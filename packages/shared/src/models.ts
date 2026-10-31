import { z } from 'zod';
import { StreamFpsSchema, StreamResolutionSchema } from './media.js';
import { UserSettingsSchema } from './settings.js';

export const UserPublicSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

export const AuthUserSchema = UserPublicSchema.extend({
  email: z.string().email(),
  settings: UserSettingsSchema,
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

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
  username: z
    .string()
    .trim()
    .min(3, 'Nome de usuário precisa ter ao menos 3 caracteres')
    .max(28, 'Nome de usuário deve ter no máximo 28 caracteres')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Use apenas letras, números, ponto, hífen ou sublinhado'),
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
  title: z.string(),
  resolution: StreamResolutionSchema,
  fps: StreamFpsSchema,
  targetBitrateKbps: z.number(),
  hasAudio: z.boolean(),
  audioIsolationMode: z.enum(['process-isolated', 'tab-isolated', 'system-direct', 'none']),
  startedAt: z.string(),
  viewerCount: z.number().int().nonnegative(),
  viewerUsers: z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      avatarColor: z.string(),
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
      speaking: z.boolean(),
      isStreaming: z.boolean(),
    })
  ),
  activeStreamCount: z.number().int().nonnegative(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

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
  mentions: z.array(z.string()), // array of mentioned user IDs
  attachments: z.array(ChatAttachmentSchema),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deleted: z.boolean(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

