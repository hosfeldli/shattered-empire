// Pass 7 (perf): the combat target index (game.targets) with each cell's entries also kept per side, so target
// acquisition can skip the shooter's own side without visiting it. In a big battle most of what stands within a
// weapon's range is friendly: acquire() used to read every entry in range and reject the friendly ones one by one.
//
// hostileQuery() returns the same entries, in a different order, as query() minus the ones on the given side, plus each
// entry's rank: its position in the order query() would have returned it. Acquisition breaks a tie in score by rank,
// so it picks exactly the target it picked when it walked query()'s list and kept the first best (test: stateHash on
// fixed seeds, docs/performance/IMPLEMENTATION_LOG.md Pass 7).
import { SpatialIndex } from './actionNavigation.js';

const SEQ = 2 ** 26;   // rank = cell visit order * SEQ + insertion order (cells hold far fewer entries than this)

export class TargetIndex extends SpatialIndex {
  constructor(size, game) {
    super(size);
    this.game = game;
    this.sides = new Map();   // cell key -> Map(side -> { items: [], seqs: [] })
    this.seq = 0;
    this.skipSide = undefined; this.ranks = []; this.visit = 0;
  }

  /** The side an owner fights on: its team (owners >= 0); every negative owner is its own side. */
  sideOf(owner) {
    if (owner >= 0) { const t = this.game.civs[owner]?.team; return t === undefined ? -1e6 - owner : t; }
    return -1000 + owner;
  }

  clear() { super.clear(); this.sides.clear(); this.seq = 0; }

  add(object) {
    super.add(object);
    const key = this.key(object.x, object.z), side = this.sideOf(object.owner);
    let cell = this.sides.get(key);
    if (!cell) this.sides.set(key, cell = new Map());
    let list = cell.get(side);
    if (!list) cell.set(side, list = { items: [], seqs: [] });
    list.items.push(object); list.seqs.push(this.seq++);
  }

  moved(object, oldX, oldZ) {
    const old = this.key(oldX, oldZ);
    if (old === this.key(object.x, object.z)) return;
    const list = this.sides.get(old)?.get(this.sideOf(object.owner));
    if (list) { const i = list.items.indexOf(object); if (i >= 0) { list.items.splice(i, 1); list.seqs.splice(i, 1); } }
    super.moved(object, oldX, oldZ);   // removes from the plain cell and calls this.add (new insertion order, as before)
  }

  /** query() without the entries of `side`; `this.ranks[i]` is out[i]'s position in query()'s order. */
  hostileQuery(x, z, radius, out, side) {
    this.skipSide = side; this.ranks.length = 0; this.visit = 0;
    try { return this.query(x, z, radius, out); } finally { this.skipSide = undefined; }
  }

  read(x, z, r, out, minX, maxX) {
    if (this.skipSide === undefined) { super.read(x, z, r, out, minX, maxX); return; }
    const s = this.size, left = Math.floor((x - r) / s), right = Math.floor((x + r) / s);
    const top = Math.floor((z - r) / s), bottom = Math.floor((z + r) / s);
    for (let ix = left; ix <= right; ix++) for (let iz = top; iz <= bottom; iz++) {
      const cell = this.sides.get(ix * 2048 + iz);
      const v = this.visit++;
      if (!cell) continue;
      for (const [side, list] of cell) {
        if (side === this.skipSide) continue;
        const items = list.items, seqs = list.seqs;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.x >= minX && item.x < maxX && (item.x - x) ** 2 + (item.z - z) ** 2 <= r * r) { out.push(item); this.ranks.push(v * SEQ + seqs[i]); }
        }
      }
    }
  }
}
