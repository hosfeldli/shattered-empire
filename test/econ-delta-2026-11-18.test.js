// Pass 4 (perf, 2026-11-18): keyed econ deltas (capability 'econ-delta-v1', server/delta.js). 'sites' (5 Hz),
// 'buildings' and 'bf' (1 Hz) go out as versioned keyed deltas to a client that negotiated them. A long AI match is
// replayed through the encoder and the reference client (keyedReceiver, which Unity ClientSession mirrors); after every
// delivered snapshot the client's copy must equal what the full snapshot carried, including across a reconnect (a
// new encoder, the client keeps its copy) and a forced version gap (a dropped message: the client asks for a resync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';
import { negotiate } from '../server/protocol.js';
import { deltaEncoder, keyedReceiver } from '../server/delta.js';

const SIM = new URL('../server/sim/', import.meta.url).href;
const DELTA = new URL('../server/delta.js', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { deltaEncoder, keyedReceiver } = await import(workerData.delta);
const slots = [0, 1, 2, 3].map((i) => ({ human: false, difficulty: 'normal', personality: ['warlord', 'merchant', 'builder'][i % 3] }));
const g = new ActionGame({ id: 'econdelta', seed: 7, map: 'crossroads', slots });
const viewer = g.civs[0]; viewer.connected = true;   // an AI seat watched as a player would be
const RECONNECT = workerData.reconnect, DROP = workerData.drop;
let enc = deltaEncoder(50, 10, { keyed: true }), legacy = deltaEncoder();
const rx = keyedReceiver();
const r = { messages: 0, econ: 0, compared: 0, mismatch: null, deltas: { sd: 0, bd: 0, bfd: 0 }, fulls: { sites: 0, buildings: 0, bf: 0 },
  keyedBytes: 0, legacyBytes: 0, plainBytes: 0, reconnected: false, dropped: null, gapAt: null, resyncs: 0, staleMessages: 0, legacyKeyed: false,
  maxTenureErr: 0, ruinsGated: 0, bfNonEmpty: 0, buildingsMax: 0 };
let stale = false, staleRun = 0, maxStaleRun = 0;
const canonSites = (list) => { const m = new Map(); for (const s of list || []) m.set(s.id, s); return m; };
const canonById = (list) => { const m = new Map(); for (const b of list || []) m.set(b.id, JSON.stringify(b)); return [...m.entries()].sort((a, b) => a[0] - b[0]); };
const canonBf = (bf) => {
  if (!bf) return null;
  const out = {};
  for (const [sub, rows] of Object.entries(bf)) { const m = new Map(); for (const row of rows) { const k = row[0]; if (!m.has(k)) m.set(k, []); m.get(k).push(row); } out[sub] = JSON.stringify([...m.entries()].sort((a, b) => a[0] - b[0])); }
  return out;
};
function sitesEqual(held, plain) {
  const a = canonSites(held), b = canonSites(plain);
  if (a.size !== b.size) return 'site count ' + a.size + ' vs ' + b.size;
  for (const [id, want] of b) {
    const got = a.get(id); if (!got) return 'site ' + id + ' missing';
    const x = { ...got }, y = { ...want };
    for (const k of ['tenure', 'maturity']) {
      const e = Math.abs((x[k] ?? 0) - (y[k] ?? 0)); if (e > 0.06) return 'site ' + id + ' ' + k + ' ' + x[k] + ' vs ' + y[k];
      if (k === 'tenure') r.maxTenureErr = Math.max(r.maxTenureErr, e);
      delete x[k]; delete y[k];
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) return 'site ' + id + ' fields';
  }
  return null;
}
for (let i = 1; i <= workerData.ticks && !g.over; i++) {
  g.tick(); g.outbox.length = 0;
  if (i % 2) continue;
  let batch = g.snapshots(null, i % 10 === 0);
  if (i === RECONNECT) {
    // a rejoin: the worker's welcome makes a new encoder and sends a full snapshot; the client keeps its copy
    enc = deltaEncoder(50, 10, { keyed: true }); legacy = deltaEncoder(); batch = g.snapshots(0); r.reconnected = true;
  }
  for (const [civId, msg] of batch) {
    if (civId !== 0) continue;
    const plain = JSON.parse(JSON.stringify(msg));
    const wire = JSON.stringify(enc(JSON.parse(JSON.stringify(msg))));
    const lw = JSON.stringify(legacy(JSON.parse(JSON.stringify(msg))));
    if (lw.includes('"sd":') || lw.includes('"bd":') || lw.includes('"bfd":') || lw.includes('"sv":')) r.legacyKeyed = true;
    r.messages++; r.keyedBytes += wire.length; r.legacyBytes += lw.length; r.plainBytes += JSON.stringify(plain).length;
    const out = JSON.parse(wire);
    if (plain.econ && out.ruins === undefined) r.ruinsGated++;
    if (out.sd) r.deltas.sd++; if (out.bd) r.deltas.bd++; if (out.bfd) r.deltas.bfd++;
    if (out.sites) r.fulls.sites++; if (out.buildings) r.fulls.buildings++; if (out.bf) r.fulls.bf++;
    if (plain.econ) { r.econ++; r.buildingsMax = Math.max(r.buildingsMax, plain.buildings.length); if (plain.bf && Object.values(plain.bf).some((x) => x.length)) r.bfNonEmpty++; }
    // the forced gap: the first delta-carrying message at or after DROP never reaches the client
    if (r.dropped == null && i >= DROP && (out.sd || out.bd || out.bfd)) { r.dropped = i; stale = true; continue; }
    const { resync } = rx.apply(out);
    if (resync) {
      if (r.gapAt == null) r.gapAt = i;
      r.resyncs++; stale = true;
      enc.resyncEcon(); g.civs[0].catchUp = true;      // what worker.js does on cmd { c: 'resync' }
    }
    const view = rx.view(out.time);
    const st = rx.state;
    if (stale) {
      // between a lost message and the full fields after the resync the client's copy may be behind; it must recover
      const caught = st.sv >= 0 && st.bv >= 0 && st.bfv >= 0 && !resync && out.sites && (out.buildings || !plain.econ);
      staleRun++; r.staleMessages++;
      if (caught && plain.econ && out.buildings && out.bf) { stale = false; maxStaleRun = Math.max(maxStaleRun, staleRun); staleRun = 0; }
      else continue;
    }
    r.compared++;
    let why = sitesEqual(view.sites, plain.sites);
    if (!why && plain.econ) {
      if (JSON.stringify(canonById(view.buildings)) !== JSON.stringify(canonById(plain.buildings))) why = 'buildings';
      else if (JSON.stringify(canonBf(view.bf)) !== JSON.stringify(canonBf(plain.bf))) why = 'bf';
      else if (JSON.stringify(view.ruins) !== JSON.stringify(plain.ruins) || JSON.stringify(view.cities) !== JSON.stringify(plain.cities)) why = 'ruins/cities';
    }
    if (why && !r.mismatch) r.mismatch = { i, why };
  }
}
r.maxStaleRun = maxStaleRun;
parentPort.postMessage(r);
`;

test('econ deltas: the capability is negotiated only when asked for', () => {
  assert.ok(negotiate({ proto: 2, caps: ['udelta', 'econ-delta-v1'] }).caps.includes('econ-delta-v1'));
  assert.ok(!negotiate({ proto: 2, caps: ['udelta', 'geo', 'action-rts', 'ring-cities-v1'] }).caps.includes('econ-delta-v1'), 'a 0.5.0 client keeps its messages');
  assert.deepEqual(negotiate({ proto: 1, caps: ['econ-delta-v1'] }).caps, []);
});

test('econ deltas: a delta that does not follow the version held is refused (resync), a full field resets the copy', () => {
  const enc = deltaEncoder(50, 10, { keyed: true }), rx = keyedReceiver();
  const msg = (time, sites, buildings, bf) => ({ t: 's', time, tick: time * 10, units: [], paths: {}, sites, ...(buildings ? { econ: {}, buildings, bf } : {}) });
  const bf = (m) => ({ c: [], w: [], s: [], i: [], fp: [], m, sc: [], wr: [], hs: [] });
  const site = (id, extra = {}) => ({ id, tile: id, owner: 0, tenure: 0, maturity: 0, developedAt: 0, memory: false, ...extra });
  const a = enc(msg(1, [site(1), site(2)], [{ id: 5, hp: 100 }], bf([[7, 'shell', 1, 1, 1, 3, 100]])));
  assert.ok(a.sites && a.buildings && a.bf && a.sv === 1 && a.bv === 1 && a.bfv === 1, 'the first message is whole');
  assert.equal(rx.apply(a).resync, false);
  const b = enc(msg(2, [site(1, { tenure: 1 }), site(3)], [{ id: 5, hp: 90 }, { id: 6, hp: 100 }], bf([[7, 'shell', 1, 1, 1, 3, 100], [7, 'shell', 2, 2, 1, 4, 100]])));
  assert.equal(b.sites, undefined); assert.equal(b.buildings, undefined); assert.equal(b.bf, undefined);
  assert.deepEqual(b.sd.r, [2]); assert.equal(b.sd.u.length, 2); assert.equal(b.sd.u[0].ta, 1, 'tenure travels as its anchor');
  assert.deepEqual(b.bd.u.map((x) => x.id), [5, 6]);
  assert.equal(b.bfd.u.m.length, 2, 'a changed tile resends all of its rows');
  assert.equal(rx.apply(b).resync, false);
  const v = rx.view(2);
  assert.deepEqual(v.sites.map((s) => [s.id, s.tenure]), [[1, 1], [3, 0]]);
  assert.equal(v.bf.m.length, 2);
  const c = enc(msg(3, [site(1, { tenure: 2 }), site(3)], [{ id: 6, hp: 100 }], bf([])));
  assert.equal(c.sd, undefined, 'an unchanged field sends nothing (the anchor holds still)');
  assert.deepEqual(c.bd.r, [5]); assert.deepEqual(c.bfd.r, { m: [7] });
  const d = enc(msg(4, [site(1, { tenure: 3 }), site(3, { capture: 1 })], [{ id: 6, hp: 50 }], bf([])));
  assert.equal(rx.apply(d).resync, true, 'c was lost: d does not follow');
  enc.resyncEcon();
  const e = enc(msg(5, [site(1, { tenure: 4 }), site(3, { capture: 1 })], [{ id: 6, hp: 50 }], bf([])));
  assert.ok(e.sites && e.buildings && e.bf, 'after a resync the fields are whole');
  assert.equal(rx.apply(e).resync, false);
  assert.deepEqual(rx.view(5).buildings, [{ id: 6, hp: 50 }]);
  // an old (udelta-only) client never sees keyed fields
  const old = deltaEncoder();
  const o1 = old(msg(1, [site(1)], [{ id: 5 }], bf([]))), o2 = old(msg(2, [site(1, { tenure: 1 })], [{ id: 6 }], bf([])));
  for (const o of [o1, o2]) { assert.ok(Array.isArray(o.sites) && Array.isArray(o.buildings)); assert.equal(o.sd ?? o.bd ?? o.bfd ?? o.sv, undefined); }
});

test('econ deltas: a long AI match reconstructs every snapshot, across a reconnect and a forced version gap', { timeout: 600000 }, async () => {
  const def = MAP_CATALOG.find((m) => m.id === 'crossroads');
  const r = await new Promise((resolve, reject) => {
    const w = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, sim: SIM, delta: DELTA, ticks: 12000, reconnect: 3000, drop: 6450 } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
  if (process.env.SE_DEBUG) console.log(JSON.stringify(r));
  assert.equal(r.mismatch, null, JSON.stringify(r.mismatch));
  assert.ok(r.reconnected, 'reconnected');
  assert.ok(r.dropped != null && r.gapAt != null && r.gapAt > r.dropped, `gap detected after the drop (${r.dropped} -> ${r.gapAt})`);
  assert.ok(r.maxStaleRun <= 8, `recovered within ${r.maxStaleRun} messages of the drop`);
  assert.ok(r.compared >= r.messages - 10, `compared ${r.compared} of ${r.messages}`);
  assert.ok(r.econ >= 400 && r.bfNonEmpty > 0, `econ ${r.econ}, battlefield rows ${r.bfNonEmpty}`);
  assert.ok(r.deltas.sd > 100 && r.deltas.bd > 100 && r.deltas.bfd > 10, JSON.stringify(r.deltas));
  assert.ok(r.ruinsGated > r.econ / 2, `ruins left out while unchanged ${r.ruinsGated}/${r.econ}`);
  assert.ok(!r.legacyKeyed, 'an encoder without the capability never sends keyed fields');
  assert.ok(r.keyedBytes < r.legacyBytes * 0.8, `keyed ${r.keyedBytes} vs udelta ${r.legacyBytes} (plain ${r.plainBytes})`);
});
