# Deliberate native match pacing

New matches now use `native-v3`; `native-v2` remains available for existing games. V3 changes
infantry movement to .50, wheeled/tracked movement to .55, ground logistics to .60 and aircraft
movement to .78. Production and population growth are .60, research and building construction
.55, training and road/bridge work .60, and trench work .50. Rates are relative to the original
legacy baseline. Ordinary food consumption and production both use the production rate; movement
fuel remains tied to the appropriate movement rate. These values still require long-match balance,
supply, AI and era-progression evaluation.

`native-v2` matches use the following settings. Existing `native-v1` and `legacy-v1` saves keep their own
rates on reload; there is no silent migration of an active economy or war. The server continues to
run at its usual tick rate, and rendering/input remain independent of the gameplay multipliers.

| System | Native v1 | Native v2 |
| --- | ---: | ---: |
| Infantry movement | 0.65 | 0.60 |
| Wheeled / tracked movement | 0.70 | 0.65 |
| Ground logistics | 0.75 | 0.70 |
| Aircraft | 0.85 | 0.82 |
| Research / construction | 0.70 | 0.65 |
| Training / road and bridge work | 0.75 | 0.70 |
| Trench work | 0.65 | 0.60 |

Production and population growth retain their previous rates, as do routine consumption and
combat damage. Fuel consumption still scales with authoritative movement rate. This is an initial
balance adjustment, not a claim that the longer era targets or economy/AI acceptance tests are
complete. Seeded long-match, retreat, supply and late-game evaluations remain release gates.

Close-view artillery impacts and destruction add bounded, event-driven dust. They do not create
extra attacks or damage. Reload clears pooled effect state so effects are not accidentally faded.
