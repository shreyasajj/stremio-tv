const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  isElectron: true,
  proxyFetch: (url) => ipcRenderer.invoke('proxy-fetch', url),
  quit: () => ipcRenderer.send('app-quit'),
});
