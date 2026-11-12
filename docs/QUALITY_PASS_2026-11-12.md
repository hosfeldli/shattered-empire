# Unity world, cinematic and audio quality pass — 12 November 2026

Status: **Functional prototype; visually incomplete.** This is a Windows preview update.
It is not art approved, performance approved or production accepted.

## Changes and behavior

- Normal player startup plays the skippable eight-beat introduction on every boot. The
  sequence now lasts about 64 seconds, with an emergency warning, converging missile
  tracks, three deliberately targeted strikes, district destruction, blackout, winter,
  regrowth, rival mobilization and a surviving launch installation.
- The cinematic city has a concentrated business skyline, older curved streets, pitched
  residential terraces, civic landmarks and larger industrial parcels. Its estuary,
  shoreline and wooded uplands replace the flat repeated-block arrangement. Parcel
  placement checks neighboring buildings and intersecting streets. Buildings retain
  their positions and architectural families through destruction and regrowth.
- The silo shot disables bloom, specular glare, water glint and the sky's solar halo.
  Its armored hatch and service buildings remain visible under restrained side lighting.
- Broadleaf trees use a credited CC0 photographic branch cutout, smaller leaves, branching
  trunks and stable canopy LODs. Fir branches, understory and denser curved grass blades
  replace the former sparse vegetation. Grass avoids roads, water and active base sites.
- Flames use rising irregular tendrils, anchored narrow geometry, soot and embers.
  Strategic explosions have filled cloud caps, rising stems, debris and expanding shocks.
  Particle opacity now preserves the initial part of each effect's lifetime correctly.
- Infantry gain rounded faces and helmets, straps, webbing, pouches and equipment.
  Distance-driven gait has planted steps, leg articulation and foot lift; breathing,
  recoil and reload timing remain tied to movement and authoritative firing events.
- Barricades and supported trench fortifications use raised concertina wire and steel
  tank obstacles. Cosmetic geometry does not grant new navigation or combat rules.
- Menu and contextual panels have bounded scrolling. Nested menu scroll areas were
  removed, and menu interaction suppresses camera scroll and drag underneath the UI.
- New competitive action maps are bounded. Their outer cells form a sea rim, with a
  continuous surrounding ocean. Wrapped legacy maps retain their original rules.
- Release startup resolves stale saved localhost addresses to the hosted public endpoint.
  Explicit development connections remain available for local development.

## Audio and asset provenance

Nineteen additional OGG assets include two orchestral themes, a real warning-siren
recording, weapon and impact layers, pre-war city ambience, construction, close river
water, mechanical track detail and fire. Sources, licenses and edits are recorded in
[audio sources](../unity/Assets/ShatteredEmpires/Runtime/Resources/Audio/SOURCES.md),
[the processing manifest](../unity/Assets/ShatteredEmpires/Runtime/Resources/Audio/Recorded/oga-edits.json)
and [texture sources](../unity/Assets/ShatteredEmpires/Runtime/Resources/Textures/SOURCES.md).

Effects are mono positional sources with distance attenuation and low-pass filtering;
music remains a separate stereo bus. The mix uses bounded voice and engine pools,
camera-local ambience and audible-range culling. Recorded highway ambience is used
only before the cinematic collapse. Civilian actors and ambient vehicles remain removed.
Some impacts and track details are designed layers rather than authentic recordings of
particular weapons or vehicles. Final subjective mastering still needs listening review.

## Visual evidence and verification

Actual Unity URP player captures, at 1920×1080 and High quality, are stored locally in:

- `.scratch/action-rts/review-distinct-districts`: the revised cinematic, all eight beats,
  six attack samples, menu pages at both scroll positions, foliage and ocean boundaries.
- `.scratch/action-rts/review-release-soldiers`: headquarters, ruins, facilities, armor,
  infantry, operational and strategic views from a hosted stronghold sandbox.
- `.scratch/action-rts/review-release-final`: the preceding pass's foliage, silo and menu
  captures. Its earlier repeated city layout is superseded by the distinct-district pass.

These captures use the actual game camera and scene, not generated concept art. Selected
frames accompany this report in `reviews/2026-11-12`. An isolated mesh capture does not
constitute approval of an asset in gameplay.

[Before the collapse](reviews/2026-11-12/city-before.jpg) ·
[City destruction](reviews/2026-11-12/city-collapse.jpg) ·
[Silo warning](reviews/2026-11-12/silo.jpg) ·
[Foliage detail](reviews/2026-11-12/foliage.jpg)

Local Windows release compilation succeeded with **0 errors** and approximately **135 MB**
of uncompressed player content. The final build took 17 seconds after
the initial import/build. No runtime exceptions appeared in the completed cinematic
capture logs. The hosted sandbox review uses the release client's default public endpoint.
Deployment runs the repository's required CI gates in addition to these local captures.

Manual work in this pass is limited to development, compilation, visual review and
distribution checks. No new broad gameplay, load or two-hour soak run is claimed.

## Measurements, defects and remaining gates

No reference-hardware FPS, GPU timing, p99 frame pacing, multiplayer load or memory-soak
measurement was taken in this pass. A successful build is not performance approval.
The Windows archive is produced with the native .NET ZIP writer, then all extracted
files are compared against the build using Windows Explorer and SHA-256. Download
verification compares the public browser download with that archive before handoff.

Known visual limitations include a thin ocean-boundary seam in some boundary views,
procedural model repetition within each architectural
family, stylized fir needles, angular small shorelines, procedural infantry motion and
limited terrain surface variety. The raised field defenses need wider gameplay-context
art review. Nuclear effects and flames are improved procedural effects, not final VFX art.

Known verification limits: no complete human-played match, subjective fun evaluation,
final audio mastering or macOS runtime acceptance is established by this update. Existing
saved maps retain their geography; the new sea rim applies when a bounded map is generated.

Next priorities are eliminating conspicuous visual seams and intersections, improving
repeated architecture and fir silhouettes, reviewing movement/VFX in sustained battles,
then obtaining reference-hardware performance measurements and human art/playtest approval.
