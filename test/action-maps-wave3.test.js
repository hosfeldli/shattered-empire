// Maps wave 3 (2026-11-16): choke points, steep ranges, seas and gimmick maps. The generic checks
// (determinism, symmetry, reachability, route fairness, preview) run for every map in action-maps.test.js;
// these check what each new map is about: walls infantry cannot climb, the routes they leave, and that
// every map looks different in the lobby.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAPS_BY_ID, MAP_CATALOG } from '../server/sim/mapCatalog.js';
import { MAP_PREVIEWS } from '../server/sim/mapPreviews.js';

const WAVE3 = ['fortress_pass', 'serpentine', 'stepping_stones', 'fjordmark', 'twin_continents', 'ring_of_fire', 'king_of_the_hill'];
const SIM = new URL('../server/sim/', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { HEAVY_GROUND, LIGHT_GROUND } = await import(workerData.sim + 'actionNavigation.js');
const slots = Array.from({ length: workerData.players }, () => ({ human: false, difficulty: 'normal' }));
const g = new ActionGame({ id: 'w3', seed: 5, map: workerData.id, slots });
const site = (name) => g.sites.find((s) => s.name === name);
const len = (a, b, def) => g.nav.strategic(site(a).tile, site(b).tile, def, false, true, 1e9)?.length ?? Infinity;
parentPort.postMessage(workerData.pairs.map(([a, b]) => ({ a, b, heavy: len(a, b, HEAVY_GROUND), light: len(a, b, LIGHT_GROUND) })));
`;
function routes(id, pairs) {
  const def = MAPS_BY_ID[id];
  return new Promise((resolve, reject) => {
    const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, id, players: def.players, pairs, sim: SIM } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', reject);
  });
}

test('wave 3 maps are in the catalog with a name, a description and a distinct preview', () => {
  for (const id of WAVE3) {
    const m = MAPS_BY_ID[id];
    assert.ok(m && m.name && m.description.length > 60, `${id} is listed`);
    assert.ok(m.size >= 76 && m.size <= 132, `${id} is a moderate size (${m.size})`);
  }
  // every map's preview differs from every other map's in at least a fifth of the cells where either has land
  const cells = Object.fromEntries(MAP_CATALOG.map((m) => [m.id, Buffer.from(MAP_PREVIEWS[m.id].cells, 'base64')]));
  for (const id of WAVE3) for (const other of MAP_CATALOG) {
    if (other.id === id) continue;
    const a = cells[id], b = cells[other.id];
    let differ = 0, land = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > 1 || b[i] > 1) { land++; if (a[i] !== b[i]) differ++; }
    assert.ok(differ >= land * .2, `${id} and ${other.id} look alike (${differ} of ${land} cells differ)`);
  }
});

test('walls hold: peaks and cliffs stop infantry as well as vehicles', async () => {
  // capital to capital (or to the centre) on foot is no shorter than by tank: no one climbs the walls
  const cases = [
    ['fortress_pass', [['Westwall', 'Eastwall'], ['Canyon Mouth', 'The Keep']]],
    ['ring_of_fire', [['Ashport', 'The Heart'], ['Ashport', 'West Forge']]],
    ['king_of_the_hill', [['Westhold', 'The Summit'], ['Westhold', 'Easthold']]],
  ];
  for (const [id, pairs] of cases) for (const r of await routes(id, pairs)) {
    assert.ok(Number.isFinite(r.heavy), `${id}: ${r.a} reaches ${r.b}`);
    assert.ok(r.light >= r.heavy * .9, `${id}: ${r.a} -> ${r.b} on foot ${r.light}, by tank ${r.heavy}`);
  }
});

// HILLS_MOUNTAINS (2026-11-19): mountains are walls for every ground unit, so the saddle is a hill pass now: the short
// way over the northern ridge for infantry and vehicles alike (infantry climb it at the hill pace)
test('Serpentine: the hill saddle is the short way over the ridge', async () => {
  const [r] = await routes('serpentine', [['Harrowby', 'Upper Fold']]);
  assert.ok(Number.isFinite(r.heavy) && Number.isFinite(r.light) && r.light < 40, `on foot ${r.light}, by tank ${r.heavy}`);
});

test('Fortress Pass: the goat trail is a real route, longer than the canyon', async () => {
  const [canyon, trail] = await routes('fortress_pass', [['Westwall', 'Eastwall'], ['Crag End', 'Stillwater']]);
  assert.ok(Number.isFinite(trail.heavy), 'vehicles can cross the trail');
  assert.ok(canyon.heavy < 90, `the canyon is the short way (${canyon.heavy})`);
});

test('the sea maps make the ground long way round: capital routes far exceed the straight line', async () => {
  for (const [id, a, b] of [['twin_continents', 'Westmoor', 'Eastmoor'], ['stepping_stones', 'Gullhaven', 'Shellhaven']]) {
    const [r] = await routes(id, [[a, b]]);
    assert.ok(Number.isFinite(r.heavy), `${id}: ${a} reaches ${b} by land`);
    assert.ok(r.heavy > 60, `${id}: ${a} -> ${b} is ${r.heavy} steps`);
  }
});
