# Documentation review — 2026-11-13

- **Type:** Review guide
- **Updated:** 2026-11-13
- **Scope:** Documentation-only commit; implementation work remains separate

## Review order

1. [Game design](GAME_DESIGN.md): current owner decisions and terminology.
2. [Current status](UNITY_PROGRESS.md): published/local/pending distinctions and evidence limits.
3. [Development queue](DEVELOPMENT_QUEUE.md): latest unresolved requests and acceptance criteria.
4. [Architecture](ARCHITECTURE.md), [development](DEVELOPMENT.md),
   [verification](VERIFICATION.md) and [release](RELEASE.md): engineering and delivery contracts.

## What changed

- Replaced the root README's civilization/Electron description with the current Unity military RTS.
- Established one documentation index and one owner for design, status, backlog, architecture,
  setup, verification and release information.
- Consolidated ring sites, Materials/Energy, local/global tiers, Materials drops, captured Energy
  plants, free field construction, engineer automation, roads and civilian-activity overrides.
- Recorded the latest contextual UI, road/bridge, map-use, very short grass, independent infantry
  and mountain-camera requirements without calling unfinished work complete.
- Replaced stale append-only Unity inventories with focused current guides and source navigation.
- Preserved earlier documents in the archive and labeled Godot/legacy guidance at its entry points.
- Standardized dates, terminology, status vocabulary, links and code examples.
- Removed unsupported build-switch, current-platform and production-performance claims from
  active guidance. Historical measurements remain identifiable as historical.

## Implementation boundary

This commit does not include or publish the ongoing simulation, shader, mesh, UI or asset edits.
Some local rendering builds/captures precede the latest road, bridge, map and interface amendments.
Those later changes need a new build and visual review. Independent soldier movement and the
mountain-camera correction remain open requests at this checkpoint.

The [working quality report](QUALITY_PASS_2026-11-12_RENDER_UX.md) records intermediate evidence
without assigning approval to later source. The [release runbook](RELEASE.md) distinguishes
server deployment from the public Windows archive.

## Validation for this commit

- Active-document checks passed for 18 guides, 166 local links and five heading anchors.
- Unity pin, assembly names, build entry points, endpoint, ruleset and save-schema references were
  checked against repository source and workflow configuration.
- Metadata, dates, terminology, code fences and Git whitespace were checked.
- Staging is limited to documentation and the two explicitly identified review images.

No gameplay, load or performance result is produced by documentation validation.
