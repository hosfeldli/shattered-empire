// The AI's coordination layer (see the module headers): perception and memory, the director,
// the shared blackboard, the command arbiter and the execution monitor, with diagnostics. The
// existing planners (economy governors, military missions, air planner, research, diplomacy) keep
// doing the domain work; this layer decides what they may know, who controls what, which orders
// actually go out, and whether plans are working.
import { perceive } from './Perception.js';
import { BeliefState } from './BeliefState.js';
import { Blackboard } from './Blackboard.js';
import { CommandArbiter } from './CommandArbiter.js';
import { ExecutionMonitor } from './ExecutionMonitor.js';
import { Director } from './Director.js';
import { Diagnostics } from './Diagnostics.js';
import { profileOf } from './BehaviorProfile.js';
import { UNITS, aiProfile } from '../constants.js';

export class Brain {
  constructor(ai) {
    this.ai = ai;
    this.diag = new Diagnostics(ai);
    this.board = new Blackboard();
    this.belief = new BeliefState();
    this.arbiter = new CommandArbiter(ai, { ownerOf: (id) => this.ownerOf(id), reserved: (now) => this.board.reserved(now, ['era']) }, this.diag);
    this.monitor = new ExecutionMonitor(ai, this.diag);
    this.director = new Director(ai, this.board, this.belief, this.diag);
    this.prevOwner = new Map();
  }
  get profile() { return profileOf(this.ai.civ, aiProfile(this.ai.civ).skill); }

  // who controls a unit right now: its mission, the air force, an explicit claim, or nobody (free)
  ownerOf(id) {
    const ai = this.ai, m = ai.mil.owner(id);
    if (m) return 'mission:' + m;
    const u = ai.g.units.get(id);
    if (u && UNITS[u.type].air) return 'air';
    return this.board.ownerOf(id);
  }

  // before the planners run: look, remember, and settle the national objective
  begin() {
    const g = this.ai.g, civ = this.ai.civ;
    this.perception = perceive(g, civ);
    this.belief.observe(g, civ, this.perception);
    this.director.step(this.perception);
  }
  // after they ran: check the plans, keep ownership records honest
  end() {
    this.monitor.step();
    const alive = new Set(this.perception.own.map((u) => u.id));
    this.board.prune(alive);
    for (const u of this.perception.ownCombat) {
      const o = this.ownerOf(u.id), p = this.prevOwner.get(u.id);
      if (p && o && p !== o) { this.board.transfers.push({ id: u.id, from: p, to: o, at: +this.ai.g.time.toFixed(1) }); if (this.board.transfers.length > 60) this.board.transfers.shift(); }
      if (o) this.prevOwner.set(u.id, o); else this.prevOwner.delete(u.id);
    }
    for (const id of this.prevOwner.keys()) if (!alive.has(id)) this.prevOwner.delete(id);
  }

  report(full) {
    const civ = this.ai.civ;
    const out = { posture: civ.posture, goal: civ.strategy?.goal, why: civ.strategy?.why };
    if (!full) return { posture: out.posture };
    return { ...out, objectives: this.director.objectives(), quality: this.diag.quality(), monitor: this.monitor.counts, reserved: this.board.reserved(this.ai.g.time), transfers: this.board.transfers.slice(-10), memory: { sightings: this.belief.sightings.size, battles: this.belief.battles.length, raids: this.belief.raidedRegions(this.ai.g.time).length, routes: this.belief.routes.length }, log: this.diag.log.slice(-25), traits: this.profile.traits };
  }

  serialize() { return { b: this.board.serialize(), m: this.belief.serialize(), x: this.monitor.serialize(), d: this.diag.serialize(), a: this.arbiter.serialize(), po: [...this.prevOwner.entries()], lg: this.director.lastGoal }; }
  load(o) { if (!o) return; this.board.load(o.b); this.belief.load(o.m); this.monitor.load(o.x); this.diag.load(o.d); this.arbiter.load(o.a); this.prevOwner = new Map(o.po || []); this.director.lastGoal = o.lg ?? null; }
}
