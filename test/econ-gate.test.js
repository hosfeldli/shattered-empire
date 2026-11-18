// S4 (perf, 2026-11-17): for udelta viewers the econ snapshot's battlefield ('bf') and trench lists
// ('fw' + 'trenchWorld') are left out while identical to what the viewer last received. A client that
// keeps the previous copy when they are absent (Unity ClientSession, Godot WorldState) must always hold
// exactly what a full snapshot would carry, and both go out again after resyncEcon() and periodically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const SIM = new URL('../server/sim/', import.meta.url).href;
const DELTA = new URL('../server/delta.js', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { deltaEncoder } = await import(workerData.delta);
const slots = [0, 1, 2, 3].map((i) => ({ human: false, difficulty: 'normal', personality: ['warlord', 'merchant', 'builder'][i % 3] }));
const g = new ActionGame({ id: 'econgate', seed: 7, map: 'crossroads', slots });
g.civs[0].connected = true;   // an AI seat watched as a player would be: its battlefield fills up as it fights
const enc = deltaEncoder();
const held = { bf: undefined, fw: undefined, trenchWorld: undefined };
let econ = 0, omittedBf = 0, omittedFw = 0, fullBytes = 0, gatedBytes = 0, mismatch = null, resyncOk = true, bfNonEmpty = 0;
for (let i = 1; i <= workerData.ticks && !g.over; i++) {
  g.tick(); g.outbox.length = 0;
  if (i % 2) continue;
  for (const [civId, msg] of g.snapshots(null, i % 10 === 0)) {
    if (civId !== 0) continue;
    const plain = JSON.parse(JSON.stringify(msg));
    if (i === 3000) enc.resyncEcon();
    const out = enc(JSON.parse(JSON.stringify(msg)));
    if (!plain.econ) continue;
    econ++;
    fullBytes += JSON.stringify(plain).length; gatedBytes += JSON.stringify(out).length;
    if (i === 3000 && (out.bf === undefined || out.fw === undefined)) resyncOk = false;
    if (out.bf === undefined) omittedBf++; else held.bf = out.bf;
    if (out.fw === undefined) { omittedFw++; if (out.trenchWorld !== undefined) mismatch = mismatch || { i, why: 'trenchWorld without fw' }; }
    else { held.fw = out.fw; held.trenchWorld = out.trenchWorld; }
    if (plain.bf && (plain.bf.c.length || plain.bf.w.length || plain.bf.sc.length || plain.bf.wr.length)) bfNonEmpty++;
    if (JSON.stringify(held.bf) !== JSON.stringify(plain.bf)) mismatch = mismatch || { i, why: 'bf' };
    if (JSON.stringify(held.fw) !== JSON.stringify(plain.fw) || JSON.stringify(held.trenchWorld) !== JSON.stringify(plain.trenchWorld)) mismatch = mismatch || { i, why: 'fw' };
  }
}
parentPort.postMessage({ econ, omittedBf, omittedFw, fullBytes, gatedBytes, mismatch, resyncOk, bfNonEmpty });
`;

test('econ gate: a udelta viewer always holds the current battlefield and trenches while unchanged copies are left out', { timeout: 300000 }, async () => {
  const def = MAP_CATALOG.find((m) => m.id === 'crossroads');
  const r = await new Promise((resolve, reject) => {
    const w = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, sim: SIM, delta: DELTA, ticks: 6000 } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
  assert.equal(r.mismatch, null, JSON.stringify(r.mismatch));
  assert.ok(r.resyncOk, 'resyncEcon() forces both blocks out');
  assert.ok(r.econ >= 500, `econ messages ${r.econ}`);
  assert.ok(r.omittedBf > 0 && r.omittedFw > 0, `omitted bf ${r.omittedBf} fw ${r.omittedFw}`);
  assert.ok(r.econ - r.omittedBf >= r.econ / 10, 'the periodic refresh still sends the battlefield at least every 10th econ message');
  assert.ok(r.gatedBytes < r.fullBytes, `bytes ${r.gatedBytes} < ${r.fullBytes}`);
});
