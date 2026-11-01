// A record of why the AI did what it did, built from its actual planning data (never invented):
// goal changes with their reasons, mission transitions, refused and failing orders, recoveries and
// abandoned plans. Bounded. Players see only the public posture; the full record is for the
// developer inspector (spectators and the combat sandbox) and for tests.
export class Diagnostics {
  constructor(ai) { this.ai = ai; this.log = []; this.counts = {}; }
  note(kind, text, by = '') {
    const g = this.ai.g;
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    this.log.push({ at: +g.time.toFixed(1), kind, text, by });
    if (this.log.length > 120) this.log.shift();
  }
  // a behavioural quality summary: the things that make an opponent feel broken
  quality() {
    const a = this.ai, s = a.brain?.arbiter.stats || {};
    return {
      orders: s.ok || 0, refused: (s.duplicate || 0) + (s.not_owner || 0) + (s.commitment_conflict || 0) + (s.insufficient_funds || 0) + (s.repeated_failure || 0),
      duplicates: s.duplicate || 0, ownershipConflicts: s.not_owner || 0, jitter: s.commitment_conflict || 0, failed: s.failed || 0,
      reversals: a.mil?.reversals || 0, oscillations: a.mil?.oscillations || 0,
      stalls: (this.counts.stalled || 0) + (this.counts.blocked || 0), recovered: this.counts.recovered || 0, abandoned: this.counts.abandoned || 0,
    };
  }
  serialize() { return { log: this.log, counts: this.counts }; }
  load(o) { if (!o) return; this.log = o.log || []; this.counts = o.counts || {}; }
}
