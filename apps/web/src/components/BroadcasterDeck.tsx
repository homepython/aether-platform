import React, { useEffect, useState } from 'react';
import { Clock, Eye, Monitor, Music2, Square, Zap } from 'lucide-react';
import type { ActiveStreamInfo } from '@aether/shared';
import { useAppStore } from '../store/useAppStore.js';

function formatElapsed(startedAtIso: string, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - new Date(startedAtIso).getTime()) / 1000));
  const hrs = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  return [hrs, mins, secs].map((n) => String(n).padStart(2, '0')).join(':');
}

export const BroadcasterDeck: React.FC<{ stream: ActiveStreamInfo }> = ({ stream }) => {
  const stopBroadcast = useAppStore((s) => s.stopBroadcast);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const audioStatusLabel = !stream.hasAudio
    ? 'Desativado'
    : stream.audioIsolationMode === 'process-isolated'
      ? 'Ativo • Isolado sem Loopback'
      : stream.audioIsolationMode === 'tab-isolated'
        ? 'Ativo • Aba Isolada'
        : 'Ativo • Estéreo 320 kbps';

  const resolutionDetail =
    stream.verifiedWidth && stream.verifiedHeight
      ? `${stream.resolution} (${stream.verifiedWidth}×${stream.verifiedHeight})`
      : stream.resolution;

  const fpsDetail =
    stream.verifiedFps && stream.verifiedFps > 0
      ? `${Math.round(stream.verifiedFps)} FPS`
      : `${stream.fps} FPS`;

  return (
    <div
      className="rounded-2xl border p-5 transition-all"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-hairline)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4" style={{ borderColor: 'var(--border-hairline)' }}>
        <div className="flex items-center gap-3">
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
          <div>
            <div className="text-sm font-semibold">{stream.title}</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Modo Transmissor de Alta Performance • Sem decodificação local de vídeo
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
          <div className="mt-1 text-lg font-semibold tabular-nums">{stream.viewerCount}</div>
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
            Tempo de Transmissão
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
            FPS
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
            Áudio Compartilhado
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

      {/* Live Real Viewers Strip */}
      {stream.viewerUsers.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-2 pt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Assistindo agora:
          </span>
          {stream.viewerUsers.map((v) => (
            <span
              key={v.id}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: v.avatarColor }} />
              {v.displayName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

