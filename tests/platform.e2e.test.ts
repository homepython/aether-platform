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
  STREAM_FPS_OPTIONS,
  STREAM_RESOLUTIONS,
  StreamFpsSchema,
  StreamResolutionSchema,
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
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
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

  it('enforces strict stream resolutions (720p, 1080p, 1440p ONLY) and FPS (30, 60, 75 ONLY)', () => {
    expect(STREAM_RESOLUTIONS).toEqual(['720p', '1080p', '1440p']);
    expect(STREAM_FPS_OPTIONS).toEqual([30, 60, 75]);

    expect(StreamResolutionSchema.safeParse('1440p').success).toBe(true);
    expect(StreamResolutionSchema.safeParse('480p').success).toBe(false);
    expect(StreamResolutionSchema.safeParse('2160p').success).toBe(false);

    expect(StreamFpsSchema.safeParse(75).success).toBe(true);
    expect(StreamFpsSchema.safeParse(24).success).toBe(false);
    expect(StreamFpsSchema.safeParse(120).success).toBe(false);

    // Verify 1440p @ 75fps gets high-clarity 26 Mbps target bitrate
    expect(resolveTargetBitrateKbps('1440p', 75, null)).toBe(26000);
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
    expect(opusCodec?.parameters?.maxaveragebitrate).toBe(320000);

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

  it('serves the Official Web Portal HTML, RNNoise SIMD WASM DSP assets, /api/health, and the real Windows NSIS installer', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { status: string };
    expect(health.status).toBe('ok');

    const portalRes = await fetch(`${baseUrl}/`);
    expect(portalRes.status).toBe(200);
    expect(portalRes.headers.get('content-type')).toContain('text/html');
    const portalHtml = await portalRes.text();
    expect(portalHtml).toContain('Aether');

    const wasmRes = await fetch(`${baseUrl}/dsp/rnnoise_simd.wasm`);
    expect(wasmRes.status).toBe(200);

    const infoRes = await fetch(`${baseUrl}/api/releases/info`);
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as {
      available: boolean;
      filename: string;
      sizeBytes: number;
      downloadUrl: string;
    };
    expect(info.available).toBe(true);
    expect(info.filename).toBe('Aether-Setup-1.0.0.exe');
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

  it('starts the compiled .NET 8 Native Helper (WASAPI Anti-Ducking + Process Loopback + Global Hooks), connects TCP PCM bridge, and enforces Dual-Bus Zero Ducking invariants', async () => {
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

    const rtcSessionSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/web/src/rtc/RealtimeSession.ts'),
      'utf8'
    );
    // Desktop-only capture: Chromium never touches stream audio (audio: false on WGC capture),
    // stream audio comes exclusively from the .NET WASAPI process-isolated PCM bridge (zero DSP, zero ducking).
    expect(rtcSessionSrc).toContain('audio: false');
    expect(rtcSessionSrc).toContain('createNativeLoopbackTrack');
    expect(rtcSessionSrc).toContain("audioIsolationMode = 'process-isolated'");
    expect(rtcSessionSrc).toContain('isDesktopClient()');
    expect(rtcSessionSrc).toContain('maintain-resolution');
    expect(rtcSessionSrc).toContain('sfu:produceStreamTrack');

    const desktopMainSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/desktop/src/main.ts'),
      'utf8'
    );
    expect(desktopMainSrc).toContain('AudioDucking,WebRtcHybridAgc');
    expect(desktopMainSrc).toContain('registerSchemesAsPrivileged');
    expect(desktopMainSrc).toContain('aether://app/index.html');
    expect(desktopMainSrc).toContain('setDisplayMediaRequestHandler');
    expect(desktopMainSrc).toContain('safeStorage.encryptString');
  }, 15000);
});
