import React, { useState } from 'react';
import {
  HeadphoneOff,
  Headphones,
  KeyRound,
  Lock,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Plus,
  Radio,
  Settings,
  ShieldCheck,
  Trash2,
  Volume2,
} from 'lucide-react';
import { hasRoleAtLeast, type RoomSummary } from '@aether/shared';
import { useAppStore } from '../store/useAppStore.js';
import { StyledUserName, UserRoleBadge } from './UserIdentity.js';

export const SidebarRooms: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const rooms = useAppStore((s) => s.rooms);
  const currentRoom = useAppStore((s) => s.currentRoom);
  const joiningRoomId = useAppStore((s) => s.joiningRoomId);
  const activeStreams = useAppStore((s) => s.activeStreams);

  const micMuted = useAppStore((s) => s.micMuted);
  const deafened = useAppStore((s) => s.deafened);
  const localSpeaking = useAppStore((s) => s.localSpeaking);

  const joinRoom = useAppStore((s) => s.joinRoom);
  const leaveRoom = useAppStore((s) => s.leaveRoom);
  const deleteRoom = useAppStore((s) => s.deleteRoom);
  const toggleMicMute = useAppStore((s) => s.toggleMicMute);
  const toggleDeafen = useAppStore((s) => s.toggleDeafen);
  const openSettings = useAppStore((s) => s.openSettings);
  const setAdminModalOpen = useAppStore((s) => s.setAdminModalOpen);
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const setStreamLauncherOpen = useAppStore((s) => s.setStreamLauncherOpen);
  const stopBroadcast = useAppStore((s) => s.stopBroadcast);
  const logout = useAppStore((s) => s.logout);
  const pushToast = useAppStore((s) => s.pushToast);

  const [passwordPromptRoom, setPasswordPromptRoom] = useState<RoomSummary | null>(null);
  const [roomPassword, setRoomPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const myActiveStream = activeStreams.find((s) => s.broadcasterId === user?.id) || null;

  const handleRoomClick = async (room: RoomSummary) => {
    if (currentRoom?.id === room.id) return;
    try {
      await joinRoom(room.id, null);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'PASSWORD_REQUIRED') {
        setPasswordPromptRoom(room);
        setRoomPassword('');
        setPasswordError(null);
      } else {
        pushToast({
          title: 'Não foi possível entrar na sala',
          body: err instanceof Error ? err.message : 'Tente novamente',
        });
      }
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordPromptRoom) return;
    setPasswordError(null);
    try {
      await joinRoom(passwordPromptRoom.id, roomPassword);
      setPasswordPromptRoom(null);
      setRoomPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Senha incorreta');
    }
  };

  const publicRooms = rooms.filter((r) => !r.isPrivate);
  const privateRooms = rooms.filter((r) => r.isPrivate);

  const renderRoomItem = (room: RoomSummary) => {
    const isActive = currentRoom?.id === room.id;
    const isJoining = joiningRoomId === room.id;
    const isOwner = user?.id === room.ownerId;

    return (
      <div key={room.id} className="group relative">
        <button
          type="button"
          onClick={() => void handleRoomClick(room)}
          disabled={isJoining}
          className="flex w-full flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left transition-all"
          style={{
            backgroundColor: isActive ? 'var(--bg-active)' : 'transparent',
            border: `1px solid ${isActive ? 'var(--border-focus)' : 'transparent'}`,
          }}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {room.isPrivate ? (
                <Lock className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
              ) : (
                <Volume2
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)' }}
                />
              )}
              <span
                className="truncate text-sm font-medium"
                style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              >
                {room.name}
              </span>
              {room.hasPassword && !room.isPrivate && (
                <KeyRound className="h-3 w-3 shrink-0" style={{ color: 'var(--text-muted)' }} />
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {room.activeStreamCount > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{
                    backgroundColor: 'var(--live-red-soft)',
                    color: 'var(--live-red)',
                  }}
                >
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-current" />
                  AO VIVO
                </span>
              )}
              {room.participantCount > 0 && (
                <span
                  className="rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
                  style={{
                    backgroundColor: 'var(--bg-hover)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {room.participantCount}
                </span>
              )}
            </div>
          </div>

          {room.participantsPreview.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pl-5 pt-0.5">
              {room.participantsPreview.map((p) => (
                <div
                  key={p.userId}
                  className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    backgroundColor: 'var(--bg-hover)',
                    color: 'var(--text-secondary)',
                    boxShadow: p.speaking ? '0 0 0 1.5px var(--voice-green)' : 'none',
                  }}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: p.speaking ? 'var(--voice-green)' : p.avatarColor }}
                  />
                  <span className="max-w-[96px] truncate">
                    <StyledUserName name={p.displayName} role={p.role} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </button>

        {(isOwner || hasRoleAtLeast(user?.role, 'admin')) && (
          <button
            type="button"
            title="Excluir sala"
            onClick={(e) => {
              e.stopPropagation();
              void deleteRoom(room.id).catch((err) =>
                pushToast({
                  title: 'Erro ao excluir sala',
                  body: err instanceof Error ? err.message : 'Tente novamente',
                })
              );
            }}
            className="absolute right-2 top-2.5 hidden h-6 w-6 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 group-hover:flex"
            style={{
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--live-red)',
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <aside
      className="flex h-full w-72 shrink-0 flex-col border-r select-none"
      style={{
        backgroundColor: 'var(--bg-sidebar)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      {/* Workspace Header */}
      <div
        className="flex h-14 items-center justify-between border-b px-4"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-xl text-xs font-bold text-white"
            style={{ background: 'linear-gradient(135deg, #2563EB, #0EA5E9)' }}
          >
            A
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Aether</div>
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: wsConnected ? 'var(--voice-green)' : 'var(--warn-amber)' }}
              />
              {wsConnected ? 'Conectado em Tempo Real' : 'Reconectando...'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setCreateRoomModalOpen(true)}
          title="Criar nova sala"
          className="flex h-8 w-8 items-center justify-center rounded-xl border transition-colors hover:opacity-90"
          style={{
            borderColor: 'var(--border-hairline)',
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-primary)',
          }}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Rooms Scroll Area */}
      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between px-2">
            <span
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              Salas Públicas
            </span>
          </div>
          <div className="space-y-1">{publicRooms.map(renderRoomItem)}</div>
        </div>

        {privateRooms.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between px-2">
              <span
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Salas Privadas
              </span>
            </div>
            <div className="space-y-1">{privateRooms.map(renderRoomItem)}</div>
          </div>
        )}
      </div>

      {/* Active Voice & Stream Quick Bar */}
      {currentRoom && (
        <div
          className="border-t px-3.5 py-3"
          style={{
            borderColor: 'var(--border-hairline)',
            backgroundColor: 'var(--bg-surface)',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div
                className="flex items-center gap-1.5 text-[11px] font-semibold"
                style={{ color: 'var(--voice-green)' }}
              >
                <Radio className="h-3 w-3" />
                Voz Conectada
              </div>
              <div className="truncate text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                {currentRoom.name}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {myActiveStream ? (
                <button
                  type="button"
                  onClick={() => void stopBroadcast()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: 'var(--live-red)' }}
                  title="Encerrar minha transmissão"
                >
                  Parar Live
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setStreamLauncherOpen(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: 'var(--accent)' }}
                  title="Transmitir tela ou jogo"
                >
                  <MonitorUp className="h-3.5 w-3.5" />
                  Transmitir
                </button>
              )}

              <button
                type="button"
                onClick={() => void leaveRoom()}
                title="Sair da sala rapidamente"
                className="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--live-red)',
                }}
              >
                <PhoneOff className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Personal Control Dock */}
      {user && (
        <div
          className="flex items-center justify-between gap-2 border-t px-3.5 py-3"
          style={{
            borderColor: 'var(--border-hairline)',
            backgroundColor: 'var(--bg-sidebar)',
          }}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white transition-shadow"
              style={{
                backgroundColor: user.avatarColor,
                boxShadow: localSpeaking ? '0 0 0 2.5px var(--voice-green)' : 'none',
              }}
            >
              {user.displayName.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5 text-xs">
                <StyledUserName name={user.displayName} role={user.role} />
                <UserRoleBadge role={user.role} compact />
              </div>
              <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                @{user.username}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={toggleMicMute}
              title={micMuted ? 'Ativar Microfone' : 'Silenciar Microfone'}
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
              style={{
                backgroundColor: micMuted ? 'var(--live-red-soft)' : 'transparent',
                color: micMuted ? 'var(--live-red)' : 'var(--text-secondary)',
              }}
            >
              {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={toggleDeafen}
              title={deafened ? 'Reativar Áudio' : 'Desativar Áudio de Voz'}
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
              style={{
                backgroundColor: deafened ? 'var(--live-red-soft)' : 'transparent',
                color: deafened ? 'var(--live-red)' : 'var(--text-secondary)',
              }}
            >
              {deafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => openSettings('audio')}
              title="Configurações Completas"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: 'var(--text-secondary)' }}
            >
              <Settings className="h-4 w-4" />
            </button>

            {hasRoleAtLeast(user.role, 'moderator') && (
              <button
                type="button"
                onClick={() => setAdminModalOpen(true)}
                title="Central de Administração"
                className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                style={{ color: user.role === 'owner' ? '#fbbf24' : '#60a5fa' }}
              >
                <ShieldCheck className="h-4 w-4" />
              </button>
            )}

            <button
              type="button"
              onClick={() => void logout()}
              title="Sair da conta"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: 'var(--text-muted)' }}
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Password Prompt Modal */}
      {passwordPromptRoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
        >
          <form
            onSubmit={handlePasswordSubmit}
            className="w-full max-w-sm rounded-2xl border p-6"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--border-hairline)',
              boxShadow: 'var(--shadow-modal)',
            }}
          >
            <div className="mb-4 flex items-center gap-2.5">
              <KeyRound className="h-5 w-5" style={{ color: 'var(--accent)' }} />
              <h3 className="text-base font-semibold">Sala protegida por senha</h3>
            </div>
            <p className="mb-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
              Informe a senha para entrar em <strong>{passwordPromptRoom.name}</strong>.
            </p>
            <input
              type="password"
              autoFocus
              required
              value={roomPassword}
              onChange={(e) => setRoomPassword(e.target.value)}
              placeholder="Senha da sala"
              className="mb-3 h-10 w-full rounded-xl border px-3.5 text-sm outline-none"
              style={{
                borderColor: 'var(--border-strong)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
              }}
            />
            {passwordError && (
              <p className="mb-3 text-xs" style={{ color: 'var(--live-red)' }}>
                {passwordError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPasswordPromptRoom(null)}
                className="h-9 rounded-xl px-4 text-xs font-medium"
                style={{ color: 'var(--text-secondary)' }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="h-9 rounded-xl px-4 text-xs font-semibold text-white"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                Entrar na Sala
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  );
};

