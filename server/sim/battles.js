// Battles: where hostile forces are actively exchanging fire, grouped into regions so the client
// can show one marker and an engagement summary instead of hundreds of individual effects.
// Group target assignment for attack orders also lives here.
import { UNITS, W } from './constants.js';
import { dist, disk, dqWrap, idx } from './hex.js';
import { WEAPONS, UNIT_WEAPON, ARMORED } from './weapons.js';

const RADIUS = 6;

export function battlesStep(g) {
  const from = g.battleSeq || 0;
  for (const e of g.events) {
    if (e.i <= from) continue;
    if ((e.k !== 'hit' && e.k !== 'impact' && e.k !== 'bhit' && e.k !== 'kill') || !(e.b >= 0)) continue;
    let bt = null, bd = Infinity;
    for (const b of g.battles) { const d = dist(b.tile, e.b); if (d <= RADIUS && d < bd) { bd = d; bt = b; } }
    if (!bt) { bt = { id: g.nextBattle++, tile: e.b, since: g.time, last: g.time, sq: 0, sr: 0, n: 0, losses: {}, heat: 0 }; g.battles.push(bt); }
    bt.last = g.time; bt.heat++;
    // running centre, seam-safe: offsets are measured from the battle's first hex
    bt.q0 = bt.q0 ?? (bt.tile % W);
    bt.sq += dqWrap(bt.q0, e.b % W); bt.sr += (e.b / W) | 0; bt.n++;
    if (bt.n >= 4) bt.tile = idx(Math.round(bt.q0 + bt.sq / bt.n), Math.round(bt.sr / bt.n));
    if (e.k === 'kill' && e.ow >= 0) bt.losses[e.ow] = (bt.losses[e.ow] || 0) + 1;
  }
  g.battleSeq = g.eventSeq;
  for (const b of g.battles) b.heat *= 0.8;
  // merge battles that drifted together; end quiet ones
  for (let i = 0; i < g.battles.length; i++) for (let j = g.battles.length - 1; j > i; j--) {
    const a = g.battles[i], b = g.battles[j];
    if (dist(a.tile, b.tile) <= 4) { for (const [k, v] of Object.entries(b.losses)) a.losses[k] = (a.losses[k] || 0) + v; a.since = Math.min(a.since, b.since); a.last = Math.max(a.last, b.last); g.battles.splice(j, 1); }
  }
  g.battles = g.battles.filter((b) => g.time - b.last < 20);
}

// One viewer's picture of each battle: its own forces in full, the enemy only as far as it can see.
export function battlesFor(g, civ, vis, god) {
  const out = [];
  for (const b of g.battles) {
    const mine = { n: 0, engaged: 0, suppressed: 0, retreating: 0, lost: b.losses[civ.id] || 0 };
    const foes = new Map(), sides = new Set();
    for (const t of disk(b.tile, RADIUS)) {
      const ids = g.tileUnits.get(t); if (!ids) continue;
      for (const id of ids) {
        const u = g.units.get(id); if (!u || UNITS[u.type].civilian) continue;
        if (u.owner === civ.id) {
          mine.n++; sides.add(u.owner);
          if ([2, 7, 8].includes(u.cstat)) mine.engaged++;
          if (u.cstat === 4 || u.cstat === 10) mine.suppressed++;
          if (u.cstat === 9) mine.retreating++;
        } else if (god || (vis[t] && g.detects(civ.id, u))) {
          const f = foes.get(u.owner) || { n: 0, str: 0 }; f.n++; f.str += (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp); foes.set(u.owner, f); sides.add(u.owner);
        }
      }
    }
    if (!god && !mine.n && !vis[b.tile]) continue;
    let near = null, nd = Infinity;
    for (const c of g.cities.values()) { const d = dist(c.tile, b.tile); if (d < nd) { nd = d; near = c; } }
    const myStr = [...g.units.values()].filter((u) => u.owner === civ.id && !UNITS[u.type].civilian && dist(u.tile, b.tile) <= RADIUS).reduce((s, u) => s + (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp), 0);
    out.push({ id: b.id, t: b.tile, name: near ? `Battle near ${near.name}` : 'Battle in the wilds', age: Math.round(g.time - b.since), heat: Math.round(b.heat),
      mine, myStr: Math.round(myStr),
      foes: [...foes.entries()].map(([o, f]) => ({ civ: o, n: f.n, str: Math.round(f.str), lost: god || mine.n ? b.losses[o] || 0 : undefined })),
      sides: [...sides] });
  }
  return out;
}

// Spread a group's fire over the threats around a target, avoiding overkill.
export function assignTargets(g, civ, units, target) {
  const tt = target.kind === 'unit' ? g.units.get(target.id)?.tile : g.buildings.get(target.id)?.tile;
  if (!(tt >= 0)) return null;
  const cands = [];
  for (const t of disk(tt, 3)) {
    const ids = g.tileUnits.get(t);
    if (ids) for (const id of ids) {
      const e = g.units.get(id);
      if (!e || !g.hostile(civ.id, e.owner) || !g.detects(civ.id, e)) continue;
      cands.push({ tg: { kind: 'unit', id }, hp: e.hp, def: UNITS[e.type].def, air: !!UNITS[e.type].air, threat: UNITS[e.type].atk, d: dist(t, tt), primary: target.kind === 'unit' && id === target.id, armored: ARMORED.has(UNITS[e.type].cat) });
    }
    const b = g.buildingAtTile(t);
    if (b && g.hostile(civ.id, b.owner)) cands.push({ tg: { kind: 'building', id: b.id }, hp: b.hp, def: 10, threat: 0, d: dist(t, tt), primary: target.kind === 'building' && b.id === target.id, building: true });
  }
  if (!cands.length) return null;
  const load = new Map();
  const plan = new Map();
  // long-range and heavy weapons pick first; riflemen fill in
  const order = units.slice().sort((a, b) => UNITS[b.type].range - UNITS[a.type].range || UNITS[b.type].atk - UNITS[a.type].atk || a.id - b.id);
  for (const u of order) {
    const def = UNITS[u.type];
    let best = null, bs = -Infinity;
    for (const c of cands) {
      if (c.air && !(def.aa > 0)) continue;
      const per = def.atk * 1.6 * (10 / (10 + c.def)) * 2 * (c.building ? (def.vsBuildings || 1) : 1);
      const over = (load.get(c) || 0) >= c.hp * 1.15;
      let s = (c.primary ? 4 : 0) + c.threat / 8 - c.d * 0.6 - dist(u.tile, tt) * 0.05 - (over ? 20 : 0) + (c.building ? -1 : 0);
      if (c.building && (def.vsBuildings || 1) > 1.4) s += 3;
      const vsA = (WEAPONS[UNIT_WEAPON[u.type]] || WEAPONS.carbine).vsArmor;
      if (c.armored) s += vsA >= 1 ? 5 : vsA < 0.6 ? -2 : 0;      // anti-armour weapons go for vehicles
      if (s > bs) { bs = s; best = { c, per }; }
    }
    if (!best) continue;
    load.set(best.c, (load.get(best.c) || 0) + best.per);
    plan.set(u.id, best.c.tg);
  }
  return plan;
}
