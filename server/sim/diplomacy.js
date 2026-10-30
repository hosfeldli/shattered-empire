// Diplomacy: contact, war & peace, trade agreements, open borders, alliances, tribute.
import { N } from './constants.js';

const ACTIONS = {
  war: 'Declare war', peace: 'Propose peace', trade: 'Propose trade agreement', cancel_trade: 'Cancel trade agreement',
  borders: 'Propose open borders', alliance: 'Propose alliance', tribute: 'Send 100 gold', demand: 'Demand 150 gold tribute',
};
export { ACTIONS };

export class Diplomacy {
  constructor(g) {
    this.g = g;
    const n = g.civs.length;
    this.m = [];
    for (let a = 0; a < n; a++) { this.m[a] = []; for (let b = 0; b < n; b++) this.m[a][b] = a === b ? null : undefined; }
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { const r = { state: 'unmet', trade: false, borders: false, since: 0, attitude: 0 }; this.m[a][b] = r; this.m[b][a] = r; }
    this.nextProposal = 1;
  }
  rel(a, b) { return this.m[a][b] || { state: 'self' }; }

  checkContact(civ) {
    const g = this.g, w = g.world;
    for (const o of g.civs) {
      if (o === civ || !o.alive) continue;
      const r = this.rel(civ.id, o.id);
      if (r.state !== 'unmet') continue;
      let met = false;
      for (const u of g.units.values()) if (u.owner === o.id && civ.visible[u.tile]) { met = true; break; }
      if (!met) for (let i = 0; i < N; i += 1) if (w.owner[i] === o.id && civ.visible[i]) { met = true; break; }
      if (met) {
        r.state = 'peace'; r.since = g.time;
        g.notify(civ.id, `First contact with ${o.name}. You are at peace.`, { kind: 'diplo' });
        g.notify(o.id, `First contact with ${civ.name}. You are at peace.`, { kind: 'diplo' });
      }
    }
  }

  step() {
    // expire stale proposals
    for (const c of this.g.civs) c.proposals = c.proposals.filter((p) => this.g.time - p.time < 60);
  }

  act(civ, to, action) {
    const g = this.g, other = g.civs[to];
    if (!other || other === civ || !other.alive) return { error: 'invalid civilization' };
    const r = this.rel(civ.id, to);
    if (r.state === 'unmet') return { error: 'you have not met them yet' };
    switch (action) {
      case 'war': {
        if (r.state === 'war') return { error: 'already at war' };
        const treachery = r.state === 'alliance' || g.time - r.since < 120;
        r.state = 'war'; r.trade = false; r.borders = false; r.since = g.time; r.attitude -= 40;
        if (treachery) for (const c of g.cityOf(civ)) c.stability = Math.max(0, c.stability - 15);
        g.notify(-1, `${civ.name} has declared war on ${other.name}!`, { kind: 'war' });
        // allies are called to arms
        for (const ally of g.civs) if (ally.alive && ally !== other && ally !== civ && this.rel(ally.id, to).state === 'alliance' && this.rel(ally.id, civ.id).state !== 'war') {
          if (ally.isAI) { const ar = this.rel(ally.id, civ.id); ar.state = 'war'; ar.trade = false; ar.borders = false; ar.since = g.time; g.notify(-1, `${ally.name} honours its alliance and declares war on ${civ.name}!`, { kind: 'war' }); }
          else g.notify(ally.id, `Your ally ${other.name} has been attacked by ${civ.name}.`, { kind: 'diplo' });
        }
        return null;
      }
      case 'cancel_trade': r.trade = false; g.notify(to, `${civ.name} has cancelled your trade agreement.`, { kind: 'diplo' }); return null;
      case 'tribute': {
        if (civ.res.gold < 100) return { error: 'not enough gold' };
        civ.res.gold -= 100; other.res.gold += 100; r.attitude += 15;
        g.notify(to, `${civ.name} sends you 100 gold as a gift.`, { kind: 'diplo' }); return null;
      }
      case 'peace': if (r.state !== 'war') return { error: 'not at war' }; break;
      case 'trade': if (r.state === 'war' || r.trade) return { error: 'not possible now' }; break;
      case 'borders': if (r.state === 'war' || r.borders) return { error: 'not possible now' }; break;
      case 'alliance': if (r.state !== 'peace') return { error: 'must be at peace' }; break;
      case 'demand': break;
      default: return { error: 'unknown action' };
    }
    const p = { id: this.nextProposal++, from: civ.id, fromName: civ.name, action, label: ACTIONS[action], time: g.time };
    if (other.isAI) {
      const ok = other.ai ? other.ai.evaluate(civ, action) : false;
      this.resolve(other, p, ok);
      return { reply: { t: 'diploResult', to, action, accepted: ok } };
    }
    other.proposals.push(p);
    g.notify(to, `${civ.name} proposes: ${ACTIONS[action]}.`, { kind: 'proposal', proposal: p });
    return null;
  }

  respond(civ, pid, accept) {
    const p = civ.proposals.find((x) => x.id === pid);
    if (!p) return { error: 'proposal expired' };
    civ.proposals = civ.proposals.filter((x) => x !== p);
    this.resolve(civ, p, accept);
    return null;
  }

  resolve(target, p, accept) {
    const g = this.g, from = g.civs[p.from], r = this.rel(target.id, p.from);
    if (!accept) { g.notify(from.id, `${target.name} rejected: ${p.label}.`, { kind: 'diplo' }); r.attitude -= 5; return; }
    switch (p.action) {
      case 'peace': r.state = 'peace'; r.since = g.time; g.notify(-1, `${from.name} and ${target.name} have made peace.`, { kind: 'peace' }); break;
      case 'trade': r.trade = true; g.notify(from.id, `${target.name} accepted a trade agreement.`, { kind: 'diplo' }); g.notify(target.id, `Trade agreement signed with ${from.name}.`, { kind: 'diplo' }); break;
      case 'borders': r.borders = true; g.notify(from.id, `${target.name} opened their borders.`, { kind: 'diplo' }); g.notify(target.id, `Open borders with ${from.name}.`, { kind: 'diplo' }); break;
      case 'alliance': r.state = 'alliance'; r.borders = true; r.since = g.time; g.notify(-1, `${from.name} and ${target.name} have formed an alliance.`, { kind: 'diplo' }); break;
      case 'demand': {
        const amt = Math.min(150, Math.floor(target.res.gold));
        target.res.gold -= amt; from.res.gold += amt; r.attitude -= 20;
        g.notify(from.id, `${target.name} paid ${amt} gold in tribute.`, { kind: 'diplo' }); g.notify(target.id, `You paid ${amt} gold to ${from.name}.`, { kind: 'diplo' });
        break;
      }
      default: break;
    }
    r.attitude += 5;
  }
}
