import type {
  AuthUser,
  ChatAttachment,
  CreateRoomInput,
  LoginInput,
  RegisterInput,
  RoomSummary,
  UserSettings,
} from '@aether/shared';
import { getDesktopApi } from '../bridge/DesktopBridge.js';

const SERVER_URL_STORAGE_KEY = 'aether:server_url';
const SESSION_HINT_KEY = 'aether:has_session';

// Scrub any legacy plaintext tokens from localStorage immediately on startup
if (typeof window !== 'undefined') {
  try {
    localStorage.removeItem('aether:access_token');
    localStorage.removeItem('aether:refresh_token');
  } catch {
    // Ignore storage access errors
  }
}

// Short-lived Access Token is kept strictly in volatile RAM (never written to localStorage!)
let memoryAccessToken: string | null = null;
// Desktop Refresh Token is kept in RAM and persisted ONLY via OS-encrypted Windows DPAPI (safeStorage)
let memoryDesktopRefreshToken: string | null = null;

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function getServerBaseUrl(): string {
  try {
    const saved = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    if (saved && saved.trim()) {
      return normalizeBaseUrl(saved);
    }
  } catch {
    // Ignore
  }

  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (envUrl && envUrl.trim()) {
    return normalizeBaseUrl(envUrl);
  }

  const desktopDefault = getDesktopApi()?.defaultServerUrl;
  if (desktopDefault && desktopDefault.trim()) {
    return normalizeBaseUrl(desktopDefault);
  }

  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    return normalizeBaseUrl(window.location.origin);
  }

  return 'http://localhost:3001';
}

export function setServerBaseUrl(url: string): void {
  const normalized = normalizeBaseUrl(url);
  try {
    if (normalized) {
      localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(SERVER_URL_STORAGE_KEY);
    }
  } catch {
    // Ignore
  }
}

export function resolveServerAssetUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = getServerBaseUrl();
  const cleanPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${cleanPath}`;
}

export function buildWsTicketUrl(ticket: string): string {
  const base = getServerBaseUrl();
  const wsBase = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`;
}

export function hasActiveMemoryToken(): boolean {
  return Boolean(memoryAccessToken);
}

async function persistSecureSessionTokens(
  accessToken: string | null,
  refreshToken: string | null
): Promise<void> {
  memoryAccessToken = accessToken;
  const desktop = getDesktopApi();

  if (desktop) {
    memoryDesktopRefreshToken = refreshToken;
    if (refreshToken) {
      await desktop.secureVault
        .saveSession({
          refreshToken,
          serverUrl: getServerBaseUrl(),
        })
        .catch(() => {});
    } else {
      await desktop.secureVault.clearSession().catch(() => {});
    }
  } else {
    // Browser relies on HttpOnly; SameSite=Strict cookie (`aether_rt`) set by the server
    try {
      if (accessToken) {
        localStorage.setItem(SESSION_HINT_KEY, '1');
      } else {
        localStorage.removeItem(SESSION_HINT_KEY);
      }
    } catch {
      // Ignore
    }
  }
}

let refreshPromise: Promise<{ user: AuthUser; accessToken: string } | null> | null = null;

async function performSessionRefresh(): Promise<{ user: AuthUser; accessToken: string } | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const desktop = getDesktopApi();
      let desktopRt = memoryDesktopRefreshToken;

      if (desktop && !desktopRt) {
        const vault = await desktop.secureVault.loadSession();
        if (vault.serverUrl && vault.serverUrl.trim()) {
          const hasExplicitLocal = Boolean(localStorage.getItem(SERVER_URL_STORAGE_KEY));
          if (!hasExplicitLocal) {
            setServerBaseUrl(vault.serverUrl);
          }
        }
        desktopRt = vault.refreshToken;
      }

      if (desktop && !desktopRt) {
        return null;
      }

      const res = await fetch(`${getServerBaseUrl()}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(desktopRt ? { refreshToken: desktopRt } : {}),
      });

      if (!res.ok) {
        await persistSecureSessionTokens(null, null);
        return null;
      }

      const data = (await res.json()) as {
        user: AuthUser;
        accessToken: string;
        refreshToken: string;
      };
      await persistSecureSessionTokens(data.accessToken, data.refreshToken);
      return { user: data.user, accessToken: data.accessToken };
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Restores an authenticated user session securely on app launch:
 * - Desktop: decrypts refresh token from Windows DPAPI (`electron.safeStorage`)
 * - Web: uses the `HttpOnly` refresh cookie without ever storing tokens in `localStorage`
 */
export async function restoreSecureSession(): Promise<AuthUser | null> {
  const desktop = getDesktopApi();
  if (!desktop) {
    let hasHint = false;
    try {
      hasHint = localStorage.getItem(SESSION_HINT_KEY) === '1';
    } catch {
      hasHint = false;
    }
    if (!hasHint && !memoryAccessToken) {
      return null;
    }
  }

  const refreshed = await performSessionRefresh();
  return refreshed ? refreshed.user : null;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  authenticated = true
): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (!(init.body instanceof FormData) && !headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (authenticated && !memoryAccessToken) {
    await performSessionRefresh();
  }

  if (authenticated && memoryAccessToken) {
    headers.set('Authorization', `Bearer ${memoryAccessToken}`);
  }

  let res = await fetch(`${getServerBaseUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (res.status === 401 && authenticated) {
    const refreshed = await performSessionRefresh();
    if (refreshed?.accessToken) {
      headers.set('Authorization', `Bearer ${refreshed.accessToken}`);
      res = await fetch(`${getServerBaseUrl()}${path}`, {
        ...init,
        credentials: 'include',
        headers,
      });
    }
  }

  if (!res.ok) {
    let errMsg = `Erro HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) errMsg = body.error;
    } catch {
      // Ignore JSON parse error
    }
    throw new Error(errMsg);
  }

  return (await res.json()) as T;
}

export interface ServerHealthStatus {
  ok: boolean;
  latencyMs: number;
  database?: string;
  onlineConnections?: number;
  error?: string;
}

export const api = {
  checkServerHealth: async (customUrl?: string): Promise<ServerHealthStatus> => {
    const target = normalizeBaseUrl(customUrl || getServerBaseUrl());
    const start = performance.now();
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 4500);
    try {
      const res = await fetch(`${target}/api/health`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { ok: false, latencyMs: Math.round(performance.now() - start), error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as {
        status?: string;
        database?: string;
        onlineConnections?: number;
      };
      return {
        ok: data.status === 'ok',
        latencyMs: Math.max(1, Math.round(performance.now() - start)),
        database: data.database,
        onlineConnections: data.onlineConnections,
      };
    } catch {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        error: 'Servidor inacessível ou offline',
      };
    } finally {
      window.clearTimeout(timer);
    }
  },

  register: async (input: RegisterInput) => {
    const data = await apiRequest<{ user: AuthUser; accessToken: string; refreshToken: string }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify(input) },
      false
    );
    await persistSecureSessionTokens(data.accessToken, data.refreshToken);
    return data;
  },

  login: async (input: LoginInput) => {
    const data = await apiRequest<{ user: AuthUser; accessToken: string; refreshToken: string }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify(input) },
      false
    );
    await persistSecureSessionTokens(data.accessToken, data.refreshToken);
    return data;
  },

  logout: async () => {
    const desktopRt = memoryDesktopRefreshToken;
    await persistSecureSessionTokens(null, null);
    await fetch(`${getServerBaseUrl()}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(desktopRt ? { refreshToken: desktopRt } : {}),
    }).catch(() => {});
  },

  createWsTicket: async (): Promise<{ ticket: string; wsUrl: string }> => {
    const data = await apiRequest<{ ticket: string; expiresInSec: number }>(
      '/api/auth/ws-ticket',
      { method: 'POST', body: JSON.stringify({}) },
      true
    );
    return {
      ticket: data.ticket,
      wsUrl: buildWsTicketUrl(data.ticket),
    };
  },

  me: () => apiRequest<{ user: AuthUser }>('/api/auth/me'),

  saveSettings: (settings: UserSettings) =>
    apiRequest<{ settings: UserSettings }>('/api/users/me/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  updateProfile: (updates: { displayName?: string; avatarUrl?: string | null }) =>
    apiRequest<{ user: AuthUser }>('/api/users/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  listRooms: () => apiRequest<{ rooms: RoomSummary[] }>('/api/rooms'),

  createRoom: (input: CreateRoomInput) =>
    apiRequest<{ room: RoomSummary }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteRoom: (roomId: string) =>
    apiRequest<{ deleted: boolean }>(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: 'DELETE',
    }),

  uploadFile: async (file: File): Promise<ChatAttachment> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const data = await apiRequest<{ attachment: ChatAttachment }>('/api/uploads', {
      method: 'POST',
      body: form,
    });
    return data.attachment;
  },

  getReleaseInfo: () =>
    apiRequest<{
      version: string;
      platform: string;
      available: boolean;
      filename: string;
      sizeBytes: number | null;
      downloadUrl: string;
    }>('/api/releases/info', {}, false),
};
