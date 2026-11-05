# Simple native controls and development coverage

This is the current native interaction contract. It supersedes the earlier permanent rail and
large workspace layout. The later user instruction removes the minimap entirely.

## On the map

- Only Build, Army and Research are primary tools. Overview contains cities, economy, known
  rivals, chronicle and map lenses. Settings stays in the top bar.
- Selection opens a small card. Uncommon orders are secondary; clearing selection hides the card.
  Management drawers leave the map interactive. Menus and text entry block gameplay input.
- The build palette is 300 logical pixels wide, with City, Resources, Industry, Roads and Defense
  groups. Unlocked structures have pictures rendered from their world models. Search can also
  explain locked structures. Era/technology changes refresh availability.
- Placement uses finished-model geometry, terrain siting and compatible district connections.
  A 32-entry cache preserves the proposed appearance. Geometry variation uses stable world/site/
  type/recipe/purpose identity, so server allocation of a new entity ID does not change the preview.
- The authoritative site query returns validity, a short reason, exact cost, shortages and a base
  construction-time estimate. Time assumes one crew and current research; staffing, resource queues
  and project priority can delay completion. Ordinary placement is one click; Shift/drag queues more.
- Training opens in the selected production building's card. Quantity, per-building distribution
  and repeat production are expandable. Rally and attack-move targets commit on a map click.
- Army selection exposes Move, Defend and Attack. Individual movement, queued right-click orders,
  deployment drawing, facing and control groups remain available. Routes are temporary feedback.
- Research opens the technology tree with prerequisites, unlocks, current-rate time estimates and
  an inline queue. Cities expose automatic development and local priorities rather than civic controls.
- Low-health units have a short screen-space indicator. Critical alerts can interrupt visually;
  resource and other actionable reports remain accessible from the compact top bar.

`CommandRegistry` owns the native action definitions, submission, pending tracking and feedback.
The server still checks legality and changes simulation state. Decorative models and previews never
enter gameplay picking, collision, cover, movement or ownership data.

Settings retain display/audio/camera options and add weather, particle density, reduced motion,
optional screen shake, contrast, labels/markers and core command key bindings. No trading,
government or treaty-management controls are exposed.

## All five eras

The rendered [catalogue](ui-validation/catalogue-validation.json) uses the running server's definitions.
There are 32 active player building types and 23 unit types. Retired depots and rebel-only camps do
not appear in the player's build palette. Existing rebel rendering remains supported.

All 23 troop types have explicit role-specific compositions. These include mechanized transports,
main battle and autonomous tanks with separate turrets, self-propelled guns, missile and air-defense
vehicles, helicopters, fighter/bomber/recon/strike aircraft, drone swarms, special forces and exo armor.
Shared authored components remain part of the modular library; explicit composition does not mean
23 completely independent art assets.

The 17 server-upgradable building types have distinct levels 1–3, giving 66 building/type/level
variants in the audit. Housing preserves the original homes and adds apartments. Industrial
upgrades add wings and equipment. The four server city tiers retain their old civic core while
adding development. Architecture is not regenerated merely because the observing player's era changes.

Advanced factories, drone works, robotics, fusion, shields, silos and the arcology have distinct
layouts. Actual HP selects material damage; ruins clip surviving walls to a collapse height and
add bounded rubble. Construction progressively realizes the final structure, with cached templates,
foundations, framing, exterior and finishing geometry. No broad decorative building plates are added.

Review [troops](ui-validation/troop-catalogue.png), [buildings](ui-validation/building-catalogue.png),
[development](ui-validation/development-levels.png), [destruction](ui-validation/advanced-destruction.png),
[placement](ui-validation/building-preview.png) and [recruitment](ui-validation/recruitment.png).
Catalogue sheets are explicitly labelled presentation fixtures; they do not add hypothetical objects
to the real match. Coverage checks establish functional representation, not final art approval or
large-battle/late-game performance acceptance. Remaining release gates stay in [RELEASE_GATES.md](RELEASE_GATES.md).
