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
  renderSpeedSlider, getLocaleConfig,
} from './voices.js';
import { aiSpeak, cancelTTSPlayback, normalizeTextForTTS, warmAudioForMobile } from './tts.js';
import { playCountdownBeep, playSfx, unlockAudio } from './sfx.js';
import {
  getUserData, saveUserData, getUserTier, getPlan,
  checkAndApplyResets, getRemainingSessionMs, consumeMs,
  startSessionTimer, stopSessionTimer, freezeTimer, unfreezeTimer,
  fmtTimer, isServerAdmin, updateChronoDisplay, computeLineDelayMs, voicePaceMultiplier,
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
import { startSttFollow, stopSttFollow, setSttCapturing, isSttRunning } from './stt.js';
import {
  buildLines, normalizeCharacterNameForGroup, groupConsecutiveLines,
  pickDefaultRehearsalCharacter, renderPartnerAssignment,
  clearPDF, finishPdfSetupUi,
  buildDisplayLines, displayRangeForPrompter,
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
  myTakes: 'takes',
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
  // Monologue detection: stamp lines inside blocks so automation can
  // switch to paced continuous advance (no VAD, no AI wait)
  try {
    const blocksFn = window.computeMonologueBlocks;
    S.monologueBlocks = typeof blocksFn === 'function' ? blocksFn(S.prompterLines) : [];
    for (const b of S.monologueBlocks) {
      for (let i = b.start; i <= b.end && i < S.prompterLines.length; i++) {
        if (S.prompterLines[i]) S.prompterLines[i].inMonologue = true;
      }
    }
    if (S.monologueBlocks.length) console.info('[monologue] blocks:', JSON.stringify(S.monologueBlocks));
  } catch (e) { S.monologueBlocks = []; }
  // Build the display-line layer (one sentence at a time)
  try { S.displayLines = buildDisplayLines(S.prompterLines); } catch (e) { S.displayLines = []; }
  S.activeDisplayIndex = 0;
  debugPrompterPdfScriptKinds(tag);
}

// ── Display-line ↔ turn mapping helpers ─────────────────────────────

function firstDisplayForPrompter(idx) {
  const [first] = displayRangeForPrompter(S.displayLines, idx);
  return first === -1 ? 0 : first;
}

/** Move the highlight to the first display line of S.prompterIndex's turn. */
function alignDisplayToPrompter() {
  if (!S.displayLines.length) { S.activeDisplayIndex = 0; return; }
  S.activeDisplayIndex = firstDisplayForPrompter(S.prompterIndex);
}

/** Rebuild the display-line layer from current prompterLines (used by the
    partner after receiving the actor's script over the data channel). */
function rebuildDisplayLines() {
  try { S.displayLines = buildDisplayLines(S.prompterLines); } catch (e) { S.displayLines = []; }
  alignDisplayToPrompter();
}

/**
 * Advance the highlight by one display line. If it crosses out of the
 * current turn's range, hand off to the turn-level advance so AI-speak /
 * VAD / WebRTC sync / recording stay coherent.
 * Returns true if it advanced within the same turn (display-only).
 */
/** Next display index >= d within turnIdx that is actually spoken by the
    actor (skips stage directions / parentheticals). -1 if none remain. */
function nextSpokenDisplayInTurn(d, turnIdx) {
  for (let i = d; i < S.displayLines.length; i++) {
    const dl = S.displayLines[i];
    if (!dl || dl.prompterIndex !== turnIdx) return -1;
    if (!dl.isStageDirection && !dl.isParenthetical && dl.type === 'actor') return i;
  }
  return -1;
}

function advanceDisplayLine() {
  const cur = S.displayLines[S.activeDisplayIndex];
  const next = S.displayLines[S.activeDisplayIndex + 1];
  if (!cur) return false;
  if (next && next.prompterIndex === cur.prompterIndex) {
    S.activeDisplayIndex++;
    refreshPrompterAfterAdvance();
    return true;
  }
  return false; // caller performs the turn advance
}

// ── STT word-following (Scribe v2) ──────────────────────────────────
// STT drives activeDisplayIndex by matching the live transcript to the
// actor's script words; the VAD path stays armed as a silent fallback
// for when STT stalls (paraphrase / recognition error).

let _sttSessionActive = false;   // WS open for this take
const STT_WORD_NORM = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']/gu, '');
let _sttWords = [];              // [{ w, displayIndex }] for the current actor turn
let _sttWordPtr = 0;
let _sttTurnIndex = -1;          // prompterIndex the matcher is built for
let _lastSttAdvanceTs = 0;       // when STT last moved the highlight
const STT_MATCH_WINDOW = 14;

function sttFollowEnabled() {
  if (S.sessionMode !== 'ai') return false;
  if (S.mode !== 'ai' && S.mode !== 'auto') return false;
  return !!(S.cwServerSession && S.cwServerSession.email) ||
         !!(S.userAccess && S.userAccess.verified && S.userAccess.email);
}

function sttLangCode() {
  try {
    const loc = S.lockedVoiceLocale || S.selectedLocale;
    const cfg = getLocaleConfig(loc);
    return (cfg && cfg.languageCode) || '';
  } catch (_e) { return ''; }
}

/** Build the word→displayIndex map for the actor's current turn. */
function buildSttMatcherForTurn(turnIdx) {
  _sttWords = [];
  _sttWordPtr = 0;
  _sttTurnIndex = turnIdx;
  for (let d = 0; d < S.displayLines.length; d++) {
    const dl = S.displayLines[d];
    if (dl.prompterIndex !== turnIdx) continue;
    if (dl.type !== 'actor' || dl.isParenthetical || dl.isStageDirection) continue;
    for (const raw of String(dl.text || '').split(/\s+/)) {
      const w = STT_WORD_NORM(raw);
      if (w) _sttWords.push({ w, displayIndex: d });
    }
  }
}

/** Align the live transcript tail to the script and lead the highlight. */
function onSttWords(words) {
  if (!_sttSessionActive) return;
  if (_sttTurnIndex !== S.prompterIndex || !_sttWords.length) return;
  const tail = words.slice(-4);
  if (!tail.length) return;
  const lo = _sttWordPtr;
  const hi = Math.min(_sttWords.length, _sttWordPtr + STT_MATCH_WINDOW);
  let bestEnd = -1, bestScore = 0;
  for (let start = lo; start < hi; start++) {
    let score = 0, k = start;
    for (let ti = 0; ti < tail.length && k < _sttWords.length; ti++, k++) {
      const sw = _sttWords[k].w, tw = tail[ti];
      const last = ti === tail.length - 1;
      if (sw === tw || (last && (sw.startsWith(tw) || tw.startsWith(sw)))) score++;
      else break;
    }
    if (score > bestScore) { bestScore = score; bestEnd = start + score; }
  }
  if (bestScore < 1 || bestEnd <= _sttWordPtr) return; // no forward progress — hold
  _sttWordPtr = bestEnd;
  _lastSttAdvanceTs = Date.now();
  if (_sttWordPtr >= _sttWords.length) { sttFinishTurn(); return; }
  // Lead one word ahead so the next line lights up as you finish the
  // current one — hides the ~400ms transcription latency.
  const leadPtr = Math.min(_sttWords.length - 1, _sttWordPtr + 1);
  const di = _sttWords[leadPtr].displayIndex;
  if (di !== S.activeDisplayIndex) { S.activeDisplayIndex = di; refreshPrompterAfterAdvance(); }
}

/** Actor finished the turn per STT → advance to the next turn. */
function sttFinishTurn() {
  if (S.prompterIndex >= S.prompterLines.length - 1) return;
  const lineIndex = S.prompterIndex;
  if (S.prompterIndex !== lineIndex) return;
  S.prompterIndex++;
  S.lastAutoSpokenIndex = -1;
  alignDisplayToPrompter();
  refreshPrompterAfterAdvance();
  syncPrompter();
  handleCurrentLineAutomation();
}

/** Start the STT session for the whole take (capture stays paused until
    an actor turn). Safe to call when ineligible — it just no-ops. */
async function maybeStartSttSession() {
  if (_sttSessionActive || isSttRunning()) return;
  if (!sttFollowEnabled()) return;
  const ok = await startSttFollow({ lang: sttLangCode(), onWords: onSttWords });
  if (ok) {
    _sttSessionActive = true;
    // If we're already on an actor turn (e.g. it connected mid-turn),
    // build the matcher and start capturing right away.
    const cur = S.prompterLines[S.prompterIndex];
    if (cur && cur.type === 'actor' && !S.sessionPaused) { buildSttMatcherForTurn(S.prompterIndex); setSttCapturing(true); }
    else setSttCapturing(false);
    console.info('[stt] session started');
  } else console.info('[stt] unavailable → VAD fallback');
}

function stopSttSession() {
  _sttSessionActive = false;
  _sttWords = []; _sttWordPtr = 0; _sttTurnIndex = -1; _lastSttAdvanceTs = 0;
  stopSttFollow();
}

// Walk the highlight through a spoken AI/partner turn IN SYNC WITH THE
// ACTUAL VOICE: a rAF loop maps real playback progress (from
// S.ttsPlaybackInfo, set by tts.js) onto the turn's display lines by
// cumulative word fraction — no drift, never runs ahead of the audio.
let _spokenStepRaf = null;
function clearDisplayStepTimers() {
  if (_spokenStepRaf) { cancelAnimationFrame(_spokenStepRaf); _spokenStepRaf = null; }
}

function startSpokenDisplayStepping(turnIdx) {
  clearDisplayStepTimers();
  const [first, last] = displayRangeForPrompter(S.displayLines, turnIdx);
  if (first === -1 || last <= first) return; // single display line — nothing to step
  S.activeDisplayIndex = first;
  // Only spoken display lines get a share of the voice timeline — stage
  // directions / parentheticals are passed instantly so the highlight never
  // dwells on them "as if read aloud".
  const steps = []; // { idx, cum } cumulative word count at the END of each spoken line
  let total = 0;
  for (let d = first; d <= last; d++) {
    const dl = S.displayLines[d];
    if (!dl || dl.isStageDirection || dl.isParenthetical) continue;
    const w = ((dl.text || '').split(/\s+/).filter(Boolean)).length || 1;
    total += w; steps.push({ idx: d, cum: total });
  }
  if (!steps.length) return;
  const tick = () => {
    if (!__cwSessionActive || S.sessionPaused || S.prompterIndex !== turnIdx) { _spokenStepRaf = null; return; }
    const info = S.ttsPlaybackInfo;
    // Hold on the first line until the voice ACTUALLY starts (TTS fetch +
    // decode latency); only follow real playback progress — never guess
    // ahead of the audio.
    if (info && info.durationMs > 0) {
      const frac = Math.min(1, (Date.now() - info.startTs) / info.durationMs);
      const spokenWords = frac * total;
      let target = steps[0].idx;
      for (let i = 0; i < steps.length; i++) {
        if (spokenWords >= steps[i].cum) target = (i + 1 < steps.length) ? steps[i + 1].idx : steps[i].idx;
      }
      if (target !== S.activeDisplayIndex && S.displayLines[target] && S.displayLines[target].prompterIndex === turnIdx) {
        S.activeDisplayIndex = target;
        refreshPrompterAfterAdvance();
      }
    }
    _spokenStepRaf = requestAnimationFrame(tick);
  };
  _spokenStepRaf = requestAnimationFrame(tick);
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
  // Switch to minimal take UI now (during the countdown) so the old
  // record/mic/view controls aren't visible behind the countdown overlay.
  const _sess = document.getElementById('session');
  if (_sess) _sess.classList.add('take-active');
  track('take_countdown_start', { mode: S.sessionMode });
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
  // Fixed 5-second countdown (not configurable)
  const steps = [5, 4, 3, 2, 1];
  const freqs = [800, 800, 800, 800, 1200];
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
  var speedTri = document.getElementById('speedTriTake');
  if (mobCtrl) mobCtrl.style.cssText = '';
  if (mobAct) mobAct.style.cssText = '';
  if (sessTop) sessTop.style.cssText = '';
  if (speedTri) speedTri.style.cssText = '';
  // Tag the session with the active view so CSS can hide text-only controls
  // (nav arrows + speed) in video-only mode where they serve no purpose.
  var sessEl = document.getElementById('session');
  if (sessEl) { sessEl.classList.remove('vm-50-50', 'vm-prompt', 'vm-video'); sessEl.classList.add('vm-' + m); }
  if (m === 'prompt') {
    if (vc) vc.style.display = 'none';
    va.style.setProperty('width', '0', 'important'); va.style.setProperty('display', 'none', 'important');
    pa.style.setProperty('left', '0', 'important'); pa.style.setProperty('width', '100%', 'important');
    pa.style.height = '100dvh'; pa.style.top = '0'; pa.style.fontSize = '1.3rem';
    if (isLandscape) {
      // Text-only landscape: reserve a 58px toolbar strip at the bottom so the
      // playback + speed controls sit BELOW the script, never over it.
      pa.style.setProperty('position', 'fixed', 'important');
      pa.style.setProperty('right', '0', 'important');
      pa.style.setProperty('top', '0', 'important');
      pa.style.setProperty('bottom', '58px', 'important');
      pa.style.setProperty('height', 'auto', 'important');
      if (mobCtrl) { mobCtrl.style.setProperty('left', '8px', 'important'); mobCtrl.style.setProperty('right', 'auto', 'important'); mobCtrl.style.setProperty('bottom', '8px', 'important'); mobCtrl.style.setProperty('top', 'auto', 'important'); mobCtrl.style.setProperty('transform', 'none', 'important'); }
      if (speedTri) { speedTri.style.setProperty('left', '50%', 'important'); speedTri.style.setProperty('right', 'auto', 'important'); speedTri.style.setProperty('transform', 'translateX(-50%)', 'important'); speedTri.style.setProperty('bottom', '10px', 'important'); speedTri.style.setProperty('top', 'auto', 'important'); speedTri.style.setProperty('width', 'min(44vw,260px)', 'important'); }
      if (mobAct) { mobAct.style.setProperty('left', 'auto', 'important'); mobAct.style.setProperty('right', '8px', 'important'); mobAct.style.setProperty('bottom', '8px', 'important'); mobAct.style.setProperty('top', 'auto', 'important'); mobAct.style.setProperty('transform', 'none', 'important'); mobAct.style.setProperty('flex-direction', 'row', 'important'); }
      if (sessTop) { sessTop.style.setProperty('left', '0', 'important'); sessTop.style.setProperty('right', '0', 'important'); }
    } else if (window.innerWidth >= 768) {
      pa.style.marginTop = '0'; pa.style.position = 'fixed'; pa.style.bottom = '0'; pa.style.left = '0'; pa.style.right = '0';
    } else {
      // Portrait phone, text-only: the screen is too narrow for one row, so
      // stack the controls in a reserved bottom strip — playback row on top,
      // speed row below — never over the script.
      pa.style.setProperty('position', 'fixed', 'important');
      pa.style.setProperty('top', '0', 'important');
      pa.style.setProperty('bottom', '108px', 'important');
      pa.style.setProperty('height', 'auto', 'important');
      if (mobCtrl) { mobCtrl.style.setProperty('left', '50%', 'important'); mobCtrl.style.setProperty('right', 'auto', 'important'); mobCtrl.style.setProperty('transform', 'translateX(-50%)', 'important'); mobCtrl.style.setProperty('bottom', 'calc(58px + env(safe-area-inset-bottom,0px))', 'important'); mobCtrl.style.setProperty('top', 'auto', 'important'); }
      if (speedTri) { speedTri.style.setProperty('left', '50%', 'important'); speedTri.style.setProperty('right', 'auto', 'important'); speedTri.style.setProperty('transform', 'translateX(-50%)', 'important'); speedTri.style.setProperty('bottom', 'calc(12px + env(safe-area-inset-bottom,0px))', 'important'); speedTri.style.setProperty('top', 'auto', 'important'); speedTri.style.setProperty('width', 'min(82vw,300px)', 'important'); }
    }
  } else if (m === 'video') {
    pa.style.setProperty('display', 'none', 'important');
    va.style.setProperty('width', '100%', 'important'); va.style.setProperty('height', '100dvh', 'important');
    if (isLandscape) {
      va.style.setProperty('right', '0', 'important');
      // Stop (top-left corner) + centered pause are handled by the landscape
      // CSS defaults — don't override them here.
      if (sessTop) { sessTop.style.setProperty('left', '0', 'important'); sessTop.style.setProperty('right', '0', 'important'); }
    }
  }
  renderPrompter();
  updateViewModeButtons();
  // Refresh every rendered toggle so the selection is visible from the
  // setup screen and the pause menu too
  ['viewModeSetup', 'viewModePause', 'viewModeSession'].forEach(id => {
    if (document.getElementById(id) && document.getElementById(id).childElementCount) renderViewModeToggle(id);
  });
}

function cycleViewMode() {
  var modes = ['50-50', 'prompt', 'video'];
  var i = modes.indexOf(S.sessionViewMode);
  setViewMode(modes[(i + 1) % modes.length]);
}

// Teleprompter text size — compensates for browser chrome (Safari bars) eating
// vertical space, and reading distance. Persisted in localStorage.
function applyFontScale() {
  var scale = S.prompterFontScale || 'medium';
  var pa = document.querySelector('.prompter-area');
  if (pa) { pa.classList.remove('fs-small', 'fs-medium', 'fs-large'); pa.classList.add('fs-' + scale); }
  document.querySelectorAll('#fontSizeTri .fs-btn').forEach(function (b) {
    b.classList.toggle('selected', b.getAttribute('data-fs') === scale);
  });
}

function setFontScale(scale) {
  S.prompterFontScale = scale;
  try { localStorage.setItem('cw_fontScale', scale); } catch (_e) {}
  applyFontScale();
  if (typeof forceScrollToActive === 'function') forceScrollToActive();
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
  if (words <= 3) return 550;
  if (words <= 10) return 900;
  return 1300;
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
  clearDisplayStepTimers();
  stopAutoVAD();
  setSttCapturing(false); // pause STT audio; keep the WS open for the take
}

/** TTS was refused for lack of credits: freeze the take where it is
    (no silent scrolling), surface a toast; the credit/top-up modal is
    already shown by the caller. The recording keeps running so the actor
    can top up and resume, or end the take. */
function haltForCredits() {
  cancelSpeechFlow();
  showToast(t('insufficientCredits'), 5000);
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
      showToast(t('sesMicForVad'), 5000);
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
    // Base the silence window on the CURRENT SENTENCE (display line), not the
    // whole speech — otherwise a long monologue waits ~1.8s to step one line.
    // When STT is following, VAD is only a backstop: the onAutoSpeechEnd guard
    // (ignores silence within 1.5s of an STT advance) stops it pre-empting, so
    // a small +200 buffer is enough. minSpeechMs requires real speech first so
    // a silent mid-thought pause never advances.
    const curDisp = S.displayLines[S.activeDisplayIndex];
    const silenceBase = (curDisp && curDisp.type === 'actor' && !curDisp.isStageDirection) ? curDisp : line;
    const silenceMs = computeSilenceMsForActorLine(silenceBase) + (_sttSessionActive ? 200 : 0);
    console.info('[VAD] arming: silence=' + silenceMs + 'ms, stt=' + _sttSessionActive + ', postTtsDelay=' + postTtsDelay + 'ms');
    S.vad = new VoiceActivityDetector({ speechThreshold: 0.010, silenceDuration: silenceMs, minSpeechMs: 350, onSpeechEnd: onAutoSpeechEnd });
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
  const dl0 = S.displayLines[S.activeDisplayIndex];
  const next0 = S.displayLines[S.activeDisplayIndex + 1];
  const isLastOfTurn = dl0 && (!next0 || next0.prompterIndex !== dl0.prompterIndex);
  // STT in control: if it moved the highlight recently, let it lead and
  // don't double-advance on this silence — EXCEPT on the last line of the
  // turn, where STT can't lead any further, so a silence means "done":
  // finish the turn promptly instead of waiting on STT to catch the final word.
  if (_sttSessionActive && !isLastOfTurn && (Date.now() - _lastSttAdvanceTs) < 1500) return;
  const dl = S.displayLines[S.activeDisplayIndex];
  if (!dl || dl.type !== 'actor') return;
  // Still more spoken display lines in this actor speech \u2192 advance to the
  // next one (skipping any stage directions) and re-arm, so the highlight
  // walks sentence by sentence.
  const nx = nextSpokenDisplayInTurn(S.activeDisplayIndex + 1, dl.prompterIndex);
  if (nx !== -1) {
    console.info('[VAD] speech ended \u2192 next display line');
    S.activeDisplayIndex = nx;
    refreshPrompterAfterAdvance();
    armAutoVADForActorLine();
    return;
  }
  // Last display line of the actor's turn \u2192 advance the turn
  console.info('[VAD] speech ended \u2192 advancing turn');
  if (S.prompterIndex >= S.prompterLines.length - 1) return;
  const line = S.prompterLines[S.prompterIndex];
  const lineIndex = S.prompterIndex;
  const advance = () => {
    if (!__cwSessionActive || S.sessionPaused) return;
    if (S.prompterIndex !== lineIndex) return; // manual nav during the delay
    S.prompterIndex++;
    S.lastAutoSpokenIndex = -1;
    alignDisplayToPrompter();
    refreshPrompterAfterAdvance();
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
    alignDisplayToPrompter();
    refreshPrompterAfterAdvance();
    syncPrompter();
    handleCurrentLineAutomation();
  }, computeLineDelayMs(S.prompterLines[lineIndex], S.prompterLines[lineIndex + 1]));
}

// =====================================================================
//  Prompter rendering & scroll
// =====================================================================

function scrollActiveLineToCenter(pa, el) {
  const targetY = pa.scrollTop + el.getBoundingClientRect().top - pa.getBoundingClientRect().top - pa.clientHeight * 0.5 + el.offsetHeight / 2;
  pa.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
}

// Programmatic-scroll guard: smooth animations emit scroll events for
// longer than any fixed timeout, and stray events were being misread as
// USER scrolling (suppressing auto-follow for 15s). The guard now stays
// armed until scroll events stop for 350ms.
let _scrollGuardTimer = null;
function _beginProgrammaticScroll() {
  _scrollSyncProgrammatic = true;
  _extendScrollGuard();
}
function _extendScrollGuard() {
  if (_scrollGuardTimer) clearTimeout(_scrollGuardTimer);
  _scrollGuardTimer = setTimeout(() => { _scrollSyncProgrammatic = false; _scrollGuardTimer = null; }, 350);
}

/** Lightweight per-advance update: toggle active/past/future classes and
    move the turn dot without rebuilding the prompter DOM. Keys off the
    display-line layer (activeDisplayIndex). */
function updatePrompterProgress() {
  const pa = document.getElementById('prompterArea');
  if (!pa) return false;
  const els = pa.querySelectorAll('[data-display-index]');
  if (!els.length) return false;
  const cur = S.activeDisplayIndex;
  let found = false;
  els.forEach(el => {
    const idx = parseInt(el.dataset.displayIndex, 10);
    const isLine = el.classList.contains('prompter-line');
    const isActive = isLine && idx === cur;
    if (isActive) found = true;
    el.classList.toggle('active', isActive);
    el.classList.toggle('past', idx < cur);
    el.classList.toggle('future', idx > cur);
  });
  if (!found) return false; // active line not in DOM — caller should full-render
  pa.querySelectorAll('.turn-dot').forEach(d => d.remove());
  const act = pa.querySelector('.prompter-line.active');
  const dl = S.displayLines[cur];
  if (act && dl && dl.type === 'actor') {
    const dot = document.createElement('span');
    dot.className = 'turn-dot turn-actor';
    act.appendChild(dot);
  }
  if (!S.userScrolledUp && act) {
    _beginProgrammaticScroll();
    requestAnimationFrame(() => {
      scrollActiveLineToCenter(pa, act);
    });
  }
  return true;
}

/** Update the prompter after an index advance: lightweight path with a
    full-render fallback. */
function refreshPrompterAfterAdvance() {
  if (!updatePrompterProgress()) renderPrompter();
}

function forceScrollToActive(force) {
  if (!force && S.userScrolledUp) return;
  const pa = document.getElementById('prompterArea'); if (!pa) return;
  const act = pa.querySelector('.prompter-line.active') || pa.querySelector('[data-display-index="' + S.activeDisplayIndex + '"]');
  if (!act) return;
  S.userScrolledUp = false;
  _beginProgrammaticScroll();
  requestAnimationFrame(() => {
    scrollActiveLineToCenter(pa, act);
  });
}

function renderPrompter() {
  const a = document.getElementById('prompterArea');
  const emptyTxt = (typeof t === 'function' && t('prompterEmptyText')) || 'Aucun texte charg\u00e9';
  if (!S.displayLines.length) {
    a.innerHTML = '<div class="prompter-empty" id="prompterEmptyText"></div>';
    const pe = a.querySelector('.prompter-empty');
    if (pe) pe.textContent = emptyTxt;
    return;
  }
  a.textContent = '';
  const cur = S.activeDisplayIndex;
  let groupEl = null, segWrap = null, groupKey = null;
  for (let d = 0; d < S.displayLines.length; d++) {
    const dl = S.displayLines[d];
    const tense = d < cur ? ' past' : (d > cur ? ' future' : '');
    // Action / slug \u2192 standalone block, breaks any open group
    if (dl.kind === LINE_TYPE.SLUG || (dl.kind === LINE_TYPE.ACTION && !dl.isParenthetical)) {
      groupEl = null; groupKey = null;
      const block = document.createElement('div');
      block.className = (dl.kind === LINE_TYPE.SLUG ? 'prompter-slug' : 'prompter-action') + tense;
      block.dataset.displayIndex = String(d);
      block.dataset.lineIndex = String(dl.prompterIndex);
      block.textContent = dl.text;
      block.addEventListener('click', () => handleTapToJump(dl.prompterIndex));
      a.appendChild(block);
      continue;
    }
    // Dialogue display line \u2192 grouped under one character header per turn
    if (groupKey !== dl.prompterIndex) {
      const isSel = S.selectedChar && normalizeCharacterNameForGroup(dl.char) === normalizeCharacterNameForGroup(S.selectedChar);
      groupEl = document.createElement('div');
      groupEl.className = 'prompter-group' + (isSel ? ' prompter-group-user' : ' prompter-group-partner');
      const header = document.createElement('div');
      header.className = 'prompter-character';
      header.textContent = dl.char || '';
      groupEl.appendChild(header);
      segWrap = document.createElement('div');
      segWrap.className = 'prompter-segments';
      groupEl.appendChild(segWrap);
      a.appendChild(groupEl);
      groupKey = dl.prompterIndex;
    }
    if (dl.isParenthetical) {
      const parEl = document.createElement('div');
      parEl.className = 'prompter-parenthetical' + tense;
      parEl.dataset.displayIndex = String(d);
      parEl.dataset.lineIndex = String(dl.prompterIndex);
      parEl.textContent = dl.text;
      segWrap.appendChild(parEl);
      continue;
    }
    const lineEl = document.createElement('div');
    let cls = 'prompter-line';
    if (d === cur) cls += ' active';
    else cls += tense;
    if (dl.type === 'partner') cls += ' prompter-line-partner';
    if (dl.isStageDirection) cls += ' is-stage-direction';
    lineEl.className = cls;
    lineEl.dataset.displayIndex = String(d);
    lineEl.dataset.lineIndex = String(dl.prompterIndex);
    lineEl.appendChild(document.createTextNode(dl.text));
    if (d === cur && dl.type === 'actor') {
      const dot = document.createElement('span');
      dot.className = 'turn-dot turn-actor';
      lineEl.appendChild(dot);
    }
    lineEl.addEventListener('click', () => handleTapToJump(dl.prompterIndex));
    segWrap.appendChild(lineEl);
  }
  if (!S.userScrolledUp) {
    const act = a.querySelector('.prompter-line.active') || a.querySelector('[data-display-index="' + cur + '"]');
    if (act) {
      _beginProgrammaticScroll();
      requestAnimationFrame(() => {
        scrollActiveLineToCenter(a, act);
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
  // STT captures only during the actor's turn (don't transcribe the AI's voice)
  if (line.type !== 'actor') setSttCapturing(false);
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
      alignDisplayToPrompter();
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
    alignDisplayToPrompter();
    refreshPrompterAfterAdvance();
    startSpokenDisplayStepping(currentIndex);
    aiSpeak(spokenText, () => { S.lastTTSEndTs = Date.now(); clearDisplayStepTimers(); scheduleAfterPartner(currentIndex); });
    return;
  }
  if ((S.mode === 'auto' || S.mode === 'ai') && line.type === 'actor') {
    S.userScrolledUp = false;
    if (S._scrollResumeTimer) { clearTimeout(S._scrollResumeTimer); S._scrollResumeTimer = null; }
    // If the highlight is sitting on a stage direction at the start of the
    // turn (a leading didascalie / parenthetical), jump straight to the first
    // spoken sentence — never arm VAD/STT waiting for the actor to read it.
    const spoken = nextSpokenDisplayInTurn(S.activeDisplayIndex, S.prompterIndex);
    if (spoken !== -1 && spoken !== S.activeDisplayIndex) { S.activeDisplayIndex = spoken; refreshPrompterAfterAdvance(); }
    forceScrollToActive(true);
    // STT word-following drives the highlight; VAD stays armed as a silent
    // fallback for when STT stalls. STT only follows real dialogue lines.
    buildSttMatcherForTurn(S.prompterIndex);
    if (_sttSessionActive) setSttCapturing(true);
    else void maybeStartSttSession();
    if (line.inMonologue && !_sttSessionActive) { scheduleMonologueAdvance(); return; }
    armAutoVADForActorLine();
  }
}

/** Monologue blocks: paced timed crawl (~160 wpm), no VAD wait. Advances
    one DISPLAY line per tick; crossing a turn boundary bumps prompterIndex
    so WebRTC sync / recording stay coherent. */
function scheduleMonologueAdvance() {
  clearAutoTimer();
  const dIdx = S.activeDisplayIndex;
  const dl = S.displayLines[dIdx];
  if (!dl) return;
  if (dIdx >= S.displayLines.length - 1) return;
  const words = ((dl.text || '').split(/\s+/).filter(Boolean)).length;
  const paceMult = voicePaceMultiplier();
  // Stage directions / parentheticals are not read aloud — flash past them
  // instead of dwelling word-count time as if reading them silently.
  const isSilent = dl.isStageDirection || dl.isParenthetical;
  const ms = isSilent ? 60 : Math.max(900, Math.round(words * 380 * paceMult));
  S.autoAdvanceTimer = setTimeout(() => {
    if (!__cwSessionActive || S.sessionPaused) return;
    if (S.activeDisplayIndex !== dIdx) return;
    if (S.mode === 'manual') return;
    const nextDl = S.displayLines[dIdx + 1];
    S.activeDisplayIndex = dIdx + 1;
    if (nextDl && nextDl.prompterIndex !== dl.prompterIndex) {
      // crossed into a new turn — keep the turn pointer in step
      S.prompterIndex = nextDl.prompterIndex;
      S.lastAutoSpokenIndex = -1;
      refreshPrompterAfterAdvance();
      syncPrompter();
      handleCurrentLineAutomation();
    } else {
      refreshPrompterAfterAdvance();
      scheduleMonologueAdvance();
    }
  }, ms);
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
  alignDisplayToPrompter();
  refreshPrompterAfterAdvance();
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
  alignDisplayToPrompter();
  refreshPrompterAfterAdvance();
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
  alignDisplayToPrompter();
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
    const centerY = pa.getBoundingClientRect().top + pa.clientHeight * 0.5;
    let closest = -1, closestDist = Infinity;
    var closestAny = -1, closestAnyDist = Infinity;
    pa.querySelectorAll('.prompter-line').forEach(el => {
      const idx = parseInt(el.dataset.displayIndex); if (isNaN(idx)) return;
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const d = Math.abs(mid - centerY);
      if (d < closestAnyDist) { closestAnyDist = d; closestAny = idx; }
      var dl = S.displayLines[idx];
      if (dl && dl.type !== 'context' && d < closestDist) { closestDist = d; closest = idx; }
    });
    if (closest < 0) closest = closestAny;
    if (closest >= 0 && closest !== S.activeDisplayIndex) {
      S.activeDisplayIndex = closest;
      const dl = S.displayLines[closest];
      if (dl) S.prompterIndex = dl.prompterIndex;
      pa.querySelectorAll('.prompter-line.active').forEach(el => el.classList.remove('active'));
      pa.querySelectorAll('.prompter-line').forEach(el => {
        if (parseInt(el.dataset.displayIndex) === closest) el.classList.add('active');
      });
      syncPrompter();
    }
  }, 50);
}

// =====================================================================
//  Camera / Mic
// =====================================================================

/** iPad front cameras are ultra-wide (Center Stage) and getUserMedia
    ignores zoom constraints on Safari — applyConstraints after
    acquisition is the path that works. If zoom can't be normalised,
    fall back to a centered 70% canvas crop (S.recCropFactor). */
async function applyCameraFieldOfViewFix(track) {
  S.recCropFactor = 1;
  const isIPad = /iPad/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
  let zoomNormalised = false;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.zoom) {
      await track.applyConstraints({ advanced: [{ zoom: 1 }] });
      zoomNormalised = true;
    }
  } catch (_e) { /* constraint not honored */ }
  if (isIPad && S.currentFacingMode === 'user' && !zoomNormalised) {
    S.recCropFactor = 0.7;
    console.info('[camera] iPad front cam: zoom constraint unavailable → 0.7 centered crop');
  }
}

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
    { video: { facingMode: { ideal: S.currentFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr = null;
  for (const c of videoAttempts) {
    try {
      const vs = await navigator.mediaDevices.getUserMedia(c);
      const vt = vs.getVideoTracks()[0];
      if (vt) {
        vt.enabled = S.isCamOn;
        await applyCameraFieldOfViewFix(vt);
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
    showToast(t('cameraDenied'), 5000);
  } else {
    noVideoEl.style.display = 'flex'; noVideoEl.textContent = '\uD83D\uDCF7 Camera unavailable';
    showToast(t('sesCameraUnavailableMsg', { msg: (lastErr && lastErr.message || '') }), 5000);
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
    showToast(t('micDenied'), 5000);
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
      showToast(t('sesMicUnavailable'), 4000);
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
    showToast(t('sesCameraAudioOnly'), 4000);
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
  const target = S.currentFacingMode === 'user' ? 'environment' : 'user';
  const oldTracks = S.localStream ? S.localStream.getVideoTracks() : [];
  // Acquire the new camera. `exact` is rejected on many Android devices,
  // and some can't open a 2nd camera while the 1st is live — so try
  // exact, then ideal, then (stopping the old track) ideal again.
  async function acquire() {
    const dims = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: target }, ...dims }, audio: false });
    } catch (e1) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: target }, ...dims }, audio: false });
      } catch (e2) {
        // Camera may be busy holding the current track — release and retry
        oldTracks.forEach(t => t.stop());
        return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: target }, ...dims }, audio: false });
      }
    }
  }
  try {
    const newStream = await acquire();
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) throw new Error('no video track');
    S.currentFacingMode = target;
    await applyCameraFieldOfViewFix(newTrack);
    if (S.localStream) {
      S.localStream.getVideoTracks().forEach(t => { S.localStream.removeTrack(t); try { t.stop(); } catch (_e) {} });
      S.localStream.addTrack(newTrack);
    } else {
      S.localStream = new MediaStream([newTrack]);
    }
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
    console.warn('[camera] switch failed:', e && e.message);
    showToast(t('sesCameraSwitchUnavailable'), 3500);
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
    renderAllSpeedSliders();
    renderViewModeToggle('viewModePause');
    applyFontScale();
    // AI voice speed only makes sense in AI mode
    const _vss = document.getElementById('psVoiceSpeedSection');
    if (_vss) _vss.style.display = S.sessionMode === 'ai' ? '' : 'none';
    if (overlay) overlay.classList.add('active');
    if (btn) btn.classList.add('is-paused');
    if (icon) icon.innerHTML = '<polygon points="6,4 20,12 6,20" fill="currentColor"/>';
    if (mobBtn) mobBtn.classList.add('is-paused');
    if (recInd) recInd.style.display = 'none';
    // NOTE: do NOT pause the MediaRecorder here. On Android Webviews
    // (Brave/Samsung) MediaRecorder.pause() can drop the whole recording.
    // We keep it rolling through the pause (the take just includes the
    // gap) — never lose footage. The prompter/AI/STT still freeze below.
    if (S.conn && S.conn.open) S.conn.send({ type: 'pause' });
  } else {
    if (typeof window.markTakePaused === 'function') window.markTakePaused(false);
    unfreezeTimer();
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
  renderAllSpeedSliders();
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
      showToast(t('sesYouPlay', { name: char }));
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
  if (S.selectedVoice) showToast(t('sesVoiceLabel', { name: S.selectedVoice.label }));
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
  hideEndTakeModal(); // close the confirm shell — the review modal takes over
  endSession();
}

// =====================================================================
//  Restart take (Recommencer) — discard recording, prompter to start
// =====================================================================

function confirmRestartTake() {
  if (!confirm(t('restartConfirm'))) return;
  restartTake();
}

function restartTake() {
  track('take_restart', { from: 'pause', take_number: S.takeNumber });
  track('pause_restart', {});
  cancelSpeechFlow();
  // Discard the current recording — never saved
  if (S.isRecording && S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    S._recDiscard = true;
    stopRecording();
  }
  S.prompterIndex = 0;
  S.activeDisplayIndex = 0;
  S.lastAutoSpokenIndex = -1;
  // Close the pause overlay WITHOUT resuming the now-stopped recorder
  S.sessionPaused = false;
  if (typeof window.markTakePaused === 'function') window.markTakePaused(false);
  const overlay = document.getElementById('pauseOverlay'); if (overlay) overlay.classList.remove('active');
  const pbtn = document.getElementById('btnPause'); if (pbtn) pbtn.classList.remove('is-paused');
  const picon = document.getElementById('pauseIcon');
  if (picon) picon.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
  const pmob = document.getElementById('mobMainBtn'); if (pmob) pmob.classList.remove('is-paused');
  unfreezeTimer();
  renderPrompter();
  showClapperboard(() => {
    if (canRecord() && S.localStream && !S.isRecording) startRecording();
    S.userScrolledUp = false;
    handleCurrentLineAutomation();
    forceScrollToActive();
  });
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
  renderAllSpeedSliders();
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
  // Acquire camera/mic first, then let the actor frame the shot before
  // anything records (camera preview screen)
  await ensureSessionStream();
  const proceed = await window.openCameraPreview({ flow: 'ai' });
  if (!proceed) {
    cwSessionStateClear('preview_cancel');
    if (window._cwMicStream) { window._cwMicStream.getTracks().forEach(t => t.stop()); window._cwMicStream = null; }
    if (S.localStream) { S.localStream.getTracks().forEach(t => t.stop()); S.localStream = null; }
    showScreen('setupAi');
    return false;
  }
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
  renderViewModeToggle('viewModeSession');
  renderAllSpeedSliders();
  // Connect STT for the take ahead of time (capture stays paused until an
  // actor turn); falls back to VAD silently if it can't connect.
  void maybeStartSttSession();
  showClapperboard(() => {
    // Recording starts only after the countdown — the take never
    // contains the countdown itself
    if (canRecord() && S.localStream && !S.isRecording) startRecording();
    if (tier !== 'visitor' || getSpecTier() === 'figurant') startSessionTimer();
    else hideTimerBadge();
    setViewMode(S.sessionViewMode);
    applyFontScale();
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

/**
 * End the current TAKE: stop the recorder (its onstop shows the review
 * modal) but keep streams, peer connection, prompter state and the
 * session screen alive so Refaire / Nouvelle prise restart instantly.
 * If nothing was recording, falls through to a full teardown.
 */
function endTake() {
  S.sessionPaused = false;
  if (typeof window.markTakePaused === 'function') window.markTakePaused(false);
  const po = document.getElementById('pauseOverlay'); if (po) po.classList.remove('active');
  const pb = document.getElementById('btnPause'); if (pb) pb.classList.remove('is-paused');
  const pi = document.getElementById('pauseIcon');
  if (pi) pi.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
  const mb = document.getElementById('mobMainBtn'); if (mb) mb.classList.remove('is-paused');
  cancelSpeechFlow();
  if (S.isRecording && S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
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
    };
    const _onstopTimeout = setTimeout(function () {
      if (_onstopDone) return;
      _onstopDone = true;
      console.warn('[rec] onstop timeout \u2014 forcing review');
      _closeRecAudioCtx();
      if (savedChunks.length > 0) {
        try {
          var isMP4 = (savedRecorder.mimeType || '').startsWith('video/mp4');
          var ext = isMP4 ? 'mp4' : 'webm'; var mime = isMP4 ? 'video/mp4' : 'video/webm';
          var blob = new Blob(savedChunks, { type: mime });
          var tk = S.currentTake || {};
          window.showTakeReviewModal(blob, {
            fname: 'citizentape-' + Date.now() + '.' + ext, mime: mime,
            sceneId: tk.sceneId || (window.getSceneId ? window.getSceneId() : 'legacy'),
            sceneName: tk.sceneName || S.currentScriptName || '',
            takeNumber: tk.takeNumber || S.takeNumber,
            wasPaused: !!tk.wasPaused, duration: null, thumb: null,
          });
        } catch (e) { console.error('[rec] timeout review:', e); showToast(t('sesRecNotRecovered'), 3000); teardownSession(); showScreen('home'); }
      } else { showToast(t('sesRecNotSaved'), 3000); teardownSession(); showScreen('home'); }
    }, 5000);
    stopRecording();
  } else {
    teardownSession();
    showScreen('home');
  }
}

/**
 * Full teardown: release streams and peers, reset session UI/state and
 * mark the session over. Called when the actor is truly done (review
 * modal Save\u2192Finish, discard, partner disconnect, navigation home).
 */
function teardownSession() {
  const _wasLive = __cwSessionActive;
  const _ssPrev = (typeof window !== 'undefined' && window.__cwSessionState) || {};
  __cwSessionActive = false;
  cwSessionStateClear('teardownSession');
  stopSessionTimer();
  stopSttSession();
  if (_wasLive && !S.isRecording) {
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
  const _sessEl = document.getElementById('session'); if (_sessEl) _sessEl.classList.remove('take-active');
  if (S._preItalienneVoice) { S.selectedVoice = S._preItalienneVoice; S._preItalienneVoice = null; }
  if (S.connectionTimeout) clearTimeout(S.connectionTimeout);
  cancelSpeechFlow();
  // endTake is the path that preserves footage; any recorder still
  // running here is discarded
  if (S.isRecording && S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    S._recDiscard = true;
    stopRecording();
  }
  try { if (S.conn && S.conn.open) S.conn.send({ type: 'end-session' }); } catch (e) {}
  if (S.call) { S.call.close(); S.call = null; }
  if (S.conn) { S.conn.close(); S.conn = null; }
  if (S.peer) { S.peer.destroy(); S.peer = null; }
  if (window._cwMicStream) { window._cwMicStream.getTracks().forEach(t => t.stop()); window._cwMicStream = null; }
  if (S.localStream) { S.localStream.getTracks().forEach(t => t.stop()); S.localStream = null; }
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
  S.prompterLines = []; S.prompterIndex = 0; S.displayLines = []; S.activeDisplayIndex = 0; S.lastAutoSpokenIndex = -1; S.activeSpeechToken = 0;
  S.recordedChunks = []; S.mediaRecorder = null;
  hideEndTakeModal();
  S.role = 'actor'; S.sessionMode = 'ai';
}

/** Compat wrapper: recording \u2192 end the take (review); else full teardown. */
function endSession() {
  if (S.isRecording && S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    endTake();
  } else {
    teardownSession();
    showScreen('home');
  }
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
    if (_scrollSyncProgrammatic) { _extendScrollGuard(); S._lastPrompterScrollTop = pa.scrollTop; return; }
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
  setFontScale,
  applyFontScale,
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
  haltForCredits,
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
  confirmRestartTake,
  restartTake,
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
  endTake,
  teardownSession,
  cancelConnection,

  // Scroll
  onPrompterScrollSync,
  setupPrompterScrollListeners,
  scrollActiveLineToCenter,
  updatePrompterProgress,
  alignDisplayToPrompter,
  rebuildDisplayLines,
  advanceDisplayLine,
};
