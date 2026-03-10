const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ── GPU & WebRTC Flags ──
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns,WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow = null;
let selectedSourceId = null;  // ← Speichert die User-Auswahl

function createWindow() {
  // Icon-Pfad
  let iconPath = path.join(__dirname, 'assets', 'logo.png');
  if (process.platform === 'win32') {
    const icoPath = path.join(__dirname, 'assets', 'icon.ico');
    if (fs.existsSync(icoPath)) iconPath = icoPath;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#2f3136',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      backgroundThrottling: false
    },
    title: 'Bro Talk'
  });

  // ── Alle Permissions erlauben ──
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));

  // ══════════════════════════════════════════════════════════════
  // ██  WICHTIG: Display Media Handler für Desktop-Capture  ██
  // ══════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════
// ██  Display Media Handler mit besserem Audio-Support  ██
// ══════════════════════════════════════════════════════════════
session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 }
    });

    if (sources.length === 0) {
      console.log('[Main] No sources available');
      callback({});
      return;
    }

    let selectedSource = null;
    if (selectedSourceId) {
      selectedSource = sources.find(s => s.id === selectedSourceId);
      console.log('[Main] Using pre-selected source:', selectedSourceId, selectedSource?.name);
    }

    if (!selectedSource) {
      selectedSource = sources[0];
      console.log('[Main] Using fallback source:', selectedSource.name);
    }

    // ══════════════════════════════════════════════
    // ██  WICHTIG: Audio richtig konfigurieren  ██
    // ══════════════════════════════════════════════
    
    // Für Screens: System-Audio mit loopback
    // Für Windows: Kein System-Audio möglich
    const isScreen = selectedSource.id.startsWith('screen:');
    
    console.log('[Main] Source type:', isScreen ? 'Screen' : 'Window');
    console.log('[Main] Returning video source:', selectedSource.name);

    callback({
      video: selectedSource,
      // Audio nur für Bildschirme, nicht für Fenster
      audio: isScreen ? 'loopbackWithMute' : undefined
    });
    
    selectedSourceId = null;
    
  } catch (err) {
    console.error('[Main] DisplayMedia error:', err);
    callback({});
  }
}, { useSystemPicker: false });


  mainWindow.loadFile('index.html');

  // ── DevTools mit F12 ──
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // ── Crash Recovery ──
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer crashed:', details.reason);
    if (details.reason !== 'clean-exit') {
      setTimeout(() => mainWindow.reload(), 1000);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('Window unresponsive – reloading...');
    mainWindow.reload();
  });
}

// ══════════════════════════════════════════════════════════════
// ██  IPC Handlers  ██
// ══════════════════════════════════════════════════════════════

// Liefert alle Bildschirme & Fenster ans Frontend
ipcMain.handle('get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    });
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL()
    }));
  } catch (err) {
    console.error('[Main] get-sources error:', err);
    return [];
  }
});

// ── NEU: User wählt eine Quelle vor ──
ipcMain.handle('select-source', async (event, sourceId) => {
  console.log('[Main] Source pre-selected:', sourceId);
  selectedSourceId = sourceId;
  return { success: true };
});

// ── NEU: Reset der Auswahl ──
ipcMain.handle('clear-source-selection', async () => {
  selectedSourceId = null;
  return { success: true };
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

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
