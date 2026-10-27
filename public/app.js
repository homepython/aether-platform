(() => {
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  const isDesktopInstalledApp = Boolean(window.aetherDesktop && window.aetherDesktop.isDesktop);

  // ================= CONFIGURAÇÃO DO SERVIDOR CLOUD 24/7 OU LOCAL =================
  const savedServerMode = localStorage.getItem('aether_server_mode') || 'auto';
  const savedCloudUrl = (localStorage.getItem('aether_cloud_url') || '').trim().replace(/\/+$/, '');

  function resolveSocketServerUrl() {
    if (savedServerMode === 'cloud' && savedCloudUrl && /^https?:\/\//i.test(savedCloudUrl)) {
      return savedCloudUrl;
    }
    return undefined;
  }

  const activeServerEndpoint = resolveSocketServerUrl();
  const socket = activeServerEndpoint
    ? io(activeServerEndpoint, {
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000,
        transports: ['websocket', 'polling']
      })
    : io({
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000,
        transports: ['websocket', 'polling']
      });

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };

  const defaultHotkeys = {
    toggleMic: 'CommandOrControl+Shift+M',
    muteMic: 'CommandOrControl+Shift+Down',
    unmuteMic: 'CommandOrControl+Shift+Up',
    pushToTalk: 'CommandOrControl+Shift+Space',
    toggleOverlay: 'CommandOrControl+Shift+O',
    toggleDeafen: 'CommandOrControl+Shift+D'
  };

  let savedHotkeys = defaultHotkeys;
  try {
    const rawHk = localStorage.getItem('aether_global_hotkeys');
    if (rawHk) savedHotkeys = { ...defaultHotkeys, ...JSON.parse(rawHk) };
  } catch (e) {}

  let savedCustomXY = { x: null, y: null };
  try {
    const rawXY = localStorage.getItem('aether_overlay_custom_xy');
    if (rawXY) savedCustomXY = JSON.parse(rawXY);
  } catch (e) {}

  const state = {
    user: null,
    currentRoomId: null,
    roomSessionToken: 0,
    isLoggingIn: false,
    isReinitializingMic: false,
    rooms: [],
    roomUsers: [],
    localVoiceStream: null,
    localMicRawStream: null,
    localMicFilterNodes: null,
    localMicMeterTimer: null,
    localScreenStream: null,
    lastRemoteVoiceActivityAt: 0,
    lastVideoBytesReceived: new Map(),
    audioContext: null,
    voiceGateEnabled: true,
    noiseSuppressionEnabled: true,
    localNoiseLevel: localStorage.getItem('aether_local_nr_level') || 'auto',
    voiceGateThreshold: 18,
    isSelfSpeaking: false,
    voiceMode: 'vad',
    pttPressed: false,
    globalPttHoldTimeout: null,
    isMicMuted: false,
    isDeafened: false,
    isStreaming: false,
    streamStartedAt: null,
    streamTimerInterval: null,
    myStreamViewers: new Set(),
    sharpenEnabled: true,
    roomSfxEnabled: localStorage.getItem('aether_room_sfx') !== 'off',
    overlayEnabled: localStorage.getItem('aether_overlay_enabled') !== 'off',
    overlayFullscreenOnly: localStorage.getItem('aether_overlay_fullscreen_only') !== 'off',
    overlayShowRoomTitle: localStorage.getItem('aether_overlay_show_title') !== 'off',
    overlaySize: localStorage.getItem('aether_overlay_size') || 'medium',
    overlayScale: Number(localStorage.getItem('aether_overlay_scale') || 100),
    overlayOpacity: Number(localStorage.getItem('aether_overlay_opacity') || 90),
    overlayPosition: localStorage.getItem('aether_overlay_pos') || 'top-left',
    overlayCustomX: typeof savedCustomXY?.x === 'number' ? savedCustomXY.x : null,
    overlayCustomY: typeof savedCustomXY?.y === 'number' ? savedCustomXY.y : null,
    overlayUnlocked: false,
    nativeNotificationsEnabled: localStorage.getItem('aether_win_notif') !== 'off',
    globalHotkeys: savedHotkeys,
    speakingPeers: new Set(),
    suppressedLocalQueue: [],
    serverMode: savedServerMode,
    cloudServerUrl: savedCloudUrl,
    selectedAudioInputId: 'default',
    selectedAudioOutputId: 'default',
    theme: localStorage.getItem('aether_theme') || 'comfortable',
    uiScale: localStorage.getItem('aether_scale') || '100',
    animationsEnabled: localStorage.getItem('aether_motion') !== 'reduced',
    streamSettings: {
      resolution: 1080,
      fps: 60,
      bitrateMode: 'auto',
      contentHint: 'detail'
    },
    focusedPeerId: null,
    activeAudioStreamPeerId: null,
    stoppedWatchingPeers: new Set(),
    replyingTo: null,
    stagedFile: null,
    mentionState: {
      active: false,
      startIndex: -1,
      query: '',
      filteredUsers: [],
      selectedIndex: 0
    },
    lightbox: {
      scale: 1,
      panX: 0,
      panY: 0,
      isDragging: false,
      startX: 0,
      startY: 0
    },
    peers: new Map(),
    userVolumes: new Map(),
    userNoiseLevels: new Map()
  };

  const el = {
    toastContainer: document.getElementById('toast-container'),
    entryScreen: document.getElementById('entry-screen'),
    entryForm: document.getElementById('entry-form'),
    inputName: document.getElementById('input-name'),
    inputNick: document.getElementById('input-nick'),
    btnEnterApp: document.getElementById('btn-enter-app'),
    appShell: document.getElementById('app-shell'),
    workspaceGrid: document.getElementById('workspace-grid'),
    selfAvatar: document.getElementById('self-avatar'),
    selfName: document.getElementById('self-name'),
    selfNick: document.getElementById('self-nick'),
    currentRoomTitle: document.getElementById('current-room-title'),
    currentRoomIcon: document.getElementById('current-room-icon'),
    roomsList: document.getElementById('rooms-list'),
    participantsList: document.getElementById('participants-list'),
    roomUserCount: document.getElementById('room-user-count'),
    localMicLevel: document.getElementById('local-mic-level'),
    vadGateStateText: document.getElementById('vad-gate-state-text'),
    inputGateThreshold: document.getElementById('input-gate-threshold'),
    gateThresholdLabel: document.getElementById('gate-threshold-label'),
    btnToggleMic: document.getElementById('btn-toggle-mic'),
    btnToggleDeafen: document.getElementById('btn-toggle-deafen'),
    btnStartStream: document.getElementById('btn-start-stream'),
    btnQuickStreamHeader: document.getElementById('btn-quick-stream-header'),
    labelStreamBtn: document.getElementById('label-stream-btn'),
    selectVoiceMode: document.getElementById('select-voice-mode'),
    streamsGrid: document.getElementById('streams-grid'),
    stageEmptyState: document.getElementById('stage-empty-state'),
    activeStreamsCounter: document.getElementById('active-streams-counter'),
    focusedControls: document.getElementById('focused-controls'),
    focusedTelemetryHud: document.getElementById('focused-telemetry-hud'),
    btnToggleSharpen: document.getElementById('btn-toggle-sharpen'),
    focusedStreamVolume: document.getElementById('focused-stream-volume'),
    focusedVolumeLabel: document.getElementById('focused-volume-label'),
    btnMuteFocusedStream: document.getElementById('btn-mute-focused-stream'),
    btnFullscreenStream: document.getElementById('btn-fullscreen-stream'),
    btnStopWatching: document.getElementById('btn-stop-watching'),
    btnMinimizeStream: document.getElementById('btn-minimize-stream'),
    chatMessages: document.getElementById('chat-messages'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    mentionAutocomplete: document.getElementById('mention-autocomplete'),
    mentionAutocompleteList: document.getElementById('mention-autocomplete-list'),
    btnAttachFile: document.getElementById('btn-attach-file'),
    fileInputHidden: document.getElementById('file-input-hidden'),
    btnToggleEmoji: document.getElementById('btn-toggle-emoji'),
    emojiPickerBar: document.getElementById('emoji-picker-bar'),
    chatDropzone: document.getElementById('chat-dropzone'),
    dropzoneOverlay: document.getElementById('dropzone-overlay'),
    clipboardPreviewBar: document.getElementById('clipboard-preview-bar'),
    clipboardPreviewImg: document.getElementById('clipboard-preview-img'),
    clipboardPreviewName: document.getElementById('clipboard-preview-name'),
    clipboardPreviewSize: document.getElementById('clipboard-preview-size'),
    btnCancelClipboard: document.getElementById('btn-cancel-clipboard'),
    replyPreviewBar: document.getElementById('reply-preview-bar'),
    replyTargetNick: document.getElementById('reply-target-nick'),
    replyTargetSnippet: document.getElementById('reply-target-snippet'),
    btnCancelReply: document.getElementById('btn-cancel-reply'),
    imageLightbox: document.getElementById('image-lightbox'),
    lightboxStage: document.getElementById('lightbox-stage'),
    lightboxImg: document.getElementById('lightbox-img'),
    lightboxCaption: document.getElementById('lightbox-caption'),
    lightboxZoomLabel: document.getElementById('lightbox-zoom-label'),
    btnZoomIn: document.getElementById('btn-zoom-in'),
    btnZoomOut: document.getElementById('btn-zoom-out'),
    btnZoomReset: document.getElementById('btn-zoom-reset'),
    btnLightboxDownload: document.getElementById('btn-lightbox-download'),
    btnCloseLightbox: document.getElementById('btn-close-lightbox'),
    modalStreamConfig: document.getElementById('modal-stream-config'),
    btnCloseStreamModal: document.getElementById('btn-close-stream-modal'),
    btnCancelStreamModal: document.getElementById('btn-cancel-stream-modal'),
    btnConfirmStartStream: document.getElementById('btn-confirm-start-stream'),
    selectContentHint: document.getElementById('select-content-hint'),
    modalCreateRoom: document.getElementById('modal-create-room'),
    btnOpenCreateRoom: document.getElementById('btn-open-create-room'),
    btnCloseRoomModal: document.getElementById('btn-close-room-modal'),
    btnCancelRoomModal: document.getElementById('btn-cancel-room-modal'),
    formCreateRoom: document.getElementById('form-create-room'),
    newRoomName: document.getElementById('new-room-name'),
    newRoomPrivate: document.getElementById('new-room-private'),
    newRoomPassword: document.getElementById('new-room-password'),
    passwordFieldGroup: document.getElementById('password-field-group'),
    netStatusDot: document.getElementById('net-status-dot'),
    netStatusText: document.getElementById('net-status-text'),
    telemetryPing: document.getElementById('telemetry-ping'),
    telemetryLoss: document.getElementById('telemetry-loss'),
    remoteVoiceAudios: document.getElementById('remote-voice-audios'),
    btnQuickTheme: document.getElementById('btn-quick-theme'),
    btnOpenSettings: document.getElementById('btn-open-settings'),
    btnCapsuleSettings: document.getElementById('btn-capsule-settings'),
    modalSettings: document.getElementById('modal-settings'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    settingsPanelTitle: document.getElementById('settings-panel-title'),
    toggleNoiseGate: document.getElementById('toggle-noise-gate'),
    toggleNoiseSuppression: document.getElementById('toggle-noise-suppression'),
    selectAudioInput: document.getElementById('select-audio-input'),
    selectAudioOutput: document.getElementById('select-audio-output'),
    settingsStreamRes: document.getElementById('settings-stream-res'),
    settingsStreamFps: document.getElementById('settings-stream-fps'),
    settingsStreamBitrate: document.getElementById('settings-stream-bitrate'),
    selectUiScale: document.getElementById('select-ui-scale'),
    toggleUiAnimations: document.getElementById('toggle-ui-animations')
  };

  function injectAuxiliaryStyles() {
    if (document.getElementById('aether-final-injected-styles')) return;
    const style = document.createElement('style');
    style.id = 'aether-final-injected-styles';
    style.textContent = `
      .broadcaster-hud {
        border-radius: 18px;
        padding: 12px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 14px;
        background: linear-gradient(135deg, rgba(244, 63, 94, 0.14) 0%, var(--surface-glass) 55%);
        border: 1px solid rgba(244, 63, 94, 0.35);
        box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.14), 0 12px 30px -8px rgba(0, 0, 0, 0.45);
        flex-shrink: 0;
      }
      .broadcaster-hud-left { display: flex; align-items: center; gap: 14px; }
      .broadcaster-live-pill {
        display: inline-flex; align-items: center; gap: 7px;
        background: rgba(244, 63, 94, 0.22); border: 1px solid rgba(244, 63, 94, 0.5);
        color: #fecdd3; padding: 6px 12px; border-radius: 99px;
        font-size: 11.5px; font-weight: 700; letter-spacing: 0.05em;
      }
      .broadcaster-live-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #f43f5e; box-shadow: 0 0 10px #f43f5e;
      }
      .broadcaster-status-stack { display: flex; flex-direction: column; gap: 2px; }
      .broadcaster-status-stack strong { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
      .broadcaster-status-sub { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-secondary); }
      .broadcaster-hud-right { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
      .broadcaster-metric-pill {
        background: var(--surface-card); border: 1px solid var(--border-hairline);
        padding: 6px 12px; border-radius: 10px; font-size: 12px; font-weight: 500;
        color: var(--text-primary); display: inline-flex; align-items: center; gap: 6px;
      }
      .broadcaster-metric-pill.viewers-pill {
        background: rgba(94, 129, 244, 0.18); border-color: rgba(94, 129, 244, 0.42);
        color: #e0e7ff; font-weight: 600;
      }
      .participant-nr-row {
        margin-top: 6px; padding-top: 6px;
        border-top: 1px dashed rgba(255, 255, 255, 0.06);
        display: none; align-items: center; justify-content: space-between; gap: 6px;
      }
      .participant-card:hover .participant-nr-row,
      .participant-card.show-volume .participant-nr-row {
        display: flex;
      }
      .participant-nr-label { font-size: 10px; color: var(--text-secondary); }
      .nr-pills-group { display: inline-flex; gap: 3px; }
      .nr-pill-btn {
        background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border-hairline);
        color: var(--text-secondary); border-radius: 6px; padding: 2px 6px;
        font-size: 9.5px; font-weight: 600; cursor: pointer; transition: all 150ms ease;
      }
      .nr-pill-btn:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.09); }
      .nr-pill-btn.active {
        background: rgba(94, 129, 244, 0.24); border-color: rgba(94, 129, 244, 0.55); color: #dbeafe;
      }
      .cloud-server-input-row {
        display: flex; gap: 8px; margin-top: 8px; width: 100%;
      }
      .cloud-server-input-row input {
        flex: 1; background: var(--surface-input); border: 1px solid var(--border-specular);
        border-radius: 10px; padding: 8px 12px; color: var(--text-primary);
        font-size: 12.5px; outline: none;
      }
      .cloud-status-badge {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; padding: 3px 9px; border-radius: 99px;
        background: rgba(16, 185, 129, 0.14); border: 1px solid rgba(16, 185, 129, 0.35); color: #6ee7b7;
      }
      .entry-cloud-accordion {
        margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-hairline);
      }
      .entry-cloud-toggle {
        background: transparent; border: none; color: var(--text-secondary);
        font-size: 11.5px; cursor: pointer; display: flex; align-items: center; gap: 6px;
      }
      .entry-cloud-toggle:hover { color: var(--text-primary); }
      .hotkey-recorder-btn {
        min-width: 195px;
        text-align: center;
        background: var(--surface-input);
        border: 1px solid var(--border-specular);
        color: var(--text-primary);
        padding: 7px 12px;
        border-radius: 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 150ms ease;
      }
      .hotkey-recorder-btn.recording {
        background: rgba(244, 63, 94, 0.2);
        border-color: #f43f5e;
        color: #fecdd3;
        box-shadow: 0 0 12px rgba(244, 63, 94, 0.35);
      }
      #btn-quick-stream-header.streaming-active-btn {
        background: rgba(244, 63, 94, 0.22) !important;
        border-color: rgba(244, 63, 94, 0.65) !important;
        color: #fecdd3 !important;
        box-shadow: 0 0 16px rgba(244, 63, 94, 0.28);
      }
      /* Nitidez nativa 1:1 em GPU para transmissões 2K (1440p) sem distorção de sub-píxeis */
      video.stream-webrtc-video.native-2k-crisp {
        filter: contrast(1.03) saturate(1.03) !important;
        image-rendering: -webkit-optimize-contrast;
        transform: translateZ(0);
        backface-visibility: hidden;
        will-change: transform;
      }
    `;
    document.head.appendChild(style);
  }
  injectAuxiliaryStyles();

  function syncStreamButtonsVisualState() {
    if (el.btnStartStream) {
      el.btnStartStream.classList.toggle('streaming-now', state.isStreaming);
    }
    if (el.labelStreamBtn) {
      el.labelStreamBtn.textContent = state.isStreaming ? 'Parar Live' : 'Transmitir';
    }
    if (el.btnQuickStreamHeader) {
      el.btnQuickStreamHeader.classList.toggle('streaming-active-btn', state.isStreaming);
      el.btnQuickStreamHeader.innerHTML = state.isStreaming
        ? '<span>🔴</span> <span>Encerrar Transmissão</span>'
        : '<span>🖥️</span> <span>Partilhar Ecrã</span>';
    }
  }

  function buildOverlayConfigObject() {
    return {
      enabled: state.overlayEnabled,
      fullscreenOnly: state.overlayFullscreenOnly,
      showRoomTitle: state.overlayShowRoomTitle,
      size: state.overlaySize,
      scale: state.overlayScale,
      opacity: state.overlayOpacity,
      position: state.overlayPosition,
      customX: state.overlayCustomX,
      customY: state.overlayCustomY,
      unlocked: state.overlayUnlocked
    };
  }

  function pushOverlayConfigToDesktop() {
    if (!isDesktopInstalledApp || !window.aetherDesktop?.setOverlayConfig) return;
    window.aetherDesktop.setOverlayConfig(buildOverlayConfigObject());
  }

  function syncDesktopOverlayState() {
    if (!isDesktopInstalledApp || !window.aetherDesktop?.updateOverlayState) return;
    const roomObj = state.rooms.find(r => r.id === state.currentRoomId);
    const usersPayload = (state.roomUsers || []).map((u) => {
      const isMe = u.socketId === socket.id;
      const isSpeaking = isMe ? state.isSelfSpeaking : state.speakingPeers.has(u.socketId);
      return {
        socketId: u.socketId,
        name: u.name,
        nick: u.nick,
        avatarColor: u.avatarColor || '#5E81F4',
        isMuted: isMe ? state.isMicMuted : Boolean(u.isMuted),
        isDeafened: isMe ? state.isDeafened : Boolean(u.isDeafened),
        isSpeaking: Boolean(isSpeaking && !(isMe ? state.isMicMuted : u.isMuted))
      };
    });

    window.aetherDesktop.updateOverlayState({
      roomName: roomObj ? roomObj.name : (el.currentRoomTitle?.textContent || 'Aether'),
      isSelfStreaming: Boolean(state.isStreaming),
      viewersCount: state.myStreamViewers.size,
      users: usersPayload
    });
  }

  function isLocalFullscreenOrVideoPlaying() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function dispatchSmartNotification(title, body, icon = '🔔', onClick = null) {
    const fullscreenNow = isLocalFullscreenOrVideoPlaying();

    if (isDesktopInstalledApp && state.nativeNotificationsEnabled && window.aetherDesktop?.notify) {
      if (fullscreenNow) {
        state.suppressedLocalQueue.push({ title, body });
        return;
      }
      window.aetherDesktop.notify({ title, body });
      if (!document.hidden) {
        showToast(title, body, icon, onClick);
      }
      return;
    }

    if (fullscreenNow) {
      state.suppressedLocalQueue.push({ title, body });
      return;
    }

    showToast(title, body, icon, onClick);
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && state.suppressedLocalQueue.length > 0) {
      const count = state.suppressedLocalQueue.length;
      const last = state.suppressedLocalQueue[count - 1];
      state.suppressedLocalQueue = [];
      showToast(
        `${count} ${count === 1 ? 'notificação recebida' : 'notificações recebidas'} durante ecrã cheio`,
        `${last.title}: ${last.body}`,
        '🔔'
      );
    }
  });

  function formatAcceleratorFromKeyEvent(e) {
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');

    const ignoredKeys = ['Control', 'Shift', 'Alt', 'Meta'];
    if (ignoredKeys.includes(e.key)) return null;

    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    else if (keyName.startsWith('Arrow')) keyName = keyName.replace('Arrow', '');
    else if (keyName.length === 1) keyName = keyName.toUpperCase();

    return [...mods, keyName].join('+');
  }

  function injectAdvancedSettingsAndCloudUI() {
    const tabAudio = document.getElementById('tab-audio');
    if (tabAudio && !document.getElementById('select-local-nr-level')) {
      const audioExtraCard = document.createElement('div');
      audioExtraCard.className = 'settings-group-card';
      audioExtraCard.innerHTML = `
        <div class="setting-row">
          <div class="setting-info">
            <strong>Nível de Supressão de Ruído (Ventilador / Ar-Condicionado)</strong>
            <small>Ajuste a intensidade do filtro para o seu microfone sem cortar a voz.</small>
          </div>
          <select id="select-local-nr-level" class="apple-select">
            <option value="auto">Automático Inteligente (Recomendado)</option>
            <option value="low">Baixo (Ambiente Silencioso)</option>
            <option value="medium">Médio (Ventilador Leve)</option>
            <option value="high">Alto (Ruído Intenso / Ar-Condicionado)</option>
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Efeitos Sonoros de Entrada e Saída da Sala</strong>
            <small>Reproduz avisos sonoros suaves quando você ou um amigo entra ou sai da sala.</small>
          </div>
          <label class="apple-switch">
            <input type="checkbox" id="toggle-room-sfx" ${state.roomSfxEnabled ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
      `;
      tabAudio.appendChild(audioExtraCard);

      const selectNr = document.getElementById('select-local-nr-level');
      if (selectNr) {
        selectNr.value = state.localNoiseLevel;
        selectNr.addEventListener('change', () => {
          state.localNoiseLevel = selectNr.value;
          localStorage.setItem('aether_local_nr_level', state.localNoiseLevel);
          applyLocalMicNoiseFilterProfile(state.localNoiseLevel);
          showToast('Filtro de Ruído Atualizado', `Perfil "${selectNr.options[selectNr.selectedIndex].text}" aplicado.`, '🎙️');
        });
      }

      const toggleSfx = document.getElementById('toggle-room-sfx');
      if (toggleSfx) {
        toggleSfx.addEventListener('change', () => {
          state.roomSfxEnabled = toggleSfx.checked;
          localStorage.setItem('aether_room_sfx', state.roomSfxEnabled ? 'on' : 'off');
          if (state.roomSfxEnabled) playRoomSoundEffect('self-join');
        });
      }
    }

    const tabInterface = document.getElementById('tab-interface');

    if (tabInterface && !document.getElementById('user-profile-settings-card')) {
      const profileCard = document.createElement('div');
      profileCard.id = 'user-profile-settings-card';
      profileCard.className = 'settings-group-card';
      profileCard.innerHTML = `
        <div class="setting-info">
          <strong>Perfil do Utilizador (Salvo Automaticamente)</strong>
          <small>Altere o seu Nome de exibição e Nickname quando quiser sem precisar reiniciar o aplicativo.</small>
          <div class="cloud-server-input-row" style="margin-top:10px;">
            <input type="text" id="settings-input-user-name" placeholder="Seu Nome" maxlength="28" value="${escapeHtml(state.user?.name || '')}" />
            <input type="text" id="settings-input-user-nick" placeholder="seu_nick" maxlength="20" value="${escapeHtml(state.user?.nick || '')}" />
            <button type="button" id="btn-save-user-profile" class="btn-chip primary">Salvar Perfil</button>
          </div>
        </div>
      `;
      tabInterface.prepend(profileCard);

      const nameInp = document.getElementById('settings-input-user-name');
      const nickInp = document.getElementById('settings-input-user-nick');
      const saveProfileBtn = document.getElementById('btn-save-user-profile');

      nickInp?.addEventListener('input', () => {
        nickInp.value = nickInp.value.replace(/[^a-zA-Z0-9_\s]/g, '');
      });

      saveProfileBtn?.addEventListener('click', () => {
        const newName = (nameInp?.value || '').trim();
        const newNick = (nickInp?.value || '').trim().replace(/\s+/g, '_').toLowerCase();
        if (newName.length < 2 || newNick.length < 2) {
          showToast('Dados Inválidos', 'Nome e Nickname devem ter pelo menos 2 caracteres.', '⚠️');
          return;
        }
        const avatarColor = state.user?.avatarColor || '#5E81F4';
        localStorage.setItem('aether_user_profile', JSON.stringify({
          name: newName,
          nick: newNick,
          avatarColor
        }));

        if (state.user) {
          state.user.name = newName;
          state.user.nick = newNick;
          el.selfAvatar.textContent = newName.charAt(0).toUpperCase();
          el.selfName.textContent = newName;
          el.selfNick.textContent = '@' + newNick;

          const meInRoom = state.roomUsers.find(u => u.socketId === socket.id);
          if (meInRoom) {
            meInRoom.name = newName;
            meInRoom.nick = newNick;
            renderParticipantsList(state.roomUsers);
          }

          socket.emit('user:state-change', { name: newName, nick: newNick });
          syncDesktopOverlayState();
        }
        showToast('Perfil Atualizado', `Agora você é ${newName} (@${newNick}).`, '✅');
      });
    } else if (state.user) {
      const nameInp = document.getElementById('settings-input-user-name');
      const nickInp = document.getElementById('settings-input-user-nick');
      if (nameInp && !nameInp.value) nameInp.value = state.user.name;
      if (nickInp && !nickInp.value) nickInp.value = state.user.nick;
    }

    if (tabInterface && !document.getElementById('desktop-overlay-hotkeys-card')) {
      const desktopCard = document.createElement('div');
      desktopCard.id = 'desktop-overlay-hotkeys-card';
      desktopCard.className = 'settings-group-card';
      desktopCard.innerHTML = `
        <div class="setting-row">
          <div class="setting-info">
            <strong>Ativar Overlay Dentro de Jogos</strong>
            <small>Exibe avatares discretos, quem está falando, status AO VIVO e estado de mute.</small>
          </div>
          <label class="apple-switch">
            <input type="checkbox" id="toggle-game-overlay" ${state.overlayEnabled ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Mostrar Overlay Apenas Durante Aplicações em Tela Cheia</strong>
            <small>Oculta o overlay no uso normal do Aether e exibe apenas quando estiver em jogo ou noutra janela.</small>
          </div>
          <label class="apple-switch">
            <input type="checkbox" id="toggle-overlay-fullscreen-only" ${state.overlayFullscreenOnly ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Mostrar Título da Sala no Overlay</strong>
            <small>Permite exibir ou ocultar o nome da sala atual no topo do overlay.</small>
          </div>
          <label class="apple-switch">
            <input type="checkbox" id="toggle-overlay-room-title" ${state.overlayShowRoomTitle ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Posição do Overlay & Arrastar Livremente</strong>
            <small>Escolha um canto ou destrave para arrastar o overlay livremente para qualquer lugar da tela.</small>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <select id="select-overlay-position" class="apple-select">
              <option value="top-left" ${state.overlayPosition === 'top-left' ? 'selected' : ''}>Superior Esquerdo</option>
              <option value="top-right" ${state.overlayPosition === 'top-right' ? 'selected' : ''}>Superior Direito</option>
              <option value="bottom-left" ${state.overlayPosition === 'bottom-left' ? 'selected' : ''}>Inferior Esquerdo</option>
              <option value="bottom-right" ${state.overlayPosition === 'bottom-right' ? 'selected' : ''}>Inferior Direito</option>
              <option value="custom" ${state.overlayPosition === 'custom' ? 'selected' : ''}>Posição Livre Personalizada</option>
            </select>
            <button type="button" id="btn-unlock-drag-overlay" class="btn-chip primary">
              ${state.overlayUnlocked ? '🔒 Fixar Posição' : '🔓 Destravar p/ Arrastar'}
            </button>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Tamanho dos Elementos do Overlay</strong>
            <small>Ajusta o tamanho dos avatares e indicadores no overlay.</small>
          </div>
          <select id="select-overlay-size" class="apple-select">
            <option value="small" ${state.overlaySize === 'small' ? 'selected' : ''}>Compacto (Pequeno)</option>
            <option value="medium" ${state.overlaySize === 'medium' ? 'selected' : ''}>Padrão (Médio)</option>
            <option value="large" ${state.overlaySize === 'large' ? 'selected' : ''}>Expandido (Grande)</option>
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Escala do Overlay (<span id="label-overlay-scale">${state.overlayScale}%</span>)</strong>
            <small>Controle proporcional de escala do overlay na tela.</small>
          </div>
          <input type="range" id="input-overlay-scale" min="70" max="150" step="5" value="${state.overlayScale}" style="width:160px;" />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Opacidade do Overlay (<span id="label-overlay-opacity">${state.overlayOpacity}%</span>)</strong>
            <small>Ajusta a transparência do overlay durante as partidas.</small>
          </div>
          <input type="range" id="input-overlay-opacity" min="25" max="100" step="5" value="${state.overlayOpacity}" style="width:160px;" />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Restaurar Configuração Padrão do Overlay</strong>
            <small>Redefine posição, tamanho, escala e opacidade para os valores originais.</small>
          </div>
          <button type="button" id="btn-reset-overlay-defaults" class="btn-chip">Restaurar Padrão</button>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-info">
            <strong>Notificações Nativas do Windows (Com Supressão em Ecrã Cheio)</strong>
            <small>Usa notificações nativas do Windows e silencia automaticamente durante jogos ou vídeos em ecrã cheio.</small>
          </div>
          <label class="apple-switch">
            <input type="checkbox" id="toggle-win-notifications" ${state.nativeNotificationsEnabled ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-info" style="margin-bottom:8px;">
          <strong>Hotkeys Globais (Funcionam Minimizado e Dentro de Jogos)</strong>
          <small>Clique em qualquer botão abaixo e pressione a combinação de teclas desejada.</small>
        </div>
        <div class="setting-row">
          <div class="setting-info"><strong>Alternar Microfone (Mute / Unmute)</strong></div>
          <button type="button" class="hotkey-recorder-btn mono" data-hk="toggleMic">${escapeHtml(state.globalHotkeys.toggleMic)}</button>
        </div>
        <div class="setting-row" style="margin-top:6px;">
          <div class="setting-info"><strong>Mutar Microfone</strong></div>
          <button type="button" class="hotkey-recorder-btn mono" data-hk="muteMic">${escapeHtml(state.globalHotkeys.muteMic)}</button>
        </div>
        <div class="setting-row" style="margin-top:6px;">
          <div class="setting-info"><strong>Desmutar Microfone</strong></div>
          <button type="button" class="hotkey-recorder-btn mono" data-hk="unmuteMic">${escapeHtml(state.globalHotkeys.unmuteMic)}</button>
        </div>
        <div class="setting-row" style="margin-top:6px;">
          <div class="setting-info"><strong>Push-To-Talk Global</strong></div>
          <button type="button" class="hotkey-recorder-btn mono" data-hk="pushToTalk">${escapeHtml(state.globalHotkeys.pushToTalk)}</button>
        </div>
        <div class="setting-row" style="margin-top:6px;">
          <div class="setting-info"><strong>Abrir / Ocultar Overlay em Jogo</strong></div>
          <button type="button" class="hotkey-recorder-btn mono" data-hk="toggleOverlay">${escapeHtml(state.globalHotkeys.toggleOverlay)}</button>
        </div>
        <div class="setting-row" style="margin-top:6px;">
          <div class="setting-info"><strong>Alternar Áudio da Sala (Deafen)</strong></div>
          <button type="button" class="hotkey-recorder-btn mono" data-hk="toggleDeafen">${escapeHtml(state.globalHotkeys.toggleDeafen)}</button>
        </div>
      `;
      tabInterface.appendChild(desktopCard);

      const overlayToggle = document.getElementById('toggle-game-overlay');
      const fullscreenOnlyToggle = document.getElementById('toggle-overlay-fullscreen-only');
      const roomTitleToggle = document.getElementById('toggle-overlay-room-title');
      const overlayPosSelect = document.getElementById('select-overlay-position');
      const btnUnlockDrag = document.getElementById('btn-unlock-drag-overlay');
      const overlaySizeSelect = document.getElementById('select-overlay-size');
      const overlayScaleInput = document.getElementById('input-overlay-scale');
      const overlayScaleLabel = document.getElementById('label-overlay-scale');
      const overlayOpacityInput = document.getElementById('input-overlay-opacity');
      const overlayOpacityLabel = document.getElementById('label-overlay-opacity');
      const btnResetOverlay = document.getElementById('btn-reset-overlay-defaults');
      const winNotifToggle = document.getElementById('toggle-win-notifications');

      overlayToggle?.addEventListener('change', () => {
        state.overlayEnabled = overlayToggle.checked;
        localStorage.setItem('aether_overlay_enabled', state.overlayEnabled ? 'on' : 'off');
        pushOverlayConfigToDesktop();
        syncDesktopOverlayState();
      });

      fullscreenOnlyToggle?.addEventListener('change', () => {
        state.overlayFullscreenOnly = fullscreenOnlyToggle.checked;
        localStorage.setItem('aether_overlay_fullscreen_only', state.overlayFullscreenOnly ? 'on' : 'off');
        pushOverlayConfigToDesktop();
      });

      roomTitleToggle?.addEventListener('change', () => {
        state.overlayShowRoomTitle = roomTitleToggle.checked;
        localStorage.setItem('aether_overlay_show_title', state.overlayShowRoomTitle ? 'on' : 'off');
        pushOverlayConfigToDesktop();
      });

      overlayPosSelect?.addEventListener('change', () => {
        state.overlayPosition = overlayPosSelect.value;
        localStorage.setItem('aether_overlay_pos', state.overlayPosition);
        pushOverlayConfigToDesktop();
      });

      btnUnlockDrag?.addEventListener('click', () => {
        state.overlayUnlocked = !state.overlayUnlocked;
        btnUnlockDrag.textContent = state.overlayUnlocked ? '🔒 Fixar Posição' : '🔓 Destravar p/ Arrastar';
        pushOverlayConfigToDesktop();
        syncDesktopOverlayState();
        if (state.overlayUnlocked) {
          showToast('Overlay Destravado', 'Arraste a caixa do overlay para qualquer área da tela e clique em Fixar.', '✥');
        } else {
          showToast('Posição Salva', 'O overlay foi fixado na nova posição.', '📌');
        }
      });

      overlaySizeSelect?.addEventListener('change', () => {
        state.overlaySize = overlaySizeSelect.value;
        localStorage.setItem('aether_overlay_size', state.overlaySize);
        pushOverlayConfigToDesktop();
      });

      overlayScaleInput?.addEventListener('input', () => {
        state.overlayScale = Number(overlayScaleInput.value);
        if (overlayScaleLabel) overlayScaleLabel.textContent = `${state.overlayScale}%`;
        localStorage.setItem('aether_overlay_scale', String(state.overlayScale));
        pushOverlayConfigToDesktop();
      });

      overlayOpacityInput?.addEventListener('input', () => {
        state.overlayOpacity = Number(overlayOpacityInput.value);
        if (overlayOpacityLabel) overlayOpacityLabel.textContent = `${state.overlayOpacity}%`;
        localStorage.setItem('aether_overlay_opacity', String(state.overlayOpacity));
        pushOverlayConfigToDesktop();
      });

      btnResetOverlay?.addEventListener('click', () => {
        state.overlayEnabled = true;
        state.overlayFullscreenOnly = true;
        state.overlayShowRoomTitle = true;
        state.overlaySize = 'medium';
        state.overlayScale = 100;
        state.overlayOpacity = 90;
        state.overlayPosition = 'top-left';
        state.overlayCustomX = null;
        state.overlayCustomY = null;
        state.overlayUnlocked = false;

        localStorage.setItem('aether_overlay_enabled', 'on');
        localStorage.setItem('aether_overlay_fullscreen_only', 'on');
        localStorage.setItem('aether_overlay_show_title', 'on');
        localStorage.setItem('aether_overlay_size', 'medium');
        localStorage.setItem('aether_overlay_scale', '100');
        localStorage.setItem('aether_overlay_opacity', '90');
        localStorage.setItem('aether_overlay_pos', 'top-left');
        localStorage.removeItem('aether_overlay_custom_xy');

        if (overlayToggle) overlayToggle.checked = true;
        if (fullscreenOnlyToggle) fullscreenOnlyToggle.checked = true;
        if (roomTitleToggle) roomTitleToggle.checked = true;
        if (overlayPosSelect) overlayPosSelect.value = 'top-left';
        if (btnUnlockDrag) btnUnlockDrag.textContent = '🔓 Destravar p/ Arrastar';
        if (overlaySizeSelect) overlaySizeSelect.value = 'medium';
        if (overlayScaleInput) overlayScaleInput.value = '100';
        if (overlayScaleLabel) overlayScaleLabel.textContent = '100%';
        if (overlayOpacityInput) overlayOpacityInput.value = '90';
        if (overlayOpacityLabel) overlayOpacityLabel.textContent = '90%';

        pushOverlayConfigToDesktop();
        syncDesktopOverlayState();
        showToast('Overlay Restaurado', 'As configurações padrão do overlay foram aplicadas.', '✨');
      });

      winNotifToggle?.addEventListener('change', () => {
        state.nativeNotificationsEnabled = winNotifToggle.checked;
        localStorage.setItem('aether_win_notif', state.nativeNotificationsEnabled ? 'on' : 'off');
      });

      desktopCard.querySelectorAll('.hotkey-recorder-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const hkKey = btn.dataset.hk;
          btn.classList.add('recording');
          btn.textContent = 'Pressione as teclas...';

          const onKeyDown = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (ev.key === 'Escape') {
              btn.classList.remove('recording');
              btn.textContent = state.globalHotkeys[hkKey];
              window.removeEventListener('keydown', onKeyDown, true);
              return;
            }
            const accel = formatAcceleratorFromKeyEvent(ev);
            if (!accel) return;

            state.globalHotkeys[hkKey] = accel;
            localStorage.setItem('aether_global_hotkeys', JSON.stringify(state.globalHotkeys));
            btn.classList.remove('recording');
            btn.textContent = accel;
            window.removeEventListener('keydown', onKeyDown, true);

            if (window.aetherDesktop?.updateHotkeys) {
              window.aetherDesktop.updateHotkeys(state.globalHotkeys);
            }
            showToast('Atalho Global Guardado', `Novo atalho definido: ${accel}`, '⌨️');
          };

          window.addEventListener('keydown', onKeyDown, true);
        });
      });
    }

    if (tabInterface && !document.getElementById('cloud-server-settings-card')) {
      const cloudCard = document.createElement('div');
      cloudCard.id = 'cloud-server-settings-card';
      cloudCard.className = 'settings-group-card';
      const isCloudActive = state.serverMode === 'cloud' && state.cloudServerUrl;

      cloudCard.innerHTML = `
        <div class="setting-row">
          <div class="setting-info">
            <strong>Servidor Cloud 24/7 (Funcionar com PC Desligado)</strong>
            <small>Escolha entre o servidor local ou um servidor na nuvem (Render, Railway, VPS) ativo 24h.</small>
          </div>
          <select id="select-server-mode" class="apple-select">
            <option value="auto" ${state.serverMode === 'auto' ? 'selected' : ''}>Automático / Servidor Atual</option>
            <option value="cloud" ${state.serverMode === 'cloud' ? 'selected' : ''}>Servidor Cloud 24/7 Dedicado</option>
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-info">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <strong>Endereço (URL) do Servidor Cloud 24/7</strong>
            <span class="cloud-status-badge" id="cloud-current-badge">
              ${isCloudActive ? '☁️ Cloud 24/7 Ativo' : '🖥️ Servidor Padrão Ativo'}
            </span>
          </div>
          <small>Cole a URL HTTPS do seu servidor hospedado na nuvem (ex: https://meu-aether.onrender.com).</small>
          <div class="cloud-server-input-row">
            <input type="text" id="input-cloud-server-url" placeholder="Ex: https://aether-cloud.onrender.com" value="${escapeHtml(state.cloudServerUrl)}" />
            <button type="button" id="btn-save-cloud-server" class="btn-chip primary">Salvar & Conectar</button>
            <button type="button" id="btn-reset-local-server" class="btn-chip">Usar Local</button>
          </div>
        </div>
      `;
      tabInterface.appendChild(cloudCard);

      const modeSelect = document.getElementById('select-server-mode');
      const urlInput = document.getElementById('input-cloud-server-url');
      const saveBtn = document.getElementById('btn-save-cloud-server');
      const resetBtn = document.getElementById('btn-reset-local-server');

      saveBtn?.addEventListener('click', () => {
        const cleanedUrl = (urlInput.value || '').trim().replace(/\/+$/, '');
        if (cleanedUrl && !/^https?:\/\//i.test(cleanedUrl)) {
          showToast('URL Inválida', 'O endereço deve começar com https:// ou http://', '⚠️');
          return;
        }
        const chosenMode = cleanedUrl ? 'cloud' : 'auto';
        localStorage.setItem('aether_server_mode', chosenMode);
        localStorage.setItem('aether_cloud_url', cleanedUrl);
        showToast('Servidor Cloud 24/7 Salvo', 'Reconectando ao servidor configurado...', '☁️');
        setTimeout(() => window.location.reload(), 600);
      });

      resetBtn?.addEventListener('click', () => {
        localStorage.setItem('aether_server_mode', 'auto');
        localStorage.setItem('aether_cloud_url', '');
        showToast('Servidor Padrão Restaurado', 'Reconectando ao servidor local/padrão...', '🖥️');
        setTimeout(() => window.location.reload(), 500);
      });

      modeSelect?.addEventListener('change', () => {
        state.serverMode = modeSelect.value;
        localStorage.setItem('aether_server_mode', state.serverMode);
      });
    }

    if (el.entryForm && !document.getElementById('entry-cloud-box')) {
      const entryCloud = document.createElement('div');
      entryCloud.id = 'entry-cloud-box';
      entryCloud.className = 'entry-cloud-accordion';
      entryCloud.innerHTML = `
        <button type="button" id="btn-toggle-entry-cloud" class="entry-cloud-toggle">
          <span>☁️ Servidor: <strong>${state.serverMode === 'cloud' && state.cloudServerUrl ? state.cloudServerUrl : 'Padrão / Local'}</strong> (Clique p/ alterar Cloud 24/7)</span>
        </button>
        <div id="entry-cloud-Config" class="hidden" style="margin-top:8px;">
          <div class="cloud-server-input-row">
            <input type="text" id="entry-cloud-url-input" placeholder="URL Cloud 24/7 (Ex: https://aether.onrender.com)" value="${escapeHtml(state.cloudServerUrl)}" />
            <button type="button" id="btn-apply-entry-cloud" class="btn-chip primary">Aplicar</button>
          </div>
        </div>
      `;
      el.entryForm.appendChild(entryCloud);

      document.getElementById('btn-toggle-entry-cloud')?.addEventListener('click', () => {
        document.getElementById('entry-cloud-Config')?.classList.toggle('hidden');
      });

      document.getElementById('btn-apply-entry-cloud')?.addEventListener('click', () => {
        const val = (document.getElementById('entry-cloud-url-input')?.value || '').trim().replace(/\/+$/, '');
        if (val) {
          localStorage.setItem('aether_server_mode', 'cloud');
          localStorage.setItem('aether_cloud_url', val);
        } else {
          localStorage.setItem('aether_server_mode', 'auto');
          localStorage.setItem('aether_cloud_url', '');
        }
        window.location.reload();
      });
    }
  }
  injectAdvancedSettingsAndCloudUI();

  if (isDesktopInstalledApp) {
    pushOverlayConfigToDesktop();
    window.aetherDesktop.updateHotkeys(state.globalHotkeys);

    window.aetherDesktop.onHotkeyCommand((cmd) => {
      if (!cmd || !cmd.action) return;
      if (cmd.action === 'toggle-mic') {
        el.btnToggleMic?.click();
      } else if (cmd.action === 'mute-mic') {
        if (!state.isMicMuted) el.btnToggleMic?.click();
      } else if (cmd.action === 'unmute-mic') {
        if (state.isMicMuted) el.btnToggleMic?.click();
      } else if (cmd.action === 'toggle-deafen') {
        el.btnToggleDeafen?.click();
      } else if (cmd.action === 'ptt-trigger') {
        state.pttPressed = true;
        updateLocalMicTrackEnabledState();
        if (state.globalPttHoldTimeout) clearTimeout(state.globalPttHoldTimeout);
        state.globalPttHoldTimeout = setTimeout(() => {
          state.pttPressed = false;
          updateLocalMicTrackEnabledState();
        }, 1200);
      }
    });

    window.aetherDesktop.onOverlayToggled((enabled) => {
      state.overlayEnabled = Boolean(enabled);
      localStorage.setItem('aether_overlay_enabled', state.overlayEnabled ? 'on' : 'off');
      const toggleEl = document.getElementById('toggle-game-overlay');
      if (toggleEl) toggleEl.checked = state.overlayEnabled;
      syncDesktopOverlayState();
    });

    window.aetherDesktop.onOverlayBoundsChanged?.((pos) => {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
      state.overlayPosition = 'custom';
      state.overlayCustomX = pos.x;
      state.overlayCustomY = pos.y;
      localStorage.setItem('aether_overlay_pos', 'custom');
      localStorage.setItem('aether_overlay_custom_xy', JSON.stringify({ x: pos.x, y: pos.y }));
      const posSelect = document.getElementById('select-overlay-position');
      if (posSelect) posSelect.value = 'custom';
    });

    window.aetherDesktop.onOverlayLockChanged?.((unlocked) => {
      state.overlayUnlocked = Boolean(unlocked);
      const btnUnlockDrag = document.getElementById('btn-unlock-drag-overlay');
      if (btnUnlockDrag) {
        btnUnlockDrag.textContent = state.overlayUnlocked ? '🔒 Fixar Posição' : '🔓 Destravar p/ Arrastar';
      }
      showToast('Posição Salva', 'O overlay foi fixado na posição escolhida.', '📌');
    });

    window.aetherDesktop.onFlushedNotifications((list) => {
      if (!Array.isArray(list) || list.length === 0) return;
      const last = list[list.length - 1];
      showToast(
        `${list.length} ${list.length === 1 ? 'notificação recebida' : 'notificações recebidas'} enquanto esteve fora`,
        `${last.title}: ${last.body}`,
        '🎮'
      );
    });
  }

  // ================= EFEITOS SONOROS DE ENTRADA E SAÍDA DA SALA =================
  function playRoomSoundEffect(type) {
    if (!state.roomSfxEnabled || state.isDeafened) return;
    try {
      if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          latencyHint: 'interactive'
        });
      }
      if (state.audioContext.state === 'suspended') {
        state.audioContext.resume().catch(() => {});
      }

      const ctx = state.audioContext;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';

      if (type === 'self-join') {
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.14);
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === 'self-leave') {
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.exponentialRampToValueAtTime(349.23, now + 0.16);
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === 'peer-join') {
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(783.99, now + 0.08);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.28);
      } else if (type === 'peer-leave') {
        osc.frequency.setValueAtTime(659.25, now);
        osc.frequency.setValueAtTime(440.0, now + 0.09);
        gain.gain.setValueAtTime(0.055, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.28);
      }
    } catch (e) {}
  }

  // ================= PAINEL DE CONTROLO DEDICADO DO TRANSMISSOR =================
  function ensureBroadcasterHudElement() {
    let hud = document.getElementById('broadcaster-control-panel');
    if (!hud && el.workspaceGrid) {
      hud = document.createElement('section');
      hud.id = 'broadcaster-control-panel';
      hud.className = 'broadcaster-hud surface-glass hidden';
      hud.innerHTML = `
        <div class="broadcaster-hud-left">
          <div class="broadcaster-live-pill">
            <span class="broadcaster-live-dot"></span>
            <span>🔴 AO VIVO</span>
          </div>
          <div class="broadcaster-status-stack">
            <strong>Transmissão ativa</strong>
            <div class="broadcaster-status-sub">
              <span>🖥️ Compartilhando tela</span>
              <span>•</span>
              <span id="broadcaster-audio-status">🔊 Compartilhando áudio</span>
            </div>
          </div>
        </div>
        <div class="broadcaster-hud-right">
          <div id="broadcaster-viewers-pill" class="broadcaster-metric-pill viewers-pill hidden" title="Pessoas assistindo sua transmissão agora">
            <span id="broadcaster-viewers-count">👁 1 espectador</span>
          </div>
          <div class="broadcaster-metric-pill mono" title="Tempo de transmissão ao vivo">
            <span>⏱</span>
            <span id="broadcaster-live-timer">00:00:00</span>
          </div>
          <div class="broadcaster-metric-pill mono" id="broadcaster-quality-spec" title="Resolução real capturada, FPS e Bitrate alvo">
            1080p • 60 FPS • Alta Qualidade
          </div>
          <button type="button" id="btn-hud-stop-stream" class="btn-chip danger" title="Encerrar sua transmissão">
            Encerrar Transmissão
          </button>
        </div>
      `;
      const canvasBody = el.workspaceGrid.querySelector('.canvas-body');
      if (canvasBody) {
        el.workspaceGrid.insertBefore(hud, canvasBody);
      } else {
        el.workspaceGrid.prepend(hud);
      }
      document.getElementById('btn-hud-stop-stream')?.addEventListener('click', () => {
        stopScreenSharing();
      });
    }
    return hud;
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  }

  function updateBroadcasterControlPanel() {
    const hud = ensureBroadcasterHudElement();
    if (!hud) return;

    syncStreamButtonsVisualState();

    if (!state.isStreaming || !state.localScreenStream) {
      hud.classList.add('hidden');
      syncDesktopOverlayState();
      return;
    }

    hud.classList.remove('hidden');

    const hasSysAudio = state.localScreenStream.getAudioTracks().length > 0;
    const audioStatusEl = document.getElementById('broadcaster-audio-status');
    if (audioStatusEl) {
      audioStatusEl.textContent = hasSysAudio ? '🔊 Compartilhando áudio' : '🔇 Somente tela (sem áudio)';
    }

    const viewersCount = state.myStreamViewers.size;
    const viewersPillEl = document.getElementById('broadcaster-viewers-pill');
    const viewersEl = document.getElementById('broadcaster-viewers-count');
    if (viewersPillEl && viewersEl) {
      if (viewersCount > 0) {
        viewersPillEl.classList.remove('hidden');
        viewersEl.textContent = `👁 ${viewersCount} ${viewersCount === 1 ? 'espectador' : 'espectadores'}`;
      } else {
        viewersPillEl.classList.add('hidden');
      }
    }

    const timerEl = document.getElementById('broadcaster-live-timer');
    if (timerEl && state.streamStartedAt) {
      timerEl.textContent = formatDuration(Date.now() - state.streamStartedAt);
    }

    const specEl = document.getElementById('broadcaster-quality-spec');
    if (specEl) {
      const vidTrack = state.localScreenStream.getVideoTracks()[0];
      const trackSettings = vidTrack?.getSettings ? vidTrack.getSettings() : {};
      const actualHeight = trackSettings.height || state.streamSettings.resolution;
      const resLabel = state.streamSettings.resolution === 1440
        ? `1440p (2K • ${actualHeight}p • 32 Mbps)`
        : `${state.streamSettings.resolution}p`;
      const qualityLabel = state.streamSettings.contentHint === 'detail' ? 'Nitidez Máxima' : 'Fluidez Ultra';
      specEl.textContent = `${resLabel} • ${state.streamSettings.fps} FPS • ${qualityLabel}`;
    }

    syncDesktopOverlayState();
  }

  const resumeAllAudio = () => {
    if (state.audioContext && state.audioContext.state === 'suspended') {
      state.audioContext.resume().catch(() => {});
    }
    document.querySelectorAll('#remote-voice-audios audio').forEach((a) => {
      if (a.paused && a.srcObject) a.play().catch(() => {});
    });
  };
  window.addEventListener('click', resumeAllAudio);
  window.addEventListener('keydown', resumeAllAudio);

  // ================= 0. TEMAS E CONFIGURAÇÕES =================
  function applyInterfacePreferences() {
    document.documentElement.setAttribute('data-theme', state.theme);
    document.documentElement.setAttribute('data-scale', state.uiScale);
    document.documentElement.setAttribute('data-motion', state.animationsEnabled ? 'full' : 'reduced');

    document.querySelectorAll('.theme-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeVal === state.theme);
    });
    if (el.selectUiScale) el.selectUiScale.value = state.uiScale;
    if (el.toggleUiAnimations) el.toggleUiAnimations.checked = state.animationsEnabled;
  }
  applyInterfacePreferences();

  function setTheme(newTheme) {
    state.theme = newTheme;
    localStorage.setItem('aether_theme', newTheme);
    applyInterfacePreferences();
  }

  el.btnQuickTheme?.addEventListener('click', () => {
    setTheme(state.theme === 'comfortable' ? 'deep' : 'comfortable');
  });

  document.querySelectorAll('.theme-pill').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeVal));
  });

  el.selectUiScale?.addEventListener('change', () => {
    state.uiScale = el.selectUiScale.value;
    localStorage.setItem('aether_scale', state.uiScale);
    applyInterfacePreferences();
  });

  el.toggleUiAnimations?.addEventListener('change', () => {
    state.animationsEnabled = el.toggleUiAnimations.checked;
    localStorage.setItem('aether_motion', state.animationsEnabled ? 'full' : 'reduced');
    applyInterfacePreferences();
  });

  const openSettingsModal = async () => {
    injectAdvancedSettingsAndCloudUI();
    await refreshAudioDevicesList();
    el.modalSettings?.classList.remove('hidden');
  };
  el.btnOpenSettings?.addEventListener('click', openSettingsModal);
  el.btnCapsuleSettings?.addEventListener('click', openSettingsModal);
  el.btnCloseSettings?.addEventListener('click', () => el.modalSettings.classList.add('hidden'));
  el.modalSettings?.addEventListener('click', (e) => {
    if (e.target === el.modalSettings) el.modalSettings.classList.add('hidden');
  });

  const tabTitles = {
    'tab-audio': 'Áudio & Processamento Vocal',
    'tab-stream': 'Qualidade de Transmissão',
    'tab-interface': 'Perfil, Overlay & Hotkeys'
  };

  document.querySelectorAll('.settings-nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
      document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.add('hidden'));
      item.classList.add('active');
      const targetId = item.dataset.tab;
      document.getElementById(targetId)?.classList.remove('hidden');
      if (el.settingsPanelTitle) el.settingsPanelTitle.textContent = tabTitles[targetId] || 'Configurações';
    });
  });

  async function refreshAudioDevicesList() {
    if (!navigator.mediaDevices?.enumerateDevices || !el.selectAudioInput) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      el.selectAudioInput.innerHTML = '';
      inputs.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microfone ${idx + 1}`;
        if (d.deviceId === state.selectedAudioInputId) opt.selected = true;
        el.selectAudioInput.appendChild(opt);
      });

      el.selectAudioOutput.innerHTML = '';
      if (outputs.length === 0) {
        const opt = document.createElement('option');
        opt.value = 'default';
        opt.textContent = 'Saída Padrão do Sistema';
        el.selectAudioOutput.appendChild(opt);
      } else {
        outputs.forEach((d, idx) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Saída de Áudio ${idx + 1}`;
          if (d.deviceId === state.selectedAudioOutputId) opt.selected = true;
          el.selectAudioOutput.appendChild(opt);
        });
      }
    } catch (e) {}
  }

  async function syncReplacedMicTrackAcrossPeers() {
    const newVoiceTrack = state.localVoiceStream?.getAudioTracks()[0];
    if (!newVoiceTrack) return;

    socket.emit('user:state-change', {
      voiceStreamId: state.localVoiceStream?.id || null
    });

    for (const [peerId, peerObj] of state.peers.entries()) {
      peerObj.suppressAutoNegotiation = true;
      const needsNegotiation = ensureLocalAudioSenderOnPeer(peerObj);
      peerObj.suppressAutoNegotiation = false;
      sendStreamIdsMeta(peerId);
      if (needsNegotiation) {
        negotiateWithPeer(peerId, peerObj);
      }
    }
  }

  el.selectAudioInput?.addEventListener('change', async () => {
    state.selectedAudioInputId = el.selectAudioInput.value;
    await initLocalVoiceEngine();
    await syncReplacedMicTrackAcrossPeers();
  });

  el.selectAudioOutput?.addEventListener('change', async () => {
    state.selectedAudioOutputId = el.selectAudioOutput.value;
    document.querySelectorAll('video, audio').forEach((mediaEl) => {
      if (typeof mediaEl.setSinkId === 'function') {
        mediaEl.setSinkId(state.selectedAudioOutputId).catch(() => {});
      }
    });
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await refreshAudioDevicesList();
      const currentMicTrack = state.localVoiceStream?.getAudioTracks()[0];
      if (!currentMicTrack || currentMicTrack.readyState === 'ended') {
        await recoverMicrophoneAutomatically();
      }
    });
  }

  el.toggleNoiseGate?.addEventListener('change', () => {
    state.voiceGateEnabled = el.toggleNoiseGate.checked;
    updateLocalMicTrackEnabledState();
  });

  el.toggleNoiseSuppression?.addEventListener('change', async () => {
    state.noiseSuppressionEnabled = el.toggleNoiseSuppression.checked;
    applyLocalMicNoiseFilterProfile(state.localNoiseLevel);
  });

  el.settingsStreamRes?.addEventListener('change', () => {
    state.streamSettings.resolution = Number(el.settingsStreamRes.value);
    syncStreamModalButtons();
    if (state.isStreaming) enforceHighQualityForAllViewers();
    updateBroadcasterControlPanel();
  });

  el.settingsStreamFps?.addEventListener('change', () => {
    state.streamSettings.fps = Number(el.settingsStreamFps.value);
    syncStreamModalButtons();
    if (state.isStreaming) enforceHighQualityForAllViewers();
    updateBroadcasterControlPanel();
  });

  el.settingsStreamBitrate?.addEventListener('change', () => {
    state.streamSettings.bitrateMode = el.settingsStreamBitrate.value;
    if (state.isStreaming) enforceHighQualityForAllViewers();
    updateBroadcasterControlPanel();
  });

  function syncStreamModalButtons() {
    document.querySelectorAll('#resolution-options .seg-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.res) === state.streamSettings.resolution);
    });
    document.querySelectorAll('#fps-options .seg-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.fps) === state.streamSettings.fps);
    });
  }

  // ================= 1. LOGIN AUTOMÁTICO SEM CONDIÇÃO DE CORRIDA =================
  function validateEntryInputs() {
    const nameValid = el.inputName.value.trim().length >= 2;
    const cleanedNick = el.inputNick.value.replace(/[^a-zA-Z0-9_\s]/g, '');
    if (el.inputNick.value !== cleanedNick) el.inputNick.value = cleanedNick;
    const nickValid = cleanedNick.trim().length >= 2;
    el.btnEnterApp.disabled = !(nameValid && nickValid);
  }

  el.inputName.addEventListener('input', validateEntryInputs);
  el.inputNick.addEventListener('input', validateEntryInputs);

  async function performUserLogin(name, nick, existingColor = null) {
    if (state.isLoggingIn) return;
    state.isLoggingIn = true;

    const palette = ['#5E81F4', '#7C69EF', '#EC4899', '#10B981', '#3B82F6', '#F59E0B'];
    const avatarColor = existingColor || palette[Math.floor(Math.random() * palette.length)];
    const normalizedNick = nick.trim().replace(/\s+/g, '_').toLowerCase();
    const cleanedName = name.trim();

    localStorage.setItem('aether_user_profile', JSON.stringify({
      name: cleanedName,
      nick: normalizedNick,
      avatarColor
    }));

    await initLocalVoiceEngine();

    socket.emit('user:register', {
      name: cleanedName,
      nick: normalizedNick,
      avatarColor
    }, (res) => {
      state.isLoggingIn = false;
      if (!res?.ok) return;
      state.user = res.user;
      state.rooms = res.rooms;

      el.selfAvatar.textContent = state.user.name.charAt(0).toUpperCase();
      el.selfAvatar.style.background = state.user.avatarColor;
      el.selfName.textContent = state.user.name;
      el.selfNick.textContent = '@' + state.user.nick;

      const nameInp = document.getElementById('settings-input-user-name');
      const nickInp = document.getElementById('settings-input-user-nick');
      if (nameInp) nameInp.value = state.user.name;
      if (nickInp) nickInp.value = state.user.nick;

      el.entryScreen.classList.add('hidden');
      el.appShell.classList.remove('hidden');

      ensureBroadcasterHudElement();
      syncStreamButtonsVisualState();

      socket.emit('user:state-change', {
        voiceStreamId: state.localVoiceStream?.id || null,
        screenStreamId: null
      });

      renderRoomsList();
      joinRoom(state.currentRoomId || 'lobby-principal');
    });
  }

  el.entryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (el.btnEnterApp.disabled) return;
    await performUserLogin(el.inputName.value, el.inputNick.value);
  });

  try {
    const savedProfileRaw = localStorage.getItem('aether_user_profile');
    if (savedProfileRaw) {
      const savedProfile = JSON.parse(savedProfileRaw);
      if (savedProfile?.name && savedProfile?.nick && savedProfile.name.trim().length >= 2 && savedProfile.nick.trim().length >= 2) {
        el.inputName.value = savedProfile.name;
        el.inputNick.value = savedProfile.nick;
        validateEntryInputs();
        performUserLogin(savedProfile.name, savedProfile.nick, savedProfile.avatarColor);
      }
    }
  } catch (e) {}

  // ================= 2. MOTOR DE VOZ COM AUTO-RECUPERAÇÃO E TAXA DE AMOSTRAGEM NATIVA =================
  function getNoiseFilterFrequencies(level) {
    switch (level) {
      case 'low':
        return { hpFreq: 90, lpFreq: 11500, threshold: 10 };
      case 'medium':
        return { hpFreq: 145, lpFreq: 7200, threshold: 13 };
      case 'high':
        return { hpFreq: 185, lpFreq: 5400, threshold: 16 };
      case 'auto':
      default:
        return { hpFreq: 130, lpFreq: 8000, threshold: 11 };
    }
  }

  function applyLocalMicNoiseFilterProfile(level) {
    const micTrack = state.localVoiceStream?.getAudioTracks()[0];
    if (micTrack) {
      try {
        micTrack.applyConstraints({
          noiseSuppression: level !== 'low' ? true : state.noiseSuppressionEnabled,
          echoCancellation: true,
          autoGainControl: true
        }).catch(() => {});
      } catch (e) {}
    }

    if (state.localMicFilterNodes && state.audioContext) {
      const { hpFreq, lpFreq } = getNoiseFilterFrequencies(level);
      const now = state.audioContext.currentTime;
      state.localMicFilterNodes.hp.frequency.setTargetAtTime(hpFreq, now, 0.04);
      state.localMicFilterNodes.lp.frequency.setTargetAtTime(lpFreq, now, 0.04);
    }
  }

  function updateLocalMicTrackEnabledState() {
    const micTrack = state.localVoiceStream?.getAudioTracks()[0];
    if (!micTrack) return;

    if (state.isMicMuted) {
      micTrack.enabled = false;
    } else if (state.voiceMode === 'ptt') {
      micTrack.enabled = Boolean(state.pttPressed);
    } else {
      micTrack.enabled = true;
    }
  }

  async function recoverMicrophoneAutomatically() {
    if (state.isReinitializingMic) return;
    state.isReinitializingMic = true;
    try {
      state.selectedAudioInputId = 'default';
      await initLocalVoiceEngine();
      await syncReplacedMicTrackAcrossPeers();
    } catch (e) {
    } finally {
      state.isReinitializingMic = false;
    }
  }

  async function initLocalVoiceEngine() {
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive'
      });
    }
    if (state.audioContext.state === 'suspended') {
      state.audioContext.resume().catch(() => {});
    }

    try {
      if (state.localMicRawStream) {
        state.localMicRawStream.getTracks().forEach((t) => {
          t.onended = null;
          t.stop();
        });
      }

      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: state.noiseSuppressionEnabled,
        autoGainControl: true,
        channelCount: 1
      };
      if (state.selectedAudioInputId && state.selectedAudioInputId !== 'default') {
        audioConstraints.deviceId = { exact: state.selectedAudioInputId };
      }

      let rawMicStream;
      try {
        rawMicStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false
        });
      } catch (_deviceErr) {
        state.selectedAudioInputId = 'default';
        rawMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
      }

      const micTrack = rawMicStream.getAudioTracks()[0];
      if (micTrack) {
        micTrack.onended = () => {
          recoverMicrophoneAutomatically();
        };
      }

      state.localMicRawStream = rawMicStream;
      state.localVoiceStream = rawMicStream;

      applyLocalMicNoiseFilterProfile(state.localNoiseLevel);
      updateLocalMicTrackEnabledState();

      const ctx = state.audioContext;
      const source = ctx.createMediaStreamSource(rawMicStream);
      const { hpFreq, lpFreq } = getNoiseFilterFrequencies(state.localNoiseLevel);

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = hpFreq;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lpFreq;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;

      source.connect(hp);
      hp.connect(lp);
      lp.connect(analyser);

      state.localMicFilterNodes = { source, hp, lp, analyser };
      startVoiceMeterLoop(analyser);
    } catch (err) {
      console.warn('Microfone indisponível, iniciando em modo somente escuta:', err);
      const silentDest = state.audioContext.createMediaStreamDestination();
      state.localVoiceStream = silentDest.stream;
    }
  }

  function startVoiceMeterLoop(analyser) {
    if (state.localMicMeterTimer) {
      clearInterval(state.localMicMeterTimer);
    }
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    let lastSpokeTimestamp = 0;

    state.localMicMeterTimer = setInterval(() => {
      updateLocalMicTrackEnabledState();

      if (state.audioContext && state.audioContext.state === 'suspended') {
        state.audioContext.resume().catch(() => {});
      }

      analyser.getByteFrequencyData(freqData);
      let sum = 0;
      for (let i = 2; i < 48; i++) {
        sum += freqData[i];
      }
      const avg = sum / 46;

      const profile = getNoiseFilterFrequencies(state.localNoiseLevel);
      const nowMs = performance.now();

      const rawTalking = !state.isMicMuted && (
        state.voiceMode === 'ptt' ? state.pttPressed : avg > profile.threshold
      );

      if (rawTalking) {
        lastSpokeTimestamp = nowMs;
      }

      const isTalkingNow = rawTalking || (!state.isMicMuted && state.voiceMode !== 'ptt' && (nowMs - lastSpokeTimestamp) < 200);

      const prevSpeaking = state.isSelfSpeaking;
      state.isSelfSpeaking = isTalkingNow;
      const selfCard = document.getElementById(`participant-card-${socket.id}`);
      if (selfCard) selfCard.classList.toggle('speaking', isTalkingNow);

      if (prevSpeaking !== isTalkingNow) {
        syncDesktopOverlayState();
      }

      const pct = isTalkingNow ? Math.min(100, Math.round((avg / 75) * 100)) : 0;
      if (el.localMicLevel) el.localMicLevel.style.width = `${pct}%`;
      if (el.vadGateStateText) {
        el.vadGateStateText.textContent = state.isMicMuted
          ? 'Microfone Silenciado'
          : isTalkingNow
            ? 'Voz Ativa'
            : 'Pronto';
      }
    }, 50);
  }

  el.inputGateThreshold?.addEventListener('input', () => {
    state.voiceGateThreshold = Number(el.inputGateThreshold.value);
    if (el.gateThresholdLabel) el.gateThresholdLabel.textContent = `${state.voiceGateThreshold} dB`;
  });

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (e.key.toLowerCase() === 'v' && state.voiceMode === 'ptt') {
      state.pttPressed = true;
      updateLocalMicTrackEnabledState();
    }
    if (e.key === 'Escape') {
      if (!el.imageLightbox.classList.contains('hidden')) closeImageLightbox();
      if (el.modalSettings && !el.modalSettings.classList.contains('hidden')) el.modalSettings.classList.add('hidden');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'v') {
      state.pttPressed = false;
      updateLocalMicTrackEnabledState();
    }
  });

  el.selectVoiceMode?.addEventListener('change', () => {
    state.voiceMode = el.selectVoiceMode.value;
    updateLocalMicTrackEnabledState();
  });

  // ================= 3. ESPAÇOS / SALAS =================
  function renderRoomsList() {
    el.roomsList.innerHTML = '';
    state.rooms.forEach((room) => {
      const div = document.createElement('div');
      div.className = `room-item ${room.id === state.currentRoomId ? 'active' : ''}`;
      div.innerHTML = `
        <div class="room-item-left">
          <span>${room.isPrivate ? '🔒' : '🔊'}</span>
          <span>${escapeHtml(room.name)}</span>
        </div>
        <span class="room-count-pill">${room.userCount}</span>
      `;
      div.addEventListener('click', () => {
        if (room.id === state.currentRoomId) return;
        let pwd = '';
        if (room.isPrivate) {
          pwd = prompt(`Palavra-passe para o espaço "${room.name}":`) || '';
        }
        joinRoom(room.id, pwd);
      });
      el.roomsList.appendChild(div);
    });
  }

  function joinRoom(roomId, password = '') {
    const hadPreviousRoom = Boolean(state.currentRoomId && state.currentRoomId !== roomId);
    if (hadPreviousRoom) {
      playRoomSoundEffect('self-leave');
    }
    if (state.isStreaming) stopScreenSharing();
    state.roomSessionToken += 1;
    const currentSession = state.roomSessionToken;
    cleanupAllPeers();

    socket.emit('room:join', { roomId, password }, async (res) => {
      if (currentSession !== state.roomSessionToken) return;
      if (!res?.ok) {
        showToast('Acesso Negado', res?.error || 'Não foi possível entrar no espaço.', '⚠️');
        return;
      }

      const currentMicTrack = state.localVoiceStream?.getAudioTracks()[0];
      if (!currentMicTrack || currentMicTrack.readyState === 'ended') {
        await initLocalVoiceEngine();
      }

      state.currentRoomId = res.room.id;
      state.roomUsers = res.room.users || [];
      el.currentRoomTitle.textContent = res.room.name;
      el.currentRoomIcon.textContent = res.room.isPrivate ? '🔒' : '🔊';

      if (!hadPreviousRoom) {
        playRoomSoundEffect('self-join');
      } else {
        setTimeout(() => playRoomSoundEffect('self-join'), 160);
      }

      el.chatMessages.innerHTML = '';
      res.room.messages.forEach(msg => appendChatMessage(msg, false));

      res.room.users.forEach((u) => {
        if (u.socketId !== socket.id) {
          createPeerConnection(u.socketId, u, true);
        }
      });

      renderRoomsList();
      renderParticipantsList(res.room.users);
      updateStageLayout();
      syncStreamButtonsVisualState();
      syncDesktopOverlayState();
    });
  }

  el.btnOpenCreateRoom?.addEventListener('click', () => el.modalCreateRoom.classList.remove('hidden'));
  el.btnCloseRoomModal?.addEventListener('click', () => el.modalCreateRoom.classList.add('hidden'));
  el.btnCancelRoomModal?.addEventListener('click', () => el.modalCreateRoom.classList.add('hidden'));
  el.newRoomPrivate?.addEventListener('change', () => {
    el.passwordFieldGroup.classList.toggle('hidden', !el.newRoomPrivate.checked);
  });

  el.formCreateRoom?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.newRoomName.value.trim();
    const isPrivate = el.newRoomPrivate.checked;
    const password = el.newRoomPassword.value;

    socket.emit('room:create', { name, isPrivate, password }, (res) => {
      if (res?.ok) {
        el.modalCreateRoom.classList.add('hidden');
        el.formCreateRoom.reset();
        el.passwordFieldGroup.classList.add('hidden');
        joinRoom(res.roomId, password);
      }
    });
  });

  // ================= 4. WEBRTC ENGINE (MALHA DE VOZ DETERMINÍSTICA + 1440P 2K 32 MBPS) =================
  function getTargetBitrateKbps() {
    if (state.streamSettings.bitrateMode !== 'auto') {
      const manualVal = Number(state.streamSettings.bitrateMode);
      return state.streamSettings.resolution === 1440 ? Math.max(25000, manualVal) : manualVal;
    }
    return state.streamSettings.resolution === 1440
      ? 32000
      : state.streamSettings.resolution === 1080
        ? 12000
        : 6500;
  }

  function enhanceSdpForHighQualityStream(sdp) {
    if (!sdp) return sdp;
    const targetMax = getTargetBitrateKbps();
    const targetBps = targetMax * 1000;
    const is2K = state.streamSettings.resolution === 1440;
    const startBitrate = is2K ? Math.min(24000, targetMax) : Math.min(10000, targetMax);
    const minBitrate = is2K ? Math.min(16000, targetMax) : Math.min(4500, Math.round(targetMax * 0.5));

    const sections = sdp.split('\r\nm=');
    for (let i = 1; i < sections.length; i++) {
      if (sections[i].startsWith('video')) {
        if (!/b=AS:\d+/.test(sections[i])) {
          sections[i] = sections[i].replace(
            /(c=IN IP[46] [^\r\n]+\r\n)/,
            `$1b=AS:${targetMax}\r\nb=TIAS:${targetBps}\r\n`
          );
        }
        sections[i] = sections[i].replace(
          /(a=fmtp:\d+ (?!.*apt=)(?!.*x-google-max-bitrate)[^\r\n]+)/g,
          `$1;x-google-max-bitrate=${targetMax};x-google-min-bitrate=${minBitrate};x-google-start-bitrate=${startBitrate}`
        );
      }
    }
    return sections.join('\r\nm=');
  }

  function buildLocalStreamMeta() {
    const voiceTrack = state.localVoiceStream?.getAudioTracks()[0] || null;
    const screenVideoTrack = state.localScreenStream?.getVideoTracks()[0] || null;
    const screenAudioTrack = state.localScreenStream?.getAudioTracks()[0] || null;
    return {
      voiceStreamId: state.localVoiceStream?.id || null,
      voiceTrackId: voiceTrack?.id || null,
      screenStreamId: state.localScreenStream?.id || null,
      screenVideoTrackId: screenVideoTrack?.id || null,
      screenAudioTrackId: screenAudioTrack?.id || null,
      isStreaming: state.isStreaming,
      streamConfig: state.streamSettings
    };
  }

  function ensureLocalAudioSenderOnPeer(peerObj) {
    if (!peerObj || !peerObj.pc || !state.localVoiceStream) return false;
    const voiceTrack = state.localVoiceStream.getAudioTracks()[0];
    if (!voiceTrack || voiceTrack.readyState === 'ended') return false;

    updateLocalMicTrackEnabledState();

    const pc = peerObj.pc;
    const screenAudioTrack = state.localScreenStream?.getAudioTracks()[0] || null;

    const existingVoiceSender = pc.getSenders().find(
      s => s.track && s.track.kind === 'audio' && s.track !== screenAudioTrack
    );

    if (existingVoiceSender) {
      if (existingVoiceSender.track !== voiceTrack) {
        existingVoiceSender.replaceTrack(voiceTrack).catch(() => {});
      }
      if (typeof pc.getTransceivers === 'function') {
        pc.getTransceivers().forEach((t) => {
          if (t.sender === existingVoiceSender && (t.direction === 'recvonly' || t.direction === 'inactive')) {
            try { t.direction = 'sendrecv'; } catch (e) {}
          }
        });
      }
      return false;
    }

    if (typeof pc.getTransceivers === 'function') {
      const freeAudioTransceiver = pc.getTransceivers().find(
        t => (t.receiver?.track?.kind === 'audio') && (!t.sender?.track)
      );
      if (freeAudioTransceiver) {
        try {
          freeAudioTransceiver.sender.replaceTrack(voiceTrack).catch(() => {});
          freeAudioTransceiver.direction = 'sendrecv';
          return true;
        } catch (e) {}
      }
    }

    try {
      pc.addTrack(voiceTrack, state.localVoiceStream);
      return true;
    } catch (e) {
      return false;
    }
  }

  function reconcilePeerMediaTracks(peerId, peerObj) {
    if (!peerObj || !peerObj.pc) return;
    const receivers = peerObj.pc.getReceivers();

    receivers.forEach((r) => {
      const track = r.track;
      if (!track || track.readyState === 'ended') return;

      if (track.kind === 'audio') {
        const isScreenAud = Boolean(
          peerObj.screenAudioTrackId && track.id === peerObj.screenAudioTrackId
        );
        if (isScreenAud) {
          if (peerObj.attachedVoiceTrackId === track.id) {
            detachVoicePipeline(peerObj);
          }
          if (peerObj.screenStream && !peerObj.screenStream.getTracks().includes(track)) {
            peerObj.screenStream.addTrack(track);
            const tile = document.getElementById(`stream-tile-${peerId}`);
            const videoEl = tile?.querySelector('video.stream-webrtc-video');
            if (videoEl) {
              videoEl.srcObject = null;
              videoEl.srcObject = peerObj.screenStream;
              safePlayVideo(videoEl, false, peerId);
            }
          }
        } else if (peerObj.attachedVoiceTrackId !== track.id || !peerObj.voiceAudioEl) {
          if (!peerObj.voiceTrackId || peerObj.voiceTrackId === track.id || !peerObj.voiceAudioEl) {
            peerObj.voiceTrackId = track.id;
            peerObj.attachedVoiceTrackId = track.id;
            setupRemoteVoicePipeline(peerId, new MediaStream([track]));
          }
        }
      } else if (track.kind === 'video' && peerObj.user?.isStreaming) {
        if (!peerObj.screenStream) {
          peerObj.screenStream = new MediaStream([track]);
        } else if (!peerObj.screenStream.getTracks().includes(track)) {
          peerObj.screenStream.addTrack(track);
        }
        if (!state.stoppedWatchingPeers.has(peerId) && !document.getElementById(`stream-tile-${peerId}`)) {
          renderOrUpdateStreamTile(peerId, peerObj.user, peerObj.screenStream, false, true);
        }
      }
    });
  }

  function applyRemoteStreamMeta(peerId, peerObj, meta) {
    if (!meta || !peerObj) return;
    if (meta.voiceStreamId) peerObj.voiceStreamId = meta.voiceStreamId;
    if (meta.voiceTrackId) peerObj.voiceTrackId = meta.voiceTrackId;
    if (meta.screenStreamId !== undefined) peerObj.screenStreamId = meta.screenStreamId;
    if (meta.screenVideoTrackId !== undefined) peerObj.screenVideoTrackId = meta.screenVideoTrackId;
    if (meta.screenAudioTrackId !== undefined) peerObj.screenAudioTrackId = meta.screenAudioTrackId;
    if (typeof meta.isStreaming === 'boolean') peerObj.user.isStreaming = meta.isStreaming;
    if (meta.streamConfig) peerObj.user.streamConfig = meta.streamConfig;

    if (meta.isStreaming === false) {
      peerObj.screenStream = null;
      peerObj.screenAudioTrackId = null;
      peerObj.screenVideoTrackId = null;
      removeStreamTile(peerId);
    } else if (meta.isStreaming === true && peerObj.screenStream && peerObj.screenStream.getVideoTracks().length > 0) {
      if (!state.stoppedWatchingPeers.has(peerId)) {
        renderOrUpdateStreamTile(peerId, peerObj.user, peerObj.screenStream, false, false);
      }
    }

    reconcilePeerMediaTracks(peerId, peerObj);
  }

  function sendStreamIdsMeta(peerId) {
    socket.emit('webrtc:signal', {
      to: peerId,
      data: {
        streamMeta: buildLocalStreamMeta()
      }
    });
  }

  async function flushPendingCandidates(peerObj) {
    const pc = peerObj.pc;
    if (!pc.remoteDescription || !pc.remoteDescription.type) return;
    while (peerObj.pendingCandidates.length > 0) {
      const candidate = peerObj.pendingCandidates.shift();
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {}
    }
  }

  async function negotiateWithPeer(peerId, peerObj, iceRestart = false) {
    const pc = peerObj.pc;
    if (peerObj.makingOffer) {
      peerObj.needsAnotherNegotiation = true;
      return;
    }
    if (pc.signalingState !== 'stable') {
      peerObj.needsAnotherNegotiation = true;
      return;
    }

    try {
      peerObj.makingOffer = true;
      peerObj.needsAnotherNegotiation = false;

      peerObj.suppressAutoNegotiation = true;
      ensureLocalAudioSenderOnPeer(peerObj);
      peerObj.suppressAutoNegotiation = false;

      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (pc.signalingState !== 'stable') return;

      try {
        await pc.setLocalDescription({
          type: offer.type,
          sdp: enhanceSdpForHighQualityStream(offer.sdp)
        });
      } catch (_sdpErr) {
        await pc.setLocalDescription(offer);
      }

      socket.emit('webrtc:signal', {
        to: peerId,
        data: {
          description: pc.localDescription,
          streamMeta: buildLocalStreamMeta()
        }
      });
    } catch (err) {
      console.error('Erro ao negociar oferta WebRTC:', err);
    } finally {
      peerObj.makingOffer = false;
      if (peerObj.needsAnotherNegotiation && pc.signalingState === 'stable') {
        peerObj.needsAnotherNegotiation = false;
        setTimeout(() => negotiateWithPeer(peerId, peerObj), 80);
      }
    }
  }

  function createPeerConnection(peerId, peerUser, isInitiator = false) {
    if (state.peers.has(peerId)) return state.peers.get(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peerObj = {
      pc,
      user: peerUser || {},
      voiceStreamId: peerUser?.voiceStreamId || null,
      voiceTrackId: null,
      screenStreamId: peerUser?.screenStreamId || null,
      screenVideoTrackId: null,
      screenAudioTrackId: null,
      attachedVoiceTrackId: null,
      pendingCandidates: [],
      signalingChain: Promise.resolve(),
      voiceSourceNode: null,
      voiceHighPassNode: null,
      voiceLowPassNode: null,
      voiceAudioEl: null,
      remoteAnalyser: null,
      screenStream: null,
      webrtcVideoConfirmed: false,
      makingOffer: false,
      needsAnotherNegotiation: false,
      ignoreOffer: false,
      suppressAutoNegotiation: true
    };
    state.peers.set(peerId, peerObj);

    sendStreamIdsMeta(peerId);

    ensureLocalAudioSenderOnPeer(peerObj);

    if (state.localScreenStream) {
      state.localScreenStream.getTracks().forEach((track) => {
        const alreadySent = pc.getSenders().some(s => s.track === track);
        if (!alreadySent) pc.addTrack(track, state.localScreenStream);
      });
    }

    peerObj.suppressAutoNegotiation = false;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit('webrtc:signal', { to: peerId, data: { candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (peerObj.voiceAudioEl && peerObj.voiceAudioEl.paused) {
          peerObj.voiceAudioEl.play().catch(() => {});
        }
        reconcilePeerMediaTracks(peerId, peerObj);
        if (state.isStreaming) {
          setTimeout(() => enforceHighQualityForAllViewers(), 200);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        const polite = socket.id < peerId;
        if (!polite && pc.signalingState === 'stable') {
          negotiateWithPeer(peerId, peerObj, true);
        }
      }
    };

    pc.onnegotiationneeded = () => {
      if (peerObj.suppressAutoNegotiation) return;
      negotiateWithPeer(peerId, peerObj);
    };

    pc.ontrack = (event) => {
      const incomingTrack = event.track;
      const incomingStream = event.streams[0];

      // 1. Trilha de VÍDEO da Transmissão
      if (incomingTrack.kind === 'video') {
        peerObj.user.isStreaming = true;
        peerObj.screenVideoTrackId = incomingTrack.id;

        if (!peerObj.screenStream) {
          peerObj.screenStream = new MediaStream();
        }
        peerObj.screenStream.getVideoTracks().forEach((oldVid) => {
          if (oldVid.id !== incomingTrack.id) peerObj.screenStream.removeTrack(oldVid);
        });
        if (!peerObj.screenStream.getTracks().includes(incomingTrack)) {
          peerObj.screenStream.addTrack(incomingTrack);
        }

        if (incomingStream) {
          peerObj.screenStreamId = incomingStream.id;
          incomingStream.getAudioTracks().forEach((audTrack) => {
            if (audTrack.id !== peerObj.voiceTrackId && audTrack.id !== peerObj.attachedVoiceTrackId) {
              peerObj.screenAudioTrackId = audTrack.id;
              if (!peerObj.screenStream.getTracks().includes(audTrack)) {
                peerObj.screenStream.addTrack(audTrack);
              }
            }
          });
        }

        state.stoppedWatchingPeers.delete(peerId);
        renderOrUpdateStreamTile(peerId, peerObj.user, peerObj.screenStream, false, true);
        socket.emit('webrtc:signal', { to: peerId, data: { viewerStatus: 'watching' } });

        incomingTrack.onunmute = () => {
          const tile = document.getElementById(`stream-tile-${peerId}`);
          const videoEl = tile?.querySelector('video.stream-webrtc-video');
          if (videoEl) {
            applyOptimalVideoShaderClass(videoEl);
            safePlayVideo(videoEl, false, peerId);
          }
        };

        incomingTrack.onended = () => {
          peerObj.screenStream = null;
          removeStreamTile(peerId);
        };
        return;
      }

      // 2. Trilha de ÁUDIO (Classificação Determinística: Voz da Sala vs Áudio da Live)
      if (incomingTrack.kind === 'audio') {
        const isKnownVoiceTrack = Boolean(peerObj.voiceTrackId && incomingTrack.id === peerObj.voiceTrackId);
        const isDefinitelyScreenAudio = !isKnownVoiceTrack && Boolean(
          (peerObj.screenAudioTrackId && incomingTrack.id === peerObj.screenAudioTrackId) ||
          (incomingStream && peerObj.screenStreamId && incomingStream.id === peerObj.screenStreamId && incomingStream.id !== peerObj.voiceStreamId) ||
          (incomingStream && incomingStream.getVideoTracks().length > 0)
        );

        if (isDefinitelyScreenAudio) {
          peerObj.screenAudioTrackId = incomingTrack.id;

          if (!peerObj.screenStream) {
            peerObj.screenStream = new MediaStream();
          }
          peerObj.screenStream.getAudioTracks().forEach((oldAud) => {
            if (oldAud.id !== incomingTrack.id) peerObj.screenStream.removeTrack(oldAud);
          });
          if (!peerObj.screenStream.getTracks().includes(incomingTrack)) {
            peerObj.screenStream.addTrack(incomingTrack);
          }

          const tile = document.getElementById(`stream-tile-${peerId}`);
          const videoEl = tile?.querySelector('video.stream-webrtc-video');
          if (videoEl) {
            videoEl.srcObject = null;
            videoEl.srcObject = peerObj.screenStream;
            safePlayVideo(videoEl, false, peerId);
          }
          syncMultiStreamAudioBus();
        } else {
          peerObj.voiceTrackId = incomingTrack.id;
          peerObj.attachedVoiceTrackId = incomingTrack.id;
          const isolatedVoiceStream = new MediaStream([incomingTrack]);
          setupRemoteVoicePipeline(peerId, isolatedVoiceStream);

          incomingTrack.onunmute = () => {
            if (peerObj.voiceAudioEl && peerObj.voiceAudioEl.paused) {
              peerObj.voiceAudioEl.play().catch(() => {});
            }
          };
        }
      }
    };

    if (isInitiator) {
      negotiateWithPeer(peerId, peerObj);
    }

    return peerObj;
  }

  function detachVoicePipeline(peerObj) {
    if (!peerObj) return;
    if (peerObj.voiceSourceNode) {
      try { peerObj.voiceSourceNode.disconnect(); } catch (e) {}
      peerObj.voiceSourceNode = null;
    }
    if (peerObj.voiceHighPassNode) {
      try { peerObj.voiceHighPassNode.disconnect(); } catch (e) {}
      peerObj.voiceHighPassNode = null;
    }
    if (peerObj.voiceLowPassNode) {
      try { peerObj.voiceLowPassNode.disconnect(); } catch (e) {}
      peerObj.voiceLowPassNode = null;
    }
    if (peerObj.remoteAnalyser) {
      try { peerObj.remoteAnalyser.disconnect(); } catch (e) {}
      peerObj.remoteAnalyser = null;
    }
    if (peerObj.voiceAudioEl) {
      peerObj.voiceAudioEl.pause();
      peerObj.voiceAudioEl.srcObject = null;
      peerObj.voiceAudioEl.remove();
      peerObj.voiceAudioEl = null;
    }
    peerObj.attachedVoiceTrackId = null;
  }

  function applyRemotePeerNoiseProfile(peerId, level) {
    state.userNoiseLevels.set(peerId, level);
    const peerObj = state.peers.get(peerId);
    if (!peerObj) return;

    const { hpFreq, lpFreq } = getNoiseFilterFrequencies(level);
    if (peerObj.voiceHighPassNode && state.audioContext) {
      peerObj.voiceHighPassNode.frequency.setTargetAtTime(hpFreq, state.audioContext.currentTime, 0.03);
    }
    if (peerObj.voiceLowPassNode && state.audioContext) {
      peerObj.voiceLowPassNode.frequency.setTargetAtTime(lpFreq, state.audioContext.currentTime, 0.03);
    }
  }

  function setupRemoteVoicePipeline(peerId, isolatedVoiceStream) {
    const peerObj = state.peers.get(peerId);
    if (!peerObj) return;

    detachVoicePipeline(peerObj);

    const audioEl = document.createElement('audio');
    audioEl.srcObject = isolatedVoiceStream;
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.muted = state.isDeafened;

    const savedVol = state.userVolumes.get(peerId) ?? 100;
    audioEl.volume = state.isDeafened ? 0 : Math.min(1, savedVol / 100);

    if (state.selectedAudioOutputId && state.selectedAudioOutputId !== 'default' && typeof audioEl.setSinkId === 'function') {
      audioEl.setSinkId(state.selectedAudioOutputId).catch(() => {});
    }

    el.remoteVoiceAudios.appendChild(audioEl);
    audioEl.play().catch(() => {});

    if (state.audioContext) {
      try {
        if (state.audioContext.state === 'suspended') {
          state.audioContext.resume().catch(() => {});
        }
        const nrLevel = state.userNoiseLevels.get(peerId) || 'auto';
        const { hpFreq, lpFreq } = getNoiseFilterFrequencies(nrLevel);

        const source = state.audioContext.createMediaStreamSource(isolatedVoiceStream);
        const hp = state.audioContext.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = hpFreq;

        const lp = state.audioContext.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = lpFreq;

        const remoteAnalyser = state.audioContext.createAnalyser();
        remoteAnalyser.fftSize = 256;

        source.connect(hp);
        hp.connect(lp);
        lp.connect(remoteAnalyser);

        peerObj.voiceSourceNode = source;
        peerObj.voiceHighPassNode = hp;
        peerObj.voiceLowPassNode = lp;
        peerObj.remoteAnalyser = remoteAnalyser;
      } catch (e) {}
    }

    peerObj.voiceAudioEl = audioEl;
  }

  socket.on('webrtc:signal', ({ from, user, data }) => {
    if (!state.currentRoomId) return;

    const isPeerInCurrentRoom = state.roomUsers.some(u => u.socketId === from);
    if (!isPeerInCurrentRoom && !state.peers.has(from) && !user) return;

    let peerObj = state.peers.get(from);
    if (!peerObj) {
      peerObj = createPeerConnection(from, user, false);
    }
    if (user) Object.assign(peerObj.user, user);

    if (data.requestStreamOffer) {
      if (state.isStreaming && state.localScreenStream) {
        peerObj.suppressAutoNegotiation = true;
        state.localScreenStream.getTracks().forEach((track) => {
          const alreadySent = peerObj.pc.getSenders().some(s => s.track === track);
          if (!alreadySent) peerObj.pc.addTrack(track, state.localScreenStream);
        });
        peerObj.suppressAutoNegotiation = false;
        sendStreamIdsMeta(from);
        negotiateWithPeer(from, peerObj);
      }
      return;
    }

    if (data.viewerStatus) {
      if (data.viewerStatus === 'watching') {
        state.myStreamViewers.add(from);
      } else if (data.viewerStatus === 'stopped') {
        state.myStreamViewers.delete(from);
      }
      updateBroadcasterControlPanel();
      return;
    }

    if (data.webrtcVideoOk) {
      peerObj.webrtcVideoConfirmed = true;
      state.myStreamViewers.add(from);
      updateBroadcasterControlPanel();
      return;
    }

    if (data.streamMeta) {
      applyRemoteStreamMeta(from, peerObj, data.streamMeta);
      if (!data.description && !data.candidate) return;
    }

    peerObj.signalingChain = peerObj.signalingChain.then(async () => {
      const pc = peerObj.pc;
      try {
        if (data.streamMeta) {
          applyRemoteStreamMeta(from, peerObj, data.streamMeta);
        }

        if (data.description) {
          const desc = data.description;
          const polite = socket.id < from;
          const offerCollision = desc.type === 'offer' && (peerObj.makingOffer || pc.signalingState !== 'stable');

          peerObj.ignoreOffer = !polite && offerCollision;
          if (peerObj.ignoreOffer) return;

          if (offerCollision) {
            await pc.setLocalDescription({ type: 'rollback' });
          }

          await pc.setRemoteDescription(desc);
          await flushPendingCandidates(peerObj);

          if (desc.type === 'offer') {
            peerObj.suppressAutoNegotiation = true;
            const addedVoice = ensureLocalAudioSenderOnPeer(peerObj);
            peerObj.suppressAutoNegotiation = false;

            const answer = await pc.createAnswer();
            try {
              await pc.setLocalDescription({
                type: answer.type,
                sdp: enhanceSdpForHighQualityStream(answer.sdp)
              });
            } catch (_sdpErr) {
              await pc.setLocalDescription(answer);
            }

            socket.emit('webrtc:signal', {
              to: from,
              data: {
                description: pc.localDescription,
                streamMeta: buildLocalStreamMeta()
              }
            });

            reconcilePeerMediaTracks(from, peerObj);

            if (addedVoice || (state.isStreaming && state.localScreenStream)) {
              setTimeout(() => {
                negotiateWithPeer(from, peerObj);
                enforceHighQualityForAllViewers();
              }, 120);
            } else {
              setTimeout(() => enforceHighQualityForAllViewers(), 250);
            }
          } else if (desc.type === 'answer') {
            reconcilePeerMediaTracks(from, peerObj);
            if (peerObj.needsAnotherNegotiation && pc.signalingState === 'stable') {
              peerObj.needsAnotherNegotiation = false;
              negotiateWithPeer(from, peerObj);
            }
            if (state.isStreaming) {
              setTimeout(() => enforceHighQualityForAllViewers(), 200);
            }
          }
        } else if (data.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(data.candidate);
          } else {
            peerObj.pendingCandidates.push(data.candidate);
          }
        }
      } catch (err) {
        console.warn('Aviso na fila de sinalização WebRTC:', err);
      }
    });
  });

  // ================= 5. BARRAMENTO DE ÁUDIO DE LIVES (VOLUME 100% CONSTANTE SEM DUCKING) =================
  function syncMultiStreamAudioBus(preferredPeerId = null) {
    if (preferredPeerId && preferredPeerId !== socket.id) {
      state.activeAudioStreamPeerId = preferredPeerId;
    }

    const allTiles = Array.from(el.streamsGrid.querySelectorAll('.stream-tile'));
    const remoteTiles = allTiles.filter(t => t.dataset.peerId && t.dataset.peerId !== socket.id);

    if (
      !state.activeAudioStreamPeerId ||
      !remoteTiles.some(t => t.dataset.peerId === state.activeAudioStreamPeerId)
    ) {
      if (state.focusedPeerId && state.focusedPeerId !== socket.id) {
        state.activeAudioStreamPeerId = state.focusedPeerId;
      } else {
        state.activeAudioStreamPeerId = remoteTiles[0]?.dataset.peerId || null;
      }
    }

    const localSysAudioTrack = state.localScreenStream?.getAudioTracks()[0] || null;
    const weAreAlsoSharingSystemAudio = Boolean(state.isStreaming && localSysAudioTrack);

    let anyRemoteLiveAudioPlayingOnOurSpeakers = false;

    remoteTiles.forEach((tile) => {
      const peerId = tile.dataset.peerId;
      const videoEl = tile.querySelector('video.stream-webrtc-video');
      const bottomHint = tile.querySelector('.stream-overlay-bottom');
      if (!videoEl) return;

      const isSelectedAudioLive = (peerId === state.activeAudioStreamPeerId);

      if (state.isDeafened) {
        videoEl.muted = true;
      } else if (weAreAlsoSharingSystemAudio && tile.dataset.userUnmutedManually !== 'true') {
        videoEl.muted = true;
        if (bottomHint) bottomHint.textContent = 'Clique para expandir';
      } else {
        videoEl.muted = !isSelectedAudioLive;
        if (bottomHint) {
          bottomHint.textContent = isSelectedAudioLive
            ? '🔊 Áudio ativo • Clique para expandir'
            : '🔇 Clique para focar nesta live';
        }
      }

      if (!videoEl.muted) {
        anyRemoteLiveAudioPlayingOnOurSpeakers = true;
      }
    });

    // Mantém o áudio da transmissão sempre ativo e no mesmo volume, sem reduzir quando alguém fala!
    if (localSysAudioTrack) {
      localSysAudioTrack.enabled = !anyRemoteLiveAudioPlayingOnOurSpeakers;
    }

    if (state.focusedPeerId && el.btnMuteFocusedStream) {
      const focusedTile = document.getElementById(`stream-tile-${state.focusedPeerId}`);
      const focusedVideo = focusedTile?.querySelector('video.stream-webrtc-video');
      if (focusedVideo) {
        el.btnMuteFocusedStream.textContent = focusedVideo.muted ? 'Ativar Som' : 'Silenciar';
      }
    }
  }

  function setupSegmentedButtons(containerId, key) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.streamSettings[key] = Number(btn.dataset[key === 'resolution' ? 'res' : 'fps']);
        if (el.settingsStreamRes) el.settingsStreamRes.value = String(state.streamSettings.resolution);
        if (el.settingsStreamFps) el.settingsStreamFps.value = String(state.streamSettings.fps);
      });
    });
  }
  setupSegmentedButtons('resolution-options', 'resolution');
  setupSegmentedButtons('fps-options', 'fps');

  const openStreamConfigOrStop = () => {
    if (state.isStreaming) {
      stopScreenSharing();
    } else {
      syncStreamModalButtons();
      el.modalStreamConfig.classList.remove('hidden');
    }
  };

  el.btnStartStream?.addEventListener('click', openStreamConfigOrStop);
  el.btnQuickStreamHeader?.addEventListener('click', openStreamConfigOrStop);

  el.btnCloseStreamModal?.addEventListener('click', () => el.modalStreamConfig.classList.add('hidden'));
  el.btnCancelStreamModal?.addEventListener('click', () => el.modalStreamConfig.classList.add('hidden'));

  el.btnConfirmStartStream?.addEventListener('click', async () => {
    if (el.selectContentHint) state.streamSettings.contentHint = el.selectContentHint.value;
    el.modalStreamConfig.classList.add('hidden');
    await startScreenSharing();
  });

  async function lockCaptureVideoTrackResolution(videoTrack, dims, fps) {
    if (!videoTrack || typeof videoTrack.applyConstraints !== 'function') return;
    try {
      await videoTrack.applyConstraints({
        width: { min: dims.width, ideal: dims.width, max: dims.width },
        height: { min: dims.height, ideal: dims.height, max: dims.height },
        frameRate: { ideal: fps, max: fps },
        resizeMode: 'none'
      });
    } catch (_errStrict) {
      try {
        await videoTrack.applyConstraints({
          width: { ideal: dims.width, max: dims.width },
          height: { ideal: dims.height, max: dims.height },
          frameRate: { ideal: fps, max: fps }
        });
      } catch (_errFallback) {}
    }
  }

  async function startScreenSharing() {
    const resMap = {
      720: { width: 1280, height: 720 },
      1080: { width: 1920, height: 1080 },
      1440: { width: 2560, height: 1440 }
    };
    const dims = resMap[state.streamSettings.resolution] || resMap[1080];
    const fps = state.streamSettings.fps;

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: dims.width, max: dims.width },
          height: { ideal: dims.height, max: dims.height },
          frameRate: { ideal: fps, max: fps },
          resizeMode: 'none'
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          restrictOwnAudio: true,
          suppressLocalAudioPlayback: false,
          channelCount: 2,
          sampleRate: 48000
        },
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
        windowAudio: 'system'
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return;

      videoTrack.enabled = true;
      await lockCaptureVideoTrackResolution(videoTrack, dims, fps);

      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = state.streamSettings.resolution === 1440
          ? 'detail'
          : state.streamSettings.contentHint;
      }

      const sysAudioTrack = stream.getAudioTracks()[0];
      if (sysAudioTrack) {
        sysAudioTrack.enabled = true;
        // Desativa explicitamente qualquer AutoGain / Ducking / Supressão na faixa de áudio da live
        if (typeof sysAudioTrack.applyConstraints === 'function') {
          try {
            await sysAudioTrack.applyConstraints({
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            });
          } catch (_audErr) {}
        }
      }

      videoTrack.onended = () => stopScreenSharing();

      state.localScreenStream = stream;
      state.isStreaming = true;
      state.streamStartedAt = Date.now();
      state.myStreamViewers.clear();

      if (state.streamTimerInterval) clearInterval(state.streamTimerInterval);
      state.streamTimerInterval = setInterval(updateBroadcasterControlPanel, 1000);

      document.querySelectorAll('.stream-tile').forEach((t) => {
        delete t.dataset.userUnmutedManually;
      });

      syncStreamButtonsVisualState();

      socket.emit('user:state-change', {
        isStreaming: true,
        screenStreamId: stream.id,
        streamConfig: {
          resolution: state.streamSettings.resolution,
          fps: state.streamSettings.fps
        }
      });

      for (const [peerId, peerObj] of state.peers.entries()) {
        peerObj.webrtcVideoConfirmed = false;
        peerObj.suppressAutoNegotiation = true;
        sendStreamIdsMeta(peerId);
        stream.getTracks().forEach((track) => {
          const alreadySent = peerObj.pc.getSenders().some(s => s.track === track);
          if (!alreadySent) peerObj.pc.addTrack(track, stream);
        });
        peerObj.suppressAutoNegotiation = false;
        negotiateWithPeer(peerId, peerObj);
      }

      updateBroadcasterControlPanel();
      updateStageLayout();
      syncMultiStreamAudioBus();
      setTimeout(() => enforceHighQualityForAllViewers(), 300);
      setTimeout(() => enforceHighQualityForAllViewers(), 1000);
    } catch (err) {
      state.isStreaming = false;
      syncStreamButtonsVisualState();
      console.log('Partilha de ecrã cancelada:', err);
    }
  }

  async function applyVideoSenderParameters(sender) {
    if (!sender || !sender.track || sender.track.kind !== 'video') return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) return;

      params.encodings[0].maxBitrate = getTargetBitrateKbps() * 1000;
      params.encodings[0].maxFramerate = state.streamSettings.fps;
      params.encodings[0].scaleResolutionDownBy = 1.0;
      params.encodings[0].active = true;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      params.degradationPreference = 'maintain-resolution';

      await sender.setParameters(params);
    } catch (e) {}
  }

  function enforceHighQualityForAllViewers() {
    if (!state.isStreaming || !state.localScreenStream) return;
    const vidTrack = state.localScreenStream.getVideoTracks()[0];
    if (vidTrack) {
      const resMap = {
        720: { width: 1280, height: 720 },
        1080: { width: 1920, height: 1080 },
        1440: { width: 2560, height: 1440 }
      };
      const dims = resMap[state.streamSettings.resolution] || resMap[1080];
      lockCaptureVideoTrackResolution(vidTrack, dims, state.streamSettings.fps);
    }

    for (const [, peerObj] of state.peers.entries()) {
      if (peerObj.pc.signalingState !== 'stable') continue;
      const senders = peerObj.pc.getSenders();
      senders.forEach((sender) => {
        if (sender.track && sender.track.kind === 'video') {
          applyVideoSenderParameters(sender);
        }
      });
    }
  }

  function stopScreenSharing() {
    if (state.streamTimerInterval) {
      clearInterval(state.streamTimerInterval);
      state.streamTimerInterval = null;
    }
    state.streamStartedAt = null;
    state.myStreamViewers.clear();
    state.isStreaming = false;

    if (state.localScreenStream) {
      const tracksToStop = state.localScreenStream.getTracks();

      for (const [peerId, peerObj] of state.peers.entries()) {
        peerObj.suppressAutoNegotiation = true;
        const senders = peerObj.pc.getSenders();
        senders.forEach((sender) => {
          if (sender.track && tracksToStop.includes(sender.track)) {
            try { peerObj.pc.removeTrack(sender); } catch (e) {}
          }
        });
        ensureLocalAudioSenderOnPeer(peerObj);
        peerObj.suppressAutoNegotiation = false;
        sendStreamIdsMeta(peerId);
        negotiateWithPeer(peerId, peerObj);
      }

      tracksToStop.forEach(t => t.stop());
      state.localScreenStream = null;
    }

    syncStreamButtonsVisualState();
    updateBroadcasterControlPanel();
    updateStageLayout();
    syncMultiStreamAudioBus();

    socket.emit('user:state-change', {
      isStreaming: false,
      screenStreamId: null,
      streamConfig: null
    });
  }

  // ================= 6. RENDERIZAÇÃO DA GRADE DE TRANSMISSÕES (#streams-grid) =================
  function applyOptimalVideoShaderClass(videoEl) {
    if (!videoEl) return;
    if (!state.sharpenEnabled) {
      videoEl.classList.remove('cas-sharpen-active', 'native-2k-crisp');
      return;
    }
    const is2KStream = videoEl.videoWidth >= 2000 || videoEl.videoHeight >= 1200;
    if (is2KStream) {
      videoEl.classList.remove('cas-sharpen-active');
      videoEl.classList.add('native-2k-crisp');
    } else {
      videoEl.classList.remove('native-2k-crisp');
      videoEl.classList.add('cas-sharpen-active');
    }
  }

  function safePlayVideo(videoEl, isLocal = false, peerId = null) {
    if (!videoEl) return;
    if (isLocal) {
      videoEl.muted = true;
    } else {
      syncMultiStreamAudioBus();
    }

    const p = videoEl.play();
    if (p !== undefined) {
      p.catch(() => {
        videoEl.muted = true;
        videoEl.play().catch(() => {});
        if (!isLocal) {
          const unlock = () => {
            syncMultiStreamAudioBus(peerId);
            videoEl.play().catch(() => {});
            window.removeEventListener('click', unlock);
          };
          window.addEventListener('click', unlock, { once: true });
        }
      });
    }
  }

  function ensureStreamTileExists(peerId, user, isLocal = false) {
    if (isLocal || peerId === socket.id) return null;

    let tile = document.getElementById(`stream-tile-${peerId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = `stream-tile-${peerId}`;
      tile.className = 'stream-tile';
      tile.dataset.peerId = peerId;

      const relayImg = document.createElement('img');
      relayImg.className = 'stream-relay-img hidden';
      relayImg.alt = 'Stream';

      const video = document.createElement('video');
      video.className = 'stream-webrtc-video webrtc-has-frames';
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.volume = 1.0;

      const markWebrtcActive = () => {
        if (video.videoWidth > 0) {
          video.classList.add('webrtc-has-frames');
          relayImg.classList.add('hidden');
          applyOptimalVideoShaderClass(video);
          socket.emit('webrtc:signal', { to: peerId, data: { webrtcVideoOk: true } });
        }
      };

      video.addEventListener('loadeddata', markWebrtcActive);
      video.addEventListener('playing', markWebrtcActive);
      video.addEventListener('resize', markWebrtcActive);

      const overlayTop = document.createElement('div');
      overlayTop.className = 'stream-overlay-top';
      const cfg = user?.streamConfig || state.streamSettings;

      overlayTop.innerHTML = `
        <div class="live-badge-header">
          <div class="avatar-circle" style="width:20px;height:20px;font-size:10px;background:${user?.avatarColor || '#5E81F4'}">
            ${escapeHtml((user?.name || 'U').charAt(0).toUpperCase())}
          </div>
          <span class="live-pill-red">● AO VIVO</span>
          <span>•</span>
          <strong>${escapeHtml(user?.name || 'Utilizador')}</strong>
        </div>
        <div class="spec-pill mono">
          ${cfg?.resolution || 1080}p ${cfg?.fps || 60}FPS
        </div>
      `;

      const overlayBottom = document.createElement('div');
      overlayBottom.className = 'stream-overlay-bottom';
      overlayBottom.textContent = 'Clique para expandir';

      tile.appendChild(relayImg);
      tile.appendChild(video);
      tile.appendChild(overlayTop);
      tile.appendChild(overlayBottom);

      tile.addEventListener('click', () => {
        if (peerId !== socket.id) {
          state.activeAudioStreamPeerId = peerId;
        }
        if (state.focusedPeerId !== peerId) {
          focusStreamTile(peerId);
        } else {
          syncMultiStreamAudioBus(peerId);
        }
      });

      el.streamsGrid.appendChild(tile);
      syncMultiStreamAudioBus();
    }
    return tile;
  }

  function renderOrUpdateStreamTile(peerId, user, stream, isLocal = false, forceRebind = false) {
    if (isLocal || peerId === socket.id) return;

    const tile = ensureStreamTileExists(peerId, user, false);
    if (!tile) return;

    const specPill = tile.querySelector('.spec-pill');
    if (specPill && user?.streamConfig) {
      specPill.textContent = `${user.streamConfig.resolution || 1080}p ${user.streamConfig.fps || 60}FPS`;
    }

    const videoEl = tile.querySelector('video.stream-webrtc-video');
    if (videoEl && stream) {
      if (forceRebind || videoEl.srcObject !== stream) {
        videoEl.srcObject = null;
        videoEl.srcObject = stream;
      }
      applyOptimalVideoShaderClass(videoEl);
      safePlayVideo(videoEl, false, peerId);
    }

    updateStageLayout();
    syncMultiStreamAudioBus();
  }

  function removeStreamTile(peerId) {
    const tile = document.getElementById(`stream-tile-${peerId}`);
    if (tile) {
      const video = tile.querySelector('video');
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      tile.remove();
    }
    if (state.focusedPeerId === peerId) {
      state.focusedPeerId = null;
    }
    if (state.activeAudioStreamPeerId === peerId) {
      state.activeAudioStreamPeerId = null;
    }
    updateStageLayout();
    syncMultiStreamAudioBus();
  }

  function focusStreamTile(peerId) {
    if (!peerId || peerId === socket.id) return;
    state.focusedPeerId = peerId;
    state.activeAudioStreamPeerId = peerId;

    const tile = document.getElementById(`stream-tile-${peerId}`);
    if (tile) {
      tile.dataset.userUnmutedManually = 'true';
      const videoEl = tile.querySelector('video.stream-webrtc-video');
      if (videoEl && !state.isDeafened) {
        const sliderVal = Number(el.focusedStreamVolume?.value || 100);
        videoEl.volume = sliderVal > 0 ? Math.min(1, sliderVal / 100) : 1.0;
        videoEl.muted = false;
      }
    }
    updateStageLayout();
    syncMultiStreamAudioBus(peerId);
  }

  function updateStageLayout() {
    const tiles = Array.from(el.streamsGrid.querySelectorAll('.stream-tile'));
    const count = tiles.length;

    el.activeStreamsCounter.textContent = count === 0
      ? (state.isStreaming ? 'Você está transmitindo ao vivo' : 'Conversa em tempo real')
      : `${count} ${count === 1 ? 'transmissão ativa na grade' : 'transmissões ativas na grade'}`;

    if (count === 0) {
      el.workspaceGrid.classList.add('no-streams-mode');
      el.workspaceGrid.classList.remove('streams-active-mode');
      state.focusedPeerId = null;
      el.focusedControls.classList.add('hidden');
      return;
    }

    el.workspaceGrid.classList.remove('no-streams-mode');
    el.workspaceGrid.classList.add('streams-active-mode');

    if (state.focusedPeerId && document.getElementById(`stream-tile-${state.focusedPeerId}`)) {
      el.streamsGrid.classList.add('has-focused');
      el.focusedControls.classList.remove('hidden');
      tiles.forEach((t) => {
        const isTarget = t.dataset.peerId === state.focusedPeerId;
        t.classList.toggle('focused-tile', isTarget);
        t.classList.toggle('minimized-in-focus', !isTarget);
      });
    } else {
      state.focusedPeerId = null;
      el.streamsGrid.classList.remove('has-focused');
      el.focusedControls.classList.add('hidden');
      tiles.forEach((t) => {
        t.classList.remove('focused-tile', 'minimized-in-focus');
      });
    }
  }

  el.btnToggleSharpen?.addEventListener('click', () => {
    state.sharpenEnabled = !state.sharpenEnabled;
    el.btnToggleSharpen.classList.toggle('active-sharpen', state.sharpenEnabled);
    document.querySelectorAll('.stream-tile video').forEach((v) => {
      applyOptimalVideoShaderClass(v);
    });
  });

  el.btnMinimizeStream?.addEventListener('click', () => {
    document.querySelectorAll('.stream-tile').forEach((t) => {
      delete t.dataset.userUnmutedManually;
    });
    state.focusedPeerId = null;
    updateStageLayout();
    syncMultiStreamAudioBus();
  });

  el.btnFullscreenStream?.addEventListener('click', () => {
    if (!state.focusedPeerId) return;
    const tile = document.getElementById(`stream-tile-${state.focusedPeerId}`);
    if (tile?.requestFullscreen) tile.requestFullscreen();
  });

  el.focusedStreamVolume?.addEventListener('input', () => {
    const val = Number(el.focusedStreamVolume.value);
    el.focusedVolumeLabel.textContent = `${val}%`;
    if (!state.focusedPeerId || state.focusedPeerId === socket.id) return;

    const tile = document.getElementById(`stream-tile-${state.focusedPeerId}`);
    const video = tile?.querySelector('video.stream-webrtc-video');
    if (video) {
      if (val > 0) {
        tile.dataset.userUnmutedManually = 'true';
        state.activeAudioStreamPeerId = state.focusedPeerId;
      } else {
        delete tile.dataset.userUnmutedManually;
      }
      video.volume = Math.min(1, val / 100);
      syncMultiStreamAudioBus(state.focusedPeerId);
      if (val === 0) video.muted = true;
    }
  });

  el.btnMuteFocusedStream?.addEventListener('click', () => {
    if (!state.focusedPeerId || state.focusedPeerId === socket.id) return;
    const tile = document.getElementById(`stream-tile-${state.focusedPeerId}`);
    const video = tile?.querySelector('video.stream-webrtc-video');
    if (video) {
      const willUnmute = video.muted;
      if (willUnmute) {
        tile.dataset.userUnmutedManually = 'true';
        state.activeAudioStreamPeerId = state.focusedPeerId;
      } else {
        delete tile.dataset.userUnmutedManually;
      }
      syncMultiStreamAudioBus(state.focusedPeerId);
      el.btnMuteFocusedStream.textContent = video.muted ? 'Ativar Som' : 'Silenciar';
    }
  });

  el.btnStopWatching?.addEventListener('click', () => {
    if (!state.focusedPeerId) return;
    const targetId = state.focusedPeerId;
    if (targetId === socket.id) {
      stopScreenSharing();
    } else {
      state.stoppedWatchingPeers.add(targetId);
      removeStreamTile(targetId);
      socket.emit('webrtc:signal', { to: targetId, data: { viewerStatus: 'stopped' } });
    }
  });

  // ================= 7. CONTROLES DA CÁPSULA E PARTICIPANTES =================
  el.btnToggleMic?.addEventListener('click', () => {
    state.isMicMuted = !state.isMicMuted;
    el.btnToggleMic.classList.toggle('muted', state.isMicMuted);
    document.getElementById('icon-mic').textContent = state.isMicMuted ? '🔇' : '🎙️';
    updateLocalMicTrackEnabledState();
    socket.emit('user:state-change', { isMuted: state.isMicMuted });
    syncDesktopOverlayState();
  });

  el.btnToggleDeafen?.addEventListener('click', () => {
    state.isDeafened = !state.isDeafened;
    el.btnToggleDeafen.classList.toggle('muted', state.isDeafened);
    document.getElementById('icon-deafen').textContent = state.isDeafened ? '🔈' : '🎧';

    for (const [peerId, peerObj] of state.peers.entries()) {
      if (peerObj.voiceAudioEl) {
        const vol = state.userVolumes.get(peerId) ?? 100;
        peerObj.voiceAudioEl.muted = state.isDeafened;
        peerObj.voiceAudioEl.volume = state.isDeafened ? 0 : Math.min(1, vol / 100);
      }
    }
    syncMultiStreamAudioBus();
    socket.emit('user:state-change', { isDeafened: state.isDeafened });
    syncDesktopOverlayState();
  });

  function renderParticipantsList(users) {
    state.roomUsers = users || [];
    el.participantsList.innerHTML = '';
    el.roomUserCount.textContent = users.length;

    users.forEach((u) => {
      const isMe = u.socketId === socket.id;
      const currentVol = state.userVolumes.get(u.socketId) ?? 100;
      const currentNr = state.userNoiseLevels.get(u.socketId) || 'auto';

      const peerObj = state.peers.get(u.socketId);
      if (peerObj) {
        Object.assign(peerObj.user, u);
      }

      const card = document.createElement('div');
      card.id = `participant-card-${u.socketId}`;
      card.className = 'participant-card';
      card.innerHTML = `
        <div class="participant-top">
          <div class="participant-identity">
            <div class="avatar-circle" style="background:${u.avatarColor || '#5E81F4'}">
              ${escapeHtml(u.name.charAt(0).toUpperCase())}
            </div>
            <div class="participant-names">
              <strong>${escapeHtml(u.name)} ${isMe ? '(Você)' : ''}</strong>
              <small class="mono">@${escapeHtml(u.nick)}</small>
            </div>
          </div>
          <div class="participant-badges">
            <div class="speaking-eq" title="A falar">
              <span></span><span></span><span></span>
            </div>
            ${u.isStreaming ? '<span class="live-mini-tag">LIVE</span>' : ''}
            ${u.isMuted ? '<span title="Microfone Silenciado">🔇</span>' : ''}
            ${u.isDeafened ? '<span title="Áudio Desativado">🔈</span>' : ''}
          </div>
        </div>
        ${!isMe ? `
          <div class="participant-volume-row">
            <button class="btn-local-mute" title="Silenciar localmente">🔊</button>
            <input type="range" min="0" max="100" value="${Math.min(100, currentVol)}" />
            <span class="mono" style="font-size:10.5px;width:34px;text-align:right">${Math.min(100, currentVol)}%</span>
          </div>
          <div class="participant-nr-row" title="Filtro de Ruído Individual para este utilizador">
            <span class="participant-nr-label">Filtro Ruído:</span>
            <div class="nr-pills-group">
              <button type="button" class="nr-pill-btn ${currentNr === 'auto' ? 'active' : ''}" data-nr="auto">Auto</button>
              <button type="button" class="nr-pill-btn ${currentNr === 'low' ? 'active' : ''}" data-nr="low">Baixo</button>
              <button type="button" class="nr-pill-btn ${currentNr === 'medium' ? 'active' : ''}" data-nr="medium">Médio</button>
              <button type="button" class="nr-pill-btn ${currentNr === 'high' ? 'active' : ''}" data-nr="high">Alto</button>
            </div>
          </div>
        ` : ''}
      `;

      if (!isMe) {
        card.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
          if (u.isStreaming) {
            state.stoppedWatchingPeers.delete(u.socketId);
            const pObj = state.peers.get(u.socketId);
            if (pObj?.screenStream && pObj.screenStream.getVideoTracks().length > 0) {
              renderOrUpdateStreamTile(u.socketId, u, pObj.screenStream, false, true);
              focusStreamTile(u.socketId);
              socket.emit('webrtc:signal', { to: u.socketId, data: { viewerStatus: 'watching' } });
              return;
            } else {
              socket.emit('webrtc:signal', { to: u.socketId, data: { requestStreamOffer: true } });
              showToast('A abrir transmissão...', `A conectar à live de ${u.name}...`, '🖥️');
              return;
            }
          }
          card.classList.toggle('show-volume');
        });

        const slider = card.querySelector('input[type="range"]');
        const label = card.querySelector('.participant-volume-row span');
        const muteBtn = card.querySelector('.btn-local-mute');

        slider.addEventListener('input', () => {
          const val = Number(slider.value);
          state.userVolumes.set(u.socketId, val);
          label.textContent = `${val}%`;
          const pObj = state.peers.get(u.socketId);
          if (pObj?.voiceAudioEl) {
            pObj.voiceAudioEl.muted = state.isDeafened || val === 0;
            pObj.voiceAudioEl.volume = state.isDeafened ? 0 : Math.min(1, val / 100);
          }
        });

        muteBtn.addEventListener('click', () => {
          const newVol = (state.userVolumes.get(u.socketId) ?? 100) > 0 ? 0 : 100;
          slider.value = newVol;
          slider.dispatchEvent(new Event('input'));
          muteBtn.textContent = newVol === 0 ? '🔇' : '🔊';
        });

        card.querySelectorAll('.nr-pill-btn').forEach((nrBtn) => {
          nrBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            card.querySelectorAll('.nr-pill-btn').forEach(b => b.classList.remove('active'));
            nrBtn.classList.add('active');
            applyRemotePeerNoiseProfile(u.socketId, nrBtn.dataset.nr);
          });
        });
      }

      el.participantsList.appendChild(card);
    });

    syncDesktopOverlayState();
  }

  // ================= 8. CHAT PREMIUM =================
  function formatMessageBodyHtml(rawText) {
    const myNickLower = state.user?.nick?.toLowerCase() || '';
    return escapeHtml(rawText).replace(
      /@([a-zA-Z0-9_]+)/g,
      (full, nickMatch) => {
        const isSelf = myNickLower && nickMatch.toLowerCase() === myNickLower;
        return `<span class="mention-highlight ${isSelf ? 'mention-self' : ''}">@${nickMatch}</span>`;
      }
    );
  }

  function appendChatMessage(msg, isRealtime = true) {
    const div = document.createElement('div');
    div.id = `chat-msg-${msg.id}`;
    div.dataset.rawText = msg.text || '';

    const myNickLower = state.user?.nick?.toLowerCase() || '';
    const mentionRegex = new RegExp(`@${myNickLower}\\b`, 'i');
    const mentionedMe = Boolean(myNickLower && mentionRegex.test(msg.text || ''));
    const isMyMessage = state.user && (msg.senderId === socket.id || msg.senderNick === state.user.nick);

    div.className = `msg-card ${mentionedMe ? 'mentioned-me' : ''}`;

    const formattedText = formatMessageBodyHtml(msg.text || '');

    let attachmentHtml = '';
    if (msg.file) {
      const { name, size, type, dataUrl } = msg.file;
      const sizeStr = (size / (1024 * 1024)).toFixed(2) + ' MB';
      if (type.startsWith('image/')) {
        attachmentHtml = `
          <div class="msg-attachment">
            <img src="${dataUrl}" alt="${escapeHtml(name)}" class="chat-zoomable-img" title="Clique para ampliar" loading="lazy" />
          </div>
        `;
      } else if (type.startsWith('video/')) {
        attachmentHtml = `
          <div class="msg-attachment">
            <video src="${dataUrl}" controls preload="metadata"></video>
          </div>
        `;
      } else {
        attachmentHtml = `
          <div class="file-download-card">
            <div class="file-info">
              <strong>📄 ${escapeHtml(name)}</strong>
              <small>${sizeStr}</small>
            </div>
            <a href="${dataUrl}" download="${escapeHtml(name)}" class="btn-download-file">Transferir</a>
          </div>
        `;
      }
    }

    const createdAt = msg.createdAt || Date.now();
    const withinWindow = isMyMessage && (Date.now() - createdAt <= FIFTEEN_MINUTES_MS);

    div.innerHTML = `
      ${msg.replyTo ? `
        <div class="msg-reply-quote">
          ↪ <strong>@${escapeHtml(msg.replyTo.nick)}</strong>: ${escapeHtml(msg.replyTo.snippet)}
        </div>
      ` : ''}
      <div class="msg-header">
        <div class="msg-author">
          <span class="msg-author-dot" style="background:${msg.avatarColor || '#5E81F4'}"></span>
          <strong>${escapeHtml(msg.senderName)}</strong>
          <span class="mono">@${escapeHtml(msg.senderNick)}</span>
          ${mentionedMe ? '<span class="mention-you-badge">Mencionou-o</span>' : ''}
        </div>
        <div class="msg-meta">
          <div class="msg-actions-toolbar">
            <button type="button" class="btn-msg-action btn-reply-msg">↩ Responder</button>
            ${withinWindow && msg.text ? `<button type="button" class="btn-msg-action edit-action btn-edit-msg">✏️ Editar</button>` : ''}
            ${withinWindow ? `<button type="button" class="btn-msg-action delete-action btn-delete-msg">🗑️ Excluir</button>` : ''}
          </div>
          <span class="msg-time">${msg.timestamp}</span>
          <span class="msg-edited-tag ${msg.edited ? '' : 'hidden'}">(editado)</span>
        </div>
      </div>
      <div class="msg-body ${msg.text ? '' : 'hidden'}">${formattedText}</div>
      ${attachmentHtml}

      <div class="msg-edit-box hidden">
        <input type="text" class="msg-edit-input" maxlength="1000" value="${escapeHtml(msg.text || '')}" />
        <div class="msg-edit-footer">
          <span>Enter para guardar • Esc para cancelar</span>
          <div class="msg-edit-btns">
            <button type="button" class="btn-cancel-edit">Cancelar</button>
            <button type="button" class="btn-save-edit">Guardar</button>
          </div>
        </div>
      </div>

      <div class="delete-confirm-bar hidden">
        <span>Apagar esta mensagem para todos na sala?</span>
        <div class="delete-confirm-btns">
          <button type="button" class="btn-confirm-del">Apagar</button>
          <button type="button" class="btn-cancel-del">Cancelar</button>
        </div>
      </div>
    `;

    const zoomImg = div.querySelector('.chat-zoomable-img');
    if (zoomImg && msg.file) {
      zoomImg.addEventListener('click', () => {
        openImageLightbox(msg.file.dataUrl, msg.file.name);
      });
    }

    div.querySelector('.btn-reply-msg').addEventListener('click', () => {
      state.replyingTo = {
        nick: msg.senderNick,
        snippet: (div.dataset.rawText || msg.file?.name || 'Anexo').slice(0, 50)
      };
      el.replyTargetNick.textContent = '@' + state.replyingTo.nick;
      el.replyTargetSnippet.textContent = state.replyingTo.snippet;
      el.replyPreviewBar.classList.remove('hidden');
      el.chatInput.focus();
    });

    const editBtn = div.querySelector('.btn-edit-msg');
    const deleteBtn = div.querySelector('.btn-delete-msg');
    const editBox = div.querySelector('.msg-edit-box');
    const editInput = div.querySelector('.msg-edit-input');
    const confirmBar = div.querySelector('.delete-confirm-bar');
    const bodyEl = div.querySelector('.msg-body');

    if (withinWindow) {
      const remainingMs = FIFTEEN_MINUTES_MS - (Date.now() - createdAt);
      if (remainingMs > 0) {
        setTimeout(() => {
          editBtn?.remove();
          deleteBtn?.remove();
          editBox?.classList.add('hidden');
          confirmBar?.classList.add('hidden');
          if (div.dataset.rawText) bodyEl?.classList.remove('hidden');
        }, remainingMs);
      }
    }

    if (editBtn && editBox && editInput) {
      const openEditor = () => {
        if (Date.now() - createdAt > FIFTEEN_MINUTES_MS) {
          editBtn.remove();
          return;
        }
        confirmBar?.classList.add('hidden');
        editInput.value = div.dataset.rawText || '';
        bodyEl.classList.add('hidden');
        editBox.classList.remove('hidden');
        editInput.focus();
      };

      const closeEditor = () => {
        editBox.classList.add('hidden');
        if (div.dataset.rawText) bodyEl.classList.remove('hidden');
      };

      const submitEdit = () => {
        const newText = editInput.value.trim();
        if (!newText || newText === div.dataset.rawText) {
          closeEditor();
          return;
        }
        socket.emit('chat:edit-message', { messageId: msg.id, newText }, () => {
          closeEditor();
        });
      };

      editBtn.addEventListener('click', openEditor);
      div.querySelector('.btn-cancel-edit').addEventListener('click', closeEditor);
      div.querySelector('.btn-save-edit').addEventListener('click', submitEdit);

      editInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeEditor();
        }
      });
    }

    if (deleteBtn && confirmBar) {
      deleteBtn.addEventListener('click', () => {
        if (Date.now() - createdAt > FIFTEEN_MINUTES_MS) {
          deleteBtn.remove();
          return;
        }
        editBox?.classList.add('hidden');
        if (div.dataset.rawText) bodyEl?.classList.remove('hidden');
        confirmBar.classList.toggle('hidden');
      });

      div.querySelector('.btn-cancel-del').addEventListener('click', () => {
        confirmBar.classList.add('hidden');
      });

      div.querySelector('.btn-confirm-del').addEventListener('click', () => {
        socket.emit('chat:delete-message', { messageId: msg.id });
      });
    }

    el.chatMessages.appendChild(div);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;

    if (isRealtime && !isMyMessage) {
      if (mentionedMe) {
        playMentionChime();
        dispatchSmartNotification(
          `@${msg.senderNick} mencionou-o`,
          (msg.text || 'Anexo enviado').slice(0, 80),
          '🔔',
          () => div.scrollIntoView({ behavior: 'smooth', block: 'center' })
        );
      } else if (document.hidden && isDesktopInstalledApp) {
        dispatchSmartNotification(
          `Nova mensagem de ${msg.senderName}`,
          (msg.text || msg.file?.name || 'Enviou um ficheiro').slice(0, 80),
          '💬'
        );
      }
    }
  }

  socket.on('chat:message-edited', ({ messageId, newText }) => {
    const msgEl = document.getElementById(`chat-msg-${messageId}`);
    if (!msgEl) return;

    msgEl.dataset.rawText = newText;
    const bodyEl = msgEl.querySelector('.msg-body');
    const editedTag = msgEl.querySelector('.msg-edited-tag');

    if (bodyEl) {
      bodyEl.innerHTML = formatMessageBodyHtml(newText);
      bodyEl.classList.remove('hidden');
    }
    if (editedTag) {
      editedTag.classList.remove('hidden');
    }
  });

  socket.on('chat:message-deleted', ({ messageId }) => {
    const msgEl = document.getElementById(`chat-msg-${messageId}`);
    if (msgEl) {
      msgEl.classList.add('deleting-anim');
      setTimeout(() => msgEl.remove(), 220);
    }
  });

  function checkMentionAutocomplete() {
    const val = el.chatInput.value;
    const caret = el.chatInput.selectionStart ?? val.length;
    const textBeforeCaret = val.slice(0, caret);

    const match = textBeforeCaret.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
    if (!match) {
      closeMentionAutocomplete();
      return;
    }

    const query = match[1].toLowerCase();
    const atPosition = textBeforeCaret.lastIndexOf('@');

    const matches = state.roomUsers.filter((u) => {
      return (
        u.nick.toLowerCase().includes(query) ||
        u.name.toLowerCase().includes(query)
      );
    });

    if (matches.length === 0) {
      closeMentionAutocomplete();
      return;
    }

    state.mentionState.active = true;
    state.mentionState.startIndex = atPosition;
    state.mentionState.query = query;
    state.mentionState.filteredUsers = matches;
    if (state.mentionState.selectedIndex >= matches.length) {
      state.mentionState.selectedIndex = 0;
    }

    renderMentionAutocompleteList();
    el.mentionAutocomplete.classList.remove('hidden');
  }

  function renderMentionAutocompleteList() {
    el.mentionAutocompleteList.innerHTML = '';
    state.mentionState.filteredUsers.forEach((u, idx) => {
      const item = document.createElement('div');
      item.className = `mention-option ${idx === state.mentionState.selectedIndex ? 'active' : ''}`;
      item.innerHTML = `
        <div class="mention-option-left">
          <div class="avatar-circle" style="width:22px;height:22px;font-size:10px;background:${u.avatarColor || '#5E81F4'}">
            ${escapeHtml(u.name.charAt(0).toUpperCase())}
          </div>
          <strong>${escapeHtml(u.name)}</strong>
        </div>
        <span class="mono mention-option-nick">@${escapeHtml(u.nick)}</span>
      `;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertMentionFromAutocomplete(u);
      });
      el.mentionAutocompleteList.appendChild(item);
    });
  }

  function insertMentionFromAutocomplete(userObj) {
    if (!userObj) return;
    const val = el.chatInput.value;
    const caret = el.chatInput.selectionStart ?? val.length;
    const beforeAt = val.slice(0, state.mentionState.startIndex);
    const afterCaret = val.slice(caret);

    const inserted = `@${userObj.nick} `;
    el.chatInput.value = beforeAt + inserted + afterCaret;
    const newCaretPos = (beforeAt + inserted).length;
    el.chatInput.setSelectionRange(newCaretPos, newCaretPos);
    closeMentionAutocomplete();
    el.chatInput.focus();
  }

  function closeMentionAutocomplete() {
    state.mentionState.active = false;
    state.mentionState.filteredUsers = [];
    state.mentionState.selectedIndex = 0;
    el.mentionAutocomplete.classList.add('hidden');
  }

  el.chatInput.addEventListener('input', checkMentionAutocomplete);
  el.chatInput.addEventListener('click', checkMentionAutocomplete);

  el.chatInput.addEventListener('keydown', (e) => {
    if (!state.mentionState.active) return;
    const len = state.mentionState.filteredUsers.length;
    if (len === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.mentionState.selectedIndex = (state.mentionState.selectedIndex + 1) % len;
      renderMentionAutocompleteList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.mentionState.selectedIndex = (state.mentionState.selectedIndex - 1 + len) % len;
      renderMentionAutocompleteList();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const chosen = state.mentionState.filteredUsers[state.mentionState.selectedIndex];
      insertMentionFromAutocomplete(chosen);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionAutocomplete();
    }
  });

  function playMentionChime() {
    if (!state.audioContext || state.isDeafened) return;
    try {
      const now = state.audioContext.currentTime;
      const osc1 = state.audioContext.createOscillator();
      const osc2 = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();

      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(587.33, now);
      osc1.frequency.setValueAtTime(880.0, now + 0.09);
      osc2.frequency.setValueAtTime(1174.66, now + 0.09);

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(state.audioContext.destination);

      osc1.start(now);
      osc2.start(now + 0.09);
      osc1.stop(now + 0.4);
      osc2.stop(now + 0.4);
    } catch (e) {}
  }

  function showToast(title, subtitle, icon = '🔔', onClick = null) {
    if (isLocalFullscreenOrVideoPlaying()) return;
    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.innerHTML = `
      <div class="toast-icon">${icon}</div>
      <div class="toast-content">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(subtitle)}</span>
      </div>
    `;
    toast.addEventListener('click', () => {
      if (onClick) onClick();
      toast.remove();
    });
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      setTimeout(() => toast.remove(), 220);
    }, 4200);
  }

  function openImageLightbox(src, name = 'imagem.png') {
    state.lightbox.scale = 1;
    state.lightbox.panX = 0;
    state.lightbox.panY = 0;
    el.lightboxImg.src = src;
    el.lightboxCaption.textContent = name;
    el.btnLightboxDownload.href = src;
    el.btnLightboxDownload.download = name;
    applyLightboxTransform();
    el.imageLightbox.classList.remove('hidden');
  }

  function closeImageLightbox() {
    el.imageLightbox.classList.add('hidden');
    el.lightboxImg.src = '';
  }

  function applyLightboxTransform() {
    el.lightboxImg.style.transform = `translate3d(${state.lightbox.panX}px, ${state.lightbox.panY}px, 0) scale(${state.lightbox.scale})`;
    el.lightboxZoomLabel.textContent = `${Math.round(state.lightbox.scale * 100)}%`;
  }

  el.btnZoomIn?.addEventListener('click', () => {
    state.lightbox.scale = Math.min(4, +(state.lightbox.scale + 0.25).toFixed(2));
    applyLightboxTransform();
  });

  el.btnZoomOut?.addEventListener('click', () => {
    state.lightbox.scale = Math.max(0.5, +(state.lightbox.scale - 0.25).toFixed(2));
    if (state.lightbox.scale === 1) { state.lightbox.panX = 0; state.lightbox.panY = 0; }
    applyLightboxTransform();
  });

  el.btnZoomReset?.addEventListener('click', () => {
    state.lightbox.scale = 1;
    state.lightbox.panX = 0;
    state.lightbox.panY = 0;
    applyLightboxTransform();
  });

  el.btnCloseLightbox?.addEventListener('click', closeImageLightbox);
  el.lightboxStage?.addEventListener('click', (e) => {
    if (e.target === el.lightboxStage) closeImageLightbox();
  });

  el.lightboxStage?.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    state.lightbox.scale = Math.min(4, Math.max(0.5, +(state.lightbox.scale + delta).toFixed(2)));
    if (state.lightbox.scale <= 1) { state.lightbox.panX = 0; state.lightbox.panY = 0; }
    applyLightboxTransform();
  }, { passive: false });

  el.lightboxStage?.addEventListener('mousedown', (e) => {
    if (state.lightbox.scale <= 1) return;
    state.lightbox.isDragging = true;
    state.lightbox.startX = e.clientX - state.lightbox.panX;
    state.lightbox.startY = e.clientY - state.lightbox.panY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.lightbox.isDragging) return;
    state.lightbox.panX = e.clientX - state.lightbox.startX;
    state.lightbox.panY = e.clientY - state.lightbox.startY;
    applyLightboxTransform();
  });

  window.addEventListener('mouseup', () => {
    state.lightbox.isDragging = false;
  });

  window.addEventListener('paste', (e) => {
    if (!state.user || el.appShell.classList.contains('hidden')) return;
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) return;
        const ext = blob.type.split('/')[1] || 'png';
        const fileName = `print_${new Date().toLocaleTimeString('pt-BR').replace(/:/g, '-')}.${ext}`;
        stageImageForSending(blob, fileName);
        break;
      }
    }
  });

  function stageImageForSending(fileOrBlob, customName) {
    const reader = new FileReader();
    reader.onload = () => {
      const name = customName || fileOrBlob.name || 'imagem.png';
      const sizeStr = (fileOrBlob.size / 1024).toFixed(1) + ' KB';
      state.stagedFile = {
        name,
        size: fileOrBlob.size,
        type: fileOrBlob.type || 'image/png',
        dataUrl: reader.result
      };
      el.clipboardPreviewImg.src = reader.result;
      el.clipboardPreviewName.textContent = name;
      el.clipboardPreviewSize.textContent = `${sizeStr} • Prima Enter para enviar`;
      el.clipboardPreviewBar.classList.remove('hidden');
      el.chatInput.focus();
    };
    reader.readAsDataURL(fileOrBlob);
  }

  el.btnCancelClipboard?.addEventListener('click', () => {
    state.stagedFile = null;
    el.clipboardPreviewBar.classList.add('hidden');
  });

  el.btnCancelReply?.addEventListener('click', () => {
    state.replyingTo = null;
    el.replyPreviewBar.classList.add('hidden');
  });

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.mentionState.active) return;

    const text = el.chatInput.value.trim();
    if (!text && !state.stagedFile) return;

    socket.emit('chat:message', {
      text,
      replyTo: state.replyingTo,
      file: state.stagedFile || null
    });

    el.chatInput.value = '';
    state.replyingTo = null;
    state.stagedFile = null;
    el.replyPreviewBar.classList.add('hidden');
    el.clipboardPreviewBar.classList.add('hidden');
    closeMentionAutocomplete();
  });

  el.btnToggleEmoji?.addEventListener('click', () => {
    el.emojiPickerBar.classList.toggle('hidden');
  });
  document.querySelectorAll('.emoji-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.chatInput.value += btn.textContent;
      el.chatInput.focus();
    });
  });

  el.btnAttachFile?.addEventListener('click', () => el.fileInputHidden.click());
  el.fileInputHidden?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleFileUpload(e.target.files[0]);
    el.fileInputHidden.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    el.chatDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzoneOverlay.classList.remove('hidden');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    el.chatDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzoneOverlay.classList.add('hidden');
    });
  });

  el.chatDropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileUpload(file);
  });

  function handleFileUpload(file) {
    if (file.size > 60 * 1024 * 1024) {
      showToast('Ficheiro demasiado grande', 'O limite para envio instantâneo é de 60 MB.', '⚠️');
      return;
    }
    if (file.type.startsWith('image/')) {
      stageImageForSending(file, file.name);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      socket.emit('chat:message', {
        text: el.chatInput.value.trim(),
        replyTo: state.replyingTo,
        file: {
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          dataUrl: reader.result
        }
      });
      el.chatInput.value = '';
      state.replyingTo = null;
      el.replyPreviewBar.classList.add('hidden');
    };
    reader.readAsDataURL(file);
  }

  // ================= 9. EVENTOS DE SALA E AUDITOR CONTÍNUO DE MALHA E VOZ =================
  socket.on('rooms:update', (rooms) => {
    state.rooms = rooms;
    renderRoomsList();
    const current = rooms.find(r => r.id === state.currentRoomId);
    if (current) renderParticipantsList(current.users);
  });

  socket.on('peer:joined', ({ user }) => {
    if (!user || user.socketId === socket.id) return;
    if (!state.roomUsers.some(u => u.socketId === user.socketId)) {
      state.roomUsers.push(user);
    }
    playRoomSoundEffect('peer-join');
    createPeerConnection(user.socketId, user, false);
    dispatchSmartNotification(
      `${user.name} entrou na sala`,
      `@${user.nick} juntou-se ao canal de voz.`,
      '👋'
    );
  });

  socket.on('peer:left', ({ socketId }) => {
    playRoomSoundEffect('peer-leave');
    state.myStreamViewers.delete(socketId);
    state.speakingPeers.delete(socketId);
    state.lastVideoBytesReceived.delete(socketId);
    updateBroadcasterControlPanel();
    cleanupSinglePeer(socketId);
    syncDesktopOverlayState();
  });

  socket.on('peer:state-updated', ({ socketId, patch }) => {
    const peerObj = state.peers.get(socketId);
    if (peerObj && patch) {
      Object.assign(peerObj.user, patch);
      if (patch.voiceStreamId) peerObj.voiceStreamId = patch.voiceStreamId;
      if (patch.screenStreamId !== undefined) peerObj.screenStreamId = patch.screenStreamId;
      if (patch.isStreaming === false) {
        peerObj.webrtcVideoConfirmed = false;
        peerObj.screenAudioTrackId = null;
        peerObj.screenVideoTrackId = null;
        peerObj.screenStream = null;
        removeStreamTile(socketId);
      } else if (patch.isStreaming === true) {
        state.stoppedWatchingPeers.delete(socketId);
        if (peerObj.screenStream && peerObj.screenStream.getVideoTracks().length > 0) {
          renderOrUpdateStreamTile(socketId, peerObj.user, peerObj.screenStream, false, true);
        } else {
          socket.emit('webrtc:signal', { to: socketId, data: { requestStreamOffer: true } });
        }
      }
    }
    const uInRoom = state.roomUsers.find(u => u.socketId === socketId);
    if (uInRoom && patch) {
      Object.assign(uInRoom, patch);
      renderParticipantsList(state.roomUsers);
    } else {
      syncDesktopOverlayState();
    }
  });

  socket.on('chat:new-message', (msg) => appendChatMessage(msg, true));

  socket.on('room:invite', (invite) => {
    if (!invite) return;
    dispatchSmartNotification(
      `Convite de @${invite.fromNick || 'utilizador'}`,
      `Convidou-o para a sala "${invite.roomName || 'Sala'}"`,
      '📩'
    );
  });

  socket.on('disconnect', () => {
    el.netStatusDot.className = 'dot-indicator reconnecting';
    el.netStatusText.textContent = 'A reconectar...';
  });

  socket.on('connect', () => {
    el.netStatusDot.className = 'dot-indicator online';
    el.netStatusText.textContent = state.serverMode === 'cloud' && state.cloudServerUrl ? 'Cloud 24/7' : 'Ligado';
    if (state.user && state.currentRoomId && !state.isLoggingIn) {
      socket.emit('user:register', state.user, () => {
        joinRoom(state.currentRoomId);
      });
    }
  });

  // Loop de 50ms: Apenas Deteção Visual de Voz (Zero interferência ou ducking no áudio da live)
  setInterval(() => {
    const buf = new Uint8Array(128);
    let overlayDirty = false;

    for (const [peerId, peerObj] of state.peers.entries()) {
      const card = document.getElementById(`participant-card-${peerId}`);
      if (!card || !peerObj.remoteAnalyser || peerObj.user?.isMuted) {
        if (card) card.classList.remove('speaking');
        if (state.speakingPeers.has(peerId)) {
          state.speakingPeers.delete(peerId);
          overlayDirty = true;
        }
        continue;
      }
      peerObj.remoteAnalyser.getByteFrequencyData(buf);
      let s = 0;
      for (let i = 4; i < 40; i++) s += buf[i];
      const isTalking = (s / 36) > 12;
      card.classList.toggle('speaking', isTalking);

      if (isTalking) {
        state.lastRemoteVoiceActivityAt = performance.now();
      }

      const hadSpeaking = state.speakingPeers.has(peerId);
      if (isTalking && !hadSpeaking) {
        state.speakingPeers.add(peerId);
        overlayDirty = true;
      } else if (!isTalking && hadSpeaking) {
        state.speakingPeers.delete(peerId);
        overlayDirty = true;
      }
    }

    if (overlayDirty) {
      syncDesktopOverlayState();
    }
  }, 50);

  // Auditor Contínuo de Saúde da Malha de Voz, Transmissões e Telemetria (a cada 1.8s)
  setInterval(async () => {
    let bestRtt = null;
    let totalLost = 0;
    let totalPackets = 0;

    const localMicTrack = state.localVoiceStream?.getAudioTracks()[0];
    if (state.user && (!localMicTrack || localMicTrack.readyState === 'ended')) {
      await recoverMicrophoneAutomatically();
    } else {
      updateLocalMicTrackEnabledState();
    }

    if (state.currentRoomId && Array.isArray(state.roomUsers)) {
      state.roomUsers.forEach((u) => {
        if (u.socketId && u.socketId !== socket.id && !state.peers.has(u.socketId)) {
          const shouldInitiate = socket.id < u.socketId;
          createPeerConnection(u.socketId, u, shouldInitiate);
        }
      });
    }

    document.querySelectorAll('#remote-voice-audios audio').forEach((a) => {
      if (a.srcObject && a.paused) {
        a.play().catch(() => {});
      }
    });

    document.querySelectorAll('.stream-tile video.stream-webrtc-video').forEach((v) => {
      if (v.srcObject && v.paused) {
        v.play().catch(() => {});
      }
      if (v.videoWidth > 0) {
        v.classList.add('webrtc-has-frames');
        applyOptimalVideoShaderClass(v);
        const tile = v.closest('.stream-tile');
        tile?.querySelector('img.stream-relay-img')?.classList.add('hidden');
      }
    });

    if (state.isStreaming) {
      enforceHighQualityForAllViewers();
    }

    for (const [peerId, peerObj] of state.peers.entries()) {
      if (peerObj.pc.signalingState === 'stable') {
        peerObj.suppressAutoNegotiation = true;
        const fixedLocalVoice = ensureLocalAudioSenderOnPeer(peerObj);
        peerObj.suppressAutoNegotiation = false;
        if (fixedLocalVoice) {
          negotiateWithPeer(peerId, peerObj);
        }
      }

      reconcilePeerMediaTracks(peerId, peerObj);

      if (peerObj.user?.isStreaming && !state.stoppedWatchingPeers.has(peerId) && !document.getElementById(`stream-tile-${peerId}`)) {
        socket.emit('webrtc:signal', { to: peerId, data: { requestStreamOffer: true } });
      }

      const stats = await peerObj.pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
          bestRtt = Math.round(report.currentRoundTripTime * 1000);
        }
        if (report.type === 'inbound-rtp') {
          totalLost += report.packetsLost || 0;
          totalPackets += (report.packetsReceived || 0) + (report.packetsLost || 0);

          if (report.kind === 'video' && state.focusedPeerId === peerId) {
            const fps = report.framesPerSecond || state.streamSettings.fps;
            const width = report.frameWidth || 1280;
            const height = report.frameHeight || 720;
            const nowMs = performance.now();
            const prevBytesObj = state.lastVideoBytesReceived.get(peerId);
            let mbpsStr = '';
            if (prevBytesObj && report.bytesReceived != null && nowMs > prevBytesObj.time) {
              const deltaBits = (report.bytesReceived - prevBytesObj.bytes) * 8;
              const deltaSec = (nowMs - prevBytesObj.time) / 1000;
              const mbps = Math.max(0.1, deltaBits / deltaSec / 1000000).toFixed(1);
              mbpsStr = ` • ${mbps} Mbps`;
            }
            if (report.bytesReceived != null) {
              state.lastVideoBytesReceived.set(peerId, { bytes: report.bytesReceived, time: nowMs });
            }
            el.focusedTelemetryHud.textContent = `${width}×${height} • ${Math.round(fps)} FPS${mbpsStr}`;
          }
        }
      });
    }

    el.telemetryPing.textContent = `${bestRtt !== null ? bestRtt : 4} ms`;
    const lossPct = totalPackets > 0 ? ((totalLost / totalPackets) * 100).toFixed(1) : '0.0';
    el.telemetryLoss.textContent = `${lossPct}%`;
  }, 1800);

  function cleanupSinglePeer(peerId) {
    state.myStreamViewers.delete(peerId);
    state.speakingPeers.delete(peerId);
    state.lastVideoBytesReceived.delete(peerId);
    updateBroadcasterControlPanel();
    const peerObj = state.peers.get(peerId);
    if (!peerObj) return;
    peerObj.pc.close();
    detachVoicePipeline(peerObj);
    removeStreamTile(peerId);
    state.peers.delete(peerId);
    syncDesktopOverlayState();
  }

  function cleanupAllPeers() {
    for (const peerId of state.peers.keys()) {
      cleanupSinglePeer(peerId);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();