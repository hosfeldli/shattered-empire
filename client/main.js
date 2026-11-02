// Shattered Empires client bootstrap: lobby, state sync, actions and input. No game rules live
// here: every decision (paths, placements, road routes, costs, combat) is made on the server.
import { Net } from './net.js';
import { api } from './config.js';
import { View } from './view.js';
import { Hud } from './hud.js';
import { unitKind } from './commandBar.js';
import { AudioManager } from './audio/AudioManager.js';
import { planDeployment, deployRole } from '/shared/deploy.js';
import { loadPrefs, savePrefs, applyPrefs, GRAPHICS } from './prefs.js';

const $ = (id) => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } } };

// sound: created now, unlocked by the first click or key press
let audio;
const S = {
  ready: false, defs: null, civId: -1, civInfo: [], W: 128, H: 128, lens: 'terrain', mode: null, hover: -1, formation: 'line', lod: 'city', night: 0,
  selUnits: new Set(), selBuilding: null, selBuildings: new Set(), batchCount: 4, batchMode: 'total', deploy: null, deployOpts: { mode: 'line', density: 'auto', depth: 'auto', behavior: 'defend', reverse: false }, prefs: loadPrefs(), units: new Map(), paths: {}, buildings: new Map(), cities: new Map(), ruins: new Map(), traffic: [], trafficTile: new Map(),
  cityAt: new Map(), buildingAtTile: new Map(), buildingTiles: new Set(), buildingsVersion: 0, ruinsVersion: 0, econ: null, log: [], time: 0, lightsList: [],
  civColor(id) { return (this.civInfo[id] && this.civInfo[id].color) ?? 0x888888; },
};
audio = new AudioManager(S);
window.__audio = () => audio;

let view = null, hud = null, net = null;

// ------------------------------------------------------------------ lobby
function showScreen(id) { for (const s of ['lobby', 'room', 'game']) $(s).hidden = s !== id; }
function lobbyStatus(t) { $('lobbyStatus').textContent = t || ''; }
function playerName() { const n = $('playerName').value.trim() || 'Founder'; store.set('se.name', n); return n; }
$('playerName').value = store.get('se.name') || '';

// The menu backdrop: a freshly generated continent drawn as a hex map (the server sends a tiny
// preview, one colour per hex; the hexes, relief shading and coastlines are drawn here).
function lobbyArt() {
  const c = $('lobbyCanvas'); const img = new Image();
  img.onload = () => {
    const sc = 2, W = Math.round((img.width - sc / 2) / sc), H = Math.round(img.height / sc);
    const src = document.createElement('canvas'); src.width = img.width; src.height = img.height;
    const sx = src.getContext('2d'); sx.drawImage(img, 0, 0); const px = sx.getImageData(0, 0, img.width, img.height).data;
    const R = 9, SQ = Math.sqrt(3);
    c.width = Math.ceil(W * R * SQ + R * SQ / 2); c.height = Math.ceil(H * R * 1.5 + R / 2);
    const g = c.getContext('2d');
    const col = (q, r) => { const x = Math.min(img.width - 1, q * sc + (r & 1) * (sc / 2)), y = r * sc, o = (y * img.width + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
    const lum = (k) => 0.3 * k[0] + 0.59 * k[1] + 0.11 * k[2];
    for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) {
      const k = col(q, r), cx = R * SQ * (q + 0.5 * (r & 1)) + R * SQ / 2, cy = R * 1.5 * r + R;
      // light from the north-west: a hex brighter than its south-east neighbour stands up
      const ne = col(Math.min(W - 1, q + (r & 1)), Math.min(H - 1, r + 1)), d = Math.max(-26, Math.min(26, (lum(k) - lum(ne)) * 0.6));
      g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; g.lineTo(cx + Math.cos(a) * (R + 0.6), cy + Math.sin(a) * (R + 0.6)); }
      g.fillStyle = `rgb(${k[0] + d | 0},${k[1] + d | 0},${k[2] + d | 0})`; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.07)'; g.lineWidth = 1; g.stroke();
    }
    c.classList.add('ready');
  };
  img.src = api('/api/preview?scale=2&seed=') + ((Math.random() * 1e6) | 0);
}
async function refreshMatches() {
  try {
    const list = await (await fetch(api('/api/matches'))).json();
    const open = list.filter((m) => m.status === 'lobby' && m.slots.some((s) => s.human && !s.taken));
    const live = list.filter((m) => m.status === 'running' || m.status === 'parked').slice(0, 6);
    const esc = (t) => String(t).replace(/</g, '&lt;');
    const rows = open.map((m) => `<li><span><b>${esc(m.name)}</b> <span class="muted">${m.slots.filter((s) => s.taken).length}/${m.slots.filter((s) => s.human).length} players · ${m.mapSize}²</span></span><button class="btn small" data-join="${m.id}">Join</button></li>`)
      .concat(live.map((m) => `<li><span><b>${esc(m.name)}</b> <span class="muted">${m.mode === 'observe' ? 'AI exhibition' : 'in progress'} · ${m.slots.length} empires · ${Math.floor((m.time || 0) / 60)} min</span></span><button class="btn small ghost" data-watch="${m.id}" title="Spectate without fog of war">Watch</button></li>`));
    $('matchList').innerHTML = rows.length ? rows.join('') : '<li class="empty">No open matches. Host one and share the code.</li>';
  } catch { /* server unreachable; status shown on connect */ }
}
$('matchList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-join]'); if (b) return join(b.dataset.join);
  const w = e.target.closest('[data-watch]'); if (w) { lobbyStatus('Opening the spectator view…'); await ensureNet(); net.send({ t: 'spectate', match: w.dataset.watch, name: playerName() }); }
});
$('joinForm').addEventListener('submit', (e) => { e.preventDefault(); const code = $('joinCode').value.trim().toLowerCase(); if (code) join(code); });

async function ensureNet() {
  if (net) return net;
  net = new Net({ onMessage, onStatus: (s) => { if (s === 'disconnected' && S.ready) hud?.toast({ text: 'Connection lost. Reconnecting…', kind: 'error', level: 'major' }); } });
  try { await net.connect(); } catch (e) { net = null; lobbyStatus(e.message); throw e; }
  setInterval(() => net.ping(), 5000);
  return net;
}
const seedVal = () => { const v = $('seed').value.trim(); return v === '' ? undefined : +v; };
const worldOpts = () => ({ seed: seedVal(), mapSize: $('mapSize').value === 'auto' ? undefined : $('mapSize').value, rebels: $('rebels').checked, style: $('worldStyle').value || undefined });
// ---- lobby: rival difficulty with full disclosure of what each level does
const DIFF_TEXT = {
  easy: ['Gentle', 'Basic', 'Simple', 'Short campaigns, limited reserves, slow to adapt'],
  normal: ['Fair benchmark', 'Competent', 'Balanced', 'Stable objectives, moderate adaptation'],
  hard: ['Demanding', 'Strong', 'Counter-aware', 'Long campaigns, deliberate reserves, better scouting'],
  expert: ['Very demanding', 'Advanced', 'Counter-aware', 'Coordinated offense and defense, raids on exposed logistics'],
  brutal: ['Maximum', 'Advanced', 'Adaptive', 'Multi-objective campaigns, aggressive adaptation'],
};
function renderDifficulty() {
  const d = $('aiDifficulty').value, fair = $('fairPlay').checked, t = DIFF_TEXT[d] || DIFF_TEXT.normal;
  const adv = d === 'brutal' && !fair ? 'Economy +15%, research +10%, army +20% (disclosed to every player)' : 'None';
  $('diffName').textContent = { easy: 'Relaxed', normal: 'Standard', hard: 'Hard', expert: 'Expert', brutal: 'Brutal' }[d];
  $('diffFair').textContent = adv === 'None' ? '(fair play)' : '(with economic help)';
  $('diffInfo').innerHTML = `<dl class="kv"><dt>Challenge</dt><dd>${t[0]}</dd><dt>Strategic planning</dt><dd>${t[1]}</dd><dt>Army composition</dt><dd>${t[2]}</dd><dt>Military coordination</dt><dd>${t[3]}</dd><dt>Economic advantages</dt><dd class="${adv === 'None' ? 'good' : 'warn'}">${adv}</dd></dl>`;
  for (const b of document.querySelectorAll('#diffSeg button')) b.classList.toggle('on', b.dataset.diff === d);
  const n = +$('aiCount').value || 1, rows = $('rivalRows'), cur = rows.children.length;
  if (cur !== n) rows.innerHTML = Array.from({ length: n }, (_, i) => `<div class="rival"><span>Rival ${i + 1}</span><select data-rival-p="${i}"><option value="">Temperament: shared</option><option value="warlord">Warlord</option><option value="merchant">Merchant</option><option value="builder">Builder</option></select><select data-rival-d="${i}"><option value="">Difficulty: shared</option><option value="easy">Relaxed</option><option value="normal">Standard</option><option value="hard">Hard</option><option value="expert">Expert</option><option value="brutal">Brutal</option></select></div>`).join('');
}
function rivalSettings() { return [...document.querySelectorAll('#rivalRows .rival')].map((r) => ({ personality: r.querySelector('[data-rival-p]').value || undefined, difficulty: r.querySelector('[data-rival-d]').value || undefined })); }
$('diffSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-diff]'); if (!b) return; $('aiDifficulty').value = b.dataset.diff; renderDifficulty(); });
$('fairPlay').addEventListener('change', renderDifficulty);
$('aiCount').addEventListener('change', renderDifficulty);
renderDifficulty();

$('btnPlayAI').addEventListener('click', async () => { lobbyStatus('Shaping the continent…'); await ensureNet(); net.send({ t: 'create', mode: 'ai', ais: +$('aiCount').value, aiPersonality: $('aiPersonality').value, difficulty: $('aiDifficulty').value, fairPlay: $('fairPlay').checked, rivals: rivalSettings(), name: playerName(), ...worldOpts() }); });
$('btnWatch').addEventListener('click', async () => { lobbyStatus('Shaping the continent for an AI exhibition…'); await ensureNet(); net.send({ t: 'create', mode: 'observe', ais: +$('watchCount').value, aiPersonality: $('watchPersonality').value, name: playerName(), ...worldOpts() }); });
// Steam (desktop app): lobbies carry the server's match code. Hosts invite from the waiting room;
// an accepted invite (or a friend's match picked here) joins that match on the game server.
const steamApi = window.desktop?.steam || null;
async function steamInit() {
  if (!steamApi) return;
  const st = await steamApi.status();
  $('steamFriends').hidden = false;
  if (!st.available) { $('steamNote').textContent = st.error || 'Steam is not running: start Steam to play with friends.'; $('btnSteamRefresh').hidden = true; return; }
  $('steamNote').textContent = `Signed in to Steam as ${st.name}. Host a multiplayer match and invite friends from the waiting room, or join a friend's match.`;
  // your Steam name is who you play as
  if (st.name) { const n = $('playerName'); n.value = st.name.slice(0, 24); n.readOnly = true; n.title = 'Your Steam name'; n.closest('.field')?.classList.add('steam'); }
  $('btnSteamInvite').hidden = false;
}
async function steamLobbies() {
  const list = await steamApi.lobbies();
  const esc = (t) => String(t).replace(/</g, '&lt;');
  $('steamLobbies').innerHTML = list.length ? list.map((l) => `<li><span><b>${esc(l.name)}</b> <span class="muted">${l.members} in lobby</span></span><button class="btn small" data-steamlobby="${l.id}">Join</button></li>`).join('') : '<li class="empty">No friends\' matches found. Ask for a Steam invite.</li>';
}
if (steamApi) {
  steamInit();
  steamApi.onJoin((code) => { if (S.ready) return hud?.toast({ text: 'Finish or leave this match to join your friend\'s.', kind: 'info', level: 'minor' }); join(code); });
  $('btnSteamRefresh').addEventListener('click', steamLobbies);
  $('steamLobbies').addEventListener('click', async (e) => { const b = e.target.closest('[data-steamlobby]'); if (!b) return; lobbyStatus('Joining through Steam…'); const r = await steamApi.join(b.dataset.steamlobby); if (!r.ok) lobbyStatus(r.error); });
  $('btnSteamInvite').addEventListener('click', async () => { const r = await steamApi.host($('roomCode').textContent.trim(), $('roomName').textContent.trim()); if (!r.ok) lobbyStatus(r.error); });
}
$('btnSandbox').addEventListener('click', async () => { lobbyStatus('Preparing the combat sandbox…'); await ensureNet(); net.send({ t: 'create', mode: 'sandbox', name: playerName(), seed: seedVal() }); });
$('btnHost').addEventListener('click', async () => { await ensureNet(); net.send({ t: 'create', mode: 'pvp', humans: +$('humanCount').value, ais: +$('pvpAi').value, difficulty: $('aiDifficulty').value, fairPlay: $('fairPlay').checked, name: playerName(), ...worldOpts() }); });
async function join(code) { lobbyStatus('Joining ' + code + '…'); await ensureNet(); net.send({ t: 'join', match: code, name: playerName() }); }
$('btnStartNow').addEventListener('click', () => net.send({ t: 'start' }));
$('btnLeaveRoom').addEventListener('click', () => location.reload());
// server administration: offered for the administrator's name; the server checks name and PIN
const ADMIN_NAME = 'Liam6642';
function adminOffer() { $('btnAdmin').hidden = $('playerName').value.trim() !== ADMIN_NAME; }
$('playerName').addEventListener('input', adminOffer); adminOffer();
let adminSignedIn = false, adminArmed = null;
$('btnAdmin').addEventListener('click', () => { $('admin').hidden = false; $('adminStatus').textContent = ''; if (adminSignedIn) net?.send({ t: 'admin', action: 'list' }); else $('adminPin').focus(); });
$('adminDone').addEventListener('click', () => { $('admin').hidden = true; });
$('admin').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('admin').hidden = true; });
$('adminLogin').addEventListener('submit', async (e) => {
  e.preventDefault(); $('adminStatus').textContent = 'Signing in…';
  try { await ensureNet(); } catch { $('adminStatus').textContent = 'Cannot reach the game server.'; return; }
  net.send({ t: 'admin', action: 'login', name: $('playerName').value.trim(), pin: $('adminPin').value }); $('adminPin').value = '';
});
$('adminRefresh').addEventListener('click', () => net?.send({ t: 'admin', action: 'list' }));
// closing is final for everyone in the match: each close button asks once more before it acts
function adminConfirm(btn, label, send) {
  if (adminArmed === btn) { adminArmed = null; send(); btn.disabled = true; return; }
  if (adminArmed) adminArmed.textContent = adminArmed.dataset.label;
  adminArmed = btn; btn.dataset.label = btn.textContent; btn.textContent = label;
}
$('adminCloseAll').addEventListener('click', (e) => adminConfirm(e.currentTarget, 'Click again to close all', () => net.send({ t: 'admin', action: 'closeAll' })));
$('adminList').addEventListener('click', (e) => { const b = e.target.closest('[data-close]'); if (b) adminConfirm(b, 'Click again to close', () => net.send({ t: 'admin', action: 'close', match: b.dataset.close })); });
function adminResult(m) {
  if (m.error) { $('adminStatus').textContent = m.error; return; }
  adminSignedIn = true; adminArmed = null;
  $('adminLogin').hidden = true; $('adminBody').hidden = false;
  $('adminStatus').textContent = m.closed ? `Closed ${m.closed.length === 1 ? 'match ' + m.closed[0] : m.closed.length + ' matches'}.` : '';
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const list = m.matches || [];
  $('adminCount').textContent = list.length === 1 ? '1 match on this server' : `${list.length} matches on this server`;
  $('adminCloseAll').disabled = !list.length; $('adminCloseAll').textContent = 'Close every match';
  const mode = { ai: 'vs AI', pvp: 'multiplayer', observe: 'AI exhibition', sandbox: 'sandbox' };
  $('adminList').innerHTML = list.length ? list.map((x) => {
    const on = x.players.filter((p) => p.connected).length;
    const who = x.players.map((p) => esc(p.name || 'open seat') + (p.connected ? '' : ' (away)')).join(', ') || 'no players';
    return `<li><div><b>${esc(x.name)}</b><small>${esc(x.id)}, ${mode[x.mode] || esc(x.mode)}, ${esc(x.status)}, ${Math.floor(x.time / 60)} min in, ${on} connected${x.watchers ? `, ${x.watchers} watching` : ''}${x.tickMs != null ? `, ${x.tickMs} ms per tick` : ''}</small><small>${who}</small></div><button class="btn small danger" data-close="${esc(x.id)}">Close</button></li>`;
  }).join('') : '<li class="empty">No matches are running.</li>';
}
{ const msg = store.get('se.closedMsg'); if (msg) { store.del('se.closedMsg'); setTimeout(() => lobbyStatus(msg), 0); } }
// main menu: one mode at a time; its settings and its one action button show on the right
function setLobbyMode(mode) {
  for (const b of document.querySelectorAll('.modes [data-mode]')) { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  for (const p of document.querySelectorAll('.mode-panel')) p.hidden = p.dataset.panel !== mode;
  for (const b of document.querySelectorAll('.go [data-for]')) b.hidden = b.dataset.for !== mode;
  for (const f of document.querySelectorAll('.advanced .world-only')) f.hidden = mode === 'sandbox';
  if (mode === 'mp') refreshMatches();
  store.set('se.mode', mode); lobbyStatus('');
}
document.querySelector('.modes').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setLobbyMode(b.dataset.mode); });
setLobbyMode(['ai', 'mp', 'watch', 'sandbox'].includes(store.get('se.mode')) ? store.get('se.mode') : 'ai');
// desktop app: version and self-update (the app downloads updates in the background)
const upd = window.desktop?.update || null;
function showUpdate(st) {
  const pill = $('updatePill'); if (!st) return;
  if (st.current) $('appVersion').textContent = 'Version ' + st.current;
  const txt = { downloading: `Downloading update ${st.version}${st.progress ? ` (${st.progress}%)` : ''}`, ready: `Update ${st.version} ready: restart to install`, installing: 'Installing the update…', manual: `Version ${st.version} is out: ${st.note}`, error: 'Update check failed: try again' }[st.state];
  pill.hidden = !txt; if (txt) pill.textContent = txt;
  pill.className = 'pill ' + (st.state === 'ready' ? 'go' : st.state === 'error' ? 'bad' : '');
  pill.disabled = st.state === 'downloading' || st.state === 'installing';
  if (st.state === 'ready' && S.ready && !showUpdate.told) { showUpdate.told = true; hud?.toast({ text: `Update ${st.version} is ready. It installs when you restart the game (main menu).`, kind: 'info', level: 'minor' }); }
}
if (upd) {
  upd.status().then(showUpdate); upd.onStatus(showUpdate);
  $('updatePill').addEventListener('click', async () => { const st = await upd.status(); if (st.state === 'ready') { const r = await upd.install(); if (!r?.ok) lobbyStatus(r?.error || 'Could not install the update.'); } else if (st.state === 'error' || st.state === 'manual') upd.check(); });
} else window.desktop?.info?.().then((i) => { if (i?.version) $('appVersion').textContent = 'Version ' + i.version; });
const last = JSON.parse(store.get('se.session') || 'null');
if (last) { $('btnRejoin').hidden = false; $('btnRejoin').addEventListener('click', async () => { await ensureNet(); net.session = last; net.send({ t: 'rejoin', ...last }); }); }

// ------------------------------------------------------------------ messages
function onMessage(m) {
  switch (m.t) {
    case 'error': lobbyStatus(m.error); if (S.ready) hud.toast({ text: m.error, kind: 'error', level: 'major' }); if (/no longer exists|Invalid session/.test(m.error)) { store.del('se.session'); $('btnRejoin').hidden = true; } break;
    case 'joined': net.session = { match: m.match, token: m.token, spectator: !!m.spectator }; store.set('se.session', JSON.stringify(net.session)); if (m.status === 'lobby') showScreen('room'); break;
    case 'room': showScreen('room'); $('roomName').textContent = m.name; $('roomCode').textContent = m.match; $('roomSlots').innerHTML = m.slots.map((s) => `<li><span>${s.human ? (s.taken ? s.name.replace(/</g, '&lt;') : 'Waiting for player…') : `AI empire${s.personality ? ` (${s.personality})` : ''}`}</span><span class="muted">${s.human ? (s.taken ? 'ready' : 'open') : `${({ easy: 'Relaxed', normal: 'Standard', hard: 'Hard', expert: 'Expert', brutal: 'Brutal' })[s.difficulty] || 'Standard'} · ${s.fairPlay === false && s.difficulty === 'brutal' ? 'economic help' : 'fair play'}`}</span></li>`).join(''); break;
    case 'welcome': startGame(m); break;
    case 's': if (!S.ready) (S.early || (S.early = [])).push(m); else applySnapshot(m); break;   // snapshots that arrive while the renderer loads are applied once it is ready
    case 'note': onNote(m); break;
    case 'paused': setPaused(!!m.on); break;
    case 'over': gameOver(m); break;
    case 'admin': adminResult(m); break;
    case 'closed': store.del('se.session'); store.set('se.closedMsg', m.reason || 'This match was closed.'); location.reload(); break;
    default: break;
  }
}

// Map tooltips wait until the pointer settles: 0.25 s without moving faster than ~150 px/s.
// Once shown, a tooltip follows the pointer within the same hex; a new hex waits again.
const tipGate = { t: 0, x: 0, y: 0, tile: -1, timer: 0 };
function gateTooltip(tile, x, y) {
  const now = performance.now(), v = Math.hypot(x - tipGate.x, y - tipGate.y) / Math.max(1, now - tipGate.t);
  tipGate.x = x; tipGate.y = y; tipGate.t = now;
  if (tile < 0) { clearTimeout(tipGate.timer); tipGate.timer = 0; tipGate.tile = -1; hud.tooltip(-1); return; }
  const shown = !$('tooltip').hidden;
  if (shown && tile === tipGate.tile) { hud.tooltip(tile, x, y); return; }
  if (shown) hud.tooltip(-1);
  if (tile !== tipGate.tile || v > 0.15 || !tipGate.timer) {
    tipGate.tile = tile; clearTimeout(tipGate.timer);
    tipGate.timer = setTimeout(() => { tipGate.timer = 0; if (S.hover === tipGate.tile) hud.tooltip(tipGate.tile, tipGate.x, tipGate.y); }, 250);
  }
}

// Pause (single-player): the server stops the clock; the map, inspector and orders still work.
function setPaused(on) {
  S.paused = on;
  $('pausedBanner').hidden = !on;
  $('btnPause').innerHTML = on ? '&#9654;' : '&#10074;&#10074;';
  $('btnPause').title = on ? 'Resume (P)' : 'Pause the match (P)';
  $('btnPause').classList.toggle('on', on);
}
function togglePause(force) {
  if (!S.canPause) return false;
  actions.cmd({ c: 'pause', on: force == null ? !S.paused : force }).then((r) => { if (r.error) hud.toast({ text: r.error, kind: 'error', level: 'minor' }); else setPaused(!!r.paused); });
  return true;
}

async function startGame(m) {
  const first = !S.defs || S.W !== m.defs.W || (view && view.wrap !== (m.world ? m.world.wrap !== false : false));
  S.defs = m.defs; S.civId = m.civId; S.W = m.defs.W; S.H = m.defs.H;
  S.wrap = m.world ? m.world.wrap !== false : false; S.worldStyle = m.world?.style || '';
  S.canPause = !!m.canPause && !m.spectator; $('btnPause').hidden = !S.canPause; setPaused(!!m.paused);
  S.spectator = !!m.spectator; S.sandbox = !!m.sandbox; S.obs = m.spectator ? { follow: m.civId, fog: false, speed: 1 } : null;
  document.body.classList.toggle('spectating', S.spectator);
  document.body.classList.toggle('sandbox-on', S.sandbox);
  S.civInfo = m.civs.map((c) => ({ ...c }));
  const N = S.W * S.H;
  S.terr = new Uint8Array(N).fill(255); S.color = new Uint32Array(N); S.res = new Uint8Array(N); S.road = new Uint32Array(N); S.flags = new Uint8Array(N);
  S.fdir = new Int8Array(N).fill(-1); S.fb = new Uint8Array(N); S.owner = new Int8Array(N).fill(-1); S.stab = new Int8Array(N).fill(-1); S.vis = new Uint8Array(N); S.supply = new Uint8Array(N); S.urban = new Uint8Array(N); S.fw = new Map();
  for (const k of ['units', 'buildings', 'cities', 'ruins', 'cityAt', 'buildingAtTile']) S[k].clear();
  S.buildingTiles.clear(); S.selUnits.clear(); S.selBuilding = null; S.time = m.time;
  showScreen('game');
  if (first) {
    if (view) { view.app.destroy(true); $('stage').innerHTML = ''; }
    view = new View(S, $('stage'));
    await view.init();
    view.audio = audio; audio.attach(view);
    if (!hud) { hud = new Hud(S, actions); bindInput(); }
  }
  view.centerOn(m.start, S.spectator ? 0.7 : 1.15);
  S.ready = true;
  for (const m2 of S.early || []) applySnapshot(m2); S.early = null;
  hud.specbar(); hud.sandboxPanel();
  if (S.sandbox) hud.toast({ text: 'Combat sandbox: pick a scenario on the right, or spawn forces for either side and fight.', kind: 'info', level: 'minor' });
  if (S.spectator) hud.toast({ text: 'Spectating: the whole continent is revealed. Pick an empire to follow below; [ and ] cycle, P pauses, , and . change speed, V toggles that empire\'s fog.', kind: 'info', level: 'minor' });
}

function decodeBits(b64, out) {
  const bin = atob(b64); const changed = [];
  for (let i = 0; i < out.length; i++) { const v = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1; if (out[i] !== v) { out[i] = v; changed.push(i); } }
  return changed;
}

function resetMap() {
  S.terr.fill(255); S.owner.fill(-1); S.vis.fill(0); S.road.fill(0); S.res.fill(0); S.flags.fill(0); S.fdir.fill(-1); S.stab.fill(-1);
  for (const k of ['units', 'buildings', 'cities', 'ruins', 'cityAt', 'buildingAtTile']) S[k].clear();
  S.buildingTiles.clear(); S.selUnits.clear(); S.selBuilding = null; S.ruinsKey = ''; S.buildingsVersion++; S.ruinsVersion++;
  view.resetMap();
}

function applySnapshot(m) {
  if (!S.ready) return;
  if (m.reset) resetMap();
  if (m.obs) {
    const followChanged = S.obs && (S.obs.follow !== m.obs.follow);
    S.obs = m.obs;
    if (S.civId !== m.obs.follow) { S.civId = m.obs.follow; view.bordersDirty = true; hud.selHtml = ''; hud.drawerKey = ''; }
    if (followChanged) hud.specbar();
  }
  S.time = m.time;
  if (m.tiles) {
    let ownerChanged = false;
    for (const t of m.tiles) {
      const [i, terr, color, res, road, flags, fdir, fb, owner, stab] = t;
      if (S.owner[i] !== owner) ownerChanged = true;
      if (S.road[i] !== road) S.roadVersion = (S.roadVersion || 0) + 1;
      S.terr[i] = terr; S.color[i] = color; S.res[i] = res; S.road[i] = road; S.flags[i] = flags; S.fdir[i] = fdir; S.fb[i] = fb; S.owner[i] = owner; S.stab[i] = stab;
      view.dirtyTiles.add(i); view.dirtyOverlay.add(i);
    }
    if (ownerChanged || m.tiles.length > 300) view.bordersDirty = true;
    S.tilesVersion = (S.tilesVersion || 0) + 1;
    if (m.tiles.length > 600) view.overlayAll = true;
  }
  if (m.vis) for (const i of decodeBits(m.vis, S.vis)) view.dirtyOverlay.add(i);
  const seen = new Set();
  for (const a of m.units) {
    const [id, owner, type, tile, next, prog, hp, sup, flags, stance, cstat, tgt, supp, morale, vet, refit, form, det, ar, pfc] = a;
    const pf = pfc >= 0 ? S.defs.PATH_FAIL_CODES[pfc] : null;
    seen.add(id);
    // aircraft: full operational state for our own, only aloft/grounded for others
    const air = ar ? (ar.length > 1 ? { st: S.defs.AIR_STATES[ar[0]], fuel: ar[1], ammo: ar[2], mis: ar[3] >= 0 ? S.defs.MISSIONS[ar[3]] : null, mt: ar[4], svc: ar[5], rad: ar[6] || 0, grounded: ['ready', 'servicing', 'awaiting', 'landing', 'launching'].includes(S.defs.AIR_STATES[ar[0]]) } : { grounded: ar[0] === 0 }) : null;
    const u = S.units.get(id);
    if (u) Object.assign(u, { type, tile, next, prog, hp, sup, flags, owner, stance, cstat, tgt, supp, morale, vet, refit, form, det, air, pf });
    else S.units.set(id, { id, owner, type, tile, next, prog, hp, sup, flags, stance, cstat, tgt, supp, morale, vet, refit, form, det, air, pf });
  }
  for (const id of S.units.keys()) if (!seen.has(id)) { S.units.delete(id); S.selUnits.delete(id); }
  S.paths = m.paths || {};
  S.timeAt = performance.now();
  if (m.ms) { const was = S.ms?.m?.length || 0; S.ms = m.ms; if (S.ms.m.length !== was) hud.missileBanner(); }
  if (m.wx) view.wxField.ingest(m.wx);
  if (m.ev) { view.combat.ingest(m.ev, m.tick); if (!S.spectator || !S.obs || S.obs.speed !== 0) audio.combat(m.ev); }
  if (m.econ) applyEcon(m);
}

function applyEcon(m) {
  S.econ = m.econ;
  // field trenches (authoritative) and the developed city footprint
  if (m.fw) { const k = m.fw.length + ':' + m.fw.reduce((s, f) => s + f[0] * 7 + f[4] + f[5] * 3, 0); if (k !== S.fwKey) { S.fwKey = k; S.fw = new Map(m.fw.map((f) => [f[0], { t: f[0], o: f[1], type: f[2] ? 'reinforced' : 'basic', dir: f[3], p: f[4], hp: f[5], st: f[6] }])); S.fwVersion = (S.fwVersion || 0) + 1; } }
  // land that becomes (or stops being) built up is repainted: towns clear and wear their ground
  if (m.urban) { const ch = decodeBits(m.urban, S.urban); if (ch.length) { S.urbanVersion = (S.urbanVersion || 0) + 1; for (const i of ch) view.dirtyTiles.add(i); } }
  for (const i of decodeBits(m.supply, S.supply)) if (S.lens === 'supply') view.dirtyOverlay.add(i);
  const got = new Set(m.buildings.map((b) => b.id));
  let bchg = false;
  for (const [id, b] of S.buildings) if (!got.has(id) && (b.o === S.civId || S.vis[b.t])) { S.buildings.delete(id); bchg = true; }
  for (const b of m.buildings) { const o = S.buildings.get(b.id); if (!o || o.st !== b.st || o.o !== b.o) bchg = true; S.buildings.set(b.id, { ...b, rallyArmy: o?.rallyArmy }); }
  if (bchg) {
    const before = new Set(S.buildingTiles);
    S.buildingsVersion++; S.buildingAtTile.clear(); S.buildingTiles.clear(); for (const b of S.buildings.values()) { S.buildingAtTile.set(b.t, b); S.buildingTiles.add(b.t); }
    for (const t of S.buildingTiles) if (!before.delete(t)) view.dirtyTiles.add(t);
    for (const t of before) view.dirtyTiles.add(t);
  }
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
  S.campaigns = m.campaigns || null;
  S.battles = m.battles || [];
  view.combat.syncBattlefield(m.bf);
  if (hud.battleId != null) hud.battlePanel();
  view.syncBuildings(); view.syncArmies(); view.syncCampaigns();
  hud.topbar(); if (!S.spectator) hud.buildbar(); hud.selection(); hud.drawer(); hud.roadPanel(); hud.specbar();
  hud.minimap(view);
}

function onNote(m) {
  if (!S.ready) return;
  S.log.push(m); if (S.log.length > 400) S.log.shift();
  if (m.tile >= 0 && !m.quiet) view.ping(m.tile, m.radius || 2, m.level === 'critical' || m.kind === 'war' ? 0xd0533b : 0x8fd19e);
  if (!m.quiet && m.level !== 'info') { hud.toast(m); if (m.level === 'critical' || m.level === 'major') audio.ui('alert'); else if (m.kind === 'unit' || m.kind === 'build') audio.ui('done'); }
  hud.alert(m);
  if (hud.tab === 'chronicle') hud.drawer();
}

function gameOver(m) {
  $('gameover').hidden = false;
  const won = !S.spectator && m.winner && m.winner.civ === S.civId;
  $('goTitle').textContent = S.spectator ? 'The exhibition has ended' : won ? 'Your civilization endures' : 'The age has ended';
  $('goText').textContent = m.winner ? `${m.winner.name} prevails: ${m.winner.how}.` : '';
  $('goStats').innerHTML = '<tr><th>Empire</th><th>Cities</th><th>Pop</th><th>Techs</th><th>Kills</th><th>Score</th></tr>' + m.stats.map((s) => `<tr><td>${s.name}</td><td>${s.cities}</td><td>${s.pop}</td><td>${s.techs}</td><td>${s.kills}</td><td>${s.score}</td></tr>`).join('');
  store.del('se.session');
}
$('btnLobby').addEventListener('click', () => location.reload());

// ------------------------------------------------------------------ actions (all validated server-side)
const mineSel = () => [...S.selUnits].filter((id) => S.units.get(id)?.owner === S.civId);
const actions = {
  async cmd(c) {
    if (S.spectator && !['follow', 'fog', 'speed', 'aiDiag'].includes(c.c)) { hud.toast({ text: 'You are spectating: orders are disabled. Pick an empire to follow in the bar below.', kind: 'error', level: 'minor' }); return { error: 'spectating' }; }
    const r = await net.cmd(c); if (r && r.error) { hud.toast({ text: r.error, kind: 'error', level: 'minor' }); audio.ui('error'); } else if (!['workforcePreview', 'importQuote', 'roadPreview', 'follow', 'fog', 'speed'].includes(c.c)) audio.ui(c.c === 'build' || c.c === 'batchTrain' || c.c === 'train' ? 'build' : ['move', 'attack', 'withdraw', 'army'].includes(c.c) ? 'order' : 'click'); return r || {};
  },
  // spectator controls
  follow(civ, center = true) {
    actions.cmd({ c: 'follow', civ }).then((r) => {
      if (r.error) return;
      if (center) { const cap = [...S.cities.values()].find((c) => c.o === civ && c.cap) || [...S.cities.values()].find((c) => c.o === civ); if (cap) view.centerOn(cap.t); else { const u = [...S.units.values()].find((x) => x.owner === civ); if (u) view.centerOn(u.tile); } }
      hud.specbar();
    });
  },
  cycleFollow(dir) {
    const alive = S.civInfo.filter((c) => !c.rebel && c.alive !== false).map((c) => c.id); if (!alive.length) return;
    const i = alive.indexOf(S.civId); actions.follow(alive[(i + dir + alive.length) % alive.length]);
  },
  fog(on) { actions.cmd({ c: 'fog', on }).then(() => hud.specbar()); },
  speed(n) { actions.cmd({ c: 'speed', speed: n }).then((r) => { if (!r.error && S.obs) { S.obs.speed = r.speed; hud.specbar(); } }); },
  jump(tile) { if (tile >= 0) view.centerOn(tile); },
  refresh() { hud.drawer(true); },
  selectCity(id) { const c = S.cities.get(id); if (!c) return; const b = S.buildingAtTile.get(c.t); if (b) { S.selUnits.clear(); S.selBuilding = b.id; hud.cityTab = 'overview'; hud.selection(); view.syncBuildings(); } },
  async train(unit) {
    if (S.selBuilding == null) return;
    const b = S.buildings.get(S.selBuilding);
    const r = await actions.cmd({ c: 'train', building: S.selBuilding, unit, army: b?.rallyArmy || undefined });
    if (!r.error) hud.toast({ text: `Training ${S.defs.UNITS[unit].name}.`, kind: 'build', level: 'info' });
  },
  act(a, kind) {
    // from the command bar a command applies to one kind of unit in a mixed selection
    const ids = kind ? mineSel().filter((id) => { const u = S.units.get(id); return u && unitKind(S.defs, u.type) === kind; }) : mineSel();
    if (a === 'fortify') return startTrenchMode();
    if (a === 'rebuildRuin') return actions.rebuildRuin();
    if (a === 'missileBuild' && S.selBuilding != null) return actions.cmd({ c: 'missileBuild', silo: S.selBuilding }).then((r) => { if (!r.error) hud.toast({ text: `Missile project started: ready in ${r.missile.eta} s.`, kind: 'build', level: 'info' }); });
    if (a === 'missileMode') return setMode({ kind: 'missile', preview: null }, 'Strategic strike: hover a target to see the flight time and interception odds, click to launch (Escape cancels).');
    if (a === 'patrolMode') return setMode({ kind: 'airPatrol', ids }, 'Click the area to patrol: aircraft orbit it, engage what they can, and rotate home to refuel.');
    if (a === 'scoutMode') return setMode({ kind: 'airScout', ids }, 'Click the area to scout.');
    if (a === 'strikeMode') return setMode({ kind: 'airStrike', ids }, 'Click a target (unit, building or ground) to strike.');
    if (a === 'supportMode') return setMode({ kind: 'airSupport', ids }, 'Click the troops or area to support.');
    if (a === 'airReturn') return airOrder(ids, 'return');      // trenches are a construction tool now (Build -> Defenses)
    if (a === 'supply') {
      const forms = new Set(ids.map((id) => S.units.get(id)?.form).filter(Boolean));
      const c = forms.size === 1 ? { c: 'supplyRun', formation: [...forms][0], preset: hud.preset || 'auto' } : { c: 'supplyRun', units: ids.filter((id) => !S.defs.UNITS[S.units.get(id)?.type]?.civilian), preset: hud.preset || 'auto' };
      return actions.cmd(c).then((r) => { if (r.supplyRun) hud.toast({ text: `Supply truck dispatched: ${Object.entries(r.supplyRun.cargo).map(([k, v]) => `${Math.round(v)} ${S.defs.GOOD_NAMES[k].toLowerCase()}`).join(', ')}.`, kind: 'unit', level: 'info' }); });
    }
    if (a === 'spread') {
      // spread a stack over a short line through its hex, perpendicular to the threat side
      const u = S.units.get(ids[0]); if (!u) return;
      const q = u.tile % S.W, r = (u.tile / S.W) | 0, n = Math.max(2, Math.ceil(ids.length / 2));
      const a0 = r * S.W + ((q - Math.floor(n / 2) + S.W) % S.W), b0 = r * S.W + ((q + Math.ceil(n / 2)) % S.W);
      return actions.cmd({ c: 'deploy', units: ids, line: [a0, b0], density: 'spread', behavior: 'defend' });
    }
    if (a === 'stop') actions.cmd({ c: 'stop', units: ids });
    if (a === 'hold') { actions.cmd({ c: 'hold', units: ids }); hud.toast({ text: `${ids.length} unit${ids.length > 1 ? 's' : ''} holding position.`, kind: 'unit', level: 'info' }); }
    if (a === 'withdraw') { actions.cmd({ c: 'withdraw', units: ids }).then((r) => { if (!r.error) hud.toast({ text: 'Withdrawing toward the nearest friendly city.', kind: 'unit', level: 'info' }); }); }
    if (a === 'engageMode') setMode({ kind: 'engage' }, 'Click an enemy: fire is spread over the threats around it. Click ground to advance and engage.');
    if (a === 'focusMode') setMode({ kind: 'focus' }, 'Click an enemy: every selected weapon fires on it.');
    if (a === 'moveMode') setMode({ kind: 'move', ids: kind ? ids : null }, 'Click where to reposition (drag with the right button to set a battle line and facing).');
    if (a === 'defendMode') setMode({ kind: 'defendZone' }, 'Click the centre of the area to defend: the group becomes an army that holds that zone.');
    if (a === 'amove') setMode({ kind: 'attackMove', ids: kind ? ids : null }, 'Left-click a destination: units will fight anything they meet on the way.');
    if (a === 'found' || a === 'autoSettle') {
      const cols = ids.map((id) => S.units.get(id)).filter((u) => u.type === 'colonist');
      if (a === 'found') cols.slice(0, 1).forEach((s) => actions.cmd({ c: 'found', unit: s.id }));
      else { for (const s of cols) actions.cmd({ c: 'autoSettle', unit: s.id }); hud.toast({ text: 'Colonists will pick a site and settle on their own.', kind: 'city', level: 'info' }); }
    }
    if (a === 'army') actions.formArmy();
    if (a === 'demolish' && S.selBuilding != null) { actions.cmd({ c: 'demolish', id: S.selBuilding }); S.selBuilding = null; }
    if (a === 'repair' && S.selBuilding != null) actions.cmd({ c: 'repair', id: S.selBuilding });
    if (a === 'modeDefend' || a === 'modeAttack') {
      const ids = mineSel().filter((id) => !S.defs.UNITS[S.units.get(id)?.type]?.civilian);
      const stance = a === 'modeAttack' ? 'aggressive' : 'defensive';
      actions.cmd({ c: 'stance', units: ids, stance });
      for (const id of ids) { const u = S.units.get(id); if (u) u.stance = stance; }
      hud.selHtml = ''; hud.selection();
    }
    if (a === 'buildNext' && S.selBuilding != null) actions.cmd({ c: 'buildNext', id: S.selBuilding }).then((r) => { if (!r.error) hud.toast({ text: 'Moved to the front of the construction queue.', kind: 'build', level: 'info' }); });
    if (a === 'upgradeDefense' && S.selBuilding != null) actions.cmd({ c: 'upgradeDefense', id: S.selBuilding }).then((r) => { if (!r.error) hud.toast({ text: 'AA battery upgraded.', kind: 'build', level: 'info' }); });
    if (a === 'disband') actions.cmd({ c: 'disband', units: ids }).then((r) => { if (r.men) { hud.toast({ text: `${ids.length} unit${ids.length > 1 ? 's' : ''} disbanded: ${Math.round(r.back)} of ${r.men} soldiers return home as civilians.`, kind: 'city', level: 'minor' }); S.selUnits.clear(); hud.selection(); } });
  },
  async formArmy() {
    const ids = mineSel().filter((id) => !S.defs.UNITS[S.units.get(id).type].civilian);
    if (!ids.length) return hud.toast({ text: 'Select combat units first.', kind: 'error', level: 'minor' });
    const r = await actions.cmd({ c: 'army', op: 'create', units: ids });
    if (!r.error) { hud.toast({ text: `Army formed with ${ids.length} units.`, kind: 'unit', level: 'minor' }); hud.tab = ''; document.querySelector('[data-tab=armies]').click(); }
  },
  // ---- deployment, formations, fortification
  deploy(line, { queue, attackMove } = {}) {
    const o = S.deployOpts, units = mineSel();
    const attackMode = attackMove || attacking(units);
    actions.cmd({ c: 'deploy', units, line, mode: 'line', density: 'auto', depth: 'auto', behavior: attackMode ? 'attackMove' : 'defend', reverse: o.reverse, queue: !!queue })
      .then((r) => {
        const d = r.deploy; if (!d) return;
        if (d.queued) return hud.toast({ text: `Deployment queued for ${d.queued} units.`, kind: 'unit', level: 'info' });
        const parts = [`${d.placed + d.partial} deploying`]; if (d.overflow?.length) parts.push(`${d.overflow.length} did not fit (no room on that line)`); if (d.unreachable) parts.push(`${d.unreachable} cannot reach`);
        if (d.overflow?.length || d.unreachable) hud.toast({ text: `Line — ${parts.join(', ')}.`, kind: 'warning', level: 'minor' });
      });
    view.ping(line[1], 0.5, 0xf1c75b);
  },
  formationOp(op, id) {
    if (op === 'reinforce') return actions.cmd({ c: 'formation', id, op: 'reinforce', units: mineSel().filter((x) => !S.units.get(x)?.form) }).then((r) => { if (r.reinforce) hud.toast({ text: `${r.reinforce.placed} units reinforce the line${r.reinforce.overflow ? `, ${r.reinforce.overflow} found no room` : ''}.`, kind: 'unit', level: 'info' }); });
    return actions.cmd({ c: 'formation', id, op });
  },
  selectFormation(id) { const f = (S.econ?.formations || []).find((x) => x.id === id); if (!f) return; S.selUnits.clear(); for (const u of f.units) S.selUnits.add(u); S.selBuilding = null; hud.closeWorkspace(); hud.selection(); const u = S.units.get(f.units[0]); if (u) view.centerOn(u.tile); },
  // airfield inspector: missions with automatic aircraft choice, or select what is based here
  airbase(op, base) {
    if (op === 'select') { const ids = (S.econ?.air?.craft || []).filter((c) => c.home === base).map((c) => c.id); S.selUnits.clear(); S.selBuilding = null; S.selBuildings.clear(); for (const id of ids) S.selUnits.add(id); hud.selHtml = ''; hud.selection(); return; }
    const kind = { patrol: 'airPatrol', strike: 'airStrike', scout: 'airScout' }[op];
    setMode({ kind, ids: null, base }, op === 'strike' ? 'Click a target: the airfield sends suitable ready aircraft (Shift-click for more strikes).' : `Click the area to ${op}: the airfield sends its best ready aircraft.`);
  },
  async rebuildRuin() {
    const t = S.selRuin?.tile; if (t == null) return;
    const r = await actions.cmd({ c: 'rebuild', tile: t, commit: true });
    if (r.error) return hud.toast({ text: r.error, kind: 'error', level: 'minor' });
    hud.toast({ text: `${r.name} has been resettled.`, kind: 'city', level: 'major' }); S.selRuin = null; hud.selHtml = ''; hud.selection();
  },
  pickUnit(id) { S.selUnits.clear(); S.selUnits.add(id); hud.selHtml = ''; hud.selection(); },
  // trench line tool (Build -> Defenses -> Trench Line)
  trench(op, id) {
    const m = S.mode;
    if (op === 'cancel') return actions.cmd({ c: 'trenchCancel', id });
    if (!m || m.kind !== 'trench') return;
    if (op === 'close') return setMode(null);
    if (op === 'clear') { m.points = []; m.preview = null; }
    if (op === 'undo') { m.points.pop(); requestPreview(); }
    if (op === 'reverse') { m.reverse = !m.reverse; requestPreview(); }
    if (op === 'type') { m.type = id; requestPreview(); }
    if (op === 'commit' && m.preview && m.preview.build) {
      actions.cmd({ c: 'trenchPlan', points: m.points, type: m.type, reverse: m.reverse, commit: true }).then((r) => {
        if (r.started) { hud.toast({ text: `${r.trench.name}: ${r.started.placed} segment${r.started.placed === 1 ? '' : 's'} queued for construction · ${Object.entries(r.started.cost).map(([k, v]) => `${v} ${S.defs.GOOD_NAMES[k].toLowerCase()}`).join(', ')} · about ${r.started.seconds}s.`, kind: 'build', level: 'minor' }); m.points = []; m.preview = null; hud.roadPanel(); }
      });
    }
    hud.roadPanel();
  },
  // ---- preferences
  prefs() { return S.prefs; },
  pref(k, v) { S.prefs[k] = v; savePrefs(S.prefs); applyPrefs(S.prefs); syncPrefs(); },
  inBattle() { return (S.battles || []).some((b) => b.mine?.n > 0); },
  async batchTrain(unit) {
    const ids = [...S.selBuildings].filter((id) => S.buildings.get(id)?.o === S.civId);
    const per = S.batchMode === 'per';
    const n = Math.max(1, Math.min(60, S.batchCount | 0)) * (per ? ids.filter((id) => S.defs.BUILDINGS[S.buildings.get(id).ty].trains?.includes(unit)).length : 1);
    const r = await actions.cmd({ c: 'batchTrain', buildings: ids, unit, count: n, each: per ? Math.max(1, Math.min(60, S.batchCount | 0)) : 0, policy: 'partial', requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
    if (r.batch) hud.toast({ text: r.batch.text, kind: r.batch.queued < r.batch.requested ? 'warning' : 'build', level: 'minor' });
  },
  repeat(unit, only) { const ids = only || [...S.selBuildings].filter((id) => S.buildings.get(id)?.o === S.civId); actions.cmd({ c: 'repeat', buildings: ids, unit }); hud.toast({ text: unit ? `Repeat production: ${S.defs.UNITS[unit].name} whenever a queue empties (pauses when resources or manpower run low).` : 'Repeat production off.', kind: 'build', level: 'info' }); },
  async refit(type, to) {
    const ids = mineSel().filter((id) => S.units.get(id)?.type === type);
    const r = await actions.cmd({ c: 'refit', units: ids, to });
    if (r.refitted) hud.toast({ text: `${r.refitted} ${S.defs.UNITS[type].name}${r.refitted > 1 ? 's' : ''} going into the workshop to become ${S.defs.UNITS[to].name}.`, kind: 'build', level: 'minor' });
  },
  async workforce(d) {
    const b = S.buildings.get(S.selBuilding); const c = b && S.cityAt.get(b.t); if (!c) return;
    let r = {};
    if (d.wf === 'preview') { r = await actions.cmd({ c: 'workforcePreview', city: c.id, mode: d.mode }); hud.wfPreview = r.preview || null; hud.selHtml = ''; hud.selection(); return; }
    if (d.wf === 'apply') { r = await actions.cmd({ c: 'workforce', city: c.id, mode: d.mode, autoBalance: true }); hud.wfPreview = null; }
    else if (d.wf === 'prio') r = await actions.cmd({ c: 'workforce', city: c.id, prio: { [d.cat]: d.level } });
    else if (d.wf === 'lock') r = await actions.cmd({ c: 'workforce', city: c.id, building: +d.id, lock: d.n === 'null' ? null : +d.n });
    else if (d.wf === 'off') r = await actions.cmd({ c: 'workforce', city: c.id, building: +d.id, off: d.on === '1' });
    if (!r.error) setTimeout(() => { hud.selHtml = ''; hud.selection(); }, 1100);
  },
  stance(st) { actions.cmd({ c: 'stance', units: mineSel(), stance: st }); },
  policy(p) { actions.cmd({ c: 'engage', units: mineSel(), policy: p }).then(() => hud.toast({ text: `Engagement: ${S.defs.ENGAGE_POLICIES[p]}.`, kind: 'unit', level: 'info' })); S.policy = p; },
  cycleFormation() { const ks = Object.keys(S.defs.FORMATIONS); S.formation = ks[(ks.indexOf(S.formation) + 1) % ks.length]; hud.selHtml = ''; hud.selection(); hud.toast({ text: `Formation: ${S.defs.FORMATIONS[S.formation]}.`, kind: 'unit', level: 'info' }); },
  selectNear(tile, radius = 6) { S.selUnits = new Set([...S.units.values()].filter((u) => u.owner === S.civId && !S.defs.UNITS[u.type].civilian && hexDistC(u.tile, tile) <= radius).map((u) => u.id)); S.selBuilding = null; hud.selection(); },
  async sandbox(op, arg) {
    if (op === 'scenario') {
      const r = await actions.cmd({ c: 'sandbox', op: 'scenario', key: arg });
      const sc = r.scenario; if (!sc) return;
      view.centerOn(sc.arena, 1.6);
      S.selUnits = new Set(sc.A); S.selBuilding = null; hud.selection();
      hud.toast({ text: `${sc.name}: your force is selected. Right-click to attack, or right-drag a battle line.`, kind: 'info', level: 'minor' });
    }
    if (op === 'spawn') setMode({ kind: 'spawn', ...arg }, `Click to place ${arg.n} × ${S.defs.UNITS[arg.type].name} for ${arg.civ ? 'the enemy' : 'you'}.`);
    if (op === 'advance') setMode({ kind: 'sbAdvance' }, 'Click where the enemy should attack.');
    if (op === 'clear') actions.cmd({ c: 'sandbox', op: 'clear' });
  },
  battle(op, id) {
    const b = (S.battles || []).find((x) => x.id === id); if (!b) return;
    if (op === 'jump') view.centerOn(b.t);
    if (op === 'select') actions.selectNear(b.t);
    if (op === 'reinforce') { const ids = mineSel(); if (!ids.length) return hud.toast({ text: 'Select the units to send first.', kind: 'error', level: 'minor' }); orderMove(ids, b.t, true); }
    if (op === 'withdraw') { const ids = [...S.units.values()].filter((u) => u.owner === S.civId && hexDistC(u.tile, b.t) <= 6).map((u) => u.id); actions.cmd({ c: 'withdraw', units: ids }); }
    if (op === 'hold') { const ids = [...S.units.values()].filter((u) => u.owner === S.civId && hexDistC(u.tile, b.t) <= 6).map((u) => u.id); actions.cmd({ c: 'hold', units: ids }); }
    if (op === 'close') { hud.battleId = null; hud.battlePanel(); }
    if (op === 'command') hud.openWorkspace('military');
  },
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
    if (tool === 'bridge') return S.mode?.kind === 'bridge' ? setMode(null) : startBridgeMode();
    if (tool === 'trench') return S.mode?.kind === 'trench' ? setMode(null) : startTrenchMode();
    if (tool === 'clearPass') return setMode({ kind: 'clearPass' }, 'Click an impassable peak next to an engineer team or your supply network.');
    if (S.mode && S.mode.kind === 'build' && S.mode.type === type) return setMode(null);    // the palette button toggles the tool
    const m = { kind: 'build', type, tiles: null, session: { n: 0, planned: 0, cost: {} }, multi: false };
    setMode(m, `Placing: ${S.defs.BUILDINGS[type].name} — click to place · drag to paint several · Shift+drag for an area · Escape to finish.`);
    await refreshPlacement(m);
    if (S.mode === m && !m.tiles.size) $('hint').textContent = `No valid place for ${S.defs.BUILDINGS[type].name} in explored territory. Escape to finish.`;
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
  // ---- resource explanations: every button in a resource panel or shortage alert lands here
  resourceAction(a) {
    const D = S.defs;
    switch (a.a) {
      case 'research': hud.openWorkspace('research'); hud.research.sel = a.tech; hud.research.refresh(); setTimeout(() => hud.research.focus(a.tech), 60); return;
      case 'build': hud.closeWorkspace(); return actions.buildMode(a.type);
      case 'housing': hud.closeWorkspace(); return actions.buildMode('house');
      case 'find': hud.closeWorkspace(); return actions.findSites(a.type);
      case 'locate': return actions.findBuildings({ type: a.type || '', state: a.filter || 'all' });
      case 'inspect': return hud.openResource(a.good);
      case 'import': return actions.cmd({ c: 'importQuote', good: a.good, amount: 50 }).then((r) => { const q = r.quote; if (!q || q.error) return hud.toast({ text: q?.error || 'Cannot import now.', kind: 'error', level: 'minor' }); actions.cmd({ c: 'import', good: a.good, amount: q.amount }).then((x) => { if (x.bought) hud.toast({ text: `Imported ${x.bought.amount} ${D.GOOD_NAMES[a.good].toLowerCase()} for ${x.bought.credits} credits.`, kind: 'build', level: 'minor' }); }); });
      case 'expand': hud.toast({ text: 'Train a Colonist Convoy at a settlement hub and found a city next to the deposit: its territory makes the deposit yours.', kind: 'city', level: 'minor' }); return hud.openWorkspace('cities');
      case 'tax': return hud.openWorkspace('government');
      case 'diplomacy': return hud.openWorkspace('diplomacy');
      case 'road': hud.closeWorkspace(); return startRoadMode();
      case 'jump': hud.closeWorkspace(); return actions.jump(a.tile);
      case 'selectType': hud.closeWorkspace(); return selectBuildingType(a.type, false);
      case 'tab': hud.econ.tab = a.tab; return hud.drawer(true);
      default: break;
    }
  },
  // highlight where a building could go: deposits and suitable terrain (explored hexes only)
  findSites(type) {
    const D = S.defs, hint = D.SITE_HINT?.[type], tiles = [];
    for (let t = 0; t < S.W * S.H; t++) {
      if (S.terr[t] === 255 || S.buildingAtTile.has(t)) continue;
      if (hint) { if ((hint.res && hint.res.includes(S.res[t])) || (hint.terr && hint.terr.includes(S.terr[t]))) tiles.push(t); }
    }
    const own = tiles.filter((t) => S.owner[t] === S.civId), free = tiles.filter((t) => S.owner[t] < 0);
    const show = own.length ? own : free;
    S.deposits = { tiles: new Set(show), type, until: S.time + 45 };
    const name = D.BUILDINGS[type]?.name || type;
    if (!show.length) { hud.toast({ text: `No ${D.PLACE_INFO?.[D.BUILDINGS[type]?.place] || 'suitable site'} found in explored land. Explore further with scouts.`, kind: 'warning', level: 'minor' }); return; }
    const ref = view.camCenterX();
    let best = show[0], bd = Infinity; for (const t of show) { const d = Math.abs(view.near(view.cx0[t], ref) - ref) + Math.abs(view.cy[t] - (view.cam.y + view.app.screen.height / 2 / view.cam.z)); if (d < bd) { bd = d; best = t; } }
    view.centerOn(best);
    $('hint').textContent = `${show.length} ${own.length ? 'site' : 'site beyond your border'}${show.length > 1 ? 's' : ''} for a ${name} highlighted${own.length ? '' : ' (expand your territory to build there)'}. Press B to build, Esc to clear.`;
    hud.minimap(view);
  },
  findBuildings(opts) { hud.closeWorkspace(); hud.finder.open(opts); },
  refreshMinimap() { hud.minimap(view); },
  openResource(k) { hud.openResource(k); },
  placeProblem(type, t) { return placeProblemC(type, t); },
  roadType(t) { if (S.mode?.kind === 'road') { S.mode.type = t; requestPreview(); } },
  bridge(op, v) {
    const m = S.mode; if (!m || m.kind !== 'bridge') return;
    if (op === 'close') return setMode(null);
    if (op === 'cls') { m.cls = v; bridgePreview(); }
    if (op === 'clear') { m.from = -1; m.to = -1; m.preview = null; m.error = ''; }
    if (op === 'commit' && m.preview) actions.cmd({ c: 'bridgePlan', from: m.from, to: m.to, cls: m.cls, commit: true }).then((r) => { if (!r.error) { hud.toast({ text: `${S.defs.BRIDGE_CLASSES[m.cls].name} commissioned: crews start when it is funded.`, kind: 'build', level: 'minor' }); m.from = -1; m.to = -1; m.preview = null; hud.roadPanel(); } });
    hud.roadPanel();
  },
  roadAuto(on) { if (S.mode?.kind === 'road') { S.mode.auto = on; requestPreview(); } },
};
function setMode(m, hint) {
  const prev = S.mode;
  if (prev && prev.kind === 'build' && prev !== m) placementSummary(prev);     // leaving (or switching) ends the placement session
  S.mode = m; $('hint').textContent = m ? (hint || '') + (m.kind === 'build' ? '' : ' Esc to cancel.') : ''; hud.bbKey = ''; hud.buildbar(); hud.roadPanel(); hud.placePanel();
}
// one compact summary for a placement session, from the server's placement outcomes
function placementSummary(m) {
  const s = m.session; if (!s || !s.n) return;
  const D = S.defs, name = D.BUILDINGS[m.type].name;
  const cost = Object.entries(s.cost).map(([k, v]) => `${v} ${D.GOOD_NAMES[k]}`).join(', ');
  const funded = s.n - s.planned;
  hud.toast({ text: `${s.n} ${name}${s.n > 1 ? 's' : ''} ${funded ? 'placed' : 'planned'}${cost ? ` · ${cost} committed` : ''}${s.planned ? ` · ${s.planned} awaiting funds` : ''}.`, kind: 'build', level: 'minor' });
}
// hexes whose centres fall inside a screen-space box
function boxTiles(d) {
  const x0 = Math.min(d.x, d.x1), x1 = Math.max(d.x, d.x1), y0 = Math.min(d.y, d.y1), y1 = Math.max(d.y, d.y1);
  const [wx0, wy0] = view.screenToWorld(x0, y0), [wx1, wy1] = view.screenToWorld(x1, y1);
  const out = [];
  for (let wy = wy0; wy <= wy1 + 18; wy += 6) for (let wx = wx0; wx <= wx1 + 21; wx += 6) {
    const t = view.tileAt(Math.min(wx, wx1), Math.min(wy, wy1)); if (t < 0 || out.includes(t)) continue;
    const [sx, sy] = view.worldToScreen(view.cx[t], view.cy[t]); if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) out.push(t);
  }
  return out;
}
// one order for every painted hex: placed, queued for funds, or refused (with the reason counted)
async function placeMany(m) {
  const tiles = [...m.paint]; m.paint = null;
  const r = await actions.cmd({ c: 'buildMany', type: m.type, tiles });
  const x = r.many; if (!x) return;
  m.session.n += x.placed; m.session.planned += x.planned; for (const [k, v] of Object.entries(x.cost || {})) m.session.cost[k] = (m.session.cost[k] || 0) + v;
  hud.toast({ text: `${x.placed} × ${S.defs.BUILDINGS[m.type].name} placed${x.planned ? ` (${x.planned} queued until funded)` : ''}${x.failed ? ` · ${x.failed} could not go there` : ''}.`, kind: 'build', level: 'minor' });
  if (S.mode === m) { m.multi = true; refreshPlacement(m); $('hint').textContent = `Placing: ${S.defs.BUILDINGS[m.type].name} — ${m.session.n} placed · drag to paint more, Shift+drag for an area · Escape to finish.`; }
}

async function refreshPlacement(m) {
  const r = await net.cmd({ c: 'placement', type: m.type });
  if (S.mode !== m) return;
  m.tiles = new Set(r.tiles || []); m.afford = r.afford; hud.placePanel();
}
function startTrenchMode() {
  const techs = new Set(S.econ?.techs || []);
  setMode({ kind: 'trench', points: [], preview: null, type: techs.has('fortification') ? 'reinforced' : 'basic', reverse: false }, 'Trench Line: drag across the map or click waypoints. Enter builds, Backspace undoes a point.');
}
function startRoadMode() {
  const techs = new Set(S.econ?.techs || []);
  const best = [3, 2, 1].find((t) => !S.defs.ROAD_TYPES[t].tech || techs.has(S.defs.ROAD_TYPES[t].tech)) || 1;
  setMode({ kind: 'road', points: [], preview: null, type: best, auto: true }, 'Drag to sketch a road or click waypoints.');
}
// Bridge tool: click one bank, then the other; the server finds the crossing and prices it
function startBridgeMode() {
  const techs = new Set(S.econ?.techs || []);
  const cls = techs.has('civil_engineering') ? 'road' : 'timber';
  setMode({ kind: 'bridge', from: -1, to: -1, cls, preview: null }, 'Bridge: click one bank of the river or strait, then the other. Enter builds.');
}
async function bridgePreview() {
  const m = S.mode; if (!m || m.kind !== 'bridge' || m.from < 0 || m.to < 0) return;
  const r = await net.cmd({ c: 'bridgePlan', from: m.from, to: m.to, cls: m.cls });
  if (S.mode !== m) return;
  m.preview = r.plan || null; m.error = r.plan ? '' : r.error || ''; hud.roadPanel();
}
let previewTimer = null;
function requestPreview() {
  const m = S.mode; if (!m || (m.kind !== 'road' && m.kind !== 'trench')) return;
  clearTimeout(previewTimer);
  if (m.points.length < (m.kind === 'trench' ? 1 : 2)) { m.preview = null; hud.roadPanel(); return; }
  previewTimer = setTimeout(async () => {
    if (m.kind === 'trench') { const r = await net.cmd({ c: 'trenchPlan', points: m.points, type: m.type, reverse: m.reverse }); if (S.mode === m && r.trench) { m.preview = r.trench; hud.roadPanel(); } return; }
    const r = await net.cmd({ c: 'roadPlan', tiles: m.points, type: m.type, auto: m.auto });
    if (S.mode === m && r.plan) { m.preview = r.plan; hud.roadPanel(); }
  }, 120);
}

// ------------------------------------------------------------------ input
function bindInput() {
  const cv = view.app.canvas;
  let drag = null, pan = null, stroke = null, rdrag = null;
  const keys = new Set();
  // a precision recentre moved the camera by whole world periods: keep drag anchors on the same copy
  view.onRecenter = (shift) => { if (S.deploy?.anchorX != null) S.deploy.anchorX -= shift; if (rdrag) rdrag.wx -= shift; if (pan) pan.cx -= shift; };
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const ae = document.activeElement; if (ae && ae !== document.body && ae.blur) ae.blur();   // the map keeps keyboard focus after a click on it
    if (e.button === 1) { pan = { x: e.clientX, y: e.clientY, cx: view.cam.x, cy: view.cam.y }; view.panning = true; return; }   // Alt-drag now box-selects buildings
    if (e.button === 0 && (S.mode?.kind === 'road' || S.mode?.kind === 'trench')) { stroke = { x: e.offsetX, y: e.offsetY, moved: false, start: S.mode.points.length }; return; }
    if (e.button === 0) { drag = { x: e.offsetX, y: e.offsetY, x1: e.offsetX, y1: e.offsetY }; lastDown = { x: e.offsetX, y: e.offsetY, u: view.unitAtScreen(e.offsetX, e.offsetY) }; }
    if (e.button === 2) { const [wx, wy] = view.screenToWorld(e.offsetX, e.offsetY); rdrag = { x: e.offsetX, y: e.offsetY, wx, wy, tile: view.tileAt(wx, wy), moved: false }; }
  });
  cv.addEventListener('pointermove', (e) => {
    if (pan) { view.cam.x = pan.cx - (e.clientX - pan.x) / view.cam.z; view.cam.y = pan.cy - (e.clientY - pan.y) / view.cam.z; view.clamp(); return; }
    const [wx, wy] = view.screenToWorld(e.offsetX, e.offsetY);
    const hv = view.tileAt(wx, wy);
    if (hv !== S.hover) { const was = S.hover; S.hover = hv; if (S.mode?.kind === 'build') hud.placePanel(); for (const t of [was, hv]) { const b = S.buildingAtTile.get(t); if (b) view.buildingSprite(b); } }
    if (rdrag) {
      if (Math.hypot(e.offsetX - rdrag.x, e.offsetY - rdrag.y) > 14 && mineSel().length && !S.spectator) rdrag.moved = true;
      if (rdrag.moved) { rdrag.end = view.tileAt(wx, wy); updateDeployPreview(rdrag.tile, rdrag.end, e.altKey, rdrag.wx); }   // continuous drag coordinates: the preview stays anchored where the drag began
      return;
    }
    if (!drag && !stroke) { const hu = view.unitAtScreen(e.offsetX, e.offsetY); S.hoverUnit = hu ? hu.id : null; }
    if (stroke && S.hover >= 0) {
      // freehand road sketch: every hex the cursor crosses becomes a waypoint
      if (Math.hypot(e.offsetX - stroke.x, e.offsetY - stroke.y) > 6) stroke.moved = true;
      const pts = S.mode.points;
      if (stroke.moved && pts[pts.length - 1] !== S.hover) { pts.push(S.hover); if (S.mode.kind === 'road') S.mode.auto = false; requestPreview(); }
    }
    gateTooltip(drag || stroke ? -1 : S.hover, e.offsetX, e.offsetY);
    if (drag && S.mode?.kind === 'build') {
      // drag placement: paint every valid hex the cursor crosses; Shift+drag: fill the box
      drag.x1 = e.offsetX; drag.y1 = e.offsetY;
      if (Math.hypot(drag.x1 - drag.x, drag.y1 - drag.y) > 6) {
        const m = S.mode; m.paint = m.paint || new Set();
        if (e.shiftKey) { m.paint = new Set(boxTiles(drag).filter((t) => !m.tiles || m.tiles.has(t))); drawBox(drag); }
        else { view.selG.clear(); if (hv >= 0 && (!m.tiles || m.tiles.has(hv))) m.paint.add(hv); }
        $('hint').textContent = `${S.defs.BUILDINGS[m.type].name}: ${m.paint.size} to place · release to build`;
      }
      return;
    }
    if (drag) { drag.x1 = e.offsetX; drag.y1 = e.offsetY; drawBox(drag); }
  });
  cv.addEventListener('pointerleave', () => { S.hover = -1; gateTooltip(-1); });
  cv.addEventListener('pointerup', (e) => {
    if (pan) { pan = null; view.panning = false; return; }
    if (rdrag && e.button === 2) {
      const r = rdrag; rdrag = null;
      if (r.moved && S.deploy) {
        const [wx, wy] = view.screenToWorld(e.offsetX, e.offsetY);
        const b = view.tileAt(wx, wy);
        if (r.tile >= 0 && b >= 0 && !r.cancelled) actions.deploy([r.tile, b], { queue: e.shiftKey, attackMove: e.altKey });
        S.deploy = null; hud.deployBar();
        return;
      }
      S.deploy = null; S.dragLine = null;
      if (r.cancelled) return;
      rightClick(e); return;
    }
    if (stroke) { const s = stroke; stroke = null; if (!s.moved && S.hover >= 0) { S.mode.points.push(S.hover); requestPreview(); hud.roadPanel(); } return; }
    if (!drag || e.button !== 0) return;
    const d = drag; drag = null; view.selG.clear();
    if (S.mode?.kind === 'build' && S.mode.paint?.size) { placeMany(S.mode); return; }
    if (Math.hypot(d.x1 - d.x, d.y1 - d.y) > 6 && !S.mode) return e.altKey ? boxSelectBuildings(d, e.shiftKey) : boxSelect(d, e.shiftKey);
    leftClick(e);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) view.zoomAt(Math.exp(-e.deltaY * 0.01), e.offsetX, e.offsetY);
    else if (e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY))) view.zoomAt(e.deltaY > 0 ? 0.88 : 1.14, e.offsetX, e.offsetY);
    else { view.cam.x += e.deltaX / view.cam.z; view.cam.y += e.deltaY / view.cam.z; view.clamp(); }
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;   // typing never triggers shortcuts
    if (S.spectator) {
      const k0 = e.key;
      if (k0 === '[' || k0 === ']') { actions.cycleFollow(k0 === ']' ? 1 : -1); return; }
      if (k0.toLowerCase() === 'p') { actions.speed(S.obs?.speed ? 0 : 1); return; }
      if (k0 === ',' || k0 === '.') { const sp = [0, 1, 2, 4, 8]; const i = Math.max(0, sp.indexOf(S.obs?.speed ?? 1)); actions.speed(sp[Math.max(0, Math.min(sp.length - 1, i + (k0 === '.' ? 1 : -1)))]); return; }
      if (k0.toLowerCase() === 'v') { actions.fog(!S.obs?.fog); return; }
    }
    if (controlGroupKey(e)) return;
    const k = e.key.toLowerCase();
    if (!e.ctrlKey && !e.metaKey && !e.altKey) keys.add(k);   // held keys pan the camera
    if (['w', 'a', 's', 'd'].includes(k) && !e.ctrlKey && !e.metaKey) return;   // WASD always pans the camera, whatever is selected
    if (e.repeat && !['=', '+', '-'].includes(k)) return;   // a held key never repeats an order
    if (S.spectator && ['f', 'g', 'r'].includes(k)) return;
    if (k === 'p' && !e.ctrlKey && !e.metaKey && togglePause()) return;
    if (k === 'tab' && rdrag && S.deploy) { e.preventDefault(); S.deployOpts.reverse = !S.deployOpts.reverse; updateDeployPreview(rdrag.tile, rdrag.end, false, rdrag.wx); return; }
    if (k === 'escape') {
      if (rdrag && S.deploy) { rdrag.cancelled = true; S.deploy = null; hud.deployBar(); return; }
      if (!$('menu').hidden) { $('menu').hidden = true; if (S.menuPaused) { S.menuPaused = false; togglePause(false); } return; }
      if (S.mode) { setMode(null); return; }
      if (S.deposits || S.findIds) { S.deposits = null; S.findIds = null; $('hint').textContent = ''; hud.minimap(view); return; }
      if (hud.escape()) return;
      if (S.selUnits.size || S.selBuilding != null) { S.selUnits.clear(); S.selBuilding = null; S.selBuildings.clear(); hud.selection(); return; }
    }
    if ((k === '/' || (k === 'k' && (e.ctrlKey || e.metaKey)))) { e.preventDefault(); openSearch(); return; }
    if (k === 't' && !e.ctrlKey && !e.metaKey) { hud.ws === 'research' ? hud.closeWorkspace() : hud.openWorkspace('research'); return; }
    if (k === 'b' && !e.ctrlKey && !e.metaKey && !S.spectator) { hud.toggleBuild(); return; }
    if (k === 'a' && (e.ctrlKey || e.metaKey) && S.selUnits.size) { e.preventDefault(); actions.act('amove'); return; }   // Ctrl/Cmd+A: attack-move
    if (k === 'f') { if (mineSel().some((id) => S.units.get(id)?.type === 'colonist')) actions.act('found'); else if (S.selUnits.size) actions.cycleFormation(); }
    if (k === 'q' && !e.ctrlKey && !e.metaKey && !S.spectator) { selectArmy(!e.shiftKey); return; }   // Q: every combat unit on screen (Shift: whole map)
    if (k === 'e' && S.selUnits.size && !S.spectator) { actions.act('amove'); return; }               // E: attack-move to the next click
    if (k === 'h' && S.selUnits.size) actions.act('hold');
    if (k === 'x' && S.selUnits.size) actions.act('withdraw');
    if (k === 'g' && S.selUnits.size) actions.formArmy();
    if (k === 'r') startRoadMode();
    if (k === ' ') { const u = S.units.get([...S.selUnits][0]); if (u) view.centerOn(u.tile); else { const c = [...S.cities.values()].find((x) => x.o === S.civId && x.cap); if (c) view.centerOn(c.t); } e.preventDefault(); }
    if (k === '=' || k === '+') view.zoomAt(1.15, view.app.screen.width / 2, view.app.screen.height / 2);
    if (k === '-') view.zoomAt(0.87, view.app.screen.width / 2, view.app.screen.height / 2);
    if (k === 'k') hud.toggleKey();
    if (k === 'm') $('btnSound').click();
    if (k === 'l') { const order = ['terrain', 'territory', 'stability', 'traffic', 'front', 'tactical']; setLens(order[(order.indexOf(S.lens) + 1) % order.length]); }
    if (k === 'backspace' && S.mode?.kind === 'road') actions.road('undo');
    if (k === 'enter' && S.mode?.kind === 'road') actions.road('commit');
    if (k === 'enter' && S.mode?.kind === 'bridge') actions.bridge('commit');
    if (k === 'backspace' && S.mode?.kind === 'trench') actions.trench('undo');
    if (k === 'enter' && S.mode?.kind === 'trench') actions.trench('commit');
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());   // never keep panning after the window loses focus
  let layoutT = 0, uiTick = 0, mmTick = 0;
  S.onFrame = (dt) => {
    const sp = (600 * dt) / view.cam.z;
    if (keys.has('arrowleft') || keys.has('a')) view.cam.x -= sp;
    if (keys.has('arrowright') || keys.has('d')) view.cam.x += sp;
    if (keys.has('arrowup') || keys.has('w')) view.cam.y -= sp;
    if (keys.has('arrowdown') || keys.has('s')) view.cam.y += sp;
    view.clamp();
    hud.clock(S.time, net?.rtt);
    layoutT += dt; if (layoutT > 0.1) { layoutT = 0; hud.layoutPanels(); }
    uiTick += dt; if (uiTick > 0.5) { uiTick = 0; hud.selection(); hud.deployBar(); pollDiagnostics(); }
    mmTick += dt; if (mmTick > 1) { mmTick = 0; hud.minimap(view); }
  };
  $('minimap').addEventListener('pointerdown', (e) => { const mm = (ev) => { const cvs = $('minimap'); let x = (ev.offsetX / cvs.clientWidth) * view.pw; const y = (ev.offsetY / cvs.clientHeight) * view.ph; if (view.wrap) x = view.near(x, view.camCenterX()); view.cam.x = x - view.app.screen.width / 2 / view.cam.z; view.cam.y = y - view.app.screen.height / 2 / view.cam.z; view.clamp(); }; mm(e); const mv = (ev) => mm(ev); e.target.addEventListener('pointermove', mv); window.addEventListener('pointerup', () => e.target.removeEventListener('pointermove', mv), { once: true }); });
  document.querySelectorAll('.lenses button').forEach((b) => b.addEventListener('click', () => { setLens(b.dataset.lens); $('lensPop').hidden = true; }));
  $('lensBtn').addEventListener('click', () => { $('lensPop').hidden = !$('lensPop').hidden; });
  // minimap: compact -> expanded -> hidden (a small button brings it back)
  $('mmSize').addEventListener('click', () => { const order = ['compact', 'expanded', 'hidden']; actions.pref('minimap', order[(order.indexOf(S.prefs.minimap) + 1) % 3]); $('mmShow').hidden = S.prefs.minimap !== 'hidden'; });
  $('mmShow').addEventListener('click', () => { actions.pref('minimap', 'compact'); $('mmShow').hidden = true; });
  $('mmShow').hidden = S.prefs.minimap !== 'hidden';
  // search palette
  $('btnSearch').addEventListener('click', openSearch);
  $('searchInput').addEventListener('input', (e) => renderSearch(e.target.value));
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); searchSel = Math.max(0, Math.min(searchList.length - 1, searchSel + (e.key === 'ArrowDown' ? 1 : -1))); [...$('searchResults').children].forEach((li, i) => li.classList.toggle('on', i === searchSel)); }
    else if (e.key === 'Enter') { const r = searchList[searchSel]; $('search').hidden = true; if (r) r.go(); }
    else if (e.key === 'Escape') { $('search').hidden = true; }
  });
  $('searchResults').addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (!li) return; $('search').hidden = true; searchList[+li.dataset.i]?.go(); });
  $('search').addEventListener('click', (e) => { if (e.target.id === 'search') $('search').hidden = true; });
  // preferences
  for (const el of document.querySelectorAll('[data-pref]')) el.addEventListener('input', () => { const k = el.dataset.pref; actions.pref(k, el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value); });
  // deployment toolbar
  $('deployBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dopt]'); if (!b) return;
    const k = b.dataset.dopt, v = b.dataset.v;
    if (k === 'reverse') S.deployOpts[k] = !S.deployOpts[k]; else S.deployOpts[k] = v;
    hud.deployBar(true);
  });
  applyPrefs(S.prefs); syncPrefs();
  // building finder: classes first, then every building type
  const fsel = $('findType');
  const classes = { 'class:milprod': 'Military production', 'class:defense': 'Defenses', 'class:power': 'Power', 'class:research': 'Research', 'class:industry': 'Industry', 'class:food': 'Food', 'class:logistics': 'Logistics' };
  fsel.innerHTML = '<option value="">Find…</option>' + Object.entries(classes).map(([k, n]) => `<option value="${k}">${n}</option>`).join('') + '<option disabled>──────────</option>' + Object.entries(S.defs.BUILDINGS).filter(([k, d]) => !d.rebelOnly && k !== 'town').map(([k, d]) => `<option value="${k}">${d.name}</option>`).join('');
  fsel.addEventListener('change', () => { S.find = fsel.value || null; hud.minimap(view); fsel.blur(); });
  $('btnMenu').addEventListener('click', () => {
    $('menu').hidden = false;
    // in single player the menu really pauses; elsewhere the world keeps moving
    $('menuTitle').textContent = S.canPause ? 'Paused' : 'Menu';
    $('menuNote').textContent = S.canPause ? 'The match is paused while this menu is open.' : 'The world keeps moving while this menu is open.';
    if (S.canPause && !S.paused) { S.menuPaused = true; togglePause(true); }
  });
  $('btnPause').addEventListener('click', () => togglePause());
  const syncSound = () => { for (const el of document.querySelectorAll('[data-vol]')) { const k = el.dataset.vol; if (k === 'muted') el.checked = audio.settings.muted; else el.value = audio.settings[k]; } $('btnSound').classList.toggle('off', audio.settings.muted); };
  for (const el of document.querySelectorAll('[data-vol]')) el.addEventListener('input', () => { const k = el.dataset.vol; audio.set(k, k === 'muted' ? el.checked : el.value); syncSound(); });
  $('btnSound').addEventListener('click', () => { audio.unlock(); audio.set('muted', !audio.settings.muted); syncSound(); });
  syncSound();
  $('btnResume').addEventListener('click', () => { $('menu').hidden = true; if (S.menuPaused) { S.menuPaused = false; togglePause(false); } });
  $('btnSurrender').addEventListener('click', () => { actions.cmd({ c: 'surrender' }); $('menu').hidden = true; });
  $('btnQuit').addEventListener('click', () => { store.del('se.session'); location.reload(); });
}

function setLens(l) { S.lens = l; view.overlayAll = true; document.querySelectorAll('.lenses button').forEach((b) => b.classList.toggle('on', b.dataset.lens === l)); $('lensName').textContent = { terrain: 'Terrain', territory: 'Borders', supply: 'Supply', stability: 'Stability', traffic: 'Traffic', tactical: 'Tactical', front: 'Front lines' }[l] || l; hud.minimap(view);
  // one line saying how to read the view (none for plain terrain)
  const key = { territory: 'Each empire’s land in its colour.', stability: 'Red: unrest · amber: uneasy · green: content.', traffic: 'Brighter: busier roads and freight.', front: 'Red: the front · gold dashes: suggested lines (click to dig) · green/red hexes: trenches.', tactical: 'Lines: formations · circles: objectives · red rings: units in trouble.' }[l] || '';
  const el = $('lensKey'); if (el) { el.textContent = key; el.hidden = !key; } }
// why a hex cannot take a building (client-side mirror of the server's placement rules, for the hint)
function placeProblemC(type, t) {
  const D = S.defs, def = D.BUILDINGS[type];
  if (S.terr[t] === 255) return 'unexplored';
  if (D.TERRAIN[S.terr[t]]?.water) return 'water';
  const b = S.buildingAtTile.get(t); if (b) return `occupied by a ${D.BUILDINGS[b.ty]?.name || 'building'}`;
  const r = S.ruins.get(t); if (r && r.type !== type) return 'ruins must be cleared first';
  if (!def.anywhere && S.owner[t] !== S.civId) return 'outside your territory';
  if (def.anywhere && S.owner[t] >= 0 && S.owner[t] !== S.civId) return 'foreign territory';
  if (!Number.isFinite(D.TERRAIN[S.terr[t]]?.move)) return 'impassable terrain';
  if (type === 'house') return 'needs flat ground (or the city has reached its housing-block limit)';
  return `needs ${D.PLACE_INFO?.[def.place] || 'a suitable hex'}`;
}
function drawBox(d) { const g = view.selG; g.clear(); g.rect(Math.min(d.x, d.x1), Math.min(d.y, d.y1), Math.abs(d.x1 - d.x), Math.abs(d.y1 - d.y)).fill({ color: 0xf1c75b, alpha: 0.08 }).stroke({ width: 1, color: 0xf1c75b, alpha: 0.8 }); }

// Selected buildings: S.selBuildings holds them all; S.selBuilding stays the primary one so every
// single-building panel and action keeps working.
function setBuildings(ids, add) {
  if (!add) S.selBuildings.clear();
  for (const id of ids) S.selBuildings.add(id);
  S.selBuilding = S.selBuildings.size ? [...S.selBuildings][0] : null;
  hud.cityTab = 'overview'; hud.selHtml = ''; hud.selection(); view.syncBuildings();
}
function boxSelectBuildings(d, add) {
  if (!add) S.selUnits.clear();
  const x0 = Math.min(d.x, d.x1), x1 = Math.max(d.x, d.x1), y0 = Math.min(d.y, d.y1), y1 = Math.max(d.y, d.y1);
  const ids = [];
  for (const b of S.buildings.values()) { if (b.o !== S.civId) continue; const [sx, sy] = view.worldToScreen(view.cx[b.t], view.cy[b.t]); if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(b.id); }
  setBuildings(ids, add);
}
function selectBuildingType(type, onScreenOnly) {
  const sw = view.app.screen.width, sh = view.app.screen.height, ids = [];
  for (const b of S.buildings.values()) {
    if (b.o !== S.civId || b.ty !== type || !b.d) continue;
    if (onScreenOnly) { const [x, y] = view.worldToScreen(view.cx[b.t], view.cy[b.t]); if (x < 0 || y < 0 || x > sw || y > sh) continue; }
    ids.push(b.id);
  }
  setBuildings(ids, false);
}

function boxSelect(d, add) {
  if (!add) { S.selUnits.clear(); S.selBuilding = null; S.selBuildings.clear(); }
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
  // Front Lines view: a click on a suggested defensive line opens the trench tool along it
  if (!m && S.lens === 'front' && !S.spectator) {
    const sg = view.suggestionAt(wx, wy);
    if (sg) { startTrenchMode(); S.mode.points = [sg.a, sg.b]; requestPreview(); hud.roadPanel(); return; }
  }
  if (m) {
    if (tile < 0) return;
    if (m.kind === 'build') {
      // invalid hexes never end the tool: say why and stay in placement
      if (m.tiles && !m.tiles.has(tile)) { const why = placeProblemC(m.type, tile); $('hint').textContent = `Cannot place here: ${why}. Drag to paint several · Escape to finish.`; audio.ui('error'); return; }
      if (e.shiftKey) m.multi = true;          // once several are being placed, releasing Shift does not end the session
      const r = await actions.cmd({ c: 'build', type: m.type, tile, plan: true });
      if (!r.error && r.built) { m.session.n++; if (r.built.planned) m.session.planned++; for (const [k, v] of Object.entries(r.built.cost || {})) m.session.cost[k] = (m.session.cost[k] || 0) + v; }
      if (S.mode !== m) return;
      if (m.multi) { refreshPlacement(m); $('hint').textContent = `Placing: ${S.defs.BUILDINGS[m.type].name} — ${m.session.n} placed · Shift-click to place more · Escape to finish.`; }
      else if (!r.error) setMode(null);
      return;
    }
    if (m.kind === 'missile') {
      // two-step: the first click previews (odds, flight), a second click on the same hex launches
      if (m.armed !== tile) {
        const r = await actions.cmd({ c: 'missileLaunch', tile });
        const p = r.missile; if (!p) return hud.toast({ text: r.error, kind: 'error', level: 'minor' });
        m.armed = tile;
        $('hint').textContent = !p.inRange ? 'Out of range of any stocked silo.' : `Flight ${p.eta} s · ${p.interceptors ? `${p.interceptors} known interceptors: about ${Math.round(p.odds * 100)}% chance it is stopped` : 'no known missile defenses'}${p.war && p.war !== 'war' ? ' · NOT AT WAR with this nation' : ''} — click the same hex again to LAUNCH.`;
        view.ping(tile, 2, 0xff5a3c); return;
      }
      const r = await actions.cmd({ c: 'missileLaunch', tile, commit: true });
      if (r.error) hud.toast({ text: r.error, kind: 'error', level: 'minor' });
      setMode(null); return;
    }
    if (m.kind === 'clearPass') { await actions.cmd({ c: 'clearPass', tile }); setMode(null); return; }
    if (m.kind === 'bridge') { if (m.from < 0 || m.to >= 0) { m.from = tile; m.to = -1; m.preview = null; } else { m.to = tile; bridgePreview(); } hud.roadPanel(); return; }
    if (m.kind === 'attackMove') { orderMove(m.ids || mineSel(), tile, true); setMode(null); return; }
    if (m.kind === 'move') { orderMove(m.ids || mineSel(), tile, false); setMode(null); return; }
    if (m.kind === 'airPatrol' || m.kind === 'airScout' || m.kind === 'airStrike' || m.kind === 'airSupport') {
      const mk = { airPatrol: 'patrol', airScout: 'scout', airStrike: 'strike', airSupport: 'support' }[m.kind];
      let target = null;
      if (mk === 'strike' || mk === 'support') {
        const tu = view.unitAtScreen(e.offsetX, e.offsetY, (u) => (mk === 'strike' ? u.owner !== S.civId : u.owner === S.civId));
        const tb = S.buildingAtTile.get(tile);
        target = tu ? { kind: 'unit', id: tu.id } : mk === 'strike' && tb && tb.o !== S.civId ? { kind: 'building', id: tb.id } : null;
      }
      airOrder(m.ids, mk, tile, target, m.base);
      if (!(e.shiftKey && m.base != null)) setMode(null);
      return;
    }
    if (m.kind === 'spawn') { actions.cmd({ c: 'sandbox', op: 'spawn', civ: m.civ, type: m.type, n: m.n, tile }); if (!e.shiftKey) setMode(null); return; }
    if (m.kind === 'sbAdvance') { actions.cmd({ c: 'sandbox', op: 'advance', tile }); view.ping(tile, 1, 0xd0533b); setMode(null); return; }
    if (m.kind === 'engage' || m.kind === 'focus') {
      const tu = view.unitAtScreen(e.offsetX, e.offsetY, (u) => u.owner !== S.civId);
      const tb = S.buildingAtTile.get(tile);
      const target = tu ? { kind: 'unit', id: tu.id } : tb && tb.o !== S.civId ? { kind: 'building', id: tb.id } : null;
      if (target) attackTarget(target, m.kind === 'focus', tu ? tu.tile : tile);
      else if (m.kind === 'engage') orderMove(mineSel(), tile, true);
      else return hud.toast({ text: 'Click an enemy unit or building.', kind: 'error', level: 'minor' });
      setMode(null); return;
    }
    if (m.kind === 'defendZone') {
      const ids = mineSel().filter((id) => !S.defs.UNITS[S.units.get(id).type].civilian);
      actions.cmd({ c: 'army', op: 'create', units: ids }).then((r) => { const id = r.army ?? r.id; if (id != null) actions.cmd({ c: 'army', op: 'order', id, kind: 'defend', tile, radius: 4 }); });
      view.ping(tile, 4, 0x8fd19e); setMode(null); return;
    }
    if (m.kind === 'armyOrder') { actions.cmd({ c: 'army', op: 'order', id: m.id, kind: m.op, tile, radius: 4 }); view.ping(tile, m.op === 'defend' ? 4 : 1, 0xf1c75b); setMode(null); return; }
    if (m.kind === 'rallyAll') { actions.cmd({ c: 'rallyAll', tile }); view.ping(tile, 1, 0x8fe0a8); setMode(null); return; }
  }
  // units first (a unit standing on a building is selected, not the building); a moving unit is also
  // found where it was when the button went down
  let u = (lastDown?.u && S.units.has(lastDown.u.id) ? lastDown.u : null) || view.unitAtScreen(e.offsetX, e.offsetY);
  // a stack badge selects the whole stack of our units on that hex
  const badge = !u ? view.badgeAtScreen(e.offsetX, e.offsetY) : null;
  if (badge && badge.owner === S.civId && !S.spectator) {
    if (!e.shiftKey) { S.selUnits.clear(); S.selBuilding = null; S.selBuildings.clear(); }
    for (const x of S.units.values()) if (x.owner === S.civId && (x.tile === badge.tile || x.next === badge.tile) && !S.defs.UNITS[x.type].air) S.selUnits.add(x.id);
    hud.selHtml = ''; hud.selection(); return;
  }
  if (!u && badge) u = [...S.units.values()].find((x) => x.tile === badge.tile) || null;
  // pointerup carries no reliable click count, so double-clicks are tracked explicitly
  const now = performance.now();
  const hb = !u && tile >= 0 ? S.buildingAtTile.get(tile) : null;
  const ckey = u ? u.type : hb ? 'b:' + hb.ty : null;
  const dbl = lastClick && now - lastClick.t < 500 && Math.hypot(e.offsetX - lastClick.x, e.offsetY - lastClick.y) < 10 && ckey && lastClick.type === ckey;
  lastClick = { t: now, x: e.offsetX, y: e.offsetY, type: ckey };
  // buildings: double-click = every one of that type on screen (Ctrl/Cmd: all), Shift-click = add/remove
  if (hb && hb.o === S.civId && !S.spectator) {
    S.selUnits.clear();
    if (dbl) { selectBuildingType(hb.ty, !(e.ctrlKey || e.metaKey)); lastClick = null; return; }
    if (e.shiftKey) { if (S.selBuildings.has(hb.id)) S.selBuildings.delete(hb.id); else S.selBuildings.add(hb.id); setBuildings([], true); return; }
  }
  if (!e.shiftKey && !dbl) { S.selUnits.clear(); S.selBuilding = null; S.selBuildings.clear(); }
  if (!u && !e.shiftKey) { const bt = view.combat.battleAt(e.offsetX, e.offsetY); if (bt) { hud.battleId = bt.id; hud.battlePanel(); return; } }
  if (u) {
    if (dbl && u.owner === S.civId) { if (!e.shiftKey) S.selUnits.clear(); selectType(u.type, !(e.ctrlKey || e.metaKey)); lastClick = null; }
    else S.selUnits.add(u.id);
  } else if (tile >= 0) {
    const b = S.buildingAtTile.get(tile);
    if (b) { S.selBuildings.clear(); S.selBuildings.add(b.id); S.selBuilding = b.id; hud.cityTab = 'overview'; }
    else if (S.ruins.get(tile)?.type === 'town' && !S.spectator) {
      // town ruins: offer to resettle them
      S.selRuin = { tile, preview: null };
      actions.cmd({ c: 'rebuild', tile }).then((r) => { if (S.selRuin && S.selRuin.tile === tile) { S.selRuin.preview = r.rebuild || { ok: false, why: r.error }; hud.selHtml = ''; hud.selection(); } });
    }
  }
  if (!(tile >= 0 && S.ruins.get(tile)?.type === 'town' && !S.buildingAtTile.get(tile))) S.selRuin = null;
  hud.selHtml = ''; hud.selection();
  view.syncBuildings();
}
let lastClick = null, lastDown = null;

// the army at a keypress: every ground combat unit of ours on screen (or everywhere)
function selectArmy(onScreenOnly) {
  const D = S.defs, sw = view.app.screen.width, sh = view.app.screen.height;
  S.selUnits.clear(); S.selBuilding = null; S.selBuildings.clear();
  for (const o of S.units.values()) {
    const d = D.UNITS[o.type]; if (o.owner !== S.civId || d.civilian || d.air || d.engineer) continue;
    if (onScreenOnly) { const s = view.unitSprites.get(o.id); if (!s) continue; const [x, y] = view.worldToScreen(s.dx, s.dy); if (x < 0 || y < 0 || x > sw || y > sh) continue; }
    S.selUnits.add(o.id);
  }
  hud.selHtml = ''; hud.selection();
  if (!S.selUnits.size) hud.toast({ text: onScreenOnly ? 'No combat units on screen (Shift+Q: the whole army).' : 'You have no combat units.', kind: 'info', level: 'minor' });
}
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
  if (e.ctrlKey || e.metaKey) {
    if (!mineSel().length && S.selBuildings.size) { groups[k] = { buildings: [...S.selBuildings] }; hud.toast({ text: `Group ${k}: ${S.selBuildings.size} buildings.`, kind: 'build', level: 'info' }); }
    else { groups[k] = mineSel(); hud.toast({ text: `Group ${k}: ${groups[k].length} units.`, kind: 'build', level: 'info' }); }
    e.preventDefault(); return true;
  }
  if (groups[k] && groups[k].buildings) {
    const bids = groups[k].buildings.filter((id) => S.buildings.has(id)); if (!bids.length) return true;
    S.selUnits.clear(); setBuildings(bids, e.shiftKey);
    const now = performance.now(); if (lastGroupKey.k === k && now - lastGroupKey.t < 400) view.centerOn(S.buildings.get(bids[0]).t);
    lastGroupKey = { k, t: now }; return true;
  }
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
  if (S.spectator) return;   // spectators look, they do not command
  const [wx, wy] = view.screenToWorld(e.offsetX, e.offsetY);
  const tile = view.tileAt(wx, wy); if (tile < 0) return;
  if (S.mode) { if (S.mode.kind === 'road' && S.mode.points.length) { S.mode.points.pop(); requestPreview(); hud.roadPanel(); return; } return setMode(null); }
  const mine = mineSel();
  if (!mine.length) {
    // rally point for every selected production building
    const rb = [...S.selBuildings].map((id) => S.buildings.get(id)).filter((b) => b && b.o === S.civId && S.defs.BUILDINGS[b.ty].trains);
    if (rb.length) { for (const b of rb) { actions.cmd({ c: 'rally', building: b.id, tile, army: b.rallyArmy || 0 }); b.r = tile; } view.rallyKey = ''; hud.toast({ text: `Rally point set for ${rb.length} building${rb.length > 1 ? 's' : ''}.`, kind: 'build', level: 'info' }); view.ping(tile, 0.8, 0x8fe0a8); }
    return;
  }
  const rel = (o) => S.civInfo[o]?.rel?.state;
  const target = view.unitAtScreen(e.offsetX, e.offsetY, (u) => u.owner !== S.civId);
  const focus = e.ctrlKey || e.metaKey;
  // aircraft: right-click picks the obvious mission (own airfield: go home; enemy: strike; ground: patrol / scout / one-way strike)
  const D = S.defs, airIds = mine.filter((id) => D.UNITS[S.units.get(id)?.type]?.air);
  if (airIds.length) {
    const ob = S.buildingAtTile.get(tile);
    const hostileU = target && rel(target.owner) === 'war' ? target : null;
    const hostileB = ob && ob.o !== S.civId && rel(ob.o) === 'war' ? ob : null;
    const tgt = hostileU ? { kind: 'unit', id: hostileU.id } : hostileB ? { kind: 'building', id: hostileB.id } : null;
    if (ob && ob.o === S.civId && D.BUILDINGS[ob.ty].airbase) { actions.cmd({ c: 'airHome', base: ob.id, units: airIds }); airOrder(airIds, 'return'); view.ping(tile, 0.6, 0x8fe0a8); }
    else {
      const by = { strike: [], patrol: [], scout: [] };
      for (const id of airIds) {
        const k = unitKind(D, S.units.get(id).type);
        if (tgt) (k === 'recon' ? by.scout : by.strike).push(id);
        else (k === 'oneway' ? by.strike : k === 'recon' ? by.scout : by.patrol).push(id);
      }
      for (const [k, ids] of Object.entries(by)) if (ids.length) airOrder(ids, k, tgt ? (hostileU ? hostileU.tile : tile) : tile, k === 'strike' ? tgt : null);
    }
    const rest = mine.filter((id) => !airIds.includes(id));
    if (!rest.length) return;
    if (target && rel(target.owner) === 'war') return attackTarget({ kind: 'unit', id: target.id }, focus, target.tile, rest);
    return orderMove(rest, tile, e.altKey, e.shiftKey);
  }
  if (target && rel(target.owner) === 'war') return attackTarget({ kind: 'unit', id: target.id }, focus, target.tile);
  const b = S.buildingAtTile.get(tile);
  if (b && b.o !== S.civId && rel(b.o) === 'war') return attackTarget({ kind: 'building', id: b.id }, focus, tile);
  orderMove(mine, tile, e.altKey, e.shiftKey);
}

// Developer inspector: while the Diagnostics section is open, ask the server why the unit does what it does.
async function pollDiagnostics() {
  const d = document.querySelector('#selection details.diag');
  hud.diagOpen = !!(d && d.open);
  if (!d || !d.open || pollDiagnostics.busy) return;
  pollDiagnostics.busy = true;
  try {
    if (d.dataset.cdiag) {
      const r = await actions.cmd({ c: 'cityDiag', city: +d.dataset.cdiag }); const x = r.city;
      hud.diagText = x ? [`state ${x.state}${x.why ? ': ' + x.why : ''}`, `town ${x.hpAbs} HP · siege damage ${x.siegeDamage} / ${x.ruinAt} before ruin`, `stability ${x.stability} · unrest ${x.unrest}s · revolt: ${x.revolt}`, `cooldowns: city ${x.cityCooldown}s · nation ${x.empireCooldown}s`].join('\n') : r.error || '';
      hud.selHtml = ''; return;
    }
    const r = await actions.cmd({ c: 'diagnose', unit: +d.dataset.diag });
    const x = r.diag; if (!x) { hud.diagText = r.error || ''; return; }
    const lines = [`order ${x.order} (by ${x.auth}) · status ${x.status}${x.wait ? ` waiting ${x.wait}s` : ''}`, `tile ${x.tile} → goal ${x.goal} slot ${x.slot} · path ${x.path}${x.flowField ? ' (flow field)' : ''}`, `stance ${x.stance} · supply ${x.supply}% · morale ${x.morale}%${x.formation ? ` · formation ${x.formation}` : ''}`];
    if (x.pathFail) lines.push(`last failure: ${x.pathFail.code} (${x.pathFail.ago}s ago) — ${x.pathFail.text}`);
    if (x.air) lines.push(`air: ${x.air.state} · fuel ${x.air.fuel}s · ammo ${x.air.ammo} · base ${x.air.home}${x.air.mission ? ` · ${x.air.mission.kind} → ${x.air.mission.tile} (by ${x.air.mission.auth})${x.air.mission.suspended ? ' suspended' : ''}` : ''}${x.air.note ? ' · ' + x.air.note : ''}`);
    if (x.mission) { lines.push(`AI mission #${x.mission.id} ${x.mission.kind}: ${x.mission.state} for ${x.mission.since}s (${x.mission.units} units)`); for (const h of x.mission.history.slice(-4)) lines.push(`  ${h[0]}s ${h[1]} → ${h[2]}${h[3] ? ': ' + h[3] : ''}`); }
    lines.push(`game: ${x.stats.pathFail || 0} path failures · ${x.stats.deadlocks || 0} deadlocks cleared · ${x.stats.oscillations || 0} AI oscillations`);
    hud.diagText = lines.join('\n'); hud.selHtml = '';
  } finally { pollDiagnostics.busy = false; }
}

// One air order: a mission for chosen aircraft, or (from an airfield) for aircraft the server picks.
async function airOrder(ids, kind, tile = -1, target = null, base = null) {
  const c = { c: 'airMission', kind, tile, target };
  if (ids && ids.length) c.units = ids; else if (base != null) c.base = base; else return;
  const r = await actions.cmd(c);
  if (r.error) return hud.toast({ text: r.error, kind: 'error', level: 'minor' });
  const a = r.air || {};
  const verb = { patrol: 'patrolling', scout: 'scouting', strike: 'striking', support: 'supporting troops', return: 'returning to base' }[kind];
  if (a.assigned) hud.toast({ text: `${a.assigned} aircraft ${verb}${a.refused?.length ? ` · ${a.refused.length} refused: ${a.refused[0][1]}` : ''}.`, kind: 'unit', level: 'info' });
  else if (a.refused?.length) hud.toast({ text: a.refused[0][1], kind: 'error', level: 'minor' });
  if (tile >= 0 && kind !== 'return') view.ping(tile, kind === 'strike' ? 0.6 : 2, kind === 'strike' ? 0xd0533b : 0x7fb8e0);
}
actions.airOrder = airOrder;

function attackTarget(target, focus, tile, units = mineSel()) {
  S.focusSet = S.focusSet || new Set();
  const key = target.kind === 'unit' ? target.id : -target.id;
  if (focus) S.focusSet.add(key); else S.focusSet.delete(key);
  actions.cmd({ c: 'attack', units, target, focus });
  view.ping(tile, focus ? 0.4 : 0.8, 0xd0533b);
  if (units.length > 2) hud.toast({ text: focus ? `Focus fire: ${units.length} units on one target.` : `Attack: fire spread over the threats around the target.`, kind: 'unit', level: 'info' });
}

// Battle line preview for a right-drag: where each selected unit will stand and which way it faces.
// Live deployment preview: the same planner the server runs, fed with what this client knows.
// our city nearest a line (the server makes the same choice): lines face away from it
function homeTile(a, b) {
  let best = -1, bd = Infinity;
  for (const c of S.cities.values()) if (c.o === S.civId) for (const t of [a, b]) { const d = Math.hypot(view.near(view.cx[c.t], view.cx[t]) - view.cx[t], view.cy[c.t] - view.cy[t]); if (d < bd) { bd = d; best = c.t; } }
  return bd <= 25 * 21 ? best : -1;
}
function deployEnv(sel) {
  const D = S.defs, selSet = new Set(sel.map((u) => u.id));
  return {
    W: S.W, H: S.H, wrap: S.wrap,
    passable: (t, u) => {
      const ter = S.terr[t]; if (ter === 255 || !D.TERRAIN[ter] || D.TERRAIN[ter].water || !Number.isFinite(D.TERRAIN[ter].move ?? Infinity)) return false;
      if (u && D.MOVE[D.UNITS[u.type]?.move]?.terrain && !Number.isFinite(D.MOVE[D.UNITS[u.type].move].terrain[ter] ?? 1)) return false;
      return true;
    },
    capacity: (t) => {
      const b = S.buildingAtTile.get(t); if (b && b.ty === 'town') return 14;
      let rt = 0; const p = S.road[t]; for (let d = 0; d < 6; d++) rt = Math.max(rt, (p >> (d * 4)) & 7);
      const wr = 0; return rt ? Math.max(2, (D.ROAD_TYPES[rt]?.capacity || 6) - wr) : 6;
    },
    occupied: (t) => { let n = 0; for (const u of S.units.values()) if (u.tile === t && u.owner === S.civId && !selSet.has(u.id) && !D.UNITS[u.type].air && !S.paths[u.id]) n++; return n; },
  };
}
function updateDeployPreview(a, b, attackMove, anchorX) {
  if (!(a >= 0) || !(b >= 0)) return;
  const D = S.defs;
  const sel = mineSel().map((id) => S.units.get(id)).filter((u) => u && !D.UNITS[u.type].civilian);
  if (!sel.length) return;
  const o = S.deployOpts;
  const plan = planDeployment(deployEnv(sel), sel.map((u) => ({ id: u.id, tile: u.tile, type: u.type, role: deployRole(D.UNITS[u.type]), air: !!D.UNITS[u.type].air })), [a, b], { mode: 'line', density: 'auto', depth: 'auto', away: homeTile(a, b), reverse: o.reverse });
  S.deploy = { line: [a, b], plan, attackMove, n: sel.length, anchorX: anchorX ?? S.deploy?.anchorX };
  hud.deployBar();
}
function openSearch() {
  const box = $('search'); box.hidden = false; const inp = $('searchInput'); inp.value = ''; inp.focus(); renderSearch('');
}
function searchItems(q) {
  const D = S.defs, out = []; q = q.trim().toLowerCase(); if (!q) return out;
  for (const c of S.cities.values()) if (c.n.toLowerCase().includes(q)) out.push({ label: c.n, hint: c.o === S.civId ? 'your city' : 'city', go: () => { actions.jump(c.t); actions.selectCity(c.id); } });
  const types = new Map(); for (const u of S.units.values()) if (u.owner === S.civId) types.set(u.type, (types.get(u.type) || 0) + 1);
  for (const [t, n] of types) if (D.UNITS[t].name.toLowerCase().includes(q)) out.push({ label: D.UNITS[t].name, hint: `${n} unit${n > 1 ? 's' : ''}: select all`, go: () => actions.selectType(t, false) });
  for (const [k, b] of Object.entries(D.BUILDINGS)) if (b.name.toLowerCase().includes(q)) { const n = [...S.buildings.values()].filter((x) => x.o === S.civId && x.ty === k).length; out.push({ label: b.name, hint: n ? `${n} built: find` : 'building: open build palette', go: () => { if (n) actions.findBuildings({ type: k }); else hud.toggleBuild(true); } }); }
  if ('find buildings'.includes(q) || 'finder'.includes(q) || 'unfinished'.includes(q) || 'inactive'.includes(q) || 'idle'.includes(q)) out.push({ label: 'Find buildings', hint: 'search, filter by type, city and state', go: () => actions.findBuildings({ state: 'unfinished'.includes(q) ? 'unfinished' : 'inactive'.includes(q) || 'idle'.includes(q) ? 'idle' : 'all' }) });
  for (const k of D.GOODS) if ((D.GOOD_NAMES[k] || '').toLowerCase().includes(q)) out.push({ label: D.GOOD_NAMES[k], hint: 'resource: what makes it and why it moves', go: () => hud.openResource(k) });
  for (const [k, t] of Object.entries(D.TECHS)) if (t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)) out.push({ label: t.name, hint: 'technology', go: () => { hud.openWorkspace('research'); hud.research.sel = k; hud.research.refresh(); setTimeout(() => hud.research.focus(k), 60); } });
  const cmds = [['Research', 'research'], ['Economy', 'economy'], ['Military', 'military'], ['Cities', 'cities'], ['Government', 'government'], ['Diplomacy', 'diplomacy'], ['Chronicle', 'chronicle']];
  for (const [n, w] of cmds) if (n.toLowerCase().includes(q)) out.push({ label: n, hint: 'open workspace', go: () => hud.openWorkspace(w) });
  if ('road'.includes(q) || 'plan road'.includes(q)) out.push({ label: 'Plan road', hint: 'command (R)', go: () => startRoadMode() });
  return out.slice(0, 14);
}
let searchSel = 0, searchList = [];
function renderSearch(q) { searchList = searchItems(q); searchSel = 0; $('searchResults').innerHTML = searchList.map((r, i) => `<li data-i="${i}" class="${i === 0 ? 'on' : ''}"><span>${r.label.replace(/</g, '&lt;')}</span><small>${r.hint}</small></li>`).join('') || (q ? '<li class="muted">Nothing found.</li>' : '<li class="muted">Type to search cities, units, buildings, technologies and commands.</li>'); }
function syncPrefs() {
  for (const el of document.querySelectorAll('[data-pref]')) { const k = el.dataset.pref, v = S.prefs[k]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
  S.shakeOff = !S.prefs.shake || S.prefs.reducedMotion;
  S.particleScale = (GRAPHICS[S.prefs.graphics]?.particles || 1) * (S.prefs.particles ?? 1);
  S.decor = GRAPHICS[S.prefs.graphics]?.decor !== false;
}

function linePreview(x0, y0, x1, y1, n) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, rx = (x1 - x0) / L, ry = (y1 - y0) / L, fx = ry, fy = -rx;
  const step = 21, width = Math.max(1, Math.min(n, Math.round(L / step) + 1)), sp = width > 1 ? Math.max(step, L / (width - 1)) : step;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, slots = [];
  for (let i = 0; i < n; i++) { const rank = Math.floor(i / width), file = i % width, off = (file - (width - 1) / 2) * sp; slots.push([mx + rx * off - fx * rank * 19, my + ry * off - fy * rank * 19]); }
  return { x0, y0, x1, y1, fx, fy, slots };
}
function hexDistC(a, b) {
  const cube = (i) => { const q = i % S.W, r = (i / S.W) | 0; const x = q - ((r - (r & 1)) >> 1); return [x, r, -x - r]; };
  const [ax, ay, az] = cube(a), [bx, by, bz] = cube(b);
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

// troops set to Attack fight their way to wherever they are sent
function attacking(ids) {
  const us = ids.map((id) => S.units.get(id)).filter((u) => u && !S.defs.UNITS[u.type].civilian);
  return us.length > 0 && us.every((u) => u.stance === 'aggressive');
}
async function orderMove(units, tile, attackMove, queue) {
  attackMove = attackMove || attacking(units);
  view.ping(tile, 0.5, queue ? 0x8fd19e : 0xf1c75b);
  const r = await actions.cmd({ c: 'move', units, tile, attackMove, formation: S.formation, queue });
  if (r && r.order && r.order.queued) return hud.toast({ text: `Waypoint queued for ${r.order.queued} unit${r.order.queued > 1 ? 's' : ''}.`, kind: 'unit', level: 'info' });
  const o = r && r.order; if (!o) return;
  if (o.unreachable) hud.toast({ text: `${o.unreachable} unit${o.unreachable > 1 ? 's' : ''} cannot reach that location.`, kind: 'error', level: 'minor' });
  if (o.partial) hud.toast({ text: `${o.partial} unit${o.partial > 1 ? 's' : ''} will get as close as the terrain allows.`, kind: 'warning', level: 'minor' });
}

// ------------------------------------------------------------------ boot
lobbyArt();
refreshMatches();
setInterval(() => { if (!S.ready) refreshMatches(); }, 4000);
window.__S = S;
S.dev = /[?&]dev(=1)?\b/.test(location.search);
window.__view = () => view;
window.__hud = () => hud;
window.__actions = () => actions;
