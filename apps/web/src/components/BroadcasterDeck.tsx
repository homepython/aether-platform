import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Eye,
  Gauge,
  Lock,
  Minus,
  Monitor,
  Music2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  Zap,
} from 'lucide-react';
import type { ActiveStreamInfo } from '@aether/shared';
import { getDesktopApi } from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';
import { StyledUserName, UserAvatar, UserRoleBadge } from './UserIdentity.js';

function formatElapsed(startedAtIso: string, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - new Date(startedAtIso).getTime()) / 1000));
  const hrs = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  return [hrs, mins, secs].map((n) => String(n).padStart(2, '0')).join(':');
}

export const BroadcasterDeck: React.FC<{ stream: ActiveStreamInfo }> = ({ stream }) => {
  const stopBroadcast = useAppStore((s) => s.stopBroadcast);
  const updateBroadcastSettings = useAppStore((s) => s.updateBroadcastSettings);
  const reauthorizeCapture = useAppStore((s) => s.reauthorizeCapture);
  const captureDiagnostic = useAppStore((s) => s.captureDiagnostic);
  const setInspectedUser = useAppStore((s) => s.setInspectedUser);
  const pushToast = useAppStore((s) => s.pushToast);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [liveBitrateInput, setLiveBitrateInput] = useState<number>(stream.targetBitrateKbps);
  const [applyingBitrate, setApplyingBitrate] = useState(false);
  const [reauthorizing, setReauthorizing] = useState(false);

  const desktopApi = getDesktopApi();

  useEffect(() => {
    setLiveBitrateInput(stream.targetBitrateKbps);
  }, [stream.targetBitrateKbps]);

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) {
        setNowMs(Date.now());
      }
    };
    const onVisChange = () => {
      if (!document.hidden) {
        setNowMs(Date.now());
      }
    };
    const id = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, []);

  const audioStatusLabel = !stream.hasAudio
    ? 'Desativado'
    : stream.audioIsolationMode === 'multi-process'
      ? `Multi-App Isolado (${stream.audioBitrateKbps} kbps)`
      : stream.audioIsolationMode === 'process-isolated'
        ? `Isolado s/ Eco (${stream.audioBitrateKbps} kbps)`
        : stream.audioIsolationMode === 'tab-isolated'
          ? 'Ativo • Aba Isolada'
          : `Estéreo ${stream.audioBitrateKbps} kbps`;

  const resolutionDetail =
    stream.verifiedWidth && stream.verifiedHeight
      ? `${stream.resolution} (${stream.verifiedWidth}×${stream.verifiedHeight})`
      : stream.resolution;

  const fpsDetail =
    stream.verifiedFps && stream.verifiedFps > 0
      ? `${Math.round(stream.verifiedFps)} FPS`
      : `${stream.fps} FPS`;

  const privacyBadge =
    stream.privacy === 'friends'
      ? 'Apenas Amigos'
      : stream.privacy === 'private'
        ? 'Privada'
        : 'Pública';

  const applyLiveBitrate = async (nextKbps: number) => {
    const clamped = Math.max(300, Math.min(60000, Math.round(nextKbps)));
    setLiveBitrateInput(clamped);
    setApplyingBitrate(true);
    try {
      await updateBroadcastSettings({ targetBitrateKbps: clamped });
      pushToast({
        title: 'Bitrate atualizado ao vivo',
        body: `Novo alvo de vídeo: ${(clamped / 1000).toFixed(1)} Mbps (${clamped} Kbps).`,
      });
    } catch (err) {
      pushToast({
        title: 'Erro ao ajustar bitrate',
        body: err instanceof Error ? err.message : 'Tente novamente',
      });
    } finally {
      setApplyingBitrate(false);
    }
  };

  const handleReauthorize = async () => {
    setReauthorizing(true);
    try {
      await reauthorizeCapture();
    } catch (err) {
      pushToast({
        title: 'Falha ao reautorizar captura',
        body: err instanceof Error ? err.message : 'Tente selecionar a janela novamente.',
      });
    } finally {
      setReauthorizing(false);
    }
  };

  return (
    <div
      className="rounded-2xl border p-5 transition-all"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-hairline)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {/* Capture Diagnostic Alert Banner (1-Click Reauthorize) */}
      {captureDiagnostic?.active && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-xs"
          style={{
            borderColor: 'rgba(245, 158, 11, 0.5)',
            backgroundColor: 'rgba(245, 158, 11, 0.12)',
            color: '#fbbf24',
          }}
        >
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{captureDiagnostic.reason}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={reauthorizing}
              onClick={() => void handleReauthorize()}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-amber-500 px-3 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${reauthorizing ? 'animate-spin' : ''}`} />
              Reautorizar Captura
            </button>
            {desktopApi?.openCaptureSystemPermissions && (
              <button
                type="button"
                onClick={() => void desktopApi.openCaptureSystemPermissions?.()}
                className="h-8 rounded-xl border border-amber-400/40 px-2.5 text-xs font-medium hover:bg-amber-500/15"
              >
                Permissões Windows
              </button>
            )}
          </div>
        </div>
      )}

      {/* Top Bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider"
            style={{
              backgroundColor: 'var(--live-red-soft)',
              color: 'var(--live-red)',
            }}
          >
            <span className="live-dot h-2 w-2 rounded-full bg-current" />
            AO VIVO
          </span>

          {stream.relayActive && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold"
              style={{
                backgroundColor: 'rgba(16, 185, 129, 0.14)',
                color: 'var(--voice-green)',
              }}
              title="Túnel Cloud Relay Anti-Tela-Preta pronto para espectadores com NAT estrito"
            >
              <ShieldCheck className="h-3 w-3" />
              Cloud Relay Ativo
            </span>
          )}

          <span
            className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
            }}
          >
            <Lock className="h-2.5 w-2.5" />
            {privacyBadge}
          </span>

          <div>
            <div className="text-sm font-semibold">{stream.title}</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Modo Transmissor de Alta Performance • Zero autodecodificação local
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void stopBroadcast()}
          className="inline-flex h-9 items-center gap-2 rounded-xl px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--live-red)' }}
        >
          <Square className="h-3.5 w-3.5 fill-current" />
          Encerrar Transmissão
        </button>
      </div>

      {/* Telemetry Metrics Grid */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div
          className="rounded-xl border p-3"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
            <Eye className="h-3.5 w-3.5" />
            Espectadores
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {stream.viewerCount}
            {stream.viewerLimit ? (
              <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                {' '}
                / {stream.viewerLimit}
              </span>
            ) : null}
          </div>
        </div>

        <div
          className="rounded-xl border p-3"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
            <Clock className="h-3.5 w-3.5" />
            Tempo no Ar
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {formatElapsed(stream.startedAt, nowMs)}
          </div>
        </div>

        <div
          className="rounded-xl border p-3"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
            <Monitor className="h-3.5 w-3.5" />
            Resolução
          </div>
          <div className="mt-1 text-sm font-semibold tabular-nums">{resolutionDetail}</div>
        </div>

        <div
          className="rounded-xl border p-3"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
            <Zap className="h-3.5 w-3.5" />
            FPS &amp; Rede
          </div>
          <div className="mt-1 text-sm font-semibold tabular-nums">
            {fpsDetail}
            {stream.verifiedBitrateKbps && stream.verifiedBitrateKbps > 0 ? (
              <span className="ml-1.5 text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>
                • {(stream.verifiedBitrateKbps / 1000).toFixed(1)} Mbps
              </span>
            ) : null}
          </div>
        </div>

        <div
          className="col-span-2 rounded-xl border p-3 sm:col-span-1"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
            <Music2 className="h-3.5 w-3.5" />
            Áudio da Live
          </div>
          <div
            className="mt-1 truncate text-xs font-semibold"
            style={{ color: stream.hasAudio ? 'var(--voice-green)' : 'var(--text-secondary)' }}
            title={audioStatusLabel}
          >
            {audioStatusLabel}
          </div>
        </div>
      </div>

      {/* Live Bitrate Adjustment Strip + Viewers Strip */}
      <div
        className="mt-3.5 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 font-medium" style={{ color: 'var(--text-secondary)' }}>
            <Gauge className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
            Bitrate ao vivo:
          </span>
          <button
            type="button"
            disabled={applyingBitrate}
            onClick={() => void applyLiveBitrate(liveBitrateInput - 1000)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-elevated)',
            }}
            title="-1000 Kbps"
          >
            <Minus className="h-3 w-3" />
          </button>
          <input
            type="number"
            min={300}
            max={60000}
            step={500}
            value={liveBitrateInput}
            onChange={(e) => setLiveBitrateInput(Number(e.target.value) || 300)}
            className="h-7 w-24 rounded-lg border px-2 text-center text-xs font-semibold tabular-nums outline-none"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
            }}
          />
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Kbps
          </span>
          <button
            type="button"
            disabled={applyingBitrate}
            onClick={() => void applyLiveBitrate(liveBitrateInput + 1000)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-elevated)',
            }}
            title="+1000 Kbps"
          >
            <Plus className="h-3 w-3" />
          </button>
          {liveBitrateInput !== stream.targetBitrateKbps && (
            <button
              type="button"
              disabled={applyingBitrate}
              onClick={() => void applyLiveBitrate(liveBitrateInput)}
              className="inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-[11px] font-semibold text-white"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              <Check className="h-3 w-3" />
              Aplicar
            </button>
          )}
        </div>

        {stream.viewerUsers.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Assistindo:
            </span>
            {stream.viewerUsers.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() =>
                  setInspectedUser({
                    id: v.id,
                    username: v.username,
                    displayName: v.displayName,
                    avatarColor: v.avatarColor,
                    avatarUrl: v.avatarUrl ?? null,
                    bio: '',
                    presenceStatus: 'online',
                    role: v.role,
                    createdAt: new Date().toISOString(),
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-90"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--bg-elevated)',
                }}
              >
                <UserAvatar
                  user={{
                    displayName: v.displayName,
                    avatarColor: v.avatarColor,
                    avatarUrl: v.avatarUrl,
                  }}
                  size="xs"
                  className="!h-4 !w-4 !text-[8px]"
                />
                <StyledUserName name={v.displayName} role={v.role} />
                <UserRoleBadge role={v.role} compact />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
