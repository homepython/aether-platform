import { create } from 'zustand';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsSchema,
  type ActiveStreamInfo,
  type AuthUser,
  type ChatMessage,
  type CreateRoomInput,
  type LoginInput,
  type PeerAudioOverride,
  type RegisterInput,
  type RoomParticipant,
  type RoomSummary,
  type ServerPushEvent,
  type StreamFps,
  type StreamResolution,
  type UserSettings,
} from '@aether/shared';
import { api, restoreSecureSession } from '../api/httpClient.js';
import { audioEngine } from '../audio/AudioEngine.js';
import { uiSounds } from '../audio/UiSoundEffects.js';
import {
  getDesktopApi,
  isDesktopClient,
  type DesktopCaptureSourceItem,
} from '../bridge/DesktopBridge.js';
import { realtimeSession } from '../rtc/RealtimeSession.js';

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

export interface WatchedStreamViewState {
  streamId: string;
  videoStream: MediaStream;
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
}

interface AppState {
  viewMode: 'landing' | 'auth' | 'app';
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
  setAdminModalOpen: (open: boolean) => void;
  bootstrap: () => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;

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
    shareAudio: boolean;
    contentOptimization: 'detail' | 'motion';
    desktopSource?: DesktopCaptureSourceItem | null;
  }) => Promise<void>;
  stopBroadcast: () => Promise<void>;

  watchStream: (streamId: string) => Promise<void>;
  unwatchStream: (streamId: string) => Promise<void>;
  setWatchedStreamVolume: (streamId: string, volume: number, muted: boolean) => void;

  sendMessage: (content: string, attachmentIds: string[]) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;

  // Cloud Administration & Real-Time Moderation
  claimOwnerRole: (masterKey: string) => Promise<void>;
  kickParticipant: (peerId: string, reason?: string) => Promise<void>;
  forceMuteParticipant: (peerId: string) => Promise<void>;
  forceStopStream: (streamId: string, reason?: string) => Promise<void>;
}

let settingsSaveTimer: number | null = null;

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

function syncDesktopOverlayParticipants(roomName: string | null, participants: RoomParticipant[]) {
  const desktop = getDesktopApi();
  if (!desktop) return;
  desktop.updateOverlayState({
    roomName,
    participants: participants.map((p) => ({
      userId: p.user.id,
      displayName: p.user.displayName,
      avatarColor: p.user.avatarColor,
      role: p.user.role,
      speaking: p.speaking,
      micMuted: p.micMuted,
      isStreaming: p.isStreaming,
    })),
  });
}

export const useAppStore = create<AppState>((set, get) => {
  // Wire real-time session callbacks once
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

      case 'room:participantJoined': {
        if (state.currentRoom?.id !== ev.payload.roomId) return;
        const exists = state.participants.some((p) => p.peerId === ev.payload.participant.peerId);
        const nextParticipants = exists
          ? state.participants.map((p) =>
              p.peerId === ev.payload.participant.peerId ? ev.payload.participant : p
            )
          : [...state.participants, ev.payload.participant];
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
        const nextParticipants = state.participants.filter((p) => p.peerId !== ev.payload.peerId);
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
          p.peerId === ev.payload.peerId
            ? {
                ...p,
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
        const filtered = state.activeStreams.filter((s) => s.streamId !== ev.payload.stream.streamId);
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
          activeStreams: state.activeStreams.filter((s) => s.streamId !== ev.payload.streamId),
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

      case 'user:roleUpdated': {
        const { userId, role } = ev.payload;
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

        const isMe = state.user?.id === userId;
        set({
          user: isMe && state.user ? { ...state.user, role } : state.user,
          participants: nextParticipants,
          messages: nextMessages,
          activeStreams: nextStreams,
          rooms: nextRooms,
        });
        if (state.currentRoom) {
          syncDesktopOverlayParticipants(state.currentRoom.name, nextParticipants);
        }
        if (isMe) {
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
        });
        get().pushToast({
          title: `Removido de #${ev.payload.roomName}`,
          body: `${ev.payload.reason} (por ${ev.payload.byDisplayName})`,
        });
        break;
      }

      case 'admin:forceMuted': {
        audioEngine.setLocalMuteAndDeafen(true, state.deafened);
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

  // Initial settings load + automatic background animation suspension when hidden/minimized
  const initialSettings = loadCachedSettings();
  if (typeof document !== 'undefined') {
    applyThemeAndDomSettings(initialSettings);
    const syncVisibilityClass = () => {
      document.documentElement.classList.toggle('window-hidden', document.hidden);
    };
    syncVisibilityClass();
    document.addEventListener('visibilitychange', syncVisibilityClass);
  }

  return {
    viewMode: isDesktopClient() ? 'auth' : 'landing',
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
    setAdminModalOpen: (open) => set({ adminModalOpen: open }),

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
        watchedStreams: {},
        viewMode: isDesktopClient() ? 'auth' : 'landing',
      });
    },

    updateSettings: (updater) => {
      const next = UserSettingsSchema.parse(updater(get().settings));
      persistCachedSettings(next);
      applyThemeAndDomSettings(next);
      void audioEngine.applyAudioSettings(next.audio);
      syncDesktopRuntimeSettings(next);

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

    openSettings: (tab = 'audio') => set({ settingsModalOpen: true, settingsActiveTab: tab }),
    closeSettings: () => {
      audioEngine.setMicLoopbackTest(false);
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
      }, 5000);
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
      if (state.currentRoom?.id === roomId) return;
      set({ joiningRoomId: roomId });
      try {
        const res = await realtimeSession.joinRoomAndSetupMedia({
          roomId,
          password,
          audioSettings: state.settings.audio,
          micMuted: state.micMuted,
          deafened: state.deafened,
        });

        set({
          currentRoom: res.room,
          myPeerId: res.peerId,
          participants: res.participants,
          activeStreams: res.activeStreams,
          messages: res.messages,
          watchedStreams: {},
          joiningRoomId: null,
        });
        syncDesktopOverlayParticipants(res.room.name, res.participants);

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
        activeStreams: [...s.activeStreams.filter((x) => x.streamId !== stream.streamId), stream],
        streamLauncherOpen: false,
      }));
    },

    stopBroadcast: async () => {
      await realtimeSession.stopLiveStream();
      const userId = get().user?.id;
      if (userId) {
        set((s) => ({
          activeStreams: s.activeStreams.filter((x) => x.broadcasterId !== userId),
        }));
      }
    },

    watchStream: async (streamId) => {
      const res = await realtimeSession.watchStream(streamId);
      set((s) => ({
        activeStreams: s.activeStreams.map((st) =>
          st.streamId === res.stream.streamId ? res.stream : st
        ),
        watchedStreams: {
          ...s.watchedStreams,
          [streamId]: {
            streamId,
            videoStream: res.videoStream,
            hasAudio: res.hasAudio,
            volume: 100,
            muted: false,
            stats: { width: 0, height: 0, fps: 0, bitrateKbps: 0 },
          },
        },
      }));
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
      audioEngine.setStreamVolume(streamId, volume, muted);
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
      const room = get().currentRoom;
      if (!room) return;
      const { message } = await realtimeSession.sendChatMessage(room.id, content, attachmentIds);
      set((s) => ({
        messages: s.messages.some((m) => m.id === message.id) ? s.messages : [...s.messages, message],
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

