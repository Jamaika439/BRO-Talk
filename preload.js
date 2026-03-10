const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Quellen laden
  getSources: () => ipcRenderer.invoke('get-sources'),
  
  // Quelle vorauswählen (WICHTIG!)
  selectSource: (sourceId) => ipcRenderer.invoke('select-source', sourceId),
  
  // Auswahl zurücksetzen
  clearSourceSelection: () => ipcRenderer.invoke('clear-source-selection'),
  
  // Info
  platform: process.platform,
  isElectron: true
});

console.log('[Preload] electronAPI exposed');
