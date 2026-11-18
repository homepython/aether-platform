import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  DoorOpen,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Radio,
  Send,
  Smile,
  Trash2,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { ChatAttachment, DirectMessage, FriendEntry } from '@aether/shared';
import { api, resolveServerAssetUrl, type UploadProgressInfo } from '../api/httpClient.js';
import { useAppStore } from '../store/useAppStore.js';
import { StyledUserName, UserAvatar, UserRoleBadge } from './UserIdentity.js';

const QUICK_EMOJIS = [
  '😀',
  '😂',
  '🔥',
  '❤️',
  '🎮',
  '🚀',
  '👀',
  '🎉',
  '💯',
  '🤝',
  '⚡',
  '✨',
  '👍',
  '🙏',
  '😎',
  '💀',
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const FriendsAndDmView: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const friends = useAppStore((s) => s.friends);
  const activeDmUserId = useAppStore((s) => s.activeDmUserId);
  const dmMessagesByUser = useAppStore((s) => s.dmMessagesByUser);
  const dmTypingByUser = useAppStore((s) => s.dmTypingByUser);
  const currentRoom = useAppStore((s) => s.currentRoom);

  const refreshFriends = useAppStore((s) => s.refreshFriends);
  const sendFriendRequest = useAppStore((s) => s.sendFriendRequest);
  const respondFriendRequest = useAppStore((s) => s.respondFriendRequest);
  const removeFriend = useAppStore((s) => s.removeFriend);
  const inviteFriendToCurrentRoom = useAppStore((s) => s.inviteFriendToCurrentRoom);
  const openDmWithUser = useAppStore((s) => s.openDmWithUser);
  const sendDirectMessage = useAppStore((s) => s.sendDirectMessage);
  const editDirectMessage = useAppStore((s) => s.editDirectMessage);
  const deleteDirectMessage = useAppStore((s) => s.deleteDirectMessage);
  const notifyDmTyping = useAppStore((s) => s.notifyDmTyping);
  const joinRoom = useAppStore((s) => s.joinRoom);
  const setInspectedUser = useAppStore((s) => s.setInspectedUser);
  const setLightboxImageUrl = useAppStore((s) => s.setLightboxImageUrl);
  const pushToast = useAppStore((s) => s.pushToast);

  const [tab, setTab] = useState<'online' | 'all' | 'pending' | 'add'>('online');
  const [addUsernameInput, setAddUsernameInput] = useState('');
  const [addingFriend, setAddingFriend] = useState(false);

  const [draft, setDraft] = useState('');
  const [stagedAttachments, setStagedAttachments] = useState<ChatAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{
    filename: string;
    info: UploadProgressInfo;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingThrottleRef = useRef<number>(0);

  useEffect(() => {
    void refreshFriends().catch(() => {});
  }, [refreshFriends]);

  const activeDmMessages = useMemo(
    () => (activeDmUserId ? dmMessagesByUser[activeDmUserId] || [] : []),
    [activeDmUserId, dmMessagesByUser]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeDmMessages.length, activeDmUserId]);

  const pendingIncomingCount = useMemo(
    () => friends.filter((f) => f.status === 'pending_incoming').length,
    [friends]
  );

  const filteredFriends = useMemo(() => {
    if (tab === 'online') {
      return friends.filter((f) => f.status === 'accepted' && f.isOnline);
    }
    if (tab === 'all') {
      return friends.filter((f) => f.status === 'accepted');
    }
    if (tab === 'pending') {
      return friends.filter((f) => f.status !== 'accepted');
    }
    return [];
  }, [friends, tab]);

  const activePeerFriend: FriendEntry | null = useMemo(() => {
    if (!activeDmUserId) return null;
    return friends.find((f) => f.user.id === activeDmUserId) || null;
  }, [friends, activeDmUserId]);

  const activePeerUser = useMemo(() => {
    if (activePeerFriend) return activePeerFriend.user;
    if (!activeDmUserId) return null;
    const msgs = dmMessagesByUser[activeDmUserId] || [];
    const otherMsg = msgs.find((m) => m.sender.id === activeDmUserId);
    return otherMsg?.sender || null;
  }, [activePeerFriend, activeDmUserId, dmMessagesByUser]);

  const handleAddFriendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addUsernameInput.trim()) return;
    setAddingFriend(true);
    try {
      await sendFriendRequest(addUsernameInput.trim());
      setAddUsernameInput('');
      setTab('all');
    } catch (err) {
      pushToast({
        title: 'Não foi possível adicionar amigo',
        body: err instanceof Error ? err.message : 'Verifique o @nickname informado',
      });
    } finally {
      setAddingFriend(false);
    }
  };

  const uploadDmFiles = async (files: File[]) => {
    if (files.length === 0) return;
    for (const file of files) {
      try {
        setUploadProgress({
          filename: file.name,
          info: { percent: 0, loadedBytes: 0, totalBytes: file.size },
        });
        const uploaded = await api.uploadFile(file, (info) => {
          setUploadProgress({ filename: file.name, info });
        });
        setStagedAttachments((prev) => [...prev, uploaded]);
      } catch (err) {
        pushToast({
          title: `Falha ao anexar ${file.name}`,
          body: err instanceof Error ? err.message : 'Limite máximo: 550 MB por arquivo',
        });
      } finally {
        setUploadProgress(null);
      }
    }
  };

  const handleSendDm = async () => {
    if (!activeDmUserId || sending || uploadProgress) return;
    const text = draft.trim();
    if (!text && stagedAttachments.length === 0) return;
    setSending(true);
    try {
      await sendDirectMessage(
        activeDmUserId,
        text,
        stagedAttachments.map((a) => a.id)
      );
      setDraft('');
      setStagedAttachments([]);
      setEmojiOpen(false);
      notifyDmTyping(activeDmUserId, false);
    } catch (err) {
      pushToast({
        title: 'Falha ao enviar mensagem direta',
        body: err instanceof Error ? err.message : 'Tente novamente',
      });
    } finally {
      setSending(false);
    }
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (!activeDmUserId) return;
    const now = Date.now();
    if (value.trim() && now - typingThrottleRef.current > 2000) {
      typingThrottleRef.current = now;
      notifyDmTyping(activeDmUserId, true);
    } else if (!value.trim()) {
      notifyDmTyping(activeDmUserId, false);
    }
  };

  const renderAttachment = (att: ChatAttachment) => {
    const fullUrl = resolveServerAssetUrl(att.url);
    if (att.isImage) {
      return (
        <button
          key={att.id}
          type="button"
          onClick={() => setLightboxImageUrl(fullUrl)}
          className="overflow-hidden rounded-xl border transition-transform hover:scale-[1.01]"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <img
            src={fullUrl}
            alt={att.filename}
            loading="lazy"
            className="max-h-64 max-w-xs object-cover sm:max-w-sm"
          />
        </button>
      );
    }
    if (att.mimeType.startsWith('video/')) {
      return (
        <video
          key={att.id}
          src={fullUrl}
          controls
          preload="metadata"
          className="max-h-72 max-w-sm rounded-xl border bg-black"
          style={{ borderColor: 'var(--border-hairline)' }}
        />
      );
    }
    if (att.mimeType.startsWith('audio/')) {
      return (
        <audio key={att.id} src={fullUrl} controls preload="metadata" className="w-72 max-w-full" />
      );
    }
    return (
      <a
        key={att.id}
        href={fullUrl}
        download={att.filename}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs transition-colors"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          color: 'var(--text-primary)',
        }}
      >
        <FileText className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
        <div className="min-w-0">
          <div className="max-w-[220px] truncate font-medium">{att.filename}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {formatBytes(att.sizeBytes)}
          </div>
        </div>
        <Download className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
      </a>
    );
  };

  const renderDmContent = (msg: DirectMessage) => {
    const parts = msg.content.split(/(@[a-zA-Z0-9_.-]{3,28})/g);
    return parts.map((part, i) => {
      if (part.startsWith('@')) {
        const isMe = user?.username.toLowerCase() === part.slice(1).toLowerCase();
        return (
          <span
            key={i}
            className="rounded-md px-1 py-0.5 font-medium"
            style={{
              backgroundColor: isMe ? 'var(--accent)' : 'var(--accent-soft)',
              color: isMe ? '#ffffff' : 'var(--accent)',
            }}
          >
            {part}
          </span>
        );
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* LEFT PANE: Friends & Conversations Directory */}
      <div
        className="flex w-80 shrink-0 flex-col border-r"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        {/* Top Filter Tabs */}
        <div
          className="flex flex-col gap-2.5 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Users className="h-4 w-4" style={{ color: 'var(--accent)' }} />
              <span>Amigos & Mensagens</span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-1 rounded-xl p-1" style={{ backgroundColor: 'var(--bg-elevated)' }}>
            {(
              [
                { id: 'online', label: 'Online' },
                { id: 'all', label: 'Todos' },
                { id: 'pending', label: 'Pendentes', badge: pendingIncomingCount },
                { id: 'add', label: '+ Amigo' },
              ] as const
            ).map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className="relative flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-semibold transition-all"
                  style={{
                    backgroundColor: active ? 'var(--accent)' : 'transparent',
                    color: active ? '#ffffff' : 'var(--text-secondary)',
                  }}
                >
                  <span>{t.label}</span>
                  {'badge' in t && t.badge ? (
                    <span className="rounded-full bg-red-500 px-1.5 text-[9px] font-bold text-white">
                      {t.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Add Friend Form OR Friends List */}
        <div className="flex-1 overflow-y-auto p-3">
          {tab === 'add' ? (
            <form onSubmit={handleAddFriendSubmit} className="space-y-3 rounded-2xl border p-4" style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-elevated)' }}>
              <div className="text-xs font-semibold">Adicionar pelo @nickname</div>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                Digite o nickname exato do seu amigo para enviar um pedido instantâneo.
              </p>
              <input
                type="text"
                required
                value={addUsernameInput}
                onChange={(e) => setAddUsernameInput(e.target.value)}
                placeholder="ex: @jogador"
                className="h-9 w-full rounded-xl border px-3 text-xs outline-none"
                style={{
                  borderColor: 'var(--border-strong)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
              <button
                type="submit"
                disabled={addingFriend || !addUsernameInput.trim()}
                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-xs font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                {addingFriend ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UserPlus className="h-3.5 w-3.5" />
                )}
                Enviar Pedido de Amizade
              </button>
            </form>
          ) : filteredFriends.length === 0 ? (
            <div className="py-12 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              {tab === 'online' && 'Nenhum amigo online no momento.'}
              {tab === 'all' && 'Sua lista de amigos está vazia. Clique em "+ Amigo" para adicionar!'}
              {tab === 'pending' && 'Nenhuma solicitação de amizade pendente.'}
            </div>
          ) : (
            <div className="space-y-1.5">
              {filteredFriends.map((f) => {
                const isSelected = activeDmUserId === f.user.id;
                return (
                  <div
                    key={f.friendshipId}
                    className="group flex items-center justify-between gap-2 rounded-2xl border p-2.5 transition-all"
                    style={{
                      backgroundColor: isSelected ? 'var(--bg-active)' : 'transparent',
                      borderColor: isSelected ? 'var(--border-focus)' : 'transparent',
                    }}
                  >
                    <div
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5"
                      onClick={() => {
                        if (f.status === 'accepted') {
                          void openDmWithUser(f.user.id);
                        } else {
                          setInspectedUser(f.user);
                        }
                      }}
                    >
                      <UserAvatar
                        user={f.user}
                        size="md"
                        showPresence
                        isOnline={f.isOnline}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs">
                          <StyledUserName
                            name={f.user.displayName}
                            role={f.user.role}
                            className="font-semibold"
                          />
                          <UserRoleBadge role={f.user.role} compact />
                        </div>

                        <div className="flex items-center gap-1.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {f.status === 'pending_incoming' ? (
                            <span style={{ color: 'var(--accent)' }}>Solicitação recebida</span>
                          ) : f.status === 'pending_outgoing' ? (
                            <span>Aguardando confirmação</span>
                          ) : f.currentRoomName ? (
                            <span className="truncate" style={{ color: 'var(--voice-green)' }}>
                              Em #{f.currentRoomName} {f.isStreaming ? '• AO VIVO' : ''}
                            </span>
                          ) : f.isOnline ? (
                            <span>{f.presenceStatus === 'busy' ? 'Ocupado' : 'Online'}</span>
                          ) : (
                            <span>Offline</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right Action Buttons */}
                    <div className="flex shrink-0 items-center gap-1">
                      {f.unreadDmCount > 0 && (
                        <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {f.unreadDmCount}
                        </span>
                      )}

                      {f.status === 'pending_incoming' && (
                        <>
                          <button
                            type="button"
                            onClick={() => void respondFriendRequest(f.friendshipId, true)}
                            title="Aceitar amizade"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-white"
                            style={{ backgroundColor: 'var(--voice-green)' }}
                          >
                            <UserCheck className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void respondFriendRequest(f.friendshipId, false)}
                            title="Recusar"
                            className="flex h-7 w-7 items-center justify-center rounded-lg"
                            style={{
                              backgroundColor: 'var(--live-red-soft)',
                              color: 'var(--live-red)',
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}

                      {f.status === 'pending_outgoing' && (
                        <button
                          type="button"
                          onClick={() => void removeFriend(f.friendshipId)}
                          title="Cancelar solicitação"
                          className="flex h-7 w-7 items-center justify-center rounded-lg"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}

                      {f.status === 'accepted' && (
                        <>
                          {f.currentRoomId && f.currentRoomId !== currentRoom?.id && (
                            <button
                              type="button"
                              onClick={() => void joinRoom(f.currentRoomId!, null)}
                              title={`Entrar na sala #${f.currentRoomName}`}
                              className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                              style={{ color: 'var(--voice-green)' }}
                            >
                              <DoorOpen className="h-3.5 w-3.5" />
                            </button>
                          )}

                          {currentRoom && f.currentRoomId !== currentRoom.id && (
                            <button
                              type="button"
                              onClick={() => void inviteFriendToCurrentRoom(f.user.id)}
                              title={`Convidar para #${currentRoom.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                              style={{ color: 'var(--accent)' }}
                            >
                              <Radio className="h-3.5 w-3.5" />
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => void removeFriend(f.friendshipId)}
                            title="Remover amigo"
                            className="hidden h-7 w-7 items-center justify-center rounded-lg opacity-70 hover:opacity-100 group-hover:flex"
                            style={{ color: 'var(--live-red)' }}
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT PANE: Direct Message Conversation */}
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        style={{ backgroundColor: 'var(--bg-canvas)' }}
        onDragOver={(e) => {
          if (!activeDmUserId) return;
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setIsDraggingOver(false);
        }}
        onDrop={(e) => {
          if (!activeDmUserId) return;
          e.preventDefault();
          setIsDraggingOver(false);
          const dropped = Array.from(e.dataTransfer.files || []);
          void uploadDmFiles(dropped);
        }}
      >
        {!activeDmUserId ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <div
              className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              <MessageSquare className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold">Mensagens Diretas Privadas</h3>
            <p className="mt-1 max-w-sm text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Selecione um amigo à esquerda para conversar em privado, enviar arquivos de até{' '}
              <strong>550 MB</strong> ou convidar para sua sala de voz com 1 clique.
            </p>
          </div>
        ) : (
          <>
            {isDraggingOver && (
              <div
                className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed backdrop-blur-sm"
                style={{
                  borderColor: 'var(--accent)',
                  backgroundColor: 'var(--accent-soft)',
                }}
              >
                <Paperclip className="mb-2 h-7 w-7" style={{ color: 'var(--accent)' }} />
                <div className="text-sm font-semibold">Solte arquivos (até 550 MB) para enviar na DM</div>
              </div>
            )}

            {/* DM Header */}
            <header
              className="flex h-14 shrink-0 items-center justify-between border-b px-5"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-surface)',
              }}
            >
              {activePeerUser ? (
                <div
                  className="flex cursor-pointer items-center gap-3"
                  onClick={() => setInspectedUser(activePeerUser)}
                >
                  <UserAvatar
                    user={activePeerUser}
                    size="sm"
                    showPresence
                    isOnline={activePeerFriend?.isOnline ?? true}
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-semibold">
                      <StyledUserName name={activePeerUser.displayName} role={activePeerUser.role} />
                      <UserRoleBadge role={activePeerUser.role} compact />
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      @{activePeerUser.username}
                      {activePeerFriend?.currentRoomName
                        ? ` • Na sala #${activePeerFriend.currentRoomName}`
                        : ''}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm font-semibold">Conversa Direta</div>
              )}

              <div className="flex items-center gap-2">
                {currentRoom && (
                  <button
                    type="button"
                    onClick={() => void inviteFriendToCurrentRoom(activeDmUserId)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    <Radio className="h-3.5 w-3.5" />
                    Convidar para #{currentRoom.name}
                  </button>
                )}
              </div>
            </header>

            {/* DM Feed */}
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {activeDmMessages.length === 0 ? (
                <div className="py-12 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  Início do histórico criptografado com{' '}
                  <strong>{activePeerUser?.displayName || 'este usuário'}</strong>.
                </div>
              ) : (
                activeDmMessages.map((msg) => {
                  const isMine = msg.sender.id === user?.id;
                  return (
                    <div
                      key={msg.id}
                      className="group flex items-start gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.025]"
                    >
                      <UserAvatar
                        user={msg.sender}
                        size="md"
                        onClick={() => setInspectedUser(msg.sender)}
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setInspectedUser(msg.sender)}
                            className="text-left hover:underline"
                          >
                            <StyledUserName
                              name={msg.sender.displayName}
                              role={msg.sender.role}
                              className="text-sm font-semibold"
                            />
                          </button>
                          <UserRoleBadge role={msg.sender.role} compact />
                          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                            {formatTime(msg.createdAt)}
                          </span>
                          {msg.editedAt && (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              (editado)
                            </span>
                          )}
                          {isMine && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px]"
                              style={{
                                color: msg.readAt ? 'var(--voice-green)' : 'var(--text-muted)',
                              }}
                              title={
                                msg.readAt
                                  ? `Visto às ${formatTime(msg.readAt)}`
                                  : 'Entregue'
                              }
                            >
                              {msg.readAt ? (
                                <>
                                  <CheckCheck className="h-3 w-3" />
                                  Visto
                                </>
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                            </span>
                          )}
                        </div>

                        {editingId === msg.id ? (
                          <div className="mt-1.5 flex items-center gap-2">
                            <input
                              type="text"
                              autoFocus
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditingId(null);
                                if (e.key === 'Enter' && editingText.trim()) {
                                  void editDirectMessage(
                                    activeDmUserId,
                                    msg.id,
                                    editingText.trim()
                                  ).then(() => setEditingId(null));
                                }
                              }}
                              className="h-9 flex-1 rounded-xl border px-3 text-sm outline-none"
                              style={{
                                borderColor: 'var(--border-focus)',
                                backgroundColor: 'var(--bg-elevated)',
                                color: 'var(--text-primary)',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (editingText.trim()) {
                                  void editDirectMessage(
                                    activeDmUserId,
                                    msg.id,
                                    editingText.trim()
                                  ).then(() => setEditingId(null));
                                }
                              }}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-white"
                              style={{ backgroundColor: 'var(--accent)' }}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          msg.content && (
                            <div className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
                              {renderDmContent(msg)}
                            </div>
                          )
                        )}

                        {/* Room Invite Interactive Card */}
                        {msg.roomInvite && (
                          <div
                            className="mt-2 flex max-w-sm items-center justify-between gap-3 rounded-2xl border p-3.5"
                            style={{
                              backgroundColor: 'var(--bg-surface)',
                              borderColor: 'var(--border-strong)',
                            }}
                          >
                            <div className="min-w-0">
                              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--voice-green)' }}>
                                Convite de Sala de Voz
                              </div>
                              <div className="truncate text-sm font-semibold">
                                #{msg.roomInvite.roomName}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void joinRoom(msg.roomInvite!.roomId, null)}
                              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold text-white"
                              style={{ backgroundColor: 'var(--voice-green)' }}
                            >
                              <DoorOpen className="h-3.5 w-3.5" />
                              Entrar
                            </button>
                          </div>
                        )}

                        {msg.attachments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2.5">
                            {msg.attachments.map(renderAttachment)}
                          </div>
                        )}
                      </div>

                      {isMine && editingId !== msg.id && (
                        <div
                          className="flex shrink-0 items-center gap-1 rounded-xl border p-1 opacity-0 transition-opacity group-hover:opacity-100"
                          style={{
                            backgroundColor: 'var(--bg-surface)',
                            borderColor: 'var(--border-hairline)',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(msg.id);
                              setEditingText(msg.content);
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-lg"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteDirectMessage(activeDmUserId, msg.id)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg"
                            style={{ color: 'var(--live-red)' }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Composer */}
            <div className="px-5 pb-4 pt-1">
              {dmTypingByUser[activeDmUserId] && (
                <div className="mb-1.5 px-2 text-[11px] font-medium" style={{ color: 'var(--accent)' }}>
                  {activePeerUser?.displayName || 'Usuário'} está digitando...
                </div>
              )}

              {/* Live Upload Progress Bar (550 MB+) */}
              {uploadProgress && (
                <div
                  className="mb-2 rounded-2xl border p-3 text-xs"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-hairline)',
                  }}
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="truncate font-medium">
                      Enviando {uploadProgress.filename}...
                    </span>
                    <span className="font-semibold tabular-nums">
                      {uploadProgress.info.percent}% ({formatBytes(uploadProgress.info.loadedBytes)} /{' '}
                      {formatBytes(uploadProgress.info.totalBytes)})
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-elevated)' }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${uploadProgress.info.percent}%`,
                        backgroundColor: 'var(--accent)',
                      }}
                    />
                  </div>
                </div>
              )}

              {stagedAttachments.length > 0 && (
                <div
                  className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl border p-2.5"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-hairline)',
                  }}
                >
                  {stagedAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        borderColor: 'var(--border-hairline)',
                      }}
                    >
                      <FileText className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                      <span className="max-w-[160px] truncate">{att.filename}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setStagedAttachments((prev) => prev.filter((x) => x.id !== att.id))
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {emojiOpen && (
                <div
                  className="mb-2 flex flex-wrap gap-1.5 rounded-2xl border p-2.5"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-strong)',
                  }}
                >
                  {QUICK_EMOJIS.map((em) => (
                    <button
                      key={em}
                      type="button"
                      onClick={() => setDraft((prev) => `${prev}${em}`)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-base transition-transform hover:scale-110 hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      {em}
                    </button>
                  ))}
                </div>
              )}

              <div
                className="flex items-end gap-2 rounded-2xl border px-3 py-2"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    void uploadDmFiles(files);
                    e.target.value = '';
                  }}
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Anexar arquivo de até 550 MB"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <Paperclip className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setEmojiOpen((o) => !o)}
                  title="Inserir Emoji"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: emojiOpen ? 'var(--accent)' : 'var(--text-secondary)' }}
                >
                  <Smile className="h-4 w-4" />
                </button>

                <textarea
                  rows={1}
                  value={draft}
                  onChange={(e) => handleDraftChange(e.target.value)}
                  onPaste={(e) => {
                    const items = Array.from(e.clipboardData?.items || []);
                    const pastedFiles: File[] = [];
                    for (const item of items) {
                      if (item.kind === 'file') {
                        const f = item.getAsFile();
                        if (f) pastedFiles.push(f);
                      }
                    }
                    if (pastedFiles.length > 0) {
                      e.preventDefault();
                      void uploadDmFiles(pastedFiles);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendDm();
                    }
                  }}
                  placeholder={`Enviar mensagem direta para ${activePeerUser?.displayName || 'amigo'}...`}
                  className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm outline-none"
                  style={{ color: 'var(--text-primary)' }}
                />

                <button
                  type="button"
                  disabled={
                    sending ||
                    Boolean(uploadProgress) ||
                    (!draft.trim() && stagedAttachments.length === 0)
                  }
                  onClick={() => void handleSendDm()}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white disabled:opacity-40"
                  style={{ backgroundColor: 'var(--accent)' }}
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

