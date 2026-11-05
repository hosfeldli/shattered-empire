# Local native checkpoint

Runtime source hash: `f54d0557c7020beda8ac5f145847e58217ece1d4e93e922807f5fe1645a15288`.
Windows/macOS development exports share this hash. The macOS bundle was tested on Apple M3
with Godot 4.7.2; the Windows executable was exported but has not been run on Windows.

| Check | Result |
| --- | --- |
| Server functional suite | 140 passed |
| Native headless regressions | 226 checks passed: rendering 43, composition 33, LWE 62, water 18, development 70 |
| Packaged macOS UI | 50 checks passed; 94 actions; three primary tools; no minimap |
| Packaged macOS live-command smoke | 20 checks passed |
| Packaged macOS reconnect/server restart | Passed; order reached and picking verified |
| Catalogue | 23 explicit troop models; 32 active building types; 66 type/level variants |
| Building damage | 52 industrial/advanced damaged or ruined variants checked |

The [UI report](ui-validation/ui-validation.json) records an unchanged runtime hash and a rendered,
exported run. Its [catalogue report](ui-validation/catalogue-validation.json) audits the actual server
definitions, every supported upgrade level, distinct troop silhouettes and advanced damage stages.
Read [SIMPLE_UI.md](SIMPLE_UI.md) for current interactions and the exact coverage limits.

The new 70-check development regression includes deterministic damage, shared-template immutability,
construction matching the finished model and wall clipping that prevents tall ruin triangles.
Site-preview server tests verify exact cost, isolated-city resource pools, visibility filtering and
that previews cannot construct objects or spend resources.

Review [default world](ui-validation/world.png), [build palette](ui-validation/construction.png),
[placement](ui-validation/building-preview.png), [recruitment](ui-validation/recruitment.png),
[troops](ui-validation/troop-catalogue.png), [buildings](ui-validation/building-catalogue.png),
[development](ui-validation/development-levels.png) and [destruction](ui-validation/advanced-destruction.png).
The catalogue sheets are labelled presentation fixtures, not new objects invented in the running match.

Earlier [water](water-validation/water-validation.json) and [rendered reload](native-validation/validation.json)
reports remain historical evidence for their recorded source hashes. The previous water p95 was
17.1 ms at 1280 × 900; it is not current-source late-game 1080p or GPU-time acceptance. The previous
city-center ground audit sampled 2,520 points before reload and 2,520 after without failures.

The macOS export has an ad-hoc development signature; Windows is unsigned. No native release has
been published and Cloud Run has not been changed. Balance, art review, representative late-game
performance, Windows runtime, signing and soak gates in [RELEASE_GATES.md](RELEASE_GATES.md) remain open.
