// Game creation settings (Ticket 4, 2026-11-20): the host's custom match rules, validated by the server
// (matches.js: create and the lobby 'options' / 'income' messages) and applied deterministically by the
// action simulation (actionGame.js).
//
//   rules: { startMaterials?, startEnergy?, unitSpeed?, unitRange?, unitHealth? }
//     startMaterials / startEnergy: whole numbers that replace the starting-resources preset's amounts
//       (absent: the preset, actionGame START_RES);
//     unitSpeed / unitRange / unitHealth: multipliers on every unit type's speed, weapon reach and health
//       (absent or 1: the standard game).
//   per player (a lobby seat's `income`, or rules.income[seat] at create): a multiplier on that player's income
//     (buildings, outposts) and on what its units pick up from supply and energy caches.
//
// Out-of-range or malformed values are refused with a readable message, never quietly clamped. The canonical
// rules object keeps only the values that differ from the standard game, so an all-default match saves and
// compares exactly as before. Speed and range scale the shared unit definitions (ACTION_UNITS), which every
// system reads: orders, combat, the AI, aircraft, and the client (the welcome's defs). A match runs in its own
// worker thread, so one process holds one set; applyUnitRules re-applies a game's set whenever another game in
// the same process (tests, benches) changed it. Health scales each unit as it is created (actionGame.spawn), so
// the armour classes (by definition HP) do not move.
import { ACTION_UNITS } from './actionDefinitions.js';

export const RULE_LIMITS = Object.freeze({
  startMaterials: { min: 0, max: 50000, name: 'Starting materials', integer: true },
  startEnergy: { min: 0, max: 20000, name: 'Starting energy', integer: true },
  unitSpeed: { min: .5, max: 2, name: 'Unit speed' },
  unitRange: { min: .5, max: 2, name: 'Unit range' },
  unitHealth: { min: .25, max: 4, name: 'Unit health' },
});
export const INCOME_LIMITS = Object.freeze({ min: .25, max: 4, name: 'Resource multiplier' });
const MULTIPLIERS = ['unitSpeed', 'unitRange', 'unitHealth'];

const fail = (why) => { throw new Error(why); };
const multText = (v) => `${+v.toFixed(2)}×`;

function checkValue(key, v) {
  const lim = RULE_LIMITS[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${lim.name} must be a number`);
  if (lim.integer && !Number.isInteger(v)) fail(`${lim.name} must be a whole number`);
  if (v < lim.min || v > lim.max) fail(`${lim.name} must be between ${lim.integer ? lim.min : multText(lim.min)} and ${lim.integer ? lim.max : multText(lim.max)}`);
  return lim.integer ? v : Math.round(v * 100) / 100;
}

/** A per-player resource multiplier (0.25–4, two decimals); throws a readable Error. */
export function parseIncome(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${INCOME_LIMITS.name} must be a number`);
  if (v < INCOME_LIMITS.min || v > INCOME_LIMITS.max) fail(`${INCOME_LIMITS.name} must be between ${multText(INCOME_LIMITS.min)} and ${multText(INCOME_LIMITS.max)}`);
  return Math.round(v * 100) / 100;
}

/**
 * Validate and canonicalise client rules (create opts.rules, the lobby 'options' rules). Returns a fresh object with
 * only the known, non-default values (startMaterials / startEnergy are kept whenever given). `base` (the lobby's
 * current rules) is merged first; a value of null removes that rule. Unknown keys are refused.
 */
export function parseRules(raw, base = null) {
  if (raw == null) return base ? { ...base } : {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('rules must be an object');
  const out = base ? { ...base } : {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'income') continue;   // per player: parsed by the caller (seats)
    if (!Object.hasOwn(RULE_LIMITS, k)) fail(`Unknown match rule "${k}"`);
    if (v === null) { delete out[k]; continue; }
    const value = checkValue(k, v);
    if (MULTIPLIERS.includes(k) && value === 1) delete out[k]; else out[k] = value;
  }
  return out;
}

/** The rules a game runs with: every multiplier present (1 when absent). Tolerant (saves, internal callers). */
export function normalizeRules(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  const num = (k, d) => { const v = r[k]; const lim = RULE_LIMITS[k]; return typeof v === 'number' && Number.isFinite(v) ? Math.min(lim.max, Math.max(lim.min, v)) : d; };
  const out = { unitSpeed: num('unitSpeed', 1), unitRange: num('unitRange', 1), unitHealth: num('unitHealth', 1) };
  if (r.startMaterials != null) out.startMaterials = Math.round(num('startMaterials', 0));
  if (r.startEnergy != null) out.startEnergy = Math.round(num('startEnergy', 0));
  return out;
}

/** The starting stockpile: the preset's amounts with the rules' own amounts in their place. */
export function startResources(preset, rules) {
  return { materials: rules?.startMaterials ?? preset.materials, energy: rules?.startEnergy ?? preset.energy };
}

/** True when the rules change nothing (the standard game). */
export const standardRules = (rules) => !rules || Object.keys(parseRules(rules)).length === 0;

// The pristine unit values, captured once (after actionDefinitions' own load-time adjustments).
const BASE = new Map(Object.entries(ACTION_UNITS).map(([k, d]) => [k, { speed: d.speed, range: d.range, atgm: d.atgm?.range }]));
let active = '1|1|1', health = 1;

/** A unit type's maximum health under the applied rules (the health multiplier; actionGame.spawn, unit upgrades, saves). */
export const unitHp = (d) => (health === 1 ? d.hp : Math.max(1, Math.round(d.hp * health)));

/** Scale every unit type's speed and reach for these rules (no-op when they are already applied); set the health factor. */
export function applyUnitRules(rules) {
  const s = rules?.unitSpeed ?? 1, r = rules?.unitRange ?? 1, key = `${s}|${r}|${rules?.unitHealth ?? 1}`;
  if (key === active) return false;
  health = rules?.unitHealth ?? 1;
  for (const [k, d] of Object.entries(ACTION_UNITS)) {
    let base = BASE.get(k);
    if (!base) BASE.set(k, base = { speed: d.speed, range: d.range, atgm: d.atgm?.range });
    if (typeof base.speed === 'number') d.speed = base.speed * s;
    if (typeof base.range === 'number') d.range = base.range * r;
    if (d.atgm && typeof base.atgm === 'number') d.atgm.range = base.atgm * r;
  }
  active = key;
  return true;
}

/** A short human summary of non-standard rules (match info, logs): "Units: speed 1.5×, health 2×". */
export function describeRules(rules, incomes = []) {
  const r = rules || {}, parts = [];
  if (r.startMaterials != null || r.startEnergy != null) parts.push(`Start: ${r.startMaterials ?? 'preset'} Materials, ${r.startEnergy ?? 'preset'} Energy`);
  const units = [['unitSpeed', 'speed'], ['unitRange', 'range'], ['unitHealth', 'health']].filter(([k]) => r[k] != null && r[k] !== 1).map(([k, n]) => `${n} ${multText(r[k])}`);
  if (units.length) parts.push(`Units: ${units.join(', ')}`);
  const inc = incomes.map((v, i) => (v != null && v !== 1 ? `P${i + 1} ${multText(v)}` : null)).filter(Boolean);
  if (inc.length) parts.push(`Income: ${inc.join(', ')}`);
  return parts.join(' · ');
}
