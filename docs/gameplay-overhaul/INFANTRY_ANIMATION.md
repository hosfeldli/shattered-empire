# Infantry animation

Code: `unity/Assets/ShatteredEmpires/Runtime/Military/UnitRenderer.Infantry.cs` holds the motion
state and the procedural soldier. `UnitRenderer.cs` (`AddSquad`, `AddFigure`) calls into it, and
`UnitRenderer.Casualties.cs` handles the procedural death fall. Squad behaviour stays in
`AddSquad`: formation, trench manning, cover dashes, mortar set-up and fallen men. This layer only
changes how each man gets to the place `AddSquad` picks for him, and how he moves while doing so.

## Motion (all soldiers, baked rig or procedural)
- **Squad point.** The 10 Hz snapshot point (already interpolated by `UnitStore`) is followed by
  a critically damped spring that is also fed the measured velocity (`TrackFoot`, pass 1).
  - Steady marching has no lag. Snapshot seams, sidesteps and short stalls are smoothed out.
  - A jump of more than 0.5 map units snaps.
  - `px/pz` stay raw, so picking, aiming, cover search and effects are unchanged.
  - Foot units (and their team ring) are drawn at the smoothed `sqX/sqZ`.
- **Soldiers.** Each man follows his place through a spring of his own, with a different
  stiffness per man. Each also trails the squad by his own reaction time: the file stretches while
  moving and closes up on a halt. He stays clamped inside the squad's team ring. When the squad
  turns, the soldiers walk round, and cover dashes and trench places are reached by moving rather
  than by blending.
- **Heading.** A soldier takes the heading `AddSquad` wants (squad facing, threat, trench, tube or
  dash direction). When he is free (auto pose, not engaged, not in a trench, not at a mortar), he
  faces along his own path, with a slow look-around at ease. The turn uses an eased angular
  velocity, capped at 3.2 rad/s standing and 7 rad/s moving.
- **Baked rig.** Each man has his own clip phase, advanced by the distance he covers (the clip
  stride is still one cycle per 0.056 map units, so no sliding). He picks walk or run from his own
  speed, so the rear man still walks to close up after the front has stopped.

## Procedural soldier (roles without a baked rig, field-gun crews)
- The gait phase advances by distance covered divided by stride length. Stride grows with speed,
  from 1.15 up to 4.2 leg lengths per cycle, varied per man, so cadence follows from speed. The
  planted foot moves back exactly as far as the body moves forward. Running shortens the stance
  and adds a flight phase, which keeps long strides within the leg's reach.
- Feet step along the direction of travel in the body frame, so backing off or moving sideways
  while aiming steps that way.
- Walking: the body is highest at mid-stance, the hips sway over the stance foot and the chest
  counter-rotates. Running: the body compresses at mid-stance, the base narrows and knees lift
  higher. Acceleration adds lean and turning adds a bank.
- Idle: breathing, a slow weight shift and a per-man foot stagger.
- Rifles bounce with the stride. Free arms (engineers) swing against the leg on the same side.
- Kneel and deploy poses are eased in and out.
- Recoil kicks the muzzle up, delayed by the same per-man reaction time as the rig's fire clip.
- A short flinch plays when the squad's HP drops.
- Death (non-rig): the knees give, the body topples with acceleration (usually backward), the arms
  fly out, it bounces once, then after 4.5 s it sinks out of view. Rigged soldiers keep the baked
  Die clip.

## LOD and cost
- Strategic zoom: only the squad spring runs (a few flops per foot unit).
- Operational (and tactical beyond the near radius): up to 4 men, one mesh each, on the same
  springs and headings, with stride bob, lean, bank and a kneel drop.
- Tactical close: baked rig (one instance per man, animated in the vertex shader), or the
  procedural figure as before. The new work is a few sin/cos and scalar springs per man.
- The state is 14 floats per man (MaxFigures = 12 per slot) plus 10 values per slot, in flat
  arrays with no per-frame allocation. It is updated only while the squad is drawn. A squad that
  wasn't drawn last frame (culled, strategic, or a different man count) re-initialises its men in
  place.

## What to check in the editor
- A squad marching a long path: no stepping at snapshot rate, and no foot sliding with either the
  rig or the procedural figure.
- Turns and halts: men swing round, rear men close up, and nobody snap-rotates.
- Under fire: dashes to cover read as runs to the spot. Also check trench entry hops and mortar
  set-up.
- Zooming across the operational and tactical boundaries: no men jumping out of place.
- Procedural deaths: buckle, topple, bounce, sink.
