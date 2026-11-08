// Live server benchmark without a game client: N WebSocket players connect to a running server,
// each creates a sandbox match (or one match is shared), stages the 500 vs 500 battle like the
// native client's --battle=massive, keeps issuing orders and placement queries, and measures
// command round trips and snapshot arrival intervals and sizes. The server log reports tick time.
// Usage: node tools/live-bench.mjs [url=ws://127.0.0.1:8137/ws] [seconds=60] [caps=geo,udelta]
import WebSocket from 'ws';
const url = process.argv[2] || 'ws://127.0.0.1:8137/ws', seconds = Number(process.argv[3] || 60);
const caps = (process.argv[4] || 'geo,udelta').split(',').filter(Boolean);
const ws = new WebSocket(url);
let rid = 0; const pending = new Map(); const rtt = []; const gaps = []; const sizes = []; let lastSnap = 0;
const cmd = (c) => new Promise((res) => { const id = ++rid; pending.set(id, [performance.now(), res]); ws.send(JSON.stringify({ t: 'cmd', rid: id, cmd: c })); });
ws.on('message', (data) => {
  const m = JSON.parse(data);
  if (m.rid && pending.has(m.rid)) { const [t0, res] = pending.get(m.rid); pending.delete(m.rid); rtt.push(performance.now() - t0); res(m); }
  if (m.t === 's') { const now = performance.now(); if (lastSnap) gaps.push(now - lastSnap); lastSnap = now; sizes.push(data.length); }
  if (m.t === 'hello') ws.send(JSON.stringify({ t: 'create', mode: 'sandbox', name: 'bench', ruleset: 'native-v4' }));
  if (m.t === 'welcome') stage(m);
});
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', proto: 2, caps, client: 'bench' })));
async function stage() {
  const r = (await cmd({ c: 'sandbox', op: 'scenario', key: 'massive' })).scenario;
  const A = r.A;
  await cmd({ c: 'fortify', units: A.slice(0, A.length / 3 | 0) });
  await new Promise((s) => setTimeout(s, 6000));
  await cmd({ c: 'move', units: A.slice(A.length / 3 | 0), tile: r.arena, attackMove: true });
  rtt.length = 0; gaps.length = 0; sizes.length = 0;
  const end = Date.now() + seconds * 1000;
  let k = 0;
  while (Date.now() < end) {
    // a busy player: re-order a group, check a site, query placement, every half second
    const group = A.slice((k * 25) % A.length, (k * 25) % A.length + 25);
    cmd({ c: 'move', units: group, tile: r.arena + ((k % 7) - 3), attackMove: true });
    cmd({ c: 'placement', type: 'guard_post', tile: r.arena - 20 + (k % 11) });
    if (k % 4 === 0) cmd({ c: 'placement', type: 'guard_post' });
    k++;
    await new Promise((s) => setTimeout(s, 500));
  }
  const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
  console.log(JSON.stringify({ caps, commandRoundTripMs: { p50: q(rtt, .5), p95: q(rtt, .95), max: q(rtt, 1) }, snapshotGapMs: { p50: q(gaps, .5), p95: q(gaps, .95), max: q(gaps, 1) }, snapshotKB: { p50: Math.round(q(sizes, .5) / 1024), p95: Math.round(q(sizes, .95) / 1024) } }));
  process.exit(0);
}
