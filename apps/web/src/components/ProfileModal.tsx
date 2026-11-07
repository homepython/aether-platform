import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Clock,
  Loader2,
  MessageSquare,
  Radio,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  X,
  ZoomIn,
} from 'lucide-react';
import { USERNAME_MAX_CHANGES_PER_24H } from '@aether/shared';
import { useAppStore } from '../store/useAppStore.js';
import { ROLE_LABELS, StyledUserName, UserAvatar, UserRoleBadge } from './UserIdentity.js';

const AVATAR_COLOR_PALETTE = [
  '#2563eb',
  '#0ea5e9',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#ef4444',
  '#14b8a6',
];

function formatCountdown(targetIso: string | null | undefined, nowMs: number): string | null {
  if (!targetIso) return null;
  const targetMs = new Date(targetIso).getTime();
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) return null;
  const totalSec = Math.ceil((targetMs - nowMs) / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

export const ProfileModal: React.FC = () => {
  const open = useAppStore((s) => s.profileModalOpen);
  const setOpen = useAppStore((s) => s.setProfileModalOpen);
  const user = useAppStore((s) => s.user);
  const saveMyProfile = useAppStore((s) => s.saveMyProfile);
  const uploadMyAvatar = useAppStore((s) => s.uploadMyAvatar);
  const pushToast = useAppStore((s) => s.pushToast);

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [presenceStatus, setPresenceStatus] = useState<'online' | 'busy'>('online');
  const [avatarColor, setAvatarColor] = useState('#2563eb');
  const [localLockedUntil, setLocalLockedUntil] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Interactive Circular Crop State for static PNG/JPEG images
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropFilename, setCropFilename] = useState('avatar.png');
  const [cropZoom, setCropZoom] = useState(1);
  const [cropOffset, setCropOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [draggingCrop, setDraggingCrop] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; ox: number; oy: number }>({
    x: 0,
    y: 0,
    ox: 0,
    oy: 0,
  });
  const cropImgObjRef = useRef<HTMLImageElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open || !user) return;
    setDisplayName(user.displayName);
    setUsername(user.username);
    setBio(user.bio || '');
    setPresenceStatus(user.presenceStatus === 'busy' ? 'busy' : 'online');
    setAvatarColor(user.avatarColor || '#2563eb');
    setLocalLockedUntil(user.nicknameLockedUntil || null);
    setError(null);
    setCropImageSrc(null);
  }, [open, user]);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  // Render live interactive circular crop preview
  useEffect(() => {
    if (!cropImageSrc) return;
    const canvas = cropCanvasRef.current;
    const img = cropImgObjRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);

    const baseScale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    const scale = baseScale * cropZoom;
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    const dx = (size - drawW) / 2 + cropOffset.x;
    const dy = (size - drawH) / 2 + cropOffset.y;

    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, dx, dy, drawW, drawH);
    ctx.restore();
  }, [cropImageSrc, cropZoom, cropOffset]);

  if (!open || !user) return null;

  const effectiveLockedUntil = localLockedUntil || user.nicknameLockedUntil;
  const lockCountdown = formatCountdown(effectiveLockedUntil, nowMs);
  const isNicknameLocked = Boolean(lockCountdown);
  const remainingNickChanges = isNicknameLocked
    ? 0
    : Math.max(0, USERNAME_MAX_CHANGES_PER_24H - (user.nicknameChangesLast24h || 0));

  const handleAvatarFileChosen = async (file: File) => {
    setError(null);
    const lowerName = file.name.toLowerCase();
    const isAnimatedCapable =
      file.type === 'image/gif' ||
      file.type === 'image/webp' ||
      lowerName.endsWith('.gif') ||
      lowerName.endsWith('.webp');

    // Animated GIF / WebP: upload raw binary without canvas rasterization to preserve 100% of frames!
    if (isAnimatedCapable) {
      setUploadingAvatar(true);
      try {
        await uploadMyAvatar(file, file.name);
        pushToast({
          title: 'Avatar atualizado!',
          body: 'Sua imagem / GIF animado foi aplicado em tempo real.',
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Falha ao enviar avatar');
      } finally {
        setUploadingAvatar(false);
      }
      return;
    }

    // Static PNG / JPG: open interactive circular zoom & pan cropper
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        cropImgObjRef.current = img;
        setCropFilename(file.name.replace(/\.[^.]+$/, '') + '.png');
        setCropZoom(1);
        setCropOffset({ x: 0, y: 0 });
        setCropImageSrc(dataUrl);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleApplyCroppedAvatar = async () => {
    const img = cropImgObjRef.current;
    if (!img) return;
    setUploadingAvatar(true);
    setError(null);
    try {
      const outCanvas = document.createElement('canvas');
      const outSize = 512;
      outCanvas.width = outSize;
      outCanvas.height = outSize;
      const ctx = outCanvas.getContext('2d');
      if (!ctx) throw new Error('Canvas indisponível');

      const previewSize = 220;
      const ratio = outSize / previewSize;
      const baseScale = Math.max(outSize / img.naturalWidth, outSize / img.naturalHeight);
      const scale = baseScale * cropZoom;
      const drawW = img.naturalWidth * scale;
      const drawH = img.naturalHeight * scale;
      const dx = (outSize - drawW) / 2 + cropOffset.x * ratio;
      const dy = (outSize - drawH) / 2 + cropOffset.y * ratio;

      ctx.drawImage(img, dx, dy, drawW, drawH);

      const blob = await new Promise<Blob>((resolve, reject) => {
        outCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Falha ao processar recorte'))),
          'image/png',
          0.95
        );
      });

      await uploadMyAvatar(blob, cropFilename);
      setCropImageSrc(null);
      pushToast({
        title: 'Foto de perfil atualizada!',
        body: 'Recorte circular aplicado com sucesso.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao enviar foto');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleRemoveAvatar = async () => {
    setUploadingAvatar(true);
    setError(null);
    try {
      await saveMyProfile({ avatarUrl: null });
      pushToast({
        title: 'Foto removida',
        body: 'Seu avatar voltou para as iniciais personalizadas.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao remover foto');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const cleanUsername = username.trim().replace(/^@+/, '');
      const updates: Parameters<typeof saveMyProfile>[0] = {
        displayName: displayName.trim(),
        bio: bio.trim(),
        presenceStatus,
        avatarColor,
      };
      if (cleanUsername !== user.username) {
        updates.username = cleanUsername;
      }
      await saveMyProfile(updates);
      pushToast({
        title: 'Perfil salvo com sucesso',
        body: 'Suas informações foram sincronizadas em tempo real.',
      });
      setOpen(false);
    } catch (err) {
      const customErr = err as Error & { lockedUntil?: string | null };
      if (customErr.lockedUntil) {
        setLocalLockedUntil(customErr.lockedUntil);
      }
      setError(customErr instanceof Error ? customErr.message : 'Não foi possível salvar o perfil');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
    >
      <form
        onSubmit={handleSaveProfile}
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center justify-between border-b px-6 py-4"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div>
            <h2 className="text-base font-semibold">Editar Meu Perfil</h2>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Personalize avatar estático ou GIF animado, bio, status e @nickname
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
          {/* Avatar Section / Cropper */}
          <div
            className="rounded-2xl border p-4"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-hairline)',
            }}
          >
            {cropImageSrc ? (
              <div className="flex flex-col items-center gap-3">
                <div className="text-xs font-semibold">
                  Arraste para posicionar e ajuste o zoom
                </div>
                <canvas
                  ref={cropCanvasRef}
                  width={220}
                  height={220}
                  onMouseDown={(e) => {
                    setDraggingCrop(true);
                    dragStartRef.current = {
                      x: e.clientX,
                      y: e.clientY,
                      ox: cropOffset.x,
                      oy: cropOffset.y,
                    };
                  }}
                  onMouseMove={(e) => {
                    if (!draggingCrop) return;
                    setCropOffset({
                      x: dragStartRef.current.ox + (e.clientX - dragStartRef.current.x),
                      y: dragStartRef.current.oy + (e.clientY - dragStartRef.current.y),
                    });
                  }}
                  onMouseUp={() => setDraggingCrop(false)}
                  onMouseLeave={() => setDraggingCrop(false)}
                  className="h-[220px] w-[220px] cursor-grab rounded-full border-2 active:cursor-grabbing"
                  style={{ borderColor: 'var(--accent)' }}
                />

                <div className="flex w-full max-w-xs items-center gap-2.5">
                  <ZoomIn className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="range"
                    min={100}
                    max={300}
                    value={Math.round(cropZoom * 100)}
                    onChange={(e) => setCropZoom(Number(e.target.value) / 100)}
                    className="aether-range flex-1"
                  />
                  <span className="w-11 text-right text-xs font-semibold tabular-nums">
                    {cropZoom.toFixed(1)}x
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCropImageSrc(null)}
                    className="h-8 rounded-xl border px-3.5 text-xs font-medium"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={uploadingAvatar}
                    onClick={() => void handleApplyCroppedAvatar()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-xl px-4 text-xs font-semibold text-white"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    {uploadingAvatar ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    Aplicar Foto
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <UserAvatar
                    user={{
                      displayName: displayName || user.displayName,
                      avatarColor,
                      avatarUrl: user.avatarUrl,
                      presenceStatus,
                    }}
                    size="xl"
                    showPresence
                    isOnline
                  />
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <StyledUserName
                        name={displayName || user.displayName}
                        role={user.role}
                        className="text-base font-semibold"
                      />
                      <UserRoleBadge role={user.role} />
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      @{username || user.username} • {ROLE_LABELS[user.role]}
                    </div>
                    <div
                      className="inline-flex items-center gap-1 text-[11px]"
                      style={{ color: 'var(--accent)' }}
                    >
                      <Sparkles className="h-3 w-3" />
                      Suporta PNG, JPG, WebP e <strong>GIF Animado</strong>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleAvatarFileChosen(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    disabled={uploadingAvatar}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    {uploadingAvatar ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Camera className="h-3.5 w-3.5" />
                    )}
                    Trocar Avatar / GIF
                  </button>

                  {user.avatarUrl && (
                    <button
                      type="button"
                      disabled={uploadingAvatar}
                      onClick={() => void handleRemoveAvatar()}
                      title="Remover foto e usar iniciais"
                      className="flex h-9 w-9 items-center justify-center rounded-xl border transition-colors"
                      style={{
                        borderColor: 'var(--border-hairline)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--live-red)',
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Fallback Avatar Color Palette */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--border-hairline)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Cor de Destaque do Avatar
              </span>
              <div className="flex items-center gap-2">
                {AVATAR_COLOR_PALETTE.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => setAvatarColor(hex)}
                    className="h-6 w-6 rounded-full transition-transform hover:scale-110"
                    style={{
                      backgroundColor: hex,
                      boxShadow:
                        avatarColor.toLowerCase() === hex.toLowerCase()
                          ? '0 0 0 2px var(--bg-surface), 0 0 0 4px var(--accent)'
                          : 'none',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Display Name & @Username */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Nome de Exibição
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={40}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="h-10 w-full rounded-xl border px-3.5 text-sm outline-none"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  Nickname Único (@usuário)
                </label>
                {isNicknameLocked ? (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums"
                    style={{ color: 'var(--warn-amber)' }}
                  >
                    <Clock className="h-3 w-3" />
                    Bloqueado: {lockCountdown}
                  </span>
                ) : (
                  <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {remainingNickChanges}/{USERNAME_MAX_CHANGES_PER_24H} trocas hoje
                  </span>
                )}
              </div>
              <div className="relative">
                <span
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold"
                  style={{ color: 'var(--text-muted)' }}
                >
                  @
                </span>
                <input
                  type="text"
                  required
                  minLength={3}
                  maxLength={28}
                  disabled={isNicknameLocked}
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, ''))}
                  className="h-10 w-full rounded-xl border pl-8 pr-3.5 text-sm outline-none disabled:opacity-60"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
              <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Limite de segurança: até 3 alterações de @nickname a cada 24 horas.
              </div>
            </div>
          </div>

          {/* Presence Status */}
          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Status de Presença
            </label>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setPresenceStatus('online')}
                className="flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs font-semibold transition-all"
                style={{
                  borderColor: presenceStatus === 'online' ? 'var(--accent)' : 'var(--border-hairline)',
                  backgroundColor: presenceStatus === 'online' ? 'var(--bg-active)' : 'var(--bg-elevated)',
                }}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'var(--voice-green)' }} />
                Online (Disponível)
              </button>

              <button
                type="button"
                onClick={() => setPresenceStatus('busy')}
                className="flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs font-semibold transition-all"
                style={{
                  borderColor: presenceStatus === 'busy' ? 'var(--accent)' : 'var(--border-hairline)',
                  backgroundColor: presenceStatus === 'busy' ? 'var(--bg-active)' : 'var(--bg-elevated)',
                }}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                Ocupado (Em Jogo / Foco)
              </button>
            </div>
          </div>

          {/* Bio */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Biografia / Recado
              </label>
              <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                {bio.length}/240
              </span>
            </div>
            <textarea
              rows={3}
              maxLength={240}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Conte um pouco sobre você, o que está jogando ou trabalhando..."
              className="w-full resize-none rounded-xl border p-3 text-xs leading-relaxed outline-none"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
              }}
            />
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

        {/* Footer */}
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
            type="submit"
            disabled={saving || uploadingAvatar}
            className="inline-flex h-10 items-center gap-2 rounded-xl px-5 text-xs font-semibold text-white transition-opacity disabled:opacity-60"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Salvar Perfil
          </button>
        </div>
      </form>
    </div>
  );
};

export const UserProfilePopoverModal: React.FC = () => {
  const inspected = useAppStore((s) => s.inspectedUser);
  const setInspected = useAppStore((s) => s.setInspectedUser);
  const me = useAppStore((s) => s.user);
  const friends = useAppStore((s) => s.friends);
  const currentRoom = useAppStore((s) => s.currentRoom);
  const openDmWithUser = useAppStore((s) => s.openDmWithUser);
  const sendFriendRequest = useAppStore((s) => s.sendFriendRequest);
  const respondFriendRequest = useAppStore((s) => s.respondFriendRequest);
  const inviteFriendToCurrentRoom = useAppStore((s) => s.inviteFriendToCurrentRoom);
  const setProfileModalOpen = useAppStore((s) => s.setProfileModalOpen);
  const pushToast = useAppStore((s) => s.pushToast);

  if (!inspected) return null;

  const isMe = me?.id === inspected.id;
  const friendship = friends.find((f) => f.user.id === inspected.id) || null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
      onClick={() => setInspected(null)}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-3xl border"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Accent Banner */}
        <div
          className="relative h-20"
          style={{
            background: `linear-gradient(135deg, ${inspected.avatarColor || '#2563eb'}, #0f172a)`,
          }}
        >
          <button
            type="button"
            onClick={() => setInspected(null)}
            className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="px-6 pb-6">
          <div className="-mt-10 mb-3 flex items-end justify-between">
            <div
              className="rounded-full p-1"
              style={{ backgroundColor: 'var(--bg-surface)' }}
            >
              <UserAvatar
                user={inspected}
                size="xl"
                showPresence
                isOnline={friendship ? friendship.isOnline : true}
              />
            </div>

            <UserRoleBadge role={inspected.role} />
          </div>

          <div className="space-y-0.5">
            <StyledUserName
              name={inspected.displayName}
              role={inspected.role}
              className="text-lg font-semibold"
            />
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              @{inspected.username} • {ROLE_LABELS[inspected.role]}
            </div>
          </div>

          {inspected.bio ? (
            <p
              className="mt-3 rounded-2xl border p-3 text-xs leading-relaxed whitespace-pre-wrap"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-hairline)',
                color: 'var(--text-secondary)',
              }}
            >
              {inspected.bio}
            </p>
          ) : (
            <p className="mt-3 text-xs italic" style={{ color: 'var(--text-muted)' }}>
              Sem biografia definida.
            </p>
          )}

          {/* Action Buttons */}
          <div className="mt-5 flex flex-wrap gap-2">
            {isMe ? (
              <button
                type="button"
                onClick={() => {
                  setInspected(null);
                  setProfileModalOpen(true);
                }}
                className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl px-4 text-xs font-semibold text-white"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                Editar Meu Perfil
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const targetId = inspected.id;
                    setInspected(null);
                    void openDmWithUser(targetId);
                  }}
                  className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold text-white"
                  style={{ backgroundColor: 'var(--accent)' }}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Mensagem Direta
                </button>

                {!friendship && (
                  <button
                    type="button"
                    onClick={() =>
                      void sendFriendRequest(inspected.username).catch((err) =>
                        pushToast({
                          title: 'Pedido de amizade',
                          body: err instanceof Error ? err.message : 'Tente novamente',
                        })
                      )
                    }
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border px-3.5 text-xs font-semibold"
                    style={{
                      borderColor: 'var(--border-strong)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Adicionar
                  </button>
                )}

                {friendship?.status === 'pending_incoming' && (
                  <button
                    type="button"
                    onClick={() => void respondFriendRequest(friendship.friendshipId, true)}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold text-white"
                    style={{ backgroundColor: 'var(--voice-green)' }}
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    Aceitar Pedido
                  </button>
                )}

                {friendship?.status === 'accepted' && currentRoom && (
                  <button
                    type="button"
                    onClick={() => void inviteFriendToCurrentRoom(inspected.id)}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                    }}
                    title={`Convidar para #${currentRoom.name}`}
                  >
                    <Radio className="h-3.5 w-3.5" style={{ color: 'var(--voice-green)' }} />
                    Convidar p/ Sala
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
