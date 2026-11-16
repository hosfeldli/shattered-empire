# Clean world presentation pass

- **Type:** Historical implementation report
- **Scope:** Only the build, ruleset and captures recorded below; not current acceptance.

Use [Current status](UNITY_PROGRESS.md) and the [documentation index](README.md) for later work.

Status: visually incomplete until the new Unity captures are reviewed. No art or performance approval is implied.

The pass replaces the noisy ground treatment with a photographic grass, compacted earth, limestone and aggregate atlas. Biome colours use a restrained temperate palette; slow material variation replaces high-contrast blotches and repeating cliff stripes. Material colour is converted to linear reflectance once, and neutral daylight, stronger ambient fill and restrained grading retain readable shadows.

Water triangles are clipped against the shared terrain surface before upload. This avoids relying on a depth prepass to include procedural terrain. Banks have a locally smoothed profile, bounded deterministic relief and finer geometry; water is clipped against the matching subdivisions. Dry land cannot receive the old foam overlay. Continuous Hermite channel curves share their end tangents and width, and insignificant headwater threads no longer appear as bright blue lines. Sources taper instead of ending in a rectangle, with wet earthen margins grounded along the channel. Channels stop where standing water covers them. Lake beds derive from immutable source geometry on every update, avoiding cumulative lowering during exploration and reconnects. Discovery refreshes previously rendered banks when a connected basin's common level changes. Distant ocean continues beyond the playable perimeter so strategic zoom does not expose the sea mesh's cut edge.

Roads, shoulders and sidewalks are continuous terrain-following ribbons cached with their city render cell. Two-ended streets share a continuous tangent. Streets route around occupied historical parcels; their frontage does not move when reconstruction begins. Minor construction access becomes an understated gravel lane; paved through routes remain continuous. Entrance paths start at the actual facility doorway. Material and width stay consistent across cell boundaries. Bridge decks derive from the water surface rather than the highest adjacent land sample; piers and parapets occur over the crossing. Damaged road spans remain visibly interrupted. Traffic uses the same curves and height function.

Ruins use supported concrete cores, partial masonry, roofless shells and collapsed floor slabs contained within the former building footprint. Random sideways intact skyscrapers and scattered decorative towers are removed from action maps. Discovered sites expose their historical parcel geometry without exposing enemy building occupancy. Their surviving foundations remain at stable positions as the site is captured and rebuilt.

The starting Barracks and Supply Center have new asymmetric architectural recipes, recognisable entrances, restrained faction markings, loading areas and roof details. Individual building foundations reach the actual terrain. Yard surfaces follow the ground instead of floating at the building's floor height. Glazing and trim share the main building datum. Duplicate infill over historical ruins, bright rectangular civic lawns and repeated formal plazas are removed from action bases. Small landscaping uses branched tree geometry. Selection stays clear while unselected close-range ownership rings no longer overwhelm the models. Operational headquarters do not show an irrelevant capture boundary.

Battlefield decoration follows material history: forest damage can leave short snapped trunks, and developed land can leave masonry fragments. Impacts on open grass no longer invent tall tree spikes or decorative barbed-wire defenses. Authoritative trenches, defenses, craters and typed wrecks retain their own presentation.

## Generated material asset

- Source/output: `unity/Assets/ShatteredEmpires/Runtime/Resources/Textures/TerrainAtlas.png`.
- Generated using the built-in imagegen tool, without an external asset library.
- Texture import uses sRGB albedo, mipmaps, trilinear filtering and anisotropic sampling. The shader samples each atlas region independently with explicit gradients and an edge inset.
- The atlas stores albedo. Shader surface gradients provide restrained relief; it is not a scanned PBR material set.

Final generation prompt:

> Use case: photorealistic-natural. Asset type: production terrain ALBEDO material atlas for a grounded modern military RTS Unity landscape. Create one square high resolution texture atlas with precisely four equally sized square quadrants, edge to edge with no gaps or labels. TOP LEFT: closely cropped natural temperate short meadow grass, muted sage and olive blades with a little dry thatch, dense fine consistent coverage, not overgrown. TOP RIGHT: dry compacted brown gray earth and fine grit, no large stones. BOTTOM LEFT: weathered gray limestone rock surface with fine irregular mineral grain, restrained broad natural fissures, no banding. BOTTOM RIGHT: fine gray gravel and aged concrete aggregate suitable for courtyards. True orthographic top down flat material photography, even diffuse neutral illumination. Each quadrant is a separately seamless repeating square material, independently tileable on all four edges. All details at realistic small surface scale. Desaturated natural midtones, consistent uniform brightness, no dramatic lighting, no shadows, no perspective, no objects, no plants above the ground, no puddles, no white edges, no text, no vignette, no painted or illustrative appearance. Fine authentic photographic detail without large conspicuous spots or obvious repeated shapes.

## Verification

Major graphics development preceded review. The first capture round exposed excessive exposure and an unreliable procedural-depth shoreline; subsequent captures guided the explicit ambient lighting, geometry clipping, parcel routing and ruin revisions. After the user's instruction to perform only visual testing, work is restricted to building and inspecting the actual Unity scenes. No further functional, AI soak or load tests are scheduled in this pass.

Camera coverage includes the complete base, close headquarters architecture, ruins at two scales, a lake bank, a river crossing, infantry, armor, a battle and strategic view. The captures are from the actual runtime world at 1920×1080, High quality; they are scene-only and do not include the screen-space HUD.

Pending visual concerns: distant vegetation still uses simplified representations; roads can reveal the coarse authoritative network over long distances; bespoke authored building assets and animation clips remain unfinished. These changes improve the procedural library but do not constitute human art approval. Performance, balance, platform acceptance and extended-session testing are not performed in this visual-only iteration.

## Architecture material asset

Source/output: `unity/Assets/ShatteredEmpires/Runtime/Resources/Textures/ArchitectureAtlas.png`, generated using the built-in imagegen tool. Concrete, masonry, painted roof metal and asphalt use photographic albedo variation and surface-gradient relief with consistent physical sampling. Existing palette, faction markings, material roughness and model silhouettes remain responsible for identity.

Final generation prompt:

> Use case: photorealistic-natural. Asset type: seamless ALBEDO material atlas for a realistic modern military RTS in Unity. Create a square atlas divided into exactly four equal squares, no gutters, no labels, no borders. TOP LEFT: aged structural gray concrete wall, fine pores and subtle fine aggregate, very restrained light weathering, no large cracks or stains. TOP RIGHT: brown gray fired masonry brick wall, tightly staggered rectangular bricks with thin gray mortar joints, consistent dimensions and restrained natural color variation, believable modern industrial building. BOTTOM LEFT: faded slate gray galvanized standing seam metal roofing, narrow straight vertical seams with subtle fine material grain, matte metallic finish, no dramatic rust. BOTTOM RIGHT: medium dark weathered gray asphalt with fine aggregate, no paint or road markings, no large cracks. All four are flat orthographic front-on surface photography, each individual square seamless and tileable horizontally and vertically, uniform neutral diffuse lighting, flat albedo without baked shadows or reflections, fine realistic high resolution detail, carefully restrained contrast, no objects, no perspective, no text, no embellishments, no cinematic grading, no high contrast spots or large conspicuous features, no illustration or stylization.

## Fog of war and the cloud bank

Status: written without an editor or player run; needs captures in both before it counts as done.

- **What is covered:** Only never-explored ground gets volumetric cloud. Explored hexes that border unknown ground are covered too, so the cut edge of known terrain never shows. Explored ground that is out of sight gets no cloud: world shaders desaturate and darken it (`SE_ApplyFog`), as before. The old thin mist over explored-but-unseen land is gone.
- **Data:** `FogField` packs one RGBA32 texel per hex:
  - R: visible.
  - G: explored. Interior hexes are 255, explored hexes on the boundary are 120, and unknown hexes are 0.
  - B: the ground height the bank must bury, smoothed over six passes so the crown rolls instead of stepping in hexagons.
  - R is rewritten whenever visibility changes. G and B, the expensive part, are rebuilt only when known ground grows, plus every 24th visibility update to pick up height changes.
- **Rendering:** `SE/Shroud` is one full-screen triangle drawn by `Shroud.cs` in the transparent queue, with premultiplied blending. It ray-marches a slab from y −0.4 to 6.5:
  - Coverage is `1 − smoothstep(.55, .85, G)`, read through a noise warp so no hexagon outlines show. Everything outside a bounded map counts as unexplored, so the world edge is never visible.
  - Density is shaped by a rolling crown 0.6 units above the burial height plus 3D billow noise drifting on the wind. Light runs from a shadowed belly to sunlit crowns, tinted by the haze colour.
  - Crown detail flattens with distance, so grazing views read as a calm sea rather than streaks.
  - Under the bank, a floor fill makes unexplored ground opaque, so no gaps show.
- **Rays:** Each frame, and again in `beginCameraRendering`, `Shroud.cs` passes the world-space ray origin and direction at the four screen corners, using `Camera.ViewportToWorldPoint`. The shader interpolates them across the screen. Scene distance is linear eye depth multiplied by the ray length.
  - This is exact for the perspective camera and for the orthographic action-RTS camera, and does not depend on reversed-Z or on projection flips.
  - The earlier near-plane reconstruction gave orthographic cameras sideways rays. Only rays near the screen centre pointed forward, which produced the "cloud bubble" at the focus.
- **Sky cumulus:** This optional layer sits 13–21 units up. It is drawn only for a low perspective camera (it fades out above 11 units), only in the top part of the image, and only for rays climbing toward the horizon. It is off for the orthographic camera.
- **Cost:** The step count follows the slab crossing length (6–44 steps). Steps well inside explored ground, or above the highest crown possible there, cost one texture fetch and no noise. The march stops once the bank is opaque. The pass is skipped, along with its depth copy, when there is nothing to draw. A follow-up option if the pass is still GPU-heavy: render it at half resolution with a bilateral upsample (this needs a renderer feature).
- **Build:** The shader loads through `Resources.Load` and has no keywords. It needs the URP depth copy after opaques (`SE_Renderer` `m_CopyDepthMode: 0`), and `Atmosphere` requests depth while the pass is active. Graphics settings now use custom fog stripping that keeps the linear fog variants. With automatic stripping, the build dropped `FOG_LINEAR` everywhere, because `Main.unity` has fog off, so the player rendered without distance fog.


## Troops, destruction and aircraft pass (military renderer)

**Soldiers as individuals** (`Military/UnitRenderer.cs`, `AddSquad`/`AddRigged`). Every behaviour is seeded by unit id and figure index and uses preallocated per-slot arrays (no per-frame allocation).
- **Calm idle:** the old head-scan yaw swings (+-0.45 rad) and the random "watch a sector" rifle raising are gone. At ease a man only drifts +-0.07 rad slowly; the baked idle clip's head yaw was cut from 0.32 to 0.07 rad.
- **Engaged:** about a third of the men (deterministic) kneel to fire instead of standing.
- **Under fire** (`NoteShot` now also records the last shot *at* each unit and who fired it): the squad halts, then each man in turn (his own reaction trait) dashes, crouch-running, to cover and kneels facing the shooter. Cover is the far side of a friendly armoured vehicle within 0.45 units if one stands still nearby (men spread along the hull away from the threat; matches the server's 0.5-hex cover rule), otherwise the lowest of four spots ~1.6 m around his place (shell holes and ditches win), chosen once when the squad reacts.
- **Trenches:** men drop into the cut one after another with a short hop (`hop` clip plus a small arc), and climb out the same way.
- **Mortar teams:** set up when they halt and fire, or from the server flags (512 deployed, 1024 setting up; `UnitRenderer.DeployedFlag/SettingUpFlag`). The crew moves to stations round the tube (loader, gunner, ammunition bearer, kneeling flankers). The tube is laid on the ground, raised onto baseplate and bipod over ~3 s, and kicks down on each round. When packed, the tube rides on the loader's back. Field-gun crews kneel and work the breech.
- **New baked clips** (`tools/blender/build_soldiers.py`, rebaked, 310 frames): `kneel` 203-242, `hop` 244-259, `deploy` 261-308. `SoldierRig.Has()` falls back for an old bake. The leg IK pole angle was corrected (-90 to +90 degrees): the old setting bent knees slightly backward in walk and run, and fully backward when kneeling. Verified by solving the rig headless.

**Destruction** (`Effects/EffectsRenderer.Destruction.cs`, all fixed pools: 96 timed stages, 48 long-lived emitters, a 2400-piece rubble ring buffer, plus the shared 16k particle budget).
- `fx.BuildingCollapse(point, footprintRadius)`: dust wave out from the base, then 3-7 collapse stages that drop masonry and timber on ballistic arcs. Debris particles now land on the ground, bounce and rest. A persistent rubble spill, a scorch mark, 1-3 fires dying down over 20-45 s and a smoke column (60-100 s). **Wire to the server's `demolish` event and to destroyed `bhit` (GameBootstrap, not yet wired).**
- `fx.VehicleDestroyed(point, yaw, sizeClass)`: catastrophic blast, hull pieces and the turret thrown, a scorched patch with fragments, a burning wreck pouring oily smoke, and 1-3 timed cook-offs. **Wire to vehicle `kill` events in place of the plain `Explosion(p, .9)`.**
- `fx.SecondaryExplosion`, `fx.Scorch`. The existing small wreck fires (`Fire(p, <.2)`) also cook off now and then.
- **Craters** (`Terrain/ChunkMeshJob.cs`, `CraterRelief`): render relief on top of the shared `DamageHeight` bowl. A jagged two-octave floor, a raised lip broken into lobes and gaps, and noise-placed clod bumps beyond it. The floor is scorched black and the thrown subsoil is paler. Normals follow the relief, and crater hexes are tessellated 4x4 per sector triangle (1728 vertices) instead of 3x3. The relief is a few decimetres at most, so actors still stand true. `WarzoneRenderer` adds half-buried clods and turf lumps around every crater lip, placed on the drawn surface.
- **Wrecks** (`Battlefields/WarzoneRenderer.cs`): sized per vehicle type (no more 0.38 aircraft or tank-sized buggies). Pitch and roll follow the terrain under the hull, they are bedded at the mean footprint height, burnt colours replace the near-white tint, and each has a scorched patch and tumbled fragments around it.

**Aircraft** (`FlySnapshot`): with continuous server motion, aircraft dead-reckon along the server velocity and bleed their error toward the interpolated track. This removes the kinks at every snapshot and the freeze-then-jump when playback reaches the newest one. Heading follows the smoothed velocity at a turn-rate limit, bank is the coordinated-turn angle for speed and turn rate, and altitude is eased. Path-driven aircraft (`Fly`) measure the server's speed and chase at least that fast (turn rate, lead and the snap distance scale with it), so faster planes no longer lag or teleport.