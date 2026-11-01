import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { hasRoleAtLeast, type ChatAttachment, type ChatMessage } from '@aether/shared';
import { api, resolveServerAssetUrl } from '../api/httpClient.js';
import { useAppStore } from '../store/useAppStore.js';
import { StyledUserName, UserRoleBadge } from './UserIdentity.js';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const ChatPanel: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const currentRoom = useAppStore((s) => s.currentRoom);
  const participants = useAppStore((s) => s.participants);
  const messages = useAppStore((s) => s.messages);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const editMessage = useAppStore((s) => s.editMessage);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const setLightboxImageUrl = useAppStore((s) => s.setLightboxImageUrl);
  const pushToast = useAppStore((s) => s.pushToast);

  const [draft, setDraft] = useState('');
  const [stagedAttachments, setStagedAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  // @Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, currentRoom?.id]);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const unique = new Map<string, { username: string; displayName: string; avatarColor: string }>();
    for (const p of participants) {
      if (
        p.user.username.toLowerCase().includes(q) ||
        p.user.displayName.toLowerCase().includes(q)
      ) {
        unique.set(p.user.id, {
          username: p.user.username,
          displayName: p.user.displayName,
          avatarColor: p.user.avatarColor,
        });
      }
    }
    return Array.from(unique.values()).slice(0, 6);
  }, [mentionQuery, participants]);

  const handleDraftChange = (val: string) => {
    setDraft(val);
    const match = val.match(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/);
    if (match) {
      setMentionQuery(match[1] ?? '');
    } else {
      setMentionQuery(null);
    }
  };

  const insertMention = (username: string) => {
    const next = draft.replace(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/, (full) => {
      const leading = full.startsWith(' ') ? ' ' : '';
      return `${leading}@${username} `;
    });
    setDraft(next);
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploadingCount((c) => c + files.length);
    for (const file of files) {
      try {
        const uploaded = await api.uploadFile(file);
        setStagedAttachments((prev) => [...prev, uploaded]);
      } catch (err) {
        pushToast({
          title: `Falha no envio de ${file.name}`,
          body: err instanceof Error ? err.message : 'Verifique o tamanho do arquivo',
        });
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          const ext = f.type.split('/')[1] || 'png';
          const namedFile = new File([f], `imagem-colada-${Date.now()}.${ext}`, { type: f.type });
          imageFiles.push(namedFile);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      void uploadFiles(imageFiles);
    }
  };

  const handleSend = async () => {
    if (sending || uploadingCount > 0) return;
    const text = draft.trim();
    if (!text && stagedAttachments.length === 0) return;
    setSending(true);
    try {
      await sendMessage(
        text,
        stagedAttachments.map((a) => a.id)
      );
      setDraft('');
      setStagedAttachments([]);
      setMentionQuery(null);
    } catch (err) {
      pushToast({
        title: 'Erro ao enviar mensagem',
        body: err instanceof Error ? err.message : 'Tente novamente',
      });
    } finally {
      setSending(false);
    }
  };

  const renderFormattedContent = (msg: ChatMessage) => {
    const parts = msg.content.split(/(@[a-zA-Z0-9_.-]{3,28})/g);
    return parts.map((part, idx) => {
      if (part.startsWith('@')) {
        const uname = part.slice(1).toLowerCase();
        const isMe = user?.username.toLowerCase() === uname;
        return (
          <span
            key={idx}
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
      return <React.Fragment key={idx}>{part}</React.Fragment>;
    });
  };

  if (!currentRoom) return null;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDraggingOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOver(false);
        const dropped = Array.from(e.dataTransfer.files || []);
        void uploadFiles(dropped);
      }}
    >
      {isDraggingOver && (
        <div
          className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed backdrop-blur-sm"
          style={{
            borderColor: 'var(--accent)',
            backgroundColor: 'var(--accent-soft)',
          }}
        >
          <Paperclip className="mb-2 h-7 w-7" style={{ color: 'var(--accent)' }} />
          <div className="text-sm font-semibold">Solte arquivos ou imagens para anexar ao chat</div>
        </div>
      )}

      {/* Messages Feed */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div
              className="rounded-2xl border px-6 py-5"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              <div className="text-sm font-semibold">Bem-vindo a #{currentRoom.name}</div>
              <p className="mt-1 max-w-sm text-xs" style={{ color: 'var(--text-secondary)' }}>
                Envie mensagens, mencione participantes com <code>@usuario</code>, cole capturas de
                tela com <code>Ctrl+V</code> ou arraste arquivos aqui.
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isAuthor = user?.id === msg.author.id;
            const canDelete =
              isAuthor ||
              user?.id === currentRoom.ownerId ||
              hasRoleAtLeast(user?.role, 'moderator');
            const mentionsMe = Boolean(user && msg.mentions.includes(user.id));

            return (
              <div
                key={msg.id}
                className="group flex items-start gap-3 rounded-2xl px-3 py-2.5 transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.025]"
                style={{
                  backgroundColor: mentionsMe ? 'var(--accent-soft)' : undefined,
                  borderLeft: mentionsMe ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >
                <div
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{ backgroundColor: msg.author.avatarColor }}
                >
                  {msg.author.displayName.slice(0, 2).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StyledUserName
                      name={msg.author.displayName}
                      role={msg.author.role}
                      className="text-sm font-semibold"
                    />
                    <UserRoleBadge role={msg.author.role} compact />
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      @{msg.author.username}
                    </span>
                    <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {formatTime(msg.createdAt)}
                    </span>
                    {msg.editedAt && (
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        (editado)
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
                            void editMessage(msg.id, editingText.trim()).then(() =>
                              setEditingId(null)
                            );
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
                            void editMessage(msg.id, editingText.trim()).then(() =>
                              setEditingId(null)
                            );
                          }
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-white"
                        style={{ backgroundColor: 'var(--accent)' }}
                        title="Salvar edição"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--text-secondary)',
                        }}
                        title="Cancelar"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    msg.content && (
                      <div
                        className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {renderFormattedContent(msg)}
                      </div>
                    )
                  )}

                  {/* Attachments */}
                  {msg.attachments.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-2.5">
                      {msg.attachments.map((att) => {
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
                              <div className="max-w-[200px] truncate font-medium">{att.filename}</div>
                              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {formatBytes(att.sizeBytes)}
                              </div>
                            </div>
                            <Download className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Hover Message Actions */}
                {(isAuthor || canDelete) && editingId !== msg.id && (
                  <div
                    className="flex shrink-0 items-center gap-1 rounded-xl border p-1 opacity-0 transition-opacity group-hover:opacity-100"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      borderColor: 'var(--border-hairline)',
                    }}
                  >
                    {isAuthor && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(msg.id);
                          setEditingText(msg.content);
                        }}
                        title="Editar mensagem"
                        className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => void deleteMessage(msg.id)}
                        title="Excluir mensagem"
                        className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-red-500/10"
                        style={{ color: 'var(--live-red)' }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Composer Area */}
      <div className="px-5 pb-4 pt-2">
        {/* @Mention Autocomplete Popover */}
        {mentionCandidates.length > 0 && (
          <div
            className="mb-2 overflow-hidden rounded-2xl border p-1.5"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--border-strong)',
              boxShadow: 'var(--shadow-card)',
            }}
          >
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Mencionar participante
            </div>
            {mentionCandidates.map((cand) => (
              <button
                key={cand.username}
                type="button"
                onClick={() => insertMention(cand.username)}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: cand.avatarColor }}
                >
                  {cand.displayName.slice(0, 2).toUpperCase()}
                </span>
                <span className="font-medium">{cand.displayName}</span>
                <span style={{ color: 'var(--text-muted)' }}>@{cand.username}</span>
              </button>
            ))}
          </div>
        )}

        {/* Staged Attachments Preview */}
        {(stagedAttachments.length > 0 || uploadingCount > 0) && (
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
                className="relative flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                {att.isImage ? (
                  <img
                    src={resolveServerAssetUrl(att.url)}
                    alt={att.filename}
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                ) : (
                  <FileText className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                )}
                <span className="max-w-[140px] truncate">{att.filename}</span>
                <button
                  type="button"
                  onClick={() =>
                    setStagedAttachments((prev) => prev.filter((x) => x.id !== att.id))
                  }
                  className="ml-1 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {uploadingCount > 0 && (
              <div className="inline-flex items-center gap-2 px-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Enviando arquivo...
              </div>
            )}
          </div>
        )}

        {/* Input Box */}
        <div
          className="flex items-end gap-2 rounded-2xl border px-3 py-2 transition-colors"
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
              void uploadFiles(files);
              e.target.value = '';
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Enviar arquivo ou imagem"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Paperclip className="h-4 w-4" />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={`Mensagem em #${currentRoom.name} (@ para mencionar, Ctrl+V para colar imagem)`}
            className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm outline-none"
            style={{ color: 'var(--text-primary)' }}
          />

          <button
            type="button"
            disabled={sending || uploadingCount > 0 || (!draft.trim() && stagedAttachments.length === 0)}
            onClick={() => void handleSend()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white transition-opacity disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent)' }}
            title="Enviar mensagem"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

