# Native feature parity matrix (2026-11-07)

This table compares each action in the old browser build with the streamlined native client.
"Path" is the shortest way to do it in the native client. Pending and refusal feedback comes from
the server's reply in every case. Retired systems are listed at the end.

| Action | Path in the native client | Eligibility and feedback |
| --- | --- | --- |
| Pan, zoom, centre | WASD / edge / middle drag, wheel, Space | Hitch-capped; no panning while typing |
| Select units and buildings | Click, drag box, double-click same type, 1–9 groups | Selection kept across panels |
| Move, attack, attack-move | Right-click, right-click enemy, E / Ctrl+A | Path failures reported on the unit card |
| Deploy a drawn line | Right-drag, Tab reverses facing | Server assigns slots; formations are drawn by the player |
| Hold, withdraw, stance | H, X, Y and card buttons | Card buttons show the current stance |
| Follow a unit | V or the card's follow button | Pill with a stop button; releases when the unit is lost |
| Form an army | G, or the Army rail button | Army card with Move/Defend/Attack and More |
| Build a building | B → group → building → click a highlighted site | Footprint outline, cursor tooltip with cost, time and city; refusal reason; pending marker; Shift keeps placing; drag places a group with per-site reasons |
| Roads, rail, bridges | Build → Roads → draw, Enter confirms | Blocked segments in red with reasons; exact class preview; works progress on the map |
| Trench lines | Build → Defense → draw trench line | Per-segment reasons; staged construction; crews at fronts |
| Upgrade, repair | Building card (single or double-click batch) | Timed works with progress and ETA; pause, prioritise, cancel with refund |
| Train troops | Select barracks/factory → Train troops | Cost, time and affordability per unit; Shift queues 5; quantity, per-building and repeat options; queue with progress bar and per-item cancel |
| Rally point | Building card → Rally point | Click the map |
| Research | T or Research rail button | Visual tree for all five eras, search, eras, queue |
| City development | Town card → Manage | Balanced/Agriculture/Industry/Military; governor builds and upgrades housing and production within budget; explains caps |
| Economy and shortages | Overview → Economy / Resources | Shortage cause and suggested action |
| Rivals | Overview → Rivals | Observed state only; Initiate attack and Disengage, both confirmed |
| Alerts | Top bar bell and alert feed | Critical events show a banner, major events a pill, both with Go; routine events go to the chronicle |
| Chronicle | Overview → Chronicle | Click an entry to go to its location |
| Map lenses, hide interface | Overview → lens, L, F10 | — |
| Settings | Gear | Graphics presets, UI scale, weather, particles, reduced motion, screen shake, high contrast, labels, markers, borders, audio buses, remappable keys |
| Single player, multiplayer, observer, sandbox, rejoin | Main menu | Server refusals shown on the connecting card |
| Strategic missiles | Overview → Strategic | Range, flight time and interception estimate, then confirmation |
| Air operations | Select aircraft → card orders, Overview → Air | — |

## Retired in the native ruleset

Trading, imports and market purchases, treaties and tribute, governments, policies, taxes,
focus, the manual workforce screen, and rebels. The server refuses these commands under the
native ruleset (`REMOVED_COMMANDS`).

## Not yet available natively

- Selecting a road or bridge segment to see its condition or cancel works on it. Road projects
  and trench works can still be cancelled from Build → More options.
