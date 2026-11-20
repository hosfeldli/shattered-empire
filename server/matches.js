import { validateRuleset, LEGACY_RULESET, ACTION_RULESET } from './sim/rulesets.js';

const CONGESTED_BYTES = 2 * 1024 * 1024;
// Lobby, matchmaking and match lifecycle. Each running match lives in its own worker thread;
// this process only routes messages between WebSocket clients and match workers, and persists
// match snapshots so games survive deploys, restarts and worker crashes.
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { negotiate, PROTOCOL_VERSION, CAPABILITIES } from './protocol.js';
import { cores as effectiveCores } from './cpuCores.js';
import { MAPS_BY_ID, mapList, mapMode } from './sim/mapCatalog.js';
import { baseOwnersProblem, parseSketch, sketchForTeams } from './sim/sketchMaps.js';

const PARKED_TTL_MS = +(process.env.PARKED_TTL_HOURS || 168) * 3600 * 1000;
const MAX_MATCHES = +(process.env.MAX_MATCHES || Math.max(4, Math.round(effectiveCores()) * 4));
const MAX_CIVS = 12;
const IDLE_MS = 10 * 60 * 1000;
const SIZES = { small: 128, medium: 192, large: 256 };
// Action RTS worlds: wide enough that bases stand well apart (site spacing scales with the size in actionMap.js).
const ACTION_SIZES = { small: 104, medium: 152, large: 208, huge: 232 };
const autoSize = (n) => (n <= 4 ? 128 : n <= 8 ? 192 : 256);
// Lobby formats (action RTS): teams × seats per team. Team = seat index / team size (actionGame.js), so
// moving a player between teams is a seat swap. FFA formats are one-seat teams.
const FORMATS = { '1v1': { teamSize: 1, teams: 2 }, '2v2': { teamSize: 2, teams: 2 }, '3v3': { teamSize: 3, teams: 2 }, '4v4': { teamSize: 4, teams: 2 },
  ffa3: { teamSize: 1, teams: 3 }, ffa4: { teamSize: 1, teams: 4 }, ffa5: { teamSize: 1, teams: 5 }, ffa6: { teamSize: 1, teams: 6 } };
const AI_DIFFICULTIES = ['easy', 'normal', 'hard', 'expert', 'brutal'];
const AI_PERSONALITIES = ['warlord', 'merchant', 'builder'];
// Lobby game options (host, New Skirmish): victory, starting resources and a random world's style and size.
const OBJECTIVES = ['domination', 'control', 'operation', 'horde'];   // 'horde': BLIGHT survival (sim/horde.js)
// BLIGHT survival: co-op seats from a format (its team size, or an FFA's player count; at most 4), else what was asked
const hordeSeats = (fmt, n) => Math.min(4, fmt ? (fmt.teamSize > 1 ? fmt.teamSize : fmt.teams > 2 ? fmt.teams : 1) : n);
const START_RESOURCES = ['low', 'standard', 'high', 'max'];   // amounts: actionGame.js START_RES
const STYLES = ['continents', 'pangaea', 'archipelago', 'inlandSea'];
// a catalog map takes any number of players from 2 up to its starts (actionMap.assignStarts)
const fitsMap = (def, seats) => seats >= 2 && seats <= def.players;
// A map-builder sketch (sketchMaps.js) as the lobby sees a map: a free-for-all map with one start per
// placed base (any format up to that many seats fits), its size one of the action sizes.
const sketchDef = (sk) => (sk ? { id: 'custom', name: sk.name, players: sk.bases.length, teamSize: 1, size: ACTION_SIZES[sk.size] || ACTION_SIZES.small } : null);
/** The catalog entry or the sketch of a match's map (null: a random world). */
const mapDefOf = (m) => (m.map === 'custom' ? sketchDef(m.sketch) : Object.hasOwn(MAPS_BY_ID, m.map || '') ? MAPS_BY_ID[m.map] : null);
const formatName = (teamSize, teams) => (teamSize > 1 || teams === 2 ? `${teamSize}v${teamSize}` : `ffa${teams}`);
// Admission control (inside this process: no change to how many instances run). A new match is
// refused, with a clear message, when the running matches already use most of the CPU time the
// tick loops have, or when free memory would not hold another worker of that map size.
const ADMIT_CPU = +(process.env.ADMIT_CPU_SHARE || 0.85);
const WORKER_MB = { 64: 90, 76: 100, 80: 105, 96: 115, 104: 122, 108: 125, 112: 130, 128: 140, 136: 150, 140: 160, 152: 180, 160: 200, 192: 260, 208: 290, 224: 330, 232: 350, 256: 420 };

// the three systems with the highest p95 in a match (for /api/health and the logs)
const slowest = (sys = {}) => Object.entries(sys).filter(([k]) => k !== 'tick').sort((a, b) => b[1].p95 - a[1].p95).slice(0, 3).map(([k, v]) => ({ system: k, p50: v.p50, p95: v.p95, p99: v.p99 }));

export class MatchManager {
  constructor(log = console, store = null) {
    this.matches = new Map();
    this.log = log;
    this.store = store;
    this.janitor = setInterval(() => this.cleanup(), 30_000);
    this.janitor.unref?.();
  }

  list() {
    return [...this.matches.values()].map((m) => ({
      id: m.id, name: m.name, status: m.status, mode: m.mode, ruleset: m.ruleset, created: m.created, mapSize: m.mapSize, map: m.map || 'random', watchers: (m.watchers || []).filter((w) => w.ws).length,
      slots: m.slots.map((s) => ({ name: s.name, human: s.human, taken: !!s.token, connected: !!s.ws })),
      time: m.stats?.time || 0,
    }));
  }

  create(opts) {
    // only running matches use a worker thread; parked ones are a saved file and never block a new match
    if ([...this.matches.values()].filter((x) => x.status !== 'parked').length >= MAX_MATCHES) throw new Error('Server is full, try again shortly');
    const ruleset = validateRuleset(opts.ruleset || LEGACY_RULESET);
    const action = ruleset === ACTION_RULESET;
    const id = crypto.randomBytes(3).toString('hex');
    const pvp = opts.mode === 'pvp';
    const observe = opts.mode === 'observe';   // AI-only match watched by spectators (no fog, speed control)
    const sandbox = opts.mode === 'sandbox';   // developer combat sandbox: one player, one passive opponent
    // a hand-authored map (mapCatalog.js) fixes its size; 'random' (the default) is procedural
    const mapId = action && !sandbox && opts.map && opts.map !== 'random' ? String(opts.map) : 'random';
    // 'custom': the host's map-builder sketch, validated here (a bad one refuses the match)
    const sketch = mapId === 'custom' ? parseSketch(opts.sketch) : null;
    const authored = mapId === 'custom' ? sketchDef(sketch) : mapId !== 'random' ? (Object.hasOwn(MAPS_BY_ID, mapId) ? MAPS_BY_ID[mapId] : null) : null;
    if (mapId !== 'random' && !authored) throw new Error(`Unknown map "${mapId}"`);
    // Watch AI Match (action RTS): the New Skirmish setup with every seat an AI. Impossible combinations
    // are refused with the reason rather than quietly changed (docs/gameplay-overhaul/WATCH_SETUP.md).
    if (observe && action) this.checkObserve(opts, authored);
    // a lobby format ('2v2', 'ffa4') or teams × teamSize fixes the seat count exactly (lobby and New Skirmish).
    // On a catalog map any format up to its number of starts fits (fewer players than it was drawn for, or
    // other teams: actionMap.assignStarts places them); without one, or one that does not fit, the map's own.
    let fmt = action && !sandbox ? (Object.hasOwn(FORMATS, opts.format) ? FORMATS[opts.format] : null) || (Number.isInteger(opts.teams) ? { teamSize: opts.teamSize | 0, teams: opts.teams } : null) : null;
    if (fmt && authored && !fitsMap(authored, Math.max(1, Math.min(4, fmt.teamSize | 0)) * Math.max(2, fmt.teams | 0))) fmt = null;
    const teamSize = fmt ? Math.min(4, Math.max(1, fmt.teamSize | 0)) : authored ? authored.teamSize : action && !sandbox ? Math.min(4, Math.max(1, opts.teamSize | 0)) : 1;
    const teams = fmt ? Math.max(2, Math.min(teamSize > 1 ? 2 : 6, fmt.teams | 0)) : 2;
    const desired = Math.min(MAX_CIVS, fmt || !authored ? teamSize * teams : authored.players);
    const fixed = fmt || authored;
    const humans = observe ? 0 : Math.max(1, Math.min(fixed ? desired : MAX_CIVS, pvp ? (opts.humans | 0) || (fixed ? desired : 2) : 1));
    const ais = authored && !fmt ? authored.players - humans : sandbox ? 1 : observe ? (fmt ? desired : Math.max(desired, Math.min(MAX_CIVS, opts.ais ?? 4))) : fmt ? desired - humans :
      Math.max(pvp ? 0 : 1, action ? desired - humans : 0, Math.min(MAX_CIVS - humans, opts.ais ?? 1));
    const personalities = ['warlord', 'merchant', 'builder'];
    const slots = [];
    for (let i = 0; i < humans; i++) slots.push({ human: true, name: i === 0 ? String(opts.name || 'Player').slice(0, 24) : 'Open seat', token: null, ws: null });
    const DIFFS = ['easy', 'normal', 'hard', 'expert', 'brutal'];
    const fairPlay = opts.fairPlay !== false;            // default: no numerical AI advantages at any level
    for (let i = 0; i < ais; i++) {
      // per-rival settings (advanced lobby) override the shared ones
      const r = Array.isArray(opts.rivals) ? opts.rivals[i] || {} : {};
      const pers = ['warlord', 'merchant', 'builder'].includes(r.personality) ? r.personality : opts.aiPersonality && opts.aiPersonality !== 'random' ? opts.aiPersonality : personalities[(i + ((Math.random() * 3) | 0)) % 3];
      const diff = DIFFS.includes(r.difficulty) ? r.difficulty : DIFFS.includes(opts.difficulty) ? opts.difficulty : 'normal';
      slots.push({ human: false, name: 'AI', personality: pers, difficulty: diff, fairPlay });
    }
    // BLIGHT survival (objective 'horde', HORDE_MODE.md): every seat is on one co-op side; a format's team size (or an
    // FFA's player count) is the squad size, so 1v1 is solo and 2v2 brings one AI ally. Surplus AI seats are dropped.
    if (action && !sandbox && !pvp && opts.objective === 'horde') slots.splice(Math.max(humans, observe ? 1 : 0, hordeSeats(fmt, slots.length)));
    const mapSize = authored ? authored.size : action ? (sandbox ? 64 : ACTION_SIZES[opts.mapSize] || (slots.length <= 2 ? ACTION_SIZES.small : slots.length <= 4 ? ACTION_SIZES.medium : ACTION_SIZES.large))
      : (sandbox ? 128 : SIZES[opts.mapSize] || autoSize(slots.length));
    const why = this.admit(mapSize);
    if (why) throw new Error(why);
    const m = { id, name: String(opts.title || (observe ? `AI exhibition (${ais} empires)` : `${opts.name || 'Player'}'s match`)).slice(0, 40), mode: pvp ? 'pvp' : observe ? 'observe' : sandbox ? 'sandbox' : 'ai', status: 'lobby', watchers: [], created: Date.now(), lastActive: Date.now(),
      seed: Number.isFinite(+opts.seed) && opts.seed !== '' && opts.seed != null ? +opts.seed | 0 : (Math.random() * 2 ** 31) | 0, slots, mapSize, rebels: !action && !sandbox && opts.rebels !== false, worker: null, stats: null,
      ruleset, wrap: !action, style: ['continents', 'pangaea', 'archipelago', 'inlandSea'].includes(opts.style) ? opts.style : action ? 'pangaea' : null,
      teamSize, map: mapId, tutorial: action && !pvp && !authored && opts.tutorial === true, objective: ['control', 'operation', 'horde'].includes(opts.objective) ? opts.objective : 'domination',
      startRes: START_RESOURCES.includes(opts.startRes) ? opts.startRes : 'standard' };
    // closed seats (uneven teams: 2 v 1, three humans against two AIs), on a random world or a catalog map
    // (whose unused starts stay neutral). Seat indices other than the creator's; dropped when the match starts.
    // An AI match may leave any seat empty (there is no creator's seat); there a seat that does not exist, or
    // one that would leave a single side, is refused instead of skipped.
    if (action && (fmt || authored) && !sandbox && Array.isArray(opts.closed)) {
      for (const v of opts.closed) {
        const i = Number(v);
        if (!Number.isInteger(i) || i < (observe ? 0 : 1) || i >= slots.length || slots[i].human && slots[i].token) {
          if (observe) throw new Error(`There is no seat ${v} to leave empty in this format`);
          continue;
        }
        const before = slots[i];
        slots[i] = { human: false, closed: true, name: 'Closed', token: null, ws: null };
        if (!this.playable(slots, teamSize)) {
          slots[i] = before;
          if (observe) throw new Error('At least two sides must keep an AI nation');
        }
      }
    }
    if (observe) {
      // the exhibition's own options: the starting speed (the spectator still changes it in the match) and
      // whether the spectator starts behind the followed nation's fog of war (in-match "Their fog of war")
      m.speed = [1, 2, 4, 8].includes(+opts.speed) ? +opts.speed : 1;
      m.observerFog = opts.fog === true;
      if (!opts.title) m.name = `AI exhibition (${slots.filter((s) => !s.closed).length} empires)`;
    }
    // lobby (pvp): the size the host asked for (random maps re-size with the seat count), and whether the
    // match waits for everyone to be ready (Unity lobby) instead of starting when the last seat is taken
    m.sizeKey = Object.hasOwn(ACTION_SIZES, opts.mapSize) ? opts.mapSize : null;
    if (sketch) {
      // a sketch that assigns its bases to teams must give every seat a base (MAP_BUILDER_TEAMS.md)
      const why = baseOwnersProblem(sketch, slots, teamSize);
      if (why) throw new Error(why);
      m.sketch = sketch;
    }
    m.waitForReady = pvp && opts.waitForReady === true;
    m.public = pvp && opts.public === true;   // listed in /api/lobbies (the in-game lobby browser)
    this.matches.set(id, m);
    this.telemetry?.lifecycle(m, 'created');
    this.log.info?.(`match ${id} created (${humans} humans, ${ais} AI, ${mapSize}x${mapSize})`);
    return m;
  }

  // Watch AI Match options, checked before anything is built: the New Skirmish choices (format, map, each AI,
  // rules, random world) plus the exhibition's speed and the spectator's fog. Throws the reason.
  checkObserve(o, authored) {
    const has = (k) => o[k] !== undefined && o[k] !== null && o[k] !== '';
    let seats = authored && !has('format') ? authored.players : 0;
    if (has('format')) {
      if (!Object.hasOwn(FORMATS, o.format)) throw new Error(`Unknown format "${o.format}"`);
      const f = FORMATS[o.format];
      seats = f.teamSize * f.teams;
      if (authored && !fitsMap(authored, seats)) throw new Error(`${authored.name} has ${authored.players} starting bases; a ${o.format} match needs ${seats}. Choose a smaller format or another map.`);
      if (has('ais') && Number(o.ais) !== seats) throw new Error(`A ${o.format} match has ${seats} AI nations, not ${o.ais}`);
    } else if (has('ais') && !authored) {
      const n = Number(o.ais);
      if (!Number.isInteger(n) || n < 2 || n > MAX_CIVS) throw new Error(`An AI match needs between 2 and ${MAX_CIVS} AI nations`);
      seats = n;
    }
    if (has('rivals')) {
      if (!Array.isArray(o.rivals)) throw new Error('rivals must be a list of AI settings');
      if (seats && o.rivals.length > seats) throw new Error(`${o.rivals.length} AI settings for ${seats} seats`);
      o.rivals.forEach((r, i) => {
        if (r == null || typeof r !== 'object') throw new Error(`AI ${i + 1}: settings must be an object`);
        if (r.difficulty != null && !AI_DIFFICULTIES.includes(r.difficulty)) throw new Error(`AI ${i + 1}: unknown difficulty "${r.difficulty}"`);
        if (r.personality != null && r.personality !== 'random' && !AI_PERSONALITIES.includes(r.personality)) throw new Error(`AI ${i + 1}: unknown personality "${r.personality}"`);
      });
    }
    if (has('difficulty') && !AI_DIFFICULTIES.includes(o.difficulty)) throw new Error(`Unknown AI difficulty "${o.difficulty}"`);
    if (has('aiPersonality') && o.aiPersonality !== 'random' && !AI_PERSONALITIES.includes(o.aiPersonality)) throw new Error(`Unknown AI personality "${o.aiPersonality}"`);
    if (has('objective') && !OBJECTIVES.includes(o.objective)) throw new Error(`Unknown victory condition "${o.objective}"`);
    if (has('startRes') && !START_RESOURCES.includes(o.startRes)) throw new Error(`Unknown starting resources "${o.startRes}"`);
    if (has('style') && !STYLES.includes(o.style)) throw new Error(`Unknown world style "${o.style}"`);
    // the setup screen sends a size name; the launch flag -map may pass a side length
    if (has('mapSize') && !Object.hasOwn(ACTION_SIZES, o.mapSize) && !Number.isInteger(+o.mapSize)) throw new Error(`Unknown map size "${o.mapSize}"`);
    if (has('speed') && ![1, 2, 4, 8].includes(+o.speed)) throw new Error('Game speed must be 1×, 2×, 4× or 8×');
    if (has('fog') && typeof o.fog !== 'boolean') throw new Error('fog must be true or false');
    if (has('seed') && !Number.isFinite(+o.seed)) throw new Error('The seed must be a whole number');
    if (has('closed')) {
      if (!Array.isArray(o.closed)) throw new Error('closed must be a list of seats');
      if (o.closed.length && !has('format') && !authored) throw new Error('Choose a format (or a catalog map) to leave seats empty');
    }
  }

  // spectator seat: watches the whole map, cannot give orders
  watch(m, name) {
    if ((m.watchers || (m.watchers = [])).length >= 8) throw new Error('Too many spectators');
    const w = { token: crypto.randomBytes(16).toString('hex'), ws: null, name: String(name || 'Spectator').slice(0, 24), spectator: true };
    m.watchers.push(w);
    return w;
  }

  seat(m, name) {
    const slot = m.slots.find((s) => s.human && !s.token);
    if (!slot) throw new Error('Match is full');
    slot.token = crypto.randomBytes(16).toString('hex');
    if (name) slot.name = String(name).slice(0, 24);
    return slot;
  }

  meta(m) { return { ruleset: m.ruleset || LEGACY_RULESET, id: m.id, name: m.name, mode: m.mode, created: m.created, lastActive: m.lastActive, seed: m.seed, mapSize: m.mapSize, rebels: m.rebels, wrap: m.wrap !== false, style: m.style,
    teamSize: m.teamSize, map: m.map || 'random', sketch: m.map === 'custom' ? m.sketch : undefined, tutorial: m.tutorial, objective: m.objective, startRes: m.startRes, teamOf: m.teamOf,
    speed: m.speed, observerFog: m.observerFog || undefined,
    slots: m.slots.map((s) => ({ human: s.human, name: s.name, personality: s.personality, difficulty: s.difficulty, fairPlay: s.fairPlay, token: s.token, civId: s.civId })), watchers: (m.watchers || []).map((w) => ({ token: w.token, name: w.name })) }; }

  start(m, restoreBuf = null) {
    if (m.status === 'running' && m.worker) return;
    // the lobby as it was, so a world that cannot be generated (a sketch with no room for a base) hands it back
    const before = restoreBuf ? null : { slots: m.slots.map((s) => [s, { ...s }]), teamOf: m.teamOf, teamSize: m.teamSize };
    // a custom map's team-owned bases: every seat keeps a base, and the owners follow the teams' renumbering
    let startSketch = m.map === 'custom' ? m.sketch : null;
    if (!restoreBuf && startSketch?.owners) {
      const why = baseOwnersProblem(startSketch, m.slots, m.teamSize);
      if (why) throw new Error(why);
      startSketch = sketchForTeams(startSketch, m.slots, m.teamSize);
    }
    if (!restoreBuf) { this.dropClosed(m); this.catalogTeams(m); }
    if (!restoreBuf) for (const s of m.slots) if (s.human && !s.token) { s.human = false; s.name = 'AI'; s.personality = 'builder'; s.difficulty = s.difficulty || 'normal'; s.fairPlay = s.fairPlay !== false; }
    m.slots.forEach((s, i) => { s.civId = i; });
    m.status = 'running';
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { ruleset: m.ruleset || LEGACY_RULESET, id: m.id, seed: m.seed, mapSize: m.mapSize, rebels: m.rebels, restore: restoreBuf, observe: m.mode === 'observe', wrap: m.wrap !== false, style: m.style, sandbox: m.mode === 'sandbox',
        teamSize: m.teamSize, map: m.map || 'random', sketch: startSketch || null, tutorial: m.tutorial, objective: m.objective, startRes: m.startRes || 'standard', teamOf: m.teamOf,
        speed: m.mode === 'observe' ? m.speed || 1 : undefined, observerFog: m.mode === 'observe' && !!m.observerFog, telemetry: this.telemetry?.workerOptions() || null,
        slots: m.slots.map((s) => ({ human: s.human, name: undefined, leader: s.name, personality: s.personality, difficulty: s.difficulty, fairPlay: s.fairPlay })) },
      resourceLimits: { maxOldGenerationSizeMb: m.mapSize >= 256 ? 1024 : 512 },
    });
    m.worker = worker; m.ready = false; m.pending = [];
    worker.on('message', (msg) => this.onWorker(m, msg));
    worker.on('error', (e) => {
      this.log.error?.(`match ${m.id} worker error`, e);
      if (before && !m.ready && m.worker === worker) this.startFailed(m, before, e);
    });
    worker.on('exit', (code) => {
      if (m.worker !== worker) return;
      m.worker = null;
      if (m.status === 'running' && !this.stopping) {
        this.log.warn?.(`match ${m.id} worker exited (${code}); recovering from last snapshot`);
        this.recover(m);
      }
    });
    this.log.info?.(`match ${m.id} ${restoreBuf ? 'restored' : 'started'} seed=${m.seed} size=${m.mapSize}`);
    this.telemetry?.lifecycle(m, restoreBuf ? 'restored' : 'started');
  }

  // A new match whose world could not be built (the worker threw before it was ready, e.g. a map-builder
  // sketch that validates but has no room for a base): nothing was played, so a lobby goes back to the
  // lobby as it was, with the reason shown; a skirmish, exhibition or sandbox is closed with the reason.
  startFailed(m, before, e) {
    const w = m.worker; m.worker = null; m.ready = false; m.pending = [];
    if (w) w.terminate().catch(() => {});
    const why = `The match could not start: ${String(e?.message || e || 'world generation failed').replace(/^Error:\s*/, '')}`;
    m.slots = before.slots.map(([s, copy]) => {
      for (const k of Object.keys(s)) if (!(k in copy) && k !== 'ws') delete s[k];
      return Object.assign(s, copy, { ws: s.ws });
    });
    m.teamSize = before.teamSize;
    if (before.teamOf === undefined) delete m.teamOf; else m.teamOf = before.teamOf;
    const seen = [...m.slots, ...(m.watchers || [])];
    if (m.mode === 'pvp') {
      m.status = 'lobby';
      for (const s of m.slots) if (s.human) s.ready = false;
      for (const s of seen) if (s.ws) this.send(s.ws, { t: 'error', error: why, startFailed: true });
      this.roomUpdate(m);
    } else {
      m.status = 'over';
      this.matches.delete(m.id);
      for (const s of seen) if (s.ws) { this.send(s.ws, { t: 'lobbyClosed', match: m.id, error: why, startFailed: true }); s.ws.ctx = { ...s.ws.ctx, match: null, slot: null }; }
    }
    this.log.warn?.(`match ${m.id}: ${why}`);
    this.telemetry?.lifecycle(m, 'start_failed', { end_reason: why });
  }

  async recover(m) {
    try {
      const buf = m.lastSnapshot || (this.store && (await this.store.load(m.id)));
      if (!buf) throw new Error('no snapshot');
      const meta = JSON.parse(zlib.gunzipSync(buf).toString()).meta;
      void meta;
      this.start(m, this.gameBuf(buf));
    } catch (e) {
      this.log.error?.(`match ${m.id} could not be recovered`, e);
      m.status = 'over';
      for (const s of [...m.slots, ...(m.watchers || [])]) if (s.ws) this.send(s.ws, { t: 'error', error: 'This match could not be recovered after a server fault.' });
    }
  }

  // snapshot file = { meta, game } gzipped; the worker only needs the game part
  pack(m, gameBuf) { return zlib.gzipSync(JSON.stringify({ meta: this.meta(m), game: JSON.parse(zlib.gunzipSync(gameBuf).toString()) })); }
  gameBuf(packed) { return zlib.gzipSync(JSON.stringify(JSON.parse(zlib.gunzipSync(packed).toString()).game)); }

  async persist(m, gameBuf) {
    const packed = this.pack(m, Buffer.from(gameBuf));
    m.lastSnapshot = packed;
    if (this.store) try { await this.store.save(m.id, packed); m.savedAt = Date.now(); } catch (e) { this.log.warn?.(`snapshot ${m.id} failed: ${e.message}`); }
  }

  // Backpressure: a connection whose send buffer is backing up (a slow client or network in a big
  // battle) gets no new snapshots until it drains. The worker skips building them, so incremental
  // tile updates are not lost, and the heartbeat ping is not stuck behind megabytes of state.
  backpressure(m) {
    const busy = (ws) => !!ws && ws.readyState === 1 && ws.bufferedAmount > CONGESTED_BYTES;
    const now = new Set();
    m.slots.forEach((s, civId) => { if (busy(s.ws)) now.add(civId); });
    if ((m.watchers || []).some((w) => busy(w.ws))) now.add(-2);
    const before = m.congested || new Set();
    const changed = now.size !== before.size || [...now].some((id) => !before.has(id));
    if (!changed) { if (now.size) { clearTimeout(m.congestionTimer); m.congestionTimer = setTimeout(() => this.backpressure(m), 250); } return; }
    m.congested = now;
    m.worker?.postMessage({ t: 'congestion', civs: [...now] });
    // while held, nothing new is sent to that connection, so re-check until it drains
    clearTimeout(m.congestionTimer);
    if (now.size) m.congestionTimer = setTimeout(() => this.backpressure(m), 250);
    if (now.size) this.log.warn?.(`match ${m.id}: holding snapshots for congested connections ${[...now].join(', ')}`);
  }

  onWorker(m, msg) {
    switch (msg.t) {
      case 'ready':
        m.ready = true;
        for (const s of m.slots) if (s.ws) this.welcome(m, s);
        for (const w of m.watchers || []) if (w.ws) this.welcome(m, w);
        for (const p of m.pending.splice(0)) m.worker.postMessage(p);
        break;
      case 'out':
        for (const [civId, str, cap] of msg.msgs) {
          // a message that needs a capability only reaches connections that negotiated it
          const ok = (ws) => ws && ws.readyState === 1 && (!cap || ws.ctx?.caps?.includes(cap));
          if (civId === -2) { for (const w of m.watchers || []) if (ok(w.ws)) w.ws.send(str); continue; }
          if (civId < 0) { for (const s of [...m.slots, ...(m.watchers || [])]) if (ok(s.ws)) s.ws.send(str); }
          else { const s = m.slots[civId]; if (s && ok(s.ws)) s.ws.send(str); }
        }
        this.backpressure(m);
        break;
      case 'tm': this.telemetry?.fromWorker(m, msg.rows); break;
      case 'stats': m.stats = msg; if (msg.avg > 50) this.log.warn?.(`match ${m.id} avg tick ${msg.avg}ms (max ${msg.max}ms); slowest: ${slowest(msg.systems).map((x) => `${x.system} p95 ${x.p95}ms`).join(', ')}`); break;
      case 'autosave': this.persist(m, msg.buf); break;
      case 'saved': this.persist(m, msg.buf).then(() => { const r = m.saveWaiters?.shift(); if (r) r(); }); break;
      case 'over': m.status = 'over'; m.overAt = Date.now(); this.persist(m, msg.buf); setTimeout(() => this.stopWorker(m), 5000); break;
      case 'error': this.log.error?.(`match ${m.id} sim error`, msg.error); break;
      default: break;
    }
  }

  toWorker(m, msg) { if (!m.worker) return; if (m.ready) m.worker.postMessage(msg); else m.pending.push(msg); }
  welcome(m, slot) {
    const caps = slot.ws?.ctx?.caps || [];
    if (!slot.spectator) return this.toWorker(m, { t: 'welcome', civId: slot.civId, caps });
    // spectators share one channel: snapshot encodings may use only what every connected spectator negotiated
    const shared = caps.filter((c) => (m.watchers || []).every((w) => !w.ws || w.ws === slot.ws || w.ws.ctx?.caps?.includes(c)));
    this.toWorker(m, { t: 'obsWelcome', caps, shared });
  }
  send(ws, msg) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } } }
  // The pre-game lobby as each seated player sees it: the match code to share, who holds which seat,
  // who is connected and ready, which seat is yours, and whether you (the host, seat 0) may start.
  // Open human seats become AI when the host starts early; the match starts by itself once every
  // human seat is taken.
  roomUpdate(m) {
    const host = this.hostOf(m), ts = Math.max(1, m.teamSize || 1);
    const slots = m.slots.map((x, i) => ({ seat: i, team: Math.floor(i / ts), name: x.name, human: x.human, closed: x.closed || undefined, taken: !!x.token, connected: !!x.ws, ready: x.human ? !!x.ready : undefined, host: x === host || undefined,
      difficulty: x.human || x.closed ? undefined : x.difficulty, personality: x.human || x.closed ? undefined : x.personality, fairPlay: x.human || x.closed ? undefined : x.fairPlay !== false }));
    const open = m.slots.filter((x) => x.human && !x.token).length;
    const teams = this.teamsOf(m);
    const spectators = (m.watchers || []).map((w) => ({ name: w.name, connected: !!w.ws }));
    const room = { t: 'room', match: m.id, code: m.id, name: m.name, status: m.status, mode: m.mode, ruleset: m.ruleset, mapSize: m.mapSize, teamSize: m.teamSize, map: m.map || 'random', mapName: mapDefOf(m)?.name || 'Random',
      mapPlayers: mapDefOf(m)?.players || 0, mapFormat: mapDefOf(m) ? mapMode(mapDefOf(m)) : null, sketch: m.map === 'custom' ? m.sketch : undefined,
      teams, format: formatName(ts, teams), players: m.slots.filter((x) => !x.closed).length, waitForReady: !!m.waitForReady, host: host?.name, open, slots, spectators,
      objective: m.objective || 'domination', startRes: m.startRes || 'standard', style: m.style, size: m.sizeKey || null, public: !!m.public };
    m.slots.forEach((s, i) => {
      if (s.ws) this.send(s.ws, { ...room, you: i, isHost: s === host, canStart: s === host && m.status === 'lobby' });
    });
    for (const w of m.watchers || []) if (w.ws) this.send(w.ws, { ...room, you: -1, spectator: true, isHost: false, canStart: false });
  }

  // a seated player leaves a match that has not started: a guest frees the seat for someone else;
  // the host closes the lobby and everyone else is told
  leaveLobby(ws) {
    const { match: m, slot } = ws.ctx;
    if (!m || !slot || m.status !== 'lobby') return false;
    ws.ctx = { ...ws.ctx, match: null, slot: null };
    if (slot.spectator) {
      m.watchers = (m.watchers || []).filter((w) => w !== slot);
      this.roomUpdate(m);
    } else if (slot === this.hostOf(m)) {
      this.matches.delete(m.id);
      for (const s of [...m.slots, ...(m.watchers || [])]) if (s.ws && s.ws !== ws) { this.send(s.ws, { t: 'lobbyClosed', match: m.id, error: 'The host closed the lobby' }); s.ws.ctx = { ...s.ws.ctx, match: null, slot: null }; }
      this.log.info?.(`match ${m.id} lobby closed by the host`);
      this.telemetry?.lifecycle(m, 'lobby_closed', { end_reason: 'host_left' });
    } else {
      Object.assign(slot, { token: null, ws: null, name: 'Open seat', ready: false });
      m.lastActive = Date.now();
      this.roomUpdate(m);
    }
    this.send(ws, { t: 'left', match: m.id });
    return true;
  }

  attach(ws) {
    ws.ctx = { match: null, slot: null, proto: 1, caps: [] };
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      ws.rawBytes = raw.length;   // telemetry size limit
      try { this.handle(ws, msg); } catch (e) { this.send(ws, { t: 'error', error: e.message, rid: msg.rid }); }
    });
    ws.on('close', () => {
      const { match, slot } = ws.ctx;
      if (match && slot && slot.ws === ws) {
        slot.ws = null;
        if (slot.spectator && match.status === 'lobby') match.watchers = match.watchers.filter((w) => w !== slot);   // a lobby spectator who left
        else if (slot.spectator) { if (!match.watchers.some((w) => w.ws)) this.toWorker(match, { t: 'observe', on: false }); }
        else if (slot.civId != null) this.toWorker(match, { t: 'connect', civId: slot.civId, on: false });
        match.lastActive = Date.now();
        if (match.status === 'lobby') this.roomUpdate(match);
      }
    });
  }

  handle(ws, msg) {
    const ctx = ws.ctx;
    switch (msg.t) {
      case 'ping': return this.send(ws, { t: 'pong', at: msg.at });
      case 'hello': {
        // versioned handshake; capabilities apply from the next welcome on this connection
        const r = negotiate(msg);
        if (r.error) return this.send(ws, { t: 'hello', ok: false, error: r.error, proto: PROTOCOL_VERSION });
        ctx.proto = r.proto; ctx.caps = r.caps;
        this.telemetry?.hello(ctx, msg);
        return this.send(ws, { t: 'hello', ok: true, proto: r.proto, server: PROTOCOL_VERSION, caps: r.caps, offered: CAPABILITIES, version: process.env.APP_VERSION || 'dev', maps: mapList(), telemetry: this.telemetry?.helloReply() });
      }
      // client diagnostics (docs/TELEMETRY.md): validated, rate-limited, dropped silently when telemetry is off
      case 'telemetry': this.telemetry?.client(ws, msg, ws.rawBytes || 0); return;
      case 'maps': return this.send(ws, { t: 'maps', maps: mapList(), rid: msg.rid });
      case 'list': return this.send(ws, { t: 'lobby', matches: this.list().filter((m) => m.ruleset !== ACTION_RULESET || ctx.caps?.includes('ring-cities-v1')) });
      case 'create': {
        if (msg.ruleset === ACTION_RULESET && (!ctx.caps?.includes('action-rts') || !ctx.caps?.includes('ring-cities-v1'))) throw new Error('This match requires the updated Unity client with ring-city RTS support.');
        const m = this.create(msg);
        const slot = m.mode === 'observe' ? this.watch(m, msg.name) : this.seat(m, msg.name);
        if (!slot.spectator) m.hostSlot = slot;
        this.bind(ws, m, slot);
        if (m.mode === 'ai' || m.mode === 'observe' || m.mode === 'sandbox') this.start(m); else this.roomUpdate(m);
        return;
      }
      case 'spectate': {
        // watch any running match (no fog, no orders)
        const m = this.matches.get(String(msg.match || '').toLowerCase()); if (!m) throw new Error('No such match');
        this.requireClient(ctx, m);
        if (m.status === 'lobby' && m.mode !== 'pvp') throw new Error('Match has not started yet');
        if (ctx.match && ctx.slot && ctx.match !== m) this.leaveLobby(ws);
        const w = this.watch(m, msg.name);
        this.bind(ws, m, w);
        // a lobby's spectator seat: sees the room now and watches the match once it starts
        if (m.status === 'lobby') { this.roomUpdate(m); return; }
        this.wake(m); this.welcome(m, w);
        return;
      }
      case 'join': {
        // codes are shared by voice and chat: tolerate case, spaces and a leading '#'
        const code = String(msg.match || '').trim().replace(/^#/, '').toLowerCase();
        const m = this.matches.get(code); if (!m) throw new Error(`No match with the code "${code}"`);
        // the same player asking twice (a second invite click) keeps the seat they have
        if (ctx.match === m && ctx.slot && !ctx.slot.spectator && m.status === 'lobby') { this.bind(ws, m, ctx.slot); this.roomUpdate(m); return; }
        if (ctx.match && ctx.slot && ctx.match !== m) this.leaveLobby(ws);
        this.requireClient(ctx, m);
        if (m.status !== 'lobby') throw new Error('Match already started');
        const slot = this.seat(m, msg.name);
        this.bind(ws, m, slot);
        this.roomUpdate(m);
        this.autoStart(m);
        return;
      }
      case 'rejoin': {
        const m = this.matches.get(msg.match); if (!m) throw new Error('Match no longer exists');
        this.requireClient(ctx, m);
        const slot = [...m.slots, ...(m.watchers || [])].find((s) => s.token && s.token === msg.token); if (!slot) throw new Error('Invalid session');
        if (slot.ws && slot.ws !== ws) { try { slot.ws.close(4000, 'replaced'); } catch { /* ignore */ } }
        this.bind(ws, m, slot);
        if (m.status === 'lobby') this.roomUpdate(m); else { this.wake(m); this.welcome(m, slot); }
        return;
      }
      case 'start': {
        if (!ctx.match || ctx.match.status !== 'lobby') throw new Error('Not in a match lobby');
        if (this.hostOf(ctx.match) !== ctx.slot) throw new Error('Only the host can start the match');
        this.start(ctx.match);
        return;
      }
      case 'ready': {
        if (!ctx.match || ctx.match.status !== 'lobby' || !ctx.slot || ctx.slot.spectator) throw new Error('Not in a match lobby');
        ctx.slot.ready = msg.on !== false;
        this.roomUpdate(ctx.match);
        this.autoStart(ctx.match);
        return;
      }
      // lobby seat editing (see editLobby): seats, teams, AI seats, format and map
      case 'watch': {
        // a seated player (not the host) moves to the lobby's spectator seats; their seat opens
        const m = this.lobbyOf(ctx), me = ctx.slot;
        if (me === this.hostOf(m)) throw new Error('The host plays in the match');
        const w = this.watch(m, me.name);
        Object.assign(me, { token: null, ws: null, name: 'Open seat', ready: false });
        this.bind(ws, m, w);
        this.roomUpdate(m);
        if (msg.rid != null) this.send(ws, { t: 'ack', rid: msg.rid });
        return;
      }
      case 'sit': {
        // a lobby spectator takes an open seat ({ to } or the first open one)
        const m = ctx.match;
        if (!m || m.status !== 'lobby' || !ctx.slot?.spectator) throw new Error('Not watching a match lobby');
        const to = msg.to != null ? Number(msg.to) : m.slots.findIndex((s) => s.human && !s.token);
        const s = m.slots[to];
        if (!s || !s.human || s.token || s.closed) throw new Error('That seat is not open');
        m.watchers = m.watchers.filter((w) => w !== ctx.slot);
        s.token = crypto.randomBytes(16).toString('hex'); s.name = String(ctx.slot.name || 'Player').slice(0, 24); s.ready = false;
        this.bind(ws, m, s);
        this.roomUpdate(m);
        if (msg.rid != null) this.send(ws, { t: 'ack', rid: msg.rid });
        return;
      }
      case 'seat': case 'team': case 'addAi': case 'removeAi': case 'aiDifficulty': case 'mode': case 'map': case 'options': case 'closeSeat': {
        const m = this.lobbyOf(ctx);
        this.editLobby(m, ctx.slot, msg);
        m.lastActive = Date.now();
        this.roomUpdate(m);
        if (msg.rid != null) this.send(ws, { t: 'ack', rid: msg.rid });
        return;
      }
      case 'room': {
        if (ctx.match && ctx.slot?.spectator && ctx.match.status === 'lobby') { this.roomUpdate(ctx.match); return; }
        if (!ctx.match || ctx.match.status !== 'lobby') throw new Error('Not in a match lobby');
        this.roomUpdate(ctx.match);
        return;
      }
      case 'leave': { if (!this.leaveLobby(ws)) throw new Error('Not in a match lobby'); return; }
      case 'cmd': {
        const m = ctx.match; if (!m || !m.worker || !ctx.slot || (ctx.slot.civId == null && !ctx.slot.spectator)) throw new Error('Not in a running match');
        m.lastActive = Date.now();
        if (ctx.slot.spectator) this.toWorker(m, { t: 'obsCmd', cmd: msg.cmd || {}, rid: msg.rid });
        else this.toWorker(m, { t: 'cmd', civId: ctx.slot.civId, cmd: msg.cmd || {}, rid: msg.rid });
        return;
      }
      case 'obsCmd': {
        // spectators' commands (follow, fog, match speed) in their own envelope; the worker validates them
        const m = ctx.match; if (!m || !m.worker || !ctx.slot?.spectator) throw new Error('Not spectating a running match');
        m.lastActive = Date.now();
        this.toWorker(m, { t: 'obsCmd', cmd: msg.cmd || {}, rid: msg.rid });
        return;
      }
      case 'admin': if (!this.admin) throw new Error('Administration is not available'); return this.admin.handle(ws, msg);
      default: throw new Error('Unknown message');
    }
  }

  // ------------------------------------------------------------------ lobby seat editing
  // The host (by reference: seats move, the host keeps the role) edits the room; players may move only
  // themselves, to a free seat (an open seat or an AI's, which takes theirs). Every change is answered
  // with a fresh 'room' to everyone; a refused one with an 'error' to the sender.
  hostOf(m) { return m.hostSlot && m.slots.includes(m.hostSlot) ? m.hostSlot : m.slots[0]; }
  teamsOf(m) { return Math.max(1, Math.ceil(m.slots.length / Math.max(1, m.teamSize || 1))); }
  lobbyOf(ctx) {
    const m = ctx.match;
    if (!m || m.status !== 'lobby' || !ctx.slot || ctx.slot.spectator || !m.slots.includes(ctx.slot)) throw new Error('Not in a match lobby');
    return m;
  }

  editLobby(m, me, msg) {
    const host = this.hostOf(m), isHost = me === host;
    const needHost = (what) => { if (!isHost) throw new Error(`Only the host can ${what}`); };
    const seatOf = (v, fallback) => {
      if (v == null) { if (fallback >= 0) return fallback; throw new Error('Choose a seat'); }
      const i = Number(v);
      if (!Number.isInteger(i) || i < 0 || i >= m.slots.length) throw new Error('No such seat');
      return i;
    };
    const mine = m.slots.indexOf(me), ts = Math.max(1, m.teamSize || 1);
    const free = (s) => !s.closed && (!s.human || !s.token);
    const aiAt = (i) => { const s = m.slots[i]; if (s.human || s.closed) throw new Error('That seat is not an AI'); return s; };
    switch (msg.t) {
      case 'seat': {
        // { to } moves you; the host may move any seat: { seat, to }
        const from = seatOf(msg.seat, mine), to = seatOf(msg.to);
        if (from !== mine) needHost('move other players');
        if (from === to) return;
        if (!isHost && !free(m.slots[to])) throw new Error('That seat is taken');
        if (m.slots[to].closed || m.slots[from].closed) throw new Error('That seat is closed');
        [m.slots[from], m.slots[to]] = [m.slots[to], m.slots[from]];
        return;
      }
      case 'team': {
        // { team } moves you to a free seat in that team (an open seat before an AI's); the host may move anyone: { seat, team }
        const from = seatOf(msg.seat, mine), team = Number(msg.team), teams = this.teamsOf(m);
        if (from !== mine) needHost('move other players');
        if (!Number.isInteger(team) || team < 0 || team >= teams) throw new Error('No such team');
        if (Math.floor(from / ts) === team) return;
        let to = -1;
        for (let i = team * ts; i < Math.min(m.slots.length, (team + 1) * ts); i++) if (free(m.slots[i]) && (to < 0 || m.slots[i].human && !m.slots[to].human)) to = i;
        if (to < 0) throw new Error(`Team ${team + 1} is full`);
        [m.slots[from], m.slots[to]] = [m.slots[to], m.slots[from]];
        return;
      }
      case 'addAi': {
        // an open seat becomes an AI: { seat } or the first open seat (in { team } when given)
        needHost('add AI players');
        let i = -1;
        if (msg.seat != null) i = seatOf(msg.seat);
        else for (let k = 0; k < m.slots.length && i < 0; k++) if (m.slots[k].human && !m.slots[k].token && (msg.team == null || Math.floor(k / ts) === Number(msg.team))) i = k;
        if (i < 0) throw new Error('No open seat for an AI (remove one or change the format)');
        const s = m.slots[i];
        if (!s.human || s.token) throw new Error('That seat is not open');
        if (msg.difficulty != null && !AI_DIFFICULTIES.includes(msg.difficulty)) throw new Error('Unknown AI difficulty');
        if (msg.personality != null && msg.personality !== 'random' && !AI_PERSONALITIES.includes(msg.personality)) throw new Error('Unknown AI personality');
        Object.assign(s, { human: false, name: 'AI', token: null, ws: null, ready: false, fairPlay: true, difficulty: msg.difficulty || 'normal',
          personality: AI_PERSONALITIES.includes(msg.personality) ? msg.personality : AI_PERSONALITIES[(Math.random() * 3) | 0] });
        return;
      }
      case 'removeAi': {
        needHost('remove AI players');
        const s = aiAt(seatOf(msg.seat));
        Object.assign(s, { human: true, name: 'Open seat', token: null, ws: null, ready: false });
        delete s.difficulty; delete s.personality; delete s.fairPlay;
        return;
      }
      case 'aiDifficulty': {
        // { seat, difficulty?, personality? }
        needHost('change AI players');
        const s = aiAt(seatOf(msg.seat));
        if (msg.difficulty == null && msg.personality == null) throw new Error('Choose a difficulty or a personality');
        if (msg.difficulty != null && !AI_DIFFICULTIES.includes(msg.difficulty)) throw new Error('Unknown AI difficulty');
        if (msg.personality != null && !AI_PERSONALITIES.includes(msg.personality)) throw new Error('Unknown AI personality');
        if (msg.difficulty != null) s.difficulty = msg.difficulty;
        if (msg.personality != null) s.personality = msg.personality;
        return;
      }
      case 'mode': {
        // { mode: '1v1' | '2v2' | '3v3' | '4v4' | 'ffa3' | 'ffa4' | 'ffa5' | 'ffa6' }
        needHost('change the format');
        if (m.ruleset !== ACTION_RULESET) throw new Error('Formats are part of the action RTS');
        const f = Object.hasOwn(FORMATS, msg.mode) ? FORMATS[msg.mode] : null;
        if (!f) throw new Error('Unknown format');
        // a catalog map stays while the format still fits its starts
        const map = mapDefOf(m);
        const keepMap = map && fitsMap(map, f.teamSize * f.teams);
        this.relayout(m, f.teamSize, f.teams);   // throws (nothing changed) when more players are seated than it holds
        if (map && !keepMap) { m.map = 'random'; delete m.sketch; this.resize(m); }
        return;
      }
      case 'map': {
        needHost('choose the map');
        if (m.ruleset !== ACTION_RULESET) throw new Error('Maps are part of the action RTS');
        const id = String(msg.map || 'random');
        if (id === 'random') { m.map = 'random'; delete m.sketch; this.resize(m); return; }
        // { map: 'custom', sketch }: the host's map-builder sketch (validated; every client previews it from the room)
        const sketch = id === 'custom' ? parseSketch(msg.sketch) : null;
        const def = sketch ? sketchDef(sketch) : Object.hasOwn(MAPS_BY_ID, id) ? MAPS_BY_ID[id] : null;
        if (!def) throw new Error(`Unknown map "${id}"`);
        // the seats stay when they fit the map's starts (2 v 2 on a free-for-all map, a duel on a 3 v 3 map);
        // otherwise the map's own format
        if (!fitsMap(def, m.slots.length)) this.relayout(m, def.teamSize, Math.max(2, Math.round(def.players / Math.max(1, def.teamSize))));
        m.map = id;
        if (sketch) m.sketch = sketch; else delete m.sketch;
        this.resize(m);
        return;
      }
      case 'options': {
        // { objective?, startRes?, style?, size?, public? }: the match rules; style and size shape a random world
        needHost('change the match options');
        if (msg.objective != null && !OBJECTIVES.includes(msg.objective)) throw new Error('Unknown victory condition');
        if (msg.startRes != null && !START_RESOURCES.includes(msg.startRes)) throw new Error('Unknown starting resources');
        if (msg.style != null && !STYLES.includes(msg.style)) throw new Error('Unknown world style');
        if (msg.size != null && msg.size !== 'auto' && !Object.hasOwn(ACTION_SIZES, msg.size)) throw new Error('Unknown map size');
        if (msg.objective != null) m.objective = msg.objective;
        if (msg.startRes != null) m.startRes = msg.startRes;
        if (msg.style != null) m.style = msg.style;
        if (msg.size != null) { m.sizeKey = msg.size === 'auto' ? null : msg.size; this.resize(m); }   // auto: follows the seat count
        if (msg.public != null) m.public = msg.public === true;
        return;
      }
      case 'closeSeat': {
        // { seat, closed }: an empty seat leaves the match (uneven teams) or opens again (any map: a catalog map leaves the spare starts neutral)
        needHost('close seats');
        const i = seatOf(msg.seat), s = m.slots[i];
        if (msg.closed === false) {
          if (!s.closed) return;
          delete s.closed; Object.assign(s, { human: true, name: 'Open seat', token: null, ws: null });
          return;
        }
        if (s.closed) return;
        if (s.human && s.token) throw new Error('A player sits there');
        const before = { ...s };
        for (const k of Object.keys(s)) delete s[k];
        Object.assign(s, { human: false, closed: true, name: 'Closed', token: null, ws: null });
        if (!this.playable(m.slots, ts)) { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, before); throw new Error('At least two sides must keep a seat'); }
        return;
      }
      default: throw new Error('Unknown message');
    }
  }

  // Closed seats leave the match when it starts; everyone keeps the team of the seat they sat in
  // (teams renumbered from 0), passed to the simulation as teamOf.
  dropClosed(m) {
    if (!m.slots.some((s) => s.closed)) return;
    const ts = Math.max(1, m.teamSize || 1);
    const kept = m.slots.map((s, i) => ({ s, team: Math.floor(i / ts) })).filter((e) => !e.s.closed);
    const order = [...new Set(kept.map((e) => e.team))];
    m.slots = kept.map((e) => e.s);
    m.teamOf = kept.map((e) => order.indexOf(e.team));
  }

  // A catalog map always gets explicit teams (seat / team size of the lobby's format): the simulation then
  // seats them on the map's starts (actionMap.assignStarts), as drawn when the format is the map's own.
  catalogTeams(m) {
    if (m.teamOf || !mapDefOf(m) || m.ruleset !== ACTION_RULESET) return;
    const ts = Math.max(1, m.teamSize || 1);
    m.teamOf = m.slots.map((_, i) => Math.floor(i / ts));
  }

  // at least two sides keep a seat that is not closed
  playable(slots, teamSize) {
    const ts = Math.max(1, teamSize || 1);
    return new Set(slots.map((s, i) => (s.closed ? -1 : Math.floor(i / ts))).filter((t) => t >= 0)).size >= 2;
  }

  // public lobbies for the in-game browser (/api/lobbies): only those the host listed
  lobbies() {
    return [...this.matches.values()].filter((m) => m.status === 'lobby' && m.public && m.mode === 'pvp').map((m) => {
      const ts = Math.max(1, m.teamSize || 1), teams = this.teamsOf(m);
      return { id: m.id, name: m.name, host: this.hostOf(m)?.name || '', format: formatName(ts, teams), map: m.map || 'random', mapName: mapDefOf(m)?.name || 'Random',
        mapSize: m.mapSize, seats: m.slots.filter((s) => !s.closed).length, players: m.slots.filter((s) => s.human && s.token).length,
        open: m.slots.filter((s) => s.human && !s.token).length, spectators: (m.watchers || []).length, objective: m.objective || 'domination', created: m.created };
    });
  }

  // Rebuild the seats for teams × teamSize: seated players first, then AIs, then open seats, each keeping
  // its team where there is room; new seats are open; what does not fit (open seats, then AIs) is dropped.
  relayout(m, teamSize, teams) {
    const n = teamSize * teams;
    if (n > MAX_CIVS || n < 2) throw new Error('Unsupported format');
    const oldTs = Math.max(1, m.teamSize || 1);
    const ranked = m.slots.map((s, i) => ({ s, team: Math.floor(i / oldTs), rank: s.human && s.token ? 0 : !s.human && !s.closed ? 1 : 2 }));
    const seated = ranked.filter((e) => e.rank === 0).length;
    if (seated > n) throw new Error(`${seated} players are seated; that format has ${n} seats`);
    const next = new Array(n).fill(null);
    const place = (e, team) => { for (let k = 0; k < teamSize; k++) { const i = team * teamSize + k; if (!next[i]) { next[i] = e.s; return true; } } return false; };
    for (const rank of [0, 1, 2]) {
      const group = ranked.filter((e) => e.rank === rank), later = [];
      for (const e of group) if (!(e.team < teams && place(e, e.team))) later.push(e);
      for (const e of later) for (let t = 0; t < teams; t++) if (place(e, t)) break;
    }
    for (let i = 0; i < n; i++) if (!next[i]) next[i] = { human: true, name: 'Open seat', token: null, ws: null };
    m.slots = next;
    m.teamSize = teamSize;
    this.resize(m);
  }

  // an authored map fixes the world size; a random one follows the host's size choice or the seat count
  resize(m) {
    const def = mapDefOf(m), n = m.slots.length;
    m.mapSize = def ? def.size : ACTION_SIZES[m.sizeKey] || (n <= 2 ? ACTION_SIZES.small : n <= 4 ? ACTION_SIZES.medium : ACTION_SIZES.large);
  }

  // Unity lobbies (waitForReady) start when every seat is taken and every player is ready; older
  // clients' lobbies start as soon as the last human seat is taken.
  autoStart(m) {
    if (m.status !== 'lobby') return;
    const humans = m.slots.filter((s) => s.human);
    if (!humans.every((s) => s.token)) return;
    if (m.waitForReady && (humans.length < 2 || !humans.every((s) => s.ready))) return;
    this.start(m);
  }

  requireClient(ctx, match) {
    if (match.ruleset === ACTION_RULESET && (!ctx.caps?.includes('action-rts') || !ctx.caps?.includes('ring-cities-v1'))) throw new Error('This match requires the updated Unity client with ring-city RTS support.');
  }

  bind(ws, m, slot) {
    slot.ws = ws; ws.ctx = { ...ws.ctx, match: m, slot };
    m.lastActive = Date.now();
    this.send(ws, { t: 'joined', match: m.id, token: slot.token, status: m.status, mode: m.mode, mapSize: m.mapSize, spectator: !!slot.spectator });
  }

  stopWorker(m) { if (m.worker) { const w = m.worker; m.worker = null; w.terminate(); } }

  cleanup() {
    const now = Date.now();
    for (const m of this.matches.values()) {
      const anyone = m.slots.some((s) => s.ws) || (m.watchers || []).some((w) => w.ws);
      const idle = !anyone && now - m.lastActive > IDLE_MS;
      const done = m.status === 'over' && now - (m.overAt || now) > 10 * 60 * 1000;
      // a match nobody has come back to for a week is retired (memory and saved file)
      if (m.status === 'parked' && !anyone && now - m.lastActive > PARKED_TTL_MS) {
        this.matches.delete(m.id); if (this.store) this.store.remove(m.id).catch(() => {});
        this.log.info?.(`match ${m.id} removed (parked for a week)`);
        this.telemetry?.lifecycle(m, 'abandoned', { end_reason: 'parked_expired' });
        continue;
      }
      if (idle && m.status === 'running') {
        // park idle matches: save and stop the worker; a player rejoining resumes them
        this.requestSave(m).then(() => { this.stopWorker(m); m.status = 'parked'; this.log.info?.(`match ${m.id} parked`); this.telemetry?.lifecycle(m, 'parked', { end_reason: 'idle' }); });
      } else if ((idle && m.status !== 'parked') || done) {
        this.stopWorker(m); this.matches.delete(m.id);
        if (this.store && done) this.store.remove(m.id).catch(() => {});
        this.log.info?.(`match ${m.id} removed (${done ? 'finished' : 'idle'})`);
        if (!done) this.telemetry?.lifecycle(m, 'abandoned', { end_reason: m.status === 'lobby' ? 'lobby_idle' : 'idle' });
      }
    }
  }

  requestSave(m, timeoutMs = 6000) {
    if (!m.worker) return Promise.resolve();
    return new Promise((resolve) => {
      (m.saveWaiters = m.saveWaiters || []).push(resolve);
      m.worker.postMessage({ t: 'save' });
      setTimeout(resolve, timeoutMs);
    });
  }

  // Resume every match that was running (or parked) when the previous server instance stopped.
  async restoreAll() {
    if (!this.store) return 0;
    const list = await this.store.list();
    let n = 0;
    for (const { id, updated } of list) {
      if (Date.now() - updated > 24 * 3600 * 1000) { this.store.remove(id).catch(() => {}); continue; }
      try {
        const buf = await this.store.load(id);
        const { meta, game } = JSON.parse(zlib.gunzipSync(buf).toString());
        if (game.over) continue;
        const m = { ...meta, wrap: meta.wrap === true, status: 'parked', lastActive: meta.lastActive || Date.now(), worker: null, stats: null, lastSnapshot: buf, slots: meta.slots.map((s) => ({ ...s, ws: null })), watchers: (meta.watchers || []).map((w) => ({ ...w, ws: null, spectator: true })) };
        this.matches.set(id, m); n++;
      } catch (e) { this.log.warn?.(`could not restore ${id}: ${e.message}`); }
    }
    this.log.info?.(`restored ${n} saved matches from ${this.store.kind}`);
    return n;
  }

  // parked matches wake up when a player comes back
  wake(m) { if (m.status === 'parked' && m.lastSnapshot) this.start(m, this.gameBuf(m.lastSnapshot)); }

  // load = sum over running matches of (average tick time / tick interval), in CPU cores
  load() {
    let cores = 0, heap = 0;
    for (const m of this.matches.values()) if (m.status === 'running' && m.stats) { cores += (m.stats.avg || 0) / 100; heap += m.stats.heapMb || 0; }
    return { cores: +cores.toFixed(2), capacity: effectiveCores(), heapMb: heap, freeMb: Math.round(os.freemem() / 1048576) };
  }
  admit(mapSize) {
    if (process.env.ADMIT_OFF === '1') return null;
    const l = this.load();
    if (l.cores > l.capacity * ADMIT_CPU) return 'The server is busy running other matches; try again in a minute.';
    if (l.freeMb < (WORKER_MB[mapSize] || 260) * 1.2) return 'The server is short of memory for another match right now; try a smaller map or try again shortly.';
    return null;
  }

  // per-match, per-system tick timings (p50 / p95 / p99 / max, budget overruns, deferrals)
  metrics() { return { load: this.load(), matches: [...this.matches.values()].filter((m) => m.stats).map((m) => ({ id: m.id, status: m.status, avg: m.stats.avg, max: m.stats.max, units: m.stats.units, heapMb: m.stats.heapMb, systems: m.stats.systems || {} })) }; }

  stats() {
    const ms = [...this.matches.values()];
    return { matches: ms.length, running: ms.filter((m) => m.status === 'running').length, parked: ms.filter((m) => m.status === 'parked').length,
      players: ms.reduce((s, m) => s + m.slots.filter((x) => x.ws).length, 0), spectators: ms.reduce((s, m) => s + (m.watchers || []).filter((x) => x.ws).length, 0), maxMatches: MAX_MATCHES, cpus: effectiveCores(),
      ticks: ms.filter((m) => m.stats).map((m) => ({ id: m.id, avg: m.stats.avg, max: m.stats.max, units: m.stats.units, heapMb: m.stats.heapMb, slowest: slowest(m.stats.systems) })), store: this.store?.kind || 'none', load: this.load(),
      memMB: Math.round(process.memoryUsage().rss / 1e6) };
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.janitor);
    await Promise.all([...this.matches.values()].filter((m) => m.worker && m.status === 'running').map((m) => this.requestSave(m, 7000)));
    for (const m of this.matches.values()) this.stopWorker(m);
  }
}
