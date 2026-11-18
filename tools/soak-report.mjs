// Summarises client soak benchmarks (GameBootstrap.Bench.cs, -perf-soak) into Markdown tables bucketed by match
// age, so runs of the same seed can be compared: frame-time percentiles, worst frames, GPU, GC, and the main-thread
// phases that cost the most. Optional server metrics (tools/metrics-poll.mjs) are summarised alongside.
// Usage: node tools/soak-report.mjs run.jsonl [other.jsonl ...] [--label=static|pan] [--buckets=5,10,20,30,45,60,90]
//        node tools/soak-report.mjs --server metrics.jsonl
//        node tools/soak-report.mjs run.jsonl --zoom [--from=MIN] [--to=MIN]   (perf pass 2: one row per window label,
//            e.g. static@2.5 / pan@30 from -perf-zooms, with the render thread, draw split, units, trees and chunk rebuilds)
import fs from 'node:fs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const files = args.filter((a) => !a.startsWith('--'));
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^﻿/, '')));
const edges = String(flags.buckets || '5,10,20,30,45,60,90').split(',').map(Number);
const bucketOf = (min) => { let lo = 0; for (const e of edges) { if (min < e) return `${lo}-${e}`; lo = e; } return `${lo}+`; };
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const max = (xs) => xs.length ? Math.max(...xs) : NaN;
const f1 = (v) => Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) : '-';

if (flags.server) {
  const rows = read(flags.server === true ? files[0] : flags.server);
  const groups = new Map();
  for (const r of rows) { const k = bucketOf(r.t / 60); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  console.log('| real min | units | tick p50 | tick p95 | tick p99 | nav p95 | vis p95 | ai p95 | ai p99 | combat p95 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const [k, g] of groups) {
    const s = (sys, f) => f1(mean(g.map((r) => r.systems?.[sys]?.[f]).filter(Number.isFinite)));
    console.log(`| ${k} | ${f1(mean(g.map((r) => r.units)))} | ${s('tick', 'p50')} | ${s('tick', 'p95')} | ${s('tick', 'p99')} | ${s('navigation', 'p95')} | ${s('visibility', 'p95')} | ${s('ai', 'p95')} | ${s('ai', 'p99')} | ${s('combat', 'p95')} |`);
  }
  process.exit(0);
}

if (flags.zoom) {
  for (const file of files) {
    const rows = read(file);
    const from = Number(flags.from ?? 0), to = Number(flags.to ?? 1e9);
    const windows = rows.filter((r) => r.kind === 'window' && r.matchTime / 60 >= from && r.matchTime / 60 < to);
    const labels = [...new Set(windows.map((w) => w.label))];
    console.log(`
### ${file} (game min ${from}-${to === 1e9 ? 'end' : to})
`);
    console.log('| window | n | units | FPS | p50 | p95 | p99 | worst | >33 ms | main p95 | engine main p95 | render p95 | GPU p95 | units ms (build) | unit inst | culled | draw ms terrain/city/units | trees drawn / shadowed | chunks rebuilt | trees regrown | GC KB/f |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const zoomOf = (l) => Number(String(l).split('@')[1] ?? 0);
    labels.sort((a, b) => zoomOf(a) - zoomOf(b) || a.localeCompare(b));
    for (const l of labels) {
      const g = windows.filter((w) => w.label === l);
      const m = (f) => f1(mean(g.map(f).filter(Number.isFinite)));
      console.log(`| ${l} | ${g.length} | ${m((w) => w.units)} | ${m((w) => w.fps)} | ${m((w) => w.frameMs.p50)} | ${m((w) => w.frameMs.p95)} | ${m((w) => w.frameMs.p99)} | ${f1(max(g.map((w) => w.frameMs.max)))} | ${m((w) => w.frameMs.over33)} | ${m((w) => w.mainMs?.p95)} | ${m((w) => w.engineMainMs?.p95)} | ${m((w) => w.renderMs?.p95)} | ${m((w) => w.gpuMs?.p95)} | ${m((w) => w.present?.units?.[0])} (${m((w) => w.unitsMs?.[1])}) | ${m((w) => w.unitInstances)} | ${m((w) => w.unitsCulled)} | ${m((w) => w.drawMs?.terrain?.[0])}/${m((w) => w.drawMs?.city?.[0])}/${m((w) => w.drawMs?.units?.[0])} | ${m((w) => w.terrain?.treesDrawn)} / ${m((w) => w.terrain?.treeShadows)} | ${m((w) => w.terrain?.chunksFinished)} | ${m((w) => w.terrain?.treesRegrown)} | ${m((w) => w.gcKbPerFrame)} |`);
    }
  }
  process.exit(0);
}

for (const file of files) {
  const rows = read(file);
  const meta = rows.find((r) => r.kind === 'meta') || {};
  const windows = rows.filter((r) => r.kind === 'window' && (!flags.label || r.label === flags.label));
  console.log(`\n### ${file}`);
  console.log(`build ${meta.build ?? '?'} · dev ${meta.dev} · ${meta.cpu ?? ''} · ${meta.gpu ?? ''} · ${meta.screen ?? ''} · quality ${meta.quality ?? ''} · vsync ${meta.vsync} · speed ${meta.speed}x · ${windows.length} windows\n`);
  console.log('| game min | units | FPS | p50 ms | p95 ms | p99 ms | worst ms | frames >33 ms /window | GPU p95 | GC KB/frame | top main-thread phases (avg / worst ms) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  const groups = new Map();
  for (const w of windows) { const k = bucketOf(w.matchTime / 60); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); }
  for (const [k, g] of groups) {
    const phases = {};
    for (const w of g) {
      for (const [p, [avg, worst]] of Object.entries(w.present || {})) { phases[p] ??= { avg: [], worst: [] }; phases[p].avg.push(avg); phases[p].worst.push(worst); }
      phases.net ??= { avg: [], worst: [] }; phases.net.avg.push(w.netMs?.[0] ?? 0); phases.net.worst.push(w.netMs?.[1] ?? 0);
      phases.hud ??= { avg: [], worst: [] }; phases.hud.avg.push(w.hudMs?.[0] ?? 0); phases.hud.worst.push(w.hudMs?.[1] ?? 0);
    }
    const top = Object.entries(phases).map(([p, v]) => [p, mean(v.avg), max(v.worst)]).sort((a, b) => b[2] - a[2]).slice(0, 3)
      .map(([p, a, m]) => `${p} ${f1(a)}/${f1(m)}`).join(', ');
    console.log(`| ${k} | ${f1(mean(g.map((w) => w.units)))} | ${f1(mean(g.map((w) => w.fps)))} | ${f1(mean(g.map((w) => w.frameMs.p50)))} | ${f1(mean(g.map((w) => w.frameMs.p95)))} | ${f1(mean(g.map((w) => w.frameMs.p99)))} | ${f1(max(g.map((w) => w.frameMs.max)))} | ${f1(mean(g.map((w) => w.frameMs.over33)))} | ${f1(mean(g.map((w) => w.gpuMs?.p95)))} | ${f1(mean(g.map((w) => w.gcKbPerFrame)))} | ${top} |`);
  }
  const counts = windows.at(-1);
  if (counts) console.log(`\nlast window: gameObjects ${counts.gameObjects}, meshes ${counts.meshes}, materials ${counts.materials}, textures ${counts.textures}, gfx ${counts.gfxMb} MB, used ${counts.usedMb} MB, GC heap ${counts.gcHeapMb} MB`);
}
