// Battlefield aftermath that persists and matters: craters slow vehicles and give infantry cover,
// destroyed vehicles burn then remain as wrecks (obstacles and cover) until engineers clear them,
// and smoke from fires and shelling conceals what is inside it and spoils aim through it.
// Everything recovers with time: smoke clears, fires burn out, craters soften, wrecks rust away.
import { book } from './ledger.js';
import { UNITS, T, isWater } from './constants.js';
import { disk } from './hex.js';

export function bfInit(g) { g.craters = new Map(); g.wrecks = new Map(); g.smoke = new Map(); g.intensity = new Map(); g.fieldPos = new Map(); g.bfVer = 0; }

// ---------------------------------------------------------------- battlefield intensity
// Every shell, wreck and death adds intensity to the ground around it. Sustained fighting turns
// farmland into churned ground (stage 1), then cratered no man's land (2), then a devastated waste
// of wire and debris (3). It is slow to build, slower to heal, and matters: vehicles bog down,
// infantry find shell holes to hide in. Recovery is gradual once the fighting moves on.
export const INTENSITY_STAGES = [15, 40, 75];
export const intensityStage = (v) => (v >= INTENSITY_STAGES[2] ? 3 : v >= INTENSITY_STAGES[1] ? 2 : v >= INTENSITY_STAGES[0] ? 1 : 0);
export function addIntensity(g, t, v) {
  if (t < 0 || isWater(g.world.terr[t])) return;
  for (const n of disk(t, 1)) {
    if (isWater(g.world.terr[n])) continue;
    const add = n === t ? v : v * 0.35;
    const e = g.intensity.get(n) || { v: 0, at: 0, st: 0 };
    e.v = Math.min(100, e.v + add); e.at = g.time;
    const st = intensityStage(e.v); if (st !== e.st) { e.st = st; g.world.dirty.add(n); g.bfVer++; }
    g.intensity.set(n, e);
  }
}
export const intensityAt = (g, t) => g.intensity.get(t)?.v || 0;

// Temporary field positions: infantry holding ground under fire scrape out foxholes. A light, capped
// substitute for trenches: no construction, a little cover, gone soon after they are abandoned.
export const FIELD_POS = { perCiv: 24, total: 120, cover: 0.12, after: 15, abandon: 90 };

export function addCrater(g, t, depth) {
  if (isWater(g.world.terr[t]) || g.world.terr[t] === T.PEAK) return;
  const c = g.craters.get(t) || { d: 0, at: 0 };
  c.d = Math.min(3, c.d + depth); c.at = g.time;
  addIntensity(g, t, 2.5 * depth);
  g.craters.set(t, c); g.world.dirty.add(t); g.bfVer++;
}

export function addWreck(g, t, type, owner) {
  const def = UNITS[type];
  if (!def || def.civilian && def.move === 'infantry') return;
  if (def.move === 'infantry') return;
  const list = g.wrecks.get(t) || [];
  if (list.length >= 3) list.shift();
  list.push({ type, owner, burn: def.air ? 25 : 45, at: g.time });
  addIntensity(g, t, 4);
  g.wrecks.set(t, list); g.world.dirty.add(t); g.bfVer++;
  addSmoke(g, t, 0.55, 30);
}

export function addSmoke(g, t, density, seconds) {
  const s = g.smoke.get(t);
  if (s) { s.d = Math.min(1, Math.max(s.d, density) + density * 0.2); s.until = Math.max(s.until, g.time + seconds); }
  else { g.smoke.set(t, { d: Math.min(1, density), until: g.time + seconds }); g.bfVer++; }
}

export const smokeAt = (g, t) => { const s = g.smoke.get(t); return s ? s.d : 0; };

// Cover from craters and wrecks on a hex (rubble from ruins is handled with buildings).
export function scarCover(g, t) {
  let c = 0;
  const cr = g.craters.get(t); if (cr) c = 0.15 + 0.08 * cr.d;
  const st = g.intensity.get(t)?.st || 0; if (st >= 2) c = Math.max(c, 0.1 + 0.05 * st);   // shell holes everywhere
  const wr = g.wrecks.get(t); if (wr) c = Math.max(c, 0.2 + 0.05 * wr.length);
  return Math.min(0.4, c);
}

// Extra movement cost: vehicles labour through craters and around wrecks; infantry barely notice.
export function scarCost(g, t, moveClass) {
  let c = 0;
  const cr = g.craters.get(t); if (cr) c += cr.d * (moveClass === 'wheeled' ? 0.6 : moveClass === 'tracked' ? 0.3 : moveClass === 'infantry' ? 0.12 : 0);
  const wr = g.wrecks.get(t); if (wr && moveClass !== 'aircraft') c += wr.length * (moveClass === 'infantry' ? 0.05 : 0.35);
  // no man's land: mud and shell holes bog vehicles down; wire slows everyone at the worst
  const st = g.intensity.get(t)?.st || 0;
  if (st >= 2 && moveClass !== 'aircraft') c += moveClass === 'wheeled' ? 0.25 * (st - 1) : moveClass === 'tracked' ? 0.12 * (st - 1) : st >= 3 ? 0.15 : 0;
  return c;
}

export function battlefieldStep(g, dt) {
  // smoke: burning wrecks and buildings keep it coming; otherwise it thins and clears
  for (const [t, list] of g.wrecks) {
    for (const wr of list) if (wr.burn > 0) { wr.burn -= dt; addSmoke(g, t, 0.6, 6); if (wr.burn <= 0) g.bfVer++; }
    if (list.length && g.time - list[0].at > 1500) { list.shift(); g.world.dirty.add(t); g.bfVer++; }
    if (!list.length) { g.wrecks.delete(t); g.bfVer++; }
  }
  for (const b of g.buildings.values()) if (b.fire > 0) addSmoke(g, b.tile, 0.7, 6);
  for (const [t, s] of g.smoke) {
    if (g.time >= s.until) { s.d -= 0.12 * dt; if (s.d <= 0.05) { g.smoke.delete(t); g.bfVer++; } }
  }
  // intensity recovers once the fighting has moved on: slowly, and slower the worse it got
  {
    const step = dt;                      // called once a second
    for (const [t, e] of g.intensity) {
      if (g.time - e.at < 60) continue;
      e.v -= step * (e.v > 40 ? 0.025 : 0.05) * (g.world.owner[t] >= 0 ? 1.3 : 1);
      if (e.v <= 0.5) { g.intensity.delete(t); if (e.st) { g.world.dirty.add(t); g.bfVer++; } continue; }
      const st = intensityStage(e.v); if (st !== e.st) { e.st = st; g.world.dirty.add(t); g.bfVer++; }
    }
    fieldPositionsStep(g, step);
  }
  // craters soften over time (faster on roads, which crews patch)
  for (const [t, c] of g.craters) {
    const age = g.time - c.at;
    if (age > (g.world.road[t] ? 300 : 900)) { c.d -= 1; c.at = g.time; g.world.dirty.add(t); g.bfVer++; if (c.d <= 0) g.craters.delete(t); }
  }
}

function fieldPositionsStep(g, dt) {
  const perCiv = new Map(); for (const f of g.fieldPos.values()) perCiv.set(f.o, (perCiv.get(f.o) || 0) + 1);
  // occupied ones stay; abandoned ones collapse; an enemy on the hex takes it over (or fills it in)
  for (const [t, f] of g.fieldPos) {
    const ids = g.tileUnits.get(t) || [];
    const occ = ids.map((id) => g.units.get(id)).filter((u) => u && UNITS[u.type].move === 'infantry' && !UNITS[u.type].civilian);
    if (occ.some((u) => u.owner === f.o)) f.last = g.time;
    else if (occ.length) { g.fieldPos.delete(t); g.bfVer++; continue; }
    if (g.time - f.last > FIELD_POS.abandon || g.fieldworks?.has(t)) { g.fieldPos.delete(t); g.bfVer++; }
  }
  if (g.fieldPos.size >= FIELD_POS.total) return;
  for (const u of g.units.values()) {
    const d = UNITS[u.type];
    if (d.move !== 'infantry' || d.civilian || d.engineer) continue;
    const still = !u.path.length && !u.field && u.next < 0;
    if (!still) { u.stillSince = g.time; continue; }
    if (u.stillSince == null) u.stillSince = g.time;
    const t = u.tile;
    if (g.fieldPos.has(t) || g.fieldworks?.has(t) || g.tileB[t] >= 0 || g.urban?.[t] || isWater(g.world.terr[t])) continue;
    const pressed = g.time - (u.lastCombat ?? -99) < 12 || (g.intensity.get(t)?.st || 0) >= 1 || (u.supp || 0) > 20;
    if (!pressed || g.time - u.stillSince < FIELD_POS.after) continue;
    if ((perCiv.get(u.owner) || 0) >= FIELD_POS.perCiv) continue;
    g.fieldPos.set(t, { o: u.owner, at: g.time, last: g.time });
    perCiv.set(u.owner, (perCiv.get(u.owner) || 0) + 1); g.bfVer++;
    if (g.fieldPos.size >= FIELD_POS.total) break;
  }
  void dt;
}
export function fieldPosCover(g, u) {
  const f = g.fieldPos?.get(u.tile);
  return f && f.o === u.owner && UNITS[u.type].move === 'infantry' ? FIELD_POS.cover : 0;
}

// Engineers clear wrecks and fill craters next to them (called from their work loop).
export function engineerClear(g, u, dt) {
  const civ = g.civs[u.owner];
  for (const t of disk(u.tile, 1)) {
    const wr = g.wrecks.get(t);
    if (wr && wr.length && wr[0].burn <= 0) { wr[0].clear = (wr[0].clear || 0) + dt; if (wr[0].clear >= 8) { wr.shift(); if (!wr.length) g.wrecks.delete(t); g.world.dirty.add(t); g.bfVer++; } return true; }
    const cr = g.craters.get(t);
    if (cr && civ.res.materials >= 1 * dt && (g.world.owner[t] === u.owner || g.world.road[t])) { cr.fill = (cr.fill || 0) + dt; civ.res.materials -= dt; book(civ, 'maintenance', 'materials', -dt); if (cr.fill >= 5) { cr.d -= 1; cr.fill = 0; if (cr.d <= 0) g.craters.delete(t); g.world.dirty.add(t); g.bfVer++; } return true; }
  }
  return false;
}

// Smoke conceals: a hex inside dense smoke is only seen by someone right next to it. In our own (or
// an ally's) territory the land itself stays in view — a nation never loses sight of its own ground,
// which otherwise showed as our colour under fog after a battle — but what stands in the smoke is
// hidden (civ.smokeHide; see Game.detects).
export function concealBySmoke(g, civ, vis, allies) {
  const hide = civ.smokeHide || (civ.smokeHide = new Uint8Array(vis.length)); hide.fill(0);
  for (const [t, s] of g.smoke) {
    if (s.d < 0.6 || !vis[t]) continue;
    let near = false;
    for (const n of disk(t, 1)) {
      const ids = g.tileUnits.get(n);
      if (ids) for (const id of ids) { const u = g.units.get(id); if (u && allies.includes(u.owner)) { near = true; break; } }
      if (near) break;
      const b = g.buildingAtTile(n); if (b && allies.includes(b.owner)) { near = true; break; }
    }
    if (near) continue;
    if (allies.includes(g.world.owner[t])) hide[t] = 1; else vis[t] = 0;
  }
}

export function battlefieldSnapshot(g, vis, explored) {
  const c = [], w = [], s = [];
  for (const [t, cr] of g.craters) if (vis[t] || explored[t]) c.push([t, cr.d]);
  for (const [t, list] of g.wrecks) if (vis[t] || explored[t]) for (const wr of list) w.push([t, wr.type, wr.burn > 0 ? 1 : 0, wr.owner]);
  // smoke is seen where we can see; a dense screen also at the edge of what we see (it hides what is in it)
  for (const [t, sm] of g.smoke) if (vis[t] || (sm.d >= 0.6 && disk(t, 1).some((n) => vis[n]))) s.push([t, Math.round(sm.d * 10)]);
  const i = [], fp = [];
  for (const [t, e] of g.intensity) if (e.st && (vis[t] || explored[t])) i.push([t, e.st]);
  for (const [t, f] of g.fieldPos) if (vis[t]) fp.push([t, f.o]);
  return { c, w, s, i, fp };
}

export function serializeBattlefield(g) {
  return { craters: [...g.craters.entries()], wrecks: [...g.wrecks.entries()], smoke: [...g.smoke.entries()], intensity: [...g.intensity.entries()], fieldPos: [...g.fieldPos.entries()] };
}
export function restoreBattlefield(g, d) {
  bfInit(g);
  if (!d) return;
  g.craters = new Map(d.craters); g.wrecks = new Map(d.wrecks); g.smoke = new Map(d.smoke);
  g.intensity = new Map(d.intensity || []); g.fieldPos = new Map(d.fieldPos || []);
}
