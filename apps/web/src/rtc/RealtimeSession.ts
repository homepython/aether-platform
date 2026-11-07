import { Device, type types as mediasoupTypes } from 'mediasoup-client';
import {
  STREAM_RESOLUTION_SPECS,
  resolveTargetAudioBitrateKbps,
  resolveTargetBitrateKbps,
  type ActiveStreamInfo,
  type AudioIsolationMode,
  type AudioSettings,
  type ChatMessage,
  type ClientRpcMethod,
  type ClientRpcRequest,
  type DirectMessage,
  type FriendEntry,
  type IceServerConfig,
  type RoomJoinResult,
  type RoomParticipant,
  type RoomSummary,
  type ServerPushEvent,
  type ServerRpcResponse,
  type StreamConnectionMode,
  type StreamFps,
  type StreamPrivacyMode,
  type StreamResolution,
  type StreamWatchResult,
  type TransportCreatedResult,
  type TransportDirection,
  type TransportPlane,
} from '@aether/shared';
import { api, hasActiveMemoryToken } from '../api/httpClient.js';
import { audioEngine } from '../audio/AudioEngine.js';
import {
  getDesktopApi,
  isDesktopClient,
  type DesktopCaptureSourceItem,
} from '../bridge/DesktopBridge.js';

export type WatchedTransportMode = 'p2p' | 'sfu' | 'relay';

export interface WatchedStreamHandle {
  streamId: string;
  videoStream: MediaStream;
  transportMode: WatchedTransportMode;
  hasAudio: boolean;
  volume: number;
  muted: boolean;
  verifiedWidth: number;
  verifiedHeight: number;
  verifiedFps: number;
  verifiedBitrateKbps: number;
}

interface RelayViewerPipeline {
  mediaSource: MediaSource;
  objectUrl: string;
  videoEl: HTMLVideoElement;
  sourceBuffer: SourceBuffer | null;
  mimeType: string;
  initAppended: boolean;
  pendingInitBytes: Uint8Array | null;
  queue: Uint8Array[];
  bytesReceived: number;
  dispose: () => void;
}

interface InternalWatchedStream {
  streamId: string;
  streamInfo: ActiveStreamInfo;
  transportMode: WatchedTransportMode;
  videoConsumer: mediasoupTypes.Consumer | null;
  audioConsumer: mediasoupTypes.Consumer | null;
  p2pPc?: RTCPeerConnection | null;
  relay?: RelayViewerPipeline | null;
  zeroFrameWatchdogTimer: number | null;
  videoStream: MediaStream;
  statsTimer: number | null;
  lastBytesReceived: number;
  lastStatsTs: number;
  volume: number;
  muted: boolean;
}

interface P2pVoiceEntry {
  peerId: string;
  userId: string;
  pc: RTCPeerConnection;
  makingOffer: boolean;
}

interface ActiveRoomSessionParams {
  roomId: string;
  password?: string | null;
  audioSettings: AudioSettings;
  micMuted: boolean;
  deafened: boolean;
}

const RELAY_FRAME_VERSION = 1;
const RELAY_STREAM_ID_BYTES = 36;
const RELAY_HEADER_BYTES = 1 + RELAY_STREAM_ID_BYTES;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function findWebmClusterOffset(bytes: Uint8Array): number {
  // Matroska/WebM Cluster EBML Element ID = 0x1F 0x43 0xB6 0x75
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (
      bytes[i] === 0x1f &&
      bytes[i + 1] === 0x43 &&
      bytes[i + 2] === 0xb6 &&
      bytes[i + 3] === 0x75
    ) {
      return i;
    }
  }
  return -1;
}

function hasEbmlHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private roomSyncTimer: number | null = null;
  private consecutivePingFailures = 0;
  private intentionalClose = false;
  private rejoiningRoom = false;

  private pendingRpcs = new Map<
    string,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: number }
  >();

  private myPeerId = '';
  private inActiveRoom = false;
  private activeRoomSessionParams: ActiveRoomSessionParams | null = null;
  private lastWatchedStreamIdBeforeBlip: string | null = null;

  private mediaMode: 'sfu' | 'p2p' = 'sfu';
  private localMicTrack: MediaStreamTrack | null = null;
  private p2pVoicePeers = new Map<string, P2pVoiceEntry>();

  // Serialized WebRTC Signaling Queue + Pre-RemoteDescription ICE Candidate Buffer
  private p2pSignalChains = new Map<string, Promise<void>>();
  private pendingRemoteIceCandidates = new Map<string, RTCIceCandidateInit[]>();

  private p2pBroadcastTracks: {
    videoTrack: MediaStreamTrack;
    audioTrack: MediaStreamTrack | null;
    resolution: StreamResolution;
    targetBitrateKbps: number;
    audioBitrateKbps: number;
    fps: StreamFps;
    connectionMode: StreamConnectionMode;
    forceVp8: boolean;
  } | null = null;

  private p2pStreamSenders = new Map<string, RTCPeerConnection>(); // viewerPeerId -> RTCPeerConnection
  private p2pPendingWatchers = new Map<
    string,
    {
      pc: RTCPeerConnection;
      videoTrack: MediaStreamTrack | null;
      audioTrack: MediaStreamTrack | null;
      expectAudio: boolean;
      resolveTracks: (tracks: {
        videoTrack: MediaStreamTrack;
        audioTrack: MediaStreamTrack | null;
      }) => void;
    }
  >();

  // Broadcaster Cloud WSS Relay State
  private localRelayRecorder: MediaRecorder | null = null;
  private localRelayMimeType = 'video/webm;codecs=vp8,opus';

  private device: Device | null = null;
  private iceServers: IceServerConfig[] = [];
  private voiceSendTransport: mediasoupTypes.Transport | null = null;
  private voiceRecvTransport: mediasoupTypes.Transport | null = null;
  private streamSendTransport: mediasoupTypes.Transport | null = null;
  private streamRecvTransport: mediasoupTypes.Transport | null = null;

  private voiceProducer: mediasoupTypes.Producer | null = null;
  private remoteVoiceConsumers = new Map<string, mediasoupTypes.Consumer>(); // keyed by remote peerId

  // Local Broadcast State
  private localStreamId: string | null = null;
  private lastDesktopSource: DesktopCaptureSourceItem | null = null;
  private lastContentOptimization: 'detail' | 'motion' = 'motion';
  private lastStreamResolution: StreamResolution = '1080p';
  private lastStreamFps: StreamFps = 60;
  private localVideoProducer: mediasoupTypes.Producer | null = null;
  private localAudioProducer: mediasoupTypes.Producer | null = null;
  private localDisplayStream: MediaStream | null = null;
  private localNativeAudioCleanup: (() => void) | null = null;
  private localDesktopPcmUnsub: (() => void) | null = null;
  private localTelemetryTimer: number | null = null;
  private prevBytesSent = 0;
  private prevStatsTime = 0;
  private zeroCaptureChecks = 0;

  // Watched Remote Streams
  private watchedStreams = new Map<string, InternalWatchedStream>();

  // Event Callbacks wired into Zustand Store
  public onConnectionStatus?: (connected: boolean) => void;
  public onServerEvent?: (ev: ServerPushEvent) => void;
  public onWatchedStreamStats?: (
    streamId: string,
    stats: { width: number; height: number; fps: number; bitrateKbps: number }
  ) => void;
  public onWatchedStreamTransportChanged?: (
    streamId: string,
    videoStream: MediaStream,
    transportMode: WatchedTransportMode
  ) => void;
  public onCaptureDiagnostic?: (diag: { active: boolean; reason: string } | null) => void;
  public onLocalStreamEndedExternally?: () => void;

  private connectingWs = false;

  public isInActiveRoom(): boolean {
    return this.inActiveRoom;
  }

  public getLocalPeerId(): string {
    return this.myPeerId;
  }

  public updateStoredSessionRoomAudio(
    audioSettings: AudioSettings,
    micMuted: boolean,
    deafened: boolean
  ): void {
    if (this.activeRoomSessionParams) {
      this.activeRoomSessionParams = {
        ...this.activeRoomSessionParams,
        audioSettings,
        micMuted,
        deafened,
      };
    }
  }

  public connect(): void {
    if (!hasActiveMemoryToken()) return;
    this.intentionalClose = false;
    if (
      this.connectingWs ||
      (this.ws &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }
    void this.openAuthenticatedWebSocket();
  }

  private startSessionHeartbeatAndSyncLoops(): void {
    this.stopSessionHeartbeatAndSyncLoops();
    this.consecutivePingFailures = 0;

    // 20-second active client heartbeat prevents silent NAT/Cloudflare/Render idle socket drops
    this.pingTimer = window.setInterval(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        await this.rpc('ping', {}, 8000);
        this.consecutivePingFailures = 0;
      } catch {
        this.consecutivePingFailures++;
        if (this.consecutivePingFailures >= 2 && this.ws) {
          try {
            this.ws.close(4000, 'Heartbeat timeout');
          } catch {
            // ignore
          }
        }
      }
    }, 20_000);

    // 45-second authoritative room state reconciliation (eliminates ghost/missing users & stale streams over hours)
    this.roomSyncTimer = window.setInterval(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.activeRoomSessionParams) return;
      try {
        const sync = await this.rpc<{
          peerId: string;
          inRoom: boolean;
          room: RoomSummary | null;
          participants: RoomParticipant[];
          activeStreams: ActiveStreamInfo[];
        }>('room:syncState', {}, 10_000);

        if (sync.inRoom && sync.room) {
          this.myPeerId = sync.peerId;
          this.inActiveRoom = true;
          this.onServerEvent?.({
            type: 'event',
            event: 'room:stateSynced',
            payload: {
              roomId: sync.room.id,
              room: sync.room,
              participants: sync.participants,
              activeStreams: sync.activeStreams,
            },
          });
        } else if (this.activeRoomSessionParams && !this.rejoiningRoom) {
          // Server lost room membership without dropping WS -> seamlessly heal room membership!
          await this.rejoinActiveRoomAfterBlip();
        }
      } catch {
        // Ignore transient sync error
      }
    }, 45_000);
  }

  private stopSessionHeartbeatAndSyncLoops(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.roomSyncTimer !== null) {
      window.clearInterval(this.roomSyncTimer);
      this.roomSyncTimer = null;
    }
  }

  private async rejoinActiveRoomAfterBlip(): Promise<void> {
    if (this.rejoiningRoom || !this.activeRoomSessionParams || !isDesktopClient()) return;
    this.rejoiningRoom = true;
    const savedParams = { ...this.activeRoomSessionParams };
    const previouslyWatchedId = this.lastWatchedStreamIdBeforeBlip;

    try {
      const joinRes = await this.joinRoomAndSetupMedia(savedParams);
      this.onServerEvent?.({
        type: 'event',
        event: 'room:stateSynced',
        payload: {
          roomId: joinRes.room.id,
          room: joinRes.room,
          participants: joinRes.participants,
          activeStreams: joinRes.activeStreams,
        },
      });

      if (
        previouslyWatchedId &&
        joinRes.activeStreams.some((s) => s.streamId === previouslyWatchedId)
      ) {
        const rewatched = await this.watchStream(previouslyWatchedId).catch(() => null);
        if (rewatched) {
          this.onWatchedStreamTransportChanged?.(
            previouslyWatchedId,
            rewatched.videoStream,
            rewatched.transportMode
          );
        }
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'ROOM_NOT_FOUND' || code === 'ACCOUNT_BANNED' || code === 'INVALID_PASSWORD') {
        this.activeRoomSessionParams = null;
        this.lastWatchedStreamIdBeforeBlip = null;
      }
    } finally {
      this.rejoiningRoom = false;
    }
  }

  private async openAuthenticatedWebSocket(): Promise<void> {
    if (this.connectingWs || this.intentionalClose) return;
    this.connectingWs = true;

    try {
      const { wsUrl } = await api.createWsTicket();
      if (this.intentionalClose) {
        this.connectingWs = false;
        return;
      }

      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      this.ws = socket;

      socket.onopen = () => {
        this.connectingWs = false;
        this.onConnectionStatus?.(true);
        this.startSessionHeartbeatAndSyncLoops();

        // Refresh friends list automatically on every connection/reconnection
        void this.rpc<{ friends: FriendEntry[] }>('friends:list', {})
          .then(({ friends }) => {
            this.onServerEvent?.({
              type: 'event',
              event: 'friends:updated',
              payload: { friends, reason: 'ws:connected' },
            });
          })
          .catch(() => {});

        // Seamless Auto-Rejoin if user was inside a room when network blipped!
        if (this.activeRoomSessionParams) {
          void this.rejoinActiveRoomAfterBlip();
        }
      };

      socket.onerror = () => {
        this.connectingWs = false;
      };

      socket.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          this.handleIncomingBinaryRelayFrame(ev.data);
          return;
        }
        try {
          const msg = JSON.parse(String(ev.data)) as ServerRpcResponse | ServerPushEvent;
          if (msg.type === 'rpc:res') {
            const pending = this.pendingRpcs.get(msg.reqId);
            if (!pending) return;
            this.pendingRpcs.delete(msg.reqId);
            window.clearTimeout(pending.timer);
            if (msg.ok) {
              pending.resolve(msg.data);
            } else {
              const err = Object.assign(
                new Error(msg.error?.message || 'Erro de comunicação'),
                { code: msg.error?.code }
              );
              pending.reject(err);
            }
            return;
          }

          if (msg.type === 'event') {
            void this.handleInternalServerEvent(msg);
            this.onServerEvent?.(msg);
          }
        } catch (err) {
          console.error('[RealtimeSession] Erro ao processar pacote WS:', err);
        }
      };

      socket.onclose = (closeEv) => {
        this.connectingWs = false;
        this.stopSessionHeartbeatAndSyncLoops();
        this.onConnectionStatus?.(false);
        this.rejectAllPending('Conexão em tempo real encerrada');

        // Remember watched stream before tearing down media so auto-rejoin can seamlessly restore it
        const firstWatched = this.watchedStreams.keys().next().value as string | undefined;
        if (firstWatched) {
          this.lastWatchedStreamIdBeforeBlip = firstWatched;
        }

        // If closed due to duplicate session replacement (4009) or ban (4003), do not auto-rejoin room
        if (closeEv.code === 4009 || closeEv.code === 4003) {
          this.activeRoomSessionParams = null;
          this.lastWatchedStreamIdBeforeBlip = null;
        }

        this.teardownRoomMedia();
        if (!this.intentionalClose && closeEv.code !== 4003) {
          if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = window.setTimeout(() => this.connect(), 1800);
        }
      };
    } catch {
      this.connectingWs = false;
      if (!this.intentionalClose && hasActiveMemoryToken()) {
        if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => this.connect(), 2500);
      }
    }
  }

  public disconnect(): void {
    this.intentionalClose = true;
    this.activeRoomSessionParams = null;
    this.lastWatchedStreamIdBeforeBlip = null;
    this.stopSessionHeartbeatAndSyncLoops();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownRoomMedia();
    if (this.ws) {
      this.ws.close(1000, 'Logout');
      this.ws = null;
    }
  }

  public async rpc<T = unknown>(
    method: ClientRpcMethod,
    params?: unknown,
    timeoutMs = 15000
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Sem conexão em tempo real com o servidor');
    }
    const reqId = crypto.randomUUID();
    const payload: ClientRpcRequest = {
      type: 'rpc:req',
      reqId,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingRpcs.delete(reqId);
        reject(new Error(`Tempo limite excedido (${method})`));
      }, timeoutMs);

      this.pendingRpcs.set(reqId, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(payload));
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pendingRpcs) {
      window.clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pendingRpcs.clear();
  }

  private async handleInternalServerEvent(ev: ServerPushEvent): Promise<void> {
    if (ev.event === 'room:voiceProducerAvailable') {
      const { peerId, userId, producerId } = ev.payload;
      if (this.mediaMode === 'p2p' || producerId.startsWith('p2p-voice:')) {
        await this.ensureP2pVoicePeer(peerId, userId, this.myPeerId < peerId).catch((err) => {
          console.warn('[P2P Voice] Erro ao negociar voz remota:', err);
        });
      } else {
        await this.subscribeRemoteVoice(peerId, userId, producerId).catch((err) => {
          console.warn('[SFU] Erro ao assinar voz remota:', err);
        });
      }
    } else if (ev.event === 'room:voiceProducerClosed') {
      this.unsubscribeRemoteVoice(ev.payload.peerId);
    } else if (ev.event === 'room:participantLeft') {
      this.unsubscribeRemoteVoice(ev.payload.peerId);
      const senderPc = this.p2pStreamSenders.get(ev.payload.peerId);
      if (senderPc) {
        this.p2pStreamSenders.delete(ev.payload.peerId);
        senderPc.close();
      }
    } else if (ev.event === 'room:streamStopped') {
      if (this.lastWatchedStreamIdBeforeBlip === ev.payload.streamId) {
        this.lastWatchedStreamIdBeforeBlip = null;
      }
      this.cleanupWatchedStream(ev.payload.streamId);
    } else if (ev.event === 'p2p:viewerJoined') {
      await this.handleP2pViewerJoined(ev.payload.streamId, ev.payload.viewerPeerId).catch(
        (err) => {
          console.warn('[P2P Stream] Erro ao conectar espectador:', err);
        }
      );
    } else if (ev.event === 'p2p:viewerLeft') {
      const senderPc = this.p2pStreamSenders.get(ev.payload.viewerPeerId);
      if (senderPc) {
        this.p2pStreamSenders.delete(ev.payload.viewerPeerId);
        senderPc.close();
      }
    } else if (ev.event === 'p2p:signal') {
      this.enqueueP2pSignal(ev.payload);
    } else if (ev.event === 'stream:relayViewerNeeded') {
      if (this.localStreamId && ev.payload.streamId === this.localStreamId) {
        void this.startOrRefreshBroadcasterRelay(this.localStreamId);
      }
    } else if (ev.event === 'stream:relayReady') {
      const watched = this.watchedStreams.get(ev.payload.streamId);
      if (watched?.relay && ev.payload.base64Init) {
        const initBytes = base64ToBytes(ev.payload.base64Init);
        watched.relay.pendingInitBytes = initBytes;
        if (!watched.relay.initAppended) {
          watched.relay.queue.unshift(initBytes);
          watched.relay.initAppended = true;
          this.pumpRelaySourceBuffer(watched.relay);
        }
      }
    } else if (ev.event === 'admin:kickedFromRoom' || ev.event === 'admin:accountBanned') {
      this.activeRoomSessionParams = null;
      this.lastWatchedStreamIdBeforeBlip = null;
    }
  }

  private enqueueP2pSignal(payload: {
    fromPeerId: string;
    fromUserId: string;
    plane: 'voice' | 'stream';
    streamId?: string;
    description?: unknown;
    candidate?: unknown;
  }): void {
    const key =
      payload.plane === 'voice'
        ? `voice:${payload.fromPeerId}`
        : `stream:${payload.streamId || ''}:${payload.fromPeerId}`;

    const prev = this.p2pSignalChains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.handleP2pSignalOrdered(key, payload))
      .catch((err) => {
        console.warn('[P2P Signal] Aviso na negociação WebRTC:', err);
      });
    this.p2pSignalChains.set(key, next);
  }

  private async flushBufferedRemoteIceCandidates(
    key: string,
    pc: RTCPeerConnection
  ): Promise<void> {
    const queued = this.pendingRemoteIceCandidates.get(key);
    if (!queued || queued.length === 0) return;
    this.pendingRemoteIceCandidates.delete(key);
    for (const cand of queued) {
      await pc.addIceCandidate(cand).catch(() => {});
    }
  }

  private enhanceOpusStereoSdp(sdp: string, maxBitrateBps: number): string {
    return sdp.replace(/a=fmtp:(\d+) (.*minptime=10.*)/g, (_match, pt, rest) => {
      if (maxBitrateBps >= 128000) {
        return `a=fmtp:${pt} ${rest};stereo=1;sprop-stereo=1;maxaveragebitrate=${maxBitrateBps};usedtx=0;cbr=1`;
      }
      return `a=fmtp:${pt} ${rest};maxaveragebitrate=${maxBitrateBps};usedtx=0;useinbandfec=1`;
    });
  }

  private async ensureP2pVoicePeer(
    remotePeerId: string,
    remoteUserId: string,
    shouldOffer: boolean
  ): Promise<RTCPeerConnection> {
    let entry = this.p2pVoicePeers.get(remotePeerId);
    if (!entry) {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
      entry = { peerId: remotePeerId, userId: remoteUserId, pc, makingOffer: false };
      this.p2pVoicePeers.set(remotePeerId, entry);

      if (this.localMicTrack && this.localMicTrack.readyState === 'live') {
        pc.addTrack(this.localMicTrack);
      } else {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      pc.onicecandidate = (iceEv) => {
        if (iceEv.candidate && this.ws?.readyState === WebSocket.OPEN) {
          void this.rpc('p2p:signal', {
            targetPeerId: remotePeerId,
            plane: 'voice',
            candidate: iceEv.candidate.toJSON(),
          }).catch(() => {});
        }
      };

      pc.ontrack = (trackEv) => {
        if (trackEv.track.kind === 'audio') {
          void audioEngine.attachRemotePeerVoice(remotePeerId, remoteUserId, trackEv.track);
        }
      };
    }

    if (shouldOffer && entry.pc.signalingState === 'stable') {
      try {
        entry.makingOffer = true;
        const offer = await entry.pc.createOffer();
        const enhancedSdp = offer.sdp ? this.enhanceOpusStereoSdp(offer.sdp, 96000) : offer.sdp;
        await entry.pc.setLocalDescription({ type: offer.type, sdp: enhancedSdp });
        await this.rpc('p2p:signal', {
          targetPeerId: remotePeerId,
          plane: 'voice',
          description: entry.pc.localDescription,
        });
      } finally {
        entry.makingOffer = false;
      }
    }

    return entry.pc;
  }

  /**
   * Universal Anti-Black-Screen Video Codec Ranking:
   * - Constrained Baseline H.264 (42e01f) is ranked #1 because it is 100% hardware-accelerated on
   *   NVIDIA NVENC, AMD Radeon AMF, Intel QuickSync AND 100% compatible with OpenH264 software fallback!
   *   (Previously ranking High Profile 6400 #1 caused 0-frame black streams on AMD/Intel/OpenH264!)
   * - VP8 is ranked #2 (or #1 in 'compatibility' / watchdog recovery mode) for 100% guaranteed frames on every GPU.
   */
  private applyHardwareVideoCodecPreferences(
    pc: RTCPeerConnection,
    sender: RTCRtpSender,
    connectionMode: StreamConnectionMode = 'auto',
    forceVp8 = false
  ): void {
    try {
      if (
        typeof RTCRtpSender === 'undefined' ||
        typeof RTCRtpSender.getCapabilities !== 'function'
      ) {
        return;
      }
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps?.codecs?.length) return;

      const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
      if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;

      const scoreCodec = (c: RTCRtpCodec): number => {
        const mime = c.mimeType.toLowerCase();
        const fmtp = (c.sdpFmtpLine || '').toLowerCase();

        if (forceVp8 || connectionMode === 'compatibility') {
          if (mime === 'video/vp8') return 1;
          if (mime === 'video/h264' && fmtp.includes('profile-level-id=42e0')) return 2;
          if (mime === 'video/h264') return 5;
          if (mime === 'video/vp9') return 10;
          if (mime === 'video/av1') return 15;
          return 40;
        }

        if (mime === 'video/h264') {
          // Constrained Baseline 42e01f works across 100% of NVENC, AMF, QSV & OpenH264
          if (fmtp.includes('profile-level-id=42e0') && fmtp.includes('packetization-mode=1')) {
            return 1;
          }
          if (fmtp.includes('profile-level-id=42e0')) return 2;
          if (connectionMode === 'quality' && fmtp.includes('profile-level-id=6400')) return 3;
          if (fmtp.includes('packetization-mode=1')) return 6;
          return 8;
        }
        if (mime === 'video/vp8') return 4;
        if (mime === 'video/vp9') return 12;
        if (mime === 'video/av1') return 16;
        // Keep RTX / RED / ULPFEC / FlexFEC intact for zero-glitch packet recovery
        return 40;
      };

      const ordered = [...caps.codecs].sort((a, b) => scoreCodec(a) - scoreCodec(b));
      transceiver.setCodecPreferences(ordered);
    } catch {
      // Non-fatal if driver rejects custom codec order
    }
  }

  private resolveDegradationPreference(
    connectionMode: StreamConnectionMode,
    fps: StreamFps
  ): RTCDegradationPreference {
    // Prevent 1-FPS collapse during heavy DX12 games (e.g., Fortnite on RTX 2060)!
    // Only lock 'maintain-resolution' when user explicitly chooses 'quality' or 5 FPS 'presentation'.
    if (connectionMode === 'quality' || fps === 5) {
      return 'maintain-resolution';
    }
    return 'maintain-framerate';
  }

  private async handleP2pViewerJoined(streamId: string, viewerPeerId: string): Promise<void> {
    if (this.localStreamId !== streamId || !this.p2pBroadcastTracks) return;
    const prev = this.p2pStreamSenders.get(viewerPeerId);
    if (prev) prev.close();

    const state = this.p2pBroadcastTracks;
    const { videoTrack, audioTrack, targetBitrateKbps, audioBitrateKbps, fps, connectionMode } =
      state;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    this.p2pStreamSenders.set(viewerPeerId, pc);

    pc.onicecandidate = (iceEv) => {
      if (iceEv.candidate && this.ws?.readyState === WebSocket.OPEN) {
        void this.rpc('p2p:signal', {
          targetPeerId: viewerPeerId,
          plane: 'stream',
          streamId,
          candidate: iceEv.candidate.toJSON(),
        }).catch(() => {});
      }
    };

    const videoSender = pc.addTrack(videoTrack);
    this.applyHardwareVideoCodecPreferences(pc, videoSender, connectionMode, state.forceVp8);

    const vParams = videoSender.getParameters();
    vParams.degradationPreference = this.resolveDegradationPreference(connectionMode, fps);
    if (!vParams.encodings || vParams.encodings.length === 0) {
      vParams.encodings = [{}];
    }
    vParams.encodings[0].maxBitrate = targetBitrateKbps * 1000;
    vParams.encodings[0].maxFramerate = fps;
    vParams.encodings[0].scaleResolutionDownBy = 1.0;
    (
      vParams.encodings[0] as RTCRtpEncodingParameters & {
        priority?: string;
        networkPriority?: string;
      }
    ).priority = 'high';
    (
      vParams.encodings[0] as RTCRtpEncodingParameters & {
        priority?: string;
        networkPriority?: string;
      }
    ).networkPriority = 'high';
    void videoSender.setParameters(vParams).catch(() => {});

    const audioBps = Math.max(32000, Math.min(510000, audioBitrateKbps * 1000));
    if (audioTrack && audioTrack.readyState === 'live') {
      const audioSender = pc.addTrack(audioTrack);
      const aParams = audioSender.getParameters();
      if (!aParams.encodings || aParams.encodings.length === 0) {
        aParams.encodings = [{}];
      }
      aParams.encodings[0].maxBitrate = audioBps;
      void audioSender.setParameters(aParams).catch(() => {});
    }

    const offer = await pc.createOffer();
    const enhancedSdp = offer.sdp ? this.enhanceOpusStereoSdp(offer.sdp, audioBps) : offer.sdp;
    await pc.setLocalDescription({ type: offer.type, sdp: enhancedSdp });
    await this.rpc('p2p:signal', {
      targetPeerId: viewerPeerId,
      plane: 'stream',
      streamId,
      description: pc.localDescription,
    });

    // 2.2-Second Broadcaster Hardware Encoder Watchdog:
    // If GPU H.264 encoder stalls with 0 encoded frames (broken driver / AMF / OpenH264 issue),
    // automatically hot-fallback to universal VP8 and renegotiate without interrupting the broadcast!
    if (!state.forceVp8) {
      window.setTimeout(async () => {
        if (this.localStreamId !== streamId || this.p2pStreamSenders.get(viewerPeerId) !== pc) {
          return;
        }
        if (pc.connectionState === 'closed' || videoTrack.readyState !== 'live') return;
        try {
          const stats = await pc.getStats();
          let framesEncoded = 0;
          stats.forEach((s) => {
            if (s.type === 'outbound-rtp' && s.kind === 'video') {
              framesEncoded += s.framesEncoded || 0;
            }
          });
          if (framesEncoded === 0 && pc.signalingState === 'stable') {
            console.warn(
              '[Stream Watchdog] Codificador H.264 gerou 0 quadros em 2.2s; alternando automaticamente para VP8 universal!'
            );
            state.forceVp8 = true;
            this.applyHardwareVideoCodecPreferences(pc, videoSender, connectionMode, true);
            const reOffer = await pc.createOffer();
            const reSdp = reOffer.sdp
              ? this.enhanceOpusStereoSdp(reOffer.sdp, audioBps)
              : reOffer.sdp;
            await pc.setLocalDescription({ type: reOffer.type, sdp: reSdp });
            await this.rpc('p2p:signal', {
              targetPeerId: viewerPeerId,
              plane: 'stream',
              streamId,
              description: pc.localDescription,
            });
          }
        } catch {
          // Ignore watchdog renegotiation error
        }
      }, 2200);
    }
  }

  private async handleP2pSignalOrdered(
    signalKey: string,
    payload: {
      fromPeerId: string;
      fromUserId: string;
      plane: 'voice' | 'stream';
      streamId?: string;
      description?: unknown;
      candidate?: unknown;
    }
  ): Promise<void> {
    if (payload.plane === 'voice') {
      const pc = await this.ensureP2pVoicePeer(payload.fromPeerId, payload.fromUserId, false);
      const entry = this.p2pVoicePeers.get(payload.fromPeerId)!;
      const polite = this.myPeerId < payload.fromPeerId;

      if (payload.description) {
        const desc = payload.description as RTCSessionDescriptionInit;
        const offerCollision =
          desc.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
        if (offerCollision && !polite) {
          return;
        }
        await pc.setRemoteDescription(desc);
        await this.flushBufferedRemoteIceCandidates(signalKey, pc);

        if (desc.type === 'offer') {
          const answer = await pc.createAnswer();
          const enhancedSdp = answer.sdp ? this.enhanceOpusStereoSdp(answer.sdp, 96000) : answer.sdp;
          await pc.setLocalDescription({ type: answer.type, sdp: enhancedSdp });
          await this.rpc('p2p:signal', {
            targetPeerId: payload.fromPeerId,
            plane: 'voice',
            description: pc.localDescription,
          });
        }
      } else if (payload.candidate) {
        const cand = payload.candidate as RTCIceCandidateInit;
        if (!pc.remoteDescription) {
          const list = this.pendingRemoteIceCandidates.get(signalKey) || [];
          list.push(cand);
          this.pendingRemoteIceCandidates.set(signalKey, list);
        } else {
          await pc.addIceCandidate(cand).catch(() => {});
        }
      }
      return;
    }

    // Stream plane signaling (broadcaster <-> viewer)
    const streamId = payload.streamId || '';
    const senderPc = this.p2pStreamSenders.get(payload.fromPeerId);
    if (senderPc && this.localStreamId === streamId) {
      if (payload.description) {
        await senderPc.setRemoteDescription(payload.description as RTCSessionDescriptionInit);
        await this.flushBufferedRemoteIceCandidates(signalKey, senderPc);
      } else if (payload.candidate) {
        const cand = payload.candidate as RTCIceCandidateInit;
        if (!senderPc.remoteDescription) {
          const list = this.pendingRemoteIceCandidates.get(signalKey) || [];
          list.push(cand);
          this.pendingRemoteIceCandidates.set(signalKey, list);
        } else {
          await senderPc.addIceCandidate(cand).catch(() => {});
        }
      }
      return;
    }

    const pendingWatch = this.p2pPendingWatchers.get(streamId);
    const activeWatch = this.watchedStreams.get(streamId);
    const viewerPc = pendingWatch?.pc || activeWatch?.p2pPc;
    if (!viewerPc) {
      // Candidate arrived slightly before watchStream registered viewerPc -> buffer it!
      if (payload.candidate) {
        const list = this.pendingRemoteIceCandidates.get(signalKey) || [];
        list.push(payload.candidate as RTCIceCandidateInit);
        this.pendingRemoteIceCandidates.set(signalKey, list);
      }
      return;
    }

    if (payload.description) {
      const desc = payload.description as RTCSessionDescriptionInit;
      await viewerPc.setRemoteDescription(desc);
      await this.flushBufferedRemoteIceCandidates(signalKey, viewerPc);

      if (desc.type === 'offer') {
        const answer = await viewerPc.createAnswer();
        const enhancedSdp = answer.sdp ? this.enhanceOpusStereoSdp(answer.sdp, 320000) : answer.sdp;
        await viewerPc.setLocalDescription({ type: answer.type, sdp: enhancedSdp });
        await this.rpc('p2p:signal', {
          targetPeerId: payload.fromPeerId,
          plane: 'stream',
          streamId,
          description: viewerPc.localDescription,
        });
      }
    } else if (payload.candidate) {
      const cand = payload.candidate as RTCIceCandidateInit;
      if (!viewerPc.remoteDescription) {
        const list = this.pendingRemoteIceCandidates.get(signalKey) || [];
        list.push(cand);
        this.pendingRemoteIceCandidates.set(signalKey, list);
      } else {
        await viewerPc.addIceCandidate(cand).catch(() => {});
      }
    }
  }

  // =========================================================================
  // CLOUD WSS BINARY MEDIA RELAY (100% Anti-Black-Screen Fallback over TCP/TLS)
  // =========================================================================

  private async startOrRefreshBroadcasterRelay(streamId: string): Promise<void> {
    if (this.localStreamId !== streamId) return;
    const videoTrack =
      this.p2pBroadcastTracks?.videoTrack || this.localDisplayStream?.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') return;

    const audioTrack =
      this.p2pBroadcastTracks?.audioTrack || this.localAudioProducer?.track || null;
    const targetBitrateKbps = this.p2pBroadcastTracks?.targetBitrateKbps || 6000;
    const audioBitrateKbps = this.p2pBroadcastTracks?.audioBitrateKbps || 192;

    this.stopBroadcasterRelayLocally();

    const tracks: MediaStreamTrack[] = [videoTrack];
    const hasLiveAudio = Boolean(audioTrack && audioTrack.readyState === 'live');
    if (hasLiveAudio && audioTrack) {
      tracks.push(audioTrack);
    }

    const candidates = hasLiveAudio
      ? ['video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp8', 'video/webm'];
    const chosenMime =
      candidates.find(
        (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
      ) || 'video/webm';

    this.localRelayMimeType = chosenMime;
    const relayStream = new MediaStream(tracks);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(relayStream, {
        mimeType: chosenMime,
        videoBitsPerSecond: Math.max(600_000, Math.min(targetBitrateKbps * 1000, 9_000_000)),
        audioBitsPerSecond: hasLiveAudio
          ? Math.max(64_000, Math.min(audioBitrateKbps * 1000, 256_000))
          : undefined,
      });
    } catch (err) {
      console.warn('[Cloud Relay] MediaRecorder indisponível:', err);
      return;
    }

    this.localRelayRecorder = recorder;
    await this.rpc('stream:relayStart', { streamId, mimeType: chosenMime }).catch(() => {});

    let initSent = false;
    const streamIdAscii = new Uint8Array(RELAY_STREAM_ID_BYTES);
    for (let i = 0; i < RELAY_STREAM_ID_BYTES; i++) {
      streamIdAscii[i] = streamId.charCodeAt(i) || 0x20;
    }

    recorder.ondataavailable = async (ev) => {
      if (this.localRelayRecorder !== recorder || this.localStreamId !== streamId) return;
      if (!ev.data || ev.data.size === 0) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const buf = await ev.data.arrayBuffer();
      const chunk = new Uint8Array(buf);

      // Extract & cache WebM Initialization Segment (EBML Header + Tracks before first Cluster)
      if (!initSent && hasEbmlHeader(chunk)) {
        const clusterOffset = findWebmClusterOffset(chunk);
        if (clusterOffset > 0) {
          initSent = true;
          const initSlice = chunk.subarray(0, clusterOffset);
          void this.rpc('stream:relayInitSegment', {
            streamId,
            base64Init: bytesToBase64(initSlice),
          }).catch(() => {});
        }
      }

      // Backpressure guard on broadcaster WS
      if (this.ws.bufferedAmount > 4 * 1024 * 1024) return;

      const frame = new Uint8Array(RELAY_HEADER_BYTES + chunk.length);
      frame[0] = RELAY_FRAME_VERSION;
      frame.set(streamIdAscii, 1);
      frame.set(chunk, RELAY_HEADER_BYTES);
      this.ws.send(frame.buffer);
    };

    recorder.start(120); // 120ms ultra-low-latency streaming intervals
  }

  private stopBroadcasterRelayLocally(): void {
    if (this.localRelayRecorder) {
      const rec = this.localRelayRecorder;
      this.localRelayRecorder = null;
      rec.ondataavailable = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        // Ignore
      }
    }
  }

  private handleIncomingBinaryRelayFrame(rawBuffer: ArrayBuffer): void {
    const view = new Uint8Array(rawBuffer);
    if (view.length <= RELAY_HEADER_BYTES || view[0] !== RELAY_FRAME_VERSION) return;

    let streamId = '';
    for (let i = 1; i < RELAY_HEADER_BYTES; i++) {
      streamId += String.fromCharCode(view[i]);
    }
    streamId = streamId.trim();

    const entry = this.watchedStreams.get(streamId);
    if (!entry?.relay) return;

    const chunk = view.slice(RELAY_HEADER_BYTES);
    entry.relay.bytesReceived += chunk.byteLength;

    if (!entry.relay.initAppended) {
      if (hasEbmlHeader(chunk)) {
        entry.relay.initAppended = true;
      } else if (entry.relay.pendingInitBytes) {
        entry.relay.queue.push(entry.relay.pendingInitBytes);
        entry.relay.initAppended = true;
      } else {
        // Wait for init segment (`stream:relayReady`) or restarted EBML header
        return;
      }
    }

    // Bound queue length so slow tab never accumulates stale video
    if (entry.relay.queue.length > 35) {
      entry.relay.queue.splice(1, entry.relay.queue.length - 12);
    }

    entry.relay.queue.push(chunk);
    this.pumpRelaySourceBuffer(entry.relay);
  }

  private pumpRelaySourceBuffer(relay: RelayViewerPipeline): void {
    const sb = relay.sourceBuffer;
    if (!sb || sb.updating || relay.mediaSource.readyState !== 'open') return;
    const next = relay.queue.shift();
    if (!next) return;

    try {
      sb.appendBuffer(next as BufferSource);
    } catch {
      // Recover if SourceBuffer quota or timestamp hiccup occurs
      relay.queue.length = 0;
    }
  }

  private async watchStreamViaRelay(
    streamId: string,
    knownStream?: ActiveStreamInfo,
    preserveVolume?: { volume: number; muted: boolean }
  ): Promise<{
    stream: ActiveStreamInfo;
    videoStream: MediaStream;
    transportMode: WatchedTransportMode;
    hasAudio: boolean;
  }> {
    const relayRes = await this.rpc<{
      ok: boolean;
      active: boolean;
      mimeType: string;
      base64Init: string | null;
    }>('stream:relayWatch', { streamId });

    const streamInfo: ActiveStreamInfo =
      knownStream ||
      ({
        streamId,
        roomId: this.activeRoomSessionParams?.roomId || '',
        broadcasterId: '',
        broadcasterUsername: '',
        broadcasterDisplayName: 'Transmissão ao Vivo',
        broadcasterAvatarColor: '#6366f1',
        broadcasterAvatarUrl: null,
        broadcasterRole: 'member',
        title: 'Transmissão ao Vivo',
        resolution: '1080p',
        fps: 60,
        targetBitrateKbps: 6000,
        audioBitrateKbps: 192,
        privacy: 'public',
        viewerLimit: null,
        connectionMode: 'compatibility',
        relayActive: true,
        hasAudio: relayRes.mimeType.includes('opus'),
        audioIsolationMode: 'process-isolated',
        startedAt: new Date().toISOString(),
        viewerCount: 1,
        viewerUsers: [],
        videoProducerId: `relay:${streamId}`,
        audioProducerId: null,
      } satisfies ActiveStreamInfo);

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);

    // Off-DOM 1x1 live decode surface (prevents Chromium hidden-element frame suspension)
    const videoEl = document.createElement('video');
    videoEl.playsInline = true;
    videoEl.autoplay = true;
    videoEl.style.position = 'fixed';
    videoEl.style.width = '2px';
    videoEl.style.height = '2px';
    videoEl.style.left = '-10px';
    videoEl.style.top = '-10px';
    videoEl.style.opacity = '0.001';
    videoEl.style.pointerEvents = 'none';
    document.body.appendChild(videoEl);
    videoEl.src = objectUrl;

    const initialVol = preserveVolume?.volume ?? 100;
    const initialMuted = preserveVolume?.muted ?? false;

    const hasAudio = Boolean(streamInfo.hasAudio || relayRes.mimeType.includes('opus'));
    if (hasAudio) {
      await audioEngine.attachStreamMediaElement(streamId, videoEl, initialVol);
      if (initialMuted) {
        audioEngine.setStreamVolume(streamId, initialVol, true);
      }
    } else {
      videoEl.muted = true;
    }

    const relayPipeline: RelayViewerPipeline = {
      mediaSource,
      objectUrl,
      videoEl,
      sourceBuffer: null,
      mimeType: relayRes.mimeType || 'video/webm;codecs=vp8,opus',
      initAppended: false,
      pendingInitBytes: relayRes.base64Init ? base64ToBytes(relayRes.base64Init) : null,
      queue: [],
      bytesReceived: 0,
      dispose: () => {
        try {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.load();
          videoEl.remove();
        } catch {
          // ignore
        }
        URL.revokeObjectURL(objectUrl);
      },
    };

    mediaSource.addEventListener(
      'sourceopen',
      () => {
        try {
          const mime = MediaSource.isTypeSupported(relayPipeline.mimeType)
            ? relayPipeline.mimeType
            : 'video/webm;codecs=vp8';
          const sb = mediaSource.addSourceBuffer(mime);
          sb.mode = 'sequence';
          relayPipeline.sourceBuffer = sb;

          sb.addEventListener('updateend', () => {
            try {
              if (!sb.updating && videoEl.buffered.length > 0) {
                const end = videoEl.buffered.end(videoEl.buffered.length - 1);
                if (end - videoEl.currentTime > 0.6) {
                  videoEl.currentTime = Math.max(0, end - 0.16);
                }
                if (end > 12 && videoEl.currentTime > 7) {
                  sb.remove(0, videoEl.currentTime - 4);
                  return;
                }
              }
            } catch {
              // ignore buffer trim race
            }
            this.pumpRelaySourceBuffer(relayPipeline);
          });

          if (relayPipeline.pendingInitBytes && !relayPipeline.initAppended) {
            relayPipeline.queue.unshift(relayPipeline.pendingInitBytes);
            relayPipeline.initAppended = true;
          }
          this.pumpRelaySourceBuffer(relayPipeline);
        } catch (err) {
          console.warn('[Cloud Relay] Erro ao inicializar SourceBuffer:', err);
        }
      },
      { once: true }
    );

    void videoEl.play().catch(() => {});

    const anyVideo = videoEl as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const capturedStream =
      typeof anyVideo.captureStream === 'function'
        ? anyVideo.captureStream()
        : typeof anyVideo.mozCaptureStream === 'function'
          ? anyVideo.mozCaptureStream()
          : new MediaStream();

    const entry: InternalWatchedStream = {
      streamId,
      streamInfo,
      transportMode: 'relay',
      videoConsumer: null,
      audioConsumer: null,
      p2pPc: null,
      relay: relayPipeline,
      zeroFrameWatchdogTimer: null,
      videoStream: capturedStream,
      statsTimer: null,
      lastBytesReceived: 0,
      lastStatsTs: performance.now(),
      volume: initialVol,
      muted: initialMuted,
    };

    entry.statsTimer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.max(0.2, (now - entry.lastStatsTs) / 1000);
      const bytesReceived = relayPipeline.bytesReceived;
      const bitrateKbps =
        entry.lastBytesReceived > 0
          ? Math.max(0, ((bytesReceived - entry.lastBytesReceived) * 8) / 1000 / dt)
          : 0;
      entry.lastBytesReceived = bytesReceived;
      entry.lastStatsTs = now;

      this.onWatchedStreamStats?.(streamId, {
        width: videoEl.videoWidth || streamInfo.verifiedWidth || 0,
        height: videoEl.videoHeight || streamInfo.verifiedHeight || 0,
        fps: streamInfo.fps,
        bitrateKbps: Math.round(bitrateKbps),
      });
    }, 1000);

    this.watchedStreams.set(streamId, entry);
    this.lastWatchedStreamIdBeforeBlip = streamId;

    // Ensure Stage re-attaches when first decoded video track populates captureStream()
    videoEl.addEventListener(
      'loadeddata',
      () => {
        void videoEl.play().catch(() => {});
        const refreshed =
          typeof anyVideo.captureStream === 'function' ? anyVideo.captureStream() : capturedStream;
        entry.videoStream = refreshed;
        this.onWatchedStreamTransportChanged?.(streamId, refreshed, 'relay');
      },
      { once: true }
    );

    return {
      stream: streamInfo,
      videoStream: capturedStream,
      transportMode: 'relay',
      hasAudio,
    };
  }

  public async switchWatchedStreamTransport(
    streamId: string,
    targetMode: 'p2p' | 'relay'
  ): Promise<void> {
    const current = this.watchedStreams.get(streamId);
    const knownStream = current?.streamInfo;
    const preserveVolume = current
      ? { volume: current.volume, muted: current.muted }
      : { volume: 100, muted: false };

    this.cleanupWatchedStream(streamId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (targetMode === 'relay') {
        await this.rpc('p2p:streamUnwatch', { streamId }).catch(() => {});
        const res = await this.watchStreamViaRelay(streamId, knownStream, preserveVolume);
        this.onWatchedStreamTransportChanged?.(streamId, res.videoStream, 'relay');
      } else {
        await this.rpc('stream:relayUnwatch', { streamId }).catch(() => {});
        const res = await this.watchStream(streamId, 'p2p');
        audioEngine.setStreamVolume(streamId, preserveVolume.volume, preserveVolume.muted);
        this.onWatchedStreamTransportChanged?.(streamId, res.videoStream, res.transportMode);
      }
    }
  }

  // =========================================================================
  // ROOM LIFECYCLE & VOICE/STREAM MEDIA
  // =========================================================================

  public async joinRoomAndSetupMedia(params: {
    roomId: string;
    password?: string | null;
    audioSettings: AudioSettings;
    micMuted: boolean;
    deafened: boolean;
  }): Promise<RoomJoinResult> {
    if (!isDesktopClient()) {
      throw new Error(
        'Salas de voz e transmissões ao vivo são exclusivas do Aplicativo Desktop Aether.'
      );
    }
    await audioEngine.resumeContexts();
    this.teardownRoomMedia();

    const joinRes = await this.rpc<RoomJoinResult>('room:join', {
      roomId: params.roomId,
      password: params.password ?? null,
      clientPlatform: isDesktopClient() ? 'desktop' : 'web',
      micMuted: params.micMuted,
      deafened: params.deafened,
    });

    this.myPeerId = joinRes.peerId;
    this.inActiveRoom = true;
    this.activeRoomSessionParams = { ...params };
    this.mediaMode = joinRes.mediaMode ?? 'sfu';
    this.iceServers = joinRes.iceServers;

    if (this.mediaMode === 'p2p') {
      try {
        this.localMicTrack = await audioEngine.startMicrophone(params.audioSettings);
        audioEngine.setLocalMuteAndDeafen(params.micMuted, params.deafened);
      } catch (micErr) {
        this.localMicTrack = null;
        console.warn(
          '[Audio] Microfone indisponível ou permissão negada (modo escuta ativo):',
          micErr
        );
      }

      await this.rpc('p2p:voiceReady', { active: true }).catch(() => {});

      for (const part of joinRes.participants) {
        if (part.peerId !== joinRes.peerId) {
          await this.ensureP2pVoicePeer(part.peerId, part.user.id, true).catch((err) => {
            console.warn('[P2P Voice] Falha ao conectar participante existente:', err);
          });
        }
      }

      return joinRes;
    }

    this.device = new Device();
    await this.device.load({
      routerRtpCapabilities: joinRes.routerRtpCapabilities as mediasoupTypes.RtpCapabilities,
    });

    this.voiceRecvTransport = await this.initClientTransport('voice', 'recv');
    this.voiceSendTransport = await this.initClientTransport('voice', 'send');

    for (const part of joinRes.participants) {
      if (part.peerId !== joinRes.peerId && part.voiceProducerId) {
        await this.subscribeRemoteVoice(part.peerId, part.user.id, part.voiceProducerId).catch(
          (err) => {
            console.warn('[SFU] Falha ao consumir participante existente:', err);
          }
        );
      }
    }

    try {
      const micTrack = await audioEngine.startMicrophone(params.audioSettings);
      this.localMicTrack = micTrack;
      audioEngine.setLocalMuteAndDeafen(params.micMuted, params.deafened);
      this.voiceProducer = await this.voiceSendTransport.produce({
        track: micTrack,
        stopTracks: false,
        codecOptions: {
          opusStereo: false,
          opusFec: true,
          opusDtx: false,
          opusMaxAverageBitrate: 96000,
          opusPtime: 10,
        },
      });
    } catch (micErr) {
      console.warn(
        '[Audio] Microfone indisponível ou permissão negada (modo escuta ativo):',
        micErr
      );
    }

    return joinRes;
  }

  public async leaveRoom(): Promise<void> {
    this.activeRoomSessionParams = null;
    this.lastWatchedStreamIdBeforeBlip = null;
    this.teardownRoomMedia();
    if (this.ws?.readyState === WebSocket.OPEN) {
      await this.rpc('room:leave', {}).catch(() => {});
    }
  }

  private async initClientTransport(
    plane: TransportPlane,
    direction: TransportDirection
  ): Promise<mediasoupTypes.Transport> {
    if (!this.device) throw new Error('Dispositivo SFU não inicializado');

    const transportInfo = await this.rpc<TransportCreatedResult>('sfu:createTransport', {
      plane,
      direction,
    });

    const baseOpts = {
      id: transportInfo.id,
      iceParameters: transportInfo.iceParameters as mediasoupTypes.IceParameters,
      iceCandidates: transportInfo.iceCandidates as mediasoupTypes.IceCandidate[],
      dtlsParameters: transportInfo.dtlsParameters as mediasoupTypes.DtlsParameters,
      iceServers: this.iceServers as RTCIceServer[],
    };

    const transport =
      direction === 'send'
        ? this.device.createSendTransport(baseOpts)
        : this.device.createRecvTransport(baseOpts);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.rpc('sfu:connectTransport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch((err) => errback(err instanceof Error ? err : new Error(String(err))));
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
        if (plane === 'voice') {
          this.rpc<{ producerId: string }>('sfu:produceVoice', {
            transportId: transport.id,
            rtpParameters,
          })
            .then(({ producerId }) => callback({ id: producerId }))
            .catch((err) => errback(err instanceof Error ? err : new Error(String(err))));
        } else {
          this.rpc<{ producerId: string }>('sfu:produceStreamTrack', {
            transportId: transport.id,
            kind,
            rtpParameters,
          })
            .then(({ producerId }) => callback({ id: producerId }))
            .catch((err) => errback(err instanceof Error ? err : new Error(String(err))));
        }
      });
    }

    return transport;
  }

  private async subscribeRemoteVoice(
    peerId: string,
    userId: string,
    producerId: string
  ): Promise<void> {
    if (!this.device || !this.voiceRecvTransport) return;
    this.unsubscribeRemoteVoice(peerId);

    const res = await this.rpc<{
      id: string;
      producerId: string;
      kind: 'audio';
      rtpParameters: mediasoupTypes.RtpParameters;
    }>('sfu:consumeVoice', {
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    const consumer = await this.voiceRecvTransport.consume({
      id: res.id,
      producerId: res.producerId,
      kind: 'audio',
      rtpParameters: res.rtpParameters,
    });

    this.remoteVoiceConsumers.set(peerId, consumer);
    await audioEngine.attachRemotePeerVoice(peerId, userId, consumer.track);
    await this.rpc('sfu:resumeConsumer', { consumerId: consumer.id }).catch(() => {});
  }

  private unsubscribeRemoteVoice(peerId: string): void {
    const existing = this.remoteVoiceConsumers.get(peerId);
    if (existing) {
      this.remoteVoiceConsumers.delete(peerId);
      try {
        existing.close();
      } catch {
        // Ignore
      }
    }
    const p2pEntry = this.p2pVoicePeers.get(peerId);
    if (p2pEntry) {
      this.p2pVoicePeers.delete(peerId);
      try {
        p2pEntry.pc.close();
      } catch {
        // Ignore
      }
    }
    audioEngine.detachRemotePeerVoice(peerId);
  }

  private withStageTimeout<T>(promise: Promise<T>, ms: number, stageLabel: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(`Tempo limite excedido ao inicializar ${stageLabel}. Tente novamente.`));
      }, ms);

      promise
        .then((val) => {
          window.clearTimeout(timer);
          resolve(val);
        })
        .catch((err) => {
          window.clearTimeout(timer);
          reject(err);
        });
    });
  }

  private async captureDesktopVideoStream(
    source: DesktopCaptureSourceItem,
    resolution: StreamResolution,
    fps: StreamFps
  ): Promise<MediaStream> {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      throw new Error('Captura avançada requer o Aplicativo Desktop Aether.');
    }

    const spec = STREAM_RESOLUTION_SPECS[resolution] ?? STREAM_RESOLUTION_SPECS['1080p'];
    const isOriginal = resolution === 'original' || spec.width === 0;

    try {
      await desktopApi.prepareDisplayMedia(source.id);
      const videoConstraints: MediaTrackConstraints = isOriginal
        ? {
            frameRate: { ideal: fps, max: fps },
          }
        : {
            width: { ideal: spec.width, max: spec.width },
            height: { ideal: spec.height, max: spec.height },
            frameRate: { ideal: fps, max: fps },
          };

      return await this.withStageTimeout(
        navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
        }),
        10000,
        'captura de tela Desktop'
      );
    } catch {
      const mandatory: Record<string, unknown> = {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        minFrameRate: Math.min(30, fps),
        maxFrameRate: fps,
      };
      if (!isOriginal) {
        mandatory.maxWidth = spec.width;
        mandatory.maxHeight = spec.height;
      }
      return await this.withStageTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory },
        } as unknown as MediaStreamConstraints),
        10000,
        'captura de janela Desktop'
      );
    }
  }

  /**
   * 1-Click Capture Reauthorization: replaces the video track live on all active WebRTC & Relay
   * senders without dropping the broadcast or disconnecting viewers!
   */
  public async reauthorizeCaptureSource(newSource?: DesktopCaptureSourceItem): Promise<void> {
    const source = newSource || this.lastDesktopSource;
    if (!this.localStreamId || !source) return;

    const nextStream = await this.captureDesktopVideoStream(
      source,
      this.lastStreamResolution,
      this.lastStreamFps
    );
    const nextTrack = nextStream.getVideoTracks()[0];
    if (!nextTrack) {
      for (const t of nextStream.getTracks()) t.stop();
      throw new Error('Não foi possível capturar vídeo da fonte selecionada');
    }

    this.lastDesktopSource = source;
    nextTrack.contentHint = this.lastContentOptimization;
    nextTrack.onended = () => {
      void this.stopLiveStream();
      this.onLocalStreamEndedExternally?.();
    };

    const prevStream = this.localDisplayStream;
    this.localDisplayStream = nextStream;

    if (this.p2pBroadcastTracks) {
      this.p2pBroadcastTracks.videoTrack = nextTrack;
      for (const pc of this.p2pStreamSenders.values()) {
        const vSender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (vSender) {
          await vSender.replaceTrack(nextTrack).catch(() => {});
        }
      }
    }

    if (this.localVideoProducer && !this.localVideoProducer.closed) {
      await this.localVideoProducer.replaceTrack({ track: nextTrack }).catch(() => {});
    }

    if (this.localRelayRecorder) {
      await this.startOrRefreshBroadcasterRelay(this.localStreamId);
    }

    if (prevStream) {
      for (const t of prevStream.getTracks()) {
        t.onended = null;
        t.stop();
      }
    }

    this.zeroCaptureChecks = 0;
    this.onCaptureDiagnostic?.(null);
  }

  private async produceStreamVideoWithFallback(
    videoTrack: MediaStreamTrack,
    targetBitrateKbps: number,
    fps: StreamFps,
    connectionMode: StreamConnectionMode
  ): Promise<mediasoupTypes.Producer> {
    if (!this.device || !this.streamSendTransport) {
      throw new Error('Transporte de transmissão não inicializado');
    }

    const allVideo = (this.device.rtpCapabilities.codecs || []).filter((c) => c.kind === 'video');
    const h264Base = allVideo.find(
      (c) =>
        c.mimeType.toLowerCase() === 'video/h264' &&
        String(c.parameters?.['profile-level-id'] || '')
          .toLowerCase()
          .startsWith('42e0')
    );
    const vp8Codec = allVideo.find((c) => c.mimeType.toLowerCase() === 'video/vp8');
    const h264High = allVideo.find(
      (c) =>
        c.mimeType.toLowerCase() === 'video/h264' &&
        String(c.parameters?.['profile-level-id'] || '')
          .toLowerCase()
          .startsWith('6400')
    );

    const codecCandidates: (mediasoupTypes.RtpCodecCapability | undefined)[] =
      connectionMode === 'compatibility'
        ? [vp8Codec, h264Base, undefined]
        : connectionMode === 'quality'
          ? [h264Base, h264High, vp8Codec, undefined]
          : [h264Base, vp8Codec, h264High, undefined];

    const deduped = codecCandidates.filter(
      (c, idx, arr) =>
        (c !== undefined && arr.indexOf(c) === idx) || (c === undefined && idx === arr.length - 1)
    );

    let lastErr: unknown = null;
    for (const codecCandidate of deduped) {
      try {
        const prod = await this.withStageTimeout(
          this.streamSendTransport.produce({
            track: videoTrack,
            stopTracks: false,
            codec: codecCandidate,
            encodings: [
              {
                maxBitrate: targetBitrateKbps * 1000,
                maxFramerate: fps,
                scaleResolutionDownBy: 1.0,
                networkPriority: 'high',
              },
            ],
            codecOptions: {
              videoGoogleStartBitrate: Math.round(targetBitrateKbps * 0.8),
              videoGoogleMaxBitrate: targetBitrateKbps,
              videoGoogleMinBitrate: Math.round(targetBitrateKbps * 0.45),
            },
          }),
          15000,
          'codificador de vídeo'
        );

        const rtpSender = prod.rtpSender;
        if (rtpSender) {
          const params = rtpSender.getParameters();
          params.degradationPreference = this.resolveDegradationPreference(connectionMode, fps);
          void rtpSender.setParameters(params).catch(() => {});
        }

        return prod;
      } catch (err) {
        lastErr = err;
        if (!this.streamSendTransport || this.streamSendTransport.closed) {
          break;
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error('Falha ao negociar codificador de vídeo WebRTC');
  }

  public async startLiveStream(options: {
    title: string;
    resolution: StreamResolution;
    fps: StreamFps;
    customBitrateKbps?: number | null;
    audioBitrateKbps?: number | null;
    shareAudio: boolean;
    audioSourceMode?: 'window' | 'system' | 'apps';
    selectedAudioPids?: number[];
    privacy?: StreamPrivacyMode;
    allowedUserIds?: string[];
    viewerLimit?: number | null;
    connectionMode?: StreamConnectionMode;
    contentOptimization: 'detail' | 'motion';
    desktopSource?: DesktopCaptureSourceItem | null;
  }): Promise<ActiveStreamInfo> {
    if (!this.inActiveRoom) {
      // Attempt instant state heal if user has an active session saved
      if (this.activeRoomSessionParams) {
        await this.rejoinActiveRoomAfterBlip();
      }
      if (!this.inActiveRoom) {
        throw new Error('Entre em uma sala antes de transmitir');
      }
    }
    await this.stopLiveStream();

    const targetBitrateKbps = resolveTargetBitrateKbps(
      options.resolution,
      options.fps,
      options.customBitrateKbps
    );
    const audioBitrateKbps = resolveTargetAudioBitrateKbps(options.audioBitrateKbps);
    const privacy: StreamPrivacyMode = options.privacy ?? 'public';
    const allowedUserIds = options.allowedUserIds ?? [];
    const viewerLimit = options.viewerLimit ?? null;
    const connectionMode: StreamConnectionMode = options.connectionMode ?? 'auto';

    try {
      await audioEngine.resumeContexts();

      let audioTrack: MediaStreamTrack | null = null;
      let audioIsolationMode: AudioIsolationMode = 'none';

      const desktopApi = getDesktopApi();
      if (!desktopApi || !options.desktopSource) {
        throw new Error(
          'Selecione uma janela ou tela no Aplicativo Desktop Aether para iniciar a transmissão.'
        );
      }

      this.lastDesktopSource = options.desktopSource;
      this.lastContentOptimization = options.contentOptimization;
      this.lastStreamResolution = options.resolution;
      this.lastStreamFps = options.fps;
      this.zeroCaptureChecks = 0;
      this.onCaptureDiagnostic?.(null);

      // Activate OS Anti-Background-Throttling Shield + High Priority GPU/Capture Threads
      await desktopApi.setBroadcastActive(true).catch(() => {});

      const mediaStream = await this.captureDesktopVideoStream(
        options.desktopSource,
        options.resolution,
        options.fps
      );
      this.localDisplayStream = mediaStream;
      const videoTrack = mediaStream.getVideoTracks()[0];

      if (options.shareAudio) {
        try {
          const sourceMode =
            options.audioSourceMode ||
            (options.desktopSource.kind === 'window' && options.desktopSource.pid
              ? 'window'
              : 'system');

          let nativeRes: { ok: boolean; mode?: string; error?: string };
          if (
            sourceMode === 'apps' &&
            Array.isArray(options.selectedAudioPids) &&
            options.selectedAudioPids.length > 0
          ) {
            nativeRes = await desktopApi.startProcessLoopback({
              mode: 'include-multi',
              targetPids: options.selectedAudioPids,
            });
            audioIsolationMode =
              options.selectedAudioPids.length > 1 ? 'multi-process' : 'process-isolated';
          } else if (
            sourceMode === 'window' &&
            options.desktopSource.kind === 'window' &&
            options.desktopSource.pid
          ) {
            nativeRes = await desktopApi.startProcessLoopback({
              mode: 'include-process',
              targetPid: options.desktopSource.pid,
              targetHwnd: options.desktopSource.hwnd,
            });
            audioIsolationMode = 'process-isolated';
          } else {
            nativeRes = await desktopApi.startProcessLoopback({
              mode: 'exclude-self',
            });
            audioIsolationMode = 'process-isolated';
          }

          if (nativeRes.ok) {
            const bridge = await this.withStageTimeout(
              audioEngine.createNativeLoopbackTrack(),
              8000,
              'ponte de áudio WASAPI'
            );
            this.localNativeAudioCleanup = bridge.dispose;
            this.localDesktopPcmUnsub = desktopApi.onLoopbackPcm((buf) => {
              const floatView = new Float32Array(buf);
              bridge.pushInterleavedPcm(floatView);
            });
            audioTrack = bridge.track;
          } else {
            audioIsolationMode = 'none';
          }
        } catch (audioErr) {
          audioIsolationMode = 'none';
          console.warn(
            '[Desktop Audio Loopback] Falha não-bloqueante ao iniciar áudio isolado; prosseguindo com vídeo:',
            audioErr
          );
        }
      }

      if (!videoTrack || videoTrack.readyState === 'ended') {
        throw new Error('Nenhuma fonte de vídeo ativa foi capturada');
      }

      videoTrack.contentHint = options.contentOptimization;
      videoTrack.onended = () => {
        void this.stopLiveStream();
        this.onLocalStreamEndedExternally?.();
      };

      if (this.mediaMode === 'p2p') {
        const validAudio = audioTrack && audioTrack.readyState === 'live' ? audioTrack : null;
        this.p2pBroadcastTracks = {
          videoTrack,
          audioTrack: validAudio,
          resolution: options.resolution,
          targetBitrateKbps,
          audioBitrateKbps,
          fps: options.fps,
          connectionMode,
          forceVp8: connectionMode === 'compatibility',
        };
        const startRes = await this.withStageTimeout(
          this.rpc<{ stream: ActiveStreamInfo }>('p2p:streamStart', {
            title: options.title,
            resolution: options.resolution,
            fps: options.fps,
            targetBitrateKbps,
            audioBitrateKbps,
            privacy,
            allowedUserIds,
            viewerLimit,
            connectionMode,
            hasAudio: Boolean(validAudio),
            audioIsolationMode: validAudio ? audioIsolationMode : 'none',
          }),
          12000,
          'registro da transmissão no servidor'
        );
        this.localStreamId = startRes.stream.streamId;
        this.startBroadcasterTelemetryLoop(startRes.stream.streamId);

        // Pre-warm Cloud WSS Relay immediately when broadcaster chooses Compatibility Mode
        if (connectionMode === 'compatibility') {
          void this.startOrRefreshBroadcasterRelay(startRes.stream.streamId);
        }
        return startRes.stream;
      }

      if (!this.streamSendTransport || this.streamSendTransport.closed) {
        this.streamSendTransport = await this.withStageTimeout(
          this.initClientTransport('stream', 'send'),
          12000,
          'transporte SFU de transmissão'
        );
      }

      const videoProducer = await this.produceStreamVideoWithFallback(
        videoTrack,
        targetBitrateKbps,
        options.fps,
        connectionMode
      );
      this.localVideoProducer = videoProducer;

      if (audioTrack && audioTrack.readyState === 'live') {
        try {
          const audioProducer = await this.withStageTimeout(
            this.streamSendTransport.produce({
              track: audioTrack,
              stopTracks: false,
              codecOptions: {
                opusStereo: true,
                opusFec: true,
                opusDtx: false,
                opusMaxPlaybackRate: 48000,
                opusMaxAverageBitrate: Math.max(32000, Math.min(510000, audioBitrateKbps * 1000)),
              },
            }),
            12000,
            'codificador de áudio estéreo'
          );
          this.localAudioProducer = audioProducer;
        } catch (audioProdErr) {
          console.warn(
            '[Stream Audio Produce] Prosseguindo sem áudio após erro no codificador:',
            audioProdErr
          );
          audioIsolationMode = 'none';
        }
      }

      const startRes = await this.withStageTimeout(
        this.rpc<{ stream: ActiveStreamInfo }>('stream:start', {
          transportId: this.streamSendTransport.id,
          title: options.title,
          resolution: options.resolution,
          fps: options.fps,
          targetBitrateKbps,
          audioBitrateKbps,
          privacy,
          allowedUserIds,
          viewerLimit,
          connectionMode,
          audioIsolationMode: this.localAudioProducer ? audioIsolationMode : 'none',
          videoProducerId: this.localVideoProducer.id,
          audioProducerId: this.localAudioProducer?.id ?? null,
        }),
        12000,
        'registro da transmissão no servidor'
      );

      this.localStreamId = startRes.stream.streamId;
      this.startBroadcasterTelemetryLoop(startRes.stream.streamId);
      if (connectionMode === 'compatibility') {
        void this.startOrRefreshBroadcasterRelay(startRes.stream.streamId);
      }
      return startRes.stream;
    } catch (err) {
      await this.stopLiveStream().catch(() => {});
      throw err;
    }
  }

  /**
   * Real-Time Live Stream Adjustment: updates video/audio bitrates, privacy, or viewer limit
   * instantaneously on active WebRTC encoders and room metadata without restarting the broadcast!
   */
  public async updateLiveStreamSettings(patch: {
    targetBitrateKbps?: number;
    audioBitrateKbps?: number;
    privacy?: StreamPrivacyMode;
    viewerLimit?: number | null;
  }): Promise<ActiveStreamInfo | null> {
    if (!this.localStreamId) return null;

    if (typeof patch.targetBitrateKbps === 'number' && patch.targetBitrateKbps >= 300) {
      const clampedKbps = Math.min(60000, Math.round(patch.targetBitrateKbps));
      if (this.p2pBroadcastTracks) {
        this.p2pBroadcastTracks.targetBitrateKbps = clampedKbps;
      }
      for (const pc of this.p2pStreamSenders.values()) {
        const vSender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (vSender) {
          const p = vSender.getParameters();
          if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
          p.encodings[0].maxBitrate = clampedKbps * 1000;
          void vSender.setParameters(p).catch(() => {});
        }
      }
      const sfuSender = this.localVideoProducer?.rtpSender;
      if (sfuSender) {
        const p = sfuSender.getParameters();
        if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
        p.encodings[0].maxBitrate = clampedKbps * 1000;
        void sfuSender.setParameters(p).catch(() => {});
      }
    }

    if (typeof patch.audioBitrateKbps === 'number' && patch.audioBitrateKbps >= 32) {
      const clampedAudio = Math.min(510, Math.round(patch.audioBitrateKbps));
      if (this.p2pBroadcastTracks) {
        this.p2pBroadcastTracks.audioBitrateKbps = clampedAudio;
      }
      for (const pc of this.p2pStreamSenders.values()) {
        const aSender = pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (aSender) {
          const p = aSender.getParameters();
          if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
          p.encodings[0].maxBitrate = clampedAudio * 1000;
          void aSender.setParameters(p).catch(() => {});
        }
      }
    }

    const res = await this.rpc<{ stream: ActiveStreamInfo }>('stream:updateMeta', {
      streamId: this.localStreamId,
      ...patch,
    });
    return res.stream;
  }

  private startBroadcasterTelemetryLoop(streamId: string): void {
    if (this.localTelemetryTimer !== null) window.clearInterval(this.localTelemetryTimer);
    this.prevBytesSent = 0;
    this.prevStatsTime = performance.now();

    this.localTelemetryTimer = window.setInterval(async () => {
      if (this.localStreamId !== streamId) return;

      // Capture Permission / Minimized Exclusive Window Health Check
      const vTrack =
        this.p2pBroadcastTracks?.videoTrack || this.localDisplayStream?.getVideoTracks()[0];
      if (vTrack) {
        const settings = vTrack.getSettings();
        const isMutedOrZeroDim =
          vTrack.muted ||
          (typeof settings.width === 'number' && settings.width === 0);
        if (isMutedOrZeroDim) {
          this.zeroCaptureChecks++;
          if (this.zeroCaptureChecks >= 3) {
            this.onCaptureDiagnostic?.({
              active: true,
              reason:
                'A janela capturada está minimizada, bloqueada por tela cheia exclusiva ou sem permissão gráfica do Windows.',
            });
          }
        } else if (this.zeroCaptureChecks > 0) {
          this.zeroCaptureChecks = 0;
          this.onCaptureDiagnostic?.(null);
        }
      }

      try {
        let report: RTCStatsReport | null = null;
        if (this.mediaMode === 'p2p') {
          const firstSenderPc = this.p2pStreamSenders.values().next().value as
            | RTCPeerConnection
            | undefined;
          if (!firstSenderPc) {
            // Even before first viewer joins, report track capture dimensions so badge shows verified resolution!
            const s = vTrack?.getSettings();
            if (s?.width && s?.height) {
              await this.rpc('stream:telemetry', {
                streamId,
                verifiedWidth: s.width,
                verifiedHeight: s.height,
                verifiedFps: Math.round(s.frameRate || this.lastStreamFps),
                verifiedBitrateKbps: 0,
              }).catch(() => {});
            }
            return;
          }
          report = await firstSenderPc.getStats();
        } else {
          if (!this.localVideoProducer || this.localVideoProducer.closed) return;
          report = await this.localVideoProducer.getStats();
        }

        let width = 0;
        let height = 0;
        let fps = 0;
        let bytesSent = 0;

        report.forEach((stat) => {
          if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
            width = stat.frameWidth || width;
            height = stat.frameHeight || height;
            fps = stat.framesPerSecond || fps;
            bytesSent = stat.bytesSent || bytesSent;
          }
        });

        const now = performance.now();
        const elapsedSec = Math.max(0.2, (now - this.prevStatsTime) / 1000);
        const bitrateKbps =
          this.prevBytesSent > 0
            ? Math.max(0, ((bytesSent - this.prevBytesSent) * 8) / 1000 / elapsedSec)
            : 0;
        this.prevBytesSent = bytesSent;
        this.prevStatsTime = now;

        if (width > 0 && height > 0) {
          await this.rpc('stream:telemetry', {
            streamId,
            verifiedWidth: width,
            verifiedHeight: height,
            verifiedFps: fps,
            verifiedBitrateKbps: bitrateKbps,
          }).catch(() => {});
        }
      } catch {
        // Ignore transient stats error
      }
    }, 1500);
  }

  public async stopLiveStream(): Promise<void> {
    if (this.localTelemetryTimer !== null) {
      window.clearInterval(this.localTelemetryTimer);
      this.localTelemetryTimer = null;
    }

    this.stopBroadcasterRelayLocally();
    this.onCaptureDiagnostic?.(null);
    this.zeroCaptureChecks = 0;

    const activeId = this.localStreamId;
    this.localStreamId = null;
    this.p2pBroadcastTracks = null;
    for (const pc of this.p2pStreamSenders.values()) {
      try {
        pc.close();
      } catch {
        // Ignore
      }
    }
    this.p2pStreamSenders.clear();

    if (this.localDesktopPcmUnsub) {
      this.localDesktopPcmUnsub();
      this.localDesktopPcmUnsub = null;
    }
    const desktopApi = getDesktopApi();
    if (desktopApi) {
      await desktopApi.stopProcessLoopback().catch(() => {});
      await desktopApi.setBroadcastActive(false).catch(() => {});
    }
    if (this.localNativeAudioCleanup) {
      this.localNativeAudioCleanup();
      this.localNativeAudioCleanup = null;
    }

    try {
      this.localVideoProducer?.close();
      this.localAudioProducer?.close();
    } catch {
      // Ignore
    }
    this.localVideoProducer = null;
    this.localAudioProducer = null;

    if (this.localDisplayStream) {
      for (const t of this.localDisplayStream.getTracks()) {
        t.onended = null;
        t.stop();
      }
      this.localDisplayStream = null;
    }

    if (activeId && this.ws?.readyState === WebSocket.OPEN) {
      await this.rpc('stream:relayStop', { streamId: activeId }).catch(() => {});
      const stopMethod = this.mediaMode === 'p2p' ? 'p2p:streamStop' : 'stream:stop';
      await this.rpc(stopMethod, { streamId: activeId }).catch(() => {});
    }
  }

  public async watchStream(
    streamId: string,
    preferredMode?: 'p2p' | 'relay'
  ): Promise<{
    stream: ActiveStreamInfo;
    videoStream: MediaStream;
    transportMode: WatchedTransportMode;
    hasAudio: boolean;
  }> {
    if (!this.inActiveRoom && this.activeRoomSessionParams) {
      await this.rejoinActiveRoomAfterBlip();
    }
    if (!this.inActiveRoom) {
      throw new Error('Entre em uma sala para assistir à transmissão');
    }

    await audioEngine.resumeContexts();
    this.cleanupWatchedStream(streamId);

    if (preferredMode === 'relay') {
      return this.watchStreamViaRelay(streamId);
    }

    if (this.mediaMode === 'p2p') {
      const viewerPc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
      let broadcasterPeerId = '';
      const outboundCandidateQueue: RTCIceCandidateInit[] = [];

      // Buffer local ICE candidates generated BEFORE broadcasterPeerId is returned by p2p:streamWatch!
      viewerPc.onicecandidate = (iceEv) => {
        if (!iceEv.candidate) return;
        const json = iceEv.candidate.toJSON();
        if (!broadcasterPeerId) {
          outboundCandidateQueue.push(json);
          return;
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          void this.rpc('p2p:signal', {
            targetPeerId: broadcasterPeerId,
            plane: 'stream',
            streamId,
            candidate: json,
          }).catch(() => {});
        }
      };

      const tracksPromise = new Promise<{
        videoTrack: MediaStreamTrack;
        audioTrack: MediaStreamTrack | null;
      }>((resolve) => {
        const pending = {
          pc: viewerPc,
          videoTrack: null as MediaStreamTrack | null,
          audioTrack: null as MediaStreamTrack | null,
          expectAudio: false,
          resolveTracks: resolve,
        };
        this.p2pPendingWatchers.set(streamId, pending);

        viewerPc.ontrack = (trackEv) => {
          const receiver = trackEv.receiver as RTCRtpReceiver & { playoutDelayHint?: number };
          if (trackEv.track.kind === 'video') {
            if (receiver && 'playoutDelayHint' in receiver) {
              receiver.playoutDelayHint = 0.045;
            }
            pending.videoTrack = trackEv.track;
          } else if (trackEv.track.kind === 'audio') {
            pending.audioTrack = trackEv.track;
          }

          if (pending.videoTrack && (!pending.expectAudio || pending.audioTrack)) {
            this.p2pPendingWatchers.delete(streamId);
            resolve({ videoTrack: pending.videoTrack, audioTrack: pending.audioTrack });
          } else if (pending.videoTrack && pending.expectAudio) {
            window.setTimeout(() => {
              if (this.p2pPendingWatchers.has(streamId) && pending.videoTrack) {
                this.p2pPendingWatchers.delete(streamId);
                resolve({ videoTrack: pending.videoTrack, audioTrack: pending.audioTrack });
              }
            }, 600);
          }
        };
      });

      let watchedStreamMeta: ActiveStreamInfo | null = null;
      try {
        const watchRes = await this.rpc<{ stream: ActiveStreamInfo; broadcasterPeerId: string }>(
          'p2p:streamWatch',
          { streamId }
        );
        watchedStreamMeta = watchRes.stream;
        broadcasterPeerId = watchRes.broadcasterPeerId;

        // If broadcaster explicitly selected Compatibility Mode, switch directly to Cloud WSS Relay!
        if (watchRes.stream.connectionMode === 'compatibility' && !preferredMode) {
          this.p2pPendingWatchers.delete(streamId);
          viewerPc.close();
          await this.rpc('p2p:streamUnwatch', { streamId }).catch(() => {});
          return await this.watchStreamViaRelay(streamId, watchRes.stream);
        }

        // Flush any outbound ICE candidates gathered before watchRes arrived
        if (outboundCandidateQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
          for (const cand of outboundCandidateQueue.splice(0)) {
            void this.rpc('p2p:signal', {
              targetPeerId: broadcasterPeerId,
              plane: 'stream',
              streamId,
              candidate: cand,
            }).catch(() => {});
          }
        }

        const pending = this.p2pPendingWatchers.get(streamId);
        if (pending) pending.expectAudio = watchRes.stream.hasAudio;

        const { videoTrack, audioTrack } = await this.withStageTimeout(
          tracksPromise,
          8500,
          'recepção WebRTC da transmissão'
        );

        if (audioTrack) {
          await audioEngine.attachStreamAudio(streamId, audioTrack, 100);
        }

        const videoStream = new MediaStream([videoTrack]);
        const entry: InternalWatchedStream = {
          streamId,
          streamInfo: watchRes.stream,
          transportMode: 'p2p',
          videoConsumer: null,
          audioConsumer: null,
          p2pPc: viewerPc,
          relay: null,
          zeroFrameWatchdogTimer: null,
          videoStream,
          statsTimer: null,
          lastBytesReceived: 0,
          lastStatsTs: performance.now(),
          volume: 100,
          muted: false,
        };

        // 4.2-Second Anti-Black-Screen Viewer Watchdog:
        // If Symmetric CGNAT / firewall blocks UDP packets (framesDecoded === 0 after 4.2s) or ICE fails,
        // automatically & transparently switch to Cloud WSS Binary Media Relay so video NEVER stays black!
        const triggerRelayFallback = () => {
          const cur = this.watchedStreams.get(streamId);
          if (!cur || cur.transportMode !== 'p2p') return;
          console.warn(
            '[Anti-Black-Screen Watchdog] 0 quadros WebRTC decodificados; ativando Cloud WSS Relay automaticamente!'
          );
          void this.switchWatchedStreamTransport(streamId, 'relay');
        };

        viewerPc.addEventListener('iceconnectionstatechange', () => {
          if (viewerPc.iceConnectionState === 'failed') {
            triggerRelayFallback();
          }
        });

        entry.zeroFrameWatchdogTimer = window.setTimeout(async () => {
          if (this.watchedStreams.get(streamId) !== entry) return;
          try {
            const stats = await viewerPc.getStats();
            let framesDecoded = 0;
            stats.forEach((s) => {
              if (s.type === 'inbound-rtp' && s.kind === 'video') {
                framesDecoded += s.framesDecoded || 0;
              }
            });
            if (framesDecoded === 0) {
              triggerRelayFallback();
            }
          } catch {
            // ignore
          }
        }, 4200);

        entry.statsTimer = window.setInterval(async () => {
          try {
            const stats = await viewerPc.getStats();
            let width = 0;
            let height = 0;
            let fps = 0;
            let bytesReceived = 0;
            stats.forEach((s) => {
              if (s.type === 'inbound-rtp' && s.kind === 'video') {
                width = s.frameWidth || width;
                height = s.frameHeight || height;
                fps = s.framesPerSecond || fps;
                bytesReceived = s.bytesReceived || bytesReceived;
              }
            });
            const now = performance.now();
            const dt = Math.max(0.2, (now - entry.lastStatsTs) / 1000);
            const bitrateKbps =
              entry.lastBytesReceived > 0
                ? Math.max(0, ((bytesReceived - entry.lastBytesReceived) * 8) / 1000 / dt)
                : 0;
            entry.lastBytesReceived = bytesReceived;
            entry.lastStatsTs = now;

            this.onWatchedStreamStats?.(streamId, {
              width,
              height,
              fps: Math.round(fps * 10) / 10,
              bitrateKbps: Math.round(bitrateKbps),
            });
          } catch {
            // Ignore
          }
        }, 1000);

        this.watchedStreams.set(streamId, entry);
        this.lastWatchedStreamIdBeforeBlip = streamId;
        return {
          stream: watchRes.stream,
          videoStream,
          transportMode: 'p2p',
          hasAudio: Boolean(audioTrack),
        };
      } catch (err) {
        this.p2pPendingWatchers.delete(streamId);
        viewerPc.close();

        // If P2P signaling/ICE timed out (Symmetric NAT), fall back directly to Cloud WSS Relay
        // UNLESS the error was an access policy rejection (privacy / viewer limit)!
        const code = (err as { code?: string })?.code;
        if (
          !preferredMode &&
          code !== 'STREAM_PRIVATE' &&
          code !== 'STREAM_FRIENDS_ONLY' &&
          code !== 'VIEWER_LIMIT_REACHED' &&
          watchedStreamMeta
        ) {
          await this.rpc('p2p:streamUnwatch', { streamId }).catch(() => {});
          return await this.watchStreamViaRelay(streamId, watchedStreamMeta);
        }
        throw err;
      }
    }

    if (!this.device) {
      throw new Error('Dispositivo SFU não inicializado na sala.');
    }

    if (!this.streamRecvTransport || this.streamRecvTransport.closed) {
      this.streamRecvTransport = await this.initClientTransport('stream', 'recv');
    }

    const res = await this.rpc<StreamWatchResult>('stream:watch', {
      streamId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    if (res.stream.connectionMode === 'compatibility') {
      return this.watchStreamViaRelay(streamId, res.stream);
    }

    const videoConsumer = await this.streamRecvTransport.consume({
      id: res.videoConsumer.id,
      producerId: res.videoConsumer.producerId,
      kind: 'video',
      rtpParameters: res.videoConsumer.rtpParameters as mediasoupTypes.RtpParameters,
    });

    const receiver = videoConsumer.rtpReceiver as RTCRtpReceiver & { playoutDelayHint?: number };
    if (receiver && 'playoutDelayHint' in receiver) {
      receiver.playoutDelayHint = 0.045;
    }

    let audioConsumer: mediasoupTypes.Consumer | null = null;
    if (res.audioConsumer) {
      audioConsumer = await this.streamRecvTransport.consume({
        id: res.audioConsumer.id,
        producerId: res.audioConsumer.producerId,
        kind: 'audio',
        rtpParameters: res.audioConsumer.rtpParameters as mediasoupTypes.RtpParameters,
      });
      await audioEngine.attachStreamAudio(streamId, audioConsumer.track, 100);
      await this.rpc('sfu:resumeConsumer', { consumerId: audioConsumer.id }).catch(() => {});
    }

    await this.rpc('sfu:resumeConsumer', { consumerId: videoConsumer.id }).catch(() => {});

    const videoStream = new MediaStream([videoConsumer.track]);
    const entry: InternalWatchedStream = {
      streamId,
      streamInfo: res.stream,
      transportMode: 'sfu',
      videoConsumer,
      audioConsumer,
      relay: null,
      zeroFrameWatchdogTimer: null,
      videoStream,
      statsTimer: null,
      lastBytesReceived: 0,
      lastStatsTs: performance.now(),
      volume: 100,
      muted: false,
    };

    entry.statsTimer = window.setInterval(async () => {
      if (videoConsumer.closed) return;
      try {
        const stats = await videoConsumer.getStats();
        let width = 0;
        let height = 0;
        let fps = 0;
        let bytesReceived = 0;
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            width = s.frameWidth || width;
            height = s.frameHeight || height;
            fps = s.framesPerSecond || fps;
            bytesReceived = s.bytesReceived || bytesReceived;
          }
        });
        const now = performance.now();
        const dt = Math.max(0.2, (now - entry.lastStatsTs) / 1000);
        const bitrateKbps =
          entry.lastBytesReceived > 0
            ? Math.max(0, ((bytesReceived - entry.lastBytesReceived) * 8) / 1000 / dt)
            : 0;
        entry.lastBytesReceived = bytesReceived;
        entry.lastStatsTs = now;

        this.onWatchedStreamStats?.(streamId, {
          width,
          height,
          fps: Math.round(fps * 10) / 10,
          bitrateKbps: Math.round(bitrateKbps),
        });
      } catch {
        // Ignore
      }
    }, 1000);

    this.watchedStreams.set(streamId, entry);
    this.lastWatchedStreamIdBeforeBlip = streamId;

    return {
      stream: res.stream,
      videoStream,
      transportMode: 'sfu',
      hasAudio: Boolean(audioConsumer),
    };
  }

  public setWatchedStreamVolumeState(streamId: string, volume: number, muted: boolean): void {
    const entry = this.watchedStreams.get(streamId);
    if (entry) {
      entry.volume = volume;
      entry.muted = muted;
    }
    audioEngine.setStreamVolume(streamId, volume, muted);
  }

  public async unwatchStream(streamId: string): Promise<void> {
    if (this.lastWatchedStreamIdBeforeBlip === streamId) {
      this.lastWatchedStreamIdBeforeBlip = null;
    }
    const wasRelay = this.watchedStreams.get(streamId)?.transportMode === 'relay';
    this.cleanupWatchedStream(streamId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (wasRelay) {
        await this.rpc('stream:relayUnwatch', { streamId }).catch(() => {});
      }
      const unwatchMethod = this.mediaMode === 'p2p' ? 'p2p:streamUnwatch' : 'stream:unwatch';
      await this.rpc(unwatchMethod, { streamId }).catch(() => {});
    }
  }

  private cleanupWatchedStream(streamId: string): void {
    const pending = this.p2pPendingWatchers.get(streamId);
    if (pending) {
      this.p2pPendingWatchers.delete(streamId);
      try {
        pending.pc.close();
      } catch {
        // Ignore
      }
    }
    const entry = this.watchedStreams.get(streamId);
    if (!entry) return;
    this.watchedStreams.delete(streamId);
    if (entry.statsTimer !== null) window.clearInterval(entry.statsTimer);
    if (entry.zeroFrameWatchdogTimer !== null) window.clearTimeout(entry.zeroFrameWatchdogTimer);
    audioEngine.detachStreamAudio(streamId);
    try {
      entry.videoConsumer?.close();
      entry.audioConsumer?.close();
      entry.p2pPc?.close();
      entry.relay?.dispose();
    } catch {
      // Ignore
    }
  }

  public teardownRoomMedia(): void {
    void this.stopLiveStream();
    for (const streamId of Array.from(this.watchedStreams.keys())) {
      this.cleanupWatchedStream(streamId);
    }
    for (const [sid, p] of Array.from(this.p2pPendingWatchers.entries())) {
      this.p2pPendingWatchers.delete(sid);
      try {
        p.pc.close();
      } catch {
        // Ignore
      }
    }
    for (const peerId of Array.from(this.remoteVoiceConsumers.keys())) {
      this.unsubscribeRemoteVoice(peerId);
    }
    for (const peerId of Array.from(this.p2pVoicePeers.keys())) {
      this.unsubscribeRemoteVoice(peerId);
    }
    this.pendingRemoteIceCandidates.clear();
    this.p2pSignalChains.clear();

    try {
      this.voiceProducer?.close();
      this.voiceSendTransport?.close();
      this.voiceRecvTransport?.close();
      this.streamSendTransport?.close();
      this.streamRecvTransport?.close();
    } catch {
      // Ignore
    }
    this.inActiveRoom = false;
    this.localMicTrack = null;
    this.voiceProducer = null;
    this.voiceSendTransport = null;
    this.voiceRecvTransport = null;
    this.streamSendTransport = null;
    this.streamRecvTransport = null;
    this.device = null;
    audioEngine.clearRoomAudio();
  }

  // Room Chat helpers
  public sendChatMessage(roomId: string, content: string, attachmentIds: string[]) {
    return this.rpc<{ message: ChatMessage }>('chat:send', { roomId, content, attachmentIds });
  }

  public editChatMessage(messageId: string, content: string) {
    return this.rpc<{ message: ChatMessage }>('chat:edit', { messageId, content });
  }

  public deleteChatMessage(messageId: string) {
    return this.rpc<{ deleted: boolean }>('chat:delete', { messageId });
  }

  public listRoomsRpc() {
    return this.rpc<{ rooms: RoomSummary[] }>('lobby:listRooms', {});
  }

  // Friends & Direct Messages RPCs
  public listFriendsRpc() {
    return this.rpc<{ friends: FriendEntry[] }>('friends:list', {});
  }

  public sendFriendRequestRpc(username: string) {
    return this.rpc<{ status: string; friends: FriendEntry[] }>('friends:request', { username });
  }

  public respondFriendRequestRpc(friendshipId: string, accept: boolean) {
    return this.rpc<{ accepted: boolean; friends: FriendEntry[] }>('friends:respond', {
      friendshipId,
      accept,
    });
  }

  public removeFriendRpc(friendshipId: string) {
    return this.rpc<{ removed: boolean; friends: FriendEntry[] }>('friends:remove', {
      friendshipId,
    });
  }

  public inviteFriendToRoomRpc(targetUserId: string, roomId: string) {
    return this.rpc<{ invited: boolean; dmMessage?: DirectMessage }>('friends:inviteToRoom', {
      targetUserId,
      roomId,
    });
  }

  public listDmHistoryRpc(peerUserId: string, beforeCreatedAt?: string) {
    return this.rpc<{ messages: DirectMessage[] }>('dm:history', {
      peerUserId,
      beforeCreatedAt,
      limit: 70,
    });
  }

  public sendDmRpc(
    recipientId: string,
    content: string,
    attachmentIds: string[],
    roomInvite?: { roomId: string; roomName: string } | null
  ) {
    return this.rpc<{ message: DirectMessage }>('dm:send', {
      recipientId,
      content,
      attachmentIds,
      roomInvite: roomInvite ?? null,
    });
  }

  public editDmRpc(messageId: string, content: string) {
    return this.rpc<{ message: DirectMessage }>('dm:edit', { messageId, content });
  }

  public deleteDmRpc(messageId: string) {
    return this.rpc<{ deleted: boolean }>('dm:delete', { messageId });
  }

  public sendDmTypingRpc(recipientId: string, typing: boolean) {
    return this.rpc<{ ok: boolean }>('dm:typing', { recipientId, typing });
  }

  public markDmReadRpc(peerUserId: string) {
    return this.rpc<{ markedCount: number; readAt: string }>('dm:markRead', { peerUserId });
  }

  // Real-Time Moderation & Administration RPCs
  public adminKickParticipant(peerId: string, reason?: string) {
    return this.rpc<{ kicked: boolean }>('admin:kickParticipant', { peerId, reason });
  }

  public adminForceMuteParticipant(peerId: string) {
    return this.rpc<{ muted: boolean }>('admin:forceMuteParticipant', { peerId });
  }

  public adminForceStopStream(streamId: string, reason?: string) {
    return this.rpc<{ stopped: boolean }>('admin:forceStopStream', { streamId, reason });
  }
}

export const realtimeSession = new RealtimeSession();
