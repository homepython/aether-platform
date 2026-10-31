import { z } from 'zod';
import { StreamFpsSchema, StreamResolutionSchema } from './media.js';

export const PeerAudioOverrideSchema = z.object({
  volume: z.number().min(0).max(200).default(100),
  muted: z.boolean().default(false),
  noiseReductionEnabled: z.boolean().default(false),
  noiseReductionLevel: z.number().min(0).max(100).default(50),
});
export type PeerAudioOverride = z.infer<typeof PeerAudioOverrideSchema>;

export const OverlayPositionPresetSchema = z.enum([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'middle-left',
  'middle-right',
  'custom',
]);
export type OverlayPositionPreset = z.infer<typeof OverlayPositionPresetSchema>;

export const AudioSettingsSchema = z.object({
  inputDeviceId: z.string().default('default'),
  outputDeviceId: z.string().default('default'),
  inputVolume: z.number().min(0).max(200).default(100),
  outputVolume: z.number().min(0).max(200).default(100),
  voiceMode: z.enum(['vad', 'ptt']).default('vad'),
  vadSensitivityDb: z.number().min(-85).max(-5).default(-48),
  noiseSuppressionEnabled: z.boolean().default(true),
  noiseSuppressionLevel: z.number().min(0).max(100).default(80),
  noiseGateEnabled: z.boolean().default(true),
  noiseGateThresholdDb: z.number().min(-85).max(-10).default(-52),
  echoCancellationEnabled: z.boolean().default(true),
  pttKey: z.string().default('KeyV'),
  pttReleaseDelayMs: z.number().min(0).max(1000).default(180),
  peerOverrides: z.record(z.string(), PeerAudioOverrideSchema).default({}),
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

export const StreamSettingsSchema = z.object({
  resolution: StreamResolutionSchema.default('1080p'),
  fps: StreamFpsSchema.default(60),
  bitrateMode: z.enum(['auto', 'custom']).default('auto'),
  customBitrateKbps: z.number().min(2500).max(32000).nullable().default(null),
  shareAudio: z.boolean().default(true),
  contentOptimization: z.enum(['detail', 'motion']).default('detail'),
});
export type StreamSettings = z.infer<typeof StreamSettingsSchema>;

export const OverlaySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  position: OverlayPositionPresetSchema.default('top-left'),
  customX: z.number().min(0).max(10000).default(24),
  customY: z.number().min(0).max(10000).default(24),
  scale: z.number().min(0.7).max(1.6).default(1.0),
  opacity: z.number().min(0.2).max(1.0).default(0.88),
  showOnlySpeaking: z.boolean().default(false),
});
export type OverlaySettings = z.infer<typeof OverlaySettingsSchema>;

export const ShortcutSettingsSchema = z.object({
  toggleMute: z.string().default('Control+Shift+KeyM'),
  toggleDeafen: z.string().default('Control+Shift+KeyD'),
  pushToTalk: z.string().default('KeyV'),
  toggleOverlay: z.string().default('Alt+KeyO'),
  stopStream: z.string().default('Control+Shift+KeyS'),
});
export type ShortcutSettings = z.infer<typeof ShortcutSettingsSchema>;

export const AppSettingsSchema = z.object({
  autoStartOnBoot: z.boolean().default(false),
  minimizeToTrayOnClose: z.boolean().default(true),
  startMinimizedToTray: z.boolean().default(false),
  overlay: OverlaySettingsSchema.default({}),
  shortcuts: ShortcutSettingsSchema.default({}),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const NotificationSettingsSchema = z.object({
  soundEnabled: z.boolean().default(true),
  desktopNotifications: z.boolean().default(true),
  mentionAlerts: z.boolean().default(true),
  joinLeaveSounds: z.boolean().default(true),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const InterfaceSettingsSchema = z.object({
  theme: z.enum(['dark', 'light']).default('dark'),
  uiScale: z.number().min(0.85).max(1.25).default(1.0),
  glassEffects: z.boolean().default(true),
  smoothAnimations: z.boolean().default(true),
  notifications: NotificationSettingsSchema.default({}),
});
export type InterfaceSettings = z.infer<typeof InterfaceSettingsSchema>;

export const UserSettingsSchema = z.object({
  audio: AudioSettingsSchema.default({}),
  stream: StreamSettingsSchema.default({}),
  app: AppSettingsSchema.default({}),
  interface: InterfaceSettingsSchema.default({}),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = UserSettingsSchema.parse({});

