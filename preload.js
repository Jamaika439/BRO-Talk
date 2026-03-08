const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  onNgrokUrl: (cb) => ipcRenderer.on('ngrok-url', (_, url) => cb(url))
});