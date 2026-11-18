import { create } from 'zustand';
import {
  DEFAULT_USER_SETTINGS,
  hasRoleAtLeast,
  UserSettingsSchema,
  type ActiveStreamInfo,
  type AuthUser,
  type ChatMessage,
  type CreateRoomInput,
  type DirectMessage,
  type FriendEntry,
  type LoginInput,
  type PeerAudioOverride,
  type RegisterInput,
  type RoomParticipant,
  type RoomSummary,
  type ServerPushEvent,
  type StreamConnectionMode,
  type StreamFps,
  type StreamPrivacyMode,
  type StreamResolution,
  type UpdateProfileInput,
  type UserPublic,
  type UserRole,
  type UserSettings,
} from '@aether/shared';
import { api, restoreSecureSession } from '../api/httpClient.js';
import { audioEngine } from '../audio/AudioEngine.js';
import { uiSounds } from '../audio/UiSoundEffects.js';
import {
  getDesktopApi,
  isDesktopClient,
  type DesktopCaptureSourceItem,
  type DesktopUpdaterStatus,
} from '../bridge/DesktopBridge.js';
import { realtimeSession, type WatchedTransportMode } from '../rtc/RealtimeSession.js';

const LOCAL_SETTINGS_CACHE_KEY = 'aether:user_settings_v1';

function loadCachedSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(LOCAL_SETTINGS_CACHE_KEY);
    if (raw) {
      return UserSettingsSchema.parse(JSON.parse(raw));
    }
  } catch {
    // Fallback
  }
  return DEFAULT_USER_SETTINGS;
}

function persistCachedSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(LOCAL_SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Guarantees 1 user = 1 participant row on screen (zero clones).
 */
function dedupeParticipantsByUser(list: RoomParticipant[]): RoomParticipant[] {
  const byUser = new Map<string, RoomParticipant>();
  for (const item of list) {
    byUser.set(item.user.id, item);
  }
  return Array.from(byUser.values());
}

export interface WatchedStreamViewState {
  streamId: string;
  videoStream: MediaStream;
  transportMode: WatchedTransportMode;
  hasAudio: boolean;
  volume: number;
  muted: boolean;
  stats: {
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
  };
}

export interface ToastNotification {
  id: string;
  title: string;
  body: string;
  roomId?: string;
  dmUserId?: string;
}

interface AppState {
  viewMode: 'landing' | 'auth' | 'app';
  navView: 'rooms' | 'friends';
  bootstrapping: boolean;
  wsConnected: boolean;
  user: AuthUser | null;
  settings: UserSettings;

  rooms: RoomSummary[];
  currentRoom: RoomSummary | null;
  joiningRoomId: string | null;
  myPeerId: string | null;
  participants: RoomParticipant[];
  activeStreams: ActiveStreamInfo[];
  messages: ChatMessage[];

  // Friends & Direct Messages
  friends: FriendEntry[];
  activeDmUserId: string | null;
  dmMessagesByUser: Record<string, DirectMessage[]>;
  dmTypingByUser: Record<string, boolean>;

  // Profile & Role Promotion Feedback
  profileModalOpen: boolean;
  inspectedUser: UserPublic | null;
  rolePromotionRole: UserRole | null;

  // Capture Diagnostics & Desktop Auto-Updater
  captureDiagnostic: { active: boolean; reason: string } | null;
  updaterStatus: DesktopUpdaterStatus | null;
  updaterDismissedVersion: string | null;

  micMuted: boolean;
  deafened: boolean;
  localMicDb: number;
  localSpeaking: boolean;

  watchedStreams: Record<string, WatchedStreamViewState>;
  settingsModalOpen: boolean;
  settingsActiveTab: 'audio' | 'stream' | 'app' | 'interface';
  adminModalOpen: boolean;
  streamLauncherOpen: boolean;
  createRoomModalOpen: boolean;
  lightboxImageUrl: string | null;
  toasts: ToastNotification[];

  // Actions
  setViewMode: (mode: 'landing' | 'auth' | 'app') => void;
  setNavView: (nav: 'rooms' | 'friends') => void;
  setAdminModalOpen: (open: boolean) => void;
  setProfileModalOpen: (open: boolean) => void;
  setInspectedUser: (target: UserPublic | null) => void;
  dismissRolePromotionModal: () => void;

  bootstrap: () => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;

  saveMyProfile: (updates: UpdateProfileInput) => Promise<AuthUser>;
  uploadMyAvatar: (file: File | Blob, filename?: string) => Promise<AuthUser>;

  updateSettings: (updater: (prev: UserSettings) => UserSettings) => void;
  setPeerAudioOverride: (targetUserId: string, patch: Partial<PeerAudioOverride>) => void;
  openSettings: (tab?: 'audio' | 'stream' | 'app' | 'interface') => void;
  closeSettings: () => void;
  setStreamLauncherOpen: (open: boolean) => void;
  setCreateRoomModalOpen: (open: boolean) => void;
  setLightboxImageUrl: (url: string | null) => void;
  pushToast: (toast: Omit<ToastNotification, 'id'>) => void;
  dismissToast: (id: string) => void;

  createRoom: (input: CreateRoomInput) => Promise<RoomSummary>;
  deleteRoom: (roomId: string) => Promise<void>;
  joinRoom: (roomId: string, password?: string | null) => Promise<void>;
  leaveRoom: () => Promise<void>;

  toggleMicMute: () => void;
  toggleDeafen: () => void;

  startBroadcast: (params: {
    title: string;
    resolution: StreamResolution;
    fps: StreamFps;
    customBitrateKbps?: number | null;
    audioBitrateKbps?: number | null;
    shareAudio: boolean;
    audioSourceMode?: 'window' | 'system' | 'apps';
    selectedAudioPids?: number[];
    privacy?: StreamPrivacyMode;
    allowedUserIds?: string[];
    viewerLimit?: number | null;
    connectionMode?: StreamConnectionMode;
    contentOptimization: 'detail' | 'motion';
    desktopSource?: DesktopCaptureSourceItem | null;
  }) => Promise<void>;
  updateBroadcastSettings: (patch: {
    targetBitrateKbps?: number;
    audioBitrateKbps?: number;
    privacy?: StreamPrivacyMode;
    viewerLimit?: number | null;
    connectionMode?: StreamConnectionMode;
  }) => Promise<void>;
  reauthorizeCapture: (source?: DesktopCaptureSourceItem) => Promise<void>;
  stopBroadcast: () => Promise<void>;

  watchStream: (streamId: string, preferredMode?: 'p2p' | 'relay') => Promise<void>;
  switchWatchedStreamTransport: (streamId: string, mode: 'p2p' | 'relay') => Promise<void>;
  unwatchStream: (streamId: string) => Promise<void>;
  setWatchedStreamVolume: (streamId: string, volume: number, muted: boolean) => void;

  sendMessage: (content: string, attachmentIds: string[]) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;

  // Friends & Direct Messages Actions
  refreshFriends: () => Promise<void>;
  sendFriendRequest: (username: string) => Promise<void>;
  respondFriendRequest: (friendshipId: string, accept: boolean) => Promise<void>;
  removeFriend: (friendshipId: string) => Promise<void>;
  inviteFriendToCurrentRoom: (targetUserId: string) => Promise<void>;
  openDmWithUser: (peerUserId: string) => Promise<void>;
  sendDirectMessage: (
    recipientId: string,
    content: string,
    attachmentIds: string[]
  ) => Promise<void>;
  editDirectMessage: (peerUserId: string, messageId: string, content: string) => Promise<void>;
  deleteDirectMessage: (peerUserId: string, messageId: string) => Promise<void>;
  notifyDmTyping: (recipientId: string, typing: boolean) => void;

  // Auto-Updater Actions
  checkForAppUpdates: () => Promise<void>;
  installDownloadedUpdateNow: () => Promise<void>;
  dismissUpdateBanner: () => void;

  // Cloud Administration & Real-Time Moderation
  claimOwnerRole: (masterKey: string) => Promise<void>;
  kickParticipant: (peerId: string, reason?: string) => Promise<void>;
  forceMuteParticipant: (peerId: string) => Promise<void>;
  forceStopStream: (streamId: string, reason?: string) => Promise<void>;
}

let settingsSaveTimer: number | null = null;
const dmTypingClearTimers = new Map<string, number>();

function applyThemeAndDomSettings(settings: UserSettings): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.interface.theme);
  root.style.setProperty('--ui-scale', String(settings.interface.uiScale));
  root.style.fontSize = `${Math.round(16 * settings.interface.uiScale * 10) / 10}px`;
  root.classList.toggle('no-glass', !settings.interface.glassEffects);
  root.classList.toggle('reduce-motion', !settings.interface.smoothAnimations);
}

function syncDesktopRuntimeSettings(settings: UserSettings): void {
  const desktop = getDesktopApi();
  if (!desktop) return;
  void desktop.setAutoStart(settings.app.autoStartOnBoot).catch(() => {});
  void desktop.updateOverlayConfig(settings.app.overlay).catch(() => {});
  void desktop
    .configureShortcuts({
      pttEnabled: settings.audio.voiceMode === 'ptt',
      pttKey: settings.audio.pttKey,
      shortcuts: settings.app.shortcuts,
    })
    .catch(() => {});
}

function syncDesktopOverlayParticipants(
  roomName: string | null,
  participants: RoomParticipant[]
) {
  const desktop = getDesktopApi();
  if (!desktop) return;
  desktop.updateOverlayState({
    roomName,
    participants: participants.map((p) => ({
      userId: p.user.id,
      displayName: p.user.displayName,
      avatarColor: p.user.avatarColor,
      avatarUrl: p.user.avatarUrl,
      role: p.user.role,
      speaking: p.speaking,
      micMuted: p.micMuted,
      isStreaming: p.isStreaming,
    })),
  });
}

export const useAppStore = create<AppState>((set, get) => {
  realtimeSession.onConnectionStatus = (connected) => {
    set({ wsConnected: connected });
  };

  realtimeSession.onWatchedStreamStats = (streamId, stats) => {
    set((state) => {
      const existing = state.watchedStreams[streamId];
      if (!existing) return state;
      return {
        watchedStreams: {
          ...state.watchedStreams,
          [streamId]: {
            ...existing,
            stats,
          },
        },
      };
    });
  };

  realtimeSession.onWatchedStreamTransportChanged = (
    streamId,
    videoStream,
    transportMode
  ) => {
    set((state) => {
      const existing = state.watchedStreams[streamId];
      if (!existing) return state;
      return {
        watchedStreams: {
          ...state.watchedStreams,
          [streamId]: {
            ...existing,
            videoStream,
            transportMode,
          },
        },
      };
    });
  };

  realtimeSession.onCaptureDiagnostic = (diag) => {
    set({ captureDiagnostic: diag });
  };

  realtimeSession.onLocalStreamEndedExternally = () => {
    get().pushToast({
      title: 'Transmissão encerrada',
      body: 'O compartilhamento de tela foi finalizado.',
    });
  };

  realtimeSession.onServerEvent = (ev: ServerPushEvent) => {
    const state = get();
    switch (ev.event) {
      case 'lobby:roomsUpdated': {
        const updatedCurrent = state.currentRoom
          ? ev.payload.rooms.find((r) => r.id === state.currentRoom!.id) || state.currentRoom
          : null;
        set({ rooms: ev.payload.rooms, currentRoom: updatedCurrent });
        break;
      }

      case 'room:stateSynced': {
        const deduped = dedupeParticipantsByUser(ev.payload.participants);
        const meInRoom = deduped.find((p) => p.user.id === state.user?.id);
        set({
          currentRoom: ev.payload.room,
          myPeerId: meInRoom?.peerId || realtimeSession.getLocalPeerId() || state.myPeerId,
          participants: deduped,
          activeStreams: ev.payload.activeStreams,
        });
        syncDesktopOverlayParticipants(ev.payload.room.name, deduped);
        break;
      }

      case 'room:participantJoined': {
        if (state.currentRoom?.id !== ev.payload.roomId) return;
        const nextParticipants = dedupeParticipantsByUser([
          ...state.participants.filter((p) => p.user.id !== ev.payload.participant.user.id),
          ev.payload.participant,
        ]);
        set({ participants: nextParticipants });
        syncDesktopOverlayParticipants(state.currentRoom.name, nextParticipants);
        if (
          state.settings.interface.notifications.soundEnabled &&
          state.settings.interface.notifications.joinLeaveSounds
        ) {
          uiSounds.joinRoom();
        }
        break;
      }

      case 'room:participantLeft': {
        if (state.currentRoom?.id !== ev.payload.roomId) return;
        const nextParticipants = state.participants.filter(
          (p) => p.peerId !== ev.payload.peerId && p.user.id !== ev.payload.userId
        );
        set({ participants: nextParticipants });
        syncDesktopOverlayParticipants(state.currentRoom.name, nextParticipants);
        if (
          state.settings.interface.notifications.soundEnabled &&
          state.settings.interface.notifications.joinLeaveSounds
        ) {
          uiSounds.leaveRoom();
        }
        break;
      }

      case 'room:participantUpdated': {
        if (state.currentRoom?.id !== ev.payload.roomId) return;
        const nextParticipants = state.participants.map((p) =>
          p.peerId === ev.payload.peerId || p.user.id === ev.payload.userId
            ? {
                ...p,
                peerId: ev.payload.peerId,
                micMuted: ev.payload.micMuted,
                deafened: ev.payload.deafened,
                speaking: ev.payload.speaking,
                isStreaming: ev.payload.isStreaming,
                voiceProducerId: ev.payload.voiceProducerId,
              }
            : p
        );
        set({ participants: nextParticipants });
        syncDesktopOverlayParticipants(state.currentRoom.name, nextParticipants);
        break;
      }

      case 'room:streamStarted': {
        if (state.currentRoom?.id !== ev.payload.stream.roomId) return;
        const filtered = state.activeStreams.filter(
          (s) => s.streamId !== ev.payload.stream.streamId
        );
        set({ activeStreams: [...filtered, ev.payload.stream] });
        if (state.settings.interface.notifications.soundEnabled) {
          uiSounds.streamStart();
        }
        break;
      }

      case 'room:streamUpdated': {
        if (state.currentRoom?.id !== ev.payload.stream.roomId) return;
        set({
          activeStreams: state.activeStreams.map((s) =>
            s.streamId === ev.payload.stream.streamId ? ev.payload.stream : s
          ),
        });
        break;
      }

      case 'room:streamStopped': {
        if (state.currentRoom?.id !== ev.payload.roomId) return;
        const nextWatched = { ...state.watchedStreams };
        delete nextWatched[ev.payload.streamId];
        set({
          activeStreams: state.activeStreams.filter(
            (s) => s.streamId !== ev.payload.streamId
          ),
          watchedStreams: nextWatched,
        });
        break;
      }

      case 'chat:messageCreated': {
        if (state.currentRoom?.id !== ev.payload.message.roomId) return;
        if (state.messages.some((m) => m.id === ev.payload.message.id)) return;
        set({ messages: [...state.messages, ev.payload.message] });
        break;
      }

      case 'chat:messageUpdated': {
        if (state.currentRoom?.id !== ev.payload.message.roomId) return;
        set({
          messages: state.messages.map((m) =>
            m.id === ev.payload.message.id ? ev.payload.message : m
          ),
        });
        break;
      }

      case 'chat:messageDeleted': {
        if (state.currentRoom?.id !== ev.payload.roomId) return;
        set({
          messages: state.messages.filter((m) => m.id !== ev.payload.messageId),
        });
        break;
      }

      case 'notification:mention': {
        const { roomName, message, roomId } = ev.payload;
        if (state.settings.interface.notifications.mentionAlerts) {
          if (state.settings.interface.notifications.soundEnabled) {
            uiSounds.mention();
          }
          get().pushToast({
            title: `@${message.author.username} mencionou você em #${roomName}`,
            body: message.content.slice(0, 120),
            roomId,
          });
          if (
            state.settings.interface.notifications.desktopNotifications &&
            'Notification' in window &&
            Notification.permission === 'granted' &&
            document.hidden
          ) {
            new Notification(`Menção em #${roomName}`, {
              body: `${message.author.displayName}: ${message.content.slice(0, 100)}`,
            });
          }
        }
        break;
      }

      case 'user:profileUpdated': {
        const updatedUser = ev.payload.user;
        const isMe = state.user?.id === updatedUser.id;
        const nextParticipants = state.participants.map((p) =>
          p.user.id === updatedUser.id ? { ...p, user: updatedUser } : p
        );
        const nextMessages = state.messages.map((m) =>
          m.author.id === updatedUser.id ? { ...m, author: updatedUser } : m
        );
        const nextStreams = state.activeStreams.map((st) => ({
          ...st,
          broadcasterUsername:
            st.broadcasterId === updatedUser.id
              ? updatedUser.username
              : st.broadcasterUsername,
          broadcasterDisplayName:
            st.broadcasterId === updatedUser.id
              ? updatedUser.displayName
              : st.broadcasterDisplayName,
          broadcasterAvatarColor:
            st.broadcasterId === updatedUser.id
              ? updatedUser.avatarColor
              : st.broadcasterAvatarColor,
          broadcasterAvatarUrl:
            st.broadcasterId === updatedUser.id
              ? updatedUser.avatarUrl
              : st.broadcasterAvatarUrl,
          broadcasterRole:
            st.broadcasterId === updatedUser.id ? updatedUser.role : st.broadcasterRole,
          viewerUsers: st.viewerUsers.map((v) =>
            v.id === updatedUser.id
              ? {
                  ...v,
                  username: updatedUser.username,
                  displayName: updatedUser.displayName,
                  avatarColor: updatedUser.avatarColor,
                  avatarUrl: updatedUser.avatarUrl,
                  role: updatedUser.role,
                }
              : v
          ),
        }));
        const nextFriends = state.friends.map((f) =>
          f.user.id === updatedUser.id
            ? { ...f, user: updatedUser, presenceStatus: updatedUser.presenceStatus }
            : f
        );
        const nextDmByUser: Record<string, DirectMessage[]> = {};
        for (const [k, list] of Object.entries(state.dmMessagesByUser)) {
          nextDmByUser[k] = list.map((dm) =>
            dm.sender.id === updatedUser.id ? { ...dm, sender: updatedUser } : dm
          );
        }

        set({
          user: isMe && state.user ? { ...state.user, ...updatedUser } : state.user,
          inspectedUser:
            state.inspectedUser?.id === updatedUser.id ? updatedUser : state.inspectedUser,
          participants: nextParticipants,
          messages: nextMessages,
          activeStreams: nextStreams,
          friends: nextFriends,
          dmMessagesByUser: nextDmByUser,
        });
        if (state.currentRoom) {
          syncDesktopOverlayParticipants(state.currentRoom.name, nextParticipants);
        }
        break;
      }

      case 'user:roleUpdated': {
        const { userId, role } = ev.payload;
        const prevRole = state.user?.role ?? 'member';
        const nextParticipants = state.participants.map((p) =>
          p.user.id === userId ? { ...p, user: { ...p.user, role } } : p
        );
        const nextMessages = state.messages.map((m) =>
          m.author.id === userId ? { ...m, author: { ...m.author, role } } : m
        );
        const nextStreams = state.activeStreams.map((st) => ({
          ...st,
          broadcasterRole: st.broadcasterId === userId ? role : st.broadcasterRole,
          viewerUsers: st.viewerUsers.map((v) => (v.id === userId ? { ...v, role } : v)),
        }));
        const nextRooms = state.rooms.map((r) => ({
          ...r,
          participantsPreview: r.participantsPreview.map((p) =>
            p.userId === userId ? { ...p, role } : p
          ),
        }));
        const nextFriends = state.friends.map((f) =>
          f.user.id === userId ? { ...f, user: { ...f.user, role } } : f
        );

        const isMe = state.user?.id === userId;
        const wasPromotedToStaff =
          isMe &&
          role !== 'member' &&
          role !== prevRole;

        set({
          user: isMe && state.user ? { ...state.user, role } : state.user,
          rolePromotionRole: wasPromotedToStaff ? role : state.rolePromotionRole,
          participants: nextParticipants,
          messages: nextMessages,
          activeStreams: nextStreams,
          rooms: nextRooms,
          friends: nextFriends,
        });
        if (state.currentRoom) {
          syncDesktopOverlayParticipants(state.currentRoom.name, nextParticipants);
        }
        if (isMe) {
          if (state.settings.interface.notifications.soundEnabled) {
            uiSounds.mention();
          }
          const label =
            role === 'owner'
              ? 'Fundador'
              : role === 'admin'
                ? 'Administrador'
                : role === 'moderator'
                  ? 'Moderador'
                  : 'Membro';
          get().pushToast({
            title: 'Credencial atualizada em tempo real',
            body: `Seu cargo agora é ${label}.`,
          });
        }
        break;
      }

      case 'friends:updated': {
        if (Array.isArray(ev.payload.friends)) {
          set({ friends: ev.payload.friends });
        } else {
          void get().refreshFriends();
        }
        break;
      }

      case 'friends:roomInvite': {
        const { fromUser, roomId, roomName } = ev.payload;
        if (state.settings.interface.notifications.soundEnabled) {
          uiSounds.mention();
        }
        get().pushToast({
          title: `Convite de ${fromUser.displayName}`,
          body: `Convidou você para entrar na sala #${roomName}. Clique para conectar!`,
          roomId,
        });
        break;
      }

      case 'dm:messageCreated': {
        const msg = ev.payload.message;
        const myId = state.user?.id;
        if (!myId) return;
        const peerId = msg.sender.id === myId ? msg.recipientId : msg.sender.id;
        const existing = state.dmMessagesByUser[peerId] || [];
        if (existing.some((m) => m.id === msg.id)) return;

        const isWatchingThisDm =
          state.navView === 'friends' && state.activeDmUserId === peerId;

        const nextFriends = state.friends.map((f) =>
          f.user.id === peerId
            ? {
                ...f,
                lastDmAt: msg.createdAt,
                unreadDmCount:
                  msg.sender.id !== myId && !isWatchingThisDm
                    ? (f.unreadDmCount || 0) + 1
                    : f.unreadDmCount,
              }
            : f
        );

        set({
          dmMessagesByUser: {
            ...state.dmMessagesByUser,
            [peerId]: [...existing, msg],
          },
          friends: nextFriends,
        });

        if (msg.sender.id !== myId) {
          if (isWatchingThisDm) {
            void realtimeSession.markDmReadRpc(peerId).catch(() => {});
          } else {
            if (state.settings.interface.notifications.soundEnabled) {
              uiSounds.mention();
            }
            get().pushToast({
              title: `Mensagem direta de ${msg.sender.displayName}`,
              body: msg.content
                ? msg.content.slice(0, 110)
                : msg.roomInvite
                  ? `Convite para a sala #${msg.roomInvite.roomName}`
                  : 'Enviou um anexo',
              dmUserId: peerId,
            });
          }
        }
        break;
      }

      case 'dm:messageUpdated': {
        const msg = ev.payload.message;
        const myId = state.user?.id;
        if (!myId) return;
        const peerId = msg.sender.id === myId ? msg.recipientId : msg.sender.id;
        const existing = state.dmMessagesByUser[peerId] || [];
        set({
          dmMessagesByUser: {
            ...state.dmMessagesByUser,
            [peerId]: existing.map((m) => (m.id === msg.id ? msg : m)),
          },
        });
        break;
      }

      case 'dm:messageDeleted': {
        const nextByUser: Record<string, DirectMessage[]> = {};
        for (const [uid, list] of Object.entries(state.dmMessagesByUser)) {
          nextByUser[uid] = list.filter((m) => m.id !== ev.payload.messageId);
        }
        set({ dmMessagesByUser: nextByUser });
        break;
      }

      case 'dm:typing': {
        const { fromUserId, typing } = ev.payload;
        const prevTimer = dmTypingClearTimers.get(fromUserId);
        if (prevTimer) window.clearTimeout(prevTimer);

        if (typing) {
          const t = window.setTimeout(() => {
            set((s) => ({
              dmTypingByUser: { ...s.dmTypingByUser, [fromUserId]: false },
            }));
          }, 4500);
          dmTypingClearTimers.set(fromUserId, t);
        }

        set((s) => ({
          dmTypingByUser: { ...s.dmTypingByUser, [fromUserId]: typing },
        }));
        break;
      }

      case 'dm:read': {
        const { byUserId, readAt } = ev.payload;
        const existing = state.dmMessagesByUser[byUserId];
        if (!existing) return;
        set({
          dmMessagesByUser: {
            ...state.dmMessagesByUser,
            [byUserId]: existing.map((m) =>
              m.recipientId === byUserId && !m.readAt ? { ...m, readAt } : m
            ),
          },
        });
        break;
      }

      case 'admin:kickedFromRoom': {
        realtimeSession.teardownRoomMedia();
        syncDesktopOverlayParticipants(null, []);
        set({
          currentRoom: null,
          myPeerId: null,
          participants: [],
          activeStreams: [],
          messages: [],
          watchedStreams: {},
          localSpeaking: false,
          captureDiagnostic: null,
        });
        get().pushToast({
          title: `Removido de #${ev.payload.roomName}`,
          body: `${ev.payload.reason} (por ${ev.payload.byDisplayName})`,
        });
        break;
      }

      case 'admin:forceMuted': {
        audioEngine.setLocalMuteAndDeafen(true, state.deafened);
        realtimeSession.updateStoredSessionRoomAudio(
          state.settings.audio,
          true,
          state.deafened
        );
        const nextParticipants = state.participants.map((p) =>
          p.peerId === state.myPeerId ? { ...p, micMuted: true, speaking: false } : p
        );
        set({
          micMuted: true,
          localSpeaking: false,
          participants: nextParticipants,
        });
        syncDesktopOverlayParticipants(state.currentRoom?.name ?? null, nextParticipants);
        get().pushToast({
          title: 'Microfone silenciado pela moderação',
          body: `Silenciado por ${ev.payload.byDisplayName}.`,
        });
        break;
      }

      case 'admin:accountBanned': {
        realtimeSession.disconnect();
        void api.logout();
        syncDesktopOverlayParticipants(null, []);
        set({
          user: null,
          currentRoom: null,
          myPeerId: null,
          participants: [],
          activeStreams: [],
          messages: [],
          watchedStreams: {},
          adminModalOpen: false,
          settingsModalOpen: false,
          profileModalOpen: false,
          viewMode: isDesktopClient() ? 'auth' : 'landing',
        });
        get().pushToast({
          title: 'Conta suspensa pela administração',
          body: ev.payload.reason,
        });
        break;
      }
    }
  };

  // Wire local microphone meter + speaking sync (zero redundant Zustand re-renders during gameplay!)
  let lastReportedSpeaking = false;
  audioEngine.onMeterUpdate = (db, speaking) => {
    const state = get();
    const isWindowVisible = typeof document === 'undefined' || !document.hidden;
    const shouldUpdateDb = state.settingsModalOpen && isWindowVisible;
    const speakingChanged = speaking !== state.localSpeaking;

    if (shouldUpdateDb && speakingChanged) {
      set({ localMicDb: db, localSpeaking: speaking });
    } else if (shouldUpdateDb) {
      set({ localMicDb: db });
    } else if (speakingChanged) {
      set({ localSpeaking: speaking });
    }

    if (speaking !== lastReportedSpeaking && state.currentRoom && state.myPeerId) {
      lastReportedSpeaking = speaking;
      const nextParticipants = state.participants.map((p) =>
        p.peerId === state.myPeerId ? { ...p, speaking } : p
      );
      set({ participants: nextParticipants });
      syncDesktopOverlayParticipants(state.currentRoom.name, nextParticipants);

      void realtimeSession
        .rpc('voice:updateState', {
          micMuted: state.micMuted,
          deafened: state.deafened,
          speaking,
        })
        .catch(() => {});
    }
  };

  const initialSettings = loadCachedSettings();
  if (typeof document !== 'undefined') {
    applyThemeAndDomSettings(initialSettings);
    const syncVisibilityClass = () => {
      document.documentElement.classList.toggle('window-hidden', document.hidden);
    };
    syncVisibilityClass();
    document.addEventListener('visibilitychange', syncVisibilityClass);
  }

  // Subscribe once to Desktop Auto-Updater events
  const desktopBridge = getDesktopApi();
  if (desktopBridge?.updater) {
    void desktopBridge.updater
      .getStatus()
      .then((st) => set({ updaterStatus: st }))
      .catch(() => {});
    desktopBridge.updater.onStatus((st) => {
      set({ updaterStatus: st });
    });
  }

  return {
    viewMode: isDesktopClient() ? 'auth' : 'landing',
    navView: 'rooms',
    bootstrapping: true,
    wsConnected: false,
    user: null,
    settings: initialSettings,

    rooms: [],
    currentRoom: null,
    joiningRoomId: null,
    myPeerId: null,
    participants: [],
    activeStreams: [],
    messages: [],

    friends: [],
    activeDmUserId: null,
    dmMessagesByUser: {},
    dmTypingByUser: {},

    profileModalOpen: false,
    inspectedUser: null,
    rolePromotionRole: null,

    captureDiagnostic: null,
    updaterStatus: null,
    updaterDismissedVersion: null,

    micMuted: false,
    deafened: false,
    localMicDb: -96,
    localSpeaking: false,

    watchedStreams: {},
    settingsModalOpen: false,
    settingsActiveTab: 'audio',
    adminModalOpen: false,
    streamLauncherOpen: false,
    createRoomModalOpen: false,
    lightboxImageUrl: null,
    toasts: [],

    setViewMode: (mode) => set({ viewMode: mode }),
    setNavView: (nav) => set({ navView: nav }),
    setAdminModalOpen: (open) => set({ adminModalOpen: open }),
    setProfileModalOpen: (open) => set({ profileModalOpen: open }),
    setInspectedUser: (target) => set({ inspectedUser: target }),
    dismissRolePromotionModal: () => set({ rolePromotionRole: null }),

    bootstrap: async () => {
      try {
        const restoredUser = await restoreSecureSession();
        if (!restoredUser) {
          set({ bootstrapping: false, viewMode: isDesktopClient() ? 'auth' : 'landing' });
          return;
        }
        persistCachedSettings(restoredUser.settings);
        applyThemeAndDomSettings(restoredUser.settings);
        if (isDesktopClient()) {
          void audioEngine.applyAudioSettings(restoredUser.settings.audio);
          syncDesktopRuntimeSettings(restoredUser.settings);
        }

        set({
          user: restoredUser,
          settings: restoredUser.settings,
          viewMode: isDesktopClient() ? 'app' : 'landing',
          bootstrapping: false,
        });
        if (isDesktopClient()) {
          realtimeSession.connect();
        }
      } catch {
        set({
          user: null,
          bootstrapping: false,
          viewMode: isDesktopClient() ? 'auth' : 'landing',
        });
      }
    },

    login: async (input) => {
      const { user } = await api.login(input);
      persistCachedSettings(user.settings);
      applyThemeAndDomSettings(user.settings);
      if (isDesktopClient()) {
        void audioEngine.applyAudioSettings(user.settings.audio);
        syncDesktopRuntimeSettings(user.settings);
        set({ user, settings: user.settings, viewMode: 'app' });
        realtimeSession.connect();
      } else {
        set({ user, settings: user.settings, viewMode: 'landing' });
      }
    },

    register: async (input) => {
      const { user } = await api.register(input);
      persistCachedSettings(user.settings);
      applyThemeAndDomSettings(user.settings);
      if (isDesktopClient()) {
        void audioEngine.applyAudioSettings(user.settings.audio);
        syncDesktopRuntimeSettings(user.settings);
        set({ user, settings: user.settings, viewMode: 'app' });
        realtimeSession.connect();
      } else {
        set({ user, settings: user.settings, viewMode: 'landing' });
      }
    },

    logout: async () => {
      realtimeSession.disconnect();
      await api.logout();
      syncDesktopOverlayParticipants(null, []);
      set({
        user: null,
        currentRoom: null,
        myPeerId: null,
        participants: [],
        activeStreams: [],
        messages: [],
        friends: [],
        activeDmUserId: null,
        dmMessagesByUser: {},
        watchedStreams: {},
        profileModalOpen: false,
        adminModalOpen: false,
        viewMode: isDesktopClient() ? 'auth' : 'landing',
      });
    },

    saveMyProfile: async (updates) => {
      const { user } = await api.updateProfile(updates);
      set((s) => ({
        user,
        participants: s.participants.map((p) =>
          p.user.id === user.id ? { ...p, user } : p
        ),
      }));
      return user;
    },

    uploadMyAvatar: async (file, filename = 'avatar.png') => {
      const { user } = await api.uploadAvatar(file, filename);
      set((s) => ({
        user,
        participants: s.participants.map((p) =>
          p.user.id === user.id ? { ...p, user } : p
        ),
      }));
      return user;
    },

    updateSettings: (updater) => {
      const next = UserSettingsSchema.parse(updater(get().settings));
      persistCachedSettings(next);
      applyThemeAndDomSettings(next);
      void audioEngine.applyAudioSettings(next.audio);
      syncDesktopRuntimeSettings(next);
      realtimeSession.updateStoredSessionRoomAudio(
        next.audio,
        get().micMuted,
        get().deafened
      );

      set((s) => ({
        settings: next,
        user: s.user ? { ...s.user, settings: next } : null,
      }));

      if (get().user) {
        if (settingsSaveTimer !== null) window.clearTimeout(settingsSaveTimer);
        settingsSaveTimer = window.setTimeout(() => {
          void api.saveSettings(get().settings).catch((err) => {
            console.warn('[Settings] Falha ao sincronizar configurações com servidor:', err);
          });
        }, 350);
      }
    },

    setPeerAudioOverride: (targetUserId, patch) => {
      get().updateSettings((prev) => {
        const existing = prev.audio.peerOverrides[targetUserId] || {
          volume: 100,
          muted: false,
          noiseReductionEnabled: false,
          noiseReductionLevel: 50,
        };
        return {
          ...prev,
          audio: {
            ...prev.audio,
            peerOverrides: {
              ...prev.audio.peerOverrides,
              [targetUserId]: { ...existing, ...patch },
            },
          },
        };
      });
    },

    openSettings: (tab = 'audio') => {
      audioEngine.setMeterActive(tab === 'audio');
      set({ settingsModalOpen: true, settingsActiveTab: tab });
    },
    closeSettings: () => {
      audioEngine.setMicLoopbackTest(false);
      audioEngine.setMeterActive(false);
      set({ settingsModalOpen: false });
    },
    setStreamLauncherOpen: (open) => set({ streamLauncherOpen: open }),
    setCreateRoomModalOpen: (open) => set({ createRoomModalOpen: open }),
    setLightboxImageUrl: (url) => set({ lightboxImageUrl: url }),

    pushToast: (toast) => {
      const id = crypto.randomUUID();
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
      window.setTimeout(() => {
        get().dismissToast(id);
      }, 5500);
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    createRoom: async (input) => {
      const { room } = await api.createRoom(input);
      set((s) => ({
        rooms: s.rooms.some((r) => r.id === room.id) ? s.rooms : [...s.rooms, room],
      }));
      return room;
    },

    deleteRoom: async (roomId) => {
      if (get().currentRoom?.id === roomId) {
        await get().leaveRoom();
      }
      await api.deleteRoom(roomId);
      set((s) => ({ rooms: s.rooms.filter((r) => r.id !== roomId) }));
    },

    joinRoom: async (roomId, password = null) => {
      const state = get();
      if (state.currentRoom?.id === roomId && realtimeSession.isInActiveRoom()) {
        set({ navView: 'rooms' });
        return;
      }
      set({ joiningRoomId: roomId, navView: 'rooms' });
      try {
        const res = await realtimeSession.joinRoomAndSetupMedia({
          roomId,
          password,
          audioSettings: state.settings.audio,
          micMuted: state.micMuted,
          deafened: state.deafened,
        });

        const deduped = dedupeParticipantsByUser(res.participants);
        set({
          currentRoom: res.room,
          myPeerId: res.peerId,
          participants: deduped,
          activeStreams: res.activeStreams,
          messages: res.messages,
          watchedStreams: {},
          joiningRoomId: null,
          navView: 'rooms',
        });
        syncDesktopOverlayParticipants(res.room.name, deduped);

        if (
          state.settings.interface.notifications.soundEnabled &&
          state.settings.interface.notifications.joinLeaveSounds
        ) {
          uiSounds.joinRoom();
        }
      } catch (err) {
        set({ joiningRoomId: null });
        throw err;
      }
    },

    leaveRoom: async () => {
      const state = get();
      if (!state.currentRoom) return;
      await realtimeSession.leaveRoom();
      syncDesktopOverlayParticipants(null, []);
      set({
        currentRoom: null,
        myPeerId: null,
        participants: [],
        activeStreams: [],
        messages: [],
        watchedStreams: {},
        localSpeaking: false,
        captureDiagnostic: null,
      });
      if (
        state.settings.interface.notifications.soundEnabled &&
        state.settings.interface.notifications.joinLeaveSounds
      ) {
        uiSounds.leaveRoom();
      }
    },

    toggleMicMute: () => {
      const state = get();
      const nextMuted = !state.micMuted;
      audioEngine.setLocalMuteAndDeafen(nextMuted, state.deafened);
      realtimeSession.updateStoredSessionRoomAudio(
        state.settings.audio,
        nextMuted,
        state.deafened
      );

      const nextParticipants = state.participants.map((p) =>
        p.peerId === state.myPeerId ? { ...p, micMuted: nextMuted, speaking: false } : p
      );
      set({ micMuted: nextMuted, localSpeaking: false, participants: nextParticipants });
      syncDesktopOverlayParticipants(state.currentRoom?.name ?? null, nextParticipants);

      if (state.settings.interface.notifications.soundEnabled) {
        if (nextMuted) uiSounds.mute();
        else uiSounds.unmute();
      }

      if (state.currentRoom) {
        void realtimeSession
          .rpc('voice:updateState', {
            micMuted: nextMuted,
            deafened: state.deafened,
            speaking: false,
          })
          .catch(() => {});
      }
    },

    toggleDeafen: () => {
      const state = get();
      const nextDeafened = !state.deafened;
      const effectiveMuted = nextDeafened ? true : state.micMuted;
      audioEngine.setLocalMuteAndDeafen(effectiveMuted, nextDeafened);
      realtimeSession.updateStoredSessionRoomAudio(
        state.settings.audio,
        effectiveMuted,
        nextDeafened
      );

      const nextParticipants = state.participants.map((p) =>
        p.peerId === state.myPeerId
          ? { ...p, deafened: nextDeafened, micMuted: effectiveMuted, speaking: false }
          : p
      );
      set({
        deafened: nextDeafened,
        micMuted: effectiveMuted,
        localSpeaking: false,
        participants: nextParticipants,
      });
      syncDesktopOverlayParticipants(state.currentRoom?.name ?? null, nextParticipants);

      if (state.settings.interface.notifications.soundEnabled) {
        if (nextDeafened) uiSounds.mute();
        else uiSounds.unmute();
      }

      if (state.currentRoom) {
        void realtimeSession
          .rpc('voice:updateState', {
            micMuted: effectiveMuted,
            deafened: nextDeafened,
            speaking: false,
          })
          .catch(() => {});
      }
    },

    startBroadcast: async (params) => {
      const stream = await realtimeSession.startLiveStream(params);
      set((s) => ({
        activeStreams: [
          ...s.activeStreams.filter((x) => x.streamId !== stream.streamId),
          stream,
        ],
        streamLauncherOpen: false,
      }));
    },

    updateBroadcastSettings: async (patch) => {
      const updated = await realtimeSession.updateLiveStreamSettings(patch);
      if (updated) {
        set((s) => ({
          activeStreams: s.activeStreams.map((st) =>
            st.streamId === updated.streamId ? updated : st
          ),
        }));
      }
    },

    reauthorizeCapture: async (source) => {
      await realtimeSession.reauthorizeCaptureSource(source);
      get().pushToast({
        title: 'Captura renovada com sucesso',
        body: 'A fonte gráfica foi reautorizada sem interromper sua transmissão.',
      });
    },

    stopBroadcast: async () => {
      await realtimeSession.stopLiveStream();
      const userId = get().user?.id;
      if (userId) {
        set((s) => ({
          activeStreams: s.activeStreams.filter((x) => x.broadcasterId !== userId),
          captureDiagnostic: null,
        }));
      }
    },

    watchStream: async (streamId, preferredMode) => {
      const res = await realtimeSession.watchStream(streamId, preferredMode);
      set((s) => ({
        activeStreams: s.activeStreams.map((st) =>
          st.streamId === res.stream.streamId ? res.stream : st
        ),
        watchedStreams: {
          ...s.watchedStreams,
          [streamId]: {
            streamId,
            videoStream: res.videoStream,
            transportMode: res.transportMode,
            hasAudio: res.hasAudio,
            volume: 100,
            muted: false,
            stats: { width: 0, height: 0, fps: 0, bitrateKbps: 0 },
          },
        },
      }));
    },

    switchWatchedStreamTransport: async (streamId, mode) => {
      await realtimeSession.switchWatchedStreamTransport(streamId, mode);
      get().pushToast({
        title:
          mode === 'relay'
            ? 'Modo Compatibilidade (Relay) ativado'
            : 'Conexão Direta P2P ativada',
        body:
          mode === 'relay'
            ? 'Transmissão roteada via túnel criptografado anti-tela-preta.'
            : 'Transmissão conectada diretamente em baixa latência.',
      });
    },

    unwatchStream: async (streamId) => {
      await realtimeSession.unwatchStream(streamId);
      set((s) => {
        const next = { ...s.watchedStreams };
        delete next[streamId];
        return { watchedStreams: next };
      });
    },

    setWatchedStreamVolume: (streamId, volume, muted) => {
      realtimeSession.setWatchedStreamVolumeState(streamId, volume, muted);
      set((s) => {
        const entry = s.watchedStreams[streamId];
        if (!entry) return s;
        return {
          watchedStreams: {
            ...s.watchedStreams,
            [streamId]: { ...entry, volume, muted },
          },
        };
      });
    },

    sendMessage: async (content, attachmentIds) => {
      const state = get();
      const room = state.currentRoom;
      if (!room) return;

      // Real-time Moderator Slash Commands (/mute, /kick, /stopstream)
      const trimmed = content.trim();
      if (
        trimmed.startsWith('/') &&
        attachmentIds.length === 0 &&
        hasRoleAtLeast(state.user?.role, 'moderator')
      ) {
        const match = trimmed.match(/^\/(mute|kick|stopstream)\s+@?([a-zA-Z0-9_.-]+)(?:\s+(.*))?$/i);
        if (match) {
          const cmd = match[1].toLowerCase();
          const targetUname = match[2].toLowerCase();
          const reason = match[3]?.trim() || 'Ação da moderação';
          const targetPeer = state.participants.find(
            (p) => p.user.username.toLowerCase() === targetUname
          );

          if (!targetPeer) {
            get().pushToast({
              title: 'Comando de moderação',
              body: `Usuário @${targetUname} não está conectado nesta sala.`,
            });
            return;
          }

          if (cmd === 'mute') {
            await realtimeSession.adminForceMuteParticipant(targetPeer.peerId);
            get().pushToast({
              title: 'Moderador • /mute executado',
              body: `@${targetPeer.user.username} foi silenciado na sala.`,
            });
            return;
          }
          if (cmd === 'kick') {
            await realtimeSession.adminKickParticipant(targetPeer.peerId, reason);
            get().pushToast({
              title: 'Moderador • /kick executado',
              body: `@${targetPeer.user.username} foi removido da sala.`,
            });
            return;
          }
          if (cmd === 'stopstream') {
            const targetStream = state.activeStreams.find(
              (st) => st.broadcasterId === targetPeer.user.id
            );
            if (!targetStream) {
              get().pushToast({
                title: 'Comando /stopstream',
                body: `@${targetPeer.user.username} não possui transmissão ativa.`,
              });
              return;
            }
            await realtimeSession.adminForceStopStream(targetStream.streamId, reason);
            get().pushToast({
              title: 'Moderador • /stopstream executado',
              body: `A transmissão de @${targetPeer.user.username} foi encerrada.`,
            });
            return;
          }
        }
      }

      const { message } = await realtimeSession.sendChatMessage(
        room.id,
        content,
        attachmentIds
      );
      set((s) => ({
        messages: s.messages.some((m) => m.id === message.id)
          ? s.messages
          : [...s.messages, message],
      }));
    },

    editMessage: async (messageId, content) => {
      const { message } = await realtimeSession.editChatMessage(messageId, content);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === message.id ? message : m)),
      }));
    },

    deleteMessage: async (messageId) => {
      await realtimeSession.deleteChatMessage(messageId);
      set((s) => ({
        messages: s.messages.filter((m) => m.id !== messageId),
      }));
    },

    // Friends & Direct Messages
    refreshFriends: async () => {
      const { friends } = await realtimeSession.listFriendsRpc();
      set({ friends });
    },

    sendFriendRequest: async (username) => {
      const clean = username.trim().replace(/^@+/, '');
      const { status, friends } = await realtimeSession.sendFriendRequestRpc(clean);
      set({ friends });
      get().pushToast({
        title: status === 'accepted' ? 'Amizade confirmada!' : 'Pedido de amizade enviado',
        body:
          status === 'accepted'
            ? `Você e @${clean} agora são amigos!`
            : `Solicitação enviada para @${clean}.`,
      });
    },

    respondFriendRequest: async (friendshipId, accept) => {
      const { friends } = await realtimeSession.respondFriendRequestRpc(
        friendshipId,
        accept
      );
      set({ friends });
      get().pushToast({
        title: accept ? 'Amizade aceita' : 'Solicitação recusada',
        body: accept ? 'Novo contato adicionado à sua lista.' : 'Solicitação removida.',
      });
    },

    removeFriend: async (friendshipId) => {
      const { friends } = await realtimeSession.removeFriendRpc(friendshipId);
      set({ friends });
    },

    inviteFriendToCurrentRoom: async (targetUserId) => {
      const room = get().currentRoom;
      if (!room) {
        get().pushToast({
          title: 'Entre em uma sala primeiro',
          body: 'Conecte-se a uma sala de voz para convidar amigos com 1 clique.',
        });
        return;
      }
      const res = await realtimeSession.inviteFriendToRoomRpc(targetUserId, room.id);
      const dm = res.dmMessage;
      if (dm) {
        set((s) => {
          const existing = s.dmMessagesByUser[targetUserId] || [];
          return {
            dmMessagesByUser: {
              ...s.dmMessagesByUser,
              [targetUserId]: existing.some((m) => m.id === dm.id)
                ? existing
                : [...existing, dm],
            },
          };
        });
      }
      get().pushToast({
        title: 'Convite enviado!',
        body: `Convite para #${room.name} entregue em tempo real.`,
      });
    },

    openDmWithUser: async (peerUserId) => {
      set((s) => ({
        navView: 'friends',
        activeDmUserId: peerUserId,
        friends: s.friends.map((f) =>
          f.user.id === peerUserId ? { ...f, unreadDmCount: 0 } : f
        ),
      }));

      try {
        const { messages } = await realtimeSession.listDmHistoryRpc(peerUserId);
        set((s) => ({
          dmMessagesByUser: {
            ...s.dmMessagesByUser,
            [peerUserId]: messages,
          },
        }));
        await realtimeSession.markDmReadRpc(peerUserId).catch(() => {});
      } catch {
        // Ignore history load error if offline
      }
    },

    sendDirectMessage: async (recipientId, content, attachmentIds) => {
      const { message } = await realtimeSession.sendDmRpc(
        recipientId,
        content,
        attachmentIds
      );
      set((s) => {
        const existing = s.dmMessagesByUser[recipientId] || [];
        return {
          dmMessagesByUser: {
            ...s.dmMessagesByUser,
            [recipientId]: existing.some((m) => m.id === message.id)
              ? existing
              : [...existing, message],
          },
        };
      });
    },

    editDirectMessage: async (peerUserId, messageId, content) => {
      const { message } = await realtimeSession.editDmRpc(messageId, content);
      set((s) => ({
        dmMessagesByUser: {
          ...s.dmMessagesByUser,
          [peerUserId]: (s.dmMessagesByUser[peerUserId] || []).map((m) =>
            m.id === messageId ? message : m
          ),
        },
      }));
    },

    deleteDirectMessage: async (peerUserId, messageId) => {
      await realtimeSession.deleteDmRpc(messageId);
      set((s) => ({
        dmMessagesByUser: {
          ...s.dmMessagesByUser,
          [peerUserId]: (s.dmMessagesByUser[peerUserId] || []).filter(
            (m) => m.id !== messageId
          ),
        },
      }));
    },

    notifyDmTyping: (recipientId, typing) => {
      void realtimeSession.sendDmTypingRpc(recipientId, typing).catch(() => {});
    },

    // Desktop Auto-Updater
    checkForAppUpdates: async () => {
      const desktop = getDesktopApi();
      if (!desktop?.updater) return;
      const st = await desktop.updater.check();
      set({ updaterStatus: st, updaterDismissedVersion: null });
    },

    installDownloadedUpdateNow: async () => {
      const desktop = getDesktopApi();
      if (!desktop?.updater) return;
      await desktop.updater.quitAndInstall();
    },

    dismissUpdateBanner: () => {
      const ver = get().updaterStatus?.availableVersion || 'dismissed';
      set({ updaterDismissedVersion: ver });
    },

    claimOwnerRole: async (masterKey) => {
      const { user } = await api.claimOwner(masterKey);
      set((s) => ({
        user,
        participants: s.participants.map((p) =>
          p.user.id === user.id ? { ...p, user: { ...p.user, role: user.role } } : p
        ),
      }));
    },

    kickParticipant: async (peerId, reason) => {
      await realtimeSession.adminKickParticipant(peerId, reason);
    },

    forceMuteParticipant: async (peerId) => {
      await realtimeSession.adminForceMuteParticipant(peerId);
    },

    forceStopStream: async (streamId, reason) => {
      await realtimeSession.adminForceStopStream(streamId, reason);
    },
  };
});
