# Warthog ground-attack jet and natural flight (2026-11-19)

User request: turn the fighter into an A-10-style Warthog that makes strafing runs with a powerful gun
but is slow and weak to anti-aircraft fire; make planes fly natural attack runs instead of circling;
smooth helicopter movement.

## The Warthog (unit key `fighter`)

The key stays `fighter`: saves, the wire protocol, client tables and the AI keep working. Only its name,
weapon, stats and behaviour changed.

| | Fighter (before) | Warthog (after) |
|---|---|---|
| Name / glyph | Fighter / Fi | Warthog / Wh |
| Role (legacy ruleset) | `fighter` (interceptor) | `attack` (ground attack) |
| Weapon | `aam` air-to-air missiles (air 1.4x, ground 0.25x) | `gau8` 30 mm rotary cannon, ground only, vsArmor 1.3 |
| HP | 120 | 110 |
| Attack | 16 | 26 |
| Speed (action RTS, units/s) | 6.5 (fastest aircraft) | 3.8 (slower than the bomber 4.2; helicopter 3.4) |
| AA damage taken | 1x | 1.35x from any anti-aircraft weapon (`aaVulnerable`) |
| Ability | Air Superiority Patrol | Gun Run (point; strafes everything around it) |
| Cost / fuel / altitude class | unchanged (315/160, 51 s, `high`) | unchanged |

`alt` stays `high`, so small arms and autocannons still cannot reach it (as for every jet); only flak,
AA batteries and upgraded city AA can. With 1.35x vulnerability an air defense vehicle kills it in about
three volleys, an AA battery in two: flying gun runs into air defense is costly.

### Counters and the air-to-air role

No aircraft carries an air-to-air weapon any more. Aircraft are countered by air defense vehicles, AA
batteries and upgraded city perimeters. The AI no longer answers enemy air with jets (`airChoice`): it
builds air defense (`buildArmy` already did), and uses Gun Run against ground forces that observed air
defense does not cover (`tacticalSupport`). In the legacy hex ruleset the Warthog flies patrol, strike and
support missions against ground threats; nothing is selected for air targets (`autoSelect`), the AI planner
keeps ~30% Warthogs in its air mix and sends them on strikes.

### Strafing runs (server/sim/actionFlight.js)

`attackRuns` drives a run state on the aircraft (`u.run`, plain data, saved with the unit):

1. **reposition**: fly to an initial point 5.6 units short of the target on the chosen attack heading;
2. **run**: line up with cross-track guidance onto the attack line and fly it straight, diving to 0.5;
   between 2.5 and 0.6 units short of the target, if within 0.4 of the line and 0.4 rad of its heading,
   the Warthog fires a one-second burst: the impacts walk 1.45 units along its own ground track through the
   target, damaging every hostile ground unit or structure within 0.22 (+ its radius) of each tick's segment
   (`atk x 0.55` per tick, ~85 per pass on a tank; buildings take 0.55x);
3. **extend**: carry on straight 3 units past the target and climb;
4. **reposition** again onto a new heading: the reciprocal offset 0.5 rad to whichever side needs less turn.

Explicit attack orders run until the target dies; Gun Run, strike and patrol orders acquire ground
targets around their point (armour first). A strike order for the Warthog becomes a gun run. The bomber uses
the same runs for explicit attacks, releasing its bombs as it passes over. One `strafe` event per burst
carries the line of impacts (`ax,az -> bx,bz`) and its duration `f`.

## Flight model (server, deterministic)

`flyAircraft` replaces the aircraft branch of `unitMotion` (one line in actionOrders.js).

* **Fixed-wing** (Warthog, bomber): always moving; the turn rate is capped at speed / radius (1.45 / 2.0) and
  itself changes at a limited roll rate, so turns are banked curves, never heading snaps. Waypoints inside the
  turning circle are not chased in circles: the aircraft holds course until it can turn onto them. Racetrack
  and route patterns from actionAir.js are flown through; with nothing to do it orbits.
  Landing approaches slow down and descend.
* **Helicopters and drones**: velocity steering with limited acceleration (0.85x speed per second for the
  helicopter): they speed up and slow down smoothly, brake to a hover on arrival, curve between headings and
  fly through station circuits without stopping at each point. The nose follows the flight path, or the target
  while hovering.

## Client (Unity)

* Model: `tools/blender/build_military.py warthog()` -> `Resources/Models/Warthog.bytes` (straight wing, twin
  engine pods, twin fins, nose cannon); `MilitaryMeshes.Warthog()` and `MeshKit.Fighter` are the code-built
  fallbacks. Icon redrawn; role texts updated.
* Smoothing: `UnitStore.SmoothPosition` (cubic Hermite through the snapshots with the server velocities as
  tangents) and `SmoothAltitude`; FlySnapshot follows that curve. `UnitRenderer.Flight.cs`: pitch from the
  climb/dive angle for jets, from forward acceleration for helicopters (nose down accelerating, flare when
  braking), helicopter hover bob when slow; bank as before from the turn.
* Gun runs: `GameBootstrap.GunRun.cs` plays each `strafe` event for its duration: flickering muzzle flash at the
  drawn aircraft's nose, a dense tracer stream and dust/flash/spark impacts walking along the line
  (`EffectsRenderer.GunRun.cs`, light particles, no light/shake per round). Sound `gun_run`: a recording
  `gun_run_01/02` if added, otherwise `AudioSynth.GunRun` (procedural ~65 Hz "brrrt").

## Tests

`test/warthog-flight.test.js`: Warthog stats and counters, strafing runs (several passes from different
headings, limited turn rate and roll, dive, both tanks in the line hit), Gun Run ability, bomber runs,
helicopter acceleration/braking, idle jets keep flying, determinism. Updated: `air.test.js` (target classes),
`action-wave2.test.js` (air mix).

## Needs visual verification in the editor

Warthog model scale/orientation and paint; jet banking and pitch in runs; helicopter pitch/bob; the gun-run
muzzle, tracers, impacts and sound volume; the run geometry at gameplay zoom.
