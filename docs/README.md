# Documentation

- **Type:** Documentation index
- **Updated:** 2026-11-13
- **Scope:** Unity edition / `action-v2`

## Current guides

| Document | Owns |
| --- | --- |
| [Game design](GAME_DESIGN.md) | Gameplay, presentation and player-experience requirements |
| [Current status](UNITY_PROGRESS.md) | Implementation state, evidence and release limitations |
| [Development queue](DEVELOPMENT_QUEUE.md) | Remaining work and severity-ordered acceptance criteria |
| [Architecture](ARCHITECTURE.md) | Authority, data contracts, rendering and compatibility |
| [Development](DEVELOPMENT.md) | Local server, Editor, player and build commands |
| [Verification](VERIFICATION.md) | Status vocabulary, review scope and acceptance gates |
| [Release](RELEASE.md) | Windows packaging, hosting and public-download verification |
| [Review notes](REVIEW_NOTES_2026-11-13.md) | This documentation pass and suggested review order |

The [Unity README](../unity/README.md) is the client entry point.
The [implementation map](ACTION_RTS_IMPLEMENTATION.md) links systems to source.

## Precedence

1. The owner's latest explicit direction overrides older briefs.
2. [Game design](GAME_DESIGN.md) consolidates the current direction; an implementation gap does
   not silently change it.
3. [Current status](UNITY_PROGRESS.md) records implementation and observed evidence.
4. [Development queue](DEVELOPMENT_QUEUE.md) records unresolved requests.
5. Dated reports and archives apply only to their recorded build or historical ruleset.

Use Materials and Energy for currencies, Command Capacity for the army limit,
Global Technology Tier for faction unlocks, and Local City Tier for an individual HQ.
The [terminology table](GAME_DESIGN.md#terminology) resolves earlier names.

## Evidence and history

- [12 November world, cinematic and audio report](QUALITY_PASS_2026-11-12.md).
- [12–13 November rendering/UX working report](QUALITY_PASS_2026-11-12_RENDER_UX.md).
- [11 November quality report](QUALITY_PASS_2026-11-11.md).
- [Earlier world visual pass](WORLD_VISUAL_PASS.md).
- [Migration context](UNITY_MIGRATION.md), [ring-city context](RING_CITY_REDESIGN.md)
  and [gap-analysis guide](UNITY_GAP_ANALYSIS.md).
- [Archive](archive/README.md), including superseded Unity inventories and frozen Godot records.

Historical checkboxes and benchmark numbers do not grant current acceptance.
Local untracked captures/logs are not durable review artifacts until attached or committed.

## Documentation conventions

Keep one source of truth per subject. Update design in Game design, claims in Current status,
and follow-up work in Development queue; link between them instead of duplicating entire briefs.

Current guides use one H1, descriptive sections, ISO dates (`YYYY-MM-DD`), language-tagged code
fences, repository-relative links and the [shared status vocabulary](VERIFICATION.md#status-vocabulary).
Evidence records its build/ruleset, scene/seed, camera, quality, hardware and limitations.

Preserve dated results and asset attribution. Label superseded instructions as historical.
Do not rewrite an old measurement to appear current, or equate a prototype/screenshot with approval.
