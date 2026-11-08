// Combat sandbox: reproducible battle scenarios on a real continent, for tests and for the
// developer sandbox match (spawn forces for either side, run, watch, repeat).
import { UNITS, TERRAIN, T, W, H, N, isWater } from './constants.js';
import { disk, dist, NB } from './hex.js';
import { spawnUnit } from './military.js';
import { onAircraftBuilt } from './airOperations.js';

const passable = (g, t) => { const ter = g.world.terr[t]; return !isWater(ter) && Number.isFinite(TERRAIN[ter].move) && ter !== T.LAVA; };

export function makeSandbox(g) {
  g.sandbox = true;
  for (const c of g.civs) if (!c.isRebel && !c.human) c.ai = null;           // no AI meddling
  for (const c of g.civs) if (c.isRebel) c.alive = false;
  const r = g.diplomacy.rel(0, 1); r.state = 'war'; r.since = g.time;
  for (const c of g.civs.slice(0, 2)) { for (const k of ['materials', 'food', 'steel', 'fuel', 'munitions', 'credits']) c.res[k] = 5000; }
}

// An open battlefield: the flattest stretch of land near the middle of the map.
export function findArena(g, need = 7) {
  const w = g.world;
  let best = -1, bs = -Infinity;
  for (let r = 10; r < H - 10; r += 3) for (let q = 12; q < W - 12; q += 3) {
    const t = r * W + q;
    if (!passable(g, t)) continue;
    let ok = 0, rough = 0;
    for (const n of disk(t, need)) { if (passable(g, n)) ok++; const tr = w.terr[n]; if (tr === T.MOUNTAIN || tr === T.MARSH || tr === T.FOREST) rough++; }
    let near = Infinity; for (const c of g.cities.values()) near = Math.min(near, dist(c.tile, t));
    const s = ok - rough * 0.5 - (near < 10 ? 50 : 0) - dist(t, (H >> 1) * W + (W >> 1)) * 0.2;
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

// Place `n` units of a type in a compact block around a tile (up to 3 per hex).
export function spawnGroup(g, civId, type, center, n, radius = 4) {
  const civ = g.civs[civId], out = [];
  const tiles = disk(center, radius).filter((t) => passable(g, t) || UNITS[type].air).sort((a, b) => dist(a, center) - dist(b, center) || a - b);
  let i = 0;
  for (const t of tiles) {
    for (let k = 0; k < 3 && i < n; k++, i++) { const u = spawnUnit(g, civ, type, t); u.stance = 'aggressive'; out.push(u); }
    if (i >= n) break;
  }
  g.rebuildTileUnits();
  return out;
}

const offset = (t, dq) => { const q = (t % W) + dq, r = (t / W) | 0; return r * W + Math.max(1, Math.min(W - 2, q)); };
const buildingSite = (g, t) => disk(t, 3).find((x) => passable(g, x) && !g.world.river[x] && g.tileB[x] < 0 && g.world.terr[x] !== T.MOUNTAIN);

export function clearForces(g) { for (const u of [...g.units.values()]) if (u.owner <= 1) g.units.delete(u.id); g.projectiles.clear(); g.pending.clear(); g.rebuildTileUnits(); }

export const SCENARIOS = {
  rifles: { name: '10 rifle squads vs 10', run(g, a) { return [spawnGroup(g, 0, 'rifle_squad', offset(a, -4), 10), spawnGroup(g, 1, 'rifle_squad', offset(a, 4), 10)]; } },
  mixed: { name: '20-unit mixed force vs 12 defenders', run(g, a) {
    const A = [...spawnGroup(g, 0, 'rifle_squad', offset(a, -5), 8), ...spawnGroup(g, 0, 'tank', offset(a, -6), 6), ...spawnGroup(g, 0, 'sp_artillery', offset(a, -9), 4), ...spawnGroup(g, 0, 'supply_truck', offset(a, -9), 2)];
    const B = [...spawnGroup(g, 1, 'rifle_squad', offset(a, 4), 6), ...spawnGroup(g, 1, 'mortar_team', offset(a, 6), 3), ...spawnGroup(g, 1, 'armored_car', offset(a, 5), 3)];
    for (const u of B) u.stance = 'defensive';
    return [A, B];
  } },
  armor: { name: 'Tank platoon vs fortified position', run(g, a) {
    const B = spawnGroup(g, 1, 'rifle_squad', offset(a, 4), 4);
    const site = buildingSite(g, offset(a, 4)); if (site !== undefined) g.placeBuilding(g.civs[1], 'bunker', site, true);
    return [spawnGroup(g, 0, 'tank', offset(a, -4), 6), B];
  } },
  artillery: { name: 'Artillery bombardment of a position', run(g, a) {
    return [spawnGroup(g, 0, 'sp_artillery', offset(a, -6), 6), spawnGroup(g, 1, 'rifle_squad', offset(a, 2), 9)];
  } },
  air: { name: 'Air operations: airfield, fighters, bomber, helicopter, drones vs troops and AA', run(g, a) {
    const free = (t) => buildingSite(g, t);
    for (const k of ['aviation', 'air_operations', 'drones', 'air_defense']) { g.civs[0].techs.add(k); g.civs[1].techs.add(k); }
    const airSite = free(offset(a, -9));
    const af = airSite === undefined ? null : g.placeBuilding(g.civs[0], 'airfield', airSite, true);
    const droneSite = free(offset(a, -7));
    const dw = droneSite === undefined ? null : g.placeBuilding(g.civs[0], 'drone_works', droneSite, true);
    const A = [];
    const based = (type, b, n) => { for (let i = 0; i < n; i++) { const u = spawnUnit(g, g.civs[0], type, b.tile); onAircraftBuilt(g, u, b); A.push(u); } };
    if (af) { based('fighter', af, 2); based('bomber', af, 1); based('helicopter', af, 1); }
    if (dw) { based('recon_drone', dw, 1); based('oneway_drone', dw, 2); }
    A.push(...spawnGroup(g, 0, 'rifle_squad', offset(a, -4), 3));
    const B = [...spawnGroup(g, 1, 'rifle_squad', offset(a, 5), 6), ...spawnGroup(g, 1, 'tank', offset(a, 6), 2)];
    const aaSite = free(offset(a, 7)); if (aaSite !== undefined) g.placeBuilding(g.civs[1], 'aa_battery', aaSite, true);
    for (const u of B) u.stance = 'defensive';
    g.rebuildTileUnits();
    return [A, B];
  } },
  strategic: { name: 'Strategic missiles: a stocked silo, an enemy army and upgraded AA', run(g, a) {
    const free = (t) => buildingSite(g, t);
    for (const k of ['strategic_missiles', 'air_defense', 'missile_defense']) { g.civs[0].techs.add(k); g.civs[1].techs.add(k); }
    const siloSite = free(offset(a, -10)); const silo = siloSite === undefined ? null : g.placeBuilding(g.civs[0], 'missile_silo', siloSite, true); if (silo) silo.missiles = 2;
    const B = [...spawnGroup(g, 1, 'tank', offset(a, 6), 9), ...spawnGroup(g, 1, 'rifle_squad', offset(a, 8), 6)];
    const aaSite = free(offset(a, 9)); const aa = aaSite === undefined ? null : g.placeBuilding(g.civs[1], 'aa_battery', aaSite, true); if (aa) aa.upgraded = true;
    for (const u of B) u.stance = 'hold';
    return [spawnGroup(g, 0, 'rifle_squad', offset(a, -6), 2), B];
  } },
  massive: { name: '500 vs 500 (performance)', run(g, a) {
    const mk = (civ, side) => [...spawnGroup(g, civ, 'rifle_squad', offset(a, side * 9), 300, 11), ...spawnGroup(g, civ, 'tank', offset(a, side * 14), 120, 8), ...spawnGroup(g, civ, 'mortar_team', offset(a, side * 17), 50, 6), ...spawnGroup(g, civ, 'armored_car', offset(a, side * 12), 30, 5)];
    return [mk(0, -1), mk(1, 1)];
  } },
  large: { name: '30 vs 30 combined arms', run(g, a) {
    const mk = (civ, side) => [...spawnGroup(g, civ, 'rifle_squad', offset(a, side * 4), 14), ...spawnGroup(g, civ, 'tank', offset(a, side * 6), 8), ...spawnGroup(g, civ, 'mortar_team', offset(a, side * 8), 5), ...spawnGroup(g, civ, 'armored_car', offset(a, side * 5), 3)];
    return [mk(0, -1), mk(1, 1)];
  } },
};

export function runScenario(g, key, arena = findArena(g)) {
  clearForces(g);
  const sc = SCENARIOS[key]; if (!sc) return { error: 'unknown scenario' };
  const [A, B] = sc.run(g, arena);
  return { arena, A: A.map((u) => u.id), B: B.map((u) => u.id), name: sc.name };
}

void N; void NB;
