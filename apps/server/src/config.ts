import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import type { IceServerConfig } from '@aether/shared';

dotenv.config();

function detectDefaultLanIp(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

function resolvePersistentSecret(
  name: string,
  envValue: string | undefined,
  dataDir: string,
  minEnvLength = 24
): string {
  if (envValue && envValue.trim().length >= minEnvLength) {
    return envValue.trim();
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, `.${name}.secret`);
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= minEnvLength) return existing;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

const rootDir = path.resolve(import.meta.dirname, '../../..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(rootDir, 'uploads'));
const desktopReleaseDir = path.resolve(
  process.env.DESKTOP_RELEASE_DIR || path.join(rootDir, 'release', 'desktop')
);
const webDistDir = path.resolve(process.env.WEB_DIST_DIR || path.join(rootDir, 'apps', 'web', 'dist'));

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3001),
  publicUrl: process.env.PUBLIC_URL || '',
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
    : true,

  dataDir,
  uploadsDir,
  desktopReleaseDir,
  webDistDir,

  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl:
    process.env.DATABASE_SSL === 'true' ||
    /sslmode=(require|verify-full|verify-ca)/i.test(process.env.DATABASE_URL || '') ||
    /(neon\.tech|supabase\.co|supabase\.com|render\.com|railway\.app)/i.test(
      process.env.DATABASE_URL || ''
    ),
  sqlitePath: path.join(dataDir, 'aether.sqlite'),

  redisUrl: process.env.REDIS_URL || '',
  nodeInstanceId: process.env.NODE_INSTANCE_ID || crypto.randomUUID(),

  s3: {
    enabled: Boolean(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY),
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'auto',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || '',
  },

  security: {
    passwordPepper: resolvePersistentSecret('password_pepper', process.env.PASSWORD_PEPPER, dataDir),
    dataEncryptionSecret: resolvePersistentSecret(
      'data_encryption_key',
      process.env.DATA_ENCRYPTION_KEY,
      dataDir
    ),
    adminMasterKey: resolvePersistentSecret(
      'admin_master_key',
      process.env.ADMIN_MASTER_KEY,
      dataDir,
      12
    ),
  },

  jwt: {
    accessSecret: resolvePersistentSecret('jwt_access', process.env.JWT_ACCESS_SECRET, dataDir),
    refreshSecret: resolvePersistentSecret('jwt_refresh', process.env.JWT_REFRESH_SECRET, dataDir),
    accessExpiresInSec: Number(process.env.JWT_ACCESS_EXPIRES_SEC || 15 * 60), // 15 min short-lived access token
    refreshExpiresInSec: Number(process.env.JWT_REFRESH_EXPIRES_SEC || 60 * 60 * 24 * 30), // 30d rotating refresh token
  },

  mediasoup: {
    mediaMode:
      process.env.MEDIA_MODE === 'p2p' ||
      (process.env.RENDER === 'true' && process.env.MEDIA_MODE !== 'sfu')
        ? ('p2p' as const)
        : ('sfu' as const),
    numWorkers: Math.max(1, Math.min(Number(process.env.MEDIASOUP_WORKERS || os.cpus().length), 8)),
    listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || detectDefaultLanIp(),
    enableTcp: process.env.MEDIASOUP_ENABLE_TCP !== 'false',
    enableUdp: true,
    preferUdp: true,
    rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT || 40000),
    rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT || 40400),
    initialAvailableOutgoingBitrate: 35_000_000, // 35 Mbps immediate start for ultra-crisp 1440p75
    maxIncomingBitrate: 32_000_000,
  },

  ice: {
    stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    turnUrls: (process.env.TURN_URLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    turnStaticSecret: process.env.TURN_STATIC_AUTH_SECRET || '',
    turnUsername: process.env.TURN_USERNAME || '',
    turnCredential: process.env.TURN_CREDENTIAL || '',
    turnTtlSec: Number(process.env.TURN_TTL_SEC || 86400),
  },

  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024), // 50 MB
};

/**
 * Generates production ICE server configuration including ephemeral HMAC TURN credentials (coturn REST API)
 * or static TURN credentials for corporate/symmetric NAT traversal.
 */
export function buildIceServersForUser(userId: string): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (config.ice.stunUrls.length > 0) {
    servers.push({ urls: config.ice.stunUrls });
  }
  if (config.ice.turnUrls.length > 0) {
    if (config.ice.turnStaticSecret) {
      const expiresAt = Math.floor(Date.now() / 1000) + config.ice.turnTtlSec;
      const username = `${expiresAt}:${userId}`;
      const credential = crypto
        .createHmac('sha1', config.ice.turnStaticSecret)
        .update(username)
        .digest('base64');
      servers.push({
        urls: config.ice.turnUrls,
        username,
        credential,
      });
    } else if (config.ice.turnUsername && config.ice.turnCredential) {
      servers.push({
        urls: config.ice.turnUrls,
        username: config.ice.turnUsername,
        credential: config.ice.turnCredential,
      });
    }
  }
  return servers;
}

