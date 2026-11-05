# Native production gate

The user authorized publishing Windows/macOS builds and updating Cloud Run, then explicitly made
that deployment conditional on closing UI/gameplay parity and world-generation acceptance gaps.
**Do not publish a new native release or deploy production while required gates remain open.**
Local development builds, isolated tests and CI artifacts are not a production deployment.

The [streamlined native redesign](NATIVE_REDESIGN.md) supersedes old government, treaty and
trading parity requirements. Those systems are deliberately removed in `native-v1`; legacy saves
retain their rules. The remaining LWE acceptance and platform/release gates still apply.

## Application and UI

- [x] Native fullscreen launch, windowed option, F11 toggle, main/pause menus and match setup.
- [x] Persistent graphics, display, audio, interface-scale and camera preferences.
- [x] Native system navigation and typed action catalog for existing server commands.
- [x] Three primary tools (Build, Army, Research), contextual selection cards and Overview access
  to cities, economy, Rivals and Chronicle. Minimap removed. Recruitment, formations and air/missile controls retained.
- [x] Trading/imports, government and treaty controls removed from native gameplay.
- [x] Versioned native/legacy save behavior and server-side command gates.
- [ ] Seeded pace, food/maintenance sustainability, scarce-region progression and era milestone audit.
- [ ] Longer AI commitment, retreat, conflict-resolution and automatic-development acceptance.
- [x] Map selection, additive/batch selection, control groups, double-click type selection,
  queued movement, rally points, road undo/waypoints, deployment spacing/depth/facing controls.
- [ ] Complete the explicit old-build feature/command audit and close remaining discrepancies.
- [x] Rendered compact selection/palette/drawer review, all contextual pages and larger UI scale.
  Packaged macOS: 50 UI checks. Windows interactive review remains open.
- [ ] Validate keyboard/mouse modality, target previews, destructive confirmations and stale replies.
- [ ] Multiplayer host/join/rejoin and observer controls verified through native menus.
- [ ] Windows and macOS packaged application checks, including saved preferences/fullscreen.

## Procedural world

The [LWE contract](LWE_REQUIREMENTS.md) remains the full requirement source. Every incomplete item
there remains open unless replaced by specific tested evidence. Module existence is insufficient.

- [ ] Continuous physical terrain/hydrology, ridge/shoreline/slope quality and wrap review.
- [ ] Context-aware ecology, road/river/terrain-aware settlements and regional identity.
- [ ] Deterministic city plan, compatible districts, stable upgrades/growth and reconstruction.
- [ ] Modular recognizable buildings, all development levels and production/activity states.
- [ ] Material-specific damage stages and local ruins without rebuilding unrelated neighborhoods.
- [ ] Complete LOD transitions for terrain, vegetation, buildings, troops, formations and armies.
- [ ] Troop movement/terrain adaptation, facing, casualties/condition and event-driven animation.
- [ ] Continuous battle regions, craters, wrecks, trenches, effects, recovery and persistence.
- [ ] Coherent weather/wetness/wind/water response using authorized environmental information.
- [ ] Full river-valley city plus adjoining mountain/mine/battlefield scenario, including economy,
  growth, destruction, recovery and reconnect/save-load identity.
- [ ] Performance and stability gates on representative late/large-map scenes; bounded generation,
  memory and effects; readable controls under sustained combat and graphics preset changes.

## Production publication (only after the above)

- [ ] Build both platforms from one recorded source revision; verify artifact hashes/runtime.
- [ ] Publish native-specific download metadata and accurate installation instructions. Preserve
  older reference downloads without presenting their installers as native auto-update packages.
- [ ] Deploy the compatible authoritative server without altering gameplay/balance or `deploy.yml`.
- [ ] Verify health, capability negotiation, a native match/rejoin and the actual hosted downloads.
- [ ] Record revision, artifact URLs/hashes and remaining platform/signing limitations honestly.

Production inspected read-only: Cloud Run `shattered-empires`, `us-east1`, project `stem-471602`;
existing revision `shattered-empires-00012-mjc` runs server image `8c03ba7d6056`. Downloads currently
use `gs://stem-471602-se-snapshots/downloads/manifest.json` (Electron 0.1.8). No production write
has been performed during the native application/UI work.
