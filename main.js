const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
app.commandLine.appendSwitch('disable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns,WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('ignore-gpu-blacklist');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#2f3136',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      allowRunningInsecureContent: true
    },
    title: 'Bro Talk'
  });

  // Alle Permissions erlauben (Mikrofon, Kamera, etc.)
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));

  // ── WICHTIG: setDisplayMediaRequestHandler ENTFERNT ──
  // Vorher hat dieser Handler immer automatisch sources[0] gewählt
  // und damit die eigene Source-Auswahl im UI überschrieben.
  // Jetzt übernimmt der ipcMain 'get-sources' + getUserMedia mit
  // chromeMediaSourceId die Kontrolle vollständig.

  win.loadFile('index.html');
  // win.webContents.openDevTools();
}

// Liefert alle Bildschirme & Fenster mit Thumbnails ans Frontend
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false
  });
  return sources.map(s => ({
    id:        s.id,
    name:      s.name,
    thumbnail: s.thumbnail.toDataURL()
  }));
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});