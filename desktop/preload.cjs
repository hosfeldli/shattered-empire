// The only bridge between the bundled client and the desktop shell: the game server's address and
// a few named Steam calls, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--se-server='));
const server = arg ? arg.slice('--se-server='.length) : 'https://game.liamhosfeld.com';

contextBridge.exposeInMainWorld('desktop', {
  server,
  info: () => ipcRenderer.invoke('se:info'),
  update: {
    status: () => ipcRenderer.invoke('se:update-status'),
    check: () => ipcRenderer.invoke('se:update-check'),
    install: () => ipcRenderer.invoke('se:update-install'),
    onStatus: (fn) => ipcRenderer.on('se-update', (_e, s) => fn(s)),
  },
  steam: {
    status: () => ipcRenderer.invoke('se:steam-status'),
    host: (matchCode, name) => ipcRenderer.invoke('se:steam-host', matchCode, name),
    invite: () => ipcRenderer.invoke('se:steam-invite'),
    lobbies: () => ipcRenderer.invoke('se:steam-lobbies'),
    join: (lobbyId) => ipcRenderer.invoke('se:steam-join', String(lobbyId)),
    leave: () => ipcRenderer.invoke('se:steam-leave'),
    onJoin: (fn) => ipcRenderer.on('steam-join', (_e, code) => fn(code)),
  },
});
