# Intermediate rendering evidence

- **Type:** Visual evidence record
- **Recorded in documentation:** 2026-11-13
- **Scope:** Intermediate local rendering build; not an approved reference or public release

The images are actual Unity runtime renders from the local rendering/UX working tree, captured
before the latest road, bridge, map, contextual-interface and shortest-grass follow-ups.
The documentation commit does not contain that implementation. No reproducible frozen graphics
source commit or final art approval is claimed for these intermediate frames.

| Property | Recorded value |
| --- | --- |
| Engine | Unity 6000.3.28f1 / URP |
| Player | Local Windows release build |
| Rendering | Full URP StandardRequest camera-stack path, with volume/post-processing updates |
| Final readback | sRGB ARGB32 |
| Resolution / quality | 1920 × 1080 / High |
| GPU | AMD Radeon RX 7600 XT, 16 GB |
| Scenario | Existing intro/menu review scene; default deterministic menu composition |
| Cameras | Main menu composition and beat 7 silo composition |
| Conversion | PNG capture to JPEG for documentation size; no scene retouching |

- [Menu frame](menu-glare-review.jpg): actual screen-space interface composited over the world.
- [Silo frame](silo-glare-review.jpg): actual world camera without screen-space captions.

These frames support the narrow local observation that the giant white foliage glare is absent
in this intermediate render. They do not prove all hardware/settings, live distribution, movement
reliability, current UI, current grass size or performance. The older UI visible in the menu is not
the new interaction target. See the [working report](../../QUALITY_PASS_2026-11-12_RENDER_UX.md).
