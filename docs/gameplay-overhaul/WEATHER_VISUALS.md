# Weather visuals: where the storms are

Player report: storms and weather "are not clearly communicated, there are no clouds that come in or darkness or
audio that would indicate where they are." Before this pass, `Atmosphere` sampled the weather only at the camera
focus and changed the global light, sky and lightning, so nothing showed where a storm was.

The server is unchanged. It already sends the full regional grid (`server/sim/weather.js` snapshot `wx`: 8x8-hex
cells of cloud, rain, fog, wet and storm, plus wind and cyclones, every 5 simulated seconds when the version
changes). The client now draws that grid in the world.

## Storm systems (2026-11-19)

Player request: "use a weather simulation and cloud simulation for moving hurricanes and large storms, it shouldn't
look cheesy, and they should only come every once in a while." The background weather is now fair to lightly
overcast; real storms are rare, scheduled, travelling systems.

### Simulation (server, `server/sim/weather.js`, deterministic)
- **Schedule.** At most one large system alive at a time. The first arrives 6–12 minutes in
  (`STORM_SCHEDULE.first/firstSpan`, in 5 s weather steps); each later one 9–18 minutes after the previous one has
  died. A system lives 4.5–9 minutes. Measured over 24 seeds × 45-minute matches: about 2.1 systems a match (always
  1–3), a system alive about 25–30% of the time, none in the opening (`test/weather-storms.test.js`).
- **Kinds.** `hurricaneOdds = min(.75, seaShare × 1.6)`: watery maps mostly get hurricanes, dry maps squall lines.
  - *Squall line*: half-length 0.3–0.38 × the map's shorter side. Born just beyond the upwind edge (heading = the
    prevailing wind ± 20°), crosses the map in 4.5–6 minutes. A bowed convective line (storm) just behind the
    leading edge, a shelf cloud on the edge, trailing stratiform rain behind.
  - *Hurricane*: radius 0.19–0.24 × the shorter side. Born over the sea-richest of 16 candidate points, heading for
    the land mass ± 35°, crossing in 7–9 minutes on a constant-curvature track (turn ±0.0008–0.0024 rad/s). Eye
    (clear, calm), eyewall at 0.2 R (the strongest storm), spiral bands, central dense overcast. Counter-clockwise
    from above in the north half, clockwise in the south. `fuel`: +0.02 per step over sea, −0.035 over land
    (min 0.3), so it fills after landfall.
- **State** per system: `{id, kind, x, z, h, v, turn, r, s, peak, fuel, spin, age, life, name}` in world units (x
  east, z south). Motion is parametric (`x += cos h · v · 5; z += sin h · v · 5; h += turn · 5` per step, no
  random draws after birth), intensity `s = peak · grow(age) · decay(age) · fuel` (`systemIntensity`). The track
  wraps in x on wrapping maps; the system dies at the end of its life or when it leaves the map in z (or in x on
  non-wrapping maps).
- **Field.** `systemProfile(sy, dx, dz) → [cloud, storm, rain]`, axisymmetric for hurricanes. Each step it is
  stamped into the regional grid: cloud and rain averaged over five sub-samples per cell, storm the maximum (so a
  narrow squall line still grounds the bases it crosses). The background field relaxes back afterwards, leaving
  a short trail of cloud and wet ground. The systems also add to the advecting wind (hurricane swirl and inflow,
  squall gust front), so the background cloud wraps around them.
- **Gameplay** (unchanged mechanics, now driven by the systems): `stormAt ≥ .5` grounds aircraft at bases and slows
  and drains aircraft inside (eyewall, squall line); rain `> .45` slows off-road movement (≤ +15%); `fogAt` is now
  `max(fog, storm × .75)`, so the driving rain in a storm core costs one hex of vision like dense fog. The random
  "stormy fronts" and the cyclones that used to make storms every few minutes no longer form (legacy cyclones in old
  saves finish their life). Sea humidity was lowered so open water is lightly overcast rather than raining.
- **Saves.** `serialize()` adds `systems`, `nextSys`, `sysAt`. A save from before has none alive and schedules the
  first one 6–12 minutes after the restore (deterministically from `ver`, no rng draw).
- **Snapshot.** `wx.sys = [{id, k, x, z, h, v, t, r, s, sp, a, l, n}]` (a few hundred bytes, only while a system lives).

### Client
| Piece | File | What it does |
|---|---|---|
| Records | `Core/Protocol/WorldRecords.cs` | `StormSystemRecord`, `WeatherState.Systems` (decoded from `wx.sys`). |
| Systems | `Runtime/Effects/StormSystems.cs` | The systems eased between the previous and latest snapshot with the same blend as the weather texture (`WeatherField.Blend`), so clouds, rain and ground shade stay together. A newborn system slides in fading up; a vanished one carries on along its track fading out (no popping). Publishes `_SE_WxSys[8]` / `_SE_WxSysN`. CPU mirror of `systemProfile` (minimap, hover), wind, exact forecast track (`systemTrackAt`). |
| Cloud deck | `Runtime/Effects/StormSky.cs`, `Resources/Shaders/StormSky.shader` | One quad at y = 20 (`SE_SKY_Y`) around the focus, one draw call. Per pixel: the background cloud from the weather texture and the dominant system's field, shaped by domain-warped fbm from a 256² tileable noise texture built at start-up (RGBA: fbm 4/8/16 and cellular billows). Hurricanes are sampled in near-conformal log-polar coordinates turning with the flow (faster at the eyewall; two phases cross-faded every 22 s so the shear never winds up), with a ragged eye, solid eyewall and central dense overcast, noise-frayed spiral bands and a faint outflow veil turning the other way. Squall lines are sampled in line coordinates: bubbling convective cells along the line, a striated shelf cloud on the leading edge, a ragged trailing deck. Lit from the sun by the density gradient (grey-blue lee sides, bright crowns), darker and flatter in storm cores, flickering with lightning and lit by strikes. Pixels without cloud leave after one texture read and the analytic test. Replaces the billboard cloud puffs (StormClouds mode 0 is no longer drawn). |
| Ground shade | `SECommon.hlsl` (`SE_SysProfile`, `SE_SystemsAt`, `SE_StormShade`) | Every world shader darkens and desaturates under a system's deck (spiral bands included, read where the sun ray meets the deck, broken up by one noise sample), on top of the regional storm shade. |
| Rain shafts | `StormClouds.cs` / `StormClouds.shader` | Curtains follow the system's exact field inside it (the eye stays dry), are softer, and fade out at strategic zoom where the deck covers them. |
| Audio | `WeatherPresenter.Hear` | `StormNear` also rises as a system's edge approaches (storm wind bed); distant thunder rumbles from a system up to ~2× earshot away every few seconds (3D voice in its direction, delay by distance) before any strike is in range. |
| Wind | `WeatherPresenter.SystemWind` → `Atmosphere.ExtraWind` | The system's wind at the focus is added to the effects wind (smoke, rain slant, `_SE_Wind`). |
| Minimap | `WeatherPresenter.Minimap` | The storm layer is now 3 texels per weather cell and includes the system's field, its centre (eye) and a dotted forecast track for the next four minutes (amber, fading). |
| Hover | `WeatherPresenter.SystemInfo`, `Hud.StormInfo` | Hovering open ground anywhere under a system's cloud: "Hurricane Ada · Weather · category 3", what it does there (grounded / the eye / rain), and "Moving north-east at 6 hexes a minute · holding strength / weakening". |
| Stress scenario | `Core/Stress/StressScenario.cs` | Carries a hurricane south of the city and a squall line north-east, for profiling and screenshots. |

**Zoom:** the deck is absent below camDistance 28, fades in to a translucent layer (≈55%) at mid zoom with a hole
where the camera looks at the battle (closing by 180), and is near-solid for storm systems at strategic zoom.
Fair-weather cloud stays a thinner veil (55–85%). Weather intensity 0 hides the deck and the shade.

**Performance:** one extra draw call. Clear pixels: one weather texture read plus a loop over (usually zero or one)
systems. Cloud pixels: 4 noise reads per fbm, 2 fbm for background, 4 for a hurricane (two phases × sun offset), 2
for a squall. `SE_ApplyFog` gains the analytic system test and one noise read only under a system. Server: the
stamping costs about 0.2 ms per 5 s step at 256² maps.

**Editor note:** after re-importing `StormSky.shader` in play mode, the material created at start-up draws nothing
until play mode restarts (create a new material, or restart).

## Design (regional weather, 2026-11-17)

| Piece | File | What it does |
|---|---|---|
| Weather texture | `Runtime/Effects/WeatherField.cs` | Two RGBA32 textures with one texel per weather cell (r cloud, g rain, b storm, a wet): the previous and the latest snapshot. The textures are rewritten only when a new snapshot arrives. Per frame it sets 3 shader vectors: the blend `f`, the advection offsets and the scale. Between snapshots the shown field is `lerp(prev(x - u f), next(x + u (1-f)), f)`, where `u` is the server's prevailing-wind step (weather.js `vx, vy`). Cloud banks therefore glide downwind instead of fading in place. The interval is measured from arrivals, so it follows the game speed. The same interpolation runs on the CPU (`Sample`, `SampleCells`) for the audio, the strike scheduler and the minimap. `StormCell(tile)` reads the raw cell value, exactly as the server's air rules do. |
| Ground darkening | `Resources/Shaders/SECommon.hlsl` (`SE_WeatherAt`, `SE_StormShade`, `SE_StrikeLight`, applied in `SE_ApplyFog`) | Every world shader (terrain, water, units, buildings, overlays, decals, ground waves) calls `SE_ApplyFog`. Under heavy cloud and storms the colour is up to 55% darker, cooler and less saturated. The weather is read where the sun ray meets the cloud base (y = 17), so the shade sits under the clouds as drawn. A noise term breaks up the cell edges. Recent lightning strikes light about 24 world units around them. `SE_CloudShadow` (the terrain's drifting cloud patches) now uses the regional cloud cover instead of the camera's. |
| Wet ground | `Terrain.shader` (one line) | Ground under falling rain looks wet at once (regional rain), as well as the server's slower wetness. |
| Clouds, rain curtains, bolts | `Runtime/Effects/StormClouds.cs`, `Resources/Shaders/StormClouds.shader` | A world-anchored lattice of slots (half a weather cell apart) in a window around the focus. It drifts with the wind; each lattice point's hash is periodic with the map's wrap. The vertex shader reads the weather at each slot and makes a lit, noise-eroded puff where the cloud is thick enough. Puffs get bigger, taller and darker with storm intensity, so broken cloud thickens into towering dark storm systems. A coarse lattice (twice the spacing, twice the size) cross-fades in at strategic zoom (105 to 175). Rain curtains hang under pouring cells (camDistance 40 and above). Storm cells flicker with intra-cloud lightning. No instance buffers: there are at most 4 `RenderMeshPrimitives` calls (fine, coarse, curtains, bolts), and empty slots collapse in the vertex shader. |
| Lightning and thunder | `StormClouds.Strikes` | Four times a second it scans the storm cells within `max(70, 1.6 x zoom)` of the focus and picks strikes weighted by (storm - .35)². At most 1.4 strikes per second, at least 0.5 s apart, and none while paused. Each strike gets a ring slot (`_SE_Strikes`) that lights the ground, the clouds and a bolt. It raises a `Strike` event with a thunder delay of `dist / 30` s (at most 7 s) and a loudness. |
| Global light | `Atmosphere.cs` | `RegionalWeather`: the camera's own overcast dims the whole view less as the camera zooms out (35% of the effect at strategic zoom), so a storm reads as a dark patch rather than a dark screen. The global lightning flash comes from nearby regional strikes (`StrikeFlash`) instead of a random timer. The global `_SE_Wetness` applies only up close. |
| Audio | `AudioDirector.cs` | `Thunder(pos, delay, loudness)` plays the recorded `thunder` set as a 3D voice at the strike, so it pans and attenuates by direction and distance. The distance low-pass muffles far strikes. The storm wind bed (`amb_wind_storm`) also rises with `StormNear`, the strongest storm within earshot, so a storm is heard before it arrives. The rain beds still follow the rain at the camera. Everything stays under the existing Master, Effects and Ambience volumes. |
| Minimap | `WeatherPresenter.Minimap`, `Minimap.Weather` | A texture with one texel per weather cell, bilinear-stretched over each terrain image as a child, so it follows scroll, zoom and wrap copies. Pale veil = thick cloud, blue = rain, dark violet = storm. It is refreshed at 2 Hz from the interpolated field. |
| Notices | `WeatherPresenter.WatchBases`, `ClientSession.LocalNote` | Once a second it checks our airfields, plus our headquarters and drone labs while we own aircraft. A raw storm value of .5 or more (the server's grounding threshold) gives "Storm over your airfield: aircraft there cannot take off or land; returning aircraft divert." (major). If the storm two or five steps upwind will reach the base, it gives "Storm approaching…" (major). These are the existing notice row with Go there and a minimap ping. "The storm … has passed" goes to the chronicle (info). Hysteresis plus a 90 s cooldown per base stop repeats. |
| Hover | `Hud.HoverCard.cs` (`StormHoverCard`) | Hovering open ground where the storm is at least .5 shows the hover card: "Storm · Aircraft cannot take off or land at bases under it · Aircraft inside fly slower and burn fuel faster". The tile is picked at 10 Hz and only when no unit or building is hovered. |

### Zoom behaviour
- **Close (< 26):** no cloud masses. The ground under a storm is darker and wet. Local rain particles fall at the camera (existing `fx.Rain`). Strikes light the ground with thunder.
- **Mid (26 to 175):** clouds fade in. A soft hole (radius `0.5 x zoom + 10`) is cut where the line of sight to the focus crosses the cloud layer, so clouds never cover the units being commanded. The hole closes by zoom 175.
- **Strategic (> 105):** coarse cloud masses. Storms read as dark towering systems with rain curtains and flickering lightning. Ground shade sits under them, and the global dimming is mostly off.
- The **Weather intensity** setting (`GameSettings.WeatherIntensity`, `Atmosphere.VisualIntensity`) scales the cloud opacity, ground shade, strike light and bolts. At 0 nothing is drawn. Thunder and notices remain, because the setting controls how weather is drawn, not what it does.

## Performance budget (main thread target < 0.5 ms at all zooms)
- **Per frame (CPU):** about 10 `SetGlobalVector` / `SetVector` calls, one `SetGlobalVectorArray` (4 elements, reused array), and up to 4 `RenderMeshPrimitives`. No allocations: the property blocks, arrays and lambdas are created once.
- **Every 0.25 s:** a strike scan over the weather cells (at most 32 x 32 = 1024 cells at 256 maps), with 2 bilinear samples per cell in range. This is roughly 0.05 ms.
- **Every 0.5 s:** minimap layer, 1024 cells x 6 bilinear samples plus a 4 KB texture upload.
- **Every 1 s:** base watch, which iterates own buildings and units (an allocation-free `Dictionary.Values` enumerator).
- **On a weather snapshot (every 5 s):** one 4 KB texture upload. The previous texture is swapped, not re-uploaded.
- **GPU:** the fine lattice is at most 160 x 160 slots, but the window radius caps it at about 120 x 140. Most slots collapse in the vertex shader. Overdraw only happens under thick cloud at mid and strategic zoom, with a cheap fragment (2 value noises, no textures). `SE_ApplyFog` gains 2 bilinear samples, 1 noise and a 4-iteration strike loop, early-outed when the amplitude is 0.

## Risks
- Uniform darkening in `SE_ApplyFog` also dims emissive surfaces (city lights) under storms, which is acceptable in permanent daylight.
- The visual field lags the server by up to one step (5 s) because it interpolates between snapshots. Notices and hover use the raw latest cell, so they match the gameplay.
- Cyclone spin is not drawn separately. The cyclones' effect shows through the cloud and storm fields the server advects.
- Cloud base y = 17 assumes terrain and aircraft stay below it.

## In-game checklist (eyes-on)
Storm systems:
- A. A normal match: the first 6 minutes are clear or lightly overcast; open sea is not permanently raining.
- B. When a system arrives (or in the stress scenario), at strategic zoom: a hurricane reads as a rotating cloud
  mass with a clear eye, a solid core and spiral bands with gaps; a squall line as a bowed line with a bright shelf
  edge and a ragged trailing deck. No straight cell edges, no repeating tiles, no popping every 5 s.
- C. Ground, units and buildings under the deck are darker and greyer, sunny ground stays bright, the shade sits
  under the cloud (offset with the sun).
- D. Zoom in through mid zoom: the deck thins and opens around the focus; below 28 only shade, rain and lightning.
- E. Pan toward an approaching system: storm wind rises and distant thunder rumbles from its side before strikes start.
- F. Minimap: the system, an amber dotted track ahead of it, the eye dot; the track should match where it goes.
- G. Hover open ground under it: the named system card with its heading, speed and strength.
- H. Profiler at strategic zoom with a hurricane on screen: GPU time for SE/StormSky, no GC.

1. Start a match and zoom to strategic. Dark cloud masses should sit over storm cells and pale broken cloud over cloudy cells. Over 30 s they should glide with the wind without popping when 5 s updates arrive.
2. The ground, water, units and buildings under a storm should be visibly darker and cooler, and sunny areas should stay bright. The shade should sit under the clouds (offset with the sun).
3. Zoom in toward a storm. Clouds should thin around the focus and be gone by zoom 26. Commanded units should never be hidden.
4. Lightning near a storm: a bolt, a local ground flash and flickering cloud. Thunder should come from the strike's side and arrive later the further away it is.
5. Pan toward a storm. The storm wind bed should rise before you reach it, and rain beds should play under rain.
6. Minimap: violet patches over storms, blue for rain. It should follow scrolling, Z zoom and the wrap seam.
7. Own an airfield in a storm's path. "Storm approaching your airfield" should appear, then "Storm over your airfield" (Go there works, minimap ping), then "has passed" in the chronicle. There should be no repeats while the storm sits at the threshold.
8. Hover open ground under a storm: the storm hover card appears. Hovering a unit or building still shows their cards.
9. Settings → Weather intensity at 0: no clouds, shade or bolts, but thunder still plays. At 50%: everything is halved.
10. Pause: the clouds stop drifting and no new strikes occur. Reduced motion: the global flash is softened.
11. Profiler (stress scenario, strategic zoom): `GameBootstrap` frame phases should show no measurable change, with 0 B GC per frame.
