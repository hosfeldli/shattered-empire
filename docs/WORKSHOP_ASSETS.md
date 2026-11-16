# Asset Store media and Blender models

- **Type:** Pipeline reference
- **Updated:** 2026-11-15

## Asset Store media (not in git)

The owner's Unity Asset Store downloads are converted into
`unity/Assets/ShatteredEmpires/Runtime/Resources/Workshop/`. This folder is git-ignored:
the Asset Store EULA allows the assets inside the built game, but not redistribution in this
public repository. Without the folder, the game falls back to its committed assets.

Rebuild after a fresh clone:

```
node tools/ingest-workshop-assets.cjs <ffmpeg.exe> [asset-store-cache] [scratch-dir]
```

The cache defaults to `%APPDATA%/Unity/Asset Store-5.x`. The script extracts only the selected
files, converts them to runtime formats and writes `Workshop/manifest.json`:

- Audio becomes Vorbis: mono for positional one-shots, stereo for music and beds.
- Textures become JPG or PNG at runtime resolution.

Texture overrides keep the committed file's name, such as `GroundGrass`, `ArchitectureAtlas` or
`UnitArmor`. Each one is luminance-matched to the texture it replaces, so the tuned shaders keep
their light balance. `WorkshopImport.cs` sets the import rules.

| Use | Source packages |
| --- | --- |
| Gunfire (near/far), echo tails, casings, ricochets, impacts | Post Apocalypse Guns Demo, Weapons of Choice FREE, Grenade Sound FX, Nature Sound FX (AK takes) |
| Explosions, rumbles, thunder, fire, wind, rain, coast | Grenade Sound FX, Nature Sound FX |
| UI clicks, casualty cries, footsteps | Free SFX Package |
| Score playlists (calm, combat, menu, intro dread) | Dynamic Music, Fantasy Battle Music Free Pack |
| Terrain grass, crater earth, district gravel | Outdoor Ground Textures |
| Building plaster, brick, roof metal | Free architectural textures, Yughues Free Metal Materials |
| Unit armour wear | Yughues Free Metal Materials |
| Sky panoramas (gameplay weather, menu, eight intro beats) | 8K Skybox Pack Free |
| Infantry casualty decals | Blood splatter decal package |
| Meadow ground-cover cards | Grass Flowers Pack Free |

## Blender models (in git)

`tools/blender/build_military.py` builds the close-range vehicles, aircraft, wheels and rifle as
real solids. Profiles are extruded into hulls, edges are chamfered, and wheels, barrels and
fuselages are lathed. The script writes `Resources/Models/*.bytes`:

```
"<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_military.py -- unity/Assets/ShatteredEmpires/Runtime/Resources/Models
"<blender.exe>" -b --factory-startup --python tools/blender/preview_models.py -- unity/Assets/ShatteredEmpires/Runtime/Resources/Models preview.png
```

The other scripts, run the same way (or live in Blender over the MCP bridge: `exec` the file with
`SE_OUT` set to the models directory):

- **`build_soldiers.py`:** seven rigged infantry roles on one armature.
  - IK locks the hands to the weapon grips and drives the feet from targets.
  - Clips: idle, walk, run, aim, fire and die.
  - Output: `Soldier<r>.bytes` (UV0.x holds the bone index) and `SoldierAnim<r>.bytes`, the per-frame
    3×4 bone matrices.
  - `SoldierRig` uploads the animation as a float texture. SE/InstancedLit skins each instance on
    the GPU; the instance colour's alpha carries the frame number.
- **`build_bases.py`:** headquarters, barracks, supply centre, vehicle works and generator, plus
  `BaseLayout.txt` (walls, faction panels, flags, smoke stacks).
- **`build_wildlife.py`:** birds in two wing poses.

Building collision comes from what the client draws. Positioned buildings record their solid walls
as they are composed (`CityRenderer.Footprints`). After a session that shows each base type (the
intro does), export the walls:

```
CityRenderer.ExportJson()  ->  server/sim/actionFootprints.json
```

Keep only the action building types in that file. Types without walls keep their circular radius.

`se_meshkit.py` bakes each vertex for the instanced renderer:

- vertex colour is the palette colour multiplied by ray-traced ambient occlusion;
- UV1.x is the SurfaceKind;
- normals are split at 38°.

It also converts Blender's Z-up right-handed axes to Unity's Y-up left-handed axes. Units and
pivots match `MilitaryMeshes.cs`. `ModelLibrary` loads the models and falls back to the
code-built mesh for anything missing.
