# Shattered Empires

A grand-scale RTS where you build a civilization on a continent that is tearing itself apart. Mountains rise and seal passes, the Great Rift sinks into the sea, volcanoes bury roads in lava and leave fertile soil, droughts dry rivers into crossings, and silted rivers carve new courses. The land is a strategic opponent.

## Architecture: the cloud does the thinking

```
Browser (PixiJS)                         Cloud Run (Node.js, 10 Hz authoritative simulation)
 ├─ draws server-shaded hex colours  ◀──  world gen · tectonics · quakes · eruptions · hydrology
 ├─ interpolates unit positions      ◀──  A* pathfinding · combat · supply networks · attrition
 ├─ sends intents (move, build, …)   ──▶  economy · jobs · stability · migration · research
 └─ shows fog-filtered snapshots     ◀──  fog of war · AI empires · diplomacy · placement checks
```

Everything that decides the game runs on the server. Clients never see unexplored or hidden data: tile changes (a collapsed pass, a new lava field) only reach a player when one of their units or buildings can see the place. Even placement validity, road routing, terrain lighting and the lobby map preview are computed server-side.

| Module | Responsibility |
| --- | --- |
| `server/sim/world.js` | 128×128 hex continent: tectonic plates, the Great Rift, climate, priority-flood hydrology, resources, start sites |
| `server/sim/geology.js` | Uplift & subsidence, seismic stress & earthquakes (landslides seal passes), eruptions, droughts, river avulsions, seismology warnings |
| `server/sim/economy.js` | Population (workers, merchants, specialists, soldiers), jobs & production chains, food, taxes, stability, unrest & defection, migration, territory, road trade routes |
| `server/sim/military.js` | 10 unit types, movement, combat with terrain/river/fort modifiers, supply networks (cities, depots, ports, forts, wagons; cut by enemy armies), attrition, city capture |
| `server/sim/diplomacy.js` | Contact, war & peace, trade agreements, open borders, alliances, tribute |
| `server/sim/ai.js` | Builder, merchant and warlord AI empires |
| `server/sim/game.js` | Tick loop, commands, visibility, per-player snapshots |
| `server/matches.js` | Lobby, matchmaking, reconnects, 5 Hz streaming |
| `client/` | PixiJS renderer + HUD (seismograph, research, realm, diplomacy, chronicle) |

## Gameplay

1. **Settle**: start with a town, a farm and a lumber camp. Place buildings from the bottom bar.
2. **Develop**: farms, lumber camps, quarries, mines, houses, markets, libraries, workshops, factories.
3. **Explore**: scouts reveal terrain, resources, rivals, volcanoes and fault lines (Surveying shows structural stability).
4. **Expand**: settlers found cities; roads connect them for trade routes and fast supply.
5. **Fight**: right-click to move/attack, A to attack-move. Armies need supply from cities, depots, ports, forts or wagons; out of supply they weaken and suffer attrition. Cut enemy supply by standing on their roads.
6. **Adapt**: watch the seismograph. Seismology gives early warning; Geoengineering and Conservation halve disaster damage; Engineering lets you bridge rivers and blast through peaks.
7. **Advance**: Settlement → Kingdom → Industrial Age. Governments and policies specialise your civilization.

Victory: conquest, or complete the Grand Exposition and hold it for 5 minutes.

## Develop locally

```bash
npm install
npm run dev          # http://localhost:8080
npm test             # simulation + protocol tests
npm run soak         # 30 minutes of AI-vs-AI in ~5 seconds
node test/preview.mjs 42 map.png   # render a continent
```

## Deploy (Google Cloud Run via GitHub Actions)

One-time setup (needs `gcloud`, and optionally `gh`):

```bash
./infra/bootstrap.sh "$HOME/Downloads/Stem IAM Admin.json"
```

This enables the APIs, creates an Artifact Registry repo, a runtime service account, a deployer service account and a Workload Identity Federation pool restricted to this repository, sets the GitHub Actions variables, and pushes `main`. From then on every push to `main` runs the tests, builds the container, pushes it to Artifact Registry and deploys to Cloud Run. No service-account key is stored in GitHub.

Get the game URL from the Actions run summary, or:

```bash
gcloud run services describe shattered-empires --region us-east1 --format 'value(status.url)'
```

If the URL returns 403, your organization blocks public (`allUsers`) access; allow it with
`gcloud run services add-iam-policy-binding shattered-empires --region us-east1 --member allUsers --role roles/run.invoker`.

Cloud Run runs a single instance (`--max-instances 1`, session affinity, 60-minute WebSocket timeout, CPU always allocated) because live matches are held in memory. Scaling past one instance means routing each match to its instance (e.g. match id → instance via Memorystore) — the simulation itself is already isolated per match.
