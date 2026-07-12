const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  isElectron: true,
  proxyFetch: (url) => ipcRenderer.invoke('proxy-fetch', url),
  quit: () => ipcRenderer.send('app-quit'),
  setPlaybackActive: (playing) => ipcRenderer.send('playback-state', !!playing),
  onWindowBlur: (cb) => ipcRenderer.on('window-blur', () => cb()),
  onWindowFocus: (cb) => ipcRenderer.on('window-focus', () => cb()),
});
