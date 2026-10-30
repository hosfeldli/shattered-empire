// Army groups: named formations of units that take one order and manage themselves.
//   move / attackMove  - formation march (slowest member sets the pace)
//   hold               - stand ground; units only fire from position
//   defend (zone)      - a tactical zone: engage anything hostile that enters, then return
//   offensive          - automated offensive preparation: stage behind the lines, wait until
//                        assembled, supplied and healthy (or strong enough), then attack
import { UNITS } from './constants.js';
import { disk, dist } from './hex.js';

let nextArmyId = 1;
export function setNextArmyId(n) { nextArmyId = n; }
export function getNextArmyId() { return nextArmyId; }

export function armyCommand(g, civ, cmd) {
  civ.armies = civ.armies || new Map();
  const A = civ.armies;
  const own = (ids) => (ids || []).filter((id) => { const u = g.units.get(id); return u && u.owner === civ.id && !UNITS[u.type].civilian; });
  const detach = (ids) => { for (const a of A.values()) a.units = a.units.filter((x) => !ids.includes(x)); };
  switch (cmd.op) {
    case 'create': {
      const ids = own(cmd.units); if (!ids.length) return { error: 'Select combat units to form an army' };
      detach(ids);
      const id = nextArmyId++;
      const name = String(cmd.name || `${ordinal(A.size + 1)} Army`).slice(0, 32);
      A.set(id, { id, name, units: ids, formation: 'line', stance: 'defensive', order: { kind: 'idle' }, status: 'idle', created: g.time, note: '' });
      for (const uid of ids) g.units.get(uid).stance = 'defensive';
      g.history(civ, cmd.by || 'you', `Formed ${name} (${ids.length} units)`);
      return { reply: { t: 'army', id } };
    }
    case 'add': { const a = A.get(cmd.id); if (!a) return { error: 'No such army' }; const ids = own(cmd.units); detach(ids); a.units.push(...ids); return null; }
    case 'remove': { const a = A.get(cmd.id); if (a) a.units = a.units.filter((x) => !(cmd.units || []).includes(x)); return null; }
    case 'disband': { const a = A.get(cmd.id); if (a) { A.delete(cmd.id); g.history(civ, cmd.by || 'you', `Disbanded ${a.name}`); } return null; }
    case 'rename': { const a = A.get(cmd.id); if (a) a.name = String(cmd.name || a.name).slice(0, 32); return null; }
    case 'formation': { const a = A.get(cmd.id); if (a && g.defs.FORMATIONS[cmd.formation]) a.formation = cmd.formation; return null; }
    case 'stance': {
      const a = A.get(cmd.id); if (!a || !g.defs.STANCES[cmd.stance]) return null;
      a.stance = cmd.stance; for (const id of a.units) { const u = g.units.get(id); if (u) u.stance = cmd.stance; }
      return null;
    }
    case 'order': {
      const a = A.get(cmd.id); if (!a) return { error: 'No such army' };
      const kind = cmd.kind;
      if (!['move', 'attackMove', 'hold', 'defend', 'offensive'].includes(kind)) return { error: 'Unknown army order' };
      a.order = { kind, tile: cmd.tile, radius: Math.max(2, Math.min(8, cmd.radius | 0 || 4)), since: g.time, phase: kind === 'offensive' ? 'staging' : null };
      a.note = '';
      if (kind === 'offensive') a.order.staging = stagingTile(g, civ, a, cmd.tile);
      issue(g, civ, a);
      g.history(civ, cmd.by || 'you', `${a.name}: ${describe(a.order)}`);
      return null;
    }
    default: return { error: 'Unknown army operation' };
  }
}

function ordinal(n) { return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'); }
function describe(o) { return { move: 'march', attackMove: 'advance and engage', hold: 'hold position', defend: `defend zone (radius ${o.radius})`, offensive: 'prepare offensive' }[o.kind] || o.kind; }

function stagingTile(g, civ, a, target) {
  // a point inside our territory (or supply) on the near side of the target, ~8 hexes back
  const c = centroid(g, a);
  let best = c, bs = -Infinity;
  for (const t of disk(target, 12)) {
    const d = dist(t, target); if (d < 6 || d > 12) continue;
    if (g.world.owner[t] !== civ.id && !civ.supply[t]) continue;
    const s = -Math.abs(d - 8) - dist(t, c) * 0.25;
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

function centroid(g, a) {
  const us = a.units.map((id) => g.units.get(id)).filter(Boolean);
  if (!us.length) return -1;
  // medoid: the member closest to all others (cheap and always a real tile)
  let best = us[0].tile, bd = Infinity;
  for (const u of us.slice(0, 24)) { let s = 0; for (const v of us) s += dist(u.tile, v.tile); if (s < bd) { bd = s; best = u.tile; } }
  return best;
}

function issue(g, civ, a) {
  const o = a.order, ids = a.units;
  const move = (tile, attackMove) => g.orderMove(civ, ids, tile, attackMove, a.formation);
  if (o.kind === 'move') { move(o.tile, false); a.status = 'moving'; }
  else if (o.kind === 'attackMove') { move(o.tile, true); a.status = 'advancing'; }
  else if (o.kind === 'hold') { for (const id of ids) { const u = g.units.get(id); if (u) { u.path = []; u.field = false; u.order = { kind: 'idle' }; u.stance = 'hold'; } } a.status = 'holding'; }
  else if (o.kind === 'defend') { move(o.tile, true); a.status = 'defending'; }
  else if (o.kind === 'offensive') { move(o.staging, false); a.status = 'staging'; }
}

// Runs every 2 s for every civ.
export function armiesStep(g) {
  for (const civ of g.civs) {
    if (!civ.alive || !civ.armies) continue;
    for (const a of civ.armies.values()) {
      a.units = a.units.filter((id) => g.units.has(id) && g.units.get(id).owner === civ.id);
      const us = a.units.map((id) => g.units.get(id));
      if (!us.length) { if (a.status !== 'destroyed') { a.status = 'destroyed'; g.notify(civ.id, `${a.name} has been destroyed.`, { kind: 'loss', level: 'major' }); } continue; }
      a.men = us.reduce((s, u) => s + (UNITS[u.type].men || 0), 0);
      a.hp = Math.round(us.reduce((s, u) => s + u.hp / u.maxHp, 0) / us.length * 100);
      a.supply = Math.round(us.reduce((s, u) => s + u.supply, 0) / us.length);
      a.center = centroid(g, a);
      const blocked = us.filter((u) => u.status === 'blocked').length;
      if (blocked > us.length / 2 && a.status !== 'blocked') { a.status = 'blocked'; a.note = 'Route impassable: most units cannot reach the objective.'; g.notify(civ.id, `${a.name} cannot reach its objective: the route is blocked.`, { kind: 'blocked', tile: a.center, level: 'major' }); }
      const o = a.order;
      if (o.kind === 'defend') {
        // tactical zone: engage intruders, then fall back to the zone
        let intruder = null;
        for (const t of disk(o.tile, o.radius)) { for (const id of g.tileUnits.get(t) || []) { const e = g.units.get(id); if (e && g.hostile(civ.id, e.owner) && civ.visible[e.tile] && g.detects(civ.id, e)) { intruder = e; break; } } if (intruder) break; }
        if (intruder) { if (a.status !== 'engaging') { a.status = 'engaging'; g.orderMove(civ, a.units, intruder.tile, true, a.formation); } }
        else if (a.status === 'engaging' || us.some((u) => dist(u.tile, o.tile) > o.radius + 1 && !u.path.length && !u.field)) { a.status = 'defending'; g.orderMove(civ, a.units, o.tile, true, a.formation); }
      } else if (o.kind === 'offensive') {
        if (o.phase === 'staging') {
          const assembled = us.filter((u) => dist(u.tile, o.staging) <= 4).length / us.length;
          const enemyStr = observedNear(g, civ, o.tile);
          const ourStr = us.reduce((s, u) => s + (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp), 0);
          const ready = assembled >= 0.85 && a.supply >= 70 && a.hp >= 75;
          const waited = g.time - o.since;
          a.note = `Assembling ${Math.round(assembled * 100)}%, supply ${a.supply}%, strength ${a.hp}%${enemyStr ? `, odds ${(ourStr / enemyStr).toFixed(1)}:1` : ''}`;
          if ((ready && (ourStr >= enemyStr * 1.2 || waited > 180)) || waited > 420) {
            o.phase = 'attacking'; a.status = 'attacking'; a.note = 'Offensive launched';
            g.orderMove(civ, a.units, o.tile, true, a.formation === 'column' ? 'line' : a.formation);
            g.notify(civ.id, `${a.name} is launching its offensive.`, { kind: 'war', tile: o.tile, level: 'major' });
            g.history(civ, 'army:' + a.name, `Offensive launched (${Math.round(assembled * 100)}% assembled, supply ${a.supply}%, odds ${enemyStr ? (ourStr / enemyStr).toFixed(1) : 'unknown'})`);
          } else if (a.status !== 'staging') a.status = 'staging';
        } else if (o.phase === 'attacking' && a.supply < 20) {
          o.phase = 'withdrawn'; a.status = 'withdrawing'; a.note = 'Out of supply: withdrawing to the staging area';
          g.orderMove(civ, a.units, o.staging, false, 'column');
          g.notify(civ.id, `${a.name} is out of supply and falling back.`, { kind: 'warning', tile: a.center, level: 'major' });
        }
      } else if ((o.kind === 'move' || o.kind === 'attackMove') && us.every((u) => !u.path.length && !u.field)) {
        if (a.status !== 'blocked') a.status = 'idle';
      }
    }
  }
}

function observedNear(g, civ, tile) {
  let s = 0;
  for (const t of disk(tile, 6)) for (const id of g.tileUnits.get(t) || []) {
    const e = g.units.get(id); if (!e || !g.hostile(civ.id, e.owner) || !civ.visible[e.tile]) continue;
    const d = UNITS[e.type]; if (!d.civilian) s += (d.atk + d.def) * (e.hp / e.maxHp);
  }
  for (const t of disk(tile, 3)) { const b = g.buildingAtTile(t); if (b && g.hostile(civ.id, b.owner) && civ.visible[t] && g.defs.BUILDINGS[b.type].attack) s += g.defs.BUILDINGS[b.type].attack * 2; }
  return s;
}

export function armySummary(g, civ) {
  return [...(civ.armies || new Map()).values()].filter((a) => a.units.length).map((a) => ({
    id: a.id, name: a.name, units: a.units, formation: a.formation, stance: a.stance, status: a.status, note: a.note, men: a.men || 0, hp: a.hp, supply: a.supply, center: a.center,
    order: { kind: a.order.kind, tile: a.order.tile, radius: a.order.radius, staging: a.order.staging, phase: a.order.phase },
  }));
}
