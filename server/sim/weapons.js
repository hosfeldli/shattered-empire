// Weapon profiles: how each unit (and armed building) fires, what reaches the target, and what
// it does on arrival. Combat resolution reads these; the client renders the matching effects.
//
// mode: 'hitscan'   resolves on the firing tick (rifles, machine guns): one aggregated volley,
//                   rendered as several tracers.
//       'projectile' an authoritative projectile flies for `flight` seconds; damage on impact.
// arc:  true for indirect fire (mortars, howitzers): no line of fire needed, high trajectory.
// blast: hex radius of area damage (0 = the target only); falloff applies to the ring.
export const WEAPONS = {
  carbine:  { name: 'Carbines',       mode: 'hitscan', cooldown: 1.5, burst: 2, supp: 5,  vsArmor: 0.5, tracer: 'light' },
  rifle:    { name: 'Rifles',         mode: 'hitscan', cooldown: 1.8, burst: 3, supp: 8,  vsArmor: 0.45, tracer: 'light' },
  smg_team: { name: 'Assault rifles', mode: 'hitscan', cooldown: 1.4, burst: 4, supp: 10, vsArmor: 0.6, tracer: 'light' },
  mg:       { name: 'Machine gun',    mode: 'hitscan', cooldown: 1.6, burst: 6, supp: 16, vsArmor: 0.4, tracer: 'heavy' },
  autocannon:{ name: 'Autocannon',    mode: 'hitscan', cooldown: 1.6, burst: 4, supp: 14, vsArmor: 0.9, tracer: 'heavy' },
  flak:     { name: 'Flak',           mode: 'hitscan', cooldown: 1.2, burst: 5, supp: 6,  vsArmor: 0.7, tracer: 'flak' },
  cannon:   { name: 'Tank cannon',    mode: 'projectile', cooldown: 2.2, flight: 0.35, blast: 0, supp: 12, vsArmor: 1.2, he: 0.4, impact: 'cannon' },
  fortgun:  { name: 'Fortress guns',  mode: 'projectile', cooldown: 2.4, flight: 0.5, blast: 0, supp: 14, vsArmor: 1.0, he: 0.5, impact: 'cannon' },
  mortar:   { name: 'Mortar',         mode: 'projectile', arc: true, cooldown: 3.0, flight: 1.6, blast: 1, falloff: 0.4, supp: 22, vsArmor: 0.5, he: 1, impact: 'mortar' },
  howitzer: { name: 'Howitzer',       mode: 'projectile', arc: true, cooldown: 3.5, flight: 2.4, blast: 1, falloff: 0.5, supp: 30, vsArmor: 0.8, he: 1.6, impact: 'artillery' },
  missile:  { name: 'Guided missiles',mode: 'projectile', cooldown: 4.0, flight: 1.4, blast: 1, falloff: 0.3, supp: 26, vsArmor: 1.3, he: 1.2, impact: 'missile', guided: true },
  rockets:  { name: 'Rocket pods',    mode: 'projectile', cooldown: 2.4, flight: 0.6, blast: 0, supp: 18, vsArmor: 1.1, he: 0.6, impact: 'rocket', salvo: 3 },
  drone_strike: { name: 'Loitering munitions', mode: 'projectile', cooldown: 2.0, flight: 0.8, blast: 0, supp: 16, vsArmor: 1.2, he: 0.5, impact: 'rocket', guided: true },
};

// Which weapon each unit type carries (civilian units carry none).
export const UNIT_WEAPON = {
  engineer: 'carbine', scout_buggy: 'mg', militia: 'carbine', rifle_squad: 'rifle', special_forces: 'smg_team', exo_infantry: 'smg_team',
  mortar_team: 'mortar', armored_car: 'mg', field_gun: 'howitzer', mech_infantry: 'autocannon', tank: 'cannon', autonomous_tank: 'cannon',
  sp_artillery: 'howitzer', helicopter: 'rockets', missile_battery: 'missile', air_defense: 'flak', strike_swarm: 'drone_strike',
};
export const BUILDING_WEAPON = { town: 'mg', bunker: 'mg', fort: 'fortgun', camp: 'rifle' };

export const WEAPON_KEYS = Object.keys(WEAPONS);
export const weaponOf = (unitType) => WEAPONS[UNIT_WEAPON[unitType]] || null;

// Armoured targets resist small arms; anti-armour weapons do full damage to them.
export const ARMORED = new Set(['wheeled', 'tracked']);
