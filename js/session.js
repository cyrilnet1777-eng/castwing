// ── Session Module ──────────────────────────────────────────────────
// Extracted from index.html: session lifecycle, prompter, pause/controls,
// camera/mic, clapperboard, view modes, session mode switching, VAD,
// italienne, emotion lock, scroll handling, and all session helpers.
// This is the LARGEST module — it orchestrates the entire session flow.

import { S } from './state.js';
import { LINE_TYPE } from './constants.js';
import { showToast, escHtml, track, isMobileDevice } from './utils.js';
import { t } from './i18n.js';
import {
  EMOTION_PRESETS, getEmotionSettings, getCurrentVoiceSpeed,
  setVoiceSpeed, renderAllSpeedSliders, setEmotion,
  VOICE_LOCALES, buildVoicePresetsFromLocale, initVoiceGrid,
  populateSessionVoiceSelect, sliderToElevenLabs, SPEED_DEFAULT,
  renderSpeedSlider,
} from './voices.js';
import { aiSpeak, cancelTTSPlayback, normalizeTextForTTS, warmAudioForMobile } from './tts.js';
import { playCountdownBeep, playSfx, unlockAudio } from './sfx.js';
import {
  getUserData, saveUserData, getUserTier, getPlan,
  checkAndApplyResets, getRemainingSessionMs, consumeMs,
  startSessionTimer, stopSessionTimer, freezeTimer, unfreezeTimer,
  fmtTimer, isServerAdmin, updateChronoDisplay, computeLineDelayMs,
  updateTimerBadge, hideTimerBadge, getSpecTier,
  canUseElevenLabs, canUseEmotions, canRecord,
} from './plan-timer.js';
import {
  startRecording, stopRecording, toggleRecording, pauseRecording,
} from './recording.js';
import {
  createPeer, startPartnerSession, joinAsPartner, getIceServers,
  setStatus, syncPrompter, startPeerKeepalive, stopPeerKeepalive,
  setupDataConnection, setupCallHandlers,
} from './webrtc.js';
import { isPdfDialogueRow, getChars, autoAssignVoiceByGender } from './pdf-parse.js';
import {
  fetchServerSession, applyServerSessionUI, persistSettings, loadSettings,
  openAuthModal,
} from './auth.js';
import { persistScriptSnapshotNow } from './idb.js';
import { refreshCreditBalance, showPaywallModal, updateCreditBadge } from './paywall.js';
import {
  buildLines, normalizeCharacterNameForGroup, groupConsecutiveLines,
  pickDefaultRehearsalCharacter, renderPartnerAssignment,
  clearPDF, finishPdfSetupUi,
} from './script-ai.js';
import {
  syncPdfScriptDebugMirror,
} from './pdf-parse.js';
import { showOverlay, hideOverlay } from './utils.js';

// =====================================================================
//  Module-level state (not in S — local to session orchestration)
// =====================================================================

let _vadArmTimer = null;
let _scrollSyncTimer = null;
let _scrollSyncProgrammatic = false;
let _scrollOwner = null;
let _scrollOwnerTimer = null;

// ── Session state (cwSessionActive / cwPendingSessionTag / boot queue) ──
let __cwSessionActive = false;
let __cwPendingSessionTag = null;
let __cwSessionBootTail = Promise.resolve();

if (typeof window !== 'undefined') {
  window.__cwSessionState = {
    active: false,
    source: null,
    startedAt: null,
    phase: 'idle',
    endedAt: null,
    lastEndReason: null,
    lastSkip: null,
    lastSkipReason: null,
  };
}

// ── End-take recording state ──
let _lastRecBlob = null;
let _lastRecFname = '';
let _lastRecMime = '';

// =====================================================================
//  Screen routing
// =====================================================================

const SCREEN_ROUTES = {
  home: '', importScene: 'import', chooseMode: 'choose',
  setupAi: 'solo', partnerChoice: 'partner',
  setupPartner: 'create', joinScreen: 'join', session: 'session',
};
const ROUTE_TO_SCREEN = Object.fromEntries(
  Object.entries(SCREEN_ROUTES).map(([k, v]) => [v, k])
);

function showScreen(id) {
  track('screen_view', { screen_name: id });
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (!el) { console.warn('[showScreen] unknown screen:', id); return; }
  el.classList.add('active');
  const bb = document.getElementById('homeBottomBar');
  if (bb) bb.style.display = id === 'home' ? 'flex' : 'none';
  if (id !== 'session') hideTimerBadge();
  var hash = SCREEN_ROUTES[id];
  if (hash !== undefined) {
    var target = hash ? '#' + hash : '';
    if (location.hash !== target && ('#' + location.hash.slice(1)) !== target)
      history.pushState(null, '', target || location.pathname + location.search);
  }
}

// =====================================================================
//  Prompter helpers
// =====================================================================

function debugPrompterPdfScriptKinds(tag) {
  const p0 = S.prompterLines[0];
  const s0 = S.pdfScript[0];
  console.log('[DEBUG] prompterLines[0] type=', p0?.type, 'kind=', p0?.kind,
    'pdfScript[0] kind=', s0?.kind, '[' + tag + ']');
}

function fallbackPrompterLinesFromPdfScript() {
  const selN = (S.selectedChar || '').toUpperCase().trim();
  return S.pdfScript.map(s => {
    const isDial = isPdfDialogueRow(s);
    const isActor = isDial && selN && (s.char || '').toUpperCase().trim() === selN;
    const spoken = isDial && (s.isSpoken !== false);
    return {
      text: s.line,
      type: isDial ? (isActor ? 'actor' : 'partner') : 'context',
      char: s.char || '',
      kind: isDial ? (s.kind || LINE_TYPE.DIALOGUE) : (s.kind || LINE_TYPE.ACTION),
      isStageDirection: !!s.isStageDirection,
      isSpoken: spoken,
      parenthetical: s.parenthetical || null,
    };
  });
}

function setPrompterLinesForSession(n, tag) {
  const num = Number(n) || 1;
  S.prompterLines = buildLines(num);
  if (!S.prompterLines.length && S.pdfScript.length > 0)
    S.prompterLines = fallbackPrompterLinesFromPdfScript();
  debugPrompterPdfScriptKinds(tag);
}

function normalizeContParenDisplay(stored) {
  const raw = String(stored || '').trim();
  const inner = raw.replace(/^\(([^)]*)\)$/, '$1').trim();
  if (/^CONT['''\/]?D$/i.test(inner)) return "CONT'D";
  return inner;
}

// =====================================================================
//  Scene label / take info
// =====================================================================

function getSceneLabel() {
  for (let i = S.prompterIndex; i >= 0; i--) {
    const l = S.prompterLines[i];
    if (l && (l.kind === 'slug' || l.type === 'context') && /sc[eè]ne|scene|seq/i.test(l.text)) {
      const m = l.text.match(/(\d+)/);
      if (m) return m[1];
    }
  }
  return '1';
}

function updateTakeInfo() {
  const el = document.getElementById('takeInfo');
  if (!el) return;
  const sc = getSceneLabel();
  const prod = S.currentScriptName ? S.currentScriptName.replace(/\.pdf$/i, '') : '\u2014';
  el.innerHTML = `<div class="take-scene">Sc\u00e8ne ${escHtml(sc)} \u2014 TAKE ${escHtml(S.takeNumber)}</div><div class="take-prod">Prod: ${escHtml(prod)}</div>`;
}

// =====================================================================
//  Clapperboard countdown (3-2-1)
// =====================================================================

function showClapperboard(onComplete) {
  const existing = document.getElementById('clapOverlay');
  if (existing) existing.remove();
  if (typeof window.beginTake === 'function') window.beginTake();
  else S.takeNumber++;
  const overlay = document.createElement('div');
  overlay.id = 'clapOverlay';
  overlay.className = 'clap-overlay';
  const cdEl = document.createElement('div');
  cdEl.className = 'clap-countdown';
  overlay.appendChild(cdEl);
  document.body.appendChild(overlay);
  warmAudioForMobile();
  const steps = [3, 2, 1];
  const freqs = [800, 800, 1200];
  let i = 0;
  function tick() {
    if (i >= steps.length) {
      if (overlay.parentElement) overlay.remove();
      if (typeof onComplete === 'function') onComplete();
      return;
    }
    cdEl.textContent = steps[i];
    requestAnimationFrame(() => { requestAnimationFrame(() => { playCountdownBeep(freqs[i - 1] || 800, 0.15); }); });
    i++;
    setTimeout(tick, 1000);
  }
  tick();
}

// =====================================================================
//  View modes
// =====================================================================

function updateViewModeButtons() {
  document.querySelectorAll('.view-mode-toggle .mode-opt').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-view') === S.sessionViewMode);
  });
  var mb = document.getElementById('mobViewBtn');
  if (mb) mb.textContent = S.sessionViewMode === 'prompt' ? 'TXT' : S.sessionViewMode === 'video' ? 'VID' : '50/50';
}

function setViewMode(m) {
  S.sessionViewMode = m;
  localStorage.setItem('cw_viewMode', m);
  var va = document.querySelector('.video-area');
  var pa = document.querySelector('.prompter-area');
  var vc = document.querySelector('.video-container');
  if (!va || !pa) return;
  va.style.cssText = ''; pa.style.cssText = '';
  if (vc) vc.style.cssText = '';
  var isLandscape = window.innerHeight <= 600 && window.matchMedia('(orientation:landscape)').matches;
  var mobCtrl = document.querySelector('.mob-controls-row');
  var mobAct = document.querySelector('.mob-action-col');
  var sessTop = document.querySelector('.session-top');
  if (mobCtrl) mobCtrl.style.cssText = '';
  if (mobAct) mobAct.style.cssText = '';
  if (sessTop) sessTop.style.cssText = '';
  if (m === 'prompt') {
    if (vc) vc.style.display = 'none';
    va.style.setProperty('width', '0', 'important'); va.style.setProperty('display', 'none', 'important');
    pa.style.setProperty('left', '0', 'important'); pa.style.setProperty('width', '100%', 'important');
    pa.style.height = '100dvh'; pa.style.top = '0'; pa.style.fontSize = '1.3rem';
    if (isLandscape) {
      pa.style.setProperty('position', 'fixed', 'important'); pa.style.setProperty('right', '0', 'important'); pa.style.setProperty('bottom', '0', 'important');
      if (mobCtrl) mobCtrl.style.setProperty('left', '0', 'important');
      if (mobCtrl) mobCtrl.style.setProperty('right', 'auto', 'important');
      if (mobAct) mobAct.style.setProperty('left', 'auto', 'important');
      if (mobAct) mobAct.style.setProperty('right', '8px', 'important');
      if (sessTop) { sessTop.style.setProperty('left', '0', 'important'); sessTop.style.setProperty('right', '0', 'important'); }
    } else if (window.innerWidth >= 768) {
      pa.style.marginTop = '0'; pa.style.position = 'fixed'; pa.style.bottom = '0'; pa.style.left = '0'; pa.style.right = '0';
    }
  } else if (m === 'video') {
    pa.style.setProperty('display', 'none', 'important');
    va.style.setProperty('width', '100%', 'important'); va.style.setProperty('height', '100dvh', 'important');
    if (isLandscape) {
      va.style.setProperty('right', '0', 'important');
      if (mobCtrl) { mobCtrl.style.setProperty('right', '0', 'important'); mobCtrl.style.setProperty('left', '0', 'important'); }
      if (mobAct) { mobAct.style.setProperty('left', 'auto', 'important'); mobAct.style.setProperty('right', '8px', 'important'); }
      if (sessTop) { sessTop.style.setProperty('left', '0', 'important'); sessTop.style.setProperty('right', '0', 'important'); }
    }
  }
  renderPrompter();
  updateViewModeButtons();
}

function cycleViewMode() {
  var modes = ['50-50', 'prompt', 'video'];
  var i = modes.indexOf(S.sessionViewMode);
  setViewMode(modes[(i + 1) % modes.length]);
}

function renderViewModeToggle(containerId) {
  var g = document.getElementById(containerId); if (!g) return;
  g.innerHTML = '';
  var wrap = document.createElement('div'); wrap.className = 'view-mode-toggle'; wrap.style.cssText = 'display:flex;gap:.5rem;width:100%';
  ['prompt', '50-50', 'video'].forEach(function (m) {
    var lbl = m === 'prompt' ? 'Text' : m === 'video' ? 'Video' : '50/50';
    var el = document.createElement('div');
    var isActive = S.sessionViewMode === m;
    el.style.cssText = 'flex:1;text-align:center;padding:12px 16px;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:DM Sans,sans-serif;'
      + (isActive ? 'background:#F5F0E1;color:#000;border:1px solid #F5F0E1;' : 'background:transparent;color:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.15);');
    el.setAttribute('data-view', m);
    el.textContent = lbl;
    el.onclick = function () { setViewMode(m); };
    wrap.appendChild(el);
  });
  g.appendChild(wrap);
}

// =====================================================================
//  Session mode switching
// =====================================================================

function modeHintText(m) {
  if (m === 'auto') return t('modeHintAuto');
  if (m === 'ai') return t('modeHintAi');
  return t('modeHintManual');
}

function syncSessionModeButtons() {
  const aiBtn = document.getElementById('sessionModeAiBtn');
  const manBtn = document.getElementById('sessionModeManualBtn');
  const autoBtn = document.getElementById('sessionModeAutoBtn');
  if (aiBtn) aiBtn.classList.toggle('active', S.mode === 'ai');
  if (manBtn) manBtn.classList.toggle('active', S.mode === 'manual');
  if (autoBtn) autoBtn.classList.toggle('active', S.mode === 'auto');
}

function switchSessionMode(nextMode) {
  setMode(nextMode);
  if (S.sessionMode !== 'ai') return;
  if (S.mode === 'manual') {
    cancelSpeechFlow();
    setStatus('', 'Manuel');
    document.getElementById('aiPanel').classList.remove('active');
    return;
  }
  document.getElementById('aiPanel').classList.add('active');
  setStatus('', '');
  handleCurrentLineAutomation();
}

function setMode(m) {
  S.mode = m;
  document.getElementById('modeAiBtn').classList.toggle('active', m === 'ai');
  document.getElementById('modeManBtn').classList.toggle('active', m === 'manual');
  document.getElementById('modeAutoBtn').classList.toggle('active', m === 'auto');
  document.getElementById('voiceSection').classList.toggle('active', m === 'ai' || m === 'auto');
  document.getElementById('modeHint').textContent = modeHintText(m);
  syncSessionModeButtons();
  renderAllSpeedSliders();
  persistSettings();
}

// =====================================================================
//  Emotion lock
// =====================================================================

function updateEmotionLock() {
  const emotionSelect = document.getElementById('emotionSelect');
  if (!emotionSelect) return;
  const locked = !canUseEmotions();
  emotionSelect.classList.toggle('emotion-locked', locked);
  [...emotionSelect.options].forEach(opt => {
    if (opt.value === 'neutral') opt.disabled = false;
    else opt.disabled = locked;
  });
  if (locked && emotionSelect.value !== 'neutral') {
    emotionSelect.value = 'neutral';
    S.selectedEmotion = 'neutral';
  }
}

// =====================================================================
//  VoiceActivityDetector class
// =====================================================================

class VoiceActivityDetector {
  constructor({ speechThreshold = 0.012, silenceDuration = 1500, minSpeechMs = 0, onSpeechEnd } = {}) {
    this.speechThreshold = speechThreshold;
    this.silenceDuration = silenceDuration;
    this.minSpeechMs = minSpeechMs;
    this.onSpeechEnd = typeof onSpeechEnd === 'function' ? onSpeechEnd : () => {};
    this.state = 'WAITING';
    this.trailingSince = 0;
    this.speakingStartedAt = 0;
    this.hasSpoken = false;
    this.audioContext = null;
    this.source = null;
    this.analyser = null;
    this.data = null;
    this.rafId = null;
    this.running = false;
  }
  async start(stream) {
    if (!stream) return false;
    this.stop();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    this.audioContext = new Ctx();
    if (this.audioContext.state === 'suspended') { try { await this.audioContext.resume(); } catch (e) {} }
    const audioTracks = stream.getAudioTracks();
    console.info('[VAD] mic stream active:', audioTracks.length > 0, 'tracks:', audioTracks.length,
      'ctxState:', this.audioContext.state,
      audioTracks.map(t => t.label + '/' + t.readyState + '/enabled:' + t.enabled).join(', '));
    if (!audioTracks.length || audioTracks[0].readyState !== 'live') {
      console.warn('[VAD] no live audio track \u2014 mic may not be authorized');
      return false;
    }
    this.source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.data = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.running = true;
    this.state = 'WAITING';
    this.hasSpoken = false;
    this.speakingStartedAt = 0;
    this.loop();
    return true;
  }
  getRms() {
    if (!this.analyser || !this.data) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    return Math.sqrt(sum / this.data.length);
  }
  loop() {
    if (!this.running) return;
    const now = Date.now();
    const rms = this.getRms();
    if (this.state === 'WAITING') {
      if (rms >= this.speechThreshold) { this.state = 'SPEAKING'; this.hasSpoken = true; if (!this.speakingStartedAt) this.speakingStartedAt = now; }
    } else if (this.state === 'SPEAKING') {
      if (rms < this.speechThreshold) {
        const spokenFor = now - this.speakingStartedAt;
        if (spokenFor >= this.minSpeechMs) { this.state = 'TRAILING'; this.trailingSince = now; }
      }
    } else if (this.state === 'TRAILING') {
      if (rms >= this.speechThreshold) this.state = 'SPEAKING';
      else if (this.hasSpoken && now - this.trailingSince >= this.silenceDuration) {
        this.onSpeechEnd();
        this.state = 'WAITING';
        this.hasSpoken = false;
      }
    }
    if ((localStorage.getItem('cw_vad_debug') === '1') && (!this._lastLog || now - this._lastLog >= 500)) {
      this._lastLog = now;
      const silMs = this.state === 'TRAILING' ? now - this.trailingSince : 0;
      console.info('[VAD] state:' + this.state + ' rms:' + rms.toFixed(4) + ' spoken:' + this.hasSpoken + ' silenceMs:' + silMs + '/' + this.silenceDuration);
    }
    this.rafId = requestAnimationFrame(() => this.loop());
  }
  stop() {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.analyser) { try { this.analyser.disconnect(); } catch (e) {} this.analyser = null; }
    if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
    this.data = null;
    this.state = 'WAITING';
    this.hasSpoken = false;
  }
}

// =====================================================================
//  VAD helpers
// =====================================================================

function computeSilenceMsForActorLine(line) {
  // Fixed VAD floors by line length — speech-end detection, not dramatic pauses
  const words = ((line && line.text) || '').split(/\s+/).filter(Boolean).length;
  if (words <= 3) return 700;
  if (words <= 10) return 1200;
  return 1800;
}

function getPostTtsArmDelayCapMs() {
  try { return window.matchMedia('(pointer:fine)').matches ? 400 : 700; } catch (_e) { return 600; }
}

function stopAutoVAD() {
  if (_vadArmTimer) { clearTimeout(_vadArmTimer); _vadArmTimer = null; }
  if (S.vad) S.vad.stop();
}

function clearAutoTimer() {
  if (S.autoAdvanceTimer) { clearTimeout(S.autoAdvanceTimer); S.autoAdvanceTimer = null; }
}

function cancelSpeechFlow() {
  S.activeSpeechToken++;
  cancelTTSPlayback();
  clearAutoTimer();
  stopAutoVAD();
}

async function armAutoVADForActorLine() {
  if (S.sessionPaused) return;
  if ((S.mode !== 'auto' && S.mode !== 'ai') || S.sessionMode !== 'ai') {
    console.info('[VAD] skip arm: mode=' + S.mode + ' sessionMode=' + S.sessionMode); return;
  }
  const line = S.prompterLines[S.prompterIndex];
  if (!line || line.type !== 'actor') { console.info('[VAD] skip arm: not actor'); return; }

  let stream = window._cwMicStream;
  let liveTracks = stream ? stream.getAudioTracks().filter(t => t.readyState === 'live') : [];
  if (!liveTracks.length) {
    console.warn('[VAD] mic track dead or missing, requesting new one');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      window._cwMicStream = stream;
      liveTracks = stream.getAudioTracks();
      liveTracks.forEach(t => { t.onended = () => console.warn('[VAD] audio track ended unexpectedly'); });
      if (S.localStream) {
        S.localStream.getAudioTracks().forEach(t => { S.localStream.removeTrack(t); t.stop(); });
        liveTracks.forEach(t => S.localStream.addTrack(t));
      }
      console.info('[VAD] new mic stream acquired, tracks:', liveTracks.map(t => t.readyState));
    } catch (err) {
      console.error('[VAD] cannot get mic:', err);
      showToast("Autorise le micro pour que l'IA d\u00e9tecte quand tu as fini de parler", 5000);
      return;
    }
  }
  console.info('[VAD] audio track:', liveTracks[0].label, 'enabled:', liveTracks[0].enabled, 'readyState:', liveTracks[0].readyState);
  stopAutoVAD();
  if (_vadArmTimer) { clearTimeout(_vadArmTimer); _vadArmTimer = null; }
  const postTtsDelay = Math.max(0, getPostTtsArmDelayCapMs() - (Date.now() - S.lastTTSEndTs));
  const doArm = async () => {
    _vadArmTimer = null;
    if ((S.mode !== 'auto' && S.mode !== 'ai') || S.sessionPaused) return;
    const silenceMs = computeSilenceMsForActorLine(line);
    console.info('[VAD] arming: silence=' + silenceMs + 'ms, words=' + ((line && line.text) || '').split(/\s+/).filter(Boolean).length + ', postTtsDelay=' + postTtsDelay + 'ms');
    S.vad = new VoiceActivityDetector({ speechThreshold: 0.010, silenceDuration: silenceMs, minSpeechMs: 0, onSpeechEnd: onAutoSpeechEnd });
    await S.vad.start(new MediaStream(liveTracks));
  };
  if (postTtsDelay > 100) {
    _vadArmTimer = setTimeout(doArm, postTtsDelay);
  } else {
    await doArm();
  }
}

function onAutoSpeechEnd() {
  if (S.sessionPaused) return;
  if ((S.mode !== 'auto' && S.mode !== 'ai') || S.sessionMode !== 'ai') return;
  console.info('[VAD] speech ended \u2192 advancing to next line');
  const line = S.prompterLines[S.prompterIndex];
  if (!line || line.type !== 'actor') return;
  if (S.prompterIndex >= S.prompterLines.length - 1) return;
  const lineIndex = S.prompterIndex;
  const advance = () => {
    if (!__cwSessionActive || S.sessionPaused) return;
    if (S.prompterIndex !== lineIndex) return; // manual nav during the delay
    S.prompterIndex++;
    S.lastAutoSpokenIndex = -1;
    renderPrompter();
    syncPrompter();
    handleCurrentLineAutomation();
  };
  // VAD's silence window already gave a natural gap \u2014 only honor *explicit*
  // script cues ((un temps), (silence), \u2026) beyond the 300ms baseline.
  const extra = Math.max(0, computeLineDelayMs(line, S.prompterLines[lineIndex + 1]) - 300);
  if (extra > 0) {
    clearAutoTimer();
    S.autoAdvanceTimer = setTimeout(advance, extra);
  } else {
    advance();
  }
}

function scheduleAfterPartner(lineIndex) {
  clearAutoTimer();
  S.autoAdvanceTimer = setTimeout(() => {
    if (!__cwSessionActive) return;
    if (S.sessionPaused) return;
    if (S.prompterIndex !== lineIndex) return;
    if (S.mode === 'manual') return;
    if (S.prompterIndex >= S.prompterLines.length - 1) return;
    S.prompterIndex++;
    S.lastAutoSpokenIndex = -1;
    renderPrompter();
    syncPrompter();
    forceScrollToActive();
    handleCurrentLineAutomation();
  }, computeLineDelayMs(S.prompterLines[lineIndex], S.prompterLines[lineIndex + 1]));
}

// =====================================================================
//  Prompter rendering & scroll
// =====================================================================

function scrollActiveLineTo30(pa, el) {
  const targetY = pa.scrollTop + el.getBoundingClientRect().top - pa.getBoundingClientRect().top - pa.clientHeight * 0.3;
  pa.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
}

function forceScrollToActive(force) {
  if (!force && S.userScrolledUp) return;
  const pa = document.getElementById('prompterArea'); if (!pa) return;
  const act = pa.querySelector('.prompter-line.active') || pa.querySelector('[data-line-index="' + S.prompterIndex + '"]');
  if (!act) return;
  S.userScrolledUp = false;
  _scrollSyncProgrammatic = true;
  requestAnimationFrame(() => {
    scrollActiveLineTo30(pa, act);
    setTimeout(() => { _scrollSyncProgrammatic = false; }, 800);
  });
}

function renderPrompter() {
  const a = document.getElementById('prompterArea');
  const emptyTxt = (typeof t === 'function' && t('prompterEmptyText')) || 'Aucun texte charg\u00e9';
  if (!S.prompterLines.length) {
    a.innerHTML = '<div class="prompter-empty" id="prompterEmptyText"></div>';
    const pe = a.querySelector('.prompter-empty');
    if (pe) pe.textContent = emptyTxt;
    return;
  }
  a.textContent = '';
  const grouped = groupConsecutiveLines(S.prompterLines);
  for (const g of grouped) {
    if (g.kind === LINE_TYPE.SLUG || g.kind === LINE_TYPE.ACTION) {
      const block = document.createElement('div');
      block.className = g.kind === LINE_TYPE.SLUG ? 'prompter-slug' : 'prompter-action';
      block.dataset.lineIndex = String(g.originalIndex);
      block.textContent = g.text;
      a.appendChild(block);
      continue;
    }
    const isSel = S.selectedChar && normalizeCharacterNameForGroup(g.character) === normalizeCharacterNameForGroup(S.selectedChar);
    const groupEl = document.createElement('div');
    groupEl.className = 'prompter-group' + (isSel ? ' prompter-group-user' : ' prompter-group-partner');
    const header = document.createElement('div');
    header.className = 'prompter-character';
    header.textContent = g.character || '';
    groupEl.appendChild(header);
    const segWrap = document.createElement('div');
    segWrap.className = 'prompter-segments';
    for (const seg of g.segments) {
      const flat = S.prompterLines[seg.originalIndex];
      if (seg.parenthetical) {
        const parEl = document.createElement('div');
        parEl.className = 'prompter-parenthetical';
        parEl.textContent = '(' + normalizeContParenDisplay(seg.parenthetical) + ')';
        segWrap.appendChild(parEl);
      }
      const lineEl = document.createElement('div');
      let cls = 'prompter-line';
      if (seg.originalIndex === S.prompterIndex) cls += ' active';
      if (flat && flat.type === 'partner') cls += ' prompter-line-partner';
      if (seg.isStageDirection) cls += ' is-stage-direction';
      lineEl.className = cls;
      lineEl.dataset.lineIndex = String(seg.originalIndex);
      lineEl.appendChild(document.createTextNode(seg.text));
      if (seg.originalIndex === S.prompterIndex && flat && flat.type === 'actor') {
        const dot = document.createElement('span');
        dot.className = 'turn-dot turn-actor';
        lineEl.appendChild(dot);
      }
      lineEl.addEventListener('click', () => handleTapToJump(seg.originalIndex));
      segWrap.appendChild(lineEl);
    }
    groupEl.appendChild(segWrap);
    a.appendChild(groupEl);
  }
  if (!S.userScrolledUp) {
    const act = a.querySelector('.prompter-line.active') || a.querySelector('[data-line-index="' + S.prompterIndex + '"]');
    if (act) {
      _scrollSyncProgrammatic = true;
      requestAnimationFrame(() => {
        scrollActiveLineTo30(a, act);
        setTimeout(() => { _scrollSyncProgrammatic = false; }, 800);
      });
    }
  }
}

// =====================================================================
//  handleCurrentLineAutomation
// =====================================================================

function handleCurrentLineAutomation() {
  clearAutoTimer();
  stopAutoVAD();
  if (!__cwSessionActive) { console.info('[auto] session ended, skip'); return; }
  if (S.sessionPaused) { console.info('[auto] paused, skip'); return; }
  if (S.sessionMode !== 'ai' || !S.prompterLines[S.prompterIndex]) { console.info('[auto] not ai or no line'); return; }
  const line = S.prompterLines[S.prompterIndex];
  console.info('[auto] idx=' + S.prompterIndex + ' type=' + line.type + ' spoken=' + line.isSpoken + ' char=' + line.char + ' lastSpoken=' + S.lastAutoSpokenIndex);
  if (line.isSpoken !== true) {
    S.lastAutoSpokenIndex = S.prompterIndex;
    let nextSpokenIdx = -1;
    for (let i = S.prompterIndex + 1; i < S.prompterLines.length; i++) {
      if (S.prompterLines[i].isSpoken) { nextSpokenIdx = i; break; }
    }
    if (nextSpokenIdx > S.prompterIndex) {
      console.info('[auto] skipping stage directions idx=' + S.prompterIndex + ' \u2192 next spoken idx=' + nextSpokenIdx);
      S.prompterIndex = nextSpokenIdx;
      S.lastAutoSpokenIndex = nextSpokenIdx - 1;
      renderPrompter(); syncPrompter();
      forceScrollToActive();
      handleCurrentLineAutomation();
      return;
    }
    scheduleAfterPartner(S.prompterIndex);
    return;
  }
  if (line.type === 'partner' && (S.mode === 'ai' || S.mode === 'auto')) {
    if (S.lastAutoSpokenIndex === S.prompterIndex) { console.info('[auto] already spoken'); return; }
    const currentIndex = S.prompterIndex;
    S.lastAutoSpokenIndex = currentIndex;
    let spokenText = line.text;
    if (line.char) {
      const charUp = line.char.toUpperCase().trim();
      const textUp = spokenText.toUpperCase().trim();
      if (textUp === charUp || textUp === charUp + ':' || textUp === charUp + ' :') {
        scheduleAfterPartner(currentIndex); return;
      }
      const prefixRx = new RegExp('^' + line.char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-\u2013\u2014]?\\s*', 'i');
      spokenText = spokenText.replace(prefixRx, '').trim();
      if (!spokenText) { scheduleAfterPartner(currentIndex); return; }
    }
    if (!line.isSpoken) {
      console.log('[auto] skipping non-spoken line');
      scheduleAfterPartner(currentIndex);
      return;
    }
    console.info('[auto] speaking partner line:', spokenText.slice(0, 40));
    aiSpeak(spokenText, () => { S.lastTTSEndTs = Date.now(); scheduleAfterPartner(currentIndex); });
    return;
  }
  if ((S.mode === 'auto' || S.mode === 'ai') && line.type === 'actor') {
    S.userScrolledUp = false;
    if (S._scrollResumeTimer) { clearTimeout(S._scrollResumeTimer); S._scrollResumeTimer = null; }
    forceScrollToActive(true);
    armAutoVADForActorLine();
  }
}

// =====================================================================
//  Prompter navigation
// =====================================================================

function prompterNext() {
  if (S.prompterIndex >= S.prompterLines.length - 1) return;
  S.userScrolledUp = false;
  cancelSpeechFlow();
  var next = S.prompterIndex + 1;
  while (next < S.prompterLines.length - 1 && S.prompterLines[next] && S.prompterLines[next].type !== 'actor') next++;
  S.prompterIndex = next;
  S.lastAutoSpokenIndex = -1;
  renderPrompter();
  syncPrompter();
  handleCurrentLineAutomation();
}

function prompterPrev() {
  if (S.prompterIndex <= 0) return;
  S.userScrolledUp = false;
  cancelSpeechFlow();
  var prev = S.prompterIndex - 1;
  while (prev > 0 && S.prompterLines[prev] && S.prompterLines[prev].type !== 'actor') prev--;
  S.prompterIndex = prev;
  S.lastAutoSpokenIndex = -1;
  renderPrompter();
  syncPrompter();
  handleCurrentLineAutomation();
}

function handleTapToJump(targetIndex) {
  if (targetIndex < 0 || targetIndex >= S.prompterLines.length || targetIndex === S.prompterIndex) return;
  S.userScrolledUp = true;
  if (S._scrollResumeTimer) clearTimeout(S._scrollResumeTimer);
  S._scrollResumeTimer = setTimeout(() => { S.userScrolledUp = false; S._scrollResumeTimer = null; }, 2000);
  cancelSpeechFlow();
  S.prompterIndex = targetIndex;
  S.lastAutoSpokenIndex = -1;
  renderPrompter();
  syncPrompter();
  handleCurrentLineAutomation();
}

// =====================================================================
//  Prompter scroll sync
// =====================================================================

function claimScrollOwnership() {
  _scrollOwner = 'local';
  if (_scrollOwnerTimer) clearTimeout(_scrollOwnerTimer);
  _scrollOwnerTimer = setTimeout(() => { _scrollOwner = null; _scrollOwnerTimer = null; }, 500);
}

function onPrompterScrollSync() {
  if (_scrollSyncProgrammatic) return;
  claimScrollOwnership();
  if (_scrollSyncTimer) clearTimeout(_scrollSyncTimer);
  _scrollSyncTimer = setTimeout(() => {
    _scrollSyncTimer = null;
    const pa = document.getElementById('prompterArea');
    if (!pa || !S.prompterLines.length) return;
    const centerY = pa.getBoundingClientRect().top + pa.clientHeight * 0.3;
    let closest = -1, closestDist = Infinity;
    var closestAny = -1, closestAnyDist = Infinity;
    pa.querySelectorAll('.prompter-line').forEach(el => {
      const idx = parseInt(el.dataset.lineIndex); if (isNaN(idx)) return;
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const d = Math.abs(mid - centerY);
      if (d < closestAnyDist) { closestAnyDist = d; closestAny = idx; }
      var line = S.prompterLines[idx];
      if (line && line.type !== 'context' && d < closestDist) { closestDist = d; closest = idx; }
    });
    if (closest < 0) closest = closestAny;
    if (closest >= 0 && closest !== S.prompterIndex) {
      S.prompterIndex = closest;
      pa.querySelectorAll('.prompter-line.active').forEach(el => el.classList.remove('active'));
      pa.querySelectorAll('.prompter-line').forEach(el => {
        if (parseInt(el.dataset.lineIndex) === closest) el.classList.add('active');
      });
      syncPrompter();
    }
  }, 50);
}

// =====================================================================
//  Camera / Mic
// =====================================================================

async function startCamera() {
  const localVideo = document.getElementById('localVideo');
  const hasLiveVideo = () => S.localStream && S.localStream.getVideoTracks().some(t => t.readyState === 'live');
  if (hasLiveVideo()) {
    if (localVideo.srcObject !== S.localStream) localVideo.srcObject = S.localStream;
    localVideo.muted = true; localVideo.playsInline = true;
    localVideo.classList.toggle('mirror', S.currentFacingMode === 'user');
    document.getElementById('noVideoMsg').style.display = 'none';
    try { await localVideo.play(); } catch (e) {}
    return S.localStream;
  }
  if (S.localStream) {
    S.localStream.getVideoTracks().forEach(t => t.stop());
    S.localStream.getVideoTracks().forEach(t => S.localStream.removeTrack(t));
  }
  const videoAttempts = [
    { video: { facingMode: { ideal: S.currentFacingMode }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr = null;
  for (const c of videoAttempts) {
    try {
      const vs = await navigator.mediaDevices.getUserMedia(c);
      const vt = vs.getVideoTracks()[0];
      if (vt) {
        vt.enabled = S.isCamOn;
        if (!S.localStream) S.localStream = new MediaStream();
        S.localStream.addTrack(vt);
      }
      localVideo.srcObject = S.localStream;
      localVideo.muted = true; localVideo.playsInline = true;
      localVideo.classList.toggle('mirror', S.currentFacingMode === 'user');
      document.getElementById('noVideoMsg').style.display = 'none';
      try { await localVideo.play(); } catch (e) {}
      return S.localStream;
    } catch (e) { lastErr = e; }
  }
  const noVideoEl = document.getElementById('noVideoMsg');
  if (lastErr && (lastErr.name === 'NotAllowedError' || lastErr.name === 'PermissionDeniedError')) {
    noVideoEl.style.display = 'flex'; noVideoEl.textContent = '\uD83D\uDCF7 Camera denied \u2014 check permissions';
    showToast('Camera denied \u2014 check permissions', 5000);
  } else {
    noVideoEl.style.display = 'flex'; noVideoEl.textContent = '\uD83D\uDCF7 Camera unavailable';
    showToast('Camera unavailable: ' + (lastErr && lastErr.message || ''), 5000);
  }
  return null;
}

async function _ensureSeparateAudio() {
  if (window._cwMicStream && window._cwMicStream.getAudioTracks().some(t => t.readyState === 'live'))
    return window._cwMicStream;
  console.info('[Audio] requesting separate mic stream');
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    window._cwMicStream = audioStream;
    audioStream.getAudioTracks().forEach(t => {
      t.enabled = S.isMicOn;
      t.onended = () => console.warn('[VAD] audio track ended unexpectedly');
    });
    if (S.localStream) {
      S.localStream.getAudioTracks().forEach(t => { S.localStream.removeTrack(t); t.stop(); });
      audioStream.getAudioTracks().forEach(t => S.localStream.addTrack(t));
    }
    console.info('[Audio] separate mic stream acquired, tracks:', audioStream.getAudioTracks().map(t => t.label + '/' + t.readyState));
    return audioStream;
  } catch (e) {
    console.error('[Audio] cannot get mic:', e);
    showToast('Micro refus\u00e9 \u2014 v\u00e9rifie les permissions', 5000);
    return null;
  }
}

async function ensureSessionStream() {
  if (!S.isCamOn) {
    try {
      if (S.localStream) { S.localStream.getVideoTracks().forEach(t => t.stop()); S.localStream = null; }
      const audioStream = await _ensureSeparateAudio();
      if (!audioStream) return null;
      S.localStream = new MediaStream(audioStream.getAudioTracks());
      document.getElementById('localVideo').srcObject = null;
      document.getElementById('noVideoMsg').style.display = 'flex';
      document.getElementById('noVideoMsg').textContent = 'Camera off';
      return S.localStream;
    } catch (e) {
      showToast('Mic unavailable', 4000);
      return null;
    }
  }
  const cam = await startCamera();
  const audioStream = await _ensureSeparateAudio();
  if (cam && audioStream) return S.localStream;
  if (!cam && audioStream) {
    S.localStream = new MediaStream(audioStream.getAudioTracks());
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('noVideoMsg').style.display = 'flex';
    document.getElementById('noVideoMsg').textContent = 'Camera unavailable, audio only';
    showToast('Camera unavailable, audio only', 4000);
    return S.localStream;
  }
  return cam || null;
}

function toggleMic() {
  if (!S.localStream) return;
  S.isMicOn = !S.isMicOn;
  S.localStream.getAudioTracks().forEach(t => t.enabled = S.isMicOn);
  if (window._cwMicStream) window._cwMicStream.getAudioTracks().forEach(t => t.enabled = S.isMicOn);
  const btn = document.getElementById('btnMic');
  btn.innerHTML = S.isMicOn
    ? '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M19 11h-2a5 5 0 0 1-1.08 3.13l1.45 1.45A6.97 6.97 0 0 0 19 11zM12 14a3 3 0 0 0 2.82-2H12v2zm-1 3.93V21h2v-3.07c.34-.04.67-.11 1-.2l-1.55-1.55c-.15.01-.3.02-.45.02a5 5 0 0 1-5-5H5a7 7 0 0 0 6 6.93zM3.71 3.56L2.29 4.97l7.03 7.03H9.3A3 3 0 0 0 12 14c.09 0 .18 0 .27-.02l1.46 1.46a5.02 5.02 0 0 1-1.73.49V21h-2v-3.07L12 17.93 3.71 3.56zM12 4a3 3 0 0 0-3 3v4.17l6-6V5a3 3 0 0 0-3-3z"/><line x1="3" y1="3" x2="21" y2="21" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
  btn.style.opacity = S.isMicOn ? '1' : '.5';
  const _mm = document.getElementById('mobMicBtn');
  if (_mm) {
    _mm.classList.toggle('muted', !S.isMicOn);
    _mm.innerHTML = S.isMicOn
      ? '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M19 11h-2a5 5 0 0 1-1.08 3.13l1.45 1.45A6.97 6.97 0 0 0 19 11zM12 14c.09 0 .18 0 .27-.02l1.46 1.46a5.02 5.02 0 0 1-1.73.49V21h2v-3.07A7 7 0 0 0 19 11h-2z" fill="currentColor"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  showToast(S.isMicOn ? 'Micro activ\u00e9' : 'Micro coup\u00e9');
}

async function toggleCam() {
  S.currentFacingMode = S.currentFacingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: S.currentFacingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const newTrack = newStream.getVideoTracks()[0];
    const oldTracks = S.localStream ? S.localStream.getVideoTracks() : [];
    if (S.localStream) {
      S.localStream.getVideoTracks().forEach(t => S.localStream.removeTrack(t));
      S.localStream.addTrack(newTrack);
    }
    oldTracks.forEach(t => t.stop());
    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = S.localStream;
    localVideo.classList.toggle('mirror', S.currentFacingMode === 'user');
    try { await localVideo.play(); } catch (e) {}
    if (S.call && S.call.peerConnection) {
      const sender = S.call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
    document.getElementById('noVideoMsg').style.display = 'none';
    showToast(S.currentFacingMode === 'user' ? 'Front camera' : 'Rear camera');
  } catch (e) {
    S.currentFacingMode = S.currentFacingMode === 'user' ? 'environment' : 'user';
    showToast('Camera switch unavailable', 3500);
  }
}

function toggleSetupCamera() {
  S.isCamOn = !S.isCamOn;
  updateSetupCameraButton();
  showToast(S.isCamOn ? 'Camera on' : 'Camera off');
  if (S.localStream) {
    S.localStream.getVideoTracks().forEach(t => t.enabled = S.isCamOn);
  }
}

function updateSetupCameraButton() {
  const btn = document.getElementById('setupCamBtn');
  if (!btn) return;
  const svgIcon = '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;vertical-align:middle;margin-right:4px"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>';
  btn.innerHTML = svgIcon + (S.isCamOn ? t('cameraOn') : t('cameraOff'));
}

// =====================================================================
//  Pause
// =====================================================================

function togglePause(forceState) {
  const newState = typeof forceState === 'boolean' ? forceState : !S.sessionPaused;
  if (newState === S.sessionPaused) return;
  S.sessionPaused = newState;
  const btn = document.getElementById('btnPause');
  const icon = document.getElementById('pauseIcon');
  const overlay = document.getElementById('pauseOverlay');
  const mobBtn = document.getElementById('mobMainBtn');
  const recInd = document.getElementById('recIndicator');
  if (S.sessionPaused) {
    const _ss = (typeof window !== 'undefined' && window.__cwSessionState) || {};
    track('pause_menu_open', { take_elapsed_s: _ss.startedAt ? Math.round((Date.now() - _ss.startedAt) / 1000) : 0 });
    if (typeof window.markTakePaused === 'function') window.markTakePaused(true);
    cancelSpeechFlow();
    freezeTimer();
    updateTakeInfo();
    renderSpeedSlider('speedBtnsPause', false);
    renderViewModeToggle('viewModePause');
    if (overlay) overlay.classList.add('active');
    if (btn) btn.classList.add('is-paused');
    if (icon) icon.innerHTML = '<polygon points="6,4 20,12 6,20" fill="currentColor"/>';
    if (mobBtn) mobBtn.classList.add('is-paused');
    if (recInd) recInd.style.display = 'none';
    if (S.isRecording && S.mediaRecorder && S.mediaRecorder.state === 'recording') {
      try { S.mediaRecorder.pause(); } catch (_e) {}
    }
    if (S.conn && S.conn.open) S.conn.send({ type: 'pause' });
  } else {
    if (typeof window.markTakePaused === 'function') window.markTakePaused(false);
    unfreezeTimer();
    if (S.isRecording && S.mediaRecorder && S.mediaRecorder.state === 'paused') {
      try { S.mediaRecorder.resume(); } catch (_e) {}
    }
    if (overlay) overlay.classList.remove('active');
    if (btn) btn.classList.remove('is-paused');
    if (icon) icon.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
    if (mobBtn) mobBtn.classList.remove('is-paused');
    if (recInd && S.isRecording) recInd.style.display = 'block';
    if (S.conn && S.conn.open) S.conn.send({ type: 'resume' });
    S.unavailableElevenVoiceIds.clear();
    (async () => {
      if (S._recAudioCtx && S._recAudioCtx.state === 'suspended') {
        try { await S._recAudioCtx.resume(); } catch (_e) { console.warn('[resume] AudioContext resume failed:', _e); }
      }
      S.lastAutoSpokenIndex = -1;
      handleCurrentLineAutomation();
    })();
  }
}

function togglePauseMode() {
  const isAuto = S.mode === 'auto' || S.mode === 'ai';
  const next = isAuto ? 'manual' : 'auto';
  setMode(next);
  syncSessionModeButtons();
  const label = document.getElementById('psModeLabel');
  const tog = document.getElementById('psModeToggle');
  if (label) label.textContent = next === 'manual' ? 'Manuel' : 'Auto';
  if (tog) tog.classList.toggle('on', next === 'auto' || next === 'ai');
}

function togglePauseSettings() {
  const panel = document.getElementById('pauseSettingsPanel');
  if (!panel) return;
  if (panel.classList.contains('active')) { closePauseSettings(); return; }
  populatePauseCharGrid();
  populatePauseVoiceSelect();
  renderSpeedSlider('speedBtnsPause', false);
  const mtog = document.getElementById('psModeToggle');
  const mlabel = document.getElementById('psModeLabel');
  if (mtog) mtog.classList.toggle('on', S.mode === 'auto' || S.mode === 'ai');
  if (mlabel) mlabel.textContent = (S.mode === 'manual') ? 'Manuel' : 'Auto';
  panel.classList.add('active');
}

function closePauseSettings() {
  // Intentionally empty in the original code
}

function populatePauseCharGrid() {
  const g = document.getElementById('pauseCharGrid');
  if (!g) return;
  g.innerHTML = '';
  const chars = getChars();
  chars.forEach(({ char, count }) => {
    const el = document.createElement('div');
    el.className = 'char-item' + (S.selectedChar === char ? ' selected' : '');
    el.innerHTML = `${escHtml(char)}<span class="cc">(${count})</span>`;
    el.onclick = () => {
      S.selectedChar = char;
      g.querySelectorAll('.char-item').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      setPrompterLinesForSession(1, 'pauseCharChange');
      S.prompterIndex = 0;
      renderPrompter();
      showToast('Tu joues ' + char);
    };
    g.appendChild(el);
  });
}

function populatePauseVoiceSelect() {
  const s = document.getElementById('pauseVoiceSelect');
  if (!s) return;
  s.innerHTML = '';
  S.VOICE_PRESETS.forEach(v => {
    const o = document.createElement('option');
    o.value = v.id; o.textContent = v.label + ' \u2014 ' + v.tag;
    if (S.selectedVoice && v.id === S.selectedVoice.id) o.selected = true;
    s.appendChild(o);
  });
}

function changePauseVoice() {
  const s = document.getElementById('pauseVoiceSelect');
  if (!s) return;
  S.selectedVoice = S.VOICE_PRESETS.find(v => v.id === s.value) || S.VOICE_PRESETS[0] || null;
  if (S.selectedVoice) showToast('Voix : ' + S.selectedVoice.label);
  persistSettings();
  populateSessionVoiceSelect();
}

function setPauseSpeed(v) { setVoiceSpeed(v, false); }

// =====================================================================
//  End-take modal
// =====================================================================

function showEndTakeModal() {
  const m = document.getElementById('endTakeModal'); if (!m) return;
  document.getElementById('etmConfirmPhase').style.display = '';
  document.getElementById('etmSavedPhase').style.display = 'none';
  m.classList.add('active');
}

function hideEndTakeModal() {
  const m = document.getElementById('endTakeModal'); if (m) m.classList.remove('active');
  var home = document.getElementById('home'); if (home) home.style.pointerEvents = '';
}

function confirmEndTake() {
  track('end_take', { mode: S.sessionMode });
  document.getElementById('etmConfirmPhase').style.display = 'none';
  endSession();
}

function showRecSavedModal(blob, fname, mime) {
  _lastRecBlob = blob; _lastRecFname = fname; _lastRecMime = mime;
  const m = document.getElementById('endTakeModal');
  const info = document.getElementById('etmRecInfo');
  if (!m) return;
  document.getElementById('etmConfirmPhase').style.display = 'none';
  const phase = document.getElementById('etmSavedPhase'); phase.style.display = '';
  var sizeStr = blob.size < 1048576 ? (blob.size / 1024).toFixed(0) + ' KB' : (blob.size / 1048576).toFixed(1) + ' MB';
  var ext = fname.split('.').pop().toUpperCase();
  info.innerHTML = '<div class="etm-info-row"><span>File</span><span class="etm-info-val">' + escHtml(fname) + '</span></div><div class="etm-info-row"><span>Format</span><span class="etm-info-val">' + ext + '</span></div><div class="etm-info-row"><span>Size</span><span class="etm-info-val">' + sizeStr + '</span></div>';
  var home = document.getElementById('home'); if (home) home.style.pointerEvents = 'none';
  m.classList.add('active');
}

function dismissRecModal() {
  _lastRecBlob = null; _lastRecFname = ''; _lastRecMime = '';
  var home = document.getElementById('home'); if (home) home.style.pointerEvents = '';
  hideEndTakeModal();
  showScreen('home');
}

// =====================================================================
//  Italienne
// =====================================================================

function toggleItalienne() {
  const tog = document.getElementById('psItalienneToggle');
  const isOn = tog && tog.classList.contains('on');
  if (isOn) {
    if (S._preItalienneVoice) { S.selectedVoice = S._preItalienneVoice; S._preItalienneVoice = null; }
    setVoiceSpeed(1.0, true);
    S.selectedEmotion = S._preItalienneEmotion || 'neutral';
    if (tog) tog.classList.remove('on');
    const badge = document.getElementById('italienneBadge'); if (badge) badge.classList.remove('active');
  } else {
    S._preItalienneVoice = S.selectedVoice;
    S._preItalienneEmotion = S.selectedEmotion;
    const itVoice = S.VOICE_PRESETS.find(v => v.voiceId === 'tZssYepgGaQmegsMEXjK');
    if (itVoice) S.selectedVoice = itVoice;
    S.selectedEmotion = 'neutral';
    setVoiceSpeed(2.0, true);
    if (tog) tog.classList.add('on');
    const badge = document.getElementById('italienneBadge'); if (badge) badge.classList.add('active');
  }
  // Note: original calls renderSpeedBtns which doesn't exist — should be renderSpeedSlider
  renderSpeedSlider('speedBtnsPause', false);
}

// =====================================================================
//  UI helpers
// =====================================================================

function hideAiOnlyControls() {
  var ids = ['sessionModeManualBtn', 'sessionModeAutoBtn', 'speedBtnsSession', 'viewModeSession', 'aiPanel', 'speedBtnsOverlay'];
  ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
}

function showAiControls() {
  var ids = ['sessionModeManualBtn', 'sessionModeAutoBtn', 'speedBtnsSession', 'viewModeSession', 'aiPanel'];
  ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = ''; });
}

function setSessionSpeed(v) { setVoiceSpeed(v, false); }

// =====================================================================
//  Session state machine
// =====================================================================

function cwCommitSessionLive() {
  const tag = __cwPendingSessionTag || 'unknown';
  __cwPendingSessionTag = null;
  __cwSessionActive = true;
  if (typeof window !== 'undefined') {
    window.__cwSessionState = {
      active: true,
      source: tag,
      startedAt: Date.now(),
      phase: 'live',
      endedAt: null,
      lastEndReason: null,
      lastSkip: null,
      lastSkipReason: null,
    };
  }
}

function cwSessionStateClear(reason) {
  __cwPendingSessionTag = null;
  if (typeof window === 'undefined') return;
  const prev = window.__cwSessionState || {};
  window.__cwSessionState = {
    active: false,
    source: null,
    startedAt: null,
    phase: 'idle',
    endedAt: Date.now(),
    lastEndReason: String(reason || 'unknown'),
    lastSkip: prev.lastSkip,
    lastSkipReason: prev.lastSkipReason,
  };
}

function cwSessionStateMarkSkipped(reason) {
  if (typeof window === 'undefined') return;
  const base = window.__cwSessionState || {};
  window.__cwSessionState = Object.assign({}, base, {
    lastSkip: Date.now(),
    lastSkipReason: String(reason || 'skipped'),
  });
}

function cwEnqueueSessionBoot(fn) {
  const p = __cwSessionBootTail.then(async () => {
    if (__cwSessionActive) {
      cwSessionStateMarkSkipped('already_active');
      return null;
    }
    try { return await fn(); } catch (e) { console.warn('[session boot]', e); return null; }
  });
  __cwSessionBootTail = p.catch(() => {});
  return p;
}

/**
 * Solo AI session entry: import, IDB restore, manual "Lancer", or auto-rehearse after paste/PDF.
 */
function requestRehearsalStart(opts) {
  opts = opts || {};
  const source = opts.source || 'import';
  if (source === 'manual') {
    return cwEnqueueSessionBoot(async () => {
      if (__cwSessionActive) return false;
      unlockAudio();
      if (S.pdfScript.length > 0 && !S.selectedChar) { showToast(t('pickCharacterFirst')); return false; }
      try {
        const perms = await navigator.mediaDevices.getUserMedia({ audio: true, video: S.isCamOn });
        perms.getTracks().forEach(t => t.stop());
      } catch (e) {
        console.warn('[session] permission denied:', e.message);
        showToast(t('micDenied') || 'Autorise le micro pour continuer', 4000);
        return false;
      }
      S.role = 'actor'; S.sessionMode = 'ai'; S.mode = 'ai';
      __cwPendingSessionTag = 'manual';
      await fetchServerSession();
      const ok = await bootstrapAiSessionFromCurrentScript(1);
      return ok !== false;
    });
  }
  const importScreenN = opts.importScreenN != null ? opts.importScreenN : 1;
  const pdfScriptSnapshot = opts.pdfScriptSnapshot;
  const selectedCharacter = opts.selectedCharacter;
  const bootSource = opts.source || 'import';
  return cwEnqueueSessionBoot(async () => {
    if (__cwSessionActive) return false;
    __cwPendingSessionTag = bootSource;
    const ok = await enterRehearsalMode(importScreenN, pdfScriptSnapshot, selectedCharacter);
    return !!ok;
  });
}

// =====================================================================
//  Session lifecycle
// =====================================================================

async function bootstrapAiSessionFromCurrentScript(importScreenN) {
  const tier = getUserTier();
  const n = Number(importScreenN) || 1;
  if (!isServerAdmin() && tier !== 'visitor' && getRemainingSessionMs() <= 0) {
    showPaywallModal(); __cwPendingSessionTag = null; return false;
  }
  if (!canUseElevenLabs()) {
    S.elevenLabsTemporarilyDisabled = true; S.elevenLabsDisableReason = 'quota';
  } else {
    S.elevenLabsTemporarilyDisabled = false;
    if (S.elevenLabsDisableReason === 'visitor' || S.elevenLabsDisableReason === 'quota') S.elevenLabsDisableReason = '';
  }
  if (!canUseEmotions()) S.selectedEmotion = 'neutral';
  S.selectedEmotion = document.getElementById('emotionSelect').value || S.selectedEmotion;
  if (!canUseEmotions()) S.selectedEmotion = 'neutral';
  if (!S.selectedVoice) S.selectedVoice = S.VOICE_PRESETS[0] || null;
  autoAssignVoiceByGender();
  if (!S.currentScriptName) {
    const si = document.getElementById('scriptInput' + n);
    S.currentScriptName = si && si.value.trim() ? t('clapPastedText') : '\u2014';
  }
  setPrompterLinesForSession(n, 'bootstrapAiSession');
  S.prompterIndex = 0;
  S.lastAutoSpokenIndex = -1;
  S.userScrolledUp = false;
  const _pCounts = { actor: 0, partner: 0, context: 0 };
  S.prompterLines.forEach(l => { _pCounts[l.type] = ((_pCounts[l.type]) || 0) + 1; });
  console.info('[session] prompterLines:', S.prompterLines.length,
    '\u2192 actor:', _pCounts.actor, 'partner:', _pCounts.partner, 'context:', _pCounts.context,
    'mode:', S.mode, 'sessionMode:', S.sessionMode);
  if (!_pCounts.partner) console.error('[session] ZERO partner lines \u2014 AI has nothing to speak!');
  if (!_pCounts.actor) console.warn('[session] ZERO actor lines \u2014 VAD will never arm');
  showScreen('session');
  renderRecordingsList();
  showAiControls();
  cwCommitSessionLive();
  renderPrompter();
  if (S.mode === 'ai' || S.mode === 'auto') {
    document.getElementById('aiPanel').classList.add('active');
    populateSessionVoiceSelect();
  }
  setStatus('', S.sessionMode === 'ai' ? t('sessionReadyLabel') : '');
  await ensureSessionStream();
  if (canRecord() && S.localStream && !S.isRecording) startRecording();
  renderViewModeToggle('viewModeSession');
  renderAllSpeedSliders();
  showClapperboard(() => {
    if (tier !== 'visitor' || getSpecTier() === 'figurant') startSessionTimer();
    else hideTimerBadge();
    setViewMode(S.sessionViewMode);
    S.userScrolledUp = false;
    handleCurrentLineAutomation();
    forceScrollToActive();
  });
  return true;
}

async function enterRehearsalMode(importScreenN, pdfScriptSnapshot, selectedCharacter) {
  const n = Number(importScreenN) || 1;
  if (Array.isArray(pdfScriptSnapshot) && pdfScriptSnapshot.length) {
    S.pdfScript = pdfScriptSnapshot;
    syncPdfScriptDebugMirror();
  }
  const chosen = selectedCharacter || pickDefaultRehearsalCharacter();
  if (!chosen) {
    __cwPendingSessionTag = null;
    console.warn('[rehearsal] aucun personnage d\u00e9tect\u00e9');
    return false;
  }
  S.selectedChar = chosen;
  S.soloPartnerMode = 'all';
  S.soloPartnerChar = null;
  S.userScrolledUp = false;
  cancelSpeechFlow();
  unlockAudio();
  try {
    const perms = await navigator.mediaDevices.getUserMedia({ audio: true, video: S.isCamOn });
    perms.getTracks().forEach(t => t.stop());
  } catch (e) {
    console.warn('[rehearsal] permission:', e.message);
    showToast(t('micDenied') || 'Autorise le micro pour continuer', 4000);
    return false;
  }
  S.role = 'actor';
  S.sessionMode = 'ai';
  S.mode = 'auto';
  syncSessionModeButtons();
  const ok = await bootstrapAiSessionFromCurrentScript(n);
  return ok !== false;
}

async function startAiSession() {
  track('start_session', { mode: 'ai' });
  await requestRehearsalStart({ source: 'manual' });
}

function endSession() {
  const _wasLive = __cwSessionActive;
  const _ssPrev = (typeof window !== 'undefined' && window.__cwSessionState) || {};
  __cwSessionActive = false;
  cwSessionStateClear('endSession');
  stopSessionTimer();
  if (_wasLive && !S.isRecording) {
    // Session ended without an active recording → nothing was captured this take
    track('session_abandon', {
      screen: 'session',
      had_recording: false,
      elapsed_s: _ssPrev.startedAt ? Math.round((Date.now() - _ssPrev.startedAt) / 1000) : 0,
    });
  }
  S.sessionPaused = false;
  closePauseSettings();
  const po = document.getElementById('pauseOverlay'); if (po) po.classList.remove('active');
  const pb = document.getElementById('btnPause'); if (pb) pb.classList.remove('is-paused');
  const pi = document.getElementById('pauseIcon');
  if (pi) pi.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
  const mb = document.getElementById('mobMainBtn'); if (mb) mb.classList.remove('is-paused');
  const mg = document.getElementById('mobSettingsGear'); if (mg) mg.classList.remove('visible');
  const _mrEnd = document.getElementById('mobRecBtn'); if (_mrEnd) _mrEnd.classList.remove('recording');
  const _mmEnd = document.getElementById('mobMicBtn'); if (_mmEnd) _mmEnd.classList.remove('muted');
  const _qbEnd = document.getElementById('quitBtn');
  if (_qbEnd) { _qbEnd.classList.remove('has-recording'); _qbEnd.textContent = 'Done'; }
  const _ssb = document.getElementById('sessionShareBtn'); if (_ssb) _ssb.style.display = 'none';
  const _msb = document.getElementById('mobShareBtn'); if (_msb) _msb.style.display = 'none';
  const _rp = document.getElementById('recPanel'); if (_rp) _rp.classList.remove('active');
  const ib = document.getElementById('italienneBadge'); if (ib) ib.classList.remove('active');
  if (S._preItalienneVoice) { S.selectedVoice = S._preItalienneVoice; S._preItalienneVoice = null; }
  if (S.connectionTimeout) clearTimeout(S.connectionTimeout);
  cancelSpeechFlow();
  const wasRecording = S.isRecording;
  if (wasRecording && S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    const savedChunks = S.recordedChunks;
    const savedRecorder = S.mediaRecorder;
    const origOnStop = savedRecorder.onstop;
    let _onstopDone = false;
    savedRecorder.onstop = async function () {
      if (_onstopDone) return;
      _onstopDone = true;
      clearTimeout(_onstopTimeout);
      S.recordedChunks = savedChunks;
      if (origOnStop) await origOnStop.call(this);
      teardownStreamsAndPeers();
    };
    const _onstopTimeout = setTimeout(function () {
      if (_onstopDone) return;
      _onstopDone = true;
      console.warn('[rec] onstop timeout \u2014 forcing teardown');
      _closeRecAudioCtx();
      teardownStreamsAndPeers();
      if (savedChunks.length > 0) {
        try {
          var isMP4 = (savedRecorder.mimeType || '').startsWith('video/mp4');
          var ext = isMP4 ? 'mp4' : 'webm'; var mime = isMP4 ? 'video/mp4' : 'video/webm';
          var blob = new Blob(savedChunks, { type: mime });
          var fname = 'citizentape-' + Date.now() + '.' + ext;
          saveRecToDB(blob, fname, mime).then(function () { renderRecordingsList(); }).catch(function () {});
          showRecSavedModal(blob, fname, mime);
        } catch (e) { console.error('[rec] timeout save:', e); showToast('Recording may not have saved', 3000); hideEndTakeModal(); }
      } else { showToast('Recording could not be saved', 3000); hideEndTakeModal(); }
    }, 5000);
    stopRecording();
  } else {
    teardownStreamsAndPeers();
  }
  function teardownStreamsAndPeers() {
    try { if (S.conn && S.conn.open) S.conn.send({ type: 'end-session' }); } catch (e) {}
    if (S.call) { S.call.close(); S.call = null; }
    if (S.conn) { S.conn.close(); S.conn = null; }
    if (S.peer) { S.peer.destroy(); S.peer = null; }
    if (window._cwMicStream) { window._cwMicStream.getTracks().forEach(t => t.stop()); window._cwMicStream = null; }
    if (S.localStream) { S.localStream.getTracks().forEach(t => t.stop()); S.localStream = null; }
  }
  const lv = document.getElementById('localVideo');
  lv.srcObject = null; lv.style.display = ''; lv.classList.remove('mirror');
  document.getElementById('remoteVideo').srcObject = null;
  document.getElementById('remoteVideo').style.display = 'none';
  document.getElementById('remoteAudio').srcObject = null;
  document.getElementById('noVideoMsg').style.display = 'flex';
  document.getElementById('noVideoMsg').textContent = 'Camera \u00b7 on or off';
  document.getElementById('aiPanel').classList.remove('active');
  const _riEnd = document.getElementById('recIndicator'); if (_riEnd) _riEnd.style.display = 'none';
  hideTimerBadge();
  S.lockedVoiceLocale = '';
  S.userScrolledUp = false;
  const _pa = document.getElementById('prompterArea'); if (_pa) _pa.classList.remove('rear-cam');
  stopPeerKeepalive();
  hideOverlay();
  S.isMicOn = true; S.isCamOn = true; S.currentFacingMode = 'user';
  S.prompterLines = []; S.prompterIndex = 0; S.lastAutoSpokenIndex = -1; S.activeSpeechToken = 0;
  if (!wasRecording) { S.recordedChunks = []; S.mediaRecorder = null; hideEndTakeModal(); }
  else {
    const m = document.getElementById('endTakeModal');
    if (m) {
      document.getElementById('etmConfirmPhase').style.display = 'none';
      const phase = document.getElementById('etmSavedPhase');
      phase.style.display = '';
      document.getElementById('etmRecInfo').innerHTML = '<div class="etm-info-row" style="justify-content:center"><span class="etm-info-val">Saving recording\u2026</span></div>';
      var _h = document.getElementById('home'); if (_h) _h.style.pointerEvents = 'none';
      m.classList.add('active');
    }
  }
  showScreen('home');
  S.role = 'actor'; S.sessionMode = 'ai';
}

function cancelConnection() {
  hideOverlay();
  if (!S.conn || !S.conn.open) endSession();
}

// =====================================================================
//  _closeRecAudioCtx helper (needed by endSession)
// =====================================================================

function _closeRecAudioCtx() {
  // Stub — the full recording teardown lives in recording.js.
  // This bridge stops canvas draw + closes audio context if still open.
  if (S._recAudioCtx) { try { S._recAudioCtx.close(); } catch (e) {} S._recAudioCtx = null; }
  S._recDest = null; S._recMicSource = null; S._recMicGain = null; S._recStream = null;
}

// =====================================================================
//  Late-bound imports for idb (saveRecToDB, renderRecordingsList)
//  These are referenced inside endSession's timeout but are imported
//  at the top. Provide local aliases so the closure captures them.
// =====================================================================

let _saveRecToDB, _renderRecordingsList;
// Dynamically import to avoid circular dep issues — will be set by init
import('./idb.js').then(mod => {
  _saveRecToDB = mod.saveRecToDB;
  _renderRecordingsList = mod.renderRecordingsList;
});

// Re-alias for use in endSession (the static import already gives us
// renderRecordingsList via idb.js, but endSession closure also needs saveRecToDB)
function saveRecToDB(blob, fname, mime) {
  if (_saveRecToDB) return _saveRecToDB(blob, fname, mime);
  // Fallback: try window
  if (window.saveRecToDB) return window.saveRecToDB(blob, fname, mime);
  return Promise.resolve();
}
function renderRecordingsList() {
  if (_renderRecordingsList) return _renderRecordingsList();
  if (window.renderRecordingsList) return window.renderRecordingsList();
}

// =====================================================================
//  Install window globals (for cross-module calls from webrtc.js, etc.)
// =====================================================================

if (typeof window !== 'undefined') {
  window.cwCommitSessionLive = cwCommitSessionLive;
  window.cwSessionStateClear = cwSessionStateClear;
  window.cwEnqueueSessionBoot = cwEnqueueSessionBoot;
  window.__cwSessionActive = __cwSessionActive;
  // Keep window.__cwSessionActive in sync
  Object.defineProperty(window, '__cwSessionActive', {
    configurable: true,
    get() { return __cwSessionActive; },
    set(v) { __cwSessionActive = v; },
  });
  Object.defineProperty(window, '__cwPendingSessionTag', {
    configurable: true,
    get() { return __cwPendingSessionTag; },
    set(v) { __cwPendingSessionTag = v; },
  });
}

// =====================================================================
//  Scroll event setup helper (called from DOMContentLoaded init)
// =====================================================================

function setupPrompterScrollListeners() {
  const pa = document.getElementById('prompterArea');
  if (!pa) return;
  pa.addEventListener('scroll', () => {
    if (_scrollSyncProgrammatic) { S._lastPrompterScrollTop = pa.scrollTop; return; }
    const st = pa.scrollTop;
    if (Math.abs(st - S._lastPrompterScrollTop) > 2) {
      S.userScrolledUp = true;
      if (S._scrollResumeTimer) clearTimeout(S._scrollResumeTimer);
      S._scrollResumeTimer = setTimeout(() => { S.userScrolledUp = false; S._scrollResumeTimer = null; }, 15000);
    }
    if (pa.scrollHeight - st - pa.clientHeight < 80) {
      S.userScrolledUp = false;
      if (S._scrollResumeTimer) { clearTimeout(S._scrollResumeTimer); S._scrollResumeTimer = null; }
    }
    S._lastPrompterScrollTop = st;
    onPrompterScrollSync();
  }, { passive: true });
  pa.addEventListener('touchstart', () => {
    if (!_scrollSyncProgrammatic) {
      S.userScrolledUp = true;
      if (S._scrollResumeTimer) clearTimeout(S._scrollResumeTimer);
      S._scrollResumeTimer = setTimeout(() => { S.userScrolledUp = false; S._scrollResumeTimer = null; }, 15000);
    }
  }, { passive: true });
}

// =====================================================================
//  Named exports
// =====================================================================

export {
  // Screen routing
  SCREEN_ROUTES,
  ROUTE_TO_SCREEN,
  showScreen,

  // Prompter
  debugPrompterPdfScriptKinds,
  fallbackPrompterLinesFromPdfScript,
  setPrompterLinesForSession,
  normalizeContParenDisplay,
  renderPrompter,
  forceScrollToActive,
  handleCurrentLineAutomation,
  prompterNext,
  prompterPrev,
  handleTapToJump,

  // Scene / take
  getSceneLabel,
  updateTakeInfo,

  // Clapperboard
  showClapperboard,

  // View modes
  setViewMode,
  cycleViewMode,
  renderViewModeToggle,
  updateViewModeButtons,

  // Session mode switching
  modeHintText,
  syncSessionModeButtons,
  switchSessionMode,
  setMode,

  // Emotion lock
  updateEmotionLock,

  // VAD
  VoiceActivityDetector,
  computeSilenceMsForActorLine,
  stopAutoVAD,
  armAutoVADForActorLine,
  onAutoSpeechEnd,

  // Speech flow
  cancelSpeechFlow,
  clearAutoTimer,
  scheduleAfterPartner,

  // Camera / Mic
  startCamera,
  ensureSessionStream,
  toggleMic,
  toggleCam,
  toggleSetupCamera,
  updateSetupCameraButton,

  // Pause
  togglePause,
  togglePauseMode,
  togglePauseSettings,
  closePauseSettings,
  changePauseVoice,
  setPauseSpeed,

  // End-take
  showEndTakeModal,
  hideEndTakeModal,
  confirmEndTake,
  showRecSavedModal,
  dismissRecModal,

  // Italienne
  toggleItalienne,

  // UI helpers
  hideAiOnlyControls,
  showAiControls,
  setSessionSpeed,

  // Session state machine
  cwCommitSessionLive,
  cwSessionStateClear,
  cwSessionStateMarkSkipped,
  cwEnqueueSessionBoot,
  requestRehearsalStart,

  // Session lifecycle
  bootstrapAiSessionFromCurrentScript,
  enterRehearsalMode,
  startAiSession,
  endSession,
  cancelConnection,

  // Scroll
  onPrompterScrollSync,
  setupPrompterScrollListeners,
  scrollActiveLineTo30,
};
