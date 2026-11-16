// Hand-authored action RTS maps (pure data: no simulation imports, so the lobby can list them).
//
// Coordinates are normalised: [u, v] with u across the map (west → east) and v down it (north → south),
// both 0..1. Lengths (radii, widths, soft edges) are world units at the map's design size; a map
// painted at another size scales them. Every map is point-symmetric (180° rotation about the centre):
// each feature listed is painted twice, as authored and rotated, so both teams get exactly the same
// ground. Team 0 holds the west, team 1 the rotated east. Sites marked `center` are painted once.
//
// Painting order (authoredMaps.js): base land and sea border → `ops` in order → site pads → rivers.
//   elev ops: { op: 'elev', mode: 'set'|'max'|'min', value, soft, <shape> }   (sea < 0, plains .05-.3,
//             hills .34-.52 (slow, cover), mountains .52-.74 (no vehicles), peaks > .74 (impassable))
//   ridge:    { op: 'ridge', line, w, h, soft } a crest of height h tapering to its flanks over w
//   moist:    { op: 'moist', value, soft, <shape> } forest > .53, grass .38-.53, plains < .38, marsh > .7 (low)
//   river:    { op: 'river', path, flow: [source, mouth], fords: [[u, v]] } traced source → mouth; it
//             must end in water. Flow ≥ 94 stops vehicles (bridge needed); fords are shallow (passable).
// Shapes: { circle: [u, v], r } | { ellipse: [u, v], rx, rz, rot } | { line: [[u, v]...], w } | { poly: [[u, v]...] }
// Sites: main ruins with an eight-parcel ring ({ key, at, kind, name, start }: start = seat index within
// the team), outposts ({ at, kind, name }). Roads: waypoint lists (site keys or [u, v]) routed by the
// road planner; the rotated copy of every road is laid tile for tile.

export const MAP_CATALOG = [
  {
    id: 'twin_rivers', name: 'Twin Rivers', players: 2, teamSize: 1, size: 76, style: 'continents',
    description: 'Two rivers frame a central ridge. Coastal roads bridge both rivers to the north and south; the direct route wades the fords and climbs to the ridge saddle, where the Ridgeway ruins command the valley.',
    base: { elev: .14, moist: .44 },
    noise: { elev: .05, moist: .16, scale: 7, moistScale: 6, warp: 9, warpScale: 14, knolls: { amp: 2.6, scale: 5, above: .1 } },
    border: 5,
    ops: [
      // coastline: a north-west bay, a southern cove by the river mouth and a headland
      { op: 'elev', mode: 'min', value: -.28, soft: 4, ellipse: [.12, .04], rx: 16, rz: 9, rot: .2 },
      { op: 'elev', mode: 'min', value: -.2, soft: 3, circle: [.44, .98], r: 7 },
      { op: 'elev', mode: 'min', value: -.22, soft: 4, circle: [.02, .5], r: 9 },
      // western uplands behind the start (cover and a view over the base)
      { op: 'elev', mode: 'max', value: .4, soft: 5, ellipse: [.09, .3], rx: 5, rz: 9, rot: .3 },
      { op: 'elev', mode: 'max', value: .38, soft: 4, circle: [.3, .3], r: 4 },
      // the central ridge: hill shoulders, two mountain spines and the saddle between them
      { op: 'elev', mode: 'max', value: .37, soft: 5, line: [[.5, .18], [.5, .82]], w: 4.5 },
      { op: 'ridge', line: [[.5, .17], [.505, .28], [.5, .39]], w: 4, h: .68, soft: 3 },
      { op: 'elev', mode: 'min', value: .22, soft: 4, circle: [.5, .5], r: 7 },
      // the coast passes around the ridge ends
      { op: 'elev', mode: 'min', value: .18, soft: 4, circle: [.5, .11], r: 4 },
      // cover: woods on the west bank, the ridge flanks and the uplands
      { op: 'moist', value: .68, soft: 3, ellipse: [.31, .38], rx: 6, rz: 4, rot: .4 },
      { op: 'moist', value: .68, soft: 3, ellipse: [.31, .68], rx: 6, rz: 4, rot: -.3 },
      { op: 'moist', value: .66, soft: 2, line: [[.46, .24], [.45, .40]], w: 2.4 },
      { op: 'moist', value: .66, soft: 3, ellipse: [.12, .74], rx: 5, rz: 4, rot: 0 },
      { op: 'moist', value: .34, soft: 4, circle: [.19, .52], r: 8 },
      // the west river runs north → south (its rotated twin runs south → north on the east)
      { op: 'river', path: [[.38, .08], [.4, .22], [.37, .36], [.41, .5], [.38, .64], [.41, .78], [.41, .92], [.43, 1]], flow: [92, 230],
        fords: [[.41, .5], [.385, .64]] },
    ],
    sites: [
      { key: 'home', at: [.19, .52], kind: 'industrial', name: 'Westmarch', start: 0 },
      { key: 'north', at: [.24, .2], kind: 'town', name: 'Fenwick' },
      { key: 'coast', at: [.26, .83], kind: 'coastal', name: 'Saltgate' },
      { key: 'post', at: [.31, .52], kind: 'military', name: 'Ford Camp' },
      { key: 'ridge', at: [.5, .5], kind: 'metro', name: 'Ridgeway', center: true },
    ],
    names: { home: 'Eastmarch', north: 'Holloway', coast: 'Brinewater', post: 'River Camp' },
    outposts: [
      { at: [.11, .68], kind: 'energy' },
      { at: [.33, .12], kind: 'supply' },
      { at: [.45, .3], kind: 'radar' },
      { at: [.355, .44], kind: 'defense' },
      { at: [.16, .9], kind: 'repair' },
    ],
    roads: [
      ['home', 'north'], ['home', 'post'], ['home', 'coast'],
      ['north', [.4, .2], [.5, .12], [.6, .16], '~coast'],
    ],
  },
  {
    id: 'saltmarsh_estuary', name: 'Saltmarsh Estuary', players: 4, teamSize: 2, size: 108, style: 'archipelago',
    description: 'A tidal sound splits the coast. Land bridges cross it to the north and south, and a causeway from each shore reaches Tidewater Isle in the middle; marsh and islets fill the lagoons between.',
    base: { elev: .13, moist: .46 },
    noise: { elev: .05, moist: .16, scale: 8, moistScale: 7, warp: 8, warpScale: 16, knolls: { amp: 2.4, scale: 6, above: .1 } },
    border: 5,
    ops: [
      // the sound: north bay, the lagoon and the water around the isle (rotated: the south half)
      { op: 'elev', mode: 'min', value: -.3, soft: 3, line: [[.52, 0], [.5, .07], [.49, .11]], w: 9 },
      { op: 'elev', mode: 'min', value: -.14, soft: 3, line: [[.48, .27], [.46, .34], [.47, .41], [.5, .5]], w: 8 },
      { op: 'elev', mode: 'min', value: -.1, soft: 2, ellipse: [.415, .3], rx: 6, rz: 4.5, rot: .3 },
      // the north land bridge between the bay and the lagoon
      { op: 'elev', mode: 'max', value: .12, soft: 3, ellipse: [.5, .19], rx: 16, rz: 5, rot: 0 },
      // Tidewater Isle and its causeway to the west shore
      { op: 'elev', mode: 'max', value: .16, soft: 3, circle: [.5, .5], r: 9 },
      { op: 'elev', mode: 'max', value: .1, soft: 2, line: [[.5, .5], [.37, .44]], w: 2.3 },
      // islets in the bay and the lagoon
      { op: 'elev', mode: 'max', value: .22, soft: 2, circle: [.535, .05], r: 2.4 },
      { op: 'elev', mode: 'max', value: .18, soft: 2, circle: [.465, .345], r: 2.3 },
      // western bluffs, a coastal ridge and hills over the river
      { op: 'elev', mode: 'max', value: .4, soft: 6, ellipse: [.08, .52], rx: 6, rz: 14, rot: 0 },
      { op: 'ridge', line: [[.28, .62], [.31, .68], [.3, .75]], w: 3.6, h: .62, soft: 3 },
      { op: 'elev', mode: 'max', value: .38, soft: 4, circle: [.29, .37], r: 4.5 },
      // salt marsh along the sound
      { op: 'moist', value: .8, soft: 3, line: [[.4, .2], [.41, .26], [.39, .36]], w: 3.5 },
      { op: 'elev', mode: 'min', value: .05, soft: 3, line: [[.4, .2], [.41, .26], [.39, .36]], w: 2.6 },
      { op: 'moist', value: .8, soft: 3, circle: [.43, .58], r: 3 },
      { op: 'elev', mode: 'min', value: .05, soft: 2, circle: [.43, .58], r: 2.4 },
      // forests (cover on the approaches) and open fields around the starts
      { op: 'moist', value: .68, soft: 4, ellipse: [.23, .42], rx: 6, rz: 4.5, rot: .2 },
      { op: 'moist', value: .68, soft: 4, ellipse: [.28, .91], rx: 8, rz: 3.5, rot: 0 },
      { op: 'moist', value: .68, soft: 3, circle: [.07, .2], r: 5 },
      { op: 'moist', value: .68, soft: 3, ellipse: [.36, .62], rx: 3, rz: 5, rot: 0 },
      { op: 'moist', value: .34, soft: 4, circle: [.17, .25], r: 7 },
      { op: 'moist', value: .34, soft: 4, circle: [.18, .76], r: 7 },
      // the Mere drains the western bluffs into the lagoon
      { op: 'river', path: [[.12, .4], [.19, .33], [.26, .26], [.33, .28], [.42, .3]], flow: [70, 180], fords: [[.26, .26]] },
    ],
    sites: [
      { key: 'a', at: [.16, .25], kind: 'industrial', name: 'Northreach', start: 0 },
      { key: 'b', at: [.18, .76], kind: 'military', name: 'Southmoor', start: 1 },
      { key: 'mid', at: [.22, .53], kind: 'town', name: 'Reedholm' },
      { key: 'bridge', at: [.35, .13], kind: 'coastal', name: 'Gull Point' },
      { key: 'cause', at: [.33, .46], kind: 'research', name: 'Causeway Head' },
      { key: 'isle', at: [.5, .5], kind: 'metro', name: 'Tidewater Isle', center: true },
    ],
    names: { a: 'Farshore', b: 'Kestrel Bay', mid: 'Mirebrook', bridge: 'Tern Spit', cause: 'Seawall' },
    outposts: [
      { at: [.5, .19], kind: 'defense' },
      { at: [.07, .52], kind: 'energy' },
      { at: [.27, .63], kind: 'radar' },
      { at: [.26, .14], kind: 'supply' },
      { at: [.3, .9], kind: 'repair' },
      { at: [.11, .9], kind: 'energy' },
    ],
    roads: [
      ['a', 'mid', 'b'], ['a', 'bridge', [.5, .2], [.62, .2], '~bridge'], ['mid', 'cause', 'isle'], ['b', [.3, .86], '~bridge'],
    ],
  },
  {
    id: 'continental_divide', name: 'Continental Divide', players: 6, teamSize: 3, size: 140, style: 'continents',
    description: 'A mountain divide runs from coast to coast around Lake Meridian. Two high passes and the lakeshore gates are the only ways across; rivers from both highlands feed the lake.',
    base: { elev: .15, moist: .45 },
    noise: { elev: .05, moist: .16, scale: 9, moistScale: 8, warp: 9, warpScale: 18, knolls: { amp: 2.2, scale: 7, above: .1 } },
    border: 6,
    ops: [
      // coastline: bays on the north coast and a western cove (rotated: south and east)
      { op: 'elev', mode: 'min', value: -.25, soft: 5, ellipse: [.3, .02], rx: 20, rz: 9, rot: 0 },
      { op: 'elev', mode: 'min', value: -.25, soft: 5, ellipse: [.69, .03], rx: 13, rz: 8, rot: 0 },
      { op: 'elev', mode: 'min', value: -.22, soft: 4, circle: [.03, .35], r: 9 },
      // Lake Meridian with an islet
      { op: 'elev', mode: 'min', value: -.2, soft: 4, ellipse: [.5, .5], rx: 25, rz: 19, rot: .25 },
      { op: 'elev', mode: 'max', value: .2, soft: 2, circle: [.535, .47], r: 2.6 },
      // the divide: a range from the coast toward the lake, broken by the high pass
      { op: 'elev', mode: 'max', value: .38, soft: 6, line: [[.5, .06], [.49, .2], [.5, .32]], w: 7 },
      { op: 'ridge', line: [[.5, .05], [.49, .145]], w: 5.5, h: .78, soft: 3 },
      { op: 'ridge', line: [[.49, .25], [.5, .31]], w: 5.5, h: .74, soft: 3 },
      { op: 'elev', mode: 'min', value: .3, soft: 5, ellipse: [.49, .197], rx: 9, rz: 4, rot: 0 },
      // highland shoulders inland from each team
      { op: 'elev', mode: 'max', value: .4, soft: 7, ellipse: [.25, .5], rx: 7, rz: 12, rot: .2 },
      { op: 'ridge', line: [[.36, .7], [.4, .76]], w: 4, h: .62, soft: 3 },
      // forests
      { op: 'moist', value: .68, soft: 4, ellipse: [.36, .27], rx: 9, rz: 5, rot: .5 },
      { op: 'moist', value: .68, soft: 4, ellipse: [.18, .66], rx: 7, rz: 5, rot: 0 },
      { op: 'moist', value: .68, soft: 4, ellipse: [.42, .6], rx: 5, rz: 4, rot: 0 },
      { op: 'moist', value: .68, soft: 4, circle: [.08, .9], r: 6 },
      { op: 'moist', value: .34, soft: 5, circle: [.14, .2], r: 8 },
      { op: 'moist', value: .34, soft: 5, circle: [.11, .5], r: 8 },
      { op: 'moist', value: .34, soft: 5, circle: [.14, .8], r: 8 },
      // the Westwater: highlands → lake
      { op: 'river', path: [[.21, .41], [.27, .44], [.33, .41], [.38, .45], [.42, .47], [.47, .49]], flow: [70, 190], fords: [[.27, .44]] },
    ],
    sites: [
      { key: 'n', at: [.14, .2], kind: 'industrial', name: 'Cape Harrow', start: 0 },
      { key: 'm', at: [.11, .5], kind: 'military', name: 'Westfold', start: 1 },
      { key: 's', at: [.14, .8], kind: 'coastal', name: 'Port Lanyard', start: 2 },
      { key: 'np', at: [.32, .14], kind: 'town', name: 'Highgate' },
      { key: 'gate', at: [.36, .36], kind: 'research', name: 'Lakegate' },
      { key: 'mid', at: [.28, .57], kind: 'town', name: 'Ashwell' },
      { key: 'sf', at: [.28, .86], kind: 'industrial', name: 'Southmere' },
    ],
    names: { n: 'Cape Lorne', m: 'Eastfold', s: 'Port Varne', np: 'Lowgate', gate: 'Shorewatch', mid: 'Emberley', sf: 'Northmere' },
    outposts: [
      { at: [.49, .2], kind: 'defense' },
      { at: [.42, .37], kind: 'radar' },
      { at: [.05, .65], kind: 'energy' },
      { at: [.22, .33], kind: 'supply' },
      { at: [.2, .92], kind: 'energy' },
      { at: [.36, .66], kind: 'repair' },
      { at: [.24, .08], kind: 'supply' },
    ],
    roads: [
      ['n', 'm', 's'], ['n', 'np', [.49, .2], [.62, .23], '~gate'], ['m', 'mid', 'gate'], ['gate', [.45, .37]], ['s', 'sf', [.42, .87]],
      ['np', 'gate'],
    ],
  },
];

export const MAPS_BY_ID = Object.fromEntries(MAP_CATALOG.map((m) => [m.id, m]));

/** The lobby's view of the catalog: what a client needs to offer and describe a map. */
export function mapList() {
  return [{ id: 'random', name: 'Random', players: 0, teamSize: 0, size: 0, description: 'A new procedurally generated world for any number of players.' },
    ...MAP_CATALOG.map((m) => ({ id: m.id, name: m.name, players: m.players, teamSize: m.teamSize, size: m.size, mode: `${m.teamSize}v${m.teamSize}`, description: m.description }))];
}
