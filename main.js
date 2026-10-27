const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { exec } = require('child_process');

// ================= 1. GERADOR AUTOMÁTICO DO ÍCONE OFICIAL (.ICO / .PNG) =================
function ensureAppIcons() {
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  const pngPath = path.join(publicDir, 'icon.png');
  const icoPath = path.join(publicDir, 'icon.ico');

  if (fs.existsSync(pngPath) && fs.existsSync(icoPath)) return { pngPath, icoPath };

  const width = 256;
  const height = 256;
  const rawData = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    rawData[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + 1 + x * 4;
      const nx = (x - 128) / 128;
      const ny = (y - 128) / 128;
      const dist = Math.sqrt(nx * nx + ny * ny);

      const cornerRadius = 56;
      const dx = Math.max(0, Math.abs(x - 128) - (116 - cornerRadius));
      const dy = Math.max(0, Math.abs(y - 128) - (116 - cornerRadius));
      const edgeDist = Math.sqrt(dx * dx + dy * dy);

      if (edgeDist > cornerRadius) {
        rawData[idx] = 0;
        rawData[idx + 1] = 0;
        rawData[idx + 2] = 0;
        rawData[idx + 3] = 0;
        continue;
      }

      const t = (x + y) / (width + height);
      let r = Math.round(35 + 65 * (1 - t));
      let g = Math.round(45 + 75 * (1 - t));
      let b = Math.round(145 + 100 * (1 - t));

      const ringDist = Math.abs(dist - 0.48);
      const innerDot = dist < 0.22;
      const waveRing = Math.abs(dist - 0.68) < 0.045 && Math.abs(ny) < 0.38;

      if (innerDot || ringDist < 0.065 || waveRing) {
        r = 240;
        g = 246;
        b = 255;
      }

      rawData[idx] = r;
      rawData[idx + 1] = g;
      rawData[idx + 2] = b;
      rawData[idx + 3] = 255;
    }
  }

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngBuffer = Buffer.concat([
    pngSignature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);

  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);
  icoHeader[6] = 0;
  icoHeader[7] = 0;
  icoHeader[8] = 0;
  icoHeader[9] = 0;
  icoHeader.writeUInt16LE(1, 10);
  icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(pngBuffer.length, 14);
  icoHeader.writeUInt32LE(22, 18);

  const icoBuffer = Buffer.concat([icoHeader, pngBuffer]);
  fs.writeFileSync(pngPath, pngBuffer);
  fs.writeFileSync(icoPath, icoBuffer);
  return { pngPath, icoPath };
}

const iconPaths = ensureAppIcons();
if (process.argv.includes('--generate-icon')) {
  console.log('Ícones oficiais do Aether gerados com sucesso em public/icon.ico e public/icon.png');
  process.exit(0);
}

// ================= 2. PROCESSO PRINCIPAL DO ELECTRON =================
const {
  app,
  BrowserWindow,
  desktopCapturer,
  session,
  globalShortcut,
  ipcMain,
  Notification,
  screen
} = require('electron');

const CLOUD_URL = process.env.AETHER_CLOUD_URL || 'https://aether-platform.onrender.com';
const LOCAL_URL = 'http://localhost:3000';

if (CLOUD_URL === LOCAL_URL) {
  require('./server.js');
}

app.setAppUserModelId('com.aether.realtime');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let overlayWindow = null;
let usingLocalMode = false;
let overlayEnabled = true;
let overlayPosition = 'top-left';
let lastOverlayPayload = { roomName: '', users: [] };
let isExternalFullscreenActive = false;
let queuedNotifications = [];

let currentHotkeys = {
  toggleMic: 'CommandOrControl+Shift+M',
  muteMic: 'CommandOrControl+Shift+Down',
  unmuteMic: 'CommandOrControl+Shift+Up',
  pushToTalk: 'CommandOrControl+Shift+Space',
  toggleOverlay: 'CommandOrControl+Shift+O',
  toggleDeafen: 'CommandOrControl+Shift+D'
};

// Cria os ficheiros auxiliares de Preload (Ponte Nativa) e HTML do Overlay em Jogo
function ensureRuntimeBridgeFiles() {
  const userDataDir = app.getPath('userData');
  const preloadPath = path.join(userDataDir, 'aether-preload.js');
  const overlayHtmlPath = path.join(userDataDir, 'aether-overlay.html');

  const preloadCode = `
    const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('aetherDesktop', {
      isDesktop: true,
      updateOverlayState: (payload) => ipcRenderer.send('desktop:overlay-state', payload),
      setOverlayConfig: (cfg) => ipcRenderer.send('desktop:overlay-config', cfg),
      updateHotkeys: (hk) => ipcRenderer.invoke('desktop:update-hotkeys', hk),
      getHotkeys: () => ipcRenderer.invoke('desktop:get-hotkeys'),
      notify: (payload) => ipcRenderer.send('desktop:notify', payload),
      onHotkeyCommand: (cb) => {
        ipcRenderer.removeAllListeners('desktop:hotkey-command');
        ipcRenderer.on('desktop:hotkey-command', (_e, cmd) => cb(cmd));
      },
      onOverlayToggled: (cb) => {
        ipcRenderer.removeAllListeners('desktop:overlay-toggled');
        ipcRenderer.on('desktop:overlay-toggled', (_e, enabled) => cb(enabled));
      },
      onFlushedNotifications: (cb) => {
        ipcRenderer.removeAllListeners('desktop:flushed-notifications');
        ipcRenderer.on('desktop:flushed-notifications', (_e, list) => cb(list));
      },
      onOverlayRender: (cb) => {
        ipcRenderer.removeAllListeners('overlay:render');
        ipcRenderer.on('overlay:render', (_e, data) => cb(data));
      }
    });
  `;

  const overlayHtmlCode = `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    html, body {
      width: 100%;
      height: 100%;
      background: transparent;
      overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .overlay-root {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
    }
    .overlay-room-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      background: rgba(13, 17, 26, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 99px;
      padding: 4px 10px;
      color: rgba(240, 244, 255, 0.9);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      backdrop-filter: blur(10px);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    }
    .overlay-room-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }
    .overlay-users-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .overlay-user-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      align-self: flex-start;
      background: rgba(15, 19, 29, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      padding: 4px 11px 4px 4px;
      color: rgba(235, 240, 255, 0.85);
      transition: all 140ms ease;
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
    .overlay-user-pill.speaking {
      background: rgba(20, 28, 46, 0.92);
      border-color: #10b981;
      box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.45), 0 6px 18px rgba(0, 0, 0, 0.6);
      transform: translateX(3px);
      color: #ffffff;
    }
    .overlay-avatar {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11.5px;
      font-weight: 700;
      color: #fff;
      position: relative;
      transition: transform 140ms ease, box-shadow 140ms ease;
    }
    .overlay-user-pill.speaking .overlay-avatar {
      box-shadow: 0 0 12px #10b981;
      transform: scale(1.06);
    }
    .overlay-name {
      font-size: 12px;
      font-weight: 600;
      max-width: 140px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    }
    .overlay-status-icons {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
    }
    .overlay-voice-bars {
      display: none;
      align-items: center;
      gap: 2px;
      height: 10px;
    }
    .overlay-user-pill.speaking .overlay-voice-bars {
      display: inline-flex;
    }
    .overlay-voice-bars span {
      width: 2.5px;
      background: #10b981;
      border-radius: 99px;
      animation: eqPulse 0.55s infinite ease-in-out alternate;
    }
    .overlay-voice-bars span:nth-child(1) { height: 5px; animation-delay: 0s; }
    .overlay-voice-bars span:nth-child(2) { height: 10px; animation-delay: 0.15s; }
    .overlay-voice-bars span:nth-child(3) { height: 7px; animation-delay: 0.3s; }
    @keyframes eqPulse {
      from { transform: scaleY(0.45); opacity: 0.7; }
      to { transform: scaleY(1.1); opacity: 1; }
    }
  </style>
</head>
<body>
  <div id="overlay-root" class="overlay-root" style="display:none;">
    <div class="overlay-room-badge">
      <span class="overlay-room-dot"></span>
      <span id="overlay-room-title">Aether</span>
    </div>
    <div id="overlay-users-list" class="overlay-users-list"></div>
  </div>
  <script>
    if (window.aetherDesktop && window.aetherDesktop.onOverlayRender) {
      window.aetherDesktop.onOverlayRender((state) => {
        const root = document.getElementById('overlay-root');
        const titleEl = document.getElementById('overlay-room-title');
        const listEl = document.getElementById('overlay-users-list');
        if (!state || !state.users || state.users.length === 0) {
          root.style.display = 'none';
          return;
        }
        root.style.display = 'flex';
        titleEl.textContent = state.roomName || 'Sala de Voz';
        listEl.innerHTML = '';
        state.users.forEach((u) => {
          const pill = document.createElement('div');
          pill.className = 'overlay-user-pill' + (u.isSpeaking ? ' speaking' : '');
          const initial = (u.name || 'U').charAt(0).toUpperCase();
          pill.innerHTML = \`
            <div class="overlay-avatar" style="background:\${u.avatarColor || '#5E81F4'}">\${initial}</div>
            <span class="overlay-name">\${u.name || 'Utilizador'}</span>
            <div class="overlay-status-icons">
              <div class="overlay-voice-bars"><span></span><span></span><span></span></div>
              \${u.isMuted ? '<span>🔇</span>' : ''}
              \${u.isDeafened ? '<span>🔈</span>' : ''}
            </div>
          \`;
          listEl.appendChild(pill);
        });
      });
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(preloadPath, preloadCode, 'utf8');
  fs.writeFileSync(overlayHtmlPath, overlayHtmlCode, 'utf8');
  return { preloadPath, overlayHtmlPath };
}

// ================= 3. DETEÇÃO DE APLICAÇÕES / JOGOS EM ECRÃ CHEIO NO WINDOWS =================
function checkWindowsFullscreenState() {
  if (process.platform !== 'win32') return;

  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFg {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
}
"@
$state = 0
[WinFg]::SHQueryUserNotificationState([ref]$state) | Out-Null
$hwnd = [WinFg]::GetForegroundWindow()
$rect = New-Object WinFg+RECT
[WinFg]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
Write-Output "$state|$($rect.Left)|$($rect.Top)|$($rect.Right)|$($rect.Bottom)"
  `.trim();

  exec(
    `powershell -NoProfile -WindowStyle Hidden -Command "${psScript.replace(/\r?\n/g, '; ').replace(/"/g, '\\"')}"`,
    { timeout: 1400, windowsHide: true },
    (err, stdout) => {
      if (err || !stdout) return;
      const parts = stdout.trim().split('|').map(Number);
      if (parts.length < 5) return;
      const [notifState, left, top, right, bottom] = parts;
      const primaryBounds = screen.getPrimaryDisplay().bounds;
      const coversPrimaryScreen =
        left <= primaryBounds.x &&
        top <= primaryBounds.y &&
        (right - left) >= primaryBounds.width &&
        (bottom - top) >= primaryBounds.height;

      // Estados 2 (D3D Fullscreen), 3 (Presentation) ou 4 (Active Fullscreen App)
      const isAppFullScreen =
        (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) ||
        notifState === 2 ||
        notifState === 3 ||
        notifState === 4 ||
        (coversPrimaryScreen && (!mainWindow || !mainWindow.isFocused()));

      const wasFullscreen = isExternalFullscreenActive;
      isExternalFullscreenActive = Boolean(isAppFullScreen);

      // Se o utilizador acabou de sair do jogo/vídeo em ecrã cheio, liberta notificações guardadas
      if (wasFullscreen && !isExternalFullscreenActive && queuedNotifications.length > 0) {
        const pending = queuedNotifications.splice(0, queuedNotifications.length);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop:flushed-notifications', pending);
        }
      }
    }
  );
}

// ================= 4. CRIAÇÃO E POSICIONAMENTO DO OVERLAY DENTRO DE JOGOS =================
function applyOverlayWindowBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  const winWidth = 260;
  const winHeight = 380;
  const margin = 18;

  let targetX = x + margin;
  let targetY = y + 80;

  if (overlayPosition === 'top-right') {
    targetX = x + width - winWidth - margin;
    targetY = y + 80;
  } else if (overlayPosition === 'bottom-left') {
    targetX = x + margin;
    targetY = y + height - winHeight - 60;
  } else if (overlayPosition === 'bottom-right') {
    targetX = x + width - winWidth - margin;
    targetY = y + height - winHeight - 60;
  }

  overlayWindow.setBounds({ x: targetX, y: targetY, width: winWidth, height: winHeight });
}

function createOrUpdateOverlayWindow(runtimePaths) {
  if (!overlayEnabled) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
    return;
  }

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = new BrowserWindow({
      width: 260,
      height: 380,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: runtimePaths.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    });

    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    applyOverlayWindowBounds();

    overlayWindow.loadFile(runtimePaths.overlayHtmlPath).then(() => {
      if (overlayEnabled && lastOverlayPayload.users && lastOverlayPayload.users.length > 0) {
        overlayWindow.showInactive();
        overlayWindow.webContents.send('overlay:render', lastOverlayPayload);
      }
    }).catch(() => {});
  } else {
    applyOverlayWindowBounds();
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    if (lastOverlayPayload.users && lastOverlayPayload.users.length > 0) {
      if (!overlayWindow.isVisible()) overlayWindow.showInactive();
      overlayWindow.webContents.send('overlay:render', lastOverlayPayload);
    } else {
      overlayWindow.hide();
    }
  }
}

// ================= 5. REGISTO DE ATALHOS GLOBAIS PERSONALIZÁVEIS =================
function registerConfiguredHotkeys(runtimePaths) {
  globalShortcut.unregisterAll();

  const safeRegister = (accel, handler) => {
    if (!accel || typeof accel !== 'string' || !accel.trim()) return;
    try {
      globalShortcut.register(accel.trim(), handler);
    } catch (e) {}
  };

  safeRegister(currentHotkeys.toggleMic, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:hotkey-command', { action: 'toggle-mic' });
    }
  });

  safeRegister(currentHotkeys.muteMic, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:hotkey-command', { action: 'mute-mic' });
    }
  });

  safeRegister(currentHotkeys.unmuteMic, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:hotkey-command', { action: 'unmute-mic' });
    }
  });

  safeRegister(currentHotkeys.pushToTalk, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:hotkey-command', { action: 'ptt-trigger' });
    }
  });

  safeRegister(currentHotkeys.toggleOverlay, () => {
    overlayEnabled = !overlayEnabled;
    createOrUpdateOverlayWindow(runtimePaths);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:overlay-toggled', overlayEnabled);
    }
  });

  safeRegister(currentHotkeys.toggleDeafen, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:hotkey-command', { action: 'toggle-deafen' });
    }
  });
}

// ================= 6. JANELA PRINCIPAL E HANDLERS IPC =================
function createMainWindow(runtimePaths) {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    title: 'Aether',
    icon: iconPaths.icoPath,
    backgroundColor: '#141821',
    autoHideMenuBar: true,
    webPreferences: {
      preload: runtimePaths.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      if (sources && sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({});
      }
    }).catch(() => callback({}));
  });

  mainWindow.loadURL(CLOUD_URL).catch(() => {
    require('./server.js');
    mainWindow.loadURL(LOCAL_URL);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      mainWindow.webContents.reloadIgnoringCache();
    }
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
    if (input.control && input.shift && input.key.toLowerCase() === 'l') {
      usingLocalMode = !usingLocalMode;
      mainWindow.loadURL(usingLocalMode ? LOCAL_URL : CLOUD_URL);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
    }
  });
}

app.whenReady().then(() => {
  const runtimePaths = ensureRuntimeBridgeFiles();

  ipcMain.on('desktop:overlay-state', (_event, payload) => {
    lastOverlayPayload = payload || { roomName: '', users: [] };
    createOrUpdateOverlayWindow(runtimePaths);
  });

  ipcMain.on('desktop:overlay-config', (_event, cfg) => {
    if (typeof cfg?.enabled === 'boolean') overlayEnabled = cfg.enabled;
    if (cfg?.position) overlayPosition = cfg.position;
    createOrUpdateOverlayWindow(runtimePaths);
  });

  ipcMain.handle('desktop:update-hotkeys', (_event, newHotkeys) => {
    if (newHotkeys && typeof newHotkeys === 'object') {
      currentHotkeys = { ...currentHotkeys, ...newHotkeys };
      registerConfiguredHotkeys(runtimePaths);
    }
    return { ok: true, hotkeys: currentHotkeys };
  });

  ipcMain.handle('desktop:get-hotkeys', () => currentHotkeys);

  ipcMain.on('desktop:notify', (_event, payload) => {
    if (!payload || !payload.title) return;

    const selfFullscreen = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen();
    if (isExternalFullscreenActive || selfFullscreen) {
      queuedNotifications.push({
        title: payload.title,
        body: payload.body || '',
        timestamp: new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      });
      if (queuedNotifications.length > 20) queuedNotifications.shift();
      return;
    }

    if (Notification.isSupported()) {
      const notif = new Notification({
        title: payload.title,
        body: payload.body || '',
        icon: iconPaths.pngPath,
        silent: false
      });
      notif.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      });
      notif.show();
    }
  });

  createMainWindow(runtimePaths);
  createOrUpdateOverlayWindow(runtimePaths);
  registerConfiguredHotkeys(runtimePaths);

  setInterval(checkWindowsFullscreenState, 2500);
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});