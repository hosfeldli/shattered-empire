// Intelligence is derived only from the viewer's visible units, territory and known conflicts.
import { UNITS } from './constants.js';
export function rivalIntel(g, viewer, other) {
  const relation = g.diplomacy.rel(viewer.id, other.id);
  const state = !other.alive ? 'defeated' : relation.state === 'unmet' ? 'unknown' : relation.state === 'war' ? 'war' : relation.state === 'hostile' ? 'hostile' : 'peaceful';
  if (state === 'unknown' || state === 'defeated') return { state, posture: 'Focus unknown', focus: null, activity: 'No current observations' };
  const seen = [...g.units.values()].filter((u) => u.owner === other.id && viewer.visible[u.tile] && g.detects(viewer.id, u) && !UNITS[u.type].civilian);
  const attacking = seen.filter((u) => u.order?.kind === 'attack');
  const opponents = new Set();
  for (const u of attacking) {
    const target = u.order.target;
    const entity = target?.kind === 'unit' ? g.units.get(target.id) : g.buildings.get(target?.id);
    if (entity && viewer.visible[entity.tile] && (target.kind !== 'unit' || g.detects(viewer.id, entity)) && (entity.owner === viewer.id || g.diplomacy.rel(viewer.id, entity.owner).state !== 'unmet')) opponents.add(entity.owner);
  }
  return { state, posture: attacking.length ? 'Engaged in combat' : seen.some((u) => u.path?.length) ? 'Moving forces' : seen.length ? 'Holding positions' : 'Focus unknown',
    focus: opponents.size === 1 ? [...opponents][0] : null,
    activity: attacking.length ? 'Fighting observed forces' : seen.length ? 'Military activity observed' : 'No current military observations' };
}
