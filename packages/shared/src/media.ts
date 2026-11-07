import { z } from 'zod';

/**
 * Complete Studio & Standard live stream resolutions.
 * Supports 360p, 480p, 720p, 1080p, 1440p (2K), and native Original resolution.
 */
export const STREAM_RESOLUTIONS = [
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  'original',
] as const;
export type StreamResolution = (typeof STREAM_RESOLUTIONS)[number];
export const StreamResolutionSchema = z.enum(STREAM_RESOLUTIONS);

/**
 * Complete Studio & Gaming frame rates (5 FPS presentation up to 144 FPS eSports).
 */
export const STREAM_FPS_OPTIONS = [5, 30, 60, 75, 100, 120, 144] as const;
export type StreamFps = (typeof STREAM_FPS_OPTIONS)[number];
export const StreamFpsSchema = z.union([
  z.literal(5),
  z.literal(30),
  z.literal(60),
  z.literal(75),
  z.literal(100),
  z.literal(120),
  z.literal(144),
]);

export const STREAM_PROFILES = [
  'auto',
  '720p',
  '1080p',
  '1440p',
  'original',
  'presentation',
] as const;
export type StreamProfile = (typeof STREAM_PROFILES)[number];
export const StreamProfileSchema = z.enum(STREAM_PROFILES);

export const STREAM_PRIVACY_MODES = ['public', 'friends', 'private'] as const;
export type StreamPrivacyMode = (typeof STREAM_PRIVACY_MODES)[number];
export const StreamPrivacyModeSchema = z.enum(STREAM_PRIVACY_MODES);

export const STREAM_CONNECTION_MODES = [
  'auto',
  'quality',
  'performance',
  'compatibility',
] as const;
export type StreamConnectionMode = (typeof STREAM_CONNECTION_MODES)[number];
export const StreamConnectionModeSchema = z.enum(STREAM_CONNECTION_MODES);

export const STREAM_AUDIO_BITRATE_PRESETS = [64, 96, 128, 192, 256, 320] as const;
export const STREAM_VIDEO_BITRATE_PRESETS = [1000, 2000, 5000, 8000, 12000, 20000, 26000] as const;
export const STREAM_VIEWER_LIMIT_PRESETS = [2, 5, 10, 25, 50, 100] as const;

export interface ResolutionSpec {
  id: StreamResolution;
  label: string;
  sublabel: string;
  width: number; // 0 indicates native monitor/window source dimensions ('original')
  height: number;
  minBitrateKbps: number;
  maxBitrateKbps: number;
  targetBitrateByFpsKbps: Record<StreamFps, number>;
}

export const STREAM_RESOLUTION_SPECS: Record<StreamResolution, ResolutionSpec> = {
  '360p': {
    id: '360p',
    label: '360p Economia',
    sublabel: '640 × 360 • Ultra Leve para Redes Lentas',
    width: 640,
    height: 360,
    minBitrateKbps: 300,
    maxBitrateKbps: 60000,
    targetBitrateByFpsKbps: {
      5: 450,
      30: 1000,
      60: 1600,
      75: 1900,
      100: 2300,
      120: 2600,
      144: 3000,
    },
  },
  '480p': {
    id: '480p',
    label: '480p SD',
    sublabel: '854 × 480 • Baixo Consumo de Banda',
    width: 854,
    height: 480,
    minBitrateKbps: 400,
    maxBitrateKbps: 60000,
    targetBitrateByFpsKbps: {
      5: 650,
      30: 1800,
      60: 2800,
      75: 3300,
      100: 4000,
      120: 4500,
      144: 5000,
    },
  },
  '720p': {
    id: '720p',
    label: '720p HD',
    sublabel: '1280 × 720 • Fluidez Ideal em Jogos Pesados',
    width: 1280,
    height: 720,
    minBitrateKbps: 500,
    maxBitrateKbps: 60000,
    targetBitrateByFpsKbps: {
      5: 1200,
      30: 4000,
      60: 6000,
      75: 7500,
      100: 9000,
      120: 10500,
      144: 12000,
    },
  },
  '1080p': {
    id: '1080p',
    label: '1080p Full HD',
    sublabel: '1920 × 1080 • Alta Definição Cristalina',
    width: 1920,
    height: 1080,
    minBitrateKbps: 800,
    maxBitrateKbps: 60000,
    targetBitrateByFpsKbps: {
      5: 2200,
      30: 8000,
      60: 12000,
      75: 15000,
      100: 18000,
      120: 20000,
      144: 22000,
    },
  },
  '1440p': {
    id: '1440p',
    label: '1440p 2K QHD',
    sublabel: '2560 × 1440 • Ultra Nitidez para Texto e Jogos',
    width: 2560,
    height: 1440,
    minBitrateKbps: 1000,
    maxBitrateKbps: 60000,
    targetBitrateByFpsKbps: {
      5: 4000,
      30: 16000,
      60: 22000,
      75: 26000,
      100: 29000,
      120: 32000,
      144: 35000,
    },
  },
  original: {
    id: 'original',
    label: 'Original (Nativa)',
    sublabel: 'Resolução Exata da Tela / Janela • Sem Escalonamento',
    width: 0,
    height: 0,
    minBitrateKbps: 500,
    maxBitrateKbps: 60000,
    targetBitrateByFpsKbps: {
      5: 3500,
      30: 12000,
      60: 18000,
      75: 22000,
      100: 26000,
      120: 30000,
      144: 34000,
    },
  },
};

export function resolveTargetBitrateKbps(
  resolution: StreamResolution,
  fps: StreamFps,
  customBitrateKbps?: number | null
): number {
  const spec = STREAM_RESOLUTION_SPECS[resolution] ?? STREAM_RESOLUTION_SPECS['1080p'];
  if (
    typeof customBitrateKbps === 'number' &&
    Number.isFinite(customBitrateKbps) &&
    customBitrateKbps > 0
  ) {
    // Allow full manual user control within safe WebRTC transport limits (300 Kbps .. 60,000 Kbps)
    return Math.max(300, Math.min(60000, Math.round(customBitrateKbps)));
  }
  return spec.targetBitrateByFpsKbps[fps] ?? 8000;
}

export function resolveTargetAudioBitrateKbps(customAudioBitrateKbps?: number | null): number {
  if (
    typeof customAudioBitrateKbps === 'number' &&
    Number.isFinite(customAudioBitrateKbps) &&
    customAudioBitrateKbps > 0
  ) {
    return Math.max(32, Math.min(510, Math.round(customAudioBitrateKbps)));
  }
  return 320;
}

export const TRANSPORT_PLANE = ['voice', 'stream'] as const;
export type TransportPlane = (typeof TRANSPORT_PLANE)[number];
export const TransportPlaneSchema = z.enum(TRANSPORT_PLANE);

export const TRANSPORT_DIRECTION = ['send', 'recv'] as const;
export type TransportDirection = (typeof TRANSPORT_DIRECTION)[number];
export const TransportDirectionSchema = z.enum(TRANSPORT_DIRECTION);

export const MEDIA_TRACK_KIND_SOURCE = [
  'mic-audio',
  'stream-video',
  'stream-audio',
] as const;
export type MediaTrackSource = (typeof MEDIA_TRACK_KIND_SOURCE)[number];
export const MediaTrackSourceSchema = z.enum(MEDIA_TRACK_KIND_SOURCE);
