// ── Auth & Session Module ───────────────────────────────────────────
// Extracted from index.html: authentication (email + Google OAuth),
// session management, user access persistence, settings persistence,
// profile UI, and burger drawer.

import { S } from './state.js';
import { SETTINGS_KEY, ACCESS_KEY, GOOGLE_CLIENT_ID, APP_BUILD } from './constants.js';
import { showToast, escHtml, track, emailInitials } from './utils.js';
import { t } from './i18n.js';
import { getUserData, saveUserData, getUserTier, isSignedUp, isServerAdmin, checkAndApplyResets, createFreshUserData, getPlan } from './plan-timer.js';
import { refreshCreditBalance, onUserSignedIn, updateCreditBadge, tt, dismissPaywall, updatePaygoUI, loadUsageHistory } from './paywall.js';

// ── Settings persistence ────────────────────────────────────────────

export function persistSettings() {
  const realVoice = S.selectedVoice && S.selectedVoice.id === '_italienne' ? S._preItalienneVoice : S.selectedVoice;
  const payload = {
    uiLang:     S.selectedUILanguage,
    voiceLocale: S.selectedLocale,
    voiceId:    realVoice ? realVoice.id : '',
    emotion:    S.selectedEmotion,
    speedValue: S.voiceSpeed,
    mode:       S.mode,
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload)); } catch (e) {}
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {}
  return null;
}

// ── Access persistence ──────────────────────────────────────────────

export function loadAccess() {
  try {
    const raw = localStorage.getItem(ACCESS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') S.userAccess = { ...S.userAccess, ...parsed };
    if (S.userAccess.email && /\@castwing\.user$/i.test(S.userAccess.email)) {
      S.userAccess = { email: '', verified: false, provider: '', paid: false, usageMs: 0, cooldownUntil: 0, lastTick: 0 };
      persistAccess();
    }
  } catch (e) {}
}

export function persistAccess() {
  try { localStorage.setItem(ACCESS_KEY, JSON.stringify(S.userAccess)); } catch (e) {}
}

// ── Auth mini button (avatar / login prompt) ────────────────────────

export function updateAuthMiniButton() {
  const btn = document.getElementById('authMiniBtn');
  if (!btn) return;
  if (S.userAccess.verified && S.userAccess.email) {
    const initials = emailInitials(S.userAccess.email);
    btn.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#d92027,#8a1519);color:#1a1a1a;font-size:.7rem;font-weight:800;letter-spacing:.02em">${initials}</span>`;
    return;
  }
  btn.innerHTML = '';
  btn.textContent = t('authMiniBtn');
}

// ── Auth modal ──────────────────────────────────────────────────────

export function openAuthModal() {
  const loginView   = document.getElementById('authLoginView');
  const accountView = document.getElementById('authAccountView');
  document.getElementById('authStatusText').textContent = '';
  const codeRow = document.getElementById('authCodeRow');
  if (codeRow) codeRow.classList.remove('active');
  const codeInput = document.getElementById('authCodeInput');
  if (codeInput) codeInput.value = '';
  const resendLink = document.getElementById('authResendLink');
  if (resendLink) resendLink.style.display = 'none';

  if (S.userAccess.verified && S.userAccess.email) {
    if (loginView) loginView.style.display = 'none';
    if (accountView) accountView.style.display = 'block';
    const titleEl = document.getElementById('authTitle');
    if (titleEl) titleEl.textContent = t('authAccountTitle') || 'My account';
    const avatar  = document.getElementById('authAvatar');
    const emailEl = document.getElementById('authLoggedEmail');
    if (avatar) avatar.textContent = emailInitials(S.userAccess.email);
    if (emailEl) emailEl.textContent = S.userAccess.email;
    // Populate credit balance and usage history
    var balEl = document.getElementById('profileBalanceAmount');
    if (balEl) balEl.textContent = '$' + ((S.cwServerSession.creditBalance || 0) / 100).toFixed(2);
    var balLabel = document.getElementById('profileBalanceLabel');
    if (balLabel) balLabel.textContent = tt('creditBalance', 'Credit Balance');
    var usageLabel = document.getElementById('profileUsageLabel');
    if (usageLabel) usageLabel.textContent = tt('recentActivity', 'Recent activity');
    // Fetch fresh balance from server
    (S.cwServerSession.email ? Promise.resolve() : fetchServerSession()).then(function() {
      return refreshCreditBalance();
    }).then(function() {
      var el = document.getElementById('profileBalanceAmount');
      if (el) el.textContent = '$' + ((S.cwServerSession.creditBalance || 0) / 100).toFixed(2);
    });
    loadUsageHistory();
    updatePaygoUI();
    if (typeof window.renderProfileRecordings === 'function') window.renderProfileRecordings();
    var bv = document.getElementById('profileBuildVersion'); if (bv) bv.textContent = 'v' + APP_BUILD;
    var abv = document.getElementById('authBuildVersion'); if (abv) abv.textContent = 'v' + APP_BUILD;
  } else {
    if (loginView) loginView.style.display = 'block';
    if (accountView) accountView.style.display = 'none';
    const titleEl = document.getElementById('authTitle');
    if (titleEl) titleEl.textContent = t('authTitle');
  }
  document.getElementById('authModal').classList.add('active');
}

export function closeAuthModal() {
  var m = document.getElementById('authModal');
  if (m) m.classList.remove('active');
}

// ── Profile section toggler ─────────────────────────────────────────

export function toggleProfileSection(listId, toggleId) {
  var el = document.getElementById(listId);
  var tg = document.getElementById(toggleId);
  if (!el) return;
  var open = el.style.display !== 'none';
  el.style.display = open ? 'none' : '';
  if (tg) tg.textContent = open ? '\u25BC' : '\u25B2';
}

// ── Logout ──────────────────────────────────────────────────────────

export async function logoutUser() {
  track('logout');
  S.userAccess = { email: '', verified: false, provider: '', paid: false, usageMs: 0, cooldownUntil: 0, lastTick: 0 };
  persistAccess();
  saveUserData(createFreshUserData('figurant'));
  S.cwServerSession = { email: null, isAdmin: false, plan: 'visitor', creditsRemaining: null, creditBalance: 0, autoTopupCents: 0 };
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  applyServerSessionUI();
  updateAuthMiniButton();
  closeAuthModal();
  showToast('Logged out', 2000);
}

// ── Change email ────────────────────────────────────────────────────

export function startChangeEmail() {
  const loginView   = document.getElementById('authLoginView');
  const accountView = document.getElementById('authAccountView');
  if (loginView) loginView.style.display = 'block';
  if (accountView) accountView.style.display = 'none';
  const emailInput = document.getElementById('authEmailInput');
  if (emailInput) { emailInput.value = ''; emailInput.focus(); }
}

// ── Email auth helpers ──────────────────────────────────────────────

function authEmailLangFromUI() {
  const id = S.selectedUILanguage || 'fr';
  const allowed = new Set(['fr', 'en', 'es', 'it', 'de', 'pt', 'ja', 'zh', 'ko', 'ar', 'he', 'ru']);
  return allowed.has(id) ? id : 'fr';
}

export async function requestEmailCode() {
  if (S._authCodeSending) return;
  S._authCodeSending = true;
  const btn = document.getElementById('authSendCodeBtn');
  if (btn) btn.disabled = true;
  track('auth_request_code');
  const email = (document.getElementById('authEmailInput').value || '').trim().toLowerCase();
  if (!email || !/@/.test(email)) { showToast('Email invalide'); S._authCodeSending = false; if (btn) btn.disabled = false; return; }
  S.authPendingEmail = email;
  try {
    const rsp = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'request_code', email, lang: authEmailLangFromUI() }), credentials: 'same-origin' });
    const out = await rsp.json().catch(() => null);
    if (!rsp.ok) { showToast((out && out.error) || 'Email failed'); return; }
    showToast((t('authCodeSent') || 'Code sent. Check your inbox.') + ' (' + email + ')', 5000);
    const codeRow = document.getElementById('authCodeRow');
    if (codeRow) codeRow.classList.add('active');
    const codeInput = document.getElementById('authCodeInput');
    if (codeInput) codeInput.focus();
    const resendLink = document.getElementById('authResendLink');
    if (resendLink) resendLink.style.display = 'block';
    document.getElementById('authStatusText').textContent = t('authCodeSent');
  } catch (e) {
    console.error('[auth] requestEmailCode error:', e.name, e.message);
    showToast(e.name === 'TypeError' ? 'Network error \u2014 check your connection' : 'Connection failed \u2014 try again', 5000);
  } finally {
    S._authCodeSending = false;
    if (btn) btn.disabled = false;
  }
}

export async function verifyEmailCode() {
  const code = (document.getElementById('authCodeInput').value || '').trim();
  if (!S.authPendingEmail || code.length < 4) { showToast(t('authInvalidCode')); return; }
  var rsp, out;
  try {
    rsp = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify_code', email: S.authPendingEmail, code }), credentials: 'same-origin' });
    out = await rsp.json().catch(() => null);
  } catch (e) { console.error('[auth] network error:', e); showToast('Connection error. Check your internet and try again.', 5000); return; }
  if (!rsp.ok || !(out && out.ok)) { showToast((out && out.error) || t('authInvalidCode')); return; }
  // Auth succeeded
  var isSignup = false;
  try { isSignup = getPlan().tier === 'visitor'; } catch (_e) {}
  if (out.isNewUser === true) isSignup = true; else if (out.isNewUser === false) isSignup = false;
  S.userAccess.email = S.authPendingEmail; S.userAccess.verified = true; S.userAccess.provider = 'email';
  track(isSignup ? 'sign_up' : 'login', { method: 'email' });
  try { persistAccess(); } catch (_e) {}
  try { updateAuthMiniButton(); } catch (_e) {}
  try {
    if (isSignup) {
      onUserSignedIn({ id: S.authPendingEmail, userId: out.userId || null });
    } else {
      const u = getUserData();
      u.email = S.authPendingEmail;
      if (out.userId) u.userId = out.userId;
      if (out.tier && ['figurant', 'audition', 'payg', 'oscar', 'palme'].includes(out.tier)) u.tier = out.tier;
      if (u.tier === 'figurant') onUserSignedIn({ id: S.authPendingEmail, userId: out.userId || null });
      else { saveUserData(u); dismissPaywall(); if (typeof window.updateTimerBadge === 'function') window.updateTimerBadge(); if (typeof window.updateChronoDisplay === 'function') window.updateChronoDisplay(); }
    }
  } catch (e) { console.warn('[auth] post-login data:', e); }
  try { await fetchServerSession(); } catch (_e) {}
  try { var _ast = document.getElementById('authStatusText'); if (_ast) _ast.textContent = t('authVerified'); } catch (_e) {}
  showToast(isSignup ? t('authWelcomeNew') : t('authWelcomeBack'), isSignup ? 4200 : 3200);
  try { closeAuthModal(); } catch (_e) {}
  resumePendingFileAfterAuth();
}

// ── Google Sign-In ──────────────────────────────────────────────────

export function startGoogleSignIn() {
  if (/OPR\/|Opera/i.test(navigator.userAgent)) { showToast('Google login unavailable on this browser \u2014 use email', 4000); return; }
  if (typeof google === 'undefined' || !google.accounts) { showToast('Google non disponible, utilise ton email'); return; }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential, auto_prompt: false });
  google.accounts.id.prompt(n => {
    if (n.isNotDisplayed() || n.isSkippedMoment()) {
      google.accounts.id.renderButton(document.getElementById('googleSignInBtn'), { theme: 'outline', size: 'large', width: 320 });
      showToast('Clique \u00e0 nouveau sur le bouton Google');
    }
  });
}

export async function handleGoogleCredential(response) {
  if (!response || !response.credential) { showToast('Google error'); return; }
  var rsp, out;
  try {
    rsp = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: response.credential }), credentials: 'same-origin' });
    out = await rsp.json().catch(() => null);
  } catch (e) { console.error('[auth] google network error:', e); showToast('Connection error. Check your internet and try again.', 5000); return; }
  if (!rsp.ok || !(out && out.ok)) { showToast(out && out.error ? out.error : 'Google error'); return; }
  var isSignup = false;
  try { isSignup = getPlan().tier === 'visitor'; } catch (_e) {}
  if (out.isNewUser === true) isSignup = true; else if (out.isNewUser === false) isSignup = false;
  S.userAccess.email = out.email; S.userAccess.verified = true; S.userAccess.provider = 'google';
  track(isSignup ? 'sign_up' : 'login', { method: 'google' });
  try { persistAccess(); } catch (_e) {}
  try { updateAuthMiniButton(); } catch (_e) {}
  try {
    if (isSignup) {
      onUserSignedIn({ id: out.email, userId: out.userId || null });
    } else {
      const u = getUserData();
      u.email = out.email;
      if (out.userId) u.userId = out.userId;
      if (out.tier && ['figurant', 'audition', 'payg', 'oscar', 'palme'].includes(out.tier)) u.tier = out.tier;
      if (u.tier === 'figurant') onUserSignedIn({ id: out.email, userId: out.userId || null });
      else { saveUserData(u); dismissPaywall(); if (typeof window.updateTimerBadge === 'function') window.updateTimerBadge(); if (typeof window.updateChronoDisplay === 'function') window.updateChronoDisplay(); }
    }
  } catch (e) { console.warn('[auth] google post-login data:', e); }
  try { await fetchServerSession(); } catch (_e) {}
  try { var st = document.getElementById('authStatusText'); if (st) st.textContent = t('authVerified'); } catch (_e) {}
  showToast(isSignup ? t('authWelcomeNew') : t('authWelcomeBack'), isSignup ? 4200 : 3200);
  try { closeAuthModal(); } catch (_e) {}
  resumePendingFileAfterAuth();
}

// ── Server session ──────────────────────────────────────────────────

export async function fetchServerSession() {
  try {
    const rsp = await fetch('/api/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (!rsp.ok) { console.warn('[session] http', rsp.status); return; }
    const data = await rsp.json().catch(() => null);
    console.info('[session]', JSON.stringify(data));
    if (!data || !data.ok) return;
    S.cwServerSession = {
      email:            data.email || null,
      isAdmin:          !!data.isAdmin,
      plan:             data.plan || 'visitor',
      creditsRemaining: data.creditsRemaining,
      creditBalance:    data.creditBalance || 0,
      autoTopupCents:   data.autoTopupCents || 0,
      billingMode:      data.billingMode || 'credits',
    };
    applyServerSessionUI();
  } catch (e) { console.warn('[session] fetch failed', e); }
}

export function applyServerSessionUI() {
  const badge = document.getElementById('cwSessionBadge');
  if (!badge) return;
  const burger  = document.getElementById('cwBurgerRoot');
  const admPlan = document.getElementById('cwBurgerAdminPlan');
  const admLink = document.getElementById('cwBurgerAdminLink');
  if (S.cwServerSession.isAdmin) {
    badge.className = 'cw-session-badge cw-badge-admin';
    badge.textContent = 'ADMIN';
    badge.style.display = '';
    badge.style.cursor = 'pointer';
    badge.onclick = () => { if (typeof window.openAdminPanel === 'function') window.openAdminPanel(); };
    if (burger) burger.style.display = '';
    if (admPlan) admPlan.style.display = 'block';
    if (admLink) admLink.style.display = 'block';
    syncAdminPlanSelect();
  } else {
    badge.style.display = 'none';
    if (burger) burger.style.display = 'none';
    if (admPlan) admPlan.style.display = 'none';
    if (admLink) admLink.style.display = 'none';
    closeBurgerDrawer();
  }
  updateCreditBadge();
}

// ── Admin plan selector sync ────────────────────────────────────────

export function syncAdminPlanSelect() {
  const sel = document.getElementById('cwAdminPlanSelect');
  if (!sel) return;
  const tier = getUserData().tier || 'figurant';
  if ([...sel.options].some(o => o.value === tier)) sel.value = tier;
}

// ── Burger drawer ───────────────────────────────────────────────────

export function toggleBurgerDrawer() {
  const d   = document.getElementById('cwBurgerDrawer');
  const o   = document.getElementById('cwBurgerOverlay');
  const btn = document.getElementById('cwBurgerBtn');
  if (!d || !o) return;
  const open = !d.classList.contains('open');
  d.classList.toggle('open', open);
  o.classList.toggle('open', open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) syncAdminPlanSelect();
}

export function closeBurgerDrawer() {
  const d   = document.getElementById('cwBurgerDrawer');
  const o   = document.getElementById('cwBurgerOverlay');
  const btn = document.getElementById('cwBurgerBtn');
  if (d) d.classList.remove('open');
  if (o) o.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// ── Resume pending file after auth ──────────────────────────────────

export function resumePendingFileAfterAuth() {
  if (!S._pendingFileAfterAuth) return;
  const { n, file } = S._pendingFileAfterAuth;
  S._pendingFileAfterAuth = null;
  if (typeof window.showScreen === 'function') window.showScreen('importScene');
  if (typeof window.initDragDrop === 'function') window.initDragDrop('uploadZone1');
  setTimeout(() => {
    if (typeof window.isPdfUploadFile === 'function' && window.isPdfUploadFile(file)) {
      if (typeof window.processPDF === 'function') window.processPDF(n, file);
    } else {
      showToast('Unsupported file format', 4000);
    }
  }, 300);
}
