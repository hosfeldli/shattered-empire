# BLIGHT survival mode (objective `horde`)

2026-11-19. User request: "add a flood-like zombies mode like firefight from halo wars, it should be scary and intense
and scale indefinitely." This is an **original** wave-survival mode in that genre: its own name, faction, creatures,
art and sound. Nothing is taken from another game.

## Identity

**The Blight** is a fungal-flesh contagion. It grows out of the ground in **hives** at the far edges of the map, rots
the ground around them, sends waves of mutated organisms at anything alive and raises fallen soldiers as **husks**.
Palette: pale grey-yellow flesh, bruise purple, bile green, bone, wet red sinew (no team colour uses it).

| Creature | Role | Wave-1 stats (hp / dmg / cooldown / speed) | Notes |
|---|---|---|---|
| Crawler | swarm | 30 / 3 / 0.9 s / 1.18 | many-legged knot of claws, hunts troops first |
| Husk | swarm | 48 / 3.5 / 1.0 s / 0.95 | a fallen soldier, risen; still in uniform |
| Spitter | ranged | 52 / 6 / 2.3 s / 0.82 | lobs acid 2.4 units, splash 0.5 at 45 % |
| Mauler | brute | 260 / 20 / 1.8 s / 0.74 | x4 vs structures, goes for defenses first |
| Broodsac | carrier | 120 / 3 / 1.1 s / 0.66 | bursts into 4 (+2 per elite level) crawlers when killed |
| Colossus | boss | 2400 / 45 / 2.4 s / 0.60 | every 5th wave (+1 per 15 waves); slam hits everything within 0.85 |
| Blight Hive | nest | 900 (+15 % per level) | spawns waves, spreads corrupted ground, regenerates; burn it for supplies |

## Rules

* **Setup.** Victory option `horde` ("Blight" in New Skirmish, the lobby and Watch AI). Every player and AI ally is on
  team 0; The Blight is an extra, non-playing civ appended last (team 11). In New Skirmish / Watch AI the format sets the
  squad: 1v1 solo, 2v2 = you + one AI ally, 3v3 = 3, 4v4 or FFA4 = 4 (`matches.js hordeSeats`); lobbies keep their seats.
* **Waves.** 75 s of preparation, then waves. Breathers shorten from 40 s by 1.3 s a wave to 14 s. A wave ends when
  everything it brought is dead (cleared: +100 × wave score, full supply drop) or after 80 s + 2.5 s per wave (half
  supply drop; the stragglers join the next wave). Supply drop to every living player: materials 140 + 32 × wave,
  energy 35 + 10 × wave.
* **Infection.** A squad the Blight wipes out rises again 3.5 s later as husks: 0.17 per man, at least 1 (12-man
  rifle squad: 2, engineer: 1); per wave at most 40 % of the wave's size (bounds the snowball when allies feed it).
* **Hives.** 2 at the start (+1 per extra player), on passable ground 17+ units from every player base, connected by
  land. One more grows in a breather while below 2 + extra players + wave / 3 (max 9), never within 45 s of a hive
  burning. Corrupted ground: radius 2 hexes growing by 1 every 30 s up to 7 + wave / 6 (max 10); creatures on it
  regenerate 2 % a second and move 15 % faster. A burned hive pays every player 260 materials + 90 energy (× 1 + 0.08 ×
  wave) and 600 score.
* **Burrowing ambush.** From wave 8, with chance 40 % + 3 % per wave (max 85 %), a quarter of a wave tunnels up 3.6-6.2
  units from a random player structure; a tremor warning (event + note + HUD) comes 4 s before.
* **Defeat.** The run ends when every player has fallen (the normal HQ-loss rules). `winner.how` = `Overrun on wave N`,
  `winner.horde` carries the run summary for the defeat screen.

## Scaling (hordeDefs.js)

Pressure level `L = (wave − 1) + elapsed seconds / 240`. No caps on strength:

| | formula | wave 1 | wave 10 | wave 50 | wave 100 |
|---|---|---|---|---|---|
| budget (points, 1 player) | 30 (1 + L)^1.3 × (1 + 0.55 (players − 1)) | 30 | 598 | 4 840 | 11 940 |
| hp × | 1 + 0.07 L + 0.0012 L² | 1.0 | 1.73 | 7.3 | 19.7 |
| damage × | 1 + 0.045 L | 1.0 | 1.41 | 3.2 | 5.5 |
| speed × | 1 + 0.35 (1 − e^(−L/18)) | 1.0 | 1.14 | 1.33 | 1.35 |

(time term omitted in the table.) Composition weights: crawler 10; spitter from L 1 (0.6 + 0.25 L, max 4); mauler from
L 2 (0.4 + 0.2 L, max 3.5); broodsac from L 4 (0.2 + 0.12 L, max 2.5). Points: crawler 3, husk 4, spitter 7, broodsac 12,
mauler 16, colossus 120 (bosses are on top of the budget, elite level L / 12).

**Performance cap.** At most `cap` = 160 creatures alive (hives excluded); a wave fields at most
`min(0.85 cap, 14 + 5 L)`. Beyond that `fitRoster` merges pairs of the same type and level into one of the next
**elite level** (hp × 1.7^e, damage × 1.32^e, size × (1 + 0.12 e), score and points × 2^e), so strength is preserved
while the count stays bounded. Groups that find the live cap full wait and spawn as creatures die.

## Creature AI (horde.js)

Cheap and deterministic: no per-creature path searches.

* Two **shared flow fields** (multi-source Dijkstra over the hex grid, direction per hex in a `Uint8Array`):
  `soft` from every player structure and ground unit (swarms, spitters, carriers), `hard` from player structures with
  defenses / fortified structures seeded first (brutes, the colossus). Costs come from the navigation's public coarse
  API (`nav.centreCost`, `nav.crowding`, `nav.edgeOk`, or `nav.stepCost` as a fallback), so rivers, cliffs, mountains,
  bridges and compounds are honoured exactly as unit routes honour them. Rebuilt synchronously every 2.5 s (soft) and
  5 s (hard); the search stops once every creature's hex is settled.
* Near a target (within 4.5) a creature steers straight at it; otherwise it follows its field toward the next hex with
  a per-creature lateral offset (the swarm spreads over the corridor). Separation push from nearby creatures, a heading
  twitch, terrain pace (forest, hills, marsh), standing tests via `nav.canStand` with four deflections, and a nudge to
  the nearest open spot after 3 s blocked. A creature walled in by a player structure attacks it.
* Targets are re-chosen twice a second from `game.targets` by role (swarms prefer infantry and troops, brutes
  defenses, the colossus anything) and kept while valid.
* Strikes resolve through `actionCombat.damageActionTarget` (cover, armour, squads losing men), weapon key `claws`.
  Creature types carry no `weapon`, so `actionCombat` skips them, and are `auto` (never trainable).

## Determinism and saves

`game.rng` only; fixed iteration orders; fields rebuilt on tick cadences and **saved** (base64 direction arrays) with
the rest of the horde state (`persist.js` → `action.horde`). Derived state (corrupted-ground map, last-seen creatures)
is rebuilt on restore. The Blight's civ is created with its keys in the order a restored save rebuilds them
(`ActionGame.initCiv`), so the state hash of a live match equals its restored save's.

## Wire

Every snapshot carries `horde`: `w` wave, `ph` phase (0 prep, 1 breather, 2 wave, 3 over), `t` countdown or wave
seconds, `left`, `live`, `cap`, `total`, `lvl`, `sc` score, `st` seconds survived, `boss` (next/current wave has a
colossus), `hv` [[id, x, z, blight radius, hp %]], `th` threat clusters [[x, z, count, heavy]], `bw` tunnelling warnings
[[x, z]]; with the 1 Hz econ block also `el` {id: elite level} and `stats`. Events `{k: 'horde', o: ...}`: strike,
spit, slam, infect, rise, burrow, tremor, spawn, roar, burst, hive, burn.

## Client (Unity)

* Models: `tools/blender/build_horde.py` sculpts every creature in Blender (headless:
  `blender -b --factory-startup --python-exit-code 1 --python tools/blender/build_horde.py -- unity/Assets/ShatteredEmpires/Runtime/Resources/Models [Kind...]`)
  into `Resources/Models/Horde_<Kind><lod>.bytes` (SEM1, read by `ModelLibrary`; list in `HORDE_MANIFEST.txt`). Each
  design is laid out as organic parts (ellipsoid blobs, tapered tube chains). LOD0: the parts voxel-remeshed into one
  fused surface, relaxed, sculpted procedurally along the normal (lumpy flesh, Voronoi tumour clusters, wrinkle
  creases), decimated to budget. LOD1: LOD0 decimated to about a third. LOD2: the bare low-poly parts with small
  details dropped (silhouette). Vertex colour = palette blended softly between parts × mottling, wet veins, pale
  tumour tops, open sores, bruising × ray-traced AO × ground grime. Channels for the GPU animation: uv0.x = region +
  phase (turns), uv0.y = weight (0 where a limb meets the body, 1 at its tip), colour alpha = 1 − glow. Regions: 0 body,
  1 leg, 2 arm, 3 sac, 4 head, 5 spine/stalk/tendril, 6 jaw (opens toward its phase direction).

  | Kind | LOD0 tris | LOD1 tris | LOD2 tris | Look |
  |---|---|---|---|---|
  | Crawler | 3598 | 1000 | 402 | six high-kneed legs, bead-eye cluster, mandibles, dorsal spines, dragging entrails |
  | Husk | 3200 | 950 | 474 | hunched raised soldier, chest burst by a glowing growth, curled ribs, lolled head, long claw arm, glowing spore stalks |
  | Spitter | 3598 | 1000 | 300 | four legs, long neck, three-petal mouth, veined glowing bile sac with clots |
  | Mauler | 4500 | 1300 | 642 | plated slab torso, tusked sunken head, knuckle-bone clubs |
  | Broodsac | 3600 | 1000 | 336 | membrane bladder with the curled brood pressing through, vent, slime strands |
  | Colossus | 9000 | 2600 | 696 | fused masses with half-sunk skulls, stunted twitching limbs, glowing toothed maw, spine crown, great clubs |
  | Hive | 9999 | 2800 | 606 | rot lobes webbed with veins, ten glowing pustules, gum crown and orifice, swaying spines, roots |

  `HordeMeshes.cs` loads the 21 models and keeps a code-built, equally tagged fallback per kind (used for every LOD
  when a model is missing).
* `HordeRenderer.cs` + `HordeBatch.cs` + `Resources/Shaders/HordeLit.shader`: GPU-animated instancing. The CPU keeps
  per creature only the smoothed heading, gait phase and speed (pooled, no per-frame allocation), tests a bounding
  sphere against the camera's real frustum planes (`GeometryUtility.CalculateFrustumPlanes`, the ground height cached
  from the last visible frame so culled creatures cost no height lookup), picks the LOD from the on-screen height
  (`Lod0Pixels` 56, `Lod1Pixels` 16; LOD2 casts no shadow) and writes one 64-byte `HordeInstance` (position, yaw,
  scale, phase, moving, seed, strike time, rise time, elite, health, engaged) into the batch of its kind × LOD
  (21 batches, persistent `NativeArray` + three rotating `GraphicsBuffer`s that only grow; draw bounds = union of the
  visible spheres). SE/HordeLit builds the pose: heading twitch + hashed sudden jerks, bob, pitch and roll with the gait,
  legs stepping and lifting by phase (idle scrabble), arms swinging about the kind's shoulder pivot, raised overhead in
  the strike's rear-back and clubbed down in the slam, lunge forward, sacs throbbing and swelling before a spit, heads
  trembling with the odd violent snap, stalks/spines/entrails swaying and trailing (more for elites), jaws gnashing and
  gaping, creatures clawing up out of the ground, breathing; glowing parts throb; elites darker, redder, smouldering;
  the wounded paler; wet specular and a sickly translucent rim. Per-kind amplitudes live in one material per kind.
  Hive roots (terrain-tilted tendrils) stay on SE/InstancedLit; corrupted ground as terrain-tilted decals per hex.
  `BuildMs`, `Drawn`, `Culled`, `LodCounts` expose the cost. `UnitRenderer` skips `blight_` types.
* `HordeAudio.cs`: synthesized screeches, growls, wet impacts, acid, roar, tremor, rising, hive burning, slam; the wave
  horn and a tension bed (drone, heartbeat, chittering) that follows the pressure.
* `EffectsRenderer.Blight.cs`: ichor gore and stains, acid arcs, spores, ground eruptions, slam rings, hive fires.
* `HordeHud.cs`: wave / countdown / remaining / score banner, wave warnings, edge arrows to off-screen masses and
  tunnels, defeat screen with statistics and the map's best five runs (PlayerPrefs `se.blight.best.<map>`).
* `GameBootstrap.Horde.cs`: wiring, horn and camera shake at wave start, minimap pings, darker and sicker light rising
  with the pressure (restored afterwards).

## Measured (Node, 152 map, defended bases)

Wave 50 (L ≈ 62): live creatures pinned at the cap (154-160), ~135 of them elites (levels up to 5); wave 100: levels up
to 10, still 160 alive. Horde step median 1.8 ms per tick, creature movement and combat median ~0.5-0.9 ms, field
build median ~8 ms every 2.5 s (1.8-2.8 ms in isolation on the same state; ~2 750 hexes settled of 23 104). Tail
figures from these runs are not meaningful: they were taken with the CPU at 100 % (other test suites running).

## Tests

`test/horde-mode.test.js`: scaling formulas; rosters within the count limit with strength preserved (waves 1-200);
setup (teams, hives, wire); waves arrive and close in, a cleared wave pays; infection raises husks; determinism of two
runs and of a save restored mid-wave; wave 50 holds the cap with elites and a cheap step; defeat summary; creatures are
never trainable.

## Tuning notes

Balance constants all live in `hordeDefs.js` (`CREATURES`, `HORDE`). Early balance: three rifle squads beat the 11
crawlers of wave 1 losing one squad; an idle player with two AI allies is overrun around wave 3-4 (the AI allies are
not horde-aware yet and feed the infection), so real play needs walls, bunkers and armour by wave 5.
