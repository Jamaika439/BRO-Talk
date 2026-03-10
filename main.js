const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

// ── GPU & WebRTC Flags ──
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns,WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('ignore-gpu-blacklist');

// ── WICHTIG: Verhindert Renderer-Crash bei getUserMedia ──
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#2f3136',
    
    // ── APP ICON ──
    icon: path.join(__dirname, 'logo.png'),
    
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false  // Verhindert Freezes
    },
    title: 'Bro Talk'
  });

  // Alle Permissions erlauben
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));

  mainWindow.loadFile('index.html');
  
  // ── DevTools: F12 oder Ctrl+Shift+I ──
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // ── Crash-Handler: Verhindert stilles Hängen ──
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer crashed:', details.reason);
    if (details.reason !== 'clean-exit') {
      mainWindow.reload();
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('Window unresponsive – reloading...');
    mainWindow.reload();
  });

  // Optional: DevTools beim Start öffnen (zum Debuggen)
  // mainWindow.webContents.openDevTools();
}

// ── Desktop-Sources mit Thumbnails ──
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
    console.error('get-sources error:', err);
    return [];
  }
});

// ── NEU: Stream direkt im Main-Prozess anfordern (Fallback) ──
ipcMain.handle('get-stream-for-source', async (event, sourceId) => {
  // Gibt nur die sourceId zurück - der eigentliche Stream wird im Renderer erstellt
  // Dies ist ein Workaround für Race-Conditions
  return { sourceId, timestamp: Date.now() };
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

// ── Globaler Error Handler ──
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
