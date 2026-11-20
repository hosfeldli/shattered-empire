// Per-building upgrades (2026-11-20, docs/gameplay-overhaul/BASE_MENU_REWORK.md, Ticket 3).
//
// Commands: unitUpgrade { id, unit } (a unit's line, next tier, at the building that trains it), engineerUpgrade { site },
// centreTurret { site }, perimeterUpgrade { id, path? } (a perimeter turret: choose its path, then deepen it).
// One research project per building at a time (b.upg = { kind, key, level, left, total }), alongside its production and
// its b.project. Everything is deterministic: no RNG, ordered scans only.
//
// Units carry what their building gave them: u.src (the building id) and u.mods (the mechanic of their upgrade line and
// its tier, the kit bits the client draws: unit record extra[7]). A completed upgrade restamps the living units that
// building made. The mechanics hook into combat (actionCombat: afterFire, incoming, blastRadius, salvoExtra, rofMul),
// sight (actionGame.sees / revealSource: camouflage and detection), movement (speedMul) and this module's upgradeStep.
import { ACTION_BUILDINGS, ACTION_UNITS, BUILDING_LEVEL, CENTRE_TURRET, ENGINEER_UPGRADES, PERIMETER_COST, PERIMETER_PATHS, PERIMETER_TIME,
  TIERS, trainsAt } from './actionDefinitions.js';
import { KIT_TIER_SHIFT, MECH, OUTPOST } from './baseMenuDefs.js';
import { WEAPONS, WEAPON_KEYS } from './weapons.js';
import { distance, tileAt } from './actionNavigation.js';
import { emit } from './combat.js';
import { addSmoke } from './battlefield.js';
import { disk } from './hex.js';
import { headquarters, setLevel } from './actionBases.js';
import { fireAtgm } from './actionCombat.js';
import { unitHp } from './matchRules.js';   // Ticket 4: the match's unit health multiplier

const VID = Object.fromEntries(WEAPON_KEYS.map((key, index) => [key, index]));
const RES = ['materials', 'energy'];
const canPay = (civ, cost) => RES.every((k) => civ.res[k] >= (cost[k] || 0));
const pay = (civ, cost) => { for (const k of RES) civ.res[k] -= cost[k] || 0; };
const funds = { error: 'Insufficient materials or energy.', code: 'funds' };
const AT = new Set(MECH.AT_WEAPONS), AA = new Set(MECH.AA_WEAPONS);
const SMALL = new Set(['carbine', 'rifle', 'smg_team', 'mg', 'mg_light', 'pistol', 'coax']);
const unitDef = (o) => o?.isUnit ? ACTION_UNITS[o.type] : null;
const armoured = (v) => { const d = unitDef(v); return d ? !d.air && (d.move === 'tracked' || d.move === 'wheeled') : ACTION_BUILDINGS[v?.type]?.armor === 'fortified'; };

function begin(b, kind, key, level, time) { b.upg = { kind, key, level, left: time, total: time }; }
const busy = (b) => b.upg ? { error: 'This building is already researching an upgrade.', code: 'busy' } : null;

// ---- commands --------------------------------------------------------------------------------------------------

/** Command unitUpgrade { id, unit }: the next tier of `unit`'s line at building `id` (it must train the unit). */
export function unitUpgrade(game, civ, id, unit) {
  const b = game.buildings.get(id), d = Object.hasOwn(ACTION_UNITS, unit) ? ACTION_UNITS[unit] : null;
  if (b?.owner !== civ.id || !b.done) return { error: 'Select one of your operational buildings.' };
  if (!d?.upgrade || !ACTION_BUILDINGS[b.type]?.trains?.includes(unit)) return { error: 'This building has no upgrade for that unit.', code: 'unit' };
  if (!trainsAt(b, unit)) return { error: `Requires outpost tier ${ACTION_BUILDINGS[b.type].trainsAt[unit]}.`, code: 'tier' };
  const tier = (b.ug?.[unit] || 0) + 1;
  if (tier > 3) return { error: `${d.upgrade.name} is fully upgraded here.`, code: 'max' };
  const era = Math.max(tier, d.tier);
  if (civ.age + 1 < era) return { error: `${d.upgrade.name} ${'I'.repeat(tier)} requires Era ${TIERS[era - 1].label}.`, code: 'era' };
  const spec = d.upgrade.tiers[tier - 1];
  if (busy(b)) return busy(b);
  if (!canPay(civ, spec.cost)) return funds;
  pay(civ, spec.cost);
  begin(b, 'unit', unit, tier, spec.time);
  return { reply: { t: 'ack', upgrade: { unit, tier } } };
}

/** Command engineerUpgrade { site }: the base's next engineer upgrade (level n needs base tier n). */
export function engineerUpgrade(game, civ, site) {
  const hq = headquarters(game, site);
  if (!site?.slots || site.owner !== civ.id || !hq?.done) return { error: 'Select an operational headquarters.' };
  const level = (site.engLevel || 0) + 1, spec = ENGINEER_UPGRADES[level - 1];
  if (!spec) return { error: 'The engineers are fully upgraded.', code: 'max' };
  if ((site.tier || 1) < level) return { error: `${spec.name} requires a Tier ${TIERS[level - 1].label} base.`, code: 'tier' };
  if (busy(hq)) return busy(hq);
  if (!canPay(civ, spec.cost)) return funds;
  pay(civ, spec.cost);
  begin(hq, 'engineer', 'engineer', level, spec.time);
  return { reply: { t: 'ack', upgrade: { engineer: level } } };
}

/** Command centreTurret { site }: the headquarters' centre turret, next level (level n needs base tier n). */
export function centreTurret(game, civ, site) {
  const hq = headquarters(game, site);
  if (!site?.slots || site.owner !== civ.id || !hq?.done) return { error: 'Select an operational headquarters.' };
  const level = (hq.gun || 0) + 1, spec = CENTRE_TURRET.levels[level - 1];
  if (!spec) return { error: 'The centre turret is fully upgraded.', code: 'max' };
  if ((site.tier || 1) < level) return { error: `${spec.name} requires a Tier ${TIERS[level - 1].label} base.`, code: 'tier' };
  if (busy(hq)) return busy(hq);
  if (!canPay(civ, spec.cost)) return funds;
  pay(civ, spec.cost);
  begin(hq, 'gun', 'gun', level, spec.time);
  return { reply: { t: 'ack', upgrade: { gun: level } } };
}

/** Command perimeterUpgrade { id, path? }: a perimeter turret chooses its path (level 1), then deepens it (level n needs era n). */
export function perimeterUpgrade(game, civ, id, path) {
  const b = game.buildings.get(id);
  if (b?.owner !== civ.id || !b.done || b.type !== 'city_turret' || !b.perimeterSlot) return { error: 'Select one of your perimeter turrets.' };
  if (!b.path && !Object.hasOwn(PERIMETER_PATHS, path || '')) return { error: 'Choose a path: anti-air, anti-infantry or anti-vehicle.', code: 'path' };
  if (b.path && path && path !== b.path) return { error: `This turret is on the ${PERIMETER_PATHS[b.path].name} path.`, code: 'path' };
  const level = b.path ? (b.level || 1) + 1 : 1;
  if (level > 3) return { error: 'This turret is fully upgraded.', code: 'max' };
  if (civ.age + 1 < level) return { error: `Level ${level} requires Era ${TIERS[level - 1].label}.`, code: 'era' };
  if (b.project) return { error: 'This turret already has a project underway.', code: 'busy' };
  if (busy(b)) return busy(b);
  const cost = PERIMETER_COST[level - 1];
  if (!canPay(civ, cost)) return funds;
  pay(civ, cost);
  begin(b, 'path', b.path || path, level, PERIMETER_TIME[level - 1]);
  return { reply: { t: 'ack', upgrade: { path: b.path || path, level } } };
}

/** Advances a building's research (productionStep, every 3 ticks). */
export function researchStep(game, civ, b, dt) {
  const r = b.upg;
  if (!r) return;
  r.left = Math.max(0, r.left - dt);
  if (r.left > 1e-4) return;
  b.upg = null;
  if (r.kind === 'unit') {
    (b.ug ??= {})[r.key] = r.level;
    for (const u of game.units.values()) if (u.src === b.id && u.type === r.key && u.hp > 0) stampUnit(game, u, b);
    game.notify(civ.id, `${ACTION_UNITS[r.key].upgrade.name} ${'I'.repeat(r.level)} ready at the ${ACTION_BUILDINGS[b.type].name}.`, { kind: 'tech', tile: b.tile });
  } else if (r.kind === 'engineer') {
    const site = game.siteById.get(b.site);
    if (site) site.engLevel = Math.max(site.engLevel || 0, r.level);
    for (const u of game.units.values()) if (u.auto && u.home === b.site && u.owner === b.owner) stampEngineer(game, u, site);
    game.notify(civ.id, `Engineers: ${ENGINEER_UPGRADES[r.level - 1].name}.`, { kind: 'tech', tile: b.tile });
  } else if (r.kind === 'gun') {
    b.gun = r.level;
    game.notify(civ.id, `Centre turret: ${CENTRE_TURRET.levels[r.level - 1].name}.`, { kind: 'tech', tile: b.tile });
  } else if (r.kind === 'path') {
    b.path = r.key;
    if (r.level > 1) setLevel(b, r.level);
    game.territoryDirty = true;
    game.notify(civ.id, `Perimeter turret: ${PERIMETER_PATHS[r.key].name} ${r.level} (${PERIMETER_PATHS[r.key].levels[r.level - 1]}).`, { kind: 'building', tile: b.tile });
  }
}

// ---- unit stamps -----------------------------------------------------------------------------------------------

function lineMods(d, tier) {
  const spec = d.upgrade.tiers[tier - 1], mods = { mech: d.upgrade.mech, tier, kit: d.upgrade.kit | tier << KIT_TIER_SHIFT };
  for (const [k, v] of Object.entries(spec)) if (k !== 'tier' && k !== 'cost' && k !== 'time') mods[k] = v;
  return mods;
}

/** Sets a unit's mods and rescales its health to the new maximum (base hp x mods.hp), keeping its health fraction. */
export function setMods(u, mods) {
  const d = ACTION_UNITS[u.type];
  if (mods) u.mods = mods; else delete u.mods;
  const max = unitHp(d) * (mods?.hp || 1);   // Ticket 4: the match's unit health multiplier (matchRules.js)
  if (u.maxHp > 0 && Math.abs(max - u.maxHp) > 1e-6) {
    u.hp = u.hp > 0 ? Math.max(1e-3, Math.round(u.hp / u.maxHp * max * 1000) / 1000) : 0;
    u.maxHp = max;
  }
}

/** Veterancy rank a production building's level gives the units it trains (BUILDING_LEVEL.rank). */
export const levelRank = (b) => ACTION_BUILDINGS[b?.type]?.levels?.effect === 'production' ? BUILDING_LEVEL.rank[Math.max(0, Math.min(2, (b.level || 1) - 1))] : 0;

/** A unit that left building b: its source, its upgrade line's mods and the building's veterancy. */
export function stampUnit(game, u, b) {
  const d = ACTION_UNITS[u.type];
  u.src = b.id;
  const tier = d?.upgrade ? b.ug?.[u.type] || 0 : 0;
  setMods(u, tier ? lineMods(d, tier) : null);
  const rank = levelRank(b);
  if (rank) u.kills = Math.max(u.kills || 0, rank * 4);
}

/** A production building reached a new level: the living units it made gain its veterancy. */
export function promoteUnits(game, b) {
  const rank = levelRank(b);
  if (!rank) return;
  for (const u of game.units.values()) if (u.src === b.id && u.hp > 0) u.kills = Math.max(u.kills || 0, rank * 4);
}

/** A base engineer: the base's engineer upgrades (ENGINEER_UPGRADES, cumulative). */
export function stampEngineer(game, u, site) {
  const level = site?.engLevel || 0;
  if (!level) { setMods(u, null); return; }
  const mods = { mech: 'engineer', tier: level, kit: level << KIT_TIER_SHIFT };
  for (let i = 0; i < level; i++) {
    const s = ENGINEER_UPGRADES[i];
    mods.kit |= s.kit;
    if (s.hp) mods.hp = s.hp;
    if (s.steady) mods.steady = true;
    if (s.speed) mods.speed = s.speed;
    if (s.build) mods.build = s.build;
  }
  setMods(u, mods);
}

/** The kit bits of a unit for the client (unit record extra[7]). */
export const kitBits = (u) => u.mods?.kit || 0;

// ---- mechanics: structures --------------------------------------------------------------------------------------

let PATH_DEFS = null;   // built on first use (module cycles: the definitions may not be evaluated yet at import)
/** The combat definition of a structure: a perimeter turret on a path fights with its path's weapon. */
export function structureDef(b) {
  if (!b.path) return ACTION_BUILDINGS[b.type];
  if (!PATH_DEFS) {
    PATH_DEFS = {};
    for (const [key, p] of Object.entries(PERIMETER_PATHS)) PATH_DEFS[key] = { ...ACTION_BUILDINGS.city_turret, weapon: p.weapon, attack: p.attack, range: p.range, vision: p.vision, path: key };
  }
  return PATH_DEFS[b.path] || ACTION_BUILDINGS[b.type];
}

/** Extra range of a structure from its upgrades: the searchlight (anti-infantry 3), the heavy centre gun (3). */
export function structureReach(b) {
  if (b.path === 'ai' && (b.level || 1) >= 3) return .6;
  if (b.type === 'town' && (b.gun || 0) >= 3) return .8;
  return 0;
}

/** True when a base has its anti-aircraft umbrella: an anti-air perimeter turret at level 2+, or the centre turret's airburst fuze. */
export function baseAirCover(game, site, hq = headquarters(game, site)) {
  if (!site) return false;
  if ((hq?.gun || 0) >= 2) return true;
  for (const o of game.buildings.values()) if (o.site === site.id && o.perimeterSlot && o.done && o.path === 'aa' && (o.level || 1) >= 2 && o.owner === site.owner) return true;
  return false;
}

// ---- mechanics: combat hooks (actionCombat) ----------------------------------------------------------------------

function lob(game, shooter, target, weapon, damage, radius, flag, extra = {}) {
  const w = WEAPONS[weapon], t = tileAt(target.x, target.z);
  if (t < 0) return;
  const flight = (w.flight || .7) * .55 + Math.min(.5, distance(shooter, target) * .04);
  const id = game.id_();
  game.projectiles.set(id, { id, owner: shooter.owner, shooter: shooter.id, from: shooter.tile, ax: shooter.x, az: shooter.z, to: t,
    x: target.x, z: target.z, weapon, damage, radius, arrive: game.time + flight, target: radius ? 0 : target.id || 0, air: false, small: true, ...extra });
  emit(game, { k: 'launch', a: shooter.tile, b: t, s: shooter.id, t: target.id, w: VID[weapon], f: flight,
    ax: shooter.x, az: shooter.z, bx: target.x, bz: target.z, [flag]: 1 });
}

/** Damage multiplier on a shot: an ambush from camouflage (t3), the heavy centre gun against vehicles. */
export function fireMul(game, actor, target) {
  let f = 1;
  const m = actor.mods;
  if (m?.mech === 'camo' && m.ambush && actor.hiddenAt && game.time - actor.hiddenAt < 60) f *= m.ambush;
  if (actor.type === 'town' && (actor.gun || 0) >= 3 && unitDef(target) && !unitDef(target).air && unitDef(target).move !== 'infantry') f *= 1.4;
  if (actor.path === 'av' && (actor.level || 1) >= 2 && armoured(target)) f *= 1.15;
  actor.hiddenAt = 0;   // firing gives the position away
  actor.stillAt = game.time;
  return f;
}

/** Fire-rate multiplier (cooldown x): extra salvo t2+. */
export const rofMul = (actor) => actor.mods?.rof || 1;
/** Extra projectiles per attack (the salvo line). */
export const salvoExtra = (actor) => actor.mods?.mech === 'salvo' ? actor.mods.extra || 0 : 0;
/** A projectile's blast radius with the blast line (mortar, artillery, drone). */
export function blastRadius(actor, weapon, radius) {
  if (actor.mods?.mech !== 'blast') return radius;
  const base = radius ?? (WEAPONS[weapon]?.blast ? WEAPONS[weapon].blast * .92 : 0);
  return base ? base * actor.mods.blast : radius;
}

/** After a unit or structure fired its main weapon: grenades, squad rockets, HE centre shells, the turrets' secondaries. */
export function afterFire(game, actor, def, target) {
  const m = actor.mods, tu = unitDef(target);
  if (tu?.air) {
    return;
  }
  const range = distance(actor, target);
  if (m?.mech === 'grenade' && (actor.grenadeReady || 0) <= game.time && (!tu || tu.move === 'infantry') && range < 2.2) {
    actor.grenadeReady = game.time + m.cooldown;
    lob(game, actor, target, 'mortar', m.damage, m.radius, 'gr', { kit: 'grenade' });
  }
  if (m?.mech === 'rocket' && actor.isUnit && !ACTION_UNITS[actor.type].air && (actor.rocketReady || 0) <= game.time && armoured(target) && range <= m.range + .3) {
    actor.rocketReady = game.time + m.cooldown;
    lob(game, actor, target, 'atgun', m.damage, 0, 'rk', { kit: 'rocket' });
  }
  if (!actor.isUnit) {
    if (actor.type === 'town' && (actor.gun || 0) >= 1 && (actor.grenadeReady || 0) <= game.time && tu?.move === 'infantry') {
      actor.grenadeReady = game.time + 4;
      lob(game, actor, target, 'mortar', 16 + 6 * (actor.gun - 1), .5, 'gr', { kit: 'grenade' });
    }
    if (actor.path === 'ai' && (actor.level || 1) >= 2 && (actor.grenadeReady || 0) <= game.time && tu?.move === 'infantry') {
      actor.grenadeReady = game.time + 5;
      lob(game, actor, target, 'mortar', 18, .55, 'gr', { kit: 'grenade' });
    }
    if (actor.path === 'av' && (actor.level || 1) >= 3) fireAtgm(game, actor, AV_MISSILE, target);
  }
}
// reach 4.4: past the anti-vehicle cannon (4.0, itself past the base turret 3.4 and the tank 3.49)
const AV_MISSILE = { atgm: { damage: 70, cooldown: 9, range: 4.4 } };

/** Suppression multiplier on a squad hit (body armour), and the blast line's extra suppression from its shooter. */
export function suppressMul(game, target, source) {
  let f = target.mods?.mech === 'armour' ? target.mods.supp : 1;
  const shooter = source?.id ? game.units.get(source.id) : null;
  if (shooter?.mods?.mech === 'blast') f *= shooter.mods.supp || 1;
  return f;
}

/**
 * Damage multiplier on an incoming hit (after the weapon's own multipliers): body armour against small arms, reactive
 * armour against the first anti-armour hit (not against sabot), flares against the first anti-aircraft hit. 0: no damage.
 */
export function incoming(game, target, source, weapon) {
  const m = target.mods;
  if (!m) return 1;
  if (m.mech === 'armour' && SMALL.has(weapon)) return m.small;
  if (m.mech === 'reactive' && AT.has(weapon) && (target.reactiveReady || 0) <= game.time) {
    const by = game.buildings.get(source?.id);
    if (by?.path === 'av' && (by.level || 1) >= 2) return 1;   // sabot defeats the tiles
    target.reactiveReady = game.time + m.cooldown;
    emit(game, { k: 'hit', a: source?.tile ?? target.tile, b: target.tile, s: source?.id || 0, t: target.id, w: VID[weapon], d: 0, bx: target.x, bz: target.z, ar: 1 });
    return 1 - m.cut;
  }
  if (m.mech === 'flares' && (AA.has(weapon) || WEAPONS[weapon]?.targets?.includes('air')) && (target.flareReady || 0) <= game.time) {
    target.flareReady = game.time + m.cooldown;
    emit(game, { k: 'flare', a: target.tile, b: target.tile, s: target.id, t: target.id, bx: target.x, bz: target.z });
    return 0;
  }
  return 1;
}

/** After a unit took damage: smoke launchers fire below 70 % health. */
export function afterHit(game, target) {
  const m = target.mods;
  if (m?.mech !== 'smoke' || target.hp <= 0 || target.hp > target.maxHp * .7 || (target.smokeReady || 0) > game.time) return;
  target.smokeReady = game.time + m.cooldown;
  const t = tileAt(target.x, target.z);
  if (t < 0) return;
  for (const n of m.wide ? disk(t, 1) : [t]) if (n >= 0) addSmoke(game, n, .85, m.seconds);
  emit(game, { k: 'smoke', a: t, b: t, s: target.id, t: target.id, bx: target.x, bz: target.z });
}

// ---- mechanics: sight and movement -------------------------------------------------------------------------------

/** True while a camouflaged unit is concealed: still and silent for its delay (only detection reveals it). */
export function concealed(game, u) {
  const m = u.mods;
  if (m?.mech !== 'camo' || u.goal || u.vx || u.vz) return false;
  const quiet = Math.max(u.lastCombat ?? -999, u.stillAt ?? -999);
  if (game.time - quiet < m.delay) return false;
  u.hiddenAt ||= game.time;
  return true;
}

/** Radius within which a source detects hidden units (0: none beyond the default). */
export function detectRadius(source) {
  if (source.isUnit) return source.mods?.mech === 'detect' ? source.mods.detect : 0;
  if (source.path === 'aa' && (source.level || 1) >= 3) return 5;
  if (source.path === 'ai' && (source.level || 1) >= 3) return 4;
  if (source.type === 'fort' && source.done && (source.level || 1) >= 3) return OUTPOST.detect;
  return 0;
}
/** Extra vision from an upgrade (the detection lines). */
export const visionBonus = (source) => source.isUnit && source.mods?.mech === 'detect' ? source.mods.vision || 0 : 0;

/** Ground speed multiplier: the engineers' utility car, the carrier's sprint. */
export function speedMul(game, u) {
  const m = u.mods;
  if (!m) return 1;
  if (m.speed) return m.speed;
  if (m.mech === 'sprint' && u.sprintUntil > game.time) return m.mult;
  return 1;
}

// ---- passive mechanics (upgradeStep, from productionStep every 3 ticks) -----------------------------------------

/** Sprint triggers, self-repair, the workshop aura, the support truck's automatic field repair, fighter rockets, camo stillness. */
export function upgradeStep(game, dt) {
  for (const u of game.units.values()) {
    if (u.hp <= 0) continue;
    const d = ACTION_UNITS[u.type], m = u.mods;
    // the support truck's Field Repair is automatic (2026-11-20: no repair buttons): a burst whenever something near is hurt
    if (d.passive && d.ability === 'repair' && (u.abilityReady || 0) <= game.time && (game.tickN + u.id) % 9 < 3) {
      const civ = game.civs[u.owner];
      if (civ && hurtNear(game, u, 2.35)) {
        game.repairAround(civ, u, 2.35, 39, true);
        u.abilityReady = game.time + 28; u.abilityUntil = game.time;
      }
    }
    if (!m) continue;
    if (m.mech === 'camo' && (u.goal || u.vx || u.vz)) { u.stillAt = game.time; u.hiddenAt = 0; }
    else if (m.mech === 'sprint' && u.goal && (u.sprintReady || 0) <= game.time) { u.sprintUntil = game.time + m.seconds; u.sprintReady = game.time + m.cooldown; }
    else if (m.mech === 'regen' && u.hp < u.maxHp && game.time - (u.lastCombat ?? -999) > 6) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * m.rate * dt);
    else if (m.mech === 'aura') { const civ = game.civs[u.owner]; if (civ) game.repairAround(civ, u, m.radius, m.rate * dt, true); }
    else if (m.mech === 'rocket' && d.air && (u.rocketReady || 0) <= game.time && (game.tickN + u.id) % 6 < 3) airRocket(game, u, m);
  }
}

function hurtNear(game, u, r) {
  for (const v of game.targets.query(u.x, u.z, r, [])) {
    if (v === u || v.owner !== u.owner || v.hp <= 0 || v.hp >= v.maxHp - 1 || distance(u, v) > r) continue;
    const d = unitDef(v);
    if (d ? !d.air && d.move !== 'infantry' : !!v.done) return true;
  }
  return false;
}

function airRocket(game, u, m) {
  const civ = game.civs[u.owner];
  let pick = null, best = Infinity;
  for (const v of game.targets.query(u.x, u.z, m.range, [])) {
    if (v.hp <= 0 || !game.hostile(u.owner, v.owner) || !armoured(v) || !game.sees(civ, v)) continue;
    const r = distance(u, v);
    if (r <= m.range && r < best) { best = r; pick = v; }
  }
  if (!pick) return;
  u.rocketReady = game.time + m.cooldown;
  lob(game, u, pick, 'rockets', m.damage, 0, 'rk', { kit: 'rocket' });
}
