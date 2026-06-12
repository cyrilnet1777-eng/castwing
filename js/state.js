// ── Centralised mutable state ────────────────────────────────────────
// Every global `let` from the monolith lives here as a property of `S`.
// Import S everywhere; mutate via S.prop = value.

import { AUDITION_WINDOW_MS } from './constants.js';

export const S = {

  // ── Session / mode ─────────────────────────────────────────────────
  role:             'actor',
  sessionMode:      'ai',
  mode:             'ai',

  // ── WebRTC / peer ──────────────────────────────────────────────────
  peer:             null,
  conn:             null,
  call:             null,
  localStream:      null,
  connectionTimeout: null,
  _cachedIceServers: null,
  _iceExpiry:        0,
  _peerKeepalive:    null,
  _analyticsSid:     '',

  // ── Recording ──────────────────────────────────────────────────────
  mediaRecorder:    null,
  recordedChunks:   [],
  isRecording:      false,
  _recAudioCtx:     null,
  _recDest:         null,
  _recMicSource:    null,
  _recMicGain:      null,
  _recStream:       null,
  _recStopIntentional: false,

  // ── Media controls ─────────────────────────────────────────────────
  isMicOn:          true,
  isCamOn:          true,
  currentFacingMode: 'user',

  // ── Prompter / script navigation ───────────────────────────────────
  prompterLines:    [],
  prompterIndex:    0,
  userScrolledUp:   false,
  _lastPrompterScrollTop: 0,
  _scrollResumeTimer: null,

  // ── Script data ────────────────────────────────────────────────────
  selectedChar:     null,
  pdfScript:        [],
  /** Source brute (PDF ou collage) — jamais reecrite par le parseur */
  scriptRawText:    '',
  /** Cles normalisees des personnages (liste Claude + principaux forces) */
  scriptValidatedCharKeys: null,
  _scriptReviewCtx: null,
  _bgRefinementToken: 0,
  /** Annule le parse « fin de script » lance apres un parse tete (gros PDF) */
  _fastFullParseToken: 0,
  takeNumber:       0,
  currentTake:      null,
  prompterPace:     'normal',
  monologueBlocks:  [],
  currentScriptName: '',

  // ── Voice / TTS ────────────────────────────────────────────────────
  VOICE_PRESETS:    [],
  selectedVoice:    null,
  selectedEmotion:  'neutral',
  selectedLocale:   'french',
  selectedUILanguage: 'en',
  voiceSpeed:       4,
  availableVoices:  [],
  presetVoiceMap:   {},
  soloPartnerMode:  'all',
  soloPartnerChar:  null,
  lockedVoiceLocale: '',
  _preItalienneVoice: null,
  _preItalienneEmotion: 'neutral',

  // ── ElevenLabs fallback / backoff ──────────────────────────────────
  ttsEndpointCache: '',
  elevenLabsTemporarilyDisabled: false,
  elevenLabsFallbackNotified: false,
  elevenLabsBackoffTimer: null,
  elevenLabsDisableReason: '',
  unavailableElevenVoiceIds: new Set(),
  unavailableVoiceToastShown: new Set(),

  // ── Auth ───────────────────────────────────────────────────────────
  authFlowToken:    '',
  authPendingEmail: '',
  _authCodeSending: false,
  _pendingFileAfterAuth: null,
  userAccess: {
    email: '', verified: false, provider: '',
    paid: false, usageMs: 0, cooldownUntil: 0, lastTick: 0,
  },
  cwServerSession: {
    email: null, isAdmin: false, plan: 'visitor',
    creditsRemaining: null, creditBalance: 0,
    autoTopupCents: 0, billingMode: 'credits',
  },

  // ── Timer / chrono ─────────────────────────────────────────────────
  usageTimer:       null,
  sessionTimerInterval: null,
  sessionTimerFrozen: false,
  sessionPaused:    false,
  chronoRafId:      null,
  chronoRunning:    false,
  chronoLastTs:     0,
  chronoLowSoundArmed: true,
  chronoHadPositiveBalance: false,
  chronoPaywallShown: false,
  chronoWarn5minShown: false,

  // ── Auto-advance / speech token ────────────────────────────────────
  autoAdvanceTimer: null,
  lastAutoSpokenIndex: -1,
  activeSpeechToken: 0,

  // ── Audio / TTS playback ───────────────────────────────────────────
  ttsAudio:         null,
  lastTTSEndTs:     0,
  sfxCache:         {},
  _audioUnlocked:   false,
  _audioCtx:        null,

  // ── VAD (voice activity detection) ─────────────────────────────────
  vad:              null,

  // ── View mode ──────────────────────────────────────────────────────
  sessionViewMode:  '50-50',   // overwritten by initState()
};

/**
 * One-time reads from localStorage that must happen after DOM-ready
 * (or at least after localStorage is available).
 */
export function initState() {
  S.sessionViewMode = localStorage.getItem('cw_viewMode') || '50-50';
  const pace = localStorage.getItem('cw_prompterPace');
  if (pace === 'slow' || pace === 'normal' || pace === 'fast') S.prompterPace = pace;
  try { S._analyticsSid = crypto.randomUUID(); } catch (_e) { S._analyticsSid = 'sid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10); }
}

/**
 * Install window.pdfScript / window.scriptRawText accessors that
 * proxy through S, so legacy code that touches `window.pdfScript`
 * still works.
 */
export function installWindowProperties() {
  try {
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'pdfScript', {
        configurable: true,
        enumerable:   true,
        get()  { return Array.isArray(S.pdfScript) ? S.pdfScript : []; },
        set(v) { S.pdfScript = Array.isArray(v) ? v : []; },
      });
      Object.defineProperty(window, 'scriptRawText', {
        configurable: true,
        enumerable:   true,
        get()  { return typeof S.scriptRawText === 'string' ? S.scriptRawText : ''; },
        set()  { /* read-only */ },
      });
    }
  } catch (_e) { /* silently ignore in non-browser environments */ }
}
