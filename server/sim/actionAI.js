import { T } from './constants.js';
import { NB, disk } from './hex.js';
import { ACTION_BUILDINGS, ACTION_UNITS, MISSILE_PROJECT, TIERS, trainsAt } from './actionDefinitions.js';
import { aiOutpost, aiUpgrades } from './actionAIUpgrades.js';   // 2026-11-20 per-building upgrades and outposts (BASE_MENU_REWORK.md §8)
import { advanceBase, armyCapacity, canPay, construct, demolish, establish, facilitiesAt, fieldCost, fortifyBase, headquarters, openSlots, train,
  upgradeBuilding, settlementCost } from './actionBases.js';
import { productionCommitment, queuedCount } from './actionProduction.js';
import { centerOf, distance, tileAt } from './actionNavigation.js';
import { GROUP_ROUTE } from './actionOrders.js';
import { aiOrders, bridgeToward, canReach, cutOff, enemyGrid, moveGroup, knownDefences, leavePicket, managePickets, nearAny, needsOrder, picketIds, runOperation, secureSite,
  strategicProgram } from './actionAIOps.js';
import { aiEmergencyWorks, aiWorks } from './actionAIWorks.js';

const force = (u) => ACTION_UNITS[u.type].atk * Math.max(.25, u.hp / u.maxHp);
// brutal's surplus fill (balance pass 2026-11-18): materials kept above the reserve before an idle facility trains
// past its role shares
const FILL_MARGIN = 150;
// the standing army an AI keeps before it saves for expansion or tiers: 8 at the start, ~28 by minute 20
const armyFloor = (game) => Math.min(40, 8 + Math.floor(game.time / 60));
// Stalemate pass (2026-11-19, TELEMETRY_ANALYSIS B6: late 4v4 AIs banked 10-17k materials with 150-500 energy): energy is
// the binding constraint once materials pile up and energy income is under a quarter of the materials income. Then
// the build lists put Energy Generators where a second Materials Processor would go (and in any free ring site), the
// economy upgrades go to generators first, and a surplus processor may be pulled down for a generator (developBases).
export const energyBound = (game, civ) => civ.age >= 1 && game.time > 600 && civ.res.materials > 2000 && civ.res.energy < 500 &&
  (civ.rates?.energy || 0) * 4 < (civ.rates?.materials || 0);
function energyList(build) {
  let depots = 0;
  return build.map((t) => t === 'depot' && depots++ ? 'power_plant' : t).concat(['power_plant', 'power_plant']);
}

function note(game, p, message) {
  game.tm?.aiNote(p, message);   // telemetry (read-only, docs/TELEMETRY.md)
  p.notes.unshift({ time: Math.round(game.time), text: message });
  if (p.notes.length > 18) p.notes.pop();
}

function objective(game, p, state, target = 0) {
  if (p.state === state && p.target === target) return;
  game.tm?.aiObjective(p, state, target);   // telemetry (read-only): state change and operation end
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
  if (p.op) p.lastOp = { ...p.op, endedAt: game.time };   // AI_OPERATIONS.md: task forces belong to one objective (resumable)
  p.op = null;
  p.capture = null;
  note(game, p, target ? `${state} at ${game.siteById.get(target)?.name || 'the objective'}` : state);
}

const live = (game, site) => game.siteById.get(site.id);
// failed assaults per objective: rank other weak points first, and feed the stalemate test (actionAIOps)
function failed(game, p, target) {
  p.failedAt ??= {};
  p.failedAt[target] = (p.failedAt[target] || 0) + 1;
}

// W2: what the airfields train. Air is capped at ~18% of the army (min 2). The mix aims at helicopters 2 :
// Warthogs ('fighter') 1 (: bombers 1 from era III), plus one recon drone once the army is 20 strong. Before this
// every airfield built only helicopters (Wave 1: 26 helicopters, no fighters or bombers in 30 sims).
// 2026-11-19: the fighter became the Warthog ground-attack jet, which cannot engage aircraft: enemy air is now
// answered by air defense vehicles alone (buildArmy), never by more jets. `airSeen` is kept for callers.
export function airChoice(own, count, airSeen, highest) {
  const air = own.filter((u) => ACTION_UNITS[u.type].air && ACTION_UNITS[u.type].facility === 'airfield');
  if (air.length >= Math.max(2, Math.round(own.length * .18))) return null;
  if (!count('recon_drone') && own.length >= 20) return 'recon_drone';
  const mix = [['helicopter', 2], ['fighter', 1]];
  if (highest >= 3) mix.push(['bomber', 1]);
  const total = mix.reduce((n, [, w]) => n + w, 0), size = air.filter((u) => u.type !== 'recon_drone').length + 1;
  return mix.map(([type, w]) => ({ type, gap: w / total * size - count(type) })).sort((a, b) => b.gap - a.gap)[0].type;
}

// Target ground-army composition by era (shares of the ground army). Indirect fire (mortars, SP artillery,
// missile batteries) is kept to about a tenth: some, never a mortar carpet. Each role lists its unit types with
// weights; the role and type furthest below target is trained next.
const ROLES = [
  { role: 'line', share: [.56, .32, .26], types: [['rifle_squad', 1], ['special_forces', .12, 2]] },
  { role: 'antitank', share: [.22, .14, .12], types: [['anti_armor', 1]] },
  { role: 'indirect', share: [.1, .1, .1], types: [['mortar_team', 1], ['sp_artillery', 1, 2], ['missile_battery', .5, 3]] },
  { role: 'armour', share: [.12, .44, .52], types: [['armored_car', .5], ['tank', 1.6, 2], ['mech_infantry', .7, 2], ['exo_infantry', .8, 2], ['field_gun', .35, 2], ['autonomous_tank', 1, 3]] },
];
const ROLE_OF = Object.fromEntries(ROLES.flatMap((r) => r.types.map(([t]) => [t, r.role])));
export function compositionPick(own, count, highest, personality) {
  const era = Math.max(0, Math.min(2, highest - 1));
  const ground = own.filter((u) => ROLE_OF[u.type]);
  const size = ground.length + 1;
  const tilt = personality?.aggression > .65 ? .06 : 0;   // aggressive AIs lean on armour
  const share = (r) => r.share[era] + (r.role === 'armour' ? tilt : r.role === 'line' ? -tilt : 0);
  const roleCount = (role) => ground.filter((u) => ROLE_OF[u.type] === role).length;
  return (facility, allowOver) => {
    const picks = [];
    for (const r of ROLES) {
      const gap = share(r) * size - roleCount(r.role);
      const types = r.types.filter(([t, , tier]) => (tier || ACTION_UNITS[t].tier) <= highest && !!ACTION_BUILDINGS[facility]?.trains?.includes(t));
      if (!types.length || gap <= 0 && !allowOver) continue;
      const total = types.reduce((n, [, w]) => n + w, 0), have = types.reduce((n, [t]) => n + count(t), 0) + 1;
      const order = types.map(([t, w]) => ({ t, g: w / total * have - count(t) })).sort((a, b) => b.g - a.g).map((x) => x.t);
      picks.push({ gap, order });
    }
    return picks.sort((a, b) => b.gap - a.gap).flatMap((x) => x.order);
  };
}

function buildArmy(game, civ, bases, own, observed, p) {
  const byType = {};
  for (const u of own) byType[u.type] = (byType[u.type] || 0) + 1;
  const count = (type) => byType[type] || 0;
  const ground = observed.filter((u) => !ACTION_UNITS[u.type].air);
  const enemyArmor = ground.filter((u) => ['wheeled', 'tracked'].includes(ACTION_UNITS[u.type].move)).length;
  const enemyAir = observed.length - ground.length;
  const defensive = p.state === 'Defending';
  const highest = civ.age + 1, starved = energyBound(game, civ);
  for (const s of bases) {
    const hq = headquarters(game, s);
    if (!hq?.done) continue;
    const facilities = facilitiesAt(game, s);
    if (defensive && game.time > 150 && civ.res.materials > 460 && civ.res.energy > 135 && !hq.project)
      fortifyBase(game, civ, s);
    // (no repairs to order: the base engineers repair automatically, 2026-11-20)
    const exists = (type) => facilities.some((b) => b.type === type);
    const main = s === bases[0];
    // a second Materials Processor early: materials, not energy, limit how many troops an AI can field
    // W2: enemy air seen in the last couple of minutes (p.enemyAir) brings the Heavy Weapons Works (AA vehicles) forward
    let build = main ? ['depot', 'barracks', 'power_plant', 'motor_works', 'depot', ...(Math.max(enemyAir, p.enemyAir || 0) >= 1 ? ['heavy_weapons', 'airfield'] : ['airfield', 'heavy_weapons']), 'advanced_lab'] :
      s.kind === 'research' ? ['power_plant', 'advanced_lab', 'depot', 'missile_silo', 'airfield'] :
      // W2: the second base puts up the airfield (or, against enemy air, the AA-producing Heavy Weapons Facility) fourth,
      // so the AI fields an air arm at all (Wave 1: airfields only appeared at the seventh slot of a tier-3 base)
      bases.indexOf(s) === 1 ? ['depot', 'power_plant', s.kind === 'military' ? 'barracks' : 'motor_works',
        ...(Math.max(enemyAir, p.enemyAir || 0) >= 1 ? ['heavy_weapons', 'airfield'] : ['airfield', 'heavy_weapons']), 'barracks', 'advanced_lab'] :
      ['depot', 'power_plant', s.kind === 'military' ? 'barracks' : 'motor_works', 'barracks', 'heavy_weapons', 'airfield', 'advanced_lab'];
    if (starved) build = energyList(build);
    // AI_OPERATIONS.md: the strategic programme's host base keeps its free ring sites for the lab and silo
    if (openSlots(game, s).length && !facilities.some((b) => !b.done) && !(p.nuke?.saving && p.nuke.host === s.id)) {
      const have = {}, wanted = {};
      for (const b of facilities) have[b.type] = (have[b.type] || 0) + 1;
      const type = build.find((t) => (wanted[t] = (wanted[t] || 0) + 1) > (have[t] || 0) && ACTION_BUILDINGS[t].tier <= highest &&
        (!ACTION_BUILDINGS[t].needs || facilities.some((b) => b.type === ACTION_BUILDINGS[t].needs && b.done)));
      // outposts build out only once the army floor is met: facilities everywhere and no troops loses wars
      if (type && (main || own.length >= armyFloor(game) * .6 && civ.res.materials >= ACTION_BUILDINGS[type].cost.materials + 60)) construct(game, civ, s, type);
    }
    if (s.tier < 3 && !hq.project && game.time >= (s.tier === 1 ? 110 : 420) && (main || !p.nuke?.saving && !openSlots(game, s).length && civ.res.materials > 780))
      advanceBase(game, civ, s);
  }
  const cap = armyCapacity(game, civ);
  if (cap.limit <= cap.used + cap.queued) return;
  // Saving for a new headquarters or the next tier never starves the army below its floor (which grows
  // with the match), so the AI keeps fielding troops instead of banking materials for minutes at a time.
  const belowFloor = own.length < armyFloor(game);
  const reserveForBase = !belowFloor && p.state === 'Expanding' && game.siteById.get(p.target)?.owner === civ.id && !game.siteById.get(p.target)?.hq;
  const reserveForTier = !belowFloor && highest === 1 && game.time > 135 && !headquarters(game, bases[0])?.project;
  // the settlement price includes the claim road planned at capture (ROADS_AND_CLAIMS.md)
  // AI_OPERATIONS.md: a stalemate's strategic programme banks the missile price (silo / missile) above the army floor
  // (also while defending: stalemates are full of raids, and spending the bank on each one kept the missile out of
  // reach in every 45-minute test match), but only above 80 % of the army floor, so the bank never starves the army
  // balance pass 2026-11-18: brutal banks only once its army is at the full floor (it must stay the strongest AI). Any
  // AI whose stock already holds the step's materials (with 400 to spare) banks its energy from 60 % of the floor:
  // energy is what the late game runs short of, and in 48-minute stalemates hard AIs sat on 3000 materials for 20
  // minutes without ever holding the 600 energy of Tier III. Troops that cost no energy keep coming meanwhile.
  const bankAt = civ.difficulty === 'brutal' ? armyFloor(game) : Math.min(28, armyFloor(game) * .8);
  const step = p.nuke?.saving && p.nuke.reserve;
  const materialsBanked = step && civ.res.materials >= (step.materials || 0) + 400 && own.length >= armyFloor(game) * .6;
  const nukeReserve = step && (own.length >= bankAt || materialsBanked) ? step : null;
  const minimum = nukeReserve ? nukeReserve.materials || 0 : defensive || belowFloor ? 0 : reserveForBase ? settlementCost(game, civ, game.siteById.get(p.target).claimRoad).materials : reserveForTier && own.length >= 7 ? TIERS[1].cost.materials : 38;
  const armorCount = own.filter((u) => ACTION_UNITS[u.type].move === 'tracked' || ACTION_UNITS[u.type].air && ACTION_UNITS[u.type].atk > 0).length;
  const needsArmor = highest >= 2 && armorCount < Math.max(3, own.length * .22);
  // Urgent picks first (a minimum infantry screen, one scout, answers to enemy air and armour), then the
  // balanced composition (compositionPick): the AI used to fall through to rifle squads at every barracks and
  // spammed infantry; now each facility trains whatever its share of the target army is shortest of.
  const preferred = [];
  if (count('rifle_squad') + count('militia') < 4 || own.length < 6) preferred.push('rifle_squad');
  if (count('scout_buggy') === 0) preferred.push('scout_buggy');
  // 2026-11-20: a small militia screen from the headquarters and outposts (their only infantry), never a militia army
  if (game.time > 480 && count('militia') < 1 + bases.length && civ.res.materials > 400) preferred.push('militia');
  // W2: air defence answers the enemy air seen recently (p.enemyAir decays over ~2 min): one AA vehicle per two
  // enemy aircraft (up to 6); upgraded city perimeters add AA in developBases (Warthogs cannot intercept).
  const airSeen = Math.max(enemyAir, p.enemyAir || 0);
  if (airSeen >= 1 && count('air_defense') < Math.min(6, Math.ceil(airSeen * .5))) preferred.push('air_defense');
  if (enemyArmor > count('tank') + count('anti_armor') + count('autonomous_tank') + count('field_gun')) preferred.push('anti_armor', 'tank');
  const airPick = airChoice(own, count, airSeen, highest);
  const comp = compositionPick(own, count, highest, civ.personality);
  // W1: production is paid progressively as it is built, so what is already queued is a commitment against the
  // stockpile: the AI queues only what the stock left after those commitments can sustain, keeps at most two items
  // per facility, and gives urgent answers (air defence, anti-armour) high priority and scouts low priority.
  const owed = productionCommitment(game, civ), stock = { materials: civ.res.materials - owed.materials, energy: civ.res.energy - owed.energy };
  const fillSurplus = civ.difficulty === 'brutal' || !!nukeReserve;   // every AI keeps producing while it banks
  const urgent = new Set(preferred.filter((key) => key === 'air_defense' || key === 'anti_armor' || key === 'tank'));
  // 2026-11-20: the headquarters (militia, scout buggies) and outposts train too (BASE_MENU_REWORK.md §2)
  const hqs = bases.map((s) => headquarters(game, s)).filter(Boolean);
  const forts = [...game.buildings.values()].filter((b) => b.owner === civ.id && b.type === 'fort');
  const light = (b) => b.type === 'barracks' || b.type === 'town' || b.type === 'fort';
  const facilities = [...bases.flatMap((s) => facilitiesAt(game, s)), ...hqs, ...forts].filter((b) => b.done && ACTION_BUILDINGS[b.type].trains && queuedCount(b) < 2)
    .sort((a, b) => Number(light(a)) - Number(light(b)) || a.id - b.id);
  const operation = game.siteById.get(p.target), staging = operation && bases[0] ? game.lerpPoint(bases[0], operation,
    p.state === 'Attacking' || p.state === 'Final Assault' ? .38 : .10) : null;
  for (const b of facilities) {
    if (staging) b.rally = staging;
    const s = game.siteById.get(b.site);
    const affordable = (key) => {
      const d = ACTION_UNITS[key];
      if (!d || !trainsAt(b, key) || d.tier > highest) return false;
      if (needsArmor && b.type === 'barracks' && own.length > 8 && stock.materials < 215 + d.cost.materials) return false;
      const energyReserve = nukeReserve ? nukeReserve.energy || 0 : reserveForBase ? 120 : reserveForTier && own.length >= 7 ? TIERS[1].cost.energy : 0;
      // balance pass 2026-11-18: the strategic bank holds energy only against units that cost energy, so troops that
      // need none keep coming while the missile's energy is saved (energy is what an AI runs short of)
      const energyOk = nukeReserve && !d.cost.energy || stock.energy - (d.cost.energy || 0) >= energyReserve;
      return stock.materials - d.cost.materials >= minimum && energyOk && canPay({ res: stock }, d.cost);
    };
    let type = preferred.find(affordable);
    if (!type && b.type === 'airfield' && airPick && affordable(airPick)) type = airPick;
    // the most under-represented role this facility can train; a facility whose roles are all at or over their
    // share waits (saving materials for the vehicle works), except barracks while no vehicle facility exists yet
    if (!type) type = comp(b.type, highest < 2 || !facilities.some((f) => !light(f) && f.type !== 'airfield')).find(affordable);
    // balance pass 2026-11-18: brutal never lets a facility idle on a surplus beyond its reserves. It trains its most
    // under-represented role even over that role's share and, when energy runs short (energy, not materials, limits an
    // AI's late game), a barracks turns the materials into rifle squads.
    if (!type && fillSurplus && stock.materials >= minimum + FILL_MARGIN) {
      type = comp(b.type, true).find(affordable);
      if (!type && b.type === 'barracks' && affordable('rifle_squad')) type = 'rifle_squad';
    }
    if (type && !train(game, civ, [b.id], type, 1, false, type === 'scout_buggy' ? 0 : urgent.has(type) ? 2 : 1).error) {
      stock.materials -= ACTION_UNITS[type].cost.materials || 0; stock.energy -= ACTION_UNITS[type].cost.energy || 0;
    }
  }
  // (no upgrades to research: the troop upgrades went 2026-11-19, the Armory and its command upgrades 2026-11-20)
}

function frontier(game, civ, start, p) {
  const explored = civ.explored;
  const candidates = [];
  for (let t = 0; t < explored.length; t++) {
    if (!explored[t] || game.world.terr[t] <= T.SHALLOW || game.world.terr[t] >= T.MOUNTAIN) continue;
    for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && !explored[n]) { candidates.push(t); break; } }
  }
  // perf: one key per tile (the comparator computed two distances per comparison)
  const key = new Map(candidates.map((t) => [t, distance(start, centerOf(t)) - ((t + civ.id + p.notes.length) % 11) * .13]));
  candidates.sort((a, b) => key.get(a) - key.get(b));
  return candidates.slice(0, 9).map(centerOf);
}

function scout(game, civ, own, home, p, enemy) {
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
    const grid = enemyGrid(enemy);
    const caches = [...game.materialCaches.values()].filter((c) => c.active && civ.visible[c.tile] && distance(c, candidate) < 12 && !grid.any(c, 3.5));
    caches.sort((a, b) => distance(candidate, a) - distance(candidate, b) - (a.amount - b.amount) * .012);
    if (caches[0] && !game.command(civ.id, { c: 'collect', cache: caches[0].id, units: [candidate.id] }).error) return;
  }
  const enemyBases = [...civ.siteIntel.values()].filter((s) => s.hq && game.hostile(civ.id, s.owner));
  for (const point of frontier(game, civ, candidate, p).concat(frontier(game, civ, home, p))) {
    if (distance(point, candidate) < 1.5 || distance(point, centerOf(p.scoutSkip ?? candidate.tile)) < 1) continue;
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
      s, score: distance(home, s) + (s.base ? 0 : 2.8) + enemyGrid(enemy).near(s, 4).length * 2,
    })).sort((a, b) => a.score - b.score || a.s.id - b.s.id)[0]?.s;
}

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

// (artillery standoff positioning now lives with the task forces: actionAIOps.positionArtillery)

function troopsFor(p, own, n, requireCapture, game = null) {
  const wounded = new Set(p.wounded || []), pickets = picketIds(p);
  // AI_OPERATIONS.md: squads holding a capture that is under way are not recalled (a defence used to pull them off a
  // ruin at 14-17 of 20 s, and the progress decayed)
  const keep = game && p.keepCapture && game.siteById.get(p.keepCapture.site);
  const held = keep && keep.by === p.keepCapture.civ && keep.progress > 0 && keep.owner !== p.keepCapture.civ ? keep : null;
  if (p.keepCapture && !held) p.keepCapture = null;
  const available = own.filter((u) => !u.grounded && u.airOrder?.kind !== 'return' && !wounded.has(u.id) && !pickets.has(u.id) &&
    !(held && distance(u, held) <= held.radius));
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
  // perf: only members that are not already on their way (or fighting) are ordered again
  const fresh = group.filter((u) => needsOrder(game, u, point, 2.8));
  const result = fresh.length ? moveGroup(game, fresh, point, { mode, exact: mode === 'assault' }) : {};
  if (result.deferred) return true;
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
  const grid = enemyGrid(observed), aa = observed.filter((a) => a.type === 'air_defense');
  for (const u of own) {
    if (decisions >= 8) break;
    const d = ACTION_UNITS[u.type];
    if (d.air && u.hp < u.maxHp * .32 && u.airOrder?.kind !== 'return' && !u.grounded) {
      game.returnAircraft(u); decisions++; continue;
    }
    if (u.abilityReady > game.time) continue;
    let use = false, point;
    if (d.ability === 'repair' && d.passive) use = false;   // automatic (the support truck, 2026-11-20)
    else if (d.ability === 'repair') use = own.some((v) => v.hp < v.maxHp * .70 && distance(u, v) < 3.2) || game.roads.edgesOf(u.tile).some((e) => e.cond < 70);
    else if (d.ability === 'cover') use = !u.goal && game.time - u.lastCombat < 3;
    else if (d.ability === 'scan') use = !!u.goal && grid.any(u, d.vision + 2);
    else if (d.ability === 'focused_fire' || d.ability === 'intercept') use = !!u.target && observed.some((v) => v.id === u.target);
    else if (d.ability === 'bombard' && !u.goal) {
      // perf: the cluster size of each candidate is counted once (it was counted inside the sort comparator)
      const inRange = grid.near(u, d.range).filter((v) => !ACTION_UNITS[v.type].air && distance(u, v) >= (d.minRange || 0));
      const crowd = new Map(inRange.map((v) => [v, grid.near(v, 1).length]));
      point = inRange.sort((a, b) => crowd.get(b) - crowd.get(a))[0];
      use = !!point;
    } else if (d.ability === 'strike' && !u.airOrder) {
      point = observed.find((v) => ['tracked', 'wheeled'].includes(ACTION_UNITS[v.type].move) && distance(u, v) < 12);
      use = !!point;
    } else if (d.ability === 'gun_run' && !u.grounded && !['gun_run', 'return'].includes(u.airOrder?.kind)) {
      // Warthog: strafe ground forces (armour first) that no observed air defense covers; it is fragile under AA
      const covered = (v) => aa.some((a) => distance(a, v) < 4.5);
      const ground = grid.near(u, 12).filter((v) => !ACTION_UNITS[v.type].air && !covered(v));
      point = ground.find((v) => ['tracked', 'wheeled'].includes(ACTION_UNITS[v.type].move)) || ground[0];
      use = !!point;
    }
    if (use) { game.command(civ.id, { c: 'ability', ability: d.ability, units: [u.id], point: point && { x: point.x, z: point.z } }); decisions++; }
  }
  // strategic missiles: actionAIOps.strategicProgram (stalemates, silo, build, launch)
}

// Era upgrades on economy buildings and perimeters, and a New Base (1000) once the AI banks a surplus
// and has no ruin left to expand to. Placement follows the player rules (own territory, beside a road).
function developBases(game, civ, bases, own, p) {
  if (game.time < (p.developAt || 0)) return;
  // balance pass 2026-11-18: brutal invests in its economy first. Output upgrades (+40 % for 150-255 materials) pay
  // for themselves in about two minutes, so it buys them every 5 s, below its army floor, with a small margin and while
  // the strategic programme saves: that income is what pays for its army, its works and its missile.
  const eager = civ.difficulty === 'brutal';
  p.developAt = game.time + (eager ? 5 : 10);
  const mine = [...game.buildings.values()].filter((b) => b.owner === civ.id && b.done);
  const saving = !!p.nuke?.saving;
  const upgradeEconomy = () => {
    const starved = energyBound(game, civ);
    const economy = mine.filter((b) => (b.type === 'power_plant' || b.type === 'depot' && (eager || !saving) && !starved) && !b.project && (b.level || 1) < civ.age + 1)
      .sort((a, b) => (a.level || 1) - (b.level || 1) || Number(b.type === 'depot') - Number(a.type === 'depot') || a.id - b.id)[0];
    const cost = economy && ACTION_BUILDINGS[economy.type].levels.cost[(economy.level || 1) - 1];
    if (economy && civ.res.materials > cost.materials + (eager ? 60 : 280) && civ.res.energy > (cost.energy || 0) + (eager ? 20 : 60)) upgradeBuilding(game, civ, economy.id);
  };
  if (eager && civ.age >= 1) upgradeEconomy();
  // a base full of Materials Processors while energy binds: one processor beyond the first at a base with no free ring
  // site is pulled down (every 2 minutes at most); buildArmy puts an Energy Generator in its place
  if (energyBound(game, civ) && civ.res.materials > 4000 && game.time >= (p.convertAt || 0) && !bases.some((s) => openSlots(game, s).length)) {
    p.convertAt = game.time + 120;
    for (const s of bases) {
      const depots = facilitiesAt(game, s).filter((b) => b.type === 'depot' && b.done && !b.project).sort((a, b) => (a.level || 1) - (b.level || 1) || a.id - b.id);
      if (depots.length < 2) continue;
      if (!demolish(game, civ, depots[0].id).error) { note(game, p, `Converting a Materials Processor at ${s.name} to energy.`); break; }
    }
  }
  if (own.length < armyFloor(game) * .7) return;
  if (civ.age >= 1) {
    if (!eager) upgradeEconomy();
  }
  // 2026-11-20 (BASE_MENU_REWORK.md §8): engineers, perimeter paths (anti-air answers enemy air), unit lines, the centre
  // turret, outposts and building levels, one purchase per pass
  if (!saving) aiUpgrades(game, civ, bases, own, p.observed || [], p);
  if (saving || game.time < 420 || bases.length >= 5 || civ.res.materials < 1350 || p.state === 'Expanding' || game.time < (p.newBaseAt || 0)) return;
  // the New Base left the game (2026-11-20): an outpost toward the enemy instead (actionAIUpgrades.aiOutpost)
  p.newBaseAt = game.time + 30;
  if (aiOutpost(game, civ, bases, p)) note(game, p, 'Founding an outpost.');
}

// Perf (2026-11-19, TELEMETRY_ANALYSIS_2026-11-19 B1): a plan call is bounded.
//  * At most AI_SYNC_ROUTES members of the call's group orders are routed inside the call (none: a single late-game route can
//    take 100-300 ms); moveGroup queues the rest on game.groupJobs (saved with the game, routed a few a tick under
//    the tick's routing budget, as large AI orders already were). Routing was two thirds of all plan time (late-game
//    routes average ~6 ms, the worst take 100-300 ms) and the source of the 0.5-1.9 s calls.
//  * The two heavy stages alternate between calls (p.stage, saved with the plan): stage 0 the strategic programme and
//    base development, stage 1 the AI works pass. Perception, production, tactics, pickets and the operation run on
//    every call.
//  * At most AI_GROUP_ORDERS group orders per call (actionAIOps.moveGroup): the flow field each one primes was the
//    next largest cost once routing left the call; a deferred order goes out on a later call.
//  * Seen enemies are bucketed once per call (enemyGrid); site and unit queries no longer filter the whole list.
export const AI_SYNC_ROUTES = 0;
// group orders (4+ ground units, each priming a flow field) per plan call; urgent withdrawals are not counted
export const AI_GROUP_ORDERS = 3;
function capSyncRoutes(game) {
  const limit = GROUP_ROUTE?.aiTick;
  if (!limit || !Array.isArray(game.groupJobs)) return;
  const spent = game.groupSpent ??= { tick: -1, n: 0 };
  if (spent.tick !== game.tickN) { spent.tick = game.tickN; spent.n = 0; }
  spent.n = Math.max(spent.n, limit - AI_SYNC_ROUTES);
}

export function planActionAI(game, civ) {
  aiOrders.left = AI_GROUP_ORDERS;
  try { plan(game, civ); } finally { aiOrders.left = Infinity; }
}

function plan(game, civ) {
  const p = civ.aiPlan;
  p.next = game.time + (civ.difficulty === 'easy' ? 4.2 : ['expert', 'brutal'].includes(civ.difficulty) ? 2 : 3);
  capSyncRoutes(game);
  const stage = p.stage = ((p.stage ?? 1) + 1) % 2;
  // base engineers (u.auto) work on their own and are never drafted into operations
  const owned = [...game.units.values()].filter((u) => u.owner === civ.id && !u.auto);
  const bases = game.sites.filter((s) => s.owner === civ.id && s.slots).sort((a, b) => b.tier - a.tier || a.id - b.id);
  const home = bases[0] || game.sites[civ.id];
  const known = [...civ.siteIntel.values()];
  const enemy = [...game.units.values()].filter((u) => game.hostile(civ.id, u.owner) && game.sees(civ, u));
  // W2: short strategic memory. Enemy air seen recently (decays to half in ~2.3 min) drives AA and fighter
  // production; the strongest enemy force seen recently (half-life ~3.5 min) is what field superiority is judged against.
  p.enemyAir = Math.max(enemy.filter((u) => ACTION_UNITS[u.type].air).length, (p.enemyAir || 0) * .985);
  Object.defineProperty(p, 'observed', { value: enemy, writable: true, configurable: true, enumerable: false });   // not saved
  p.enemyPeak = Math.max(sumForce(enemy), (p.enemyPeak || 0) * .99);
  p.checked ??= {};
  for (const s of game.sites) if (s.slots && civ.visible[s.tile]) p.checked[s.id] = game.time;
  for (const s of bases) if (!s.hq) establish(game, civ, s);
  const grid = enemyGrid(enemy);
  if (stage === 0) strategicProgram(game, civ, p, owned, enemy, bases);
  buildArmy(game, civ, bases, owned, enemy, p);
  if (stage === 0) developBases(game, civ, bases, owned, p);
  else aiWorks(game, civ, bases, owned, enemy, p);
  tacticalSupport(game, civ, owned, enemy);
  if (civ.difficulty !== 'easy') evacuateWounded(game, civ, owned, home, p);
  managePickets(game, civ, p, owned, enemy);

  // Retreats commit for a bounded period. The operation cannot flip back into attack
  // on the next planning tick, and threat estimates use observed forces only.
  if (p.recoverUntil > game.time) {
    // (repairs at home are automatic: base engineers and the support trucks' passive field repair)
    scout(game, civ, owned, home, p, enemy);
    return;
  }
  const troopSet = new Set(p.troops);
  const committed = owned.filter((u) => troopSet.has(u.id));
  const opposed = nearAny(enemy, committed, 5.5);
  // a Final Assault (a concentrated attack on an objective judged assailable) is only broken off at 2.4x
  const outmatched = committed.length >= 3 && opposed.length >= 3 &&
    opposed.reduce((n, u) => n + force(u), 0) > committed.reduce((n, u) => n + force(u), 0) * (p.state === 'Final Assault' ? 2.4 : 1.85);
  if (outmatched && !grid.any(home, 4)) {
    if ((p.state === 'Attacking' || p.state === 'Final Assault') && p.target) failed(game, p, p.target);
    game.command(civ.id, { c: 'withdraw', units: committed.map((u) => u.id) });
    objective(game, p, 'Recovering'); p.recoverUntil = game.time + 23;
    note(game, p, 'Withdrawing to repair and gather a mixed reinforcement force.');
    return;
  }

  const defended = bases.find((s) => grid.any(s, civ.difficulty === 'easy' ? 4.8 : 6.3));
  const enemiesNearHome = defended ? grid.near(defended, 7) : [];
  // A raid on a base that a large army can absorb is met by a proportional garrison while the main
  // operation continues; a real threat recalls everything.
  const operating = p.state === 'Attacking' || p.state === 'Final Assault' || p.state === 'Expanding';
  const raidForce = sumForce(enemiesNearHome), armyForce = sumForce(owned);
  // Stalemate pass (2026-11-19, TELEMETRY_ANALYSIS B6: 9 of 49 operations were recalled to defend): an operation is
  // recalled only by a real threat, an attack worth 45 % of the whole army, or a quarter of it with the headquarters
  // already under fire. Anything smaller is met by a proportional guard (up to half the army) while the operation
  // carries on. Small armies (under 12) still defend with everything.
  const hq = defended && headquarters(game, defended);
  const besieged = !!hq && hq.hp < hq.maxHp * .7 && grid.any(hq, 4.5, (u) => !ACTION_UNITS[u.type].air);
  const realThreat = owned.length < 12 || raidForce >= armyForce * .45 || besieged && raidForce >= armyForce * .25;
  if (defended && operating && !realThreat) {
    const vanguard = enemiesNearHome.find((u) => !ACTION_UNITS[u.type].air) || enemiesNearHome[0];
    if (game.time > (p.guardAt || 0)) {
      p.guardAt = game.time + 9;
      const wounded = new Set(p.wounded || []), operation = new Set(p.troops);
      const pool = owned.filter((u) => !wounded.has(u.id) && !u.grounded && ACTION_UNITS[u.type].atk > 0)
        .sort((a, b) => Number(operation.has(a.id)) - Number(operation.has(b.id)) || distance(a, defended) - distance(b, defended) || a.id - b.id);
      const guard = [];
      const most = Math.max(30, Math.floor(owned.length * .5));
      for (const u of pool) { if (sumForce(guard) >= raidForce * 1.7 && guard.length >= 3 || guard.length >= most) break; guard.push(u); }
      const ids = new Set(guard.map((u) => u.id));
      p.troops = p.troops.filter((id) => !ids.has(id));
      p.guard = { ids: [...ids], until: game.time + 20 };
      const post = game.lerpPoint(defended, vanguard, .72), fresh = guard.filter((u) => needsOrder(game, u, post, 2.8));
      if (fresh.length) moveGroup(game, fresh, post, { mode: 'assault', urgent: true });
    }
  } else if (defended) {
    // a capture under way keeps its holders while the rest of the army defends (troopsFor skips them)
    const capturing = p.state === 'Expanding' && game.siteById.get(p.target);
    if (capturing && capturing.by === civ.id && capturing.progress >= capturing.captureTime * .5 && capturing.owner !== civ.id) p.keepCapture = { site: capturing.id, civ: civ.id };
    objective(game, p, 'Defending', defended.id);
    const group = troopsFor(p, owned, Math.min(80, owned.length), false, game);
    const vanguard = enemiesNearHome.find((u) => !ACTION_UNITS[u.type].air) || enemiesNearHome[0];
    approach(game, p, group, game.lerpPoint(defended, vanguard, .72), 'assault');
    if (game.time > (p.defenseAt || 0)) {
      aiEmergencyWorks(game, civ, defended, vanguard, enemiesNearHome, p);   // AI_WORKS.md: list price only, sets p.defenseAt
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
    if (p.state === 'Attacking' || final) failed(game, p, p.target);
    p.avoid = p.target;
    p.avoidUntil = game.time + 50;
    note(game, p, 'Operation ended after bounded recovery.');
    objective(game, p, 'Recovering');
  }
  // (the region lookup only for sites chooseExpansion can take: a fresh region table costs a flood fill)
  const expansion = chooseExpansion(game, civ, known.filter((s) => !s.hq && (s.owner < 0 || game.hostile(civ.id, s.owner)) && (s.id !== p.avoid || game.time > p.avoidUntil) &&
    canReach(game, { type: 'rifle_squad', x: home.x, z: home.z }, s)), home, enemy);
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
  const garrisonAt = (s) => sumForce(grid.near(s, 8));
  const defences = knownDefences(game, civ, p);
  // Stalemate pass (2026-11-19): what holds an objective is its garrison plus the armed works seen around it (attack
  // value x1.4 for their armour; works seen before this pass count 18). The odds compare it with the army's strike
  // force; closing in, the weakest objective ranks first by those odds, not by its garrison alone.
  const strikeForce = armyForce * .85;
  const defenceAt = (s) => garrisonAt(s) + defences.reduce((n, d) => n + (distance(d, s) < 6 ? (d.atk ?? 18) * 1.4 : 0), 0);
  const odds = (s) => strikeForce / Math.max(1, defenceAt(s) * 1.2);
  const rank = (s) => distance(s, home) + (closing ? Math.min(40, defenceAt(s) / Math.max(1, strikeForce) * 30) + (enemyBases.filter((o) => o.owner === s.owner).length - 1) * 5 : 0) -
    (s.id === p.target ? 12 : 0) + (p.failedAt?.[s.id] || 0) * 9 + defences.filter((d) => distance(d, s) < 6).length * 1.5;
  // perf: one rank per site (the comparator filtered the enemy and defence lists twice per comparison)
  const ranks = new Map(enemyBases.map((s) => [s, rank(s)]));
  enemyBases.sort((a, b) => ranks.get(a) - ranks.get(b) || a.id - b.id);
  let target = known.find((s) => s.id === p.target) || enemyBases.find((s) => s.presumed && s.id === p.target);
  if (target?.owner === civ.id) { leavePicket(game, civ, p, owned, target); objective(game, p, 'Consolidating'); target = null; }
  // Stalemate pass: a Final Assault is called only on an objective the army can take (odds >= 1.25). Closing in on a
  // fortress it cannot take (78 % of AI minutes were "Final Assault" in the 4v4, 18 % of operations captured anything),
  // the AI keeps taking the enemy's outposts and lesser bases instead (expansion, below) and the strategic programme
  // works on the fortress.
  const assailable = !!enemyBases[0] && odds(enemyBases[0]) >= 1.25;
  // superiority interrupts expansion and lesser operations for the final assault (or the hunt, below)
  if (target && closing && assailable && !['Attacking', 'Final Assault', 'Defending'].includes(p.state)) target = null;
  if (target && closing && assailable && p.state === 'Attacking' && enemyBases[0].id === target.id) objective(game, p, 'Final Assault', target.id);
  // Do not march into a defence that is visibly stronger than the army that would attack it.
  const garrison = enemyBases[0] ? garrisonAt(enemyBases[0]) : 0;
  const canAssault = owned.length >= attackCount && game.time > opening && sumForce(owned) * .85 > garrison * 1.2;
  if (!target) {
    if (expansion && (!closing || !assailable) && (bases.length < 3 || !canAssault || !enemyBases.length || closing)) objective(game, p, bases.length ? 'Expanding' : 'Recovering', expansion.id);
    else if ((canAssault || closing) && enemyBases.length) objective(game, p, closing && assailable || enemyBases.length === 1 && owned.length >= 19 ? 'Final Assault' : 'Attacking', enemyBases[0].id);
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
      const fresh = ahead ? group.filter((u) => needsOrder(game, u, ahead)) : [];
      if (ahead && group.length && (!fresh.length || !moveGroup(game, fresh, ahead, { mode: 'assault' }).error)) note(game, p, 'Hunting for the enemy.');
      else if (site) p.checked[site.id] = game.time;
    }
    scout(game, civ, owned, home, p, enemy);
    return;
  }
  if (!target) { scout(game, civ, owned, home, p, enemy); return; }
  const attacking = p.state === 'Attacking' || p.state === 'Final Assault';
  // an outpost held by a rival is taken by a stronger group once the army is closing in (stalemate pass)
  const held = !attacking && closing && target.owner >= 0 && target.owner !== civ.id;
  const group = troopsFor(p, owned, Math.min(attacking ? 160 : held ? Math.min(30, Math.max(12, Math.round(owned.length * .3))) : Math.min(16, Math.max(9, Math.round(owned.length * .25))),Math.max(1, owned.length - (attacking ? Math.max(2, Math.floor(owned.length * .14)) : 1))), true);
  if (!group.length) return;
  if (attacking) {
    // AI_OPERATIONS.md: task forces on separate corridors, mustered and launched together; the ruin left by a
    // destroyed headquarters is then taken and held (secureSite)
    if (group.length >= 3 || p.op) runOperation(game, civ, p, owned, enemy, home, target);
  } else {
    // Expanding: hold the zone until it flips (R7: progress decays as soon as nobody stands in it). Vehicles cut off by
    // an unbridged river stay behind (infantry wade and take it); the engineers are ordered to bridge it meanwhile.
    if (cutOff(game, group, target).length) bridgeToward(game, civ, p, home, target, 'site:' + target.id);
    const result = secureSite(game, civ, p, group, target, enemy);
    if (result.holders && !result.contested && live(game, target)?.owner !== civ.id) p.progressAt = game.time;
    else if ((p.capture?.progressAt ?? 0) > p.progressAt) p.progressAt = p.capture.progressAt;
    p.failures = p.capture?.failures || 0;
  }
  scout(game, civ, owned, home, p, enemy);
}
