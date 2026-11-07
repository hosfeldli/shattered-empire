# Local native verification

## Reference-image interface and river-placement pass

The server suite passed 149 tests, including authoritative river-placement and resettlement
checks. Headless rendering passed 50 checks and battle presentation passed 10 checks, including
wind direction and smoke-only/reset behavior. The real-window source client passed 74 UI checks
against a local server, with runtime hash
`53b484d4365a4ad9b7a06a9a7759b10b95760e35c07329a9de4b4eb55bbb021f`, unchanged during the run.
The source fingerprint now includes JPEG and WebP runtime assets.
These checks establish functional behavior; they do not establish visual parity with the
reference images or complete material, model, battle-simulation and large-map art review.

## Previous terrain, pacing and interface checks

The native-v3 server suite passed 146 tests. Native headless checks passed for rendering (44),
composition (34), Living World/site placement (63), and water/weather and feedback timing (24).
The real-window source client passed 74 UI checks against a local server, including close-zoom
cloud fading and bounded resource indicators. The run used runtime source hash
`0cb4bd8cc2851ef77f3e27aae87279f8d2b68463560b0954746dbe143992f33c`, unchanged during the run.
It was a source-client run, not an export or platform certification. Long-match pacing, large
city terrain grounding and sustained high-load rendering remain open gameplay quality gates.

## Previous pacing and battle presentation checkpoint

The current source checkpoint adds the `native-v2` ruleset for new matches while preserving the
pace of existing saves. The full server suite passed 145 tests, including ruleset and save
compatibility. The Godot LWE regression passed 62 checks and the battle presentation regression
passed 6 checks. The rendered source and packaged macOS UI each passed 73 checks against a local
server. Both development exports completed, and the macOS package passed its live command and
reconnect smoke checks. Windows was exported but not run; the macOS package is ad-hoc signed.
The UI runs used runtime source hash `a494a3e54687320ff690be208e495f3add4e62cb4f12761019031848da6cbbe5`.
See [tempo notes](TEMPO_V2.md) for the adjustments and the outstanding balance work.

## Previous native checkpoint

Runtime source hash: `5a71c7179d66b991679bc7b08131fe0c628d9e028c99899a94fc99eeae21bd29`.
Windows/macOS development exports share this hash, unchanged during export and packaged tests.
The macOS application was exercised on Apple M3 with Godot 4.7.2. Windows was exported, not run.

| Check | Result |
| --- | --- |
| Server functional suite | 144 passed |
| Native headless regressions | 253 passed: rendering 43, composition 33, LWE 62, water 18, development 70, surface/research/defense 27 |
| Packaged macOS UI | 73 checks passed; 94 actions; three primary tools; no minimap |
| Packaged macOS surface/observer | 9 checks passed, including compact observer layout and authoritative speed |
| Packaged macOS live commands | 20 checks passed |
| Packaged macOS reconnect/server restart | Passed; order reached and picking verified |
| Catalogue | 23 explicit troop models; 32 active building types; 66 type/level variants |
| Damage catalogue | 52 industrial/advanced damaged or ruined variants checked |

[UI report](ui-validation/ui-validation.json) covers actual double-click selection and batch upgrade,
right-drag deployment on release, authoritative Explore, camera-aligned stable marker membership,
compact resource/troop icons, research availability/search/eras, observed production output and
moving civilian/local traffic. [Catalogue report](ui-validation/catalogue-validation.json) uses the
running server's definitions; labelled catalogue fixtures do not add gameplay entities.

[Surface report](surface-validation/surface-validation.json) covers a real 68-cell connected lake,
shared surface heights, submerged internal edges, mountain relief and actual AI-watching controls.
Lake captures include close, regional and wrapped views. Farm, industry, quarry, defense and fog
examples are explicitly labelled local presentation fixtures on already-received terrain. They do
not construct entities, change hydrology, reveal unknown state or grant extra cover on the server.

Review [troop/resource icons](ui-validation/troop-banners.png), [mass upgrades](ui-validation/mass-upgrade.png),
[city activity](ui-validation/city-activity-after.png), [production](ui-validation/production-icons.png),
[research](ui-validation/research-tree.png), [lake](surface-validation/lake-close.png),
[farms](surface-validation/farm-district.png), [quarry](surface-validation/quarry-district.png),
[defenses](surface-validation/defensive-junction.png), [fog](surface-validation/fog-boundary.png)
and [AI watching](surface-validation/watching-controls.png).

New server tests verify that power output metadata matches actual generation without adding a
resource stockpile, and that Explore releases a fixed deployment while retaining current movement. New/load tests also cover the native Varied AI choice: an older save
containing `mixed` now resolves deterministically to valid personalities and resumes research.
The surface regression also verifies wrap/unknown-cell behavior, inward fog fields, farm ownership
boundaries, research prerequisite paths, defense access without extra functional topology and city
status that explains a real growth constraint instead of replaying an old construction message.

Earlier water and rendered-reload reports retain their historical source hashes. None of these
functional/screenshot checks establishes current late-game 1080p GPU time, sustained large-map
performance or final art acceptance. Review [RELEASE_GATES.md](RELEASE_GATES.md) and
[CURRENT_WORK.md](CURRENT_WORK.md) for the complete outstanding work.

macOS has an ad-hoc development signature; Windows is unsigned. Signing/notarization, Windows
runtime review and broader balance/soak/art/performance gates remain open. An opt-in preview and
compatible server were published as documented in [NATIVE_PREVIEW_RELEASE.md](NATIVE_PREVIEW_RELEASE.md).
