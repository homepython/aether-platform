import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

export interface StoredFileResult {
  storageKey: string;
  urlPath: string;
  sizeBytes: number;
  isImage: boolean;
  width: number | null;
  height: number | null;
}

function sanitizeFilename(raw: string): string {
  const base = path.basename(raw || 'arquivo');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'arquivo';
}

/**
 * Extracts image dimensions directly from PNG, GIF, JPEG, or WebP headers without heavy native deps.
 */
export function probeImageDimensions(
  buffer: Buffer,
  mimeType: string
): { width: number; height: number } | null {
  try {
    // PNG
    if (
      buffer.length >= 24 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }

    // GIF
    if (
      buffer.length >= 10 &&
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46
    ) {
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
      };
    }

    // WEBP (VP8 / VP8L / VP8X)
    if (
      buffer.length >= 30 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const chunk = buffer.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        const w = 1 + buffer.readUIntLE(24, 3);
        const h = 1 + buffer.readUIntLE(27, 3);
        return { width: w, height: h };
      }
      if (chunk === 'VP8 ' && buffer.length >= 30) {
        const w = buffer.readUInt16LE(26) & 0x3fff;
        const h = buffer.readUInt16LE(28) & 0x3fff;
        return { width: w, height: h };
      }
      if (chunk === 'VP8L' && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21);
        const w = (bits & 0x3fff) + 1;
        const h = ((bits >> 14) & 0x3fff) + 1;
        return { width: w, height: h };
      }
    }

    // JPEG
    if (mimeType.startsWith('image/jpeg') || (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8)) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          offset += 2;
          continue;
        }
        const segLen = buffer.readUInt16BE(offset + 2);
        if (segLen < 2) break;
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        offset += 2 + segLen;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export class StorageService {
  private s3: S3Client | null = null;

  constructor() {
    if (config.s3.enabled) {
      this.s3 = new S3Client({
        region: config.s3.region,
        endpoint: config.s3.endpoint,
        credentials: {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        },
        forcePathStyle: Boolean(config.s3.endpoint),
      });
    }
  }

  async storeBuffer(params: {
    buffer: Buffer;
    originalFilename: string;
    mimeType: string;
  }): Promise<StoredFileResult> {
    const safeName = sanitizeFilename(params.originalFilename);
    const idPrefix = crypto.randomUUID();
    const storageKey = `${idPrefix}-${safeName}`;
    const isImage = /^image\/(png|jpeg|jpg|webp|gif|avif)$/i.test(params.mimeType);
    const dims = isImage ? probeImageDimensions(params.buffer, params.mimeType) : null;

    if (this.s3 && config.s3.bucket) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: storageKey,
          Body: params.buffer,
          ContentType: params.mimeType,
          CacheControl: 'public, max-age=31536000, immutable',
        })
      );
      const base = config.s3.publicBaseUrl.replace(/\/+$/, '');
      const urlPath = base ? `${base}/${encodeURIComponent(storageKey)}` : `/uploads/${encodeURIComponent(storageKey)}`;
      return {
        storageKey,
        urlPath,
        sizeBytes: params.buffer.length,
        isImage,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      };
    }

    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const targetPath = path.join(config.uploadsDir, storageKey);
    await fs.promises.writeFile(targetPath, params.buffer);

    return {
      storageKey,
      urlPath: `/uploads/${encodeURIComponent(storageKey)}`,
      sizeBytes: params.buffer.length,
      isImage,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    };
  }

  resolveLocalFilePath(storageKey: string): string | null {
    const safe = path.basename(storageKey);
    if (safe !== storageKey) return null;
    const fullPath = path.join(config.uploadsDir, safe);
    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
  }
}

