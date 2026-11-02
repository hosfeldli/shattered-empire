// Building levels: production buildings grow in place instead of spreading over every hex.
// Each level adds jobs and makes every worker more productive, so a developed city produces far
// more from the same land. Level 2 needs the Industrial era, level 3 the Mechanized era.
import { BUILDINGS } from './constants.js';

export const MAX_LEVEL = 3;
export const LEVEL_JOBS = [1, 1.67, 2.34];        // job slots, relative to level 1
export const LEVEL_OUT = [1, 1.35, 1.7];          // output per staffed worker, relative to level 1
export const LEVEL_AGE = [0, 1, 2];               // era needed to reach each level
export const LEVEL_NAMES = ['', 'Expanded', 'Industrial-scale'];

// buildings with workers and output can be upgraded; housing has its own density levels
export const upgradable = (type) => { const d = BUILDINGS[type]; return !!(d && d.jobs && (d.produce || d.power > 0) && type !== 'town'); };
export const lvl = (b) => Math.max(1, Math.min(MAX_LEVEL, b.level || 1));
export function jobSlots(b) { const d = BUILDINGS[b.type]; if (!d || !d.jobs) return 0; return b.type === 'town' ? d.jobs[1] + (b.tier || 0) : Math.round(d.jobs[1] * LEVEL_JOBS[lvl(b) - 1]); }
export const outMul = (b) => (b.type === 'town' ? 1 + 0.35 * (b.tier || 0) : BUILDINGS[b.type]?.jobs ? LEVEL_OUT[lvl(b) - 1] : 1);

// City development tiers: a settlement grows into a city, a metropolis, a megacity. Each tier
// houses more people in the hub, employs more there and produces more, widens the developed
// district and steadies the population.
export const CITY_TIERS = ['Town', 'City', 'Metropolis', 'Megacity'];
export function cityTier(civ, c) {
  const p = c.pop || 0, a = civ.age || 0;
  return p >= 170 && a >= 3 ? 3 : p >= 85 && a >= 2 ? 2 : p >= 32 && a >= 1 ? 1 : 0;
}

// cost to go from level L to L+1: about the original building, with steel for the top level
export function upgradeCost(type, level) {
  const base = BUILDINGS[type].cost || {};
  const f = level === 1 ? 1.1 : 1.7;   // upgrading is the way to grow: cheaper than a new building's worth of output
  const cost = {};
  for (const [k, v] of Object.entries(base)) cost[k] = Math.round(v * f);
  if (level >= 2) cost.steel = (cost.steel || 0) + Math.round(30 + (base.materials || 0) * 0.25);
  if (!Object.keys(cost).length) cost.materials = 60 * level;
  return cost;
}
export const upgradeTime = (type, level) => Math.round((BUILDINGS[type].time || 20) * (level === 1 ? 1.2 : 1.6));

export function upgradeProblem(civ, b) {
  if (!upgradable(b.type)) return 'this building has no levels';
  if (!b.done) return 'not finished';
  if (b.upgrading) return 'already being upgraded';
  const L = lvl(b);
  if (L >= MAX_LEVEL) return 'already at the highest level';
  if ((civ.age || 0) < LEVEL_AGE[L]) return `needs the ${['Reclamation', 'Industrial', 'Mechanized'][LEVEL_AGE[L]] || 'next'} era`;
  return '';
}
