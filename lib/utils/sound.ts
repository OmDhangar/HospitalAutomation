/**
 * Web Audio API synthesize for hospital waiting-room & reception chimes.
 *
 * Uses zero external audio files / assets:
 * - 0ms network latency
 * - 100% offline support
 * - Pleasant 2-tone melodic chime (E5 -> C5) with natural acoustic exponential decay
 */

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

/**
 * Plays a pleasant hospital announcement chime (Ding-Dong / Bell).
 *
 * Tone 1: 659.25 Hz (E5)
 * Tone 2: 523.25 Hz (C5)
 */
export function playChime(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Helper to create a rich bell tone with a fundamental + harmonic overtone
    const createBellNote = (freq: number, startTime: number, duration: number, volume: number) => {
      // Fundamental oscillator
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      // Warm subtle overtone for acoustic bell resonance
      const overtone = ctx.createOscillator();
      const overtoneGain = ctx.createGain();
      overtone.type = 'triangle';
      overtone.frequency.setValueAtTime(freq * 2.02, startTime); // slightly detuned 2nd harmonic

      gain.gain.setValueAtTime(volume, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      overtoneGain.gain.setValueAtTime(volume * 0.25, startTime);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration * 0.6);

      osc.connect(gain);
      overtone.connect(overtoneGain);
      gain.connect(ctx.destination);
      overtoneGain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration);
      overtone.start(startTime);
      overtone.stop(startTime + duration);
    };

    // Note 1: E5 (Ding)
    createBellNote(659.25, now, 0.65, 0.4);

    // Note 2: C5 (Dong)
    createBellNote(523.25, now + 0.24, 0.95, 0.45);
  } catch (err) {
    console.warn('Audio chime playback suppressed by browser:', err);
  }
}
