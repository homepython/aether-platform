import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Download,
  Lock,
  MonitorUp,
  Moon,
  Plus,
  Radio,
  Sun,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { audioEngine } from '../audio/AudioEngine.js';
import { getDesktopApi } from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';
import { ChatPanel } from './ChatPanel.js';
import { CreateRoomModal } from './CreateRoomModal.js';
import { ParticipantsDrawer } from './ParticipantsDrawer.js';
import { SettingsModal } from './SettingsModal.js';
import { SidebarRooms } from './SidebarRooms.js';
import { StreamLauncherModal } from './StreamLauncherModal.js';
import { StreamStage } from './StreamStage.js';

function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split('+');
  const mainKey = parts[parts.length - 1];
  const needCtrl = parts.includes('Control');
  const needShift = parts.includes('Shift');
  const needAlt = parts.includes('Alt');
  if (e.ctrlKey !== needCtrl || e.shiftKey !== needShift || e.altKey !== needAlt) return false;
  return e.code === mainKey || e.key.toLowerCase() === mainKey.toLowerCase();
}

export const WorkspaceShell: React.FC = () => {
  const currentRoom = useAppStore((s) => s.currentRoom);
  const rooms = useAppStore((s) => s.rooms);
  const participants = useAppStore((s) => s.participants);
  const activeStreams = useAppStore((s) => s.activeStreams);
  const user = useAppStore((s) => s.user);
  const settings = useAppStore((s) => s.settings);

  const joinRoom = useAppStore((s) => s.joinRoom);
  const toggleMicMute = useAppStore((s) => s.toggleMicMute);
  const toggleDeafen = useAppStore((s) => s.toggleDeafen);
  const stopBroadcast = useAppStore((s) => s.stopBroadcast);
  const setStreamLauncherOpen = useAppStore((s) => s.setStreamLauncherOpen);
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const lightboxImageUrl = useAppStore((s) => s.lightboxImageUrl);
  const setLightboxImageUrl = useAppStore((s) => s.setLightboxImageUrl);
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const pushToast = useAppStore((s) => s.pushToast);

  // Desktop Native Global PTT & Shortcuts Listener
  useEffect(() => {
    const desktop = getDesktopApi();
    if (!desktop) return;

    const unsubPtt = desktop.onPttState((pressed) => {
      audioEngine.setPushToTalkPressed(pressed);
    });

    const unsubShortcut = desktop.onShortcutTriggered((action) => {
      if (action === 'toggleMute') useAppStore.getState().toggleMicMute();
      else if (action === 'toggleDeafen') useAppStore.getState().toggleDeafen();
      else if (action === 'stopStream') void useAppStore.getState().stopBroadcast();
      else if (action === 'toggleOverlay') {
        useAppStore.getState().updateSettings((prev) => ({
          ...prev,
          app: {
            ...prev.app,
            overlay: { ...prev.app.overlay, enabled: !prev.app.overlay.enabled },
          },
        }));
      }
    });

    return () => {
      unsubPtt();
      unsubShortcut();
    };
  }, []);

  // Browser / In-Window PTT & Shortcuts Listener
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useAppStore.getState().lightboxImageUrl) {
        useAppStore.getState().setLightboxImageUrl(null);
        return;
      }

      const st = useAppStore.getState().settings;
      if (
        st.audio.voiceMode === 'ptt' &&
        !isTypingTarget(e.target) &&
        matchesCombo(e, st.audio.pttKey)
      ) {
        if (!e.repeat) audioEngine.setPushToTalkPressed(true);
        return;
      }

      if (matchesCombo(e, st.app.shortcuts.toggleMute)) {
        e.preventDefault();
        useAppStore.getState().toggleMicMute();
      } else if (matchesCombo(e, st.app.shortcuts.toggleDeafen)) {
        e.preventDefault();
        useAppStore.getState().toggleDeafen();
      } else if (matchesCombo(e, st.app.shortcuts.stopStream)) {
        e.preventDefault();
        void useAppStore.getState().stopBroadcast();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const st = useAppStore.getState().settings;
      if (st.audio.voiceMode === 'ptt' && matchesCombo(e, st.audio.pttKey)) {
        audioEngine.setPushToTalkPressed(false);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      const st = useAppStore.getState().settings;
      if (st.audio.voiceMode !== 'ptt') return;
      if ((e.button === 3 && st.audio.pttKey === 'Mouse4') || (e.button === 4 && st.audio.pttKey === 'Mouse5')) {
        audioEngine.setPushToTalkPressed(true);
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      const st = useAppStore.getState().settings;
      if (st.audio.voiceMode !== 'ptt') return;
      if ((e.button === 3 && st.audio.pttKey === 'Mouse4') || (e.button === 4 && st.audio.pttKey === 'Mouse5')) {
        audioEngine.setPushToTalkPressed(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [toggleMicMute, toggleDeafen, stopBroadcast]);

  const myActiveStream = activeStreams.find((s) => s.broadcasterId === user?.id) || null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <SidebarRooms />

      {/* Center Stage */}
      <main
        className="flex min-w-0 flex-1 flex-col overflow-hidden"
        style={{ backgroundColor: 'var(--bg-canvas)' }}
      >
        {currentRoom ? (
          <>
            {/* Room Top Bar */}
            <header
              className="flex h-14 shrink-0 items-center justify-between border-b px-5"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-surface)',
              }}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {currentRoom.isPrivate ? (
                  <Lock className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                ) : (
                  <Volume2 className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                )}
                <h1 className="truncate text-sm font-semibold">{currentRoom.name}</h1>
                {currentRoom.description && (
                  <span
                    className="hidden truncate text-xs md:inline"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    — {currentRoom.description}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {settings.audio.voiceMode === 'ptt' && (
                  <span
                    className="hidden rounded-lg border px-2.5 py-1 text-[11px] font-medium sm:inline-block"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    PTT: <strong>{settings.audio.pttKey}</strong>
                  </span>
                )}

                {!myActiveStream && (
                  <button
                    type="button"
                    onClick={() => setStreamLauncherOpen(true)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    <MonitorUp className="h-3.5 w-3.5" />
                    Transmitir em 2K / 1080p
                  </button>
                )}

                <button
                  type="button"
                  onClick={() =>
                    updateSettings((prev) => ({
                      ...prev,
                      interface: {
                        ...prev.interface,
                        theme: prev.interface.theme === 'dark' ? 'light' : 'dark',
                      },
                    }))
                  }
                  className="flex h-8 w-8 items-center justify-center rounded-xl border transition-colors"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                  }}
                  title="Alternar Tema Claro / Escuro"
                >
                  {settings.interface.theme === 'dark' ? (
                    <Sun className="h-3.5 w-3.5" />
                  ) : (
                    <Moon className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </header>

            {/* Live Broadcasts Stage + Modern Chat */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <StreamStage />
              <ChatPanel />
            </div>
          </>
        ) : (
          /* Lobby Overview when no room is active yet */
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto p-8">
            <div className="w-full max-w-2xl">
              <div className="mb-8 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    Escolha uma sala para conectar
                  </h2>
                  <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Entrada instantânea em voz de baixa latência, chat rico e transmissões 1440p 75 FPS.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setCreateRoomModalOpen(true)}
                  className="inline-flex h-10 items-center gap-1.5 rounded-xl px-4 text-xs font-semibold text-white"
                  style={{ backgroundColor: 'var(--accent)' }}
                >
                  <Plus className="h-4 w-4" />
                  Nova Sala
                </button>
              </div>

              <div className="grid gap-3.5 sm:grid-cols-2">
                {rooms.map((room) => (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() =>
                      void joinRoom(room.id, null).catch((err) =>
                        pushToast({
                          title: 'Acesso à sala',
                          body:
                            err instanceof Error
                              ? err.message
                              : 'Selecione a sala na barra lateral para informar a senha.',
                        })
                      )
                    }
                    className="flex flex-col justify-between rounded-2xl border p-5 text-left transition-all hover:scale-[1.01]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      borderColor: 'var(--border-hairline)',
                      boxShadow: 'var(--shadow-card)',
                    }}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-semibold">
                          {room.isPrivate ? (
                            <Lock className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                          ) : (
                            <Radio className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                          )}
                          <span>{room.name}</span>
                        </div>
                        {room.activeStreamCount > 0 && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                            style={{
                              backgroundColor: 'var(--live-red-soft)',
                              color: 'var(--live-red)',
                            }}
                          >
                            {room.activeStreamCount} AO VIVO
                          </span>
                        )}
                      </div>
                      {room.description && (
                        <p className="mt-1.5 line-clamp-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {room.description}
                        </p>
                      )}
                    </div>

                    <div
                      className="mt-4 flex items-center justify-between pt-3 text-xs tabular-nums"
                      style={{
                        borderTop: '1px solid var(--border-hairline)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5" />
                        {room.participantCount} conectados
                      </span>
                      <span style={{ color: 'var(--accent)' }} className="font-semibold">
                        Entrar →
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {currentRoom && <ParticipantsDrawer />}

      {/* Modals */}
      <CreateRoomModal />
      <StreamLauncherModal />
      <SettingsModal />

      {/* Fullscreen Image Lightbox */}
      <AnimatePresence>
        {lightboxImageUrl && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightboxImageUrl(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-md"
          >
            <div
              className="relative max-h-[90vh] max-w-[92vw]"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={lightboxImageUrl}
                alt="Visualização ampliada"
                className="max-h-[85vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl"
              />
              <div className="mt-3 flex justify-end gap-2">
                <a
                  href={lightboxImageUrl}
                  download
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-white/15 px-3.5 text-xs font-medium text-white backdrop-blur hover:bg-white/25"
                >
                  <Download className="h-3.5 w-3.5" />
                  Baixar original
                </a>
                <button
                  type="button"
                  onClick={() => setLightboxImageUrl(null)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-white/15 px-3.5 text-xs font-medium text-white backdrop-blur hover:bg-white/25"
                >
                  <X className="h-3.5 w-3.5" />
                  Fechar
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Real-Time Toast Notifications */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col gap-2.5">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              className="pointer-events-auto flex w-80 items-start justify-between gap-3 rounded-2xl border p-4"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor: 'var(--border-strong)',
                boxShadow: 'var(--shadow-modal)',
              }}
            >
              <div
                className="min-w-0 flex-1 cursor-pointer"
                onClick={() => {
                  if (t.roomId && t.roomId !== participants[0]?.peerId) {
                    void joinRoom(t.roomId, null).catch(() => {});
                  }
                  dismissToast(t.id);
                }}
              >
                <div className="text-xs font-semibold">{t.title}</div>
                <div className="mt-0.5 line-clamp-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t.body}
                </div>
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="rounded-lg p-1 opacity-60 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};

