// Per-viewer snapshot deltas (capability 'udelta'). Outside the deterministic simulation: the
// worker keeps, per connected viewer, what it last sent and transmits only the unit records and
// path previews that changed, plus the ids that left view. A full set goes out first and every
// `fullEvery` snapshots, so a viewer can never drift for long.
//
// S4 (perf): the 1 Hz econ block's battlefield ('bf') and trench lists ('fw' with 'trenchWorld') were
// resent whole, and the battlefield grows with the match. A udelta viewer keeps its previous copy when
// they are absent (Unity ClientSession / Godot WorldState apply them only when present), so they are
// left out while identical to what this viewer last received. They always go out on this encoder's
// first message (welcome / rejoin), after resyncEcon() (a congested connection catching up), and on every
// `econFullEvery`-th econ message.
//
// Pass 4 (perf, 2026-11-18): keyed deltas (capability 'econ-delta-v1', opts.keyed). Three fields grow with the
// match and were resent whole: 'sites' in every 5 Hz snapshot, 'buildings' and 'bf' in every 1 Hz econ block.
// For a viewer that negotiated the capability each becomes a versioned keyed list:
//   full:  sites + sv, buildings + bv, bf + bfv           (the whole field and its version; the client replaces its copy)
//   delta: sd / bd = { v, u: [changed or added records], r: [removed keys] }      (sites by id, buildings by id)
//          bfd     = { v, u: { sub: [rows] }, r: { sub: [tiles] } }              (battlefield rows grouped by tile:
//                    a tile listed in u replaces every row that tile had in that sub-list)
//   nothing at all when the field is unchanged (the version does not move).
// ruins and cities (small, rarely changing) are left out while identical to the last econ message, as bf / fw are
// for udelta viewers.
// A delta applies only on top of version v - 1; a client that sees any other version drops it and asks for a
// resync (cmd { c: 'resync' } -> resyncEcon()), and the next message carries the field whole. Full fields go out on
// the encoder's first message (welcome / rejoin: a new encoder), after resyncEcon(), and as a slow safety refresh.
// Sites carry two time anchors instead of values that change every frame: 'ta' (time the site was claimed:
// tenure = time - ta) and 'ml' (maturity is still growing: maturity = min(35, time - developedAt)). keyedReceiver()
// below is the reference client (test/econ-delta-2026-11-18.test.js; Unity ClientSession mirrors it).
export const KEYED_CAP = 'econ-delta-v1';
// keyed mode also leaves these econ fields out while unchanged (resent identical 96-99% of the time late in a match)
const WHOLE_GATED = ['ruins', 'cities'];
const BF_SUBS = ['c', 'w', 's', 'i', 'fp', 'm', 'sc', 'wr', 'hs'];

export function deltaEncoder(fullEvery = 50, econFullEvery = 10, opts = {}) {
  let units = new Map(), paths = new Map(), worldPaths = new Map(), n = 0;
  let bfKey = null, fwKey = null, econN = 0, econForce = true;
  const wholeKeys = {};   // keyed mode: ruins / cities, left out while identical (the Unity client keeps its copy)
  const keyed = !!opts.keyed;
  // keyed mode: the safety refresh is slow (a version gap asks for a resync instead)
  const keyedEconFull = opts.keyedEconFull ?? 300, keyedSitesFull = opts.keyedSitesFull ?? 1500;
  const ks = keyed ? { sites: keyedList((r) => r.id), buildings: keyedList((r) => r.id, true), bf: keyedBattlefield(), sitesN: 0, sitesForce: true } : null;
  const encode = (msg) => {
    if (msg.t !== 's' || !Array.isArray(msg.units)) return msg;
    const full = n++ % fullEvery === 0;
    const nu = new Map(), list = [];
    for (const r of msg.units) { const k = JSON.stringify(r); nu.set(r[0], k); if (full || units.get(r[0]) !== k) list.push(r); }
    const gone = []; if (!full) for (const id of units.keys()) if (!nu.has(id)) gone.push(id);
    units = nu;
    const np = new Map(), pl = {};
    for (const [id, p] of Object.entries(msg.paths || {})) { const k = p.join(','); np.set(id, k); if (full || paths.get(id) !== k) pl[id] = p; }
    const pg = []; if (!full) for (const id of paths.keys()) if (!np.has(id)) pg.push(Number(id));
    paths = np;
    const out = { ...msg, units: list, paths: pl };
    if (ks && Array.isArray(msg.sites)) {
      const force = ks.sitesN++ % keyedSitesFull === 0 || ks.sitesForce;
      ks.sitesForce = false;
      const sites = msg.sites.map((r) => siteAnchored(r, msg.time));
      delete out.sites;
      if (force) { out.sites = sites; out.sv = ks.sites.full(sites); } else { const d = ks.sites.delta(sites); if (d) out.sd = d; }
    }
    if (msg.econ) {
      const force = econN++ % (keyed ? keyedEconFull : econFullEvery) === 0 || econForce;
      econForce = false;
      if (ks) {
        if (Array.isArray(msg.buildings)) {
          delete out.buildings;
          if (force) { out.buildings = msg.buildings; out.bv = ks.buildings.full(msg.buildings); } else { const d = ks.buildings.delta(msg.buildings); if (d) out.bd = d; }
        }
        if (msg.bf !== undefined) {
          delete out.bf;
          if (force) { out.bf = msg.bf; out.bfv = ks.bf.full(msg.bf); } else { const d = ks.bf.delta(msg.bf); if (d) out.bfd = d; }
        }
        for (const f of WHOLE_GATED) if (msg[f] !== undefined) { const k = JSON.stringify(msg[f]); if (!force && k === wholeKeys[f]) delete out[f]; wholeKeys[f] = k; }
      } else if (msg.bf !== undefined) { const k = JSON.stringify(msg.bf); if (!force && k === bfKey) delete out.bf; bfKey = k; }
      if (msg.fw !== undefined) {
        const k = JSON.stringify(msg.fw) + '|' + JSON.stringify(msg.trenchWorld ?? null);
        if (!force && k === fwKey) { delete out.fw; delete out.trenchWorld; }
        fwKey = k;
      }
    }
    if (!full) { out.d = 1; if (gone.length) out.ug = gone; if (pg.length) out.pg = pg; }
    if (msg.wp) {
      const nw = new Map(), next = {}, removed = [];
      for (const [id, route] of Object.entries(msg.wp)) {
        const key = JSON.stringify(route);
        nw.set(id, key);
        if (full || worldPaths.get(id) !== key) next[id] = route;
      }
      if (!full) for (const id of worldPaths.keys()) if (!nw.has(id)) removed.push(Number(id));
      worldPaths = nw;
      out.wp = next;
      if (removed.length) out.wpg = removed;
    }
    return out;
  };
  /** The next econ message carries the battlefield and trenches in full (a connection catching up); keyed fields too. */
  encode.resyncEcon = () => { econForce = true; if (ks) ks.sitesForce = true; };
  encode.keyed = keyed;
  return encode;
}

// A site record with its per-frame clocks replaced by anchors (constant while nothing else changes). Remembered
// sites (memory) are frozen copies and keep their literal values.
// (Rest-spread copies, not delete: a deleted key turns the object slow for JSON.stringify.)
function siteAnchored(r, time) {
  if (!r || r.memory || typeof time !== 'number') return r;
  const anchor = r.tenure > 0, live = r.maturity > 0 && r.maturity < 35 && typeof r.developedAt === 'number' && Math.abs(r.maturity - (time - r.developedAt)) < 0.06;
  if (!anchor && !live) return r;
  const { tenure, maturity, ...o } = r;
  if (anchor) o.ta = Math.round((time - tenure) * 10) / 10; else o.tenure = tenure;
  if (live) o.ml = 1; else o.maturity = maturity;
  return o;
}

// A list of records keyed by `keyOf`; a key that repeats keeps its last record (as the clients' dictionaries do).
// whole: first compare the whole list as one string (cheap when it is often unchanged, e.g. buildings).
function keyedList(keyOf, whole = false) {
  let held = new Map(), v = 0, all = null;
  const index = (list) => { const m = new Map(); for (const r of list) m.set(keyOf(r), r); return m; };
  return {
    full(list) { all = whole ? JSON.stringify(list) : null; held = new Map(); for (const [k, r] of index(list)) held.set(k, JSON.stringify(r)); return ++v; },
    delta(list) {
      if (whole) { const a = JSON.stringify(list); if (a === all) return null; all = a; }
      const next = new Map(), u = [], r = [];
      for (const [k, rec] of index(list)) { const j = JSON.stringify(rec); next.set(k, j); if (held.get(k) !== j) u.push(rec); }
      for (const k of held.keys()) if (!next.has(k)) r.push(k);
      held = next;
      if (!u.length && !r.length) return null;
      const d = { v: ++v, u }; if (r.length) d.r = r;
      return d;
    },
  };
}

// The battlefield's sub-lists, each a list of rows whose first element is the tile, grouped by tile.
function groupRows(rows) {
  const m = new Map();
  for (const row of rows || []) { const t = row[0], g = m.get(t); if (g) g.push(row); else m.set(t, [row]); }
  return m;
}
function keyedBattlefield() {
  let held = {}, whole = {}, v = 0;
  return {
    full(bf) { held = {}; whole = {}; for (const sub of BF_SUBS) whole[sub] = JSON.stringify(bf[sub] || []); for (const sub of BF_SUBS) { const m = new Map(); for (const [t, g] of groupRows(bf[sub])) m.set(t, JSON.stringify(g)); held[sub] = m; } return ++v; },
    delta(bf) {
      const u = {}, r = {}, next = {};
      let any = false;
      for (const sub of BF_SUBS) {
        // a sub-list identical to the last one as a whole (the common case) skips the per-tile comparison
        const w = JSON.stringify(bf[sub] || []);
        if (w === whole[sub] && held[sub]) { next[sub] = held[sub]; continue; }
        whole[sub] = w;
        const prev = held[sub] || new Map(), m = new Map(), up = [], gone = [];
        for (const [t, g] of groupRows(bf[sub])) { const j = JSON.stringify(g); m.set(t, j); if (prev.get(t) !== j) for (const row of g) up.push(row); }
        for (const t of prev.keys()) if (!m.has(t)) gone.push(t);
        next[sub] = m;
        if (up.length) { u[sub] = up; any = true; }
        if (gone.length) { r[sub] = gone; any = true; }
      }
      held = next;
      if (!any) return null;
      const d = { v: ++v, u }; if (Object.keys(r).length) d.r = r;
      return d;
    },
  };
}

// ------------------------------------------------------------------------------------------- reference client
// What a keyed-delta client holds, applying messages in wire order exactly as Unity ClientSession does. view(time)
// returns sites / buildings / bf as a full snapshot would carry them (sites with tenure and maturity re-derived).
// apply() returns { resync: true } when a delta did not follow the version held (the client must ask for a resync).
export function keyedReceiver() {
  const st = { sites: null, sv: -1, buildings: null, bv: -1, bf: null, bfv: -1, gaps: 0, ruins: undefined, cities: undefined };
  const putAll = (map, list, keyOf) => { for (const r of list) map.set(keyOf(r), r); };
  const applyList = (field, verKey, fullList, fullV, d) => {
    if (fullList !== undefined) { const m = new Map(); putAll(m, fullList, (r) => r.id); st[field] = m; st[verKey] = fullV ?? -1; return false; }
    if (!d) return false;
    if (st[field] == null || st[verKey] < 0 || d.v !== st[verKey] + 1) return true;
    for (const r of d.u || []) st[field].set(r.id, r);
    for (const k of d.r || []) st[field].delete(k);
    st[verKey] = d.v;
    return false;
  };
  const apply = (msg) => {
    let gap = false;
    if (msg.sites !== undefined || msg.sd) gap = applyList('sites', 'sv', msg.sites, msg.sv, msg.sd) || gap;
    if (msg.buildings !== undefined || msg.bd) gap = applyList('buildings', 'bv', msg.buildings, msg.bv, msg.bd) || gap;
    if (msg.bf !== undefined) { st.bf = {}; for (const sub of BF_SUBS) st.bf[sub] = groupRows(msg.bf[sub]); st.bfv = msg.bfv ?? -1; }
    else if (msg.bfd) {
      const d = msg.bfd;
      if (st.bf == null || st.bfv < 0 || d.v !== st.bfv + 1) gap = true;
      else {
        for (const sub of BF_SUBS) {
          const m = st.bf[sub];
          for (const [t, g] of groupRows(d.u?.[sub])) m.set(t, g);
          for (const t of d.r?.[sub] || []) m.delete(t);
        }
        st.bfv = d.v;
      }
    }
    for (const f of WHOLE_GATED) if (msg[f] !== undefined) st[f] = msg[f];
    if (gap) st.gaps++;
    return { resync: gap };
  };
  const view = (time) => ({
    sites: st.sites && [...st.sites.values()].map((r) => {
      if (r.ta === undefined && !r.ml) return r;
      const o = { ...r };
      if (o.ta !== undefined) { o.tenure = Math.max(0, time - o.ta); delete o.ta; }
      if (o.ml) { o.maturity = Math.min(35, Math.max(0, time - o.developedAt)); delete o.ml; }
      return o;
    }),
    buildings: st.buildings && [...st.buildings.values()],
    ruins: st.ruins, cities: st.cities,
    bf: st.bf && Object.fromEntries(BF_SUBS.map((sub) => [sub, [...st.bf[sub].values()].flat()])),
  });
  return { apply, view, state: st };
}
