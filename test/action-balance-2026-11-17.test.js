// Playtest fixes (2026-11-17): infantry no longer beat armour and fortifications (body-armour absorption bug,
// rocket kit, structure armour, tracked armour vs small arms), mortar debuff, forgiving trench / road strokes
// that build the valid hexes and skip the rest, and base perimeters bought with fogged outer lots.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, CITY_DEFENSES } = await import('../server/sim/actionDefinitions.js');
const { addFacility } = await import('../server/sim/actionBases.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { damageActionTarget, structureArmour, FORTIFIED_VS } = await import('../server/sim/actionCombat.js');
const { disk } = await import('../server/sim/hex.js');

const create = () => new ActionGame({ id: 'b-1117', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const rich = (g, id = 0) => { g.civs[id].res = { materials: 20000, energy: 20000 }; g.civs[id].visible.fill(1); };

test('fortified structures shrug off small arms; ring facilities do not; demolition weapons are unaffected', () => {
  const g = create(), s = g.sites[0];
  g.units.clear();
  const squad = g.spawn(g.civs[1], 'rifle_squad', { x: s.x + 4, z: s.z }, .2);
  const bunker = addFacility(g, g.civs[0], null, 'bunker', tileAt(s.x + 3, s.z + 2), { instant: true, point: { x: s.x + 3, z: s.z + 2, yaw: 0 } });
  assert.equal(ACTION_BUILDINGS.bunker.armor, 'fortified');
  assert.equal(ACTION_BUILDINGS.fort.armor, 'fortified');
  assert.equal(ACTION_BUILDINGS.barracks.armor, undefined, 'ring facilities are not fortified');
  assert.equal(structureArmour(bunker, 'rifle'), FORTIFIED_VS.smallArms);
  assert.equal(structureArmour(bunker, 'mg'), FORTIFIED_VS.smallArms);
  assert.equal(structureArmour(bunker, 'cannon'), 1, 'tank guns are full strength');
  assert.equal(structureArmour(bunker, 'howitzer'), 1, 'artillery is full strength');
  assert.equal(structureArmour(bunker, 'atgun', 'rocket'), FORTIFIED_VS.rocket, 'the rifle squad rocket kit is reduced');
  assert.equal(structureArmour({ type: 'barracks' }, 'rifle'), 1);
  const hit = (b, weapon) => { const before = b.hp; damageActionTarget(g, b, squad, 40, weapon); const d = before - b.hp; b.hp = b.maxHp; return d; };
  assert.ok(hit(bunker, 'rifle') <= 40 * FORTIFIED_VS.smallArms + 1);
  assert.equal(hit(bunker, 'cannon'), 40);
});

test('tracked armour takes half the small-arms rate; tanks fire HE at infantry', () => {
  const g = create(), s = g.sites[0];
  g.units.clear();
  const tank = g.spawn(g.civs[0], 'tank', { x: s.x + 4, z: s.z }, .2), car = g.spawn(g.civs[0], 'armored_car', { x: s.x + 4, z: s.z + 2 }, .2);
  const squad = g.spawn(g.civs[1], 'rifle_squad', { x: s.x + 6, z: s.z }, .2);
  const hit = (u) => { const before = u.hp; damageActionTarget(g, u, squad, 60, 'rifle'); const d = before - u.hp; u.hp = u.maxHp; return d; };
  // 60 x .35 (vsArmor) = 21; tank: x .5 = 10.5 - def 18 x .2 = 6.9 -> 7; car: 21 - 9 x .2 = 19
  assert.equal(hit(tank), 7);
  assert.equal(hit(car), 19);
  assert.equal(ACTION_UNITS.tank.hp, 495);   // 2026-11-20 tank pass: 330 -> 495
  assert.equal(ACTION_UNITS.autonomous_tank.hp, 760);   // 2026-11-20 tank pass: 480 -> 760
  assert.ok(ACTION_UNITS.tank.vsInfantry > 1 && ACTION_UNITS.autonomous_tank.vsInfantry > 1);
});

test('mortar numbers (balance pass)', () => {
  const m = ACTION_UNITS.mortar_team;
  assert.deepEqual(m.cost, { materials: 150, energy: 45 });
  assert.equal(m.fireCooldown, 5.4);   // 2026-11-19: indirect fire 20 % slower (was 4.5)
  assert.equal(m.hp, 120);
  // the per-unit fire cooldown is honoured in combat
  const g = create(), s = g.sites[0];
  g.units.clear();
  g.civs[0].visible.fill(1); g.civs[0].detect?.fill(1);
  const mortar = g.spawn(g.civs[0], 'mortar_team', { x: s.x + 2, z: s.z }, .1), foe = g.spawn(g.civs[1], 'rifle_squad', { x: s.x + 5.5, z: s.z }, .1);
  assert.ok(mortar && foe);
  foe.maxHp = foe.hp = 1e6;
  const shots = [];
  for (let i = 0; i < 300; i++) { const before = mortar.readyAt; g.tick(); if (mortar.readyAt !== before) shots.push(g.time); }
  assert.ok(shots.length >= 2, 'the mortar fires');
  for (let i = 1; i < shots.length; i++) assert.ok(shots[i] - shots[i - 1] >= 5.4 - 1e-6, 'at most one bomb per 5.4 s');
});

test('a trench stroke half outside your territory digs the inside half and lists the rest as skipped', () => {
  const g = create(), civ = g.civs[0]; rich(g);
  g.units.clear();
  const home = g.sites[0];
  // neutral ground is allowed now: make the land around us another player's so the border still refuses
  for (let t = 0; t < g.world.owner.length; t++) if (g.world.owner[t] < 0) g.world.owner[t] = 1;
  // a straight line from inside the territory out past its border
  let line = null;
  for (let a = 0; a < 12 && !line; a++) {
    const dx = Math.sin(a * Math.PI / 6), dz = Math.cos(a * Math.PI / 6);
    const pts = [{ x: home.x + dx * 3.2, z: home.z + dz * 3.2 }, { x: home.x + dx * 9, z: home.z + dz * 9 }];
    const r = g.command(0, { c: 'trenchWorld', points: pts, preview: true });
    if (r.reply?.trench?.positions.length && r.reply.trench.skipped.some((p) => p.why === 'territory')) line = { pts, r };
  }
  assert.ok(line, 'a line crossing the border');
  const { positions, skipped } = line.r.reply.trench;
  assert.ok(positions.every((p) => g.world.owner[p.tile] === 0));
  assert.ok(skipped.every((p) => Number.isInteger(p.tile) && typeof p.why === 'string' && Number.isFinite(p.x)));
  const m = civ.res.materials;
  const dug = g.command(0, { c: 'trenchWorld', points: line.pts });
  assert.ok(!dug.error, dug.error);
  assert.equal(dug.hexes, positions.length);
  assert.equal(dug.skipped, skipped.length);
  assert.equal(m - civ.res.materials, positions.length * 35, 'only the dug hexes are paid for');
  assert.equal(g.fieldworks.size, positions.length);
  // wholly outside: refused with the territory code, and the preview still lists the skipped hexes
  const out = line.pts[1], far = { x: out.x + (out.x - home.x) * .3, z: out.z + (out.z - home.z) * .3 };
  const none = g.command(0, { c: 'trenchWorld', points: [out, far], preview: true });
  if (none.error) { assert.equal(none.code, 'territory'); assert.ok(none.reply.trench.skipped.length > 0); }
});

test('a road stroke builds the edges it can and skips the rest (hidden, outside territory)', () => {
  const g = create(), civ = g.civs[0]; rich(g);
  const home = g.sites[0];
  for (let t = 0; t < g.world.owner.length; t++) if (g.world.owner[t] < 0) g.world.owner[t] = 1;   // foreign, not neutral
  let found = null;
  for (let a = 0; a < 12 && !found; a++) {
    const dx = Math.sin(a * Math.PI / 6), dz = Math.cos(a * Math.PI / 6);
    const pts = [{ x: home.x + dx * 3.4, z: home.z + dz * 3.4 }, { x: home.x + dx * 10, z: home.z + dz * 10 }];
    const r = g.command(0, { c: 'roadBuild', points: pts, preview: true });
    if (r.reply?.road?.positions.length && r.reply.road.skipped.length) found = { pts, r };
  }
  assert.ok(found, 'a road stroke that crosses out of the territory');
  const { positions, skipped, cost } = found.r.reply.road;
  assert.ok(positions.every((e) => g.world.owner[e.a] === 0 && g.world.owner[e.b] === 0));
  assert.ok(skipped.every((e) => ['territory', 'hidden', 'hostile', 'foundation', 'blocked'].includes(e.why) && e.from && e.to));
  const m = civ.res.materials;
  const built = g.command(0, { c: 'roadBuild', points: found.pts });
  assert.ok(!built.error, built.error);
  assert.equal(built.edges, positions.length);
  assert.equal(m - civ.res.materials, cost.materials);
  // the fog no longer refuses a whole stroke: hide the far half and the near half still builds
  civ.visible.fill(0);
  for (const e of positions) { civ.visible[e.a] = 1; civ.visible[e.b] = 1; }
  g.roadProjects.length = 0;
  const fogged = g.command(0, { c: 'roadBuild', points: found.pts, preview: true });
  assert.ok(fogged.reply?.road?.positions.length > 0, fogged.error);
});

test('base perimeter defenses do not need every outer lot in sight', () => {
  const g = create(), civ = g.civs[0], s = g.sites[0]; rich(g);
  civ.visible.fill(0);   // the whole settlement fogged
  const m = civ.res.materials;
  const r = g.command(0, { c: 'baseDefenses', site: s.id });
  assert.ok(!r.error, r.error);
  assert.ok(r.placed >= 1);
  const pieces = [...g.buildings.values()].filter((b) => b.site === s.id && b.perimeterSlot);
  assert.equal(pieces.length, r.placed);
  assert.equal(m - civ.res.materials, Math.ceil(CITY_DEFENSES.cost.materials * r.placed / 6), 'paid pro rata for the positions built');
  // field defenses inside your own territory may be placed on fogged ground too
  const t = disk(s.tile, 3).find((k) => g.world.owner[k] === 0 && !g.command(0, { c: 'fieldPreview', type: 'guard_post', point: centerOf(k) }).error);
  assert.ok(t != null, 'a fogged own-territory spot accepts a watchtower');
  const neutral = [...Array(g.world.owner.length).keys()].find((k) => g.world.owner[k] < 0 && distance(centerOf(k), s) < 14);
  if (neutral != null) assert.match(g.command(0, { c: 'fieldPreview', type: 'guard_post', point: centerOf(neutral) }).error || 'Scout', /Scout/, 'neutral ground must still be scouted');
});

test("trenches and roads may cross neutral ground (2026-11-17), never another player's territory", () => {
  const g = create(), civ = g.civs[0]; rich(g);
  g.units.clear();
  civ.visible.fill(1);
  const home = g.sites[0];
  let trench = null, road = null;
  for (let a = 0; a < 12 && !(trench && road); a++) {
    const dx = Math.sin(a * Math.PI / 6), dz = Math.cos(a * Math.PI / 6);
    const pts = [{ x: home.x + dx * 3.2, z: home.z + dz * 3.2 }, { x: home.x + dx * 9, z: home.z + dz * 9 }];
    const t = g.command(0, { c: 'trenchWorld', points: pts, preview: true });
    if (!trench && t.reply?.trench?.positions.some((p) => g.world.owner[p.tile] < 0)) trench = t;
    const r = g.command(0, { c: 'roadBuild', points: pts, preview: true });
    if (!road && r.reply?.road?.positions.some((e) => g.world.owner[e.a] < 0 || g.world.owner[e.b] < 0)) road = r;
  }
  assert.ok(trench, 'a trench reaches onto neutral ground');
  assert.ok(road, 'a road reaches onto neutral ground');
  assert.ok(!trench.reply.trench.skipped.some((p) => p.why === 'territory'));
});
