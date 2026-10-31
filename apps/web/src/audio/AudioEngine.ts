import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import type { AudioSettings, PeerAudioOverride } from '@aether/shared';
import { resolveServerAssetUrl } from '../api/httpClient.js';

interface RemoteVoiceChain {
  peerId: string;
  userId: string;
  keepAliveAudio: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode;
  rnnoiseNode: RnnoiseWorkletNode | null;
  dryDelayNode: DelayNode;
  dryGainNode: GainNode;
  wetGainNode: GainNode;
  userGainNode: GainNode;
  override: PeerAudioOverride;
  speakingTimer: number | null;
  analyser: AnalyserNode;
}

interface StreamAudioChain {
  streamId: string;
  keepAliveAudio: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  volume: number; // 0..200
  muted: boolean;
}

export class AudioEngine {
  private voiceCtx: AudioContext | null = null;
  private streamCtx: AudioContext | null = null;
  private wasmBinary: ArrayBuffer | null = null;
  private voiceWorkletsLoaded = false;
  private streamWorkletsLoaded = false;

  // Sender Mic Chain
  private rawMicStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private highPassFilter: BiquadFilterNode | null = null;
  private inputGainNode: GainNode | null = null;
  private senderRnnoise: RnnoiseWorkletNode | null = null;
  private senderDryDelay: DelayNode | null = null;
  private senderDryGain: GainNode | null = null;
  private senderWetGain: GainNode | null = null;
  private gateWorkletNode: AudioWorkletNode | null = null;
  private processedMicDest: MediaStreamAudioDestinationNode | null = null;
  private loopbackTestGain: GainNode | null = null;

  // Receiver Voice Bus (completely decoupled from Stream Audio Bus)
  private masterVoiceOutGain: GainNode | null = null;
  private remotePeers = new Map<string, RemoteVoiceChain>();

  // Receiver Live Stream Audio Bus (isolated context — ZERO ducking invariant)
  private streamAudioChains = new Map<string, StreamAudioChain>();

  // Native Desktop WASAPI Process-Loopback Bridge
  private nativePcmNode: AudioWorkletNode | null = null;
  private nativePcmDest: MediaStreamAudioDestinationNode | null = null;

  private currentSettings: AudioSettings | null = null;
  private localMicMuted = false;
  private localDeafened = false;
  private pttPressed = false;
  private pttReleaseTimer: number | null = null;

  public onMeterUpdate?: (db: number, speaking: boolean) => void;

  private resolveDspUrl(filename: string): string {
    return new URL(`./dsp/${filename}`, window.location.href).toString();
  }

  private async addWorkletModuleResilient(ctx: AudioContext, filename: string): Promise<void> {
    const primaryUrl = this.resolveDspUrl(filename);
    try {
      await ctx.audioWorklet.addModule(primaryUrl);
      return;
    } catch {
      // Fallback: load script text from server or local bundle and register via Blob URL
      const fallbackUrl = resolveServerAssetUrl(`/dsp/${filename}`);
      const res = await fetch(fallbackUrl);
      if (!res.ok) {
        throw new Error(`Falha ao carregar módulo DSP ${filename}`);
      }
      const scriptText = await res.text();
      const blob = new Blob([scriptText], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
  }

  private async ensureWasmBinary(): Promise<ArrayBuffer | null> {
    if (this.wasmBinary) return this.wasmBinary;
    try {
      this.wasmBinary = await loadRnnoise({
        url: this.resolveDspUrl('rnnoise.wasm'),
        simdUrl: this.resolveDspUrl('rnnoise_simd.wasm'),
      });
      return this.wasmBinary;
    } catch {
      try {
        this.wasmBinary = await loadRnnoise({
          url: resolveServerAssetUrl('/dsp/rnnoise.wasm'),
          simdUrl: resolveServerAssetUrl('/dsp/rnnoise_simd.wasm'),
        });
        return this.wasmBinary;
      } catch (err) {
        console.warn('[AudioEngine] RNNoise WASM load fallback:', err);
        return null;
      }
    }
  }

  private async ensureVoiceContext(): Promise<AudioContext> {
    if (!this.voiceCtx || this.voiceCtx.state === 'closed') {
      this.voiceCtx = new AudioContext({
        sampleRate: 48000,
        latencyHint: 'interactive',
      });
      this.voiceWorkletsLoaded = false;
      this.masterVoiceOutGain = this.voiceCtx.createGain();
      this.masterVoiceOutGain.gain.value = (this.currentSettings?.outputVolume ?? 100) / 100;
      this.masterVoiceOutGain.connect(this.voiceCtx.destination);
    }

    if (this.voiceCtx.state === 'suspended') {
      await this.voiceCtx.resume().catch(() => {});
    }

    if (!this.voiceWorkletsLoaded) {
      await this.addWorkletModuleResilient(this.voiceCtx, 'aetherWorklet.js');
      await this.addWorkletModuleResilient(this.voiceCtx, 'rnnoiseWorklet.js');
      this.voiceWorkletsLoaded = true;
    }

    return this.voiceCtx;
  }

  private async ensureStreamContext(): Promise<AudioContext> {
    if (!this.streamCtx || this.streamCtx.state === 'closed') {
      this.streamCtx = new AudioContext({
        sampleRate: 48000,
        latencyHint: 'playback',
      });
      this.streamWorkletsLoaded = false;
    }

    if (this.streamCtx.state === 'suspended') {
      await this.streamCtx.resume().catch(() => {});
    }

    if (!this.streamWorkletsLoaded) {
      await this.addWorkletModuleResilient(this.streamCtx, 'aetherWorklet.js');
      this.streamWorkletsLoaded = true;
    }

    return this.streamCtx;
  }

  public async resumeContexts(): Promise<void> {
    if (this.voiceCtx?.state === 'suspended') await this.voiceCtx.resume().catch(() => {});
    if (this.streamCtx?.state === 'suspended') await this.streamCtx.resume().catch(() => {});
  }

  public async startMicrophone(settings: AudioSettings): Promise<MediaStreamTrack> {
    this.currentSettings = settings;
    const ctx = await this.ensureVoiceContext();
    const wasm = await this.ensureWasmBinary();

    this.stopMicrophone();

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellationEnabled,
      noiseSuppression: false, // Handled cleanly by our 48kHz RNNoise SIMD Neural DSP without muffled voice
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
    };
    if (settings.inputDeviceId && settings.inputDeviceId !== 'default') {
      audioConstraints.deviceId = { ideal: settings.inputDeviceId };
    }

    this.rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    this.micSource = ctx.createMediaStreamSource(this.rawMicStream);

    // 80 Hz 2nd-order Butterworth High-Pass Filter (eliminates desk rumble, plosives & AC hum)
    this.highPassFilter = ctx.createBiquadFilter();
    this.highPassFilter.type = 'highpass';
    this.highPassFilter.frequency.value = 80;
    this.highPassFilter.Q.value = 0.707;

    this.inputGainNode = ctx.createGain();
    this.inputGainNode.gain.value = settings.inputVolume / 100;

    // Phase-coherent Dry/Wet Neural Noise Suppression (10ms = 480 samples RNNoise frame alignment)
    this.senderDryDelay = ctx.createDelay(0.05);
    this.senderDryDelay.delayTime.value = wasm ? 0.01 : 0;

    this.senderDryGain = ctx.createGain();
    this.senderWetGain = ctx.createGain();

    if (wasm) {
      this.senderRnnoise = new RnnoiseWorkletNode(ctx, {
        maxChannels: 1,
        wasmBinary: wasm,
      });
    }

    this.gateWorkletNode = new AudioWorkletNode(ctx, 'aether-voice-gate-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.gateWorkletNode.port.onmessage = (ev) => {
      if (ev.data?.type === 'meter') {
        this.onMeterUpdate?.(ev.data.db, ev.data.speaking);
      }
    };

    this.processedMicDest = ctx.createMediaStreamDestination();

    // Optional mic test loopback (STRICTLY 0 gain unless user enables "Testar Microfone" in Settings)
    this.loopbackTestGain = ctx.createGain();
    this.loopbackTestGain.gain.value = 0;

    // Connect Sender DSP Graph
    this.micSource.connect(this.highPassFilter);
    this.highPassFilter.connect(this.inputGainNode);

    this.inputGainNode.connect(this.senderDryDelay);
    this.senderDryDelay.connect(this.senderDryGain);
    this.senderDryGain.connect(this.gateWorkletNode);

    if (this.senderRnnoise) {
      this.inputGainNode.connect(this.senderRnnoise);
      this.senderRnnoise.connect(this.senderWetGain);
      this.senderWetGain.connect(this.gateWorkletNode);
    }

    this.gateWorkletNode.connect(this.processedMicDest);
    this.gateWorkletNode.connect(this.loopbackTestGain);
    if (this.masterVoiceOutGain) {
      this.loopbackTestGain.connect(this.masterVoiceOutGain);
    }

    await this.applyAudioSettings(settings);

    const outTrack = this.processedMicDest.stream.getAudioTracks()[0];
    if (!outTrack) throw new Error('Falha ao inicializar faixa de voz processada');
    return outTrack;
  }

  public stopMicrophone(): void {
    this.setMicLoopbackTest(false);
    try {
      this.micSource?.disconnect();
      this.highPassFilter?.disconnect();
      this.inputGainNode?.disconnect();
      this.senderDryDelay?.disconnect();
      this.senderDryGain?.disconnect();
      this.senderWetGain?.disconnect();
      if (this.senderRnnoise) {
        this.senderRnnoise.disconnect();
        this.senderRnnoise.destroy();
      }
      this.gateWorkletNode?.disconnect();
      this.loopbackTestGain?.disconnect();
    } catch {
      // Ignore disconnect errors on already torn-down nodes
    }
    if (this.rawMicStream) {
      for (const t of this.rawMicStream.getTracks()) t.stop();
    }
    this.rawMicStream = null;
    this.micSource = null;
    this.senderRnnoise = null;
    this.gateWorkletNode = null;
    this.processedMicDest = null;
  }

  public setMicLoopbackTest(enabled: boolean): void {
    if (this.loopbackTestGain && this.voiceCtx) {
      this.loopbackTestGain.gain.setTargetAtTime(enabled ? 1.0 : 0.0, this.voiceCtx.currentTime, 0.015);
    }
  }

  public setLocalMuteAndDeafen(micMuted: boolean, deafened: boolean): void {
    this.localMicMuted = micMuted || deafened;
    this.localDeafened = deafened;
    this.syncGateParameters();
    this.refreshMasterVoiceGain();
  }

  public setPushToTalkPressed(pressed: boolean): void {
    const delayMs = this.currentSettings?.pttReleaseDelayMs ?? 180;
    if (pressed) {
      if (this.pttReleaseTimer !== null) {
        window.clearTimeout(this.pttReleaseTimer);
        this.pttReleaseTimer = null;
      }
      if (!this.pttPressed) {
        this.pttPressed = true;
        this.syncGateParameters();
      }
    } else {
      if (this.pttReleaseTimer !== null) window.clearTimeout(this.pttReleaseTimer);
      this.pttReleaseTimer = window.setTimeout(() => {
        this.pttPressed = false;
        this.pttReleaseTimer = null;
        this.syncGateParameters();
      }, delayMs);
    }
  }

  private syncGateParameters(): void {
    if (!this.gateWorkletNode || !this.currentSettings) return;
    this.gateWorkletNode.port.postMessage({
      noiseGateEnabled: this.currentSettings.noiseGateEnabled,
      noiseGateThresholdDb: this.currentSettings.noiseGateThresholdDb,
      voiceMode: this.currentSettings.voiceMode,
      vadSensitivityDb: this.currentSettings.vadSensitivityDb,
      pttActive: this.pttPressed,
      muted: this.localMicMuted,
    });
  }

  private refreshMasterVoiceGain(): void {
    if (!this.masterVoiceOutGain || !this.voiceCtx) return;
    const vol = this.localDeafened ? 0 : (this.currentSettings?.outputVolume ?? 100) / 100;
    this.masterVoiceOutGain.gain.setTargetAtTime(vol, this.voiceCtx.currentTime, 0.01);
  }

  public async applyAudioSettings(settings: AudioSettings): Promise<void> {
    const prevInputDevice = this.currentSettings?.inputDeviceId;
    const prevEcho = this.currentSettings?.echoCancellationEnabled;
    this.currentSettings = settings;

    if (this.inputGainNode && this.voiceCtx) {
      this.inputGainNode.gain.setTargetAtTime(settings.inputVolume / 100, this.voiceCtx.currentTime, 0.01);
    }

    // Sender Neural Suppression Dry/Wet Mix
    if (this.senderDryGain && this.senderWetGain && this.voiceCtx) {
      const wet =
        this.senderRnnoise && settings.noiseSuppressionEnabled
          ? Math.max(0, Math.min(1, settings.noiseSuppressionLevel / 100))
          : 0;
      const dry = 1 - wet;
      this.senderWetGain.gain.setTargetAtTime(wet, this.voiceCtx.currentTime, 0.015);
      this.senderDryGain.gain.setTargetAtTime(dry, this.voiceCtx.currentTime, 0.015);
    }

    this.syncGateParameters();
    this.refreshMasterVoiceGain();

    // Apply Output Sink ID to both Voice Context and Stream Context
    await this.applySinkId(this.voiceCtx, settings.outputDeviceId);
    await this.applySinkId(this.streamCtx, settings.outputDeviceId);

    // Update all per-user overrides on active remote peers
    for (const chain of this.remotePeers.values()) {
      const override = settings.peerOverrides[chain.userId] || {
        volume: 100,
        muted: false,
        noiseReductionEnabled: false,
        noiseReductionLevel: 50,
      };
      await this.updatePeerChainOverride(chain, override);
    }

    // If input device or hardware AEC changed while mic is active, hot-swap input stream
    if (
      this.rawMicStream &&
      ((prevInputDevice && prevInputDevice !== settings.inputDeviceId) ||
        (prevEcho !== undefined && prevEcho !== settings.echoCancellationEnabled))
    ) {
      await this.hotSwapRawMicInput(settings);
    }
  }

  private async hotSwapRawMicInput(settings: AudioSettings): Promise<void> {
    if (!this.voiceCtx || !this.highPassFilter) return;
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellationEnabled,
      noiseSuppression: false,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
    };
    if (settings.inputDeviceId && settings.inputDeviceId !== 'default') {
      audioConstraints.deviceId = { ideal: settings.inputDeviceId };
    }
    const nextRaw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const oldRaw = this.rawMicStream;
    this.micSource?.disconnect();
    this.rawMicStream = nextRaw;
    this.micSource = this.voiceCtx.createMediaStreamSource(nextRaw);
    this.micSource.connect(this.highPassFilter);
    if (oldRaw) {
      for (const t of oldRaw.getTracks()) t.stop();
    }
  }

  private async applySinkId(ctx: AudioContext | null, sinkId: string): Promise<void> {
    if (!ctx) return;
    const anyCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof anyCtx.setSinkId === 'function') {
      const target = sinkId === 'default' ? '' : sinkId;
      await anyCtx.setSinkId(target).catch(() => {});
    }
  }

  /**
   * Attaches a remote participant's voice track with independent per-user Volume (0-200%)
   * AND independent per-user Neural Noise Reduction (0-100%).
   */
  public async attachRemotePeerVoice(
    peerId: string,
    userId: string,
    track: MediaStreamTrack
  ): Promise<void> {
    this.detachRemotePeerVoice(peerId);
    const ctx = await this.ensureVoiceContext();
    const wasm = await this.ensureWasmBinary();

    const stream = new MediaStream([track]);
    // Hidden muted audio element required by Chromium to pump WebRTC RTP packets into WebAudio
    const keepAliveAudio = document.createElement('audio');
    keepAliveAudio.srcObject = stream;
    keepAliveAudio.muted = true;
    keepAliveAudio.setAttribute('playsinline', 'true');
    void keepAliveAudio.play().catch(() => {});

    const sourceNode = ctx.createMediaStreamSource(stream);
    const dryDelayNode = ctx.createDelay(0.05);
    dryDelayNode.delayTime.value = wasm ? 0.01 : 0;
    const dryGainNode = ctx.createGain();
    const wetGainNode = ctx.createGain();
    const userGainNode = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    const rnnoiseNode = wasm
      ? new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasm })
      : null;

    sourceNode.connect(dryDelayNode);
    dryDelayNode.connect(dryGainNode);
    dryGainNode.connect(userGainNode);

    if (rnnoiseNode) {
      sourceNode.connect(rnnoiseNode);
      rnnoiseNode.connect(wetGainNode);
      wetGainNode.connect(userGainNode);
    }

    userGainNode.connect(analyser);
    if (this.masterVoiceOutGain) {
      userGainNode.connect(this.masterVoiceOutGain);
    }

    const override: PeerAudioOverride = this.currentSettings?.peerOverrides[userId] || {
      volume: 100,
      muted: false,
      noiseReductionEnabled: false,
      noiseReductionLevel: 50,
    };

    const chain: RemoteVoiceChain = {
      peerId,
      userId,
      keepAliveAudio,
      sourceNode,
      rnnoiseNode,
      dryDelayNode,
      dryGainNode,
      wetGainNode,
      userGainNode,
      override,
      speakingTimer: null,
      analyser,
    };

    await this.updatePeerChainOverride(chain, override);
    this.remotePeers.set(peerId, chain);
  }

  private async updatePeerChainOverride(
    chain: RemoteVoiceChain,
    override: PeerAudioOverride
  ): Promise<void> {
    if (!this.voiceCtx) return;
    chain.override = override;
    const vol = override.muted ? 0 : override.volume / 100;
    chain.userGainNode.gain.setTargetAtTime(vol, this.voiceCtx.currentTime, 0.015);

    const wet =
      chain.rnnoiseNode && override.noiseReductionEnabled
        ? Math.max(0, Math.min(1, override.noiseReductionLevel / 100))
        : 0;
    const dry = 1 - wet;
    chain.wetGainNode.gain.setTargetAtTime(wet, this.voiceCtx.currentTime, 0.015);
    chain.dryGainNode.gain.setTargetAtTime(dry, this.voiceCtx.currentTime, 0.015);
  }

  public detachRemotePeerVoice(peerId: string): void {
    const chain = this.remotePeers.get(peerId);
    if (!chain) return;
    this.remotePeers.delete(peerId);
    if (chain.speakingTimer !== null) window.clearInterval(chain.speakingTimer);
    try {
      chain.keepAliveAudio.pause();
      chain.keepAliveAudio.srcObject = null;
      chain.sourceNode.disconnect();
      chain.dryDelayNode.disconnect();
      chain.dryGainNode.disconnect();
      chain.wetGainNode.disconnect();
      if (chain.rnnoiseNode) {
        chain.rnnoiseNode.disconnect();
        chain.rnnoiseNode.destroy();
      }
      chain.userGainNode.disconnect();
      chain.analyser.disconnect();
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Attaches a Live Stream stereo audio track on the COMPLETELY ISOLATED Stream AudioContext.
   * REGRA INQUEBRÁVEL Nº 3: Zero coupling with Voice Bus -> 0.00 dB ducking when anyone speaks!
   */
  public async attachStreamAudio(
    streamId: string,
    track: MediaStreamTrack,
    initialVolume = 100
  ): Promise<void> {
    this.detachStreamAudio(streamId);
    const ctx = await this.ensureStreamContext();
    if (this.currentSettings?.outputDeviceId) {
      await this.applySinkId(ctx, this.currentSettings.outputDeviceId);
    }

    const stream = new MediaStream([track]);
    const keepAliveAudio = document.createElement('audio');
    keepAliveAudio.srcObject = stream;
    keepAliveAudio.muted = true;
    keepAliveAudio.setAttribute('playsinline', 'true');
    void keepAliveAudio.play().catch(() => {});

    const sourceNode = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = initialVolume / 100;

    sourceNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    this.streamAudioChains.set(streamId, {
      streamId,
      keepAliveAudio,
      sourceNode,
      gainNode,
      volume: initialVolume,
      muted: false,
    });
  }

  public setStreamVolume(streamId: string, volumePercent: number, muted: boolean): void {
    const chain = this.streamAudioChains.get(streamId);
    if (!chain || !this.streamCtx) return;
    chain.volume = Math.max(0, Math.min(200, volumePercent));
    chain.muted = muted;
    const effective = muted ? 0 : chain.volume / 100;
    chain.gainNode.gain.setTargetAtTime(effective, this.streamCtx.currentTime, 0.01);
  }

  public getStreamAudioGainValue(streamId: string): number | null {
    return this.streamAudioChains.get(streamId)?.gainNode.gain.value ?? null;
  }

  public detachStreamAudio(streamId: string): void {
    const chain = this.streamAudioChains.get(streamId);
    if (!chain) return;
    this.streamAudioChains.delete(streamId);
    try {
      chain.keepAliveAudio.pause();
      chain.keepAliveAudio.srcObject = null;
      chain.sourceNode.disconnect();
      chain.gainNode.disconnect();
    } catch {
      // Ignore
    }
  }

  /**
   * Creates a 48kHz Stereo MediaStreamTrack fed by our Desktop .NET 8 WASAPI Process-Loopback Helper
   * (EXCLUDE_TARGET_PROCESS_TREE / INCLUDE_TARGET_PROCESS_TREE -> mathematically 0% voice echo!).
   */
  public async createNativeLoopbackTrack(): Promise<{
    track: MediaStreamTrack;
    pushInterleavedPcm: (pcm: Float32Array) => void;
    dispose: () => void;
  }> {
    const ctx = await this.ensureStreamContext();
    const pcmNode = new AudioWorkletNode(ctx, 'aether-pcm-bridge-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    pcmNode.connect(dest);

    this.nativePcmNode = pcmNode;
    this.nativePcmDest = dest;

    const track = dest.stream.getAudioTracks()[0];
    return {
      track,
      pushInterleavedPcm: (pcm: Float32Array) => {
        pcmNode.port.postMessage({ interleaved: pcm }, [pcm.buffer]);
      },
      dispose: () => {
        try {
          pcmNode.disconnect();
          for (const t of dest.stream.getTracks()) t.stop();
        } catch {
          // Ignore
        }
        if (this.nativePcmNode === pcmNode) this.nativePcmNode = null;
        if (this.nativePcmDest === dest) this.nativePcmDest = null;
      },
    };
  }

  public clearRoomAudio(): void {
    for (const peerId of Array.from(this.remotePeers.keys())) {
      this.detachRemotePeerVoice(peerId);
    }
    for (const streamId of Array.from(this.streamAudioChains.keys())) {
      this.detachStreamAudio(streamId);
    }
    this.stopMicrophone();
  }
}

export const audioEngine = new AudioEngine();
