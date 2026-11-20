// Outposts as tiny bases (2026-11-20, BASE_MENU_REWORK.md §7). The build wheel's Outpost (`fort`) has three tiers (its
// era level, command upgradeBuilding): one build plot per tier, militia from tier 1, scout buggies from tier 2
// (actionDefinitions trainsAt), one engineer and a radar at tier 3 (actionEngineers.maintainOutposts,
// actionUnitUpgrades.detectRadius). Command outpostBuild { id, type }: a Materials Processor, Energy Generator or Barracks
// on the next free plot. A plot facility is an ordinary facility (it builds itself like a ring facility) with
// b.outpost = the outpost's id and b.plot = 1..3; it has no ring site (b.site 0, b.slot 0). Deterministic: the plot spot
// is the first clear one of fixed bearings around the outpost.
import { ACTION_BUILDINGS, OUTPOST, TIERS } from './actionDefinitions.js';
import { addFacility, canPay, onRoad, placeableBy } from './actionBases.js';
import { centerOf, distance, LIGHT_GROUND, tileAt, wrapX } from './actionNavigation.js';

/** The facilities standing on an outpost's plots. */
export const outpostPlots = (game, fort) => [...game.buildings.values()].filter((b) => b.outpost === fort.id);

/** Where an outpost's next plot facility of radius r goes: the first clear spot of fixed bearings, or null. */
export function plotSpot(game, civ, fort, def) {
  const taken = outpostPlots(game, fort);
  for (const ring of [fort.radius + def.radius + .42, fort.radius + def.radius + .8])
    for (let k = 0; k < 12; k++) {
      const a = (fort.yaw || 0) + [0, 2, 4, 1, 3, 5, .5, 2.5, 4.5, 1.5, 3.5, 5.5][k] * Math.PI / 3;
      const x = wrapX(fort.x + Math.sin(a) * ring), z = fort.z + Math.cos(a) * ring, tile = tileAt(x, z);
      if (tile < 0 || !placeableBy(game, civ, def, tile) || game.world.owner[tile] !== civ.id) continue;
      if (taken.some((b) => distance(b, { x, z }) < b.radius + def.radius + .12)) continue;
      if (onRoad(game, x, z, def.radius * .6)) continue;
      if (!game.nav.canStand(x, z, { ...LIGHT_GROUND, radius: def.radius })) continue;
      if (game.obstaclesAtTile(tile).some((o) => distance(o, { x, z }) < o.radius + def.radius + .05)) continue;
      if (game.sites.some((s) => distance(s, { x, z }) < s.radius + def.radius + .1)) continue;
      return { x, z, yaw: Math.atan2(Math.sin(a), Math.cos(a)), tile };
    }
  return null;
}

/** Command outpostBuild { id, type }: a facility on the outpost's next free plot (one plot per outpost tier). */
export function outpostBuild(game, civ, id, type) {
  const fort = game.buildings.get(id);
  if (fort?.owner !== civ.id || fort.type !== 'fort' || !fort.done) return { error: 'Select one of your operational outposts.' };
  if (!OUTPOST.plots.includes(type)) return { error: 'An outpost plot takes a Materials Processor, an Energy Generator or a Barracks.', code: 'type' };
  const def = ACTION_BUILDINGS[type];
  if (civ.age + 1 < def.tier) return { error: `This facility requires global Tier ${TIERS[def.tier - 1].label} technology.`, code: 'tech' };
  const plots = outpostPlots(game, fort), open = (fort.level || 1) - plots.length;
  if (open <= 0) return { error: (fort.level || 1) < 3 ? 'Every plot is in use: upgrade the outpost for another.' : 'Every plot is in use.', code: 'plots' };
  if (game.hasEnemyAt({ ...fort, radius: 1.6 }, civ.id)) return { error: 'Hostile forces contest the outpost.', code: 'enemy' };
  if (!canPay(civ, def.cost)) return { error: 'Insufficient materials or energy.', code: 'funds' };
  const spot = plotSpot(game, civ, fort, def);
  if (!spot) return { error: 'No clear ground around the outpost for another facility.', code: 'blocked' };
  const b = addFacility(game, civ, null, type, spot.tile, { point: { x: spot.x, z: spot.z, yaw: spot.yaw } });
  for (const k of ['materials', 'energy']) civ.res[k] -= def.cost[k] || 0;
  b.outpost = fort.id;
  b.site = -1;   // no ring site (site 0 is a real base: its headquarters' fall must not take the plot with it)
  for (let p = 1; p <= 3; p++) if (!plots.some((o) => o.plot === p)) { b.plot = p; break; }
  return { building: b.id, reply: { t: 'ack', building: b.id, plot: b.plot } };
}

/** Plot index labels for the client. */
export const plotPoint = (fort, b) => b ? { x: b.x, z: b.z } : centerOf(fort.tile);
