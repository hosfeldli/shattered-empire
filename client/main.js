// Shattered Empires client bootstrap: lobby, state sync, actions and input. No game rules live
// here: every decision (paths, placements, road routes, costs, combat) is made on the server.
import { Net } from './net.js';
import { View } from './view.js';
import { Hud } from './hud.js';

const $ = (id) => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } } };

const S = {
  ready: false, defs: null, civId: -1, civInfo: [], W: 128, H: 128, lens: 'terrain', mode: null, hover: -1, formation: 'line', lod: 'city', night: 0,
  selUnits: new Set(), selBuilding: null, units: new Map(), paths: {}, buildings: new Map(), cities: new Map(), ruins: new Map(), traffic: [], trafficTile: new Map(),
  cityAt: new Map(), buildingAtTile: new Map(), buildingTiles: new Set(), buildingsVersion: 0, ruinsVersion: 0, econ: null, log: [], time: 0, lightsList: [],
  civColor(id) { return (this.civInfo[id] && this.civInfo[id].color) ?? 0x888888; },
};
let view = null, hud = null, net = null;

// ------------------------------------------------------------------ lobby
function showScreen(id) { for (const s of ['lobby', 'room', 'game']) $(s).hidden = s !== id; }
function lobbyStatus(t) { $('lobbyStatus').textContent = t || ''; }
function playerName() { const n = $('playerName').value.trim() || 'Founder'; store.set('se.name', n); return n; }
$('playerName').value = store.get('se.name') || '';

function lobbyArt() {
  const c = $('lobbyCanvas'); const img = new Image();
  img.onload = () => { c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); c.style.objectFit = 'cover'; };
  img.src = '/api/preview?seed=' + ((Math.random() * 1e6) | 0);
}
async function refreshMatches() {
  try {
    const list = await (await fetch('/api/matches')).json();
    const open = list.filter((m) => m.status === 'lobby' && m.slots.some((s) => s.human && !s.taken));
    $('matchList').innerHTML = open.length ? open.map((m) => `<li><span><b>${m.name.replace(/</g, '&lt;')}</b> <span class="muted">${m.slots.filter((s) => s.taken).length}/${m.slots.filter((s) => s.human).length} players · ${m.mapSize}²</span></span><button class="btn small" data-join="${m.id}">Join</button></li>`).join('') : '<li class="empty">No open matches. Host one and share the code.</li>';
  } catch { /* server unreachable; status shown on connect */ }
}
$('matchList').addEventListener('click', (e) => { const b = e.target.closest('[data-join]'); if (b) join(b.dataset.join); });
$('joinForm').addEventListener('submit', (e) => { e.preventDefault(); const code = $('joinCode').value.trim().toLowerCase(); if (code) join(code); });

async function ensureNet() {
  if (net) return net;
  net = new Net({ onMessage, onStatus: (s) => { if (s === 'disconnected' && S.ready) hud?.toast({ text: 'Connection lost. Reconnecting…', kind: 'error', level: 'major' }); } });
  try { await net.connect(); } catch (e) { net = null; lobbyStatus(e.message); throw e; }
  setInterval(() => net.ping(), 5000);
  return net;
}
const seedVal = () => { const v = $('seed').value.trim(); return v === '' ? undefined : +v; };
const worldOpts = () => ({ seed: seedVal(), mapSize: $('mapSize').value === 'auto' ? undefined : $('mapSize').value, rebels: $('rebels').checked });
$('btnPlayAI').addEventListener('click', async () => { lobbyStatus('Shaping the continent…'); await ensureNet(); net.send({ t: 'create', mode: 'ai', ais: +$('aiCount').value, aiPersonality: $('aiPersonality').value, name: playerName(), ...worldOpts() }); });
$('btnHost').addEventListener('click', async () => { await ensureNet(); net.send({ t: 'create', mode: 'pvp', humans: +$('humanCount').value, ais: +$('pvpAi').value, name: playerName(), ...worldOpts() }); });
async function join(code) { lobbyStatus('Joining ' + code + '…'); await ensureNet(); net.send({ t: 'join', match: code, name: playerName() }); }
$('btnStartNow').addEventListener('click', () => net.send({ t: 'start' }));
$('btnLeaveRoom').addEventListener('click', () => location.reload());
const last = JSON.parse(store.get('se.session') || 'null');
if (last) { $('btnRejoin').hidden = false; $('btnRejoin').addEventListener('click', async () => { await ensureNet(); net.session = last; net.send({ t: 'rejoin', ...last }); }); }

// ------------------------------------------------------------------ messages
function onMessage(m) {
  switch (m.t) {
    case 'error': lobbyStatus(m.error); if (S.ready) hud.toast({ text: m.error, kind: 'error', level: 'major' }); if (/no longer exists|Invalid session/.test(m.error)) { store.del('se.session'); $('btnRejoin').hidden = true; } break;
    case 'joined': net.session = { match: m.match, token: m.token }; store.set('se.session', JSON.stringify(net.session)); if (m.status === 'lobby') showScreen('room'); break;
    case 'room': showScreen('room'); $('roomName').textContent = m.name; $('roomCode').textContent = m.match; $('roomSlots').innerHTML = m.slots.map((s) => `<li><span>${s.human ? (s.taken ? s.name.replace(/</g, '&lt;') : 'Waiting for player…') : 'AI empire'}</span><span class="muted">${s.human ? (s.taken ? 'ready' : 'open') : ''}</span></li>`).join(''); break;
    case 'welcome': startGame(m); break;
    case 's': applySnapshot(m); break;
    case 'note': onNote(m); break;
    case 'over': gameOver(m); break;
    default: break;
  }
}

async function startGame(m) {
  const first = !S.defs || S.W !== m.defs.W;
  S.defs = m.defs; S.civId = m.civId; S.W = m.defs.W; S.H = m.defs.H;
  S.civInfo = m.civs.map((c) => ({ ...c }));
  const N = S.W * S.H;
  S.terr = new Uint8Array(N).fill(255); S.color = new Uint32Array(N); S.res = new Uint8Array(N); S.road = new Uint32Array(N); S.flags = new Uint8Array(N);
  S.fdir = new Int8Array(N).fill(-1); S.fb = new Uint8Array(N); S.owner = new Int8Array(N).fill(-1); S.stab = new Int8Array(N).fill(-1); S.vis = new Uint8Array(N); S.supply = new Uint8Array(N);
  for (const k of ['units', 'buildings', 'cities', 'ruins', 'cityAt', 'buildingAtTile']) S[k].clear();
  S.buildingTiles.clear(); S.selUnits.clear(); S.selBuilding = null; S.time = m.time;
  showScreen('game');
  if (first) {
    if (view) { view.app.destroy(true); $('stage').innerHTML = ''; }
    view = new View(S, $('stage'));
    await view.init();
    if (!hud) { hud = new Hud(S, actions); bindInput(); }
  }
  view.centerOn(m.start, 1.15);
  S.ready = true;
}

function decodeBits(b64, out) {
  const bin = atob(b64); const changed = [];
  for (let i = 0; i < out.length; i++) { const v = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1; if (out[i] !== v) { out[i] = v; changed.push(i); } }
  return changed;
}

function applySnapshot(m) {
  if (!S.ready) return;
  S.time = m.time;
  if (m.tiles) {
    let ownerChanged = false;
    for (const t of m.tiles) {
      const [i, terr, color, res, road, flags, fdir, fb, owner, stab] = t;
      if (S.owner[i] !== owner) ownerChanged = true;
      S.terr[i] = terr; S.color[i] = color; S.res[i] = res; S.road[i] = road; S.flags[i] = flags; S.fdir[i] = fdir; S.fb[i] = fb; S.owner[i] = owner; S.stab[i] = stab;
      view.dirtyTiles.add(i); view.dirtyOverlay.add(i);
    }
    if (ownerChanged || m.tiles.length > 300) view.bordersDirty = true;
    if (m.tiles.length > 600) view.overlayAll = true;
  }
  if (m.vis) for (const i of decodeBits(m.vis, S.vis)) view.dirtyOverlay.add(i);
  const seen = new Set();
  for (const a of m.units) {
    const [id, owner, type, tile, next, prog, hp, sup, flags, stance] = a;
    seen.add(id);
    const u = S.units.get(id);
    if (u) Object.assign(u, { tile, next, prog, hp, sup, flags, owner, stance });
    else S.units.set(id, { id, owner, type, tile, next, prog, hp, sup, flags, stance });
  }
  for (const id of S.units.keys()) if (!seen.has(id)) { S.units.delete(id); S.selUnits.delete(id); }
  S.paths = m.paths || {};
  if (m.fx) view.addFx(m.fx);
  if (m.econ) applyEcon(m);
}

function applyEcon(m) {
  S.econ = m.econ;
  for (const i of decodeBits(m.supply, S.supply)) if (S.lens === 'supply') view.dirtyOverlay.add(i);
  const got = new Set(m.buildings.map((b) => b.id));
  let bchg = false;
  for (const [id, b] of S.buildings) if (!got.has(id) && (b.o === S.civId || S.vis[b.t])) { S.buildings.delete(id); bchg = true; }
  for (const b of m.buildings) { const o = S.buildings.get(b.id); if (!o || o.st !== b.st || o.o !== b.o) bchg = true; S.buildings.set(b.id, { ...b, rallyArmy: o?.rallyArmy }); }
  if (bchg) { S.buildingsVersion++; S.buildingAtTile.clear(); S.buildingTiles.clear(); for (const b of S.buildings.values()) { S.buildingAtTile.set(b.t, b); S.buildingTiles.add(b.t); } }
  const gotC = new Set(m.cities.map((c) => c.id));
  for (const [id, c] of S.cities) if (!gotC.has(id) && (c.o === S.civId || S.vis[c.t])) S.cities.delete(id);
  for (const c of m.cities) S.cities.set(c.id, c);
  S.cityAt.clear(); for (const c of S.cities.values()) S.cityAt.set(c.t, c);
  const rk = JSON.stringify(m.ruins);
  if (rk !== S.ruinsKey) { S.ruinsKey = rk; S.ruins.clear(); for (const [t, type, flags] of m.ruins) S.ruins.set(t, { type, flags }); S.ruinsVersion++; view.ruinsDirty = true; }
  S.traffic = m.traffic || [];
  S.trafficTile.clear(); for (const [a, b, v] of S.traffic) { S.trafficTile.set(a, Math.max(S.trafficTile.get(a) || 0, v)); S.trafficTile.set(b, Math.max(S.trafficTile.get(b) || 0, v)); }
  if (S.lens === 'traffic') view.overlayAll = true;
  let relChg = false;
  for (const c of m.civs) { const o = S.civInfo[c.id]; if (o && JSON.stringify(o.rel) !== JSON.stringify(c.rel)) relChg = true; Object.assign(S.civInfo[c.id] || (S.civInfo[c.id] = {}), c); }
  if (relChg) view.bordersDirty = true;
  if (S.selBuilding != null && !S.buildings.has(S.selBuilding)) S.selBuilding = null;
  view.syncBuildings();
  hud.topbar(); hud.buildbar(); hud.selection(); hud.drawer(); hud.roadPanel();
  hud.minimap(view);
}

function onNote(m) {
  if (!S.ready) return;
  S.log.push(m); if (S.log.length > 400) S.log.shift();
  const geo = ['quake', 'eruption', 'rift', 'uplift', 'drought', 'river', 'rumor', 'warning'];
  if (geo.includes(m.kind)) hud.quake(m.kind);
  if (m.tile >= 0 && !m.quiet) view.ping(m.tile, m.radius || 2, m.kind === 'warning' ? 0xf0b54a : geo.includes(m.kind) ? 0xff7a5c : m.level === 'critical' || m.kind === 'war' ? 0xd0533b : 0x8fd19e);
  if (m.kind === 'quake' && m.tile >= 0 && S.vis[m.tile]) view.shake = 1.2;
  if (!m.quiet && m.level !== 'info') hud.toast(m);
  hud.alert(m);
  if (hud.tab === 'chronicle') hud.drawer();
}

function gameOver(m) {
  $('gameover').hidden = false;
  const won = m.winner && m.winner.civ === S.civId;
  $('goTitle').textContent = won ? 'Your civilization endures' : 'The age has ended';
  $('goText').textContent = m.winner ? `${m.winner.name} prevails: ${m.winner.how}.` : '';
  $('goStats').innerHTML = '<tr><th>Empire</th><th>Cities</th><th>Pop</th><th>Techs</th><th>Kills</th><th>Score</th></tr>' + m.stats.map((s) => `<tr><td>${s.name}</td><td>${s.cities}</td><td>${s.pop}</td><td>${s.techs}</td><td>${s.kills}</td><td>${s.score}</td></tr>`).join('');
  store.del('se.session');
}
$('btnLobby').addEventListener('click', () => location.reload());

// ------------------------------------------------------------------ actions (all validated server-side)
const mineSel = () => [...S.selUnits].filter((id) => S.units.get(id)?.owner === S.civId);
const actions = {
  async cmd(c) { const r = await net.cmd(c); if (r && r.error) hud.toast({ text: r.error, kind: 'error', level: 'minor' }); return r || {}; },
  jump(tile) { if (tile >= 0) view.centerOn(tile); },
  refresh() { hud.drawer(true); },
  selectCity(id) { const c = S.cities.get(id); if (!c) return; const b = S.buildingAtTile.get(c.t); if (b) { S.selUnits.clear(); S.selBuilding = b.id; hud.cityTab = 'overview'; hud.selection(); view.syncBuildings(); } },
  async train(unit) {
    if (S.selBuilding == null) return;
    const b = S.buildings.get(S.selBuilding);
    const r = await actions.cmd({ c: 'train', building: S.selBuilding, unit, army: b?.rallyArmy || undefined });
    if (!r.error) hud.toast({ text: `Training ${S.defs.UNITS[unit].name}.`, kind: 'build', level: 'info' });
  },
  act(a) {
    const ids = mineSel();
    if (a === 'stop') actions.cmd({ c: 'stop', units: ids });
    if (a === 'amove') setMode({ kind: 'attackMove' }, 'Left-click a destination: units will fight anything they meet on the way.');
    if (a === 'found' || a === 'autoSettle') {
      const cols = ids.map((id) => S.units.get(id)).filter((u) => u.type === 'colonist');
      if (a === 'found') cols.slice(0, 1).forEach((s) => actions.cmd({ c: 'found', unit: s.id }));
      else { for (const s of cols) actions.cmd({ c: 'autoSettle', unit: s.id }); hud.toast({ text: 'Colonists will pick a site and settle on their own.', kind: 'city', level: 'info' }); }
    }
    if (a === 'army') actions.formArmy();
    if (a === 'demolish' && S.selBuilding != null) { actions.cmd({ c: 'demolish', id: S.selBuilding }); S.selBuilding = null; }
    if (a === 'repair' && S.selBuilding != null) actions.cmd({ c: 'repair', id: S.selBuilding });
  },
  async formArmy() {
    const ids = mineSel().filter((id) => !S.defs.UNITS[S.units.get(id).type].civilian);
    if (!ids.length) return hud.toast({ text: 'Select combat units first.', kind: 'error', level: 'minor' });
    const r = await actions.cmd({ c: 'army', op: 'create', units: ids });
    if (!r.error) { hud.toast({ text: `Army formed with ${ids.length} units.`, kind: 'unit', level: 'minor' }); hud.tab = ''; document.querySelector('[data-tab=armies]').click(); }
  },
  stance(st) { actions.cmd({ c: 'stance', units: mineSel(), stance: st }); },
  selectType(type, onScreen) { S.selUnits.clear(); selectType(type, onScreen); hud.selection(); },
  narrowTo(type) { for (const id of [...S.selUnits]) if (S.units.get(id)?.type !== type) S.selUnits.delete(id); hud.selection(); },
  governor(patch) { const b = S.buildings.get(S.selBuilding); const c = b && S.cityAt.get(b.t); if (c) actions.cmd({ c: 'governor', city: c.id, ...patch }).then(() => setTimeout(() => { hud.selHtml = ''; hud.selection(); }, 1100)); },
  rallyArmy(id) { const b = S.buildings.get(S.selBuilding); if (b) { b.rallyArmy = id; actions.cmd({ c: 'rally', building: b.id, tile: b.r ?? -1, army: id }); } },
  army(op, id, tile) {
    const a = (S.econ.armies || []).find((x) => x.id === id);
    if (op === 'select' && a) { S.selUnits = new Set(a.units.filter((u) => S.units.has(u))); S.selBuilding = null; hud.selection(); }
    else if (op === 'center' && tile >= 0) view.centerOn(tile);
    else if (op === 'disband') actions.cmd({ c: 'army', op: 'disband', id });
    else if (op === 'hold') actions.cmd({ c: 'army', op: 'order', id, kind: 'hold' });
    else if (op === 'rallyAll') setMode({ kind: 'rallyAll' }, 'Click where new units from every production building should gather.');
    else if (['move', 'attackMove', 'defend', 'offensive'].includes(op)) setMode({ kind: 'armyOrder', op, id }, { move: 'Click where the army should march.', attackMove: 'Click where the army should advance, engaging on the way.', defend: 'Click the centre of the zone to defend.', offensive: 'Click the objective. The army stages behind the lines, waits until it is ready, then attacks.' }[op]);
  },
  async buildMode(type, tool) {
    if (tool === 'road') return startRoadMode();
    if (tool === 'clearPass') return setMode({ kind: 'clearPass' }, 'Click an impassable peak next to an engineer team or your supply network.');
    if (S.mode && S.mode.type === type) return setMode(null);
    setMode({ kind: 'build', type, tiles: null }, `Place ${S.defs.BUILDINGS[type].name}: highlighted hexes are valid. Shift-click to place several.`);
    const r = await net.cmd({ c: 'placement', type });
    if (S.mode && S.mode.type === type) { S.mode.tiles = new Set(r.tiles || []); S.mode.afford = r.afford; if (!r.tiles?.length) $('hint').textContent = `No valid place for ${S.defs.BUILDINGS[type].name} in explored territory.`; else if (!r.afford) $('hint').textContent += ' Not enough resources: it will be planned and built once funded.'; }
  },
  road(op, id) {
    const m = S.mode;
    if (op === 'cancel') return actions.cmd({ c: 'roadCancel', id });
    if (!m || m.kind !== 'road') return;
    if (op === 'close') return setMode(null);
    if (op === 'clear') { m.points = []; m.preview = null; }
    if (op === 'undo') { m.points.pop(); requestPreview(); }
    if (op === 'commit' && m.preview) {
      actions.cmd({ c: 'roadPlan', tiles: m.points, type: m.type, auto: m.auto, commit: true }).then((r) => { if (!r.error) { hud.toast({ text: `${S.defs.ROAD_TYPES[m.type].name} commissioned.`, kind: 'build', level: 'minor' }); m.points = []; m.preview = null; hud.roadPanel(); } });
    }
    hud.roadPanel();
  },
  roadType(t) { if (S.mode?.kind === 'road') { S.mode.type = t; requestPreview(); } },
  roadAuto(on) { if (S.mode?.kind === 'road') { S.mode.auto = on; requestPreview(); } },
};
function setMode(m, hint) { S.mode = m; $('hint').textContent = m ? (hint || '') + ' Esc to cancel.' : ''; hud.bbKey = ''; hud.buildbar(); hud.roadPanel(); }
function startRoadMode() {
  const techs = new Set(S.econ?.techs || []);
  const best = [3, 2, 1].find((t) => !S.defs.ROAD_TYPES[t].tech || techs.has(S.defs.ROAD_TYPES[t].tech)) || 1;
  setMode({ kind: 'road', points: [], preview: null, type: best, auto: true }, 'Drag to sketch a road or click waypoints.');
}
let previewTimer = null;
function requestPreview() {
  const m = S.mode; if (!m || m.kind !== 'road') return;
  clearTimeout(previewTimer);
  if (m.points.length < 2) { m.preview = null; hud.roadPanel(); return; }
  previewTimer = setTimeout(async () => {
    const r = await net.cmd({ c: 'roadPlan', tiles: m.points, type: m.type, auto: m.auto });
    if (S.mode === m && r.plan) { m.preview = r.plan; hud.roadPanel(); }
  }, 120);
}

// ------------------------------------------------------------------ input
function bindInput() {
  const cv = view.app.canvas;
  let drag = null, pan = null, stroke = null;
  const keys = new Set();
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.altKey)) { pan = { x: e.clientX, y: e.clientY, cx: view.cam.x, cy: view.cam.y }; return; }
    if (e.button === 0 && S.mode?.kind === 'road') { stroke = { x: e.offsetX, y: e.offsetY, moved: false, start: S.mode.points.length }; return; }
    if (e.button === 0) drag = { x: e.offsetX, y: e.offsetY, x1: e.offsetX, y1: e.offsetY };
    if (e.button === 2) rightClick(e);
  });
  cv.addEventListener('pointermove', (e) => {
    if (pan) { view.cam.x = pan.cx - (e.clientX - pan.x) / view.cam.z; view.cam.y = pan.cy - (e.clientY - pan.y) / view.cam.z; view.clamp(); return; }
    const [wx, wy] = view.screenToWorld(e.offsetX, e.offsetY);
    S.hover = view.tileAt(wx, wy);
    if (stroke && S.hover >= 0) {
      // freehand road sketch: every hex the cursor crosses becomes a waypoint
      if (Math.hypot(e.offsetX - stroke.x, e.offsetY - stroke.y) > 6) stroke.moved = true;
      const pts = S.mode.points;
      if (stroke.moved && pts[pts.length - 1] !== S.hover) { pts.push(S.hover); S.mode.auto = false; requestPreview(); }
    }
    hud.tooltip(drag || stroke ? -1 : S.hover, e.offsetX, e.offsetY);
    if (drag) { drag.x1 = e.offsetX; drag.y1 = e.offsetY; drawBox(drag); }
  });
  cv.addEventListener('pointerleave', () => { S.hover = -1; hud.tooltip(-1); });
  cv.addEventListener('pointerup', (e) => {
    if (pan) { pan = null; return; }
    if (stroke) { const s = stroke; stroke = null; if (!s.moved && S.hover >= 0) { S.mode.points.push(S.hover); requestPreview(); hud.roadPanel(); } return; }
    if (!drag || e.button !== 0) return;
    const d = drag; drag = null; view.selG.clear();
    if (Math.hypot(d.x1 - d.x, d.y1 - d.y) > 6 && !S.mode) return boxSelect(d, e.shiftKey);
    leftClick(e);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) view.zoomAt(Math.exp(-e.deltaY * 0.01), e.offsetX, e.offsetY);
    else if (e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY))) view.zoomAt(e.deltaY > 0 ? 0.88 : 1.14, e.offsetX, e.offsetY);
    else { view.cam.x += e.deltaX / view.cam.z; view.cam.y += e.deltaY / view.cam.z; view.clamp(); }
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (controlGroupKey(e)) return;
    keys.add(e.key.toLowerCase());
    const k = e.key.toLowerCase();
    if (k === 'escape') { setMode(null); $('menu').hidden = true; $('alerts').hidden = true; }
    if (k === 'a' && S.selUnits.size) actions.act('amove');
    if (k === 's' && S.selUnits.size) actions.act('stop');
    if (k === 'f') actions.act('found');
    if (k === 'g' && S.selUnits.size) actions.formArmy();
    if (k === 'r') startRoadMode();
    if (k === ' ') { const u = S.units.get([...S.selUnits][0]); if (u) view.centerOn(u.tile); else { const c = [...S.cities.values()].find((x) => x.o === S.civId && x.cap); if (c) view.centerOn(c.t); } e.preventDefault(); }
    if (k === '=' || k === '+') view.zoomAt(1.15, view.app.screen.width / 2, view.app.screen.height / 2);
    if (k === '-') view.zoomAt(0.87, view.app.screen.width / 2, view.app.screen.height / 2);
    if (k === 'l') { const order = ['terrain', 'territory', 'supply', 'stability', 'traffic']; setLens(order[(order.indexOf(S.lens) + 1) % order.length]); }
    if (k === 'backspace' && S.mode?.kind === 'road') actions.road('undo');
    if (k === 'enter' && S.mode?.kind === 'road') actions.road('commit');
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  let uiTick = 0, mmTick = 0;
  S.onFrame = (dt) => {
    const sp = (600 * dt) / view.cam.z;
    if (keys.has('arrowleft') || (keys.has('a') && !S.selUnits.size)) view.cam.x -= sp;
    if (keys.has('arrowright') || keys.has('d')) view.cam.x += sp;
    if (keys.has('arrowup') || keys.has('w')) view.cam.y -= sp;
    if (keys.has('arrowdown') || (keys.has('s') && !S.selUnits.size)) view.cam.y += sp;
    view.clamp();
    hud.seismo(dt);
    hud.clock(S.time, net?.rtt);
    uiTick += dt; if (uiTick > 0.5) { uiTick = 0; hud.selection(); }
    mmTick += dt; if (mmTick > 1) { mmTick = 0; hud.minimap(view); }
  };
  $('minimap').addEventListener('pointerdown', (e) => { const mm = (ev) => { const x = (ev.offsetX / 192) * view.pw, y = (ev.offsetY / 168) * view.ph; view.cam.x = x - view.app.screen.width / 2 / view.cam.z; view.cam.y = y - view.app.screen.height / 2 / view.cam.z; view.clamp(); }; mm(e); const mv = (ev) => mm(ev); e.target.addEventListener('pointermove', mv); window.addEventListener('pointerup', () => e.target.removeEventListener('pointermove', mv), { once: true }); });
  document.querySelectorAll('.lenses button').forEach((b) => b.addEventListener('click', () => setLens(b.dataset.lens)));
  $('btnMenu').addEventListener('click', () => { $('menu').hidden = false; });
  $('btnResume').addEventListener('click', () => { $('menu').hidden = true; });
  $('btnSurrender').addEventListener('click', () => { actions.cmd({ c: 'surrender' }); $('menu').hidden = true; });
  $('btnQuit').addEventListener('click', () => { store.del('se.session'); location.reload(); });
}

function setLens(l) { S.lens = l; view.overlayAll = true; document.querySelectorAll('.lenses button').forEach((b) => b.classList.toggle('on', b.dataset.lens === l)); hud.minimap(view); }
function drawBox(d) { const g = view.selG; g.clear(); g.rect(Math.min(d.x, d.x1), Math.min(d.y, d.y1), Math.abs(d.x1 - d.x), Math.abs(d.y1 - d.y)).fill({ color: 0xf1c75b, alpha: 0.08 }).stroke({ width: 1, color: 0xf1c75b, alpha: 0.8 }); }

function boxSelect(d, add) {
  if (!add) { S.selUnits.clear(); S.selBuilding = null; }
  const x0 = Math.min(d.x, d.x1), x1 = Math.max(d.x, d.x1), y0 = Math.min(d.y, d.y1), y1 = Math.max(d.y, d.y1);
  for (const u of S.units.values()) {
    if (u.owner !== S.civId) continue;
    const s = view.unitSprites.get(u.id); if (!s) continue;
    const [sx, sy] = view.worldToScreen(s.dx, s.dy);
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) S.selUnits.add(u.id);
  }
  hud.selection();
}

async function leftClick(e) {
  const [wx, wy] = view.screenToWorld(e.offsetX, e.offsetY);
  const tile = view.tileAt(wx, wy);
  const m = S.mode;
  if (m) {
    if (tile < 0) return;
    if (m.kind === 'build') {
      if (m.tiles && !m.tiles.has(tile)) return hud.toast({ text: 'That hex is not valid for this building.', kind: 'error', level: 'minor' });
      const r = await actions.cmd({ c: 'build', type: m.type, tile, plan: true });
      if (!r.error) { if (e.shiftKey) actions.buildMode(m.type); else setMode(null); }
      return;
    }
    if (m.kind === 'clearPass') { await actions.cmd({ c: 'clearPass', tile }); setMode(null); return; }
    if (m.kind === 'attackMove') { orderMove(mineSel(), tile, true); setMode(null); return; }
    if (m.kind === 'armyOrder') { actions.cmd({ c: 'army', op: 'order', id: m.id, kind: m.op, tile, radius: 4 }); view.ping(tile, m.op === 'defend' ? 4 : 1, 0xf1c75b); setMode(null); return; }
    if (m.kind === 'rallyAll') { actions.cmd({ c: 'rallyAll', tile }); view.ping(tile, 1, 0x8fe0a8); setMode(null); return; }
  }
  const u = view.unitAtScreen(e.offsetX, e.offsetY);
  // pointerup carries no reliable click count, so double-clicks are tracked explicitly
  const now = performance.now();
  const dbl = lastClick && now - lastClick.t < 380 && Math.hypot(e.offsetX - lastClick.x, e.offsetY - lastClick.y) < 10 && u && lastClick.type === u.type;
  lastClick = { t: now, x: e.offsetX, y: e.offsetY, type: u ? u.type : null };
  if (!e.shiftKey && !dbl) { S.selUnits.clear(); S.selBuilding = null; }
  if (u) {
    if (dbl && u.owner === S.civId) { if (!e.shiftKey) S.selUnits.clear(); selectType(u.type, !(e.ctrlKey || e.metaKey)); lastClick = null; }
    else S.selUnits.add(u.id);
  } else if (tile >= 0) { const b = S.buildingAtTile.get(tile); if (b) { S.selBuilding = b.id; hud.cityTab = 'overview'; } }
  hud.selHtml = ''; hud.selection();
  view.syncBuildings();
}
let lastClick = null;

function selectType(type, onScreenOnly) {
  const sw = view.app.screen.width, sh = view.app.screen.height;
  for (const o of S.units.values()) {
    if (o.owner !== S.civId || o.type !== type) continue;
    if (onScreenOnly) { const s = view.unitSprites.get(o.id); if (!s) continue; const [x, y] = view.worldToScreen(s.dx, s.dy); if (x < 0 || y < 0 || x > sw || y > sh) continue; }
    S.selUnits.add(o.id);
  }
}

// Control groups: Ctrl+1..9 assigns, 1..9 recalls, pressing the number twice centres the camera.
const groups = {};
let lastGroupKey = { k: null, t: 0 };
function controlGroupKey(e) {
  const k = e.key;
  if (!/^[1-9]$/.test(k)) return false;
  if (e.ctrlKey || e.metaKey) { groups[k] = mineSel(); hud.toast({ text: `Group ${k}: ${groups[k].length} units.`, kind: 'build', level: 'info' }); e.preventDefault(); return true; }
  const ids = (groups[k] || []).filter((id) => S.units.has(id));
  if (!ids.length) return true;
  if (!e.shiftKey) { S.selUnits.clear(); S.selBuilding = null; }
  ids.forEach((id) => S.selUnits.add(id));
  const now = performance.now();
  if (lastGroupKey.k === k && now - lastGroupKey.t < 400) view.centerOn(S.units.get(ids[0]).tile);
  lastGroupKey = { k, t: now };
  hud.selection(); return true;
}

function rightClick(e) {
  const [wx, wy] = view.screenToWorld(e.offsetX, e.offsetY);
  const tile = view.tileAt(wx, wy); if (tile < 0) return;
  if (S.mode) { if (S.mode.kind === 'road' && S.mode.points.length) { S.mode.points.pop(); requestPreview(); hud.roadPanel(); return; } return setMode(null); }
  const mine = mineSel();
  if (!mine.length) {
    if (S.selBuilding != null) { const b = S.buildings.get(S.selBuilding); if (b && b.o === S.civId && S.defs.BUILDINGS[b.ty].trains) { actions.cmd({ c: 'rally', building: b.id, tile, army: b.rallyArmy || 0 }); b.r = tile; hud.toast({ text: 'Rally point set.', kind: 'build', level: 'info' }); } }
    return;
  }
  const rel = (o) => S.civInfo[o]?.rel?.state;
  const target = view.unitAtScreen(e.offsetX, e.offsetY, (u) => u.owner !== S.civId);
  if (target && rel(target.owner) === 'war') { actions.cmd({ c: 'attack', units: mine, target: { kind: 'unit', id: target.id } }); view.ping(target.tile, 0.6, 0xd0533b); return; }
  const b = S.buildingAtTile.get(tile);
  if (b && b.o !== S.civId && rel(b.o) === 'war') { actions.cmd({ c: 'attack', units: mine, target: { kind: 'building', id: b.id } }); view.ping(tile, 0.8, 0xd0533b); return; }
  orderMove(mine, tile, e.shiftKey);
}

async function orderMove(units, tile, attackMove) {
  view.ping(tile, 0.5, 0xf1c75b);
  const r = await actions.cmd({ c: 'move', units, tile, attackMove, formation: S.formation });
  const o = r && r.order; if (!o) return;
  if (o.unreachable) hud.toast({ text: `${o.unreachable} unit${o.unreachable > 1 ? 's' : ''} cannot reach that location.`, kind: 'error', level: 'minor' });
  if (o.partial) hud.toast({ text: `${o.partial} unit${o.partial > 1 ? 's' : ''} will get as close as the terrain allows.`, kind: 'warning', level: 'minor' });
}

// ------------------------------------------------------------------ boot
lobbyArt();
refreshMatches();
setInterval(() => { if (!S.ready) refreshMatches(); }, 4000);
window.__S = S;
window.__view = () => view;
