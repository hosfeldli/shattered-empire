// AI empires. Personalities shape specialization:
//   builder  - stable, scientific, expands widely
//   merchant - trade, markets, diplomacy
//   warlord  - militarized industrial state that seeks conquest
// City development runs through the same governor code that players can enable.
import { MilitaryPlanner } from './missions.js';
import { N, UNITS, TECHS, AGES, isWater, aiProfile } from './constants.js';
import { dist } from './hex.js';
import { defaultGovernor, steerColonist } from './governor.js';
import { nationalRoles } from './planner.js';
import { aiAirStep } from './airPlanner.js';
import { aiMissiles } from './missiles.js';

const TECH_PREF = {
  builder: ['agronomy', 'salvage_engineering', 'schooling', 'surveying', 'trade_networks', 'fortification', 'small_arms', 'seafaring',
    'metallurgy', 'electrification', 'higher_education', 'seismology', 'petroleum', 'civil_engineering', 'munitions_industry', 'motorization', 'logistics', 'field_artillery',
    'mechanized_agriculture', 'geoengineering', 'highways', 'mechanization', 'railways', 'aviation', 'corporate_charter', 'self_propelled_guns',
    'computing', 'networked_command', 'federal_union', 'air_defense', 'drones', 'special_operations', 'precision_missiles',
    'fusion_power', 'continental_arcology', 'robotics', 'climate_engineering', 'exo_armor', 'strike_swarms'],
  warlord: ['small_arms', 'salvage_engineering', 'agronomy', 'fortification', 'surveying', 'schooling', 'trade_networks', 'seafaring',
    'metallurgy', 'munitions_industry', 'petroleum', 'motorization', 'field_artillery', 'electrification', 'logistics', 'civil_engineering', 'higher_education', 'seismology',
    'mechanization', 'self_propelled_guns', 'aviation', 'highways', 'railways', 'mechanized_agriculture', 'geoengineering', 'corporate_charter',
    'computing', 'air_defense', 'drones', 'precision_missiles', 'special_operations', 'networked_command', 'federal_union',
    'robotics', 'strike_swarms', 'exo_armor', 'fusion_power', 'climate_engineering', 'continental_arcology'],
  merchant: ['agronomy', 'trade_networks', 'salvage_engineering', 'schooling', 'seafaring', 'surveying', 'small_arms', 'fortification',
    'metallurgy', 'petroleum', 'electrification', 'motorization', 'higher_education', 'logistics', 'civil_engineering', 'munitions_industry', 'seismology', 'field_artillery',
    'corporate_charter', 'highways', 'railways', 'mechanized_agriculture', 'mechanization', 'aviation', 'geoengineering', 'self_propelled_guns',
    'computing', 'federal_union', 'networked_command', 'air_defense', 'drones', 'precision_missiles', 'special_operations',
    'fusion_power', 'continental_arcology', 'robotics', 'climate_engineering', 'strike_swarms', 'exo_armor'],
};
const POLICY_PREF = {
  builder: ['rationing', 'research_grants', 'extraction_quotas', 'conservation', 'homesteading'],
  warlord: ['conscription', 'extraction_quotas', 'total_war', 'fortification', 'industrial_planning'],
  merchant: ['free_markets', 'rationing', 'research_grants', 'public_works', 'conservation'],
};
const GOV_PREF = { builder: ['federal', 'technocracy'], warlord: ['junta'], merchant: ['corporate', 'federal'] };
const SPEC = { builder: ['balanced', 'research', 'agrarian'], warlord: ['industrial', 'fortress', 'balanced'], merchant: ['commercial', 'balanced', 'agrarian'] };
const ARMY_PREF = ['autonomous_tank', 'exo_infantry', 'strike_swarm', 'tank', 'mech_infantry', 'helicopter', 'missile_battery', 'sp_artillery', 'air_defense', 'special_forces', 'armored_car', 'field_gun', 'mortar_team', 'rifle_squad', 'militia'];

export class AI {
  constructor(g, civ) {
    this.g = g; this.civ = civ; this.p = civ.personality;
    this.campaign = null; this.lastTrade = 0; this.colonists = new Map();
    this.mil = new MilitaryPlanner(this);
  }
  cmd(c) { return this.g.command(this.civ.id, c); }
  // civilian units come from the most populous town, never from a city that can't spare people
  hub(minPop = 10) { const c = this.g.cityOf(this.civ).filter((x) => x.pop >= minPop).sort((a, b) => b.pop - a.pop)[0]; return c || null; }

  think() {
    const g = this.g, civ = this.civ;
    if (!civ.alive || g.over) return;
    this.cities = g.cityOf(civ);
    if (!this.cities.length) return;
    this.myUnits = [...g.units.values()].filter((u) => u.owner === civ.id);
    this.strategy();
    this.research();
    this.government();
    this.governors();
    this.expand();
    this.military();
    this.diplomacy();
  }

  // ---------------------------------------------------------------- strategic layer
  // One coherent goal at a time, with a minimum commitment and hysteresis, so the empire does not
  // lurch between plans whenever one number moves. The goal steers army size, offensives,
  // expansion and city goals; every choice is explained (civ.strategy.why).
  strategy() {
    const g = this.g, civ = this.civ, sk = aiProfile(civ).skill;
    const s = civ.strategy || (civ.strategy = { goal: 'recovery', since: g.time, until: g.time + 120, why: 'starting out', score: 0 });
    if (g.time - (s.checked || 0) < 15) return;
    s.checked = g.time;
    const army = this.myUnits.filter((u) => !UNITS[u.type].civilian);
    const enemies = this.enemies(), threats = this.enemiesNear();
    const mine = this.strength(army), theirs = Math.max(0, ...enemies.map((o) => this.observed(o)));
    const pop = this.cities.reduce((t, c) => t + c.pop, 0), starving = this.cities.some((c) => c.foodShort);
    const next = AGES[civ.age + 1];
    const techsLeft = next ? Math.max(0, next.techsNeeded - [...civ.techs].filter((t) => TECHS[t].age === civ.age).length) : 9;
    const lost = (s.peakArmy || 0) > 8 && army.length < (s.peakArmy || 0) * 0.5;
    s.peakArmy = Math.max((s.peakArmy || 0) * 0.995, army.length);
    const P = this.p;
    const score = {
      recovery: (starving ? 60 : 0) + (pop < 30 ? 30 : 0) + (g.time < 240 ? 40 : 0),
      expansion: this.cities.length < ({ builder: 5, merchant: 4, warlord: 3 }[P] + Math.min(3, civ.age)) ? 35 + (P === 'builder' ? 10 : 0) : 0,
      technology: (techsLeft <= 2 ? 45 : 20) + (P === 'builder' ? 12 : 0) + (P === 'merchant' ? 6 : 0),
      defense: threats.length ? 40 + Math.min(40, threats.length * 4) : enemies.length && theirs > mine ? 35 : 0,
      modernization: civ.age >= 1 && army.some((u) => (g.defs.REFIT[u.type] || []).some((r) => UNITS[r.to].age <= civ.age)) ? 22 : 0,
      offensive: enemies.length && mine > theirs * (P === 'warlord' ? 1.15 : 1.5) && army.length >= 8 ? 30 + (P === 'warlord' ? 25 : 0) + sk.level * 4 : 0,
      rebuild: lost ? 55 : 0,
      victory: civ.age >= 4 ? 50 : 0,
    };
    const [best, bv] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    const cur = score[s.goal] ?? 0;
    // switch only after the commitment ends and for a clearly better goal (or an emergency)
    const emergency = (best === 'defense' && bv >= 60) || (best === 'rebuild' && s.goal === 'offensive');
    if (best !== s.goal && (emergency || (g.time >= s.until && bv > cur * 1.25 + 5))) {
      const WHY = { recovery: 'feed and house the people first', expansion: 'settle more land', technology: `reach ${next ? next.name : 'the last era'}`, defense: 'enemy forces threaten our cities', modernization: 'refit the army with newer equipment', offensive: 'our forces outmatch what we have seen of the enemy', rebuild: 'recover from heavy losses', victory: 'pursue the civilizational victory' };
      s.goal = best; s.since = g.time; s.until = g.time + ({ short: 90, moderate: 150, long: 200, multi: 200 }[sk.plan] || 150); s.why = WHY[best];
    }
    s.score = Math.round(score[s.goal] || 0);
  }

  research() {
    const civ = this.civ;
    const next = AGES[civ.age + 1];
    if (next && !civ.advancing) {
      const have = [...civ.techs].filter((t) => TECHS[t].age === civ.age).length;
      if (have >= next.techsNeeded && this.g.canAfford(civ, next.cost)) this.cmd({ c: 'advance' });
      // national budget: once the era is within reach, save for it instead of spending everything
      civ.saving = have >= next.techsNeeded - 1 ? next.cost : null;
      // missing a deposit is not a dead end: buy the shortfall on the world market
      if (civ.saving && civ.res.credits > (civ.saving.credits || 0) + 400) for (const [k, v] of Object.entries(civ.saving)) {
        if (k === 'credits' || (civ.res[k] || 0) >= v || (civ.gross?.[k] || 0) * 60 > v - (civ.res[k] || 0)) continue;
        const q = this.g.importQuote(civ, k, Math.ceil(v - (civ.res[k] || 0)));
        if (q.error && /market/.test(q.error)) civ.needsMarket = k; else civ.needsMarket = null;
        if (!q.error && civ.res.credits - q.credits > (civ.saving.credits || 0) + 200) this.g.command(civ.id, { c: 'import', good: k, amount: q.amount });
      }
    } else civ.saving = null;
    if (!civ.researching) {
      // cities stranded across water make Seafaring urgent
      const urgent = this.cities.some((c) => c.wantsSeafaring) && !civ.techs.has('seafaring') && TECHS.seafaring.req.every((r) => civ.techs.has(r)) ? ['seafaring'] : [];
      const t = [...urgent, ...TECH_PREF[this.p]].find((k) => !civ.techs.has(k) && TECHS[k].age <= civ.age && TECHS[k].req.every((r) => civ.techs.has(r)));
      if (t) this.cmd({ c: 'research', tech: t });
    }
  }

  government() {
    const civ = this.civ, G = this.g.defs.GOVS;
    const want = GOV_PREF[this.p].find((k) => !G[k].tech || civ.techs.has(G[k].tech));
    if (want && civ.gov !== want && civ.govCooldown <= 0) this.cmd({ c: 'gov', id: want });
    const slots = G[civ.gov].slots;
    for (const p of POLICY_PREF[this.p]) { if (civ.policies.size >= slots) break; if (!civ.policies.has(p)) this.cmd({ c: 'policy', id: p, on: true }); }
    const avgStab = this.cities.reduce((s, c) => s + c.stability, 0) / this.cities.length;
    if (avgStab < 35 && civ.tax > 0) civ.tax--;
    else if (avgStab > 65 && civ.res.credits < 200 && civ.tax < 2) civ.tax++;
    const atWar = this.enemies().length > 0;
    civ.focus = atWar && this.p === 'warlord' ? 'military' : this.p === 'merchant' ? 'commerce' : this.p === 'builder' && civ.age >= 1 ? 'science' : 'balanced';
  }

  governors() {
    nationalRoles(this.g, this.civ);
    const civ0 = this.civ; civ0.claims = civ0.claims || {};
    for (const [k, id] of Object.entries(civ0.claims)) { const c = this.g.cities.get(id); if (!c || c.owner !== civ0.id || [...this.g.buildings.values()].some((b) => b.owner === civ0.id && b.type === k && b.done)) delete civ0.claims[k]; }
    const atWar = this.enemies().length > 0;
    // save up when the next era is within reach
    const civ = this.civ, next = AGES[civ.age + 1];
    const saving = next && !civ.advancing && [...civ.techs].filter((t) => TECHS[t].age === civ.age).length >= next.techsNeeded;
    this.cities.forEach((c, i) => {
      if (!c.governor) c.governor = defaultGovernor(true);
      const gv = c.governor;
      gv.enabled = true; gv.level = 'autonomous';
      // roles are earned from geography and the nation's needs, and kept stable (planner.js)
      gv.spec = civ.roles?.[c.id] || 'balanced';
      gv.reserve = saving ? 0.75 : atWar ? 0.35 : 0.1;
      gv.perms = { build: true, roads: true, repair: true, recruit: !c.capital || atWar, settle: false };
    });
  }

  expand() {
    const g = this.g, civ = this.civ;
    const want = { builder: 5, merchant: 4, warlord: 3 }[this.p] + Math.min(3, civ.age);
    const colonists = this.myUnits.filter((u) => u.type === 'colonist');
    const cap = g.capital(civ);
    const queued = [...g.buildings.values()].some((b) => b.owner === civ.id && b.queue.some((q) => q.unit === 'colonist'));
    const hub = this.hub(12);
    if (this.cities.length + colonists.length < want && !queued && !colonists.length && civ.res.food > 100 && hub && !this.enemiesNear().length) {
      this.cmd({ c: 'train', building: hub.buildingId, unit: 'colonist' });
    }
    void cap;
    for (const s of colonists) steerColonist(g, civ, s, this.colonists);
  }

  // ------------------------------------------------------------- military
  strength(units) { return units.reduce((s, u) => s + (UNITS[u.type].civilian ? 0 : (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp)), 0); }
  enemies() { return this.g.civs.filter((o) => o.alive && this.g.hostile(this.civ.id, o.id) && !o.isRebel); }
  enemiesNear() {
    const g = this.g, w = g.world, vis = this.civ.visible;
    return [...g.units.values()].filter((u) => vis[u.tile] && g.hostile(this.civ.id, u.owner) && !UNITS[u.type].civilian && g.detects(this.civ.id, u) && (w.owner[u.tile] === this.civ.id || this.cities.some((c) => dist(c.tile, u.tile) <= 6)));
  }
  observed(o) { const i = this.civ.intel[o.id]; return i ? i.peak : 0; }

  // Recruitment by role: fill the largest gap in the intended mix (armour, artillery, air
  // defence, line infantry) with the best unit the facility can make, newest era first.
  trainChoice(b) {
    const g = this.g, civ = this.civ;
    const opts = (g.defs.BUILDINGS[b.type].trains || []).filter((u) => !UNITS[u].civilian && !UNITS[u].engineer && !g.canTrain(civ, b, u));
    if (!opts.length) return null;
    const army = this.myUnits.filter((u) => !UNITS[u.type].civilian && !UNITS[u.type].engineer);
    const role = (t) => { const d = UNITS[t]; return d.aa >= 2 ? 'aa' : d.cat === 'artillery' ? 'art' : d.cat === 'tracked' || d.cat === 'wheeled' || d.cat === 'air' ? 'armor' : 'inf'; };
    const have = { inf: 0, armor: 0, art: 0, aa: 0 }; for (const u of army) have[role(u.type)]++;
    const n = Math.max(1, army.length);
    const target = { armor: civ.age >= 1 ? 0.35 : 0, art: civ.age >= 1 ? 0.2 : 0.1, aa: this.enemyAir ? 0.12 : 0, inf: 0.4 };
    // counter-composition (skill): answer what has actually been seen of the enemy
    const k = aiProfile(civ).skill.counter, seen = civ.seenComp;
    if (k > 0 && seen) {
      const tot = Math.max(1, seen.inf + seen.armor + seen.art + seen.air);
      target.art += k * 0.2 * (seen.inf / tot);                 // massed infantry: guns and mortars
      target.armor += k * 0.15 * (seen.inf / tot) - k * 0.1 * (seen.armor / tot);
      target.inf += k * 0.15 * (seen.armor / tot);               // armour: dug-in infantry and field guns
      target.art += k * 0.1 * (seen.armor / tot);
      target.aa = Math.max(target.aa, k * 0.3 * (seen.air / tot));
    }
    const gaps = Object.entries(target).map(([r, t]) => [r, t - have[r] / n]).sort((a, b2) => b2[1] - a[1]);
    const best = (r) => opts.filter((t) => role(t) === r).sort((a, b2) => UNITS[b2].age - UNITS[a].age || (UNITS[b2].atk + UNITS[b2].def) - (UNITS[a].atk + UNITS[a].def))[0];
    for (const [r] of gaps) { const t = best(r); if (t) return t; }
    return opts.sort((a, b2) => UNITS[b2].age - UNITS[a].age)[0];
  }

  // Refit the reserve before raising more low-tier troops: veterans keep their experience.
  refits(army) {
    const g = this.g, civ = this.civ;
    if (civ.saving) return 0;
    let n = 0;
    for (const u of army) {
      if (n >= 3 || u.refitUntil > g.time) continue;
      const path = (g.defs.REFIT[u.type] || []).filter((r) => { const d = UNITS[r.to]; return d.age <= civ.age && (!d.tech || civ.techs.has(d.tech)); }).pop();
      if (!path) continue;
      const fac = [...g.buildings.values()].find((b) => b.owner === civ.id && b.done && (g.defs.BUILDINGS[b.type].trains || []).includes(path.to));
      if (!fac) continue;
      if (this.mil.owner && this.mil.owner(u.id)) continue;             // busy on a mission
      if (dist(u.tile, fac.tile) <= 3) { const r = g.command(civ.id, { c: 'refit', units: [u.id], to: path.to }); if (!(r && r.error)) n++; }
      else if (!u.path.length && !u.field && u.order.kind === 'idle') this.cmd({ c: 'move', units: [u.id], tile: fac.tile, auth: 'mission' });
    }
    return n;
  }

  military() {
    const g = this.g, civ = this.civ;
    // aircraft are run by the air planner (missions from their bases), not by ground missions
    const army = this.myUnits.filter((u) => !UNITS[u.type].civilian && !UNITS[u.type].engineer && u.type !== 'scout_buggy' && !UNITS[u.type].air);
    const enemies = this.enemies();
    const threats = this.enemiesNear();
    this.enemyAir = threats.some((u) => UNITS[u.type].air);
    // size the army by need and by what the treasury can sustain, not by population
    let desired = 4 + 3 * civ.age + 2 * Math.min(8, this.cities.length);
    if (this.p === 'warlord') desired = Math.round(desired * 1.4);
    const prof = aiProfile(civ);
    desired = Math.round(desired * prof.skill.scale * prof.adv.army);
    desired = Math.round(desired * ({ offensive: 1.15, defense: 1.2, rebuild: 1.1, technology: 0.9, recovery: 0.85 }[civ.strategy?.goal] || 1));
    if (enemies.length) desired += 6;
    desired += Math.min(12, threats.length);
    const income = Math.max(1, (civ.gross?.credits || 0));
    if ((civ.upkeep?.credits || 0) > income * 0.45 && !threats.length) desired = Math.min(desired, army.length);   // logistics limit
    // strength, not head-count: a tank is worth several militia
    const tier = army.reduce((s2, u) => s2 + 1 + UNITS[u.type].age * 0.6, 0);
    if (army.length >= desired * 0.6) this.refits(army);
    civ.armyCap = Math.round(desired * 1.2);
    if (tier < desired * (1 + civ.age * 0.6) && army.length < desired * 1.2 && civ.res.food > 50) {
      // recruitment goes through the same production manager players use: the choice of unit
      // comes from the role mix, the batch is spread over every facility that can make it
      const facs = [...g.buildings.values()].filter((b) => b.owner === civ.id && b.done && b.queue.length < 2 && ['barracks', 'motor_works', 'heavy_assembly', 'robotics_complex'].includes(b.type) && (g.cities.get(b.cityId)?.pop || 0) >= 6);
      const wanted = new Map();
      for (const b of facs) { const u = this.trainChoice(b); if (u) wanted.set(u, [...(wanted.get(u) || []), b.id]); }
      const gap = Math.max(1, Math.min(4, Math.ceil((desired - army.length) / 2)));
      for (const [u, ids] of wanted) this.cmd({ c: 'batchTrain', buildings: ids, unit: u, count: Math.min(gap, ids.length * 2) });
    }
    const queuedType = (t) => [...g.buildings.values()].some((b) => b.owner === civ.id && b.queue.some((q) => q.unit === t));
    if (civ.techs.has('motorization') && this.campaign && !queuedType('supply_truck') && !this.myUnits.some((u) => u.type === 'supply_truck')) { const h = this.hub(); if (h) this.cmd({ c: 'train', building: h.buildingId, unit: 'supply_truck' }); }
    if (!this.myUnits.some((u) => u.type === 'engineer') && !queuedType('engineer') && civ.res.materials > 80) { const h = this.hub(); if (h) this.cmd({ c: 'train', building: h.buildingId, unit: 'engineer' }); }
    const scouts = this.myUnits.filter((u) => u.type === 'scout_buggy');
    const unmet = g.civs.some((o) => o !== civ && o.alive && !o.isRebel && g.diplomacy.rel(civ.id, o.id).state === 'unmet');
    const wantScouts = Math.max(1, Math.round(prof.skill.recon * (unmet || g.time < 900 ? 1 : enemies.length ? 1 : 0)));
    if (scouts.length < wantScouts && !queuedType('scout_buggy') && (g.time < 900 || unmet || (enemies.length && prof.skill.recon >= 1)) && civ.res.food > 60) { const h = this.hub(8); if (h) this.cmd({ c: 'train', building: h.buildingId, unit: 'scout_buggy' }); }
    this.mil.scouts(scouts);
    // engineers follow the army or fix things at home
    for (const e of this.myUnits.filter((u) => u.type === 'engineer' && !u.path.length && !u.field)) {
      const broken = [...g.roads.edges.values()].find((x) => x.cond < 60 && g.world.owner[x.a] === civ.id);
      if (broken && dist(e.tile, broken.a) > 0) this.cmd({ c: 'move', units: [e.id], tile: broken.a });
    }
    for (const o of g.civs) {
      if (o === civ || !o.alive || o.isRebel) continue;
      const r = g.diplomacy.rel(civ.id, o.id);
      if (r.state !== 'peace') continue;
      const patience = { warlord: 300, builder: 900, merchant: 1100 }[this.p];
      const mine = this.strength(army), theirs = this.observed(o);
      if (g.time - r.since > patience && mine > theirs * (this.p === 'warlord' ? 1.3 : 1.8) && army.length >= desired * 0.8 && r.attitude < 30) {
        this.cmd({ c: 'diplo', to: o.id, action: 'war' });
        break;
      }
    }
    // missions own their units; the reserve rallies at the front city or hunts nearby rebels
    this.mil.step(army, threats, enemies, desired, { allowOffensive: ['offensive', 'victory'].includes(civ.strategy?.goal) || (civ.strategy?.goal === 'modernization' && this.p === 'warlord') });
    const off = [...this.mil.missions.values()].find((m) => m.kind === 'offensive');
    this.campaign = off ? { city: off.target, start: off.units.size, stage: off.staging } : null;
    const assigned = this.mil.assignedIds();
    const reserve = army.filter((u) => !assigned.has(u.id));
    this.rally(reserve);
    if (!enemies.length && !threats.length) this.huntRebels(reserve);
    aiAirStep(this);
    aiMissiles(this);
  }

  huntRebels(army) {
    const g = this.g, civ = this.civ;
    const reb = g.rebelCiv(); if (!reb) return;
    let best = -1, bd = 24;
    for (const k of civ.knownCities.values()) if (k.owner === reb.id) { const d = Math.min(...this.cities.map((c) => dist(c.tile, k.tile))); if (d < bd) { bd = d; best = k.tile; } }
    for (const b of g.buildings.values()) if (b.owner === reb.id && civ.visible[b.tile]) { const d = Math.min(...this.cities.map((c) => dist(c.tile, b.tile))); if (d < bd) { bd = d; best = b.tile; } }
    const idle = army.filter((u) => !u.path.length && !u.field && u.order.kind === 'idle');
    if (best >= 0 && idle.length >= 6) this.cmd({ c: 'move', units: idle.slice(0, Math.ceil(idle.length * 0.6)).map((u) => u.id), tile: best, attackMove: true, formation: 'line' });
  }

  randomUnexplored() {
    const w = this.g.world, rng = this.g.rng;
    for (let k = 0; k < 80; k++) { const t = rng.int(N); if (!this.civ.explored[t] && !isWater(w.terr[t])) return t; }
    return -1;
  }

  rally(army) {
    const g = this.g, cap = g.capital(this.civ);
    if (!cap) return;
    let front = cap.tile, bd = Infinity;
    for (const k of this.civ.knownCities.values()) if (k.owner !== this.civ.id) { const d = dist(cap.tile, k.tile); if (d < bd) { bd = d; front = k.tile; } }
    const own = this.cities.slice().sort((a, b) => dist(a.tile, front) - dist(b.tile, front))[0] || cap;
    const loiter = army.filter((u) => !u.path.length && !u.field && u.order.kind === 'idle' && dist(u.tile, own.tile) > 4);
    if (loiter.length) this.cmd({ c: 'move', units: loiter.map((u) => u.id), tile: own.tile, formation: 'line' });
  }

  pickTargetCity(enemies) {
    const g = this.g, cap = g.capital(this.civ);
    let best = null, bd = Infinity;
    for (const [id, k] of this.civ.knownCities) {
      if (!enemies.some((e) => e.id === k.owner)) continue;
      const d = dist(cap.tile, k.tile);
      if (d < bd) { bd = d; best = { id, tile: k.tile, buildingId: g.tileB[k.tile] }; }
    }
    return best;
  }
  knownEnemyTile(enemies) {
    const cap = this.g.capital(this.civ); const lo = this.civ.lastOwner;
    let best = -1, bd = Infinity;
    for (let i = 0; i < N; i++) { if (lo[i] < 0 || !enemies.some((e) => e.id === lo[i])) continue; const d = dist(cap.tile, i); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  diplomacy() {
    const g = this.g, civ = this.civ;
    const mine = this.strength(this.myUnits);
    for (const o of g.civs) {
      if (o === civ || !o.alive || o.isRebel) continue;
      const r = g.diplomacy.rel(civ.id, o.id);
      const theirs = this.observed(o);
      if (r.state === 'war' && (mine < theirs * 0.7 || civ.weariness > 35) && g.time - r.since > 120 && g.time - this.lastTrade > 60) { this.lastTrade = g.time; g.diplomacy.act(civ, o.id, 'peace'); }
      else if (r.state === 'peace' && !r.trade && this.p !== 'warlord' && g.time - this.lastTrade > 150 && civ.techs.has('trade_networks')) { this.lastTrade = g.time; g.diplomacy.act(civ, o.id, 'trade'); }
    }
  }

  evaluate(from, action) {
    const g = this.g, civ = this.civ, r = g.diplomacy.rel(civ.id, from.id);
    const mine = this.strength([...g.units.values()].filter((u) => u.owner === civ.id));
    const theirs = this.observed(from);
    switch (action) {
      case 'peace': return mine < theirs * 0.9 || civ.weariness > 25 || (g.time - r.since > 600 && mine < theirs * 1.3) || this.p === 'merchant';
      case 'trade': return r.attitude > -30 && (this.p !== 'warlord' || mine < theirs);
      case 'borders': return r.attitude > 10 || this.p === 'merchant';
      case 'alliance': return r.attitude > 25 && this.p !== 'warlord';
      case 'demand': return theirs > mine * 1.6;
      default: return false;
    }
  }
}
