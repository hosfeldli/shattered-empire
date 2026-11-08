// Opportunity Director. Every few seconds, for each human empire, find a small number of
// significant situations that already exist in the simulation and that the player can see,
// each with one direct action: a deposit worth working, a city ready to grow, rival forces
// massing near the border, damaged infrastructure, research waiting on a choice. Nothing is
// invented and fog of war is respected (explored for terrain, visible for troops). Suggestions
// are optional: at most two at a time; dismissed or acted-on ones stay quiet for a while.
import { BUILDINGS, UNITS, RES } from './constants.js';
import { disk, dist } from './hex.js';

const DEPOSIT_BUILDING = { [RES.IRON]: 'mine', [RES.COAL]: 'mine', [RES.OIL]: 'oil_well', [RES.STONE]: 'quarry', [RES.RUINS]: 'salvage' };
const DEPOSIT_NAME = { [RES.IRON]: 'Iron ore', [RES.COAL]: 'Coal', [RES.OIL]: 'Oil', [RES.STONE]: 'Stone', [RES.RUINS]: 'Old-world ruins' };
const DEPOSIT_GOOD = { [RES.IRON]: 'ore', [RES.COAL]: 'ore', [RES.OIL]: 'fuel', [RES.STONE]: 'materials', [RES.RUINS]: 'materials' };
const QUIET = 240;             // seconds a dismissed or acted-on suggestion stays away
const MAX = 2;

export function opportunityStep(g) {
  for (const civ of g.civs) {
    if (!civ || !civ.human || !civ.alive) continue;
    const quiet = civ.oppQuiet || (civ.oppQuiet = {});
    for (const k of Object.keys(quiet)) if (quiet[k] < g.time) delete quiet[k];
    const found = [];
    const add = (o) => { if (!quiet[o.key]) found.push(o); };
    const mine = g.cityOf(civ);
    const own = (t) => g.world.owner[t] === civ.id;
    // rival forces massing near our land (visible troops only)
    const near = new Map();
    for (const u of g.units.values()) {
      if (!g.hostile(civ.id, u.owner) || !civ.visible[u.tile] || UNITS[u.type].air || UNITS[u.type].civilian) continue;
      const c = mine.find((x) => dist(x.tile, u.tile) <= 9); if (!c) continue;
      const e = near.get(c.id) || { c, n: 0, tiles: [] }; e.n++; e.tiles.push(u.tile); near.set(c.id, e);
    }
    for (const e of near.values()) if (e.n >= 5) {
      const at = e.tiles[Math.floor(e.tiles.length / 2)];
      const defenders = [...g.units.values()].filter((u) => u.owner === civ.id && !UNITS[u.type].civilian && !UNITS[u.type].air && dist(u.tile, e.c.tile) <= 8).map((u) => u.id).slice(0, 40);
      add({ key: `thr:${e.c.id}`, k: 'threat', p: 90, tile: at, title: `Rival forces near ${e.c.name}`, text: `${e.n} enemy units are visible within striking distance of ${e.c.name}.`, actions: [['Go to', 'goto'], ...(defenders.length ? [[`Select ${defenders.length} nearby troops`, 'select']] : [])], units: defenders });
    }
    // damaged buildings and infrastructure
    for (const b of g.buildings.values()) {
      if (b.owner !== civ.id || !b.done || b.works || b.hp >= b.maxHp * 0.5) continue;
      add({ key: `dmg:${b.id}`, k: 'damage', p: 70, tile: b.tile, building: b.id, title: `${BUILDINGS[b.type].name} damaged`, text: `It is at ${Math.round((100 * b.hp) / b.maxHp)}% and works poorly until repaired.`, actions: [['Repair', 'repair'], ['Go to', 'goto']] });
      break;
    }
    // a city ready to grow, with no plan yet
    for (const c of mine) {
      if (c.plan || !(c.housing > 0) || c.pop < c.housing * 0.85) continue;
      add({ key: `grow:${c.id}`, k: 'grow', p: 55, tile: c.tile, city: c.id, title: `${c.name} is ready to grow`, text: `${Math.round(c.pop)} people in homes for ${Math.round(c.housing)}: choose where it should expand.`, actions: [['Guide growth', 'guide'], ['Go to city', 'goto']] });
      break;
    }
    // an explored deposit on or just beyond our land that we could work now
    let best = null;
    for (const c of mine) for (const t of disk(c.tile, (c.radius || 3) + 2)) {
      const r = g.world.res[t], type = DEPOSIT_BUILDING[r];
      if (!type || !civ.explored[t] || g.tileB[t] >= 0 || !own(t)) continue;
      if (!g.canPlace(civ, type, t, true)) continue;
      const short = (civ.short && civ.short.has(DEPOSIT_GOOD[r])) ? 30 : 0;
      const s = short - dist(c.tile, t);
      if (!best || s > best.s) best = { s, t, r, type, c };
    }
    if (best) add({ key: `dep:${best.t}`, k: 'deposit', p: 40 + (best.s > 0 ? 25 : 0), tile: best.t, build: best.type, title: `${DEPOSIT_NAME[best.r]} near ${best.c.name}`, text: `A ${BUILDINGS[best.type].name} here would supply ${DEPOSIT_GOOD[best.r]}${best.s > 0 ? ', which you are short of' : ''}.`, actions: [[`Build ${BUILDINGS[best.type].name}`, 'build'], ['Go to', 'goto']] });
    // research waiting on a choice or on goods
    if (!civ.researching) add({ key: 'research', k: 'research', p: 35, title: 'Research is idle', text: 'Choose what your nation learns next.', actions: [['Open research', 'research']] });
    found.sort((a, b) => b.p - a.p);
    civ.opps = found.slice(0, MAX);
  }
}

// the player acted on or dismissed a suggestion: keep it quiet for a while
export function quietOpportunity(g, civ, key) {
  if (typeof key !== 'string' || key.length > 40) return { error: 'unknown suggestion' };
  (civ.oppQuiet || (civ.oppQuiet = {}))[key] = g.time + QUIET;
  civ.opps = (civ.opps || []).filter((o) => o.key !== key);
  return null;
}
