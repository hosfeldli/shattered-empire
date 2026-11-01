// Plans must survive contact with the simulation. The monitor watches every active mission and
// says what is actually happening — progressing, waiting, blocked, stalled, impossible — and reacts
// to the failure, not to every flicker:
//   blocked (moves keep failing)    -> a bounded local reroute: an approach a few hexes to one side
//   stalled (no progress in a while)-> re-issue the mission's order once, then a reroute
//   still stuck after 3 attempts    -> the mission is given up with an explicit reason (its units
//                                      return to the reserve) — never stuck forever, never silently
// Strategic objectives are not dropped because one route failed.
import { dist, disk } from '../hex.js';
import { findPath } from '../path.js';
import { isWater } from '../constants.js';

const STALL = { assemble: 90, stage: 90, approach: 70, advance: 60, execute: 120, consolidate: 999, defend: 999, holding: 999, entrenched: 999, respond: 60 };

export class ExecutionMonitor {
  constructor(ai, diag) { this.ai = ai; this.diag = diag; this.track = new Map(); this.counts = { reroutes: 0, reissued: 0, abandoned: 0, recovered: 0 }; }
  get g() { return this.ai.g; }

  status(m) { return this.track.get(m.id)?.status || 'progressing'; }

  step() {
    const g = this.g, mil = this.ai.mil, now = g.time;
    for (const id of this.track.keys()) if (!mil.missions.has(id)) this.track.delete(id);
    for (const m of mil.missions.values()) {
      const ids = [...m.units].filter((x) => g.units.has(x)); if (!ids.length) continue;
      const goal = m.lastTile;
      const t = this.track.get(m.id) || { best: 1e9, since: now, tries: 0, status: 'progressing', state: m.state };
      if (t.state !== m.state) { t.state = m.state; t.best = 1e9; t.since = now; t.tries = 0; }   // a new stage: a fresh clock
      if (!(goal >= 0)) { t.status = 'waiting'; this.track.set(m.id, t); continue; }
      // progress: the mean distance of the mission's units to its objective
      let sum = 0, failing = 0;
      for (const x of ids) { const u = g.units.get(x); sum += dist(u.tile, goal); if (u.pathFail && now - u.pathFail.at < 10) failing++; }
      const d = sum / ids.length;
      if (d < t.best - 0.5) { if (t.status === 'blocked' || t.status === 'stalled') { this.counts.recovered++; this.diag?.note('recovered', `${m.kind} moving again`, 'mission:' + m.id); } t.best = d; t.since = now; t.status = d <= 2 ? 'arrived' : 'progressing'; }
      const limit = STALL[m.state] ?? 90;
      const blocked = failing >= Math.ceil(ids.length / 2);
      if (t.status === 'arrived' || d <= 2) { t.status = 'arrived'; this.track.set(m.id, t); continue; }
      if (blocked || now - t.since > limit) {
        t.status = blocked ? 'blocked' : 'stalled';
        if (t.tries >= 3) {
          // give up this mission, with the reason on record; the units go back to the reserve
          this.counts.abandoned++; this.diag?.note('abandoned', `${m.kind} toward ${goal}: ${blocked ? 'no route' : 'no progress'} after ${t.tries} attempts`, 'mission:' + m.id);
          mil.setState(m, 'abandoned', blocked ? 'no route to the objective' : 'no progress');
          mil.missions.delete(m.id); this.track.delete(m.id); continue;
        }
        if (now - (t.lastTry || 0) > 20) {
          t.lastTry = now; t.tries++;
          const alt = blocked || t.tries > 1 ? this.detour(ids, goal) : goal;
          if (alt >= 0) {
            mil.order(m, ids, alt, true, 'line'); if (alt !== goal) { m.lastTile = goal; this.counts.reroutes++; } else this.counts.reissued++;
            this.diag?.note(blocked ? 'blocked' : 'stalled', `${m.kind}: ${alt === goal ? 're-issued the order' : 'trying another approach'} (attempt ${t.tries})`, 'mission:' + m.id);
          }
        }
      }
      this.track.set(m.id, t);
    }
  }

  // a reachable approach two to four hexes to one side of the direct line
  detour(ids, goal) {
    const g = this.g, civ = this.ai.civ, u = g.units.get(ids[0]); if (!u) return -1;
    const cands = disk(goal, 4).filter((t) => dist(t, goal) >= 2 && !isWater(g.world.terr[t])).sort((a, b) => dist(u.tile, a) - dist(u.tile, b));
    for (const t of cands.slice(0, 12)) { const p = findPath(g, civ, u.tile, t, u.type, 6000); if (p && p.length) return t; }
    return -1;
  }

  serialize() { return { t: [...this.track.entries()], c: this.counts }; }
  load(o) { if (!o) return; this.track = new Map(o.t || []); this.counts = { ...this.counts, ...(o.c || {}) }; }
}
