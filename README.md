# Shattered Empires

A grand-scale RTS where you rebuild a civilization on a shattered world that wraps around east to west. Armies hold real ground behind supplied, entrenched lines; cities grow from a real population ledger, workers are allocated to the jobs that matter, governors and rival empires plan with the same tools you do, and armies are drawn from your people. By default the land is peaceful; turn on **Cataclysm mode** for a world that tears itself apart: rising mountains, a sinking Great Rift, eruptions, droughts and wandering rivers.

## Architecture: the cloud does the thinking

```
Desktop app (Electron + PixiJS)          Cloud Run (Node.js; one worker thread per match, 10 Hz)
 ├─ draws server-shaded hex colours  ◀──  world gen · tectonics · quakes · eruptions · hydrology
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
- **The world looks alive**: districts grow with population and era, pedestrians, traffic and freight trains follow the real roads, factories smoke, farms change with the seasons, farmsteads and fields spread round the towns, rivers meander and widen downstream, construction sites have cranes and crews, and damage leaves fires and rubble. Live effects (smoke, fire, traffic) appear only where you can see; a remembered city does not keep smoking through the fog.

### Population, labour and governors
- **Build up, not only out**: production buildings cost more and produce more than before, and grow through three levels (*Expand*: +67% / +134% jobs, +35% / +70% output; level 2 needs the next era, level 3 the one after, and steel from level 2). Houses add storeys. When every hex is full, a city develops by upgrading what it has, and governors and the AI do the same, starting with whatever is scarce.
- **City tiers**: a town becomes a City, a Metropolis and a Megacity as it grows and the eras advance; each tier adds homes and jobs at its centre, output from the town hall and stability, and the district visibly densifies into blocks and towers.
- **Feeding a nation**: food per person is lower, farms and ports yield more, and cities joined overland or by sea share food without freight limits, so a growing country can feed itself; housing is a hard cap on growth, so people stop arriving when there is nowhere to live rather than starving the city into revolt.
- **Resources**: mines can be dug into bare hills and mountains (under half the yield of an iron or coal deposit) and quarries give a little ore, so a mechanised army is never blocked on one deposit; the Synthetic Fuel Refinery makes fuel from ore and timber where there is no oil.
- **Population ledger**: every city counts civilians, recruits in training (reserved) and serving soldiers. Training draws on a recruitable share that never strips essential workers; cancelling returns the people, demobilising sends most of them home, casualties are a real loss. Growth follows food, housing (blocks gain storeys), stability and services, with a post-war recovery boost.
- **Workforce**: food first, then your category priorities (or a mode: balanced, growth, industry, research, commerce). Lock a building's staff or switch it off; every building says why it is or is not staffed (no power, missing input, storage full, no rare earths…). An auto-balance preview shows the change before you apply it.
- **Governor autonomy**: Off, Advisor (proposals only), Managed (routine work), or Autonomous; goals, a spending budget, emergency powers, and proposals you approve, defer or reject. The forecast planner scores every option (benefit + resilience + specialisation − cost − risk) and explains what it holds off on and why.
- **Era progression** is paced (economy 2–4 min, rifles 4–8, industrial 10–15, mechanised 18–25, networked 30–45, advanced 45–60) with national savings for the next era, refits that keep veterancy, and logistics upkeep that limits unit spam. The readiness panel shows what stands between you and the next era.

### Front lines, trenches and logistics
- **Line deployment**: with troops selected, right-drag a line. A long line spreads them one per hex; a short one concentrates them up to each hex's capacity (shown live: green / amber / red, with a *Dispersed / Concentrated / Dense* label). Modes: Line, Compact, Defense in depth (support and artillery in rear ranks), Keep shape. Behaviours: Hold, Defend (engage nearby, then return), Advance. Tab reverses the facing while dragging, Shift queues, Esc cancels. The client runs the same planner the server validates (`server/sim/deploy.js`). Formations persist (save/restore), can be reinforced, and a unit moved by hand detaches until it rejoins.
- **Area fire hits every unit on a hex**: a mortar or howitzer shell on a stack of six squads resolves six hits. Concentration holds ground; it also invites artillery.
- **Trench lines**: Build → Defenses → **Trench Line** (or *Fortify* in the command bar) draws a line like a road: preview shows valid segments, cost (earthworks 6 materials / 10 s per hex, reinforced 10 / 18 s; reinforcing earthworks charges only the difference), completion time and the protected side (**Reverse Facing**). National construction crews dig several segments at once; no troops stand on the line to build it. Cover is directional, weak for vehicles, degraded by explosives, repairable. Never on buildings or developed districts. Guard Posts, Bunkers (shelter adjacent troops), Fortresses and AA Batteries complete the Defenses palette (*Show locked* lists what research unlocks).
- **No man's land**: every shell, wreck and death wears the ground down — churned, then cratered mud, then wire and debris. Vehicles bog down, infantry find shell holes, fields stop producing; it heals slowly once fighting moves on. Infantry holding under fire scrape out temporary foxholes (capped, gone when abandoned).
- **Ground is held**: hostile ground units never share a hex or swap places, and a combat unit's zone of control stops anyone sliding along or through a line (stepping back out is always allowed; aircraft overfly). Break a line with fire, or go around its end.
- **No troop supply to micromanage**: units are always supplied wherever they are. They recover strength out of combat (fastest in friendly territory and next to a fort); national food and fuel use still follows what the army is doing. Supply trucks and depots are gone from the build and training menus (existing depots stay as obsolete buildings).
- **AI battle lines**: AI empires at war hold a front toward each enemy — a line across the approach to their nearest city, deployed in depth, then dug in as trenches — and attack in bounds behind artillery suppression rather than walking into fire.
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
Relaxed, Standard, Hard, Expert and Brutal differ in *skill*: reconnaissance, reserves, retreat judgment, counter-composition, screens, raids, fortified defence lines, dispersal under artillery, and a strategic layer that commits to one goal at a time. **Fair Play** (the default) gives no AI any numerical bonus; only Brutal can be given disclosed economic help. Saves from before keep their old settings, marked *legacy*.

### Production and sound
- **Multi-building production**: Alt-drag to box-select buildings, Shift-click to add one, double-click for all of a type on screen (Ctrl/Cmd for the whole map). One order trains *N in total* (each unit goes where it finishes soonest) or *N per building*, is charged exactly once, queues what it can and says what blocked the rest. Repeat production keeps a facility busy while it can afford a double order. Rally points apply to the whole selection.
- **Spatial sound** (Web Audio, synthesised, nothing to download): volleys, launches and impacts panned and muffled by where they are on screen, ambience that follows what is in view (wind, sea, forest, city, industry, distant battle). Only what you can see is heard. Volume sliders in the menu, **M** mutes; audio waits for your first click and pauses in a background tab.

### World
Four world styles (continents, pangaea, archipelago, inland sea) on a seamless east–west wrap: movement, roads, vision, borders and the camera all cross the seam. Starts are checked for fair access to food, materials, metals, fuel and rare earths. AI rivals come in four difficulties (Relaxed to Brutal), which change their economic efficiency, army size and how fast their generals react — never your empire.

### Server performance
Each tick runs through a scheduler: every system has a cadence, a phase (the once-a-second systems are spread over the second) and a time budget, and records p50/p95/p99/max timings and overruns (`/api/metrics`; the slowest systems also appear in `/api/health`). Autosaves are captured on the tick and compressed off it. On live servers AI planning may slide a tick when one runs long; tests and replays stay deterministic. New matches are refused with a clear message when the running ones already use most of the CPU or memory.

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
