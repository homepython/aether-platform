import type { OverlaySettings, ShortcutSettings, UserRole } from '@aether/shared';

export interface DesktopCaptureSourceItem {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  displayId: string;
  hwnd?: number;
  pid?: number;
}

export interface DesktopAudioSessionItem {
  pid: number;
  processName: string;
  displayName: string;
  peak: number;
  isPlaying: boolean;
}

export interface DesktopUpdaterStatus {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'not-available'
    | 'error';
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  progressPercent: number;
  bytesPerSecond: number;
  errorMessage: string | null;
}

export interface OverlayParticipantState {
  userId: string;
  displayName: string;
  avatarColor: string;
  avatarUrl?: string | null;
  role?: UserRole;
  speaking: boolean;
  micMuted: boolean;
  isStreaming: boolean;
}

export interface DesktopSecureVaultSession {
  refreshToken: string | null;
  serverUrl?: string | null;
}

export interface AetherDesktopApi {
  isDesktop: true;
  platform: string;
  appVersion: string;
  defaultServerUrl?: string;
  // Window controls
  minimizeWindow: () => void;
  maximizeOrRestoreWindow: () => void;
  closeWindow: (minimizeToTray: boolean) => void;
  // App lifecycle settings
  setAutoStart: (enabled: boolean) => Promise<boolean>;
  getAutoStart: () => Promise<boolean>;
  // Automatic GitHub Releases Updater (electron-updater with SHA-512 verification)
  updater?: {
    getStatus: () => Promise<DesktopUpdaterStatus>;
    check: () => Promise<DesktopUpdaterStatus>;
    quitAndInstall: () => Promise<{ installing: boolean }>;
    onStatus: (cb: (status: DesktopUpdaterStatus) => void) => () => void;
  };
  // Encrypted OS Credential Vault (Windows DPAPI via electron.safeStorage)
  secureVault: {
    saveSession: (data: { refreshToken: string; serverUrl?: string }) => Promise<boolean>;
    loadSession: () => Promise<DesktopSecureVaultSession>;
    clearSession: () => Promise<void>;
  };
  // Screen & Game Window Capture (WGC Unified DisplayMedia + Source Picker + Permission Diagnostics)
  getCaptureAccessStatus?: () => Promise<{ screenAccess: string; micAccess: string }>;
  openCaptureSystemPermissions?: () => Promise<{ opened: boolean }>;
  listCaptureSources: () => Promise<DesktopCaptureSourceItem[]>;
  prepareDisplayMedia: (sourceId: string) => Promise<{ ok: boolean; error?: string }>;
  // Native WASAPI Active Audio Applications + Multi-Process Isolated Audio Loopback (Zero Voice Echo!)
  listAudioSessions?: () => Promise<DesktopAudioSessionItem[]>;
  startProcessLoopback: (options: {
    mode: 'exclude-self' | 'include-process' | 'include-multi';
    targetPid?: number;
    targetHwnd?: number;
    targetPids?: number[];
  }) => Promise<{ ok: boolean; mode?: string; count?: number; error?: string }>;
  stopProcessLoopback: () => Promise<void>;
  onLoopbackPcm: (cb: (pcmFloat32Buffer: ArrayBuffer) => void) => () => void;
  // Global Non-Blocking In-Game Push-To-Talk & Shortcuts
  configureShortcuts: (config: {
    pttEnabled: boolean;
    pttKey: string;
    shortcuts: ShortcutSettings;
  }) => Promise<void>;
  onPttState: (cb: (pressed: boolean) => void) => () => void;
  onShortcutTriggered: (
    cb: (action: 'toggleMute' | 'toggleDeafen' | 'toggleOverlay' | 'stopStream') => void
  ) => () => void;
  // In-Game Focusless Overlay
  updateOverlayConfig: (settings: OverlaySettings) => Promise<void>;
  updateOverlayState: (state: {
    roomName: string | null;
    participants: OverlayParticipantState[];
  }) => void;
  // Hardware Broadcast Priority & Anti-Background-Throttling Shield
  setBroadcastActive: (active: boolean) => Promise<{
    ok: boolean;
    active?: boolean;
    boostedCount?: number;
  }>;
}

declare global {
  interface Window {
    aetherDesktop?: AetherDesktopApi;
  }
}

export function getDesktopApi(): AetherDesktopApi | null {
  if (typeof window !== 'undefined' && window.aetherDesktop?.isDesktop) {
    return window.aetherDesktop;
  }
  return null;
}

export function isDesktopClient(): boolean {
  return getDesktopApi() !== null;
}
