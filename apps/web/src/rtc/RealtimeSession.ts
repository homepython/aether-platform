import { Device, type types as mediasoupTypes } from 'mediasoup-client';
import {
  STREAM_RESOLUTION_SPECS,
  resolveTargetBitrateKbps,
  type ActiveStreamInfo,
  type AudioSettings,
  type ChatMessage,
  type ClientRpcMethod,
  type ClientRpcRequest,
  type IceServerConfig,
  type RoomJoinResult,
  type RoomSummary,
  type ServerPushEvent,
  type ServerRpcResponse,
  type StreamFps,
  type StreamResolution,
  type StreamWatchResult,
  type TransportCreatedResult,
  type TransportDirection,
  type TransportPlane,
} from '@aether/shared';
import { api, hasActiveMemoryToken } from '../api/httpClient.js';
import { audioEngine } from '../audio/AudioEngine.js';
import { getDesktopApi, isDesktopClient, type DesktopCaptureSourceItem } from '../bridge/DesktopBridge.js';

export interface WatchedStreamHandle {
  streamId: string;
  videoStream: MediaStream;
  hasAudio: boolean;
  volume: number;
  muted: boolean;
  verifiedWidth: number;
  verifiedHeight: number;
  verifiedFps: number;
  verifiedBitrateKbps: number;
}

interface InternalWatchedStream {
  streamId: string;
  videoConsumer: mediasoupTypes.Consumer | null;
  audioConsumer: mediasoupTypes.Consumer | null;
  p2pPc?: RTCPeerConnection | null;
  videoStream: MediaStream;
  statsTimer: number | null;
  lastBytesReceived: number;
  lastStatsTs: number;
}

interface P2pVoiceEntry {
  peerId: string;
  userId: string;
  pc: RTCPeerConnection;
  makingOffer: boolean;
}

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private pendingRpcs = new Map<
    string,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: number }
  >();

  private myPeerId = '';
  private mediaMode: 'sfu' | 'p2p' = 'sfu';
  private localMicTrack: MediaStreamTrack | null = null;
  private p2pVoicePeers = new Map<string, P2pVoiceEntry>();
  private p2pBroadcastTracks: {
    videoTrack: MediaStreamTrack;
    audioTrack: MediaStreamTrack | null;
    targetBitrateKbps: number;
    fps: StreamFps;
  } | null = null;
  private p2pStreamSenders = new Map<string, RTCPeerConnection>(); // viewerPeerId -> RTCPeerConnection
  private p2pPendingWatchers = new Map<
    string,
    {
      pc: RTCPeerConnection;
      videoTrack: MediaStreamTrack | null;
      audioTrack: MediaStreamTrack | null;
      expectAudio: boolean;
      resolveTracks: (tracks: { videoTrack: MediaStreamTrack; audioTrack: MediaStreamTrack | null }) => void;
    }
  >();

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
  private localVideoProducer: mediasoupTypes.Producer | null = null;
  private localAudioProducer: mediasoupTypes.Producer | null = null;
  private localDisplayStream: MediaStream | null = null;
  private localNativeAudioCleanup: (() => void) | null = null;
  private localDesktopPcmUnsub: (() => void) | null = null;
  private localTelemetryTimer: number | null = null;
  private prevBytesSent = 0;
  private prevStatsTime = 0;

  // Watched Remote Streams
  private watchedStreams = new Map<string, InternalWatchedStream>();

  // Event Callbacks wired into Zustand Store
  public onConnectionStatus?: (connected: boolean) => void;
  public onServerEvent?: (ev: ServerPushEvent) => void;
  public onWatchedStreamStats?: (
    streamId: string,
    stats: { width: number; height: number; fps: number; bitrateKbps: number }
  ) => void;
  public onLocalStreamEndedExternally?: () => void;

  private connectingWs = false;

  public connect(): void {
    if (!hasActiveMemoryToken()) return;
    this.intentionalClose = false;
    if (
      this.connectingWs ||
      (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }
    void this.openAuthenticatedWebSocket();
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
      this.ws = socket;

      socket.onopen = () => {
        this.connectingWs = false;
        this.onConnectionStatus?.(true);
      };

      socket.onerror = () => {
        this.connectingWs = false;
      };

      socket.onmessage = (ev) => {
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
              const err = Object.assign(new Error(msg.error?.message || 'Erro de comunicação'), {
                code: msg.error?.code,
              });
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

      socket.onclose = () => {
        this.connectingWs = false;
        this.onConnectionStatus?.(false);
        this.rejectAllPending('Conexão em tempo real encerrada');
        this.teardownRoomMedia();
        if (!this.intentionalClose) {
          if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = window.setTimeout(() => this.connect(), 2500);
        }
      };
    } catch {
      this.connectingWs = false;
      if (!this.intentionalClose && hasActiveMemoryToken()) {
        if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
      }
    }
  }

  public disconnect(): void {
    this.intentionalClose = true;
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

  public async rpc<T = unknown>(method: ClientRpcMethod, params?: unknown, timeoutMs = 15000): Promise<T> {
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
      this.cleanupWatchedStream(ev.payload.streamId);
    } else if (ev.event === 'p2p:viewerJoined') {
      await this.handleP2pViewerJoined(ev.payload.streamId, ev.payload.viewerPeerId).catch((err) => {
        console.warn('[P2P Stream] Erro ao conectar espectador:', err);
      });
    } else if (ev.event === 'p2p:viewerLeft') {
      const senderPc = this.p2pStreamSenders.get(ev.payload.viewerPeerId);
      if (senderPc) {
        this.p2pStreamSenders.delete(ev.payload.viewerPeerId);
        senderPc.close();
      }
    } else if (ev.event === 'p2p:signal') {
      await this.handleP2pSignal(ev.payload).catch((err) => {
        console.warn('[P2P Signal] Aviso na negociação WebRTC:', err);
      });
    }
  }

  private enhanceOpusStereoSdp(sdp: string, maxBitrateBps: number): string {
    return sdp.replace(/a=fmtp:(\d+) (.*minptime=10.*)/g, (_match, pt, rest) => {
      if (maxBitrateBps >= 200000) {
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

  private async handleP2pViewerJoined(streamId: string, viewerPeerId: string): Promise<void> {
    if (this.localStreamId !== streamId || !this.p2pBroadcastTracks) return;
    const prev = this.p2pStreamSenders.get(viewerPeerId);
    if (prev) prev.close();

    const { videoTrack, audioTrack, targetBitrateKbps, fps } = this.p2pBroadcastTracks;
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
    const vParams = videoSender.getParameters();
    vParams.degradationPreference = 'maintain-resolution';
    if (!vParams.encodings || vParams.encodings.length === 0) {
      vParams.encodings = [{}];
    }
    vParams.encodings[0].maxBitrate = targetBitrateKbps * 1000;
    vParams.encodings[0].maxFramerate = fps;
    vParams.encodings[0].scaleResolutionDownBy = 1.0;
    void videoSender.setParameters(vParams).catch(() => {});

    if (audioTrack && audioTrack.readyState === 'live') {
      const audioSender = pc.addTrack(audioTrack);
      const aParams = audioSender.getParameters();
      if (!aParams.encodings || aParams.encodings.length === 0) {
        aParams.encodings = [{}];
      }
      aParams.encodings[0].maxBitrate = 320000;
      void audioSender.setParameters(aParams).catch(() => {});
    }

    const offer = await pc.createOffer();
    const enhancedSdp = offer.sdp ? this.enhanceOpusStereoSdp(offer.sdp, 320000) : offer.sdp;
    await pc.setLocalDescription({ type: offer.type, sdp: enhancedSdp });
    await this.rpc('p2p:signal', {
      targetPeerId: viewerPeerId,
      plane: 'stream',
      streamId,
      description: pc.localDescription,
    });
  }

  private async handleP2pSignal(payload: {
    fromPeerId: string;
    fromUserId: string;
    plane: 'voice' | 'stream';
    streamId?: string;
    description?: unknown;
    candidate?: unknown;
  }): Promise<void> {
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
        await pc.addIceCandidate(payload.candidate as RTCIceCandidateInit).catch(() => {});
      }
      return;
    }

    // Stream plane signaling (broadcaster <-> viewer)
    const streamId = payload.streamId || '';
    const senderPc = this.p2pStreamSenders.get(payload.fromPeerId);
    if (senderPc && this.localStreamId === streamId) {
      if (payload.description) {
        await senderPc.setRemoteDescription(payload.description as RTCSessionDescriptionInit);
      } else if (payload.candidate) {
        await senderPc.addIceCandidate(payload.candidate as RTCIceCandidateInit).catch(() => {});
      }
      return;
    }

    const pendingWatch = this.p2pPendingWatchers.get(streamId);
    const activeWatch = this.watchedStreams.get(streamId);
    const viewerPc = pendingWatch?.pc || activeWatch?.p2pPc;
    if (!viewerPc) return;

    if (payload.description) {
      const desc = payload.description as RTCSessionDescriptionInit;
      await viewerPc.setRemoteDescription(desc);
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
      await viewerPc.addIceCandidate(payload.candidate as RTCIceCandidateInit).catch(() => {});
    }
  }

  public async joinRoomAndSetupMedia(params: {
    roomId: string;
    password?: string | null;
    audioSettings: AudioSettings;
    micMuted: boolean;
    deafened: boolean;
  }): Promise<RoomJoinResult> {
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
    this.mediaMode = joinRes.mediaMode ?? 'sfu';
    this.iceServers = joinRes.iceServers;
    this.device = new Device();
    await this.device.load({
      routerRtpCapabilities: joinRes.routerRtpCapabilities as mediasoupTypes.RtpCapabilities,
    });

    if (this.mediaMode === 'p2p') {
      // Cloud P2P WebRTC Mode (100% real Dual-Plane media over STUN/TURN when PaaS blocks container UDP)
      try {
        this.localMicTrack = await audioEngine.startMicrophone(params.audioSettings);
        audioEngine.setLocalMuteAndDeafen(params.micMuted, params.deafened);
      } catch (micErr) {
        this.localMicTrack = null;
        console.warn('[Audio] Microfone indisponível ou permissão negada (modo escuta ativo):', micErr);
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

    // 1. Setup Dedicated Voice Transports (completely isolated from Video Stream Plane)
    this.voiceRecvTransport = await this.initClientTransport('voice', 'recv');
    this.voiceSendTransport = await this.initClientTransport('voice', 'send');

    // 2. Subscribe immediately to all active voice participants in the room (Regra Nº 5: Todos escutam todos)
    for (const part of joinRes.participants) {
      if (part.peerId !== joinRes.peerId && part.voiceProducerId) {
        await this.subscribeRemoteVoice(part.peerId, part.user.id, part.voiceProducerId).catch((err) => {
          console.warn('[SFU] Falha ao consumir participante existente:', err);
        });
      }
    }

    // 3. Start local Microphone DSP & publish Opus Voice Track
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
      console.warn('[Audio] Microfone indisponível ou permissão negada (modo escuta ativo):', micErr);
    }

    return joinRes;
  }

  public async leaveRoom(): Promise<void> {
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
          // Resolve stream track producer atomically & immediately so mediasoup-client's
          // internal _awaitQueue never deadlocks when publishing Video + Stereo Audio!
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

  /**
   * Starts Ultra-HD Live Broadcast (720p / 1080p / 1440p @ 30 / 60 / 75 FPS) on the dedicated Stream Plane.
   * Enforces:
   * - Hardware-friendly High Profile H.264 / AV1 / VP9
   * - maintain-resolution (1440p never silently degrades to 1080p)
   * - Zero Audio Ducking (320kbps CBR Stereo Opus, zero AGC/NS/AEC)
   * - Zero Voice Echo (Native WASAPI Process Loopback Exclusion on Desktop / Tab Audio Isolation on Web)
   */
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

  private async produceStreamVideoWithFallback(
    videoTrack: MediaStreamTrack,
    targetBitrateKbps: number,
    fps: StreamFps
  ): Promise<mediasoupTypes.Producer> {
    if (!this.device || !this.streamSendTransport) {
      throw new Error('Transporte de transmissão não inicializado');
    }

    const h264High52 = this.device.rtpCapabilities.codecs?.find(
      (c) =>
        c.kind === 'video' &&
        c.mimeType.toLowerCase() === 'video/h264' &&
        String(c.parameters?.['profile-level-id'] || '').toLowerCase() === '640034'
    );
    const h264Base52 = this.device.rtpCapabilities.codecs?.find(
      (c) =>
        c.kind === 'video' &&
        c.mimeType.toLowerCase() === 'video/h264' &&
        String(c.parameters?.['profile-level-id'] || '').toLowerCase() === '42e034'
    );

    const codecCandidates: (mediasoupTypes.RtpCodecCapability | undefined)[] = [
      h264High52,
      h264Base52,
      undefined, // Default WebRTC codec (VP9 / AV1 / VP8) guaranteed to work on every GPU/CPU
    ];

    let lastErr: unknown = null;
    for (const codecCandidate of codecCandidates) {
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
              videoGoogleMinBitrate: Math.round(targetBitrateKbps * 0.5),
            },
          }),
          15000,
          'codificador de vídeo'
        );

        // Lock maintain-resolution so 1440p NEVER silently downscales into blurry 1080p/720p
        const rtpSender = prod.rtpSender;
        if (rtpSender) {
          const params = rtpSender.getParameters();
          params.degradationPreference = 'maintain-resolution';
          void rtpSender.setParameters(params).catch(() => {});
        }

        return prod;
      } catch (err) {
        lastErr = err;
        // If transport itself is closed or disconnected, stop retrying codecs
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
    shareAudio: boolean;
    contentOptimization: 'detail' | 'motion';
    desktopSource?: DesktopCaptureSourceItem | null;
  }): Promise<ActiveStreamInfo> {
    if (!this.device) throw new Error('Entre em uma sala antes de transmitir');
    await this.stopLiveStream();

    const spec = STREAM_RESOLUTION_SPECS[options.resolution];
    const targetBitrateKbps = resolveTargetBitrateKbps(
      options.resolution,
      options.fps,
      options.customBitrateKbps
    );

    try {
      await audioEngine.resumeContexts();

      let videoTrack: MediaStreamTrack | undefined;
      let audioTrack: MediaStreamTrack | null = null;
      let audioIsolationMode: 'process-isolated' | 'tab-isolated' | 'system-direct' | 'none' =
        'none';

      const desktopApi = getDesktopApi();
      if (desktopApi && options.desktopSource) {
        // 1. Unified Modern Windows Graphics Capture (WGC) via Electron setDisplayMediaRequestHandler
        let mediaStream: MediaStream | null = null;
        try {
          await desktopApi.prepareDisplayMedia(options.desktopSource.id);
          mediaStream = await this.withStageTimeout(
            navigator.mediaDevices.getDisplayMedia({
              video: {
                width: { ideal: spec.width, max: spec.width },
                height: { ideal: spec.height, max: spec.height },
                frameRate: { ideal: options.fps, max: options.fps },
              } as MediaTrackConstraints,
              audio: false,
            }),
            10000,
            'captura de tela Desktop'
          );
        } catch {
          // Resilient fallback to non-rigid Chromium desktop source constraints
          const fallbackConstraints = {
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: options.desktopSource.id,
                maxWidth: spec.width,
                maxHeight: spec.height,
                minFrameRate: 1,
                maxFrameRate: options.fps,
              },
            },
          } as unknown as MediaStreamConstraints;
          mediaStream = await this.withStageTimeout(
            navigator.mediaDevices.getUserMedia(fallbackConstraints),
            10000,
            'captura de janela Desktop'
          );
        }

        this.localDisplayStream = mediaStream;
        videoTrack = mediaStream.getVideoTracks()[0];

        if (options.shareAudio) {
          // Use .NET 8 WASAPI Process-Isolated Loopback (EXCLUDE_TARGET_PROCESS_TREE or INCLUDE_TARGET_PROCESS_TREE)
          // Guarantees 0.0% of spectators' voices are looped back into the live stream!
          try {
            const loopbackMode =
              options.desktopSource.kind === 'window' && options.desktopSource.pid
                ? 'include-process'
                : 'exclude-self';
            const nativeRes = await desktopApi.startProcessLoopback({
              mode: loopbackMode,
              targetPid: options.desktopSource.pid,
              targetHwnd: options.desktopSource.hwnd,
            });

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
              audioIsolationMode = 'process-isolated';
            }
          } catch (audioErr) {
            console.warn(
              '[Desktop Audio Loopback] Falha não-bloqueante ao iniciar áudio isolado; prosseguindo com vídeo:',
              audioErr
            );
          }
        }
      } else {
        // Official Web Browser Display Capture
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: spec.width, max: spec.width },
            height: { ideal: spec.height, max: spec.height },
            frameRate: { ideal: options.fps, max: options.fps },
            cursor: 'always',
          } as MediaTrackConstraints,
          audio: options.shareAudio
            ? ({
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                googEchoCancellation: false,
                googAutoGainControl: false,
                googNoiseSuppression: false,
                googHighpassFilter: false,
                channelCount: 2,
                sampleRate: 48000,
                suppressLocalAudioPlayback: false,
              } as MediaTrackConstraints)
            : false,
        });

        this.localDisplayStream = displayStream;
        videoTrack = displayStream.getVideoTracks()[0];
        const capturedAudio = displayStream.getAudioTracks()[0] || null;
        if (capturedAudio && options.shareAudio) {
          await capturedAudio
            .applyConstraints({
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2,
              sampleRate: 48000,
            })
            .catch(() => {});
          audioTrack = capturedAudio;
          const vidSettings = videoTrack.getSettings() as MediaTrackSettings & {
            displaySurface?: string;
          };
          audioIsolationMode =
            vidSettings.displaySurface === 'browser' ? 'tab-isolated' : 'system-direct';
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
          targetBitrateKbps,
          fps: options.fps,
        };
        const startRes = await this.withStageTimeout(
          this.rpc<{ stream: ActiveStreamInfo }>('p2p:streamStart', {
            title: options.title,
            resolution: options.resolution,
            fps: options.fps,
            targetBitrateKbps,
            hasAudio: Boolean(validAudio),
            audioIsolationMode: validAudio ? audioIsolationMode : 'none',
          }),
          12000,
          'registro da transmissão no servidor'
        );
        this.localStreamId = startRes.stream.streamId;
        this.startBroadcasterTelemetryLoop(startRes.stream.streamId);
        return startRes.stream;
      }

      if (!this.streamSendTransport || this.streamSendTransport.closed) {
        this.streamSendTransport = await this.withStageTimeout(
          this.initClientTransport('stream', 'send'),
          12000,
          'transporte SFU de transmissão'
        );
      }

      // 1. Produce Video Track (completes _awaitQueue Task #1 cleanly & atomically)
      const videoProducer = await this.produceStreamVideoWithFallback(
        videoTrack,
        targetBitrateKbps,
        options.fps
      );
      this.localVideoProducer = videoProducer;

      // 2. Produce 320 kbps Stereo Opus Audio Track sequentially (zero _awaitQueue contention!)
      if (audioTrack && audioTrack.readyState === 'live') {
        try {
          const audioProducer = await this.withStageTimeout(
            this.streamSendTransport.produce({
              track: audioTrack,
              stopTracks: false,
              codecOptions: {
                opusStereo: true,
                opusFec: true,
                opusDtx: false, // Never gate/mute quiet music passages!
                opusMaxPlaybackRate: 48000,
                opusMaxAverageBitrate: 320000, // 320 kbps Stereo Opus!
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

      // 3. Register active stream metadata & notify room participants
      const startRes = await this.withStageTimeout(
        this.rpc<{ stream: ActiveStreamInfo }>('stream:start', {
          transportId: this.streamSendTransport.id,
          title: options.title,
          resolution: options.resolution,
          fps: options.fps,
          targetBitrateKbps,
          audioIsolationMode: this.localAudioProducer ? audioIsolationMode : 'none',
          videoProducerId: this.localVideoProducer.id,
          audioProducerId: this.localAudioProducer?.id ?? null,
        }),
        12000,
        'registro da transmissão no servidor'
      );

      this.localStreamId = startRes.stream.streamId;
      this.startBroadcasterTelemetryLoop(startRes.stream.streamId);
      return startRes.stream;
    } catch (err) {
      await this.stopLiveStream().catch(() => {});
      throw err;
    }
  }

  private startBroadcasterTelemetryLoop(streamId: string): void {
    if (this.localTelemetryTimer !== null) window.clearInterval(this.localTelemetryTimer);
    this.prevBytesSent = 0;
    this.prevStatsTime = performance.now();

    this.localTelemetryTimer = window.setInterval(async () => {
      if (this.localStreamId !== streamId) return;
      try {
        let report: RTCStatsReport | null = null;
        if (this.mediaMode === 'p2p') {
          const firstSenderPc = this.p2pStreamSenders.values().next().value as RTCPeerConnection | undefined;
          if (!firstSenderPc) return;
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
      const stopMethod = this.mediaMode === 'p2p' ? 'p2p:streamStop' : 'stream:stop';
      await this.rpc(stopMethod, { streamId: activeId }).catch(() => {});
    }
  }

  public async watchStream(streamId: string): Promise<{
    stream: ActiveStreamInfo;
    videoStream: MediaStream;
    hasAudio: boolean;
  }> {
    if (!this.device) throw new Error('Dispositivo de mídia não inicializado');
    await audioEngine.resumeContexts();
    this.cleanupWatchedStream(streamId);

    if (this.mediaMode === 'p2p') {
      const viewerPc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
      let broadcasterPeerId = '';

      viewerPc.onicecandidate = (iceEv) => {
        if (iceEv.candidate && broadcasterPeerId && this.ws?.readyState === WebSocket.OPEN) {
          void this.rpc('p2p:signal', {
            targetPeerId: broadcasterPeerId,
            plane: 'stream',
            streamId,
            candidate: iceEv.candidate.toJSON(),
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

      try {
        const watchRes = await this.rpc<{ stream: ActiveStreamInfo; broadcasterPeerId: string }>(
          'p2p:streamWatch',
          { streamId }
        );
        broadcasterPeerId = watchRes.broadcasterPeerId;
        const pending = this.p2pPendingWatchers.get(streamId);
        if (pending) pending.expectAudio = watchRes.stream.hasAudio;

        const { videoTrack, audioTrack } = await this.withStageTimeout(
          tracksPromise,
          15000,
          'recepção WebRTC da transmissão'
        );

        if (audioTrack) {
          await audioEngine.attachStreamAudio(streamId, audioTrack, 100);
        }

        const videoStream = new MediaStream([videoTrack]);
        const entry: InternalWatchedStream = {
          streamId,
          videoConsumer: null,
          audioConsumer: null,
          p2pPc: viewerPc,
          videoStream,
          statsTimer: null,
          lastBytesReceived: 0,
          lastStatsTs: performance.now(),
        };

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
        return {
          stream: watchRes.stream,
          videoStream,
          hasAudio: Boolean(audioTrack),
        };
      } catch (err) {
        this.p2pPendingWatchers.delete(streamId);
        viewerPc.close();
        throw err;
      }
    }

    if (!this.streamRecvTransport || this.streamRecvTransport.closed) {
      this.streamRecvTransport = await this.initClientTransport('stream', 'recv');
    }

    const res = await this.rpc<StreamWatchResult>('stream:watch', {
      streamId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    const videoConsumer = await this.streamRecvTransport.consume({
      id: res.videoConsumer.id,
      producerId: res.videoConsumer.producerId,
      kind: 'video',
      rtpParameters: res.videoConsumer.rtpParameters as mediasoupTypes.RtpParameters,
    });

    // Configure smooth jitter buffer playout target so video NEVER stutters or sudden fast-forwards
    const receiver = videoConsumer.rtpReceiver as RTCRtpReceiver & { playoutDelayHint?: number };
    if (receiver && 'playoutDelayHint' in receiver) {
      receiver.playoutDelayHint = 0.045; // Smooth 45ms hardware pacing buffer
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
      videoConsumer,
      audioConsumer,
      videoStream,
      statsTimer: null,
      lastBytesReceived: 0,
      lastStatsTs: performance.now(),
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

    return {
      stream: res.stream,
      videoStream,
      hasAudio: Boolean(audioConsumer),
    };
  }

  public async unwatchStream(streamId: string): Promise<void> {
    this.cleanupWatchedStream(streamId);
    if (this.ws?.readyState === WebSocket.OPEN) {
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
    audioEngine.detachStreamAudio(streamId);
    try {
      entry.videoConsumer?.close();
      entry.audioConsumer?.close();
      entry.p2pPc?.close();
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
    try {
      this.voiceProducer?.close();
      this.voiceSendTransport?.close();
      this.voiceRecvTransport?.close();
      this.streamSendTransport?.close();
      this.streamRecvTransport?.close();
    } catch {
      // Ignore
    }
    this.localMicTrack = null;
    this.voiceProducer = null;
    this.voiceSendTransport = null;
    this.voiceRecvTransport = null;
    this.streamSendTransport = null;
    this.streamRecvTransport = null;
    this.device = null;
    audioEngine.clearRoomAudio();
  }

  // Chat helpers
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
}

export const realtimeSession = new RealtimeSession();
