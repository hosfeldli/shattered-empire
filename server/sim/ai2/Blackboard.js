// The civilization's shared plan state: who controls each asset, and what the treasury is promised
// to. Planners that do not own an asset may ask for it; they cannot take it. Every transfer is
// recorded with its reason. Major planned expenditures are reserved, so a city governor does not
// spend the materials the nation is saving for a fortress or the next era (food, upkeep and
// defence in an emergency still go through).
export class Blackboard {
  constructor() { this.owners = new Map(); this.transfers = []; this.reservations = new Map(); }

  ownerOf(id) { return this.owners.get(id) || null; }
  claim(id, by, why = '') {
    const cur = this.owners.get(id);
    if (cur === by) return true;
    if (cur && !why) return false;                       // taking from another controller needs a reason
    this.owners.set(id, by);
    if (cur) { this.transfers.push({ id, from: cur, to: by, why }); if (this.transfers.length > 60) this.transfers.shift(); }
    return true;
  }
  release(id) { this.owners.delete(id); }
  // keep the registry in step with the units that still exist
  prune(alive) { for (const id of this.owners.keys()) if (!alive.has(id)) this.owners.delete(id); }

  reserve(key, cost, until, why) { this.reservations.set(key, { cost, until, why }); }
  unreserve(key) { this.reservations.delete(key); }
  // what is promised, by good; `skip` leaves out reservations the game already enforces (the era)
  reserved(now, skip = null) {
    const out = {};
    for (const [k, r] of this.reservations) { if (r.until < now) { this.reservations.delete(k); continue; } if (skip && skip.includes(k)) continue; for (const [g, v] of Object.entries(r.cost)) out[g] = (out[g] || 0) + v; }
    return out;
  }

  serialize() { return { o: [...this.owners.entries()], t: this.transfers, r: [...this.reservations.entries()] }; }
  load(x) { if (!x) return; this.owners = new Map(x.o || []); this.transfers = x.t || []; this.reservations = new Map(x.r || []); }
}
