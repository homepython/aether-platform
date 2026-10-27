const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { execFileSync } = require('child_process');

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

function downloadFileFollowRedirects(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFileFollowRedirects(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureWinCodeSignCache() {
  if (process.platform !== 'win32') return;
  const localAppData = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const cacheDir = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
  const targetDir = path.join(cacheDir, 'winCodeSign-2.6.0');

  if (fs.existsSync(path.join(targetDir, 'rcedit-x64.exe'))) {
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'winCodeSign-2.6.0') {
      const candidatePath = path.join(cacheDir, entry.name);
      if (fs.existsSync(path.join(candidatePath, 'rcedit-x64.exe'))) {
        try {
          fs.renameSync(candidatePath, targetDir);
          return;
        } catch (e) {}
      }
    }
  }

  const archivePath = path.join(cacheDir, 'winCodeSign-2.6.0.7z');
  const sevenZipPath = path.join(__dirname, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  const url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';

  await downloadFileFollowRedirects(url, archivePath);
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    execFileSync(sevenZipPath, ['x', '-bd', '-y', '-xr!darwin', archivePath, `-o${targetDir}`], {
      stdio: 'ignore'
    });
  } catch (e) {}

  try {
    fs.unlinkSync(archivePath);
  } catch (e) {}
}

const iconPaths = ensureAppIcons();
if (process.argv.includes('--generate-icon')) {
  ensureWinCodeSignCache().then(() => process.exit(0)).catch(() => process.exit(0));
  return;
}

// ================= 2. PROCESSO PRINCIPAL DO ELECTRON (SEM ROUBO DE FOCO) =================
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
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let overlayWindow = null;
let runtimePathsGlobal = null;
let usingLocalMode = false;
let isMainWindowFocused = true;
let queuedNotifications = [];

let overlayConfig = {
  enabled: true,
  fullscreenOnly: true,
  showRoomTitle: true,
  size: 'medium',
  scale: 100,
  opacity: 90,
  position: 'top-left',
  customX: null,
  customY: null,
  unlocked: false
};

let lastOverlayPayload = {
  roomName: '',
  isSelfStreaming: false,
  viewersCount: 0,
  users: []
};

let currentHotkeys = {
  toggleMic: 'CommandOrControl+Shift+M',
  muteMic: 'CommandOrControl+Shift+Down',
  unmuteMic: 'CommandOrControl+Shift+Up',
  pushToTalk: 'CommandOrControl+Shift+Space',
  toggleOverlay: 'CommandOrControl+Shift+O',
  toggleDeafen: 'CommandOrControl+Shift+D'
};

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
      lockOverlayFromHud: () => ipcRenderer.send('desktop:overlay-lock-from-hud'),
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
      onOverlayBoundsChanged: (cb) => {
        ipcRenderer.removeAllListeners('desktop:overlay-bounds-changed');
        ipcRenderer.on('desktop:overlay-bounds-changed', (_e, pos) => cb(pos));
      },
      onOverlayLockChanged: (cb) => {
        ipcRenderer.removeAllListeners('desktop:overlay-lock-changed');
        ipcRenderer.on('desktop:overlay-lock-changed', (_e, unlocked) => cb(unlocked));
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
      transform-origin: top left;
      transition: opacity 150ms ease;
    }
    .overlay-root.unlocked-mode {
      background: rgba(15, 20, 32, 0.55);
      border: 1.5px dashed rgba(94, 129, 244, 0.85);
      border-radius: 16px;
    }
    .overlay-drag-bar {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(94, 129, 244, 0.28);
      border: 1px solid rgba(94, 129, 244, 0.65);
      color: #fff;
      padding: 5px 10px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
      -webkit-app-region: drag;
      cursor: move;
    }
    .overlay-root.unlocked-mode .overlay-drag-bar {
      display: flex;
    }
    .overlay-lock-btn {
      -webkit-app-region: no-drag;
      background: #10b981;
      border: none;
      color: #06281e;
      font-size: 10px;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    .overlay-header-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }
    .overlay-room-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(13, 17, 26, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 99px;
      padding: 4px 10px;
      color: rgba(240, 244, 255, 0.92);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.03em;
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
    .overlay-live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(244, 63, 94, 0.26);
      border: 1px solid rgba(244, 63, 94, 0.65);
      border-radius: 99px;
      padding: 4px 10px;
      color: #ffe4e6;
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0.04em;
      backdrop-filter: blur(10px);
      box-shadow: 0 4px 14px rgba(244, 63, 94, 0.25);
    }
    .overlay-viewers-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(94, 129, 244, 0.28);
      border: 1px solid rgba(94, 129, 244, 0.55);
      border-radius: 99px;
      padding: 4px 9px;
      color: #e0e7ff;
      font-size: 10.5px;
      font-weight: 700;
      backdrop-filter: blur(10px);
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
      background: rgba(15, 19, 29, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.11);
      border-radius: 999px;
      padding: 4px 11px 4px 4px;
      color: rgba(235, 240, 255, 0.88);
      transition: all 140ms ease;
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
    .overlay-root.size-small .overlay-user-pill {
      padding: 3px 9px 3px 3px;
      gap: 6px;
    }
    .overlay-root.size-large .overlay-user-pill {
      padding: 6px 14px 6px 6px;
      gap: 10px;
    }
    .overlay-user-pill.speaking {
      background: rgba(20, 28, 46, 0.95);
      border-color: #10b981;
      box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.48), 0 6px 18px rgba(0, 0, 0, 0.65);
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
    .overlay-root.size-small .overlay-avatar {
      width: 22px;
      height: 22px;
      font-size: 10px;
    }
    .overlay-root.size-large .overlay-avatar {
      width: 32px;
      height: 32px;
      font-size: 13.5px;
    }
    .overlay-user-pill.speaking .overlay-avatar {
      box-shadow: 0 0 12px #10b981;
      transform: scale(1.06);
    }
    .overlay-name {
      font-size: 12px;
      font-weight: 600;
      max-width: 145px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    }
    .overlay-root.size-small .overlay-name { font-size: 11px; max-width: 120px; }
    .overlay-root.size-large .overlay-name { font-size: 13.5px; max-width: 175px; }
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
  <div id="overlay-root" class="overlay-root size-medium" style="display:none;">
    <div class="overlay-drag-bar">
      <span>✥ Arraste para mover</span>
      <button type="button" id="btn-lock-overlay" class="overlay-lock-btn">Fixar</button>
    </div>
    <div id="overlay-header-row" class="overlay-header-row">
      <div id="overlay-room-badge" class="overlay-room-badge">
        <span class="overlay-room-dot"></span>
        <span id="overlay-room-title">Aether</span>
      </div>
      <div id="overlay-live-badge" class="overlay-live-badge" style="display:none;">
        <span>🔴 AO VIVO</span>
      </div>
      <div id="overlay-viewers-badge" class="overlay-viewers-badge" style="display:none;">
        <span id="overlay-viewers-text">👁 1 espectador</span>
      </div>
    </div>
    <div id="overlay-users-list" class="overlay-users-list"></div>
  </div>
  <script>
    document.getElementById('btn-lock-overlay')?.addEventListener('click', () => {
      window.aetherDesktop?.lockOverlayFromHud();
    });

    if (window.aetherDesktop && window.aetherDesktop.onOverlayRender) {
      window.aetherDesktop.onOverlayRender((payload) => {
        const root = document.getElementById('overlay-root');
        const headerRow = document.getElementById('overlay-header-row');
        const roomBadge = document.getElementById('overlay-room-badge');
        const titleEl = document.getElementById('overlay-room-title');
        const liveBadge = document.getElementById('overlay-live-badge');
        const viewersBadge = document.getElementById('overlay-viewers-badge');
        const viewersText = document.getElementById('overlay-viewers-text');
        const listEl = document.getElementById('overlay-users-list');

        const cfg = payload?.config || {};
        const users = payload?.users || [];

        if (users.length === 0 && !cfg.unlocked) {
          root.style.display = 'none';
          return;
        }

        root.style.display = 'flex';
        root.className = 'overlay-root size-' + (cfg.size || 'medium') + (cfg.unlocked ? ' unlocked-mode' : '');
        const scaleVal = Math.max(0.6, Math.min(1.6, Number(cfg.scale || 100) / 100));
        const opacityVal = Math.max(0.2, Math.min(1, Number(cfg.opacity || 90) / 100));
        root.style.transform = 'scale(' + scaleVal + ')';
        root.style.opacity = String(opacityVal);

        const showTitle = cfg.showRoomTitle !== false;
        roomBadge.style.display = showTitle ? 'inline-flex' : 'none';
        titleEl.textContent = payload.roomName || 'Sala de Voz';

        const isLive = Boolean(payload.isSelfStreaming);
        liveBadge.style.display = isLive ? 'inline-flex' : 'none';

        const viewersCount = Number(payload.viewersCount || 0);
        if (isLive && viewersCount > 0) {
          viewersBadge.style.display = 'inline-flex';
          viewersText.textContent = '👁 ' + viewersCount + ' ' + (viewersCount === 1 ? 'espectador' : 'espectadores');
        } else {
          viewersBadge.style.display = 'none';
        }

        headerRow.style.display = (showTitle || isLive) ? 'flex' : 'none';

        listEl.innerHTML = '';
        users.forEach((u) => {
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

function shouldDisplayOverlayNow() {
  if (!overlayConfig.enabled) return false;
  if (overlayConfig.unlocked) return true;

  const hasUsers = lastOverlayPayload.users && lastOverlayPayload.users.length > 0;
  if (!hasUsers) return false;

  const mainIsFullscreen = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen());

  // Nunca mostra o overlay por cima da própria janela normal do Aether quando ela está em foco
  if (isMainWindowFocused && !mainIsFullscreen) {
    return false;
  }

  if (overlayConfig.fullscreenOnly) {
    return Boolean(!isMainWindowFocused || mainIsFullscreen);
  }
  return true;
}

// Atualiza apenas o conteúdo interno do overlay via IPC sem invocar funções Win32 que roubam foco
function syncOverlayVisibilityAndContent() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const shouldShow = shouldDisplayOverlayNow();
  const isCurrentlyVisible = overlayWindow.isVisible();

  if (shouldShow) {
    if (!isCurrentlyVisible) {
      overlayWindow.showInactive();
    }
    overlayWindow.webContents.send('overlay:render', {
      ...lastOverlayPayload,
      config: overlayConfig
    });
  } else if (isCurrentlyVisible) {
    overlayWindow.hide();
  }
}

function applyOverlayWindowBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  const scaleFactor = Math.max(0.7, Math.min(1.6, Number(overlayConfig.scale || 100) / 100));
  const winWidth = Math.round(320 * scaleFactor);
  const winHeight = Math.round(440 * scaleFactor);
  const margin = 18;

  if (
    overlayConfig.position === 'custom' &&
    typeof overlayConfig.customX === 'number' &&
    typeof overlayConfig.customY === 'number'
  ) {
    overlayWindow.setBounds({
      x: Math.round(overlayConfig.customX),
      y: Math.round(overlayConfig.customY),
      width: winWidth,
      height: winHeight
    });
    return;
  }

  let targetX = x + margin;
  let targetY = y + 80;

  if (overlayConfig.position === 'top-right') {
    targetX = x + width - winWidth - margin;
    targetY = y + 80;
  } else if (overlayConfig.position === 'bottom-left') {
    targetX = x + margin;
    targetY = y + height - winHeight - 60;
  } else if (overlayConfig.position === 'bottom-right') {
    targetX = x + width - winWidth - margin;
    targetY = y + height - winHeight - 60;
  }

  overlayWindow.setBounds({ x: targetX, y: targetY, width: winWidth, height: winHeight });
}

function ensureOverlayWindowCreated(runtimePaths) {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  overlayWindow = new BrowserWindow({
    width: 320,
    height: 440,
    frame: false,
    transparent: true,
    type: 'toolbar',
    resizable: false,
    movable: true,
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

  overlayWindow.on('moved', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const b = overlayWindow.getBounds();
    overlayConfig.position = 'custom';
    overlayConfig.customX = b.x;
    overlayConfig.customY = b.y;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:overlay-bounds-changed', { x: b.x, y: b.y });
    }
  });

  overlayWindow.loadFile(runtimePaths.overlayHtmlPath).then(() => {
    syncOverlayVisibilityAndContent();
  }).catch(() => {});
}

function updateOverlayWindowConfiguration(runtimePaths, prevUnlocked) {
  ensureOverlayWindowCreated(runtimePaths);
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (prevUnlocked !== overlayConfig.unlocked) {
    overlayWindow.setFocusable(Boolean(overlayConfig.unlocked));
    overlayWindow.setIgnoreMouseEvents(!overlayConfig.unlocked, { forward: true });
    if (overlayConfig.unlocked) {
      overlayWindow.show();
    }
  }

  applyOverlayWindowBounds();
  syncOverlayVisibilityAndContent();
}

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
    overlayConfig.enabled = !overlayConfig.enabled;
    syncOverlayVisibilityAndContent();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:overlay-toggled', overlayConfig.enabled);
    }
  });

  safeRegister(currentHotkeys.toggleDeafen, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:hotkey-command', { action: 'toggle-deafen' });
    }
  });
}

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

  mainWindow.on('focus', () => {
    isMainWindowFocused = true;
    syncOverlayVisibilityAndContent();
    if (queuedNotifications.length > 0 && !mainWindow.isFullScreen()) {
      const pending = queuedNotifications.splice(0, queuedNotifications.length);
      mainWindow.webContents.send('desktop:flushed-notifications', pending);
    }
  });

  mainWindow.on('blur', () => {
    isMainWindowFocused = false;
    syncOverlayVisibilityAndContent();
  });

  mainWindow.on('enter-full-screen', () => {
    syncOverlayVisibilityAndContent();
  });

  mainWindow.on('leave-full-screen', () => {
    syncOverlayVisibilityAndContent();
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
  runtimePathsGlobal = ensureRuntimeBridgeFiles();

  // Atualização rápida de estado (quem está a falar): NUNCA altera foco nem bounds da janela
  ipcMain.on('desktop:overlay-state', (_event, payload) => {
    lastOverlayPayload = {
      roomName: payload?.roomName || '',
      isSelfStreaming: Boolean(payload?.isSelfStreaming),
      viewersCount: Number(payload?.viewersCount || 0),
      users: Array.isArray(payload?.users) ? payload.users : []
    };
    ensureOverlayWindowCreated(runtimePathsGlobal);
    syncOverlayVisibilityAndContent();
  });

  ipcMain.on('desktop:overlay-config', (_event, cfg) => {
    const prevUnlocked = overlayConfig.unlocked;
    if (cfg && typeof cfg === 'object') {
      overlayConfig = { ...overlayConfig, ...cfg };
    }
    updateOverlayWindowConfiguration(runtimePathsGlobal, prevUnlocked);
  });

  ipcMain.on('desktop:overlay-lock-from-hud', () => {
    const prevUnlocked = overlayConfig.unlocked;
    overlayConfig.unlocked = false;
    updateOverlayWindowConfiguration(runtimePathsGlobal, prevUnlocked);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:overlay-lock-changed', false);
    }
  });

  ipcMain.handle('desktop:update-hotkeys', (_event, newHotkeys) => {
    if (newHotkeys && typeof newHotkeys === 'object') {
      currentHotkeys = { ...currentHotkeys, ...newHotkeys };
      registerConfiguredHotkeys(runtimePathsGlobal);
    }
    return { ok: true, hotkeys: currentHotkeys };
  });

  ipcMain.handle('desktop:get-hotkeys', () => currentHotkeys);

  ipcMain.on('desktop:notify', (_event, payload) => {
    if (!payload || !payload.title) return;

    const selfFullscreen = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen();
    if (!isMainWindowFocused || selfFullscreen) {
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
        silent: true
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

  createMainWindow(runtimePathsGlobal);
  ensureOverlayWindowCreated(runtimePathsGlobal);
  registerConfiguredHotkeys(runtimePathsGlobal);
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});