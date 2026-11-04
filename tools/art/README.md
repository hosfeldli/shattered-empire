# Native art sources

The residential kit is authored by `build_residential.py` in Blender 4.5 LTS. Run:

```sh
blender --background --python tools/art/build_residential.py
python3 tools/art/build_materials.py
godot --headless --editor --path godot --quit
```

The checked-in `.blend` is an editable example. The script recreates all three variants; changing
only that example does not change the other variants. Runtime imports use `.glb`, so players and
CI do not need Blender. Names of glTF material slots must match `MaterialLibrary.SPECS` exactly.

Models use hex-radius units: a house is about 0.4 wide. The exporter converts Blender Z-up to
Godot Y-up. Footings, recessed windows, lintels, mullions, doors, steps, fascias, chimneys and
drainpipes are modeled geometry. District assembly batches their surfaces by shared material.
The deterministic material generator makes tileable albedo, roughness and normal maps. Native
world-space mapping keeps their physical scale consistent between procedural and imported parts.

All sources in this directory were created for this repository. They contain no downloaded art.
The models establish a reproducible asset pipeline; they still need art direction and visual
comparison before they establish an acceptable production asset budget.
