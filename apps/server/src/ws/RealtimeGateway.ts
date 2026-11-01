import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  AdminForceMuteParticipantParamsSchema,
  AdminForceStopStreamParamsSchema,
  AdminKickParticipantParamsSchema,
  ChatDeleteParamsSchema,
  ChatEditParamsSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  ClientRpcMethodSchema,
  hasRoleAtLeast,
  P2pSignalParamsSchema,
  P2pStreamStartParamsSchema,
  P2pVoiceReadyParamsSchema,
  ROLE_RANK,
  RoomJoinParamsSchema,
  SfuConnectTransportParamsSchema,
  SfuConsumeVoiceParamsSchema,
  SfuCreateTransportParamsSchema,
  SfuProduceStreamTrackParamsSchema,
  SfuProduceVoiceParamsSchema,
  SfuResumeConsumerParamsSchema,
  StreamStartParamsSchema,
  StreamStopOrUnwatchParamsSchema,
  StreamTelemetryParamsSchema,
  StreamUpdateMetaParamsSchema,
  StreamWatchParamsSchema,
  VoiceStateParamsSchema,
  type ActiveStreamInfo,
  type ClientRpcRequest,
  type RoomJoinResult,
  type RoomParticipant,
  type RoomSummary,
  type ServerPushEvent,
  type ServerRpcResponse,
  type StreamFps,
  type StreamResolution,
  type UserPublic,
} from '@aether/shared';
import type { ClusterBus } from '../cluster/ClusterBus.js';
import { buildIceServersForUser, config } from '../config.js';
import type { AppDatabase, DbRoomRow } from '../db/Database.js';
import {
  consumeWsTicket,
  extractMentionedUsernames,
  verifyAccessToken,
  verifyPassword,
} from '../security.js';
import type { SfuManager } from '../sfu/SfuManager.js';

interface ConnectedPeer {
  peerId: string;
  socket: WebSocket;
  user: UserPublic;
  roomId: string | null;
  joinedAt: string | null;
  micMuted: boolean;
  deafened: boolean;
  speaking: boolean;
  p2pVoiceReady: boolean;
  clientPlatform: 'web' | 'desktop';
  isAlive: boolean;
}

interface P2pStreamRecord {
  streamId: string;
  roomId: string;
  broadcasterPeerId: string;
  broadcaster: UserPublic;
  title: string;
  resolution: StreamResolution;
  fps: StreamFps;
  targetBitrateKbps: number;
  hasAudio: boolean;
  audioIsolationMode: 'process-isolated' | 'tab-isolated' | 'system-direct' | 'none';
  startedAt: string;
  viewers: Map<string, UserPublic>; // viewerPeerId -> UserPublic
  verifiedWidth?: number;
  verifiedHeight?: number;
  verifiedFps?: number;
  verifiedBitrateKbps?: number;
}

export class RealtimeGateway {
  private peers = new Map<string, ConnectedPeer>();
  private p2pStreams = new Map<string, P2pStreamRecord>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly sfu: SfuManager,
    private readonly cluster: ClusterBus
  ) {
    this.sfu.onStreamUpdated = (stream: ActiveStreamInfo) => {
      this.broadcastToRoom(stream.roomId, {
        type: 'event',
        event: 'room:streamUpdated',
        payload: { stream },
      });
      void this.broadcastLobbyRoomsUpdate();
    };

    this.sfu.onStreamStopped = (roomId: string, streamId: string, broadcasterId: string) => {
      this.broadcastToRoom(roomId, {
        type: 'event',
        event: 'room:streamStopped',
        payload: { roomId, streamId, broadcasterId },
      });
      void this.broadcastLobbyRoomsUpdate();
    };

    this.cluster.onRemoteEvent((envelope) => {
      if (envelope.scope === 'all') {
        this.sendLocalAll(envelope.event, envelope.excludePeerId);
      } else if (envelope.scope === 'room' && envelope.targetId) {
        this.sendLocalRoom(envelope.targetId, envelope.event, envelope.excludePeerId);
      } else if (envelope.scope === 'user' && envelope.targetId) {
        this.sendLocalUser(envelope.targetId, envelope.event);
      }
    });

    this.heartbeatTimer = setInterval(() => {
      for (const [peerId, peer] of this.peers.entries()) {
        if (!peer.isAlive) {
          peer.socket.terminate();
          this.handleDisconnect(peerId);
          continue;
        }
        peer.isAlive = false;
        try {
          peer.socket.ping();
        } catch {
          this.handleDisconnect(peerId);
        }
      }
    }, 25000);
  }

  async handleConnection(
    socket: WebSocket,
    auth: { ticket?: string | null; token?: string | null }
  ): Promise<void> {
    let authenticatedUserId: string | null = null;

    if (auth.ticket) {
      authenticatedUserId = consumeWsTicket(auth.ticket);
      if (!authenticatedUserId) {
        socket.close(4001, 'Ticket de sessão inválido, expirado ou já utilizado');
        return;
      }
    } else if (auth.token) {
      const payload = verifyAccessToken(auth.token);
      if (!payload) {
        socket.close(4001, 'Token inválido ou expirado');
        return;
      }
      authenticatedUserId = payload.sub;
    } else {
      socket.close(4001, 'Credencial de autenticação ausente');
      return;
    }

    const userRow = await this.db.findUserRowById(authenticatedUserId);
    if (!userRow) {
      socket.close(4001, 'Usuário não encontrado');
      return;
    }
    if (Boolean(userRow.is_banned)) {
      socket.close(4003, 'Conta suspensa pela administração');
      return;
    }

    const user = this.db.mapUserPublic(userRow);
    const peerId = crypto.randomUUID();
    const peer: ConnectedPeer = {
      peerId,
      socket,
      user,
      roomId: null,
      joinedAt: null,
      micMuted: false,
      deafened: false,
      speaking: false,
      p2pVoiceReady: false,
      clientPlatform: 'web',
      isAlive: true,
    };

    this.peers.set(peerId, peer);

    socket.on('pong', () => {
      peer.isAlive = true;
    });

    socket.on('message', (rawData) => {
      peer.isAlive = true;
      void this.handleRawMessage(peer, rawData.toString());
    });

    socket.on('close', () => {
      this.handleDisconnect(peerId);
    });

    socket.on('error', () => {
      this.handleDisconnect(peerId);
    });

    this.sendToPeer(peer, {
      type: 'event',
      event: 'connected',
      payload: { peerId, serverTime: new Date().toISOString() },
    });

    const rooms = await this.buildRoomSummaries();
    this.sendToPeer(peer, {
      type: 'event',
      event: 'lobby:roomsUpdated',
      payload: { rooms },
    });
  }

  private handleDisconnect(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.leaveCurrentRoom(peer);
    this.peers.delete(peerId);
  }

  private serializeP2pStream(rec: P2pStreamRecord): ActiveStreamInfo {
    const uniqueUsers = new Map<string, UserPublic>();
    for (const u of rec.viewers.values()) {
      uniqueUsers.set(u.id, u);
    }
    const viewerUsers = Array.from(uniqueUsers.values()).map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      avatarColor: u.avatarColor,
      role: u.role ?? 'member',
    }));
    return {
      streamId: rec.streamId,
      roomId: rec.roomId,
      broadcasterId: rec.broadcaster.id,
      broadcasterUsername: rec.broadcaster.username,
      broadcasterDisplayName: rec.broadcaster.displayName,
      broadcasterAvatarColor: rec.broadcaster.avatarColor,
      broadcasterRole: rec.broadcaster.role ?? 'member',
      title: rec.title,
      resolution: rec.resolution,
      fps: rec.fps,
      targetBitrateKbps: rec.targetBitrateKbps,
      hasAudio: rec.hasAudio,
      audioIsolationMode: rec.audioIsolationMode,
      startedAt: rec.startedAt,
      viewerCount: viewerUsers.length,
      viewerUsers,
      videoProducerId: `p2p-video:${rec.streamId}`,
      audioProducerId: rec.hasAudio ? `p2p-audio:${rec.streamId}` : null,
      verifiedWidth: rec.verifiedWidth,
      verifiedHeight: rec.verifiedHeight,
      verifiedFps: rec.verifiedFps,
      verifiedBitrateKbps: rec.verifiedBitrateKbps,
    };
  }

  private getPeerVoiceId(peer: ConnectedPeer): string | null {
    return (
      this.sfu.getPeerVoiceProducerId(peer.peerId) ||
      (peer.p2pVoiceReady ? `p2p-voice:${peer.peerId}` : null)
    );
  }

  private isPeerStreaming(peerId: string): boolean {
    if (this.sfu.hasPeerActiveStream(peerId)) return true;
    for (const s of this.p2pStreams.values()) {
      if (s.broadcasterPeerId === peerId) return true;
    }
    return false;
  }

  private listCombinedRoomStreams(roomId: string): ActiveStreamInfo[] {
    const list = this.sfu.listRoomStreams(roomId);
    for (const s of this.p2pStreams.values()) {
      if (s.roomId === roomId) list.push(this.serializeP2pStream(s));
    }
    return list;
  }

  private leaveCurrentRoom(peer: ConnectedPeer): void {
    const previousRoomId = peer.roomId;
    if (!previousRoomId) return;

    const { closedVoiceProducerId, stoppedStream } = this.sfu.cleanupPeer(peer.peerId);
    const hadP2pVoice = peer.p2pVoiceReady;
    peer.p2pVoiceReady = false;
    peer.roomId = null;
    peer.joinedAt = null;
    peer.speaking = false;

    const effectiveClosedVoice =
      closedVoiceProducerId || (hadP2pVoice ? `p2p-voice:${peer.peerId}` : null);

    if (effectiveClosedVoice) {
      this.broadcastToRoom(
        previousRoomId,
        {
          type: 'event',
          event: 'room:voiceProducerClosed',
          payload: {
            roomId: previousRoomId,
            peerId: peer.peerId,
            producerId: effectiveClosedVoice,
          },
        },
        peer.peerId
      );
    }

    if (stoppedStream) {
      this.broadcastToRoom(
        previousRoomId,
        {
          type: 'event',
          event: 'room:streamStopped',
          payload: {
            roomId: stoppedStream.roomId,
            streamId: stoppedStream.streamId,
            broadcasterId: stoppedStream.broadcasterId,
          },
        },
        peer.peerId
      );
    }

    // Cleanup any P2P broadcast or P2P viewer membership for this peer
    for (const [sid, rec] of Array.from(this.p2pStreams.entries())) {
      if (rec.broadcasterPeerId === peer.peerId) {
        this.p2pStreams.delete(sid);
        this.broadcastToRoom(
          previousRoomId,
          {
            type: 'event',
            event: 'room:streamStopped',
            payload: {
              roomId: rec.roomId,
              streamId: sid,
              broadcasterId: rec.broadcaster.id,
            },
          },
          peer.peerId
        );
      } else if (rec.viewers.delete(peer.peerId)) {
        const broadcasterPeer = this.peers.get(rec.broadcasterPeerId);
        if (broadcasterPeer) {
          this.sendToPeer(broadcasterPeer, {
            type: 'event',
            event: 'p2p:viewerLeft',
            payload: { streamId: sid, viewerPeerId: peer.peerId },
          });
        }
        this.broadcastToRoom(rec.roomId, {
          type: 'event',
          event: 'room:streamUpdated',
          payload: { stream: this.serializeP2pStream(rec) },
        });
      }
    }

    this.broadcastToRoom(
      previousRoomId,
      {
        type: 'event',
        event: 'room:participantLeft',
        payload: {
          roomId: previousRoomId,
          peerId: peer.peerId,
          userId: peer.user.id,
        },
      },
      peer.peerId
    );

    void this.broadcastLobbyRoomsUpdate();
  }

  private serializeParticipant(peer: ConnectedPeer): RoomParticipant {
    return {
      peerId: peer.peerId,
      user: peer.user,
      joinedAt: peer.joinedAt || new Date().toISOString(),
      micMuted: peer.micMuted,
      deafened: peer.deafened,
      speaking: peer.speaking,
      isStreaming: this.isPeerStreaming(peer.peerId),
      voiceProducerId: this.getPeerVoiceId(peer),
      clientPlatform: peer.clientPlatform,
    };
  }

  private listRoomParticipants(roomId: string): RoomParticipant[] {
    const list: RoomParticipant[] = [];
    for (const peer of this.peers.values()) {
      if (peer.roomId === roomId) {
        list.push(this.serializeParticipant(peer));
      }
    }
    return list;
  }

  public mapRoomSummary(row: DbRoomRow): RoomSummary {
    const participants = this.listRoomParticipants(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isPrivate: Boolean(row.is_private),
      hasPassword: Boolean(row.password_hash),
      ownerId: row.owner_id || '',
      createdAt: row.created_at,
      participantCount: participants.length,
      participantsPreview: participants.slice(0, 8).map((p) => ({
        userId: p.user.id,
        displayName: p.user.displayName,
        avatarColor: p.user.avatarColor,
        role: p.user.role ?? 'member',
        speaking: p.speaking,
        isStreaming: p.isStreaming,
      })),
      activeStreamCount: this.listCombinedRoomStreams(row.id).length,
    };
  }

  async buildRoomSummaries(): Promise<RoomSummary[]> {
    const rows = await this.db.listAllRooms();
    return rows.map((r) => this.mapRoomSummary(r));
  }

  async broadcastLobbyRoomsUpdate(): Promise<void> {
    const rooms = await this.buildRoomSummaries();
    this.broadcastAll({
      type: 'event',
      event: 'lobby:roomsUpdated',
      payload: { rooms },
    });
  }

  private async handleRawMessage(peer: ConnectedPeer, text: string): Promise<void> {
    let parsed: ClientRpcRequest;
    try {
      parsed = JSON.parse(text) as ClientRpcRequest;
    } catch {
      return;
    }

    if (parsed?.type !== 'rpc:req' || typeof parsed.reqId !== 'string') {
      return;
    }

    const methodCheck = ClientRpcMethodSchema.safeParse(parsed.method);
    if (!methodCheck.success) {
      this.replyError(peer, parsed.reqId, 'INVALID_METHOD', 'Método RPC desconhecido');
      return;
    }

    try {
      const data = await this.dispatchRpc(peer, methodCheck.data, parsed.params);
      const response: ServerRpcResponse = {
        type: 'rpc:res',
        reqId: parsed.reqId,
        ok: true,
        data,
      };
      this.sendRaw(peer.socket, response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro interno na operação em tempo real';
      const code = (err as { code?: string })?.code || 'RPC_ERROR';
      this.replyError(peer, parsed.reqId, code, message);
    }
  }

  private async dispatchRpc(peer: ConnectedPeer, method: string, rawParams: unknown): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { pong: Date.now() };

      case 'lobby:listRooms':
        return { rooms: await this.buildRoomSummaries() };

      case 'room:join': {
        const params = RoomJoinParamsSchema.parse(rawParams);
        if (params.clientPlatform !== 'desktop') {
          throw Object.assign(
            new Error(
              'Salas de voz e transmissões ao vivo são exclusivas do Aplicativo Desktop Aether.'
            ),
            { code: 'DESKTOP_REQUIRED' }
          );
        }

        const freshUserRow = await this.db.findUserRowById(peer.user.id);
        if (!freshUserRow || Boolean(freshUserRow.is_banned)) {
          peer.socket.close(4003, 'Conta suspensa pela administração');
          throw Object.assign(new Error('Sua conta foi suspensa pela administração.'), {
            code: 'ACCOUNT_BANNED',
          });
        }
        peer.user = this.db.mapUserPublic(freshUserRow);

        const roomRow = await this.db.getRoomById(params.roomId);
        if (!roomRow) {
          throw Object.assign(new Error('Sala não encontrada'), { code: 'ROOM_NOT_FOUND' });
        }

        const isOwner = roomRow.owner_id === peer.user.id;
        const isStaffAdmin = hasRoleAtLeast(peer.user.role, 'admin');
        const alreadyUnlocked = await this.db.hasRoomAccess(roomRow.id, peer.user.id);

        if (roomRow.password_hash && !isOwner && !isStaffAdmin && !alreadyUnlocked) {
          if (!params.password) {
            throw Object.assign(new Error('Esta sala exige senha para entrar'), {
              code: 'PASSWORD_REQUIRED',
            });
          }
          const valid = await verifyPassword(params.password, roomRow.password_hash);
          if (!valid) {
            throw Object.assign(new Error('Senha da sala incorreta'), { code: 'INVALID_PASSWORD' });
          }
          await this.db.grantRoomAccess(roomRow.id, peer.user.id);
        } else if (
          (Boolean(roomRow.is_private) || isStaffAdmin) &&
          !isOwner &&
          !alreadyUnlocked
        ) {
          // Private room without password or staff inspection grants room access
          await this.db.grantRoomAccess(roomRow.id, peer.user.id);
        }

        // Fast switch if currently in another room
        if (peer.roomId) {
          this.leaveCurrentRoom(peer);
        }

        peer.roomId = roomRow.id;
        peer.joinedAt = new Date().toISOString();
        peer.clientPlatform = params.clientPlatform;
        peer.micMuted = params.micMuted;
        peer.deafened = params.deafened;
        peer.speaking = false;

        this.sfu.registerPeer(peer.peerId, roomRow.id, peer.user);
        const routerRtpCapabilities =
          config.mediasoup.mediaMode === 'p2p'
            ? { codecs: [], headerExtensions: [] }
            : (await this.sfu.getOrCreateRoomRouter(roomRow.id)).rtpCapabilities;
        const messages = await this.db.listRoomMessages(roomRow.id, 60);
        const participant = this.serializeParticipant(peer);

        this.broadcastToRoom(
          roomRow.id,
          {
            type: 'event',
            event: 'room:participantJoined',
            payload: { roomId: roomRow.id, participant },
          },
          peer.peerId
        );

        await this.broadcastLobbyRoomsUpdate();

        const result: RoomJoinResult = {
          peerId: peer.peerId,
          room: this.mapRoomSummary(roomRow),
          participants: this.listRoomParticipants(roomRow.id),
          activeStreams: this.listCombinedRoomStreams(roomRow.id),
          routerRtpCapabilities,
          iceServers: buildIceServersForUser(peer.user.id),
          messages,
          mediaMode: config.mediasoup.mediaMode,
        };
        return result;
      }

      case 'room:leave': {
        this.leaveCurrentRoom(peer);
        return { left: true };
      }

      case 'voice:updateState': {
        const params = VoiceStateParamsSchema.parse(rawParams);
        peer.micMuted = params.micMuted;
        peer.deafened = params.deafened;
        peer.speaking = params.micMuted ? false : params.speaking;

        if (peer.roomId) {
          this.broadcastToRoom(
            peer.roomId,
            {
              type: 'event',
              event: 'room:participantUpdated',
              payload: {
                roomId: peer.roomId,
                peerId: peer.peerId,
                userId: peer.user.id,
                micMuted: peer.micMuted,
                deafened: peer.deafened,
                speaking: peer.speaking,
                isStreaming: this.isPeerStreaming(peer.peerId),
                voiceProducerId: this.getPeerVoiceId(peer),
              },
            },
            peer.peerId
          );
        }
        return { ok: true };
      }

      case 'sfu:createTransport': {
        const params = SfuCreateTransportParamsSchema.parse(rawParams);
        return this.sfu.createTransport(peer.peerId, params.plane, params.direction);
      }

      case 'sfu:connectTransport': {
        const params = SfuConnectTransportParamsSchema.parse(rawParams);
        await this.sfu.connectTransport(peer.peerId, params.transportId, params.dtlsParameters);
        return { connected: true };
      }

      case 'sfu:produceVoice': {
        if (!peer.roomId) throw new Error('Entre em uma sala antes de publicar voz');
        const params = SfuProduceVoiceParamsSchema.parse(rawParams);
        const { producerId } = await this.sfu.produceVoice(
          peer.peerId,
          params.transportId,
          params.rtpParameters
        );

        this.broadcastToRoom(
          peer.roomId,
          {
            type: 'event',
            event: 'room:voiceProducerAvailable',
            payload: {
              roomId: peer.roomId,
              peerId: peer.peerId,
              userId: peer.user.id,
              producerId,
            },
          },
          peer.peerId
        );
        return { producerId };
      }

      case 'sfu:produceStreamTrack': {
        if (!peer.roomId) throw new Error('Entre em uma sala antes de publicar transmissão');
        const params = SfuProduceStreamTrackParamsSchema.parse(rawParams);
        return this.sfu.produceStreamTrack(
          peer.peerId,
          params.transportId,
          params.kind,
          params.rtpParameters
        );
      }

      case 'sfu:closeVoice': {
        const closedId = this.sfu.closeVoice(peer.peerId);
        if (closedId && peer.roomId) {
          this.broadcastToRoom(
            peer.roomId,
            {
              type: 'event',
              event: 'room:voiceProducerClosed',
              payload: { roomId: peer.roomId, peerId: peer.peerId, producerId: closedId },
            },
            peer.peerId
          );
        }
        return { closed: true };
      }

      case 'sfu:consumeVoice': {
        const params = SfuConsumeVoiceParamsSchema.parse(rawParams);
        return this.sfu.consumeVoice(peer.peerId, params.producerId, params.rtpCapabilities);
      }

      case 'sfu:resumeConsumer': {
        const params = SfuResumeConsumerParamsSchema.parse(rawParams);
        await this.sfu.resumeConsumer(peer.peerId, params.consumerId);
        return { resumed: true };
      }

      case 'stream:start': {
        if (!peer.roomId) throw new Error('Entre em uma sala para iniciar transmissão');
        const params = StreamStartParamsSchema.parse(rawParams);
        const stream = await this.sfu.startStream({
          peerId: peer.peerId,
          transportId: params.transportId,
          title: params.title,
          resolution: params.resolution,
          fps: params.fps,
          targetBitrateKbps: params.targetBitrateKbps,
          audioIsolationMode: params.audioIsolationMode,
          videoProducerId: params.videoProducerId,
          audioProducerId: params.audioProducerId,
          videoRtpParameters: params.videoRtpParameters,
          audioRtpParameters: params.audioRtpParameters,
        });

        this.broadcastToRoom(peer.roomId, {
          type: 'event',
          event: 'room:streamStarted',
          payload: { stream },
        });
        this.broadcastToRoom(peer.roomId, {
          type: 'event',
          event: 'room:participantUpdated',
          payload: {
            roomId: peer.roomId,
            peerId: peer.peerId,
            userId: peer.user.id,
            micMuted: peer.micMuted,
            deafened: peer.deafened,
            speaking: peer.speaking,
            isStreaming: true,
            voiceProducerId: this.sfu.getPeerVoiceProducerId(peer.peerId),
          },
        });
        await this.broadcastLobbyRoomsUpdate();
        return { stream };
      }

      case 'stream:updateMeta': {
        const params = StreamUpdateMetaParamsSchema.parse(rawParams);
        const updated = this.sfu.updateStreamMeta(
          peer.peerId,
          params.streamId,
          params.resolution,
          params.fps,
          params.targetBitrateKbps
        );
        if (updated) {
          this.broadcastToRoom(updated.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: updated },
          });
        }
        return { stream: updated };
      }

      case 'stream:telemetry': {
        const params = StreamTelemetryParamsSchema.parse(rawParams);
        const p2pRec = this.p2pStreams.get(params.streamId);
        if (p2pRec && p2pRec.broadcasterPeerId === peer.peerId) {
          p2pRec.verifiedWidth = params.verifiedWidth;
          p2pRec.verifiedHeight = params.verifiedHeight;
          p2pRec.verifiedFps = params.verifiedFps;
          p2pRec.verifiedBitrateKbps = params.verifiedBitrateKbps;
          this.broadcastToRoom(p2pRec.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: this.serializeP2pStream(p2pRec) },
          });
          return { ok: true };
        }

        const updated = this.sfu.updateStreamTelemetry(peer.peerId, params.streamId, {
          verifiedWidth: params.verifiedWidth,
          verifiedHeight: params.verifiedHeight,
          verifiedFps: params.verifiedFps,
          verifiedBitrateKbps: params.verifiedBitrateKbps,
        });
        if (updated) {
          this.broadcastToRoom(updated.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: updated },
          });
        }
        return { ok: true };
      }

      case 'stream:stop': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const stopped = this.sfu.stopStream(peer.peerId, params.streamId);
        if (stopped) {
          this.broadcastToRoom(stopped.roomId, {
            type: 'event',
            event: 'room:streamStopped',
            payload: {
              roomId: stopped.roomId,
              streamId: params.streamId,
              broadcasterId: stopped.broadcasterId,
            },
          });
          this.broadcastToRoom(stopped.roomId, {
            type: 'event',
            event: 'room:participantUpdated',
            payload: {
              roomId: stopped.roomId,
              peerId: peer.peerId,
              userId: peer.user.id,
              micMuted: peer.micMuted,
              deafened: peer.deafened,
              speaking: peer.speaking,
              isStreaming: false,
              voiceProducerId: this.sfu.getPeerVoiceProducerId(peer.peerId),
            },
          });
          await this.broadcastLobbyRoomsUpdate();
        }
        return { stopped: Boolean(stopped) };
      }

      case 'stream:watch': {
        const params = StreamWatchParamsSchema.parse(rawParams);
        const watchData = await this.sfu.watchStream(
          peer.peerId,
          params.streamId,
          params.rtpCapabilities
        );
        // Broadcast exact updated real viewer count to everyone in the room including broadcaster
        this.broadcastToRoom(watchData.stream.roomId, {
          type: 'event',
          event: 'room:streamUpdated',
          payload: { stream: watchData.stream },
        });
        return watchData;
      }

      case 'stream:unwatch': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const updatedStream = this.sfu.unwatchStream(peer.peerId, params.streamId);
        if (updatedStream) {
          this.broadcastToRoom(updatedStream.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: updatedStream },
          });
        }
        return { stream: updatedStream };
      }

      case 'p2p:voiceReady': {
        if (!peer.roomId) throw new Error('Entre em uma sala antes de ativar voz');
        const params = P2pVoiceReadyParamsSchema.parse(rawParams);
        peer.p2pVoiceReady = params.active;
        const producerId = `p2p-voice:${peer.peerId}`;
        if (params.active) {
          this.broadcastToRoom(
            peer.roomId,
            {
              type: 'event',
              event: 'room:voiceProducerAvailable',
              payload: {
                roomId: peer.roomId,
                peerId: peer.peerId,
                userId: peer.user.id,
                producerId,
              },
            },
            peer.peerId
          );
        } else {
          this.broadcastToRoom(
            peer.roomId,
            {
              type: 'event',
              event: 'room:voiceProducerClosed',
              payload: { roomId: peer.roomId, peerId: peer.peerId, producerId },
            },
            peer.peerId
          );
        }
        return { producerId: params.active ? producerId : null };
      }

      case 'p2p:signal': {
        if (!peer.roomId) throw new Error('Entre em uma sala antes de sinalizar WebRTC');
        const params = P2pSignalParamsSchema.parse(rawParams);
        const target = this.peers.get(params.targetPeerId);
        if (!target || target.roomId !== peer.roomId) {
          return { delivered: false };
        }
        this.sendToPeer(target, {
          type: 'event',
          event: 'p2p:signal',
          payload: {
            fromPeerId: peer.peerId,
            fromUserId: peer.user.id,
            plane: params.plane,
            streamId: params.streamId,
            description: params.description,
            candidate: params.candidate,
          },
        });
        return { delivered: true };
      }

      case 'p2p:streamStart': {
        if (!peer.roomId) throw new Error('Entre em uma sala para iniciar transmissão');
        const params = P2pStreamStartParamsSchema.parse(rawParams);

        // Close any previous P2P stream owned by this peer
        for (const [sid, existing] of Array.from(this.p2pStreams.entries())) {
          if (existing.broadcasterPeerId === peer.peerId) {
            this.p2pStreams.delete(sid);
          }
        }

        const streamId = crypto.randomUUID();
        const rec: P2pStreamRecord = {
          streamId,
          roomId: peer.roomId,
          broadcasterPeerId: peer.peerId,
          broadcaster: peer.user,
          title: params.title,
          resolution: params.resolution,
          fps: params.fps,
          targetBitrateKbps: params.targetBitrateKbps,
          hasAudio: params.hasAudio,
          audioIsolationMode: params.hasAudio ? params.audioIsolationMode : 'none',
          startedAt: new Date().toISOString(),
          viewers: new Map(),
        };
        this.p2pStreams.set(streamId, rec);
        const stream = this.serializeP2pStream(rec);

        this.broadcastToRoom(peer.roomId, {
          type: 'event',
          event: 'room:streamStarted',
          payload: { stream },
        });
        this.broadcastToRoom(peer.roomId, {
          type: 'event',
          event: 'room:participantUpdated',
          payload: {
            roomId: peer.roomId,
            peerId: peer.peerId,
            userId: peer.user.id,
            micMuted: peer.micMuted,
            deafened: peer.deafened,
            speaking: peer.speaking,
            isStreaming: true,
            voiceProducerId: this.getPeerVoiceId(peer),
          },
        });
        await this.broadcastLobbyRoomsUpdate();
        return { stream };
      }

      case 'p2p:streamStop': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const rec = this.p2pStreams.get(params.streamId);
        if (rec && rec.broadcasterPeerId === peer.peerId) {
          this.p2pStreams.delete(params.streamId);
          this.broadcastToRoom(rec.roomId, {
            type: 'event',
            event: 'room:streamStopped',
            payload: {
              roomId: rec.roomId,
              streamId: rec.streamId,
              broadcasterId: rec.broadcaster.id,
            },
          });
          this.broadcastToRoom(rec.roomId, {
            type: 'event',
            event: 'room:participantUpdated',
            payload: {
              roomId: rec.roomId,
              peerId: peer.peerId,
              userId: peer.user.id,
              micMuted: peer.micMuted,
              deafened: peer.deafened,
              speaking: peer.speaking,
              isStreaming: false,
              voiceProducerId: this.getPeerVoiceId(peer),
            },
          });
          await this.broadcastLobbyRoomsUpdate();
          return { stopped: true };
        }
        return { stopped: false };
      }

      case 'p2p:streamWatch': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const rec = this.p2pStreams.get(params.streamId);
        if (!rec || rec.roomId !== peer.roomId) {
          throw new Error('Transmissão não encontrada nesta sala');
        }
        if (rec.broadcasterPeerId === peer.peerId || rec.broadcaster.id === peer.user.id) {
          throw new Error('Não é permitido assistir à própria transmissão');
        }
        rec.viewers.set(peer.peerId, peer.user);
        const stream = this.serializeP2pStream(rec);

        const broadcasterPeer = this.peers.get(rec.broadcasterPeerId);
        if (broadcasterPeer) {
          this.sendToPeer(broadcasterPeer, {
            type: 'event',
            event: 'p2p:viewerJoined',
            payload: { streamId: rec.streamId, viewerPeerId: peer.peerId },
          });
        }

        this.broadcastToRoom(rec.roomId, {
          type: 'event',
          event: 'room:streamUpdated',
          payload: { stream },
        });
        return { stream, broadcasterPeerId: rec.broadcasterPeerId };
      }

      case 'p2p:streamUnwatch': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const rec = this.p2pStreams.get(params.streamId);
        if (rec && rec.viewers.delete(peer.peerId)) {
          const broadcasterPeer = this.peers.get(rec.broadcasterPeerId);
          if (broadcasterPeer) {
            this.sendToPeer(broadcasterPeer, {
              type: 'event',
              event: 'p2p:viewerLeft',
              payload: { streamId: rec.streamId, viewerPeerId: peer.peerId },
            });
          }
          const stream = this.serializeP2pStream(rec);
          this.broadcastToRoom(rec.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream },
          });
          return { stream };
        }
        return { stream: rec ? this.serializeP2pStream(rec) : null };
      }

      case 'chat:send': {
        const params = ChatSendParamsSchema.parse(rawParams);
        if (peer.roomId !== params.roomId) {
          throw new Error('Entre na sala para enviar mensagens');
        }
        const trimmed = params.content.trim();
        if (!trimmed && params.attachmentIds.length === 0) {
          throw new Error('Mensagem vazia');
        }

        const mentionedUsernames = extractMentionedUsernames(trimmed);
        const mentionedUsers = await this.db.findUsersByUsernames(mentionedUsernames);
        const mentionUserIds = mentionedUsers.map((u) => u.id);

        const message = await this.db.createMessage({
          roomId: params.roomId,
          authorId: peer.user.id,
          content: trimmed,
          mentionUserIds,
          attachmentIds: params.attachmentIds,
        });

        this.broadcastToRoom(params.roomId, {
          type: 'event',
          event: 'chat:messageCreated',
          payload: { message },
        });

        if (mentionUserIds.length > 0) {
          const roomRow = await this.db.getRoomById(params.roomId);
          const roomName = roomRow?.name || 'Sala';
          for (const targetUserId of mentionUserIds) {
            if (targetUserId === peer.user.id) continue;
            this.sendToUser(targetUserId, {
              type: 'event',
              event: 'notification:mention',
              payload: { roomId: params.roomId, roomName, message },
            });
          }
        }

        return { message };
      }

      case 'chat:edit': {
        const params = ChatEditParamsSchema.parse(rawParams);
        const mentionedUsernames = extractMentionedUsernames(params.content);
        const mentionedUsers = await this.db.findUsersByUsernames(mentionedUsernames);
        const updated = await this.db.editMessage(
          params.messageId,
          peer.user.id,
          params.content.trim(),
          mentionedUsers.map((u) => u.id)
        );
        if (!updated) {
          throw new Error('Não foi possível editar esta mensagem');
        }
        this.broadcastToRoom(updated.roomId, {
          type: 'event',
          event: 'chat:messageUpdated',
          payload: { message: updated },
        });
        return { message: updated };
      }

      case 'chat:delete': {
        const params = ChatDeleteParamsSchema.parse(rawParams);
        const freshRow = await this.db.findUserRowById(peer.user.id);
        if (freshRow) peer.user = this.db.mapUserPublic(freshRow);

        const msg = await this.db.getMessageById(params.messageId);
        if (!msg) throw new Error('Mensagem não encontrada');
        const room = await this.db.getRoomById(msg.roomId);
        const deleted = await this.db.softDeleteMessage(
          params.messageId,
          peer.user.id,
          room?.owner_id ?? null,
          peer.user.role
        );
        if (!deleted) {
          throw new Error('Sem permissão para excluir esta mensagem');
        }
        if (msg.author.id !== peer.user.id && room?.owner_id !== peer.user.id) {
          await this.db.recordAdminAuditLog({
            actorId: peer.user.id,
            actorRole: peer.user.role,
            action: 'chat:delete',
            targetUserId: msg.author.id,
            targetUsername: msg.author.username,
            details: `Mensagem removida na sala "${room?.name || msg.roomId}"`,
          });
        }
        this.broadcastToRoom(deleted.roomId, {
          type: 'event',
          event: 'chat:messageDeleted',
          payload: { roomId: deleted.roomId, messageId: params.messageId },
        });
        return { deleted: true };
      }

      case 'chat:history': {
        const params = ChatHistoryParamsSchema.parse(rawParams);
        if (peer.roomId !== params.roomId) {
          throw new Error('Acesso restrito aos participantes da sala');
        }
        const messages = await this.db.listRoomMessages(
          params.roomId,
          params.limit,
          params.beforeCreatedAt
        );
        return { messages };
      }

      case 'admin:kickParticipant': {
        const params = AdminKickParticipantParamsSchema.parse(rawParams);
        const actor = await this.requireModeratorPeer(peer);
        const target = this.peers.get(params.peerId);
        if (!target || !target.roomId) {
          throw new Error('Participante não está mais conectado em uma sala');
        }
        if (target.user.id === actor.id) {
          throw new Error('Você não pode remover a si mesmo');
        }
        const targetFresh = await this.db.findUserRowById(target.user.id);
        if (targetFresh) target.user = this.db.mapUserPublic(targetFresh);

        if (actor.role !== 'owner' && ROLE_RANK[actor.role] <= ROLE_RANK[target.user.role]) {
          throw Object.assign(
            new Error('Hierarquia insuficiente para remover este participante'),
            { code: 'FORBIDDEN' }
          );
        }

        const roomId = target.roomId;
        const room = await this.db.getRoomById(roomId);
        const reason = params.reason?.trim() || 'Removido da sala pela moderação';

        this.sendToPeer(target, {
          type: 'event',
          event: 'admin:kickedFromRoom',
          payload: {
            roomId,
            roomName: room?.name || 'Sala',
            reason,
            byDisplayName: actor.displayName,
          },
        });
        this.leaveCurrentRoom(target);

        await this.db.recordAdminAuditLog({
          actorId: actor.id,
          actorRole: actor.role,
          action: 'room:kick',
          targetUserId: target.user.id,
          targetUsername: target.user.username,
          details: `Removido da sala "${room?.name || roomId}" (${reason})`,
        });

        return { kicked: true };
      }

      case 'admin:forceMuteParticipant': {
        const params = AdminForceMuteParticipantParamsSchema.parse(rawParams);
        const actor = await this.requireModeratorPeer(peer);
        const target = this.peers.get(params.peerId);
        if (!target || !target.roomId) {
          throw new Error('Participante não está mais conectado em uma sala');
        }
        if (target.user.id === actor.id) {
          throw new Error('Use o controle local para silenciar seu próprio microfone');
        }
        const targetFresh = await this.db.findUserRowById(target.user.id);
        if (targetFresh) target.user = this.db.mapUserPublic(targetFresh);

        if (actor.role !== 'owner' && ROLE_RANK[actor.role] <= ROLE_RANK[target.user.role]) {
          throw Object.assign(
            new Error('Hierarquia insuficiente para silenciar este participante'),
            { code: 'FORBIDDEN' }
          );
        }

        const roomId = target.roomId;
        const hadP2pVoice = target.p2pVoiceReady;
        target.micMuted = true;
        target.speaking = false;
        target.p2pVoiceReady = false;

        const closedSfuVoice = this.sfu.closeVoice(target.peerId);
        const closedProducerId =
          closedSfuVoice || (hadP2pVoice ? `p2p-voice:${target.peerId}` : null);

        if (closedProducerId) {
          this.broadcastToRoom(roomId, {
            type: 'event',
            event: 'room:voiceProducerClosed',
            payload: { roomId, peerId: target.peerId, producerId: closedProducerId },
          });
        }

        this.broadcastToRoom(roomId, {
          type: 'event',
          event: 'room:participantUpdated',
          payload: {
            roomId,
            peerId: target.peerId,
            userId: target.user.id,
            micMuted: true,
            deafened: target.deafened,
            speaking: false,
            isStreaming: this.isPeerStreaming(target.peerId),
            voiceProducerId: null,
          },
        });

        this.sendToPeer(target, {
          type: 'event',
          event: 'admin:forceMuted',
          payload: {
            roomId,
            byDisplayName: actor.displayName,
          },
        });

        await this.db.recordAdminAuditLog({
          actorId: actor.id,
          actorRole: actor.role,
          action: 'voice:force_mute',
          targetUserId: target.user.id,
          targetUsername: target.user.username,
          details: `Microfone silenciado pela moderação na sala "${roomId}"`,
        });

        return { muted: true };
      }

      case 'admin:forceStopStream': {
        const params = AdminForceStopStreamParamsSchema.parse(rawParams);
        const actor = await this.requireModeratorPeer(peer);
        const reason = params.reason?.trim() || 'Transmissão encerrada pela moderação';

        const p2pRec = this.p2pStreams.get(params.streamId);
        if (p2pRec) {
          const targetRole = p2pRec.broadcaster.role ?? 'member';
          if (
            p2pRec.broadcaster.id !== actor.id &&
            actor.role !== 'owner' &&
            ROLE_RANK[actor.role] <= ROLE_RANK[targetRole]
          ) {
            throw Object.assign(
              new Error('Hierarquia insuficiente para encerrar esta transmissão'),
              { code: 'FORBIDDEN' }
            );
          }
          this.p2pStreams.delete(params.streamId);
          this.broadcastToRoom(p2pRec.roomId, {
            type: 'event',
            event: 'room:streamStopped',
            payload: {
              roomId: p2pRec.roomId,
              streamId: p2pRec.streamId,
              broadcasterId: p2pRec.broadcaster.id,
            },
          });
          const bPeer = this.peers.get(p2pRec.broadcasterPeerId);
          if (bPeer) {
            this.broadcastToRoom(p2pRec.roomId, {
              type: 'event',
              event: 'room:participantUpdated',
              payload: {
                roomId: p2pRec.roomId,
                peerId: bPeer.peerId,
                userId: bPeer.user.id,
                micMuted: bPeer.micMuted,
                deafened: bPeer.deafened,
                speaking: bPeer.speaking,
                isStreaming: false,
                voiceProducerId: this.getPeerVoiceId(bPeer),
              },
            });
          }
          await this.broadcastLobbyRoomsUpdate();
          await this.db.recordAdminAuditLog({
            actorId: actor.id,
            actorRole: actor.role,
            action: 'stream:force_stop',
            targetUserId: p2pRec.broadcaster.id,
            targetUsername: p2pRec.broadcaster.username,
            details: `Transmissão "${p2pRec.title}" encerrada (${reason})`,
          });
          return { stopped: true };
        }

        // Check SFU streams across rooms
        let sfuBroadcaster: { id: string; username: string; role: UserPublic['role']; title: string } | null =
          null;
        for (const r of await this.db.listAllRooms()) {
          const match = this.sfu.listRoomStreams(r.id).find((s) => s.streamId === params.streamId);
          if (match) {
            sfuBroadcaster = {
              id: match.broadcasterId,
              username: match.broadcasterUsername,
              role: match.broadcasterRole ?? 'member',
              title: match.title,
            };
            break;
          }
        }

        if (
          sfuBroadcaster &&
          sfuBroadcaster.id !== actor.id &&
          actor.role !== 'owner' &&
          ROLE_RANK[actor.role] <= ROLE_RANK[sfuBroadcaster.role]
        ) {
          throw Object.assign(
            new Error('Hierarquia insuficiente para encerrar esta transmissão'),
            { code: 'FORBIDDEN' }
          );
        }

        const stoppedSfu = this.sfu.forceStopStream(params.streamId);
        if (!stoppedSfu) {
          throw new Error('Transmissão não encontrada ou já encerrada');
        }

        this.broadcastToRoom(stoppedSfu.roomId, {
          type: 'event',
          event: 'room:streamStopped',
          payload: {
            roomId: stoppedSfu.roomId,
            streamId: stoppedSfu.streamId,
            broadcasterId: stoppedSfu.broadcasterId,
          },
        });

        const bPeer = this.peers.get(stoppedSfu.broadcasterPeerId);
        if (bPeer) {
          this.broadcastToRoom(stoppedSfu.roomId, {
            type: 'event',
            event: 'room:participantUpdated',
            payload: {
              roomId: stoppedSfu.roomId,
              peerId: bPeer.peerId,
              userId: bPeer.user.id,
              micMuted: bPeer.micMuted,
              deafened: bPeer.deafened,
              speaking: bPeer.speaking,
              isStreaming: false,
              voiceProducerId: this.getPeerVoiceId(bPeer),
            },
          });
        }

        await this.broadcastLobbyRoomsUpdate();
        await this.db.recordAdminAuditLog({
          actorId: actor.id,
          actorRole: actor.role,
          action: 'stream:force_stop',
          targetUserId: sfuBroadcaster?.id ?? stoppedSfu.broadcasterId,
          targetUsername: sfuBroadcaster?.username ?? null,
          details: `Transmissão "${sfuBroadcaster?.title || params.streamId}" encerrada (${reason})`,
        });

        return { stopped: true };
      }

      default:
        throw new Error(`Método não suportado: ${method}`);
    }
  }

  private replyError(peer: ConnectedPeer, reqId: string, code: string, message: string): void {
    const response: ServerRpcResponse = {
      type: 'rpc:res',
      reqId,
      ok: false,
      error: { code, message },
    };
    this.sendRaw(peer.socket, response);
  }

  private sendToPeer(peer: ConnectedPeer, event: ServerPushEvent): void {
    this.sendRaw(peer.socket, event);
  }

  private sendRaw(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(payload));
    }
  }

  public broadcastAll(event: ServerPushEvent, excludePeerId?: string): void {
    this.sendLocalAll(event, excludePeerId);
    void this.cluster.publish({ scope: 'all', excludePeerId, event });
  }

  public broadcastToRoom(roomId: string, event: ServerPushEvent, excludePeerId?: string): void {
    this.sendLocalRoom(roomId, event, excludePeerId);
    void this.cluster.publish({ scope: 'room', targetId: roomId, excludePeerId, event });
  }

  public sendToUser(userId: string, event: ServerPushEvent): void {
    this.sendLocalUser(userId, event);
    void this.cluster.publish({ scope: 'user', targetId: userId, event });
  }

  private sendLocalAll(event: ServerPushEvent, excludePeerId?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.peerId === excludePeerId) continue;
      this.sendToPeer(peer, event);
    }
  }

  private sendLocalRoom(roomId: string, event: ServerPushEvent, excludePeerId?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.roomId === roomId && peer.peerId !== excludePeerId) {
        this.sendToPeer(peer, event);
      }
    }
  }

  private sendLocalUser(userId: string, event: ServerPushEvent): void {
    for (const peer of this.peers.values()) {
      if (peer.user.id === userId) {
        this.sendToPeer(peer, event);
      }
    }
  }

  private async requireModeratorPeer(peer: ConnectedPeer): Promise<UserPublic> {
    const freshRow = await this.db.findUserRowById(peer.user.id);
    if (!freshRow || Boolean(freshRow.is_banned)) {
      peer.socket.close(4003, 'Conta suspensa');
      throw Object.assign(new Error('Conta suspensa'), { code: 'FORBIDDEN' });
    }
    const freshUser = this.db.mapUserPublic(freshRow);
    peer.user = freshUser;
    if (!hasRoleAtLeast(freshUser.role, 'moderator')) {
      throw Object.assign(new Error('Permissão administrativa necessária'), { code: 'FORBIDDEN' });
    }
    return freshUser;
  }

  public getOnlineUserMap(): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const peer of this.peers.values()) {
      const existing = map.get(peer.user.id);
      if (existing === undefined || (existing === null && peer.roomId !== null)) {
        map.set(peer.user.id, peer.roomId);
      }
    }
    return map;
  }

  public async syncUserRoleEverywhere(updatedUser: UserPublic): Promise<void> {
    let touchedRoom = false;
    for (const peer of this.peers.values()) {
      if (peer.user.id === updatedUser.id) {
        peer.user = updatedUser;
        if (peer.roomId) {
          touchedRoom = true;
        }
      }
    }

    this.sfu.syncUserRole(updatedUser);

    for (const rec of this.p2pStreams.values()) {
      let changed = false;
      if (rec.broadcaster.id === updatedUser.id) {
        rec.broadcaster = updatedUser;
        changed = true;
      }
      for (const [viewerPeerId, viewerUser] of rec.viewers.entries()) {
        if (viewerUser.id === updatedUser.id) {
          rec.viewers.set(viewerPeerId, updatedUser);
          changed = true;
        }
      }
      if (changed) {
        this.broadcastToRoom(rec.roomId, {
          type: 'event',
          event: 'room:streamUpdated',
          payload: { stream: this.serializeP2pStream(rec) },
        });
      }
    }

    this.broadcastAll({
      type: 'event',
      event: 'user:roleUpdated',
      payload: {
        userId: updatedUser.id,
        username: updatedUser.username,
        displayName: updatedUser.displayName,
        role: updatedUser.role,
      },
    });

    if (touchedRoom) {
      await this.broadcastLobbyRoomsUpdate();
    }
  }

  public disconnectBannedUser(userId: string, reason: string): void {
    for (const [peerId, peer] of Array.from(this.peers.entries())) {
      if (peer.user.id === userId) {
        this.sendToPeer(peer, {
          type: 'event',
          event: 'admin:accountBanned',
          payload: { reason },
        });
        this.leaveCurrentRoom(peer);
        this.peers.delete(peerId);
        try {
          peer.socket.close(4003, 'Conta suspensa pela administração');
        } catch {
          // ignore socket close error
        }
      }
    }
  }

  public evictRoomParticipantsOnDelete(
    roomId: string,
    roomName: string,
    byDisplayName: string
  ): void {
    for (const peer of Array.from(this.peers.values())) {
      if (peer.roomId === roomId) {
        this.sendToPeer(peer, {
          type: 'event',
          event: 'admin:kickedFromRoom',
          payload: {
            roomId,
            roomName,
            reason: 'Sala encerrada pela administração',
            byDisplayName,
          },
        });
        this.leaveCurrentRoom(peer);
      }
    }
  }

  public getOnlineCount(): number {
    return this.peers.size;
  }

  public close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const peer of this.peers.values()) {
      peer.socket.close(1001, 'Servidor reiniciando');
    }
    this.peers.clear();
  }
}

