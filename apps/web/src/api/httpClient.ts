import type {
  AdminAuditLogEntry,
  AdminUserRecord,
  AuthUser,
  ChatAttachment,
  CreateRoomInput,
  LoginInput,
  RegisterInput,
  RoomSummary,
  UpdateProfileInput,
  UserPublic,
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
  if (/^(https?:|blob:|data:)/i.test(pathOrUrl)) return pathOrUrl;
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
    let errCode: string | undefined;
    let lockedUntil: string | null | undefined;
    try {
      const body = (await res.json()) as {
        error?: string;
        code?: string;
        lockedUntil?: string | null;
      };
      if (body?.error) errMsg = body.error;
      errCode = body?.code;
      lockedUntil = body?.lockedUntil;
    } catch {
      // Ignore JSON parse error
    }
    throw Object.assign(new Error(errMsg), {
      status: res.status,
      code: errCode,
      lockedUntil,
    });
  }

  return (await res.json()) as T;
}

export interface UploadProgressInfo {
  percent: number;
  loadedBytes: number;
  totalBytes: number;
}

async function uploadMultipartWithProgress<T>(
  path: string,
  file: File | Blob,
  filename: string,
  onProgress?: (info: UploadProgressInfo) => void,
  retried = false
): Promise<T> {
  if (!memoryAccessToken) {
    await performSessionRefresh();
  }

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getServerBaseUrl()}${path}`, true);
    xhr.withCredentials = true;
    xhr.timeout = 0; // Zero timeout so 500 MB+ files upload reliably on any connection speed

    if (memoryAccessToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${memoryAccessToken}`);
    }

    if (onProgress) {
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && ev.total > 0) {
          const percent = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
          onProgress({ percent, loadedBytes: ev.loaded, totalBytes: ev.total });
        }
      };
    }

    xhr.onload = async () => {
      if (xhr.status === 401 && !retried) {
        const refreshed = await performSessionRefresh();
        if (refreshed?.accessToken) {
          try {
            const retryRes = await uploadMultipartWithProgress<T>(
              path,
              file,
              filename,
              onProgress,
              true
            );
            resolve(retryRes);
            return;
          } catch (retryErr) {
            reject(retryErr);
            return;
          }
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new Error('Resposta inválida do servidor no envio de arquivo'));
        }
        return;
      }

      let errMsg = `Erro HTTP ${xhr.status}`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string };
        if (parsed?.error) errMsg = parsed.error;
      } catch {
        // Ignore
      }
      reject(new Error(errMsg));
    };

    xhr.onerror = () => {
      reject(new Error('Falha de rede durante o envio do arquivo'));
    };

    const form = new FormData();
    form.append('file', file, filename);
    xhr.send(form);
  });
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
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          error: `HTTP ${res.status}`,
        };
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

  updateProfile: (updates: UpdateProfileInput) =>
    apiRequest<{ user: AuthUser }>('/api/users/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  uploadAvatar: (
    file: File | Blob,
    filename = 'avatar.png',
    onProgress?: (info: UploadProgressInfo) => void
  ) =>
    uploadMultipartWithProgress<{ user: AuthUser; avatarUrl: string }>(
      '/api/users/me/avatar',
      file,
      filename,
      onProgress
    ),

  getPublicUserProfile: (username: string) =>
    apiRequest<{ user: UserPublic }>(
      `/api/users/${encodeURIComponent(username.replace(/^@+/, ''))}/profile`
    ),

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

  uploadFile: async (
    file: File,
    onProgress?: (info: UploadProgressInfo) => void
  ): Promise<ChatAttachment> => {
    const data = await uploadMultipartWithProgress<{ attachment: ChatAttachment }>(
      '/api/uploads',
      file,
      file.name,
      onProgress
    );
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

  // Cloud Administration & Role System (RBAC)
  claimOwner: (masterKey: string) =>
    apiRequest<{ user: AuthUser }>('/api/admin/claim-owner', {
      method: 'POST',
      body: JSON.stringify({ masterKey }),
    }),

  listAdminUsers: () => apiRequest<{ users: AdminUserRecord[] }>('/api/admin/users'),

  updateUserRole: (userId: string, role: 'admin' | 'moderator' | 'member') =>
    apiRequest<{ user: AuthUser }>(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),

  setUserBan: (userId: string, banned: boolean, reason?: string | null) =>
    apiRequest<{ ok: boolean; banned: boolean }>(
      `/api/admin/users/${encodeURIComponent(userId)}/ban`,
      {
        method: 'POST',
        body: JSON.stringify({ banned, reason: reason || null }),
      }
    ),

  listAdminAuditLogs: () =>
    apiRequest<{ logs: AdminAuditLogEntry[] }>('/api/admin/audit-logs'),
};
