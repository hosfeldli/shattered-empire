// Match-scoped rules. Never mutate shared constants: legacy matches keep their original rules.
export const LEGACY_RULESET = 'legacy-v1';
export const NATIVE_RULESET = 'native-v1';
export const DELIBERATE_RULESET = 'native-v2';
export const EXPANSIVE_RULESET = 'native-v3';
export const TEMPO = Object.freeze({
  infantryMovement: .65, wheeledMovement: .70, trackedMovement: .70,
  logisticsMovement: .75, aircraftMovement: .85, production: .70,
  research: .70, construction: .70, training: .75, populationGrowth: .65,
  infrastructureConstruction: .75, trenchConstruction: .65,
});
// A modest additional slowdown for new games. Production and routine consumption retain their
// calibrated balance; moving, building and research take a little more planning time.
export const DELIBERATE_TEMPO = Object.freeze({ ...TEMPO,
  infantryMovement: .60, wheeledMovement: .65, trackedMovement: .65,
  logisticsMovement: .70, aircraftMovement: .82, research: .65,
  construction: .65, training: .70, infrastructureConstruction: .70,
  trenchConstruction: .60,
});
// Consumption tied to production uses the same multiplier, preserving the food balance.
export const EXPANSIVE_TEMPO = Object.freeze({ ...DELIBERATE_TEMPO,
  infantryMovement: .50, wheeledMovement: .55, trackedMovement: .55,
  logisticsMovement: .60, aircraftMovement: .78, production: .60,
  research: .55, construction: .55, training: .60, populationGrowth: .60,
  infrastructureConstruction: .60, trenchConstruction: .50,
});
export const REMOVED_TECHS = new Set(['corporate_charter', 'federal_union']);
export const REMOVED_COMMANDS = new Set(['gov', 'policy', 'tax', 'focus', 'import', 'importQuote', 'respond', 'workforce', 'workforcePreview', 'workerLock', 'govProposal']);
export const nativeRules = (subject) => [NATIVE_RULESET, DELIBERATE_RULESET, EXPANSIVE_RULESET].includes(subject?.ruleset);
export function validateRuleset(id = LEGACY_RULESET) {
  if (![LEGACY_RULESET, NATIVE_RULESET, DELIBERATE_RULESET, EXPANSIVE_RULESET].includes(id)) throw new Error(`Unsupported match ruleset: ${id}`);
  return id;
}
export const tempo = (subject, key) => subject?.ruleset === EXPANSIVE_RULESET ? EXPANSIVE_TEMPO[key] : subject?.ruleset === DELIBERATE_RULESET ? DELIBERATE_TEMPO[key] : subject?.ruleset === NATIVE_RULESET ? TEMPO[key] : 1;
export const techEnabled = (civ, key) => !nativeRules(civ) || !REMOVED_TECHS.has(key);
export function movementRate(g, def) {
  const key = def.air ? 'aircraftMovement' : def.logistics || def.cat === 'support' && def.move === 'wheeled' ? 'logisticsMovement' : def.move === 'tracked' ? 'trackedMovement' : def.move === 'wheeled' ? 'wheeledMovement' : 'infantryMovement';
  return tempo(g, key);
}
export function normalizeNativeCiv(civ) {
  // Inert compatibility containers for shared legacy code; no native decisions or bonuses.
  civ.gov = null; civ.govCooldown = 0; civ.policies = new Set(); civ.tax = 0; civ.focus = null;
  civ.proposals = [];
  for (const key of REMOVED_TECHS) { civ.techs.delete(key); delete civ.techProgress?.[key]; }
  civ.queue = civ.queue.filter((key) => !REMOVED_TECHS.has(key));
  if (REMOVED_TECHS.has(civ.researching)) { civ.researching = null; civ.progress = 0; }
}
export function nativeDefinitions(defs, ruleset = NATIVE_RULESET) {
  const out = structuredClone(defs);
  for (const key of ['GOVS', 'POLICIES', 'FOCI', 'TAX', 'IMPORT_PRICE', 'IMPORT_PER_MARKET']) delete out[key];
  for (const key of REMOVED_TECHS) { delete out.TECHS[key]; delete out.TECH_CAT[key]; }
  for (const tech of Object.values(out.TECHS)) {
    tech.req = tech.req.filter((key) => !REMOVED_TECHS.has(key));
    tech.desc = tech.desc.replace(/;?\s*(Rationing policy|Fortification Doctrine policy|Free Markets policy|Research Grants policy|Public Works policy|Technocracy)\.?/gi, '').replace(/a trade partner, imports or recycling/g, 'recycling');
  }
  out.TECHS.trade_networks.name = 'Local Commerce';
  out.TECHS.trade_networks.desc = 'Commercial halls support productive cities and generate credits.';
  out.BUILDINGS.market.name = 'Commercial Hall';
  // Removing dead unlocks must not raise the share of meaningful research needed per era.
  for (let age = 1; age < out.AGES.length; age++) {
    const before = Object.values(defs.TECHS).filter((t) => t.age === age - 1).length;
    const after = Object.values(out.TECHS).filter((t) => t.age === age - 1).length;
    out.AGES[age].techsNeeded = Math.max(1, Math.min(after, Math.floor(defs.AGES[age].techsNeeded * after / before)));
  }
  out.RULESET = { id: ruleset, tempo: ruleset === EXPANSIVE_RULESET ? EXPANSIVE_TEMPO : ruleset === DELIBERATE_RULESET ? DELIBERATE_TEMPO : TEMPO, trading: false, administration: 'automatic' };
  return out;
}
