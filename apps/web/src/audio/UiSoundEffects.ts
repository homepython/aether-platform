let fxCtx: AudioContext | null = null;

function getFxContext(): AudioContext | null {
  try {
    if (!fxCtx || fxCtx.state === 'closed') {
      fxCtx = new AudioContext();
    }
    if (fxCtx.state === 'suspended') {
      void fxCtx.resume().catch(() => {});
    }
    return fxCtx;
  } catch {
    return null;
  }
}

function playToneSequence(notes: { freq: number; delay: number; duration: number; gain?: number }[]) {
  const ctx = getFxContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(n.freq, now + n.delay);

    const peak = n.gain ?? 0.06;
    gain.gain.setValueAtTime(0.0001, now + n.delay);
    gain.gain.exponentialRampToValueAtTime(peak, now + n.delay + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.delay + n.duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + n.delay);
    osc.stop(now + n.delay + n.duration + 0.02);
  }
}

export const uiSounds = {
  joinRoom: () =>
    playToneSequence([
      { freq: 523.25, delay: 0, duration: 0.09, gain: 0.05 },
      { freq: 783.99, delay: 0.065, duration: 0.14, gain: 0.055 },
    ]),
  leaveRoom: () =>
    playToneSequence([
      { freq: 659.25, delay: 0, duration: 0.08, gain: 0.045 },
      { freq: 440.0, delay: 0.06, duration: 0.13, gain: 0.045 },
    ]),
  mute: () => playToneSequence([{ freq: 392.0, delay: 0, duration: 0.07, gain: 0.04 }]),
  unmute: () => playToneSequence([{ freq: 587.33, delay: 0, duration: 0.07, gain: 0.04 }]),
  mention: () =>
    playToneSequence([
      { freq: 659.25, delay: 0, duration: 0.08, gain: 0.065 },
      { freq: 880.0, delay: 0.075, duration: 0.16, gain: 0.065 },
    ]),
  streamStart: () =>
    playToneSequence([
      { freq: 523.25, delay: 0, duration: 0.08, gain: 0.05 },
      { freq: 659.25, delay: 0.06, duration: 0.08, gain: 0.05 },
      { freq: 1046.5, delay: 0.12, duration: 0.18, gain: 0.06 },
    ]),
};

