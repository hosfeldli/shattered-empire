// Spectator snapshot deltas (2026-11-19, docs/performance/TELEMETRY_ANALYSIS_2026-11-19.md B5 and B7). Spectators
// used to get every 200 ms snapshot whole (100 KB in a big match): the delta encoder was only set up for players. The
// shared spectator channel (-2) now gets the same udelta / keyed-delta encoding when every connected spectator
// negotiated it, a reset (follow / fog) or reconnect starts a fresh encoder (a full set), and a version gap asks for a
// resync. A spectator that applies the encoded stream must hold exactly what the whole snapshots carried.
// The god view also stops rescanning every tile and repacking its all-ones visibility bitmap each round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { deltaEncoder, keyedReceiver } = await import('../server/delta.js');
const { MatchManager } = await import('../server/matches.js');

const clone = (o) => JSON.parse(JSON.stringify(o));

// The client side, as Unity UnitStore.Apply + ClientSession apply it: units and paths (udelta), keyed econ fields.
function spectatorClient() {
  const units = new Map(), paths = new Map(), wp = new Map(), keyed = keyedReceiver();
  let fw = null, resyncs = 0;
  return {
    apply(msg) {
      if (msg.reset) { units.clear(); paths.clear(); wp.clear(); Object.assign(keyed, keyedReceiver()); }
      for (const r of msg.units) units.set(r[0], JSON.stringify(r));
      if (msg.d) {
        for (const id of msg.ug || []) units.delete(id);
        for (const [id, p] of Object.entries(msg.paths || {})) paths.set(+id, p.join(','));
        for (const id of msg.pg || []) paths.delete(id);
        for (const id of msg.wpg || []) wp.delete(id);
      } else {
        const listed = new Set(msg.units.map((r) => r[0]));
        for (const id of [...units.keys()]) if (!listed.has(id)) units.delete(id);
        paths.clear(); wp.clear();
        for (const [id, p] of Object.entries(msg.paths || {})) paths.set(+id, p.join(','));
      }
      for (const [id, r] of Object.entries(msg.wp || {})) wp.set(+id, JSON.stringify(r));
      if (msg.fw !== undefined) fw = JSON.stringify(msg.fw) + '|' + JSON.stringify(msg.trenchWorld ?? null);
      const { resync } = keyed.apply(msg);
      if (resync) resyncs++;
      return resync;
    },
    get resyncs() { return resyncs; },
    // what this client holds, in the shape of a whole snapshot
    compare(plain, heldEcon) {
      const want = new Map(plain.units.map((r) => [r[0], JSON.stringify(r)]));
      if (want.size !== units.size) return `units ${units.size} vs ${want.size}`;
      for (const [id, k] of want) if (units.get(id) !== k) return `unit ${id}`;
      const wantPaths = Object.entries(plain.paths || {});
      if (wantPaths.length !== paths.size) return `paths ${paths.size} vs ${wantPaths.length}`;
      for (const [id, p] of wantPaths) if (paths.get(+id) !== p.join(',')) return `path ${id}`;
      if (plain.wp) { const ids = Object.keys(plain.wp); if (ids.length !== wp.size || ids.some((id) => wp.get(+id) !== JSON.stringify(plain.wp[id]))) return 'world paths'; }
      if (heldEcon) {
        const v = keyed.view(plain.time);
        const byId = (l) => JSON.stringify([...new Map((l || []).map((r) => [r.id, r])).entries()].sort((a, b) => a[0] - b[0]));
        if (byId(v.buildings) !== byId(heldEcon.buildings)) return 'buildings';
        const strip = (l) => (l || []).map(({ tenure, maturity, ...r }) => r);   // re-derived from anchors: checked loosely below
        if (byId(strip(v.sites)) !== byId(strip(plain.sites))) return 'sites';
        const tenure = new Map((plain.sites || []).map((s) => [s.id, s.tenure ?? 0]));
        for (const s of v.sites || []) if (Math.abs((s.tenure ?? 0) - tenure.get(s.id)) > 0.06) return `site ${s.id} tenure`;
        if (JSON.stringify(v.ruins) !== JSON.stringify(heldEcon.ruins) || JSON.stringify(v.cities) !== JSON.stringify(heldEcon.cities)) return 'ruins / cities';
        const bfCanon = (bf) => bf && JSON.stringify(Object.fromEntries(Object.entries(bf).map(([k, rows]) => [k, [...rows].map((r) => JSON.stringify(r)).sort()])));
        if (bfCanon(v.bf) !== bfCanon(heldEcon.bf)) return 'battlefield';
        if (fw !== JSON.stringify(heldEcon.fw) + '|' + JSON.stringify(heldEcon.trenchWorld ?? null)) return 'trenches';
      }
      return null;
    },
  };
}

test('a spectator on keyed deltas holds what whole snapshots carry, across a reset, a reconnect and a resync', { timeout: 300000 }, () => {
  const slots = [0, 1, 2, 3].map((i) => ({ human: false, difficulty: 'hard', personality: ['warlord', 'merchant', 'builder'][i % 3] }));
  const g = new ActionGame({ id: 'specdelta', seed: 23, style: 'pangaea', slots });
  g.setObserver({ connected: true });
  let enc = deltaEncoder(50, 10, { keyed: true });
  let client = spectatorClient();
  const econHeld = {};       // the latest whole econ fields (what a whole-snapshot spectator holds)
  const stats = { messages: 0, compared: 0, plainBytes: 0, wireBytes: 0, deltas: 0, resets: 0, reconnects: 0, resyncs: 0, dropped: 0 };
  let dropPending = false, stale = false;
  const deliver = (msg) => {
    const plain = clone(msg);
    for (const f of ['buildings', 'bf', 'ruins', 'cities', 'fw', 'trenchWorld', 'sites']) if (plain[f] !== undefined) econHeld[f] = plain[f];
    const wire = JSON.stringify(enc(clone(msg)));
    stats.messages++; stats.plainBytes += JSON.stringify(plain).length; stats.wireBytes += wire.length;
    const out = JSON.parse(wire);
    if (out.d) stats.deltas++;
    // a forced version gap: this message's keyed deltas are lost (the rest applies), so the next one does not follow
    if (dropPending && (out.sd || out.bd || out.bfd)) {
      dropPending = false; stale = true; stats.dropped++;
      delete out.sd; delete out.bd; delete out.bfd;
    }
    if (client.apply(out)) { stats.resyncs++; enc.resyncEcon(); g.observer.catchUp = true; }   // worker.js obsCmd 'resync'
    // after a gap the keyed fields are stale until the resync brings them whole (units and paths never are)
    if (stale && Array.isArray(out.buildings) && Array.isArray(out.sites) && out.bf) stale = false;
    const bad = client.compare(plain, econHeld.buildings && !stale ? { ...econHeld, sites: plain.sites ?? econHeld.sites } : null);
    assert.equal(bad, null, `tick ${g.tickN}: the spectator's copy differs (${bad})`);
    stats.compared++;
  };
  // welcome: a full snapshot through a fresh encoder (worker.js obsWelcome)
  deliver(g.observerSnapshot(true));
  for (let i = 1; i <= 2400 && !g.over; i++) {
    g.tick(); g.outbox.length = 0;
    if (i % 2) continue;
    if (i === 900) {      // the spectator follows another nation's fog: a reset with a fresh encoder
      g.setObserver({ fog: true, follow: 2 }); enc = deltaEncoder(50, 10, { keyed: true }); stats.resets++;
      deliver({ ...g.observerSnapshot(true), reset: 1 }); continue;
    }
    if (i === 1300) {     // back to the whole map
      g.setObserver({ fog: false }); enc = deltaEncoder(50, 10, { keyed: true }); stats.resets++;
      deliver({ ...g.observerSnapshot(true), reset: 1 }); continue;
    }
    if (i === 1700) {     // a reconnect: a new client (nothing held) and a new encoder
      client = spectatorClient(); enc = deltaEncoder(50, 10, { keyed: true }); stats.reconnects++;
      deliver(g.observerSnapshot(true)); continue;
    }
    if (i === 2000) dropPending = true;   // a lost keyed delta: the next one does not follow the version held
    for (const [viewer, msg] of g.snapshots(null, i % 10 === 0)) {
      if (viewer !== -2) continue;
      deliver(msg);
    }
  }
  assert.ok(stats.compared > 1000, `compared ${stats.compared} snapshots`);
  assert.ok(stats.deltas > stats.messages * 0.9, `${stats.deltas} of ${stats.messages} messages were deltas`);
  assert.equal(stats.dropped, 1);
  assert.ok(stats.resyncs >= 1, 'the lost delta was noticed and resynced');
  assert.ok(stats.wireBytes < stats.plainBytes * 0.5, `wire ${stats.wireBytes} B vs whole ${stats.plainBytes} B`);
});

test('the god view skips the tile scan and the visibility bitmap while nothing changed', () => {
  const g = new ActionGame({ id: 'specgod', seed: 5, style: 'pangaea', slots: [{ human: false }, { human: false }] });
  g.setObserver({ connected: true });
  const first = g.observerSnapshot(true);
  assert.ok(first.tiles?.length > 0 && typeof first.vis === 'string', 'the first view carries tiles and the bitmap');
  g.tick();
  const second = g.observerSnapshot(false);
  assert.equal(second.vis, undefined, 'the all-ones bitmap is not resent');
  // a changed tile is still found
  const t = g.sites[0].tile;
  g.world.touch(t);
  const third = g.observerSnapshot(false);
  assert.deepEqual(third.tiles?.map((r) => r[0]), [t], 'the touched tile is sent');
  assert.equal(g.observerSnapshot(false).tiles, undefined, 'and then nothing until the next change');
  // the followed nation's fog brings its own bitmap back
  g.setObserver({ fog: true });
  assert.equal(typeof g.observerSnapshot(true).vis, 'string');
});

test('spectators share the capabilities every connected spectator negotiated', () => {
  const mm = new MatchManager({ info() {}, warn() {}, error() {} }, null);
  clearInterval(mm.janitor);
  const sent = [];
  const ws = (caps) => ({ readyState: 1, ctx: { caps } });
  const NEW = ['geo', 'udelta', 'action-rts', 'ring-cities-v1', 'econ-delta-v1'], OLD = ['geo', 'action-rts', 'ring-cities-v1'];
  const a = { spectator: true, ws: ws(NEW) }, b = { spectator: true, ws: ws(OLD) };
  const m = { ready: true, worker: { postMessage: (x) => sent.push(x) }, watchers: [a] };
  mm.welcome(m, a);
  assert.deepEqual(sent.at(-1).shared, NEW);
  m.watchers.push(b);
  mm.welcome(m, b);
  assert.ok(!sent.at(-1).shared.includes('udelta'), 'an old client among the spectators keeps whole snapshots');
  b.ws = null;      // the old client left: the next welcome may use deltas again
  mm.welcome(m, a);
  assert.deepEqual(sent.at(-1).shared, NEW);
});

// The worker end to end: a keyed-delta spectator gets deltas, a resync, a fresh full set on reconnect, the effective
// pace, and an old spectator keeps whole snapshots.
function collect(worker) {
  const msgs = [];
  worker.on('message', (m) => { if (m.t === 'out') for (const [civId, s] of m.msgs) if (civId === -2 || civId === -1) msgs.push(JSON.parse(s)); });
  return msgs;
}
const until = async (msgs, pred, ms = 15000) => {
  const t0 = Date.now();
  for (;;) { const i = msgs.findIndex(pred); if (i >= 0) return msgs[i]; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

test('worker: spectator deltas, resync, reconnect and pace', { timeout: 60000 }, async () => {
  const worker = new Worker(new URL('../server/worker.js', import.meta.url), { env: { ...process.env, SE_ADAPTIVE: '0' }, workerData: {
    id: 'spec-worker', seed: 9, mapSize: 64, wrap: false, rebels: false, observe: true, ruleset: 'action-v2', speed: 4,
    slots: [{ human: false, leader: 'AI 1' }, { human: false, leader: 'AI 2' }],
  } });
  const msgs = collect(worker);
  try {
    await new Promise((r) => worker.once('message', r));   // ready
    const CAPS = ['udelta', 'action-rts', 'ring-cities-v1', 'econ-delta-v1'];
    worker.postMessage({ t: 'obsWelcome', caps: CAPS, shared: CAPS });
    const welcome = await until(msgs, (m) => m.t === 'welcome');
    assert.equal(welcome.spectator, true);
    const full = await until(msgs, (m) => m.t === 's');
    assert.equal(full.d, undefined, 'the first snapshot is a full set');
    assert.ok(Array.isArray(full.sites) && full.sv >= 1, 'with keyed fields and their versions');
    await until(msgs, (m) => m.t === 's' && m.d === 1);
    const paced = await until(msgs, (m) => m.t === 's' && typeof m.pace === 'number');
    assert.ok(paced.pace > 1.5 && paced.pace < 6, `pace ${paced.pace} at 4x`);
    // resync: the next econ round carries the keyed fields whole
    msgs.length = 0;
    worker.postMessage({ t: 'obsCmd', rid: 7, cmd: { c: 'resync' } });
    assert.equal((await until(msgs, (m) => m.rid === 7)).resync, true);
    const whole = await until(msgs, (m) => m.t === 's' && m.econ);
    assert.ok(Array.isArray(whole.buildings) && Array.isArray(whole.sites), 'buildings and sites whole after the resync');
    // a reconnect: a fresh encoder, a full set again
    msgs.length = 0;
    worker.postMessage({ t: 'obsWelcome', caps: CAPS, shared: CAPS });
    const again = await until(msgs, (m) => m.t === 's');
    assert.equal(again.d, undefined);
    assert.ok(again.units.length > 0);
    // an old spectator joins: whole snapshots for everyone
    msgs.length = 0;
    worker.postMessage({ t: 'obsWelcome', caps: ['action-rts', 'ring-cities-v1'], shared: ['action-rts', 'ring-cities-v1'] });
    await until(msgs, (m) => m.t === 's');
    await new Promise((r) => setTimeout(r, 800));
    const snaps = msgs.filter((m) => m.t === 's');
    assert.ok(snaps.length >= 3 && snaps.every((m) => m.d === undefined && m.sv === undefined && m.sd === undefined), 'no deltas for an old client');
    // speed: a cheap match accepts 8x; the ack carries the speed
    worker.postMessage({ t: 'obsCmd', rid: 9, cmd: { c: 'speed', speed: 8 } });
    assert.equal((await until(msgs, (m) => m.rid === 9)).speed, 8);
  } finally { await worker.terminate(); }
});
