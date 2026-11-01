// Shattered Empires desktop edition (Electron).
// Same architecture as game.liamhosfeld.com: the unchanged Node game server runs as a child process
// (Electron's own Node, ELECTRON_RUN_AS_NODE) on a private localhost port and the window loads the
// unchanged browser client from it. Saves go to the user's data folder. Three ways to play:
//   - This computer: the local server (offline play against the AI, saves on disk)
//   - Online: the window loads https://game.liamhosfeld.com
//   - Steam (Spacewar, app 480): the host's local server is shared with friends through Steam
//     lobbies and Steam networking; guests tunnel the game's WebSocket to the host (steam.cjs).
const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { fork } = require('node:child_process');

const ONLINE = process.env.SE_ONLINE_URL || 'https://game.liamhosfeld.com';
const APP_DIR = path.join(__dirname, 'app');
let server = null, serverPort = 0, win = null, steam = null;

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
}

async function startServer() {
  if (server) return serverPort;
  const port = await freePort();
  const saves = path.join(app.getPath('userData'), 'saves');
  fs.mkdirSync(saves, { recursive: true });
  let pixi = '';
  try { pixi = require.resolve('pixi.js/dist/pixi.min.js'); } catch { /* falls back to the CDN */ }
  server = fork(path.join(APP_DIR, 'server', 'index.js'), [], {
    cwd: APP_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), HOST: '127.0.0.1', SNAPSHOT_DIR: saves, PIXI_PATH: pixi, APP_VERSION: 'desktop-' + app.getVersion(), MAX_MATCHES: '4', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const logFile = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
  server.stdout.pipe(logFile); server.stderr.pipe(logFile);
  server.on('exit', (code) => { server = null; if (code && win && !app.isQuitting) dialog.showErrorBox('Shattered Empires', `The local game server stopped (code ${code}). See server.log in ${app.getPath('userData')}.`); });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the local server did not start')), 20000);
    server.on('message', (m) => { if (m && m.t === 'listening') { clearTimeout(t); resolve(); } });
    server.on('exit', () => { clearTimeout(t); reject(new Error('the local server exited')); });
  });
  serverPort = port;
  return port;
}

function waitHealthy(url, tries = 40) {
  return new Promise((resolve, reject) => {
    const go = (n) => http.get(url + '/api/health', (r) => { r.resume(); if (r.statusCode === 200) resolve(); else if (n > 0) setTimeout(() => go(n - 1), 250); else reject(new Error('unhealthy')); }).on('error', () => (n > 0 ? setTimeout(() => go(n - 1), 250) : reject(new Error('unreachable'))));
    go(tries);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, backgroundColor: '#122025', title: 'Shattered Empires', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // external links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  showLauncher();
}
function showLauncher() { win.loadFile(path.join(__dirname, 'launcher.html')); }

async function play(mode) {
  if (mode === 'online') return win.loadURL(ONLINE);
  const port = await startServer();
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy(url);
  if (mode === 'local') return win.loadURL(url);
  if (mode === 'steam-host') { const s = await getSteam(); await s.host(port); return win.loadURL(url); }
  if (mode === 'steam-join') { const s = await getSteam(); const proxy = await s.join(port); return win.loadURL(`http://127.0.0.1:${proxy}`); }
  throw new Error('unknown mode ' + mode);
}

async function getSteam() {
  if (steam) return steam;
  const { SteamBridge } = require('./steam.cjs');
  steam = new SteamBridge({ log: (...a) => console.log('[steam]', ...a), onStatus: (s) => win?.webContents.send('steam-status', s), onInvite: (lobby) => joinInvite(lobby) });
  steam.init();
  return steam;
}
async function joinInvite(lobbyId) {
  try { const port = await startServer(); await waitHealthy(`http://127.0.0.1:${port}`); const proxy = await steam.join(port, lobbyId); win.loadURL(`http://127.0.0.1:${proxy}`); }
  catch (e) { dialog.showErrorBox('Steam', 'Could not join the lobby: ' + e.message); }
}

ipcMain.handle('se:play', async (_e, mode) => { try { await play(mode); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('se:steam-status', async () => { try { const s = await getSteam(); return s.status(); } catch (e) { return { available: false, error: e.message }; } });
ipcMain.handle('se:steam-lobbies', async () => { try { const s = await getSteam(); return await s.friendLobbies(); } catch (e) { return []; } });
ipcMain.handle('se:steam-join-lobby', async (_e, id) => { try { await getSteam(); await joinInvite(BigInt(id)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('se:steam-invite', async () => { try { const s = await getSteam(); s.invite(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('se:launcher', () => { steam?.leave(); showLauncher(); return true; });
ipcMain.handle('se:info', () => ({ version: app.getVersion(), online: ONLINE, saves: path.join(app.getPath('userData'), 'saves'), platform: process.platform }));

function menu() {
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Game', submenu: [
      { label: 'Launcher', accelerator: 'CmdOrCtrl+L', click: () => { steam?.leave(); showLauncher(); } },
      { label: 'Invite Steam friends', click: () => { steam?.invite(); } },
      { type: 'separator' },
      { label: 'Open saves folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'saves')) },
      { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'viewMenu' }, { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Download page', click: () => shell.openExternal(ONLINE + '/download') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// Steam's overlay needs this before windows exist; harmless without Steam
try { require('steamworks.js').electronEnableSteamOverlay(); } catch { /* steam not available */ }

app.whenReady().then(() => { menu(); createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
// quitting saves running matches first: the server is asked over IPC (works on Windows and macOS),
// and killed only if it has not exited within a few seconds
app.on('before-quit', (e) => {
  app.isQuitting = true; steam?.leave();
  if (!server) return;
  e.preventDefault();
  const s = server; server = null;
  const done = () => app.quit();
  s.once('exit', done);
  try { s.send({ t: 'shutdown' }); } catch { s.kill(); }
  setTimeout(() => { try { s.kill(); } catch { /* gone */ } done(); }, 6000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
