// The AI's memory of the world, built only from what Perception allowed it to see:
//   sightings  hostile units: last known tile, strength, when (confidence fades; forgotten after 3 min)
//   battles    where our units died, and to what (a place to approach carefully or to fortify)
//   raids      regions of our land where hostile forces keep turning up (a place to defend)
//   routes     where our moves failed (a crossing to avoid or to bridge)
// Bounded, timestamped and saved with the game, so a restored AI remembers the same things.
import { UNITS } from '../constants.js';
import { dist } from '../hex.js';

const FORGET = 180, MAX = { sightings: 400, battles: 60, raids: 40, routes: 40 };
const region = (t) => t - (t % 4);          // coarse buckets of tiles for raid patterns

export class BeliefState {
  constructor() { this.sightings = new Map(); this.battles = []; this.raids = new Map(); this.routes = []; this.lastOwn = new Map(); }

  // fold one perception into memory
  observe(g, civ, p) {
    const now = g.time;
    for (const u of p.hostiles) {
      const d = UNITS[u.type];
      this.sightings.set(u.id, { tile: u.tile, owner: u.owner, type: u.type, str: (d.atk + d.def) * (u.hp / u.maxHp), air: !!d.air, art: d.cat === 'artillery', seen: now });
      if (g.world.owner[u.tile] === civ.id) { const r = region(u.tile); const e = this.raids.get(r) || { n: 0, last: 0, tile: u.tile }; if (now - e.last > 20) e.n++; e.last = now; this.raids.set(r, e); }
    }
    for (const [id, s] of this.sightings) if (now - s.seen > FORGET) this.sightings.delete(id);
    if (this.sightings.size > MAX.sightings) { const old = [...this.sightings.entries()].sort((a, b) => a[1].seen - b[1].seen); for (let i = 0; i < old.length - MAX.sightings; i++) this.sightings.delete(old[i][0]); }
    // our losses: units that existed at the last look and are gone now died where we last saw them
    const cur = new Map(p.ownCombat.map((u) => [u.id, u.tile]));
    for (const [id, tile] of this.lastOwn) if (!cur.has(id)) { this.battles.push({ tile, at: now }); }
    this.lastOwn = cur;
    if (this.battles.length > MAX.battles) this.battles.splice(0, this.battles.length - MAX.battles);
    // failed moves
    for (const u of p.own) if (u.pathFail && now - u.pathFail.at < 3 && !this.routes.some((r) => r.tile === u.goal && now - r.at < 30)) { this.routes.push({ tile: u.goal ?? u.tile, code: u.pathFail.code, at: now }); }
    if (this.routes.length > MAX.routes) this.routes.splice(0, this.routes.length - MAX.routes);
    if (this.raids.size > MAX.raids) { const old = [...this.raids.entries()].sort((a, b) => a[1].last - b[1].last); this.raids.delete(old[0][0]); }
  }

  confidence(s, now) { return Math.max(0, 1 - (now - s.seen) / FORGET); }
  // remembered hostile strength near a tile, weighted by how sure we still are
  threatAt(tile, r, now) { let t = 0; for (const s of this.sightings.values()) if (dist(s.tile, tile) <= r) t += s.str * this.confidence(s, now); return t; }
  lossesNear(tile, r, now, window = 300) { return this.battles.filter((b) => now - b.at < window && dist(b.tile, tile) <= r).length; }
  raidedRegions(now) { return [...this.raids.values()].filter((e) => e.n >= 2 && now - e.last < 600).sort((a, b) => b.n - a.n); }

  serialize() { return { s: [...this.sightings.entries()], b: this.battles, r: [...this.raids.entries()], rt: this.routes, lo: [...this.lastOwn.entries()] }; }
  load(o) { if (!o) return; this.sightings = new Map(o.s || []); this.battles = o.b || []; this.raids = new Map(o.r || []); this.routes = o.rt || []; this.lastOwn = new Map(o.lo || []); }
}
