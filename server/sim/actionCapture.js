// Site capture (workstream W2, requirement R7, 2026-11-17). Extracted from ActionGame.captureStep.
//
// Rules (constants: actionDefinitions.CAPTURE; per site: site.captureTime, set from CAPTURE when the map is built):
//  - An eligible ground unit (ACTION_UNITS[type].capture: infantry, not artillery) of a civ that is not already the
//    site's owner (or an ally of it) inside site.radius advances `site.progress` by dt per second. A city ruin takes
//    CAPTURE.base (20 s) and an outpost CAPTURE.outpost (12 s) of uncontested presence. Progress starts at 0, so a
//    capture never completes on entry.
//  - Contested (ground units of more than one team in the zone): progress is frozen, no gain and no decay.
//  - Abandoned (no claimant in the zone): progress decays at once (no grace period) at captureTime / CAPTURE.decay
//    per second, so full progress falls to 0 in CAPTURE.decay (15 s). At 0 the claim is cleared (by = -1).
//  - A different, non-allied claimant first drains the previous claimant's progress at that same decay rate, then
//    builds its own from 0. Allied claimants continue each other's progress.
//  - Headquarters sites (site.hq) are never captured here.
// `site.decaying` is true while progress fell during the last step (published to the client as `decaying`).
// Cost: one spatial query per site per call (O(sites)).
import { ACTION_UNITS, CAPTURE, OUTPOST_TYPES } from './actionDefinitions.js';
import { connectSiteRoads, planClaimRoad } from './actionBases.js';
import { emit } from './combat.js';

const decayRate = (site) => site.captureTime / CAPTURE.decay;

export function captureStep(game, dt) {
  let ownershipChanged = false;
  for (const site of game.sites) {
    if (site.hq) { site.decaying = false; continue; }
    const nearby = game.movers.query(site.x, site.z, site.radius, game.search).filter((u) => u.hp > 0 && !u.auto && game.civs[u.owner].alive);
    const teams = new Set(nearby.map((u) => game.civs[u.owner].team));
    site.contested = teams.size > 1;
    site.decaying = false;
    if (site.contested) {
      site.last = game.time;
      if (site.owner >= 0 && (site.contestedNotice ?? -20) + 18 < game.time) {
        site.contestedNotice = game.time;
        game.notify(site.owner, `${site.name} is contested.`, { kind: 'warning', tile: site.tile });
      }
      continue;
    }
    const claimant = nearby.find((u) => u.owner === site.by && ACTION_UNITS[u.type].capture) ||
      nearby.find((u) => ACTION_UNITS[u.type].capture && (site.owner < 0 || game.hostile(site.owner, u.owner)));
    if (!claimant || site.owner >= 0 && !game.hostile(site.owner, claimant.owner)) {
      if (site.progress > 0) {
        site.progress = Math.max(0, site.progress - dt * decayRate(site));
        site.decaying = site.progress > 0;
      }
      if (!site.progress) site.by = -1;
      continue;
    }
    site.last = game.time;
    if (site.by >= 0 && site.by !== claimant.owner && !game.allied(site.by, claimant.owner) && site.progress > 0) {
      // a rival claim: drain it before building our own
      site.progress = Math.max(0, site.progress - dt * decayRate(site));
      site.decaying = site.progress > 0;
      if (!site.progress) site.by = -1;
      continue;
    }
    site.by = claimant.owner;
    site.progress = Math.min(site.captureTime, site.progress + dt);
    if (site.progress + .00001 < site.captureTime) continue;
    const prev = site.owner;
    site.owner = claimant.owner;
    if (!site.reclaimed) {
      site.reclaimed = true;
      game.civs[site.owner].res.materials += site.slots ? 75 : 30;
    }
    site.claimedAt = game.time;
    emit(game, { k: 'capture', b: site.tile, bx: site.x, bz: site.z, ow: site.owner });
    site.progress = 0;
    site.by = -1;
    ownershipChanged = true;
    game.notify(site.owner, site.slots ? `${site.name} secured. Establish a headquarters.` : `${site.name} secured. ${OUTPOST_TYPES[site.kind].benefit}.`,
      { kind: 'capture', site: site.id, tile: site.tile, level: 'major' });
    if (prev >= 0) game.notify(prev, `${site.name} was captured.`, { kind: 'loss', tile: site.tile });
    // An outpost (claimed by capture, no price) links itself by a free automatic road. A city gets its road when its
    // headquarters is established, priced into the settlement (actionBases.establish); the plan made here is the
    // price shown on the ruin until then (ROADS_AND_CLAIMS.md).
    if (!site.slots) connectSiteRoads(game, site);
    else if (!site.hq) site.claimRoad = planClaimRoad(game, site);
  }
  if (ownershipChanged) game.refreshTerritory();
}
