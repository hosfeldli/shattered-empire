// Weapon profiles: how each unit (and armed building) fires, what reaches the target, and what
// it does on arrival. Combat resolution reads these; the client renders the matching effects.
//
// mode: 'hitscan'   resolves on the firing tick (rifles, machine guns): one aggregated volley,
//                   rendered as several tracers.
//       'projectile' an authoritative projectile flies for `flight` seconds; damage on impact.
// arc:  true for indirect fire (mortars, howitzers): no line of fire needed, high trajectory.
// blast: hex radius of area damage (0 = the target only); falloff applies to the ring.
//
// targets: what the weapon can engage at all. Targeting checks these classes, never a unit's
//   other numbers: a ground-only cannon cannot shoot a fighter.
//     'ground'  units on the ground and structures
//     'air'     any aircraft
//     'lowair'  only low-flying aircraft (helicopters and drones)
//     'missile' strategic missiles (interception)
// airMul / groundMul: effectiveness against that class (default 1).
// airburst: the round bursts in the air near its target (anti-aircraft volleys); never craters.
export const WEAPONS = {
  carbine:  { name: 'Carbines',       mode: 'hitscan', cooldown: 1.5, burst: 2, supp: 5,  vsArmor: 0.5, tracer: 'light', targets: ['ground'] },
  rifle:    { name: 'Rifles',         mode: 'hitscan', cooldown: 1.8, burst: 3, supp: 8,  vsArmor: 0.35, tracer: 'light', targets: ['ground'] },
  smg_team: { name: 'Assault rifles', mode: 'hitscan', cooldown: 1.4, burst: 4, supp: 10, vsArmor: 0.6, tracer: 'light', targets: ['ground'] },
  mg:       { name: 'Machine gun',    mode: 'hitscan', cooldown: 1.6, burst: 6, supp: 16, vsArmor: 0.4, tracer: 'heavy', targets: ['ground'] },
  mg_light: { name: 'Light machine gun', mode: 'hitscan', cooldown: 1.8, burst: 4, supp: 12, vsArmor: 0.3, tracer: 'light', targets: ['ground'] },
  autocannon:{ name: 'Autocannon',    mode: 'hitscan', cooldown: 1.6, burst: 4, supp: 14, vsArmor: 0.9, tracer: 'heavy', targets: ['ground', 'lowair'], airMul: 0.5 },
  flak:     { name: 'Flak',           mode: 'hitscan', cooldown: 1.2, burst: 5, supp: 6,  vsArmor: 0.7, tracer: 'flak', targets: ['air', 'ground'], airMul: 4.5, groundMul: 0.6, missileDefense: true },
  airburst: { name: 'AA guns',        mode: 'projectile', cooldown: 1.6, flight: 0.55, blast: 0, supp: 0, vsArmor: 1, he: 0, impact: 'airburst', airburst: true, burst: 4, targets: ['air'], airMul: 1.5, missileDefense: true },
  aam:      { name: 'Air-to-air missiles', mode: 'projectile', cooldown: 2.0, flight: 0.5, blast: 0, supp: 4, vsArmor: 1, he: 0.3, impact: 'missile', guided: true, targets: ['air', 'ground'], airMul: 1.4, groundMul: 0.25 },
  bombs:    { name: 'Bombs',          mode: 'projectile', arc: true, cooldown: 3.0, flight: 0.9, blast: 1, falloff: 0.5, supp: 34, vsArmor: 1.1, he: 1.8, impact: 'artillery', salvo: 2, targets: ['ground'] },
  warhead:  { name: 'Warhead',        mode: 'projectile', cooldown: 1, flight: 0.3, blast: 1, falloff: 0.35, supp: 24, vsArmor: 1.2, he: 1.2, impact: 'missile', targets: ['ground'] },
  cannon:   { name: 'Tank cannon',    mode: 'projectile', cooldown: 2.2, flight: 0.35, blast: 0, supp: 12, vsArmor: 1.2, he: 0.4, impact: 'cannon', targets: ['ground'] },
  fortgun:  { name: 'Fortress guns',  mode: 'projectile', cooldown: 2.4, flight: 0.5, blast: 0, supp: 14, vsArmor: 1.0, he: 0.5, impact: 'cannon', targets: ['ground'] },
  mortar:   { name: 'Mortar',         mode: 'projectile', arc: true, cooldown: 3.0, flight: 1.6, blast: 1, falloff: 0.4, supp: 22, vsArmor: 0.5, he: 1, impact: 'mortar', targets: ['ground'] },
  howitzer: { name: 'Howitzer',       mode: 'projectile', arc: true, cooldown: 3.5, flight: 2.4, blast: 1, falloff: 0.5, supp: 30, vsArmor: 0.8, he: 1.6, impact: 'artillery', targets: ['ground'] },
  missile:  { name: 'Guided missiles',mode: 'projectile', cooldown: 4.0, flight: 1.4, blast: 1, falloff: 0.3, supp: 26, vsArmor: 1.3, he: 1.2, impact: 'missile', guided: true, targets: ['ground'] },
  rockets:  { name: 'Rocket pods',    mode: 'projectile', cooldown: 2.4, flight: 0.6, blast: 0, supp: 18, vsArmor: 1.1, he: 0.6, impact: 'rocket', salvo: 3, targets: ['ground'] },
  drone_strike: { name: 'Loitering munitions', mode: 'projectile', cooldown: 2.0, flight: 0.8, blast: 0, supp: 16, vsArmor: 1.2, he: 0.5, impact: 'rocket', guided: true, targets: ['ground'] },
};

// Which weapon each unit type carries (civilian units carry none).
export const UNIT_WEAPON = {
  engineer: 'carbine', scout_buggy: 'mg', militia: 'carbine', rifle_squad: 'rifle', special_forces: 'smg_team', exo_infantry: 'smg_team',
  mortar_team: 'mortar', armored_car: 'mg', field_gun: 'howitzer', mech_infantry: 'autocannon', tank: 'cannon', autonomous_tank: 'cannon',
  sp_artillery: 'howitzer', helicopter: 'rockets', missile_battery: 'missile', air_defense: 'flak', strike_swarm: 'drone_strike',
  fighter: 'aam', bomber: 'bombs', oneway_drone: 'warhead',
};
export const BUILDING_WEAPON = { town: 'mg', bunker: 'mg', fort: 'fortgun', camp: 'rifle', guard_post: 'mg_light', aa_battery: 'airburst' };

export const WEAPON_KEYS = Object.keys(WEAPONS);
export const weaponOf = (unitType) => WEAPONS[UNIT_WEAPON[unitType]] || null;

// Armoured targets resist small arms; anti-armour weapons do full damage to them.
export const ARMORED = new Set(['wheeled', 'tracked']);

// Effectiveness of a weapon against a target definition: 0 when the weapon cannot engage it.
//   targetDef.air with alt 'low' (helicopters, drones) or 'high' (fighters, bombers)
export function weaponVs(wk, targetDef) {
  const w = WEAPONS[wk]; if (!w || !targetDef) return 0;
  if (targetDef.air) {
    if (w.targets.includes('air')) return w.airMul || 1;
    if (w.targets.includes('lowair') && targetDef.alt !== 'high') return w.airMul || 1;
    return 0;
  }
  return w.targets.includes('ground') ? w.groundMul || 1 : 0;
}
export const canInterceptMissiles = (wk) => !!WEAPONS[wk]?.missileDefense;
