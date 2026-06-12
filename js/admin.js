// ── Referral System, Server Session UI, Invite Redemption ───────────
// The in-app admin panel was removed: analytics now live on the
// standalone password-protected /admin page served by the worker.

import { S } from './state.js';
import { REFERRAL_KEY } from './constants.js';
import { showToast, genCode } from './utils.js';
import { t } from './i18n.js';
import { addPaygMinutes } from './plan-timer.js';

// ── Referral System ─────────────────────────────────────────────────

export function getReferralData() {
  try {
    const r = localStorage.getItem(REFERRAL_KEY);
    if (r) return JSON.parse(r);
  } catch (e) {}
  const code = genCode();
  const init = { code, signups: 0, rewarded: false };
  try { localStorage.setItem(REFERRAL_KEY, JSON.stringify(init)); } catch (e) {}
  return init;
}

export function recordReferralSignup() {
  const r = getReferralData();
  r.signups = (r.signups || 0) + 1;
  if (r.signups >= 2 && !r.rewarded) {
    r.rewarded = true;
    addPaygMinutes(30 * 60 * 1000);
    showToast(t('referralReward'), 4000);
  }
  try { localStorage.setItem(REFERRAL_KEY, JSON.stringify(r)); } catch (e) {}
}

export function getReferralCode() {
  return getReferralData().code || '';
}

// ── Server Session UI ───────────────────────────────────────────────

export async function fetchServerSession() {
  try {
    const rsp = await fetch('/api/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (!rsp.ok) { console.warn('[session] http', rsp.status); return; }
    const data = await rsp.json().catch(() => null);
    console.info('[session]', JSON.stringify(data));
    if (!data || !data.ok) return;
    S.cwServerSession = {
      email: data.email || null,
      isAdmin: !!data.isAdmin,
      plan: data.plan || 'visitor',
      creditsRemaining: data.creditsRemaining,
      creditBalance: data.creditBalance || 0,
      autoTopupCents: data.autoTopupCents || 0,
      billingMode: data.billingMode || 'credits',
    };
    applyServerSessionUI();
  } catch (e) { console.warn('[session] fetch failed', e); }
}

export function applyServerSessionUI() {
  // updateCreditBadge lives in paywall.js; use window.* for late-binding
  if (typeof window.updateCreditBadge === 'function') window.updateCreditBadge();
}

// ── Invite Redemption (user-facing ?invite= links) ──────────────────

export async function redeemInviteFromURL() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('invite');
  if (!token) return false;
  try {
    const email = S.userAccess.email || '';
    const rsp = await fetch('/api/invite/redeem', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, email }),
    });
    const data = await rsp.json().catch(() => null);
    if (data && data.ok) {
      S.cwServerSession.plan = 'tester';
      S.cwServerSession.creditsRemaining = data.creditsRemaining;
      if (data.inviteLabel) showToast(t('admInviteRedeemed', { label: data.inviteLabel, credits: data.creditsRemaining }), 5000);
      applyServerSessionUI();
      history.replaceState(null, '', window.location.pathname);
      return true;
    } else {
      showToast(t('admInviteError', { msg: (data && data.error || 'invalid') }), 4000);
      history.replaceState(null, '', window.location.pathname);
    }
  } catch (e) { console.info('[invite] redeem failed', e); }
  return false;
}
