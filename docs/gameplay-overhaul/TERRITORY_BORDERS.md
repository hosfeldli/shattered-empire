# Territory borders: connected territory only (2026-11-19)

User request: *"When a territory boundary is not connected to a city or captured minor location it should not have a
border, this will prevent old borders from still existing."*

## Root cause of the stale borders
`ActionGame.refreshTerritory` rebuilds `world.owner` from scratch, from three sources:
1. owned sites (an operational headquarters 3 hexes, 4 from Tier II; a secured city ruin 2; an outpost 1),
2. finished claiming defenses (`def.claims`: watchtower, bunker, emplacements, AA battery, artillery post 1; the
   field Outpost 2),
3. dug trench sections (1).

Sources 2 and 3 claimed for any living owner, wherever they stood. When a headquarters fell (`loseBuilding`), the
site was released and its slot buildings were ruined, but its field defenses and trenches belong to the owner, not
the site, so they stayed. Each one kept a ring of its owner's territory round it, so the old border lived on as a
scatter of small islands. The same held for a defense or trench built far out on neutral ground, and for structures
left by an outpost that was later captured by a rival.

A smaller client-side cause: `TerritoryField` fell back to drawing claims from the visible sites and structures
whenever the owner map held no owned hex at all, for example after the local player lost the last of their territory.
That fallback drew rings round every finished structure, including ones the server had released.

## Rule
A hex is territory only if it is connected, through its owner's own contiguous hexes (6-neighbour), to the hex of a
site that owner holds: a city (established or a secured ruin), a base (starting or founded) or a captured outpost.
Bases count because they are sites. Allied territory does not bridge the gap.

`refreshTerritory` now works in four steps:
1. Claim the sites, then the structures (unchanged first-come order).
2. Flood from each owned site's hex across same-owner hexes. Release every owned hex the flood did not reach.
3. Second structure pass, only if step 2 released something. Released hexes can now be claimed by other civs'
   structures, but never by the civ that just lost them, so they cannot come straight back as a pocket.
4. Flood again to drop any step-3 claims that do not connect.

The work is O(N) per refresh, the same order as the existing rebuild. It runs only when the territory refresh
already ran: on capture, on a headquarters lost or completed, on a tier-up, on base founding, on elimination, when a
claiming structure or trench finishes (`territoryDirty`), and on the ~5 s periodic refresh. It is not run every tick.
The scratch buffers are module-level typed arrays. The result is a pure function of game state, so it is
deterministic and reproduces exactly after a save is restored.

## What stays on released ground
- **Structures stay.** A tower, bunker or trench on released ground is not destroyed. It keeps its owner, fights,
  and can be repaired. It now stands on neutral ground, as the neutral-ground defenses in CONSTRUCTION_DESIGN.md do.
  If the gap is closed again (a new link tower, a recaptured site), its claim comes back at the next refresh.
- **Roads are unaffected.** Road edges are not owned. Only the old "neutral ground" checks apply to released hexes.
  These are road recovery (`recovery.js`), crater maintenance and placement.
- **Placement.** Released ground is neutral. Defenses and neutral infrastructure may be built there, and
  territory-only buildings may not. The influence ring (`influenceRing`) and its ×3 surcharge are measured from the
  connected territory only.

## Gameplay implications
- A forward defense extends your territory only if its claim touches it. A watchtower or bunker extends it when it
  stands up to 2 hexes outside your border, an Outpost structure up to 3. A defense farther out is a lone strongpoint
  and claims nothing.
- Chains still work: each link that touches the territory extends it, and destroying a link releases everything
  beyond it.
- Losing a headquarters or outpost now clears all the territory it anchored. A rival can then claim the freed ground
  with its own connected defenses and trenches.
- The AI plans works from `world.owner` (`actionAIWorks`), so it sees the same connected territory.

## Client
- The server sends tile records for every visible hex whose owner changed, and for each of your own hexes that you
  lose, even unseen. A released hex therefore clears in `WorldModel.Owner`, in the territory texture
  (`TerritoryField`) and on the minimap, which reads `WorldModel.Owner` directly. Foreign hexes in fog keep their
  last seen owner until seen again, the normal fog memory.
- `TerritoryField` now keeps using the server's owner map once it has seen any server territory in the current world
  epoch (`tileModeEpoch`). An empty owner map then means no territory, never a fallback to the site and structure
  claims.

## Saves
- No migration is needed. An older save that holds stale pockets drops them at its first territory refresh after
  loading.
- No fields were added to the saved state.

## Tests
- `test/territory-borders.test.js`:
  - A tower far beyond the border claims nothing. One 2 hexes out extends the territory.
  - A pocket cut off by destroying its link tower is released, and its structure stays. Rebuilding the link
    reclaims it.
  - A captured outpost anchors a nearby tower's claim. When the rival takes the outpost, no civ-0 ring is left.
  - Ground released from a stranded civ is taken by a rival tower that connects. A repeat refresh is idempotent and
    leaves `stateHash` unchanged.
  - Losing a headquarters leaves no stale rings round its defenses and trenches.
- `test/neutral-construction.test.js`: the watchtower check now places the tower 2 hexes out, so that its claim
  connects.

## 2026-11-20: trenches and roads never claim; influence shrinks with its claimants
User request: *"The sphere of influence should shrink when the buildings that expanded it are destroyed. When influence
shrinks, you always keep the buildings in that area. You only lose the influence. Buildings left outside your influence
keep working. Trenches and roads should not expand influence."*
- Source 3 above is gone: dug trench sections claim nothing (`claimStructures` reads finished `def.claims` buildings only).
  Roads never claimed.
- `removeBuilding` marks the territory dirty when a finished claimant leaves, so the border shrinks at the next base
  economy step instead of the ~5 s periodic refresh.
- Nothing is destroyed or disabled when ground is released: structures keep their owner and keep producing, firing and
  being repaired (no system reads `world.owner` to switch a finished structure off).
- Tests: `test/orders-vision-2026-11-20.test.js`, `test/territory-borders.test.js`, `test/action-bases-2026-11.test.js`.
