#!/usr/bin/env node
// Release notes: docs/releases/<version>/notes.json (+ images). Schema and workflow: docs/RELEASING.md.
//   node tools/release-notes.mjs validate <version> [--allow-draft]   schema, images, version, since
//   node tools/release-notes.mjs files <version>                      the files to upload (one per line)
//   node tools/release-notes.mjs draft <version> [--since <ver>] [--since-commit <sha>] [--force]
// validate exits 1 on any error. A draft (draft: true) is an error unless --allow-draft (release.ps1 -DryRun
// passes it), then a warning. The module also exports validateNotes() for the server test.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASES = path.join(ROOT, 'docs', 'releases');
export const LIMITS = {
  imageBytes: 600 * 1024, totalBytes: 8 * 1024 * 1024, imageMaxW: 1920, imageMaxH: 1080,
  title: 80, summary: 500, heading: 60, text: 700, bullet: 260, bullets: 14, sections: 14, blocks: 12,
  labels: 16, series: 4, unit: 16, caption: 260, rows: 16, cell: 80, fixes: 60, fix: 220,
};
const SEMVER = /^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/;
export const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.(png|jpe?g)$/;

export function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = /^\d+$/.test(x) ? +x : NaN, ny = /^\d+$/.test(y) ? +y : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx - ny; continue; }
    if (x === y) continue;
    if (x === '') return 1; if (y === '') return -1;   // 1.0.0 > 1.0.0-rc
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Released (or drafted) versions: folders of docs/releases holding a notes.json, oldest first. */
export function listVersions(dir = RELEASES) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((v) => SEMVER.test(v) && fs.existsSync(path.join(dir, v, 'notes.json'))).sort(cmpVersion);
}

function git(...args) {
  try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/** PNG/JPEG size from the header; null when the bytes are neither. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR')
    return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return { type: 'jpg', w: 0, h: 0 };
  }
  return null;
}

/** Every image a notes object references (image blocks and comparison image pairs). */
export function imagesOf(notes) {
  const out = [];
  for (const s of notes?.sections || []) for (const b of s?.blocks || []) {
    if (b?.type === 'image' && typeof b.image === 'string') out.push(b.image);
    if (b?.type === 'comparison') for (const side of ['before', 'after']) if (typeof b[side]?.image === 'string') out.push(b[side].image);
  }
  return [...new Set(out)];
}

/**
 * Validate a notes object. opts: { version (folder name), dir (folder, for images), allowDraft, previous
 * (version expected in since.version, or undefined when unknown), checkGit }. Returns { errors, warnings }.
 */
export function validateNotes(n, opts = {}) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  const str = (v, where, max, required = true) => {
    if (v === undefined || v === null) { if (required) err(`${where} is required`); return false; }
    if (typeof v !== 'string' || !v.trim()) { err(`${where} must be a non-empty string`); return false; }
    if (v.length > max) err(`${where} is ${v.length} characters (max ${max}); keep it short`);
    return true;
  };
  const keys = (o, allowed, where) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${where}: unknown field "${k}"`); };
  if (!n || typeof n !== 'object' || Array.isArray(n)) return { errors: ['notes.json must hold a JSON object'], warnings };
  keys(n, ['schema', 'version', 'date', 'title', 'summary', 'since', 'draft', 'sections', 'fixes'], 'notes');
  if (n.schema !== 1) err('schema must be 1');
  if (str(n.version, 'version', 40)) {
    if (!SEMVER.test(n.version)) err(`version "${n.version}" is not like 0.5.0`);
    if (opts.version && n.version !== opts.version) err(`version "${n.version}" does not match its folder / -Version "${opts.version}"`);
  }
  if (str(n.date, 'date', 10) && !/^\d{4}-\d\d-\d\d$/.test(n.date)) err('date must be YYYY-MM-DD');
  str(n.title, 'title', LIMITS.title);
  str(n.summary, 'summary', LIMITS.summary);
  if (n.draft !== undefined && typeof n.draft !== 'boolean') err('draft must be true or false');
  if (n.draft === true) (opts.allowDraft ? warn : err)('notes are marked draft: true (finish them, add the screenshots and remove "draft" before releasing)');

  // since: the previous release this one follows
  const since = n.since;
  if (!since || typeof since !== 'object') err('since {version, commit} is required: the previous released version and its commit');
  else {
    keys(since, ['version', 'commit'], 'since');
    if (str(since.version, 'since.version', 40)) {
      if (!SEMVER.test(since.version)) err(`since.version "${since.version}" is not like 0.4.3`);
      else if (typeof n.version === 'string' && SEMVER.test(n.version) && cmpVersion(since.version, n.version) >= 0) err(`since.version ${since.version} is not older than ${n.version}`);
      if (opts.previous && since.version !== opts.previous) err(`since.version is ${since.version} but the previous release notes are ${opts.previous}`);
    }
    if (str(since.commit, 'since.commit', 40)) {
      if (!/^[0-9a-f]{7,40}$/.test(since.commit)) err('since.commit must be a git sha (7-40 hex)');
      else if (opts.checkGit) {
        if (git('cat-file', '-e', since.commit + '^{commit}') === null) err(`since.commit ${since.commit} is not a commit in this repository`);
        else if (git('merge-base', '--is-ancestor', since.commit, 'HEAD') === null) err(`since.commit ${since.commit} is not an ancestor of HEAD`);
      }
    }
  }

  // sections and blocks
  if (!Array.isArray(n.sections) || n.sections.length === 0) err('at least one section is required');
  else {
    if (n.sections.length > LIMITS.sections) err(`${n.sections.length} sections (max ${LIMITS.sections})`);
    n.sections.forEach((s, i) => {
      const w = `sections[${i}]`;
      if (!s || typeof s !== 'object') return err(`${w} must be an object`);
      keys(s, ['heading', 'blocks'], w);
      str(s.heading, `${w}.heading`, LIMITS.heading);
      if (!Array.isArray(s.blocks) || s.blocks.length === 0) return err(`${w}.blocks must hold at least one block`);
      if (s.blocks.length > LIMITS.blocks) err(`${w}: ${s.blocks.length} blocks (max ${LIMITS.blocks})`);
      s.blocks.forEach((b, k) => block(b, `${w}.blocks[${k}]`));
    });
  }
  function image(o, where) {
    if (!o || typeof o !== 'object') return err(`${where} must be an object`);
    if (typeof o.image !== 'string' || !IMAGE_NAME.test(o.image)) err(`${where}.image must be a file name in the notes folder (.png or .jpg, no folders)`);
    if (o.caption !== undefined) str(o.caption, `${where}.caption`, LIMITS.caption);
    if (o.alt !== undefined) str(o.alt, `${where}.alt`, LIMITS.caption);
  }
  function block(b, w) {
    if (!b || typeof b !== 'object') return err(`${w} must be an object`);
    switch (b.type) {
      case 'text':
        keys(b, ['type', 'text'], w); str(b.text, `${w}.text`, LIMITS.text); break;
      case 'bullets':
        keys(b, ['type', 'items'], w);
        if (!Array.isArray(b.items) || b.items.length === 0) err(`${w}.items must hold at least one bullet`);
        else { if (b.items.length > LIMITS.bullets) err(`${w}: ${b.items.length} bullets (max ${LIMITS.bullets})`); b.items.forEach((t, j) => str(t, `${w}.items[${j}]`, LIMITS.bullet)); }
        break;
      case 'chart': {
        keys(b, ['type', 'kind', 'title', 'unit', 'labels', 'series', 'caption', 'source', 'better'], w);
        if (b.kind !== 'bar' && b.kind !== 'line') err(`${w}.kind must be "bar" or "line"`);
        str(b.title, `${w}.title`, LIMITS.heading + 20);
        str(b.unit, `${w}.unit`, LIMITS.unit);
        str(b.caption, `${w}.caption`, LIMITS.caption);
        str(b.source, `${w}.source`, 160);
        if (b.better !== undefined && b.better !== 'higher' && b.better !== 'lower') err(`${w}.better must be "higher" or "lower"`);
        const nl = Array.isArray(b.labels) ? b.labels.length : 0;
        if (nl < 1 || nl > LIMITS.labels) err(`${w}.labels must hold 1-${LIMITS.labels} labels`);
        else b.labels.forEach((t, j) => str(t, `${w}.labels[${j}]`, 24));
        if (!Array.isArray(b.series) || b.series.length === 0 || b.series.length > LIMITS.series) err(`${w}.series must hold 1-${LIMITS.series} series`);
        else b.series.forEach((s, j) => {
          const sw = `${w}.series[${j}]`;
          if (!s || typeof s !== 'object') return err(`${sw} must be an object`);
          keys(s, ['name', 'values'], sw);
          str(s.name, `${sw}.name`, 40);
          if (!Array.isArray(s.values) || s.values.length !== nl) err(`${sw}.values must hold one value per label (${nl})`);
          else s.values.forEach((v, q) => { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) err(`${sw}.values[${q}] must be a number >= 0 or null (not measured)`); });
        });
        if (b.kind === 'line' && nl < 2) err(`${w}: a line chart needs at least 2 labels`);
        break;
      }
      case 'comparison':
        keys(b, ['type', 'title', 'columns', 'rows', 'before', 'after', 'caption', 'source'], w);
        if (b.title !== undefined) str(b.title, `${w}.title`, LIMITS.heading + 20);
        if (b.caption !== undefined) str(b.caption, `${w}.caption`, LIMITS.caption);
        if (b.source !== undefined) str(b.source, `${w}.source`, 160);
        if (b.rows !== undefined) {
          if (b.before !== undefined || b.after !== undefined) err(`${w}: a comparison is either a table (rows) or an image pair (before/after), not both`);
          if (b.columns !== undefined && (!Array.isArray(b.columns) || b.columns.length !== 2)) err(`${w}.columns must be two headings, e.g. ["0.4.3", "0.5.0"]`);
          else (b.columns || []).forEach((t, j) => str(t, `${w}.columns[${j}]`, 24));
          if (!Array.isArray(b.rows) || b.rows.length === 0 || b.rows.length > LIMITS.rows) err(`${w}.rows must hold 1-${LIMITS.rows} rows`);
          else b.rows.forEach((r, j) => {
            const rw = `${w}.rows[${j}]`;
            if (!r || typeof r !== 'object') return err(`${rw} must be an object`);
            keys(r, ['label', 'before', 'after'], rw);
            str(r.label, `${rw}.label`, LIMITS.cell); str(r.before, `${rw}.before`, LIMITS.cell); str(r.after, `${rw}.after`, LIMITS.cell);
          });
        } else if (b.before !== undefined || b.after !== undefined) { image(b.before, `${w}.before`); image(b.after, `${w}.after`); }
        else err(`${w}: a comparison needs rows or a before/after image pair`);
        break;
      case 'image':
        keys(b, ['type', 'image', 'caption', 'alt'], w); image(b, w);
        if (b.caption === undefined) err(`${w}.caption is required`);
        break;
      default: err(`${w}.type must be text, bullets, chart, comparison or image`);
    }
  }

  // fixes: the smaller fixes list
  if (n.fixes !== undefined) {
    if (!Array.isArray(n.fixes)) err('fixes must be a list of short strings');
    else { if (n.fixes.length > LIMITS.fixes) err(`${n.fixes.length} fixes (max ${LIMITS.fixes})`); n.fixes.forEach((t, j) => str(t, `fixes[${j}]`, LIMITS.fix)); }
  }

  // images: exist, are PNG/JPEG, small enough
  if (opts.dir) {
    let total = 0;
    for (const name of imagesOf(n)) {
      if (!IMAGE_NAME.test(name)) continue;
      const p = path.join(opts.dir, name);
      if (!fs.existsSync(p)) { (n.draft === true && opts.allowDraft ? warn : err)(`image ${name} is missing (run the client with -release-shots, see docs/RELEASING.md)`); continue; }
      const buf = fs.readFileSync(p); total += buf.length;
      const size = imageSize(buf);
      if (!size) err(`image ${name} is not a PNG or JPEG`);
      else {
        if (size.type === 'png' && !/\.png$/i.test(name) || size.type === 'jpg' && !/\.jpe?g$/i.test(name)) err(`image ${name} is a ${size.type.toUpperCase()} with the wrong extension`);
        if (size.w > LIMITS.imageMaxW || size.h > LIMITS.imageMaxH) err(`image ${name} is ${size.w}x${size.h} (max ${LIMITS.imageMaxW}x${LIMITS.imageMaxH}); downscale it`);
      }
      if (buf.length > LIMITS.imageBytes) err(`image ${name} is ${(buf.length / 1024).toFixed(0)} KB (max ${LIMITS.imageBytes / 1024} KB); downscale or compress it`);
    }
    if (total > LIMITS.totalBytes) err(`images total ${(total / 1048576).toFixed(1)} MB (max ${LIMITS.totalBytes / 1048576} MB)`);
    const extra = fs.existsSync(opts.dir) ? fs.readdirSync(opts.dir).filter((f) => f !== 'notes.json' && !imagesOf(n).includes(f)) : [];
    if (extra.length) warn(`not referenced and not uploaded: ${extra.join(', ')}`);
  }
  return { errors, warnings };
}

function readNotes(version) {
  const dir = path.join(RELEASES, version), file = path.join(dir, 'notes.json');
  if (!fs.existsSync(file)) return { dir, file, error: `${path.relative(ROOT, file)} does not exist (draft it: node tools/release-notes.mjs draft ${version})` };
  try { return { dir, file, notes: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { dir, file, error: `${path.relative(ROOT, file)} is not valid JSON: ${e.message}` }; }
}

function previousOf(version) {
  return listVersions().filter((v) => cmpVersion(v, version) < 0).pop();
}

function validate(version, allowDraft) {
  const r = readNotes(version);
  if (r.error) { console.error('release notes: ' + r.error); return 1; }
  const { errors, warnings } = validateNotes(r.notes, { version, dir: r.dir, allowDraft, previous: previousOf(version), checkGit: true });
  for (const w of warnings) console.log('  warning: ' + w);
  for (const e of errors) console.error('  error: ' + e);
  if (errors.length) { console.error(`release notes ${version}: ${errors.length} error(s)`); return 1; }
  const imgs = imagesOf(r.notes);
  console.log(`release notes ${version}: valid (${r.notes.sections.length} sections, ${imgs.length} images, ${(r.notes.fixes || []).length} fixes${warnings.length ? `, ${warnings.length} warning(s)` : ''})`);
  return 0;
}

function files(version) {
  const r = readNotes(version);
  if (r.error) { console.error('release notes: ' + r.error); return 1; }
  console.log(r.file);
  for (const name of imagesOf(r.notes)) if (IMAGE_NAME.test(name) && fs.existsSync(path.join(r.dir, name))) console.log(path.join(r.dir, name));
  return 0;
}

function draft(version, args) {
  if (!SEMVER.test(version)) { console.error(`"${version}" is not like 0.5.0`); return 1; }
  const dir = path.join(RELEASES, version), file = path.join(dir, 'notes.json');
  if (fs.existsSync(file) && !args.force) { console.error(`${path.relative(ROOT, file)} exists (pass --force to replace it)`); return 1; }
  const prev = args.since || previousOf(version);
  // the previous release's commit: given, or the last commit that touched its notes (they are committed before release)
  const commit = args.sinceCommit || (prev && git('log', '-1', '--format=%h', '--', `docs/releases/${prev}/notes.json`)) || '';
  if (!prev || !commit) { console.error('the previous release is unknown: pass --since <version> --since-commit <sha>'); return 1; }
  const log = (git('log', '--no-merges', '--format=%s', `${commit}..HEAD`) || '').split('\n').filter(Boolean);
  const docs = new Set([...(git('diff', '--name-only', commit, '--', 'docs') || '').split('\n'),
    ...(git('ls-files', '--others', '--exclude-standard', '--', 'docs') || '').split('\n')].filter((f) => f && f.endsWith('.md')));
  const notes = {
    schema: 1, version, date: new Date().toISOString().slice(0, 10), draft: true,
    title: `Shattered Empires ${version}`,
    summary: 'TODO: two or three plain sentences on what changed for players.',
    since: { version: prev, commit },
    sections: [
      { heading: 'Highlights', blocks: [{ type: 'bullets', items: log.slice(0, 8).length ? log.slice(0, 8) : ['TODO'] }] },
      { heading: 'Sources to write from (delete this section)', blocks: [{ type: 'bullets', items: [...docs].slice(0, LIMITS.bullets).length ? [...docs].slice(0, LIMITS.bullets) : ['no changed docs'] }] },
    ],
    fixes: log.slice(8, 8 + LIMITS.fixes),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(notes, null, 2) + '\n');
  console.log(`drafted ${path.relative(ROOT, file)} from ${log.length} commits since ${prev} (${commit}) and ${docs.size} changed docs; edit it, then validate`);
  return 0;
}

function main(argv) {
  const [cmd, version, ...rest] = argv;
  const flag = (n) => rest.includes(n);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (!version || !['validate', 'files', 'draft'].includes(cmd)) {
    console.error('usage: node tools/release-notes.mjs validate|files|draft <version> [--allow-draft] [--since <ver> --since-commit <sha> --force]');
    return 2;
  }
  if (cmd === 'validate') return validate(version, flag('--allow-draft'));
  if (cmd === 'files') return files(version);
  return draft(version, { since: opt('--since'), sinceCommit: opt('--since-commit'), force: flag('--force') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
