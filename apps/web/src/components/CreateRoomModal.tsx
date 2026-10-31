import React, { useState } from 'react';
import { Globe, Lock, Plus, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore.js';

export const CreateRoomModal: React.FC = () => {
  const open = useAppStore((s) => s.createRoomModalOpen);
  const setOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const createRoom = useAppStore((s) => s.createRoom);
  const joinRoom = useAppStore((s) => s.joinRoom);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const created = await createRoom({
        name: name.trim(),
        description: description.trim(),
        isPrivate,
        password: password.trim() || null,
      });
      setOpen(false);
      setName('');
      setDescription('');
      setPassword('');
      setIsPrivate(false);
      await joinRoom(created.id, password.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar sala');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
    >
      <div
        className="w-full max-w-md rounded-3xl border p-6"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Nova Sala em Tempo Real</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-xl transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setIsPrivate(false)}
              className="flex items-center gap-2.5 rounded-2xl border p-3 text-left transition-all"
              style={{
                borderColor: !isPrivate ? 'var(--border-focus)' : 'var(--border-hairline)',
                backgroundColor: !isPrivate ? 'var(--bg-active)' : 'var(--bg-elevated)',
              }}
            >
              <Globe className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
              <div>
                <div className="text-xs font-semibold">Pública</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Aberta a todos
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setIsPrivate(true)}
              className="flex items-center gap-2.5 rounded-2xl border p-3 text-left transition-all"
              style={{
                borderColor: isPrivate ? 'var(--border-focus)' : 'var(--border-hairline)',
                backgroundColor: isPrivate ? 'var(--bg-active)' : 'var(--bg-elevated)',
              }}
            >
              <Lock className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
              <div>
                <div className="text-xs font-semibold">Privada</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Acesso controlado
                </div>
              </div>
            </button>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Nome da Sala
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={48}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Squad Competitivo 2K"
              className="h-10 w-full rounded-xl border px-3.5 text-sm outline-none"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Descrição (opcional)
            </label>
            <input
              type="text"
              maxLength={180}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Propósito da sala"
              className="h-10 w-full rounded-xl border px-3.5 text-sm outline-none"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Senha Opcional
            </label>
            <input
              type="password"
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Deixe em branco para acesso sem senha"
              className="h-10 w-full rounded-xl border px-3.5 text-sm outline-none"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {error && (
            <div
              className="rounded-xl px-3 py-2 text-xs"
              style={{ backgroundColor: 'var(--live-red-soft)', color: 'var(--live-red)' }}
            >
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
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
              disabled={loading}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl px-5 text-xs font-semibold text-white"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              <Plus className="h-4 w-4" />
              {loading ? 'Criando...' : 'Criar e Entrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

