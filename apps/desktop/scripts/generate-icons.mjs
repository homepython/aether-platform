import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outDir = path.resolve(import.meta.dirname, '../resources/icons');
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const b = c1 / c2;
  return Math.hypot(px - (ax + b * vx), py - (ay + b * vy));
}

function renderAetherIconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 0.225;
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0; // filter none

    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;

      // Signed distance to rounded squircle rect
      const dx = Math.max(Math.abs(x + 0.5 - half) - (half - radius), 0);
      const dy = Math.max(Math.abs(y + 0.5 - half) - (half - radius), 0);
      const distRect = Math.hypot(dx, dy) - radius;

      const bgAlpha = Math.max(0, Math.min(1, 0.5 - distRect));
      if (bgAlpha <= 0) {
        const idx = rowOffset + 1 + x * 4;
        raw[idx] = 0;
        raw[idx + 1] = 0;
        raw[idx + 2] = 0;
        raw[idx + 3] = 0;
        continue;
      }

      // Smooth Cobalt (#1D4ED8) -> Sky Cyan (#0EA5E9) diagonal gradient + subtle top specular highlight
      const t = (px * 0.65 + py * 0.35);
      let r = Math.round(29 * (1 - t) + 14 * t);
      let g = Math.round(78 * (1 - t) + 165 * t);
      let b = Math.round(216 * (1 - t) + 233 * t);

      if (py < 0.45) {
        const spec = (0.45 - py) * 0.22;
        r = Math.min(255, Math.round(r + 255 * spec));
        g = Math.min(255, Math.round(g + 255 * spec));
        b = Math.min(255, Math.round(b + 255 * spec));
      }

      // Crisp geometric 'A' mark composed of two legs + crossbar
      const strokeHalf = 0.056;
      const dLeftLeg = pointToSegmentDist(px, py, 0.5, 0.23, 0.27, 0.76);
      const dRightLeg = pointToSegmentDist(px, py, 0.5, 0.23, 0.73, 0.76);
      const dCross = pointToSegmentDist(px, py, 0.36, 0.58, 0.64, 0.58);
      const minStrokeDist = Math.min(dLeftLeg, dRightLeg, dCross);

      const aaWidth = 1.15 / size;
      const glyphMask = Math.max(0, Math.min(1, (strokeHalf + aaWidth - minStrokeDist) / (2 * aaWidth)));

      r = Math.round(r * (1 - glyphMask) + 255 * glyphMask);
      g = Math.round(g * (1 - glyphMask) + 255 * glyphMask);
      b = Math.round(b * (1 - glyphMask) + 255 * glyphMask);

      const idx = rowOffset + 1 + x * 4;
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = Math.round(bgAlpha * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildMultiSizeIco(sizes) {
  const pngs = sizes.map((sz) => ({ size: sz, data: renderAetherIconPng(sz) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(pngs.length, 4);

  const dirEntries = [];
  let dataOffset = 6 + pngs.length * 16;

  for (const item of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = item.size >= 256 ? 0 : item.size;
    entry[1] = item.size >= 256 ? 0 : item.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // 32 bpp
    entry.writeUInt32LE(item.data.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dirEntries.push(entry);
    dataOffset += item.data.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngs.map((p) => p.data)]);
}

const icon256 = renderAetherIconPng(256);
const tray32 = renderAetherIconPng(32);
const icoBuf = buildMultiSizeIco([16, 32, 48, 64, 128, 256]);

fs.writeFileSync(path.join(outDir, 'icon.png'), icon256);
fs.writeFileSync(path.join(outDir, 'tray.png'), tray32);
fs.writeFileSync(path.join(outDir, 'icon.ico'), icoBuf);

console.log(`[Icons] Generated icon.ico (${icoBuf.length} bytes), icon.png & tray.png`);

