import React, { useEffect, useState } from 'react';
import {
  AppWindow,
  Loader2,
  Monitor,
  Music2,
  Radio,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  STREAM_FPS_OPTIONS,
  STREAM_RESOLUTIONS,
  STREAM_RESOLUTION_SPECS,
  resolveTargetBitrateKbps,
  type StreamFps,
  type StreamResolution,
} from '@aether/shared';
import {
  getDesktopApi,
  type DesktopCaptureSourceItem,
} from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';

export const StreamLauncherModal: React.FC = () => {
  const open = useAppStore((s) => s.streamLauncherOpen);
  const setOpen = useAppStore((s) => s.setStreamLauncherOpen);
  const streamSettings = useAppStore((s) => s.settings.stream);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const startBroadcast = useAppStore((s) => s.startBroadcast);

  const desktopApi = getDesktopApi();

  const [title, setTitle] = useState('Transmissão ao Vivo');
  const [resolution, setResolution] = useState<StreamResolution>(streamSettings.resolution);
  const [fps, setFps] = useState<StreamFps>(streamSettings.fps);
  const [shareAudio, setShareAudio] = useState<boolean>(streamSettings.shareAudio);
  const [contentOptimization, setContentOptimization] = useState<'detail' | 'motion'>(
    streamSettings.contentOptimization
  );

  const [sources, setSources] = useState<DesktopCaptureSourceItem[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<'window' | 'screen'>('window');
  const [loadingSources, setLoadingSources] = useState(false);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResolution(streamSettings.resolution);
    setFps(streamSettings.fps);
    setShareAudio(streamSettings.shareAudio);
    setContentOptimization(
      streamSettings.resolution === '1440p' ? streamSettings.contentOptimization : 'motion'
    );
    setError(null);

    if (desktopApi) {
      void refreshSources();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const refreshSources = async () => {
    if (!desktopApi) return;
    setLoadingSources(true);
    try {
      const list = await desktopApi.listCaptureSources();
      setSources(list);
      if (list.length > 0 && !selectedSourceId) {
        const firstWin = list.find((s) => s.kind === 'window');
        setSelectedSourceId((firstWin || list[0]).id);
        setSourceTab(firstWin ? 'window' : 'screen');
      }
    } catch {
      // Ignore
    } finally {
      setLoadingSources(false);
    }
  };

  if (!open) return null;

  const targetKbps = resolveTargetBitrateKbps(
    resolution,
    fps,
    streamSettings.bitrateMode === 'custom' ? streamSettings.customBitrateKbps : null
  );

  const filteredDesktopSources = sources.filter((s) => s.kind === sourceTab);
  const chosenSource = sources.find((s) => s.id === selectedSourceId) || null;

  const handleStart = async () => {
    setError(null);
    if (desktopApi && !chosenSource) {
      setError('Selecione uma tela ou janela de jogo para transmitir.');
      return;
    }

    setStarting(true);
    try {
      // Persist preferred stream defaults
      updateSettings((prev) => ({
        ...prev,
        stream: {
          ...prev.stream,
          resolution,
          fps,
          shareAudio,
          contentOptimization,
        },
      }));

      await startBroadcast({
        title: title.trim() || chosenSource?.name || 'Transmissão ao Vivo',
        resolution,
        fps,
        customBitrateKbps:
          streamSettings.bitrateMode === 'custom' ? streamSettings.customBitrateKbps : null,
        shareAudio,
        contentOptimization,
        desktopSource: chosenSource,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancelado ou falha ao iniciar transmissão');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-6 py-4"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Configurar Transmissão ao Vivo</h2>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Hardware H.264 High L5.2 / AV1 • Volume integral sem Audio Ducking
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-xl transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {/* Desktop Source Picker */}
          {desktopApi && (
            <div>
              <div className="mb-2.5 flex items-center justify-between">
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSourceTab('window')}
                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all"
                    style={{
                      backgroundColor: sourceTab === 'window' ? 'var(--accent)' : 'var(--bg-elevated)',
                      color: sourceTab === 'window' ? '#ffffff' : 'var(--text-secondary)',
                    }}
                  >
                    <AppWindow className="h-3.5 w-3.5" />
                    Jogos & Janelas
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceTab('screen')}
                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all"
                    style={{
                      backgroundColor: sourceTab === 'screen' ? 'var(--accent)' : 'var(--bg-elevated)',
                      color: sourceTab === 'screen' ? '#ffffff' : 'var(--text-secondary)',
                    }}
                  >
                    <Monitor className="h-3.5 w-3.5" />
                    Telas Inteiras
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => void refreshSources()}
                  className="inline-flex items-center gap-1 text-xs font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingSources ? 'animate-spin' : ''}`} />
                  Atualizar
                </button>
              </div>

              <div className="grid max-h-52 grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
                {filteredDesktopSources.map((src) => {
                  const selected = src.id === selectedSourceId;
                  return (
                    <button
                      key={src.id}
                      type="button"
                      onClick={() => {
                        setSelectedSourceId(src.id);
                        if (title === 'Transmissão ao Vivo') setTitle(src.name.slice(0, 60));
                      }}
                      className="overflow-hidden rounded-2xl border p-2 text-left transition-all"
                      style={{
                        borderColor: selected ? 'var(--accent)' : 'var(--border-hairline)',
                        backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-elevated)',
                      }}
                    >
                      <img
                        src={src.thumbnailDataUrl}
                        alt={src.name}
                        className="aspect-video w-full rounded-lg bg-black object-cover"
                      />
                      <div className="mt-1.5 truncate text-xs font-medium">{src.name}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Stream Title */}
          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Título da Transmissão
            </label>
            <input
              type="text"
              maxLength={80}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-10 w-full rounded-xl border px-3.5 text-sm outline-none"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {/* Strict Resolution Selector (720p, 1080p, 1440p ONLY) */}
          <div>
            <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Qualidade de Resolução
            </label>
            <div className="grid grid-cols-3 gap-2.5">
              {STREAM_RESOLUTIONS.map((resId) => {
                const spec = STREAM_RESOLUTION_SPECS[resId];
                const active = resolution === resId;
                return (
                  <button
                    key={resId}
                    type="button"
                    onClick={() => {
                      setResolution(resId);
                      setContentOptimization(resId === '1440p' ? 'detail' : 'motion');
                    }}
                    className="rounded-2xl border p-3 text-left transition-all"
                    style={{
                      borderColor: active ? 'var(--accent)' : 'var(--border-hairline)',
                      backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    }}
                  >
                    <div className="text-sm font-semibold">{spec.label}</div>
                    <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {spec.width} × {spec.height}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Strict FPS Selector (30, 60, 75 FPS ONLY) */}
          <div>
            <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Taxa de Quadros Real (FPS)
            </label>
            <div className="grid grid-cols-3 gap-2.5">
              {STREAM_FPS_OPTIONS.map((fpsVal) => {
                const active = fps === fpsVal;
                return (
                  <button
                    key={fpsVal}
                    type="button"
                    onClick={() => setFps(fpsVal)}
                    className="rounded-2xl border py-2.5 text-center text-sm font-semibold tabular-nums transition-all"
                    style={{
                      borderColor: active ? 'var(--accent)' : 'var(--border-hairline)',
                      backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    }}
                  >
                    {fpsVal} FPS
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optimization & Audio Share */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div
              className="flex items-center justify-between rounded-2xl border p-3.5"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <div className="pr-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Music2 className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                  Compartilhar Áudio Estéreo
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  320 kbps CBR • Zero redução de volume
                </div>
              </div>
              <input
                type="checkbox"
                checked={shareAudio}
                onChange={(e) => setShareAudio(e.target.checked)}
                className="h-4 w-4 accent-blue-600"
              />
            </div>

            <div
              className="rounded-2xl border p-3.5"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <div className="text-xs font-semibold">Perfil de Nitidez</div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-[11px] font-medium">
                <button
                  type="button"
                  onClick={() => setContentOptimization('detail')}
                  className="rounded-lg py-1 transition-colors"
                  style={{
                    backgroundColor: contentOptimization === 'detail' ? 'var(--accent)' : 'var(--bg-surface)',
                    color: contentOptimization === 'detail' ? '#ffffff' : 'var(--text-secondary)',
                  }}
                >
                  Nitidez Texto/2K
                </button>
                <button
                  type="button"
                  onClick={() => setContentOptimization('motion')}
                  className="rounded-lg py-1 transition-colors"
                  style={{
                    backgroundColor: contentOptimization === 'motion' ? 'var(--accent)' : 'var(--bg-surface)',
                    color: contentOptimization === 'motion' ? '#ffffff' : 'var(--text-secondary)',
                  }}
                >
                  Ação Rápida
                </button>
              </div>
            </div>
          </div>

          <div
            className="flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-xs"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-sidebar)',
              color: 'var(--text-secondary)',
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" style={{ color: 'var(--voice-green)' }} />
              Isolamento WASAPI por processo ativo (0% eco das vozes) • GPU NVENC/AMF/QSV
            </span>
            <span className="font-semibold tabular-nums">
              Alvo: {(targetKbps / 1000).toFixed(1)} Mbps
            </span>
          </div>

          {error && (
            <div
              className="rounded-xl px-3.5 py-2.5 text-xs font-medium"
              style={{ backgroundColor: 'var(--live-red-soft)', color: 'var(--live-red)' }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="flex shrink-0 items-center justify-end gap-2.5 border-t px-6 py-4"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-10 rounded-xl px-4 text-xs font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={starting}
            onClick={() => void handleStart()}
            className="inline-flex h-10 items-center gap-2 rounded-xl px-5 text-xs font-semibold text-white transition-opacity disabled:opacity-60"
            style={{ backgroundColor: 'var(--live-red)' }}
          >
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Radio className="h-4 w-4" />
            )}
            Iniciar AO VIVO
          </button>
        </div>
      </div>
    </div>
  );
};

