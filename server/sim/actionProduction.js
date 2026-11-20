// Production scheduler (gameplay overhaul W1, rules R1/R2; docs/gameplay-overhaul/PRODUCTION_SCHEDULER.md).
//
// Every producing building has ONE production-capacity budget, in work units per simulation second
// (productionCapacity). Its independent per-unit-type queues share that budget:
//   - b.queues: ordered list of { unit, count, priority (0 low / 1 normal / 2 high), work, paid, reserved,
//     ready, paused, repeat, state }. `count` includes the item in progress; `work` is the progress on it
//     (0 .. ACTION_UNITS[unit].time work units); `paid` is what that item has consumed so far.
//   - runProduction (inside actionBases.productionStep, every 3 ticks) hands the budget out by priority tier,
//     in equal shares within a tier, and re-shares whatever a blocked or saturated queue cannot use. Summed work
//     per interval never exceeds capacity × dt; more queues never mean more throughput.
//   - Cost is consumed in proportion to work (cost × work / total, settled exactly at completion). A queue the
//     stockpile cannot fund advances only as far as it can pay and shows 'resources'.
//   - An item starts only when its command capacity can be reserved (q.reserved, counted by armyCapacity);
//     a finished item waiting for its exit keeps its reservation and is never charged twice.
//   - Cancelling, clearing or losing the building never refunds what was consumed; nothing else was charged.
import { ACTION_BUILDINGS, ACTION_RESOURCES, ACTION_UNITS, PRODUCTION } from './actionDefinitions.js';
import { HASTE } from './actionUpgrades.js';

const EPS = 1e-9;
/** Queue states, as sent on the wire (qs[i][4]). 'waiting': eligible, but a higher priority used the whole budget. */
export const QUEUE_STATES = ['producing', 'resources', 'capacity', 'prerequisites', 'exit', 'paused', 'idle', 'waiting'];

/** Work units per simulation second: def.production × site bonus (12% faster) × era level (-15% time per level). */
export function productionCapacity(game, b) {
  const def = ACTION_BUILDINGS[b.type];
  if (!def?.trains || !b.done) return 0;
  const site = game.siteById.get(b.site);
  const bonus = !!site && (site.kind === 'industrial' && b.type === 'motor_works' || site.kind === 'military' && b.type === 'barracks' ||
    site.kind === 'coastal' && b.type === 'airfield');
  return (def.production ?? 1) / ((bonus ? .88 : 1) * (1 - .15 * ((b.level || 1) - 1)));
}

const zero = () => { const o = {}; for (const k of ACTION_RESOURCES) o[k] = 0; return o; };
const newQueue = (unit, priority = 1) => ({ unit, count: 0, priority, work: 0, paid: zero(), reserved: 0, ready: false, paused: false, repeat: false, state: 'idle' });

/**
 * The building's queues, migrating a pre-overhaul `queue` array (one FIFO of { unit, left, total }, each item paid
 * in full up front) on first access: items group by unit type in first-seen order; the first item of each type keeps
 * its progress and its full payment (it holds its reservation); later items were prepaid but not started, so their
 * cost is returned to the owner (they will now be paid progressively).
 */
export function productionQueues(b, game) {
  if (b.queues) return b.queues;
  b.queues = [];
  if (Array.isArray(b.queue)) {
    const civ = game?.civs?.[b.owner];
    for (const item of b.queue) {
      const def = ACTION_UNITS[item.unit];
      if (!def) continue;
      let q = b.queues.find((x) => x.unit === item.unit);
      if (!q) {
        q = newQueue(item.unit);
        b.queues.push(q);
        q.work = Math.max(0, Math.min(def.time, def.time * (1 - (item.left || 0) / (item.total || def.time))));
        for (const k of ACTION_RESOURCES) q.paid[k] = def.cost[k] || 0;
        q.reserved = def.capacity;
        q.ready = q.work >= def.time;
        q.state = 'producing';
      } else if (civ) for (const k of ACTION_RESOURCES) civ.res[k] += def.cost[k] || 0;
      q.count++;
    }
    if (b.repeat) for (const q of b.queues) q.repeat = q.unit === b.repeat;
  }
  delete b.queue;
  return b.queues;
}

/** Migrates every building of a restored save (persist.restoreGame). Idempotent. */
export function migrateProduction(game) {
  for (const b of game.buildings.values()) productionQueues(b, game);
}

export const queuedCount = (b) => { let n = 0; for (const q of b.queues || []) n += q.count; return n; };
const started = (q) => q.ready || q.work > 0 || q.reserved > 0;

/** Seconds of queued work left at the building's current capacity (for spreading batch orders). */
function backlog(game, b) {
  let work = 0;
  for (const q of productionQueues(b, game)) work += q.count * ACTION_UNITS[q.unit].time - q.work;
  return work / Math.max(EPS, productionCapacity(game, b));
}

export function armyCapacity(game, civ) {
  let used = 0, reserved = 0, pending = 0;
  for (const u of game.units.values()) if (u.owner === civ.id && !u.auto) used += ACTION_UNITS[u.type].capacity;   // base engineers are free
  for (const b of game.buildings.values()) {
    if (b.owner !== civ.id || !b.done) continue;
    for (const q of productionQueues(b, game)) {
      reserved += q.reserved;
      pending += (q.count - (q.reserved ? 1 : 0)) * ACTION_UNITS[q.unit].capacity;
    }
  }
  // Era capacities sized for large combined-arms battles.
  const limit = [140, 220, 300][Math.max(0, Math.min(2, civ.age))];
  // queued: everything in the pipeline (reserved + not yet started), for the HUD; only `reserved` is held.
  return { used, queued: reserved + pending, reserved, pending, limit: Math.min(game.armyLimit, limit) };
}

const validPriority = (p) => Number.isInteger(p) && p >= 0 && p <= 2;

/**
 * Command train / batchTrain: add `count` of `type` to the type's queue at each building (perBuilding) or spread
 * over the buildings by earliest finish. Never refused for resources or command capacity: those only hold the
 * queue (states 'resources' / 'capacity'). Each building holds at most PRODUCTION.maxQueued items.
 */
export function train(game, civ, ids, type, count, perBuilding = false, priority) {
  const def = Object.hasOwn(ACTION_UNITS, type) ? ACTION_UNITS[type] : null;
  if (!def || def.auto || !Array.isArray(ids) || !Number.isInteger(count) || count < 1 || count > 40) return { error: 'Choose a unit and training quantity.' };
  if (priority != null && !validPriority(priority)) return { error: 'Choose a priority: 0 low, 1 normal or 2 high.' };
  const buildings = [...new Set(ids.slice(0, 40))].map((id) => game.buildings.get(id)).filter((b) =>
    b?.owner === civ.id && b.done && b.type === def.facility && civ.age + 1 >= def.tier);
  if (!buildings.length) return { error: 'Select an operational facility at the required tier.' };
  const max = PRODUCTION.maxQueued, ready = new Map(buildings.map((b) => [b.id, backlog(game, b)]));
  let queued = 0, reason = '';
  for (let i = 0; i < (perBuilding ? count * buildings.length : count); i++) {
    const b = perBuilding ? buildings[i % buildings.length] :
      buildings.filter((b) => queuedCount(b) < max).sort((a, b) => ready.get(a.id) - ready.get(b.id) || a.id - b.id)[0];
    if (!b || queuedCount(b) >= max) { reason = 'Production queue full.'; if (perBuilding) continue; break; }
    const qs = productionQueues(b, game);
    let q = qs.find((x) => x.unit === type);
    if (!q) qs.push(q = newQueue(type, priority ?? 1));
    else if (priority != null) q.priority = priority;
    q.count++;
    if (q.state === 'idle') q.state = 'waiting';
    ready.set(b.id, ready.get(b.id) + def.time / Math.max(EPS, productionCapacity(game, b)));
    queued++;
  }
  if (!queued) return { error: reason || 'Nothing was queued.' };
  // advisory only: the queue waits for these instead of refusing
  const cap = armyCapacity(game, civ), short = [];
  if (!ACTION_RESOURCES.every((k) => civ.res[k] > 0 || !(def.cost[k] > 0))) short.push('resources');
  if (cap.limit - cap.used - cap.reserved < def.capacity) short.push('capacity');
  return { reply: { t: 'ack', training: { queued, reason, ...(short.length && { waiting: short }) } } };
}

/** Abandons the item in progress: what it consumed is lost (never refunded); its reservation is released. */
function abandon(q, lost) {
  for (const k of ACTION_RESOURCES) { lost[k] += q.paid[k]; q.paid[k] = 0; }
  q.work = 0; q.reserved = 0; q.ready = false;
}

function removeEmpty(b) {
  const qs = b.queues;
  let n = 0;
  for (const q of qs) if (q.count > 0) qs[n++] = q; else if (b.repeat === q.unit) b.repeat = null;
  qs.length = n;
}

/**
 * Command cancelTrain { id, type, count | all }: removes not-yet-started items first (never charged), then the
 * item in progress (its consumed resources are lost). Replies with the count cancelled and what was lost.
 */
export function cancelProduction(game, civ, id, type, count = 1) {
  const b = game.buildings.get(id);
  const q = b?.owner === civ.id ? productionQueues(b, game).find((x) => x.unit === type) : null;
  if (!q) return { error: 'That unit is not queued at this facility.' };
  let n = count === 'all' ? q.count : count;
  if (!Number.isInteger(n) || n < 1) return { error: 'Choose how many to cancel.' };
  n = Math.min(n, q.count);
  const lost = zero(), idle = q.count - (started(q) ? 1 : 0), take = Math.min(n, idle);
  q.count -= take;
  if (n > take) { abandon(q, lost); q.count--; }
  if (q.count <= 0) removeEmpty(b);
  return { reply: { t: 'ack', cancelled: { count: n, lost } } };
}

/** Legacy cancelTrain { id, index }: the index into the flattened legacy `q` list picks the unit type; one is cancelled. */
export function cancelTraining(game, civ, id, index) {
  const b = game.buildings.get(id);
  if (b?.owner !== civ.id || !Number.isInteger(index) || index < 0) return { error: 'That queue entry is no longer available.' };
  for (const q of productionQueues(b, game)) {
    if (index < q.count) return cancelProduction(game, civ, id, q.unit, 1);
    index -= q.count;
  }
  return { error: 'That queue entry is no longer available.' };
}

/** Drops every queue of a building (clearQueue, or a building lost / captured): consumed resources are lost. */
export function dropProduction(b) {
  const lost = zero();
  for (const q of b.queues || []) abandon(q, lost);
  if (b.queues) b.queues.length = 0;
  b.repeat = null;
  return lost;
}

export function clearQueue(game, civ, id) {
  const b = game.buildings.get(id);
  if (b?.owner !== civ.id || !b.done) return { error: 'Select one of your production facilities.' };
  productionQueues(b, game);
  return { reply: { t: 'ack', cancelled: { lost: dropProduction(b) } } };
}

function findQueue(game, civ, id, type) {
  const b = game.buildings.get(id);
  return b?.owner === civ.id ? productionQueues(b, game).find((x) => x.unit === type) : null;
}

/** Command setPriority { id, type, priority }: 0 low, 1 normal, 2 high. */
export function setPriority(game, civ, id, type, priority) {
  if (!validPriority(priority)) return { error: 'Choose a priority: 0 low, 1 normal or 2 high.' };
  const q = findQueue(game, civ, id, type);
  if (!q) return { error: 'That unit is not queued at this facility.' };
  q.priority = priority;
  return {};
}

/** Command pauseTrain { id, type, on }: a paused queue gets no capacity; an unstarted item gives its reservation back. */
export function pauseProduction(game, civ, id, type, on) {
  const q = findQueue(game, civ, id, type);
  if (!q) return { error: 'That unit is not queued at this facility.' };
  q.paused = !!on;
  if (q.paused && !q.ready && q.work === 0) q.reserved = 0;
  return {};
}

/** Command repeat { id, unit|null }: that type's queue keeps one item queued forever (created when missing). */
export function setRepeat(game, civ, id, unit) {
  const b = game.buildings.get(id), def = unit != null ? ACTION_UNITS[unit] : null;
  if (b?.owner !== civ.id || !b.done || unit != null && (!def || def.auto || def.facility !== b.type))
    return { error: 'Select a valid production facility and unit.' };
  const qs = productionQueues(b, game);
  b.repeat = unit || null;
  for (const q of qs) q.repeat = q.unit === b.repeat;
  if (b.repeat && !qs.some((q) => q.unit === b.repeat)) {
    if (queuedCount(b) >= PRODUCTION.maxQueued) return { error: 'Production queue full.' };
    const q = newQueue(b.repeat); q.count = 1; q.repeat = true; q.state = 'waiting'; qs.push(q);
  }
  return {};
}

// ---- scheduler -------------------------------------------------------------------------------------------

// Command capacity still free per civ during one productionStep, computed on first need and decremented as
// reservations are made, so two buildings can never claim the same capacity. Cleared by beginProduction.
const freeCapacity = new Map();
const active = [];   // scratch list of a tier's eligible queues (no per-step allocation)
let delivered = false;   // set by advance when the item it finished left the building
export function beginProduction() { freeCapacity.clear(); }

function reserve(game, civ, need) {
  let free = freeCapacity.get(civ.id);
  if (free === undefined) { const c = armyCapacity(game, civ); free = c.limit - c.used - c.reserved; }
  if (free < need) { freeCapacity.set(civ.id, free); return false; }
  freeCapacity.set(civ.id, free - need);
  return true;
}

/** Hands a finished item to the battlefield. False (exit blocked) keeps it, paid and reserved, for a retry. */
function deliver(game, civ, b, q) {
  const u = game.spawn(civ, q.unit, b, 1.2, true);   // at the facility's door (actionGame.spawn)
  if (!u) { q.state = 'exit'; b.state = 'exit blocked'; return false; }
  b.state = 'operational';
  q.ready = false; q.work = 0; q.reserved = 0;
  for (const k of ACTION_RESOURCES) q.paid[k] = 0;
  if (!(q.repeat && q.count === 1)) q.count--;
  q.state = q.count > 0 ? 'waiting' : 'idle';
  game.reinforce(b, u);
  game.emerge(b, u);
  if (civ.techs.has('improved_logistics') && u.goal) u.hasteUntil = game.time + HASTE.seconds;
  return true;
}

/** Classifies a queue: true when it may receive capacity this interval (state 'waiting' until it does). */
function eligible(civ, b, q) {
  const def = ACTION_UNITS[q.unit];
  let blocked = q.count <= 0 ? 'idle' : q.ready ? 'exit' : q.paused ? 'paused' :
    !def || def.facility !== b.type || civ.age + 1 < def.tier ? 'prerequisites' : null;
  if (!blocked) { q.state = 'waiting'; return true; }
  if (blocked !== 'exit' && q.work === 0) q.reserved = 0;   // an unstarted item holds no capacity while blocked
  q.state = blocked;
  return false;
}

/** Advances one queue by up to `share` work units; returns the work done (paid for in proportion). */
function advance(game, civ, b, q, share) {
  if (q.ready || q.count <= 0) return 0;
  const def = ACTION_UNITS[q.unit], total = def.time, cost = def.cost;
  // the work the stockpile can still fund (what this item already paid counts towards it)
  let w = Math.min(share, total - q.work);
  const want = w;
  for (const k of ACTION_RESOURCES) {
    const c = cost[k] || 0;
    if (c > 0) w = Math.min(w, total * Math.min(1, (q.paid[k] + Math.max(0, civ.res[k])) / c) - q.work);
  }
  if (w <= EPS) { q.state = 'resources'; return 0; }
  if (!q.reserved) {
    if (!reserve(game, civ, def.capacity)) { q.state = 'capacity'; return 0; }
    q.reserved = def.capacity;
  }
  q.work += w;
  const done = q.work >= total - 1e-7;
  if (done) q.work = total;
  for (const k of ACTION_RESOURCES) {
    const c = cost[k] || 0, target = done ? c : c * q.work / total, charge = target - q.paid[k];
    if (charge > 0) { civ.res[k] -= charge; q.paid[k] = target; if (civ.res[k] < 0) civ.res[k] = 0; }   // float dust only
  }
  q.state = w < want - EPS ? 'resources' : 'producing';
  if (done) { q.ready = true; delivered = deliver(game, civ, b, q); if (delivered && q.count > 0) q.state = 'producing'; }
  return w;
}

/**
 * One scheduler interval for a producing building: retries blocked exits, then shares capacity × dt over the
 * eligible queues by priority tier (2, 1, 0), equal shares within a tier, re-sharing what a queue cannot use.
 * O(queues²) in the worst case with at most one queue per trainable unit type; no allocation. Returns the work done.
 */
export function runProduction(game, civ, b, dt) {
  const qs = b.queues || productionQueues(b, game);
  if (!qs.length) return 0;
  for (const q of qs) if (q.ready && q.count > 0) deliver(game, civ, b, q);
  let budget = productionCapacity(game, b) * dt, spent = 0;
  for (let tier = 2; tier >= 0; tier--) {
    active.length = 0;
    for (const q of qs) if (q.priority === tier && eligible(civ, b, q)) active.push(q);
    // rounds: a queue that took less than its share (blocked, short of resources) drops out and the rest re-share
    // the remainder; one that finished an item stays in and starts its next item with what is left
    for (let round = 0; round < 64 && budget > EPS && active.length; round++) {
      const share = budget / active.length;
      let kept = 0;
      for (let i = 0; i < active.length; i++) {
        const q = active[i];
        delivered = false;
        const w = advance(game, civ, b, q, share);
        budget -= w; spent += w;
        if ((w >= share - EPS || delivered) && !q.ready && q.count > 0) active[kept++] = q;
      }
      active.length = kept;
    }
  }
  active.length = 0;
  if (qs.some((q) => q.count <= 0)) removeEmpty(b);
  return spent;
}

/**
 * Wire fields of a producing building (econSnapshot, own buildings only):
 *   qs:  [[unit, count, priority, progressPct, state, repeat 0|1], ...] in queue order
 *   cap: production capacity, work units per second
 *   q / tr: the legacy flattened list [[unit, secondsLeft], ...] and the first queue's progress %, for older clients
 */
export function productionWire(game, b) {
  const qs = productionQueues(b, game), cap = productionCapacity(game, b), rate = Math.max(EPS, cap);
  const r1 = (n) => Math.round(n * 10) / 10;
  const legacy = [];
  for (const q of qs) {
    const time = ACTION_UNITS[q.unit].time;
    for (let i = 0; i < q.count; i++) legacy.push([q.unit, Math.ceil((i ? time : time - q.work) / rate)]);
  }
  const first = qs[0];
  return {
    q: legacy, tr: first ? r1(first.work / ACTION_UNITS[first.unit].time * 100) : 0,
    qs: qs.map((q) => [q.unit, q.count, q.priority, r1(q.work / ACTION_UNITS[q.unit].time * 100), q.state, q.repeat ? 1 : 0]),
    cap: Math.round(cap * 1000) / 1000,
  };
}

/** Resources a civ's queued items will still consume ({ materials, energy }): count × cost − what is already paid. */
export function productionCommitment(game, civ) {
  const owed = zero();
  for (const b of game.buildings.values()) {
    if (b.owner !== civ.id || !b.queues?.length) continue;
    for (const q of b.queues) {
      const cost = ACTION_UNITS[q.unit].cost;
      for (const k of ACTION_RESOURCES) owed[k] += q.count * (cost[k] || 0) - q.paid[k];
    }
  }
  return owed;
}
