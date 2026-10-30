// AI empires. Personalities shape specialization:
//   builder  - stable, scientific, expands widely
//   merchant - trade, markets, diplomacy
//   warlord  - militarized industrial state that seeks conquest
// City development runs through the same governor code that players can enable.
import { N, UNITS, TECHS, AGES, isWater } from './constants.js';
import { dist } from './hex.js';
import { defaultGovernor, steerColonist } from './governor.js';

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
    this.research();
    this.government();
    this.governors();
    this.expand();
    this.military();
    this.diplomacy();
  }

  research() {
    const civ = this.civ;
    const next = AGES[civ.age + 1];
    if (next && !civ.advancing) {
      const have = [...civ.techs].filter((t) => TECHS[t].age === civ.age).length;
      if (have >= next.techsNeeded && this.g.canAfford(civ, next.cost)) this.cmd({ c: 'advance' });
    }
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
    const atWar = this.enemies().length > 0;
    // save up when the next era is within reach
    const civ = this.civ, next = AGES[civ.age + 1];
    const saving = next && !civ.advancing && [...civ.techs].filter((t) => TECHS[t].age === civ.age).length >= next.techsNeeded;
    this.cities.forEach((c, i) => {
      if (!c.governor) c.governor = defaultGovernor(true);
      const gv = c.governor;
      gv.enabled = true;
      gv.spec = c.capital ? 'balanced' : SPEC[this.p][i % SPEC[this.p].length];
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

  trainChoice(b) {
    const g = this.g, civ = this.civ;
    const opts = (g.defs.BUILDINGS[b.type].trains || []).filter((u) => !UNITS[u].civilian && !UNITS[u].engineer);
    const army = this.myUnits.filter((u) => !UNITS[u.type].civilian);
    const cnt = (cat) => army.filter((u) => UNITS[u.type].cat === cat).length;
    const order = ARMY_PREF.filter((u) => opts.includes(u));
    // keep some artillery and air defense in the mix
    if (cnt('artillery') < army.length / 5) order.sort((a, b) => (UNITS[b].cat === 'artillery') - (UNITS[a].cat === 'artillery'));
    if (this.enemyAir && !army.some((u) => (UNITS[u.type].aa || 0) >= 2)) order.unshift('air_defense');
    for (const u of order) if (opts.includes(u) && !g.canTrain(civ, b, u)) return u;
    return null;
  }

  military() {
    const g = this.g, civ = this.civ;
    const army = this.myUnits.filter((u) => !UNITS[u.type].civilian && !UNITS[u.type].engineer && u.type !== 'scout_buggy');
    const enemies = this.enemies();
    const threats = this.enemiesNear();
    this.enemyAir = threats.some((u) => UNITS[u.type].air);
    let desired = 3 + 2 * civ.age + Math.min(8, this.cities.length) + Math.floor(civ.popTotal / 10);
    if (this.p === 'warlord') desired = Math.round(desired * 1.6);
    if (enemies.length) desired += 4;
    desired += threats.length;
    desired = Math.min(desired, Math.round(civ.popTotal / 3) + 4);   // an army must not eat the realm
    if (army.length < desired && civ.res.food > 50) {
      for (const b of g.buildings.values()) {
        if (b.owner !== civ.id || !b.done || b.queue.length >= 2) continue;
        if (!['barracks', 'motor_works', 'heavy_assembly', 'airfield', 'drone_works', 'robotics_complex'].includes(b.type)) continue;
        if ((g.cities.get(b.cityId)?.pop || 0) < 6) continue;
        const u = this.trainChoice(b);
        if (u) this.cmd({ c: 'train', building: b.id, unit: u });
      }
    }
    const queuedType = (t) => [...g.buildings.values()].some((b) => b.owner === civ.id && b.queue.some((q) => q.unit === t));
    if (civ.techs.has('motorization') && this.campaign && !queuedType('supply_truck') && !this.myUnits.some((u) => u.type === 'supply_truck')) { const h = this.hub(); if (h) this.cmd({ c: 'train', building: h.buildingId, unit: 'supply_truck' }); }
    if (!this.myUnits.some((u) => u.type === 'engineer') && !queuedType('engineer') && civ.res.materials > 80) { const h = this.hub(); if (h) this.cmd({ c: 'train', building: h.buildingId, unit: 'engineer' }); }
    const scouts = this.myUnits.filter((u) => u.type === 'scout_buggy');
    const unmet = g.civs.some((o) => o !== civ && o.alive && !o.isRebel && g.diplomacy.rel(civ.id, o.id).state === 'unmet');
    if (!scouts.length && !queuedType('scout_buggy') && (g.time < 900 || unmet) && civ.res.food > 60) { const h = this.hub(8); if (h) this.cmd({ c: 'train', building: h.buildingId, unit: 'scout_buggy' }); }
    for (const s of scouts) if (!s.path.length) { const t = this.randomUnexplored(); if (t >= 0) this.cmd({ c: 'move', units: [s.id], tile: t }); }
    // engineers follow the army or fix things at home
    for (const e of this.myUnits.filter((u) => u.type === 'engineer' && !u.path.length)) {
      const broken = [...g.roads.edges.values()].find((x) => x.cond < 60 && g.world.owner[x.a] === civ.id);
      if (broken && dist(e.tile, broken.a) > 0) this.cmd({ c: 'move', units: [e.id], tile: broken.a });
    }
    if (threats.length) {
      const t = threats[0];
      const defenders = army.filter((u) => u.order.kind !== 'attack' && dist(u.tile, t.tile) < 20);
      if (defenders.length) this.cmd({ c: 'move', units: defenders.map((u) => u.id), tile: t.tile, attackMove: true, formation: 'line' });
      return;
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
    if (!enemies.length) { this.campaign = null; this.rally(army); this.huntRebels(army); return; }
    const target = this.pickTargetCity(enemies);
    if (!target) {
      const tile = this.knownEnemyTile(enemies);
      const idle = army.filter((u) => !u.path.length && !u.field && u.order.kind === 'idle');
      if (tile >= 0 && idle.length >= Math.max(4, desired * 0.6)) this.cmd({ c: 'move', units: idle.map((u) => u.id), tile, attackMove: true, formation: 'line' });
      else this.rally(army);
      return;
    }
    const ready = army.filter((u) => u.order.kind !== 'attack');
    const avgSupply = army.length ? army.reduce((s, u) => s + u.supply, 0) / army.length : 100;
    if (!this.campaign || this.campaign.city !== target.id) {
      if (army.length < Math.max(4, desired * 0.7)) { this.rally(army); return; }
      this.campaign = { city: target.id, start: army.length, stage: target.tile };
      this.cmd({ c: 'move', units: ready.map((u) => u.id), tile: target.tile, attackMove: true, formation: 'line' });
      return;
    }
    if (army.length < this.campaign.start * 0.35 || avgSupply < 15) {
      const home = g.capital(civ);
      if (home) this.cmd({ c: 'move', units: army.map((u) => u.id), tile: home.tile, formation: 'column' });
      this.campaign = null; return;
    }
    const town = target.buildingId >= 0 ? g.buildings.get(target.buildingId) : null;
    const near = army.filter((u) => dist(u.tile, target.tile) <= 5);
    if (town && near.length) this.cmd({ c: 'attack', units: near.filter((u) => u.order.kind !== 'attack').map((u) => u.id), target: { kind: 'building', id: town.id } });
    const idle = army.filter((u) => !u.path.length && !u.field && u.order.kind === 'idle' && dist(u.tile, target.tile) > 5);
    if (idle.length) this.cmd({ c: 'move', units: idle.map((u) => u.id), tile: target.tile, attackMove: true });
    const trucks = this.myUnits.filter((u) => u.type === 'supply_truck' && !u.path.length);
    if (trucks.length && army.length) { const cx = army[0].tile; for (const t of trucks) if (dist(t.tile, cx) > 3) this.cmd({ c: 'move', units: [t.id], tile: cx }); }
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
