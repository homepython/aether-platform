const { app, BrowserWindow, desktopCapturer, session, globalShortcut } = require('electron');

// ============================================================================
// URL DO SEU SERVIDOR NA NUVEM 24/7
// Assim que criar o servidor no Render/Railway (Passo 3), cole o link abaixo:
// Exemplo: const CLOUD_URL = 'https://aether-server.onrender.com';
// ============================================================================
const CLOUD_URL = process.env.AETHER_CLOUD_URL || 'http://localhost:3000';
const LOCAL_URL = 'http://localhost:3000';

// Se estivermos rodando em modo local, sobe o server.js automaticamente
if (CLOUD_URL === LOCAL_URL) {
  require('./server.js');
}

// Flags de Aceleração de GPU e Baixa Latência de Áudio/Vídeo
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let usingLocalMode = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    title: 'Aether',
    backgroundColor: '#141821',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  // Permite compartilhamento de tela + áudio do sistema nativo no Electron
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      if (sources && sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({});
      }
    }).catch(() => callback({}));
  });

  // Tenta carregar a Nuvem 24/7; se estiver sem internet ou em manutenção local, usa o fallback local
  mainWindow.loadURL(CLOUD_URL).catch(() => {
    require('./server.js');
    mainWindow.loadURL(LOCAL_URL);
  });

  // Atalhos de Manutenção no Teclado (quando a janela está focada)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F5 ou Ctrl+R: Recarrega as atualizações enviadas para a nuvem
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      mainWindow.webContents.reloadIgnoringCache();
    }
    // Ctrl+Shift+I: Abre o Console de Manutenção (DevTools)
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
    // Ctrl+Shift+L: Alterna entre Nuvem 24/7 e Servidor Local de Testes (localhost:3000)
    if (input.control && input.shift && input.key.toLowerCase() === 'l') {
      usingLocalMode = !usingLocalMode;
      if (usingLocalMode) {
        try { require('./server.js'); } catch (e) {}
        mainWindow.loadURL(LOCAL_URL);
      } else {
        mainWindow.loadURL(CLOUD_URL);
      }
    }
  });
}

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});