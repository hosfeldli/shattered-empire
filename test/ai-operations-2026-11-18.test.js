// AI operations (2026-11-18, docs/gameplay-overhaul/AI_OPERATIONS.md): captures that stick, attacks by several task
// forces on different corridors (mustered together, reinforced along their own axis, varied between operations), and
// late-game strategic missiles that break a stalemate through the player commands, never with own troops in the blast.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS, MISSILE_PROJECT } = await import('../server/sim/actionDefinitions.js');
const { addFacility, openSlots } = await import('../server/sim/actionBases.js');
const { distance } = await import('../server/sim/actionNavigation.js');
const { TICK_HZ } = await import('../server/sim/constants.js');
const ops = await import('../server/sim/actionAIOps.js');

const create = (slots, seed = 41) => new ActionGame({ id: 'aiops-' + seed, seed, style: 'pangaea', slots });
const bearing = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const gap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const at = (g, seconds) => { g.tickN = Math.round(seconds * TICK_HZ); g.time = g.tickN / TICK_HZ; };
function army(g, civ, point, types, spread = 1.2) {
  const out = [];
  types.forEach((type, i) => { const u = g.spawn(civ, type, point, spread + (i % 5) * .35); if (u) out.push(u); });
  return out;
}
function know(g, civ, site) {
  // scouted: the site is in the civ's intel and the map explored (as after a long war)
  civ.siteIntel.set(site.id, g.siteWire(site, civ, true));
  civ.explored.fill(1);
}

test('capture sticks: squads hold the zone against enemies lurking outside it until it flips, then a picket stays', () => {
  const g = create([{ human: false, difficulty: 'normal' }, { human: true }]);
  const civ = g.civs[0], foe = g.civs[1], p = civ.aiPlan;
  p.next = Infinity;   // the test drives the capture itself
  const site = g.sites.filter((s) => s.slots && s.owner < 0).sort((a, b) => distance(a, g.sites[0]) - distance(b, g.sites[0]))[0];
  const squads = army(g, civ, g.lerpPoint(site, g.sites[0], 7 / distance(site, g.sites[0])), ['rifle_squad', 'rifle_squad', 'anti_armor', 'rifle_squad', 'rifle_squad']);
  // three enemy squads dug in 4.6 beyond the zone: in attack-move chase range of squads walking in. The old capture
  // (an exact attack-move onto the centre, re-issued when the zone emptied) took 71 s and three entries here.
  const lurkers = army(g, foe, g.lerpPoint(site, g.sites[0], -4.6 / distance(site, g.sites[0])), ['rifle_squad', 'rifle_squad', 'rifle_squad'], .3);
  g.command(foe.id, { c: 'hold', units: lurkers.map((u) => u.id) });
  let entries = 0, wasIn = false, captured = null;
  for (let i = 1; i <= 120 * TICK_HZ && captured == null; i++) {
    g.tick(); g.outbox.length = 0;
    const alive = squads.filter((u) => g.units.has(u.id));
    if (i % 30 === 0) ops.secureSite(g, civ, p, alive, site, lurkers.filter((u) => g.units.has(u.id)));
    const inside = alive.some((u) => distance(u, site) <= site.radius);
    if (inside && !wasIn) entries++;
    wasIn = inside;
    if (site.owner === civ.id) captured = g.time;
  }
  assert.equal(site.owner, civ.id, 'the site was captured');
  assert.equal(entries, 1, 'one entry: the squads held the zone until it flipped');
  assert.ok(captured <= 45, `captured after ${captured} s (20 s of presence plus the walk in)`);
  ops.leavePicket(g, civ, p, squads.filter((u) => g.units.has(u.id)), site);
  assert.equal(p.pickets.length, 1, 'one squad stays as a picket');
  const picket = g.units.get(p.pickets[0].unit);
  for (let i = 0; i < 20 * TICK_HZ; i++) { g.tick(); g.outbox.length = 0; if (i % 30 === 0) ops.managePickets(g, civ, p, squads.filter((u) => g.units.has(u.id)), []); }
  assert.ok(distance(picket, site) <= site.radius, 'the picket holds the captured site');
});

test('corridors: genuinely different, reachable approach axes; repeating an axis is penalised', () => {
  const g = create([{ human: false, difficulty: 'hard' }, { human: false, difficulty: 'hard' }]);
  const civ = g.civs[0], p = civ.aiPlan, home = g.sites[0], target = g.sites[1];
  const lanes = ops.corridors(g, civ, p, home, target, 3);
  assert.ok(lanes.length >= 2, `axes found: ${lanes.length}`);
  for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++)
    assert.ok(gap(lanes[i].angle, lanes[j].angle) >= .95, 'axes at least ~55° apart');
  for (const lane of lanes) {
    assert.ok(ops.canReach(g, { type: 'rifle_squad', x: home.x, z: home.z }, lane.rally), 'rally reachable by infantry');
    assert.ok(Math.abs(distance(lane.rally, target) - 8.5) < 2.5, 'rally stands off the objective');
  }
  // the next operation against the same target avoids the axis just used
  p.axisLog = [{ target: target.id, angle: lanes[0].angle, point: lanes[0].rally, time: g.time }];
  p.corridorCache = null;
  const again = ops.corridors(g, civ, p, home, target, 1);
  assert.ok(gap(again[0].angle, lanes[0].angle) >= .5, 'a fresh axis is chosen');
});

test('task forces: the army splits into axes, musters, steps off together and reinforcements join at a rally', () => {
  const g = create([{ human: false, difficulty: 'hard' }, { human: true }]);
  const civ = g.civs[0], p = civ.aiPlan, home = g.sites[0], target = g.sites[1];
  at(g, 600);
  p.next = Infinity;
  know(g, civ, target);
  const types = [];
  for (let i = 0; i < 34; i++) types.push(['rifle_squad', 'anti_armor', 'tank', 'rifle_squad', 'mech_infantry', 'armored_car'][i % 6]);
  const own = army(g, civ, home, types, 2.2);
  assert.ok(own.length >= 30, `army spawned: ${own.length}`);
  p.state = 'Attacking'; p.target = target.id; p.since = g.time; p.progressAt = g.time;
  const intel = () => [...civ.siteIntel.values()].find((s) => s.id === target.id);
  const owned = () => [...g.units.values()].filter((u) => u.owner === civ.id && !u.auto);
  let launchedAt = null, spread = null;
  for (let i = 1; i <= 260 * TICK_HZ; i++) {
    g.tick(); g.outbox.length = 0;
    if (i % 30) continue;
    ops.runOperation(g, civ, p, owned(), [], home, intel());
    if (p.op.launched && launchedAt == null) {
      launchedAt = g.time;
      // where each assault force stands when it steps off
      spread = p.op.forces.filter((f) => f.role === 'main' || f.role === 'flank').map((f) => {
        const units = f.ids.map((id) => g.units.get(id)).filter((u) => u && !ACTION_UNITS[u.type].air);
        const c = { x: units.reduce((n, u) => n + u.x, 0) / units.length, z: units.reduce((n, u) => n + u.z, 0) / units.length };
        return { f, c, units };
      });
      break;
    }
  }
  const assault = p.op.forces.filter((f) => f.role === 'main' || f.role === 'flank');
  assert.ok(assault.length >= 2, `assault forces: ${p.op.forces.map((f) => f.role + ':' + f.ids.length)}`);
  assert.ok(p.op.forces.some((f) => f.role === 'reserve' && f.ids.length), 'a home reserve is kept');
  assert.ok(p.op.forces.some((f) => f.role === 'raid' && f.ids.length), 'hard AIs detach raiders');
  assert.ok(launchedAt != null && launchedAt - 600 <= 160, `the operation stepped off (${launchedAt})`);
  for (let i = 0; i < spread.length; i++) {
    const { f, c, units } = spread[i];
    const there = units.filter((u) => distance(u, f.rally) < 4.5).length;
    assert.ok(there >= units.length * .5, `force ${i} mustered at its rally (${there}/${units.length})`);
    for (let j = i + 1; j < spread.length; j++)
      assert.ok(gap(bearing(target, c), bearing(target, spread[j].c)) >= .7, `forces stand on different axes: ${JSON.stringify(spread.map((s) => ({ a: bearing(target, s.c).toFixed(2), r: bearing(target, s.f.rally).toFixed(2), d: distance(s.c, target).toFixed(1), n: s.units.length })))} at ${launchedAt}`);
  }
  assert.equal(p.axisLog.length, assault.length, 'the axes used are remembered');
  // reinforcements: new units join the nearest force and are routed to its rally, not straight at the objective
  const fresh = army(g, civ, home, ['rifle_squad', 'anti_armor', 'rifle_squad', 'tank'], 1.4);
  for (let i = 1; i <= 15 * TICK_HZ; i++) { g.tick(); g.outbox.length = 0; if (i % 30 === 0) ops.runOperation(g, civ, p, owned(), [], home, intel()); }
  for (const u of fresh.filter((v) => g.units.has(v.id))) {
    const f = p.op.forces.find((x) => x.ids.includes(u.id));
    assert.ok(f, 'the reinforcement joined a force');
    if (f.role !== 'main' && f.role !== 'flank') continue;
    assert.ok(u.goal, 'and is on the move');
    const leg = [f.stage, f.rally].filter(Boolean);
    assert.ok(leg.some((w) => distance(u.goal, w) < 3.5), 'heading for its force\'s stage or rally point');
  }
});

test('stalemate: the AI reaches for a strategic missile, launches at the blocking headquarters, never into its own troops', () => {
  const g = create([{ human: false, difficulty: 'hard' }, { human: true }]);
  const civ = g.civs[0], foe = g.civs[1], p = civ.aiPlan, home = g.sites[0], enemyHome = g.sites[1];
  at(g, 1500);
  civ.age = 2; home.tier = 3;
  civ.res = { materials: 9000, energy: 9000 };
  // a lab already stands at the main base (the programme builds the silo, then the missile, itself)
  const lab = addFacility(g, civ, home, 'advanced_lab', openSlots(g, home)[0], { instant: true });
  assert.ok(lab.done);
  know(g, civ, enemyHome);
  // a front that has not moved: two assaults on the enemy capital failed, and the capital is held by armour
  p.failedAt = { [enemyHome.id]: 2 };
  army(g, civ, home, Array.from({ length: 30 }, (_, i) => ['rifle_squad', 'anti_armor', 'tank'][i % 3]), 2);
  const defenders = army(g, foe, enemyHome, Array.from({ length: 16 }, () => 'tank'), 1.4);
  const launches = [];
  const command = g.command.bind(g);
  g.command = (id, cmd) => {
    const r = command(id, cmd);
    if (id === civ.id && cmd.c === 'missileLaunch' && !r.error) {
      launches.push({ point: cmd.point, time: g.time,
        own: [...g.units.values()].filter((u) => u.owner === civ.id && !ACTION_UNITS[u.type].air && distance(u, cmd.point) < MISSILE_PROJECT.radius + .5).length });
    }
    return r;
  };
  for (let i = 1; i <= 420 * TICK_HZ && !launches.length && !g.over; i++) { g.tick(); g.outbox.length = 0; civ.res.materials = Math.max(civ.res.materials, 4000); civ.res.energy = Math.max(civ.res.energy, 3000); }
  assert.ok(p.nuke?.stalemate, 'the stalemate was detected');
  assert.ok([...g.buildings.values()].some((b) => b.owner === civ.id && b.type === 'missile_silo'), 'the AI built a Strategic Missile Facility');
  assert.equal(launches.length, 1, 'one strategic missile was launched');
  const shot = launches[0];
  assert.ok(distance(shot.point, enemyHome) < MISSILE_PROJECT.radius || defenders.filter((u) => distance(u, shot.point) < MISSILE_PROJECT.radius).length >= 6,
    'aimed at the blocking headquarters or the massed army');
  assert.equal(shot.own, 0, 'no own troops in the blast');
  assert.ok(p.nuke.next >= shot.time + ops.PROFILES.hard.cooldown - 1, 'the next launch waits for the cooldown');
});

test('difficulty profiles: easy stays simple, harder AIs reach for strategic weapons sooner', () => {
  const P = ops.PROFILES;
  assert.equal(P.easy.axes, 1);
  assert.equal(P.easy.raid, 0);
  assert.ok(P.normal.axes >= 2 && P.hard.axes >= 3);
  const order = ['easy', 'normal', 'hard', 'expert', 'brutal'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(P[order[i]].nukeAfter <= P[order[i - 1]].nukeAfter, `${order[i]} starts no later than ${order[i - 1]}`);
    assert.ok(P[order[i]].cooldown <= P[order[i - 1]].cooldown);
  }
});

// Capture-zone entries and completed captures in a short normal 1v1 (one sample per second). Four seeds, 10 minutes
// each, pooled: 51 of 63 entries captured at the balance pass (per seed 0.68-1.00; before AI operations about 0.45).
const SEEDS = [7, 11, 23, 5], MIN_PASSES = 24, MIN_RATE = .65;
function captureCount(seed, minutes) {
  const g = create([{ human: false, difficulty: 'normal', personality: 'warlord' }, { human: false, difficulty: 'normal', personality: 'merchant' }], seed);
  const inZone = new Map();
  let passes = 0, captures = 0;
  for (let i = 1; i <= minutes * 60 * TICK_HZ && !g.over; i++) {
    g.tick(); g.outbox.length = 0;
    if (i % TICK_HZ) continue;
    for (const s of g.sites) {
      if (s.hq) continue;
      const near = g.movers.query(s.x, s.z, s.radius, []);
      for (const c of g.civs) {
        const k = c.id + ':' + s.id, eligible = s.owner !== c.id;
        const here = eligible && near.some((u) => u.owner === c.id && u.hp > 0 && !u.auto && ACTION_UNITS[u.type].capture);
        if (here && !inZone.has(k)) { inZone.set(k, true); passes++; }
        else if (!here && inZone.has(k)) { inZone.delete(k); if (s.owner === c.id) captures++; }
      }
    }
  }
  return { passes, captures };
}

// Balance pass 2026-11-18: several seeds pooled, so an unrelated change to the AI's economy cannot swing the rate of a
// single match across the threshold
test('a short AI match: captures complete instead of being walked through', () => {
  let passes = 0, captures = 0;
  const per = [];
  for (const seed of SEEDS) {
    const r = captureCount(seed, 10);
    passes += r.passes; captures += r.captures; per.push(`seed ${seed}: ${r.captures}/${r.passes}`);
  }
  assert.ok(passes >= MIN_PASSES, `zone entries: ${passes} (${per.join(', ')})`);
  assert.ok(captures / passes >= MIN_RATE, `captures completed ${captures} of ${passes} entries (${per.join(', ')})`);
});

test('operations are deterministic: the same seed plays out identically', () => {
  const run = () => {
    const g = create([{ human: false, difficulty: 'hard', personality: 'warlord' }, { human: false, difficulty: 'hard', personality: 'builder' }], 41);
    for (let i = 0; i < 7 * 60 * TICK_HZ && !g.over; i++) { g.tick(); g.outbox.length = 0; }
    return JSON.stringify({
      units: [...g.units.values()].map((u) => [u.id, u.type, u.owner, +u.x.toFixed(4), +u.z.toFixed(4)]),
      plans: g.civs.map((c) => [c.aiPlan.state, c.aiPlan.target, (c.aiPlan.op?.forces || []).map((f) => [f.role, f.ids.length]), (c.aiPlan.pickets || []).length]),
    });
  };
  assert.equal(run(), run());
});

test('rivers: vehicles cut off by an unbridged river get an engineer road ordered once; infantry still go', () => {
  const g = create([{ human: false, difficulty: 'normal' }, { human: true }]);
  const civ = g.civs[0], p = civ.aiPlan, home = g.sites[0];
  p.next = Infinity;
  civ.res.materials = 5000;
  const tank = { type: 'tank', x: home.x, z: home.z }, squad = { type: 'rifle_squad', x: home.x, z: home.z };
  const site = g.sites.find((s) => ops.cutOff(g, [tank], s).length);
  assert.ok(site, 'this map has a site across a river from the capital (no bridges at match start)');
  assert.equal(ops.cutOff(g, [squad], site).length, 0, 'infantry wade: never cut off');
  const projects = () => g.roadProjects.filter((r) => r.owner === civ.id && !r.auto).length;
  const before = projects();
  const r = ops.bridgeToward(g, civ, p, home, site, 'site:' + site.id);
  assert.ok(r.ok, `road ordered (${r.error})`);
  assert.equal(projects(), before + 1, 'one engineer road project');
  assert.ok(p.notes.some((n) => /bridge the river/.test(n.text)));
  ops.bridgeToward(g, civ, p, home, site, 'site:' + site.id);
  assert.equal(projects(), before + 1, 'deduped: no second order for the same target');
});
