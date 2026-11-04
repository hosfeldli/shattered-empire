# Native validation evidence

`validation.json` is the current isolated real-server run. `meta` identifies source hash, timestamp,
whether a GPU window rendered, and whether the embedded exported pack was used. Tests must not
overwrite the player's normal session file or connect to an active player match.

- `district.png`, `settlement.png`, `strategic.png`, `seam.png`: native views of the test match.
- `city_center_ground.png`, `city_center_ground_after_reload.png`: terrain-only close-zoom views.
- `reload-before.png`, `reload-after.png`: terrain-only before/after rejoin. Compare land samples
  in the JSON, rather than expecting pixel-identical animated river water.
- `terrain-zoom.json`: actual GPU sweep across zoom, viewport aspect ratios, chunk invalidation
  and world wrapping. This is separate from headless tests.
- `pixi-settlement.png`: an earlier captured reference image of the old client. It does not claim
  to be the exact same paused state as newly refreshed native screenshots.

The reference gallery is historical comparison material only. A future explicitly requested
paired comparison uses `lwe-live.mjs --compare`, which saves a separate `comparison-godot.png` so
later native-only test runs cannot silently overwrite the paired native image. Browser source is
not modified by these tools.
