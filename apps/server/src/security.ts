import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

const SCRYPT_KEYLEN = 64;
const SCRYPT_V2_OPTIONS: crypto.ScryptOptions = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};
const SCRYPT_V1_OPTIONS: crypto.ScryptOptions = {
  N: 16384,
  r: 8,
  p: 1,
};

// Derive isolated 256-bit cryptographic subkeys via HKDF-SHA256
const DATA_AES_KEY = Buffer.from(
  crypto.hkdfSync(
    'sha256',
    Buffer.from(config.security.dataEncryptionSecret, 'utf8'),
    Buffer.from('aether-storage-salt-v1', 'utf8'),
    Buffer.from('aes-256-gcm-sensitive-fields', 'utf8'),
    32
  )
);

const BLIND_INDEX_KEY = Buffer.from(
  crypto.hkdfSync(
    'sha256',
    Buffer.from(config.security.dataEncryptionSecret, 'utf8'),
    Buffer.from('aether-storage-salt-v1', 'utf8'),
    Buffer.from('hmac-sha256-blind-index', 'utf8'),
    32
  )
);

function applyPasswordPepper(plain: string): Buffer {
  return crypto
    .createHmac('sha256', config.security.passwordPepper)
    .update(plain, 'utf8')
    .digest();
}

/**
 * Hashes a user or room password using OWASP high-security scrypt (N=32768, r=8, p=1),
 * an individual 256-bit (32-byte) CSPRNG salt, and a server-side HMAC-SHA256 pepper.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(32).toString('hex');
  const peppered = applyPasswordPepper(plain);
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(peppered, Buffer.from(salt, 'hex'), SCRYPT_KEYLEN, SCRYPT_V2_OPTIONS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `scrypt2$${salt}$${derivedKey.toString('hex')}`;
}

export function needsPasswordRehash(storedHash: string): boolean {
  return !storedHash.startsWith('scrypt2$');
}

export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [scheme, salt, keyHex] = parts;

  if (scheme === 'scrypt2') {
    const expected = Buffer.from(keyHex, 'hex');
    const peppered = applyPasswordPepper(plain);
    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        peppered,
        Buffer.from(salt, 'hex'),
        expected.length,
        SCRYPT_V2_OPTIONS,
        (err, key) => {
          if (err) reject(err);
          else resolve(key);
        }
      );
    });
    if (derivedKey.length !== expected.length) return false;
    return crypto.timingSafeEqual(derivedKey, expected);
  }

  if (scheme === 'scrypt') {
    const expected = Buffer.from(keyHex, 'hex');
    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(plain, salt, expected.length, SCRYPT_V1_OPTIONS, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
    if (derivedKey.length !== expected.length) return false;
    return crypto.timingSafeEqual(derivedKey, expected);
  }

  return false;
}

let cachedDummyPasswordHashPromise: Promise<string> | null = null;

/**
 * Executes a full scrypt2 verification against a dummy hash when an identifier does not exist,
 * preventing timing side-channel enumeration of registered usernames/emails.
 */
export async function verifyDummyPassword(plain: string): Promise<void> {
  if (!cachedDummyPasswordHashPromise) {
    cachedDummyPasswordHashPromise = hashPassword('AetherConstantTimeDummy#2026!');
  }
  const dummyHash = await cachedDummyPasswordHashPromise;
  await verifyPassword(plain, dummyHash);
}

/**
 * Encrypts sensitive PII (such as user email) at rest using authenticated AES-256-GCM
 * with a unique 96-bit random IV and 128-bit authentication tag.
 */
export function encryptSensitiveData(plaintext: string): string {
  if (plaintext.startsWith('enc1$')) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc1$${iv.toString('hex')}$${authTag.toString('hex')}$${encrypted.toString('hex')}`;
}

export function decryptSensitiveData(stored: string): string {
  if (!stored.startsWith('enc1$')) {
    return stored;
  }
  const parts = stored.split('$');
  if (parts.length !== 4) {
    throw new Error('Formato de dado criptografado inválido');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_AES_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * Deterministic keyed HMAC-SHA256 blind index for exact-match lookups on encrypted fields.
 */
export function computeBlindIndex(normalizedLower: string): string {
  return crypto
    .createHmac('sha256', BLIND_INDEX_KEY)
    .update(normalizedLower.trim().toLowerCase(), 'utf8')
    .digest('hex');
}

export function hashOpaqueToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function safeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  const aBuf = Buffer.from(aHex, 'utf8');
  const bBuf = Buffer.from(bHex, 'utf8');
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Constant-time HMAC-SHA256 verification of the server-side Admin Master Key.
 * Leaks zero information about key length or prefix via timing side-channels.
 */
export function verifyAdminMasterKey(candidate: string): boolean {
  if (!candidate || !config.security.adminMasterKey) return false;
  const candidateMac = crypto
    .createHmac('sha256', BLIND_INDEX_KEY)
    .update(candidate.trim(), 'utf8')
    .digest();
  const masterMac = crypto
    .createHmac('sha256', BLIND_INDEX_KEY)
    .update(config.security.adminMasterKey.trim(), 'utf8')
    .digest();
  return crypto.timingSafeEqual(candidateMac, masterMac);
}

export interface AccessTokenPayload {
  sub: string;
  username: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  fam?: string;
  type: 'refresh';
}

export function signAccessToken(userId: string, username: string): string {
  const payload: AccessTokenPayload = { sub: userId, username, type: 'access' };
  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiresInSec,
  });
}

export function signRefreshToken(userId: string, tokenId: string, familyId: string): string {
  const payload: RefreshTokenPayload = {
    sub: userId,
    jti: tokenId,
    fam: familyId,
    type: 'refresh',
  };
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresInSec,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret) as AccessTokenPayload;
    if (decoded.type !== 'access' || !decoded.sub) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwt.refreshSecret) as RefreshTokenPayload;
    if (decoded.type !== 'refresh' || !decoded.sub || !decoded.jti) return null;
    return decoded;
  } catch {
    return null;
  }
}

// HttpOnly Refresh Token Cookie Utilities
export const REFRESH_COOKIE_NAME = 'aether_rt';

export function serializeRefreshCookie(token: string, maxAgeSec: number, isSecure: boolean): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/api/auth',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

export function serializeClearRefreshCookie(isSecure: boolean): string {
  return serializeRefreshCookie('', 0, isSecure);
}

export function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const k = pair.slice(0, eqIdx).trim();
    if (k === name) {
      const rawVal = pair.slice(eqIdx + 1).trim();
      try {
        return decodeURIComponent(rawVal);
      } catch {
        return rawVal;
      }
    }
  }
  return null;
}

// Ephemeral Single-Use WebSocket Tickets (prevents JWT leakage in WS URLs / proxy logs)
interface WsTicketRecord {
  userId: string;
  expiresAt: number;
}
const wsTickets = new Map<string, WsTicketRecord>();

export function issueWsTicket(userId: string, ttlMs = 30_000): string {
  const now = Date.now();
  if (wsTickets.size > 500) {
    for (const [k, v] of wsTickets.entries()) {
      if (v.expiresAt <= now) wsTickets.delete(k);
    }
  }
  const rawTicket = crypto.randomBytes(32).toString('base64url');
  const ticketHash = hashOpaqueToken(rawTicket);
  wsTickets.set(ticketHash, { userId, expiresAt: now + ttlMs });
  return rawTicket;
}

export function consumeWsTicket(rawTicket: string): string | null {
  if (!rawTicket) return null;
  const ticketHash = hashOpaqueToken(rawTicket);
  const entry = wsTickets.get(ticketHash);
  if (!entry) return null;
  // Strictly single-use: delete immediately regardless of expiration
  wsTickets.delete(ticketHash);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

// Sliding-Window Rate Limiter & Brute-Force Account Lockout Guard
class AuthSecurityGuard {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private loginFailures = new Map<string, { fails: number; firstFailAt: number; lockedUntil: number }>();

  public checkRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number
  ): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    if (this.buckets.size > 5000) {
      for (const [k, v] of this.buckets.entries()) {
        if (v.resetAt <= now) this.buckets.delete(k);
      }
    }
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }
    if (existing.count >= maxRequests) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  private lockoutKey(ip: string, identifier: string): string {
    return `${ip}::${identifier.trim().toLowerCase()}`;
  }

  public checkLoginLockout(
    ip: string,
    identifier: string
  ): { locked: boolean; retryAfterSec: number } {
    const now = Date.now();
    const entry = this.loginFailures.get(this.lockoutKey(ip, identifier));
    if (!entry) return { locked: false, retryAfterSec: 0 };
    if (entry.lockedUntil > now) {
      return {
        locked: true,
        retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
      };
    }
    return { locked: false, retryAfterSec: 0 };
  }

  public recordLoginFailure(ip: string, identifier: string): void {
    const now = Date.now();
    const key = this.lockoutKey(ip, identifier);
    const windowMs = 10 * 60 * 1000; // 10 minutes observation window
    const lockDurationMs = 5 * 60 * 1000; // 5 minutes lockout after 6 failures

    const existing = this.loginFailures.get(key);
    if (!existing || now - existing.firstFailAt > windowMs) {
      this.loginFailures.set(key, { fails: 1, firstFailAt: now, lockedUntil: 0 });
      return;
    }
    existing.fails += 1;
    if (existing.fails >= 6) {
      existing.lockedUntil = now + lockDurationMs;
    }
  }

  public clearLoginFailures(ip: string, identifier: string): void {
    this.loginFailures.delete(this.lockoutKey(ip, identifier));
  }
}

export const authGuard = new AuthSecurityGuard();

export function extractMentionedUsernames(content: string): string[] {
  const matches = content.matchAll(/(?:^|\s)@([a-zA-Z0-9_.-]{3,28})\b/g);
  const unique = new Set<string>();
  for (const m of matches) {
    if (m[1]) unique.add(m[1].toLowerCase());
  }
  return Array.from(unique);
}

const AVATAR_PALETTE = [
  '#2563EB', // Cobalt Blue
  '#0EA5E9', // Sky Cyan
  '#10B981', // Emerald
  '#8B5CF6', // Violet
  '#F59E0B', // Amber
  '#EC4899', // Rose
  '#14B8A6', // Teal
  '#6366F1', // Indigo
];

export function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}
