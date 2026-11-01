// The only bridge between web content and the desktop shell: a few named calls, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  play: (mode) => ipcRenderer.invoke('se:play', mode),
  launcher: () => ipcRenderer.invoke('se:launcher'),
  info: () => ipcRenderer.invoke('se:info'),
  steam: {
    status: () => ipcRenderer.invoke('se:steam-status'),
    lobbies: () => ipcRenderer.invoke('se:steam-lobbies'),
    join: (id) => ipcRenderer.invoke('se:steam-join-lobby', String(id)),
    invite: () => ipcRenderer.invoke('se:steam-invite'),
    onStatus: (fn) => ipcRenderer.on('steam-status', (_e, s) => fn(s)),
  },
});
