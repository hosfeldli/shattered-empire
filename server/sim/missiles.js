// Strategic missiles: the endgame weapon, deliberately slow and expensive to get and possible to stop.
// - Strategic Missiles tech -> Missile Silo -> a long project per missile (real resources, paid up front);
//   each silo stores a small inventory.
// - Launch at any tile within range: a ballistic flight of tens of seconds that everyone sees coming.
// - Interception: in the terminal phase every upgraded AA battery and air-defense vehicle of the target's
//   side (with Missile Defense) within reach gets one deterministic roll from the game RNG.
// - Effects: a massive blast (units, buildings, roads), a stricken city loses people and stability,
//   the ground becomes devastated no man's land with fallout that stops farming for a while, and
//   every other nation thinks less of the launcher.
// - AI evaluation: only when the expected damage is worth the diplomatic cost and interception odds.
import { UNITS, BUILDINGS, N, isWater } from './constants.js';
import { dist, disk } from './hex.js';
import { UNIT_WEAPON, canInterceptMissiles } from './weapons.js';
import { addIntensity, addCrater, addSmoke } from './battlefield.js';
import { emit } from './combat.js';

export const MISSILE = {
  cost: { steel: 300, fuel: 200, munitions: 250, electronics: 150, credits: 800 },
  build: 180,            // seconds per missile
  store: 2,              // per silo
  range: 160,            // hexes: intercontinental
  flight: (d) => 14 + d * 0.2,
  terminal: 4,           // seconds before impact when interceptors engage
  reach: 4,              // interceptor reach around the target, hexes
  pBattery: 0.38, pVehicle: 0.25, maxRolls: 4,
  blast: [520, 260, 110], bBlast: [900, 450, 160],
  fallout: 600, falloutRadius: 2,
};

export function missilesInit(g) { g.missiles = g.missiles || []; g.fallout = g.fallout || new Map(); g.missileSeq = g.missileSeq || 1; }

const silosOf = (g, civId) => [...g.buildings.values()].filter((b) => b.owner === civId && b.done && BUILDINGS[b.type].silo);
export const inventory = (g, civId) => silosOf(g, civId).reduce((s, b) => s + (b.missiles || 0), 0);

// start the next missile at a silo (paid up front from national stock)
export function startMissile(g, civ, siloId) {
  const b = g.buildings.get(siloId);
  if (!b || b.owner !== civ.id || !BUILDINGS[b.type]?.silo) return { error: 'choose one of your missile silos' };
  if (!b.done) return { error: 'the silo is not finished' };
  if (!civ.techs.has('strategic_missiles')) return { error: 'requires Strategic Missiles' };
  if (b.project) return { error: 'a missile is already being built here' };
  if ((b.missiles || 0) >= MISSILE.store) return { error: `the silo is full (${MISSILE.store} missiles)` };
  if (!g.canAfford(civ, MISSILE.cost, b.tile)) return { error: 'not enough resources for a missile' };
  g.pay(civ, MISSILE.cost, b.tile, 'army');
  b.project = { left: MISSILE.build, total: MISSILE.build };
  return { reply: { t: 'ack', missile: { silo: b.id, eta: MISSILE.build } } };
}

// launch from the nearest stocked silo in range
export function launchMissile(g, civ, tile, auth = 'player') {
  if (!(tile >= 0 && tile < N)) return { error: 'bad target' };
  const silos = silosOf(g, civ.id).filter((b) => (b.missiles || 0) > 0 && dist(b.tile, tile) <= MISSILE.range).sort((a, b) => dist(a.tile, tile) - dist(b.tile, tile));
  if (!silos.length) return { error: inventory(g, civ.id) ? 'target beyond missile range' : 'no missiles ready' };
  const s = silos[0]; s.missiles--;
  const d = dist(s.tile, tile), fl = MISSILE.flight(d);
  const m = { id: g.missileSeq++, owner: civ.id, from: s.tile, to: tile, at: g.time, arrive: g.time + fl, rolled: false, auth };
  g.missiles.push(m);
  emit(g, { k: 'mlaunch', s: s.id, a: s.tile, b: tile, f: +fl.toFixed(1), m: m.id, o: civ.id });
  // everyone with eyes on either end knows; the target's owner always does
  const victim = g.world.owner[tile];
  for (const c of g.civs) if (c.alive && !c.isRebel && c.id !== civ.id && (c.visible[s.tile] || c.visible[tile] || c.id === victim)) g.notify(c.id, `Strategic missile launch detected${c.id === victim ? ': incoming toward your territory' : ''}! Impact in ${Math.round(fl)} s.`, { kind: 'war', tile, level: 'critical' });
  g.notify(civ.id, `Missile launched: impact in ${Math.round(fl)} s.`, { kind: 'war', tile });
  // diplomatic cost, paid at launch
  for (const o of g.civs) if (o !== civ && o.alive && !o.isRebel) { const r = g.diplomacy.rel(civ.id, o.id); r.attitude = (r.attitude ?? 0) - (o.id === victim ? 60 : 25); }
  civ.weariness = (civ.weariness || 0) + 8;
  g.stats.missiles = (g.stats.missiles || 0) + 1;
  return { reply: { t: 'ack', launch: { id: m.id, eta: +fl.toFixed(1), silo: s.id } } };
}

// interceptors that can engage a missile coming down on `tile`
export function interceptors(g, m) {
  const out = [];
  for (const b of g.buildings.values()) {
    if (b.owner === m.owner || !g.hostile(b.owner, m.owner) || !b.done || !b.upgraded || !g.civs[b.owner].techs.has('missile_defense')) continue;
    if (BUILDINGS[b.type].defense !== 'air' || b.noAmmo) continue;
    if (dist(b.tile, m.to) <= MISSILE.reach) out.push({ kind: 'building', id: b.id, tile: b.tile, p: MISSILE.pBattery });
  }
  for (const u of g.units.values()) {
    if (u.owner === m.owner || !g.hostile(u.owner, m.owner) || !g.civs[u.owner].techs.has('missile_defense')) continue;
    if (!canInterceptMissiles(UNIT_WEAPON[u.type])) continue;
    if (dist(u.tile, m.to) <= MISSILE.reach) out.push({ kind: 'unit', id: u.id, tile: u.tile, p: MISSILE.pVehicle });
  }
  out.sort((a, b) => b.p - a.p || dist(a.tile, m.to) - dist(b.tile, m.to) || a.id - b.id);
  return out.slice(0, MISSILE.maxRolls);
}
// probability that at least one interceptor stops it (for the AI and the UI)
export const interceptOdds = (list) => 1 - list.reduce((p, x) => p * (1 - x.p), 1);

export function missilesStep(g, dt) {
  if (!g.missiles?.length && !g.fallout?.size) return;
  for (const m of [...g.missiles]) {
    // silo projects tick in buildingsStep; here: flight, interception, impact
    if (!m.rolled && g.time >= m.arrive - MISSILE.terminal) {
      m.rolled = true; m.rolls = [];
      for (const x of interceptors(g, m)) {
        const r = g.rng();                         // deterministic: the seeded game RNG, in a fixed order
        m.rolls.push([x.kind === 'building' ? 1 : 0, x.id, +x.p.toFixed(2), +r.toFixed(3)]);
        emit(g, { k: 'mintercept', m: m.id, a: x.tile, b: m.to, s: x.id, sb: x.kind === 'building' ? 1 : 0, o: r < x.p ? 'hit' : 'miss' });
        if (r < x.p) { m.intercepted = x; break; }
      }
      if (m.intercepted) {
        g.missiles.splice(g.missiles.indexOf(m), 1);
        const victim = g.world.owner[m.to];
        if (victim >= 0) g.notify(victim, 'Incoming missile intercepted!', { kind: 'war', tile: m.to, level: 'major' });
        g.notify(m.owner, 'Our missile was intercepted.', { kind: 'war', tile: m.to });
        g.stats.intercepted = (g.stats.intercepted || 0) + 1;
        continue;
      }
    }
    if (g.time >= m.arrive) { g.missiles.splice(g.missiles.indexOf(m), 1); detonateMissile(g, m); }
  }
  for (const [t, until] of g.fallout) if (g.time >= until) { g.fallout.delete(t); g.world.dirty.add(t); }
  void dt;
}

export function detonateMissile(g, m) {
  const t = m.to;
  emit(g, { k: 'mimpact', m: m.id, b: t, o: m.owner });
  for (let r = 0; r <= 2; r++) for (const x of disk(t, r)) {
    if (dist(x, t) !== r) continue;
    for (const id of [...(g.tileUnits.get(x) || [])]) { const u = g.units.get(id); if (u) g.damageUnit(u, MISSILE.blast[r] * (UNITS[u.type].air && !u.grounded ? 0.5 : 1), m.owner, 'combat'); }
    const b = g.buildingAtTile(x);
    if (b) {
      if (b.type === 'town') {
        const c = g.cities.get(b.cityId) || [...g.cities.values()].find((cc) => cc.buildingId === b.id);
        if (c) { c.pop *= r === 0 ? 0.55 : 0.8; c.stability = Math.max(0, c.stability - (r === 0 ? 35 : 15)); c.disaster = (c.disaster || 0) + 25; }
      }
      g.damageBuilding(b, MISSILE.bBlast[r], m.owner, 'combat');
    }
    addIntensity(g, x, r === 0 ? 100 : r === 1 ? 70 : 40);
    if (!isWater(g.world.terr[x])) { if (r <= 1) addCrater(g, x, 3 - r, 'strategic'); addSmoke(g, x, 1, 60 - r * 15); g.roads.damageTile(x, 60 - r * 20, null, 1); }
    if (r <= MISSILE.falloutRadius && !isWater(g.world.terr[x])) { g.fallout.set(x, g.time + MISSILE.fallout * (r === 0 ? 1 : 0.7)); g.world.dirty.add(x); }
  }
  const victim = g.world.owner[t];
  if (victim >= 0) g.notify(victim, 'A strategic missile has struck our territory!', { kind: 'loss', tile: t, level: 'critical' });
  g.stats.detonations = (g.stats.detonations || 0) + 1;
}

// fallout: no farming, and troops standing in it suffer
export const falloutAt = (g, t) => (g.fallout?.get(t) || 0) > g.time;

// silo projects and fallout sickness (once a second)
export function siloStep(g, dt) {
  for (const [t, until] of g.fallout || []) if (until > g.time) for (const id of g.tileUnits.get(t) || []) { const u = g.units.get(id); if (u && !UNITS[u.type].air) g.damageUnit(u, u.maxHp * 0.01 * dt, null, 'attrition'); }
  for (const b of g.buildings.values()) {
    if (!b.project || !BUILDINGS[b.type]?.silo) continue;
    if (b.state === 'damaged') continue;       // a damaged silo halts work
    b.project.left -= dt;
    if (b.project.left <= 0) { b.project = null; b.missiles = (b.missiles || 0) + 1; g.notify(b.owner, 'A strategic missile is ready.', { kind: 'build', tile: b.tile }); }
  }
}

// AI: launch only when it is worth it. Value of what would be hit vs. odds of interception and the
// diplomatic cost; never against a nation it is not at war with; at most one in flight.
export function aiMissiles(ai) {
  const g = ai.g, civ = ai.civ;
  if (!civ.techs.has('strategic_missiles')) return;
  const silos = silosOf(g, civ.id);
  // an empire at war (or facing rivals) builds one silo near its capital once it can afford it
  const atWar = g.civs.some((o) => o && o.id !== civ.id && o.alive && g.hostile(civ.id, o.id));
  if (!silos.length && atWar && (ai.siloAt || 0) <= g.time && Object.entries(BUILDINGS.missile_silo.cost).every(([k, v]) => (civ.res[k] || 0) > v * 1.3)) {
    ai.siloAt = g.time + 180;
    const home = g.capital(civ);
    const site = home && disk(home.tile, 4).filter((t) => g.canPlace(civ, 'missile_silo', t, true)).sort((a, b) => dist(b, home.tile) - dist(a, home.tile))[0];
    if (site != null) ai.cmd({ c: 'build', type: 'missile_silo', tile: site });
  }
  // keep one project going while there is room and money to spare
  for (const b of silos) if (!b.project && (b.missiles || 0) < MISSILE.store && Object.entries(MISSILE.cost).every(([k, v]) => (civ.res[k] || 0) > v * 2.5)) { startMissile(g, civ, b.id); break; }
  if (!inventory(g, civ.id) || g.missiles.some((m) => m.owner === civ.id)) return;
  if ((ai.missileAt || 0) > g.time) return;
  ai.missileAt = g.time + 120;
  let best = null;
  const consider = (tile, value) => {
    const fake = { owner: civ.id, to: tile };
    const p = interceptOdds(interceptors(g, fake));
    const ev = value * (1 - p);
    if (!best || ev > best.ev) best = { tile, ev, value, p };
  };
  // Battlefield targets: massed armies, fortified fronts and airfields. A human player's cities
  // (and anything close enough to one for the blast to reach it) are targets only on Brutal.
  const brutal = civ.difficulty === 'brutal';
  const humanCities = g.cities ? [...g.cities.values()].filter((c) => g.civs[c.owner]?.human).map((c) => c.tile) : [];
  const spares = (t) => !brutal && humanCities.some((c) => dist(c, t) <= 2);
  const stacks = new Map();
  for (const u of g.units.values()) if (g.hostile(civ.id, u.owner) && civ.visible[u.tile] && !UNITS[u.type].civilian) for (const x of disk(u.tile, 1)) stacks.set(x, (stacks.get(x) || 0) + 1 + UNITS[u.type].age * 0.4);
  for (const [t, v] of stacks) if (v >= 10 && !spares(t)) consider(t, v * 3);
  // a dug-in front: enemy trench segments and defences clustered together
  const works = new Map();
  for (const f of g.fieldworks.values()) if (g.hostile(civ.id, f.owner) && civ.explored[f.tile] && f.progress >= 1) for (const x of disk(f.tile, 1)) works.set(x, (works.get(x) || 0) + 1);
  for (const b of g.buildings.values()) if (g.hostile(civ.id, b.owner) && civ.explored[b.tile] && BUILDINGS[b.type]?.defense) for (const x of disk(b.tile, 1)) works.set(x, (works.get(x) || 0) + 2);
  for (const [t, v] of works) if (v >= 6 && !spares(t)) consider(t, v * 4);
  for (const b of g.buildings.values()) if (b.type === 'airfield' && b.done && g.hostile(civ.id, b.owner) && civ.explored[b.tile] && !spares(b.tile)) consider(b.tile, 35);
  for (const [, k] of civ.knownCities || []) if (g.hostile(civ.id, k.owner) && (brutal || !g.civs[k.owner]?.human)) consider(k.tile, 40);
  if (!best) return;
  // desperation lowers the bar: a nation losing its cities uses what it has
  const losing = g.cityOf(civ).length <= 2;
  if (best.ev >= (losing ? 20 : 45) && best.p < 0.7) launchMissile(g, civ, best.tile, 'mission');
}

export function missilesSnapshot(g, civ, vis) {
  const out = [];
  for (const m of g.missiles || []) if (m.owner === civ.id || vis[m.from] || vis[m.to] || g.world.owner[m.to] === civ.id) out.push([m.id, m.from, m.to, +(m.at).toFixed(1), +(m.arrive).toFixed(1), m.owner]);
  const fo = []; for (const [t] of g.fallout || []) if (vis[t] || civ.explored?.[t]) fo.push(t);
  return { m: out, fo };
}
