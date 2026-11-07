# Native redesign and current implementation

The streamlined native design supersedes the earlier requirement for government/diplomacy UI
parity and the earlier prohibition on balance changes. The later correction removes **all trading**,
including neutral imports. The server remains authoritative. Browser/Electron code is reference only.
This document records earlier checkpoints; see [DEVELOPMENT_BACKLOG.md](DEVELOPMENT_BACKLOG.md)
for later requests and [CURRENT_WORK.md](CURRENT_WORK.md) for the latest local state. In
particular, newer native matches request `native-v3`, rather than the earlier `native-v1` noted below.

## Ruleset boundary

New Godot matches request `native-v1`. Saves carry the ruleset ID; saves without one restore as
`legacy-v1`. Unknown rulesets fail explicitly. Existing matches are not silently converted.

Native rules disable government, policy, taxation, national focus, treaties, diplomatic payments,
resource purchases and import quotes at the server command boundary. Native definitions omit
those controls and the obsolete Corporate Charter/Federal Union technologies. Local Commerce
and Commercial Halls retain ordinary domestic credit production. Roads, freight, warehouses,
production chains and military supply remain functional.

Automatic city development exposes an on/off setting and Balanced, Industry, Agriculture or
Military development priorities. Routine development uses bounded spending and preserves blocked
sites and resource reservations. Major construction remains a player decision. The existing
internal governor service supplies the automation; its administrative controls are absent from
native gameplay.

The central tempo table is `server/sim/rulesets.js`. Movement, production, research, construction,
training, growth, roads/bridges and trench work have separate rates. Food and recurring economic
consumption are adjusted together. Simulation ticks remain 10 Hz. Aircraft fuel burn is adjusted
alongside speed so endurance does not receive an accidental second penalty.

The later [simple UI](SIMPLE_UI.md) replaces permanent workspace navigation with Build, Army and
Research, plus an Overview menu and contextual selection cards. The minimap is removed. Detailed
production, air, logistics, city and army views remain contextual. Rivals
reports only observed activity and visible opponents; unknown focus stays unknown. Starting
hostilities requires a native confirmation. Inactive native wars lapse after five minutes without
active fighting/orders; this is an initial rule requiring campaign balance review.

Native trench projects preserve ordered paths and advance from endpoint fronts. A second front
is available on long lines with access at both ends. Material shortages stop a front rather than
skipping intervening segments. The native mesh uses the received route for a continuous channel,
floor, walls and parapet. Legacy trench scheduling remains unchanged for legacy matches.

## Water and atmosphere

`RiverGeometry` supplies the same curved channels to water rendering, flow boundaries and dry
building siting. Ribbon sections share vertices, eliminating the wedges between independently
oriented segments. Vegetation rejects water footprints.

Close views use `WaterMicroSimulation`: a 256 × 256 GPU pressure-wave field covering ten world
units, stepped at 120 Hz with bounded catch-up. Surface height/velocity advect along the received
river route, reflect at banks, respond to wind/rain and dissipate. The field stays on the rendering
device. Camera movement reprojects overlapping cells. A coarser CPU fallback covers headless or
unsupported rendering devices. Micro motion is presentation only and cannot flood gameplay land.

The water material emphasizes small capillary slopes and subtle current/rain motion. Broad river
heave, bright specular blobs and blanket river foam are removed. A shared GPU bank field blends
nearby exposed soil. The world footprint and water levels remain server-derived.

Cloud volume, ground/water/building shadows and precipitation share one density field. Regional
cloud snapshots interpolate and advect using the received wind/cyclones. Density noise wraps
horizontally. Cloud shadows project toward the actual sun. Rain/snow drift with local wind; haze
is restrained for the orthographic camera's long boom. Permanent daylight is preserved.

## Verification and release gates

Run native regression scripts and the server suite before packaging:

```sh
ADMIT_OFF=1 node --test test/*.test.js
godot --headless --path godot -s res://tests/render_regressions.gd
godot --headless --path godot -s res://tests/composition_regressions.gd
godot --headless --path godot -s res://tests/lwe_regressions.gd
godot --headless --path godot -s res://tests/water_weather_regressions.gd
node godot/tests/lwe-live.mjs --ui --visible --out=godot/docs/ui-validation
node godot/tests/lwe-live.mjs --water --visible --out=godot/docs/water-validation
```

The water capture uses actual server-generated terrain. Its last two images use an explicitly
labelled local weather fixture; they do not alter authoritative server weather. Reports include
runtime source hashes. A frame interval is not a GPU timestamp or a late-game performance signoff.

Still open: long seeded pace/economy measurements against era milestones, AI mission/retreat and
conflict tuning, full contextual UI/input audit, remappable shortcuts, complete LWE asset/LOD/damage
acceptance, Windows runtime testing, signing and release soak. Production publication and Cloud Run
deployment remain gated on those requirements; no production update is implied by local checks.
