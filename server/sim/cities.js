// City lifecycle: operational -> damaged -> besieged / defenseless -> captured or ruined -> rebuilding.
// - A town at zero strength is captured when enemy ground troops stand next to it; shelling alone
//   no longer pins it at 1 HP forever: past a cumulative limit it is ruined (siege resolution).
// - Capture brings the surrounding buildings now inside the captor's borders along with it.
// - Rebellion has cooldowns: a city that revolted cannot revolt again for ~300 s, an empire that just
//   lost a city to revolt cannot lose another for ~120 s, and a captured city is stabilized for a while.
//   All timers are plain fields on cities/civs, so they persist with saves.
// - Ruins of a town can be resettled (Rebuild Settlement) by whoever holds or borders the ground.
import { BUILDINGS, UNITS } from './constants.js';
import { dist, disk } from './hex.js';
import { recomputeTerritory } from './economy.js';

export const CITY_STATES = ['operational', 'damaged', 'besieged', 'defenseless', 'captured', 'rebuilding'];
export const REVOLT = { cityCooldown: 300, empireCooldown: 120, captureStabilize: 240, rebuildGrace: 180 };
export const SIEGE_RUIN = 1.5;          // cumulative damage (x max HP) absorbed at zero strength before ruin
export const REBUILD_COST = { materials: 160, credits: 120 };

// What state a city is in, and why (for the inspector, the AI and diagnostics).
export function cityState(g, c) {
  const b = g.buildings.get(c.buildingId ?? g.tileB[c.tile]);
  const hp = b ? b.hp / b.maxHp : 1;
  const enemies = [], friends = [];
  for (const u of g.units.values()) {
    if (UNITS[u.type].civilian || UNITS[u.type].air) continue;
    const d = dist(u.tile, c.tile); if (d > 4) continue;
    if (u.owner === c.owner) { if (d <= 3) friends.push(u); } else if (g.hostile(c.owner, u.owner)) enemies.push(u);
  }
  const defenses = [...disk(c.tile, 3)].some((t) => { const x = g.buildingAtTile(t); return x && x.owner === c.owner && x.done && BUILDINGS[x.type].attack && x.type !== 'town'; });
  if (c.rebuildUntil > g.time) return { state: 'rebuilding', why: `resettled ${Math.round(g.time - c.rebuiltAt)} s ago`, hp };
  if (c.capturedAt != null && g.time - c.capturedAt < REVOLT.captureStabilize) return { state: 'captured', why: `occupation stabilizing for ${Math.ceil(REVOLT.captureStabilize - (g.time - c.capturedAt))} s`, hp };
  const underFire = b && g.time - (b.lastHit || -99) < 10;
  if (enemies.length && !friends.length && !defenses) return { state: 'defenseless', why: `${enemies.length} enemy units near, no defenders`, hp, enemies: enemies.length };
  if (enemies.some((u) => dist(u.tile, c.tile) <= 2) && (underFire || hp < 0.5)) return { state: 'besieged', why: `${enemies.length} enemy units around the town${underFire ? ', under fire' : ''}`, hp, enemies: enemies.length };
  if (hp < 0.6) return { state: 'damaged', why: `town at ${Math.round(hp * 100)}%`, hp };
  return { state: 'operational', why: '', hp };
}

// Can this city revolt right now? (cooldowns and stabilization)
export function revoltBlocked(g, c) {
  const civ = g.civs[c.owner];
  if ((c.revoltCooldownUntil || 0) > g.time) return 'city revolted recently';
  if ((civ.revoltCooldownUntil || 0) > g.time) return 'another city of this nation revolted recently';
  if (c.capturedAt != null && g.time - c.capturedAt < REVOLT.captureStabilize) return 'post-capture stabilization';
  if ((c.rebuildUntil || 0) > g.time) return 'newly resettled';
  return '';
}
// after a revolt (or riots), start the cooldowns
export function noteRevolt(g, c, fromCivId) {
  c.revoltCooldownUntil = g.time + REVOLT.cityCooldown;
  const from = g.civs[fromCivId]; if (from) from.revoltCooldownUntil = g.time + REVOLT.empireCooldown;
  g.stats.revolts = (g.stats.revolts || 0) + 1;
}

// After a capture: the city is stabilized for a while, and buildings of the former owner that now
// stand inside the captor's borders change hands with it (no orphaned enemy farms in the new territory).
export function afterCapture(g, c, fromId) {
  c.capturedAt = g.time; c.unrestT = 0;
  let moved = 0;
  for (const b of g.buildings.values()) {
    if (b.owner !== fromId || b.type === 'town' || b.type === 'camp') continue;
    if (g.world.owner[b.tile] !== c.owner) continue;
    if (dist(b.tile, c.tile) > (c.radius || 3) + 3) continue;
    b.owner = c.owner; b.cityId = c.id; b.queue = []; b.rally = -1; delete b.works; b.upgrading = false; moved++;
  }
  g.stats.captures = (g.stats.captures || 0) + 1;
  return moved;
}

// A town held at zero strength under bombardment: ruin it once it has absorbed enough.
export function siegeDamage(g, b, city, amount, attackerCivId) {
  b.siegeDamage = (b.siegeDamage || 0) + amount;
  if (b.siegeDamage < b.maxHp * SIEGE_RUIN) return false;
  ruinCity(g, city, attackerCivId, 'combat');
  return true;
}

// Destroy a city: the town becomes ruins that remember its name and owner; the city's buildings fall
// to the nearest remaining city of their owner (or become ruins if there is none nearby).
export function ruinCity(g, city, byCivId, cause = 'combat') {
  const b = g.buildings.get(city.buildingId ?? g.tileB[city.tile]);
  const owner = g.civs[city.owner];
  g.cities.delete(city.id);
  if (b) g.removeBuilding(b);
  g.addRuin(city.tile, 'town', city.owner, city.name);
  const r = g.ruins.get(city.tile); if (r) { r.smoke = 120; r.ruinedBy = byCivId ?? -1; }
  for (const o of [...g.buildings.values()]) {
    if (o.cityId !== city.id) continue;
    const nc = g.nearestCityId(o.owner, o.tile);
    const near = nc >= 0 && g.cities.get(nc) && dist(g.cities.get(nc).tile, o.tile) <= 10;
    if (near) o.cityId = nc;
    else { g.removeBuilding(o); g.addRuin(o.tile, o.type, o.owner); }
  }
  recomputeTerritory(g);
  g.notify(owner.id, `${city.name} has been reduced to ruins${cause === 'combat' ? ' by the bombardment' : ''}.`, { kind: 'loss', tile: city.tile, level: 'major' });
  if (byCivId != null && g.civs[byCivId]) g.notify(byCivId, `${city.name} lies in ruins. Its people have scattered.`, { kind: 'city', tile: city.tile });
  g.stats.ruined = (g.stats.ruined || 0) + 1;
  if (!g.cityOf(owner).length) { if (!owner.isRebel) g.eliminate(owner); }
  else if (!g.cityOf(owner).some((c) => c.capital)) g.cityOf(owner)[0].capital = true;
}

// Rebuild Settlement: resettle the ruins of a town on ground you hold or that borders your land.
export function rebuildProblem(g, civ, tile) {
  const r = g.ruins.get(tile);
  if (!r || r.type !== 'town') return 'no town ruins here';
  if (g.world.river[tile]) return 'Choose dry land beside the river';
  const o = g.world.owner[tile];
  if (o >= 0 && o !== civ.id) return 'the ruins are inside another nation\'s borders';
  if (o < 0 && !disk(tile, 3).some((t) => g.world.owner[t] === civ.id)) return 'the ruins must be inside or next to your borders';
  if ([...g.units.values()].some((u) => g.hostile(civ.id, u.owner) && !UNITS[u.type].civilian && dist(u.tile, tile) <= 3)) return 'enemy troops are too close';
  if (g.tileB[tile] >= 0) return 'something already stands here';
  if (!g.canAfford(civ, REBUILD_COST, tile)) return `needs ${REBUILD_COST.materials} materials and ${REBUILD_COST.credits} credits`;
  return '';
}
export function rebuildSettlement(g, civ, tile) {
  const why = rebuildProblem(g, civ, tile);
  if (why) return { error: why };
  const r = g.ruins.get(tile);
  g.pay(civ, REBUILD_COST, tile, 'construction');
  g.ruins.delete(tile);
  const c = g.foundCity(civ, tile, 3);
  if (r.name) c.name = r.name;
  c.rebuiltAt = g.time; c.rebuildUntil = g.time + REVOLT.rebuildGrace; c.stability = Math.max(c.stability, 55);
  recomputeTerritory(g);
  g.notify(civ.id, `${c.name} has been resettled.`, { kind: 'city', tile });
  g.stats.rebuilt = (g.stats.rebuilt || 0) + 1;
  return { reply: { t: 'ack', city: c.id, name: c.name } };
}

// city-resolution diagnostics
export function cityDiagnostics(g, c) {
  const b = g.buildings.get(c.buildingId ?? g.tileB[c.tile]);
  const s = cityState(g, c);
  return { id: c.id, name: c.name, owner: c.owner, ...s, hpAbs: b ? Math.round(b.hp) : 0, siegeDamage: Math.round(b?.siegeDamage || 0), ruinAt: b ? Math.round(b.maxHp * SIEGE_RUIN) : 0,
    stability: Math.round(c.stability), unrest: +(c.unrestT || 0).toFixed(1), revolt: revoltBlocked(g, c) || 'possible if unrest persists',
    cityCooldown: Math.max(0, Math.round((c.revoltCooldownUntil || 0) - g.time)), empireCooldown: Math.max(0, Math.round((g.civs[c.owner].revoltCooldownUntil || 0) - g.time)) };
}
