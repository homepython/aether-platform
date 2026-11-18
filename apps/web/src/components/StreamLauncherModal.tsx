import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  AppWindow,
  Check,
  Eye,
  Gauge,
  Globe,
  Loader2,
  Lock,
  Minus,
  Monitor,
  Music2,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sliders,
  Users,
  X,
  Zap,
} from 'lucide-react';
import {
  STREAM_AUDIO_BITRATE_PRESETS,
  STREAM_FPS_OPTIONS,
  STREAM_RESOLUTIONS,
  STREAM_RESOLUTION_SPECS,
  STREAM_VIDEO_BITRATE_PRESETS,
  STREAM_VIEWER_LIMIT_PRESETS,
  ULTRA_PERFORMANCE_PRESET,
  resolveTargetAudioBitrateKbps,
  resolveTargetBitrateKbps,
  type StreamConnectionMode,
  type StreamFps,
  type StreamPrivacyMode,
  type StreamProfile,
  type StreamResolution,
} from '@aether/shared';
import {
  getDesktopApi,
  type DesktopAudioSessionItem,
  type DesktopCaptureSourceItem,
} from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';

const QUICK_RESOLUTIONS: StreamResolution[] = ['720p', '1080p', '1440p', 'original'];
const QUICK_FPS: StreamFps[] = [30, 60, 75];

const PROFILE_DEFS: {
  id: StreamProfile;
  label: string;
  desc: string;
  apply?: {
    resolution: StreamResolution;
    fps: StreamFps;
    optimization: 'detail' | 'motion';
  };
}[] = [
  { id: 'auto', label: 'Automático', desc: 'Equilíbrio inteligente GPU/Rede' },
  {
    id: 'ultra-performance',
    label: '⚡ Ultra Performance',
    desc: '60 FPS Reais • Zero Impacto no Jogo',
    apply: { resolution: '720p', fps: 60, optimization: 'motion' },
  },
  {
    id: '720p',
    label: '720p Gaming',
    desc: 'Alta fluidez em jogos pesados',
    apply: { resolution: '720p', fps: 60, optimization: 'motion' },
  },
  {
    id: '1080p',
    label: '1080p Full HD',
    desc: 'Alta definição fluida 60 FPS',
    apply: { resolution: '1080p', fps: 60, optimization: 'motion' },
  },
  {
    id: '1440p',
    label: '1440p (2K)',
    desc: 'Ultra nitidez QHD 75 FPS',
    apply: { resolution: '1440p', fps: 75, optimization: 'detail' },
  },
  {
    id: 'original',
    label: 'Original Nativa',
    desc: 'Sem reescalonamento da janela/tela',
    apply: { resolution: 'original', fps: 60, optimization: 'motion' },
  },
  {
    id: 'presentation',
    label: 'Apresentação',
    desc: 'Código & slides ultra nítidos (5 FPS)',
    apply: { resolution: '1440p', fps: 5, optimization: 'detail' },
  },
];

export const StreamLauncherModal: React.FC = () => {
  const open = useAppStore((s) => s.streamLauncherOpen);
  const setOpen = useAppStore((s) => s.setStreamLauncherOpen);
  const user = useAppStore((s) => s.user);
  const friends = useAppStore((s) => s.friends);
  const participants = useAppStore((s) => s.participants);
  const streamSettings = useAppStore((s) => s.settings.stream);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const startBroadcast = useAppStore((s) => s.startBroadcast);

  const desktopApi = getDesktopApi();

  const [studioMode, setStudioMode] = useState(false);
  const [title, setTitle] = useState('Transmissão ao Vivo');
  const [profile, setProfile] = useState<StreamProfile>(streamSettings.profile || 'auto');
  const [resolution, setResolution] = useState<StreamResolution>(streamSettings.resolution);
  const [fps, setFps] = useState<StreamFps>(streamSettings.fps);
  const [bitrateMode, setBitrateMode] = useState<'auto' | 'custom'>(streamSettings.bitrateMode);
  const [customBitrateKbps, setCustomBitrateKbps] = useState<number>(
    streamSettings.customBitrateKbps || 12000
  );
  const [audioBitrateKbps, setAudioBitrateKbps] = useState<number>(
    streamSettings.audioBitrateKbps || 320
  );
  const [shareAudio, setShareAudio] = useState<boolean>(streamSettings.shareAudio);
  const [audioSourceMode, setAudioSourceMode] = useState<'window' | 'system' | 'apps'>('window');
  const [selectedAudioPids, setSelectedAudioPids] = useState<number[]>([]);
  const [audioSessions, setAudioSessions] = useState<DesktopAudioSessionItem[]>([]);
  const [loadingAudioApps, setLoadingAudioApps] = useState(false);

  const [privacy, setPrivacy] = useState<StreamPrivacyMode>(streamSettings.privacy || 'public');
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>([]);
  const [viewerLimit, setViewerLimit] = useState<number | null>(
    streamSettings.viewerLimit ?? null
  );
  const [connectionMode, setConnectionMode] = useState<StreamConnectionMode>(
    streamSettings.connectionMode || 'auto'
  );
  const [contentOptimization, setContentOptimization] = useState<'detail' | 'motion'>(
    streamSettings.contentOptimization
  );

  const [sources, setSources] = useState<DesktopCaptureSourceItem[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<'window' | 'screen'>('window');
  const [loadingSources, setLoadingSources] = useState(false);
  const [screenAccessWarning, setScreenAccessWarning] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSources = async () => {
    if (!desktopApi) return;
    setLoadingSources(true);
    try {
      if (desktopApi.getCaptureAccessStatus) {
        const perm = await desktopApi.getCaptureAccessStatus();
        if (perm.screenAccess && perm.screenAccess !== 'granted') {
          setScreenAccessWarning(
            `Permissão de captura do sistema reportada como "${perm.screenAccess}". Caso veja tela preta, autorize nas Configurações do Windows.`
          );
        } else {
          setScreenAccessWarning(null);
        }
      }
      const list = await desktopApi.listCaptureSources();
      setSources(list);
      if (list.length > 0 && !selectedSourceId) {
        const firstWin = list.find((s) => s.kind === 'window');
        setSelectedSourceId((firstWin || list[0]).id);
        setSourceTab(firstWin ? 'window' : 'screen');
        setAudioSourceMode(firstWin ? 'window' : 'system');
      }
    } catch {
      // Ignore
    } finally {
      setLoadingSources(false);
    }
  };

  const refreshAudioApps = async () => {
    if (!desktopApi?.listAudioSessions) return;
    setLoadingAudioApps(true);
    try {
      const list = await desktopApi.listAudioSessions();
      setAudioSessions(list);
    } catch {
      // Ignore
    } finally {
      setLoadingAudioApps(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setProfile(streamSettings.profile || 'auto');
    setResolution(streamSettings.resolution);
    setFps(streamSettings.fps);
    setBitrateMode(streamSettings.bitrateMode);
    setCustomBitrateKbps(
      streamSettings.customBitrateKbps ||
        resolveTargetBitrateKbps(streamSettings.resolution, streamSettings.fps, null)
    );
    setAudioBitrateKbps(streamSettings.audioBitrateKbps || 320);
    setShareAudio(streamSettings.shareAudio);
    setPrivacy(streamSettings.privacy || 'public');
    setViewerLimit(streamSettings.viewerLimit ?? null);
    setConnectionMode(streamSettings.connectionMode || 'auto');
    setContentOptimization(streamSettings.contentOptimization);
    setError(null);

    if (desktopApi) {
      void refreshSources();
      void refreshAudioApps();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || audioSourceMode !== 'apps' || !desktopApi?.listAudioSessions) return;
    void refreshAudioApps();
    const timer = window.setInterval(() => {
      void refreshAudioApps();
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, audioSourceMode]);

  const inviteableUsers = useMemo(() => {
    const map = new Map<string, { id: string; displayName: string; username: string }>();
    for (const p of participants) {
      if (p.user.id !== user?.id) {
        map.set(p.user.id, {
          id: p.user.id,
          displayName: p.user.displayName,
          username: p.user.username,
        });
      }
    }
    for (const f of friends) {
      if (f.status === 'accepted' && f.user.id !== user?.id) {
        map.set(f.user.id, {
          id: f.user.id,
          displayName: f.user.displayName,
          username: f.user.username,
        });
      }
    }
    return Array.from(map.values());
  }, [participants, friends, user?.id]);

  if (!open) return null;

  const isUltraPerf =
    profile === 'ultra-performance' || connectionMode === 'ultra-performance';

  const autoKbps = resolveTargetBitrateKbps(resolution, fps, null, connectionMode);
  const targetKbps = resolveTargetBitrateKbps(
    resolution,
    fps,
    bitrateMode === 'custom' ? customBitrateKbps : null,
    connectionMode
  );
  const effectiveAudioKbps = resolveTargetAudioBitrateKbps(audioBitrateKbps);

  const activateUltraPerformance = () => {
    if (isUltraPerf) {
      setProfile('1080p');
      setResolution('1080p');
      setFps(60);
      setBitrateMode('auto');
      setAudioBitrateKbps(320);
      setConnectionMode('auto');
      setContentOptimization('motion');
    } else {
      setProfile(ULTRA_PERFORMANCE_PRESET.profile);
      setResolution(ULTRA_PERFORMANCE_PRESET.resolution);
      setFps(ULTRA_PERFORMANCE_PRESET.fps);
      setBitrateMode('auto');
      setCustomBitrateKbps(ULTRA_PERFORMANCE_PRESET.targetBitrateKbps);
      setAudioBitrateKbps(ULTRA_PERFORMANCE_PRESET.audioBitrateKbps);
      setConnectionMode(ULTRA_PERFORMANCE_PRESET.connectionMode);
      setContentOptimization(ULTRA_PERFORMANCE_PRESET.contentOptimization);
    }
  };

  const filteredDesktopSources = sources.filter((s) => s.kind === sourceTab);
  const chosenSource = sources.find((s) => s.id === selectedSourceId) || null;

  const toggleAudioAppPid = (pid: number) => {
    setSelectedAudioPids((prev) =>
      prev.includes(pid) ? prev.filter((p) => p !== pid) : [...prev, pid]
    );
  };

  const toggleAllowedUser = (uid: string) => {
    setAllowedUserIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    );
  };

  const handleStart = async () => {
    setError(null);
    if (desktopApi && !chosenSource) {
      setError('Selecione uma tela ou janela de jogo para transmitir.');
      return;
    }
    if (shareAudio && audioSourceMode === 'apps' && selectedAudioPids.length === 0) {
      setError(
        'Selecione pelo menos 1 aplicativo sonoro em "Selecionar Aplicativos" ou escolha "Janela capturada".'
      );
      return;
    }

    setStarting(true);
    try {
      updateSettings((prev) => ({
        ...prev,
        stream: {
          ...prev.stream,
          profile,
          resolution,
          fps,
          bitrateMode,
          customBitrateKbps: bitrateMode === 'custom' ? customBitrateKbps : null,
          audioBitrateKbps: effectiveAudioKbps,
          shareAudio,
          privacy,
          viewerLimit,
          connectionMode,
          contentOptimization,
        },
      }));

      await startBroadcast({
        title: title.trim() || chosenSource?.name || 'Transmissão ao Vivo',
        resolution,
        fps,
        customBitrateKbps: bitrateMode === 'custom' ? customBitrateKbps : null,
        audioBitrateKbps: effectiveAudioKbps,
        shareAudio,
        audioSourceMode,
        selectedAudioPids: audioSourceMode === 'apps' ? selectedAudioPids : undefined,
        privacy,
        allowedUserIds: privacy === 'private' ? allowedUserIds : undefined,
        viewerLimit,
        connectionMode,
        contentOptimization,
        desktopSource: chosenSource,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancelado ou falha ao iniciar transmissão');
    } finally {
      setStarting(false);
    }
  };

  const privacyLabel =
    privacy === 'public'
      ? 'Pública na Sala'
      : privacy === 'friends'
        ? 'Apenas Amigos'
        : `Privada (${allowedUserIds.length} convidados)`;

  const connectionLabel =
    connectionMode === 'ultra-performance'
      ? '⚡ Ultra Performance (60 FPS Zero-Lag)'
      : connectionMode === 'auto'
        ? 'Auto'
        : connectionMode === 'quality'
          ? 'Qualidade Máx.'
          : connectionMode === 'performance'
            ? 'Anti-Lag Jogos'
            : 'Cloud Relay (Compatibilidade)';

  const audioModeSummary = !shareAudio
    ? 'Sem Áudio'
    : audioSourceMode === 'apps'
      ? `${selectedAudioPids.length} Apps Mixados (${effectiveAudioKbps} kbps)`
      : audioSourceMode === 'window'
        ? `Janela Isolada (${effectiveAudioKbps} kbps)`
        : `Sistema s/ Eco (${effectiveAudioKbps} kbps)`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        {/* Modal Header with Quick vs Studio Personalizar Toggle */}
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-4"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Configurar Transmissão ao Vivo</h2>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              H.264 Universal + VP8 + Cloud Relay Anti-Tela-Preta • Zero Audio Ducking
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div
              className="flex rounded-xl border p-1 text-xs font-semibold"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <button
                type="button"
                onClick={() => setStudioMode(false)}
                className="rounded-lg px-3 py-1.5 transition-all"
                style={{
                  backgroundColor: !studioMode ? 'var(--accent)' : 'transparent',
                  color: !studioMode ? '#ffffff' : 'var(--text-secondary)',
                }}
              >
                Rápido
              </button>
              <button
                type="button"
                onClick={() => setStudioMode(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all"
                style={{
                  backgroundColor: studioMode ? 'var(--accent)' : 'transparent',
                  color: studioMode ? '#ffffff' : 'var(--text-secondary)',
                }}
              >
                <Settings2 className="h-3.5 w-3.5" />
                Personalizar
              </button>
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
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {/* OS Capture Access Warning Banner */}
          {screenAccessWarning && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-xs"
              style={{
                borderColor: 'rgba(245, 158, 11, 0.45)',
                backgroundColor: 'rgba(245, 158, 11, 0.12)',
                color: '#fbbf24',
              }}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{screenAccessWarning}</span>
              </div>
              {desktopApi?.openCaptureSystemPermissions && (
                <button
                  type="button"
                  onClick={() => void desktopApi.openCaptureSystemPermissions?.()}
                  className="rounded-lg bg-amber-500/20 px-2.5 py-1 font-semibold hover:bg-amber-500/30"
                >
                  Abrir Permissões
                </button>
              )}
            </div>
          )}

          {/* Desktop Source Picker */}
          {desktopApi && (
            <div>
              <div className="mb-2.5 flex items-center justify-between">
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setSourceTab('window');
                      if (audioSourceMode === 'system') setAudioSourceMode('window');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all"
                    style={{
                      backgroundColor:
                        sourceTab === 'window' ? 'var(--accent)' : 'var(--bg-elevated)',
                      color: sourceTab === 'window' ? '#ffffff' : 'var(--text-secondary)',
                    }}
                  >
                    <AppWindow className="h-3.5 w-3.5" />
                    Jogos &amp; Janelas
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSourceTab('screen');
                      if (audioSourceMode === 'window') setAudioSourceMode('system');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all"
                    style={{
                      backgroundColor:
                        sourceTab === 'screen' ? 'var(--accent)' : 'var(--bg-elevated)',
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
                  Atualizar Fontes
                </button>
              </div>

              <div className="grid max-h-48 grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
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

          {/* ================================================================= */}
          {/* QUICK MODE vs STUDIO PERSONALIZAR MODE                            */}
          {/* ================================================================= */}
          {!studioMode ? (
            <>
              {/* 1-Click Ultra Performance Mode Banner */}
              <button
                type="button"
                onClick={activateUltraPerformance}
                className={`flex w-full items-center justify-between gap-3 rounded-2xl border p-3.5 text-left transition-all ${
                  isUltraPerf ? 'ultra-perf-card' : ''
                }`}
                style={
                  !isUltraPerf
                    ? {
                        borderColor: 'var(--border-strong)',
                        backgroundColor: 'var(--bg-elevated)',
                      }
                    : undefined
                }
              >
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                    style={{
                      backgroundColor: isUltraPerf
                        ? 'rgba(6, 182, 212, 0.22)'
                        : 'var(--accent-soft)',
                      color: isUltraPerf ? '#22d3ee' : 'var(--accent)',
                    }}
                  >
                    <Zap className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                      <span>Modo Ultra Performance (Desempenho Máximo em Jogos)</span>
                      <span className="ultra-perf-badge rounded-full px-2 py-0.5 text-[10px] font-bold uppercase">
                        {isUltraPerf ? 'ATIVO • 60 FPS REAIS' : 'NOVO'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      Mantém 60 FPS constantes na live com impacto quase nulo no FPS do jogo, GPU, CPU e RAM.
                    </div>
                  </div>
                </div>

                <div
                  className="shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all"
                  style={{
                    backgroundColor: isUltraPerf ? '#06b6d4' : 'var(--bg-surface)',
                    color: isUltraPerf ? '#042f2e' : 'var(--text-secondary)',
                    border: isUltraPerf ? 'none' : '1px solid var(--border-hairline)',
                  }}
                >
                  {isUltraPerf ? 'Ativado' : 'Ativar'}
                </div>
              </button>

              <div>
                <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  Qualidade de Resolução
                </label>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {QUICK_RESOLUTIONS.map((resId) => {
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
                          {spec.width > 0 ? `${spec.width} × ${spec.height}` : 'Nativa Sem Escala'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  Taxa de Quadros (FPS)
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  {QUICK_FPS.map((fpsVal) => {
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
                      {effectiveAudioKbps} kbps • Zero redução de volume
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={shareAudio}
                    onChange={(e) => setShareAudio(e.target.checked)}
                    className="h-4 w-4 accent-blue-600"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setStudioMode(true)}
                  className="flex items-center justify-between rounded-2xl border p-3.5 text-left transition-colors hover:opacity-90"
                  style={{
                    borderColor: 'var(--border-strong)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--accent)' }}>
                      <Sliders className="h-3.5 w-3.5" />
                      Precisa de 144 FPS, Multi-App Áudio ou Privacidade?
                    </div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Clique para abrir o painel Studio Personalizar completo
                    </div>
                  </div>
                </button>
              </div>
            </>
          ) : (
            /* ================================================================= */
            /* FULL STUDIO PERSONALIZAR PANEL                                    */
            /* ================================================================= */
            <div className="space-y-5">
              {/* 1. Studio Profiles */}
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  1. Perfil de Transmissão Studio
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {PROFILE_DEFS.map((p) => {
                    const active = profile === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setProfile(p.id);
                          if (p.apply) {
                            setResolution(p.apply.resolution);
                            setFps(p.apply.fps);
                            setContentOptimization(p.apply.optimization);
                          }
                          if (p.id === 'ultra-performance') {
                            setBitrateMode('auto');
                            setCustomBitrateKbps(ULTRA_PERFORMANCE_PRESET.targetBitrateKbps);
                            setAudioBitrateKbps(ULTRA_PERFORMANCE_PRESET.audioBitrateKbps);
                            setConnectionMode('ultra-performance');
                          } else if (p.id === '720p' || p.id === 'original') {
                            setConnectionMode('performance');
                          } else if (connectionMode === 'ultra-performance') {
                            setConnectionMode('auto');
                          }
                        }}
                        className={`rounded-xl border p-2.5 text-left transition-all ${
                          active && p.id === 'ultra-performance' ? 'ultra-perf-card' : ''
                        }`}
                        style={{
                          borderColor: active ? 'var(--accent)' : 'var(--border-hairline)',
                          backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                        }}
                      >
                        <div className="text-xs font-semibold">{p.label}</div>
                        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {p.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. Full Resolution Grid (360p -> Original) */}
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  2. Resolução de Saída (360p até 2K &amp; Original Nativa)
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {STREAM_RESOLUTIONS.map((resId) => {
                    const spec = STREAM_RESOLUTION_SPECS[resId];
                    const active = resolution === resId;
                    return (
                      <button
                        key={resId}
                        type="button"
                        onClick={() => setResolution(resId)}
                        className="rounded-xl border p-2.5 text-left transition-all"
                        style={{
                          borderColor: active ? 'var(--accent)' : 'var(--border-hairline)',
                          backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                        }}
                      >
                        <div className="text-xs font-semibold">{spec.label}</div>
                        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {spec.width > 0 ? `${spec.width} × ${spec.height}` : 'Dimensão Exata da Fonte'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 3. Full FPS Grid (5 -> 144 FPS) */}
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  3. Taxa de Quadros Real (5 a 144 FPS)
                </label>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                  {STREAM_FPS_OPTIONS.map((fpsVal) => {
                    const active = fps === fpsVal;
                    return (
                      <button
                        key={fpsVal}
                        type="button"
                        onClick={() => setFps(fpsVal)}
                        className="rounded-xl border py-2 text-center text-xs font-semibold tabular-nums transition-all"
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

              {/* 4. Manual Video Bitrate + Audio Bitrate */}
              <div
                className="space-y-4 rounded-2xl border p-4"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--bg-elevated)',
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <Gauge className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                      Bitrate de Vídeo ({(targetKbps / 1000).toFixed(1)} Mbps / {targetKbps} Kbps)
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Automático recomendado: {autoKbps} Kbps • Manual livre de 300 a 60.000 Kbps
                    </div>
                  </div>

                  <div className="flex gap-1.5 text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => setBitrateMode('auto')}
                      className="rounded-lg px-3 py-1"
                      style={{
                        backgroundColor:
                          bitrateMode === 'auto' ? 'var(--accent)' : 'var(--bg-surface)',
                        color: bitrateMode === 'auto' ? '#ffffff' : 'var(--text-secondary)',
                      }}
                    >
                      Automático
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBitrateMode('custom');
                        if (!customBitrateKbps) setCustomBitrateKbps(autoKbps);
                      }}
                      className="rounded-lg px-3 py-1"
                      style={{
                        backgroundColor:
                          bitrateMode === 'custom' ? 'var(--accent)' : 'var(--bg-surface)',
                        color: bitrateMode === 'custom' ? '#ffffff' : 'var(--text-secondary)',
                      }}
                    >
                      Manual (Kbps)
                    </button>
                  </div>
                </div>

                {bitrateMode === 'custom' && (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setCustomBitrateKbps((v) => Math.max(300, (v || autoKbps) - 500))
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-lg border"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          backgroundColor: 'var(--bg-surface)',
                        }}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>

                      <input
                        type="number"
                        min={300}
                        max={60000}
                        step={100}
                        value={customBitrateKbps}
                        onChange={(e) =>
                          setCustomBitrateKbps(
                            Math.max(300, Math.min(60000, Number(e.target.value) || 300))
                          )
                        }
                        className="h-8 w-28 rounded-lg border px-2.5 text-center text-xs font-semibold tabular-nums outline-none"
                        style={{
                          borderColor: 'var(--border-strong)',
                          backgroundColor: 'var(--bg-surface)',
                          color: 'var(--text-primary)',
                        }}
                      />

                      <button
                        type="button"
                        onClick={() =>
                          setCustomBitrateKbps((v) => Math.min(60000, (v || autoKbps) + 500))
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-lg border"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          backgroundColor: 'var(--bg-surface)',
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>

                      <input
                        type="range"
                        min={300}
                        max={40000}
                        step={250}
                        value={Math.min(40000, customBitrateKbps)}
                        onChange={(e) => setCustomBitrateKbps(Number(e.target.value))}
                        className="aether-range min-w-[140px] flex-1"
                      />
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {STREAM_VIDEO_BITRATE_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setCustomBitrateKbps(preset)}
                          className="rounded-lg border px-2 py-0.5 text-[11px] font-medium tabular-nums"
                          style={{
                            borderColor:
                              customBitrateKbps === preset
                                ? 'var(--accent)'
                                : 'var(--border-hairline)',
                            backgroundColor:
                              customBitrateKbps === preset
                                ? 'var(--bg-active)'
                                : 'var(--bg-surface)',
                          }}
                        >
                          {preset >= 1000 ? `${preset / 1000} Mbps` : `${preset} Kbps`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Audio Bitrate */}
                <div className="border-t pt-3" style={{ borderColor: 'var(--border-hairline)' }}>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="font-semibold">Bitrate de Áudio Opus Estéreo</span>
                    <span className="font-semibold tabular-nums">{effectiveAudioKbps} Kbps</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {STREAM_AUDIO_BITRATE_PRESETS.map((ab) => (
                      <button
                        key={ab}
                        type="button"
                        onClick={() => setAudioBitrateKbps(ab)}
                        className="rounded-lg border px-2.5 py-1 text-[11px] font-semibold tabular-nums"
                        style={{
                          borderColor:
                            audioBitrateKbps === ab ? 'var(--accent)' : 'var(--border-hairline)',
                          backgroundColor:
                            audioBitrateKbps === ab ? 'var(--bg-active)' : 'var(--bg-surface)',
                        }}
                      >
                        {ab} Kbps
                      </button>
                    ))}
                    <input
                      type="number"
                      min={32}
                      max={510}
                      value={audioBitrateKbps}
                      onChange={(e) =>
                        setAudioBitrateKbps(
                          Math.max(32, Math.min(510, Number(e.target.value) || 128))
                        )
                      }
                      className="ml-auto h-7 w-20 rounded-lg border px-2 text-center text-xs tabular-nums outline-none"
                      style={{
                        borderColor: 'var(--border-hairline)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                      }}
                      title="Bitrate manual de áudio (32–510 Kbps)"
                    />
                  </div>
                </div>
              </div>

              {/* 5. Multi-Application WASAPI Audio Source Selector */}
              <div
                className="space-y-3 rounded-2xl border p-4"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--bg-elevated)',
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <Music2 className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                    <span>Fonte de Áudio da Transmissão (Zero Eco das Vozes)</span>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium">
                    <span>Transmitir Áudio</span>
                    <input
                      type="checkbox"
                      checked={shareAudio}
                      onChange={(e) => setShareAudio(e.target.checked)}
                      className="h-4 w-4 accent-blue-600"
                    />
                  </label>
                </div>

                {shareAudio && desktopApi && (
                  <>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {(
                        [
                          {
                            id: 'window',
                            label: 'Janela Capturada',
                            sub: 'Apenas o jogo/janela escolhido',
                          },
                          {
                            id: 'system',
                            label: 'Sistema (Sem Eco)',
                            sub: 'Todo o PC exceto vozes Aether',
                          },
                          {
                            id: 'apps',
                            label: 'Selecionar Aplicativos',
                            sub: 'Mixar Spotify + Jogo (Multi-App)',
                          },
                        ] as const
                      ).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setAudioSourceMode(m.id)}
                          className="rounded-xl border p-2.5 text-left transition-all"
                          style={{
                            borderColor:
                              audioSourceMode === m.id ? 'var(--accent)' : 'var(--border-hairline)',
                            backgroundColor:
                              audioSourceMode === m.id ? 'var(--bg-active)' : 'var(--bg-surface)',
                          }}
                        >
                          <div className="text-xs font-semibold">{m.label}</div>
                          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {m.sub}
                          </div>
                        </button>
                      ))}
                    </div>

                    {audioSourceMode === 'apps' && (
                      <div
                        className="space-y-2 rounded-xl border p-3"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          backgroundColor: 'var(--bg-surface)',
                        }}
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold">
                            Escolha 1 ou mais aplicativos sonoros ativos no Windows:
                          </span>
                          <button
                            type="button"
                            onClick={() => void refreshAudioApps()}
                            className="inline-flex items-center gap-1 text-[11px]"
                            style={{ color: 'var(--accent)' }}
                          >
                            <RefreshCw
                              className={`h-3 w-3 ${loadingAudioApps ? 'animate-spin' : ''}`}
                            />
                            Atualizar Apps
                          </button>
                        </div>

                        {audioSessions.length === 0 ? (
                          <div className="py-3 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                            Nenhum aplicativo reproduzindo áudio detectado agora. Abra seu jogo ou
                            música e clique em Atualizar Apps.
                          </div>
                        ) : (
                          <div className="grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2">
                            {audioSessions.map((app) => {
                              const checked = selectedAudioPids.includes(app.pid);
                              const peakPct = Math.min(100, Math.round(app.peak * 100));
                              return (
                                <button
                                  key={app.pid}
                                  type="button"
                                  onClick={() => toggleAudioAppPid(app.pid)}
                                  className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-all"
                                  style={{
                                    borderColor: checked
                                      ? 'var(--accent)'
                                      : 'var(--border-hairline)',
                                    backgroundColor: checked
                                      ? 'var(--bg-active)'
                                      : 'var(--bg-elevated)',
                                  }}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold">{app.displayName}</div>
                                    <div
                                      className="mt-1 h-1.5 w-full overflow-hidden rounded-full"
                                      style={{ backgroundColor: 'var(--bg-sidebar)' }}
                                    >
                                      <div
                                        className="h-full rounded-full transition-all"
                                        style={{
                                          width: `${peakPct}%`,
                                          backgroundColor: 'var(--voice-green)',
                                        }}
                                      />
                                    </div>
                                  </div>

                                  <div
                                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
                                    style={{
                                      borderColor: checked
                                        ? 'var(--accent)'
                                        : 'var(--border-strong)',
                                      backgroundColor: checked ? 'var(--accent)' : 'transparent',
                                      color: '#ffffff',
                                    }}
                                  >
                                    {checked && <Check className="h-3 w-3" />}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 6. Connection Mode + Privacy + Viewer Limit */}
              <div className="grid gap-4 sm:grid-cols-2">
                {/* Connection Mode */}
                <div
                  className="space-y-2.5 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <Globe className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                    Modo de Conexão &amp; Estabilidade
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                    {(
                      [
                        { id: 'auto', label: 'Automático' },
                        { id: 'ultra-performance', label: '⚡ Ultra Performance' },
                        { id: 'performance', label: 'Desempenho (Jogos)' },
                        { id: 'quality', label: 'Melhor Nitidez' },
                        { id: 'compatibility', label: 'Compatibilidade (Relay)' },
                      ] as const
                    ).map((cm) => (
                      <button
                        key={cm.id}
                        type="button"
                        onClick={() => setConnectionMode(cm.id)}
                        className="rounded-lg border px-2.5 py-2 font-semibold transition-all"
                        style={{
                          borderColor:
                            connectionMode === cm.id ? 'var(--accent)' : 'var(--border-hairline)',
                          backgroundColor:
                            connectionMode === cm.id ? 'var(--bg-active)' : 'var(--bg-surface)',
                        }}
                      >
                        {cm.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Privacy & Viewer Limit */}
                <div
                  className="space-y-2.5 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <Lock className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                    Privacidade &amp; Limite de Espectadores
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                    {(
                      [
                        { id: 'public', label: 'Pública' },
                        { id: 'friends', label: 'Amigos' },
                        { id: 'private', label: 'Privada' },
                      ] as const
                    ).map((pm) => (
                      <button
                        key={pm.id}
                        type="button"
                        onClick={() => setPrivacy(pm.id)}
                        className="rounded-lg border py-1.5 font-semibold"
                        style={{
                          borderColor:
                            privacy === pm.id ? 'var(--accent)' : 'var(--border-hairline)',
                          backgroundColor:
                            privacy === pm.id ? 'var(--bg-active)' : 'var(--bg-surface)',
                        }}
                      >
                        {pm.label}
                      </button>
                    ))}
                  </div>

                  {privacy === 'private' && (
                    <div className="max-h-24 space-y-1 overflow-y-auto rounded-lg border p-2 text-[11px]" style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}>
                      {inviteableUsers.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)' }}>
                          Adicione amigos ou entre na sala com colegas para autorizar acesso.
                        </div>
                      ) : (
                        inviteableUsers.map((u) => (
                          <label key={u.id} className="flex cursor-pointer items-center justify-between py-0.5">
                            <span className="truncate">
                              {u.displayName} (@{u.username})
                            </span>
                            <input
                              type="checkbox"
                              checked={allowedUserIds.includes(u.id)}
                              onChange={() => toggleAllowedUser(u.id)}
                              className="h-3.5 w-3.5 accent-blue-600"
                            />
                          </label>
                        ))
                      )}
                    </div>
                  )}

                  {/* Viewer Limit */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px]">
                    <span className="inline-flex items-center gap-1 font-medium" style={{ color: 'var(--text-secondary)' }}>
                      <Eye className="h-3 w-3" /> Limite:
                    </span>
                    <button
                      type="button"
                      onClick={() => setViewerLimit(null)}
                      className="rounded-md border px-2 py-0.5 font-semibold"
                      style={{
                        borderColor:
                          viewerLimit === null ? 'var(--accent)' : 'var(--border-hairline)',
                        backgroundColor:
                          viewerLimit === null ? 'var(--bg-active)' : 'var(--bg-surface)',
                      }}
                    >
                      Sem limite
                    </button>
                    {STREAM_VIEWER_LIMIT_PRESETS.slice(0, 4).map((lim) => (
                      <button
                        key={lim}
                        type="button"
                        onClick={() => setViewerLimit(lim)}
                        className="rounded-md border px-2 py-0.5 font-semibold tabular-nums"
                        style={{
                          borderColor:
                            viewerLimit === lim ? 'var(--accent)' : 'var(--border-hairline)',
                          backgroundColor:
                            viewerLimit === lim ? 'var(--bg-active)' : 'var(--bg-surface)',
                        }}
                      >
                        {lim}
                      </button>
                    ))}
                    <input
                      type="number"
                      min={1}
                      max={500}
                      placeholder="Custom"
                      value={viewerLimit ?? ''}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        setViewerLimit(
                          val ? Math.max(1, Math.min(500, Number(val) || 1)) : null
                        );
                      }}
                      className="h-6 w-16 rounded-md border px-1.5 text-center tabular-nums outline-none"
                      style={{
                        borderColor: 'var(--border-hairline)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Pre-Live Summary Strip */}
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-xs"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-sidebar)',
              color: 'var(--text-secondary)',
            }}
          >
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ShieldCheck className="h-4 w-4 shrink-0" style={{ color: 'var(--voice-green)' }} />
              <span>
                <strong>{STREAM_RESOLUTION_SPECS[resolution].label}</strong> •{' '}
                <strong>{fps} FPS</strong> • <strong>{(targetKbps / 1000).toFixed(1)} Mbps</strong>{' '}
                • {audioModeSummary}
              </span>
            </span>

            <span className="inline-flex items-center gap-2 text-[11px] font-semibold">
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" />
                {privacyLabel}
                {viewerLimit ? ` (máx ${viewerLimit})` : ''}
              </span>
              <span>•</span>
              <span style={{ color: 'var(--accent)' }}>{connectionLabel}</span>
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
