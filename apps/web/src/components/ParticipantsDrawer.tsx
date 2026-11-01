import React, { useState } from 'react';
import {
  Ban,
  HeadphoneOff,
  Laptop,
  MicOff,
  ShieldAlert,
  Sliders,
  Sparkles,
  UserMinus,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { hasRoleAtLeast, ROLE_RANK } from '@aether/shared';
import { useAppStore } from '../store/useAppStore.js';
import { StyledUserName, UserRoleBadge } from './UserIdentity.js';

export const ParticipantsDrawer: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const currentRoom = useAppStore((s) => s.currentRoom);
  const participants = useAppStore((s) => s.participants);
  const peerOverrides = useAppStore((s) => s.settings.audio.peerOverrides);
  const setPeerAudioOverride = useAppStore((s) => s.setPeerAudioOverride);
  const kickParticipant = useAppStore((s) => s.kickParticipant);
  const forceMuteParticipant = useAppStore((s) => s.forceMuteParticipant);
  const pushToast = useAppStore((s) => s.pushToast);

  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  if (!currentRoom) return null;

  const runModeration = async (action: () => Promise<void>, label: string) => {
    try {
      await action();
      pushToast({ title: 'Moderação aplicada', body: label });
    } catch (err) {
      pushToast({
        title: 'Falha na moderação',
        body: err instanceof Error ? err.message : 'Permissão insuficiente',
      });
    }
  };

  return (
    <aside
      className="hidden h-full w-68 shrink-0 flex-col border-l lg:flex"
      style={{
        backgroundColor: 'var(--bg-sidebar)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      <div
        className="flex h-14 items-center justify-between border-b px-4"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Na Sala — {participants.length}
        </span>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
        {participants.map((p) => {
          const isMe = p.user.id === user?.id;
          const override = peerOverrides[p.user.id] || {
            volume: 100,
            muted: false,
            noiseReductionEnabled: false,
            noiseReductionLevel: 50,
          };
          const isExpanded = !isMe && expandedUserId === p.user.id;
          const myRole = user?.role ?? 'member';
          const targetRole = p.user.role ?? 'member';
          const canModerate =
            !isMe &&
            hasRoleAtLeast(myRole, 'moderator') &&
            (myRole === 'owner' || ROLE_RANK[myRole] > ROLE_RANK[targetRole]);

          return (
            <div
              key={p.peerId}
              className="rounded-2xl border p-2.5 transition-all"
              style={{
                backgroundColor: isExpanded ? 'var(--bg-surface)' : 'transparent',
                borderColor: isExpanded ? 'var(--border-hairline)' : 'transparent',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white transition-shadow"
                    style={{
                      backgroundColor: p.user.avatarColor,
                      boxShadow: p.speaking ? '0 0 0 2.5px var(--voice-green)' : 'none',
                    }}
                  >
                    {p.user.displayName.slice(0, 2).toUpperCase()}
                  </div>

                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5 text-xs">
                      <StyledUserName
                        name={p.user.displayName}
                        role={p.user.role}
                        suffix={isMe ? '(Você)' : undefined}
                        className="font-semibold"
                      />
                      <UserRoleBadge role={p.user.role} compact />
                      {p.clientPlatform === 'desktop' && (
                        <span title="Aplicativo Desktop">
                          <Laptop className="h-3 w-3 shrink-0" style={{ color: 'var(--text-muted)' }} />
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <span className="truncate">@{p.user.username}</span>
                      {p.isStreaming && (
                        <span
                          className="rounded px-1 py-0.2 text-[9px] font-bold uppercase"
                          style={{
                            backgroundColor: 'var(--live-red-soft)',
                            color: 'var(--live-red)',
                          }}
                        >
                          AO VIVO
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {p.micMuted && <MicOff className="h-3.5 w-3.5" style={{ color: 'var(--live-red)' }} />}
                  {p.deafened && (
                    <HeadphoneOff className="h-3.5 w-3.5" style={{ color: 'var(--live-red)' }} />
                  )}
                  {!isMe && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedUserId((cur) => (cur === p.user.id ? null : p.user.id))
                      }
                      title="Controle individual de volume e ruído"
                      className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                      style={{
                        color: isExpanded ? 'var(--accent)' : 'var(--text-secondary)',
                      }}
                    >
                      <Sliders className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Per-User Individual Volume & Noise Control Panel */}
              {isExpanded && (
                <div
                  className="mt-3 space-y-3 border-t pt-3 text-xs"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {override.muted ? (
                          <VolumeX className="h-3.5 w-3.5" style={{ color: 'var(--live-red)' }} />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5" />
                        )}
                        Volume Individual
                      </span>
                      <span className="font-semibold tabular-nums">
                        {override.muted ? 'Mudo' : `${override.volume}%`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={200}
                        value={override.muted ? 0 : override.volume}
                        onChange={(e) =>
                          setPeerAudioOverride(p.user.id, {
                            volume: Number(e.target.value),
                            muted: false,
                          })
                        }
                        className="aether-range flex-1"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setPeerAudioOverride(p.user.id, { muted: !override.muted })
                        }
                        className="rounded-lg border px-2 py-1 text-[11px] font-medium"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          backgroundColor: override.muted ? 'var(--live-red-soft)' : 'var(--bg-elevated)',
                          color: override.muted ? 'var(--live-red)' : 'var(--text-secondary)',
                        }}
                      >
                        {override.muted ? 'Ativar' : 'Mutar'}
                      </button>
                    </div>
                  </div>

                  {/* Per-User Receiver Noise Reduction */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium" style={{ color: 'var(--text-secondary)' }}>
                        <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                        Filtro de Ruído Individual
                      </label>
                      <input
                        type="checkbox"
                        checked={override.noiseReductionEnabled}
                        onChange={(e) =>
                          setPeerAudioOverride(p.user.id, {
                            noiseReductionEnabled: e.target.checked,
                          })
                        }
                        className="h-4 w-4 accent-blue-600"
                      />
                    </div>
                    {override.noiseReductionEnabled && (
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={10}
                          max={100}
                          value={override.noiseReductionLevel}
                          onChange={(e) =>
                            setPeerAudioOverride(p.user.id, {
                              noiseReductionLevel: Number(e.target.value),
                            })
                          }
                          className="aether-range flex-1"
                        />
                        <span className="w-9 text-right text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                          {override.noiseReductionLevel}%
                        </span>
                      </div>
                    )}
                  </div>

                  {canModerate && (
                    <div className="border-t pt-3" style={{ borderColor: 'var(--border-hairline)' }}>
                      <div
                        className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Moderação
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void runModeration(
                              () => forceMuteParticipant(p.peerId),
                              `${p.user.displayName} foi silenciado na sala.`
                            )
                          }
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium"
                          style={{
                            borderColor: 'var(--border-hairline)',
                            backgroundColor: 'var(--bg-elevated)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <Ban className="h-3 w-3" />
                          Silenciar na Sala
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void runModeration(
                              () => kickParticipant(p.peerId),
                              `${p.user.displayName} foi removido da sala.`
                            )
                          }
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold"
                          style={{
                            backgroundColor: 'var(--live-red-soft)',
                            color: 'var(--live-red)',
                          }}
                        >
                          <UserMinus className="h-3 w-3" />
                          Remover da Sala
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
};

