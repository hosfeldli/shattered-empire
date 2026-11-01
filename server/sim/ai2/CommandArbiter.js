// Every AI command passes through here before it reaches the game, the same authoritative command
// path a player's orders take. It refuses an order when:
//   not_owner            the units belong to a different controller (a mission, the air force…)
//   duplicate            the very same order was just given and the units are still carrying it out
//   commitment_conflict  the same units were sent somewhere far away a moment ago (no jitter)
//   insufficient_funds   it would dip into money reserved for a planned expenditure
//   repeated_failure     the same order has failed three times in a minute (stop knocking: rethink)
// and records every outcome, so diagnostics can show exactly what was ordered, refused and why.
import { dist } from '../hex.js';

const UNIT_CMDS = new Set(['move', 'attack', 'withdraw', 'hold', 'stance', 'army', 'fortifyLine', 'deploy']);
const SPEND = new Set(['build', 'train', 'batchTrain', 'upgrade', 'roadPlan', 'bridgePlan', 'trenchPlan']);

export class CommandArbiter {
  constructor(ai, board, diag) { this.ai = ai; this.board = board; this.diag = diag; this.recent = new Map(); this.fails = new Map(); this.lastMove = new Map(); this.stats = {}; }
  get g() { return this.ai.g; }

  // saved with the game: a restored AI makes exactly the decisions it would have made (replays)
  serialize() { return { r: [...this.recent.entries()], f: [...this.fails.entries()], l: [...this.lastMove.entries()], s: this.stats }; }
  load(o) { if (!o) return; this.recent = new Map(o.r || []); this.fails = new Map(o.f || []); this.lastMove = new Map(o.l || []); this.stats = o.s || {}; }

  sig(c) { return [c.c, c.units ? [...c.units].sort((a, b) => a - b).join(',') : '', c.tile ?? '', c.target ?? '', c.type ?? '', c.unit ?? '', c.id ?? ''].join('|'); }
  count(k) { this.stats[k] = (this.stats[k] || 0) + 1; }

  evaluate(c, by) {
    const g = this.g, now = g.time;
    const sig = this.sig(c);
    const f = this.fails.get(sig);
    if (f && f.n >= 3 && now - f.first < 60) return { ok: false, reason: 'repeated_failure' };
    if (UNIT_CMDS.has(c.c) && c.units?.length) {
      // ownership: a controller may only command what it controls (unassigned units are free)
      if (by) for (const id of c.units) { const o = this.board.ownerOf(id); if (o && o !== by && !c.override) return { ok: false, reason: 'not_owner' }; }
      // the same order, again, while it is still being carried out
      const r = this.recent.get(sig);
      if (r && now - r < 8 && c.units.every((id) => { const u = g.units.get(id); return u && (u.path.length || u.order?.kind !== 'idle'); })) return { ok: false, reason: 'duplicate' };
      // a far change of destination moments after the last one: hold the first decision
      // (a unit handed to a new controller in between may go wherever its new owner sends it)
      if (c.c === 'move' && c.tile >= 0 && !c.urgent) for (const id of c.units) { const l = this.lastMove.get(id); if (l && now - l.at < 4 && l.own === this.board.ownerOf(id) && dist(l.tile, c.tile) > 8) return { ok: false, reason: 'commitment_conflict' }; }
    }
    if (SPEND.has(c.c) && !c.urgent && !c.national) {
      const res = this.board.reserved(now), civ = this.ai.civ;
      let cost = null;
      try { cost = c.c === 'build' && c.type ? g.buildingCost(civ, c.type, c.tile) : c.c === 'train' && c.unit ? g.unitCost(civ, c.unit) : null; } catch { cost = null; }   // an unknown type: the game will refuse it
      if (cost) for (const [k, v] of Object.entries(cost)) if (res[k] && (civ.res[k] || 0) - v < res[k]) return { ok: false, reason: 'insufficient_funds' };
    }
    return { ok: true, sig };
  }

  submit(c, by = c.by || null) {
    const g = this.g, now = g.time;
    const ev = this.evaluate(c, by);
    if (!ev.ok) { this.count(ev.reason); this.diag?.note('refused', `${c.c}: ${ev.reason}`, by); return { error: ev.reason, refused: true }; }
    const r = this.ai.g.command(this.ai.civ.id, c);
    if (r && r.error) {
      const f = this.fails.get(ev.sig) || { n: 0, first: now };
      if (now - f.first > 60) { f.n = 0; f.first = now; }
      f.n++; this.fails.set(ev.sig, f); this.count('failed');
      if (f.n === 3) this.diag?.note('stuck', `${c.c} keeps failing (${r.error}): stop retrying, rethink`, by);
    } else {
      this.fails.delete(ev.sig); this.count('ok');
      this.recent.set(ev.sig, now);
      if (c.c === 'move' && c.tile >= 0 && c.units) for (const id of c.units) this.lastMove.set(id, { tile: c.tile, at: now, own: this.board.ownerOf(id) });
    }
    if (this.recent.size > 400) for (const [k, t] of this.recent) if (now - t > 30) this.recent.delete(k);
    if (this.lastMove.size > 600) for (const [k, l] of this.lastMove) if (now - l.at > 30) this.lastMove.delete(k);
    if (this.fails.size > 200) for (const [k, f] of this.fails) if (now - f.first > 120) this.fails.delete(k);
    return r;
  }
}
