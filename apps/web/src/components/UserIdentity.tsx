import React from 'react';
import { Crown, Shield, ShieldCheck } from 'lucide-react';
import type { UserRole } from '@aether/shared';

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Fundador',
  admin: 'Administrador',
  moderator: 'Moderador',
  member: 'Membro',
};

export const UserRoleBadge: React.FC<{
  role?: UserRole | null;
  compact?: boolean;
}> = ({ role, compact = false }) => {
  if (!role || role === 'member') return null;

  if (role === 'owner') {
    return (
      <span
        title="Fundador da Plataforma"
        className={`inline-flex shrink-0 items-center gap-1 rounded-full font-bold uppercase tracking-wider select-none ${
          compact ? 'px-1.5 py-0.2 text-[9px]' : 'px-2 py-0.5 text-[10px]'
        }`}
        style={{
          background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(217, 119, 6, 0.08))',
          border: '1px solid rgba(251, 191, 36, 0.42)',
          color: '#fbbf24',
          boxShadow: '0 0 12px rgba(245, 158, 11, 0.12)',
        }}
      >
        <Crown className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        <span>{compact ? 'FUNDADOR' : 'FUNDADOR'}</span>
      </span>
    );
  }

  if (role === 'admin') {
    return (
      <span
        title="Administrador Oficial"
        className={`inline-flex shrink-0 items-center gap-1 rounded-full font-bold uppercase tracking-wider select-none ${
          compact ? 'px-1.5 py-0.2 text-[9px]' : 'px-2 py-0.5 text-[10px]'
        }`}
        style={{
          background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(37, 99, 235, 0.1))',
          border: '1px solid rgba(96, 165, 250, 0.42)',
          color: '#60a5fa',
          boxShadow: '0 0 12px rgba(59, 130, 246, 0.12)',
        }}
      >
        <ShieldCheck className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        <span>ADMIN</span>
      </span>
    );
  }

  return (
    <span
      title="Moderador"
      className={`inline-flex shrink-0 items-center gap-1 rounded-full font-bold uppercase tracking-wider select-none ${
        compact ? 'px-1.5 py-0.2 text-[9px]' : 'px-2 py-0.5 text-[10px]'
      }`}
      style={{
        backgroundColor: 'rgba(16, 185, 129, 0.14)',
        border: '1px solid rgba(52, 211, 153, 0.35)',
        color: 'var(--voice-green)',
      }}
    >
      <Shield className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      <span>MOD</span>
    </span>
  );
};

export const StyledUserName: React.FC<{
  name: string;
  role?: UserRole | null;
  suffix?: string;
  className?: string;
}> = ({ name, role, suffix, className = '' }) => {
  const roleClass =
    role === 'owner'
      ? 'admin-name-owner font-semibold'
      : role === 'admin'
        ? 'admin-name-admin font-semibold'
        : '';

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span className={`truncate ${roleClass}`}>{name}</span>
      {suffix ? (
        <span className="shrink-0 font-normal" style={{ color: 'var(--text-muted)' }}>
          {suffix}
        </span>
      ) : null}
    </span>
  );
};

