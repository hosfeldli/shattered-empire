// The civilization director: the national objective and its public face.
// The existing strategic layer chooses one goal with a commitment period and hysteresis; the
// director adds what the rework calls for around it:
//   - it decides from perception and memory (what was seen, what is remembered with fading
//     confidence, where we lost men, where raids keep coming) — never from the live simulation;
//   - campaigns are objectives with stages (prepare, stage, reconnoitre, approach, engage, capture,
//     consolidate) read from the mission that executes them, with what success looks like;
//   - reservations: the next era and big planned works are reserved on the blackboard, so city
//     governors do not spend what the nation is saving for;
//   - personality traits (not ad-hoc flags) bias how bold and how patient it is;
//   - a public posture (Expanding, Developing, Defending, Preparing, Attacking, Recovering) that other
//     players may see — the plan behind it stays private.
import { AGES, TECHS } from '../constants.js';

const POSTURE = { recovery: 'Recovering', expansion: 'Expanding', technology: 'Developing', defense: 'Defending', modernization: 'Preparing', offensive: 'Attacking', rebuild: 'Recovering', victory: 'Developing' };
const STAGE = { assemble: 'prepare', stage: 'stage', recon: 'reconnoitre', approach: 'approach', advance: 'engage', execute: 'engage', capture: 'capture', consolidate: 'consolidate', regroup: 'stage' };

export class Director {
  constructor(ai, board, belief, diag) { this.ai = ai; this.board = board; this.belief = belief; this.diag = diag; this.lastGoal = null; }
  get g() { return this.ai.g; }

  step(p) {
    const g = this.g, civ = this.ai.civ, s = civ.strategy;
    if (s && s.goal !== this.lastGoal) {
      if (this.lastGoal) this.diag.note('goal', `${this.lastGoal} -> ${s.goal}: ${s.why}`, 'director');
      this.lastGoal = s.goal;
    }
    civ.posture = POSTURE[s?.goal] || 'Developing';
    // reserve the next era's cost once it is within reach (the governors respect reservations)
    const next = g.defs.AGES[civ.age + 1];
    if (next) {
      const have = [...civ.techs].filter((t) => TECHS[t].age === civ.age).length;
      if (have >= next.techsNeeded - 1) this.board.reserve('era', next.cost, g.time + 120, `the ${next.name} era`);
      else this.board.unreserve('era');
    } else this.board.unreserve('era');
    // remembered raids on our land raise the defensive priority of those regions (used by missions)
    this.ai.raided = this.belief.raidedRegions(g.time).slice(0, 3).map((r) => r.tile);
    void p;
  }

  // the active campaign, as an objective with stages (for diagnostics and tests)
  objectives() {
    const mil = this.ai.mil, out = [];
    for (const m of mil.missions.values()) {
      if (m.kind !== 'offensive' && m.kind !== 'final') continue;
      out.push({ mission: m.id, target: m.target ?? m.lastTile, stage: STAGE[m.state] || m.state, status: this.ai.brain.monitor.status(m), units: m.units.size, success: 'our troops hold the city', history: m.history || [] });
    }
    return out;
  }
}
