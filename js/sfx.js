import { S } from './state.js';

/* ── Sound-effect map ── */
export const SFX = {
  swoosh:          '/sounds/swoosh.mp3',
  rise:            '/sounds/cinematic-rise.mp3',
  freeze:          '/sounds/freeze.mp3',
  glitch:          '/sounds/glitch.mp3',
  clock:           '/sounds/clock.mp3',
  ambienceValley:  '/sounds/ambience-valley.mp3',
  ambienceHorror:  '/sounds/ambience-horror.mp3',
  ambienceOffice:  '/sounds/ambience-office.mp3',
  countdown:       '/countdown.mp3',
};

/* ── Countdown beep (synthesised tone) ── */
export function playCountdownBeep(frequency, duration) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = frequency || 800;
    gain.gain.value = 0.6;
    osc.start();
    const dur = duration || 0.2;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.stop(ctx.currentTime + dur);
    setTimeout(() => ctx.close(), 500);
  } catch (e) { console.warn('[beep] error:', e.message); }
}

/* ── Web Audio unlock (call on first user gesture) ── */
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!S._audioCtx) S._audioCtx = new Ctx();
    if (S._audioCtx.state === 'suspended') S._audioCtx.resume();
    const buf = S._audioCtx.createBuffer(1, 1, 22050);
    const src = S._audioCtx.createBufferSource();
    src.buffer = buf; src.connect(S._audioCtx.destination); src.start(0);
    const el = document.getElementById('ttsAudioEl');
    if (el) {
      el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      el.volume = 0;
      el.play().then(() => { el.volume = 1; }).catch(() => {});
    }
    S._audioUnlocked = true;
  } catch (e) {}
}

/* ── Play a keyed SFX from the cache ── */
export function playSfx(key, vol = 0.5) {
  const src = SFX[key]; if (!src) return;
  try {
    if (!S.sfxCache[key]) S.sfxCache[key] = new Audio(src);
    const a = S.sfxCache[key];
    a.volume = Math.min(1, Math.max(0, vol));
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch (e) {}
}
