import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
   session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { nativeHelper } from './nativeClient';

// Register privileged secure custom scheme BEFORE app ready so AudioWorklet, WASM SIMD,
// Fetch API, WebRTC, and CORS work identically in packaged app.asar and browser HTTPS!
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aether',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Critical Chromium flags for Zero Audio Ducking, Zero Unfocused FPS Drop & Clean Hardware Video Encode/Decode
// Intentionally omits WebRtcUseGpuMemoryBufferVideoFrames & ignore-gpu-blocklist to prevent black H.264 streams
// on AMD/Intel GPUs and D3D11 lock contention in heavy DX12 games (e.g., Fortnite).
app.commandLine.appendSwitch(
  'disable-features',
  'AudioDucking,WebRtcHybridAgc,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes'
);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-accelerated-video-encode');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-gpu-rasterization');

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let pendingDisplayCaptureSourceId: string | null = null;
let activePowerBlockerId: number | null = null;
let lastOverlayBoundsKey = '';
let lastOverlayRenderJson = '';
let overlayAlignRight = false;

export interface UpdaterStatusPayload {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  progressPercent: number;
  bytesPerSecond: number;
  errorMessage: string | null;
}

let latestUpdaterStatus: UpdaterStatusPayload = {
  status: 'idle',
  currentVersion: app.getVersion() || '1.2.0',
  availableVersion: null,
  releaseNotes: null,
  progressPercent: 0,
  bytesPerSecond: 0,
  errorMessage: null,
};

function emitUpdaterStatus(patch: Partial<UpdaterStatusPayload>): void {
  latestUpdaterStatus = {
    ...latestUpdaterStatus,
    currentVersion: app.getVersion() || '1.2.0',
    ...patch,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', latestUpdaterStatus);
  }
}

function configureAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    emitUpdaterStatus({ status: 'checking', errorMessage: null });
  });

  autoUpdater.on('update-available', (info) => {
    const rawNotes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note || '').join('\n')
          : null;
    emitUpdaterStatus({
      status: 'available',
      availableVersion: info.version,
      releaseNotes: rawNotes,
      progressPercent: 0,
      errorMessage: null,
    });
  });

  autoUpdater.on('download-progress', (prog) => {
    emitUpdaterStatus({
      status: 'downloading',
      progressPercent: Math.round((prog.percent || 0) * 10) / 10,
      bytesPerSecond: Math.round(prog.bytesPerSecond || 0),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const rawNotes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note || '').join('\n')
          : latestUpdaterStatus.releaseNotes;
    emitUpdaterStatus({
      status: 'downloaded',
      availableVersion: info.version,
      releaseNotes: rawNotes,
      progressPercent: 100,
      errorMessage: null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    emitUpdaterStatus({
      status: 'not-available',
      errorMessage: null,
    });
  });

  autoUpdater.on('error', (err) => {
    emitUpdaterStatus({
      status: 'error',
      errorMessage: err?.message || 'Falha ao verificar atualizações',
    });
  });

  if (app.isPackaged) {
    setTimeout(() => {
      void autoUpdater.checkForUpdates().catch(() => {});
    }, 6000);

    setInterval(() => {
      void autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);
  }
}

interface OverlayConfig {
  enabled: boolean;
  position: string;
  customX: number;
  customY: number;
  scale: number;
  opacity: number;
  showOnlySpeaking: boolean;
}

let currentOverlayConfig: OverlayConfig = {
  enabled: true,
  position: 'top-left',
  customX: 24,
  customY: 24,
  scale: 1,
  opacity: 0.88,
  showOnlySpeaking: false,
};

let currentOverlayState: { roomName: string | null; participants: unknown[] } = {
  roomName: null,
  participants: [],
};

function resolveIconPath(filename: string): string {
  const candidates = [
    path.join(process.resourcesPath || '', 'icons', filename),
    path.resolve(__dirname, '../resources/icons', filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[1];
}

function getHwndNumber(win: BrowserWindow): number {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? Number(buf.readBigInt64LE(0)) : buf.readInt32LE(0);
  } catch {
    return 0;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function registerAetherProtocol(): void {
  const rendererRoot = path.resolve(__dirname, '../renderer');

  protocol.handle('aether', async (request) => {
    try {
      const parsed = new URL(request.url);
      let reqPath = decodeURIComponent(parsed.pathname || '/');
      if (reqPath === '/' || reqPath === '') {
        reqPath = '/index.html';
      }

      const candidate = path.resolve(rendererRoot, `.${reqPath}`);
      const isInsideRoot =
        candidate === rendererRoot || candidate.startsWith(rendererRoot + path.sep);

      let targetFile = isInsideRoot ? candidate : path.join(rendererRoot, 'index.html');
      if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
        if (!path.extname(targetFile)) {
          targetFile = path.join(rendererRoot, 'index.html');
        } else {
          return new Response('Not Found', { status: 404 });
        }
      }

      const data = await fs.promises.readFile(targetFile);
      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';

      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      console.error('[Protocol aether://] Failed serving asset:', err);
      return new Response('Internal Error', { status: 500 });
    }
  });
}

function collectElectronPriorityPids(): { pids: number[]; highPriorityPids: number[] } {
  const metrics = app.getAppMetrics();
  const pids = metrics.map((m) => m.pid);
  const highPriorityPids = metrics
    .filter(
      (m) =>
        m.type === 'GPU' ||
        m.type === 'Utility' ||
        (typeof m.serviceName === 'string' &&
          /video|capture|audio|gpu/i.test(m.serviceName))
    )
    .map((m) => m.pid);
  return { pids, highPriorityPids };
}

function configureMediaAndDisplayPermissions(): void {
  const allowedPermissions = new Set([
    'media',
    'display-capture',
    'mediaKeySystem',
    'notifications',
    'clipboard-sanitized-write',
    'fullscreen',
  ]);

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return allowedPermissions.has(permission);
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });

      const targetId = pendingDisplayCaptureSourceId;
      pendingDisplayCaptureSourceId = null;

      let chosen = targetId ? sources.find((s) => s.id === targetId) : undefined;
      if (!chosen) {
        chosen =
          sources.find((s) => s.id.startsWith('screen:')) ||
          sources.find((s) => s.name !== 'Aether Overlay');
      }

      if (!chosen) {
        callback({});
        return;
      }

      callback({ video: chosen });
    } catch (err) {
      console.error('[Desktop DisplayMediaHandler] Error selecting source:', err);
      callback({});
    }
  });
}

// Encrypted Credential Vault (Windows DPAPI via electron.safeStorage + AES-256-GCM fallback)
function getVaultFilePath(): string {
  return path.join(app.getPath('userData'), 'session.vault');
}

function getFallbackMachineKey(): Buffer {
  const seed = `${app.getPath('userData')}::com.aether.realtime::v1`;
  return crypto.createHash('sha256').update(seed, 'utf8').digest();
}

function saveEncryptedVault(payload: { refreshToken: string; serverUrl?: string }): boolean {
  try {
    const vaultPath = getVaultFilePath();
    fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
    const rawJson = JSON.stringify(payload);

    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(rawJson);
      const envelope = Buffer.concat([Buffer.from('DPAPI1:', 'ascii'), encrypted]);
      fs.writeFileSync(vaultPath, envelope, { mode: 0o600 });
      return true;
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getFallbackMachineKey(), iv);
    const ct = Buffer.concat([cipher.update(rawJson, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const fallbackEnv = `AES1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
    fs.writeFileSync(vaultPath, fallbackEnv, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (err) {
    console.error('[SecureVault] Failed saving encrypted credentials:', err);
    return false;
  }
}

function loadEncryptedVault(): { refreshToken: string | null; serverUrl?: string | null } {
  try {
    const vaultPath = getVaultFilePath();
    if (!fs.existsSync(vaultPath)) {
      return { refreshToken: null, serverUrl: null };
    }
    const rawBuf = fs.readFileSync(vaultPath);
    const prefixDpapi = Buffer.from('DPAPI1:', 'ascii');

    let decryptedJson: string;
    if (rawBuf.subarray(0, prefixDpapi.length).equals(prefixDpapi)) {
      if (!safeStorage.isEncryptionAvailable()) {
        return { refreshToken: null, serverUrl: null };
      }
      decryptedJson = safeStorage.decryptString(rawBuf.subarray(prefixDpapi.length));
    } else {
      const text = rawBuf.toString('utf8');
      if (!text.startsWith('AES1:')) return { refreshToken: null, serverUrl: null };
      const [, ivHex, tagHex, ctHex] = text.split(':');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        getFallbackMachineKey(),
        Buffer.from(ivHex, 'hex')
      );
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      decryptedJson = Buffer.concat([
        decipher.update(Buffer.from(ctHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    }

    const parsed = JSON.parse(decryptedJson) as {
      refreshToken?: string | null;
      serverUrl?: string | null;
    };
    return {
      refreshToken: parsed.refreshToken || null,
      serverUrl: parsed.serverUrl || null,
    };
  } catch {
    return { refreshToken: null, serverUrl: null };
  }
}

function clearEncryptedVault(): void {
  try {
    const vaultPath = getVaultFilePath();
    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { force: true });
    }
  } catch {
    // Ignore
  }
}

function createMainWindow(): void {
  const iconPath = resolveIconPath('icon.ico');
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 650,
    frame: false,
    show: !process.argv.includes('--minimized'),
    backgroundColor: '#090a0d',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const devUrl = process.env.AETHER_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadURL('aether://app/index.html');
  }

  mainWindow.webContents.on('did-finish-load', () => {
    const { pids, highPriorityPids } = collectElectronPriorityPids();
    void nativeHelper.sendCommand('setBroadcastBoost', { active: false, pids, highPriorityPids });
    mainWindow?.webContents.send('updater:status', latestUpdaterStatus);
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createOverlayWindow(): void {
  overlayWindow = new BrowserWindow({
    width: 340,
    height: 420,
    x: 24,
    y: 24,
    frame: false,
    transparent: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  const overlayHtml = path.resolve(__dirname, '../overlay/index.html');
  void overlayWindow.loadFile(overlayHtml).then(() => {
    const hwnd = getHwndNumber(overlayWindow!);
    if (hwnd) {
      void nativeHelper.sendCommand('applyOverlayShield', { hwnd, clickThrough: true });
    }
    syncOverlayVisibilityAndRender(true);
  });
}

function repositionOverlayIfNeeded(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const primary = screen.getPrimaryDisplay();
  const { x: areaX, y: areaY, width: areaW, height: areaH } = primary.workArea;
  const winW = 340;
  const winH = 420;
  const pad = 20;

  let targetX = areaX + pad;
  let targetY = areaY + pad;
  let alignRight = false;

  switch (currentOverlayConfig.position) {
    case 'top-right':
      targetX = areaX + areaW - winW - pad;
      targetY = areaY + pad;
      alignRight = true;
      break;
    case 'middle-left':
      targetX = areaX + pad;
      targetY = areaY + Math.round((areaH - winH) / 2);
      break;
    case 'middle-right':
      targetX = areaX + areaW - winW - pad;
      targetY = areaY + Math.round((areaH - winH) / 2);
      alignRight = true;
      break;
    case 'bottom-left':
      targetX = areaX + pad;
      targetY = areaY + areaH - winH - pad;
      break;
    case 'bottom-right':
      targetX = areaX + areaW - winW - pad;
      targetY = areaY + areaH - winH - pad;
      alignRight = true;
      break;
    case 'custom':
      targetX = currentOverlayConfig.customX;
      targetY = currentOverlayConfig.customY;
      break;
    default:
      targetX = areaX + pad;
      targetY = areaY + pad;
      break;
  }

  overlayAlignRight = alignRight;
  const boundsKey = `${targetX}:${targetY}:${winW}:${winH}`;
  if (boundsKey !== lastOverlayBoundsKey) {
    lastOverlayBoundsKey = boundsKey;
    overlayWindow.setBounds({ x: targetX, y: targetY, width: winW, height: winH });
  }
}

function syncOverlayVisibilityAndRender(forceReposition = false): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const participants = Array.isArray(currentOverlayState.participants)
    ? (currentOverlayState.participants as Array<{ speaking?: boolean }>)
    : [];
  const hasVisiblePeers = currentOverlayConfig.showOnlySpeaking
    ? participants.some((p) => Boolean(p.speaking))
    : participants.length > 0;
  const shouldShow =
    Boolean(currentOverlayConfig.enabled) &&
    Boolean(currentOverlayState.roomName) &&
    hasVisiblePeers;

  if (!shouldShow) {
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
    lastOverlayRenderJson = '';
    return;
  }

  if (forceReposition || !lastOverlayBoundsKey) {
    repositionOverlayIfNeeded();
  }

  if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
    const hwnd = getHwndNumber(overlayWindow);
    if (hwnd) {
      void nativeHelper.sendCommand('applyOverlayShield', { hwnd, clickThrough: true });
    }
  }

  const payload = {
    config: { ...currentOverlayConfig, alignRight: overlayAlignRight },
    state: currentOverlayState,
  };
  const serialized = JSON.stringify(payload);
  if (serialized !== lastOverlayRenderJson) {
    lastOverlayRenderJson = serialized;
    overlayWindow.webContents.send('overlay:render', payload);
  }
}

function createSystemTray(): void {
  const trayIconPath = resolveIconPath('tray.png');
  const icon = fs.existsSync(trayIconPath)
    ? nativeImage.createFromPath(trayIconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip(`Aether v${app.getVersion() || '1.1.0'} — Voz, Chat & Transmissão`);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir Aether',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Verificar Atualizações',
      click: () => {
        mainWindow?.show();
        if (app.isPackaged) {
          void autoUpdater.checkForUpdates().catch(() => {});
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Silenciar / Ativar Microfone',
      click: () => mainWindow?.webContents.send('input:shortcutTriggered', 'toggleMute'),
    },
    {
      label: 'Desativar / Reativar Áudio',
      click: () => mainWindow?.webContents.send('input:shortcutTriggered', 'toggleDeafen'),
    },
    {
      label: 'Alternar Overlay em Jogos',
      click: () => mainWindow?.webContents.send('input:shortcutTriggered', 'toggleOverlay'),
    },
    { type: 'separator' },
    {
      label: 'Sair do Aether',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function registerIpcHandlers(): void {
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on('window:close', (_ev, minimizeToTray: boolean) => {
    if (minimizeToTray) {
      mainWindow?.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
  });

  ipcMain.handle('app:setAutoStart', (_ev, enabled: boolean) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      args: ['--minimized'],
    });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('app:getAutoStart', () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  // Auto-Updater IPC
  ipcMain.handle('updater:getStatus', () => {
    return latestUpdaterStatus;
  });

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      emitUpdaterStatus({ status: 'not-available', errorMessage: null });
      return latestUpdaterStatus;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      emitUpdaterStatus({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Erro ao buscar atualizações',
      });
    }
    return latestUpdaterStatus;
  });

  ipcMain.handle('updater:quitAndInstall', () => {
    if (latestUpdaterStatus.status === 'downloaded') {
      isQuitting = true;
      setImmediate(() => {
        autoUpdater.quitAndInstall(false, true);
      });
      return { installing: true };
    }
    return { installing: false };
  });

  // Encrypted Windows DPAPI Credential Vault IPC
  ipcMain.handle(
    'vault:saveSession',
    (_ev, data: { refreshToken: string; serverUrl?: string }) => {
      if (!data || typeof data.refreshToken !== 'string') return false;
      return saveEncryptedVault(data);
    }
  );

  ipcMain.handle('vault:loadSession', () => {
    return loadEncryptedVault();
  });

  ipcMain.handle('vault:clearSession', () => {
    clearEncryptedVault();
  });

  // Screen & Window Capture Diagnostics + Permission Reauthorization
  ipcMain.handle('capture:getAccessStatus', () => {
    try {
      const screenAccess = systemPreferences.getMediaAccessStatus('screen');
      const micAccess = systemPreferences.getMediaAccessStatus('microphone');
      return { screenAccess, micAccess };
    } catch {
      return { screenAccess: 'granted', micAccess: 'granted' };
    }
  });

  ipcMain.handle('capture:openSystemPermissions', async () => {
    try {
      await shell.openExternal('ms-settings:privacy-graphicscaptureprogrammatic');
      return { opened: true };
    } catch {
      try {
        await shell.openExternal('ms-settings:privacy');
        return { opened: true };
      } catch {
        return { opened: false };
      }
    }
  });

  ipcMain.handle('capture:prepareDisplayMedia', (_ev, sourceId: string) => {
    pendingDisplayCaptureSourceId = typeof sourceId === 'string' && sourceId ? sourceId : null;
    return { ok: true };
  });

  ipcMain.handle('capture:listSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: true,
    });

    const results = [];
    for (const src of sources) {
      if (src.name === 'Aether Overlay') continue;
      const isScreen = src.id.startsWith('screen:');
      let hwnd: number | undefined;
      let pid: number | undefined;

      if (!isScreen) {
        const parts = src.id.split(':');
        const parsedHwnd = Number(parts[1]);
        if (Number.isFinite(parsedHwnd) && parsedHwnd > 0) {
          hwnd = parsedHwnd;
          const res = await nativeHelper.sendCommand('resolveHwndPid', { hwnd });
          if (res.ok && typeof res.pid === 'number' && res.pid > 0) {
            pid = res.pid;
          }
        }
      }

      results.push({
        id: src.id,
        name: src.name,
        kind: isScreen ? 'screen' : 'window',
        thumbnailDataUrl: src.thumbnail.toDataURL(),
        appIconDataUrl: src.appIcon && !src.appIcon.isEmpty() ? src.appIcon.toDataURL() : null,
        displayId: src.display_id,
        hwnd,
        pid,
      });
    }
    return results;
  });

  // Real Windows WASAPI Active Audio Applications List + Multi-Process Loopback Mixer
  ipcMain.handle('audio:listSessions', async () => {
    const res = await nativeHelper.sendCommand('listAudioSessions');
    return Array.isArray(res.sessions) ? res.sessions : [];
  });

  ipcMain.handle('audio:startProcessLoopback', async (_ev, options: Record<string, unknown>) => {
    return nativeHelper.sendCommand('startLoopback', options);
  });

  ipcMain.handle('audio:stopProcessLoopback', async () => {
    await nativeHelper.sendCommand('stopLoopback');
  });

  ipcMain.handle('input:configureShortcuts', async (_ev, cfg: Record<string, unknown>) => {
    await nativeHelper.sendCommand('configureShortcuts', cfg);
  });

  ipcMain.handle('perf:setBroadcastActive', async (_ev, active: boolean) => {
    const isBroadcasting = Boolean(active);
    if (isBroadcasting) {
      if (activePowerBlockerId === null || !powerSaveBlocker.isStarted(activePowerBlockerId)) {
        activePowerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      }
    } else if (activePowerBlockerId !== null) {
      if (powerSaveBlocker.isStarted(activePowerBlockerId)) {
        powerSaveBlocker.stop(activePowerBlockerId);
      }
      activePowerBlockerId = null;
    }

    const { pids, highPriorityPids } = collectElectronPriorityPids();
    return nativeHelper.sendCommand('setBroadcastBoost', {
      active: isBroadcasting,
      pids,
      highPriorityPids,
    });
  });

  ipcMain.handle('overlay:updateConfig', (_ev, settings: OverlayConfig) => {
    currentOverlayConfig = { ...currentOverlayConfig, ...settings };
    syncOverlayVisibilityAndRender(true);
  });

  ipcMain.on('overlay:updateState', (_ev, state: { roomName: string | null; participants: unknown[] }) => {
    currentOverlayState = state;
    syncOverlayVisibilityAndRender(false);
  });

  nativeHelper.on('pcm', (buffer: ArrayBuffer) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:pcmFrame', new Uint8Array(buffer));
    }
  });

  nativeHelper.on('ptt', (pressed: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('input:pttState', pressed);
    }
  });

  nativeHelper.on('shortcut', (action: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('input:shortcutTriggered', action);
    }
  });
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('aether-app', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('aether-app');
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.aether.realtime');
    registerAetherProtocol();
    configureMediaAndDisplayPermissions();
    nativeHelper.start();
    registerIpcHandlers();
    createSystemTray();
    createMainWindow();
    createOverlayWindow();
    configureAutoUpdater();
    screen.on('display-metrics-changed', () => {
      syncOverlayVisibilityAndRender(true);
    });
  });
}
