import { z } from 'zod';
import {
  StreamFpsSchema,
  StreamResolutionSchema,
  TransportDirectionSchema,
  TransportPlaneSchema,
} from './media.js';
import type {
  ActiveStreamInfo,
  ChatMessage,
  IceServerConfig,
  RoomParticipant,
  RoomSummary,
} from './models.js';

export const ClientRpcMethodSchema = z.enum([
  'ping',
  'lobby:listRooms',
  'room:join',
  'room:leave',
  'voice:updateState',
  'sfu:createTransport',
  'sfu:connectTransport',
  'sfu:produceVoice',
  'sfu:produceStreamTrack',
  'sfu:closeVoice',
  'sfu:consumeVoice',
  'sfu:resumeConsumer',
  'stream:start',
  'stream:updateMeta',
  'stream:telemetry',
  'stream:stop',
  'stream:watch',
  'stream:unwatch',
  'p2p:voiceReady',
  'p2p:signal',
  'p2p:streamStart',
  'p2p:streamStop',
  'p2p:streamWatch',
  'p2p:streamUnwatch',
  'chat:send',
  'chat:edit',
  'chat:delete',
  'chat:history',
]);
export type ClientRpcMethod = z.infer<typeof ClientRpcMethodSchema>;

export const RoomJoinParamsSchema = z.object({
  roomId: z.string().min(1),
  password: z.string().optional().nullable(),
  clientPlatform: z.enum(['web', 'desktop']).default('web'),
  micMuted: z.boolean().default(false),
  deafened: z.boolean().default(false),
});

export const VoiceStateParamsSchema = z.object({
  micMuted: z.boolean(),
  deafened: z.boolean(),
  speaking: z.boolean(),
});

export const SfuCreateTransportParamsSchema = z.object({
  plane: TransportPlaneSchema,
  direction: TransportDirectionSchema,
});

export const SfuConnectTransportParamsSchema = z.object({
  transportId: z.string().min(1),
  dtlsParameters: z.any(),
});

export const SfuProduceVoiceParamsSchema = z.object({
  transportId: z.string().min(1),
  rtpParameters: z.any(),
});

export const SfuProduceStreamTrackParamsSchema = z.object({
  transportId: z.string().min(1),
  kind: z.enum(['video', 'audio']),
  rtpParameters: z.any(),
});

export const SfuConsumeVoiceParamsSchema = z.object({
  producerId: z.string().min(1),
  rtpCapabilities: z.any(),
});

export const SfuResumeConsumerParamsSchema = z.object({
  consumerId: z.string().min(1),
});

export const StreamStartParamsSchema = z
  .object({
    transportId: z.string().min(1),
    title: z.string().trim().min(1).max(80).default('Transmissão ao Vivo'),
    resolution: StreamResolutionSchema,
    fps: StreamFpsSchema,
    targetBitrateKbps: z.number().min(2000).max(35000),
    audioIsolationMode: z
      .enum(['process-isolated', 'tab-isolated', 'system-direct', 'none'])
      .default('none'),
    videoProducerId: z.string().min(1).optional(),
    audioProducerId: z.string().min(1).optional().nullable(),
    videoRtpParameters: z.any().optional(),
    audioRtpParameters: z.any().optional().nullable(),
  })
  .refine((d) => Boolean(d.videoProducerId || d.videoRtpParameters), {
    message: 'videoProducerId ou videoRtpParameters obrigatório',
  });

export const StreamUpdateMetaParamsSchema = z.object({
  streamId: z.string().min(1),
  resolution: StreamResolutionSchema,
  fps: StreamFpsSchema,
  targetBitrateKbps: z.number().min(2000).max(35000),
});

export const StreamTelemetryParamsSchema = z.object({
  streamId: z.string().min(1),
  verifiedWidth: z.number().int().nonnegative(),
  verifiedHeight: z.number().int().nonnegative(),
  verifiedFps: z.number().nonnegative(),
  verifiedBitrateKbps: z.number().nonnegative(),
});

export const StreamWatchParamsSchema = z.object({
  streamId: z.string().min(1),
  rtpCapabilities: z.any(),
});

export const StreamStopOrUnwatchParamsSchema = z.object({
  streamId: z.string().min(1),
});

export const P2pVoiceReadyParamsSchema = z.object({
  active: z.boolean(),
});

export const P2pSignalParamsSchema = z.object({
  targetPeerId: z.string().min(1),
  plane: z.enum(['voice', 'stream']),
  streamId: z.string().optional(),
  description: z.any().optional(),
  candidate: z.any().optional(),
});

export const P2pStreamStartParamsSchema = z.object({
  title: z.string().trim().min(1).max(80).default('Transmissão ao Vivo'),
  resolution: StreamResolutionSchema,
  fps: StreamFpsSchema,
  targetBitrateKbps: z.number().min(2000).max(35000),
  hasAudio: z.boolean().default(false),
  audioIsolationMode: z
    .enum(['process-isolated', 'tab-isolated', 'system-direct', 'none'])
    .default('none'),
});

export const ChatSendParamsSchema = z.object({
  roomId: z.string().min(1),
  content: z.string().max(4000),
  attachmentIds: z.array(z.string()).max(8).default([]),
});

export const ChatEditParamsSchema = z.object({
  messageId: z.string().min(1),
  content: z.string().trim().min(1).max(4000),
});

export const ChatDeleteParamsSchema = z.object({
  messageId: z.string().min(1),
});

export const ChatHistoryParamsSchema = z.object({
  roomId: z.string().min(1),
  beforeCreatedAt: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export interface ClientRpcRequest {
  type: 'rpc:req';
  reqId: string;
  method: ClientRpcMethod;
  params?: unknown;
}

export interface ServerRpcResponse<T = unknown> {
  type: 'rpc:res';
  reqId: string;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface RoomJoinResult {
  peerId: string;
  room: RoomSummary;
  participants: RoomParticipant[];
  activeStreams: ActiveStreamInfo[];
  routerRtpCapabilities: unknown;
  iceServers: IceServerConfig[];
  messages: ChatMessage[];
  mediaMode?: 'sfu' | 'p2p';
}

export interface TransportCreatedResult {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown[];
  dtlsParameters: unknown;
}

export interface StreamWatchResult {
  stream: ActiveStreamInfo;
  videoConsumer: {
    id: string;
    producerId: string;
    kind: 'video';
    rtpParameters: unknown;
  };
  audioConsumer: {
    id: string;
    producerId: string;
    kind: 'audio';
    rtpParameters: unknown;
  } | null;
}

export type ServerPushEvent =
  | { type: 'event'; event: 'connected'; payload: { peerId: string; serverTime: string } }
  | { type: 'event'; event: 'lobby:roomsUpdated'; payload: { rooms: RoomSummary[] } }
  | { type: 'event'; event: 'room:participantJoined'; payload: { roomId: string; participant: RoomParticipant } }
  | { type: 'event'; event: 'room:participantLeft'; payload: { roomId: string; peerId: string; userId: string } }
  | {
      type: 'event';
      event: 'room:participantUpdated';
      payload: {
        roomId: string;
        peerId: string;
        userId: string;
        micMuted: boolean;
        deafened: boolean;
        speaking: boolean;
        isStreaming: boolean;
        voiceProducerId: string | null;
      };
    }
  | {
      type: 'event';
      event: 'room:voiceProducerAvailable';
      payload: { roomId: string; peerId: string; userId: string; producerId: string };
    }
  | {
      type: 'event';
      event: 'room:voiceProducerClosed';
      payload: { roomId: string; peerId: string; producerId: string };
    }
  | { type: 'event'; event: 'room:streamStarted'; payload: { stream: ActiveStreamInfo } }
  | { type: 'event'; event: 'room:streamUpdated'; payload: { stream: ActiveStreamInfo } }
  | {
      type: 'event';
      event: 'room:streamStopped';
      payload: { roomId: string; streamId: string; broadcasterId: string };
    }
  | { type: 'event'; event: 'chat:messageCreated'; payload: { message: ChatMessage } }
  | { type: 'event'; event: 'chat:messageUpdated'; payload: { message: ChatMessage } }
  | { type: 'event'; event: 'chat:messageDeleted'; payload: { roomId: string; messageId: string } }
  | {
      type: 'event';
      event: 'notification:mention';
      payload: { roomId: string; roomName: string; message: ChatMessage };
    }
  | {
      type: 'event';
      event: 'p2p:signal';
      payload: {
        fromPeerId: string;
        fromUserId: string;
        plane: 'voice' | 'stream';
        streamId?: string;
        description?: unknown;
        candidate?: unknown;
      };
    }
  | {
      type: 'event';
      event: 'p2p:viewerJoined';
      payload: { streamId: string; viewerPeerId: string };
    }
  | {
      type: 'event';
      event: 'p2p:viewerLeft';
      payload: { streamId: string; viewerPeerId: string };
    };

