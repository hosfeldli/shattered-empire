# Native living-world and direct-control checkpoint

Baseline: `57c0bb7`. Godot is the only development target; browser/Electron is reference only.
The complete project acceptance contract remains [LWE_REQUIREMENTS.md](LWE_REQUIREMENTS.md).

## Requests implemented in this pass

- Neutral fog with inward boundary blending; unknown cells never become revealed through filtering.
- Connected, terrain-following farmland and industrial yards, stable parcel variation and river margins.
- Connected lake components share a water height, blended depth colors and submerged internal edges,
  including terrain chunks and horizontal wrapping. Mountain elevation has stronger continuous relief.
- Attack / Defend / Explore in the compact unit card. Explore can leave a fixed formation after
  current movement. Right-drag previews a frontage and deploys on release; Tab reverses facing.
- Small material pictograms for resources. Troops use separate circular type icons with counts on
  each tile, names on hover and individual selection rings. Camera movement never changes membership;
  anchors update each frame, with stable layout slots while zooming.
- Available-first research navigation, unlock search, era filters, selected prerequisite paths,
  queue controls and explicit unlock/time/eligibility details across all five eras.
- Double-click matching building selection and one batch-upgrade action that retains selection.
- No routine connection/ping or generic order-accepted notices in gameplay. Useful errors remain.
- AI watching replaces player tools/resources with follow, fog, pause and 1×/2×/4×/8× controls.
  The Varied personality choice and older `mixed` saves now resolve to real AI personalities,
  fixing a live saved-match error that had stopped AI research and later decisions.
- Subtle close-view production pictograms with positive measured output rates, bounded to 12
  simultaneous indicators. Rates come from authoritative building output; no invented tick rewards.
- Improved quarry working faces, benches, stone handling and service equipment.
- Trench spoil-bank cross sections, sandbags, timber supports, junction floors and cosmetic access
  to adjacent friendly bunkers, guard posts, forts and AA. These paths add no cover or connectivity.
  Vegetation clears only the active trench corridor; surrounding trees retain their positions.
- More visible pedestrians and bounded carts/cars derived from visible city population/activity.
  A military unit no longer hides all civilians on its tile. Traffic avoids broken/wet road edges.
- City status describes current construction or a real growth constraint instead of stale logs.

## Findings retained for follow-up

The existing local campaign already had automatic development enabled. Its population was at the
current housing limit (85), with the allowed Housing Blocks built. This is an actual growth
constraint, not permission for the client to fabricate new city development. The new status text
explains it and the batch upgrade path makes the relevant action easy to reach.

Art refinement (including quarry and integrated defenses), full ecological/city-history coverage,
all animation/LOD transitions, sustained large-map battle performance and platform/release reviews
remain subject to [RELEASE_GATES.md](RELEASE_GATES.md). This checkpoint does not close those gates.

Verification, source hashes and local package results are recorded in [VERIFICATION.md](VERIFICATION.md).
Production publication and Cloud Run deployment remain conditional on the outstanding acceptance gates.
