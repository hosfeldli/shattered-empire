# Material sources

- `ground_natural_albedo.jpg`: Ground013 1K JPG color map from
  [ambientCG Ground 013](https://ambientcg.com/view?id=Ground013), published under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Used as a subtle
  world-space ground detail; the original image has not been modified.
- `steel_*.jpg`: Color, OpenGL normal and roughness maps from
  [ambientCG Metal 032](https://ambientcg.com/view?id=Metal032), CC0 1.0.
- `canvas_*.jpg`: Color, OpenGL normal and roughness maps from
  [ambientCG Fabric 030](https://ambientcg.com/view?id=Fabric030), CC0 1.0.
- `bark_*.jpg`: Color, OpenGL normal and roughness maps from
  [ambientCG Bark 014](https://ambientcg.com/view?id=Bark014), CC0 1.0.

## Texture overhaul (2026-11-07)

The earlier 256-pixel generated placeholder maps were removed. Every set below is the 1K-JPG
Color, NormalGL and Roughness map from [ambientCG](https://ambientcg.com), published under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Files were renamed to
`<material>_albedo/normal/roughness.jpg`, re-encoded as JPEG and roughness maps downscaled to 512 px;
image content is otherwise unmodified.

| Material key | ambientCG asset |
| --- | --- |
| `asphalt` | [Asphalt031](https://ambientcg.com/view?id=Asphalt031) |
| `brick` | [Bricks059](https://ambientcg.com/view?id=Bricks059) |
| `stone` | [Bricks108A](https://ambientcg.com/view?id=Bricks108A) |
| `concrete` | [Concrete034](https://ambientcg.com/view?id=Concrete034) |
| `plaster` | [Plaster001](https://ambientcg.com/view?id=Plaster001) |
| `rock` | [Rock051](https://ambientcg.com/view?id=Rock051) |
| `roof_tile` | [RoofingTiles014A](https://ambientcg.com/view?id=RoofingTiles014A) |
| `roof_slate` | [RoofingTiles013A](https://ambientcg.com/view?id=RoofingTiles013A) |
| `soil` | [Ground109](https://ambientcg.com/view?id=Ground109) |
| `grass` | [Grass004](https://ambientcg.com/view?id=Grass004) |
| `sand` | [Ground080](https://ambientcg.com/view?id=Ground080) |
| `rubble` | [Ground110](https://ambientcg.com/view?id=Ground110) |
| `gravel` | [Gravel043](https://ambientcg.com/view?id=Gravel043) |
| `snow` | [Snow010A](https://ambientcg.com/view?id=Snow010A) |
| `timber` | [Planks037A](https://ambientcg.com/view?id=Planks037A) |
| `painted_metal` | [PaintedMetal006](https://ambientcg.com/view?id=PaintedMetal006) |
| `corrugated` | [CorrugatedSteel005](https://ambientcg.com/view?id=CorrugatedSteel005) |
| `mud` | [Ground048](https://ambientcg.com/view?id=Ground048) |
| `composite` | [Plastic010](https://ambientcg.com/view?id=Plastic010) |
| `paving` | [PavingStones138](https://ambientcg.com/view?id=PavingStones138) |

Terrain blends the `grass`, `soil`, `sand`, `rock` and `snow` colour maps by biome palette, slope
and height. All materials apply their maps at a per-material real-world scale with the map's own
average colour factored out, so the art-directed palette and vertex tints control hue; grime and
rust weathering is procedural.
