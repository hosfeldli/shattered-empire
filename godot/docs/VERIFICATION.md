# Local native checkpoint

Runtime source hash: `196d542b9a0539cf7acf60745eca0d45300b787c0e1271b061e56eca1b0596d3`.
The current Windows/macOS development exports have this hash. The macOS bundle was tested on
Apple M3 with Godot 4.7.2; the Windows executable was exported but has not been run on Windows.

| Check | Result |
| --- | --- |
| Server functional suite | 139 passed |
| Server load: four 12-empire, 256 × 256 matches | Passed |
| Native headless regressions | 156 checks passed |
| Packaged macOS UI | 20 checks passed; 94 actions, eight main workspaces |
| Packaged macOS water/atmosphere | 11 checks passed; GPU pressure field readback verified |
| Packaged macOS live commands/reload | 20 checks passed |
| City-center ground | 2,520 samples before reload and 2,520 after; no failures |

[UI report](ui-validation/ui-validation.json), [water report](water-validation/water-validation.json),
and [live report](native-validation/validation.json) record the same runtime hash and successful
packaged/rendered runs. Water frame-interval p95 was 17.1 ms at 1280 × 900. This is a close-view
integration measurement, not GPU timing or late-game 1080p performance acceptance.

Review [river](water-validation/river-close.png), [coast](water-validation/coast-after.png),
[weather fixture](water-validation/cloud-and-rain-fixture.png), [cities](ui-validation/cities.png)
and [research](ui-validation/research.png). The weather fixture is explicitly local presentation
test data over actual server terrain; it does not change authoritative server weather.

The macOS export has an ad-hoc development signature; the Windows export is unsigned. No native
release has been published and Cloud Run has not been changed. The remaining balance, UI,
world-generation, Windows runtime, signing and soak gates in [RELEASE_GATES.md](RELEASE_GATES.md)
remain open.
