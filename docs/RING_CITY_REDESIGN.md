# Ring-city redesign context

- **Type:** Design change context
- **Updated:** 2026-11-13
- **Scope:** Current ring-city rules and subsequent overrides

The consolidated [Game design](GAME_DESIGN.md) is the current contract.
[Current status](UNITY_PROGRESS.md) records implementation, and [Development queue](DEVELOPMENT_QUEUE.md)
records acceptance work. This page preserves the familiar entry point without duplicating the rules.

Key decisions are fixed 4/6/8 adjacent development sites; Materials/Energy only; faction-wide
technology/capacity with local HQ levels; Materials drops and captured abandoned energy plants;
buildable and automatically connected roads; legal field defenses without engineer selection;
automatic engineer repair/assistance and self-defense pistols; no civilian actors or ambient traffic.

Later interaction feedback removes redundant Army/Objectives tabs, the global upgrade menu and
permanent bottom building/defense shortcuts. Upgrades and production belong to selected buildings;
construction choices follow world parcel selection.

The [earlier ring implementation record](archive/RING_CITY_REDESIGN_BEFORE_2026-11-13.md) is
historical. Its eight-site bottom UI and earlier capture/build claims do not establish current
UI, road, balance or performance acceptance.

## Base presentation, team colour and territory (2026-11-15)

Unverified in Unity (the editor bridge was down); C# was type-checked offline against the Unity
6000.3 reference assemblies and the terrain fragment compiled with D3DCompiler against stubbed URP
headers. Needs an in-editor visual pass.

- **One compound, not a collage.** `Cities/TerritoryField.cs` writes `_SE_BaseGroundTex` (apron ramp,
  HQ plaza ramp, tier, maintained). `SE/Terrain` turns it into a compacted gravel apron under every
  ring base, with a ragged, trodden edge. From tier 2 the inner apron is paved with concrete panels,
  and at tier 3 the paving reaches further out. Abandoned compounds keep weeds in the gravel.
- **Sockets read as elements** (`CityRenderer.BasePresentation.cs`). A built socket gets a gravel yard,
  then a pad that depends on its type: vehicle asphalt for depot and motor works, a gravel yard for
  the generator, and concrete for the rest. Each pad has team-coloured corner marks and a hazard-striped
  threshold where its conduit arrives. An open socket shows a dashed team outline with corner lamps.
- **Connected to the core.** The HQ stands on a paved plaza with a painted team ring and eight lamps.
  A lit conduit runs down every spur, from the ring road to each socket's threshold. It is bright when
  the socket is built and dim when the socket is open.
- **Tier in the world** (the HUD tier text is going away):
  - Tier 1: plaza and conduits only.
  - Tier 2: barrier blocks behind every socket. The authored HQ model stands 10% taller and gains an
    annex and a comms mast with a team beacon.
  - Tier 3: barriers become walls with a team band and watch towers on alternate sockets. The HQ gets
    four plaza flags and a command tower with a dish, antennas and a beacon, and stands 20% taller.
  - The apron grows with each tier.
- **Team colours.** `TeamPalette` reads `ClientSession.CivColor` (relation palette: you are blue,
  allies teal, rivals red/orange/magenta/yellow/violet). In action mode that palette is linear, so
  `TeamPalette` re-encodes it to the sRGB-style albedo that city tints use. The HQ model's faction
  panels now glow faintly so the colour still reads at strategic zoom. When the local civ or the civ
  roster changes, every cell is recomposed.
- **Territory border.** `_SE_TerritoryTex` stores the owner colour and a signed distance to the border.
  The territory comes from the server's per-hex owner (`WorldModel.Owner`) when present, otherwise from
  site claims. Corridors join an owner's headquarters that are less than 13 units apart. Where two
  owners meet, the border runs half-way between them. The terrain draws a soft pulsing line in the
  owner's colour with a faint inward wash. It is thin and quiet up close, and wider and clearer at
  strategic zoom. The orthographic match camera is handled through `unity_OrthoParams`.
- **Roads between bases.** Country roads (not urban, rail or service) now sit in a dusty gravel verge
  and carry painted edge lines. Rural tracks get wheel ruts. The procedural Soil surface map now has
  pebbles.
- **Terrain fidelity.** Grass and earth photos and their normals are hex-tiled (Mikkelsen 2022), with a
  far-scale photo layer and three octaves of macro noise: lush and dry hue drift, bare patches and damp
  ground. Rock blends in by height. Crater bowls get torn clods, a scorched core, pale rim debris and
  clod normal relief.
- **Perf.** `CityRenderer.Draw` now tests each cell's bounds once before drawing its batches, and skips
  empty batches.
