// Server-side AI opponents. Personalities shape specialization:
//   builder  - stable, scientific, expands widely
//   merchant - trade, markets, diplomacy
//   warlord  - militarized mining state that seeks conquest
import { N, T, TERRAIN, BUILDINGS, UNITS, TECHS, AGES, RES, isWater } from './constants.js';
import { disk, dist, NB } from './hex.js';

const TECH_ORDER = {
  builder: ['agriculture', 'mining', 'writing', 'masonry', 'trade', 'surveying', 'archery', 'sailing', 'horseback',
    'guilds', 'seismology', 'logistics', 'engineering', 'scholasticism', 'iron_working', 'banking', 'feudalism', 'navigation', 'military_tradition',
    'steam_power', 'industrial_agriculture', 'geoengineering', 'railroads', 'rifling', 'telegraph', 'artillery', 'explosives', 'democracy'],
  warlord: ['archery', 'mining', 'agriculture', 'masonry', 'horseback', 'writing', 'trade', 'surveying', 'sailing',
    'iron_working', 'feudalism', 'engineering', 'logistics', 'military_tradition', 'guilds', 'seismology', 'scholasticism', 'banking', 'navigation',
    'rifling', 'steam_power', 'artillery', 'railroads', 'telegraph', 'industrial_agriculture', 'geoengineering', 'explosives', 'democracy'],
  merchant: ['agriculture', 'trade', 'writing', 'mining', 'sailing', 'masonry', 'surveying', 'archery', 'horseback',
    'banking', 'guilds', 'scholasticism', 'logistics', 'iron_working', 'navigation', 'engineering', 'seismology', 'feudalism', 'military_tradition',
    'steam_power', 'railroads', 'industrial_agriculture', 'democracy', 'rifling', 'telegraph', 'geoengineering', 'artillery', 'explosives'],
};
const POLICY_PREF = {
  builder: ['agrarian', 'scholarship', 'mining_guilds', 'conservation', 'frontier'],
  warlord: ['conscription', 'mining_guilds', 'total_mobilization', 'fortification', 'agrarian'],
  merchant: ['free_trade', 'agrarian', 'scholarship', 'road_corvee', 'conservation'],
};
const GOV_PREF = {
  builder: [['democracy', 2], ['monarchy', 1]],
  warlord: [['junta', 1], ['monarchy', 1]],
  merchant: [['democracy', 2], ['republic', 1]],
};

export class AI {
  constructor(g, civ) {
    this.g = g; this.civ = civ; this.p = civ.personality;
    this.peaceSince = 0; this.campaign = null; this.lastTrade = 0; this.settlerGoal = new Map(); this.scoutGoal = new Map();
  }
  cmd(c) { return this.g.command(this.civ.id, c); }

  think() {
    const g = this.g, civ = this.civ;
    if (!civ.alive || g.over) return;
    this.cities = g.cityOf(civ);
    if (!this.cities.length) return;
    this.myUnits = [...g.units.values()].filter((u) => u.owner === civ.id);
    this.research();
    this.government();
    this.economy();
    this.roads();
    this.expand();
    this.military();
    this.diplomacy();
  }

  // ------------------------------------------------------------- research & government
  research() {
    const civ = this.civ;
    const next = AGES[civ.age + 1];
    if (next && !civ.advancing) {
      const have = [...civ.techs].filter((t) => TECHS[t].age === civ.age).length;
      if (have >= next.techsNeeded && this.g.canAfford(civ, next.cost)) this.cmd({ c: 'advance' });
    }
    if (!civ.researching) {
      const t = TECH_ORDER[this.p].find((k) => !civ.techs.has(k) && TECHS[k].age <= civ.age);
      if (t) this.cmd({ c: 'research', tech: t });
    }
  }

  government() {
    const civ = this.civ;
    for (const [gov] of GOV_PREF[this.p]) {
      const def = this.g.defs.GOVS[gov];
      if (civ.gov === gov) break;
      if (!def.tech || civ.techs.has(def.tech)) { if (civ.govCooldown <= 0) this.cmd({ c: 'gov', id: gov }); break; }
    }
    const slots = this.g.defs.GOVS[civ.gov].slots;
    for (const p of POLICY_PREF[this.p]) {
      if (civ.policies.size >= slots) break;
      if (!civ.policies.has(p)) this.cmd({ c: 'policy', id: p, on: true });
    }
    const avgStab = this.cities.reduce((s, c) => s + c.stability, 0) / this.cities.length;
    if (avgStab < 35 && civ.tax > 0) civ.tax--;
    else if (avgStab > 65 && civ.res.gold < 150 && civ.tax < 2) civ.tax++;
    const atWar = this.enemies().length > 0;
    civ.focus = atWar && this.p === 'warlord' ? 'military' : this.p === 'merchant' ? 'commerce' : this.p === 'builder' && civ.age >= 1 ? 'science' : 'balanced';
  }

  // ------------------------------------------------------------- economy
  count(city, type) { let n = 0; for (const b of this.g.buildings.values()) if (b.cityId === city.id && b.type === type && b.owner === this.civ.id) n++; return n; }
  civCount(type) { let n = 0; for (const b of this.g.buildings.values()) if (b.type === type && b.owner === this.civ.id) n++; return n; }

  pickTile(city, type) {
    const g = this.g, w = g.world;
    let best = -1, bs = -Infinity;
    for (const t of disk(city.tile, city.radius || 3)) {
      if (w.owner[t] !== this.civ.id || !g.canPlace(this.civ, type, t, true)) continue;
      let s = -dist(city.tile, t);
      if (type === 'farm') { s = TERRAIN[w.terr[t]].fert * 4 + (w.river[t] ? 1 : 0) - dist(city.tile, t) * 0.3; if (w.res[t]) s -= 3; }
      else if (type === 'mine') s = (w.res[t] === RES.IRON ? 3 : w.res[t] === RES.COAL ? (this.civ.age >= 1 ? 3 : 1) : 2) - dist(city.tile, t) * 0.2;
      else if (BUILDINGS[type].place === 'flat' && (w.res[t] || w.terr[t] === T.FOREST || TERRAIN[w.terr[t]].fert > 0.8)) s -= 2;
      if (w.stab[t] < 0.3) s -= 3;
      if (w.ash[t] > 0 || w.lava[t] > 0) s -= 5;
      if (s > bs) { bs = s; best = t; }
    }
    return best;
  }

  tryBuild(city, type) {
    const civ = this.civ, g = this.g;
    if (!g.canAfford(civ, g.buildingCost(civ, type))) return false;
    const t = this.pickTile(city, type);
    if (t < 0) return false;
    return !this.cmd({ c: 'build', type, tile: t });
  }

  economy() {
    const civ = this.civ, g = this.g;
    const building = [...g.buildings.values()].some((b) => b.owner === civ.id && !b.done && b.type !== 'wonder' && g.time - (b.placedAt || 0) < 999 && b.progress < 0.5);
    let actions = 0;
    const reserve = this.enemies().length ? 0.6 : 1;
    for (const c of this.cities) {
      if (actions >= 2) break;
      const has = (t) => this.count(c, t);
      const needs = [];
      const food = civ.rates.food || 0;
      if (food < 0.8 || civ.res.food < 80) needs.push('farm');
      if (c.pop >= c.housing - 1.5) needs.push('house');
      if (has('lumber') < 1 + (c.capital ? 1 : 0)) needs.push('lumber');
      if (has('farm') < 2) needs.push('farm');
      if (c.unemployed > 2) needs.push(...(food < 1.5 ? ['farm'] : []), 'lumber', 'quarry', 'market', 'library', 'mine', 'workshop', 'university', 'factory', ...(civ.res.wood > 200 ? ['lumber'] : []));
      if (has('quarry') < 1) needs.push('quarry');
      if (civ.techs.has('mining')) needs.push('mine');
      if (c.capital && this.civCount('barracks') < 1 + (this.p === 'warlord' && civ.age >= 1 ? 1 : 0)) needs.push('barracks');
      if (civ.techs.has('trade') && has('market') < 1) needs.push('market');
      if (civ.techs.has('writing') && has('library') < 1) needs.push('library');
      if (civ.techs.has('scholasticism') && has('university') < 1 && c.pop > 10) needs.push('university');
      if (civ.techs.has('guilds') && this.civCount('workshop') < Math.min(3, this.cities.length)) needs.push('workshop');
      if (civ.techs.has('feudalism') && this.civCount('stable') < 1 && g.civHasResource(civ, RES.HORSES)) needs.push('stable');
      if (civ.techs.has('engineering') && this.civCount('siege') < 1) needs.push('siege');
      if (civ.techs.has('seismology') && has('seismic') < 1 && g.world.stab[c.tile] < 0.55) needs.push('seismic');
      if (civ.techs.has('steam_power') && this.civCount('factory') < Math.min(3, this.cities.length)) needs.push('factory');
      if (civ.techs.has('sailing') && has('port') < 1 && c.capital) needs.push('port');
      if (civ.techs.has('masonry') && c.capital && this.civCount('tower') < 1) needs.push('tower');
      if (civ.techs.has('explosives') && this.civCount('wonder') < 1 && civ.res.gold > 1000) needs.push('wonder');
      if (has('farm') < 4 && c.pop > 12 && food < 2) needs.push('farm');
      if (civ.rates.wood < 1.2 && has('lumber') < 3) needs.push('lumber');
      if (has('house') < 3) needs.push('house');
      for (const n of needs) {
        if (building && n !== 'farm' && n !== 'house' && reserve < 1) continue;
        if (this.tryBuild(c, n)) { actions++; break; }
      }
    }
    // supply depots toward the front (Kingdom age)
    if (civ.techs.has('logistics') && this.campaign && this.civCount('depot') < 2) {
      const front = this.campaign.stage;
      if (front >= 0) {
        const t = disk(front, 3).find((x) => g.canPlace(civ, 'depot', x));
        if (t !== undefined) this.cmd({ c: 'build', type: 'depot', tile: t });
      }
    }
  }

  roads() {
    const g = this.g, civ = this.civ;
    const cap = g.capital(civ); if (!cap) return;
    if (g.roadJobs.some((j) => j.owner === civ.id)) return;
    for (const c of this.cities) {
      if (c.capital || c.tradeConnected) continue;
      if (civ.res.wood < 60) return;
      const r = this.cmd({ c: 'road', from: cap.tile, to: c.tile });
      if (!r) return;
    }
    if (civ.techs.has('railroads') && civ.res.iron > 150 && civ.res.coal > 80) {
      const c = this.cities.find((x) => !x.capital);
      if (c) this.cmd({ c: 'road', from: cap.tile, to: c.tile, rail: true });
    }
  }

  // ------------------------------------------------------------- expansion
  siteScore(t) {
    const g = this.g, w = g.world;
    if (g.canFound(this.civ, t)) return -1;
    const tt = w.terr[t];
    if (tt !== T.GRASS && tt !== T.PLAINS && tt !== T.ASH && tt !== T.HILLS) return -1;
    if (w.stab[t] < 0.3 || w.lava[t] > 0) return -1;
    if (w.volcanoes.some((v) => dist(v.tile, t) < 7)) return -1;
    let s = 0;
    for (const n of disk(t, 3)) {
      if (!this.civ.explored[n]) continue;
      if (w.owner[n] >= 0 && w.owner[n] !== this.civ.id) s -= 1;
      s += TERRAIN[w.terr[n]].fert + (w.terr[n] === T.FOREST ? 0.5 : 0) + (w.res[n] ? 1 : 0) + (w.river[n] ? 0.3 : 0);
    }
    return s;
  }

  expand() {
    const g = this.g, civ = this.civ;
    const want = { builder: 5, merchant: 4, warlord: 3 }[this.p] + civ.age;
    const settlers = this.myUnits.filter((u) => u.type === 'settler');
    const cap = g.capital(civ);
    const queued = [...g.buildings.values()].some((b) => b.owner === civ.id && b.queue.some((q) => q.unit === 'settler'));
    if (this.cities.length + settlers.length < want && !queued && settlers.length === 0 && civ.res.food > 100 && cap && cap.pop > 6 && this.enemiesNear().length === 0) {
      this.cmd({ c: 'train', building: cap.buildingId, unit: 'settler' });
    }
    for (const s of settlers) {
      let goal = this.settlerGoal.get(s.id);
      if (goal !== undefined && s.tile === goal) {
        if (this.cmd({ c: 'found', unit: s.id })) this.settlerGoal.delete(s.id); else { this.settlerGoal.delete(s.id); continue; }
        continue;
      }
      if (goal !== undefined && s.path.length) continue;
      // choose a site
      let best = -1, bs = 3;
      for (const c of this.cities) for (const t of disk(c.tile, 20)) {
        if (dist(c.tile, t) < 6 || !civ.explored[t]) continue;
        const sc = this.siteScore(t) - dist(s.tile, t) * 0.15; if (sc > bs) { bs = sc; best = t; }
      }
      if (best >= 0) { this.settlerGoal.set(s.id, best); this.cmd({ c: 'move', units: [s.id], tile: best }); }
      else if (!s.path.length) { // explore a bit
        const t = this.randomUnexplored(s.tile, 5); if (t >= 0) this.cmd({ c: 'move', units: [s.id], tile: t });
      }
    }
  }

  randomUnexplored(from, rad) {
    const w = this.g.world, rng = this.g.rng;
    for (let k = 0; k < 60; k++) {
      const t = rng.int(N);
      if (this.civ.explored[t] || isWater(w.terr[t])) continue;
      if (rad && dist(from, t) > rad * 3) continue;
      return t;
    }
    return -1;
  }

  // ------------------------------------------------------------- military
  strength(units) { return units.reduce((s, u) => s + (UNITS[u.type].civilian ? 0 : (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp)), 0); }
  enemies() { return this.g.civs.filter((o) => o.alive && this.g.hostile(this.civ.id, o.id)); }
  enemiesNear() {
    const g = this.g, w = g.world;
    return [...g.units.values()].filter((u) => g.hostile(this.civ.id, u.owner) && !UNITS[u.type].civilian && (w.owner[u.tile] === this.civ.id || this.cities.some((c) => dist(c.tile, u.tile) <= 6)));
  }

  trainChoice(b) {
    const civ = this.civ, g = this.g;
    const opts = (this.g.defs.BUILDINGS[b.type].trains || []).filter((u) => !UNITS[u].civilian);
    const army = this.myUnits.filter((u) => !UNITS[u.type].civilian);
    const cnt = (t) => army.filter((u) => u.type === t).length;
    const pick = [];
    if (civ.age >= 2 && opts.includes('rifleman')) pick.push('rifleman', 'rifleman');
    if (civ.age >= 1 && opts.includes('swordsman')) pick.push('swordsman');
    if (opts.includes('archer') && cnt('archer') < army.length * 0.35 + 1) pick.push('archer');
    if (opts.includes('spearman')) pick.push('spearman');
    if (opts.includes('knight')) pick.push('knight');
    if (opts.includes('catapult') && cnt('catapult') < army.length / 5) pick.unshift('catapult');
    if (opts.includes('artillery') && cnt('artillery') < army.length / 4) pick.unshift('artillery');
    for (const u of pick) if (!g.canTrain(civ, b, u)) return u;
    return null;
  }

  military() {
    const g = this.g, civ = this.civ;
    const army = this.myUnits.filter((u) => !UNITS[u.type].civilian && u.type !== 'scout');
    const enemies = this.enemies();
    const threats = this.enemiesNear();
    let desired = 3 + 2 * civ.age + Math.min(8, this.cities.length) + Math.floor(civ.popTotal / 10);
    if (this.p === 'warlord') desired = Math.round(desired * 1.6);
    if (enemies.length) desired += 4;
    desired += threats.length;
    // training
    if (army.length < desired && civ.res.food > 50) {
      for (const b of g.buildings.values()) {
        if (b.owner !== civ.id || !b.done || b.queue.length >= 2) continue;
        if (!['barracks', 'stable', 'siege', 'factory'].includes(b.type)) continue;
        const u = this.trainChoice(b);
        if (u) this.cmd({ c: 'train', building: b.id, unit: u });
      }
    }
    // wagons for campaigns
    const wagonQueued = [...g.buildings.values()].some((b) => b.owner === civ.id && b.queue.some((q) => q.unit === 'supply_wagon'));
    if (civ.techs.has('logistics') && this.campaign && !wagonQueued && !this.myUnits.some((u) => u.type === 'supply_wagon')) {
      const cap = g.capital(civ); if (cap) this.cmd({ c: 'train', building: cap.buildingId, unit: 'supply_wagon' });
    }
    // scouts
    const scouts = this.myUnits.filter((u) => u.type === 'scout');
    const scoutQueued = [...g.buildings.values()].some((b) => b.owner === civ.id && b.queue.some((q) => q.unit === 'scout'));
    if (!scouts.length && !scoutQueued && g.time < 900 && civ.res.food > 60) { const cap = g.capital(civ); if (cap) this.cmd({ c: 'train', building: cap.buildingId, unit: 'scout' }); }
    for (const s of scouts) if (!s.path.length) { const t = this.randomUnexplored(s.tile, 0); if (t >= 0) this.cmd({ c: 'move', units: [s.id], tile: t }); }
    // defense
    if (threats.length) {
      const t = threats[0];
      const defenders = army.filter((u) => u.order.kind !== 'attack' && dist(u.tile, t.tile) < 20);
      if (defenders.length) this.cmd({ c: 'move', units: defenders.map((u) => u.id), tile: t.tile, attackMove: true });
      return;
    }
    // war declarations
    for (const o of g.civs) {
      if (o === civ || !o.alive) continue;
      const r = g.diplomacy.rel(civ.id, o.id);
      if (r.state !== 'peace') continue;
      const patience = { warlord: 240, builder: 720, merchant: 900 }[this.p];
      const theirs = this.strength([...g.units.values()].filter((u) => u.owner === o.id));
      const mine = this.strength(army);
      if (g.time - r.since > patience && mine > theirs * (this.p === 'warlord' ? 1.3 : 1.8) && army.length >= desired * 0.8 && r.attitude < 30) {
        this.cmd({ c: 'diplo', to: o.id, action: 'war' });
        break;
      }
    }
    // campaigns
    if (!enemies.length) { this.campaign = null; this.rally(army); return; }
    const target = this.pickTargetCity(enemies);
    if (!target) { this.rally(army); return; }
    const ready = army.filter((u) => u.order.kind !== 'attack');
    const avgSupply = army.length ? army.reduce((s, u) => s + u.supply, 0) / army.length : 100;
    if (!this.campaign || this.campaign.city !== target.id) {
      if (army.length < Math.max(4, desired * 0.7)) { this.rally(army); return; }
      this.campaign = { city: target.id, start: army.length, stage: target.tile };
      this.cmd({ c: 'move', units: ready.map((u) => u.id), tile: target.tile, attackMove: true });
      return;
    }
    if (army.length < this.campaign.start * 0.35 || avgSupply < 15) {
      // retreat and regroup
      const home = g.capital(civ);
      if (home) this.cmd({ c: 'move', units: army.map((u) => u.id), tile: home.tile });
      this.campaign = null; return;
    }
    const town = g.buildings.get(target.buildingId);
    const near = army.filter((u) => dist(u.tile, target.tile) <= 4);
    if (town && near.length) this.cmd({ c: 'attack', units: near.filter((u) => u.order.kind !== 'attack').map((u) => u.id), target: { kind: 'building', id: town.id } });
    const idle = army.filter((u) => !u.path.length && u.order.kind === 'idle' && dist(u.tile, target.tile) > 4);
    if (idle.length) this.cmd({ c: 'move', units: idle.map((u) => u.id), tile: target.tile, attackMove: true });
    const wagons = this.myUnits.filter((u) => u.type === 'supply_wagon' && !u.path.length);
    if (wagons.length && army.length) {
      const cx = army[0].tile;
      for (const wg of wagons) if (dist(wg.tile, cx) > 3) this.cmd({ c: 'move', units: [wg.id], tile: cx });
    }
  }

  rally(army) {
    const g = this.g, cap = g.capital(this.civ);
    if (!cap) return;
    // stand guard toward the nearest known foreign city
    let front = cap.tile, bd = Infinity;
    for (const c of g.cities.values()) if (c.owner !== this.civ.id && this.civ.explored[c.tile]) { const d = dist(cap.tile, c.tile); if (d < bd) { bd = d; front = c.tile; } }
    const own = this.cities.slice().sort((a, b) => dist(a.tile, front) - dist(b.tile, front))[0] || cap;
    const loiter = army.filter((u) => !u.path.length && u.order.kind === 'idle' && dist(u.tile, own.tile) > 3);
    if (loiter.length) this.cmd({ c: 'move', units: loiter.map((u) => u.id), tile: own.tile });
  }

  pickTargetCity(enemies) {
    const g = this.g, cap = g.capital(this.civ);
    let best = null, bd = Infinity;
    for (const c of g.cities.values()) {
      if (!enemies.some((e) => e.id === c.owner) || !this.civ.explored[c.tile]) continue;
      const d = dist(cap.tile, c.tile) + (c.capital ? 6 : 0);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) for (const c of g.cities.values()) if (enemies.some((e) => e.id === c.owner)) { const d = dist(cap.tile, c.tile); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  // ------------------------------------------------------------- diplomacy
  diplomacy() {
    const g = this.g, civ = this.civ;
    const mine = this.strength(this.myUnits);
    for (const o of g.civs) {
      if (o === civ || !o.alive) continue;
      const r = g.diplomacy.rel(civ.id, o.id);
      const theirs = this.strength([...g.units.values()].filter((u) => u.owner === o.id));
      if (r.state === 'war' && (mine < theirs * 0.7 || civ.weariness > 35) && g.time - r.since > 120 && g.time - this.lastTrade > 60) {
        this.lastTrade = g.time; g.diplomacy.act(civ, o.id, 'peace');
      } else if (r.state === 'peace' && !r.trade && this.p !== 'warlord' && g.time - this.lastTrade > 150 && civ.techs.has('trade')) {
        this.lastTrade = g.time; g.diplomacy.act(civ, o.id, 'trade');
      }
    }
  }

  evaluate(from, action) {
    const g = this.g, civ = this.civ, r = g.diplomacy.rel(civ.id, from.id);
    const mine = this.strength([...g.units.values()].filter((u) => u.owner === civ.id));
    const theirs = this.strength([...g.units.values()].filter((u) => u.owner === from.id));
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
void NB;
