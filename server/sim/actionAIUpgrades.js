// The action AI's per-building upgrades and outposts (2026-11-20, BASE_MENU_REWORK.md §8). Called from
// actionAI.developBases. Every purchase goes through the player commands (game.command), so the server's rules apply.
// One purchase per call, a reserve kept for production; deterministic (ordered scans only).
import { ACTION_BUILDINGS, ACTION_UNITS, CENTRE_TURRET, ENGINEER_UPGRADES, OUTPOST, PERIMETER_COST } from './actionDefinitions.js';
import { constructDefense, headquarters } from './actionBases.js';
import { centerOf, distance } from './actionNavigation.js';
import { outpostPlots } from './actionOutposts.js';

const has = (civ, cost, keep) => civ.res.materials >= (cost.materials || 0) + keep.materials && civ.res.energy >= (cost.energy || 0) + keep.energy;

/** The path a perimeter turret takes: what the AI has seen, complementing the base's other turret. */
export function choosePath(p, observed, other) {
  const armour = observed.filter((u) => ['wheeled', 'tracked'].includes(ACTION_UNITS[u.type]?.move)).length;
  const want = (p.enemyAir || 0) >= 2 ? 'aa' : armour >= 3 ? 'av' : 'ai';
  if (other !== want) return want;
  return want === 'aa' ? 'av' : want === 'av' ? 'ai' : armour >= 1 ? 'av' : 'aa';
}

/**
 * One upgrade decision: engineers at the main base, perimeter paths, the line of the unit type it fields most, the
 * centre turret when attacked, outpost tiers and plots, production building levels when rich.
 */
export function aiUpgrades(game, civ, bases, own, observed, p) {
  const eager = civ.difficulty === 'brutal' || civ.difficulty === 'expert';
  // the reserve keeps what the field works have saved up (AI_WORKS wallet) out of reach: defenses come first
  const keep = eager ? { materials: 180, energy: 60 } : { materials: 320, energy: 110 };
  keep.materials += Math.round(p.works?.wallet || 0);
  if (game.time < 600) { keep.materials += 250; keep.energy += 60; }   // the opening goes to the army and the works
  const cmd = (c) => !game.command(civ.id, c).error;
  const mine = [...game.buildings.values()].filter((b) => b.owner === civ.id && b.done);
  // 1. engineers (cheap, and every base works faster and safer)
  for (const s of bases.slice(0, 2)) {
    const hq = headquarters(game, s), next = ENGINEER_UPGRADES[s.engLevel || 0];
    if (hq?.done && !hq.upg && next && (s.tier || 1) > (s.engLevel || 0) && has(civ, next.cost, keep) && cmd({ c: 'engineerUpgrade', site: s.id })) return 'engineer';
  }
  // 2. perimeter turrets: a path answering what it sees, then deeper
  for (const s of bases) {
    const turrets = mine.filter((b) => b.site === s.id && b.type === 'city_turret' && b.perimeterSlot && !b.upg && !b.project);
    for (const t of turrets) {
      const level = t.path ? (t.level || 1) + 1 : 1;
      if (level > 3 || level > civ.age + 1 || !has(civ, PERIMETER_COST[level - 1], keep)) continue;
      const other = turrets.find((o) => o !== t && o.path)?.path || mine.find((o) => o.site === s.id && o !== t && o.path)?.path;
      if (cmd({ c: 'perimeterUpgrade', id: t.id, path: t.path || choosePath(p, observed, other) })) return 'perimeter';
    }
  }
  // 3. the line of the unit type it fields most, at the building that made most of them
  const count = new Map(), maker = new Map();
  for (const u of own) {
    if (!ACTION_UNITS[u.type]?.upgrade) continue;
    count.set(u.type, (count.get(u.type) || 0) + 1);
    if (u.src) { const k = u.type + ':' + u.src; maker.set(k, (maker.get(k) || 0) + 1); }
  }
  const types = [...count.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
  for (const type of types) {
    const hosts = mine.filter((b) => ACTION_BUILDINGS[b.type].trains?.includes(type) && !b.upg && (b.ug?.[type] || 0) < 3)
      .sort((a, b) => (maker.get(type + ':' + b.id) || 0) - (maker.get(type + ':' + a.id) || 0) || a.id - b.id);
    const b = hosts[0];
    if (!b) continue;
    const tier = (b.ug?.[type] || 0) + 1, spec = ACTION_UNITS[type].upgrade.tiers[tier - 1];
    if (Math.max(tier, ACTION_UNITS[type].tier) > civ.age + 1 || !has(civ, spec.cost, keep)) continue;
    if (cmd({ c: 'unitUpgrade', id: b.id, unit: type })) return 'unit';
  }
  // 4. the centre turret, when a base is attacked (or the stock overflows)
  for (const s of bases) {
    const hq = headquarters(game, s), next = CENTRE_TURRET.levels[hq?.gun || 0];
    if (!hq?.done || hq.upg || !next || (s.tier || 1) <= (hq.gun || 0)) continue;
    const attacked = p.state === 'Defending' && p.target === s.id;
    if ((attacked || civ.res.materials > 2200) && has(civ, next.cost, attacked ? { materials: 60, energy: 20 } : keep) && cmd({ c: 'centreTurret', site: s.id })) return 'gun';
  }
  // 5. outposts: tiers, then their plots (processors first, generators when energy binds)
  for (const fort of mine.filter((b) => b.type === 'fort').sort((a, b) => a.id - b.id)) {
    const plots = outpostPlots(game, fort);
    if (plots.length < (fort.level || 1)) {
      const type = civ.res.energy < civ.res.materials * .3 ? 'power_plant' : plots.some((b) => b.type === 'depot') ? 'power_plant' : 'depot';
      if (has(civ, ACTION_BUILDINGS[type].cost, keep) && cmd({ c: 'outpostBuild', id: fort.id, type })) return 'plot';
    } else if ((fort.level || 1) < Math.min(3, civ.age + 1) && !fort.project) {
      const cost = OUTPOST.levelCost[(fort.level || 1) - 1];
      if (has(civ, cost, keep) && cmd({ c: 'upgradeBuilding', id: fort.id })) return 'outpost';
    }
  }
  // 6. production building levels (expensive: veterancy for everything trained there) when the stock is rich
  const factory = mine.filter((b) => ACTION_BUILDINGS[b.type].levels?.effect === 'production' && !b.project && (b.level || 1) < civ.age + 1)
    .sort((a, b) => (a.level || 1) - (b.level || 1) || a.id - b.id)[0];
  if (factory) {
    const cost = ACTION_BUILDINGS[factory.type].levels.cost[(factory.level || 1) - 1];
    if (has(civ, cost, { materials: keep.materials + 700, energy: keep.energy + 200 }) && cmd({ c: 'upgradeBuilding', id: factory.id })) return 'level';
  }
  return null;
}

/**
 * An outpost (instead of the retired New Base): in own, visible territory, 4-10 hexes out from the main base toward the
 * nearest known enemy base, clear of other bases and outposts. Returns true when one was ordered.
 */
export function aiOutpost(game, civ, bases, p) {
  const home = bases[0];
  if (!home) return false;
  const forts = [...game.buildings.values()].filter((b) => b.owner === civ.id && b.type === 'fort');
  if (forts.length >= Math.min(3, bases.length + 1) || forts.some((b) => !b.done)) return false;
  const enemy = [...civ.siteIntel.values()].filter((s) => s.hq && s.owner >= 0 && game.hostile(civ.id, s.owner))
    .sort((a, b) => distance(home, a) - distance(home, b) || a.id - b.id)[0];
  const w = game.world, candidates = [];
  for (let t = 0; t < w.owner.length; t++) {
    if (w.owner[t] !== civ.id || !civ.visible[t]) continue;
    const c = centerOf(t), d = distance(home, c);
    if (d < 4 || d > 10) continue;
    if (game.sites.some((s) => distance(s, c) < (s.slots ? 3.4 : 2.6)) || forts.some((b) => distance(b, c) < 5)) continue;
    candidates.push({ c, t, score: (enemy ? distance(c, enemy) : -d) + (t % 7) * .01 });
  }
  candidates.sort((a, b) => a.score - b.score || a.t - b.t);
  for (const { c } of candidates.slice(0, 16)) {
    if (constructDefense(game, civ, 'fort', c, true).error) continue;
    if (!constructDefense(game, civ, 'fort', c).error) return true;
  }
  return false;
}
