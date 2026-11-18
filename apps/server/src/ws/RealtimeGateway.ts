import crypto from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import {
  AdminForceMuteParticipantParamsSchema,
  AdminForceStopStreamParamsSchema,
  AdminKickParticipantParamsSchema,
  ChatDeleteParamsSchema,
  ChatEditParamsSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  ClientRpcMethodSchema,
  DmDeleteParamsSchema,
  DmEditParamsSchema,
  DmHistoryParamsSchema,
  DmMarkReadParamsSchema,
  DmSendParamsSchema,
  DmTypingParamsSchema,
  FriendInviteToRoomParamsSchema,
  FriendRemoveParamsSchema,
  FriendRequestParamsSchema,
  FriendRespondParamsSchema,
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
  StreamRelayInitParamsSchema,
  StreamRelayStartParamsSchema,
  StreamStartParamsSchema,
  StreamStopOrUnwatchParamsSchema,
  StreamTelemetryParamsSchema,
  StreamUpdateMetaParamsSchema,
  StreamWatchParamsSchema,
  VoiceStateParamsSchema,
  type ActiveStreamInfo,
  type AudioIsolationMode,
  type ClientRpcRequest,
  type FriendEntry,
  type RoomJoinResult,
  type RoomParticipant,
  type RoomSummary,
  type ServerPushEvent,
  type ServerRpcResponse,
  type StreamConnectionMode,
  type StreamFps,
  type StreamPrivacyMode,
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
  missedPongs: number;
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
  audioBitrateKbps: number;
  privacy: StreamPrivacyMode;
  allowedUserIds: Set<string>;
  viewerLimit: number | null;
  connectionMode: StreamConnectionMode;
  relayActive: boolean;
  hasAudio: boolean;
  audioIsolationMode: AudioIsolationMode;
  startedAt: string;
  viewers: Map<string, UserPublic>; // viewerPeerId -> UserPublic
  verifiedWidth?: number;
  verifiedHeight?: number;
  verifiedFps?: number;
  verifiedBitrateKbps?: number;
}

interface RelaySessionState {
  streamId: string;
  roomId: string;
  broadcasterPeerId: string;
  broadcasterId: string;
  active: boolean;
  mimeType: string;
  base64Init: string | null;
  viewers: Set<string>; // viewerPeerIds receiving binary chunks
}

const RELAY_FRAME_VERSION = 1;
const RELAY_STREAM_ID_BYTES = 36;
const RELAY_HEADER_BYTES = 1 + RELAY_STREAM_ID_BYTES;

export class RealtimeGateway {
  private peers = new Map<string, ConnectedPeer>();
  private p2pStreams = new Map<string, P2pStreamRecord>();
  private relaySessions = new Map<string, RelaySessionState>();
  private roomNameCache = new Map<string, string>();
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
      this.relaySessions.delete(streamId);
      this.broadcastToRoom(roomId, {
        type: 'event',
        event: 'room:streamStopped',
        payload: { roomId, streamId, broadcasterId },
      });
      void this.broadcastLobbyRoomsUpdate();
      void this.notifyFriendsPresenceChanged(broadcasterId, 'stream:stopped');
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

    // Tolerant 30s ping with 2-miss grace (60s total) so heavy DX12 map loads never drop presence
    this.heartbeatTimer = setInterval(() => {
      for (const [peerId, peer] of this.peers.entries()) {
        if (peer.missedPongs >= 2) {
          try {
            peer.socket.terminate();
          } catch {
            // ignore
          }
          this.handleDisconnect(peerId);
          continue;
        }
        peer.missedPongs += 1;
        try {
          peer.socket.ping();
        } catch {
          this.handleDisconnect(peerId);
        }
      }
    }, 30000);
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
    const wasOnlineBefore = this.isUserOnline(user.id);
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
      missedPongs: 0,
    };

    this.peers.set(peerId, peer);

    socket.on('pong', () => {
      peer.missedPongs = 0;
    });

    socket.on('message', (rawData: RawData, isBinary: boolean) => {
      peer.missedPongs = 0;
      if (isBinary) {
        this.handleBinaryRelayFrame(peer, rawData);
        return;
      }
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

    if (!wasOnlineBefore) {
      void this.notifyFriendsPresenceChanged(user.id, 'user:online');
    }
  }

  private handleBinaryRelayFrame(senderPeer: ConnectedPeer, rawData: RawData): void {
    let buf: Buffer;
    if (Buffer.isBuffer(rawData)) {
      buf = rawData;
    } else if (Array.isArray(rawData)) {
      buf = Buffer.concat(rawData);
    } else {
      buf = Buffer.from(rawData as ArrayBuffer);
    }

    if (buf.length <= RELAY_HEADER_BYTES || buf[0] !== RELAY_FRAME_VERSION) {
      return;
    }

    const streamId = buf.toString('ascii', 1, RELAY_HEADER_BYTES);
    const session = this.relaySessions.get(streamId);
    if (!session || session.broadcasterPeerId !== senderPeer.peerId) {
      return;
    }

    for (const viewerPeerId of Array.from(session.viewers)) {
      const viewerPeer = this.peers.get(viewerPeerId);
      if (!viewerPeer || viewerPeer.roomId !== session.roomId || viewerPeer.socket.readyState !== 1) {
        session.viewers.delete(viewerPeerId);
        continue;
      }
      // Backpressure guard (6 MB max queued per viewer socket) so slow connections never bloat server RAM
      if (viewerPeer.socket.bufferedAmount < 6 * 1024 * 1024) {
        viewerPeer.socket.send(buf, { binary: true });
      }
    }
  }

  private handleDisconnect(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const userId = peer.user.id;
    this.leaveCurrentRoom(peer);
    this.peers.delete(peerId);

    if (!this.isUserOnline(userId)) {
      void this.notifyFriendsPresenceChanged(userId, 'user:offline');
    }
  }

  private isUserOnline(userId: string): boolean {
    for (const p of this.peers.values()) {
      if (p.user.id === userId) return true;
    }
    return false;
  }

  private resolveLiveFriendState(friendUser: UserPublic): {
    isOnline: boolean;
    currentRoomId: string | null;
    currentRoomName: string | null;
    isStreaming: boolean;
  } {
    let isOnline = false;
    let currentRoomId: string | null = null;
    let isStreaming = false;

    for (const p of this.peers.values()) {
      if (p.user.id === friendUser.id) {
        isOnline = true;
        if (p.roomId) {
          currentRoomId = p.roomId;
          if (this.isPeerStreaming(p.peerId)) {
            isStreaming = true;
          }
        }
      }
    }

    const currentRoomName = currentRoomId ? (this.roomNameCache.get(currentRoomId) ?? null) : null;
    return { isOnline, currentRoomId, currentRoomName, isStreaming };
  }

  public async buildFriendsListForUser(userId: string): Promise<FriendEntry[]> {
    if (this.roomNameCache.size === 0) {
      const rooms = await this.db.listAllRooms();
      for (const r of rooms) {
        this.roomNameCache.set(r.id, r.name);
      }
    }
    return this.db.listFriendsForUser(userId, (u) => this.resolveLiveFriendState(u));
  }

  public async notifyFriendsPresenceChanged(userId: string, reason: string): Promise<void> {
    try {
      const friendIds = await this.db.listAcceptedFriendUserIds(userId);
      for (const friendId of friendIds) {
        if (this.isUserOnline(friendId)) {
          this.sendToUser(friendId, {
            type: 'event',
            event: 'friends:updated',
            payload: { reason },
          });
        }
      }
    } catch {
      // ignore transient notification errors
    }
  }

  private serializeP2pStream(rec: P2pStreamRecord): ActiveStreamInfo {
    const uniqueUsers = new Map<string, UserPublic>();
    for (const u of rec.viewers.values()) {
      uniqueUsers.set(u.id, u);
    }
    const relay = this.relaySessions.get(rec.streamId);
    if (relay) {
      for (const vPeerId of relay.viewers) {
        const vp = this.peers.get(vPeerId);
        if (vp && vp.user.id !== rec.broadcaster.id) {
          uniqueUsers.set(vp.user.id, vp.user);
        }
      }
    }
    const viewerUsers = Array.from(uniqueUsers.values()).map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      avatarColor: u.avatarColor,
      avatarUrl: u.avatarUrl ?? null,
      role: u.role ?? 'member',
    }));
    return {
      streamId: rec.streamId,
      roomId: rec.roomId,
      broadcasterId: rec.broadcaster.id,
      broadcasterUsername: rec.broadcaster.username,
      broadcasterDisplayName: rec.broadcaster.displayName,
      broadcasterAvatarColor: rec.broadcaster.avatarColor,
      broadcasterAvatarUrl: rec.broadcaster.avatarUrl ?? null,
      broadcasterRole: rec.broadcaster.role ?? 'member',
      title: rec.title,
      resolution: rec.resolution,
      fps: rec.fps,
      targetBitrateKbps: rec.targetBitrateKbps,
      audioBitrateKbps: rec.audioBitrateKbps,
      privacy: rec.privacy,
      viewerLimit: rec.viewerLimit,
      connectionMode: rec.connectionMode,
      relayActive: rec.relayActive || Boolean(relay?.active),
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

  private async assertViewerStreamAccess(
    meta: {
      broadcasterId: string;
      privacy: StreamPrivacyMode;
      allowedUserIds: Set<string>;
      viewerLimit: number | null;
      uniqueViewerIds: Set<string>;
    },
    viewerUser: UserPublic
  ): Promise<void> {
    const isStaffAdmin = hasRoleAtLeast(viewerUser.role, 'admin');

    if (meta.privacy === 'friends' && !isStaffAdmin) {
      const friends = await this.db.areUsersFriends(meta.broadcasterId, viewerUser.id);
      if (!friends) {
        throw Object.assign(
          new Error('Esta transmissão é restrita aos amigos do transmissor.'),
          { code: 'STREAM_FRIENDS_ONLY' }
        );
      }
    } else if (meta.privacy === 'private' && !isStaffAdmin) {
      if (!meta.allowedUserIds.has(viewerUser.id)) {
        throw Object.assign(
          new Error('Esta transmissão é privada para convidados selecionados.'),
          { code: 'STREAM_PRIVATE' }
        );
      }
    }

    if (
      meta.viewerLimit !== null &&
      !meta.uniqueViewerIds.has(viewerUser.id) &&
      meta.uniqueViewerIds.size >= meta.viewerLimit
    ) {
      throw Object.assign(
        new Error(`Limite de ${meta.viewerLimit} espectadores simultâneos atingido nesta transmissão.`),
        { code: 'VIEWER_LIMIT_REACHED' }
      );
    }
  }

  private getCombinedStreamAccessMeta(streamId: string): {
    roomId: string;
    broadcasterId: string;
    broadcasterPeerId: string;
    privacy: StreamPrivacyMode;
    allowedUserIds: Set<string>;
    viewerLimit: number | null;
    uniqueViewerIds: Set<string>;
  } | null {
    const p2p = this.p2pStreams.get(streamId);
    if (p2p) {
      const uniqueViewerIds = new Set<string>();
      for (const u of p2p.viewers.values()) uniqueViewerIds.add(u.id);
      const relay = this.relaySessions.get(streamId);
      if (relay) {
        for (const vpId of relay.viewers) {
          const vp = this.peers.get(vpId);
          if (vp) uniqueViewerIds.add(vp.user.id);
        }
      }
      return {
        roomId: p2p.roomId,
        broadcasterId: p2p.broadcaster.id,
        broadcasterPeerId: p2p.broadcasterPeerId,
        privacy: p2p.privacy,
        allowedUserIds: p2p.allowedUserIds,
        viewerLimit: p2p.viewerLimit,
        uniqueViewerIds,
      };
    }

    const sfuMeta = this.sfu.getStreamAccessMeta(streamId);
    if (sfuMeta) {
      const relay = this.relaySessions.get(streamId);
      if (relay) {
        for (const vpId of relay.viewers) {
          const vp = this.peers.get(vpId);
          if (vp) sfuMeta.uniqueViewerIds.add(vp.user.id);
        }
      }
      return sfuMeta;
    }
    return null;
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
      this.relaySessions.delete(stoppedStream.streamId);
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

    // Cleanup any relay viewer or broadcaster session owned by this peer
    for (const [sid, relay] of Array.from(this.relaySessions.entries())) {
      if (relay.broadcasterPeerId === peer.peerId) {
        this.relaySessions.delete(sid);
      } else {
        relay.viewers.delete(peer.peerId);
      }
    }

    // Cleanup any P2P broadcast or P2P viewer membership for this peer
    for (const [sid, rec] of Array.from(this.p2pStreams.entries())) {
      if (rec.broadcasterPeerId === peer.peerId) {
        this.p2pStreams.delete(sid);
        this.relaySessions.delete(sid);
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
    void this.notifyFriendsPresenceChanged(peer.user.id, 'room:left');
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

  /**
   * Lists participants in a room, enforcing 1 user = 1 active participant (zero clones).
   */
  private listRoomParticipants(roomId: string): RoomParticipant[] {
    const byUserId = new Map<string, RoomParticipant>();
    for (const peer of this.peers.values()) {
      if (peer.roomId === roomId) {
        byUserId.set(peer.user.id, this.serializeParticipant(peer));
      }
    }
    return Array.from(byUserId.values());
  }

  public mapRoomSummary(row: DbRoomRow): RoomSummary {
    this.roomNameCache.set(row.id, row.name);
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
        avatarUrl: p.user.avatarUrl ?? null,
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
          await this.db.grantRoomAccess(roomRow.id, peer.user.id);
        }

        // ATOMIC PRESENCE GUARANTEE (ZERO CLONES / ZERO GHOSTS):
        // Evict any stale or duplicate room connection belonging to this same user.id BEFORE joining!
        for (const [otherPeerId, otherPeer] of Array.from(this.peers.entries())) {
          if (
            otherPeerId !== peer.peerId &&
            otherPeer.user.id === peer.user.id &&
            otherPeer.roomId !== null
          ) {
            this.leaveCurrentRoom(otherPeer);
            this.peers.delete(otherPeerId);
            try {
              otherPeer.socket.close(4009, 'Sessão substituída por nova conexão na sala');
            } catch {
              // ignore stale socket error
            }
          }
        }

        // Fast switch if this socket was already in a room
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
        void this.notifyFriendsPresenceChanged(peer.user.id, 'room:joined');

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

      case 'room:syncState': {
        if (!peer.roomId) {
          return {
            peerId: peer.peerId,
            inRoom: false,
            room: null,
            participants: [],
            activeStreams: [],
          };
        }
        const roomRow = await this.db.getRoomById(peer.roomId);
        if (!roomRow) {
          this.leaveCurrentRoom(peer);
          return {
            peerId: peer.peerId,
            inRoom: false,
            room: null,
            participants: [],
            activeStreams: [],
          };
        }
        return {
          peerId: peer.peerId,
          inRoom: true,
          room: this.mapRoomSummary(roomRow),
          participants: this.listRoomParticipants(roomRow.id),
          activeStreams: this.listCombinedRoomStreams(roomRow.id),
        };
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
          audioBitrateKbps: params.audioBitrateKbps,
          privacy: params.privacy,
          allowedUserIds: params.allowedUserIds,
          viewerLimit: params.viewerLimit,
          connectionMode: params.connectionMode,
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
        void this.notifyFriendsPresenceChanged(peer.user.id, 'stream:started');
        return { stream };
      }

      case 'stream:updateMeta': {
        const params = StreamUpdateMetaParamsSchema.parse(rawParams);
        const p2pRec = this.p2pStreams.get(params.streamId);
        if (p2pRec && p2pRec.broadcasterPeerId === peer.peerId) {
          if (params.resolution !== undefined) p2pRec.resolution = params.resolution;
          if (params.fps !== undefined) p2pRec.fps = params.fps;
          if (params.targetBitrateKbps !== undefined) p2pRec.targetBitrateKbps = params.targetBitrateKbps;
          if (params.audioBitrateKbps !== undefined) p2pRec.audioBitrateKbps = params.audioBitrateKbps;
          if (params.privacy !== undefined) p2pRec.privacy = params.privacy;
          if (params.viewerLimit !== undefined) p2pRec.viewerLimit = params.viewerLimit;
          if (params.connectionMode !== undefined) p2pRec.connectionMode = params.connectionMode;
          const serialized = this.serializeP2pStream(p2pRec);
          this.broadcastToRoom(p2pRec.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: serialized },
          });
          return { stream: serialized };
        }

        const updated = this.sfu.updateStreamMeta(peer.peerId, params.streamId, {
          resolution: params.resolution,
          fps: params.fps,
          targetBitrateKbps: params.targetBitrateKbps,
          audioBitrateKbps: params.audioBitrateKbps,
          privacy: params.privacy,
          viewerLimit: params.viewerLimit,
          connectionMode: params.connectionMode,
        });
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
          p2pRec.verifiedFps = Math.round(params.verifiedFps * 10) / 10;
          p2pRec.verifiedBitrateKbps = Math.round(params.verifiedBitrateKbps);
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
        this.relaySessions.delete(params.streamId);
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
          void this.notifyFriendsPresenceChanged(peer.user.id, 'stream:stopped');
        }
        return { stopped: Boolean(stopped) };
      }

      case 'stream:watch': {
        const params = StreamWatchParamsSchema.parse(rawParams);
        const accessMeta = this.sfu.getStreamAccessMeta(params.streamId);
        if (!accessMeta || accessMeta.roomId !== peer.roomId) {
          throw new Error('Transmissão não está ativa nesta sala');
        }
        await this.assertViewerStreamAccess(accessMeta, peer.user);

        const watchData = await this.sfu.watchStream(
          peer.peerId,
          params.streamId,
          params.rtpCapabilities
        );
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

        for (const [sid, existing] of Array.from(this.p2pStreams.entries())) {
          if (existing.broadcasterPeerId === peer.peerId) {
            this.p2pStreams.delete(sid);
            this.relaySessions.delete(sid);
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
          audioBitrateKbps: params.audioBitrateKbps,
          privacy: params.privacy,
          allowedUserIds: new Set(params.allowedUserIds),
          viewerLimit: params.viewerLimit,
          connectionMode: params.connectionMode,
          relayActive: false,
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
        void this.notifyFriendsPresenceChanged(peer.user.id, 'stream:started');
        return { stream };
      }

      case 'p2p:streamStop': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        this.relaySessions.delete(params.streamId);
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
          void this.notifyFriendsPresenceChanged(peer.user.id, 'stream:stopped');
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

        const accessMeta = this.getCombinedStreamAccessMeta(params.streamId);
        if (accessMeta) {
          await this.assertViewerStreamAccess(accessMeta, peer.user);
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
        const relay = this.relaySessions.get(params.streamId);
        if (relay) relay.viewers.delete(peer.peerId);

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

      // Built-in Cloud WSS Binary Media Relay (100% Anti-Black-Screen Symmetric CGNAT / Firewall Fallback)
      case 'stream:relayStart': {
        if (!peer.roomId) throw new Error('Entre em uma sala antes de ativar o relay');
        const params = StreamRelayStartParamsSchema.parse(rawParams);
        const accessMeta = this.getCombinedStreamAccessMeta(params.streamId);
        if (!accessMeta || accessMeta.broadcasterPeerId !== peer.peerId) {
          throw new Error('Transmissão não pertence a esta sessão');
        }

        let session = this.relaySessions.get(params.streamId);
        if (!session) {
          session = {
            streamId: params.streamId,
            roomId: accessMeta.roomId,
            broadcasterPeerId: peer.peerId,
            broadcasterId: peer.user.id,
            active: true,
            mimeType: params.mimeType,
            base64Init: null,
            viewers: new Set(),
          };
          this.relaySessions.set(params.streamId, session);
        } else {
          session.active = true;
          session.mimeType = params.mimeType;
          session.base64Init = null;
        }

        const p2pRec = this.p2pStreams.get(params.streamId);
        if (p2pRec) {
          p2pRec.relayActive = true;
          this.broadcastToRoom(p2pRec.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: this.serializeP2pStream(p2pRec) },
          });
        } else {
          const updatedSfu = this.sfu.setStreamRelayActive(params.streamId, true);
          if (updatedSfu) {
            this.broadcastToRoom(updatedSfu.roomId, {
              type: 'event',
              event: 'room:streamUpdated',
              payload: { stream: updatedSfu },
            });
          }
        }

        for (const viewerPeerId of session.viewers) {
          const vp = this.peers.get(viewerPeerId);
          if (vp) {
            this.sendToPeer(vp, {
              type: 'event',
              event: 'stream:relayReady',
              payload: {
                streamId: params.streamId,
                mimeType: session.mimeType,
                base64Init: session.base64Init,
              },
            });
          }
        }
        return { started: true };
      }

      case 'stream:relayInitSegment': {
        const params = StreamRelayInitParamsSchema.parse(rawParams);
        const session = this.relaySessions.get(params.streamId);
        if (!session || session.broadcasterPeerId !== peer.peerId) {
          return { cached: false };
        }
        session.base64Init = params.base64Init;
        for (const viewerPeerId of session.viewers) {
          const vp = this.peers.get(viewerPeerId);
          if (vp) {
            this.sendToPeer(vp, {
              type: 'event',
              event: 'stream:relayReady',
              payload: {
                streamId: params.streamId,
                mimeType: session.mimeType,
                base64Init: session.base64Init,
              },
            });
          }
        }
        return { cached: true };
      }

      case 'stream:relayStop': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const session = this.relaySessions.get(params.streamId);
        if (session && session.broadcasterPeerId === peer.peerId) {
          this.relaySessions.delete(params.streamId);
          const p2pRec = this.p2pStreams.get(params.streamId);
          if (p2pRec) p2pRec.relayActive = false;
          this.sfu.setStreamRelayActive(params.streamId, false);
        }
        return { stopped: true };
      }

      case 'stream:relayWatch': {
        if (!peer.roomId) throw new Error('Entre em uma sala para assistir');
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const accessMeta = this.getCombinedStreamAccessMeta(params.streamId);
        if (!accessMeta || accessMeta.roomId !== peer.roomId) {
          throw new Error('Transmissão não encontrada nesta sala');
        }
        if (accessMeta.broadcasterId === peer.user.id || accessMeta.broadcasterPeerId === peer.peerId) {
          throw new Error('O transmissor não consome a própria transmissão');
        }
        await this.assertViewerStreamAccess(accessMeta, peer.user);

        let session = this.relaySessions.get(params.streamId);
        if (!session) {
          session = {
            streamId: params.streamId,
            roomId: accessMeta.roomId,
            broadcasterPeerId: accessMeta.broadcasterPeerId,
            broadcasterId: accessMeta.broadcasterId,
            active: false,
            mimeType: 'video/webm;codecs=vp8,opus',
            base64Init: null,
            viewers: new Set(),
          };
          this.relaySessions.set(params.streamId, session);
        }

        session.viewers.add(peer.peerId);

        const p2pRec = this.p2pStreams.get(params.streamId);
        if (p2pRec) {
          p2pRec.viewers.set(peer.peerId, peer.user);
          this.broadcastToRoom(p2pRec.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: this.serializeP2pStream(p2pRec) },
          });
        }

        // Notify broadcaster to start or refresh relay keyframe stream on demand
        const broadcasterPeer = this.peers.get(accessMeta.broadcasterPeerId);
        if (broadcasterPeer) {
          this.sendToPeer(broadcasterPeer, {
            type: 'event',
            event: 'stream:relayViewerNeeded',
            payload: { streamId: params.streamId },
          });
        }

        return {
          ok: true,
          active: session.active,
          mimeType: session.mimeType,
          base64Init: session.base64Init,
        };
      }

      case 'stream:relayUnwatch': {
        const params = StreamStopOrUnwatchParamsSchema.parse(rawParams);
        const session = this.relaySessions.get(params.streamId);
        if (session) {
          session.viewers.delete(peer.peerId);
        }
        const p2pRec = this.p2pStreams.get(params.streamId);
        if (p2pRec) {
          this.broadcastToRoom(p2pRec.roomId, {
            type: 'event',
            event: 'room:streamUpdated',
            payload: { stream: this.serializeP2pStream(p2pRec) },
          });
        }
        return { ok: true };
      }

      // Room Chat
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

      // Friends System RPCs
      case 'friends:list': {
        const friends = await this.buildFriendsListForUser(peer.user.id);
        return { friends };
      }

      case 'friends:request': {
        const params = FriendRequestParamsSchema.parse(rawParams);
        const res = await this.db.sendFriendRequest(peer.user.id, params.username);
        const myFriends = await this.buildFriendsListForUser(peer.user.id);
        this.sendToUser(res.targetUser.id, {
          type: 'event',
          event: 'friends:updated',
          payload: {
            reason: res.autoAccepted ? 'friend:accepted' : 'friend:incoming_request',
          },
        });
        return {
          friendshipId: res.friendshipId,
          targetUser: res.targetUser,
          autoAccepted: res.autoAccepted,
          friends: myFriends,
        };
      }

      case 'friends:respond': {
        const params = FriendRespondParamsSchema.parse(rawParams);
        const res = await this.db.respondFriendRequest(params.friendshipId, peer.user.id, params.accept);
        const otherId = res.requesterId === peer.user.id ? res.addresseeId : res.requesterId;
        this.sendToUser(otherId, {
          type: 'event',
          event: 'friends:updated',
          payload: {
            reason: res.accepted ? 'friend:accepted' : 'friend:declined',
          },
        });
        const myFriends = await this.buildFriendsListForUser(peer.user.id);
        return { accepted: res.accepted, friends: myFriends };
      }

      case 'friends:remove': {
        const params = FriendRemoveParamsSchema.parse(rawParams);
        const res = await this.db.removeFriendship(params.friendshipId, peer.user.id);
        this.sendToUser(res.otherUserId, {
          type: 'event',
          event: 'friends:updated',
          payload: { reason: 'friend:removed' },
        });
        const myFriends = await this.buildFriendsListForUser(peer.user.id);
        return { removed: true, friends: myFriends };
      }

      case 'friends:inviteToRoom': {
        const params = FriendInviteToRoomParamsSchema.parse(rawParams);
        const roomRow = await this.db.getRoomById(params.roomId);
        if (!roomRow) {
          throw new Error('Sala não encontrada');
        }
        const areFriends = await this.db.areUsersFriends(peer.user.id, params.targetUserId);
        if (!areFriends && !hasRoleAtLeast(peer.user.role, 'moderator')) {
          throw new Error('Você só pode enviar convites diretos para amigos');
        }
        // Grant access if room is private/password-protected and inviter is in room or owner
        if (peer.roomId === roomRow.id || roomRow.owner_id === peer.user.id) {
          await this.db.grantRoomAccess(roomRow.id, params.targetUserId);
        }

        const dm = await this.db.createDirectMessage({
          senderId: peer.user.id,
          recipientId: params.targetUserId,
          content: `Convite para entrar na sala de voz **${roomRow.name}**`,
          mentionUserIds: [params.targetUserId],
          attachmentIds: [],
          roomInvite: { roomId: roomRow.id, roomName: roomRow.name },
        });

        this.sendToUser(params.targetUserId, {
          type: 'event',
          event: 'friends:roomInvite',
          payload: {
            fromUser: peer.user,
            roomId: roomRow.id,
            roomName: roomRow.name,
          },
        });
        this.sendToUser(params.targetUserId, {
          type: 'event',
          event: 'dm:messageCreated',
          payload: { message: dm },
        });
        this.sendToUser(peer.user.id, {
          type: 'event',
          event: 'dm:messageCreated',
          payload: { message: dm },
        });
        return { invited: true, message: dm };
      }

      // Direct Messages (DMs) RPCs
      case 'dm:history': {
        const params = DmHistoryParamsSchema.parse(rawParams);
        const messages = await this.db.listDirectMessages(
          peer.user.id,
          params.peerUserId,
          params.limit,
          params.beforeCreatedAt
        );
        return { messages };
      }

      case 'dm:send': {
        const params = DmSendParamsSchema.parse(rawParams);
        if (params.recipientId === peer.user.id) {
          throw new Error('Não é possível enviar mensagem direta para si mesmo');
        }
        const targetRow = await this.db.findUserRowById(params.recipientId);
        if (!targetRow) {
          throw new Error('Destinatário não encontrado');
        }
        const trimmed = params.content.trim();
        if (!trimmed && params.attachmentIds.length === 0 && !params.roomInvite) {
          throw new Error('Mensagem vazia');
        }

        const mentionedUsernames = extractMentionedUsernames(trimmed);
        const mentionedUsers = await this.db.findUsersByUsernames(mentionedUsernames);

        const dm = await this.db.createDirectMessage({
          senderId: peer.user.id,
          recipientId: params.recipientId,
          content: trimmed,
          mentionUserIds: mentionedUsers.map((u) => u.id),
          attachmentIds: params.attachmentIds,
          roomInvite: params.roomInvite ?? null,
        });

        this.sendToUser(params.recipientId, {
          type: 'event',
          event: 'dm:messageCreated',
          payload: { message: dm },
        });
        this.sendToUser(peer.user.id, {
          type: 'event',
          event: 'dm:messageCreated',
          payload: { message: dm },
        });
        return { message: dm };
      }

      case 'dm:edit': {
        const params = DmEditParamsSchema.parse(rawParams);
        const mentionedUsernames = extractMentionedUsernames(params.content);
        const mentionedUsers = await this.db.findUsersByUsernames(mentionedUsernames);
        const updated = await this.db.editDirectMessage(
          params.messageId,
          peer.user.id,
          params.content.trim(),
          mentionedUsers.map((u) => u.id)
        );
        if (!updated) {
          throw new Error('Não foi possível editar esta mensagem direta');
        }
        this.sendToUser(updated.recipientId, {
          type: 'event',
          event: 'dm:messageUpdated',
          payload: { message: updated },
        });
        this.sendToUser(updated.sender.id, {
          type: 'event',
          event: 'dm:messageUpdated',
          payload: { message: updated },
        });
        return { message: updated };
      }

      case 'dm:delete': {
        const params = DmDeleteParamsSchema.parse(rawParams);
        const deleted = await this.db.softDeleteDirectMessage(params.messageId, peer.user.id);
        if (!deleted) {
          throw new Error('Não foi possível excluir esta mensagem direta');
        }
        this.sendToUser(deleted.recipientId, {
          type: 'event',
          event: 'dm:messageDeleted',
          payload: {
            messageId: params.messageId,
            conversationKey: deleted.conversationKey,
          },
        });
        this.sendToUser(deleted.senderId, {
          type: 'event',
          event: 'dm:messageDeleted',
          payload: {
            messageId: params.messageId,
            conversationKey: deleted.conversationKey,
          },
        });
        return { deleted: true };
      }

      case 'dm:typing': {
        const params = DmTypingParamsSchema.parse(rawParams);
        this.sendToUser(params.recipientId, {
          type: 'event',
          event: 'dm:typing',
          payload: {
            fromUserId: peer.user.id,
            typing: params.typing,
          },
        });
        return { ok: true };
      }

      case 'dm:markRead': {
        const params = DmMarkReadParamsSchema.parse(rawParams);
        const { readAt } = await this.db.markDirectMessagesRead(peer.user.id, params.peerUserId);
        this.sendToUser(params.peerUserId, {
          type: 'event',
          event: 'dm:read',
          payload: {
            byUserId: peer.user.id,
            readAt,
          },
        });
        return { readAt };
      }

      // Moderation & Administration RPCs
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
          this.relaySessions.delete(params.streamId);
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

        this.relaySessions.delete(params.streamId);
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

  private updateInMemoryUserRecords(updatedUser: UserPublic): boolean {
    let touchedRoom = false;
    for (const peer of this.peers.values()) {
      if (peer.user.id === updatedUser.id) {
        peer.user = updatedUser;
        if (peer.roomId) touchedRoom = true;
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

    return touchedRoom;
  }

  public async syncUserRoleEverywhere(updatedUser: UserPublic): Promise<void> {
    const touchedRoom = this.updateInMemoryUserRecords(updatedUser);

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

    this.broadcastAll({
      type: 'event',
      event: 'user:profileUpdated',
      payload: { user: updatedUser },
    });

    if (touchedRoom) {
      await this.broadcastLobbyRoomsUpdate();
    }
    void this.notifyFriendsPresenceChanged(updatedUser.id, 'user:role_updated');
  }

  public async syncUserProfileEverywhere(updatedUser: UserPublic): Promise<void> {
    const touchedRoom = this.updateInMemoryUserRecords(updatedUser);

    this.broadcastAll({
      type: 'event',
      event: 'user:profileUpdated',
      payload: { user: updatedUser },
    });

    if (touchedRoom) {
      await this.broadcastLobbyRoomsUpdate();
    }
    void this.notifyFriendsPresenceChanged(updatedUser.id, 'user:profile_updated');
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
    this.roomNameCache.delete(roomId);
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
    this.relaySessions.clear();
  }
}
