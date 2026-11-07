import React, { useState } from 'react';
import { Crown, Shield, ShieldCheck } from 'lucide-react';
import type { UserPresenceStatus, UserRole } from '@aether/shared';
import { resolveServerAssetUrl } from '../api/httpClient.js';

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
        <span>FUNDADOR</span>
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
        <ShieldCheck className={compact ? 'h-2.5 w-2.5' : 'px-0 h-3 w-3'} />
        <span>ADMIN</span>
      </span>
    );
  }

  return (
    <span
      title="Moderador Oficial"
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
        : role === 'moderator'
          ? 'font-semibold text-emerald-400'
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

const AVATAR_SIZE_CLASSES: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', string> = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-[11px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
  xl: 'h-20 w-20 text-xl',
};

const PRESENCE_DOT_CLASSES: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', string> = {
  xs: 'h-2 w-2 -bottom-0.5 -right-0.5 border',
  sm: 'h-2.5 w-2.5 -bottom-0.5 -right-0.5 border-2',
  md: 'h-3 w-3 -bottom-0.5 -right-0.5 border-2',
  lg: 'h-3.5 w-3.5 bottom-0 right-0 border-2',
  xl: 'h-4 w-4 bottom-0.5 right-0.5 border-2',
};

export const UserAvatar: React.FC<{
  user: {
    displayName: string;
    avatarColor: string;
    avatarUrl?: string | null;
    presenceStatus?: UserPresenceStatus | null;
  };
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  speaking?: boolean;
  isOnline?: boolean;
  showPresence?: boolean;
  onClick?: () => void;
  className?: string;
}> = ({
  user,
  size = 'md',
  speaking = false,
  isOnline,
  showPresence = false,
  onClick,
  className = '',
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const resolvedUrl =
    user.avatarUrl && !imgFailed ? resolveServerAssetUrl(user.avatarUrl) : null;

  const effectivePresence: UserPresenceStatus =
    isOnline === false
      ? 'offline'
      : user.presenceStatus === 'busy'
        ? 'busy'
        : isOnline === true || user.presenceStatus === 'online'
          ? 'online'
          : 'offline';

  const dotColor =
    effectivePresence === 'online'
      ? 'var(--voice-green)'
      : effectivePresence === 'busy'
        ? '#f59e0b'
        : 'var(--text-muted)';

  const content = (
    <div
      className={`relative flex shrink-0 items-center justify-center rounded-full font-bold text-white transition-shadow select-none ${AVATAR_SIZE_CLASSES[size]} ${
        onClick ? 'cursor-pointer hover:opacity-90' : ''
      } ${className}`}
      style={{
        backgroundColor: resolvedUrl ? 'var(--bg-elevated)' : user.avatarColor || '#3b82f6',
        boxShadow: speaking ? '0 0 0 2.5px var(--voice-green)' : 'none',
      }}
      onClick={onClick}
    >
      {resolvedUrl ? (
        <img
          src={resolvedUrl}
          alt={user.displayName}
          onError={() => setImgFailed(true)}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <span>{(user.displayName || 'AE').slice(0, 2).toUpperCase()}</span>
      )}

      {showPresence && (
        <span
          className={`absolute rounded-full ${PRESENCE_DOT_CLASSES[size]}`}
          style={{
            borderColor: 'var(--bg-sidebar)',
            backgroundColor: dotColor,
          }}
          title={
            effectivePresence === 'online'
              ? 'Online'
              : effectivePresence === 'busy'
                ? 'Ocupado'
                : 'Offline'
          }
        />
      )}
    </div>
  );

  return content;
};
