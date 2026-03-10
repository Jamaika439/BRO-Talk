const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getStreamForSource: (sourceId) => ipcRenderer.invoke('get-stream-for-source', sourceId),
  
  // Platform-Info für Debugging
  platform: process.platform,
  isElectron: true
});

// Debug-Log im Renderer
console.log('[Preload] electronAPI exposed successfully');
