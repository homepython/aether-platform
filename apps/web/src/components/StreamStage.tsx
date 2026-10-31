import React, { useEffect, useRef } from 'react';
import {
  Eye,
  Maximize2,
  Minimize2,
  Play,
  Volume2,
  VolumeX,
  XCircle,
} from 'lucide-react';
import type { ActiveStreamInfo } from '@aether/shared';
import { useAppStore, type WatchedStreamViewState } from '../store/useAppStore.js';
import { BroadcasterDeck } from './BroadcasterDeck.js';

const ActiveWatchedPlayer: React.FC<{
  info: ActiveStreamInfo;
  watched: WatchedStreamViewState;
}> = ({ info, watched }) => {
  const unwatchStream = useAppStore((s) => s.unwatchStream);
  const setWatchedStreamVolume = useAppStore((s) => s.setWatchedStreamVolume);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = watched.videoStream;
    el.muted = true; // Audio plays on our isolated Zero-Ducking WebAudio Stream Context!
    void el.play().catch(() => {});
  }, [watched.videoStream]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement === containerRef.current) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await containerRef.current.requestFullscreen().catch(() => {});
    }
  };

  const displayQuality =
    watched.stats.height > 0
      ? `${info.resolution} (${watched.stats.width}×${watched.stats.height})`
      : info.resolution;

  const displayFps =
    watched.stats.fps > 0 ? `${Math.round(watched.stats.fps)} FPS` : `${info.fps} FPS`;

  return (
    <div
      ref={containerRef}
      className="group relative overflow-hidden rounded-2xl border bg-black"
      style={{
        borderColor: 'var(--border-hairline)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        className={`w-full bg-black object-contain ${
          isFullscreen ? 'h-screen max-h-screen' : 'aspect-video max-h-[54vh]'
        }`}
      />

      {/* Top HUD Bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/75 via-black/35 to-transparent p-3.5 text-white">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white shadow">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" />
            AO VIVO
          </span>
          <span className="text-xs font-semibold drop-shadow">{info.broadcasterDisplayName}</span>
          <span className="text-xs text-white/75">• {info.title}</span>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-semibold tabular-nums">
          <span className="rounded-md bg-black/60 px-2 py-0.5 backdrop-blur-md">
            {displayQuality}
          </span>
          <span className="rounded-md bg-black/60 px-2 py-0.5 backdrop-blur-md">{displayFps}</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-0.5 backdrop-blur-md">
            <Eye className="h-3 w-3" />
            {info.viewerCount}
          </span>
        </div>
      </div>

      {/* Bottom Interactive Controls */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-3.5 text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
        <div className="flex items-center gap-2.5">
          {watched.hasAudio ? (
            <>
              <button
                type="button"
                onClick={() =>
                  setWatchedStreamVolume(info.streamId, watched.volume, !watched.muted)
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 backdrop-blur-md transition-colors hover:bg-white/25"
                title={watched.muted ? 'Ativar áudio da transmissão' : 'Silenciar transmissão'}
              >
                {watched.muted || watched.volume === 0 ? (
                  <VolumeX className="h-4 w-4 text-red-400" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>

              <input
                type="range"
                min={0}
                max={200}
                value={watched.muted ? 0 : watched.volume}
                onChange={(e) =>
                  setWatchedStreamVolume(info.streamId, Number(e.target.value), false)
                }
                className="aether-range w-24"
                title={`Volume da live: ${watched.volume}%`}
              />
              <span className="w-10 text-[11px] font-medium tabular-nums text-white/85">
                {watched.muted ? 'Mudo' : `${watched.volume}%`}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-white/65">Transmissão sem áudio compartilhado</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void unwatchStream(info.streamId)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/15 px-3 text-xs font-medium text-white backdrop-blur-md transition-colors hover:bg-red-600"
          >
            <XCircle className="h-3.5 w-3.5" />
            Parar de assistir
          </button>

          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 backdrop-blur-md transition-colors hover:bg-white/25"
            title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
};

export const StreamStage: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const activeStreams = useAppStore((s) => s.activeStreams);
  const watchedStreams = useAppStore((s) => s.watchedStreams);
  const watchStream = useAppStore((s) => s.watchStream);
  const pushToast = useAppStore((s) => s.pushToast);

  if (activeStreams.length === 0) return null;

  const myStream = activeStreams.find((s) => s.broadcasterId === user?.id) || null;
  const remoteStreams = activeStreams.filter((s) => s.broadcasterId !== user?.id);
  const unwatchedRemoteStreams = remoteStreams.filter((s) => !watchedStreams[s.streamId]);
  const watchedRemoteStreams = remoteStreams.filter((s) => Boolean(watchedStreams[s.streamId]));

  return (
    <div className="space-y-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-hairline)' }}>
      {/* Broadcaster Telemetry Deck (No Self-Preview Video!) */}
      {myStream && <BroadcasterDeck stream={myStream} />}

      {/* Active Watched Video Players */}
      {watchedRemoteStreams.length > 0 && (
        <div
          className={`grid gap-4 ${
            watchedRemoteStreams.length > 1 ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'
          }`}
        >
          {watchedRemoteStreams.map((st) => (
            <ActiveWatchedPlayer
              key={st.streamId}
              info={st}
              watched={watchedStreams[st.streamId]}
            />
          ))}
        </div>
      )}

      {/* Available Remote Streams Cards */}
      {unwatchedRemoteStreams.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {unwatchedRemoteStreams.map((st) => (
            <div
              key={st.streamId}
              className="flex flex-1 min-w-[280px] items-center justify-between gap-4 rounded-2xl border px-4 py-3"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                    style={{
                      backgroundColor: 'var(--live-red-soft)',
                      color: 'var(--live-red)',
                    }}
                  >
                    <span className="live-dot h-1.5 w-1.5 rounded-full bg-current" />
                    AO VIVO
                  </span>
                  <span className="truncate text-sm font-semibold">
                    {st.broadcasterDisplayName}
                  </span>
                </div>
                <div
                  className="mt-1 flex items-center gap-2 text-xs tabular-nums"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <span className="truncate">{st.title}</span>
                  <span>•</span>
                  <span>
                    {st.resolution} {st.fps} FPS
                  </span>
                  <span>•</span>
                  <span className="inline-flex items-center gap-1">
                    <Eye className="h-3 w-3" /> {st.viewerCount}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  void watchStream(st.streamId).catch((err) =>
                    pushToast({
                      title: 'Falha ao abrir transmissão',
                      body: err instanceof Error ? err.message : 'Tente novamente',
                    })
                  )
                }
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Assistir
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

