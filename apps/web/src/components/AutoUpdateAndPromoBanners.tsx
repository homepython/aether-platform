import React from 'react';
import { DownloadCloud, Loader2, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore.js';
import { ROLE_LABELS, UserRoleBadge } from './UserIdentity.js';

export const AutoUpdateBanner: React.FC = () => {
  const updater = useAppStore((s) => s.updaterStatus);
  const dismissedVersion = useAppStore((s) => s.updaterDismissedVersion);
  const installNow = useAppStore((s) => s.installDownloadedUpdateNow);
  const dismissBanner = useAppStore((s) => s.dismissUpdateBanner);

  if (!updater) return null;
  if (
    updater.status !== 'available' &&
    updater.status !== 'downloading' &&
    updater.status !== 'downloaded'
  ) {
    return null;
  }
  if (updater.availableVersion && dismissedVersion === updater.availableVersion) {
    return null;
  }

  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-2 text-xs"
      style={{
        backgroundColor: 'var(--accent-soft)',
        borderColor: 'var(--border-strong)',
        color: 'var(--text-primary)',
      }}
    >
      <div className="flex items-center gap-2.5">
        {updater.status === 'downloading' ? (
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--accent)' }} />
        ) : (
          <DownloadCloud className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        )}

        {updater.status === 'downloaded' ? (
          <span>
            <strong>Aether v{updater.availableVersion}</strong> foi baixado e verificado com
            assinatura SHA-512! Pronto para atualizar.
          </span>
        ) : updater.status === 'downloading' ? (
          <span>
            Baixando atualização automática <strong>v{updater.availableVersion}</strong> em segundo
            plano ({Math.round(updater.progressPercent)}%)...
          </span>
        ) : (
          <span>
            Nova versão <strong>v{updater.availableVersion}</strong> detectada! Iniciando download
            automático...
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {updater.status === 'downloaded' && (
          <>
            <button
              type="button"
              onClick={() => void installNow()}
              className="h-7 rounded-lg px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              Atualizar Agora
            </button>
            <button
              type="button"
              onClick={dismissBanner}
              className="h-7 rounded-lg border px-2.5 text-xs font-medium"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
              }}
            >
              Atualizar ao Reiniciar
            </button>
          </>
        )}

        {updater.status !== 'downloaded' && (
          <button
            type="button"
            onClick={dismissBanner}
            className="rounded-lg p-1 opacity-70 hover:opacity-100"
            title="Ocultar aviso"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

export const RolePromotionModal: React.FC = () => {
  const role = useAppStore((s) => s.rolePromotionRole);
  const dismiss = useAppStore((s) => s.dismissRolePromotionModal);
  const setAdminModalOpen = useAppStore((s) => s.setAdminModalOpen);

  if (!role || role === 'member') return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
    >
      <div
        className="w-full max-w-md rounded-3xl border p-6"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-strong)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>
            <Sparkles className="h-4 w-4" />
            Credencial Promovida em Tempo Real
          </div>
          <UserRoleBadge role={role} />
        </div>

        <h3 className="text-lg font-semibold">
          Parabéns! Agora você é {ROLE_LABELS[role]} Oficial
        </h3>
        <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Sua insígnia pública já está visível para todos nas salas, transmissões ao vivo, chats e
          overlay. As ferramentas de moderação já estão desbloqueadas imediatamente:
        </p>

        <ul
          className="mt-4 space-y-2 rounded-2xl border p-3.5 text-xs"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-hairline)',
            color: 'var(--text-primary)',
          }}
        >
          <li>• Botões rápidos de <strong>Silenciar</strong>, <strong>Remover da Sala</strong> e <strong>Encerrar Live</strong></li>
          <li>• Comandos rápidos no chat: <code>/mute @user</code>, <code>/kick @user</code> e <code>/stopstream @user</code></li>
          <li>• Acesso completo à <strong>Central de Moderação &amp; Auditoria</strong></li>
        </ul>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="h-9 rounded-xl px-4 text-xs font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            Continuar
          </button>
          <button
            type="button"
            onClick={() => {
              dismiss();
              setAdminModalOpen(true);
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl px-4 text-xs font-semibold text-white"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Abrir Central de Moderação
          </button>
        </div>
      </div>
    </div>
  );
};

