// ── TTS Module ──────────────────────────────────────────────────────
// Extracted from index.html: ElevenLabs TTS, browser TTS fallback,
// endpoint routing, backoff/error handling, audio playback, and the
// recording bridge that pipes TTS audio into the session recording.

import { S } from './state.js';
import { useElevenLabs, ELEVEN_ACCOUNT_BACKOFF_MS } from './constants.js';
import { showToast } from './utils.js';
import { t } from './i18n.js';
import {
  getCurrentVoiceSpeed, getCurrentLanguageCode,
  getLocaleConfig, normalizeLang, getBestVoice, getSpeechStyle,
} from './voices.js';
import { isServerAdmin } from './plan-timer.js';
import { showCreditDepletedModal, showVisitorSignupPrompt, updateCreditBadge } from './paywall.js';
import { unlockAudio } from './sfx.js';
import { fetchServerSession, openAuthModal } from './auth.js';

// ── TTS endpoint routing ───────────────────────────────────────────

function getTTSEndpointCandidates() {
  const host = (window.location.hostname || '').toLowerCase();
  const netlifyFn = '/.netlify/functions/tts';
  const apiRoute = '/api/tts';
  if (host.endsWith('.netlify.app')) return [netlifyFn, apiRoute];
  return [apiRoute, netlifyFn];
}

async function fetchTTSFromBestEndpoint(payload, demoFree) {
  const primary = S.ttsEndpointCache ? [S.ttsEndpointCache] : [];
  const candidates = getTTSEndpointCandidates().filter(ep => !primary.includes(ep));
  const endpoints = [...primary, ...candidates];
  let lastResponse = null, lastEndpoint = '';
  const ac = new AbortController();
  S._ttsAbort = ac;
  const headers = { 'Content-Type': 'application/json' };
  if (demoFree) headers['X-Demo-Tts'] = '1'; // onboarding demo lane (server-capped)
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      signal: ac.signal,
    });
    lastResponse = response;
    lastEndpoint = endpoint;
    if (response.status === 404) {
      if (S.ttsEndpointCache === endpoint) S.ttsEndpointCache = '';
      continue;
    }
    if (response.ok) S.ttsEndpointCache = endpoint;
    return { response, endpoint };
  }
  if (lastResponse) return { response: lastResponse, endpoint: lastEndpoint };
  throw new Error('No TTS endpoint reachable');
}

// ── ElevenLabs error helpers ───────────────────────────────────────

function isElevenLabsAccountBlocked(status, details) {
  const msg = (details || '').toLowerCase();
  if (status === 401 || status === 403) return true;
  return msg.includes('unusual activity')
    || msg.includes('free tier usage disabled')
    || msg.includes('account blocked')
    || msg.includes('billing')
    || msg.includes('permission')
    || msg.includes('elevenlabs error 401')
    || msg.includes('elevenlabs error 403');
}

function isElevenLabsConfigMissing(details) {
  const msg = (details || '').toLowerCase();
  return msg.includes('missing elevenlabs_api_key');
}

function extractElevenLabsStatus(httpStatus, errorPayload, detail) {
  if (httpStatus !== 502) return httpStatus;
  const regex = /elevenlabs error\s+(\d{3})/i;
  const fromError = String(errorPayload && errorPayload.error || '').match(regex);
  if (fromError) return Number(fromError[1]);
  const fromDetail = String(detail || '').match(regex);
  if (fromDetail) return Number(fromDetail[1]);
  const attempts = errorPayload && Array.isArray(errorPayload.attempts) ? errorPayload.attempts : [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    const s = Number(attempts[i] && attempts[i].status);
    if (Number.isFinite(s)) return s;
  }
  return httpStatus;
}

function getElevenLabsFallbackMessage() {
  if (S.elevenLabsDisableReason === 'missing_key') {
    return S.selectedUILanguage === 'fr'
      ? "Configuration ElevenLabs manquante (ELEVENLABS_API_KEY). Voix navigateur activ\u00e9e."
      : 'ElevenLabs is not configured (missing ELEVENLABS_API_KEY). Using browser voice.';
  }
  return S.selectedUILanguage === 'fr'
    ? 'ElevenLabs unavailable, browser voice active'
    : 'ElevenLabs unavailable, using browser voice';
}

function getUnavailableVoiceMessage(label) {
  const name = label || 'Voice';
  return S.selectedUILanguage === 'fr'
    ? `Voice unavailable: ${name}. Backup voice used`
    : `Voice unavailable: ${name}. Using backup voice`;
}

// ── ElevenLabs backoff ─────────────────────────────────────────────

function setElevenLabsBackoff(ms, reason) {
  S.elevenLabsTemporarilyDisabled = true;
  S.elevenLabsDisableReason = reason || S.elevenLabsDisableReason || 'temporary';
  if (S.elevenLabsBackoffTimer) {
    clearTimeout(S.elevenLabsBackoffTimer);
    S.elevenLabsBackoffTimer = null;
  }
  const delay = Math.max(1000, Number(ms) || ELEVEN_ACCOUNT_BACKOFF_MS);
  S.elevenLabsBackoffTimer = setTimeout(() => {
    S.elevenLabsTemporarilyDisabled = false;
    S.elevenLabsDisableReason = '';
    S.elevenLabsFallbackNotified = false;
    S.elevenLabsBackoffTimer = null;
  }, delay);
}

// ── TTS playback cancel ────────────────────────────────────────────

function cancelTTSPlayback() {
  speechSynthesis.cancel();
  if (S.ttsAudio && typeof S.ttsAudio.stop === 'function') {
    try { S.ttsAudio.stop(); } catch (e) {}
  }
  if (S._ttsAbort) { try { S._ttsAbort.abort(); } catch (e) {} S._ttsAbort = null; }
  S.ttsPlaybackInfo = null;
  const el = document.getElementById('ttsAudioEl');
  if (el) {
    el.pause();
    el.onended = null; el.onerror = null;
    if (el._revokeUrl) {
      try { URL.revokeObjectURL(el._revokeUrl); } catch (e) {}
      el._revokeUrl = null;
    }
    el.removeAttribute('src'); el.load();
  }
  S.ttsAudio = null;
}

// ── Mobile audio warm-up ───────────────────────────────────────────

async function warmAudioForMobile() {
  if (S._audioUnlocked) return;
  try {
    const el = document.getElementById('ttsAudioEl');
    if (el) {
      el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      el.volume = 0;
      await el.play().catch(() => {});
      el.volume = 1;
    }
    S._audioUnlocked = true;
  } catch (e) {}
}

// ── TTS-to-recording bridge ────────────────────────────────────────

function playTtsIntoRecording(audioBuffer) {
  // Play decoded audio into the recording mix via AudioContext
  if (!S._recAudioCtx || !S._recDest) return null;
  try {
    var src = S._recAudioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(S._recAiGain || S._recDest);
    src.connect(S._recAudioCtx.destination); // also play through speakers
    src.start(0);
    return src;
  } catch (e) { console.warn('[rec] playTtsIntoRecording error:', e.message); }
  return null;
}

// ── ElevenLabs TTS ─────────────────────────────────────────────────

async function speakWithElevenLabs(text, preset, token, cb, speedOverride, demoFree) {
  try {
    if (!preset || !preset.voiceId) throw new Error('Missing ElevenLabs voiceId');
    if (!isServerAdmin() && !demoFree) {
      var isLoggedIn = !!(S.cwServerSession.email || (S.userAccess.verified && S.userAccess.email));
      // If not logged in but localStorage shows previous login, try re-fetching session
      if (!isLoggedIn && S.userAccess.email) {
        await fetchServerSession();
        isLoggedIn = !!(S.cwServerSession.email || (S.userAccess.verified && S.userAccess.email));
      }
      if (isLoggedIn) {
        if ((S.cwServerSession.creditBalance || 0) <= 0) {
          S.elevenLabsTemporarilyDisabled = true; S.elevenLabsDisableReason = 'quota';
          showCreditDepletedModal();
          return false;
        }
      } else {
        // Visitor: check free lines
        var usedLines = parseInt(localStorage.getItem('cw_free_lines') || '0');
        if (usedLines >= 2) {
          // If user previously had an account, prompt re-login instead of signup
          if (S.userAccess.email) {
            showToast(t('ttsSessionExpired'));
            openAuthModal();
          } else {
            showVisitorSignupPrompt();
          }
          return false;
        }
      }
    }
    const speed = speedOverride != null ? speedOverride : getCurrentVoiceSpeed();
    console.info('[TTS] lang:', preset.languageCode, 'locale:', S.selectedLocale, 'locked:', S.lockedVoiceLocale, 'voice:', preset.label);
    const voiceCandidates = [preset.voiceId, ...(preset.fallbackVoiceIds || [])];
    let blob = null;
    let usedFallback = false;
    let selectedVoiceUnavailable = false;
    let lastErr = '';
    for (let i = 0; i < voiceCandidates.length; i++) {
      const voiceId = voiceCandidates[i];
      if (S.unavailableElevenVoiceIds.has(voiceId)) continue;
      const effectiveLang = preset.languageCode || getCurrentLanguageCode() || (S.lockedVoiceLocale ? getLocaleConfig(S.lockedVoiceLocale).languageCode : '') || 'en';
      const { response: rsp } = await fetchTTSFromBestEndpoint({
        text,
        voiceId,
        modelId: preset.modelId || 'eleven_multilingual_v2',
        emotion: S.voiceSpeed > 6.5 ? 'neutral' : S.selectedEmotion,
        speed,
        languageCode: effectiveLang,
      }, demoFree);
      if (rsp.ok) {
        blob = await rsp.blob();
        usedFallback = i > 0;
        // Update credit balance from response header
        var newBal = rsp.headers.get('X-Credits-Balance');
        if (newBal !== null) {
          S.cwServerSession.creditBalance = parseInt(newBal) || 0;
          updateCreditBadge();
          if (S.cwServerSession.creditBalance > 0 && S.cwServerSession.creditBalance < 200) {
            showToast(t('lowCredits') + ': $' + (S.cwServerSession.creditBalance / 100).toFixed(2), 3000);
          }
        }
        // Track free lines for visitors (the onboarding demo doesn't count)
        if (!S.cwServerSession.email && !demoFree) {
          var fl = parseInt(localStorage.getItem('cw_free_lines') || '0');
          localStorage.setItem('cw_free_lines', String(fl + 1));
        }
        if (rsp.headers.get('X-Used-Fallback') === 'true') {
          console.info('[TTS] Fallback voice used:', rsp.headers.get('X-Fallback-Voice'));
        }
        break;
      }
      let err = '';
      let errorPayload = null;
      try {
        errorPayload = await rsp.json();
        const detail = errorPayload && errorPayload.details ? (typeof errorPayload.details === 'string' ? errorPayload.details : JSON.stringify(errorPayload.details)) : '';
        const headline = errorPayload && errorPayload.error ? (typeof errorPayload.error === 'string' ? errorPayload.error : JSON.stringify(errorPayload.error)) : '';
        err = [headline, detail].filter(Boolean).join(' \u00b7 ');
      } catch (e) {}
      lastErr = 'HTTP ' + rsp.status + (err ? ' \u00b7 ' + err : '');
      if (errorPayload && (errorPayload.error === 'NO_CREDITS' || errorPayload.error === 'INSUFFICIENT_CREDITS')) {
        if (errorPayload.balance_cents !== undefined) S.cwServerSession.creditBalance = errorPayload.balance_cents;
        updateCreditBadge();
        S.elevenLabsTemporarilyDisabled = true; S.elevenLabsDisableReason = 'quota';
        showCreditDepletedModal();
        return false;
      }
      if (errorPayload && errorPayload.error === 'VOICE_UNAVAILABLE') {
        S.unavailableElevenVoiceIds.add(voiceCandidates[i]);
        if (i === 0) selectedVoiceUnavailable = true;
        console.info('[TTS] Voice unavailable:', voiceCandidates[i]);
        continue;
      }
      if (errorPayload && errorPayload.error === 'TTS_PROVIDER_ERROR') {
        const msg = errorPayload.message || '';
        if (isElevenLabsConfigMissing(msg)) {
          setElevenLabsBackoff(24 * 60 * 60 * 1000, 'missing_key');
          break;
        }
        if (isElevenLabsAccountBlocked(rsp.status, msg)) {
          setElevenLabsBackoff(ELEVEN_ACCOUNT_BACKOFF_MS, 'account_blocked');
          break;
        }
        continue;
      }
      const upstreamStatus = extractElevenLabsStatus(rsp.status, errorPayload, err);
      if (upstreamStatus === 404) {
        S.unavailableElevenVoiceIds.add(voiceId);
        if (i === 0) selectedVoiceUnavailable = true;
        continue;
      }
      if (upstreamStatus === 422 || upstreamStatus === 429 || upstreamStatus >= 500) {
        continue;
      }
      break;
    }
    if (!blob) throw new Error(lastErr || 'TTS error');
    if (usedFallback) {
      if (selectedVoiceUnavailable) showToast(getUnavailableVoiceMessage(preset.label), 3500);
      else showToast(t('toastVoiceFallback'), 2500);
    }
    if (token !== S.activeSpeechToken) { return; }
    // If recording, decode and play via AudioContext (captures into recording)
    if (S.isRecording && S._recAudioCtx && S._recDest) {
      try {
        var arrayBuf = await blob.arrayBuffer();
        var audioBuffer = await S._recAudioCtx.decodeAudioData(arrayBuf);
        var _recDoneFired = false;
        var recDone = function() {
          if (_recDoneFired) return; _recDoneFired = true;
          if (S._recMicGain) S._recMicGain.gain.value = (S._recMicLevel || 1);
          if (token === S.activeSpeechToken && cb) cb();
          S.lastTTSEndTs = Date.now();
        };
        // Mute mic during TTS to prevent echo in recording
        if (S._recMicGain) S._recMicGain.gain.value = 0;
        var src = S._recAudioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(S._recAiGain || S._recDest);
        src.connect(S._recAudioCtx.destination);
        src.onended = recDone;
        // Expose real playback timing so the prompter can step display
        // lines in sync with the actual voice (not an estimate). Speed is
        // baked into the rendered audio here, so duration is final.
        S.ttsPlaybackInfo = { startTs: Date.now(), durationMs: Math.round((audioBuffer.duration || 0) * 1000) };
        src.start(0);
        // Safety: onended can fail to fire on iOS Safari -- use duration-based fallback
        var _safetyMs = Math.ceil((audioBuffer.duration || 3) * 1000) + 500;
        var _safetyTimer = setTimeout(function() { console.warn('[TTS] onended safety timeout after ' + _safetyMs + 'ms'); recDone(); }, _safetyMs);
        S.ttsAudio = { stop: function() { try { src.stop(); } catch (e) {} clearTimeout(_safetyTimer); if (S._recMicGain) S._recMicGain.gain.value = (S._recMicLevel || 1); } };
        return true;
      } catch (e) { console.warn('[TTS] AudioContext decode failed, falling back to element:', e.message); }
    }
    // Normal playback via audio element
    const url = URL.createObjectURL(blob);
    const audio = document.getElementById('ttsAudioEl');
    if (!audio) { URL.revokeObjectURL(url); return false; }
    if (S.ttsAudio && S.ttsAudio._revokeUrl) try { URL.revokeObjectURL(S.ttsAudio._revokeUrl); } catch (e) {}
    audio.onended = null; audio.onerror = null;
    audio.src = url;
    audio._revokeUrl = url;
    audio.playbackRate = Math.max(0.58, Math.min(1.9, speed || 1));
    audio.volume = S.selectedEmotion === 'whisper' ? 0.85 : 1;
    S.ttsAudio = audio;
    const done = () => {
      URL.revokeObjectURL(url);
      if (audio._revokeUrl === url) audio._revokeUrl = null;
      if (token === S.activeSpeechToken && cb) cb();
      S.lastTTSEndTs = Date.now();
    };
    audio.onended = done;
    audio.onerror = done;
    // Publish real playback timing for in-sync prompter stepping
    S.ttsPlaybackInfo = null;
    const _publishDur = () => {
      const d = audio.duration;
      if (d && isFinite(d)) S.ttsPlaybackInfo = { startTs: Date.now(), durationMs: Math.round(d * 1000 / (audio.playbackRate || 1)) };
    };
    audio.onloadedmetadata = _publishDur;
    try { await audio.play(); _publishDur(); } catch (e) {
      unlockAudio();
      try { await audio.play(); _publishDur(); } catch (e2) { done(); }
    }
    return true;
  } catch (e) {
    console.info('[TTS] speakWithElevenLabs error:', e.message);
    return false;
  }
}

// ── Browser TTS fallback ───────────────────────────────────────────

function speakWithBrowser(text, preset, style, token, cb) {
  const u = new SpeechSynthesisUtterance(text);
  const voice = getBestVoice(preset);
  u.lang = voice && voice.lang ? voice.lang : 'fr-FR';
  u.pitch = style.pitch;
  u.rate = style.rate;
  u.volume = style && Number.isFinite(style.volume) ? style.volume : 1;
  if (voice) u.voice = voice;
  const done = () => { if (token === S.activeSpeechToken && cb) cb(); };
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

// ── Main TTS entry point ───────────────────────────────────────────

async function aiSpeak(text, cb, opts) {
  if (!text) { if (cb) cb(); return; }
  opts = opts || {};
  // Don't speak into a dead session — except the onboarding demo, which runs outside any session
  if (!opts.demoFree && typeof window !== 'undefined' && window.__cwSessionState && !window.__cwSessionState.active && S.sessionMode === 'ai') return;
  const preset = S.selectedVoice || S.VOICE_PRESETS[0];
  if (!preset) { console.warn('[TTS] no voice preset available'); if (cb) cb(); return; }
  console.info('[TTS] aiSpeak voiceId:', preset.voiceId, 'label:', preset.label, 'id:', preset.id, 'slider:', S.voiceSpeed, 'elevenSpeed:', getCurrentVoiceSpeed(), 'emotion:', S.selectedEmotion);
  const spokenText = normalizeTextForTTS(text, preset);
  const token = ++S.activeSpeechToken;
  cancelTTSPlayback();
  if (useElevenLabs && !S.elevenLabsTemporarilyDisabled) {
    const ok = await speakWithElevenLabs(spokenText, preset, token, cb, opts.speedOverride, opts.demoFree);
    if (ok || token !== S.activeSpeechToken) return;
  }
  // If disabled due to credits, show pay popup instead of browser TTS
  // (never during the onboarding demo — it silently falls back to browser TTS)
  if (!opts.demoFree && useElevenLabs && S.elevenLabsTemporarilyDisabled && (S.elevenLabsDisableReason === 'quota' || S.elevenLabsDisableReason === 'visitor')) {
    var isLoggedIn = !!(S.cwServerSession.email || (S.userAccess.verified && S.userAccess.email));
    if (isLoggedIn) showCreditDepletedModal();
    else if (S.userAccess.email) { showToast(t('ttsSessionExpired')); openAuthModal(); }
    else showVisitorSignupPrompt();
    // Halt the take instead of advancing silently — the prompter stays
    // put and the credit modal / toast tell the actor to top up.
    if (typeof window.haltForCredits === 'function') window.haltForCredits();
    else if (cb) cb();
    return;
  }
  // Only fall back to browser TTS for technical errors (API down, etc.)
  if (useElevenLabs && S.elevenLabsTemporarilyDisabled && !S.elevenLabsFallbackNotified) {
    S.elevenLabsFallbackNotified = true;
    showToast(getElevenLabsFallbackMessage(), 5000);
  }
  const style = getSpeechStyle(preset);
  console.info('[TTS] falling back to browser TTS (ElevenLabs unavailable)');
  speakWithBrowser(spokenText, preset, style, token, cb);
}

// ── Text normalisation for TTS ─────────────────────────────────────

function numberToFrench(n) {
  const ones = ['z\u00e9ro','un','deux','trois','quatre','cinq','six','sept','huit','neuf','dix','onze','douze','treize','quatorze','quinze','seize'];
  const tens = ['','','vingt','trente','quarante','cinquante','soixante'];
  const num = Math.max(0, Math.floor(Number(n) || 0));
  if (num < 17) return ones[num];
  if (num < 20) return 'dix-' + ones[num - 10];
  if (num < 70) {
    const t = Math.floor(num / 10), u = num % 10;
    if (u === 0) return tens[t];
    if (u === 1) return `${tens[t]} et un`;
    return `${tens[t]}-${ones[u]}`;
  }
  if (num < 80) {
    if (num === 71) return 'soixante et onze';
    return 'soixante-' + numberToFrench(num - 60);
  }
  if (num < 100) {
    if (num === 80) return 'quatre-vingts';
    return 'quatre-vingt-' + numberToFrench(num - 80);
  }
  if (num < 1000) {
    const h = Math.floor(num / 100), r = num % 100;
    const head = h === 1 ? 'cent' : `${ones[h]} cent`;
    if (r === 0) return head;
    return `${head} ${numberToFrench(r)}`;
  }
  if (num < 10000) {
    const th = Math.floor(num / 1000), r = num % 1000;
    const head = th === 1 ? 'mille' : `${numberToFrench(th)} mille`;
    if (r === 0) return head;
    return `${head} ${numberToFrench(r)}`;
  }
  return String(num);
}

function normalizeTextForTTS(text, preset) {
  const lang = normalizeLang((preset && preset.languageCode) || getCurrentLanguageCode());
  let out = String(text || '');
  // Strip all parenthetical stage directions (up to 80 chars)
  out = out.replace(/\([^)]{1,80}\)/g, '');
  out = out.replace(/\s{2,}/g, ' ').trim();
  if (lang.startsWith('fr')) {
    out = out.replace(/\b(\d{1,4})\s*%\b/g, (_, v) => `${numberToFrench(Number(v))} pour cent`);
    out = out.replace(/\b\d{1,4}\b/g, (v) => numberToFrench(Number(v)));
  }
  return out;
}

// ── Named exports ──────────────────────────────────────────────────
export {
  getTTSEndpointCandidates,
  fetchTTSFromBestEndpoint,
  isElevenLabsAccountBlocked,
  isElevenLabsConfigMissing,
  extractElevenLabsStatus,
  getElevenLabsFallbackMessage,
  getUnavailableVoiceMessage,
  setElevenLabsBackoff,
  cancelTTSPlayback,
  warmAudioForMobile,
  playTtsIntoRecording,
  speakWithElevenLabs,
  speakWithBrowser,
  aiSpeak,
  numberToFrench,
  normalizeTextForTTS,
};
