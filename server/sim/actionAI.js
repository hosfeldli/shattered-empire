import { T } from './constants.js';
import { NB, disk } from './hex.js';
import { ACTION_BUILDINGS, ACTION_UNITS, ACTION_UPGRADES, MISSILE_PROJECT, TIERS } from './actionDefinitions.js';
import { advanceBase, armyCapacity, canPay, construct, constructDefense, establish, facilitiesAt, fortifyBase, headquarters, openSlots, repairFacility, startUpgrade, train,
  upgradeBuilding, upgradeDefenses } from './actionBases.js';
import { CITY_DEFENSES, NEW_BASE_GAP } from './actionDefinitions.js';
import { centerOf, distance } from './actionNavigation.js';
import { moveGroup } from './actionOrders.js';

const force = (u) => ACTION_UNITS[u.type].atk * Math.max(.25, u.hp / u.maxHp);
// the standing army an AI keeps before it saves for expansion or tiers: 8 at the start, ~28 by minute 20
const armyFloor = (game) => Math.min(40, 8 + Math.floor(game.time / 60));

function note(game, p, message) {
  p.notes.unshift({ time: Math.round(game.time), text: message });
  if (p.notes.length > 18) p.notes.pop();
}

function objective(game, p, state, target = 0) {
  if (p.state === state && p.target === target) return;
  p.state = state;
  p.target = target;
  p.since = game.time;
  p.phase = 'assemble';
  p.flankDone = false;
  p.pressure = null;
  p.troops = [];
  p.failures = 0;
  p.issued = 0;
  p.best = 1e6;
  p.progressAt = game.time;
  p.rallied = false;
  note(game, p, target ? `${state} at ${game.siteById.get(target)?.name || 'the objective'}` : state);
}

// W2: what the airfields train. Air is capped at ~18% of the army (min 2). Enemy air seen recently calls for
// fighters first; otherwise the mix aims at helicopters 2 : fighters 1 (: bombers 1 from era III), plus one recon
// drone once the army is 20 strong. Before this every airfield built only helicopters (Wave 1: 26 helicopters,
// no fighters or bombers in 30 sims).
export function airChoice(own, count, airSeen, highest) {
  const air = own.filter((u) => ACTION_UNITS[u.type].air && ACTION_UNITS[u.type].facility === 'airfield');
  if (air.length >= Math.max(2, Math.round(own.length * .18))) return null;
  if (airSeen >= 1 && count('fighter') < Math.min(6, airSeen * .6 + .5)) return 'fighter';
  if (!count('recon_drone') && own.length >= 20) return 'recon_drone';
  const mix = [['helicopter', 2], ['fighter', 1]];
  if (highest >= 3) mix.push(['bomber', 1]);
  const total = mix.reduce((n, [, w]) => n + w, 0), size = air.filter((u) => u.type !== 'recon_drone').length + 1;
  return mix.map(([type, w]) => ({ type, gap: w / total * size - count(type) })).sort((a, b) => b.gap - a.gap)[0].type;
}

function buildArmy(game, civ, bases, own, observed, p) {
  const byType = {};
  for (const u of own) byType[u.type] = (byType[u.type] || 0) + 1;
  const count = (type) => byType[type] || 0;
  const ground = observed.filter((u) => !ACTION_UNITS[u.type].air);
  const enemyArmor = ground.filter((u) => ['wheeled', 'tracked'].includes(ACTION_UNITS[u.type].move)).length;
  const enemyAir = observed.length - ground.length;
  const defensive = p.state === 'Defending';
  const highest = civ.age + 1;
  for (const s of bases) {
    const hq = headquarters(game, s);
    if (!hq?.done) continue;
    const facilities = facilitiesAt(game, s);
    if (defensive && game.time > 150 && civ.res.materials > 460 && civ.res.energy > 135 && !hq.project)
      fortifyBase(game, civ, s);
    if (hq.hp < hq.maxHp * .70 && !hq.project) repairFacility(game, civ, hq.id);
    const exists = (type) => facilities.some((b) => b.type === type);
    const main = s === bases[0];
    // a second Materials Processor before the Armory: materials, not energy, limit how many troops an AI can field
    // W2: enemy air seen in the last couple of minutes (p.enemyAir) brings the Heavy Weapons Works (AA vehicles) forward
    const build = main ? ['depot', 'barracks', 'power_plant', 'depot', 'armory', 'motor_works', ...(Math.max(enemyAir, p.enemyAir || 0) >= 1 ? ['heavy_weapons', 'airfield'] : ['airfield', 'heavy_weapons']), 'advanced_lab'] :
      s.kind === 'research' ? ['power_plant', 'armory', 'advanced_lab', 'depot', 'missile_silo', 'airfield'] :
      // W2: the second base puts up the airfield (or, against enemy air, the AA-producing Heavy Weapons Facility) fourth,
      // so the AI fields an air arm at all (Wave 1: airfields only appeared at the seventh slot of a tier-3 base)
      bases.indexOf(s) === 1 ? ['depot', 'power_plant', s.kind === 'military' ? 'barracks' : 'motor_works',
        ...(Math.max(enemyAir, p.enemyAir || 0) >= 1 ? ['heavy_weapons', 'airfield'] : ['airfield', 'heavy_weapons']), 'barracks', 'advanced_lab'] :
      ['depot', 'power_plant', s.kind === 'military' ? 'barracks' : 'motor_works', 'barracks', 'heavy_weapons', 'airfield', 'advanced_lab'];
    if (openSlots(game, s).length && !facilities.some((b) => !b.done)) {
      const have = {}, wanted = {};
      for (const b of facilities) have[b.type] = (have[b.type] || 0) + 1;
      const type = build.find((t) => (wanted[t] = (wanted[t] || 0) + 1) > (have[t] || 0) && ACTION_BUILDINGS[t].tier <= highest &&
        (!ACTION_BUILDINGS[t].needs || facilities.some((b) => b.type === ACTION_BUILDINGS[t].needs && b.done)));
      // outposts build out only once the army floor is met: facilities everywhere and no troops loses wars
      if (type && (main || own.length >= armyFloor(game) * .6 && civ.res.materials >= ACTION_BUILDINGS[type].cost.materials + 60)) construct(game, civ, s, type);
    }
    if (s.tier < 3 && !hq.project && game.time >= (s.tier === 1 ? 110 : 420) && (main || !openSlots(game, s).length && civ.res.materials > 780))
      advanceBase(game, civ, s);
  }
  const cap = armyCapacity(game, civ);
  if (cap.limit <= cap.used + cap.queued) return;
  // Saving for a new headquarters or the next tier never starves the army below its floor (which grows
  // with the match), so the AI keeps fielding troops instead of banking materials for minutes at a time.
  const belowFloor = own.length < armyFloor(game);
  const reserveForBase = !belowFloor && p.state === 'Expanding' && game.siteById.get(p.target)?.owner === civ.id && !game.siteById.get(p.target)?.hq;
  const reserveForTier = !belowFloor && highest === 1 && game.time > 135 && !headquarters(game, bases[0])?.project;
  const minimum = defensive || belowFloor ? 0 : reserveForBase ? ACTION_BUILDINGS.town.cost.materials : reserveForTier && own.length >= 7 ? TIERS[1].cost.materials : 38;
  // surplus energy buys the energy-hungry kit (artillery, armour, air defence) instead of piling up
  const energyRich = civ.res.energy > Math.max(400, civ.res.materials * 2.5);
  const armorCount = own.filter((u) => ACTION_UNITS[u.type].move === 'tracked' || ACTION_UNITS[u.type].air && ACTION_UNITS[u.type].atk > 0).length;
  const needsArmor = highest >= 2 && armorCount < Math.max(3, own.length * .22);
  const preferred = [];
  if (count('rifle_squad') + count('militia') < 4 || own.length < 6) preferred.push('rifle_squad');

  if (count('scout_buggy') === 0) preferred.push('scout_buggy');
  // W2: air defence answers the enemy air seen recently (p.enemyAir decays over ~2 min): one AA vehicle per two
  // enemy aircraft (up to 6) and fighters through airChoice; upgraded city perimeters add AA in developBases.
  const airSeen = Math.max(enemyAir, p.enemyAir || 0);
  if (airSeen >= 1 && count('air_defense') < Math.min(6, Math.ceil(airSeen * .5))) preferred.push('air_defense');
  if (enemyArmor > count('tank') + count('anti_armor')) preferred.push('anti_armor', 'tank');
  if (count('mortar_team') + count('sp_artillery') < own.length / 6) preferred.push('sp_artillery', 'mortar_team');
  if (count('rifle_squad') < own.length / 3) preferred.push('rifle_squad');
  if (civ.personality?.aggression > .65) preferred.push('armored_car', 'tank', 'exo_infantry');
  else if (civ.personality?.riskAversion > .55) preferred.push('tank', 'mortar_team');
  if (count('anti_armor') < Math.max(1, own.length * .15)) preferred.push('anti_armor');
  if (energyRich) preferred.unshift(...['sp_artillery', 'tank', 'air_defense', 'mortar_team', 'anti_armor'].filter((t) => ACTION_UNITS[t].tier <= highest));
  const airPick = airChoice(own, count, airSeen, highest);
  if (airPick) preferred.push(airPick);
  preferred.push('autonomous_tank', 'tank', 'mech_infantry', 'armored_car', 'rifle_squad');
  const facilities = bases.flatMap((s) => facilitiesAt(game, s)).filter((b) => b.done && b.queue.length < 2)
    .sort((a, b) => Number(a.type === 'barracks') - Number(b.type === 'barracks') || a.id - b.id);
  const operation = game.siteById.get(p.target), staging = operation && bases[0] ? game.lerpPoint(bases[0], operation,
    p.state === 'Attacking' || p.state === 'Final Assault' ? .38 : .10) : null;
  for (const b of facilities) {
    if (staging) b.rally = staging;
    const s = game.siteById.get(b.site);
    const type = preferred.find((key) => {
      const d = ACTION_UNITS[key];
      if (needsArmor && b.type === 'barracks' && own.length > 8 && civ.res.materials < 215 + d.cost.materials) return false;
      const energyReserve = reserveForBase ? 120 : reserveForTier && own.length >= 7 ? TIERS[1].cost.energy : 0;
      return d.facility === b.type && d.tier <= highest && civ.res.materials - d.cost.materials >= minimum && civ.res.energy - (d.cost.energy || 0) >= energyReserve && canPay(civ, d.cost);
    });
    if (type) train(game, civ, [b.id], type, 1);
  }
  // Upgrades: barracks kit first (cheap, immediate), then the armory's; affordable once the army floor is met,
  // without waiting to bank a fortune (energy usually piles up, materials are what is scarce).
  if (own.length >= Math.max(8, armyFloor(game) * .7) && game.time > (p.upgradeAt || 0)) {
    p.upgradeAt = game.time + 6;
    const order = Object.keys(ACTION_UPGRADES).filter((key) => !civ.techs.has(key) && ACTION_UPGRADES[key].tier <= highest)
      .sort((a, b) => Number(!!ACTION_UPGRADES[b].at) - Number(!!ACTION_UPGRADES[a].at));
    for (const key of order) {
      const c = ACTION_UPGRADES[key].cost;
      if (civ.res.materials < c.materials + 60 || civ.res.energy < (c.energy || 0)) continue;
      if (!startUpgrade(game, civ, key).error) break;
    }
  }
}

function frontier(game, civ, start, p) {
  const explored = civ.explored;
  const candidates = [];
  for (let t = 0; t < explored.length; t++) {
    if (!explored[t] || game.world.terr[t] <= T.SHALLOW || game.world.terr[t] >= T.MOUNTAIN) continue;
    for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && !explored[n]) { candidates.push(t); break; } }
  }
  candidates.sort((a, b) => {
    const da = distance(start, centerOf(a)), db = distance(start, centerOf(b));
    return da - db + ((b + civ.id + p.notes.length) % 11 - (a + civ.id + p.notes.length) % 11) * .13;
  });
  return candidates.slice(0, 9).map(centerOf);
}

function scout(game, civ, own, home, p) {
  if (game.time < (p.scoutAt || 0) || p.state === 'Defending') return;
  const candidate = own.find((u) => u.type === 'scout_buggy' || u.type === 'recon_drone') ||
    (own.length >= 4 ? own.find((u) => u.type === 'rifle_squad' && !p.troops.includes(u.id)) : null);
  if (!candidate) return;
  if (candidate.goal) {
    if (p.scoutId === candidate.id && p.scoutPoint && distance(candidate, p.scoutPoint) < .30 && game.time - (p.scoutProgress || 0) > 22) {
      game.command(civ.id, { c: 'hold', units: [candidate.id] });
      p.scoutSkip = candidate.tile;
    } else {
      if (!p.scoutPoint || distance(candidate, p.scoutPoint) > .45) { p.scoutPoint = { x: candidate.x, z: candidate.z }; p.scoutProgress = game.time; }
      return;
    }
  }
  p.scoutId = candidate.id;
  p.scoutAt = game.time + 9;
  if (!ACTION_UNITS[candidate.type].air) {
    const observed = [...game.units.values()].filter((u) => game.hostile(civ.id, u.owner) && game.sees(civ, u));
    const caches = [...game.materialCaches.values()].filter((c) => c.active && civ.visible[c.tile] && distance(c, candidate) < 12 &&
      !observed.some((u) => distance(u, c) < 3.5));
    caches.sort((a, b) => distance(candidate, a) - distance(candidate, b) - (a.amount - b.amount) * .012);
    if (caches[0] && !game.command(civ.id, { c: 'collect', cache: caches[0].id, units: [candidate.id] }).error) return;
  }
  for (const point of frontier(game, civ, candidate, p).concat(frontier(game, civ, home, p))) {
    if (distance(point, candidate) < 1.5 || distance(point, centerOf(p.scoutSkip ?? candidate.tile)) < 1) continue;
    const enemyBases = [...civ.siteIntel.values()].filter((s) => s.hq && game.hostile(civ.id, s.owner));
    if (enemyBases.some((s) => distance(point, s) < 6)) continue;
    if (!moveGroup(game, [candidate], point, { mode: 'move' }).error) break;
  }
}

function chooseExpansion(game, civ, known, home, enemy) {
  const open = known.filter((s) => !s.hq && (s.owner < 0 || game.hostile(civ.id, s.owner)));
  // The reach follows the map's spacing: on spread-out and hand-authored maps the nearest free ruins
  // can lie beyond the compact maps' 27-unit radius, and an AI must still expand to them.
  const reach = Math.max(27, Math.min(...open.map((s) => distance(home, s))) + 14);
  return open.filter((s) => distance(home, s) < reach)
    .map((s) => ({
      s, score: distance(home, s) + (s.base ? 0 : 2.8) + enemy.filter((u) => distance(u, s) < 4).length * 2,
    })).sort((a, b) => a.score - b.score || a.s.id - b.s.id)[0]?.s;
}

const artillery = (u) => ACTION_UNITS[u.type].cat === 'artillery';
const sumForce = (list) => list.reduce((n, u) => n + force(u), 0);

// Badly wounded ground units that are still under fire fall back to the main base, where engineers and
// support trucks repair them; they rejoin operations once patched up (troopsFor skips them until then).
function evacuateWounded(game, civ, own, home, p) {
  p.wounded = (p.wounded || []).filter((id) => { const u = game.units.get(id); return u && u.hp < u.maxHp * .8; });
  if (!home || game.time < (p.evacAt || 0)) return;
  p.evacAt = game.time + 4;
  // the base's automatic engineers (not in `own`) or a support truck patch them up at home
  if (![...game.units.values()].some((u) => u.owner === civ.id && ACTION_UNITS[u.type].ability === 'repair' && distance(u, home) < 6)) return;
  const out = own.filter((u) => !ACTION_UNITS[u.type].air && ACTION_UNITS[u.type].ability !== 'repair' && !p.wounded.includes(u.id) &&
    u.hp < u.maxHp * .3 && game.time - (u.lastCombat ?? -99) < 6 && distance(u, home) > 5).slice(0, 6);
  if (!out.length) return;
  const ids = out.map((u) => u.id);
  if (game.command(civ.id, { c: 'withdraw', units: ids }).error) return;
  p.wounded.push(...ids);
  p.troops = p.troops.filter((id) => !ids.includes(id));
}

// Artillery supports from standoff range instead of walking into the objective with the assault group.
function positionArtillery(game, p, guns, target, home) {
  if (!guns.length || game.time < (p.artilleryAt || 0)) return;
  p.artilleryAt = game.time + 10;
  const idle = guns.filter((u) => !u.goal && !u.attack && distance(u, target) > ACTION_UNITS[u.type].range * .95);
  if (!idle.length) return;
  const length = Math.max(.1, distance(home, target)), reach = Math.min(...idle.map((u) => ACTION_UNITS[u.type].range)) * .8;
  moveGroup(game, idle, game.lerpPoint(target, home, Math.min(.6, reach / length)), { mode: 'assault' });
}

function troopsFor(p, own, n, requireCapture) {
  const wounded = new Set(p.wounded || []);
  const available = own.filter((u) => !u.grounded && u.airOrder?.kind !== 'return' && !wounded.has(u.id));
  const active = new Map(available.map((u) => [u.id, u]));
  let group = p.troops.map((id) => active.get(id)).filter(Boolean);
  if (group.length < n) {
    const assigned = new Set(group.map((u) => u.id));
    const sorted = available.filter((u) => u.id !== p.scoutId && !assigned.has(u.id)).sort((a, b) =>
      Number(ACTION_UNITS[b.type].capture && requireCapture) - Number(ACTION_UNITS[a.type].capture && requireCapture) ||
      force(b) - force(a) || a.id - b.id);
    group.push(...sorted.slice(0, n - group.length));
    p.troops = group.map((u) => u.id);
  }
  return group;
}

function approach(game, p, group, point, mode) {
  if (!group.length) return false;
  if (group.filter((u) => distance(u, point) < 2.8).length >= Math.max(1, Math.ceil(group.length * .7))) return true;
  const nearest = Math.min(...group.map((u) => distance(u, point)));
  if (p.best > nearest + .65) { p.best = nearest; p.progressAt = game.time; }
  const moving = group.some((u) => u.goal);
  if (p.issued && (moving && game.time - p.progressAt < 19 || game.time - p.issued < 8)) return true;
  const result = moveGroup(game, group, point, { mode, exact: mode === 'assault' });
  p.issued = game.time;
  if (result.error || p.progressAt + 24 < game.time) {
    p.failures++;
    p.progressAt = game.time;
    note(game, p, result.error || 'Regrouping after a stalled approach.');
  }
  return !result.error;
}

function tacticalSupport(game, civ, own, observed) {
  let decisions = 0;
  for (const u of own) {
    if (decisions >= 8) break;
    const d = ACTION_UNITS[u.type];
    if (d.air && u.hp < u.maxHp * .32 && u.airOrder?.kind !== 'return' && !u.grounded) {
      game.returnAircraft(u); decisions++; continue;
    }
    if (u.abilityReady > game.time) continue;
    let use = false, point;
    if (d.ability === 'repair') use = own.some((v) => v.hp < v.maxHp * .70 && distance(u, v) < 3.2) || game.roads.edgesOf(u.tile).some((e) => e.cond < 70);
    else if (d.ability === 'cover') use = !u.goal && game.time - u.lastCombat < 3;
    else if (d.ability === 'scan') use = !!u.goal && observed.some((v) => distance(u, v) < d.vision + 2);
    else if (d.ability === 'focused_fire' || d.ability === 'intercept') use = !!u.target && observed.some((v) => v.id === u.target);
    else if (d.ability === 'bombard' && !u.goal) {
      point = observed.filter((v) => !ACTION_UNITS[v.type].air && distance(u, v) < d.range)
        .sort((a, b) => observed.filter((v) => distance(v, b) < 1).length - observed.filter((v) => distance(v, a) < 1).length)[0];
      use = !!point;
    } else if (d.ability === 'strike' && !u.airOrder) {
      point = observed.find((v) => ['tracked', 'wheeled'].includes(ACTION_UNITS[v.type].move) && distance(u, v) < 12);
      use = !!point;
    }
    if (use) { game.command(civ.id, { c: 'ability', ability: d.ability, units: [u.id], point: point && { x: point.x, z: point.z } }); decisions++; }
  }
  const missile = [...game.buildings.values()].find((b) => b.owner === civ.id && b.done && b.type === 'missile_silo');
  if (!missile) return;
  if (!missile.project && !missile.missiles && civ.res.materials > 1200 && civ.res.energy > 650)
    game.command(civ.id, { c: 'missileBuild', id: missile.id });
  if (missile.missiles) {
    const target = [...civ.siteIntel.values()].filter((s) => s.hq && game.hostile(civ.id, s.owner) && distance(missile, s) < MISSILE_PROJECT.range)
      .sort((a, b) => b.tier - a.tier || distance(missile, a) - distance(missile, b))[0];
    if (target && !own.some((u) => distance(u, target) < 4)) game.command(civ.id, { c: 'missileLaunch', id: missile.id, point: target });
  }
}

// Era upgrades on economy buildings and perimeters, and a New Base (1000) once the AI banks a surplus
// and has no ruin left to expand to. Placement follows the player rules (own territory, beside a road).
function developBases(game, civ, bases, own, p) {
  if (game.time < (p.developAt || 0)) return;
  p.developAt = game.time + 10;
  if (own.length < armyFloor(game) * .7) return;
  const mine = [...game.buildings.values()].filter((b) => b.owner === civ.id && b.done);
  if (civ.age >= 1) {
    const economy = mine.filter((b) => (b.type === 'depot' || b.type === 'power_plant') && !b.project && (b.level || 1) < civ.age + 1)
      .sort((a, b) => (a.level || 1) - (b.level || 1) || Number(b.type === 'depot') - Number(a.type === 'depot') || a.id - b.id)[0];
    const cost = economy && ACTION_BUILDINGS[economy.type].levels.cost[(economy.level || 1) - 1];
    if (economy && civ.res.materials > cost.materials + 280 && civ.res.energy > (cost.energy || 0) + 60) upgradeBuilding(game, civ, economy.id);
    const walled = bases.find((s) => (s.defenseLevel || 1) < 2 && !headquarters(game, s)?.project && mine.some((b) => b.site === s.id && b.perimeterSlot));
    const wall = CITY_DEFENSES.upgrade.cost[0];
    // W2: enemy air makes city AA (perimeter level 2) urgent rather than a luxury
    const reserve = (p.enemyAir || 0) >= 2 ? 120 : 500;
    if (walled && civ.res.materials > wall.materials + reserve && civ.res.energy > wall.energy + 60) upgradeDefenses(game, civ, walled);
  }
  if (game.time < 420 || bases.length >= 5 || civ.res.materials < 1350 || p.state === 'Expanding' || game.time < (p.newBaseAt || 0)) return;
  if (mine.some((b) => b.type === 'base_site') || [...game.buildings.values()].some((b) => b.owner === civ.id && b.type === 'base_site')) return;
  p.newBaseAt = game.time + 30;
  const home = bases[0];
  if (!home) return;
  const w = game.world, candidates = [];
  for (let t = 0; t < w.owner.length; t++) {
    if (w.owner[t] !== civ.id || !civ.visible[t]) continue;
    const c = centerOf(t);
    if (game.sites.some((s) => distance(s, c) < (s.slots ? NEW_BASE_GAP + .3 : 3.6))) continue;
    if (!w.road[t] && ![0, 1, 2, 3, 4, 5].some((d) => NB[t * 6 + d] >= 0 && w.road[NB[t * 6 + d]])) continue;
    candidates.push({ t, c, score: distance(home, c) });
  }
  candidates.sort((a, b) => a.score - b.score || a.t - b.t);
  for (const { c } of candidates.slice(0, 24)) {
    if (constructDefense(game, civ, 'base_site', c, true).error) continue;
    if (!constructDefense(game, civ, 'base_site', c).error) { note(game, p, 'Founding a new base.'); break; }
  }
}

export function planActionAI(game, civ) {
  const p = civ.aiPlan;
  p.next = game.time + (civ.difficulty === 'easy' ? 4.2 : ['expert', 'brutal'].includes(civ.difficulty) ? 2 : 3);
  // base engineers (u.auto) work on their own and are never drafted into operations
  const owned = [...game.units.values()].filter((u) => u.owner === civ.id && !u.auto);
  const bases = game.sites.filter((s) => s.owner === civ.id && s.slots).sort((a, b) => b.tier - a.tier || a.id - b.id);
  const home = bases[0] || game.sites[civ.id];
  const known = [...civ.siteIntel.values()];
  const enemy = [...game.units.values()].filter((u) => game.hostile(civ.id, u.owner) && game.sees(civ, u));
  // W2: short strategic memory. Enemy air seen recently (decays to half in ~2.3 min) drives AA and fighter
  // production; the strongest enemy force seen recently (half-life ~3.5 min) is what field superiority is judged against.
  p.enemyAir = Math.max(enemy.filter((u) => ACTION_UNITS[u.type].air).length, (p.enemyAir || 0) * .985);
  p.enemyPeak = Math.max(sumForce(enemy), (p.enemyPeak || 0) * .99);
  p.checked ??= {};
  for (const s of game.sites) if (s.slots && civ.visible[s.tile]) p.checked[s.id] = game.time;
  for (const s of bases) if (!s.hq) establish(game, civ, s);
  buildArmy(game, civ, bases, owned, enemy, p);
  developBases(game, civ, bases, owned, p);
  tacticalSupport(game, civ, owned, enemy);
  if (civ.difficulty !== 'easy') evacuateWounded(game, civ, owned, home, p);

  // Retreats commit for a bounded period. The operation cannot flip back into attack
  // on the next planning tick, and threat estimates use observed forces only.
  if (p.recoverUntil > game.time) {
    const engineers = owned.filter((u) => u.type === 'engineer' || u.type === 'supply_truck');
    for (const u of engineers) if ((u.abilityReady || 0) <= game.time && distance(u, home) < 5)
      game.command(civ.id, { c: 'ability', units: [u.id], ability: 'repair' });
    scout(game, civ, owned, home, p);
    return;
  }
  const committed = owned.filter((u) => p.troops.includes(u.id));
  const opposed = enemy.filter((e) => committed.some((u) => distance(e, u) < 5.5));
  const outmatched = committed.length >= 3 && opposed.length >= 3 &&
    opposed.reduce((n, u) => n + force(u), 0) > committed.reduce((n, u) => n + force(u), 0) * 1.85;
  if (outmatched && !enemy.some((u) => distance(u, home) < 4)) {
    game.command(civ.id, { c: 'withdraw', units: committed.map((u) => u.id) });
    objective(game, p, 'Recovering'); p.recoverUntil = game.time + 23;
    note(game, p, 'Withdrawing to repair and gather a mixed reinforcement force.');
    return;
  }

  const defended = bases.find((s) => enemy.some((u) => distance(u, s) < (civ.difficulty === 'easy' ? 4.8 : 6.3)));
  const enemiesNearHome = defended ? enemy.filter((u) => distance(u, defended) < 7) : [];
  // A raid on a base that a large army can absorb is met by a proportional garrison while the main
  // operation continues; a real threat recalls everything.
  const operating = p.state === 'Attacking' || p.state === 'Final Assault' || p.state === 'Expanding';
  const raidForce = sumForce(enemiesNearHome);
  if (defended && operating && owned.length >= 20 && raidForce < sumForce(owned) * .3) {
    const vanguard = enemiesNearHome.find((u) => !ACTION_UNITS[u.type].air) || enemiesNearHome[0];
    if (game.time > (p.guardAt || 0)) {
      p.guardAt = game.time + 9;
      const wounded = new Set(p.wounded || []), operation = new Set(p.troops);
      const pool = owned.filter((u) => !wounded.has(u.id) && !u.grounded && ACTION_UNITS[u.type].atk > 0)
        .sort((a, b) => Number(operation.has(a.id)) - Number(operation.has(b.id)) || distance(a, defended) - distance(b, defended) || a.id - b.id);
      const guard = [];
      for (const u of pool) { if (sumForce(guard) >= raidForce * 1.7 && guard.length >= 3 || guard.length >= 30) break; guard.push(u); }
      const ids = new Set(guard.map((u) => u.id));
      p.troops = p.troops.filter((id) => !ids.has(id));
      if (guard.length) moveGroup(game, guard, game.lerpPoint(defended, vanguard, .72), { mode: 'assault' });
    }
  } else if (defended) {
    objective(game, p, 'Defending', defended.id);
    const group = troopsFor(p, owned, Math.min(80, owned.length), false);
    const vanguard = enemiesNearHome.find((u) => !ACTION_UNITS[u.type].air) || enemiesNearHome[0];
    approach(game, p, group, game.lerpPoint(defended, vanguard, .72), 'assault');
    if (game.time > (p.defenseAt || 0)) {
      p.defenseAt = game.time + 35;
      if (![...game.buildings.values()].some((b) => b.owner === civ.id && ACTION_BUILDINGS[b.type].field && distance(b, defended) < 4)) {
        const length = Math.max(.1, distance(defended, vanguard));
        const forward = game.lerpPoint(defended, vanguard, Math.min(.85, 3.2 / length));
        constructDefense(game, civ, civ.age > 0 && enemiesNearHome.some((u) => ACTION_UNITS[u.type].move === 'tracked') ? 'turret' : 'guard_post', forward);
      }
    }
    return;
  }
  if (p.state === 'Defending') objective(game, p, 'Recovering');
  const attackCount = civ.difficulty === 'easy' ? 17 : 13;
  const opening = civ.difficulty === 'easy' ? 360 : ['expert', 'brutal'].includes(civ.difficulty) ? 240 : 300;
  // W2: closing out. From minute 12 with clear field superiority (a 24-strong army, 1.8x the strongest enemy force
  // seen recently), or past minute 16 with a 30-strong army, the AI stops expanding and commits to a Final Assault
  // on the weakest enemy headquarters, keeps feeding it reinforcements and stays on that target until it falls
  // (or the assault is beaten back).
  const closing = game.time > 720 && (owned.length >= 24 && sumForce(owned) > Math.max(p.enemyPeak, 1) * 1.8 || game.time > 960 && owned.length >= 30);
  const final = p.state === 'Final Assault';
  if (p.target && (p.failures >= (final ? 5 : 3) || game.time - p.progressAt > (final ? 150 : 85))) {
    p.avoid = p.target;
    p.avoidUntil = game.time + 50;
    note(game, p, 'Operation ended after bounded recovery.');
    objective(game, p, 'Recovering');
  }
  const expansion = chooseExpansion(game, civ, known.filter((s) => s.id !== p.avoid || game.time > p.avoidUntil), home, enemy);
  const rival = (id) => id >= 0 && game.hostile(civ.id, id) && game.civs[id]?.alive;
  const enemyBases = known.filter((s) => s.hq && rival(s.owner) && (s.id !== p.avoid || game.time > p.avoidUntil));
  // W2: a rival's capital that was never scouted is presumed to be held by that rival (start positions are known)
  for (const c of game.civs) {
    const capital = game.sites[c.id];
    if (rival(c.id) && capital && !civ.siteIntel.has(capital.id) && (capital.id !== p.avoid || game.time > p.avoidUntil))
      enemyBases.push({ id: capital.id, x: capital.x, z: capital.z, radius: capital.radius, owner: c.id, hq: -1, tier: 1, presumed: true });
  }
  // nearest first; when closing, the weakest first: lightly garrisoned, and belonging to the rival with the fewest
  // bases left (finishing a player ends the match). The current target is sticky, so the AI stops dithering.
  const garrisonAt = (s) => sumForce(enemy.filter((u) => distance(u, s) < 8));
  const rank = (s) => distance(s, home) + (closing ? garrisonAt(s) / 25 + (enemyBases.filter((o) => o.owner === s.owner).length - 1) * 5 : 0) -
    (s.id === p.target ? 12 : 0);
  enemyBases.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  let target = known.find((s) => s.id === p.target) || enemyBases.find((s) => s.presumed && s.id === p.target);
  if (target?.owner === civ.id) { objective(game, p, 'Consolidating'); target = null; }
  // superiority interrupts expansion and lesser operations for the final assault (or the hunt, below)
  if (target && closing && !['Attacking', 'Final Assault', 'Defending'].includes(p.state)) target = null;
  if (target && closing && p.state === 'Attacking' && enemyBases[0].id === target.id) objective(game, p, 'Final Assault', target.id);
  // Do not march into a defence that is visibly stronger than the army that would attack it.
  const garrison = enemyBases[0] ? sumForce(enemy.filter((u) => distance(u, enemyBases[0]) < 8)) : 0;
  const canAssault = owned.length >= attackCount && game.time > opening && sumForce(owned) * .85 > garrison * 1.2;
  if (!target) {
    if (expansion && !closing && (bases.length < 3 || !canAssault || !enemyBases.length)) objective(game, p, bases.length ? 'Expanding' : 'Recovering', expansion.id);
    else if ((canAssault || closing) && enemyBases.length) objective(game, p, closing || enemyBases.length === 1 && owned.length >= 19 ? 'Final Assault' : 'Attacking', enemyBases[0].id);
    else if (game.time > 40) objective(game, p, 'Preparing');
    target = known.find((s) => s.id === p.target) || enemyBases.find((s) => s.presumed && s.id === p.target);
  }
  if (!target && !enemyBases.length && (closing || owned.length >= attackCount * 1.6) && game.time > opening) {
    // W2: a large army with no known enemy base hunts for one: it sweeps the base sites it has not seen for 2.5
    // minutes (where a rival may have rebuilt), nearest to the army first. Before this it probed unexplored ground
    // near the map's centre, and expanded instead whenever a ruin was free, so beaten rivals survived for good.
    if (game.time > (p.probeAt || 0)) {
      p.probeAt = game.time + 20;
      const group = owned.filter((u) => !ACTION_UNITS[u.type].air && !u.attack && !(p.wounded || []).includes(u.id))
        .slice(0, Math.max(6, Math.floor(owned.length * .75)));
      const centre = group.length ? { x: group.reduce((n, u) => n + u.x, 0) / group.length, z: group.reduce((n, u) => n + u.z, 0) / group.length } : home;
      const site = game.sites.filter((s) => s.slots && !(s.owner >= 0 && game.allied(civ.id, s.owner)) && game.time - (p.checked[s.id] ?? -1e9) > 150)
        .sort((a, b) => distance(a, centre) - distance(b, centre) || a.id - b.id)[0];
      const ahead = site || frontier(game, civ, home, p)[0];
      if (ahead && group.length && !moveGroup(game, group, ahead, { mode: 'assault' }).error) note(game, p, 'Hunting for the enemy.');
      else if (site) p.checked[site.id] = game.time;
    }
    scout(game, civ, owned, home, p);
    return;
  }
  if (!target) { scout(game, civ, owned, home, p); return; }
  const attacking = p.state === 'Attacking' || p.state === 'Final Assault';
  const group = troopsFor(p, owned, Math.min(attacking ? 160 : Math.min(16, Math.max(9, Math.round(owned.length * .25))),Math.max(1, owned.length - (attacking ? Math.max(2, Math.floor(owned.length * .14)) : 1))), true);
  if (!group.length) return;
  if (attacking && target.hq) {
    if (group.length < 3) return;
    const visible = game.buildings.get(target.hq);
    // W2: the column closes up at a forward rally point ~7 short of the objective before the assault, so the army
    // arrives together instead of trickling into the defences a few units at a time (the Wave 1 sieges stalled
    // with 5-13 of 50+ troops at the objective while the rest were strung out along the route).
    const nearest = Math.min(...group.map((u) => distance(u, target)));
    if (!p.rallied && group.length >= 6 && nearest < 12 && p.phase !== 'engage') {
      const rally = game.lerpPoint(target, home, Math.min(.45, 7 / Math.max(.1, distance(home, target))));
      if (p.phase !== 'rally') { p.phase = 'rally'; p.rallySince = game.time; p.issued = 0; p.best = 1e6; }
      const gathered = group.filter((u) => distance(u, rally) < 4.5 || distance(u, target) < 9).length;
      if (gathered < Math.ceil(group.length * .6) && game.time - p.rallySince < 50) {
        const behind = group.filter((u) => distance(u, rally) >= 4.5 && distance(u, target) >= 9);
        if (game.time - (p.rallyOrder || -99) > 10) { moveGroup(game, behind, rally, { mode: 'assault' }); p.rallyOrder = game.time; }
        return;
      }
      p.rallied = true; p.phase = 'approach'; p.issued = 0; p.best = 1e6; p.progressAt = game.time;
    }
    if (visible && game.sees(civ, visible)) {
      if (p.phase !== 'engage') { p.phase = 'engage'; p.progressAt = game.time; }
      const local = group.filter((u) => distance(u, target) < 10);
      const pressure = [...game.buildings.values()].filter((b) => game.hostile(civ.id, b.owner) && distance(b, target) < 5 && game.sees(civ, b))
        .reduce((sum, b) => sum + b.hp, 0);
      if (p.pressure != null && pressure < p.pressure - 2) p.progressAt = game.time;
      p.pressure = pressure;
      // Fight the defenders first: troops locked onto the headquarters would ignore the units and
      // emplacements shooting them. Assault-moving into the threat lets every weapon pick its own target.
      const threats = enemy.filter((e) => !ACTION_UNITS[e.type].air && distance(e, target) < 7 && local.some((u) => distance(u, e) < 4.5));
      const emplacements = [...game.buildings.values()].filter((b) => game.hostile(civ.id, b.owner) && b.done !== false && b.hp > 0 &&
        ACTION_BUILDINGS[b.type]?.field && ACTION_BUILDINGS[b.type].attack && distance(b, target) < 6 && game.sees(civ, b));
      if (threats.length && local.length >= 3) {
        if (game.time - (p.threatAt || -30) > 7) {
          const front = threats.sort((a, b) => Math.min(...local.map((u) => distance(u, a))) - Math.min(...local.map((u) => distance(u, b))) || a.id - b.id)[0];
          const assault = local.filter((u) => !artillery(u));
          if (assault.length) moveGroup(game, assault, front, { mode: 'assault' });
          for (const u of local) if (artillery(u) && ACTION_UNITS[u.type].ability === 'bombard' && (u.abilityReady || 0) <= game.time)
            game.command(civ.id, { c: 'ability', ability: 'bombard', units: [u.id], point: { x: front.x, z: front.z } });
          p.threatAt = game.time; p.progressAt = game.time;
        }
      } else if (emplacements.length && local.length >= 3 && (game.time - (p.attackAt || -30)) > 13) {
        const nearest = emplacements.sort((a, b) => Math.min(...local.map((u) => distance(u, a))) - Math.min(...local.map((u) => distance(u, b))) || a.id - b.id)[0];
        game.command(civ.id, { c: 'attack', target: nearest.id, units: local.map((u) => u.id) });
        p.attackAt = game.time;
        if (nearest.hp < (p.lastEmplacementHp ?? Infinity)) p.progressAt = game.time;
        p.lastEmplacementHp = nearest.hp;
      } else if (local.length >= 3 && (game.time - (p.attackAt || -30)) > 13) {
        game.command(civ.id, { c: 'attack', target: visible.id, units: local.map((u) => u.id) });
        for (const u of local) if (ACTION_UNITS[u.type].ability === 'bombard')
          game.command(civ.id, { c: 'ability', ability: 'bombard', units: [u.id], point: target });
        p.attackAt = game.time;
        if (visible.hp < (p.lastHp ?? Infinity)) p.progressAt = game.time;
        p.lastHp = visible.hp;
      }
      if (local.length >= Math.min(5, group.length)) {
        const reinforcements = group.filter((u) => !u.goal && !u.attack && distance(u, target) >= 10);
        if (reinforcements.length && game.time > (p.reinforceAt || 0)) {
          // W2: reinforcements join the siege 3.5 short of the objective (was 83% of the way from home, which on
          // short routes left them idling outside the fight)
          moveGroup(game, reinforcements, game.lerpPoint(target, home, Math.min(.5, 3.5 / Math.max(.1, distance(home, target)))), { mode: 'assault' });
          p.reinforceAt = game.time + 14;
        }
        return;
      }
    }
    if (p.phase === 'assemble') {
      const staging = game.lerpPoint(home, target, .39);
      if (group.filter((u) => distance(u, staging) < 3.2).length < Math.ceil(group.length * .6) && game.time - p.since < 42) {
        approach(game, p, group, staging, 'assault');
        return;
      }
      p.phase = 'approach';
      p.issued = 0; p.best = 1e6;
    }
    if (p.phase === 'approach' && civ.difficulty !== 'easy' && group.length >= 12 && !p.flankDone) {
      const mid = game.lerpPoint(home, target, .68), delta = { x: game.dx(home.x, target.x), z: target.z - home.z };
      const len = Math.hypot(delta.x, delta.z) || 1, side = civ.id % 2 ? -1 : 1;
      const flank = game.nav.nearest({ x: mid.x + delta.z / len * 3.8 * side, z: mid.z - delta.x / len * 3.8 * side }, ACTION_UNITS.rifle_squad);
      if (flank && game.time - p.since < 85 && !group.some((u) => distance(u, flank) < 2)) {
        approach(game, p, group, flank, 'assault'); return;
      }
      p.flankDone = true; p.issued = 0; p.best = 1e6;
    }
    const guns = group.filter(artillery), line = group.filter((u) => !artillery(u));
    if (line.length >= 3) positionArtillery(game, p, guns, target, home);
    approach(game, p, line.length >= 3 ? line : group, target, 'assault');
  } else {
    const capture = group.filter((u) => ACTION_UNITS[u.type].capture);
    const occupied = capture.some((u) => distance(u, target) <= target.radius * .9);
    if (!occupied) approach(game, p, capture.length ? capture.slice(0, 5) : group, target, 'assault');
    const escort = group.filter((u) => !capture.includes(u) && distance(u, target) > 4 && !u.goal);
    if (escort.length && game.time - (p.escortAt || -20) > 12) {
      moveGroup(game, escort, game.lerpPoint(target, home, .12), { mode: 'assault' });
      p.escortAt = game.time;
    }
  }
  scout(game, civ, owned, home, p);
}
