# Surface assets

`GroundGrass.jpg` and `GroundGrassNormal.jpg`: unmodified Color and NormalGL maps from
**Grass 001**, ambientCG, 2K JPG release. [Asset](https://ambientcg.com/a/Grass001),
[CC0 1.0 license](https://docs.ambientcg.com/license/). Renamed for Unity resource loading.
The maps are imported with mipmaps and anisotropic filtering; the normal is imported as a normal map.

`TerrainAtlas.png` and `ArchitectureAtlas.png`: generated with the built-in imagegen tool.
Prompts, intended materials and provenance are recorded in `docs/WORLD_VISUAL_PASS.md`.
Grass now uses the separate ambientCG material; the atlas supplies earth, limestone and aggregate.
