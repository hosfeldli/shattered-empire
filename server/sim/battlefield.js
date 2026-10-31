// Battlefield aftermath that persists and matters: craters slow vehicles and give infantry cover,
// destroyed vehicles burn then remain as wrecks (obstacles and cover) until engineers clear them,
// and smoke from fires and shelling conceals what is inside it and spoils aim through it.
// Everything recovers with time: smoke clears, fires burn out, craters soften, wrecks rust away.
import { UNITS, T, isWater } from './constants.js';
import { disk } from './hex.js';

export function bfInit(g) { g.craters = new Map(); g.wrecks = new Map(); g.smoke = new Map(); g.bfVer = 0; }

export function addCrater(g, t, depth) {
  if (isWater(g.world.terr[t]) || g.world.terr[t] === T.PEAK) return;
  const c = g.craters.get(t) || { d: 0, at: 0 };
  c.d = Math.min(3, c.d + depth); c.at = g.time;
  g.craters.set(t, c); g.world.dirty.add(t); g.bfVer++;
}

export function addWreck(g, t, type, owner) {
  const def = UNITS[type];
  if (!def || def.civilian && def.move === 'infantry') return;
  if (def.move === 'infantry') return;
  const list = g.wrecks.get(t) || [];
  if (list.length >= 3) list.shift();
  list.push({ type, owner, burn: def.air ? 25 : 45, at: g.time });
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
  const wr = g.wrecks.get(t); if (wr) c = Math.max(c, 0.2 + 0.05 * wr.length);
  return Math.min(0.4, c);
}

// Extra movement cost: vehicles labour through craters and around wrecks; infantry barely notice.
export function scarCost(g, t, moveClass) {
  let c = 0;
  const cr = g.craters.get(t); if (cr) c += cr.d * (moveClass === 'wheeled' ? 0.6 : moveClass === 'tracked' ? 0.3 : moveClass === 'infantry' ? 0.12 : 0);
  const wr = g.wrecks.get(t); if (wr && moveClass !== 'aircraft') c += wr.length * (moveClass === 'infantry' ? 0.05 : 0.35);
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
  // craters soften over time (faster on roads, which crews patch)
  for (const [t, c] of g.craters) {
    const age = g.time - c.at;
    if (age > (g.world.road[t] ? 300 : 900)) { c.d -= 1; c.at = g.time; g.world.dirty.add(t); g.bfVer++; if (c.d <= 0) g.craters.delete(t); }
  }
}

// Engineers clear wrecks and fill craters next to them (called from their work loop).
export function engineerClear(g, u, dt) {
  const civ = g.civs[u.owner];
  for (const t of disk(u.tile, 1)) {
    const wr = g.wrecks.get(t);
    if (wr && wr.length && wr[0].burn <= 0) { wr[0].clear = (wr[0].clear || 0) + dt; if (wr[0].clear >= 8) { wr.shift(); if (!wr.length) g.wrecks.delete(t); g.world.dirty.add(t); g.bfVer++; } return true; }
    const cr = g.craters.get(t);
    if (cr && civ.res.materials >= 1 * dt && (g.world.owner[t] === u.owner || g.world.road[t])) { cr.fill = (cr.fill || 0) + dt; civ.res.materials -= dt; if (cr.fill >= 5) { cr.d -= 1; cr.fill = 0; if (cr.d <= 0) g.craters.delete(t); g.world.dirty.add(t); g.bfVer++; } return true; }
  }
  return false;
}

// Smoke conceals: a hex inside dense smoke is only seen by someone right next to it.
export function concealBySmoke(g, civ, vis, allies) {
  for (const [t, s] of g.smoke) {
    if (s.d < 0.6 || !vis[t]) continue;
    let near = false;
    for (const n of disk(t, 1)) {
      const ids = g.tileUnits.get(n);
      if (ids) for (const id of ids) { const u = g.units.get(id); if (u && allies.includes(u.owner)) { near = true; break; } }
      if (near) break;
      const b = g.buildingAtTile(n); if (b && allies.includes(b.owner)) { near = true; break; }
    }
    if (!near) vis[t] = 0;
  }
}

export function battlefieldSnapshot(g, vis, explored) {
  const c = [], w = [], s = [];
  for (const [t, cr] of g.craters) if (vis[t] || explored[t]) c.push([t, cr.d]);
  for (const [t, list] of g.wrecks) if (vis[t] || explored[t]) for (const wr of list) w.push([t, wr.type, wr.burn > 0 ? 1 : 0, wr.owner]);
  for (const [t, sm] of g.smoke) if (vis[t] || sm.d >= 0.6) s.push([t, Math.round(sm.d * 10)]);
  return { c, w, s };
}

export function serializeBattlefield(g) {
  return { craters: [...g.craters.entries()], wrecks: [...g.wrecks.entries()], smoke: [...g.smoke.entries()] };
}
export function restoreBattlefield(g, d) {
  bfInit(g);
  if (!d) return;
  g.craters = new Map(d.craters); g.wrecks = new Map(d.wrecks); g.smoke = new Map(d.smoke);
}
