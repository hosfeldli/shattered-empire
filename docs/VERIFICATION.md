# Verification and acceptance

- **Type:** Verification contract
- **Updated:** 2026-11-13
- **Scope:** Unity RTS development, visual review and release gates

## Status vocabulary

Use these exact classifications. Functional, visual and performance progress are separate axes.

| Status | Meaning |
| --- | --- |
| Not implemented | Required behavior or asset is absent |
| Functional prototype | Implementation exists; validation or quality remains incomplete |
| Visually incomplete | Presentation needs further asset, composition, motion or art work |
| Feature complete | Defined behavior and relevant checks are complete; approval gates may remain |
| Art approved | Human review accepted the specified actual in-match appearance |
| Performance approved | Measurements meet the agreed scene/hardware budget |
| Production accepted | Required gameplay, art, platform, stability and distribution gates pass |

Data structures, primitive rendering and passing tests alone do not establish completion.
Compilation does not establish visual, balance or performance approval.

## Current iteration scope

The owner requested major development before review and restricted manual testing to visual
checks during this graphics pass. Complete development, build, review real scenes and record
findings. Do not begin new manual gameplay, balance, soak or load campaigns without later scope.

Required CI/release gates still apply before publication. Documentation-only work needs document
checks, not new gameplay benchmarks. Compilation, visual review, automated integration and
performance profiling are distinct activities.

## Visual evidence

Review significant assets at close tactical, operational and strategic scales, during gameplay
and damaged states. Inspect buildings beside terrain, streets, infantry, vehicles and neighbors.
Include menu, cinematic, construction, ruins, forest, river/bridge and battle scenes.

Capture real Unity renders through the normal URP camera-stack/post-processing path, including
volume updates. SingleCameraRequest alone can miss post-processing state and is insufficient
for investigating the reported glare. Black/unavailable hidden-window swap-chain captures are
failed captures, not proof that an image is correct.

Existing review entry points:

```text
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode sandbox -battle stronghold -seed 41 -quality high -review REVIEW_DIRECTORY
ShatteredEmpires.exe -quality high -review-intro INTRO_DIRECTORY
```

Use `-review-quit 0` to retain a review player when needed. Do not overwrite the real player's
server/Continue state or terminate their running game.

Record source/build, ruleset, scene/seed, camera, resolution, quality and hardware with capture
claims. Keep selected durable artifacts with the report. Image automation detects regressions;
human art review decides visual approval.

## Functional and multiplayer gates

Verify full matches, capture/contesting/decay, HQ restrictions, 4/6/8 sites, two-resource costs,
capacity, progression, navigation/formations, spatial combat, production, AI and victory/recovery.
Verify team/fog equivalence, deltas, reconnect and deterministic save continuation. Cover command
feedback and conflicts among selection, typing, placement and remapped keys.

Earlier ruleset results do not validate current rules. A skipped licensed Unity CI job does not
mean the Editor build passed.

## Performance gates

Target 1080p/60 FPS, approximately 16.7 ms average and p99 below 25 ms in principal scenes on a
defined reference Windows PC. Record CPU/GPU, frame intervals, memory, draw calls, snapshot size,
server tick cost and command latency.

Cover empty world, small/mature bases, ruins, forest, river/bridge combat, artillery/air,
100/500/1,000-unit battles, 2,000-unit stress, construction/destruction, camera/selection,
save/rejoin, multiple users and two-hour sessions. Scope claims to measured scenes. Exclude
capture/export stalls from ordinary gameplay budgets.

Migration benchmarks are historical comparisons, not current late-game acceptance. A compile
log, server tick metric or screenshot does not prove client FPS.

## Phase report and release acceptance

Every implementation phase records changes, systems/assets, gameplay behavior, visual work,
actual captures, checks/results, measured performance, remaining visual defects, remaining
functional defects and severity-ordered next work. Explicitly identify missing measurements.

Production requires gameplay and visual approval, responsive large battles, platform runtime,
multiplayer, save/rejoin, extended stability, packaging and distribution validation. Windows and
macOS require separate acceptance. A Windows preview can be distributed with accurate limitations;
it is not the completed Unity replacement. Follow [release](RELEASE.md).
