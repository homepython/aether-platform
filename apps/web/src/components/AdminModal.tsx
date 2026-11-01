import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Crown,
  DoorOpen,
  FileClock,
  KeyRound,
  Loader2,
  MicOff,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {
  hasRoleAtLeast,
  ROLE_RANK,
  type AdminAuditLogEntry,
  type AdminUserRecord,
} from '@aether/shared';
import { api } from '../api/httpClient.js';
import { useAppStore } from '../store/useAppStore.js';
import { ROLE_LABELS, StyledUserName, UserRoleBadge } from './UserIdentity.js';

type AdminTab = 'users' | 'moderation' | 'audit' | 'masterkey';

export const AdminModal: React.FC = () => {
  const open = useAppStore((s) => s.adminModalOpen);
  const setOpen = useAppStore((s) => s.setAdminModalOpen);
  const user = useAppStore((s) => s.user);
  const rooms = useAppStore((s) => s.rooms);
  const currentRoom = useAppStore((s) => s.currentRoom);
  const participants = useAppStore((s) => s.participants);
  const activeStreams = useAppStore((s) => s.activeStreams);

  const claimOwnerRole = useAppStore((s) => s.claimOwnerRole);
  const deleteRoom = useAppStore((s) => s.deleteRoom);
  const joinRoom = useAppStore((s) => s.joinRoom);
  const kickParticipant = useAppStore((s) => s.kickParticipant);
  const forceMuteParticipant = useAppStore((s) => s.forceMuteParticipant);
  const forceStopStream = useAppStore((s) => s.forceStopStream);
  const pushToast = useAppStore((s) => s.pushToast);

  const isAdminOrOwner = hasRoleAtLeast(user?.role, 'admin');
  const isModeratorPlus = hasRoleAtLeast(user?.role, 'moderator');

  const [tab, setTab] = useState<AdminTab>('users');
  const [usersList, setUsersList] = useState<AdminUserRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [banReasonDrafts, setBanReasonDrafts] = useState<Record<string, string>>({});

  const [masterKeyInput, setMasterKeyInput] = useState('');
  const [claimingKey, setClaimingKey] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!isAdminOrOwner) return;
    setLoading(true);
    try {
      const [uRes, aRes] = await Promise.all([
        api.listAdminUsers(),
        api.listAdminAuditLogs(),
      ]);
      setUsersList(uRes.users);
      setAuditLogs(aRes.logs);
    } catch (err) {
      pushToast({
        title: 'Falha ao carregar dados administrativos',
        body: err instanceof Error ? err.message : 'Verifique sua conexão',
      });
    } finally {
      setLoading(false);
    }
  }, [isAdminOrOwner, pushToast]);

  useEffect(() => {
    if (!open) {
      setMasterKeyInput('');
      setClaimError(null);
      return;
    }
    if (isAdminOrOwner) {
      setTab('users');
      void loadData();
    } else if (isModeratorPlus) {
      setTab('moderation');
    } else {
      setTab('masterkey');
    }
  }, [open, isAdminOrOwner, isModeratorPlus, loadData]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return usersList;
    return usersList.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        ROLE_LABELS[u.role].toLowerCase().includes(q)
    );
  }, [usersList, search]);

  if (!open || !user) return null;

  const handleRoleChange = async (
    target: AdminUserRecord,
    nextRole: 'admin' | 'moderator' | 'member'
  ) => {
    if (nextRole === target.role) return;
    setBusyUserId(target.id);
    try {
      await api.updateUserRole(target.id, nextRole);
      pushToast({
        title: 'Cargo atualizado',
        body: `@${target.username} agora é ${ROLE_LABELS[nextRole]}.`,
      });
      await loadData();
    } catch (err) {
      pushToast({
        title: 'Não foi possível alterar o cargo',
        body: err instanceof Error ? err.message : 'Tente novamente',
      });
    } finally {
      setBusyUserId(null);
    }
  };

  const handleToggleBan = async (target: AdminUserRecord) => {
    setBusyUserId(target.id);
    try {
      const nextBanned = !target.isBanned;
      const reason = banReasonDrafts[target.id]?.trim() || 'Violação das diretrizes da plataforma';
      await api.setUserBan(target.id, nextBanned, nextBanned ? reason : null);
      pushToast({
        title: nextBanned ? 'Conta suspensa' : 'Conta reativada',
        body: nextBanned
          ? `@${target.username} foi desconectado e suspenso.`
          : `O acesso de @${target.username} foi restaurado.`,
      });
      await loadData();
    } catch (err) {
      pushToast({
        title: 'Falha na ação de suspensão',
        body: err instanceof Error ? err.message : 'Tente novamente',
      });
    } finally {
      setBusyUserId(null);
    }
  };

  const handleClaimMasterKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!masterKeyInput.trim()) return;
    setClaimError(null);
    setClaimingKey(true);
    try {
      await claimOwnerRole(masterKeyInput.trim());
      setMasterKeyInput('');
      pushToast({
        title: 'Credencial Fundador ativada',
        body: 'Sua conta agora possui autoridade máxima permanente em qualquer computador.',
      });
      setTab('users');
      await loadData();
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Chave mestre inválida');
    } finally {
      setClaimingKey(false);
    }
  };

  const roomNameById = new Map(rooms.map((r) => [r.id, r.name]));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
    >
      <div
        className="flex h-[84vh] w-full max-w-5xl overflow-hidden rounded-3xl border"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        {/* Left Navigation */}
        <div
          className="flex w-60 shrink-0 flex-col justify-between border-r p-4"
          style={{
            backgroundColor: 'var(--bg-sidebar)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="space-y-1">
            <div className="mb-4 px-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
                <ShieldCheck className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                <span>Central Admin</span>
              </div>
              <div className="mt-1.5">
                <UserRoleBadge role={user.role} />
              </div>
            </div>

            {isAdminOrOwner && (
              <button
                type="button"
                onClick={() => setTab('users')}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition-all"
                style={{
                  backgroundColor: tab === 'users' ? 'var(--bg-active)' : 'transparent',
                  color: tab === 'users' ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <Users className="h-4 w-4" style={{ color: tab === 'users' ? 'var(--accent)' : 'var(--text-muted)' }} />
                Usuários & Cargos
              </button>
            )}

            {isModeratorPlus && (
              <button
                type="button"
                onClick={() => setTab('moderation')}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition-all"
                style={{
                  backgroundColor: tab === 'moderation' ? 'var(--bg-active)' : 'transparent',
                  color: tab === 'moderation' ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <ShieldAlert
                  className="h-4 w-4"
                  style={{ color: tab === 'moderation' ? 'var(--accent)' : 'var(--text-muted)' }}
                />
                Salas & Moderação Vivo
              </button>
            )}

            {isAdminOrOwner && (
              <button
                type="button"
                onClick={() => setTab('audit')}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition-all"
                style={{
                  backgroundColor: tab === 'audit' ? 'var(--bg-active)' : 'transparent',
                  color: tab === 'audit' ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <FileClock
                  className="h-4 w-4"
                  style={{ color: tab === 'audit' ? 'var(--accent)' : 'var(--text-muted)' }}
                />
                Registro de Auditoria
              </button>
            )}

            <button
              type="button"
              onClick={() => setTab('masterkey')}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition-all"
              style={{
                backgroundColor: tab === 'masterkey' ? 'var(--bg-active)' : 'transparent',
                color: tab === 'masterkey' ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              <Crown
                className="h-4 w-4"
                style={{ color: tab === 'masterkey' ? '#f59e0b' : 'var(--text-muted)' }}
              />
              Chave Mestre (Fundador)
            </button>
          </div>

          <div className="px-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Permissões validadas no servidor em tempo real • Vinculadas à sua conta em qualquer PC.
          </div>
        </div>

        {/* Main Panel */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div
            className="flex items-center justify-between border-b px-7 py-4"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <div>
              <h2 className="text-base font-semibold">
                {tab === 'users' && 'Gestão de Contas, Hierarquia & Acessos'}
                {tab === 'moderation' && 'Moderação Instantânea de Salas, Voz & Lives'}
                {tab === 'audit' && 'Histórico Criptográfico de Ações Administrativas'}
                {tab === 'masterkey' && 'Credencial Soberana de Fundador (Owner)'}
              </h2>
            </div>

            <div className="flex items-center gap-2">
              {isAdminOrOwner && (tab === 'users' || tab === 'audit') && (
                <button
                  type="button"
                  onClick={() => void loadData()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                  Atualizar
                </button>
              )}

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

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {/* TAB: USERS & ROLES */}
            {tab === 'users' && isAdminOrOwner && (
              <div className="space-y-4">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2"
                    style={{ color: 'var(--text-muted)' }}
                  />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar por nome de exibição, @usuário ou cargo..."
                    className="h-10 w-full rounded-xl border pl-10 pr-4 text-xs outline-none"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div className="space-y-2.5">
                  {filteredUsers.map((u) => {
                    const isSelf = u.id === user.id;
                    const isTargetOwner = u.role === 'owner';
                    const canChangeRole =
                      !isSelf &&
                      !isTargetOwner &&
                      (user.role === 'owner' || u.role !== 'admin');
                    const canBan =
                      !isSelf &&
                      !isTargetOwner &&
                      (user.role === 'owner' || ROLE_RANK[user.role] > ROLE_RANK[u.role]);
                    const isBusy = busyUserId === u.id;

                    return (
                      <div
                        key={u.id}
                        className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4"
                        style={{
                          backgroundColor: 'var(--bg-elevated)',
                          borderColor: u.isBanned
                            ? 'rgba(239, 68, 68, 0.45)'
                            : 'var(--border-hairline)',
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                            style={{ backgroundColor: u.avatarColor }}
                          >
                            {u.displayName.slice(0, 2).toUpperCase()}
                            <span
                              className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2"
                              style={{
                                borderColor: 'var(--bg-elevated)',
                                backgroundColor: u.isOnline
                                  ? 'var(--voice-green)'
                                  : 'var(--text-muted)',
                              }}
                              title={u.isOnline ? 'Online agora' : 'Offline'}
                            />
                          </div>

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <StyledUserName
                                name={u.displayName}
                                role={u.role}
                                suffix={isSelf ? '(Você)' : undefined}
                                className="text-sm font-semibold"
                              />
                              <UserRoleBadge role={u.role} compact />
                              {u.isBanned && (
                                <span
                                  className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                                  style={{
                                    backgroundColor: 'var(--live-red-soft)',
                                    color: 'var(--live-red)',
                                  }}
                                >
                                  Suspenso
                                </span>
                              )}
                            </div>

                            <div
                              className="mt-0.5 flex flex-wrap items-center gap-2 text-xs"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              <span>@{u.username}</span>
                              {u.currentRoomId && (
                                <span>
                                  • Na sala:{' '}
                                  <strong style={{ color: 'var(--text-secondary)' }}>
                                    {roomNameById.get(u.currentRoomId) || u.currentRoomId}
                                  </strong>
                                </span>
                              )}
                              {u.isBanned && u.banReason && (
                                <span style={{ color: 'var(--live-red)' }}>
                                  • Motivo: {u.banReason}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {canChangeRole && (
                            <select
                              disabled={isBusy}
                              value={u.role === 'owner' ? 'admin' : u.role}
                              onChange={(e) =>
                                void handleRoleChange(
                                  u,
                                  e.target.value as 'admin' | 'moderator' | 'member'
                                )
                              }
                              className="h-9 rounded-xl border px-3 text-xs font-medium outline-none"
                              style={{
                                borderColor: 'var(--border-strong)',
                                backgroundColor: 'var(--bg-surface)',
                                color: 'var(--text-primary)',
                              }}
                            >
                              {user.role === 'owner' && (
                                <option value="admin">Administrador</option>
                              )}
                              <option value="moderator">Moderador</option>
                              <option value="member">Membro</option>
                            </select>
                          )}

                          {canBan && (
                            <div className="flex items-center gap-1.5">
                              {!u.isBanned && (
                                <input
                                  type="text"
                                  value={banReasonDrafts[u.id] || ''}
                                  onChange={(e) =>
                                    setBanReasonDrafts((prev) => ({
                                      ...prev,
                                      [u.id]: e.target.value,
                                    }))
                                  }
                                  placeholder="Motivo (opcional)"
                                  className="h-9 w-36 rounded-xl border px-2.5 text-xs outline-none"
                                  style={{
                                    borderColor: 'var(--border-hairline)',
                                    backgroundColor: 'var(--bg-surface)',
                                    color: 'var(--text-primary)',
                                  }}
                                />
                              )}

                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleToggleBan(u)}
                                className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition-opacity disabled:opacity-50"
                                style={{
                                  backgroundColor: u.isBanned
                                    ? 'var(--voice-green-soft)'
                                    : 'var(--live-red-soft)',
                                  color: u.isBanned ? 'var(--voice-green)' : 'var(--live-red)',
                                }}
                              >
                                {isBusy ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : u.isBanned ? (
                                  <UserCheck className="h-3.5 w-3.5" />
                                ) : (
                                  <Ban className="h-3.5 w-3.5" />
                                )}
                                {u.isBanned ? 'Reativar' : 'Suspender'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TAB: REAL-TIME ROOMS & MODERATION */}
            {tab === 'moderation' && isModeratorPlus && (
              <div className="space-y-6">
                {/* Active Room Participants & Streams */}
                {currentRoom ? (
                  <div
                    className="space-y-4 rounded-2xl border p-5"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      borderColor: 'var(--border-hairline)',
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold">
                          Sala Atual: #{currentRoom.name}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Ações aplicadas em tempo real via WebSocket
                        </div>
                      </div>
                    </div>

                    {activeStreams.length > 0 && (
                      <div className="space-y-2">
                        <div
                          className="text-[11px] font-semibold uppercase tracking-wider"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Transmissões Ativas na Sala
                        </div>
                        {activeStreams.map((st) => (
                          <div
                            key={st.streamId}
                            className="flex items-center justify-between rounded-xl border px-3.5 py-2.5"
                            style={{
                              backgroundColor: 'var(--bg-surface)',
                              borderColor: 'var(--border-hairline)',
                            }}
                          >
                            <div className="flex items-center gap-2 text-xs">
                              <Radio className="h-3.5 w-3.5" style={{ color: 'var(--live-red)' }} />
                              <StyledUserName
                                name={st.broadcasterDisplayName}
                                role={st.broadcasterRole}
                                className="font-semibold"
                              />
                              <span style={{ color: 'var(--text-muted)' }}>
                                • {st.title} ({st.resolution} {st.fps} FPS)
                              </span>
                            </div>

                            {(user.role === 'owner' ||
                              ROLE_RANK[user.role] >
                                ROLE_RANK[st.broadcasterRole ?? 'member']) && (
                              <button
                                type="button"
                                onClick={() =>
                                  void forceStopStream(
                                    st.streamId,
                                    'Encerrada pela moderação'
                                  ).catch((err) =>
                                    pushToast({
                                      title: 'Erro ao encerrar transmissão',
                                      body: err instanceof Error ? err.message : '',
                                    })
                                  )
                                }
                                className="rounded-lg px-2.5 py-1 text-xs font-semibold"
                                style={{
                                  backgroundColor: 'var(--live-red-soft)',
                                  color: 'var(--live-red)',
                                }}
                              >
                                Encerrar Live
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="space-y-2">
                      <div
                        className="text-[11px] font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Participantes Conectados ({participants.length})
                      </div>
                      {participants.map((p) => {
                        const canModeratePeer =
                          p.user.id !== user.id &&
                          (user.role === 'owner' || ROLE_RANK[user.role] > ROLE_RANK[p.user.role]);
                        return (
                          <div
                            key={p.peerId}
                            className="flex items-center justify-between rounded-xl border px-3.5 py-2.5"
                            style={{
                              backgroundColor: 'var(--bg-surface)',
                              borderColor: 'var(--border-hairline)',
                            }}
                          >
                            <div className="flex items-center gap-2.5 text-xs">
                              <span
                                className="h-2.5 w-2.5 rounded-full"
                                style={{ backgroundColor: p.user.avatarColor }}
                              />
                              <StyledUserName
                                name={p.user.displayName}
                                role={p.user.role}
                                className="font-semibold"
                              />
                              <UserRoleBadge role={p.user.role} compact />
                            </div>

                            {canModeratePeer && (
                              <div className="flex items-center gap-2">
                                {!p.micMuted && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void forceMuteParticipant(p.peerId).catch((err) =>
                                        pushToast({
                                          title: 'Falha ao silenciar',
                                          body: err instanceof Error ? err.message : '',
                                        })
                                      )
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold"
                                    style={{
                                      borderColor: 'var(--border-hairline)',
                                      color: 'var(--text-secondary)',
                                    }}
                                  >
                                    <MicOff className="h-3 w-3" />
                                    Silenciar
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    void kickParticipant(
                                      p.peerId,
                                      'Removido pela moderação'
                                    ).catch((err) =>
                                      pushToast({
                                        title: 'Falha ao remover',
                                        body: err instanceof Error ? err.message : '',
                                      })
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold"
                                  style={{
                                    backgroundColor: 'var(--live-red-soft)',
                                    color: 'var(--live-red)',
                                  }}
                                >
                                  <DoorOpen className="h-3 w-3" />
                                  Expulsar da Sala
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div
                    className="rounded-2xl border p-4 text-xs"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Entre em qualquer sala abaixo para inspecionar e moderar participantes ou lives em tempo real.
                  </div>
                )}

                {/* All Server Rooms */}
                <div className="space-y-2.5">
                  <div
                    className="text-xs font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Todas as Salas do Servidor ({rooms.length})
                  </div>
                  {rooms.map((room) => (
                    <div
                      key={room.id}
                      className="flex items-center justify-between gap-3 rounded-2xl border px-4 py-3"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        borderColor: 'var(--border-hairline)',
                      }}
                    >
                      <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <span>{room.name}</span>
                          {room.isPrivate && (
                            <span
                              className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                              style={{
                                backgroundColor: 'var(--accent-soft)',
                                color: 'var(--accent)',
                              }}
                            >
                              Privada
                            </span>
                          )}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {room.participantCount} conectados • {room.activeStreamCount} ao vivo
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {currentRoom?.id !== room.id && (
                          <button
                            type="button"
                            onClick={() => {
                              void joinRoom(room.id, null)
                                .then(() => setOpen(false))
                                .catch((err) =>
                                  pushToast({
                                    title: 'Erro ao entrar na sala',
                                    body: err instanceof Error ? err.message : '',
                                  })
                                );
                            }}
                            className="h-8 rounded-xl px-3 text-xs font-semibold text-white"
                            style={{ backgroundColor: 'var(--accent)' }}
                          >
                            Inspecionar Sala
                          </button>
                        )}

                        {isAdminOrOwner && (
                          <button
                            type="button"
                            onClick={() =>
                              void deleteRoom(room.id).catch((err) =>
                                pushToast({
                                  title: 'Erro ao excluir sala',
                                  body: err instanceof Error ? err.message : '',
                                })
                              )
                            }
                            className="inline-flex h-8 items-center gap-1 rounded-xl px-3 text-xs font-semibold"
                            style={{
                              backgroundColor: 'var(--live-red-soft)',
                              color: 'var(--live-red)',
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Excluir
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB: AUDIT LOGS */}
            {tab === 'audit' && isAdminOrOwner && (
              <div className="space-y-2.5">
                {auditLogs.length === 0 ? (
                  <div
                    className="rounded-2xl border p-6 text-center text-xs"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Nenhum evento administrativo registrado até o momento.
                  </div>
                ) : (
                  auditLogs.map((log) => (
                    <div
                      key={log.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-xs"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        borderColor: 'var(--border-hairline)',
                      }}
                    >
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <StyledUserName
                            name={log.actorDisplayName}
                            role={log.actorRole}
                            className="font-semibold"
                          />
                          <UserRoleBadge role={log.actorRole} compact />
                          <span
                            className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                            style={{
                              backgroundColor: 'var(--bg-surface)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {log.action}
                          </span>
                          {log.targetUsername && (
                            <span style={{ color: 'var(--text-secondary)' }}>
                              → <strong>@{log.targetUsername}</strong>
                            </span>
                          )}
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>{log.details}</div>
                      </div>

                      <div className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                        {new Date(log.createdAt).toLocaleString('pt-BR')}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* TAB: MASTER KEY OWNER CLAIM */}
            {tab === 'masterkey' && (
              <div className="mx-auto max-w-lg space-y-5 py-4">
                <div
                  className="rounded-2xl border p-5"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    borderColor: 'var(--border-hairline)',
                  }}
                >
                  <div className="flex items-center gap-2.5 text-sm font-semibold">
                    <Crown className="h-5 w-5 text-amber-400" />
                    <span>Ativação de Fundador (Owner) em Nuvem</span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Ao validar a <strong>Chave Mestre Administrativa</strong> do servidor uma única vez,
                    sua conta (<strong>@{user.username}</strong>) recebe permanentemente o cargo soberano de{' '}
                    <strong>Fundador</strong> no banco de dados. Você terá acesso administrativo automático
                    ao entrar nesta conta em <strong>qualquer computador</strong>, podendo também promover
                    outros usuários a Administradores ou Moderadores.
                  </p>

                  {user.role === 'owner' ? (
                    <div
                      className="mt-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-semibold"
                      style={{
                        borderColor: 'rgba(251, 191, 36, 0.4)',
                        backgroundColor: 'rgba(245, 158, 11, 0.12)',
                        color: '#fbbf24',
                      }}
                    >
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      Esta conta já possui autoridade máxima de Fundador ativa!
                    </div>
                  ) : (
                    <form onSubmit={handleClaimMasterKey} className="mt-4 space-y-3">
                      <div>
                        <label
                          className="mb-1.5 block text-xs font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Chave Mestre do Servidor (ADMIN_MASTER_KEY)
                        </label>
                        <div className="relative">
                          <KeyRound
                            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2"
                            style={{ color: 'var(--text-muted)' }}
                          />
                          <input
                            type="password"
                            required
                            value={masterKeyInput}
                            onChange={(e) => setMasterKeyInput(e.target.value)}
                            placeholder="Insira a chave mestre criptográfica..."
                            className="h-10 w-full rounded-xl border pl-10 pr-4 text-xs outline-none"
                            style={{
                              borderColor: 'var(--border-strong)',
                              backgroundColor: 'var(--bg-surface)',
                              color: 'var(--text-primary)',
                            }}
                          />
                        </div>
                      </div>

                      {claimError && (
                        <div
                          className="rounded-xl px-3.5 py-2.5 text-xs font-medium"
                          style={{
                            backgroundColor: 'var(--live-red-soft)',
                            color: 'var(--live-red)',
                          }}
                        >
                          {claimError}
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={claimingKey || !masterKeyInput.trim()}
                        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl text-xs font-semibold text-white transition-opacity disabled:opacity-60"
                        style={{ backgroundColor: 'var(--accent)' }}
                      >
                        {claimingKey ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Crown className="h-4 w-4" />
                        )}
                        Vincular Cargo Fundador à Minha Conta
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

