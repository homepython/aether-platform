import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aetherDesktop', {
  isDesktop: true,
  platform: process.platform,
  appVersion: '1.1.0',
  defaultServerUrl: process.env.AETHER_SERVER_URL || 'https://aether-platform.onrender.com',

  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeOrRestoreWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: (minimizeToTray: boolean) => ipcRenderer.send('window:close', minimizeToTray),

  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('app:setAutoStart', enabled),
  getAutoStart: () => ipcRenderer.invoke('app:getAutoStart'),

  updater: {
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    check: () => ipcRenderer.invoke('updater:check'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
    onStatus: (cb: (status: unknown) => void) => {
      const listener = (_ev: unknown, status: unknown) => cb(status);
      ipcRenderer.on('updater:status', listener);
      return () => {
        ipcRenderer.removeListener('updater:status', listener);
      };
    },
  },

  secureVault: {
    saveSession: (data: { refreshToken: string; serverUrl?: string }) =>
      ipcRenderer.invoke('vault:saveSession', data),
    loadSession: () => ipcRenderer.invoke('vault:loadSession'),
    clearSession: () => ipcRenderer.invoke('vault:clearSession'),
  },

  getCaptureAccessStatus: () => ipcRenderer.invoke('capture:getAccessStatus'),
  openCaptureSystemPermissions: () => ipcRenderer.invoke('capture:openSystemPermissions'),
  listCaptureSources: () => ipcRenderer.invoke('capture:listSources'),
  prepareDisplayMedia: (sourceId: string) =>
    ipcRenderer.invoke('capture:prepareDisplayMedia', sourceId),

  listAudioSessions: () => ipcRenderer.invoke('audio:listSessions'),

  startProcessLoopback: (options: {
    mode: 'exclude-self' | 'include-process' | 'include-multi';
    targetPid?: number;
    targetHwnd?: number;
    targetPids?: number[];
  }) => ipcRenderer.invoke('audio:startProcessLoopback', options),

  stopProcessLoopback: () => ipcRenderer.invoke('audio:stopProcessLoopback'),

  onLoopbackPcm: (cb: (pcmFloat32Buffer: ArrayBuffer) => void) => {
    const listener = (_ev: unknown, buf: Uint8Array | ArrayBuffer) => {
      if (buf instanceof ArrayBuffer) {
        cb(buf);
      } else {
        const copy = new Uint8Array(buf.byteLength);
        copy.set(buf);
        cb(copy.buffer);
      }
    };
    ipcRenderer.on('audio:pcmFrame', listener);
    return () => {
      ipcRenderer.removeListener('audio:pcmFrame', listener);
    };
  },

  configureShortcuts: (config: unknown) => ipcRenderer.invoke('input:configureShortcuts', config),

  onPttState: (cb: (pressed: boolean) => void) => {
    const listener = (_ev: unknown, pressed: boolean) => cb(pressed);
    ipcRenderer.on('input:pttState', listener);
    return () => {
      ipcRenderer.removeListener('input:pttState', listener);
    };
  },

  onShortcutTriggered: (cb: (action: string) => void) => {
    const listener = (_ev: unknown, action: string) => cb(action);
    ipcRenderer.on('input:shortcutTriggered', listener);
    return () => {
      ipcRenderer.removeListener('input:shortcutTriggered', listener);
    };
  },

  updateOverlayConfig: (settings: unknown) => ipcRenderer.invoke('overlay:updateConfig', settings),

  updateOverlayState: (state: unknown) => ipcRenderer.send('overlay:updateState', state),

  setBroadcastActive: (active: boolean) => ipcRenderer.invoke('perf:setBroadcastActive', active),
});
