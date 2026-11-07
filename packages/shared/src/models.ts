import { z } from 'zod';
import {
  StreamConnectionModeSchema,
  StreamFpsSchema,
  StreamPrivacyModeSchema,
  StreamResolutionSchema,
} from './media.js';
import { UserSettingsSchema } from './settings.js';

export const USER_ROLES = ['owner', 'admin', 'moderator', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const UserRoleSchema = z.enum(USER_ROLES);

export const ROLE_RANK: Record<UserRole, number> = {
  member: 0,
  moderator: 10,
  admin: 50,
  owner: 100,
};

export function hasRoleAtLeast(role: UserRole | undefined | null, minRole: UserRole): boolean {
  const current = role && role in ROLE_RANK ? ROLE_RANK[role] : 0;
  return current >= ROLE_RANK[minRole];
}

export const USER_PRESENCE_STATUSES = ['online', 'busy', 'offline'] as const;
export type UserPresenceStatus = (typeof USER_PRESENCE_STATUSES)[number];
export const UserPresenceStatusSchema = z.enum(USER_PRESENCE_STATUSES);

export const USERNAME_MAX_CHANGES_PER_24H = 3;

export const UsernameSchema = z
  .string()
  .trim()
  .min(3, 'Nickname precisa ter ao menos 3 caracteres')
  .max(28, 'Nickname deve ter no máximo 28 caracteres')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Use apenas letras, números, ponto, hífen ou sublinhado');

export const UserPublicSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.string(),
  avatarUrl: z.string().nullable(),
  bio: z.string().default(''),
  presenceStatus: UserPresenceStatusSchema.default('online'),
  role: UserRoleSchema.default('member'),
  createdAt: z.string(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

export const AuthUserSchema = UserPublicSchema.extend({
  email: z.string().email(),
  settings: UserSettingsSchema,
  nicknameChangesLast24h: z.number().int().nonnegative().default(0),
  nicknameLockedUntil: z.string().nullable().default(null),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const UpdateProfileInputSchema = z.object({
  displayName: z.string().trim().min(2, 'Nome de exibição muito curto').max(40).optional(),
  username: UsernameSchema.optional(),
  bio: z.string().trim().max(240, 'A bio pode ter no máximo 240 caracteres').optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor de perfil inválida')
    .optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  presenceStatus: z.enum(['online', 'busy']).optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;

const COMMON_WEAK_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password123',
  'qwerty123',
  'admin123',
  'aether123',
  'senha123',
  'mudar123',
  'iloveyou',
]);

export const StrongPasswordSchema = z
  .string()
  .min(8, 'A senha deve ter pelo menos 8 caracteres')
  .max(128, 'A senha deve ter no máximo 128 caracteres')
  .refine((val) => /[a-z]/.test(val), {
    message: 'A senha deve conter pelo menos uma letra minúscula',
  })
  .refine((val) => /[A-Z]/.test(val), {
    message: 'A senha deve conter pelo menos uma letra maiúscula',
  })
  .refine((val) => /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(val), {
    message: 'A senha deve conter pelo menos um número ou símbolo especial',
  })
  .refine((val) => !COMMON_WEAK_PASSWORDS.has(val.toLowerCase()), {
    message: 'Esta senha é muito comum e insegura; escolha uma senha mais forte',
  });

export const RegisterInputSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().trim().min(2).max(40),
  email: z.string().trim().email('E-mail inválido').max(160),
  password: StrongPasswordSchema,
});
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

export const LoginInputSchema = z.object({
  identifier: z.string().trim().min(2, 'Informe seu e-mail ou nome de usuário'),
  password: z.string().min(1, 'Informe sua senha'),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const ActiveStreamInfoSchema = z.object({
  streamId: z.string(),
  roomId: z.string(),
  broadcasterId: z.string(),
  broadcasterUsername: z.string(),
  broadcasterDisplayName: z.string(),
  broadcasterAvatarColor: z.string(),
  broadcasterAvatarUrl: z.string().nullable().default(null),
  broadcasterRole: UserRoleSchema.default('member'),
  title: z.string(),
  resolution: StreamResolutionSchema,
  fps: StreamFpsSchema,
  targetBitrateKbps: z.number(),
  audioBitrateKbps: z.number().default(320),
  privacy: StreamPrivacyModeSchema.default('public'),
  viewerLimit: z.number().int().positive().nullable().default(null),
  connectionMode: StreamConnectionModeSchema.default('auto'),
  relayActive: z.boolean().default(false),
  hasAudio: z.boolean(),
  audioIsolationMode: z.enum(['process-isolated', 'multi-process', 'tab-isolated', 'system-direct', 'none']),
  startedAt: z.string(),
  viewerCount: z.number().int().nonnegative(),
  viewerUsers: z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      avatarColor: z.string(),
      avatarUrl: z.string().nullable().default(null),
      role: UserRoleSchema.default('member'),
    })
  ),
  videoProducerId: z.string(),
  audioProducerId: z.string().nullable(),
  verifiedWidth: z.number().optional(),
  verifiedHeight: z.number().optional(),
  verifiedFps: z.number().optional(),
  verifiedBitrateKbps: z.number().optional(),
});
export type ActiveStreamInfo = z.infer<typeof ActiveStreamInfoSchema>;

export const RoomParticipantSchema = z.object({
  peerId: z.string(),
  user: UserPublicSchema,
  joinedAt: z.string(),
  micMuted: z.boolean(),
  deafened: z.boolean(),
  speaking: z.boolean(),
  isStreaming: z.boolean(),
  voiceProducerId: z.string().nullable(),
  clientPlatform: z.enum(['web', 'desktop']),
});
export type RoomParticipant = z.infer<typeof RoomParticipantSchema>;

export const RoomSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  isPrivate: z.boolean(),
  hasPassword: z.boolean(),
  ownerId: z.string(),
  createdAt: z.string(),
  participantCount: z.number().int().nonnegative(),
  participantsPreview: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string(),
      avatarColor: z.string(),
      avatarUrl: z.string().nullable().default(null),
      role: UserRoleSchema.default('member'),
      speaking: z.boolean(),
      isStreaming: z.boolean(),
    })
  ),
  activeStreamCount: z.number().int().nonnegative(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const AdminUserRecordSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.string(),
  avatarUrl: z.string().nullable(),
  bio: z.string().default(''),
  role: UserRoleSchema,
  isBanned: z.boolean(),
  banReason: z.string().nullable(),
  isOnline: z.boolean(),
  currentRoomId: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminUserRecord = z.infer<typeof AdminUserRecordSchema>;

export const AdminAuditLogEntrySchema = z.object({
  id: z.string(),
  actorId: z.string(),
  actorUsername: z.string(),
  actorDisplayName: z.string(),
  actorRole: UserRoleSchema,
  action: z.string(),
  targetUserId: z.string().nullable(),
  targetUsername: z.string().nullable(),
  details: z.string(),
  createdAt: z.string(),
});
export type AdminAuditLogEntry = z.infer<typeof AdminAuditLogEntrySchema>;

export const AdminClaimOwnerInputSchema = z.object({
  masterKey: z.string().trim().min(8, 'Chave mestre muito curta').max(256),
});
export type AdminClaimOwnerInput = z.infer<typeof AdminClaimOwnerInputSchema>;

export const AdminUpdateRoleInputSchema = z.object({
  role: z.enum(['admin', 'moderator', 'member']),
});
export type AdminUpdateRoleInput = z.infer<typeof AdminUpdateRoleInputSchema>;

export const AdminBanUserInputSchema = z.object({
  banned: z.boolean(),
  reason: z.string().trim().max(240).optional().nullable(),
});
export type AdminBanUserInput = z.infer<typeof AdminBanUserInputSchema>;

export const CreateRoomInputSchema = z.object({
  name: z.string().trim().min(2, 'Nome da sala muito curto').max(48, 'Nome da sala muito longo'),
  description: z.string().trim().max(180).default(''),
  isPrivate: z.boolean().default(false),
  password: z.string().max(128).optional().nullable(),
});
export type CreateRoomInput = z.infer<typeof CreateRoomInputSchema>;

export const ChatAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  url: z.string(),
  isImage: z.boolean(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  author: UserPublicSchema,
  content: z.string(),
  mentions: z.array(z.string()),
  attachments: z.array(ChatAttachmentSchema),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deleted: z.boolean(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const FriendshipStatusSchema = z.enum([
  'pending_incoming',
  'pending_outgoing',
  'accepted',
]);
export type FriendshipStatus = z.infer<typeof FriendshipStatusSchema>;

export const FriendEntrySchema = z.object({
  friendshipId: z.string(),
  user: UserPublicSchema,
  status: FriendshipStatusSchema,
  isOnline: z.boolean(),
  presenceStatus: UserPresenceStatusSchema,
  currentRoomId: z.string().nullable(),
  currentRoomName: z.string().nullable(),
  isStreaming: z.boolean(),
  unreadDmCount: z.number().int().nonnegative().default(0),
  lastDmAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type FriendEntry = z.infer<typeof FriendEntrySchema>;

export const DirectMessageSchema = z.object({
  id: z.string(),
  conversationKey: z.string(),
  sender: UserPublicSchema,
  recipientId: z.string(),
  content: z.string(),
  mentions: z.array(z.string()),
  attachments: z.array(ChatAttachmentSchema),
  roomInvite: z
    .object({
      roomId: z.string(),
      roomName: z.string(),
    })
    .nullable()
    .default(null),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  readAt: z.string().nullable(),
  deleted: z.boolean(),
});
export type DirectMessage = z.infer<typeof DirectMessageSchema>;

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}
