# Ring cities and the Materials / Energy economy

Implementation status: **functional prototype; visually incomplete**. The current development
pass has no gameplay, balance, multiplayer or performance acceptance. Build and image review
are recorded in [the quality report](QUALITY_PASS_2026-11-11.md).

## Current design precedence

The ring-city brief and its final override replace the earlier flexible parcel, Supplies / Power
economy. Roads remain buildable. Field drops grant Materials; abandoned energy plants provide
capturable passive Energy. Building commands never require an engineer selection or a nearby
engineer. Engineers automatically help nearby construction and repair vehicles, buildings and
defenses while out of combat. Their pistols cannot pursue enemies or attack structures.

## Authoritative rules

- New ruleset `action-v2`, ring layout version 1, save schema 5. An `action-v1` save receives an
  explicit compatibility error. Restart an already-running development server after updating.
  Joining also requires the negotiated `ring-cities-v1` capability; older action clients cannot
  accidentally enter the new economy with incompatible UI or commands.
- All six ruin categories reserve eight world-space parcels at map creation. Candidate ruins
  must accommodate the entire dry, sufficiently level footprint. Parcels have stable IDs,
  coordinates, orientation, dimensions and required local tier; they do not use terrain cells
  as their identities. Multiple facilities can share a coarse spatial cell.
- The headquarters occupies the center without consuming a ring site. Local tiers unlock
  4, 6 and 8 sites. Only a completed local upgrade unlocks the next pair. Global technology
  records the faction's highest achieved tier and survives the loss of that headquarters.
- Normal matches start with one operational HQ, four empty sites, 500 Materials, 100 Energy,
  three rifle squads, an engineer and a scout. Sandbox presets explicitly override the setup.
- Nine ring facility choices compete for sites: Materials Processor, Energy Generator,
  Barracks, Armory, Vehicle Works, Heavy Weapons Facility, Airfield, Advanced Systems Lab and
  Strategic Missile Facility. Unit prices, training times, HQ upgrades, income and defenses use
  the new two-resource balance. The old civilian chains do not run in this ruleset.
- Command Capacity is faction-wide: 80 / 120 / 160 by global tier, plus purchased command
  upgrades, bounded by the match army limit. Capturing additional headquarters does not
  multiply capacity.
- Mobile ground units collect visible material caches on contact. The server resolves one
  collector deterministically and deposits the reward immediately. Aircraft cannot collect.
  Starting caches offer 55 / 110 Materials; a few neutral industrial or military locations
  may replenish after three minutes and only when no unit is waiting nearby. Fog retains
  last-seen cache information until revisited, without exposing unseen collections.
- Captured Materials Relays produce 30 Materials/min; abandoned energy plants produce
  18 Energy/min. They cannot host headquarters or production rings.
- Field defenses occupy independently validated world positions, never ring sites. Placement
  requires current visibility, usable terrain, clearance, no contested site, and no protected
  capture zone or active hostile headquarters compound. Construction progresses without an
  engineer; up to two nearby idle engineers provide a bounded speed bonus. Automated repairs
  consume no third resource. Explicit movement and combat orders take precedence.
- All major city ruins are connected by generated transport routes. Players can draw extra
  roads on currently visible routes for 15 Materials per new link. Completed work updates the
  authoritative road network and navigation; it does not consume development sites.
- Saves retain caches, construction, local and global progression, independent defenses,
  road projects, historical parcels and damage. The building spatial index supports multiple
  structures in each terrain cell.

## Unity presentation and controls

Selecting HQ reveals eight unobtrusive parcel corner outlines and an eight-site UI. Empty,
occupied and locked sites have distinct states. Click an empty site, hover a building for its
world preview, then click to construct. Occupied sites open the facility controls. Production
and building unlocks use global technology, while site availability uses local city tier.

Shared terrain-draped ring streets and pavements replace individual hex-shaped road loops.
Short service aprons connect facilities. Major approaches enter between inherited parcels.
Small, stable outer street fronts restore through scaffolding, walls, roofs and finishing
over approximately 35 seconds after an upgrade. Accessories are decorative, confer no hidden
income or weapons, and do not alter navigation or cover. Existing functional buildings retain
their positions. Thin building corner outlines replace the oversized selection rings.
Visual maturity is saved and pauses on headquarters loss. Reestablishing command resumes
unfinished restoration; it does not reroll or erase established accessories. Facility-remnant
history is filtered through current vision and last-seen records, including for partially
observed enemy compounds.

Material drops use batched salvage crates; selection shows the stored value, collection shows
a floating reward, a brief effect and a restrained spatial sound. Energy plants have a distinct
substation silhouette. The field menu exposes defenses, trenches and roads without selecting
an engineer. Defense ghosts display server-validated placement feedback.
Automated review runs do not overwrite the player's saved server or Continue session.

## Remaining acceptance work

Gameplay validation is deliberately deferred during this visual-only pass. Economy timing,
capture/recapture, all unit costs, engineer order arbitration, road construction, deterministic
save/rejoin and large multiplayer matches need later verification. Map fairness and the stricter
full-ring footprint require multi-seed validation. Human art and audio reviews remain open.
Automatic accessory restoration still uses procedural geometry and discrete reconstruction
stages; it is not final authored building animation. Ring-edge runway scale, road joins and
river transitions need further art review in actual matches.
