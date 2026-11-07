import { z } from 'zod';
import {
  StreamConnectionModeSchema,
  StreamFpsSchema,
  StreamPrivacyModeSchema,
  StreamResolutionSchema,
  TransportDirectionSchema,
  TransportPlaneSchema,
} from './media.js';
import type {
  ActiveStreamInfo,
  ChatMessage,
  DirectMessage,
  FriendEntry,
  IceServerConfig,
  RoomParticipant,
  RoomSummary,
  UserPublic,
  UserRole,
} from './models.js';

export const ClientRpcMethodSchema = z.enum([
  'ping',
  'lobby:listRooms',
  'room:join',
  'room:leave',
  'room:syncState',
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
  'stream:relayStart',
  'stream:relayInitSegment',
  'stream:relayStop',
  'stream:relayWatch',
  'stream:relayUnwatch',
  'chat:send',
  'chat:edit',
  'chat:delete',
  'chat:history',
  'friends:list',
  'friends:request',
  'friends:respond',
  'friends:remove',
  'friends:inviteToRoom',
  'dm:history',
  'dm:send',
  'dm:edit',
  'dm:delete',
  'dm:typing',
  'dm:markRead',
  'admin:kickParticipant',
  'admin:forceMuteParticipant',
  'admin:forceStopStream',
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

export const AudioIsolationModeSchema = z.enum([
  'process-isolated',
  'multi-process',
  'tab-isolated',
  'system-direct',
  'none',
]);
export type AudioIsolationMode = z.infer<typeof AudioIsolationModeSchema>;

export const StreamStartParamsSchema = z
  .object({
    transportId: z.string().min(1),
    title: z.string().trim().min(1).max(80).default('Transmissão ao Vivo'),
    resolution: StreamResolutionSchema,
    fps: StreamFpsSchema,
    targetBitrateKbps: z.number().min(300).max(60000),
    audioBitrateKbps: z.number().min(32).max(510).default(320),
    privacy: StreamPrivacyModeSchema.default('public'),
    allowedUserIds: z.array(z.string()).max(200).default([]),
    viewerLimit: z.number().int().min(1).max(500).nullable().default(null),
    connectionMode: StreamConnectionModeSchema.default('auto'),
    audioIsolationMode: AudioIsolationModeSchema.default('none'),
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
  resolution: StreamResolutionSchema.optional(),
  fps: StreamFpsSchema.optional(),
  targetBitrateKbps: z.number().min(300).max(60000).optional(),
  audioBitrateKbps: z.number().min(32).max(510).optional(),
  privacy: StreamPrivacyModeSchema.optional(),
  viewerLimit: z.number().int().min(1).max(500).nullable().optional(),
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
  targetBitrateKbps: z.number().min(300).max(60000),
  audioBitrateKbps: z.number().min(32).max(510).default(320),
  privacy: StreamPrivacyModeSchema.default('public'),
  allowedUserIds: z.array(z.string()).max(200).default([]),
  viewerLimit: z.number().int().min(1).max(500).nullable().default(null),
  connectionMode: StreamConnectionModeSchema.default('auto'),
  hasAudio: z.boolean().default(false),
  audioIsolationMode: AudioIsolationModeSchema.default('none'),
});

export const StreamRelayStartParamsSchema = z.object({
  streamId: z.string().min(1),
  mimeType: z.string().min(3).max(160),
});

export const StreamRelayInitParamsSchema = z.object({
  streamId: z.string().min(1),
  base64Init: z.string().min(1).max(2_000_000),
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

export const FriendRequestParamsSchema = z.object({
  username: z.string().trim().min(2).max(40),
});

export const FriendRespondParamsSchema = z.object({
  friendshipId: z.string().min(1),
  accept: z.boolean(),
});

export const FriendRemoveParamsSchema = z.object({
  friendshipId: z.string().min(1),
});

export const FriendInviteToRoomParamsSchema = z.object({
  targetUserId: z.string().min(1),
  roomId: z.string().min(1),
});

export const DmHistoryParamsSchema = z.object({
  peerUserId: z.string().min(1),
  beforeCreatedAt: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(60),
});

export const DmSendParamsSchema = z.object({
  recipientId: z.string().min(1),
  content: z.string().max(4000),
  attachmentIds: z.array(z.string()).max(8).default([]),
  roomInvite: z
    .object({
      roomId: z.string().min(1),
      roomName: z.string().min(1).max(80),
    })
    .optional()
    .nullable(),
});

export const DmEditParamsSchema = z.object({
  messageId: z.string().min(1),
  content: z.string().trim().min(1).max(4000),
});

export const DmDeleteParamsSchema = z.object({
  messageId: z.string().min(1),
});

export const DmTypingParamsSchema = z.object({
  recipientId: z.string().min(1),
  typing: z.boolean(),
});

export const DmMarkReadParamsSchema = z.object({
  peerUserId: z.string().min(1),
});

export const AdminKickParticipantParamsSchema = z.object({
  peerId: z.string().min(1),
  reason: z.string().trim().max(200).optional(),
});

export const AdminForceMuteParticipantParamsSchema = z.object({
  peerId: z.string().min(1),
});

export const AdminForceStopStreamParamsSchema = z.object({
  streamId: z.string().min(1),
  reason: z.string().trim().max(200).optional(),
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
  | {
      type: 'event';
      event: 'room:stateSynced';
      payload: {
        roomId: string;
        room: RoomSummary;
        participants: RoomParticipant[];
        activeStreams: ActiveStreamInfo[];
      };
    }
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
  | {
      type: 'event';
      event: 'stream:relayReady';
      payload: { streamId: string; mimeType: string; base64Init?: string | null };
    }
  | {
      type: 'event';
      event: 'stream:relayViewerNeeded';
      payload: { streamId: string };
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
    }
  | {
      type: 'event';
      event: 'user:roleUpdated';
      payload: {
        userId: string;
        username: string;
        displayName: string;
        role: UserRole;
      };
    }
  | {
      type: 'event';
      event: 'user:profileUpdated';
      payload: {
        user: UserPublic;
      };
    }
  | {
      type: 'event';
      event: 'friends:updated';
      payload: {
        friends?: FriendEntry[];
        reason: string;
      };
    }
  | {
      type: 'event';
      event: 'friends:roomInvite';
      payload: {
        fromUser: UserPublic;
        roomId: string;
        roomName: string;
      };
    }
  | {
      type: 'event';
      event: 'dm:messageCreated';
      payload: {
        message: DirectMessage;
      };
    }
  | {
      type: 'event';
      event: 'dm:messageUpdated';
      payload: {
        message: DirectMessage;
      };
    }
  | {
      type: 'event';
      event: 'dm:messageDeleted';
      payload: {
        messageId: string;
        conversationKey: string;
      };
    }
  | {
      type: 'event';
      event: 'dm:typing';
      payload: {
        fromUserId: string;
        typing: boolean;
      };
    }
  | {
      type: 'event';
      event: 'dm:read';
      payload: {
        byUserId: string;
        readAt: string;
      };
    }
  | {
      type: 'event';
      event: 'admin:kickedFromRoom';
      payload: {
        roomId: string;
        roomName: string;
        reason: string;
        byDisplayName: string;
      };
    }
  | {
      type: 'event';
      event: 'admin:forceMuted';
      payload: {
        roomId: string;
        byDisplayName: string;
      };
    }
  | {
      type: 'event';
      event: 'admin:accountBanned';
      payload: {
        reason: string;
      };
    };
