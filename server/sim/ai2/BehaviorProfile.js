// Personality as a few stable traits (0..100), separate from competence (the difficulty level).
// Every AI, however inexperienced, is equally reliable: valid orders, finished plans, no flip-flops.
// What differs is judgment: how aggressive, how much risk it accepts, how patient it is, how far it
// looks ahead, how often it scouts. Traits never change during a match; experience (heavy losses)
// only tempers the current plan.
export const TRAITS = {
  builder: { aggression: 30, riskAversion: 65, patience: 80, territorial: 70, diplomacy: 70 },
  merchant: { aggression: 25, riskAversion: 70, patience: 65, territorial: 45, diplomacy: 90 },
  warlord: { aggression: 85, riskAversion: 35, patience: 55, territorial: 75, diplomacy: 30 },
};

// competence by skill level (from the difficulty): planning horizon, scouting cadence, how well it
// estimates enemy strength (an inexperienced AI can misjudge, then commits to its misjudgment)
export function competence(skill) {
  const lv = skill?.level ?? 1;
  return { level: lv, horizon: [60, 120, 180, 240, 300][lv] ?? 120, reconEvery: [240, 150, 100, 70, 50][lv] ?? 150, estimateError: [0.35, 0.2, 0.12, 0.06, 0.04][lv] ?? 0.2, counterAware: lv >= 2, flanking: lv >= 3 };
}

export function profileOf(civ, skill) { return { traits: TRAITS[civ.personality] || TRAITS.builder, comp: competence(skill) }; }
