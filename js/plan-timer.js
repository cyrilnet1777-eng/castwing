// ── Plan & Timer System ─────────────────────────────────────────────
// Extracted from index.html lines 1091-1413 + 1827-1877.
// Manages user data (citizentape_user_v2), legacy plan mirroring,
// tier checks, session timer, chrono display, and server admin helpers.

import { S } from './state.js';
import { AUDITION_WINDOW_MS, SETTINGS_KEY, ACCESS_KEY, PLAN_KEY, USER_DATA_V2_KEY, useElevenLabs } from './constants.js';
import { showToast, gaEvent } from './utils.js';
import { t } from './i18n.js';
import { playSfx } from './sfx.js';

// ── Late-binding for applyServerSessionUI (lives in auth/session module) ──
let _applyServerSessionUI = () => {};
export function setApplyServerSessionUI(fn) { _applyServerSessionUI = fn; }

// ── Migrate from Castwing to CitizenTape (one-time) ──
export function migrateFromCastwing() {
  if (localStorage.getItem('citizentape_migrated_v1')) return;
  const keyMap = [
    ['castwing_user_settings_v3', 'citizentape_user_settings_v3'],
    ['castwing_user_access_v1', 'citizentape_user_access_v1'],
    ['castwing_plan_v2', 'citizentape_plan_v2'],
    ['castwing_user_v2', 'citizentape_user_v2'],
    ['castwing_referral_v1', 'citizentape_referral_v1']
  ];
  keyMap.forEach(([oldK, newK]) => {
    const v = localStorage.getItem(oldK);
    if (v && !localStorage.getItem(newK)) localStorage.setItem(newK, v);
    if (v) localStorage.removeItem(oldK);
  });
  try { indexedDB.deleteDatabase('castwing-script-db'); } catch (_) {}
  try { indexedDB.deleteDatabase('CastwingDB'); } catch (_) {}
  try { indexedDB.deleteDatabase('castwing-recordings'); } catch (_) {}
  localStorage.setItem('citizentape_migrated_v1', '1');
}

// ── getPauseBetweenLines ──
export function getPauseBetweenLines() {
  return S.voiceSpeed >= 4.5 ? 200 : 1000;
}

// ── Plan & Timer System (citizentape_user_v2 + legacy PLAN_KEY mirror) ──
export function getFirstOfNextMonthMs() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

export function createFreshUserData(tier) {
  const quotas = { figurant: 30 * 60, audition: 120 * 60, oscar: 300 * 60, palme: 1200 * 60, payg: 0 };
  const q = quotas[tier] ?? 30 * 60;
  return {
    userId: null,
    tier,
    email: null,
    aiMinutes: {
      remainingSeconds: q,
      lastResetAt: Date.now(),
      nextResetAt: tier === 'audition' ? Date.now() + AUDITION_WINDOW_MS : null,
      monthlyResetAt: (tier === 'oscar' || tier === 'palme') ? getFirstOfNextMonthMs() : null
    },
    billing: {
      purchaseCount: 0, totalSpentCents: 0,
      autoRecharge: { enabled: false, triggerAt: 5 * 60, amount: 500 },
      lastPurchaseAt: null, upgradeSuggestedAt: null
    },
    preferences: {
      uiLanguage: 'fr', voiceLocale: 'fr-FR', selectedVoice: 'rachel', emotion: 'neutral', speed: 'normal',
      mode: 'ai_vocal', aiDirectionEnabled: true, aiDirectionMode: 'summary'
    },
    clonedVoices: [], bookings: [], unlockedPacks: [],
    flags: { welcomeBannerShown: false, freezeModalCount: 0, onboardingDone: false, upgradeSuggestedThisSession: false }
  };
}

export function mergeUserDataDefaults(parsed) {
  const tier = (parsed && parsed.tier) || 'figurant';
  const d = createFreshUserData(tier);
  if (!parsed || typeof parsed !== 'object') return d;
  return {
    ...d,
    ...parsed,
    aiMinutes: { ...d.aiMinutes, ...(parsed.aiMinutes || {}) },
    billing: { ...d.billing, ...(parsed.billing || {}) },
    preferences: { ...d.preferences, ...(parsed.preferences || {}) },
    flags: { ...d.flags, ...(parsed.flags || {}) }
  };
}

export function migratePlanToUserDataOnce() {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return null;
    const map = { visitor: 'figurant', free: 'audition', payg: 'payg', pro: 'palme' };
    const st = map[p.tier] || 'figurant';
    const u = createFreshUserData(st);
    try {
      const acc = JSON.parse(localStorage.getItem(ACCESS_KEY) || '{}');
      if (acc && acc.email) u.email = String(acc.email);
    } catch (e) {}
    if (st === 'figurant') {
      const sec = Math.floor((p.remainingMs || 0) / 1000);
      u.aiMinutes.remainingSeconds = sec > 0 ? sec : 30 * 60;
    } else if (st === 'audition') {
      const sec = Math.floor((p.remainingMs || 0) / 1000);
      u.aiMinutes.remainingSeconds = sec > 0 ? sec : 120 * 60;
      u.aiMinutes.nextResetAt = p.cooldownUntil && p.cooldownUntil > Date.now() ? p.cooldownUntil : Date.now() + AUDITION_WINDOW_MS;
    } else if (st === 'payg') {
      u.aiMinutes.remainingSeconds = Math.max(0, Math.floor((p.paygBankMs || 0) / 1000));
    } else if (st === 'palme' || st === 'oscar') {
      const sec = Math.floor((p.remainingMs || 0) / 1000);
      const full = st === 'oscar' ? 300 * 60 : 1200 * 60;
      u.aiMinutes.remainingSeconds = sec > 0 ? sec : full;
      u.aiMinutes.monthlyResetAt = p.proResetDate ? new Date(p.proResetDate).getTime() : getFirstOfNextMonthMs();
    }
    return u;
  } catch (e) { return null; }
}

export function userDataToLegacyPlan(u) {
  let tier = 'visitor', remainingMs = 0, cooldownUntil = 0, paygBankMs = 0, proResetDate = null, createdAt = new Date().toISOString();
  const sec = Math.max(0, Math.floor(u.aiMinutes && u.aiMinutes.remainingSeconds != null ? u.aiMinutes.remainingSeconds : 0));
  if (u.tier === 'figurant') { tier = 'visitor'; remainingMs = sec * 1000; }
  else if (u.tier === 'audition') {
    tier = 'free'; remainingMs = sec * 1000;
    if (sec <= 0 && u.aiMinutes.nextResetAt && Date.now() < u.aiMinutes.nextResetAt) cooldownUntil = u.aiMinutes.nextResetAt;
  } else if (u.tier === 'payg') { tier = 'payg'; paygBankMs = sec * 1000; }
  else if (u.tier === 'oscar' || u.tier === 'palme') {
    tier = 'pro'; remainingMs = sec * 1000;
    if (u.aiMinutes.monthlyResetAt) proResetDate = new Date(u.aiMinutes.monthlyResetAt).toISOString();
  }
  return { tier, remainingMs, cooldownUntil, paygBankMs, proResetDate, createdAt };
}

export function legacyPlanToUserData(p, prevU) {
  let spec = prevU.tier || 'figurant';
  if (p.tier === 'visitor') spec = 'figurant';
  else if (p.tier === 'free') spec = 'audition';
  else if (p.tier === 'payg') spec = 'payg';
  else if (p.tier === 'pro') {
    if (spec !== 'oscar' && spec !== 'palme') spec = 'palme';
  }
  const u = mergeUserDataDefaults({ ...prevU, tier: spec });
  if (spec === 'figurant' || spec === 'audition' || spec === 'oscar' || spec === 'palme') {
    u.aiMinutes.remainingSeconds = Math.max(0, Math.floor((p.remainingMs || 0) / 1000));
    if (spec === 'audition') {
      u.aiMinutes.nextResetAt = p.cooldownUntil && p.cooldownUntil > Date.now() ? p.cooldownUntil : (u.aiMinutes.nextResetAt || Date.now() + AUDITION_WINDOW_MS);
    }
    if (spec === 'oscar' || spec === 'palme') {
      u.aiMinutes.monthlyResetAt = p.proResetDate ? new Date(p.proResetDate).getTime() : getFirstOfNextMonthMs();
    }
  }
  if (spec === 'payg') u.aiMinutes.remainingSeconds = Math.max(0, Math.floor((p.paygBankMs || 0) / 1000));
  return u;
}

export function getUserData() {
  try {
    const raw = localStorage.getItem(USER_DATA_V2_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return mergeUserDataDefaults(parsed);
    }
    const migrated = migratePlanToUserDataOnce();
    if (migrated) {
      localStorage.setItem(USER_DATA_V2_KEY, JSON.stringify(mergeUserDataDefaults(migrated)));
      return mergeUserDataDefaults(migrated);
    }
    const fresh = createFreshUserData('figurant');
    localStorage.setItem(USER_DATA_V2_KEY, JSON.stringify(fresh));
    localStorage.setItem(PLAN_KEY, JSON.stringify(userDataToLegacyPlan(fresh)));
    return mergeUserDataDefaults(fresh);
  } catch (e) { return mergeUserDataDefaults(createFreshUserData('figurant')); }
}

export function saveUserData(data) {
  try {
    const prevRaw = localStorage.getItem(USER_DATA_V2_KEY);
    let prev = null;
    if (prevRaw) {
      prev = JSON.parse(prevRaw);
      if (prev && typeof prev === 'object') {
        data.preferences = { ...prev.preferences, ...(data.preferences || {}) };
        data.flags = { ...prev.flags, ...(data.flags || {}) };
        data.billing = { ...prev.billing, ...(data.billing || {}) };
        data.aiMinutes = { ...(prev.aiMinutes || {}), ...(data.aiMinutes || {}) };
      }
    }
  } catch (e) {}
  const merged = mergeUserDataDefaults(data);
  localStorage.setItem(USER_DATA_V2_KEY, JSON.stringify(merged));
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(userDataToLegacyPlan(merged))); } catch (e) {}
}

export function getSpecTier() { return getUserData().tier || 'figurant'; }
export function getPlan() { return userDataToLegacyPlan(getUserData()); }
export function savePlan(p) { saveUserData(legacyPlanToUserData(p, getUserData())); }
export function getUserTier() { return getPlan().tier || 'visitor'; }
export function isSignedUp() { return getUserTier() !== 'visitor'; }

export function canUseElevenLabs() {
  if (isServerAdmin()) return true;
  var isLoggedIn = !!(S.cwServerSession.email || (S.userAccess.verified && S.userAccess.email));
  if (isLoggedIn) return (S.cwServerSession.creditBalance || 0) > 0;
  var used = parseInt(localStorage.getItem('cw_free_lines') || '0');
  return used < 2;
}

export function canUsePartner() { return true; }
export function canRecord() { return true; }
export function canUseEmotions() { return getSpecTier() === 'palme'; }

export function getMaxVideoRes() {
  const st = getSpecTier();
  if (st === 'palme') return { w: 3840, h: 2160, label: '4K' };
  if (st === 'oscar' || st === 'audition' || st === 'payg') return { w: 1920, h: 1080, label: 'HD' };
  return { w: 0, h: 0, label: 'none' };
}

export function isFreezable() { const st = getSpecTier(); return st === 'audition' || st === 'palme'; }

export function checkAndApplyResets() {
  const u = getUserData();
  const now = Date.now();
  let ch = false;
  if (u.tier === 'audition' && u.aiMinutes.nextResetAt && now >= u.aiMinutes.nextResetAt) {
    u.aiMinutes.remainingSeconds = 120 * 60;
    u.aiMinutes.lastResetAt = now;
    u.aiMinutes.nextResetAt = now + AUDITION_WINDOW_MS;
    ch = true;
  }
  if ((u.tier === 'oscar' || u.tier === 'palme') && u.aiMinutes.monthlyResetAt && now >= u.aiMinutes.monthlyResetAt) {
    u.aiMinutes.remainingSeconds = (u.tier === 'oscar' ? 300 * 60 : 1200 * 60);
    u.aiMinutes.lastResetAt = now;
    u.aiMinutes.monthlyResetAt = getFirstOfNextMonthMs();
    ch = true;
  }
  if (ch) saveUserData(u);
}

export function checkProMonthlyReset(p) {
  if (p.tier !== 'pro' || !p.proResetDate) return;
  if (Date.now() >= new Date(p.proResetDate).getTime()) {
    const u = getUserData();
    if (u.tier === 'palme' || u.tier === 'oscar') {
      u.aiMinutes.remainingSeconds = (u.tier === 'oscar' ? 300 * 60 : 1200 * 60);
      u.aiMinutes.monthlyResetAt = getFirstOfNextMonthMs();
      saveUserData(u);
    }
  }
}

export function getRemainingSessionMs() {
  checkAndApplyResets();
  const u = getUserData();
  const sec = u.aiMinutes.remainingSeconds || 0;
  if (u.tier === 'figurant') return sec * 1000;
  if (u.tier === 'audition') {
    if (sec <= 0 && u.aiMinutes.nextResetAt && Date.now() < u.aiMinutes.nextResetAt) return 0;
    if (sec <= 0 && (!u.aiMinutes.nextResetAt || Date.now() >= u.aiMinutes.nextResetAt)) checkAndApplyResets();
    return Math.max(0, (getUserData().aiMinutes.remainingSeconds || 0)) * 1000;
  }
  if (u.tier === 'payg') return sec * 1000;
  if (u.tier === 'oscar' || u.tier === 'palme') {
    checkProMonthlyReset(getPlan());
    const u2 = getUserData();
    return Math.max(0, (u2.aiMinutes.remainingSeconds || 0)) * 1000;
  }
  return 0;
}

export function consumeMs(ms) {
  const u = getUserData();
  const sec = ms / 1000;
  if (u.tier === 'figurant' || u.tier === 'audition' || u.tier === 'oscar' || u.tier === 'palme') {
    u.aiMinutes.remainingSeconds = Math.max(0, (u.aiMinutes.remainingSeconds || 0) - sec);
    if (u.tier === 'audition' && u.aiMinutes.remainingSeconds <= 0) {
      u.aiMinutes.nextResetAt = Date.now() + AUDITION_WINDOW_MS;
    }
    saveUserData(u);
  } else if (u.tier === 'payg') {
    u.aiMinutes.remainingSeconds = Math.max(0, (u.aiMinutes.remainingSeconds || 0) - sec);
    saveUserData(u);
  }
}

export function addPaygMinutes(ms) {
  const u = getUserData();
  if (u.tier === 'figurant' || u.tier === 'audition') u.tier = 'payg';
  u.aiMinutes.remainingSeconds = (u.aiMinutes.remainingSeconds || 0) + Math.floor(ms / 1000);
  saveUserData(u);
}

export function fmtTimer(ms) {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

export function updateSessionTimeRail(ms) {
  const rail = document.getElementById('sessionTimeRail');
  const fill = document.getElementById('sessionTimeRailFill');
  if (!rail || !fill) return;
  if (isServerAdmin() || ms <= 0) { rail.style.display = 'none'; return; }
  const tier = getSpecTier();
  const totals = { figurant: 30 * 60, audition: 120 * 60, oscar: 300 * 60, palme: 1200 * 60 };
  let totalSec = totals[tier] || 30 * 60;
  if (tier === 'payg') totalSec = Math.max(60, Math.ceil(ms / 1000));
  const remSec = Math.max(0, Math.ceil(ms / 1000));
  const pct = totalSec > 0 ? Math.min(1, remSec / totalSec) : 0;
  fill.style.transform = 'scaleX(' + pct + ')';
  rail.classList.toggle('low', remSec > 0 && remSec <= 300);
  rail.style.display = 'block';
}

export function updateTimerBadge() {
}

export function hideTimerBadge() {
  const z = document.getElementById('zelda-chrono');
  if (z) z.style.display = 'none';
  const r = document.getElementById('sessionTimeRail');
  if (r) r.style.display = 'none';
}

export function maybePlayLowTimeSound(ms) {
  const sec = Math.ceil(ms / 1000);
  if (sec > 0 && sec <= 30 && S.chronoLowSoundArmed) { playSfx('clock', 0.22); S.chronoLowSoundArmed = false; }
  if (sec > 45) S.chronoLowSoundArmed = true;
}

export function startSessionTimer() {
  // Credits are now handled per-TTS-call, not by time. No countdown needed.
  return;
}

export function stopSessionTimer() {
  S.chronoRunning = false;
  S.chronoPaywallShown = false;
  S.chronoWarn5minShown = false;
  if (S.chronoRafId) { cancelAnimationFrame(S.chronoRafId); S.chronoRafId = null; }
  if (S.sessionTimerInterval) { clearInterval(S.sessionTimerInterval); S.sessionTimerInterval = null; }
}

export function freezeTimer() { if (isFreezable()) S.sessionTimerFrozen = true; }
export function unfreezeTimer() { S.sessionTimerFrozen = false; }

// ── Server admin / tester helpers ──
export function isServerAdmin() { return S.cwServerSession.isAdmin === true; }
export function isServerTester() { return S.cwServerSession.plan === 'tester'; }

export async function serverConsumeCredit(kind, voiceId) {
  if (S.cwServerSession.isAdmin) return { ok: true, creditsRemaining: null };
  if (S.cwServerSession.plan !== 'tester') return { ok: true, creditsRemaining: null };
  try {
    const rsp = await fetch('/api/credits/consume', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind || 'tts_line', voiceId: voiceId || '' })
    });
    const data = await rsp.json().catch(() => null);
    if (data && data.ok) {
      S.cwServerSession.creditsRemaining = data.creditsRemaining;
      _applyServerSessionUI();
      return { ok: true, creditsRemaining: data.creditsRemaining };
    }
    if (data && data.error === 'NO_CREDITS') {
      S.cwServerSession.creditsRemaining = 0;
      _applyServerSessionUI();
      return { ok: false, error: 'NO_CREDITS' };
    }
    return { ok: true };
  } catch (e) { return { ok: true }; }
}

// ── Chrono display (zelda-chrono widget) ──
export function updateChronoDisplay(remainingSec) {
  const wrap = document.getElementById('zelda-chrono');
  const progress = document.getElementById('zelda-chrono-progress');
  const txt = document.getElementById('zelda-chrono-text');
  if (!wrap || !progress || !txt) return;
  if (isServerAdmin()) { wrap.style.display = 'none'; return; }
  let rem = remainingSec;
  if (rem === undefined || rem === null) {
    rem = Math.max(0, Math.floor(getRemainingSessionMs() / 1000));
  } else {
    rem = Math.max(0, Number(rem) || 0);
  }
  const tier = getSpecTier();
  const totals = { figurant: 30 * 60, audition: 120 * 60, oscar: 300 * 60, palme: 1200 * 60 };
  let total = totals[tier] || 30 * 60;
  if (tier === 'payg') total = Math.max(60, rem);
  const pct = total > 0 ? Math.min(1, Math.max(0, rem / total)) : 0;
  const circ = 2 * Math.PI * 24;
  const offset = circ * (1 - pct);
  progress.setAttribute('stroke-dasharray', String(circ));
  progress.setAttribute('stroke-dashoffset', String(offset));
  let color = '#7FE3A3';
  if (pct < 0.2) color = '#E8A055';
  if (pct < 0.08) color = '#D96F6F';
  progress.setAttribute('stroke', color);
  const mins = Math.floor(rem / 60);
  const secs = Math.floor(rem % 60);
  txt.textContent = mins + ':' + (secs < 10 ? '0' : '') + secs;
  wrap.style.display = 'block';
}
