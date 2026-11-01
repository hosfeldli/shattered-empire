// AI air operations: the same mission orders a player gives, planned like a player would.
// - Production: aircraft from airfields / drone works in a sensible mix (fighters when enemy air is
//   seen, strike aircraft otherwise, a recon drone, a few one-way drones), within what the economy can service.
// - Persistent patrols over the threatened city, the front or the airfields (patrol missions repeat across servicing).
// - Strikes on concentrations that are worth it and not covered by known air defense.
// - Servicing awareness: only ready aircraft get new missions; nothing is re-tasked mid-turnaround.
// Stateless between calls (missions live on the aircraft and persist with them), so save/restore is free.
import { UNITS, BUILDINGS } from './constants.js';
import { dist, disk } from './hex.js';
import { basesOf, compatible } from './airfields.js';
import { canFly } from './airOperations.js';

const hostileTo = (g, civ) => (o) => o !== civ.id && g.hostile(civ.id, o);

// Known air-defense coverage over a tile: enemy AA batteries and AA-capable units this nation can see.
export function aaThreat(g, civ, tile) {
  const hostile = hostileTo(g, civ);
  let t = 0;
  for (const b of g.buildings.values()) {
    if (!hostile(b.owner) || !b.done || BUILDINGS[b.type].defense !== 'air' || !civ.explored?.[b.tile]) continue;
    const r = (BUILDINGS[b.type].range || 3) + (b.upgraded ? 1 : 0);
    if (dist(b.tile, tile) <= r + 1) t += 2;
  }
  for (const u of g.units.values()) {
    if (!hostile(u.owner) || !civ.visible[u.tile]) continue;
    const d = UNITS[u.type]; if (!(d.aa > 1) || d.air) continue;
    if (dist(u.tile, tile) <= (d.range || 2) + 1) t += 1;
  }
  return t;
}

// What the air force should look like for this nation right now.
function wantedFleet(g, civ, ai, bases) {
  const air = bases.filter((b) => !BUILDINGS[b.type].droneOnly).length, drone = bases.length - air;
  const enemyAir = (civ.seenComp?.air || 0) > 0.05 || ai.enemyAir;
  const want = {};
  if (air) {
    const n = Math.min(10, 2 + civ.age + (ai.campaign ? 2 : 0)) * air;
    want.fighter = Math.round(n * (enemyAir ? 0.5 : 0.3));
    want.bomber = Math.round(n * (enemyAir ? 0.2 : 0.35));
    want.helicopter = n - want.fighter - want.bomber;
  }
  if (drone) { want.recon_drone = 1; want.oneway_drone = Math.min(4, 1 + civ.age); if (civ.techs.has('strike_swarms')) want.strike_swarm = 2; }
  return want;
}

function produce(g, civ, ai, bases, craft) {
  if (civ.saving || civ.res.fuel < 60) return;           // cannot keep aircraft flying without fuel
  const have = {}; for (const u of craft) have[u.type] = (have[u.type] || 0) + 1;
  for (const b of g.buildings.values()) if (b.owner === civ.id) for (const q of b.queue) if (UNITS[q.unit]?.air) have[q.unit] = (have[q.unit] || 0) + 1;
  const want = wantedFleet(g, civ, ai, bases);
  const gaps = Object.entries(want).map(([t, n]) => [t, n - (have[t] || 0)]).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
  for (const [type] of gaps) {
    const b = bases.find((x) => x.queue.length < 2 && (BUILDINGS[x.type].trains || []).includes(type) && !g.canTrain(civ, x, type));
    if (b) { ai.cmd({ c: 'train', building: b.id, unit: type }); return; }
  }
}

// where patrols are most useful: an airfield under air threat, a threatened city, then the front
function patrolSpot(g, civ, ai, bases, threats) {
  const air = threats.filter((u) => UNITS[u.type].air);
  if (air.length) {
    const b = bases.slice().sort((x, y) => Math.min(...air.map((u) => dist(u.tile, x.tile))) - Math.min(...air.map((u) => dist(u.tile, y.tile))))[0];
    return { tile: air[0].tile, why: 'intercept', base: b };
  }
  if (threats.length) {
    const c = ai.cities.slice().sort((x, y) => Math.min(...threats.map((u) => dist(u.tile, x.tile))) - Math.min(...threats.map((u) => dist(u.tile, y.tile))))[0];
    return c ? { tile: c.tile, why: 'city' } : null;
  }
  if (ai.campaign) { const k = civ.knownCities?.get?.(ai.campaign.city); if (k) return { tile: k.tile, why: 'front' }; }
  return bases[0] ? { tile: bases[0].tile, why: 'base' } : null;
}

// strike targets: visible enemy stacks and key buildings, scored by value and penalised by known AA
export function strikeTargets(g, civ, ai, enemies) {
  const hostile = hostileTo(g, civ), byTile = new Map();
  for (const u of enemies) { if (UNITS[u.type].air) continue; const a = byTile.get(u.tile) || []; a.push(u); byTile.set(u.tile, a); }
  const out = [];
  for (const [t, us] of byTile) {
    const value = us.reduce((s, u) => s + 1 + UNITS[u.type].age * 0.5 + (UNITS[u.type].cat === 'artillery' ? 1 : 0), 0);
    if (value < 3) continue;
    out.push({ tile: t, target: us.length === 1 ? { kind: 'unit', id: us[0].id } : null, value, aa: aaThreat(g, civ, t) });
  }
  if (ai.campaign) for (const b of g.buildings.values()) {
    if (!hostile(b.owner) || !civ.visible[b.tile] || !b.done) continue;
    const d = BUILDINGS[b.type];
    const v = d.airbase ? 6 : d.defense === 'air' ? 5 : d.attack ? 4 : 0;
    if (v) out.push({ tile: b.tile, target: { kind: 'building', id: b.id }, value: v, aa: d.defense === 'air' ? 1 : aaThreat(g, civ, b.tile) });
  }
  return out.map((x) => ({ ...x, score: x.value - x.aa * 2.5 })).filter((x) => x.score > 1).sort((a, b) => b.score - a.score);
}

export function aiAirStep(ai) {
  const g = ai.g, civ = ai.civ;
  const bases = basesOf(g, civ.id);
  const craft = ai.myUnits.filter((u) => u.air);
  if (bases.length) produce(g, civ, ai, bases, craft);
  if (!craft.length) return;
  const ready = craft.filter((u) => u.air.state === 'ready' && (!u.air.mission || u.air.mission.kind === 'return' || u.air.mission.suspended));
  const tasked = (kind, tile) => craft.filter((u) => u.air.mission && u.air.mission.kind === kind && !u.air.mission.suspended && (tile == null || dist(u.air.mission.tile, tile) <= 2));
  const threats = ai.enemiesNear();
  const enemies = [...g.units.values()].filter((u) => civ.visible[u.tile] && g.hostile(civ.id, u.owner) && !UNITS[u.type].civilian && g.detects(civ.id, u));
  const send = (ids, mission) => { if (ids.length) ai.cmd({ c: 'airMission', units: ids, ...mission, auth: 'mission' }); };
  // patrols: keep one or two fighters / helicopters on station, re-aimed when the threat moves
  const spot = patrolSpot(g, civ, ai, bases, threats);
  if (spot && !(spot.why === 'base' && civ.res.fuel < 80)) {   // a standing patrol over a quiet base is a luxury when fuel is short
    const want = spot.why === 'intercept' ? 3 : spot.why === 'base' ? 1 : 2;
    const on = tasked('patrol');
    const stale = on.filter((u) => dist(u.air.mission.tile, spot.tile) > 4 && u.air.mission.auth !== 'player');
    for (const u of stale) u.air.mission.tile = spot.tile;     // re-aim persistent patrols (takes effect on their next sortie)
    const need = want - on.length;
    if (need > 0) {
      const pref = spot.why === 'intercept' ? ['fighter'] : ['fighter', 'helicopter'];
      const pick = ready.filter((u) => pref.includes(u.type) && canFly(u.type, 'patrol') && aaThreat(g, civ, spot.tile) < 3).slice(0, need);
      send(pick.map((u) => u.id), { kind: 'patrol', tile: spot.tile, radius: spot.why === 'base' ? 2 : 3 });
    }
  }
  // strikes on worthwhile targets not covered by air defense; never pile everything onto one target
  for (const t of strikeTargets(g, civ, ai, enemies).slice(0, 2)) {
    if (tasked('strike', t.tile).length) continue;
    const pool = ready.filter((u) => u.air.state === 'ready' && !u.air.mission?.kind?.match(/patrol|scout/) && canFly(u.type, 'strike') && u.type !== 'fighter');
    // helicopters and one-way drones are vulnerable: keep them out of AA cover altogether
    const ok = pool.filter((u) => (t.aa === 0 || UNITS[u.type].alt === 'high'));
    const order = ['bomber', 'helicopter', 'strike_swarm', 'oneway_drone'];
    const pick = ok.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)).filter((u) => u.type !== 'oneway_drone' || t.value >= 5).slice(0, t.value >= 6 ? 2 : 1);
    for (const u of pick) { const i = ready.indexOf(u); if (i >= 0) ready.splice(i, 1); }
    send(pick.map((u) => u.id), { kind: 'strike', tile: t.tile, target: t.target });
  }
  // recon: watch the front, or the nearest unknown enemy city
  const scouts = ready.filter((u) => UNITS[u.type].role === 'recon');
  if (scouts.length && !tasked('scout').length) {
    const k = ai.campaign ? civ.knownCities?.get?.(ai.campaign.city) : null;
    const tile = k ? k.tile : threats[0]?.tile ?? enemies[0]?.tile;
    if (tile != null) send([scouts[0].id], { kind: 'scout', tile, radius: 3 });
  }
  void compatible; void disk;
}
