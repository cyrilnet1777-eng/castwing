// js/app.js — Entry point (ES module)
// Imports every module, wires DOMContentLoaded, and registers window.* for onclick handlers.

// ── State ───────────────────────────────────────────────────────────────
import { S, initState, installWindowProperties } from './state.js';

// ── Constants ───────────────────────────────────────────────────────────
import { APP_BUILD } from './constants.js';

// ── Utilities ───────────────────────────────────────────────────────────
import { gaEvent, showToast, escHtml } from './utils.js';

// ── SFX ──────────────────────────────────────────────────────────────
import { unlockAudio } from './sfx.js';

// ── I18n ────────────────────────────────────────────────────────────────
import {
  UI_LANGUAGES,
  t,
  initSiteLanguageSelect,
  applyUILanguage,
  changeUILanguage,
  detectPreferredUILanguage,
} from './i18n.js';

// ── Voices ──────────────────────────────────────────────────────────────
import {
  VOICE_LOCALES,
  EMOTION_PRESETS,
  SPEED_MIN,
  SPEED_MAX,
  SPEED_DEFAULT,
  initVoiceCountrySelect,
  applyLocaleVoices,
  changeVoiceCountry,
  loadVoices,
  setEmotion,
  setVoiceSpeed,
  renderAllSpeedSliders,
  initVoiceGrid,
  changeSessionVoice,
  populateSessionVoiceSelect,
} from './voices.js';

// ── Plan / Timer ────────────────────────────────────────────────────────
import {
  migrateFromCastwing,
  checkAndApplyResets,
  getUserTier,
  getSpecTier,
  isServerAdmin,
  canUseEmotions,
  hideTimerBadge,
  fmtTimer,
  startSessionTimer,
  updateTimerBadge,
  updateChronoDisplay,
  freezeTimer,
  unfreezeTimer,
  canRecord,
  createFreshUserData,
  mergeUserDataDefaults,
} from './plan-timer.js';

// ── Paywall / Credits ───────────────────────────────────────────────────
import {
  tt,
  dismissPaywall,
  showPaywallModal,
  openTopupModal,
  refreshCreditBalance,
  updatePaygoUI,
  handlePaygoToggle,
  buyPaygBlock,
  updateCreditBadge,
  showCreditDepletedModal,
  showVisitorSignupPrompt,
  loadUsageHistory,
} from './paywall.js';

// ── Auth ────────────────────────────────────────────────────────────────
import {
  persistSettings,
  loadSettings,
  loadAccess,
  updateAuthMiniButton,
  openAuthModal,
  closeAuthModal,
  toggleProfileSection,
  logoutUser,
  startChangeEmail,
  requestEmailCode,
  verifyEmailCode,
  startGoogleSignIn,
  fetchServerSession,
  applyServerSessionUI,
  syncAdminPlanSelect,
  toggleBurgerDrawer,
  closeBurgerDrawer,
  resumePendingFileAfterAuth,
} from './auth.js';

// ── Admin ───────────────────────────────────────────────────────────────
import {
  openAdminPanel,
  closeAdminPanel,
  adminCreateInvite,
  adminLoadInvites,
  adminRevokeInvite,
  adminApplyTestPlan,
  redeemInviteFromURL,
} from './admin.js';

// ── IDB (IndexedDB) ────────────────────────────────────────────────────
import {
  toggleRecPanel,
  renderRecordingsList,
  reShareRec,
  reDownloadRec,
  deleteRec,
  renderScriptHistory,
  restoreFromScriptHistory,
  tryRestorePersistedScriptFromIdb,
  clearPersistedScriptMemory,
  saveRecToDB,
  renderProfileRecordings,
} from './idb.js';

// ── TTS ──────────────────────────────────────────────────────────────
import { aiSpeak, cancelTTSPlayback } from './tts.js';

// ── PDF Parsing ─────────────────────────────────────────────────────────
import {
  getChars,
  mergeConsecutiveDialogues,
  sanitizeDialogueVsAction,
  normalizeScreenplayWhitespace,
  syncPdfScriptDebugMirror,
  isPdfDialogueRow,
  cleanCharacterName,
  normalizeScriptLine,
  normCharKeyForWhitelist,
  hasPastedDialogueStructure,
} from './pdf-parse.js';

// ── Script AI (import/parse pipeline) ───────────────────────────────────
import {
  handlePDFInput,
  processTextImport,
  openOptionalScriptReview,
  clearPDF,
  newScriptReset,
  openPdfPicker,
  closeScriptReview,
  cancelPdfParse,
  initDragDrop,
  isPdfUploadFile,
  processPDF,
  finishPdfSetupUi,
  renderChars,
  renderPartnerAssignment,
  buildLines,
} from './script-ai.js';

// ── Session ─────────────────────────────────────────────────────────────
import {
  SCREEN_ROUTES,
  ROUTE_TO_SCREEN,
  showScreen,
  prompterNext,
  prompterPrev,
  togglePause,
  showEndTakeModal,
  hideEndTakeModal,
  confirmEndTake,
  dismissRecModal,
  switchSessionMode,
  setMode,
  cycleViewMode,
  onVadSliderChange,
  toggleMic,
  toggleCam,
  toggleSetupCamera,
  updateSetupCameraButton,
  updateEmotionLock,
  setViewMode,
  renderViewModeToggle,
  showAiControls,
  hideAiOnlyControls,
  cancelConnection,
  startAiSession,
  endSession,
  enterRehearsalMode,
  onPrompterScrollSync,
  setupPrompterScrollListeners,
  cwCommitSessionLive,
  requestRehearsalStart,
  bootstrapAiSessionFromCurrentScript,
  showClapperboard,
  syncSessionModeButtons,
  setSessionSpeed,
  modeHintText,
  debugPrompterPdfScriptKinds,
  setPrompterLinesForSession,
  renderPrompter,
  cancelSpeechFlow,
  cwSessionStateClear,
  cwEnqueueSessionBoot,
  ensureSessionStream,
  fallbackPrompterLinesFromPdfScript,
} from './session.js';

// ── Recording ───────────────────────────────────────────────────────────
import {
  toggleRecording,
  startRecording,
  stopRecording,
  resumeRecording,
  pauseRecording,
  etmSaveToDevice,
  etmShareRec,
  etmDeleteRec,
  showRecSavedModal,
} from './recording.js';

// ── WebRTC ──────────────────────────────────────────────────────────────
import {
  startPartnerSession,
  joinAsPartner,
  copyPartnerCode,
  copyPartnerLink,
  smartShare,
  applyJoinCodeFromURL,
} from './webrtc.js';


// =====================================================================
//  Screen routing helpers
// =====================================================================

function goHome() { endSession(); showScreen('home'); }
function goImportScene() { showScreen('importScene'); initDragDrop('uploadZone1'); renderScriptHistory(); }
function homePickFile() { goImportScene(); }
function goChooseMode() { showScreen('chooseMode'); }
function goPartnerChoice() { showScreen('partnerChoice'); }
function goConfigAi() {
  showScreen('setupAi');
  loadVoices();
  initVoiceCountrySelect();
  applyLocaleVoices(S.selectedLocale, true);
  initVoiceGrid();
  setVoiceSpeed(S.voiceSpeed, true);
  const emo = document.getElementById('emotionSelect');
  if (emo) emo.value = S.selectedEmotion;
  updateEmotionLock();
  updateSetupCameraButton();
}
function goSetupPartner() {
  showScreen('setupPartner');
  // genCode is inline to avoid a circular dependency
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 8; i++) r += c[Math.floor(Math.random() * c.length)];
  document.getElementById('mySessionCodeText').textContent = r;
  initDragDrop('uploadZone2');
}
function goJoin() { showScreen('joinScreen'); }
function goSetupAi() { goImportScene(); }

function handleHomeDrop(e) {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) {
    goImportScene();
    setTimeout(() => {
      const inp = document.getElementById('pdfInput1');
      if (inp) {
        const dt = new DataTransfer();
        dt.items.add(f);
        inp.files = dt.files;
        handlePDFInput(1, inp);
      }
    }, 200);
  }
}

// Stub functions that exist in the monolith but are not yet extracted to modules
function openPaywallModal(msg) { showPaywallModal(); }
function closePaywallModal() {}
function isUsageBlocked() { return false; }
function startUsageTracking() {}

// =====================================================================
//  Card tilt effect (desktop only)
// =====================================================================

function initCardTilt() {
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  if (isTouch) return;
  const cards = document.querySelectorAll('.hcard,.setup-card,.mode-opt,.voice-item,.upload-zone');
  cards.forEach(card => {
    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const rx = ((y / rect.height) - 0.5) * -3;
      const ry = ((x / rect.width) - 0.5) * 3;
      card.style.transform = `translateY(-2px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  });
}

// =====================================================================
//  Version checker (polling IIFE)
// =====================================================================

(function setupVersionCheck() {
  if (typeof window.__deploy !== 'number') return;
  const current = window.__deploy;
  async function check() {
    try {
      const r = await fetch(location.pathname + '?_v=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) return;
      const html = await r.text();
      const m = html.match(/window\.__deploy\s*=\s*(\d+)/);
      if (!m) return;
      const live = Number(m[1]);
      if (Number.isFinite(live) && live > current) {
        const el = document.getElementById('versionBanner');
        if (el) el.style.display = 'block';
      }
    } catch (_e) {}
  }
  setTimeout(check, 5000);
  setInterval(check, 5 * 60 * 1000);
  window.addEventListener('focus', check);
})();

// =====================================================================
//  popstate handler (browser back/forward)
// =====================================================================

window.addEventListener('popstate', function () {
  const h = location.hash.slice(1);
  let screen = ROUTE_TO_SCREEN[h] || 'home';
  if (screen === 'session') screen = 'home';
  if (screen === 'importScene') { goImportScene(); return; }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screen).classList.add('active');
  const bb = document.getElementById('homeBottomBar');
  if (bb) bb.style.display = screen === 'home' ? 'flex' : 'none';
});

// =====================================================================
//  beforeunload guard
// =====================================================================

window.addEventListener('beforeunload', e => {
  if (S.isRecording || window.__cwSessionActive) { e.preventDefault(); e.returnValue = ''; }
});

// =====================================================================
//  DOMContentLoaded
// =====================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // ── Bootstrap state ──
  initState();
  installWindowProperties();
  migrateFromCastwing();

  // ── Build version badges ──
  document.querySelectorAll('#authBuildVersion,#profileBuildVersion').forEach(el => {
    el.textContent = 'v' + APP_BUILD;
  });

  // ── Smart share button label ──
  const _ssb = document.getElementById('smartShareBtn');
  if (_ssb && !navigator.share) _ssb.textContent = 'Copy session link';

  // ── Prompter scroll listeners (from session.js) ──
  setupPrompterScrollListeners();

  // ── Load persisted settings & access ──
  loadAccess();
  checkAndApplyResets();
  setInterval(checkAndApplyResets, 60000);

  const saved = loadSettings();
  if (saved) {
    if (saved.uiLang && UI_LANGUAGES.some(l => l.id === saved.uiLang)) S.selectedUILanguage = saved.uiLang;
    if (saved.voiceLocale && VOICE_LOCALES.some(l => l.id === saved.voiceLocale)) S.selectedLocale = saved.voiceLocale;
    if (saved.emotion && EMOTION_PRESETS[saved.emotion]) S.selectedEmotion = saved.emotion;
    if (Number.isFinite(Number(saved.speedValue))) {
      let sv = Number(saved.speedValue);
      if (sv < 0 || sv > 7 || !Number.isFinite(sv)) sv = SPEED_DEFAULT;
      S.voiceSpeed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, sv));
    } else {
      S.voiceSpeed = SPEED_DEFAULT;
    }
    S.mode = 'ai'; // Voice AI mode is the only mode now
  }

  // ── Auto-detect UI language if none saved ──
  if (!(saved && saved.uiLang && UI_LANGUAGES.some(l => l.id === saved.uiLang))) {
    const detected = await detectPreferredUILanguage();
    if (detected && UI_LANGUAGES.some(l => l.id === detected)) S.selectedUILanguage = detected;
  }

  // ── I18n & voice init ──
  loadVoices();
  initSiteLanguageSelect();
  applyUILanguage();
  updateAuthMiniButton();
  initVoiceCountrySelect();

  const restoredVoiceId = saved && saved.voiceId && saved.voiceId !== '_italienne' ? saved.voiceId : null;
  applyLocaleVoices(S.selectedLocale, true, restoredVoiceId);

  if (S.selectedVoice && S.selectedVoice.id === '_italienne') {
    S.selectedVoice = S.VOICE_PRESETS[0] || null;
    S._preItalienneVoice = null;
  }

  setVoiceSpeed(S.voiceSpeed, true);
  const emo = document.getElementById('emotionSelect');
  if (emo) emo.value = S.selectedEmotion;
  updateEmotionLock();
  setMode(S.mode);

  // ── VAD slider sync from storage ──
  // vadSilenceSeconds is local to session.js; read same localStorage source
  (function syncVadSliderFromStorage() {
    const raw = localStorage.getItem('cw_vadSilence');
    const vadVal = (raw !== null && raw !== '') ? parseFloat(raw) : 0.75;
    const vad = Number.isFinite(vadVal) ? Math.min(5, Math.max(0.10, vadVal)) : 0.75;
    const slider = document.getElementById('vadSilenceSlider');
    const slbl = document.getElementById('vadSilenceLabel');
    if (slider) slider.value = String(vad);
    if (slbl) {
      const r = Math.round(vad * 100) / 100;
      slbl.textContent = (r % 1 === 0 ? r.toFixed(1) : String(r)) + 's';
    }
  })();

  updateSetupCameraButton();
  renderAllSpeedSliders();
  initCardTilt();

  // ── Clear stale #session hash ──
  if (location.hash === '#session') history.replaceState({}, '', location.pathname + location.search);

  // ── Server session / payment ──
  await fetchServerSession();
  if (isServerAdmin()) { dismissPaywall(); closePaywallModal(); }

  // Handle payment return
  const urlParams = new URLSearchParams(window.location.search);
  const paymentParam = urlParams.get('payment');
  const cardSaved = urlParams.get('card_saved');

  if (paymentParam === 'success') {
    gaEvent('purchase', { currency: 'USD' });
    setTimeout(async function () {
      try { await fetch('/api/credits/reconcile', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
      await refreshCreditBalance();
      showToast(tt('paymentSuccess', 'Payment confirmed! Credits added.'), 5000);
      history.replaceState({}, '', '/');
    }, 2000);
  } else if (paymentParam === 'metered-active') {
    gaEvent('purchase', { currency: 'USD', type: 'metered_subscribe' });
    setTimeout(async function () {
      await fetchServerSession();
      S.cwServerSession.billingMode = 'metered';
      showToast('Pay-As-You-Go activated! You\'ll be billed monthly for usage.', 5000);
      history.replaceState({}, '', '/');
    }, 2000);
  } else if (paymentParam === 'cancel') {
    gaEvent('checkout_cancel');
    showToast(tt('paymentCancelled', 'Payment cancelled.'), 3000);
    history.replaceState({}, '', '/');
  } else if (cardSaved === 'success') {
    showToast('Card saved!', 5000);
    history.replaceState({}, '', '/');
  } else if (cardSaved === 'cancel') {
    localStorage.removeItem('cw_autoTopup');
    showToast('Card setup cancelled.', 3000);
    history.replaceState({}, '', '/');
  }

  startUsageTracking();
  redeemInviteFromURL();

  // ── Restore script or route from hash ──
  const joinedFromURL = applyJoinCodeFromURL();
  if (!joinedFromURL) {
    const restoredFromIdb = await tryRestorePersistedScriptFromIdb();
    if (!restoredFromIdb) {
      const initHash = location.hash.slice(1);
      let initScreen = ROUTE_TO_SCREEN[initHash] || 'home';
      if (initScreen === 'session') initScreen = 'home';
      if (initScreen === 'setupPartner') goSetupPartner();
      else if (initScreen === 'setupAi') goSetupAi();
      else if (initScreen === 'importScene') goImportScene();
      else showScreen(initScreen);
      if (isUsageBlocked()) openPaywallModal(t('usageBlocked'));
    }
  }

  // ── Escape key closes burger drawer ──
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const d = document.getElementById('cwBurgerDrawer');
    if (d && d.classList.contains('open')) closeBurgerDrawer();
  });
});

// =====================================================================
//  window.* registration for onclick / onchange / oninput handlers
// =====================================================================
// Every function referenced from HTML attributes (onclick, onchange,
// oninput) MUST be reachable on the global window object.

Object.assign(window, {
  // ── Auth / Admin ──
  openAuthModal,
  closeAuthModal,
  requestEmailCode,
  verifyEmailCode,
  startGoogleSignIn,
  logoutUser,
  startChangeEmail,
  toggleProfileSection,
  toggleBurgerDrawer,
  closeBurgerDrawer,
  openAdminPanel,
  closeAdminPanel,
  adminCreateInvite,
  adminLoadInvites,
  adminRevokeInvite,
  adminApplyTestPlan,

  // ── Paywall / Credits ──
  openTopupModal,
  dismissPaywall,
  handlePaygoToggle,
  buyPaygBlock,

  // ── Session controls ──
  prompterNext,
  prompterPrev,
  togglePause,
  showEndTakeModal,
  hideEndTakeModal,
  confirmEndTake,
  cancelConnection,
  switchSessionMode,
  setMode,
  cycleViewMode,
  toggleSetupCamera,
  onVadSliderChange,
  toggleMic,
  toggleCam,

  // ── Recording ──
  toggleRecording,
  toggleRecPanel,
  stopRecording,
  resumeRecording,
  etmSaveToDevice,
  etmShareRec,
  etmDeleteRec,
  dismissRecModal,

  // ── WebRTC / Partner ──
  startPartnerSession,
  joinAsPartner,
  copyPartnerCode,
  copyPartnerLink,
  smartShare,

  // ── Script import ──
  handlePDFInput,
  processTextImport,
  openOptionalScriptReview,
  clearPDF,
  newScriptReset,
  openPdfPicker,
  closeScriptReview,
  cancelPdfParse,
  restoreFromScriptHistory,
  isPdfUploadFile,
  processPDF,
  finishPdfSetupUi,
  renderChars,
  renderPartnerAssignment,
  buildLines,

  // ── PDF parse (used via window.* by other modules) ──
  mergeConsecutiveDialogues,
  sanitizeDialogueVsAction,
  normalizeScreenplayWhitespace,
  syncPdfScriptDebugMirror,
  isPdfDialogueRow,
  cleanCharacterName,
  normalizeScriptLine,
  normCharKeyForWhitelist,
  hasPastedDialogueStructure,
  getChars,

  // ── I18n ──
  changeUILanguage,

  // ── Voices ──
  changeVoiceCountry,
  changeSessionVoice,
  setEmotion,

  // ── TTS ──
  aiSpeak,
  cancelTTSPlayback,

  // ── Session (used via window.* by other modules) ──
  modeHintText,
  debugPrompterPdfScriptKinds,
  setPrompterLinesForSession,
  renderPrompter,
  cancelSpeechFlow,
  cwSessionStateClear,
  cwEnqueueSessionBoot,
  ensureSessionStream,
  fallbackPrompterLinesFromPdfScript,

  // ── Plan/Timer (used via window.* by other modules) ──
  updateTimerBadge,
  updateChronoDisplay,
  freezeTimer,
  unfreezeTimer,
  canRecord,
  createFreshUserData,
  mergeUserDataDefaults,

  // ── IDB (used via window.* by other modules) ──
  clearPersistedScriptMemory,
  saveRecToDB,
  renderScriptHistory,

  // ── Recording ──
  renderProfileRecordings,
  renderRecordingsList,
  startRecording,

  // ── Auth (used via window.* by other modules) ──
  updateAuthMiniButton,
  persistSettings,
  fetchServerSession,

  // ── SFX ──
  unlockAudio,

  // ── App routing ──
  goHome,
  goImportScene,
  goChooseMode,
  goPartnerChoice,
  goConfigAi,
  goSetupPartner,
  goJoin,
  goSetupAi,
  homePickFile,
  showScreen,
  startAiSession,
  endSession,

  // ── IDB / Recordings (JS-generated onclick) ──
  reDownloadRec,
  reShareRec,
  deleteRec,

  // ── Home drag-and-drop ──
  handleHomeDrop,
  initDragDrop,
});
