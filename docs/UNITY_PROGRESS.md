# Current implementation status

- **Type:** Implementation status
- **Updated:** 2026-11-13
- **Scope:** Unity edition / `action-v2`
- **Classification:** Functional prototype / Visually incomplete
- **Definitions:** [Verification](VERIFICATION.md#status-vocabulary)

## Read this status correctly

The Unity RTS is a Windows preview, not the completed replacement. This document distinguishes
published behavior, local development and unresolved requests. The documentation review does not
publish the current working tree or certify pending implementation.

The prior append-only progress record mixed earlier releases, civilization rules, migration
benchmarks and later work. It is preserved in the [historical inventory](archive/UNITY_PROGRESS_BEFORE_2026-11-13.md).
Use [Game design](GAME_DESIGN.md) for requirements and [Development queue](DEVELOPMENT_QUEUE.md)
for acceptance work.

## Foundation and previously recorded preview

| System | Functional status | Quality / evidence boundary |
| --- | --- | --- |
| Unity/URP client and hosted Node.js authority | Functional prototype | Pinned Unity `6000.3.28f1`; not final platform acceptance |
| Ruin capture, base reconstruction and conquest | Functional prototype | Capture/readability/balance and full-match acceptance remain open |
| Materials/Energy, 4/6/8 HQ rings and local/global tiers | Functional prototype | Requires current-ruleset economy, fairness and rejoin verification |
| Continuous authoritative movement and spatial combat | Functional prototype | Steering, formations, crossings and large battles need further review |
| Recruitment, queues, abilities and combined arms | Functional prototype | Full roster, counters and reinforcement UX are not production approved |
| AI scouting, expansion, operations and recovery | Functional prototype | Mission reliability, pacing and sustained competent play remain unapproved |
| Multiplayer, observers, saves and reconnect | Functional prototype | Current large-team/long-session release gates remain open |
| Terrain, ruins, cities, units, VFX, intro and audio | Functional prototype | Visually incomplete; no final human art/audio acceptance |
| Tutorial, sandbox and contextual interface | Functional prototype | Usability and current follow-up changes remain incomplete |

Windows Unity distribution and the hosted endpoint are documented in the dated quality reports.
The old Godot/macOS download listings are retired. macOS remains a target; there is no macOS
runtime acceptance from this Windows workstation.

## Local rendering and usability development

Working-tree changes address diffuse/nonemissive foliage, safe normals/HDR output, bounded bloom,
pooled lights, building/infantry/vehicle scale, level city compounds, smaller groundcover,
credited ground/fabric/metal textures, vehicle turn behavior, trench occupation, local combat
repositioning, later AI base assaults, purchased city defenses, defense rotation and tooltips.

Earlier local builds in this pass succeeded with zero compilation errors and approximately
143 MB of uncompressed player content. Actual Unity captures through the full URP camera stack
showed the menu, silo and gameplay without the reported giant white foliage glare.

Those results apply to the captured intermediate build. They do not validate subsequent source
changes, final artifact packaging, all graphics configurations or the user's currently downloaded
copy. The newest groundcover reduction and road/UI/map follow-ups were made afterward.

See the [working quality report](QUALITY_PASS_2026-11-12_RENDER_UX.md) for the exact evidence boundary.
These implementation edits remain separate from the documentation-only review commit.

## Latest owner feedback

| Request | Implementation status at this documentation checkpoint |
| --- | --- |
| Connected highways, city entrances, loop roads and frontage junctions | Functional prototype; latest shared-network source changes await build/visual review |
| Bridge decks above rivers, coherent supports and bank approaches | Functional prototype; latest height/structure source changes await build/visual review |
| Reduce unused land around the objective network | Functional prototype; latest bounded-geography source changes await map/visual verification |
| Remove Army/Objectives tabs and global upgrade menu | Functional prototype; latest contextual UI source changes await build/visual review |
| Upgrade through the selected building and remove bottom build/defense bars | Functional prototype; incomplete context/selection review remains |
| Make grass dramatically smaller | Functional prototype; latest short-groundcover scale awaits a replacement capture |
| Infantry enter trenches and use darker disturbed ground | Functional prototype; intermediate captures exist, sustained movement/cover review remains |
| Vehicles move without rubber-band turns | Functional prototype; source changes need sustained movement review |
| Soldiers move independently instead of rigid squad pivots | Not implemented for the latest request |
| Stable camera and reliable picking over mountains | Not implemented for the latest request |
| Runtime tooltips throughout the contextual interface | Functional prototype; real hover/disabled-control review remains incomplete |

“Functional prototype” means source exists, not that the newest edits compile or pass their
acceptance criteria. Do not use an earlier successful build to close a later request.

## Acceptance still open

No current final art, fun/balance, late-game FPS/p99, memory soak, extended multiplayer,
two-hour-session or macOS acceptance is claimed. Migration-era benchmarks are historical only.
No full production approval or completed Windows/macOS replacement release is claimed.

Follow [verification](VERIFICATION.md) for the owner's visual-only manual scope and required CI
boundaries, and [release](RELEASE.md) before publishing another source/player pair.
