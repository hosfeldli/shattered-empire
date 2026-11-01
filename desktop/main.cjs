// Shattered Empires desktop app (Electron) — the only way to play.
// The game client is bundled in the app and served from a private app:// origin; every match runs
// on the deployed, authoritative game server (game.liamhosfeld.com) over a WebSocket, exactly as
// before. There is no local server and no offline mode. Steam (Spacewar test app 480 for now)
// adds friends, lobbies and invites: a Steam lobby carries the server match code, and accepting an
// invite joins that match on the game server.
const { app, BrowserWindow, ipcMain, Menu, shell, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// performance: use the GPU even where Chromium's blocklist is cautious, rasterise on it, prefer the
// discrete GPU on dual-GPU Macs, and never throttle the game when the window is in the background
// (the match keeps running on the server; the client must keep up with its snapshots)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const SERVER = (process.env.SE_SERVER || 'https://game.liamhosfeld.com').replace(/\/$/, '');
const CLIENT_DIR = path.join(__dirname, 'app', 'client');
let win = null, steam = null, pendingJoin = null;

// app://game/... -> the bundled client (standard + secure so ES modules, fetch and WebSockets work)
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function serveClient() {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname); if (p === '/' || !p) p = '/index.html';
    const file = path.normalize(path.join(CLIENT_DIR, p));
    if (!file.startsWith(CLIENT_DIR)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, backgroundColor: '#122025', title: 'Shattered Empires', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false, additionalArguments: ['--se-server=' + SERVER] },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // stay inside the app: anything else opens in the system browser
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('did-finish-load', () => { if (pendingJoin) { win.webContents.send('steam-join', pendingJoin); pendingJoin = null; } });
  win.loadURL('app://game/index.html');
}

// ----------------------------------------------------------------------------------------- Steam
function getSteam() {
  if (steam) return steam;
  const { SteamLobbies } = require('./steam.cjs');
  steam = new SteamLobbies({ log: (...a) => console.log('[steam]', ...a), onJoinMatch: (code) => joinMatch(code) });
  steam.init();
  return steam;
}
function joinMatch(code) {
  if (!code) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('steam-join', code); else pendingJoin = code;
  win?.show(); win?.focus();
}
ipcMain.handle('se:steam-status', () => getSteam().status());
ipcMain.handle('se:steam-host', async (_e, code, name) => { try { return { ok: true, lobby: String(await getSteam().host(String(code), String(name || ''))) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('se:steam-invite', () => { getSteam().invite(); return true; });
ipcMain.handle('se:steam-lobbies', async () => { try { return await getSteam().friendLobbies(); } catch { return []; } });
ipcMain.handle('se:steam-join', async (_e, id) => { try { return { ok: true, match: await getSteam().joinLobby(BigInt(id)) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('se:steam-leave', () => { steam?.leave(); return true; });
ipcMain.handle('se:info', () => ({ version: app.getVersion(), server: SERVER, platform: process.platform }));

function menu() {
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Game', submenu: [
      { label: 'Invite Steam friends', click: () => steam?.invite() },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
      { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Downloads and updates', click: () => shell.openExternal(SERVER + '/') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// Steam's overlay hook must be in place before windows exist; harmless without Steam
try { require('steamworks.js').electronEnableSteamOverlay(); } catch { /* steam not available */ }

// one window: a second launch (e.g. Steam starting the game for an invite) hands its arguments over
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => { const id = lobbyArg(argv); if (id) getSteam().joinLobby(id).catch(() => {}); win?.show(); win?.focus(); });
  app.whenReady().then(() => {
    serveClient(); menu(); createWindow();
    const id = lobbyArg(process.argv); if (id) getSteam().joinLobby(id).catch(() => {});
    else try { getSteam(); } catch { /* steam optional */ }
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
}
// Steam launches a game for a lobby invite with "+connect_lobby <id>"
function lobbyArg(argv) { const i = argv.indexOf('+connect_lobby'); try { return i >= 0 ? BigInt(argv[i + 1]) : null; } catch { return null; } }

app.on('before-quit', () => steam?.leave());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
