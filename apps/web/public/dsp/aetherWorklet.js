class AetherVoiceGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseGateEnabled = true;
    this.noiseGateThresholdDb = -52;
    this.voiceMode = 'vad'; // 'vad' | 'ptt'
    this.vadSensitivityDb = -48;
    this.pttActive = false;
    this.muted = false;

    this.currentGain = 0;
    this.holdSamplesRemaining = 0;
    this.vadHoldSamplesRemaining = 0;
    this.samplesSinceReport = 0;
    this.smoothedDb = -96;
    this.lastSpeaking = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.noiseGateEnabled === 'boolean') this.noiseGateEnabled = msg.noiseGateEnabled;
      if (typeof msg.noiseGateThresholdDb === 'number') this.noiseGateThresholdDb = msg.noiseGateThresholdDb;
      if (msg.voiceMode === 'vad' || msg.voiceMode === 'ptt') this.voiceMode = msg.voiceMode;
      if (typeof msg.vadSensitivityDb === 'number') this.vadSensitivityDb = msg.vadSensitivityDb;
      if (typeof msg.pttActive === 'boolean') this.pttActive = msg.pttActive;
      if (typeof msg.muted === 'boolean') this.muted = msg.muted;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const frameLen = output[0].length;
    if (!input || input.length === 0 || !input[0]) {
      for (let c = 0; c < output.length; c++) {
        output[c].fill(0);
      }
      return true;
    }

    const inChan = input[0];
    let sumSq = 0;
    for (let i = 0; i < inChan.length; i++) {
      const s = inChan[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / inChan.length);
    const instantDb = rms > 1e-6 ? 20 * Math.log10(rms) : -96;
    this.smoothedDb = instantDb > this.smoothedDb
      ? this.smoothedDb * 0.45 + instantDb * 0.55
      : this.smoothedDb * 0.85 + instantDb * 0.15;

    const holdSamples = Math.round(sampleRate * 0.18); // 180ms hold
    const vadHoldSamples = Math.round(sampleRate * 0.24); // 240ms natural speech syllable hold

    // 1. Noise Gate decision with 4 dB hysteresis
    let gateOpen = true;
    if (this.noiseGateEnabled) {
      const openThresh = this.noiseGateThresholdDb;
      const closeThresh = openThresh - 4;
      if (instantDb >= openThresh) {
        this.holdSamplesRemaining = holdSamples;
        gateOpen = true;
      } else if (instantDb >= closeThresh && this.holdSamplesRemaining > 0) {
        gateOpen = true;
      } else if (this.holdSamplesRemaining > 0) {
        this.holdSamplesRemaining = Math.max(0, this.holdSamplesRemaining - frameLen);
        gateOpen = true;
      } else {
        gateOpen = false;
      }
    }

    // 2. Voice Mode (VAD vs Push-To-Talk)
    let voiceOpen = false;
    if (this.muted) {
      voiceOpen = false;
    } else if (this.voiceMode === 'ptt') {
      voiceOpen = this.pttActive;
    } else {
      if (instantDb >= this.vadSensitivityDb) {
        this.vadHoldSamplesRemaining = vadHoldSamples;
        voiceOpen = true;
      } else if (this.vadHoldSamplesRemaining > 0) {
        this.vadHoldSamplesRemaining = Math.max(0, this.vadHoldSamplesRemaining - frameLen);
        voiceOpen = true;
      } else {
        voiceOpen = false;
      }
    }

    const targetOpen = !this.muted && gateOpen && voiceOpen;
    const attackCoeff = 1 - Math.exp(-1 / (sampleRate * 0.003)); // 3ms crisp attack
    const releaseCoeff = 1 - Math.exp(-1 / (sampleRate * 0.09)); // 90ms smooth release

    for (let i = 0; i < frameLen; i++) {
      const target = targetOpen ? 1.0 : 0.0;
      const coeff = target > this.currentGain ? attackCoeff : releaseCoeff;
      this.currentGain += (target - this.currentGain) * coeff;

      for (let c = 0; c < output.length; c++) {
        const src = input[c] || inChan;
        output[c][i] = src[i] * this.currentGain;
      }
    }

    this.samplesSinceReport += frameLen;
    const speakingNow = targetOpen && this.currentGain > 0.15;
    if (this.samplesSinceReport >= Math.round(sampleRate * 0.02) || speakingNow !== this.lastSpeaking) {
      this.samplesSinceReport = 0;
      this.lastSpeaking = speakingNow;
      this.port.postMessage({
        type: 'meter',
        db: Math.max(-96, Math.min(0, this.smoothedDb)),
        speaking: speakingNow,
      });
    }

    return true;
  }
}

class AetherPcmBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 48kHz * 2 channels * 0.5 sec ring buffer
    this.capacity = 48000;
    this.leftBuf = new Float32Array(this.capacity);
    this.rightBuf = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || !data.interleaved) return;
      const interleaved = data.interleaved; // Float32Array [L, R, L, R...]
      const frames = interleaved.length >> 1;

      // Prevent drift accumulation if buffer gets > 140ms (~6720 frames)
      if (this.available + frames > 7200) {
        const drop = this.available + frames - 3840;
        this.readIndex = (this.readIndex + drop) % this.capacity;
        this.available = Math.max(0, this.available - drop);
      }

      for (let i = 0; i < frames; i++) {
        this.leftBuf[this.writeIndex] = interleaved[i * 2];
        this.rightBuf[this.writeIndex] = interleaved[i * 2 + 1];
        this.writeIndex = (this.writeIndex + 1) % this.capacity;
      }
      this.available = Math.min(this.capacity, this.available + frames);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const leftOut = out[0];
    const rightOut = out[1] || out[0];
    const len = leftOut.length;

    for (let i = 0; i < len; i++) {
      if (this.available > 0) {
        leftOut[i] = this.leftBuf[this.readIndex];
        rightOut[i] = this.rightBuf[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.available--;
      } else {
        leftOut[i] = 0;
        rightOut[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('aether-voice-gate-processor', AetherVoiceGateProcessor);
registerProcessor('aether-pcm-bridge-processor', AetherPcmBridgeProcessor);

