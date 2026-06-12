// ── First-launch onboarding ──────────────────────────────────────────
// 3 steps, ≤60s: Welcome → camera+mic permission (blocking on refusal,
// no bypass) → 10-second demo take with a hardcoded 4-line meta-scene.
// AI lines use the FREE browser TTS (zero credits, no metering bypass
// surface). The demo recording is played back inline and never saved.
// Rendered as an overlay — does not disturb screen routing/deep links.

import { S } from './state.js';
import { showToast, track } from './utils.js';
import { t } from './i18n.js';
import { getUserData, saveUserData } from './plan-timer.js';
import { aiSpeak, cancelTTSPlayback } from './tts.js';
import { applyLocaleVoices } from './voices.js';

let _obStream = null;
let _obRecorder = null;
let _obChunks = [];
let _obResultUrl = null;
let _obRunning = false;

// Demo mini-scene: CASTING DIRECTOR (AI, browser TTS) vs YOU (read aloud)
function demoLines() {
  return [
    { who: 'ai', char: t('obDemoCharAi'), text: t('obDemoLine1') },
    { who: 'you', char: t('obDemoCharYou'), text: t('obDemoLine2') },
    { who: 'ai', char: t('obDemoCharAi'), text: t('obDemoLine3') },
    { who: 'you', char: t('obDemoCharYou'), text: t('obDemoLine4') },
  ];
}

function _show(stepId) {
  ['obStep1', 'obStep2', 'obStep3', 'obResult'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === stepId ? '' : 'none';
  });
}

export function maybeStartOnboarding() {
  try {
    const u = getUserData();
    if (u && u.flags && u.flags.onboardingDone) return;
  } catch (_e) { return; }
  const params = new URLSearchParams(window.location.search);
  if (params.get('join') || params.get('code') || params.get('invite') ||
      params.get('payment') || params.get('checkout') || params.get('setup')) return;
  const ov = document.getElementById('onboardingOverlay');
  if (!ov) return;
  track('onboarding_start', {});
  _show('obStep1');
  ov.classList.add('active');
}

export function obStart() {
  _show('obStep2');
  const denied = document.getElementById('obPermDenied');
  if (denied) denied.style.display = 'none';
}

export async function obRequestPermissions() {
  // Must run inside the click gesture (iOS requirement)
  try {
    _obStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    track('onboarding_permission', { granted: true });
    _show('obStep3');
    const v = document.getElementById('obPreview');
    if (v) {
      v.srcObject = _obStream;
      v.muted = true;
      v.playsInline = true;
      try { v.play().catch(() => {}); } catch (_e) {}
    }
    _renderDemoPrompter(-1);
  } catch (e) {
    track('onboarding_permission', { granted: false, reason: e && e.name });
    // Blocking panel — no bypass (per spec)
    const denied = document.getElementById('obPermDenied');
    if (denied) denied.style.display = '';
  }
}

function _renderDemoPrompter(activeIdx) {
  const p = document.getElementById('obPrompter');
  if (!p) return;
  p.innerHTML = '';
  demoLines().forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'ob-line' + (l.who === 'you' ? ' ob-line-you' : '') + (i === activeIdx ? ' active' : '');
    const who = document.createElement('span');
    who.className = 'ob-char';
    who.textContent = l.char;
    div.appendChild(who);
    div.appendChild(document.createTextNode(l.text));
    p.appendChild(div);
  });
}

export async function obStartDemo() {
  if (_obRunning || !_obStream) return;
  _obRunning = true;
  const btn = document.getElementById('obStartDemoBtn');
  if (btn) btn.disabled = true;
  _obChunks = [];
  try {
    _obRecorder = new MediaRecorder(_obStream);
    _obRecorder.ondataavailable = e => { if (e.data.size > 0) _obChunks.push(e.data); };
    _obRecorder.onstop = () => {
      const blob = new Blob(_obChunks, { type: _obRecorder.mimeType || 'video/webm' });
      _obChunks = [];
      _obShowResult(blob);
    };
    _obRecorder.start(500);
  } catch (e) {
    console.warn('[onboarding] recorder failed, demo without recording:', e);
    _obRecorder = null;
  }
  // Walk through the 4 demo lines: AI lines use the real ElevenLabs
  // voice (free — demoFree skips all metering; browser TTS only as
  // technical fallback), user lines get a generous read-aloud window
  if (!S.VOICE_PRESETS || !S.VOICE_PRESETS.length) {
    try { applyLocaleVoices(S.selectedLocale, true); } catch (_e) { /* browser TTS fallback will cover */ }
  }
  const lines = demoLines();
  for (let i = 0; i < lines.length; i++) {
    if (!_obRunning) return; // skipped mid-demo
    _renderDemoPrompter(i);
    const l = lines[i];
    if (l.who === 'ai') {
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        try { aiSpeak(l.text, finish, { demoFree: true }); }
        catch (_e) { finish(); }
        setTimeout(finish, 9000); // safety: never hang the demo
      });
    } else {
      await new Promise(r => setTimeout(r, 3500));
    }
  }
  _renderDemoPrompter(-1);
  if (_obRecorder && _obRecorder.state !== 'inactive') {
    _obRecorder.stop();
  } else {
    _obShowResult(null);
  }
}

function _obShowResult(blob) {
  _obRunning = false;
  track('onboarding_demo_complete', { has_recording: !!blob });
  _show('obResult');
  const v = document.getElementById('obResultVideo');
  if (v && blob) {
    if (_obResultUrl) { try { URL.revokeObjectURL(_obResultUrl); } catch (_e) {} }
    _obResultUrl = URL.createObjectURL(blob);
    v.src = _obResultUrl;
    v.style.display = '';
    try { v.play().catch(() => {}); } catch (_e) {}
  } else if (v) {
    v.style.display = 'none';
  }
}

export function obSkip() {
  track('onboarding_skip', {});
  _finish();
}

export function obFinish() {
  track('onboarding_complete', {});
  _finish();
  if (typeof window.goImportScene === 'function') window.goImportScene();
}

function _finish() {
  _obRunning = false;
  cancelTTSPlayback();
  if (_obRecorder && _obRecorder.state !== 'inactive') { try { _obRecorder.onstop = null; _obRecorder.stop(); } catch (_e) {} }
  _obRecorder = null;
  _obChunks = [];
  if (_obStream) { _obStream.getTracks().forEach(tk => tk.stop()); _obStream = null; }
  if (_obResultUrl) { try { URL.revokeObjectURL(_obResultUrl); } catch (_e) {} _obResultUrl = null; }
  const v = document.getElementById('obResultVideo');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  try {
    const u = getUserData();
    u.flags.onboardingDone = true;
    saveUserData(u);
  } catch (_e) {}
  const ov = document.getElementById('onboardingOverlay');
  if (ov) ov.classList.remove('active');
}
