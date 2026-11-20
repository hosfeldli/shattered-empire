// BLIGHT survival mode (docs/gameplay-overhaul/HORDE_MODE.md): creature roster and the wave-scaling formulas.
//
// Everything here is pure data and pure functions of (wave, elapsed seconds, players), so the scaling can be tested
// and tuned without a match. The simulation itself lives in horde.js.
//
// The Blight is an original creation for this game: a fungal-flesh contagion that grows out of the ground in hives,
// sends waves of mutated organisms at anything that lives, and raises fallen soldiers as husks.

import { ACTION_UNITS } from './actionDefinitions.js';

export const HORDE_OBJECTIVE = 'horde';
export const HORDE_PREFIX = 'blight_';
export const HORDE_NAME = 'The Blight';
export const HORDE_COLOR = '#8fae2c';   // sickly yellow-green, outside every team palette

/**
 * Creature roster. hp / dmg / speed are the wave-1 values before scaling; `cd` the strike cooldown (s), `reach` the
 * strike distance beyond both bodies (world units; a hex is ~1.73), `vsB` the multiplier against structures, `points`
 * what one costs from a wave's budget. role: swarm (hunts soft targets: troops first), ranged (spits acid from range),
 * brute (smashes structures, defenses first), carrier (bursts into swarmers when it dies), boss (slams everything
 * around it), hive (immobile nest, spawns waves and spreads the corrupted ground).
 */
export const CREATURES = {
  blight_crawler: { name: 'Crawler', glyph: 'CR', role: 'swarm', hp: 30, dmg: 3, cd: .9, speed: 1.18, radius: .1, reach: .16, vsB: .35, points: 3, aggro: 3.4, vision: 4.6,
    desc: 'A skittering knot of claws and exposed sinew. Fast, fragile and never alone.' },
  blight_husk: { name: 'Husk', glyph: 'HU', role: 'swarm', hp: 48, dmg: 3.5, cd: 1, speed: .95, radius: .12, reach: .16, vsB: .4, points: 4, aggro: 3.2, vision: 4.4,
    desc: 'A fallen soldier the Blight has raised. It still wears the uniform.' },
  blight_spitter: { name: 'Spitter', glyph: 'SP', role: 'ranged', hp: 52, dmg: 6, cd: 2.3, speed: .82, radius: .13, reach: 2.4, vsB: .7, points: 7, aggro: 3.9, vision: 5,
    splash: .5, desc: 'A swollen throat-sac that hurls corrosive bile over the heads of the swarm.' },
  blight_mauler: { name: 'Mauler', glyph: 'MA', role: 'brute', hp: 260, dmg: 20, cd: 1.8, speed: .74, radius: .22, reach: .2, vsB: 4, points: 16, aggro: 2.6, vision: 4.4,
    desc: 'A hunched slab of armoured gristle with battering-ram forearms. It goes for walls and guns.' },
  blight_broodsac: { name: 'Broodsac', glyph: 'BS', role: 'carrier', hp: 120, dmg: 3, cd: 1.1, speed: .66, radius: .2, reach: .18, vsB: .3, points: 12, aggro: 2.4, vision: 4.2,
    brood: 4, desc: 'A lurching, translucent bladder packed with unborn crawlers. Kill it and they spill out.' },
  blight_colossus: { name: 'Colossus', glyph: 'CO', role: 'boss', hp: 2400, dmg: 45, cd: 2.4, speed: .6, radius: .38, reach: .3, vsB: 5, points: 120, aggro: 3, vision: 5.5,
    slam: .85, desc: 'A walking mountain of fused bodies. Its slam flattens squads and bunkers alike.' },
  blight_hive: { name: 'Blight Hive', glyph: 'HV', role: 'hive', hp: 900, dmg: 0, cd: 99, speed: 0, radius: .5, reach: 0, vsB: 0, points: 0, aggro: 0, vision: 5.5,
    desc: 'A pulsing mound of rot that births the waves and corrupts the ground around it. Burn it for supplies.' },
};
export const HORDE_TYPES = Object.keys(CREATURES);
export const isHordeType = (type) => typeof type === 'string' && type.startsWith(HORDE_PREFIX);

// The creatures join ACTION_UNITS so combat, snapshots and the client's hover card treat them as units. They are
// `auto` (never trainable: actionDefinitions builds the training lists before this module loads) and carry no
// `weapon` (actionCombat skips them; horde.js resolves their strikes).
for (const [key, c] of Object.entries(CREATURES)) {
  if (ACTION_UNITS[key]) continue;
  ACTION_UNITS[key] = {
    name: c.name, glyph: c.glyph, move: 'infantry', cat: 'horde', air: false, tier: 1, age: 0, facility: null, auto: true, horde: c.role,
    cost: { materials: 0, energy: 0 }, capacity: 0, time: 0, hp: c.hp, atk: c.dmg, def: 0, vision: c.vision, speed: c.speed,
    range: Math.max(.3, c.reach), radius: c.radius, weapon: null, antiBuilding: c.vsB, capture: false, desc: c.desc,
  };
}

/**
 * Tuning. `cap` bounds the live creatures (performance budget: the server tick must hold at any wave); strength past
 * it becomes elite levels. `prep` is the build-up before wave 1; breathers shorten from `breather.first` to
 * `breather.min`. Everything else scales smoothly without an upper bound.
 */
export const HORDE = {
  cap: 160,
  prep: 75,
  breather: { first: 40, min: 14, perWave: 1.3 },
  bossEvery: 5,
  burrowFrom: 8,           // waves from which some groups tunnel up close to a base
  hiveFirst: 2,            // hives at the start (+1 per extra player, at most hiveMax)
  hiveEvery: 3,            // a new hive grows every N waves
  hiveMax: 9,
  blightRadius: { start: 2, max: 7, grow: 30 },   // hexes; +1 hex every `grow` seconds up to max + wave / 6
  riseDelay: 3.5,          // seconds from an infantry squad's death to its husks standing up
  maxWaveSeconds: 80,      // + 2.5 s per wave: after this the next breather starts even with stragglers alive
  supply: { materials: 140, energy: 35, perWaveMaterials: 32, perWaveEnergy: 10 },
  hiveReward: { materials: 260, energy: 90, score: 600 },
};

/** Pressure level: wave number plus elapsed time (one extra level every four minutes). 0 at the first wave. */
export function hordeLevel(wave, seconds = 0) {
  return Math.max(0, wave - 1) + Math.max(0, seconds) / 240;
}

/** Scaling multipliers at pressure level L. hp and damage grow without bound; speed approaches +35%. */
export function hordeScale(L) {
  return {
    hp: 1 + .07 * L + .0012 * L * L,
    dmg: 1 + .045 * L,
    speed: 1 + .35 * (1 - Math.exp(-L / 18)),
  };
}

/** A wave's spawn budget in points: grows as (1 + L)^1.3, more for more players (co-op). */
export function wavePoints(L, players = 1) {
  const coop = 1 + .55 * Math.max(0, Math.min(8, players) - 1);
  return Math.round(30 * Math.pow(1 + L, 1.3) * coop);
}

/** How many creatures one wave may field at once (before elite conversion), never above the live cap. */
export function waveCountLimit(L, cap = HORDE.cap) {
  return Math.max(8, Math.min(Math.floor(cap * .85), Math.round(14 + 5 * L)));
}

/** Composition weights at level L (crawlers always dominate early; heavier strains join as pressure rises). */
export function compositionWeights(L) {
  return {
    blight_crawler: 10,
    blight_spitter: L >= 1 ? Math.min(4, .6 + .25 * L) : 0,
    blight_mauler: L >= 2 ? Math.min(3.5, .4 + .2 * L) : 0,
    blight_broodsac: L >= 4 ? Math.min(2.5, .2 + .12 * L) : 0,
  };
}

/** Breather length (s) before the next wave: shortens wave by wave down to a floor. */
export function breatherSeconds(wave) {
  return Math.max(HORDE.breather.min, HORDE.breather.first - HORDE.breather.perWave * Math.max(0, wave - 1));
}

/** Bosses in a wave: one every `bossEvery` waves, one more each 15 waves. */
export function bossCount(wave) {
  return wave > 0 && wave % HORDE.bossEvery === 0 ? 1 + Math.floor(wave / 15) : 0;
}

/** Elite level multipliers: tougher, harder-hitting, bigger blobs; an elite costs 2^level points. */
export const eliteHp = (e) => Math.pow(1.7, e);
export const eliteDmg = (e) => Math.pow(1.32, e);
export const eliteSize = (e) => Math.min(1.6, 1 + .12 * e);

/**
 * Plans a wave's roster from its budget: picks creatures by weight with `rand` (game.rng), then, while the roster is
 * larger than the count limit, promotes the cheapest creatures to the next elite level (two of a level merge into one
 * of the next). The total strength (points) is preserved; only the count is bounded. Returns [[type, elite], ...].
 */
export function planRoster(L, players, rand, cap = HORDE.cap) {
  let budget = wavePoints(L, players);
  const weights = Object.entries(compositionWeights(L)).filter(([, w]) => w > 0);
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const roster = [];
  while (budget >= CREATURES.blight_crawler.points) {
    let r = rand() * total, pick = weights[0][0];
    for (const [k, w] of weights) { r -= w; if (r <= 0) { pick = k; break; } }
    const cost = CREATURES[pick].points;
    if (cost > budget) { if (budget >= CREATURES.blight_crawler.points) { roster.push([HORDE_PREFIX + 'crawler', 0]); budget -= CREATURES.blight_crawler.points; } continue; }
    roster.push([pick, 0]);
    budget -= cost;
  }
  return fitRoster(roster, waveCountLimit(L, cap));
}

/**
 * Bounds a roster's size: pairs of the same type and level merge into one of the next level (cheapest, lowest level
 * first) until at most `limit` remain, preserving the points. Groups by count, so a wave of thousands of points plans
 * in microseconds. The result is ordered by type order then level (deterministic).
 */
export function fitRoster(roster, limit) {
  const types = HORDE_TYPES;
  const counts = new Map();   // type index * 64 + level -> count
  for (const [type, e] of roster) { const k = types.indexOf(type) * 64 + Math.min(63, e); counts.set(k, (counts.get(k) || 0) + 1); }
  let total = roster.length;
  while (total > limit) {
    let best = -1, bestCost = Infinity;
    for (const [k, n] of counts) {
      if (n < 2) continue;
      const cost = CREATURES[types[k >> 6]].points * Math.pow(2, k & 63);
      if (cost < bestCost || cost === bestCost && k < best) { bestCost = cost; best = k; }
    }
    if (best < 0) {
      // every group is a single creature: promote the cheapest and drop the next cheapest (rare, tiny rosters)
      const keys = [...counts.keys()].sort((a, b) => a - b);
      const [a, b] = keys;
      counts.delete(a); counts.delete(b);
      counts.set((a & ~63) + Math.min(63, (a & 63) + 1), (counts.get((a & ~63) + Math.min(63, (a & 63) + 1)) || 0) + 1);
      total--;
      continue;
    }
    const n = counts.get(best), pairs = Math.min(Math.floor(n / 2), total - limit);
    counts.set(best, n - 2 * pairs);
    if (!counts.get(best)) counts.delete(best);
    const up = (best & ~63) + Math.min(63, (best & 63) + 1);
    counts.set(up, (counts.get(up) || 0) + pairs);
    total -= pairs;
  }
  const out = [];
  for (const k of [...counts.keys()].sort((a, b) => a - b)) for (let i = 0; i < counts.get(k); i++) out.push([types[k >> 6], k & 63]);
  return out;
}

/** A roster's total strength in points (an elite counts 2^level times its type's cost). */
export function rosterPoints(roster) {
  return roster.reduce((s, [type, e]) => s + CREATURES[type].points * Math.pow(2, e), 0);
}

/** Score for killing a creature. */
export const killScore = (type, elite) => Math.round((CREATURES[type]?.points || 1) * 5 * Math.pow(2, elite || 0));
