// Release notes: the schema validator (tools/release-notes.mjs) and the server routes in local mode
// (/api/release-notes/latest, /<version>, /<version>/<image> read from a notes directory).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNotes, listVersions, imagesOf, cmpVersion, RELEASES } from '../tools/release-notes.mjs';

// a 2x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000010806000000f478d4fa0000000d49444154789c63f8cfc0f01f0005fe02fe2d1f0bd60000000049454e44ae426082', 'hex');

function sample(version, extra = {}) {
  return {
    schema: 1, version, date: '2026-11-18', title: 'Test release', summary: 'Short summary.',
    since: { version: '0.4.3', commit: '4bd3f1d' },
    sections: [{ heading: 'Faster', blocks: [
      { type: 'text', text: 'Late matches stay smooth.' },
      { type: 'bullets', items: ['One', 'Two'] },
      { type: 'chart', kind: 'bar', title: 'FPS', unit: 'FPS', labels: ['0-5', '5-10'], series: [{ name: 'Old', values: [188, 144] }, { name: 'New', values: [206, null] }], caption: 'Higher is better.', source: 'docs/performance/BENCHMARK_RESULTS.md', better: 'higher' },
      { type: 'comparison', columns: ['0.4.3', '0.5.0'], rows: [{ label: 'Worst frame', before: '1.48 s', after: '0.35 s' }] },
      { type: 'image', image: 'shot.png', caption: 'A base.' },
    ] }],
    fixes: ['A small fix.'],
    ...extra,
  };
}

test('validator accepts a complete notes file and checks images, drafts, since and limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-notes-v-'));
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
  const ok = validateNotes(sample('0.5.0'), { version: '0.5.0', dir, previous: '0.4.3' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(imagesOf(sample('0.5.0')), ['shot.png']);

  const draft = sample('0.5.0', { draft: true });
  assert.ok(validateNotes(draft, { version: '0.5.0', dir }).errors.some((e) => /draft/.test(e)), 'a draft fails a real release');
  const dry = validateNotes(draft, { version: '0.5.0', dir, allowDraft: true });
  assert.deepEqual(dry.errors, []); assert.ok(dry.warnings.some((w) => /draft/.test(w)), 'a draft only warns under -DryRun');

  const bad = (n, opts, re) => assert.ok(validateNotes(n, { version: '0.5.0', dir, ...opts }).errors.some((e) => re.test(e)), re.source);
  bad(sample('0.5.1'), {}, /does not match/);
  bad(sample('0.5.0', { since: { version: '0.4.2', commit: '4bd3f1d' } }), { previous: '0.4.3' }, /previous release/);
  bad(sample('0.5.0', { since: { version: '0.5.0', commit: '4bd3f1d' } }), {}, /not older/);
  bad(sample('0.5.0', { since: undefined }), {}, /since/);
  bad(sample('0.5.0', { sections: [] }), {}, /at least one section/);
  bad(sample('0.5.0', { summary: 'x'.repeat(900) }), {}, /summary is 900/);
  bad(sample('0.5.0', { extra: 1 }), {}, /unknown field "extra"/);
  const chart = sample('0.5.0'); chart.sections[0].blocks[2].series[0].values = [1];
  bad(chart, {}, /one value per label/);
  const missing = sample('0.5.0'); missing.sections[0].blocks[4].image = 'nope.png';
  bad(missing, {}, /nope\.png is missing/);
  const traversal = sample('0.5.0'); traversal.sections[0].blocks[4].image = '../x.png';
  bad(traversal, {}, /file name in the notes folder/);
  fs.writeFileSync(path.join(dir, 'big.png'), Buffer.concat([PNG, Buffer.alloc(700 * 1024)]));
  const big = sample('0.5.0'); big.sections[0].blocks[4].image = 'big.png';
  bad(big, {}, /KB \(max 600 KB\)/);
  fs.writeFileSync(path.join(dir, 'fake.png'), 'not an image');
  const fake = sample('0.5.0'); fake.sections[0].blocks[4].image = 'fake.png';
  bad(fake, {}, /not a PNG or JPEG/);
  assert.ok(cmpVersion('0.10.0', '0.9.9') > 0 && cmpVersion('1.0.0', '1.0.0-rc1') > 0 && cmpVersion('0.4.3', '0.5.0') < 0);
});

test('every notes file in docs/releases follows the schema (drafts allowed)', () => {
  for (const v of listVersions()) {
    const n = JSON.parse(fs.readFileSync(path.join(RELEASES, v, 'notes.json'), 'utf8'));
    const { errors } = validateNotes(n, { version: v, dir: path.join(RELEASES, v), allowDraft: true });
    assert.deepEqual(errors, [], `docs/releases/${v}/notes.json`);
  }
});

test('server serves release notes and their images from a local notes directory', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-notes-'));
  for (const v of ['0.4.9', '0.5.0', '0.10.0']) {
    fs.mkdirSync(path.join(dir, v));
    fs.writeFileSync(path.join(dir, v, 'notes.json'), JSON.stringify(sample(v)));
  }
  fs.writeFileSync(path.join(dir, '0.5.0', 'shot.png'), PNG);
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'no');
  const srv = fork(fileURLToPath(new URL('../server/index.js', import.meta.url)), [], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', RELEASE_NOTES_DIR: dir, DOWNLOAD_DIR: dir, SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-notes-s-')) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const port = await new Promise((r) => srv.on('message', (m) => m.t === 'listening' && r(m.port)));
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  try {
    const latest = await get('/api/release-notes/latest');
    assert.equal(latest.status, 200);
    assert.equal(latest.headers.get('access-control-allow-origin'), '*');
    assert.equal((await latest.json()).version, '0.10.0', 'latest is the highest version, not the last alphabetically');
    const one = await (await get('/api/release-notes/0.5.0')).json();
    assert.equal(one.version, '0.5.0'); assert.equal(one.sections[0].heading, 'Faster');
    const img = await get('/api/release-notes/0.5.0/shot.png');
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await get('/api/release-notes/9.9.9')).status, 404);
    assert.equal((await get('/api/release-notes/0.5.0/missing.png')).status, 404);
    assert.equal((await get('/api/release-notes/0.5.0/notes.json')).status, 404, 'only images by file name');
    assert.equal((await get('/api/release-notes/0.5.0/..%2F..%2Fsecret.txt')).status, 404);
    assert.equal((await get('/api/release-notes/..%2Fsecret.txt')).status, 404);
  } finally { srv.kill(); }
});
