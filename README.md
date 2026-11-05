# Shattered Empires

A grand-scale RTS where you rebuild a civilization on a shattered world that wraps around east to west. Armies hold real ground behind supplied, entrenched lines; cities grow from a real population ledger, workers are allocated to the jobs that matter, governors and rival empires plan with the same tools you do, and armies are drawn from your people.

**Native development:** the active client target is [Godot 4.7.2](godot/README.md). The
[Living World Engine checklist](godot/docs/LWE_REQUIREMENTS.md) tracks the complete procedural-world
design and [native status](godot/docs/STATUS.md) records validation and remaining gates. The older
Electron/PixiJS sources and documentation below are retained as reference; new client work targets
Godot. Native builds are currently development previews.

The [streamlined native redesign](godot/docs/NATIVE_REDESIGN.md) replaces government/treaty
management and removes trading entirely in new native matches, with versioned legacy-save support.
It also documents the current native UI, ordered trench construction and fine water/weather work.

## Architecture: the cloud does the thinking

```
Desktop app (Electron + PixiJS)          Cloud Run (Node.js; one worker thread per match, 10 Hz)
 ├─ draws server-shaded hex colours  ◀──  world gen · weather · hydrology
 ├─ interpolates unit positions      ◀──  A*, shared flow fields, formations, tile/bridge capacity
 ├─ ambient city life from aggregates◀──  economy · local stockpiles · freight · population · governors
 ├─ sends intents (move, build, …)   ──▶  combat · supply · armies · AI empires · rebels · diplomacy
 └─ shows fog-filtered snapshots     ◀──  fog of war, placement checks, road planning & costing
                                          snapshots → Cloud Storage (matches survive deploys)
```

The game is played in the desktop app for Windows and macOS; the website (game.liamhosfeld.com) is only its downloader. Everything that decides the game runs on the server — there is no offline mode. Clients never see unexplored or hidden data: tile changes only reach a player when they can see the place; foreign empires expose no economy or score; AI empires plan only from what they have observed.

### Eras
Reclamation → Industrial Recovery → Mechanization → Networked Warfare → Advanced Systems, over a branching 37-technology graph with a research queue. 20 unit types across four movement classes (infantry, wheeled, tracked, aircraft) that interact differently with roads, bridges, rivers, slopes and marshes; engineers repair, fight fires, clear rubble and blast passes.

### Living infrastructure
- **Roads** are an edge graph (dirt, paved, highway, rail) drawn freehand or by waypoints with a costed server preview; bridges, per-segment damage, repair and traffic.
- **Logistics**: cities share the national stockpile only through the road/rail/sea network, limited by the freight capacity of the weakest link; cut-off cities live on local reserves.
- **Buildings** go planned → under construction (crews, engineers) → operational → damaged (half output, can burn) → ruined (rubble, salvage, rebuild at half cost).
- **City governors** automate any city with a specialization, a resource reserve, explicit permissions and a log explaining every decision. AI empires use the same governors.
- **Armies** take one order and manage formation, stance and spacing; tactical defend zones; automated offensive preparation; rally networks; control groups; double-click selection.
- **Rebel Free Companies** raise camps in the wilds, raid, occupy ruins and absorb revolting cities.
- **Alerts** are levelled (info/minor/major/critical); a command history records who ordered what — you, a governor or an army — and why.
- **Everything is visible in the world**: buildings are drawn as structures on their hexes (barns and silos, pumpjacks, cooling towers, star forts, runways, piers facing the sea) in the owner's era materials and colours. Planned sites are gold blueprints, construction rises from a foundation, damaged buildings are scorched. Status badges show what is wrong right where it happens: no workers, missing input (named up close), no power, awaiting funds, damaged, on fire, training (with a progress ring). City banners carry population, capital and governor plan, with famine, cut off and unrest in words. Armies fly standards with their orders. Press **K** in game for the map key.
- **The world looks alive**: districts grow with population and era, pedestrians, traffic and freight trains follow the real roads, factories smoke, farms change with the seasons, farmsteads and fields spread round the towns, rivers meander and widen downstream, every town has a paved civic square, older streets keep their timber or brick after the era turns until they are redeveloped, an occupied city has the new owner's patrols, construction sites have cranes and crews, and damage leaves fires and rubble. Live effects (smoke, fire, traffic) appear only where you can see; a remembered city does not keep smoking through the fog.

### Weather, seas and bridges
- **Regional weather**: a deterministic, saved weather grid (cells of 8×8 hexes) carries wind, humidity, cloud, rain or snow, fog, ground wetness and the odd storm. Fronts blow in, cloud forms over the sea and high ground, rain spends it and soaks the land, calm humid air pools into fog along rivers and coasts. Weather systems — cyclones born over the sea — drift with the prevailing wind and spin the air around them, so cloud is carried along a real wind field and wraps into spiral bands whose cores thicken into rain and storms, then fill and die away. The weather is shown by the clouds themselves: a GPU shader draws a continuous, churning, fluid-looking sky (domain-warped noise advected downwind and twisted round each cyclone, lit from the sun, grey and heavy where it rains or storms), with soft shadows on the ground; it thins as you zoom in and never shows over unexplored land. Fog banks and darkened wet ground lie below. No rain or snow streaks. Permanent daylight. Effects are mild and capped: heavy rain or snow slows off-road movement by up to 15%, dense fog costs units one hex of sight, and aircraft do not take off into a storm. *Weather effects* (Full / Reduced / Off) in the display settings; without a GPU the cloud shader is skipped automatically.
- **The sea moves**: glints drift with the wind over open water up close, and foam washes along every coast (livelier in wind and storms). World-anchored and seamless across the wrap.
- **Bridges** are a tool next to Roads (Build → Infrastructure): click both banks of a river or a narrow strait. *Timber Bridge* (infantry and light vehicles, not over major rivers), *Reinforced Road Bridge* (Civil Engineering: everything, tanks included) and *Rail Bridge* (Railways). A bridge spans up to two or three hexes of shallow water — never deep sea — is built by the same crews and from the same road network as the road planner (no double building or paying), carries exactly the units its class allows, slows when damaged and stops carrying anyone when destroyed until it is rebuilt. Bridges are drawn as timber decks, concrete decks with parapets or steel trusses, with piers in the water, and broken stubs when destroyed.
- **Resource deposits** show in the ground itself (rust-red rock, a coal seam, pale stone, an oily slick, violet crystal) and as crisp markers that keep the same size on screen at any zoom, each kind with its own shape as well as its letters (Fe, C, Oi, St, Re, Fi, Ru). Markers can be turned off in the display settings.

### Population, labour and governors
- **Expansion has a price**: every city you hold makes the next colonist dearer (+45% each), cities must be 7 hexes apart, an empire larger than its era can run (3 cities + 1 per era) is restless everywhere, and each new settlement strains the whole nation's stability for its first four minutes. AI empires keep the peace for the first fifteen minutes and rebels do not raid in the first ten.
- **Eras come by themselves**: there is no era to buy — knowing enough of an era's technologies starts the next one at once. The bottleneck is industry: from the Industrial era on, a technology needs goods to begin (materials and ore, then steel and fuel, then electronics); a project left waiting on goods gives way to one that can proceed. Research picks itself whenever nothing is chosen; the queue is yours to steer (no goals).
- **Governments that matter**: each favours branches of the research tree (30% faster there) on top of its economic and military effects, shown as cards with every effect listed; policies fill its slots.
- **A long, meaningful tree**: later eras' technologies cost far more and every technology known makes the next a little slower, so the tree takes most of an hour; every technology also gives a nation-wide bonus (output, construction speed, attack for a class of unit, movement or stability), listed in its description. **Energy Shields** (Networked era) unlock the Shield Generator: a powered dome over your units and buildings within 3 hexes soaks up incoming fire until worn down and recharges after the shooting stops.
- **Engineers roam** the territory on their own when idle: the most damaged (or burning) building first, then construction sites.
- **Tutorial** on the main menu: a short guided match through every main system.
- **Runs itself, you steer**: every city starts with an autonomous governor, research picks the next useful technology whenever nothing is under research, and the nation saves for and enters the next era as soon as it qualifies (*Automatic research* in the research screen turns it off; your own picks always come first). The tempo is brisk: research, construction, training and eras are quick, troops move fast, the Industrial era arrives in about five minutes.
- **A few strong extraction sites**: farms, timber mills, quarries, mines, oil wells, salvage yards and ports yield from the land itself, staffed or not, and each neighbouring hex of the right kind (woods round a mill, hills round a quarry, open fields round a farm, sea round a port) adds 15%; their workers add on top. One or two good mills keep a city in materials.
- **Build up, not only out**: workplaces are large (five jobs for most, three for ports and wells), so a city runs on a handful of well-staffed buildings rather than a sprawl of small ones, and they grow through three levels (*Expand*: +67% / +134% jobs, +35% / +70% output; level 2 needs the next era, level 3 the one after, and steel from level 2), each costing about as much as the building itself. Houses add storeys and hold more people each. Double-click any upgradable building to select every one of its kind on screen (Ctrl/Cmd: the whole map) and upgrade them in one order.
- **Construction queue**: an order you cannot pay for yet is queued, never refused. Sites are funded strictly in the order you placed them (a cheap later order never starves an expensive earlier one), and each city's crews work on a few sites at a time (two, plus one per city tier) and finish them quickly while the rest wait their turn, marked *Queued* on the map. *Build next* moves a site to the front; the town hall lists the city's queue. In build mode, drag across hexes to place several at once, or Shift+drag to fill an area. When every hex is full, a city develops by upgrading what it has, and governors and the AI do the same, starting with whatever is scarce.
- **Districts merge**: neighbouring buildings of compatible kinds and the same owner join into one district — housing into terraces with back gardens, industry into one works yard with pipe runs and rail spurs, farms into one stretch of aligned fields with a single farmstead per estate, markets into a trading street, civic buildings round a square, mines and quarries along haul tracks. Each building stays individually selectable, upgradable and destroyable; a destroyed one leaves a gap. Towns are set into the land, not stood on it: the ground they build on is cleared and worn (trodden earth, kitchen gardens, a few kept trees), the woods round them are thinned, district ground feathers into the terrain, and buildings have contact shadows and planted plots instead of hexagonal tokens. Ownership shows in flags and trim, and as the owner's outline when you point at a building.
- **City tiers**: a town becomes a City, a Metropolis and a Megacity as it grows and the eras advance; each tier adds homes and jobs at its centre, output from the town hall and stability, and the district visibly densifies into blocks and towers.
- **Feeding a nation**: food per person is lower, farms and ports yield more, and cities joined overland or by sea share food without freight limits, so a growing country can feed itself; housing is a hard cap on growth, so people stop arriving when there is nowhere to live rather than starving the city into revolt.
- **Resources**: mines can be dug into bare hills and mountains (under half the yield of an iron or coal deposit) and quarries give a little ore, so a mechanised army is never blocked on one deposit; the Synthetic Fuel Refinery makes fuel from ore and timber where there is no oil.
- **Population ledger**: every city counts civilians, recruits in training (reserved) and serving soldiers. Training draws on a recruitable share that never strips essential workers; cancelling returns the people, demobilising sends most of them home, casualties are a real loss. Growth follows food, housing (blocks gain storeys), stability and services, with a post-war recovery boost.
- **Workforce**: food first, then your category priorities (or a mode: balanced, growth, industry, research, commerce). Lock a building's staff or switch it off; every building says why it is or is not staffed (no power, missing input, storage full, no rare earths…). An auto-balance preview shows the change before you apply it.
- **Governor autonomy**: Off, Advisor (proposals only), Managed (routine work), or Autonomous; goals, a spending budget, emergency powers, and proposals you approve, defer or reject. The forecast planner scores every option (benefit + resilience + specialisation − cost − risk) and explains what it holds off on and why.
- **Era progression** is paced (economy 2–4 min, rifles 4–8, industrial 10–15, mechanised 18–25, networked 30–45, advanced 45–60) with national savings for the next era, refits that keep veterancy, and logistics upkeep that limits unit spam. The readiness panel shows what stands between you and the next era.

### Front lines, trenches and logistics
- **Moving troops**: one choice per selection — **Defend** (hold where sent and fire; never chase, at most stepping onto better cover right beside them), **Attack** (fight their way to wherever they are sent; idle, they hunt enemies they see nearby and take the best cover when the enemy is about) or **Explore** (scout on their own: unexplored ground first, then whatever has gone unseen the longest); then right-click to move, right-click an enemy to attack, right-drag to draw a battle line. A line spreads the force evenly from end to end, faces away from the nearest of your cities whichever way it is drawn (Tab flips it), and mortars and guns fall in a rank behind. Q selects every combat unit on screen (Shift+Q the whole army), E attack-moves. Selecting several production buildings and right-clicking sets one rally point for all of them; new units gather round its flag. Every unit is a badge in its owner's colour with its own silhouette (rifles, tanks, field guns, helicopters…; round for infantry, a box for vehicles, a diamond for aircraft), the illustrated sprite taking over close up.
- **Line deployment**: right-drag a line. A long line spreads them one per hex; a short one concentrates them up to each hex's capacity, with support and artillery falling in behind (shown live while you drag: green / amber / red, with a *Spread out / Concentrated / Packed tight* label); they defend it (engage nearby, then return). Alt+right-drag advances instead, Tab reverses the facing while dragging, Shift queues, Esc cancels. The client runs the same planner the server validates (`server/sim/deploy.js`). Formations persist (save/restore), can be reinforced, and a unit moved by hand detaches until it rejoins; ordering the whole formation somewhere else ends it.
- **Area fire hits every unit on a hex**: a mortar or howitzer shell on a stack of six squads resolves six hits. Concentration holds ground; it also invites artillery.
- **Trench lines**: Build → Defenses → **Trench Line** (or *Fortify* in the command bar) draws a line like a road: preview shows valid segments, cost (earthworks 6 materials / 10 s per hex, reinforced 10 / 18 s; reinforcing earthworks charges only the difference), completion time and the protected side (**Reverse Facing**). National construction crews dig several segments at once; no troops stand on the line to build it. Cover is directional, weak for vehicles, degraded by explosives, repairable. Never on buildings or developed districts. Guard Posts, Bunkers (shelter adjacent troops), Fortresses and AA Batteries complete the Defenses palette (*Show locked* lists what research unlocks).
- **No man's land**: every shell, wreck and death wears the ground down — churned, then cratered mud, then wire and debris. Vehicles bog down, infantry find shell holes, fields stop producing; it heals slowly once fighting moves on. It is drawn as connected landscape, not dark hexes: scarred ground spills over hex edges and joins up along a front, shell holes overlap into crater fields, woods lose their canopy to broken trunks, wire and abandoned scrapes run along the line of the front, and craters hold water when the weather has made the ground wet (all decoration: none of it blocks or shelters anyone). Infantry holding under fire scrape out temporary foxholes (capped, gone when abandoned).
- **Ground is held**: hostile ground units never share a hex or swap places, and a combat unit's zone of control stops anyone sliding along or through a line (stepping back out is always allowed; aircraft overfly). Break a line with fire, or go around its end.
- **No troop supply to micromanage**: units are always supplied wherever they are. They recover strength out of combat (fastest in friendly territory and next to a fort); national food and fuel use still follows what the army is doing. Supply trucks and depots are gone from the build and training menus (existing depots stay as obsolete buildings).
- **AI battle lines and hordes**: AI empires at war hold a front toward each enemy — a line across the approach to their nearest city, deployed in depth, then dug in as trenches. When they attack they mass quickly and rush the objective as a horde in up to three prongs (front and both flanks), guns following the main body, stragglers and reinforcements thrown back in every few seconds; they declare war sooner and come back faster after a repulse.
- **Smoke and sight**: thick smoke hides what stands in it, but never your own land: your territory stays in view (no more own-coloured land greyed out after a battle).
- **Front Lines view**: the front itself (where your land meets an enemy's) in red, every trench line, and a suggested defensive line across the approach to each threatened city — click it to start digging there. Trench lines are drawn as the map symbol (a line with teeth toward the enemy) zoomed out and, up close, as a zig-zag trench with sandbags, barbed wire in front and pillboxes on reinforced lines. Each map view has a one-line key under the lens button.
- **Front Lines and Tactical lenses**: who controls which ground, contested gaps, fortified positions, formations, objectives and units in trouble — only what you can see.

### Battles
Fire is shown as it happens on the server: muzzle flashes and tracers, shells that arc and land when the server resolves them, rockets and guided missiles trailing smoke, bombs dropped from the aircraft overhead. Impacts throw up dirt that falls back round a fresh crater, leave scorch marks and drifting dust; destroyed vehicles brew up and send a column of smoke into the wind; gunsmoke hangs over every fight. Strategic missiles climb on a thick exhaust trail and come back down glowing; the detonation sends a shockwave across the whole zone, lifts a mushroom cloud and scorches the ground. Fixed-wing aircraft fly a real course — constant speed, banked turns, orbits over a patrol area, straight runs over a target — while helicopters drift and hover.

### Air war
Fighters, tactical bombers, attack helicopters, recon drones, strike swarms and one-way strike drones fly **missions** from airfields and drone works: Patrol, Strike, Scout, Support, Return. One order runs the whole cycle — launch, outbound, on station, return on fuel or ammunition, landing (slots, a holding queue, diversion), servicing from real national fuel, munitions and steel, relaunch. Patrols persist across servicing; a destroyed base sends its aircraft elsewhere. Weapons have explicit target classes: rifles and tank guns cannot hit aircraft, AA batteries cannot hit tanks, fighters intercept. Airfields show their aircraft and launch missions with automatic aircraft choice; right-click with aircraft selected does the obvious thing (enemy: strike, ground: patrol/scout, own airfield: return). The AI builds, patrols and strikes with the same rules and keeps helicopters out of known AA cover.

### Cities, sieges and the endgame
Cities are operational, damaged, besieged, defenseless, recently captured, or resettling. Ground troops next to a broken town capture it (nearby buildings inside the new borders change hands); a town shelled with nobody to take it is eventually **ruined** rather than held at 1 HP forever, and its ruins can be resettled (*Rebuild settlement*). Rebellions have cooldowns (a city ~300 s, the nation ~120 s, plus post-capture stabilisation), all saved. AI nations finish wars with a **Final Campaign** against an enemy's last cities and walk troops in once the town is broken; their guns suppress bunkers and forts first. **Strategic missiles** (Strategic Missiles → Missile Silo → a long paid project per missile) are seen coming by everyone, can be intercepted by upgraded AA with Missile Defense (deterministic rolls), devastate the target, leave fallout and turn world opinion against the launcher; the AI fires only when it is worth it.

### Interface
A command rail (World, Build, Cities, Military, Economy, Research, Government, Diplomacy, Chronicle) opens full-size management workspaces over the map; the right-hand inspector appears only when something is selected. **Research** is a full-screen technology graph (eras left to right, categories in lanes) with search, filters, prerequisite/unlock highlighting, an inspector and a queue (add with prerequisites, reorder, goals across eras); progress is kept per technology. **Economy** shows the national balance, a production-chain explorer and a city development planner built on the governors' scoring. Grouped alerts (critical / actionable / info), a search palette (/ or Ctrl+K), Escape closes the innermost layer, and display preferences (interface size, graphics preset — Low, Medium, High, and Ultra for the desktop app —, particles, screen shake, reduced motion, faction markings, high contrast). Units are illustrated sprites from a texture atlas (`node tools/unit-art.mjs` regenerates it), with role symbols at strategic zoom and grouped stacks. The world is lit by consistent daylight (no day/night cycle).

Selected units get a **command bar** with only what they can do (troops: Move / Attack / Hold / Fortify; aircraft: Patrol / Strike / Return; recon: Scout / Return; one-way drones: Strike / Cancel; everything else under *More*). WASD always pans; Ctrl/Cmd+A attack-move, H hold, X withdraw; held keys never repeat orders. Floating panels stack instead of covering each other, map tooltips wait for the pointer to settle, and **P** (or the pause button) pauses single-player matches. The economy workspace explains every resource (what makes it, uses it, why it is falling, what to do next) with an exact income/expense ledger.

### AI difficulty
**How the AI thinks** (`server/sim/ai2/`): a coordination layer wraps the AI's planners (economy governors, military missions, air planner, research and diplomacy):
- *Perception and memory*: an AI sees only what its empire sees (no reading enemy positions through the fog) and remembers sightings with fading confidence, where its men died, regions of its land that keep getting raided, and moves that failed.
- *Director*: one national objective at a time with a commitment period; campaigns as staged objectives (prepare, stage, approach, engage, capture, consolidate); a public **posture** (Expanding, Developing, Defending, Preparing, Attacking, Recovering) shown to players who have met the nation — the plan behind it stays private.
- *Blackboard*: who controls every asset (a mission, the air force, the reserve), with transfers recorded, and reservations for planned spending that governors respect.
- *Command arbiter*: every AI order goes through it and is refused when the units belong to another controller, when it repeats an order still being carried out, when it would yank units far away moments after the last order, when it dips into reserved funds, or when the same order has already failed three times in a minute.
- *Execution monitor*: missions are watched for progress; a blocked or stalled mission gets a bounded local reroute, and after three attempts it is ended with the reason recorded — never stuck forever.
- Personalities are stable traits (aggression, risk aversion, patience, territorial ambition, diplomacy); difficulty sets competence (planning horizon, scouting, estimate quality), never reliability. Everything is saved, so a restored AI continues the same plan. Spectators can open **AI plan** to see the followed empire's objective, orders sent and refused, stalls and recoveries, memory, reservations and its recent decisions.

Relaxed, Standard, Hard, Expert and Brutal differ in *skill*: reconnaissance, reserves, retreat judgment, counter-composition, screens, raids, fortified defence lines, dispersal under artillery, and a strategic layer that commits to one goal at a time. **Fair Play** (the default) gives no AI any numerical bonus; only Brutal can be given disclosed economic help. Saves from before keep their old settings, marked *legacy*.

### Production and sound
- **Multi-building production**: Alt-drag to box-select buildings, Shift-click to add one, double-click for all of a type on screen (Ctrl/Cmd for the whole map). One order trains *N in total* (each unit goes where it finishes soonest) or *N per building*, is charged exactly once, queues what it can and says what blocked the rest. Repeat production keeps a facility busy while it can afford a double order. Rally points apply to the whole selection.
- **Spatial sound** (Web Audio, synthesised, nothing to download): volleys, launches and impacts panned and muffled by where they are on screen, ambience that follows what is in view (wind, sea, forest, city, industry, distant battle). Only what you can see is heard. Volume sliders in the menu, **M** mutes; audio waits for your first click and pauses in a background tab.

### World
Four world styles (continents, pangaea, archipelago, inland sea) on a seamless east–west wrap: movement, roads, vision, borders and the camera all cross the seam. Starts are checked for fair access to food, materials, metals, fuel and rare earths. AI rivals come in four difficulties (Relaxed to Brutal), which change their economic efficiency, army size and how fast their generals react — never your empire.

### Server performance
Each tick runs through a scheduler: every system has a cadence, a phase (the once-a-second systems are spread over the second) and a time budget, and records p50/p95/p99/max timings and overruns (`/api/metrics`; the slowest systems also appear in `/api/health`). Autosaves are captured on the tick and compressed off it. On live servers AI planning may slide a tick when one runs long; tests and replays stay deterministic. New matches are refused with a clear message when the running ones already use most of the CPU or memory.

### Server administration
With the player name **Liam6642**, the main menu shows *Server admin*. Enter the PIN to see every match on the server — mode, status, players and who is connected, spectators, game time and tick cost — and close any one of them, or all of them. Closing ends the match for everyone in it (they are returned to the menu with the reason) and deletes its save. Name and PIN are checked by the server only (`ADMIN_NAME`, `ADMIN_PIN` in the service environment override the defaults); after five wrong PINs from one address, or 25 across the server, sign-in is locked for 15 minutes.

### Watching AI matches (testing)
**Watch an AI match** in the lobby starts an AI-only game with no fog of war: every empire's units, cities and buildings are visible, with full city detail. Follow any empire to see its economy, research and cities in the panels, switch to its fog of war to check what it can see, run the match at 1×, 2×, 4× or 8× speed or pause it, and see AI offensives as arrows to the city they are marching on. Running matches also appear in the lobby with a **Watch** button. Spectators cannot give orders. Keys: `[` `]` follow previous/next, `P` pause, `,` `.` slower/faster, `V` fog.

## Desktop app (Windows and macOS)
`desktop/` is the game's client: Electron with the browser client bundled inside (`npm run prepare-app` copies `client/`, the shared deployment planner and PixiJS into the app) and served from a private `app://` origin, so no game code is downloaded at run time. Every match runs on the deployed server: the app connects to `wss://game.liamhosfeld.com/ws` and reads the small JSON API (match list, map previews) cross-origin. **Steam** (Spacewar test app 480 until the game has its own app id) is the social layer: in a multiplayer waiting room, *Invite Steam friends* opens a Steam lobby that carries the server's match code; accepting the invite (overlay, Steam chat, or Steam launching the game with `+connect_lobby`) joins that match on the server. The lobby also lists friends' matches. Without Steam the app plays normally.

**Installing and updating.** Windows gets a single `.exe`: it installs per user with no wizard and no administrator prompt, and starts the game. macOS gets a `.dmg` (drag to Applications). After that the app keeps itself current: it checks the download site on start and every 30 minutes, downloads the update for its platform and architecture in the background (SHA-256 checked), and the main menu offers *Restart to install* — on Windows the setup runs silently over the install and relaunches the game, on macOS the new app bundle (published as a zip per architecture, not shown on the download page) replaces the old one in place. Every CI build gets a higher version (`major.minor.<run number>`), so installed apps always see it. Builds from before the updater existed need one last manual install.

**Main menu**: the generated continent fills the screen as a hex map; pick a mode on the left (Play against the AI, Multiplayer, Watch the AI, Combat sandbox, Return to your last match) and its settings and single action appear on the right, with world options folded underneath. With Steam running, you play under your Steam name.

The app is tuned to push the renderer further than a browser tab: it asks for the discrete GPU, ignores Chromium's GPU blocklist, rasterises on the GPU, never throttles when in the background, renders at the display's full pixel density, and starts on the High graphics preset (Ultra adds the densest battles).

```bash
cd desktop && npm install
npm start            # run from source against game.liamhosfeld.com
npm run start:local  # against a local server (npm run dev in the repo root)
npm run dist:mac     # dmg for Apple Silicon and Intel (ad-hoc signed unless a Developer ID is configured)
npm run dist:win     # NSIS installer (x64)
```

**The website is a downloader.** The Cloud Run service serves the download page at `/` (and `/download`), the installers from `downloads/` in the game's Cloud Storage bucket, the API and the game WebSocket — through the same load balancer → Cloud Run path as before. The container image no longer contains the client. The *Desktop builds* workflow (tags `v*` or manual) builds macOS and Windows on GitHub runners and publishes them with `desktop/scripts/publish.sh` (also runnable from any machine with bucket access).

## Develop locally

```bash
npm install
npm run dev          # game server at http://localhost:8080; SERVE_CLIENT=1 also serves the client there for development
npm test             # simulation, systems, overhaul acceptance, fairness, persistence, protocol and load tests
node test/balance.mjs 7,11 30 4   # balance probe: era timings, armies, starvation per seed
npm run test:e2e     # browser tests (needs: npx playwright install chromium)
npm run demo         # write a 25-minute AI match snapshot; rejoin it with token demo-token
npm run soak         # 30 minutes of AI-vs-AI in ~5 seconds
node test/preview.mjs 42 map.png   # render a continent
# building art gallery: http://localhost:8080/dev/buildings.html?era=0..4&state=op|planned|build|damaged|mix
```

## Deploy (Google Cloud Run via GitHub Actions)

One-time setup (needs `gcloud`, and optionally `gh`):

```bash
./infra/bootstrap.sh "$HOME/Downloads/Stem IAM Admin.json"
```

This enables the APIs, creates an Artifact Registry repo, a runtime service account, a deployer service account and a Workload Identity Federation pool restricted to this repository, sets the GitHub Actions variables, and pushes `main`. From then on every push to `main` runs the tests, builds the container, pushes it to Artifact Registry and deploys to Cloud Run. No service-account key is stored in GitHub.

### Networking

```
game.liamhosfeld.com ──DNS A──▶ 136.69.75.137 (stem-portfolio-ip, global external Application LB)
   stem-portfolio-https-proxy (cert: game-liamhosfeld-com-cert, Google-managed)
   stem-portfolio-url-map ── host game.liamhosfeld.com ──▶ shattered-empires-backend
   shattered-empires-neg (serverless NEG, us-east1) ──▶ Cloud Run: shattered-empires
```

Cloud Run ingress is `internal-and-cloud-load-balancing`, so the `*.run.app` URL is closed; the game is only reachable through the load balancer. WebSockets (`/ws`) pass through the LB unchanged. `infra/lb.sh` recreates this wiring idempotently.

Cloud Run runs a single 4 vCPU instance (`--max-instances 1`, session affinity, 60-minute WebSocket timeout, CPU always allocated). Each match runs in its own worker thread, autosaves every 60 s to `gs://stem-471602-se-snapshots`, and is saved again on SIGTERM, so deploys and restarts resume matches where they were; players reconnect automatically. Idle matches are parked to storage and wake when a player returns. Scaling past one instance means routing each match id to the instance that owns it — the per-match isolation and snapshots already make that a routing problem only.
