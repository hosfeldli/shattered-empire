# Audio sources

The runtime uses `Recorded/`, a selected set of 27 edited recordings and music tracks.
Archives and conversion executables stay outside Unity Assets. `Recorded/edits.json`
records the input, filters, channel conversion and gain for every output.
Recreate the edits with `node tools/prepare-unity-audio.cjs <download-directory> <ffmpeg-executable>`.

## Weapons — CC0 1.0

`rifle_01/02/03`, `mg_01/02`, `pistol_01`: **The Free Firearm Sound Library**, recorded by
Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney.
[Source and CC0 declaration](https://opengameart.org/content/the-free-firearm-sound-library).
AR-15 D_24P / D_32P, AK-47 C_31P / C_34P, Carl Gustav M45 G_24P, 1911 A_34P.
First discharge trimmed, high-pass filtered, mono, tail fade, gain reduced, Vorbis encoded.

`cannon_01`: **Cannon fire**, Thimras, CC0.
[Source](https://opengameart.org/content/cannon-fire).
Trimmed, high-pass filtered, mono, faded, gain reduced, Vorbis encoded.

## Explosions and heavy engines — CC BY 3.0

`blast_01`, `blast_02`: **2 High Quality Explosions**, Michel Baradari (submitted by qubodup),
[source](https://opengameart.org/content/2-high-quality-explosions),
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
Original `explode.wav`, `explodemini.wav`. High-pass filtered, mono, tail fade, gain reduced,
limited and Vorbis encoded. Used for impact, launch, flak and strategic blast layers.

`engine_tank`: **Engine-loop heavy vehicle/tank**, Nayckron, based on work by qubodup,
[source](https://opengameart.org/content/engine-loop-heavy-vehicletank),
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
The offered CC BY license is selected. Original `engine_heavy_loop_1.ogg`.
Trimmed, crossfaded, band-limited, mono, gain reduced and Vorbis encoded.
This is a designed heavy engine loop, not a recording of a particular tank.

## Material impacts — CC0 1.0

`debris_01/02`, `metal_01`, `wood_01`, `glass_01`, `confirm_01`:
**75 CC0 breaking / falling / hit sfx**, rubberduck,
[source](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx).
Respectively bfh1_rock_falling_03, rock_breaking_01, metal_hit_01, wood_breaking_01,
glass_breaking_02, metal_hit_04. Trimmed where appropriate, filtered, gain reduced and encoded.

## Environmental and vehicle recordings — CC0 1.0

BigSoundBank permits editing, commercial use and redistribution under CC0.
The source pages below identify the recordings and authors.

| Output | Original / author | Source |
|---|---|---|
| amb_wind | Wind in Tall Grass 0908 — Joseph SARDIN | [Source](https://bigsoundbank.com/wind-in-tall-grass-s0908.html) |
| amb_rain | Rain on Puddle 1290 — Joseph SARDIN | [Source](https://bigsoundbank.com/rain-on-puddle-s1290.html) |
| amb_river | Small Stream #4 1354 — Joseph SARDIN | [Source](https://bigsoundbank.com/small-stream-4-s1354.html) |
| amb_forest | Forest 0100 — Joseph SARDIN | [Source](https://bigsoundbank.com/forest-s0100.html) |
| amb_industry | Generator 1 kW 0115 — Joseph SARDIN | [Source](https://bigsoundbank.com/generator-1-kw-s0115.html) |
| engine_truck | Truck engine 1145 — Joseph SARDIN | [Source](https://bigsoundbank.com/truck-engine-s1145.html) |
| engine_rotor | Helicopter #1 0263 — DenisChardonnet | [Source](https://bigsoundbank.com/helicopter-1-s0263.html) |
| engine_jet | Airplane, pass #3 3006 — Dj Lio | [Source](https://bigsoundbank.com/airplane-pass-3-s3006.html) |
| thunder_01 | Thunder #4 3115 — Joseph SARDIN & Axeline T. | [Source](https://bigsoundbank.com/thunder-4-s3115.html) |

Loops are excerpts with crossfaded joins, filtering and reduced gain; local machinery, water and
engines are mono for spatial playback. Wind, rain and forest preserve stereo environmental width.
The aircraft pass is an edited source, not an exact military jet recording.
`countryside.mp3` remains a compatibility asset: Countryside 0097, Joseph SARDIN,
[source](https://bigsoundbank.com/countryside-s0097.html), CC0.

## Music — CC0 1.0

`music_calm`: **Unexplored Expansion**, Bo Jingles,
[source](https://opengameart.org/content/unexplored-expansion).
`music_combat`: **Determined Pursuit (epic orchestra loop)**, Emma_MA,
[source](https://opengameart.org/content/determined-pursuit-epic-orchestra-loop).
High-pass filtered, gain reduced, Vorbis encoded; calm music also accompanies the introduction.

Credits are available in the in-game Field Guide and Settings. No endorsement by the authors is implied.
