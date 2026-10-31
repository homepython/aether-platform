import { z } from 'zod';

/**
 * Strictly permitted live stream resolutions (Regra de Qualidade de Transmissão).
 * Only 720p, 1080p, and 1440p (2K) exist in the protocol and UI.
 */
export const STREAM_RESOLUTIONS = ['720p', '1080p', '1440p'] as const;
export type StreamResolution = (typeof STREAM_RESOLUTIONS)[number];
export const StreamResolutionSchema = z.enum(STREAM_RESOLUTIONS);

/**
 * Strictly permitted live stream frame rates.
 * Only 30, 60, and 75 FPS exist in the protocol and UI.
 */
export const STREAM_FPS_OPTIONS = [30, 60, 75] as const;
export type StreamFps = (typeof STREAM_FPS_OPTIONS)[number];
export const StreamFpsSchema = z.union([z.literal(30), z.literal(60), z.literal(75)]);

export interface ResolutionSpec {
  id: StreamResolution;
  label: string;
  sublabel: string;
  width: number;
  height: number;
  minBitrateKbps: number;
  maxBitrateKbps: number;
  targetBitrateByFpsKbps: Record<StreamFps, number>;
}

export const STREAM_RESOLUTION_SPECS: Record<StreamResolution, ResolutionSpec> = {
  '720p': {
    id: '720p',
    label: '720p HD',
    sublabel: '1280 × 720 • Eficiente e Nítido',
    width: 1280,
    height: 720,
    minBitrateKbps: 2500,
    maxBitrateKbps: 10000,
    targetBitrateByFpsKbps: {
      30: 4000,
      60: 6000,
      75: 7500,
    },
  },
  '1080p': {
    id: '1080p',
    label: '1080p Full HD',
    sublabel: '1920 × 1080 • Alta Definição Cristalina',
    width: 1920,
    height: 1080,
    minBitrateKbps: 5000,
    maxBitrateKbps: 20000,
    targetBitrateByFpsKbps: {
      30: 8000,
      60: 12000,
      75: 15000,
    },
  },
  '1440p': {
    id: '1440p',
    label: '1440p 2K QHD',
    sublabel: '2560 × 1440 • Ultra Nitidez para Texto e Jogos',
    width: 2560,
    height: 1440,
    minBitrateKbps: 10000,
    maxBitrateKbps: 32000,
    targetBitrateByFpsKbps: {
      30: 16000,
      60: 22000,
      75: 26000,
    },
  },
};

export function resolveTargetBitrateKbps(
  resolution: StreamResolution,
  fps: StreamFps,
  customBitrateKbps?: number | null
): number {
  const spec = STREAM_RESOLUTION_SPECS[resolution];
  if (typeof customBitrateKbps === 'number' && Number.isFinite(customBitrateKbps) && customBitrateKbps > 0) {
    return Math.max(spec.minBitrateKbps, Math.min(spec.maxBitrateKbps, Math.round(customBitrateKbps)));
  }
  return spec.targetBitrateByFpsKbps[fps];
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

