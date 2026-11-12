import { T } from './constants.js';
import { NB, disk } from './hex.js';
import { ACTION_BUILDINGS, ACTION_UNITS, ACTION_UPGRADES, MISSILE_PROJECT, TIERS } from './actionDefinitions.js';
import { advanceBase, armyCapacity, canPay, construct, constructDefense, establish, facilitiesAt, headquarters, openSlots, repairFacility, startUpgrade, train } from './actionBases.js';
import { centerOf, distance } from './actionNavigation.js';
import { moveGroup } from './actionOrders.js';

const force = (u) => ACTION_UNITS[u.type].atk * Math.max(.25, u.hp / u.maxHp);

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
  note(game, p, target ? `${state} at ${game.siteById.get(target)?.name || 'the objective'}` : state);
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
    if (hq.hp < hq.maxHp * .70 && !hq.project) repairFacility(game, civ, hq.id);
    const exists = (type) => facilities.some((b) => b.type === type);
    const main = s === bases[0];
    const build = main ? ['depot', 'power_plant', 'barracks', 'armory', 'motor_works', enemyAir > 1 ? 'heavy_weapons' : 'airfield', 'advanced_lab', 'heavy_weapons'] :
      s.kind === 'research' ? ['power_plant', 'armory', 'advanced_lab', 'depot', 'missile_silo', 'airfield'] :
      ['depot', 'power_plant', s.kind === 'military' ? 'barracks' : 'motor_works', 'barracks', 'heavy_weapons', 'airfield', 'advanced_lab'];
    if (openSlots(game, s).length && !facilities.some((b) => !b.done)) {
      const type = build.find((t) => !exists(t) && ACTION_BUILDINGS[t].tier <= highest &&
        (!ACTION_BUILDINGS[t].needs || facilities.some((b) => b.type === ACTION_BUILDINGS[t].needs && b.done)));
      if (type && (main || civ.res.materials >= ACTION_BUILDINGS[type].cost.materials + 60)) construct(game, civ, s, type);
    }
    if (s.tier < 3 && !hq.project && game.time >= (s.tier === 1 ? 110 : 420) && (main || !openSlots(game, s).length && civ.res.materials > 780))
      advanceBase(game, civ, s);
  }
  const cap = armyCapacity(game, civ);
  if (cap.limit <= cap.used + cap.queued) return;
  const reserveForBase = p.state === 'Expanding' && game.siteById.get(p.target)?.owner === civ.id && !game.siteById.get(p.target)?.hq;
  const reserveForTier = highest === 1 && game.time > 135 && !headquarters(game, bases[0])?.project;
  const minimum = defensive ? 0 : reserveForBase ? ACTION_BUILDINGS.town.cost.materials : reserveForTier && own.length >= 7 ? TIERS[1].cost.materials : 38;
  const armorCount = own.filter((u) => ACTION_UNITS[u.type].move === 'tracked' || ACTION_UNITS[u.type].air && ACTION_UNITS[u.type].atk > 0).length;
  const needsArmor = highest >= 2 && armorCount < Math.max(3, own.length * .22);
  const preferred = [];
  if (count('rifle_squad') + count('militia') < 4 || own.length < 6) preferred.push('rifle_squad');
  if (count('engineer') === 0) preferred.push('engineer');
  if (count('scout_buggy') === 0) preferred.push('scout_buggy');
  if (enemyAir > count('air_defense') + count('fighter')) preferred.push('air_defense', 'fighter');
  if (enemyArmor > count('tank') + count('anti_armor')) preferred.push('anti_armor', 'tank');
  if (count('mortar_team') + count('sp_artillery') < own.length / 6) preferred.push('sp_artillery', 'mortar_team');
  if (count('rifle_squad') < own.length / 3) preferred.push('rifle_squad');
  if (civ.personality?.aggression > .65) preferred.push('armored_car', 'tank', 'exo_infantry');
  else if (civ.personality?.riskAversion > .55) preferred.push('tank', 'mortar_team', 'fighter');
  if (count('anti_armor') < Math.max(1, own.length * .15)) preferred.push('anti_armor');
  preferred.push('autonomous_tank', 'helicopter', 'tank', 'mech_infantry', 'armored_car', 'rifle_squad');
  const facilities = bases.flatMap((s) => facilitiesAt(game, s)).filter((b) => b.done && b.queue.length < 2)
    .sort((a, b) => Number(a.type === 'barracks') - Number(b.type === 'barracks') || a.id - b.id);
  const operation = game.siteById.get(p.target), staging = operation ? game.lerpPoint(bases[0], operation, .38) : null;
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
  if (own.length >= 10 && civ.res.materials >= 600 && civ.res.energy >= 145) {
    const upgrade = Object.keys(ACTION_UPGRADES).find((key) => !civ.techs.has(key) && ACTION_UPGRADES[key].tier <= highest);
    if (upgrade) startUpgrade(game, civ, upgrade);
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
    if (!moveGroup(game, [candidate], point, { mode: 'assault' }).error) break;
  }
}

function chooseExpansion(game, civ, known, home, enemy) {
  return known.filter((s) => !s.hq && (s.owner < 0 || game.hostile(civ.id, s.owner)) && distance(home, s) < 27)
    .map((s) => ({
      s, score: distance(home, s) + (s.base ? 0 : 2.8) + enemy.filter((u) => distance(u, s) < 4).length * 2,
    })).sort((a, b) => a.score - b.score || a.s.id - b.s.id)[0]?.s;
}

function troopsFor(p, own, n, requireCapture) {
  const available = own.filter((u) => !u.grounded && u.airOrder?.kind !== 'return');
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

export function planActionAI(game, civ) {
  const p = civ.aiPlan;
  p.next = game.time + (civ.difficulty === 'easy' ? 4.2 : ['expert', 'brutal'].includes(civ.difficulty) ? 2 : 3);
  const owned = [...game.units.values()].filter((u) => u.owner === civ.id);
  const bases = game.sites.filter((s) => s.owner === civ.id && s.slots).sort((a, b) => b.tier - a.tier || a.id - b.id);
  const home = bases[0] || game.sites[civ.id];
  const known = [...civ.siteIntel.values()];
  const enemy = [...game.units.values()].filter((u) => game.hostile(civ.id, u.owner) && game.sees(civ, u));
  for (const s of bases) if (!s.hq) establish(game, civ, s);
  buildArmy(game, civ, bases, owned, enemy, p);
  tacticalSupport(game, civ, owned, enemy);

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
  if (defended) {
    objective(game, p, 'Defending', defended.id);
    const group = troopsFor(p, owned, Math.min(26, owned.length), false);
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
  if (p.target && (p.failures >= 3 || game.time - p.progressAt > 85)) {
    p.avoid = p.target;
    p.avoidUntil = game.time + 50;
    note(game, p, 'Operation ended after bounded recovery.');
    objective(game, p, 'Recovering');
  }
  const expansion = chooseExpansion(game, civ, known.filter((s) => s.id !== p.avoid || game.time > p.avoidUntil), home, enemy);
  const enemyBases = known.filter((s) => s.hq && s.owner >= 0 && game.hostile(civ.id, s.owner) && (s.id !== p.avoid || game.time > p.avoidUntil))
    .sort((a, b) => distance(a, home) - distance(b, home));
  let target = known.find((s) => s.id === p.target);
  if (target?.owner === civ.id) { objective(game, p, 'Consolidating'); target = null; }
  const attackCount = civ.difficulty === 'easy' ? 13 : 9;
  const canAssault = owned.length >= attackCount && game.time > 135;
  if (!target) {
    if (expansion && (bases.length < 3 || !canAssault || !enemyBases.length)) objective(game, p, bases.length ? 'Expanding' : 'Recovering', expansion.id);
    else if (canAssault && enemyBases.length) objective(game, p, enemyBases.length === 1 && owned.length >= 19 ? 'Final Assault' : 'Attacking', enemyBases[0].id);
    else if (game.time > 40) objective(game, p, 'Preparing');
    target = known.find((s) => s.id === p.target);
  }
  if (!target) { scout(game, civ, owned, home, p); return; }
  const attacking = p.state === 'Attacking' || p.state === 'Final Assault';
  const group = troopsFor(p, owned, Math.min(attacking ? 128 : 9, Math.max(1, owned.length - (attacking ? Math.max(2, Math.floor(owned.length * .14)) : 1))), true);
  if (!group.length) return;
  if (attacking && target.hq) {
    if (group.length < 3) return;
    const visible = game.buildings.get(target.hq);
    if (visible && game.sees(civ, visible)) {
      if (p.phase !== 'engage') { p.phase = 'engage'; p.progressAt = game.time; }
      const local = group.filter((u) => distance(u, target) < 10);
      const pressure = [...game.buildings.values()].filter((b) => game.hostile(civ.id, b.owner) && distance(b, target) < 5 && game.sees(civ, b))
        .reduce((sum, b) => sum + b.hp, 0);
      if (p.pressure != null && pressure < p.pressure - 2) p.progressAt = game.time;
      p.pressure = pressure;
      if (local.length >= 3 && (game.time - (p.attackAt || -30)) > 13) {
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
          moveGroup(game, reinforcements, game.lerpPoint(home, target, .83), { mode: 'assault' });
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
    approach(game, p, group, target, 'assault');
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
