// Telemetry probe for one match, running inside its worker thread (server/worker.js). It READS the game and never
// writes it: no game.rng, no sim helpers with caches, no mutation of anything the simulation or its save uses. Its
// only footprints on the game object are `game.tm` (the AI hook sink, never serialized) and a timing wrapper on the
// game.nav instance's route() (same arguments, same result). test/telemetry-2026-11-18.test.js checks that a match
// with the probe attached hashes identically to one without.
//
// Every second it polls the state (new units, buildings, captures, upgrades, battles, events since the last poll);
// every wall minute it posts compact aggregate rows to the main thread: {t:'tm', rows:[[table, row], ...]}.
import { performance, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const sortNum = (a) => Float64Array.from(a).sort();
const toCounts = (m) => [...m].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
const inc = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const AI_ROWS_PER_MINUTE = 40;
const MIN_BATTLE_DAMAGE = 110;   // the same bar the battle reports use (actionGame.engagementReports)

export function createProbe(game, { post, units: UNITS = {}, buildings: BUILDINGS = {}, centerOf = null, minuteMs = 60_000, wallNow = () => Date.now() } = {}) {
  const rows = [];
  const push = (table, row) => rows.push([table, { event_time: wallNow(), ...row }]);
  const cost = (defs, type) => { const c = defs[type]?.cost || {}; return (c.materials || 0) + (c.energy || 0); };
  const civOf = (seat) => game.civs[seat];
  const who = (seat) => { const c = civOf(seat); return c ? { team: c.team, human: !!c.human, ai_difficulty: c.human ? undefined : c.difficulty, ai_personality: c.human ? undefined : c.personality } : {}; };
  const siteName = (id) => game.siteById?.get(id)?.name;
  const playable = () => game.civs.filter((c) => !c.isRebel);

  // ---------------------------------------------------------------- per-minute performance accumulators
  let started = performance.now(), minuteIndex = 0;
  const perf = () => ({ at: performance.now(), sim: game.time, ticks: 0, intervals: 0, intervalMax: 0, over100: 0, paused: 0, idle: 0,
    snapshots: 0, snapMs: 0, snapMax: 0, msgs: 0, bytes: 0, commands: 0, routes: [], routeN: 0, routeMs: 0, routeMax: 0, routeFail: new Map(),
    groupMax: 0, unitsMax: 0, projMax: 0, autosaves: 0, autosaveMax: 0, sys: new Map() });
  let cur = perf();
  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  let elu = performance.eventLoopUtilization();
  const gc = { n: 0, ms: 0, max: 0 };
  let gcObs = null;
  try { gcObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { gc.n++; gc.ms += e.duration; if (e.duration > gc.max) gc.max = e.duration; } }); gcObs.observe({ entryTypes: ['gc'] }); } catch { /* unsupported */ }

  // ---------------------------------------------------------------- route timing (wraps the instance method)
  const nav = game.nav;
  if (nav && typeof nav.route === 'function' && !nav.route.tmWrapped) {
    const route = nav.route;
    const timed = function (from, to, def) {
      const s = game.navStats, cut = s?.routeCutOff || 0, t0 = performance.now();
      const r = route.call(this, from, to, def);
      const ms = performance.now() - t0;
      cur.routeN++; cur.routeMs += ms; if (ms > cur.routeMax) cur.routeMax = ms;
      if (cur.routes.length < 20000) cur.routes.push(ms);
      if (!r) inc(cur.routeFail, (game.navStats?.routeCutOff || 0) > cut ? 'cutoff' : 'other');
      return r;
    };
    timed.tmWrapped = true;
    nav.route = timed;
  }
  let navPrev = flatNav(game.navStats);

  // ---------------------------------------------------------------- scheduler samples (read from its rings)
  const sysSeen = new Map();   // name -> last n
  function readScheduler() {
    const sched = game.sched; if (!sched?.stats) return;
    for (const [name, s] of sched.stats) {
      const last = sysSeen.get(name) ?? s.n; sysSeen.set(name, s.n);
      const a = cur.sys.get(name) || (cur.sys.set(name, { calls: 0, total: 0, max: 0, over: s.over, deferred: s.deferred, samples: [] }).get(name));
      const ring = s.ring, R = ring.length;
      for (let i = Math.max(last, s.n - R); i < s.n; i++) {
        const ms = ring[i % R]; a.calls++; a.total += ms; if (ms > a.max) a.max = ms;
        if (a.samples.length < 6000) a.samples.push(ms);
      }
      a.overEnd = s.over; a.deferredEnd = s.deferred;
    }
  }

  // ---------------------------------------------------------------- gameplay state shadows
  const known = { units: new Map(), buildings: new Map(), sites: new Map(), techs: new Map(), age: new Map(), alive: new Map(), res: new Map(), speed: game.speed, proj: new Set() };
  const player = new Map();   // seat -> per-minute economy and production
  const totals = new Map();   // seat -> match totals for match_results
  const pl = (seat) => player.get(seat) || (player.set(seat, { produced: new Map(), lost: new Map(), incM: 0, incE: 0, spM: 0, spE: 0 }).get(seat));
  const tot = (seat) => totals.get(seat) || (totals.set(seat, { produced: new Map(), units: 0, built: 0, lostB: 0, battles: 0, won: 0 }).get(seat));
  const eliminations = [];
  let lastEvent = game.eventSeq || 0, primed = false, overDone = false, simPrev = game.time;
  const battles = new Map();  // key -> shadow
  const ai = new Map();       // seat -> { op, launched, rows, notesSkip }

  function prime() {
    primed = true;
    for (const u of game.units?.values?.() || []) known.units.set(u.id, u.type);
    for (const b of game.buildings?.values?.() || []) known.buildings.set(b.id, { type: b.type, owner: b.owner, tile: b.tile, done: !!b.done });
    for (const s of game.sites || []) known.sites.set(s.id, { owner: s.owner, tier: s.tier });
    for (const c of game.civs) {
      known.techs.set(c.id, new Set(c.techs || [])); known.age.set(c.id, c.age); known.alive.set(c.id, c.alive);
      if (c.res) known.res.set(c.id, { m: c.res.materials || 0, e: c.res.energy || 0 });
    }
    for (const p of game.projectiles?.values?.() || []) if (p.strategic) known.proj.add(p.id);
  }

  function aiState(seat) { return ai.get(seat) || (ai.set(seat, { op: null, launched: false, rows: 0, skip: null }).get(seat)); }
  function aiRow(civ, kind, row, capped = true) {
    const st = aiState(civ.id);
    if (capped && st.rows >= AI_ROWS_PER_MINUTE) return;
    st.rows++;
    push('ai_decisions', { seat: civ.id, sim_time_s: game.time, kind, ai_difficulty: civ.difficulty, ai_personality: civ.personality, state: civ.aiPlan?.state, ...row });
  }
  const planOwner = (p) => game.civs.find((c) => c.aiPlan === p);
  function opEnd(civ, op, outcome) {
    const forces = (op.forces || []).reduce((n, f) => n + (f.ids?.length || 0), 0);
    aiRow(civ, 'operation_end', { target_site: op.target, target_name: siteName(op.target), outcome, value: game.time - (op.started ?? game.time),
      details: { forces: (op.forces || []).map((f) => ({ role: f.role, units: f.ids?.length || 0 })), units: forces, launched: !!op.launched } }, false);
  }

  // the AI hook sink (actionAI.js note()/objective(), actionAIOps.js note(), actionAIWorks.js place()/dig()): reads only
  game.tm = {
    aiNote(p, text) {
      const civ = planOwner(p); if (!civ) return;
      const st = aiState(civ.id);
      if (st.skip === text) { st.skip = null; return; }   // objective() notes its own change; the objective row has it
      aiRow(civ, 'note', { text });
    },
    aiObjective(p, state, target) {
      const civ = planOwner(p); if (!civ) return;
      const st = aiState(civ.id);
      if (p.op && st.op === p.op) {
        const owner = game.siteById?.get(p.op.target)?.owner;
        const outcome = owner === civ.id ? 'captured' : state === 'Recovering' ? 'withdrew' : state === 'Defending' ? 'recalled_to_defend'
          : state === 'Final Assault' && target === p.op.target ? 'escalated' : 'retargeted';
        opEnd(civ, p.op, outcome); st.op = null; st.launched = false;
      }
      aiRow(civ, 'objective', { prev_state: p.state, state, target_site: target || undefined, target_name: target ? siteName(target) : undefined }, false);
      st.skip = target ? `${state} at ${siteName(target) || 'the objective'}` : state;
    },
    aiBuild(civ, type, at, forward) { if (civ) aiRow(civ, 'defense', { type, details: { x: at?.x, z: at?.z, forward: !!forward, surcharge: at?.surcharge } }); },
    aiDig(civ, hexes, label) { if (civ) aiRow(civ, 'trench', { value: hexes, text: label || undefined }); },
  };

  function pollAiOps() {
    for (const civ of game.civs) {
      const p = civ.aiPlan; if (!p || civ.human || civ.isRebel) continue;
      const st = aiState(civ.id), op = p.op || null;
      if (op && op !== st.op) {
        if (st.op) opEnd(civ, st.op, 'retargeted');
        st.op = op; st.launched = !!op.launched;
        aiRow(civ, 'operation_start', { target_site: op.target, target_name: siteName(op.target), details: { resumed: game.time - (op.started ?? game.time) > 2 } }, false);
      }
      if (op && op.launched && !st.launched) {
        st.launched = true;
        const types = (ids) => { const m = new Map(); for (const id of ids || []) { const u = game.units.get(id); if (u) inc(m, u.type); } return Object.fromEntries(m); };
        aiRow(civ, 'task_force', { target_site: op.target, target_name: siteName(op.target), value: op.forces.reduce((n, f) => n + (f.ids?.length || 0), 0),
          details: { forces: op.forces.map((f) => ({ role: f.role, units: f.ids?.length || 0, types: types(f.ids) })) } }, false);
      }
    }
  }

  function event(ev, seat, row) { push('gameplay_events', { event: ev, seat, sim_time_s: game.time, ai: seat >= 0 ? !civOf(seat)?.human : undefined, ...row }); }

  function pollState() {
    if (!primed) prime();
    // units: production
    const seen = new Set();
    let n = 0;
    for (const u of game.units.values()) {
      n++; seen.add(u.id);
      if (known.units.has(u.id)) continue;
      known.units.set(u.id, u.type);
      if (u.auto) continue;   // base engineers are staff, not production
      inc(pl(u.owner).produced, u.type); inc(tot(u.owner).produced, u.type); tot(u.owner).units++;
    }
    if (n > cur.unitsMax) cur.unitsMax = n;
    for (const id of known.units.keys()) if (!seen.has(id)) known.units.delete(id);
    // buildings: built (first done) and lost
    const bSeen = new Set();
    for (const b of game.buildings.values()) {
      bSeen.add(b.id);
      const k = known.buildings.get(b.id);
      if (!k) { known.buildings.set(b.id, { type: b.type, owner: b.owner, tile: b.tile, done: !!b.done }); if (b.done) { event('building_built', b.owner, { type: b.type, tile: b.tile }); tot(b.owner).built++; } continue; }
      if (!k.done && b.done) { k.done = true; event('building_built', b.owner, { type: b.type, tile: b.tile }); tot(b.owner).built++; }
      k.owner = b.owner;
    }
    for (const [id, k] of known.buildings) if (!bSeen.has(id)) {
      known.buildings.delete(id);
      event('building_lost', k.owner, { type: k.type, tile: k.tile, details: { finished: k.done } }); tot(k.owner).lostB++;
    }
    // sites: captures and tiers
    for (const s of game.sites || []) {
      const k = known.sites.get(s.id);
      if (!k) { known.sites.set(s.id, { owner: s.owner, tier: s.tier, last: s.owner }); continue; }
      if (s.owner !== k.owner) {
        if (s.owner >= 0) event('capture', s.owner, { type: s.slots ? 'base' : s.kind || 'site', tile: s.tile, other_seat: k.last ?? k.owner, details: { site: s.name } });
        k.owner = s.owner; if (s.owner >= 0) k.last = s.owner;
      }
      if ((s.tier || 0) > (k.tier || 0) && s.owner >= 0) event('tier_up', s.owner, { type: 'base', tile: s.tile, value: s.tier, details: { site: s.name } });
      k.tier = s.tier;
    }
    // nations: upgrades, eras, eliminations, economy
    const dtSim = Math.max(0, game.time - simPrev); simPrev = game.time;
    for (const c of game.civs) {
      if (c.isRebel) continue;
      const techs = known.techs.get(c.id) || new Set();
      if (c.techs) for (const t of c.techs) if (!techs.has(t)) { techs.add(t); event('upgrade', c.id, { type: t }); }
      known.techs.set(c.id, techs);
      if (c.age !== known.age.get(c.id)) { if (known.age.get(c.id) != null) event('age_up', c.id, { value: c.age }); known.age.set(c.id, c.age); }
      if (known.alive.get(c.id) && !c.alive) { event('eliminated', c.id, { value: game.time }); eliminations.push({ seat: c.id, team: c.team, time_s: game.time }); }
      known.alive.set(c.id, c.alive);
      if (c.res) {
        const prev = known.res.get(c.id) || { m: c.res.materials, e: c.res.energy };
        const im = c.alive ? (c.rates?.materials || 0) * dtSim : 0, ie = c.alive ? (c.rates?.energy || 0) * dtSim : 0;
        const a = pl(c.id);
        a.incM += im; a.incE += ie;
        a.spM += prev.m + im - (c.res.materials || 0); a.spE += prev.e + ie - (c.res.energy || 0);   // net: clamped at 0 per minute
        known.res.set(c.id, { m: c.res.materials || 0, e: c.res.energy || 0 });
      }
    }
    if (game.speed !== known.speed) { event('speed_change', undefined, { value: game.speed, details: { from: known.speed } }); known.speed = game.speed; }
    // strategic missiles launched
    let proj = 0;
    for (const p of game.projectiles?.values?.() || []) {
      proj++;
      if (p.strategic && !known.proj.has(p.id)) { known.proj.add(p.id); event('nuke_launched', p.owner, { type: p.weapon, tile: p.to, other_seat: game.world?.owner?.[p.to] ?? undefined }); }
    }
    if (proj > cur.projMax) cur.projMax = proj;
    if (known.proj.size > 256) known.proj = new Set([...known.proj].slice(-128));
    // events since the last poll: kills (losses by type), missile intercepts
    const evs = game.events || [];
    let i = evs.length - 1;
    while (i >= 0 && evs[i].i > lastEvent) i--;
    for (let k = i + 1; k < evs.length; k++) {
      const e = evs[k];
      if (e.k === 'kill') {
        inc(pl(e.ow).lost, e.ty);
        const killer = game.units.get(e.s)?.owner ?? game.buildings.get(e.s)?.owner;
        battleLoss(e, killer);
      } else if (e.k === 'mintercept' && e.st) event('nuke_intercepted', game.buildings.get(e.s)?.owner ?? game.units.get(e.s)?.owner, { tile: e.b, type: 'strategic' });
    }
    if (evs.length) lastEvent = evs[evs.length - 1].i;
    if (game.groupJobs && game.groupJobs.length > cur.groupMax) cur.groupMax = game.groupJobs.length;
  }

  // ---------------------------------------------------------------- battles (game.engagements, read-only)
  const cellOf = (x, z) => `${Math.floor(x / 10)}:${Math.floor(z / 10)}`;
  function battleLoss(e, killer) {
    if (!Number.isFinite(e.bx)) return;
    const cell = cellOf(e.bx, e.bz);
    let best = null;
    for (const b of battles.values()) if (b.cell === cell && b.owners.includes(e.ow) && (killer == null || b.owners.includes(killer))) { best = b; break; }
    if (!best) return;
    const side = best.side(e.ow); inc(side.lost, e.ty); side.lostValue += cost(UNITS, e.ty) || cost(BUILDINGS, e.ty);
  }
  function pollBattles() {
    const eng = game.engagements; if (!eng) return;
    for (const [key, b] of eng) if (!battles.has(key)) {
      const [, , cx, cz] = key.split(':');
      const sides = new Map();
      battles.set(key, { key, ref: b, owners: b.owners, cell: `${cx}:${cz}`, cx: +cx, cz: +cz, sides, side: (o) => sides.get(o) || (sides.set(o, { peak: new Map(), peakN: 0, lost: new Map(), lostValue: 0 }).get(o)) });
    }
    if (battles.size) {
      // units of the two owners in the battle's 3x3 cell block, by type: the peak seen at once
      const need = new Map();
      for (const s of battles.values()) {
        s.now = new Map(s.owners.map((o) => [o, new Map()]));
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const c = `${s.cx + dx}:${s.cz + dz}`; (need.get(c) || need.set(c, []).get(c)).push(s); }
      }
      for (const u of game.units.values()) {
        if (u.auto || !(u.hp > 0)) continue;
        const list = need.get(cellOf(u.x, u.z)); if (!list) continue;
        for (const s of list) { const m = s.now.get(u.owner); if (m) inc(m, u.type); }
      }
      for (const s of battles.values()) for (const [o, m] of s.now) {
        const side = s.side(o); let n = 0;
        for (const [t, c] of m) { n += c; if (c > (side.peak.get(t) || 0)) side.peak.set(t, c); }
        if (n > side.peakN) side.peakN = n;
      }
    }
    for (const [key, s] of battles) if (eng.get(key) !== s.ref || overDone) { battles.delete(key); finishBattle(s); }
  }
  function finishBattle(s) {
    const b = s.ref;
    if (!(b.damage >= MIN_BATTLE_DAMAGE)) return;
    const sides = s.owners.map((o) => {
      const sd = s.side(o), lostCount = [...sd.lost.values()].reduce((a, c) => a + c, 0);
      return { seat: o, ...who(o), units_peak: sd.peakN, units: toCounts(sd.peak), losses: Math.max(lostCount, b.losses?.[o] || 0), lost: toCounts(sd.lost), lost_value: sd.lostValue,
        damage_taken: Object.values(b.weapons?.[o] || {}).reduce((a, c) => a + c, 0), weapons: Object.entries(b.weapons?.[o] || {}).map(([type, damage]) => ({ type, damage })) };
    });
    const [a, c] = sides, va = a.lost_value || a.losses, vc = c ? c.lost_value || c.losses : Infinity;
    const winner = !c || va === vc ? null : va < vc ? a : c, loser = winner === a ? c : a;
    const decisive = winner && loser && (winner === a ? vc : va) >= 3 * Math.max(1, winner === a ? va : vc);
    for (const sd of sides) { const t = tot(sd.seat); t.battles++; if (winner && sd.seat === winner.seat) t.won++; }
    const at = centerOf && b.tile >= 0 ? centerOf(b.tile) : null;
    push('battles', { battle_key: s.key, tile: b.tile, x: at?.x, z: at?.z, site: b.name, start_s: b.from, end_s: b.last, duration_s: b.last - b.from, damage: b.damage,
      winner_seat: winner ? winner.seat : -1, winner_team: winner ? winner.team : undefined, outcome: !winner ? 'even' : decisive ? 'decisive' : 'won', sides });
  }

  // ---------------------------------------------------------------- minute rows
  function minute(force = false) {
    readScheduler();
    const t = performance.now(), wall = (t - cur.at) / 1000;
    const simAdv = game.time - cur.sim;
    const tickStats = cur.sys.get('tick');
    if (cur.intervals === 0 && simAdv <= 0 && !force) { reset(t); return; }   // nobody playing: nothing to report
    const ts = tickStats ? sortNum(tickStats.samples) : new Float64Array(0);
    const systems = [...cur.sys].filter(([n]) => n !== 'tick').map(([name, a]) => {
      const s = sortNum(a.samples);
      return { name, calls: a.calls, total_ms: a.total, avg_ms: a.calls ? a.total / a.calls : 0, p50_ms: q(s, .5), p95_ms: q(s, .95), p99_ms: q(s, .99), max_ms: a.max,
        over_budget: (a.overEnd ?? a.over) - a.over, deferred: (a.deferredEnd ?? a.deferred) - a.deferred };
    }).sort((x, y) => y.total_ms - x.total_ms);
    const rs = sortNum(cur.routes);
    const navNow = flatNav(game.navStats), stuck = new Map();
    for (const [k, v] of navNow) { const d = v - (navPrev.get(k) || 0); if (d > 0 && k.startsWith('stuck.')) stuck.set(k.slice(6), d); }
    const retries = (navNow.get('routeRetry') || 0) - (navPrev.get('routeRetry') || 0);
    navPrev = navNow;
    const heap = v8.getHeapStatistics(), mb = (n) => n / 1048576, ns = (n) => (Number.isFinite(n) ? n / 1e6 : null);
    const e2 = performance.eventLoopUtilization(elu); elu = performance.eventLoopUtilization();
    let units = 0; for (const _ of game.units?.values?.() || []) units++;
    push('server_match_minute', {
      minute_index: minuteIndex, wall_s: wall, sim_time_s: game.time, sim_advanced_s: simAdv, game_speed: game.speed, pace: wall > 0 ? simAdv / wall : null,
      paused_s: cur.paused / 10, idle_s: Math.max(0, wall - (cur.intervals + cur.paused) / 10),
      ticks: tickStats?.calls ?? cur.ticks, intervals: cur.intervals,
      tick_ms_avg: tickStats?.calls ? tickStats.total / tickStats.calls : null, tick_ms_p50: q(ts, .5), tick_ms_p95: q(ts, .95), tick_ms_p99: q(ts, .99), tick_ms_max: tickStats?.max ?? null,
      interval_ms_max: cur.intervalMax, intervals_over_100ms: cur.over100, systems,
      snapshots: cur.snapshots, snapshot_ms_total: cur.snapMs, snapshot_ms_max: cur.snapMax, msgs_out: cur.msgs, bytes_out: cur.bytes, commands: cur.commands,
      routes: cur.routeN, route_ms_total: cur.routeMs, route_ms_p50: q(rs, .5), route_ms_p95: q(rs, .95), route_ms_max: cur.routeMax,
      route_failures: [...cur.routeFail.values()].reduce((a, c) => a + c, 0), route_fail_reasons: toCounts(cur.routeFail), route_retries: retries, stuck: toCounts(stuck),
      group_route_queue_max: cur.groupMax, group_route_queue_end: game.groupJobs?.length ?? null,
      units, units_max: Math.max(cur.unitsMax, units), buildings: game.buildings?.size ?? null, projectiles: game.projectiles?.size ?? null, projectiles_max: cur.projMax,
      civs: playable().length, alive: playable().filter((c) => c.alive).length,
      heap_used_mb: mb(heap.used_heap_size), heap_total_mb: mb(heap.total_heap_size), heap_limit_mb: mb(heap.heap_size_limit),
      gc_count: gc.n, gc_ms_total: gc.ms, gc_ms_max: gc.max,
      loop_lag_p50_ms: ns(lag.percentile(50)), loop_lag_p99_ms: ns(lag.percentile(99)), loop_lag_max_ms: ns(lag.max), loop_utilization: e2.utilization,
      autosaves: cur.autosaves, autosave_ms_max: cur.autosaveMax,
    });
    // players: economy, production, losses
    if (simAdv > 0 || force) for (const c of playable()) {
      const a = pl(c.id);
      let n = 0, value = 0; for (const u of game.units.values()) if (u.owner === c.id && !u.auto) { n++; value += cost(UNITS, u.type); }
      let bld = 0; for (const b of game.buildings.values()) if (b.owner === c.id) bld++;
      const bases = (game.sites || []).filter((s) => s.owner === c.id && s.slots && game.buildings.get(s.hq)?.done).length;
      push('player_minute', { seat: c.id, ...who(c.id), minute_index: Math.floor(game.time / 60), sim_time_s: game.time, alive: !!c.alive, age: c.age,
        materials: c.res?.materials, energy: c.res?.energy, income_materials: a.incM, income_energy: a.incE, spend_materials: Math.max(0, a.spM), spend_energy: Math.max(0, a.spE),
        units: n, army_value: value, buildings: bld, bases, produced: toCounts(a.produced), lost: toCounts(a.lost), kills: c.kills, casualties: c.casualties, ai_state: c.human ? undefined : c.aiPlan?.state });
    }
    player.clear();
    for (const st of ai.values()) st.rows = 0;
    minuteIndex++;
    reset(t);
  }
  function reset(t) {
    gc.n = 0; gc.ms = 0; gc.max = 0; lag.reset();
    const prevSys = cur.sys;
    cur = perf(); cur.at = t;
    for (const [name, a] of prevSys) cur.sys.set(name, { calls: 0, total: 0, max: 0, over: a.overEnd ?? a.over, deferred: a.deferredEnd ?? a.deferred, samples: [] });
  }

  function over() {
    if (overDone) return; overDone = true;
    pollBattles();
    minute(true);
    const w = game.winner || {};
    const winTeam = w.civ >= 0 ? (w.team ?? civOf(w.civ)?.team) : null;
    for (const c of playable()) {
      const t = tot(c.id), elim = eliminations.find((e) => e.seat === c.id);
      const bases = (game.sites || []).filter((s) => s.owner === c.id && s.slots && game.buildings.get(s.hq)?.done).length;
      push('match_results', { seat: c.id, ...who(c.id), result: winTeam == null ? 'draw' : c.team === winTeam ? 'win' : 'loss', eliminated_at_s: elim?.time_s,
        sim_time_s: game.time, end_reason: w.how, winner_team: winTeam ?? undefined, mode: game.sandbox ? 'sandbox' : undefined, map: game.mapId,
        kills: c.kills, casualties: c.casualties, bases_end: bases, units_produced: t.units, buildings_built: t.built, buildings_lost: t.lostB, produced: toCounts(t.produced), battles: t.battles, battles_won: t.won });
    }
    push('match_lifecycle', { event: 'ended', sim_time_s: game.time, winner_seat: w.civ ?? -1, winner_team: winTeam ?? undefined, end_reason: w.how, eliminations });
    flush();
  }

  function flush() { if (rows.length) post({ t: 'tm', rows: rows.splice(0) }); }

  return {
    /** One tick-loop iteration: ms for the whole iteration, ticks run, ms of the per-tick part. */
    interval(ms, ticks, paused) {
      if (paused) { cur.paused++; return; }
      cur.intervals++; cur.ticks += ticks;
      if (ms > cur.intervalMax) cur.intervalMax = ms;
      if (ms > 100) cur.over100++;
    },
    snapshot(ms) { cur.snapshots++; cur.snapMs += ms; if (ms > cur.snapMax) cur.snapMax = ms; },
    out(msgs) { cur.msgs += msgs.length; for (const m of msgs) cur.bytes += m[1].length; },
    command() { cur.commands++; },
    autosave(ms) { cur.autosaves++; if (ms > cur.autosaveMax) cur.autosaveMax = ms; },
    /** Once a second (its own timer in the worker). */
    second() {
      if (overDone) return;
      readScheduler();
      pollState(); pollAiOps(); pollBattles();
      if (game.over) { over(); return; }
      if (performance.now() - cur.at >= minuteMs) minute();
      flush();
    },
    minute, over, flush,
    stop() { lag.disable(); gcObs?.disconnect(); },
    get started() { return started; },
  };
}

// navStats flattened to numeric counters ('routeRetry', 'stuck.gaveUp', ...)
function flatNav(s) {
  const m = new Map();
  if (!s) return m;
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') m.set(k, v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'number') m.set(`${k}.${k2}`, v2);
  }
  return m;
}
