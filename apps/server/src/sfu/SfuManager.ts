import crypto from 'node:crypto';
import * as mediasoup from 'mediasoup';
import type {
  Consumer,
  DtlsParameters,
  Producer,
  Router,
  RouterRtpCodecCapability,
  RtpCapabilities,
  RtpParameters,
  TransportListenInfo,
  WebRtcTransport,
  Worker,
} from 'mediasoup/types';
import type {
  ActiveStreamInfo,
  StreamFps,
  StreamResolution,
  TransportDirection,
  TransportPlane,
  UserPublic,
} from '@aether/shared';
import { config } from '../config.js';

const ROUTER_MEDIA_CODECS: RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      minptime: 10,
      useinbandfec: 1,
      usedtx: 0,
      stereo: 1,
      'sprop-stereo': 1,
      maxaveragebitrate: 320000,
    },
  },
  // H.264 High Profile Level 5.2 (enables hardware NVENC/AMF/QSV at 2560x1440 @ 75 FPS)
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '640034',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 12000,
    },
  },
  // H.264 Constrained Baseline Level 5.2 (universal hardware compatibility)
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e034',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 10000,
    },
  },
  // AV1 next-gen high sharpness for UI & text at 1440p
  {
    kind: 'video',
    mimeType: 'video/AV1',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 10000,
    },
  },
  // VP9 Profile 0
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 0,
      'x-google-start-bitrate': 10000,
    },
  },
  // VP8 universal fallback
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 8000,
    },
  },
];

interface PeerMediaSession {
  peerId: string;
  roomId: string;
  user: UserPublic;
  transports: Map<string, { plane: TransportPlane; direction: TransportDirection; transport: WebRtcTransport }>;
  voiceProducer: Producer | null;
  pendingStreamProducers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  activeStreamId: string | null;
}

interface StreamViewerEntry {
  peerId: string;
  user: UserPublic;
  videoConsumer: Consumer;
  audioConsumer: Consumer | null;
}

interface ActiveStreamRecord {
  streamId: string;
  roomId: string;
  broadcasterPeerId: string;
  broadcaster: UserPublic;
  title: string;
  resolution: StreamResolution;
  fps: StreamFps;
  targetBitrateKbps: number;
  audioIsolationMode: 'process-isolated' | 'tab-isolated' | 'system-direct' | 'none';
  startedAt: string;
  videoProducer: Producer;
  audioProducer: Producer | null;
  viewers: Map<string, StreamViewerEntry>; // keyed by viewer peerId
  verifiedWidth?: number;
  verifiedHeight?: number;
  verifiedFps?: number;
  verifiedBitrateKbps?: number;
}

export class SfuManager {
  private workers: Worker[] = [];
  private nextWorkerIdx = 0;
  private roomRouters = new Map<string, Router>();
  private peers = new Map<string, PeerMediaSession>();
  private streams = new Map<string, ActiveStreamRecord>();

  public onStreamUpdated?: (stream: ActiveStreamInfo) => void;
  public onStreamStopped?: (roomId: string, streamId: string, broadcasterId: string) => void;

  async init(): Promise<void> {
    const count = config.mediasoup.numWorkers;
    for (let i = 0; i < count; i++) {
      const worker = await this.spawnWorker(i);
      this.workers.push(worker);
    }
    console.log(
      `[SFU] Initialized ${this.workers.length} native mediasoup C++ workers (ports ${config.mediasoup.rtcMinPort}-${config.mediasoup.rtcMaxPort}, announced=${config.mediasoup.announcedIp})`
    );
  }

  private async spawnWorker(slotIndex: number): Promise<Worker> {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: config.mediasoup.rtcMinPort,
      rtcMaxPort: config.mediasoup.rtcMaxPort,
    });

    worker.on('died', (err) => {
      console.error(`[SFU] Worker slot ${slotIndex} died unexpectedly:`, err);
      this.spawnWorker(slotIndex)
        .then((replacement) => {
          this.workers[slotIndex] = replacement;
        })
        .catch((spawnErr) => {
          console.error('[SFU] Failed to respawn worker:', spawnErr);
        });
    });

    return worker;
  }

  private pickWorker(): Worker {
    if (this.workers.length === 0) {
      throw new Error('Nenhum worker SFU ativo');
    }
    const worker = this.workers[this.nextWorkerIdx % this.workers.length];
    this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length;
    return worker;
  }

  async getOrCreateRoomRouter(roomId: string): Promise<Router> {
    const existing = this.roomRouters.get(roomId);
    if (existing && !existing.closed) return existing;

    const worker = this.pickWorker();
    const router = await worker.createRouter({ mediaCodecs: ROUTER_MEDIA_CODECS });
    this.roomRouters.set(roomId, router);
    return router;
  }

  registerPeer(peerId: string, roomId: string, user: UserPublic): void {
    this.cleanupPeer(peerId);
    this.peers.set(peerId, {
      peerId,
      roomId,
      user,
      transports: new Map(),
      voiceProducer: null,
      pendingStreamProducers: new Map(),
      consumers: new Map(),
      activeStreamId: null,
    });
  }

  private buildListenInfos(plane: TransportPlane): TransportListenInfo[] {
    const bufferSize = plane === 'stream' ? 8 * 1024 * 1024 : 1024 * 1024; // 8 MB UDP buffer for 1440p75 I-frames
    const infos: TransportListenInfo[] = [];

    const protocols: ('udp' | 'tcp')[] = ['udp'];
    if (config.mediasoup.enableTcp) protocols.push('tcp');

    for (const protocol of protocols) {
      infos.push({
        protocol,
        ip: config.mediasoup.listenIp,
        announcedAddress: config.mediasoup.announcedIp,
        sendBufferSize: bufferSize,
        recvBufferSize: bufferSize,
      });

      // Ensure zero-latency loopback candidate when clients & server run behind Hairpin-NAT or same host
      if (config.mediasoup.listenIp === '0.0.0.0' && config.mediasoup.announcedIp !== '127.0.0.1') {
        infos.push({
          protocol,
          ip: '127.0.0.1',
          sendBufferSize: bufferSize,
          recvBufferSize: bufferSize,
        });
      }
    }

    return infos;
  }

  async createTransport(
    peerId: string,
    plane: TransportPlane,
    direction: TransportDirection
  ): Promise<{
    id: string;
    iceParameters: unknown;
    iceCandidates: unknown[];
    dtlsParameters: unknown;
  }> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Sessão de mídia não encontrada na sala');

    const router = await this.getOrCreateRoomRouter(peer.roomId);

    // Replace existing transport for the same (plane, direction) if reconnecting
    for (const [id, entry] of peer.transports.entries()) {
      if (entry.plane === plane && entry.direction === direction) {
        entry.transport.close();
        peer.transports.delete(id);
      }
    }

    const transport = await router.createWebRtcTransport({
      listenInfos: this.buildListenInfos(plane),
      enableUdp: true,
      enableTcp: config.mediasoup.enableTcp,
      preferUdp: true,
      initialAvailableOutgoingBitrate:
        plane === 'stream' ? config.mediasoup.initialAvailableOutgoingBitrate : 1_500_000,
      maxIncomingBitrate: plane === 'stream' ? config.mediasoup.maxIncomingBitrate : 512_000,
      appData: { peerId, plane, direction },
    });

    peer.transports.set(transport.id, { plane, direction, transport });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(peerId: string, transportId: string, dtlsParameters: DtlsParameters): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Sessão não encontrada');
    const entry = peer.transports.get(transportId);
    if (!entry) throw new Error('Transporte WebRTC não encontrado');
    await entry.transport.connect({ dtlsParameters });
  }

  private findPeerTransport(
    peer: PeerMediaSession,
    plane: TransportPlane,
    direction: TransportDirection
  ): WebRtcTransport | null {
    for (const entry of peer.transports.values()) {
      if (entry.plane === plane && entry.direction === direction && !entry.transport.closed) {
        return entry.transport;
      }
    }
    return null;
  }

  async produceVoice(
    peerId: string,
    transportId: string,
    rtpParameters: RtpParameters
  ): Promise<{ producerId: string }> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Sessão não encontrada');
    const entry = peer.transports.get(transportId);
    if (!entry || entry.plane !== 'voice' || entry.direction !== 'send') {
      throw new Error('Transporte de envio de voz inválido');
    }

    if (peer.voiceProducer && !peer.voiceProducer.closed) {
      peer.voiceProducer.close();
    }

    const producer = await entry.transport.produce({
      kind: 'audio',
      rtpParameters,
      appData: { peerId, userId: peer.user.id, source: 'mic-audio' },
    });

    peer.voiceProducer = producer;
    producer.on('transportclose', () => {
      if (peer.voiceProducer?.id === producer.id) {
        peer.voiceProducer = null;
      }
    });

    return { producerId: producer.id };
  }

  closeVoice(peerId: string): string | null {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.voiceProducer) return null;
    const id = peer.voiceProducer.id;
    peer.voiceProducer.close();
    peer.voiceProducer = null;
    return id;
  }

  async consumeVoice(
    consumerPeerId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities
  ): Promise<{
    id: string;
    producerId: string;
    kind: 'audio';
    rtpParameters: RtpParameters;
  }> {
    const consumerPeer = this.peers.get(consumerPeerId);
    if (!consumerPeer) throw new Error('Sessão de recepção não encontrada');

    const router = await this.getOrCreateRoomRouter(consumerPeer.roomId);
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cliente incompatível com capacidades RTP do produtor de voz');
    }

    // Never consume own microphone (Regra Inquebrável Nº 4 — Zero Eco / Zero Loopback)
    if (consumerPeer.voiceProducer?.id === producerId) {
      throw new Error('Bloqueado: nunca consumir o próprio microfone');
    }

    const recvTransport = this.findPeerTransport(consumerPeer, 'voice', 'recv');
    if (!recvTransport) {
      throw new Error('Transporte de recepção de voz ainda não inicializado');
    }

    const consumer = await recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
      appData: { source: 'mic-audio' },
    });

    consumerPeer.consumers.set(consumer.id, consumer);
    const cleanup = () => {
      consumerPeer.consumers.delete(consumer.id);
    };
    consumer.on('transportclose', cleanup);
    consumer.on('producerclose', cleanup);

    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: 'audio',
      rtpParameters: consumer.rtpParameters,
    };
  }

  async resumeConsumer(peerId: string, consumerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const consumer = peer.consumers.get(consumerId);
    if (consumer && !consumer.closed && consumer.paused) {
      await consumer.resume();
    }
  }

  async produceStreamTrack(
    peerId: string,
    transportId: string,
    kind: 'video' | 'audio',
    rtpParameters: RtpParameters
  ): Promise<{ producerId: string }> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Sessão não encontrada');
    const entry = peer.transports.get(transportId);
    if (!entry || entry.plane !== 'stream' || entry.direction !== 'send') {
      throw new Error('Transporte de envio de transmissão inválido');
    }

    const producer = await entry.transport.produce({
      kind,
      rtpParameters,
      keyFrameRequestDelay: kind === 'video' ? 0 : undefined,
      appData: {
        peerId: peer.peerId,
        userId: peer.user.id,
        source: kind === 'video' ? 'stream-video' : 'stream-audio',
      },
    });

    peer.pendingStreamProducers.set(producer.id, producer);
    producer.on('transportclose', () => {
      peer.pendingStreamProducers.delete(producer.id);
    });

    return { producerId: producer.id };
  }

  async startStream(params: {
    peerId: string;
    transportId: string;
    title: string;
    resolution: StreamResolution;
    fps: StreamFps;
    targetBitrateKbps: number;
    audioIsolationMode: 'process-isolated' | 'tab-isolated' | 'system-direct' | 'none';
    videoProducerId?: string;
    audioProducerId?: string | null;
    videoRtpParameters?: RtpParameters;
    audioRtpParameters?: RtpParameters | null;
  }): Promise<ActiveStreamInfo> {
    const peer = this.peers.get(params.peerId);
    if (!peer) throw new Error('Sessão não encontrada');

    // Stop any previous stream by this peer cleanly without touching voice
    if (peer.activeStreamId) {
      this.stopStream(params.peerId, peer.activeStreamId);
    }

    const entry = peer.transports.get(params.transportId);
    if (!entry || entry.plane !== 'stream' || entry.direction !== 'send') {
      throw new Error('Transporte de envio de transmissão inválido');
    }

    let videoProducer: Producer;
    if (params.videoProducerId) {
      const stagedVideo = peer.pendingStreamProducers.get(params.videoProducerId);
      if (!stagedVideo || stagedVideo.closed || stagedVideo.kind !== 'video') {
        throw new Error('Produtor de vídeo da transmissão não encontrado ou fechado');
      }
      peer.pendingStreamProducers.delete(params.videoProducerId);
      videoProducer = stagedVideo;
    } else if (params.videoRtpParameters) {
      videoProducer = await entry.transport.produce({
        kind: 'video',
        rtpParameters: params.videoRtpParameters,
        keyFrameRequestDelay: 0,
        appData: { peerId: peer.peerId, userId: peer.user.id, source: 'stream-video' },
      });
    } else {
      throw new Error('Parâmetros de vídeo ausentes para iniciar transmissão');
    }

    let audioProducer: Producer | null = null;
    if (params.audioProducerId) {
      const stagedAudio = peer.pendingStreamProducers.get(params.audioProducerId);
      if (stagedAudio && !stagedAudio.closed && stagedAudio.kind === 'audio') {
        peer.pendingStreamProducers.delete(params.audioProducerId);
        audioProducer = stagedAudio;
      }
    } else if (params.audioRtpParameters) {
      audioProducer = await entry.transport.produce({
        kind: 'audio',
        rtpParameters: params.audioRtpParameters,
        appData: { peerId: peer.peerId, userId: peer.user.id, source: 'stream-audio' },
      });
    }

    // Close any leftover unattached pending producers for this peer
    for (const leftover of peer.pendingStreamProducers.values()) {
      if (!leftover.closed) leftover.close();
    }
    peer.pendingStreamProducers.clear();

    const streamId = crypto.randomUUID();
    const record: ActiveStreamRecord = {
      streamId,
      roomId: peer.roomId,
      broadcasterPeerId: peer.peerId,
      broadcaster: peer.user,
      title: params.title,
      resolution: params.resolution,
      fps: params.fps,
      targetBitrateKbps: params.targetBitrateKbps,
      audioIsolationMode: audioProducer ? params.audioIsolationMode : 'none',
      startedAt: new Date().toISOString(),
      videoProducer,
      audioProducer,
      viewers: new Map(),
    };

    this.streams.set(streamId, record);
    peer.activeStreamId = streamId;

    videoProducer.on('transportclose', () => {
      this.forceCloseStreamRecord(streamId);
    });

    return this.serializeStream(record);
  }

  updateStreamMeta(
    peerId: string,
    streamId: string,
    resolution: StreamResolution,
    fps: StreamFps,
    targetBitrateKbps: number
  ): ActiveStreamInfo | null {
    const record = this.streams.get(streamId);
    if (!record || record.broadcasterPeerId !== peerId) return null;
    record.resolution = resolution;
    record.fps = fps;
    record.targetBitrateKbps = targetBitrateKbps;
    return this.serializeStream(record);
  }

  updateStreamTelemetry(
    peerId: string,
    streamId: string,
    telemetry: {
      verifiedWidth: number;
      verifiedHeight: number;
      verifiedFps: number;
      verifiedBitrateKbps: number;
    }
  ): ActiveStreamInfo | null {
    const record = this.streams.get(streamId);
    if (!record || record.broadcasterPeerId !== peerId) return null;
    record.verifiedWidth = telemetry.verifiedWidth;
    record.verifiedHeight = telemetry.verifiedHeight;
    record.verifiedFps = Math.round(telemetry.verifiedFps * 10) / 10;
    record.verifiedBitrateKbps = Math.round(telemetry.verifiedBitrateKbps);
    return this.serializeStream(record);
  }

  stopStream(peerId: string, streamId: string): { roomId: string; broadcasterId: string } | null {
    const record = this.streams.get(streamId);
    if (!record || record.broadcasterPeerId !== peerId) return null;
    return this.forceCloseStreamRecord(streamId);
  }

  private forceCloseStreamRecord(streamId: string): { roomId: string; broadcasterId: string } | null {
    const record = this.streams.get(streamId);
    if (!record) return null;
    this.streams.delete(streamId);

    const broadcasterPeer = this.peers.get(record.broadcasterPeerId);
    if (broadcasterPeer && broadcasterPeer.activeStreamId === streamId) {
      broadcasterPeer.activeStreamId = null;
    }

    for (const viewer of record.viewers.values()) {
      if (!viewer.videoConsumer.closed) viewer.videoConsumer.close();
      if (viewer.audioConsumer && !viewer.audioConsumer.closed) viewer.audioConsumer.close();
    }
    record.viewers.clear();

    if (!record.videoProducer.closed) record.videoProducer.close();
    if (record.audioProducer && !record.audioProducer.closed) record.audioProducer.close();

    return { roomId: record.roomId, broadcasterId: record.broadcaster.id };
  }

  async watchStream(
    viewerPeerId: string,
    streamId: string,
    rtpCapabilities: RtpCapabilities
  ): Promise<{
    stream: ActiveStreamInfo;
    videoConsumer: { id: string; producerId: string; kind: 'video'; rtpParameters: RtpParameters };
    audioConsumer: { id: string; producerId: string; kind: 'audio'; rtpParameters: RtpParameters } | null;
  }> {
    const viewerPeer = this.peers.get(viewerPeerId);
    if (!viewerPeer) throw new Error('Sessão do espectador não encontrada');

    const record = this.streams.get(streamId);
    if (!record || record.roomId !== viewerPeer.roomId) {
      throw new Error('Transmissão não está ativa nesta sala');
    }

    // Broadcaster never watches their own stream (Regra do Transmissor + Regra Nº 4 Zero Loopback)
    if (record.broadcaster.id === viewerPeer.user.id || record.broadcasterPeerId === viewerPeerId) {
      throw new Error('O transmissor não consome a própria transmissão');
    }

    // Clean up existing viewer consumers if re-subscribing
    this.removeViewerInternal(record, viewerPeerId, false);

    const router = await this.getOrCreateRoomRouter(viewerPeer.roomId);
    if (!router.canConsume({ producerId: record.videoProducer.id, rtpCapabilities })) {
      throw new Error('Capacidades RTP incompatíveis para assistir à transmissão');
    }

    const recvTransport = this.findPeerTransport(viewerPeer, 'stream', 'recv');
    if (!recvTransport) {
      throw new Error('Transporte de recepção de transmissão não conectado');
    }

    const videoConsumer = await recvTransport.consume({
      producerId: record.videoProducer.id,
      rtpCapabilities,
      paused: false,
      appData: { streamId, source: 'stream-video' },
    });
    viewerPeer.consumers.set(videoConsumer.id, videoConsumer);

    // Request an immediate keyframe so the viewer gets crisp video instantaneously without gray/frozen start
    await videoConsumer.requestKeyFrame().catch(() => {});

    let audioConsumer: Consumer | null = null;
    if (
      record.audioProducer &&
      !record.audioProducer.closed &&
      router.canConsume({ producerId: record.audioProducer.id, rtpCapabilities })
    ) {
      audioConsumer = await recvTransport.consume({
        producerId: record.audioProducer.id,
        rtpCapabilities,
        paused: false,
        appData: { streamId, source: 'stream-audio' },
      });
      viewerPeer.consumers.set(audioConsumer.id, audioConsumer);
    }

    record.viewers.set(viewerPeerId, {
      peerId: viewerPeerId,
      user: viewerPeer.user,
      videoConsumer,
      audioConsumer,
    });

    const onClosed = () => {
      this.removeViewerInternal(record, viewerPeerId, true);
    };
    videoConsumer.on('transportclose', onClosed);
    videoConsumer.on('producerclose', onClosed);

    const serialized = this.serializeStream(record);
    return {
      stream: serialized,
      videoConsumer: {
        id: videoConsumer.id,
        producerId: videoConsumer.producerId,
        kind: 'video',
        rtpParameters: videoConsumer.rtpParameters,
      },
      audioConsumer: audioConsumer
        ? {
            id: audioConsumer.id,
            producerId: audioConsumer.producerId,
            kind: 'audio',
            rtpParameters: audioConsumer.rtpParameters,
          }
        : null,
    };
  }

  unwatchStream(viewerPeerId: string, streamId: string): ActiveStreamInfo | null {
    const record = this.streams.get(streamId);
    if (!record) return null;
    const removed = this.removeViewerInternal(record, viewerPeerId, false);
    if (!removed) return this.serializeStream(record);
    return this.serializeStream(record);
  }

  private removeViewerInternal(
    record: ActiveStreamRecord,
    viewerPeerId: string,
    emitCallback: boolean
  ): boolean {
    const entry = record.viewers.get(viewerPeerId);
    if (!entry) return false;
    record.viewers.delete(viewerPeerId);

    const viewerPeer = this.peers.get(viewerPeerId);
    if (viewerPeer) {
      viewerPeer.consumers.delete(entry.videoConsumer.id);
      if (entry.audioConsumer) viewerPeer.consumers.delete(entry.audioConsumer.id);
    }

    if (!entry.videoConsumer.closed) entry.videoConsumer.close();
    if (entry.audioConsumer && !entry.audioConsumer.closed) entry.audioConsumer.close();

    if (emitCallback && this.streams.has(record.streamId)) {
      this.onStreamUpdated?.(this.serializeStream(record));
    }
    return true;
  }

  listRoomStreams(roomId: string): ActiveStreamInfo[] {
    const list: ActiveStreamInfo[] = [];
    for (const record of this.streams.values()) {
      if (record.roomId === roomId) {
        list.push(this.serializeStream(record));
      }
    }
    return list;
  }

  countRoomStreams(roomId: string): number {
    let count = 0;
    for (const record of this.streams.values()) {
      if (record.roomId === roomId) count++;
    }
    return count;
  }

  getPeerVoiceProducerId(peerId: string): string | null {
    return this.peers.get(peerId)?.voiceProducer?.id ?? null;
  }

  hasPeerActiveStream(peerId: string): boolean {
    return Boolean(this.peers.get(peerId)?.activeStreamId);
  }

  cleanupPeer(peerId: string): {
    closedVoiceProducerId: string | null;
    stoppedStream: { roomId: string; streamId: string; broadcasterId: string } | null;
  } {
    const peer = this.peers.get(peerId);
    if (!peer) return { closedVoiceProducerId: null, stoppedStream: null };

    // Remove peer from any streams they were watching so real viewer count decrements immediately
    for (const record of this.streams.values()) {
      this.removeViewerInternal(record, peerId, true);
    }

    let stoppedStream: { roomId: string; streamId: string; broadcasterId: string } | null = null;
    if (peer.activeStreamId) {
      const sId = peer.activeStreamId;
      const closed = this.forceCloseStreamRecord(sId);
      if (closed) {
        stoppedStream = { roomId: closed.roomId, streamId: sId, broadcasterId: closed.broadcasterId };
      }
    }

    const closedVoiceProducerId = peer.voiceProducer ? peer.voiceProducer.id : null;
    if (peer.voiceProducer && !peer.voiceProducer.closed) {
      peer.voiceProducer.close();
    }

    for (const consumer of peer.consumers.values()) {
      if (!consumer.closed) consumer.close();
    }
    for (const { transport } of peer.transports.values()) {
      if (!transport.closed) transport.close();
    }

    this.peers.delete(peerId);
    return { closedVoiceProducerId, stoppedStream };
  }

  private serializeStream(record: ActiveStreamRecord): ActiveStreamInfo {
    // Deduplicate unique real authenticated users watching this live stream
    const uniqueUsers = new Map<
      string,
      { id: string; username: string; displayName: string; avatarColor: string }
    >();
    for (const v of record.viewers.values()) {
      if (!uniqueUsers.has(v.user.id)) {
        uniqueUsers.set(v.user.id, {
          id: v.user.id,
          username: v.user.username,
          displayName: v.user.displayName,
          avatarColor: v.user.avatarColor,
        });
      }
    }
    const viewerUsers = Array.from(uniqueUsers.values());

    return {
      streamId: record.streamId,
      roomId: record.roomId,
      broadcasterId: record.broadcaster.id,
      broadcasterUsername: record.broadcaster.username,
      broadcasterDisplayName: record.broadcaster.displayName,
      broadcasterAvatarColor: record.broadcaster.avatarColor,
      title: record.title,
      resolution: record.resolution,
      fps: record.fps,
      targetBitrateKbps: record.targetBitrateKbps,
      hasAudio: Boolean(record.audioProducer && !record.audioProducer.closed),
      audioIsolationMode: record.audioIsolationMode,
      startedAt: record.startedAt,
      viewerCount: viewerUsers.length,
      viewerUsers,
      videoProducerId: record.videoProducer.id,
      audioProducerId: record.audioProducer?.id ?? null,
      verifiedWidth: record.verifiedWidth,
      verifiedHeight: record.verifiedHeight,
      verifiedFps: record.verifiedFps,
      verifiedBitrateKbps: record.verifiedBitrateKbps,
    };
  }

  async close(): Promise<void> {
    for (const peerId of Array.from(this.peers.keys())) {
      this.cleanupPeer(peerId);
    }
    for (const router of this.roomRouters.values()) {
      if (!router.closed) router.close();
    }
    for (const worker of this.workers) {
      worker.close();
    }
    this.workers = [];
  }
}

