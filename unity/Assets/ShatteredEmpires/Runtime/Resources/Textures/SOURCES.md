# Surface assets

`GroundGrass.jpg` and `GroundGrassNormal.jpg`: unmodified Color and NormalGL maps from
**Grass 001**, ambientCG, 2K JPG release. [Asset](https://ambientcg.com/a/Grass001),
[CC0 1.0 license](https://docs.ambientcg.com/license/). Renamed for Unity resource loading.
The maps are imported with mipmaps and anisotropic filtering; the normal is imported as a normal map.

`TerrainAtlas.png` and `ArchitectureAtlas.png`: generated with the built-in imagegen tool.
Prompts, intended materials and provenance are recorded in `docs/WORLD_VISUAL_PASS.md`.
Grass now uses the separate ambientCG material; the atlas supplies earth, limestone and aggregate.
# Foliage branch cutouts

`FoliageBranches.png`: **Leafy tree/plant branch**, qubodup, based on a source photograph by titus.
CC0 1.0. [Source and license](https://opengameart.org/content/leafy-treeplant-branch).
The original masked PNG is retained. Unity imports it at up to 1024 pixels with alpha-coverage
preserving mipmaps. It supplies many small photographed leaves per twig on branching 3D trees;
the same alpha cutoff is applied in visible, depth and shadow rendering.
