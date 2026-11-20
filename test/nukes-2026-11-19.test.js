// 2026-11-19 (user: "nukes barely do any damage considering how expensive they are"): a strategic warhead nearly
// wipes out the city it hits and does wide damage that falls off with distance (docs/gameplay-overhaul/NUKES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { MISSILE_PROJECT, nukeFalloff } = await import('../server/sim/actionDefinitions.js');
const { addFacility, openSlots } = await import('../server/sim/actionBases.js');
const { launchStrategic } = await import('../server/sim/actionCombat.js');
const { distance } = await import('../server/sim/actionNavigation.js');
const { stateHash } = await import('../server/sim/persist.js');

const hqOf = (g, owner) => [...g.buildings.values()].find((b) => b.owner === owner && b.type === 'town');

function strike(at, dx = 0) {
  const g = new ActionGame({ id: 'nukes', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
  const hq = hqOf(g, 0), silo = hqOf(g, 1), site = g.siteById.get(hq.site);
  const ring = ['barracks', 'motor_works', 'heavy_weapons'].map((type) => addFacility(g, g.civs[0], site, type, openSlots(g, site)[0], { instant: true }));
  g.units.clear();
  const units = {};
  for (const d of [1, 4, 7, 9]) units[d] = g.spawn(g.civs[0], 'tank', { x: hq.x + dx + d, z: hq.z + .3 }, .1);
  g.tick();
  g.events.length = 0;
  launchStrategic(g, silo, { x: hq.x + dx, z: hq.z });
  for (const p of g.projectiles.values()) if (p.strategic) p.mint = 0;   // not shot down
  for (let i = 0; i < 400 && [...g.projectiles.values()].some((p) => p.strategic); i++) { g.tick(); g.outbox.length = 0; }
  return { g, hq, ring, units, impact: g.events.find((e) => e.k === 'mimpact') };
}

test('strategic falloff: full blast in the core, smoothly less outward, edge share at the rim, nothing beyond', () => {
  const M = MISSILE_PROJECT;
  assert.equal(M.radius, 7.5);
  assert.equal(M.core, 3.2);
  assert.equal(nukeFalloff(0), 1);
  assert.equal(nukeFalloff(M.core), 1);
  assert.ok(Math.abs(nukeFalloff(M.radius) - M.edge) < 1e-9);
  assert.equal(nukeFalloff(M.radius + .01), 0);
  let last = 1;
  for (let d = M.core; d <= M.radius; d += .25) {
    const f = nukeFalloff(d);
    assert.ok(f <= last + 1e-12, `falls off monotonically (${d})`);
    last = f;
  }
  assert.ok(nukeFalloff(5) > .4 && nukeFalloff(5) < .55, 'about half at 5');
  assert.ok(nukeFalloff(6) > .2 && nukeFalloff(6) < .33, 'about a quarter at 6');
});

test('a direct hit nearly wipes out a city: ring facilities destroyed, headquarters on a tenth of its HP', () => {
  const { g, hq, ring, units, impact } = strike();
  assert.ok(impact, 'the warhead landed');
  assert.equal(impact.r, MISSILE_PROJECT.radius, 'the impact event carries the blast radius');
  assert.ok(g.buildings.has(hq.id), 'the headquarters stands (to be finished off or rebuilt)');
  assert.ok(hq.hp > 0 && hq.hp <= hq.maxHp * .12, `headquarters on ${hq.hp} / ${hq.maxHp}`);
  for (const b of ring) assert.ok(!g.buildings.has(b.id), `${b.type} destroyed`);
  assert.ok(!g.units.has(units[1].id) && !g.units.has(units[4].id), 'armour in the core and the inner ring is destroyed');
  assert.ok(g.units.has(units[7].id) && units[7].hp < units[7].maxHp, 'armour near the rim survives, damaged');
  assert.equal(units[9].hp, units[9].maxHp, 'nothing beyond the blast radius');
});

test('a city in the outer rings takes partial damage that shrinks with distance', () => {
  const near = strike(0, 4.8).hq, far = strike(0, 6.5).hq;
  const lost = (hq) => 1 - hq.hp / hq.maxHp;
  assert.ok(lost(near) > .3 && lost(near) < .6, `5 out: ${lost(near).toFixed(2)}`);
  assert.ok(lost(far) > .08 && lost(far) < lost(near), `6.5 out: ${lost(far).toFixed(2)}`);
  assert.ok(distance(near, { x: near.x + 4.8, z: near.z }) > MISSILE_PROJECT.core);
});

test('the strategic blast is deterministic', () => {
  const a = strike(), b = strike();
  assert.equal(stateHash(a.g), stateHash(b.g));
});
