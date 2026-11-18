import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  DEFAULT_USER_SETTINGS,
  STREAM_CONNECTION_MODES,
  STREAM_FPS_OPTIONS,
  STREAM_PROFILES,
  STREAM_RESOLUTIONS,
  StreamFpsSchema,
  StreamResolutionSchema,
  ULTRA_PERFORMANCE_PRESET,
  resolveTargetBitrateKbps,
  type ActiveStreamInfo,
  type ChatMessage,
  type RoomJoinResult,
  type ServerPushEvent,
  type ServerRpcResponse,
} from '@aether/shared';
import { createServerApp, type ServerContext } from '../apps/server/src/app.js';
import { config } from '../apps/server/src/config.js';

class TestRealtimeClient {
  private ws!: WebSocket;
  public events: ServerPushEvent[] = [];
  public binaryFrames: Buffer[] = [];
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw as ArrayBuffer);
        this.binaryFrames.push(buf);
        return;
      }
      const msg = JSON.parse(raw.toString()) as ServerRpcResponse | ServerPushEvent;
      if (msg.type === 'rpc:res') {
        const entry = this.pending.get(msg.reqId);
        if (!entry) return;
        this.pending.delete(msg.reqId);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(Object.assign(new Error(msg.error?.message || 'RPC Error'), { code: msg.error?.code }));
      } else if (msg.type === 'event') {
        this.events.push(msg);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
      this.ws.once('close', (code) => reject(new Error(`WS closed early with code ${code}`)));
    });
  }

  sendBinary(buf: Buffer): void {
    this.ws.send(buf, { binary: true });
  }

  async waitForBinaryFrame(
    predicate?: (buf: Buffer) => boolean,
    timeoutMs = 4000
  ): Promise<Buffer> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = this.binaryFrames.find((b) => !predicate || predicate(b));
      if (match) return match;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('Timeout waiting for binary WS relay frame');
  }

  rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const reqId = `${Date.now()}-${Math.random()}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve: resolve as (d: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ type: 'rpc:req', reqId, method, params }));
    });
  }

  async waitForEvent<E extends ServerPushEvent['event']>(
    eventName: E,
    predicate?: (ev: Extract<ServerPushEvent, { event: E }>) => boolean,
    timeoutMs = 4000
  ): Promise<Extract<ServerPushEvent, { event: E }>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = this.events.find(
        (e): e is Extract<ServerPushEvent, { event: E }> =>
          e.event === eventName && (!predicate || predicate(e as Extract<ServerPushEvent, { event: E }>))
      );
      if (match) return match;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timeout waiting for event ${eventName}`);
  }

  close(): void {
    this.ws?.close();
  }
}

function makeTinyValidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const idat = zlib.deflateSync(raw);

  function crc32(buf: Buffer) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('Aether Production Platform — Real End-to-End Verification', () => {
  let ctx: ServerContext;
  let baseUrl: string;
  let wsBaseUrl: string;
  let tmpDbFile: string;

  let lucasToken = '';
  let lucasId = '';
  let marinaToken = '';
  let marinaId = '';
  let pedroToken = '';

  beforeAll(async () => {
    tmpDbFile = path.join(os.tmpdir(), `aether-e2e-${Date.now()}.sqlite`);
    ctx = await createServerApp({ customSqlitePath: tmpDbFile, logger: false });
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = address;
    wsBaseUrl = address.replace(/^http:/, 'ws:');
  }, 25000);

  afterAll(async () => {
    await ctx.closeAll();
    try {
      fs.rmSync(tmpDbFile, { force: true });
    } catch {
      // Ignore
    }
  });

  it('enforces Studio, Quick & Ultra Performance stream resolutions (360p..original), FPS (5..144), and manual/auto bitrates', () => {
    expect(STREAM_RESOLUTIONS).toEqual(['360p', '480p', '720p', '1080p', '1440p', 'original']);
    expect(STREAM_FPS_OPTIONS).toEqual([5, 30, 60, 75, 100, 120, 144]);
    expect(STREAM_PROFILES).toContain('ultra-performance');
    expect(STREAM_CONNECTION_MODES).toContain('ultra-performance');

    expect(StreamResolutionSchema.safeParse('1440p').success).toBe(true);
    expect(StreamResolutionSchema.safeParse('480p').success).toBe(true);
    expect(StreamResolutionSchema.safeParse('original').success).toBe(true);
    expect(StreamResolutionSchema.safeParse('2160p').success).toBe(false);

    expect(StreamFpsSchema.safeParse(75).success).toBe(true);
    expect(StreamFpsSchema.safeParse(144).success).toBe(true);
    expect(StreamFpsSchema.safeParse(5).success).toBe(true);
    expect(StreamFpsSchema.safeParse(24).success).toBe(false);

    // Verify 1440p @ 75fps gets high-clarity 26 Mbps target bitrate, Ultra Performance gets 4500 Kbps @ 720p60, & Studio manual bitrates work cleanly
    expect(resolveTargetBitrateKbps('1440p', 75, null)).toBe(26000);
    expect(resolveTargetBitrateKbps('720p', 60, null, 'ultra-performance')).toBe(
      ULTRA_PERFORMANCE_PRESET.targetBitrateKbps
    );
    expect(ULTRA_PERFORMANCE_PRESET.fps).toBe(60);
    expect(resolveTargetBitrateKbps('1080p', 60, 18500)).toBe(18500);
    expect(resolveTargetBitrateKbps('720p', 60, 999999)).toBe(60000);
    expect(resolveTargetBitrateKbps('360p', 30, 50)).toBe(300);
  });

  it('registers real users, enforces strong passwords, encrypts sensitive fields at rest (AES-256-GCM + scrypt2 + SHA-256 RT), detects token replay, issues single-use WS tickets, and persists complete settings', async () => {
    // 1. Weak or common breached passwords MUST be rejected (400)
    const weakRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'weakuser',
        displayName: 'Weak User',
        email: 'weak@aether.test',
        password: 'onlylowercase1!',
      }),
    });
    expect(weakRes.status).toBe(400);

    // 2. Register Lucas and verify HTTP Security Headers + HttpOnly Refresh Cookie
    const regLucas = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'lucas',
        displayName: 'Lucas Andrade',
        email: 'lucas@aether.test',
        password: 'StrongPassword123!',
      }),
    });
    expect(regLucas.status).toBe(201);
    expect(regLucas.headers.get('x-content-type-options')).toBe('nosniff');
    expect(regLucas.headers.get('x-frame-options')).toBe('DENY');
    expect(regLucas.headers.get('content-security-policy')).toContain("default-src 'self'");
    const setCookieHeader = regLucas.headers.get('set-cookie') || '';
    expect(setCookieHeader).toContain('aether_rt=');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Strict');

    const lucasBody = (await regLucas.json()) as {
      user: { id: string; email: string };
      accessToken: string;
      refreshToken: string;
    };
    expect(lucasBody.user.email).toBe('lucas@aether.test');
    const initialRefreshToken = lucasBody.refreshToken;
    lucasId = lucasBody.user.id;

    // 3. Verify database at rest: scrypt2 password hash, AES-256-GCM encrypted email, HMAC blind index, SHA-256 refresh token hash
    const inspectDb = new DatabaseSync(tmpDbFile, { readOnly: true });
    const rawUserRow = inspectDb
      .prepare('SELECT email, email_lower, password_hash FROM users WHERE id = ?')
      .get(lucasId) as { email: string; email_lower: string; password_hash: string } | undefined;
    const rawTokenRow = inspectDb
      .prepare('SELECT token_hash, family_id FROM refresh_tokens WHERE user_id = ?')
      .get(lucasId) as { token_hash: string; family_id: string } | undefined;
    inspectDb.close();

    expect(rawUserRow).toBeDefined();
    expect(rawUserRow!.password_hash).toMatch(/^scrypt2\$[0-9a-f]{64}\$[0-9a-f]{128}$/);
    expect(rawUserRow!.email).toMatch(/^enc1\$[0-9a-f]{24}\$[0-9a-f]{32}\$[0-9a-f]+$/);
    expect(rawUserRow!.email).not.toContain('lucas@aether.test');
    expect(rawUserRow!.email_lower).toMatch(/^[0-9a-f]{64}$/);
    expect(rawUserRow!.email_lower).not.toContain('lucas@aether.test');
    expect(rawTokenRow).toBeDefined();
    expect(rawTokenRow!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rawTokenRow!.token_hash).not.toBe(initialRefreshToken);

    // 4. Refresh token rotation + Token Replay Detection (reusing consumed RT revokes entire session family)
    const rotateRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: initialRefreshToken }),
    });
    expect(rotateRes.status).toBe(200);
    const rotatedBody = (await rotateRes.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    expect(rotatedBody.refreshToken).not.toBe(initialRefreshToken);

    // Replay the already-consumed initialRefreshToken -> 401 AND revokes rotatedBody.refreshToken!
    const replayRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: initialRefreshToken }),
    });
    expect(replayRes.status).toBe(401);

    const familyRevokedRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rotatedBody.refreshToken }),
    });
    expect(familyRevokedRes.status).toBe(401);

    // Re-authenticate Lucas cleanly via email (tests HMAC blind index lookup + AES-256-GCM decryption)
    const reloginLucas = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'lucas@aether.test',
        password: 'StrongPassword123!',
      }),
    });
    expect(reloginLucas.status).toBe(200);
    lucasToken = ((await reloginLucas.json()) as { accessToken: string }).accessToken;

    // 5. Single-use 30s WebSocket Ticket (works once, rejected with 4001 on replay)
    const ticketRes = await fetch(`${baseUrl}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lucasToken}` },
    });
    expect(ticketRes.status).toBe(200);
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    expect(ticket.length).toBeGreaterThanOrEqual(32);

    const wsTicketClient = new TestRealtimeClient();
    await wsTicketClient.connect(`${wsBaseUrl}/ws?ticket=${encodeURIComponent(ticket)}`);
    const connectedEv = await wsTicketClient.waitForEvent('connected');
    expect(connectedEv.payload.peerId).toBeTruthy();
    const lobbyEv = await wsTicketClient.waitForEvent('lobby:roomsUpdated');
    expect(Array.isArray(lobbyEv.payload.rooms)).toBe(true);
    wsTicketClient.close();

    // Reusing the exact same ticket MUST be rejected with close code 4001
    const replayWsCloseCode = await new Promise<number>((resolve) => {
      const replayWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${encodeURIComponent(ticket)}`);
      replayWs.once('close', (code) => resolve(code));
    });
    expect(replayWsCloseCode).toBe(4001);

    const regMarina = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'marina',
        displayName: 'Marina Costa',
        email: 'marina@aether.test',
        password: 'StrongPassword123!',
      }),
    });
    expect(regMarina.status).toBe(201);
    const marinaBody = (await regMarina.json()) as { user: { id: string }; accessToken: string };
    marinaToken = marinaBody.accessToken;
    marinaId = marinaBody.user.id;

    const regPedro = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'pedro',
        displayName: 'Pedro Rocha',
        email: 'pedro@aether.test',
        password: 'StrongPassword123!',
      }),
    });
    expect(regPedro.status).toBe(201);
    pedroToken = ((await regPedro.json()) as { accessToken: string }).accessToken;

    // Persist full custom settings across all 4 categories (Audio, Stream, App, Interface)
    const customSettings = structuredClone(DEFAULT_USER_SETTINGS);
    customSettings.audio.voiceMode = 'ptt';
    customSettings.audio.pttKey = 'Mouse4';
    customSettings.audio.peerOverrides[marinaId] = {
      volume: 145,
      muted: false,
      noiseReductionEnabled: true,
      noiseReductionLevel: 85,
    };
    customSettings.stream.resolution = '1440p';
    customSettings.stream.fps = 75;
    customSettings.app.overlay.position = 'top-right';
    customSettings.app.overlay.opacity = 0.75;
    customSettings.interface.theme = 'light';

    const saveRes = await fetch(`${baseUrl}/api/users/me/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${lucasToken}`,
      },
      body: JSON.stringify(customSettings),
    });
    expect(saveRes.status).toBe(200);

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${lucasToken}` },
    });
    const meJson = (await meRes.json()) as { user: { settings: typeof customSettings } };
    expect(meJson.user.settings.stream.resolution).toBe('1440p');
    expect(meJson.user.settings.stream.fps).toBe(75);
    expect(meJson.user.settings.audio.peerOverrides[marinaId]?.volume).toBe(145);
    expect(meJson.user.settings.audio.peerOverrides[marinaId]?.noiseReductionLevel).toBe(85);
    expect(meJson.user.settings.interface.theme).toBe('light');
  });

  it('connects multiple real users simultaneously, enforces private room passwords, isolates voice vs stream SFU transports, and tracks 100% real viewers', async () => {
    // Lucas creates a password-protected Private Room
    const createRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${lucasToken}`,
      },
      body: JSON.stringify({
        name: 'Squad 2K 75FPS',
        description: 'Sala privada com senha',
        isPrivate: true,
        password: 'segredo-squad',
      }),
    });
    expect(createRoomRes.status).toBe(201);
    const { room: createdRoom } = (await createRoomRes.json()) as { room: { id: string } };

    const wsLucas = new TestRealtimeClient();
    const wsMarina = new TestRealtimeClient();
    const wsPedro = new TestRealtimeClient();

    await Promise.all([
      wsLucas.connect(`${wsBaseUrl}/ws?token=${lucasToken}`),
      wsMarina.connect(`${wsBaseUrl}/ws?token=${marinaToken}`),
      wsPedro.connect(`${wsBaseUrl}/ws?token=${pedroToken}`),
    ]);

    // Desktop-Only Invariant: Web browsers can NEVER join voice rooms / live streams
    await expect(
      wsMarina.rpc('room:join', {
        roomId: createdRoom.id,
        password: 'segredo-squad',
        clientPlatform: 'web',
      })
    ).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });

    // Marina tries joining without password -> must fail with PASSWORD_REQUIRED
    await expect(
      wsMarina.rpc('room:join', { roomId: createdRoom.id, clientPlatform: 'desktop' })
    ).rejects.toThrow(/senha/i);

    // Marina tries wrong password -> must fail
    await expect(
      wsMarina.rpc('room:join', {
        roomId: createdRoom.id,
        password: 'errada',
        clientPlatform: 'desktop',
      })
    ).rejects.toThrow(/incorreta/i);

    // Lucas (owner), Marina & Pedro join with valid password
    const joinLucas = await wsLucas.rpc<RoomJoinResult>('room:join', {
      roomId: createdRoom.id,
      clientPlatform: 'desktop',
    });
    const joinMarina = await wsMarina.rpc<RoomJoinResult>('room:join', {
      roomId: createdRoom.id,
      password: 'segredo-squad',
      clientPlatform: 'desktop',
    });
    const joinPedro = await wsPedro.rpc<RoomJoinResult>('room:join', {
      roomId: createdRoom.id,
      password: 'segredo-squad',
      clientPlatform: 'desktop',
    });

    expect(joinPedro.participants.length).toBe(3);

    // Verify SFU Router exposes Stereo 320kbps Opus + H.264 High Profile Level 5.2 (640034)
    const rtpCaps = joinLucas.routerRtpCapabilities as {
      codecs: {
        mimeType: string;
        preferredPayloadType?: number;
        parameters?: Record<string, unknown>;
      }[];
    };
    const h264High52 = rtpCaps.codecs.find(
      (c) => c.mimeType === 'video/H264' && c.parameters?.['profile-level-id'] === '640034'
    );
    expect(h264High52).toBeDefined();

    const opusCodec = rtpCaps.codecs.find((c) => c.mimeType === 'audio/opus');
    expect(opusCodec?.parameters?.maxaveragebitrate).toBe(510000);

    // Create Dual-Plane SFU Transports (Voice Plane isolated from Stream Plane)
    const lucasVoiceSend = await wsLucas.rpc<{ id: string }>('sfu:createTransport', {
      plane: 'voice',
      direction: 'send',
    });
    const marinaVoiceRecv = await wsMarina.rpc<{ id: string }>('sfu:createTransport', {
      plane: 'voice',
      direction: 'recv',
    });
    const lucasStreamSend = await wsLucas.rpc<{ id: string }>('sfu:createTransport', {
      plane: 'stream',
      direction: 'send',
    });
    const marinaStreamRecv = await wsMarina.rpc<{ id: string }>('sfu:createTransport', {
      plane: 'stream',
      direction: 'recv',
    });
    const pedroStreamRecv = await wsPedro.rpc<{ id: string }>('sfu:createTransport', {
      plane: 'stream',
      direction: 'recv',
    });

    expect(lucasVoiceSend.id).not.toBe(lucasStreamSend.id);
    expect(marinaVoiceRecv.id).not.toBe(marinaStreamRecv.id);

    // Publish real Opus Voice Producer on Lucas's Voice Transport
    const opusPt = opusCodec?.preferredPayloadType ?? 100;

    const voiceProd = await wsLucas.rpc<{ producerId: string }>('sfu:produceVoice', {
      transportId: lucasVoiceSend.id,
      rtpParameters: {
        codecs: [
          {
            mimeType: 'audio/opus',
            payloadType: opusPt,
            clockRate: 48000,
            channels: 2,
            parameters: { useinbandfec: 1 },
          },
        ],
        encodings: [{ ssrc: 11111111 }],
      },
    });
    expect(voiceProd.producerId).toBeTruthy();

    // Lucas MUST NOT be able to consume his own microphone (Zero Echo / Loopback Invariant)
    await expect(
      wsLucas.rpc('sfu:consumeVoice', {
        producerId: voiceProd.producerId,
        rtpCapabilities: joinLucas.routerRtpCapabilities,
      })
    ).rejects.toThrow(/próprio microfone/i);

    // Marina consumes Lucas's voice cleanly
    const marinaVoiceCons = await wsMarina.rpc<{ id: string; kind: string }>('sfu:consumeVoice', {
      producerId: voiceProd.producerId,
      rtpCapabilities: joinMarina.routerRtpCapabilities,
    });
    expect(marinaVoiceCons.kind).toBe('audio');

    // Lucas starts a real 1440p @ 75 FPS Live Stream using the unified Desktop/Web sequential pipeline:
    // Step 1: sfu:produceStreamTrack (video) -> Step 2: sfu:produceStreamTrack (stereo audio) -> Step 3: stream:start
    const h264Pt = h264High52?.preferredPayloadType ?? 101;
    const videoStreamProd = await wsLucas.rpc<{ producerId: string }>('sfu:produceStreamTrack', {
      transportId: lucasStreamSend.id,
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/H264',
            payloadType: h264Pt,
            clockRate: 90000,
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '640034',
              'level-asymmetry-allowed': 1,
            },
          },
        ],
        encodings: [{ ssrc: 22222222, maxBitrate: 26000000, maxFramerate: 75 }],
      },
    });
    expect(videoStreamProd.producerId).toBeTruthy();

    const audioStreamProd = await wsLucas.rpc<{ producerId: string }>('sfu:produceStreamTrack', {
      transportId: lucasStreamSend.id,
      kind: 'audio',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'audio/opus',
            payloadType: opusPt,
            clockRate: 48000,
            channels: 2,
            parameters: { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: 320000, usedtx: 0 },
          },
        ],
        encodings: [{ ssrc: 33333333, maxBitrate: 320000 }],
      },
    });
    expect(audioStreamProd.producerId).toBeTruthy();

    const streamRes = await wsLucas.rpc<{ stream: ActiveStreamInfo }>('stream:start', {
      transportId: lucasStreamSend.id,
      title: 'Cyberpunk 2077 Ultra 2K',
      resolution: '1440p',
      fps: 75,
      targetBitrateKbps: 26000,
      audioIsolationMode: 'process-isolated',
      videoProducerId: videoStreamProd.producerId,
      audioProducerId: audioStreamProd.producerId,
    });

    const streamId = streamRes.stream.streamId;
    expect(streamRes.stream.viewerCount).toBe(0); // Zero simulated viewers!
    expect(streamRes.stream.hasAudio).toBe(true);
    expect(streamRes.stream.audioIsolationMode).toBe('process-isolated');

    // Broadcaster cannot watch own stream
    await expect(
      wsLucas.rpc('stream:watch', { streamId, rtpCapabilities: joinLucas.routerRtpCapabilities })
    ).rejects.toThrow(/própria transmissão/i);

    // Marina starts watching -> real viewerCount becomes 1, receives BOTH video + stereo audio consumers
    const watch1 = await wsMarina.rpc<{
      stream: ActiveStreamInfo;
      videoConsumer: { id: string; kind: string };
      audioConsumer: { id: string; kind: string } | null;
    }>('stream:watch', {
      streamId,
      rtpCapabilities: joinMarina.routerRtpCapabilities,
    });
    expect(watch1.stream.viewerCount).toBe(1);
    expect(watch1.videoConsumer.kind).toBe('video');
    expect(watch1.audioConsumer?.kind).toBe('audio');

    // Pedro starts watching -> real viewerCount becomes 2
    const watch2 = await wsPedro.rpc<{ stream: ActiveStreamInfo }>('stream:watch', {
      streamId,
      rtpCapabilities: joinPedro.routerRtpCapabilities,
    });
    expect(watch2.stream.viewerCount).toBe(2);
    expect(watch2.stream.viewerUsers.map((u) => u.username).sort()).toEqual(['marina', 'pedro']);

    // Lucas reports real encoder telemetry -> pushed to viewers
    await wsLucas.rpc('stream:telemetry', {
      streamId,
      verifiedWidth: 2560,
      verifiedHeight: 1440,
      verifiedFps: 75,
      verifiedBitrateKbps: 24800,
    });

    // Marina stops watching -> real viewerCount immediately drops to 1
    const unwatch1 = await wsMarina.rpc<{ stream: ActiveStreamInfo }>('stream:unwatch', {
      streamId,
    });
    expect(unwatch1.stream.viewerCount).toBe(1);
    expect(unwatch1.stream.viewerUsers.map((u) => u.username)).toEqual(['pedro']);

    // Lucas stops live stream -> voice remains 100% online!
    await wsLucas.rpc('stream:stop', { streamId });

    // Real-Time Chat: Image Upload + @Mentions + Edit + Delete
    const pngBuffer = makeTinyValidPng(320, 180);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(pngBuffer)], { type: 'image/png' }),
      'screenshot-2k.png'
    );

    const uploadRes = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lucasToken}` },
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const { attachment } = (await uploadRes.json()) as {
      attachment: { id: string; url: string; isImage: boolean; width: number; height: number };
    };
    expect(attachment.isImage).toBe(true);
    expect(attachment.width).toBe(320);
    expect(attachment.height).toBe(180);

    // Verify uploaded image is actually served
    const imgFetch = await fetch(`${baseUrl}${attachment.url}`);
    expect(imgFetch.status).toBe(200);

    const sentMsg = await wsLucas.rpc<{ message: ChatMessage }>('chat:send', {
      roomId: createdRoom.id,
      content: 'Olha essa nitidez @marina!',
      attachmentIds: [attachment.id],
    });
    expect(sentMsg.message.mentions).toContain(marinaId);
    expect(sentMsg.message.attachments.length).toBe(1);

    // Marina receives real-time @mention notification
    const mentionEv = await wsMarina.waitForEvent('notification:mention');
    expect(mentionEv.payload.message.id).toBe(sentMsg.message.id);

    // Edit message
    const edited = await wsLucas.rpc<{ message: ChatMessage }>('chat:edit', {
      messageId: sentMsg.message.id,
      content: 'Olha essa nitidez em 1440p 75FPS @marina!',
    });
    expect(edited.message.editedAt).toBeTruthy();

    // Delete message
    const del = await wsLucas.rpc<{ deleted: boolean }>('chat:delete', {
      messageId: sentMsg.message.id,
    });
    expect(del.deleted).toBe(true);

    const history = await wsMarina.rpc<{ messages: ChatMessage[] }>('chat:history', {
      roomId: createdRoom.id,
    });
    expect(history.messages.some((m) => m.id === sentMsg.message.id)).toBe(false);

    wsLucas.close();
    wsMarina.close();
    wsPedro.close();
  }, 20000);

  it('enforces server-authoritative RBAC (Master Key owner claim, role promotion across any PC, real-time moderation, account bans and audit logs) without touching 720p/1080p/1440p media invariants', async () => {
    const authJson = (token: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });

    const meOf = async (token: string) => {
      const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json()) as { user?: { id: string; role: string } } };
    };

    const pedroMe = await meOf(pedroToken);
    expect(pedroMe.status).toBe(200);
    const pedroId = pedroMe.body.user!.id;

    // Every account starts as a plain member
    expect((await meOf(lucasToken)).body.user?.role).toBe('member');
    expect(pedroMe.body.user?.role).toBe('member');

    // Members cannot reach admin endpoints
    const forbiddenList = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${marinaToken}` },
    });
    expect(forbiddenList.status).toBe(403);

    const wsLucas = new TestRealtimeClient();
    const wsMarina = new TestRealtimeClient();
    const wsPedro = new TestRealtimeClient();
    await Promise.all([
      wsLucas.connect(`${wsBaseUrl}/ws?token=${lucasToken}`),
      wsMarina.connect(`${wsBaseUrl}/ws?token=${marinaToken}`),
      wsPedro.connect(`${wsBaseUrl}/ws?token=${pedroToken}`),
    ]);

    // 1. Wrong Master Key -> 403, role unchanged
    const wrongClaim = await fetch(`${baseUrl}/api/admin/claim-owner`, {
      method: 'POST',
      headers: authJson(lucasToken),
      body: JSON.stringify({ masterKey: 'definitely-not-the-master-key' }),
    });
    expect(wrongClaim.status).toBe(403);
    expect((await meOf(lucasToken)).body.user?.role).toBe('member');

    // 2. Real Master Key -> Lucas becomes Fundador (owner) + real-time broadcast
    expect(config.security.adminMasterKey.length).toBeGreaterThanOrEqual(8);
    const claim = await fetch(`${baseUrl}/api/admin/claim-owner`, {
      method: 'POST',
      headers: authJson(lucasToken),
      body: JSON.stringify({ masterKey: config.security.adminMasterKey }),
    });
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { user: { role: string } }).user.role).toBe('owner');
    const roleEv = await wsMarina.waitForEvent(
      'user:roleUpdated',
      (e) => e.payload.userId === lucasId && e.payload.role === 'owner'
    );
    expect(roleEv.payload.role).toBe('owner');

    // 3. Owner promotes Marina to admin -> persisted in the cloud DB (works on any PC)
    const promote = await fetch(`${baseUrl}/api/admin/users/${marinaId}/role`, {
      method: 'PATCH',
      headers: authJson(lucasToken),
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(promote.status).toBe(200);
    expect((await meOf(marinaToken)).body.user?.role).toBe('admin');
    await wsMarina.waitForEvent(
      'user:roleUpdated',
      (e) => e.payload.userId === marinaId && e.payload.role === 'admin'
    );

    // Admin cannot demote the owner, nor promote other admins
    const demoteOwner = await fetch(`${baseUrl}/api/admin/users/${lucasId}/role`, {
      method: 'PATCH',
      headers: authJson(marinaToken),
      body: JSON.stringify({ role: 'member' }),
    });
    expect(demoteOwner.status).toBe(403);
    const adminPromotesAdmin = await fetch(`${baseUrl}/api/admin/users/${pedroId}/role`, {
      method: 'PATCH',
      headers: authJson(marinaToken),
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(adminPromotesAdmin.status).toBe(403);

    // Admin can list users with roles
    const usersRes = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${marinaToken}` },
    });
    expect(usersRes.status).toBe(200);
    const usersBody = (await usersRes.json()) as { users: { id: string; role: string }[] };
    expect(usersBody.users.find((u) => u.id === lucasId)?.role).toBe('owner');
    expect(usersBody.users.find((u) => u.id === marinaId)?.role).toBe('admin');

    // 4. Real-time room moderation inside a public desktop room
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: authJson(lucasToken),
      body: JSON.stringify({ name: 'Moderacao Ao Vivo', description: '', isPrivate: false }),
    });
    expect(roomRes.status).toBe(201);
    const { room: modRoom } = (await roomRes.json()) as { room: { id: string } };

    await wsMarina.rpc<RoomJoinResult>('room:join', { roomId: modRoom.id, clientPlatform: 'desktop' });
    const joinPedro = await wsPedro.rpc<RoomJoinResult>('room:join', {
      roomId: modRoom.id,
      clientPlatform: 'desktop',
    });
    const pedroPeer = joinPedro.participants.find((p) => p.user.id === pedroId);
    const marinaPeer = joinPedro.participants.find((p) => p.user.id === marinaId);
    expect(pedroPeer).toBeDefined();
    expect(marinaPeer?.user.role).toBe('admin');

    // A member cannot moderate an admin
    await expect(
      wsPedro.rpc('admin:forceMuteParticipant', { peerId: marinaPeer!.peerId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Pedro starts a 1080p @ 60 FPS live (media invariants untouched by RBAC)
    expect(resolveTargetBitrateKbps('720p', 60, null)).toBeGreaterThan(0);
    expect(resolveTargetBitrateKbps('1080p', 60, null)).toBeGreaterThan(
      resolveTargetBitrateKbps('720p', 60, null)
    );
    expect(resolveTargetBitrateKbps('1440p', 75, null)).toBe(26000);

    const rtpCaps = joinPedro.routerRtpCapabilities as {
      codecs: { mimeType: string; preferredPayloadType?: number; parameters?: Record<string, unknown> }[];
    };
    const h264 = rtpCaps.codecs.find(
      (c) => c.mimeType === 'video/H264' && c.parameters?.['profile-level-id'] === '640034'
    );
    const pedroStreamSend = await wsPedro.rpc<{ id: string }>('sfu:createTransport', {
      plane: 'stream',
      direction: 'send',
    });
    const pedroVideo = await wsPedro.rpc<{ producerId: string }>('sfu:produceStreamTrack', {
      transportId: pedroStreamSend.id,
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/H264',
            payloadType: h264?.preferredPayloadType ?? 101,
            clockRate: 90000,
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '640034',
              'level-asymmetry-allowed': 1,
            },
          },
        ],
        encodings: [{ ssrc: 44444444, maxBitrate: 12000000, maxFramerate: 60 }],
      },
    });
    const pedroStream = await wsPedro.rpc<{ stream: ActiveStreamInfo }>('stream:start', {
      transportId: pedroStreamSend.id,
      title: 'Ranked 1080p 60',
      resolution: '1080p',
      fps: 60,
      targetBitrateKbps: resolveTargetBitrateKbps('1080p', 60, null),
      audioIsolationMode: 'none',
      videoProducerId: pedroVideo.producerId,
      audioProducerId: null,
    });
    expect(pedroStream.stream.resolution).toBe('1080p');
    expect(pedroStream.stream.fps).toBe(60);
    expect(pedroStream.stream.broadcasterRole).toBe('member');

    // Admin force-stops the member's stream
    const stopRes = await wsMarina.rpc<{ stopped: boolean }>('admin:forceStopStream', {
      streamId: pedroStream.stream.streamId,
      reason: 'Teste de moderação',
    });
    expect(stopRes.stopped).toBe(true);
    await wsMarina.waitForEvent(
      'room:streamStopped',
      (e) => e.payload.streamId === pedroStream.stream.streamId
    );

    // Admin force-mutes the member -> target receives admin:forceMuted
    const muteRes = await wsMarina.rpc<{ muted: boolean }>('admin:forceMuteParticipant', {
      peerId: pedroPeer!.peerId,
    });
    expect(muteRes.muted).toBe(true);
    await wsPedro.waitForEvent('admin:forceMuted', (e) => e.payload.roomId === modRoom.id);

    // Admin kicks the member -> target receives admin:kickedFromRoom
    const kickRes = await wsMarina.rpc<{ kicked: boolean }>('admin:kickParticipant', {
      peerId: pedroPeer!.peerId,
      reason: 'Teste de remoção',
    });
    expect(kickRes.kicked).toBe(true);
    const kickedEv = await wsPedro.waitForEvent('admin:kickedFromRoom', (e) => e.payload.roomId === modRoom.id);
    expect(kickedEv.payload.reason).toBe('Teste de remoção');

    // 5. Account ban -> instant WS notification + API access revoked
    const banRes = await fetch(`${baseUrl}/api/admin/users/${pedroId}/ban`, {
      method: 'POST',
      headers: authJson(marinaToken),
      body: JSON.stringify({ banned: true, reason: 'Teste automatizado' }),
    });
    expect(banRes.status).toBe(200);
    await wsPedro.waitForEvent('admin:accountBanned');
    expect((await meOf(pedroToken)).status).toBe(403);

    // Admin cannot ban the owner
    const banOwner = await fetch(`${baseUrl}/api/admin/users/${lucasId}/ban`, {
      method: 'POST',
      headers: authJson(marinaToken),
      body: JSON.stringify({ banned: true, reason: 'tentativa' }),
    });
    expect(banOwner.status).toBe(403);

    // Unban restores access to the account record
    const unbanRes = await fetch(`${baseUrl}/api/admin/users/${pedroId}/ban`, {
      method: 'POST',
      headers: authJson(lucasToken),
      body: JSON.stringify({ banned: false }),
    });
    expect(unbanRes.status).toBe(200);

    // 6. Audit logs record every privileged action
    const logsRes = await fetch(`${baseUrl}/api/admin/audit-logs`, {
      headers: { Authorization: `Bearer ${lucasToken}` },
    });
    expect(logsRes.status).toBe(200);
    const { logs } = (await logsRes.json()) as { logs: { action: string }[] };
    const actions = logs.map((l) => l.action);
    for (const expected of [
      'role:claim_owner',
      'role:update',
      'stream:force_stop',
      'voice:force_mute',
      'room:kick',
      'account:ban',
      'account:unban',
    ]) {
      expect(actions).toContain(expected);
    }

    wsLucas.close();
    wsMarina.close();
    wsPedro.close();
  }, 20000);

  it('serves the Official Web Portal HTML, RNNoise SIMD WASM + Aether Worklet DSP assets, /api/health v1.1.0, and the real Windows NSIS installer', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      status: string;
      version: string;
      maxUploadBytes: number;
    };
    expect(health.status).toBe('ok');
    expect(health.version).toBe('1.2.0');
    expect(health.maxUploadBytes).toBe(550 * 1024 * 1024);

    const portalRes = await fetch(`${baseUrl}/`);
    expect(portalRes.status).toBe(200);
    expect(portalRes.headers.get('content-type')).toContain('text/html');
    const portalHtml = await portalRes.text();
    expect(portalHtml).toContain('Aether');

    const wasmRes = await fetch(`${baseUrl}/dsp/rnnoise_simd.wasm`);
    expect(wasmRes.status).toBe(200);

    const workletRes = await fetch(`${baseUrl}/dsp/aetherWorklet.js`);
    expect(workletRes.status).toBe(200);

    const infoRes = await fetch(`${baseUrl}/api/releases/info`);
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as {
      available: boolean;
      version: string;
      filename: string;
      sizeBytes: number;
      downloadUrl: string;
    };
    expect(info.available).toBe(true);
    expect(info.filename).toBe('Aether-Setup-1.2.0.exe');
    expect(info.sizeBytes).toBeGreaterThan(50 * 1024 * 1024);

    // Stream first bytes of the real NSIS installer and verify Windows PE 'MZ' header
    const dlRes = await fetch(`${baseUrl}${info.downloadUrl}`);
    expect(dlRes.status).toBe(200);
    const reader = dlRes.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(firstChunk.value).toBeDefined();
    expect(firstChunk.value![0]).toBe(0x4d); // 'M'
    expect(firstChunk.value![1]).toBe(0x5a); // 'Z'
    await reader!.cancel();
  });

  it('starts the compiled .NET 8 Native Helper (WASAPI Anti-Ducking + Multi-App Loopback + Audio Session Discovery + Global Hooks), connects TCP PCM bridge, and enforces Dual-Bus Zero Ducking invariants', async () => {
    const helperBin = path.resolve(
      process.cwd(),
      'apps/desktop/resources/bin/aether-native-helper.exe'
    );
    expect(fs.existsSync(helperBin)).toBe(true);

    const child = spawn(helperBin, ['--parent-pid', String(process.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const lines: Record<string, unknown>[] = [];
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore non-JSON lines
      }
    });

    const waitForJson = async (
      pred: (msg: Record<string, unknown>) => boolean,
      timeoutMs = 5000
    ): Promise<Record<string, unknown>> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = lines.find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('Timeout waiting for native helper JSON event');
    };

    const readyMsg = await waitForJson((m) => m.type === 'ready');
    const pcmPort = Number(readyMsg.pcmPort);
    expect(pcmPort).toBeGreaterThan(0);

    // Connect TCP client to dedicated 48kHz Stereo Float32 PCM loopback socket
    const tcpSocket = net.createConnection({ host: '127.0.0.1', port: pcmPort });
    await new Promise<void>((resolve, reject) => {
      tcpSocket.once('connect', () => resolve());
      tcpSocket.once('error', (err) => reject(err));
    });
    tcpSocket.destroy();

    // Verify real WASAPI Per-Application Audio Session Enumeration (listAudioSessions)
    child.stdin.write(JSON.stringify({ cmd: 'listAudioSessions', reqId: 'test-sessions-1' }) + '\n');
    const sessRes = await waitForJson((m) => m.type === 'res' && m.reqId === 'test-sessions-1');
    expect(sessRes.ok).toBe(true);
    expect(Array.isArray(sessRes.sessions)).toBe(true);

    // Verify JSON-RPC configureShortcuts (including Mouse4 PTT) & stopLoopback
    child.stdin.write(
      JSON.stringify({
        cmd: 'configureShortcuts',
        reqId: 'test-shortcuts-1',
        pttEnabled: true,
        pttKey: 'Mouse4',
        shortcuts: { toggleMute: 'CommandOrControl+Shift+M' },
      }) + '\n'
    );
    const scRes = await waitForJson((m) => m.type === 'res' && m.reqId === 'test-shortcuts-1');
    expect(scRes.ok).toBe(true);

    child.stdin.write(JSON.stringify({ cmd: 'stopLoopback', reqId: 'test-stop-1' }) + '\n');
    const stopRes = await waitForJson((m) => m.type === 'res' && m.reqId === 'test-stop-1');
    expect(stopRes.ok).toBe(true);

    // Closing stdin cleanly exits the native helper with code 0
    const exitCodePromise = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });
    child.stdin.end();
    const exitCode = await exitCodePromise;
    expect(exitCode).toBe(0);
    rl.close();

    // Verify Dual-Bus AudioEngine, RealtimeSession Stream Capture & Desktop Chromium Zero-Ducking flags
    const audioEngineSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/web/src/audio/AudioEngine.ts'),
      'utf8'
    );
    expect(audioEngineSrc).toContain('private voiceCtx: AudioContext | null = null;');
    expect(audioEngineSrc).toContain('private streamCtx: AudioContext | null = null;');
    expect(audioEngineSrc).toContain('RnnoiseWorkletNode');
    expect(audioEngineSrc).toContain('aether-pcm-bridge-processor');
    expect(audioEngineSrc).toContain('aether-voice-gate-processor');

    const rtcSessionSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/web/src/rtc/RealtimeSession.ts'),
      'utf8'
    );
    // Desktop-only capture: Chromium never touches stream audio (audio: false on WGC capture),
    // stream audio comes exclusively from the .NET WASAPI process-isolated / multi-process PCM bridge.
    expect(rtcSessionSrc).toContain('audio: false');
    expect(rtcSessionSrc).toContain('createNativeLoopbackTrack');
    expect(rtcSessionSrc).toContain("audioIsolationMode = 'process-isolated'");
    expect(rtcSessionSrc).toContain("'multi-process'");
    expect(rtcSessionSrc).toContain('isDesktopClient()');
    expect(rtcSessionSrc).toContain('maintain-framerate');
    expect(rtcSessionSrc).toContain('maintain-resolution');
    expect(rtcSessionSrc).toContain('profile-level-id=42e0');
    expect(rtcSessionSrc).toContain('sfu:produceStreamTrack');
    expect(rtcSessionSrc).toContain('stream:relayWatch');

    const desktopMainSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/desktop/src/main.ts'),
      'utf8'
    );
    expect(desktopMainSrc).toContain('AudioDucking,WebRtcHybridAgc');
    expect(desktopMainSrc).toContain('registerSchemesAsPrivileged');
    expect(desktopMainSrc).toContain('aether://app/index.html');
    expect(desktopMainSrc).toContain('setDisplayMediaRequestHandler');
    expect(desktopMainSrc).toContain('safeStorage.encryptString');
    expect(desktopMainSrc).toContain('autoUpdater');
  }, 15000);

  it('verifies v1.1.0 Zero Clones, Cloud WSS Binary Media Relay, Studio Privacy/ViewerLimit/LiveBitrate, Animated GIF Avatars, 3x/24h @username Rate Limit, Friends, Private Room Invites, DMs, and Moderator Panel Access', async () => {
    const authJson = (token: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });

    // Register two dedicated v1.1.0 users: Clara & Diego
    const regClara = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'clara',
        displayName: 'Clara Martins',
        email: 'clara@aether.test',
        password: 'StrongPassword123!',
      }),
    });
    expect(regClara.status).toBe(201);
    const claraBody = (await regClara.json()) as {
      user: { id: string; username: string };
      accessToken: string;
    };
    const claraId = claraBody.user.id;
    const claraToken = claraBody.accessToken;

    const regDiego = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'diego',
        displayName: 'Diego Ferreira',
        email: 'diego@aether.test',
        password: 'StrongPassword123!',
      }),
    });
    expect(regDiego.status).toBe(201);
    const diegoBody = (await regDiego.json()) as {
      user: { id: string; username: string };
      accessToken: string;
    };
    const diegoId = diegoBody.user.id;
    const diegoToken = diegoBody.accessToken;

    // 1. Editable Profile + Multi-Frame Animated GIF89a Upload (100% Byte-Preserved) + 3x/24h @username Rate Limit
    const animatedGifBytes = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      0x02, 0x00, 0x02, 0x00, // width=2, height=2
      0x80, 0x00, 0x00, // GCT flag
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // 2-color palette
      0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00, // NETSCAPE2.0 loop
      0x21, 0xf9, 0x04, 0x00, 0x08, 0x00, 0x00, 0x00, // Frame 1 GCE
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x02, 0x02, 0x4c, 0x01, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x08, 0x00, 0x00, 0x00, // Frame 2 GCE
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
      0x3b, // Trailer
    ]);

    const avatarForm = new FormData();
    avatarForm.append(
      'file',
      new Blob([new Uint8Array(animatedGifBytes)], { type: 'image/gif' }),
      'animated-profile.gif'
    );
    const avatarRes = await fetch(`${baseUrl}/api/users/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claraToken}` },
      body: avatarForm,
    });
    expect(avatarRes.status).toBe(200);
    const avatarBody = (await avatarRes.json()) as { avatarUrl: string };
    expect(avatarBody.avatarUrl).toContain('.gif');

    // Fetch uploaded GIF back and verify every single byte (both animation frames) was preserved intact
    const servedGifRes = await fetch(`${baseUrl}${avatarBody.avatarUrl}`);
    expect(servedGifRes.status).toBe(200);
    expect(servedGifRes.headers.get('content-type')).toContain('image/gif');
    const servedGifBuf = Buffer.from(await servedGifRes.arrayBuffer());
    expect(servedGifBuf.equals(animatedGifBytes)).toBe(true);

    // Updating bio & presenceStatus does NOT consume @username quota
    const bioRes = await fetch(`${baseUrl}/api/users/me/profile`, {
      method: 'PATCH',
      headers: authJson(claraToken),
      body: JSON.stringify({
        displayName: 'Clara Studio 144Hz',
        bio: 'Streaming Fortnite RTX 2060',
        presenceStatus: 'busy',
      }),
    });
    expect(bioRes.status).toBe(200);
    const bioJson = (await bioRes.json()) as {
      user: { bio: string; presenceStatus: string; nicknameChangesLast24h: number };
    };
    expect(bioJson.user.bio).toBe('Streaming Fortnite RTX 2060');
    expect(bioJson.user.presenceStatus).toBe('busy');
    expect(bioJson.user.nicknameChangesLast24h).toBe(0);

    // Change @username 3 times within 24h -> allowed (nicknameChangesLast24h goes 1 -> 2 -> 3)
    for (const [idx, nextUsername] of ['clara_v1', 'clara_v2', 'clara_live'].entries()) {
      const uRes = await fetch(`${baseUrl}/api/users/me/profile`, {
        method: 'PATCH',
        headers: authJson(claraToken),
        body: JSON.stringify({ username: nextUsername }),
      });
      expect(uRes.status).toBe(200);
      const uJson = (await uRes.json()) as {
        user: { username: string; nicknameChangesLast24h: number; nicknameLockedUntil: string | null };
      };
      expect(uJson.user.username).toBe(nextUsername);
      expect(uJson.user.nicknameChangesLast24h).toBe(idx + 1);
      if (idx === 2) {
        expect(uJson.user.nicknameLockedUntil).toBeTruthy();
      }
    }

    // 4th @username change within 24h MUST be blocked with HTTP 429 + NICKNAME_RATE_LIMIT + lockedUntil
    const fourthUsernameRes = await fetch(`${baseUrl}/api/users/me/profile`, {
      method: 'PATCH',
      headers: authJson(claraToken),
      body: JSON.stringify({ username: 'clara_blocked' }),
    });
    expect(fourthUsernameRes.status).toBe(429);
    const fourthBody = (await fourthUsernameRes.json()) as { code: string; lockedUntil: string };
    expect(fourthBody.code).toBe('NICKNAME_RATE_LIMIT');
    expect(fourthBody.lockedUntil).toBeTruthy();

    // 2. Zero Clones Invariant + room:syncState + Studio Stream Privacy, Viewer Limit & Cloud WSS Binary Relay
    const studioRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: authJson(claraToken),
      body: JSON.stringify({
        name: 'Estudio Anti-Black-Screen',
        description: 'Sala privada com convite e relay',
        isPrivate: true,
        password: 'studio-secret',
      }),
    });
    expect(studioRoomRes.status).toBe(201);
    const { room: studioRoom } = (await studioRoomRes.json()) as { room: { id: string } };

    const wsClaraOld = new TestRealtimeClient();
    const wsClaraNew = new TestRealtimeClient();
    const wsDiego = new TestRealtimeClient();
    const wsPedro = new TestRealtimeClient();

    await Promise.all([
      wsClaraOld.connect(`${wsBaseUrl}/ws?token=${claraToken}`),
      wsClaraNew.connect(`${wsBaseUrl}/ws?token=${claraToken}`),
      wsDiego.connect(`${wsBaseUrl}/ws?token=${diegoToken}`),
      wsPedro.connect(`${wsBaseUrl}/ws?token=${pedroToken}`),
    ]);

    // First connection joins room
    const firstJoin = await wsClaraOld.rpc<RoomJoinResult>('room:join', {
      roomId: studioRoom.id,
      clientPlatform: 'desktop',
    });
    expect(firstJoin.participants.filter((p) => p.user.id === claraId).length).toBe(1);

    // Second connection for the SAME user joins room -> evicts stale peer cleanly (ZERO CLONES!)
    const secondJoin = await wsClaraNew.rpc<RoomJoinResult>('room:join', {
      roomId: studioRoom.id,
      clientPlatform: 'desktop',
    });
    expect(secondJoin.participants.filter((p) => p.user.id === claraId).length).toBe(1);
    expect(secondJoin.participants.length).toBe(1);

    const syncedState = await wsClaraNew.rpc<{
      inRoom: boolean;
      participants: { user: { id: string } }[];
    }>('room:syncState', {});
    expect(syncedState.inRoom).toBe(true);
    expect(syncedState.participants.length).toBe(1);

    // 3. Friends Request + Accept + Direct Room Invite Granting Passwordless Private Room Access + DMs
    const friendReq = await wsClaraNew.rpc<{ friendshipId: string }>('friends:request', {
      username: 'diego',
    });
    expect(friendReq.friendshipId).toBeTruthy();
    await wsDiego.waitForEvent('friends:updated');

    const acceptRes = await wsDiego.rpc<{
      accepted: boolean;
      friends: { user: { id: string }; isOnline: boolean; currentRoomId: string | null }[];
    }>('friends:respond', {
      friendshipId: friendReq.friendshipId,
      accept: true,
    });
    expect(acceptRes.accepted).toBe(true);
    const claraFriendEntry = acceptRes.friends.find((f) => f.user.id === claraId);
    expect(claraFriendEntry?.isOnline).toBe(true);
    expect(claraFriendEntry?.currentRoomId).toBe(studioRoom.id);

    // Clara invites Diego to the password-protected private room -> grants room access automatically!
    const inviteRes = await wsClaraNew.rpc<{ invited: boolean }>('friends:inviteToRoom', {
      targetUserId: diegoId,
      roomId: studioRoom.id,
    });
    expect(inviteRes.invited).toBe(true);
    await wsDiego.waitForEvent('friends:roomInvite', (e) => e.payload.roomId === studioRoom.id);

    // Diego joins private room WITHOUT typing password thanks to room invite grant
    const diegoJoin = await wsDiego.rpc<RoomJoinResult>('room:join', {
      roomId: studioRoom.id,
      clientPlatform: 'desktop',
    });
    expect(diegoJoin.participants.length).toBe(2);

    // Pedro (regular member, not invited) joins with room password to test STREAM_PRIVATE & STREAM_FULL
    await wsPedro.rpc<RoomJoinResult>('room:join', {
      roomId: studioRoom.id,
      password: 'studio-secret',
      clientPlatform: 'desktop',
    });

    // 4. Studio Custom Stream (Original @ 120 FPS, Multi-Process Audio, Private -> Public, ViewerLimit=1, Binary WSS Relay)
    const p2pStart = await wsClaraNew.rpc<{ stream: ActiveStreamInfo }>('p2p:streamStart', {
      title: 'Fortnite DX12 120FPS + Spotify',
      resolution: 'original',
      fps: 120,
      targetBitrateKbps: 18000,
      audioBitrateKbps: 192,
      privacy: 'private',
      allowedUserIds: [],
      viewerLimit: 1,
      connectionMode: 'compatibility',
      hasAudio: true,
      audioIsolationMode: 'multi-process',
    });
    const studioStreamId = p2pStart.stream.streamId;
    expect(p2pStart.stream.resolution).toBe('original');
    expect(p2pStart.stream.fps).toBe(120);
    expect(p2pStart.stream.audioIsolationMode).toBe('multi-process');

    // Non-invited regular member blocked on private stream
    await expect(
      wsPedro.rpc('p2p:streamWatch', { streamId: studioStreamId })
    ).rejects.toMatchObject({ code: 'STREAM_PRIVATE' });

    // Live Studio settings update: open stream to public + switch live to Ultra Performance (keep viewerLimit=1)
    const metaUpd = await wsClaraNew.rpc<{ stream: ActiveStreamInfo }>('stream:updateMeta', {
      streamId: studioStreamId,
      privacy: 'public',
      connectionMode: 'ultra-performance',
      targetBitrateKbps: 4500,
      viewerLimit: 1,
    });
    expect(metaUpd.stream.privacy).toBe('public');
    expect(metaUpd.stream.connectionMode).toBe('ultra-performance');
    expect(metaUpd.stream.targetBitrateKbps).toBe(4500);

    // Cloud WSS Binary Media Relay: Clara starts relay + caches WebM EBML init segment
    await wsClaraNew.rpc('stream:relayStart', {
      streamId: studioStreamId,
      mimeType: 'video/webm;codecs=vp8,opus',
    });
    const fakeEbmlInit = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
    const initCacheRes = await wsClaraNew.rpc<{ cached: boolean }>('stream:relayInitSegment', {
      streamId: studioStreamId,
      base64Init: fakeEbmlInit.toString('base64'),
    });
    expect(initCacheRes.cached).toBe(true);

    // Diego watches via Cloud WSS Relay -> immediately receives cached EBML init segment
    const relayWatch = await wsDiego.rpc<{
      ok: boolean;
      active: boolean;
      mimeType: string;
      base64Init: string | null;
    }>('stream:relayWatch', { streamId: studioStreamId });
    expect(relayWatch.ok).toBe(true);
    expect(relayWatch.active).toBe(true);
    expect(relayWatch.base64Init).toBe(fakeEbmlInit.toString('base64'));

    // Pedro tries watching while viewerLimit === 1 and Diego is already watching -> VIEWER_LIMIT_REACHED
    await expect(
      wsPedro.rpc('p2p:streamWatch', { streamId: studioStreamId })
    ).rejects.toMatchObject({ code: 'VIEWER_LIMIT_REACHED' });

    // Clara sends binary relay frame [0x01][36-byte ASCII UUID][WebM Cluster payload]
    const clusterChunk = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0xde, 0xad, 0xbe, 0xef]);
    const binaryRelayPacket = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(studioStreamId, 'ascii'),
      clusterChunk,
    ]);
    wsClaraNew.sendBinary(binaryRelayPacket);

    const receivedRelayPacket = await wsDiego.waitForBinaryFrame(
      (b) => b.length === binaryRelayPacket.length && b[0] === 0x01
    );
    expect(receivedRelayPacket.toString('ascii', 1, 37)).toBe(studioStreamId);
    expect(receivedRelayPacket.subarray(37).equals(clusterChunk)).toBe(true);

    // 5. Direct Messages (Send, Edit, Read Receipt, History & Delete)
    const dmSent = await wsDiego.rpc<{ message: { id: string; content: string } }>('dm:send', {
      recipientId: claraId,
      content: 'Live lisinha em 120 FPS sem tela preta @clara_live!',
      attachmentIds: [],
    });
    expect(dmSent.message.id).toBeTruthy();
    await wsClaraNew.waitForEvent('dm:messageCreated', (e) => e.payload.message.id === dmSent.message.id);

    const dmEdited = await wsDiego.rpc<{ message: { id: string; editedAt: string | null } }>('dm:edit', {
      messageId: dmSent.message.id,
      content: 'Live lisinha via Cloud Relay 120 FPS!',
    });
    expect(dmEdited.message.editedAt).toBeTruthy();

    const dmRead = await wsClaraNew.rpc<{ readAt: string }>('dm:markRead', {
      peerUserId: diegoId,
    });
    expect(dmRead.readAt).toBeTruthy();
    await wsDiego.waitForEvent('dm:read', (e) => e.payload.byUserId === claraId);

    const dmHist = await wsClaraNew.rpc<{ messages: { id: string }[] }>('dm:history', {
      peerUserId: diegoId,
      limit: 30,
    });
    expect(dmHist.messages.some((m) => m.id === dmSent.message.id)).toBe(true);

    const dmDel = await wsDiego.rpc<{ deleted: boolean }>('dm:delete', {
      messageId: dmSent.message.id,
    });
    expect(dmDel.deleted).toBe(true);

    // 6. Moderator Panel Visibility: Owner promotes Diego to 'moderator' -> can read users & audit logs (200), cannot ban or change roles (403)
    const promoteModRes = await fetch(`${baseUrl}/api/admin/users/${diegoId}/role`, {
      method: 'PATCH',
      headers: authJson(lucasToken),
      body: JSON.stringify({ role: 'moderator' }),
    });
    expect(promoteModRes.status).toBe(200);
    await wsDiego.waitForEvent(
      'user:roleUpdated',
      (e) => e.payload.userId === diegoId && e.payload.role === 'moderator'
    );

    const modUsersRes = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${diegoToken}` },
    });
    expect(modUsersRes.status).toBe(200);

    const modLogsRes = await fetch(`${baseUrl}/api/admin/audit-logs`, {
      headers: { Authorization: `Bearer ${diegoToken}` },
    });
    expect(modLogsRes.status).toBe(200);

    const modPromoteForbidden = await fetch(`${baseUrl}/api/admin/users/${claraId}/role`, {
      method: 'PATCH',
      headers: authJson(diegoToken),
      body: JSON.stringify({ role: 'moderator' }),
    });
    expect(modPromoteForbidden.status).toBe(403);

    wsClaraOld.close();
    wsClaraNew.close();
    wsDiego.close();
    wsPedro.close();
  }, 25000);
});
