// Per-viewer snapshot deltas (capability 'udelta'). Outside the deterministic simulation: the
// worker keeps, per connected viewer, what it last sent and transmits only the unit records and
// path previews that changed, plus the ids that left view. A full set goes out first and every
// `fullEvery` snapshots, so a viewer can never drift for long.
export function deltaEncoder(fullEvery = 50) {
  let units = new Map(), paths = new Map(), worldPaths = new Map(), n = 0;
  return (msg) => {
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
}
