// ── Admin Panel, Referral System, Burger Drawer, Server Session UI ──
// Extracted from index.html lines 1731-1949.
// Admin panel CRUD, plan switching, invite redemption, referral helpers,
// burger drawer, and server session UI binding.

import { S } from './state.js';
import { REFERRAL_KEY } from './constants.js';
import { showToast, escHtml, gaEvent, genCode } from './utils.js';
import { t } from './i18n.js';
import {
  getUserData, saveUserData, isServerAdmin, isServerTester,
  createFreshUserData, addPaygMinutes, updateChronoDisplay,
  getRemainingSessionMs, getSpecTier, updateTimerBadge,
} from './plan-timer.js';

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
  const badge = document.getElementById('cwSessionBadge');
  if (!badge) return;
  const burger = document.getElementById('cwBurgerRoot');
  const admPlan = document.getElementById('cwBurgerAdminPlan');
  const admLink = document.getElementById('cwBurgerAdminLink');
  if (S.cwServerSession.isAdmin) {
    badge.className = 'cw-session-badge cw-badge-admin';
    badge.textContent = 'ADMIN';
    badge.style.display = '';
    badge.style.cursor = 'pointer';
    badge.onclick = () => openAdminPanel();
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
  // updateCreditBadge lives in paywall.js; use window.* for late-binding
  if (typeof window.updateCreditBadge === 'function') window.updateCreditBadge();
}

// ── Admin Plan Switching ────────────────────────────────────────────

export function syncAdminPlanSelect() {
  const sel = document.getElementById('cwAdminPlanSelect');
  if (!sel) return;
  const tier = getUserData().tier || 'figurant';
  if ([...sel.options].some(o => o.value === tier)) sel.value = tier;
}

export function adminApplyTestPlan(tier) {
  if (!isServerAdmin()) return;
  const ok = ['figurant', 'audition', 'payg', 'oscar', 'palme'];
  if (!ok.includes(tier)) return;
  const cur = getUserData();
  const fresh = createFreshUserData(tier);
  fresh.email = cur.email || null;
  fresh.userId = cur.userId || null;
  fresh.preferences = { ...fresh.preferences, ...cur.preferences };
  fresh.flags = { ...fresh.flags, ...cur.flags };
  fresh.billing = { ...fresh.billing, ...cur.billing };
  saveUserData(fresh);
  updateTimerBadge();
  updateChronoDisplay();
  closeBurgerDrawer();
  const lab = {
    figurant: 'Figurant',
    audition: 'Audition',
    payg: 'Pay-as-you-go',
    oscar: 'Oscar',
    palme: 'Palme d\u2019Or',
  };
  showToast('Plan\u00a0: ' + (lab[tier] || tier), 2500);
}

// ── Burger Drawer ───────────────────────────────────────────────────

export function toggleBurgerDrawer() {
  const d = document.getElementById('cwBurgerDrawer');
  const o = document.getElementById('cwBurgerOverlay');
  const btn = document.getElementById('cwBurgerBtn');
  if (!d || !o) return;
  const open = !d.classList.contains('open');
  d.classList.toggle('open', open);
  o.classList.toggle('open', open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) syncAdminPlanSelect();
}

export function closeBurgerDrawer() {
  const d = document.getElementById('cwBurgerDrawer');
  const o = document.getElementById('cwBurgerOverlay');
  const btn = document.getElementById('cwBurgerBtn');
  if (d) d.classList.remove('open');
  if (o) o.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// ── Admin Panel ─────────────────────────────────────────────────────

export function openAdminPanel() {
  const panel = document.getElementById('cwAdminPanel');
  if (panel) { panel.classList.add('active'); adminLoadInvites(); }
}

export function closeAdminPanel() {
  const panel = document.getElementById('cwAdminPanel');
  if (panel) panel.classList.remove('active');
}

export async function adminCreateInvite() {
  const label = document.getElementById('invLabel').value.trim() || 'Invite';
  const email = document.getElementById('invEmail').value.trim() || undefined;
  const credits = parseInt(document.getElementById('invCredits').value) || 25;
  const expiresRaw = document.getElementById('invExpires').value;
  const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : undefined;
  try {
    const rsp = await fetch('/api/admin/create-invite', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, emailRestriction: email, creditsGranted: credits, expiresAt }),
    });
    const data = await rsp.json().catch(() => null);
    if (!data || !data.ok) { showToast('Error: ' + (data && data.error || 'unknown')); return; }
    const res = document.getElementById('cwInviteResult');
    res.style.display = 'block';
    res.innerHTML =
      `<b>Invite created!</b><br>` +
      `URL: <a href="${escHtml(data.inviteUrl)}" style="color:rgba(245,239,224,.6);word-break:break-all">${escHtml(data.inviteUrl)}</a><br>` +
      `Code: <code>${escHtml(data.inviteCode)}</code><br>` +
      `<button class="cw-admin-btn-secondary" style="margin-top:.4rem;font-size:.72rem" ` +
      `onclick="navigator.clipboard.writeText('${escHtml(data.inviteUrl)}');showToast('Copied!')">Copy URL</button>`;
    adminLoadInvites();
  } catch (e) { showToast('Network error'); }
}

export async function adminLoadInvites() {
  try {
    const rsp = await fetch('/api/admin/list-invites', { method: 'GET', credentials: 'same-origin' });
    const data = await rsp.json().catch(() => null);
    if (!data || !data.ok) return;
    const list = document.getElementById('cwInviteList');
    if (!list) return;
    if (!data.invites || !data.invites.length) {
      list.innerHTML = '<div style="color:rgba(245,239,224,.55);font-size:.78rem">No invites yet</div>';
      return;
    }
    list.innerHTML = data.invites.map(inv => {
      const status = inv.revoked
        ? '<span class="inv-revoked">REVOKED</span>'
        : (inv.expiresAt && new Date(inv.expiresAt) < new Date()
            ? '<span style="color:#f59e0b">EXPIRED</span>'
            : '<span style="color:#22c55e">ACTIVE</span>');
      const safeId = escHtml(String(inv.id || ''));
      const revokeBtn = inv.revoked
        ? ''
        : `<button class="cw-admin-btn-danger" style="font-size:.68rem;padding:.2rem .5rem;margin-top:.3rem" ` +
          `onclick="adminRevokeInvite('${safeId}')">Revoke</button>`;
      return `<div class="cw-invite-item">` +
        `<span class="inv-label">${escHtml(inv.label || '\u2014')}</span> \u00b7 ${status}<br>` +
        `<span class="inv-credits">${inv.creditsUsed || 0}/${inv.creditsGranted} credits used</span>` +
        `${inv.emailRestriction ? ' \u00b7 ' + escHtml(inv.emailRestriction) : ''}` +
        `${inv.redemptionCount ? ' \u00b7 ' + inv.redemptionCount + ' redeemed' : ''}<br>` +
        `${revokeBtn}</div>`;
    }).join('');
  } catch (e) {}
}

export async function adminRevokeInvite(inviteId) {
  try {
    await fetch('/api/admin/revoke-invite', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteId }),
    });
    adminLoadInvites();
  } catch (e) {}
}

// ── Invite Redemption ───────────────────────────────────────────────

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
      if (data.inviteLabel) showToast('Invite redeemed: ' + data.inviteLabel + ' (' + data.creditsRemaining + ' credits)', 5000);
      applyServerSessionUI();
      history.replaceState(null, '', window.location.pathname);
      return true;
    } else {
      showToast('Invite error: ' + (data && data.error || 'invalid'), 4000);
      history.replaceState(null, '', window.location.pathname);
    }
  } catch (e) { console.info('[invite] redeem failed', e); }
  return false;
}
