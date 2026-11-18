// W1 (gameplay overhaul R1/R2): shared production capacity, priorities, progressive payment, no refunds,
// command-capacity reservations, exit-blocked items, save migration. docs/gameplay-overhaul/PRODUCTION_SCHEDULER.md
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { addFacility, armyCapacity, openSlots } = await import('../server/sim/actionBases.js');
const { beginProduction, productionCapacity, productionWire, runProduction } = await import('../server/sim/actionProduction.js');
const { serializeGame, restoreGame } = await import('../server/sim/persist.js');

const create = () => new ActionGame({ id: 'prod-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const T = (unit) => ACTION_UNITS[unit].time;

function setup(n = 1) {
  const g = create(), civ = g.civs[0], site = g.sites[0];
  civ.res = { materials: 100000, energy: 100000 };
  const slots = openSlots(g, site);
  const bs = Array.from({ length: n }, (_, i) => addFacility(g, civ, site, 'barracks', slots[i], { instant: true }));
  return { g, civ, site, bs, b: bs[0] };
}
const step = (g, b, dt) => { beginProduction(); return runProduction(g, g.civs[b.owner], b, dt); };
const q = (b, unit) => b.queues.find((x) => x.unit === unit);
// total work done since `start`: whole items finished (count dropped) plus the progress on the current one
const workOf = (b, start) => Object.entries(start).reduce((sum, [unit, n]) => sum + (n - (q(b, unit)?.count ?? 0)) * T(unit) + (q(b, unit)?.work ?? 0), 0);

test('Test A: queues share one capacity budget; more queues never mean more throughput', () => {
  const { g, b } = setup();
  const cap = productionCapacity(g, b);
  assert.ok(cap > 0);
  assert.ok(!g.command(0, { c: 'train', ids: [b.id], type: 'rifle_squad', count: 5 }).error);
  assert.ok(!g.command(0, { c: 'train', ids: [b.id], type: 'militia', count: 5 }).error);
  assert.ok(!g.command(0, { c: 'train', ids: [b.id], type: 'scout_buggy', count: 5 }).error);
  const start = { rifle_squad: 5, militia: 5, scout_buggy: 5 };
  let last = 0;
  for (let i = 0; i < 400; i++) {
    const spent = step(g, b, .3), now = workOf(b, start);
    g.movers.clear();   // finished units leave the exit (an exit-blocked item would idle the building)
    assert.ok(spent <= cap * .3 + 1e-9, 'work per interval never exceeds capacity × dt');
    close(now - last, spent, 1e-6);
    last = now;
  }
  close(last, cap * .3 * 400, 1e-6);   // fully busy for the whole run: exactly capacity × time

  // the same total with one queue: adding queues does not add speed
  const one = setup();
  // 2026-11-18: rifle squads train in 7 s (was 10): 20 of them keep the one queue busy for the whole run
  one.g.command(0, { c: 'train', ids: [one.b.id], type: 'rifle_squad', count: 20 });
  for (let i = 0; i < 400; i++) { step(one.g, one.b, .3); one.g.movers.clear(); }
  close(workOf(one.b, { rifle_squad: 20 }), last, 1e-6);
});

test('Test A: priority tiers first, fair equal shares within a tier, blocked queues release their share', () => {
  const { g, b } = setup(), cap = productionCapacity(g, b), dt = .3;
  g.command(0, { c: 'train', ids: [b.id], type: 'rifle_squad', count: 2, priority: 2 });
  g.command(0, { c: 'train', ids: [b.id], type: 'militia', count: 2, priority: 0 });
  step(g, b, dt);
  close(q(b, 'rifle_squad').work, cap * dt);
  assert.equal(q(b, 'militia').work, 0);
  assert.equal(q(b, 'militia').state, 'waiting');
  assert.equal(q(b, 'rifle_squad').state, 'producing');
  // equal priority: equal shares
  assert.ok(!g.command(0, { c: 'setPriority', id: b.id, type: 'militia', priority: 2 }).error);
  const r0 = q(b, 'rifle_squad').work;
  step(g, b, dt);
  close(q(b, 'rifle_squad').work - r0, cap * dt / 2);
  close(q(b, 'militia').work, cap * dt / 2);
  // a paused queue gives its whole share to the other
  assert.ok(!g.command(0, { c: 'pauseTrain', id: b.id, type: 'militia', on: true }).error);
  const r1 = q(b, 'rifle_squad').work, m1 = q(b, 'militia').work;
  step(g, b, dt);
  close(q(b, 'rifle_squad').work - r1, cap * dt);
  assert.equal(q(b, 'militia').work, m1);
  assert.equal(q(b, 'militia').state, 'paused');
  g.command(0, { c: 'pauseTrain', id: b.id, type: 'militia', on: false });
  // a queue short of resources (anti-armor needs energy) gives its share to one that can pay
  g.civs[0].res.energy = 0;
  g.command(0, { c: 'clearQueue', id: b.id });
  g.command(0, { c: 'train', ids: [b.id], type: 'anti_armor', count: 1 });
  g.command(0, { c: 'train', ids: [b.id], type: 'rifle_squad', count: 1 });
  step(g, b, dt);
  assert.equal(q(b, 'anti_armor').state, 'resources');
  assert.equal(q(b, 'anti_armor').work, 0);
  close(q(b, 'rifle_squad').work, cap * dt);
  const wire = productionWire(g, b);
  assert.deepEqual(wire.qs.map((x) => [x[0], x[1], x[4]]), [['anti_armor', 1, 'resources'], ['rifle_squad', 1, 'producing']]);
  assert.equal(wire.q.length, 2);
  close(wire.cap, Math.round(cap * 1000) / 1000);
});

test('Test A: resources are consumed in proportion to work, and only by work', () => {
  const { g, civ, b } = setup(), cost = ACTION_UNITS.anti_armor.cost;
  g.command(0, { c: 'train', ids: [b.id], type: 'anti_armor', count: 3 });
  const before = { ...civ.res };
  assert.deepEqual(before, civ.res, 'queueing charges nothing');
  step(g, b, 2);
  const w = q(b, 'anti_armor').work;
  close(before.materials - civ.res.materials, cost.materials * w / T('anti_armor'));
  close(before.energy - civ.res.energy, cost.energy * w / T('anti_armor'));
  // run to completion of all three: exactly three full costs, no drift
  for (let i = 0; i < 2000 && b.queues.length; i++) step(g, b, .3);
  assert.equal(b.queues.length, 0);
  close(before.materials - civ.res.materials, cost.materials * 3, 1e-9);
  close(before.energy - civ.res.energy, cost.energy * 3, 1e-9);
});

test('Test B: cancel at 40% of a 200-material item: 80 consumed, nothing refunded, 120 never charged', () => {
  const saved = ACTION_UNITS.rifle_squad.cost;
  ACTION_UNITS.rifle_squad.cost = { materials: 200 };
  try {
    for (const end of ['cancel', 'destroyed', 'clear']) {
      const { g, civ, b } = setup(), cap = productionCapacity(g, b);
      civ.res = { materials: 1000, energy: 0 };
      g.command(0, { c: 'train', ids: [b.id], type: 'rifle_squad', count: 1 });
      step(g, b, .4 * T('rifle_squad') / cap);
      close(q(b, 'rifle_squad').work / T('rifle_squad'), .4);
      close(civ.res.materials, 920);
      assert.equal(armyCapacity(g, civ).reserved, ACTION_UNITS.rifle_squad.capacity);
      if (end === 'cancel') {
        const r = g.command(0, { c: 'cancelTrain', id: b.id, type: 'rifle_squad', count: 1 });
        close(r.reply.cancelled.lost.materials, 80);
      } else if (end === 'clear') assert.ok(!g.command(0, { c: 'clearQueue', id: b.id }).error);
      else g.loseBuilding(b);
      close(civ.res.materials, 920);   // no refund, and the other 120 was never charged
      assert.equal(armyCapacity(g, civ).reserved, 0, `${end}: the reservation is released`);
      if (end !== 'destroyed') { step(g, b, 30); close(civ.res.materials, 920); }
    }
    // partial shortage: the queue advances as far as it can pay, then resumes when funds arrive
    const { g, civ, b } = setup();
    civ.res = { materials: 50, energy: 0 };
    g.command(0, { c: 'train', ids: [b.id], type: 'rifle_squad', count: 1 });
    step(g, b, 60);
    close(q(b, 'rifle_squad').work / T('rifle_squad'), .25);
    assert.equal(q(b, 'rifle_squad').state, 'resources');
    close(civ.res.materials, 0);
    const units = g.units.size;
    civ.res.materials = 150;
    step(g, b, 60);
    assert.equal(g.units.size, units + 1, 'completed only once fully paid');
    close(civ.res.materials, 0, 1e-9);
    assert.ok(!q(b, 'rifle_squad'));
  } finally { ACTION_UNITS.rifle_squad.cost = saved; }
});

test('population is reserved authoritatively before an item starts, across buildings', () => {
  const { g, civ, bs: [a, b] } = setup(2);
  const cap = armyCapacity(g, civ), need = ACTION_UNITS.rifle_squad.capacity;
  g.armyLimit = cap.used + need;   // room for exactly one more rifle squad
  assert.ok(!g.command(0, { c: 'batchTrain', buildings: [a.id, b.id], unit: 'rifle_squad', count: 1, policy: 'each' }).error,
    'queueing beyond the population cap is allowed');
  beginProduction(); runProduction(g, civ, a, .3); runProduction(g, civ, b, .3);
  assert.deepEqual([q(a, 'rifle_squad').state, q(b, 'rifle_squad').state], ['producing', 'capacity']);
  assert.equal(q(b, 'rifle_squad').work, 0);
  assert.equal(armyCapacity(g, civ).reserved, need);
  // the first finishes: its reservation becomes a unit, so the second still waits
  for (let i = 0; i < 200 && q(a, 'rifle_squad'); i++) { beginProduction(); runProduction(g, civ, a, .3); runProduction(g, civ, b, .3); }
  assert.ok(!q(a, 'rifle_squad'));
  assert.equal(q(b, 'rifle_squad').state, 'capacity');
  assert.equal(armyCapacity(g, civ).used, g.armyLimit);
  g.armyLimit += need;
  step(g, b, .3);
  assert.equal(q(b, 'rifle_squad').state, 'producing');
});

test('a finished item waiting for its exit keeps its reservation and is never charged twice', () => {
  const { g, civ, b } = setup();
  g.command(0, { c: 'train', ids: [b.id], type: 'rifle_squad', count: 1 });
  const spawn = g.spawn;
  g.spawn = () => null;
  const before = civ.res.materials;
  step(g, b, 100);
  assert.equal(q(b, 'rifle_squad').state, 'exit');
  assert.equal(b.state, 'exit blocked');
  close(before - civ.res.materials, ACTION_UNITS.rifle_squad.cost.materials);
  step(g, b, 100);
  close(before - civ.res.materials, ACTION_UNITS.rifle_squad.cost.materials);
  assert.equal(armyCapacity(g, civ).reserved, ACTION_UNITS.rifle_squad.capacity);
  g.spawn = spawn;
  const units = g.units.size;
  step(g, b, .3);
  assert.equal(g.units.size, units + 1);
  assert.equal(armyCapacity(g, civ).reserved, 0);
  close(before - civ.res.materials, ACTION_UNITS.rifle_squad.cost.materials);
});

test('repeat keeps a queue going; legacy cancelTrain by index still works; the queue cap holds', () => {
  const { g, b } = setup();
  assert.ok(!g.command(0, { c: 'repeat', id: b.id, unit: 'militia' }).error);
  assert.equal(q(b, 'militia').count, 1);
  const units = g.units.size;
  for (let i = 0; i < 200; i++) step(g, b, .3);
  assert.ok(g.units.size >= units + 3, 'repeat production continues');
  assert.equal(q(b, 'militia').count, 1);
  g.command(0, { c: 'repeat', id: b.id, unit: null });
  g.command(0, { c: 'train', ids: [b.id], type: 'rifle_squad', count: 2 });
  const legacy = productionWire(g, b).q;
  const idx = legacy.map((x) => x[0]).lastIndexOf('rifle_squad');
  assert.ok(!g.command(0, { c: 'cancelTrain', id: b.id, index: idx }).error);
  assert.equal(q(b, 'rifle_squad').count, 1);
  const r = g.command(0, { c: 'train', ids: [b.id], type: 'scout_buggy', count: 40 });
  assert.equal(r.reply.training.reason, 'Production queue full.');
  assert.equal(b.queues.reduce((n, x) => n + x.count, 0), 20);
});

test('old saves migrate: the started item is paid in full, prepaid unstarted items are returned', () => {
  const { g, civ, b } = setup();
  const data = JSON.parse(JSON.stringify(serializeGame(g)));
  const old = data.buildings.find((x) => x.id === b.id);
  delete old.queues;
  old.queue = [{ unit: 'rifle_squad', left: 6, total: 12 }, { unit: 'militia', left: 10, total: 10 }, { unit: 'rifle_squad', left: 12, total: 12 }];
  const restored = restoreGame(data), rb = restored.buildings.get(b.id), rc = restored.civs[0];
  assert.equal(rb.queue, undefined);
  assert.deepEqual(rb.queues.map((x) => [x.unit, x.count]), [['rifle_squad', 2], ['militia', 1]]);
  close(rb.queues[0].work / T('rifle_squad'), .5);
  assert.equal(rb.queues[0].paid.materials, ACTION_UNITS.rifle_squad.cost.materials);
  close(rc.res.materials, civ.res.materials + ACTION_UNITS.rifle_squad.cost.materials);
  // the half-built item completes without being charged again
  const before = rc.res.materials;
  beginProduction(); runProduction(restored, rc, rb, .3);
  assert.ok(rb.queues[0].work > .5 * T('rifle_squad'));
  // every migrated first-of-type item (the militia too: the old FIFO had already charged it) is paid in full
  assert.equal(rb.queues[1].paid.materials, ACTION_UNITS.militia.cost.materials);
  close(before - rc.res.materials, 0);
});
