// ── Paywall / Credits UI ──────────────────────────────────────────────
// Extracted from index.html lines 1414-1731 (paywall modals, credit badge,
// topup flow, usage history, partner gate, sign-in handler).

import { S } from './state.js';
import { showToast, escHtml, track } from './utils.js';
import { t } from './i18n.js';
import { getUserData, saveUserData, getUserTier, getPlan, savePlan, fmtTimer, isServerAdmin, isServerTester } from './plan-timer.js';
import { playSfx } from './sfx.js';
import { AUDITION_WINDOW_MS } from './constants.js';

// ── Translation helper (safe fallback) ──────────────────────────────
export function tt(key, fallback) {
  try {
    const v = t(key);
    return (v && v !== key && !/\$\{/.test(v)) ? v : fallback;
  } catch (e) { return fallback; }
}

// ── Dismiss paywall overlay ─────────────────────────────────────────
export function dismissPaywall() {
  const ov = document.getElementById('paywallOverlay');
  if (ov) ov.remove();
}

// ── Main paywall modal (scene pause) ────────────────────────────────
export function showPaywallModal() {
  if (isServerAdmin()) return;
  window.cancelSpeechFlow();
  window.freezeTimer();
  dismissPaywall();
  playSfx('freeze', 0.45);
  const tier = getUserTier();
  const pl = getPlan();
  const cooldownEnd = pl.cooldownUntil || 0;
  const waitMs = Math.max(0, cooldownEnd - Date.now());
  const overlay = document.createElement('div');
  overlay.id = 'paywallOverlay';
  overlay.className = 'paywall-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) { dismissPaywall(); window.goHome(); } });
  const card = document.createElement('div');
  card.className = 'paywall-mini';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const badge = tt('paywallPause', 'Pause de la sc\u00e8ne');
  const title = tt('paywallTitle', 'La sc\u00e8ne s\'arr\u00eate ici.');
  const copy = tt('paywallSub', 'Tu as atteint la limite gratuite. Reprends maintenant ou continue plus tard.');
  const continueLabel = tt('paywallContinueBtn', 'Continuer la sc\u00e8ne');
  const laterLabel = tt('paywallQuitBtn', 'Plus tard');
  const restoreLabel = tt('paywallAlreadyPaid', 'J\'ai d\u00e9j\u00e0 pay\u00e9');
  let waitBtn = '';
  if (tier === 'free' && waitMs > 0) {
    const waitLabel = tt('paywallWaitBtn', 'Attendre');
    waitBtn = `<button class="paywall-secondary" id="paywallWaitBtn" onclick="dismissPaywall();goHome()">${waitLabel} (\u23F1 <span id="paywallCountdown">${fmtTimer(waitMs)}</span>)</button>`;
  } else {
    waitBtn = `<button class="paywall-secondary" onclick="dismissPaywall();goHome()">${laterLabel}</button>`;
  }
  const PAYG_PRICE = window.PAYG_PRICE || '';
  card.innerHTML = `
    <div class="paywall-badge"><span class="paywall-badge-dot"></span>${badge}</div>
    <div class="paywall-clap">\uD83C\uDFAC</div>
    <h2 class="paywall-title">${title}</h2>
    <p class="paywall-copy">${copy}</p>
    <div class="paywall-actions">
      <button class="paywall-primary" onclick="buyPaygBlock()">${continueLabel} \u2014 ${PAYG_PRICE}</button>
      ${waitBtn}
      <button class="paywall-link" onclick="buyPaygBlock()">${restoreLabel}</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const escHandler = e => { if (e.key === 'Escape') { dismissPaywall(); window.goHome(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
  if (tier === 'free' && waitMs > 0) {
    const cdEl = document.getElementById('paywallCountdown');
    if (cdEl) {
      const iv = setInterval(() => {
        const rem = Math.max(0, cooldownEnd - Date.now());
        cdEl.textContent = fmtTimer(rem);
        if (rem <= 0) { clearInterval(iv); dismissPaywall(); window.unfreezeTimer(); }
      }, 1000);
    }
  }
}

// ── Credit badge (session balance display) ──────────────────────────
export function updateCreditBadge() {
  var cents = (S.cwServerSession.creditBalance || 0);
  var dollarStr = '$' + (cents / 100).toFixed(2);
  var sb = document.getElementById('sessionBalanceBadge');
  var sa = document.getElementById('sessionBalanceAmount');
  var sl = document.getElementById('sessionBalanceLabel');
  if (sb) sb.style.display = S.cwServerSession.email ? '' : 'none';
  if (sa) { sa.textContent = dollarStr; sa.style.color = cents <= 50 ? '#e05555' : cents <= 200 ? '#e0a040' : '#d92027'; }
  if (sl) sl.textContent = tt('balanceLabel', 'Balance');
}

// ── Credit depleted modal ───────────────────────────────────────────
export function showCreditDepletedModal() {
  if (isServerAdmin()) return;
  window.cancelSpeechFlow();
  dismissPaywall();
  var overlay = document.createElement('div');
  overlay.id = 'paywallOverlay';
  overlay.className = 'paywall-overlay';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) dismissPaywall(); });
  var card = document.createElement('div');
  card.className = 'paywall-mini';
  card.innerHTML = '<div class="paywall-badge"><span class="paywall-badge-dot"></span>' + tt('creditsPause', 'Credits depleted') + '</div>'
    + '<div class="paywall-clap">\uD83C\uDFAC</div>'
    + '<h2 class="paywall-title">' + tt('creditsDepletedTitle', 'Top up to continue') + '</h2>'
    + '<p class="paywall-copy">' + tt('creditsDepletedSub', 'Your credit balance is empty. Add credits to keep using premium AI voices.') + '</p>'
    + '<div class="paywall-actions">'
    + '<button class="paywall-primary" onclick="openTopupModal(\'pack_5\')">$5</button>'
    + '<button class="paywall-primary" onclick="openTopupModal(\'pack_10\')">$10</button>'
    + '<button class="paywall-primary" onclick="openTopupModal(\'pack_25\')">$25</button>'
    + '<button class="paywall-secondary" onclick="dismissPaywall()">' + tt('paywallQuitBtn', 'Later') + '</button>'
    + '</div>';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ── Visitor sign-up prompt ──────────────────────────────────────────
export function showVisitorSignupPrompt() {
  window.cancelSpeechFlow();
  dismissPaywall();
  var overlay = document.createElement('div');
  overlay.id = 'paywallOverlay';
  overlay.className = 'paywall-overlay';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) dismissPaywall(); });
  var card = document.createElement('div');
  card.className = 'paywall-mini';
  card.innerHTML = '<div class="paywall-badge"><span class="paywall-badge-dot"></span>' + tt('freeTrialOver', 'Free preview ended') + '</div>'
    + '<div class="paywall-clap">\uD83C\uDFAC</div>'
    + '<h2 class="paywall-title">' + tt('signupForCreditsTitle', 'Sign up free') + '</h2>'
    + '<p class="paywall-copy">' + tt('signupForCreditsSub', 'Create a free account and get $1.50 credit to rehearse with premium AI voices.') + '</p>'
    + '<div class="paywall-actions">'
    + '<button class="paywall-primary" onclick="dismissPaywall();openAuthModal()">' + tt('signupBtn', 'Sign up free') + '</button>'
    + '<button class="paywall-secondary" onclick="dismissPaywall()">' + tt('paywallQuitBtn', 'Later') + '</button>'
    + '</div>';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ── Top-up modal (Polar checkout) ───────────────────────────────────
export async function openTopupModal(packId) {
  track('begin_checkout', { item_id: packId });
  dismissPaywall();
  showToast(t('redirectingToPayment'), 3000);
  try {
    var rsp = await fetch('/api/credits/topup', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack: packId }) });
    var data = await rsp.json().catch(function() { return null; });
    if (data && data.ok && data.checkoutUrl) {
      if (data.checkoutUrl && data.checkoutUrl.startsWith('https://polar.sh/')) window.location.href = data.checkoutUrl; else showToast('Invalid checkout URL', 3000);
    } else if (rsp.status === 401 || ((data && data.error) === 'AUTH_REQUIRED')) {
      showToast('Please log in first', 2000);
      setTimeout(function() { window.openAuthModal(); }, 500);
    } else {
      showToast((data && data.error) || 'Payment error', 3000);
    }
  } catch (e) { showToast('Payment error', 3000); }
}

// ── Refresh credit balance from server ──────────────────────────────
export async function refreshCreditBalance() {
  try {
    var rsp = await fetch('/api/credits/balance', { credentials: 'include' });
    var data = await rsp.json().catch(function() { return null; });
    if (data && data.ok) {
      S.cwServerSession.creditBalance = data.balance_cents || 0;
      updateCreditBadge();
      var balEl = document.getElementById('profileBalanceAmount');
      if (balEl) balEl.textContent = '$' + ((S.cwServerSession.creditBalance || 0) / 100).toFixed(2);
    }
  } catch (e) {}
}

// ── Pay-as-you-go UI toggle ─────────────────────────────────────────
export function updatePaygoUI() {
  var tog = document.getElementById('paygoToggle');
  var info = document.getElementById('paygoActiveInfo');
  var isOn = S.cwServerSession.billingMode === 'metered';
  if (tog) tog.classList.toggle('on', isOn);
  if (info) info.style.display = isOn ? '' : 'none';
}

export async function handlePaygoToggle() {
  var isOn = S.cwServerSession.billingMode === 'metered';
  if (isOn) {
    // Turning off -- revert to credits
    if (!confirm('Disable Pay-As-You-Go? You\'ll need credit packs to use TTS.')) return;
    try {
      await fetch('/api/credits/auto-topup', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ billing_mode: 'credits' }) });
      S.cwServerSession.billingMode = 'credits';
      updatePaygoUI();
      showToast('Pay-As-You-Go disabled. Using credit packs.', 3000);
    } catch (e) { showToast('Error', 3000); }
    return;
  }
  // Turning on -- subscribe via Polar
  try {
    var rsp = await fetch('/api/credits/metered-subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    var data = await rsp.json().catch(function() { return null; });
    if (data && data.already) { S.cwServerSession.billingMode = 'metered'; updatePaygoUI(); showToast('Pay-As-You-Go activated!'); return; }
    if (data && data.ok && data.checkoutUrl && data.checkoutUrl.startsWith('https://polar.sh/')) {
      window.location.href = data.checkoutUrl;
    } else {
      showToast('Could not start checkout: ' + (data && data.error || 'error'), 4000);
    }
  } catch (e) { showToast('Error enabling Pay-As-You-Go', 3000); }
}

// ── Usage history (profile panel) ───────────────────────────────────
export async function loadUsageHistory() {
  try {
    var rsp = await fetch('/api/credits/balance', { credentials: 'same-origin' });
    var data = await rsp.json().catch(function() { return null; });
    if (!data || !data.ok) return;
    var list = document.getElementById('profileUsageList');
    if (!list) return;
    var txs = data.transactions || [];
    var meteredEvts = data.meteredEvents || [];
    // Merge metered events into transaction-like items for display
    if (meteredEvts.length) {
      for (var m = 0; m < meteredEvts.length; m++) {
        txs.push({ type: 'metered_tts', char_count: meteredEvts[m].char_count || 0, created_at: meteredEvts[m].created_at, amount_cents: 0 });
      }
      txs.sort(function(a, b) { return a.created_at > b.created_at ? -1 : 1; });
    }
    if (!txs.length) { list.innerHTML = '<div style="color:#9CA3AF;padding:8px 0">' + t('noActivityYet') + '</div>'; return; }
    // Group TTS debits/metered by date, show topups/grants individually
    var groups = [];
    var currentDateDebits = null;
    for (var i = 0; i < txs.length; i++) {
      var tx = txs[i];
      var dt = new Date(tx.created_at + 'Z');
      var dateStr = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      var timeStr = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      if (tx.type === 'tts_debit' || tx.type === 'metered_tts') {
        if (currentDateDebits && currentDateDebits.date === dateStr) {
          currentDateDebits.total += Math.abs(tx.amount_cents || 0);
          currentDateDebits.count++;
          currentDateDebits.chars += (tx.char_count || 0);
          currentDateDebits.metered = currentDateDebits.metered || (tx.type === 'metered_tts');
        } else {
          if (currentDateDebits) groups.push(currentDateDebits);
          currentDateDebits = { type: 'debit_group', date: dateStr, total: Math.abs(tx.amount_cents || 0), count: 1, chars: tx.char_count || 0, metered: tx.type === 'metered_tts' };
        }
      } else {
        if (currentDateDebits) { groups.push(currentDateDebits); currentDateDebits = null; }
        groups.push({ type: 'single', description: tx.description || tx.type, amount: tx.amount_cents, date: dateStr, time: timeStr });
      }
    }
    if (currentDateDebits) groups.push(currentDateDebits);
    list.innerHTML = groups.map(function(g) {
      if (g.type === 'debit_group') {
        var costStr = g.metered ? ((g.chars / 1000 * 0.30).toFixed(2)) : ((g.total / 100).toFixed(2));
        var label = g.metered ? 'PAYG' : '';
        return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eee">'
          + '<span style="color:#4B5563">' + g.date + ' \u2014 ' + g.count + ' AI lines' + (g.chars ? ' (' + g.chars.toLocaleString() + ' chars)' : '') + '</span>'
          + '<span style="color:' + (g.metered ? '#6B7280' : '#D96F6F') + ';font-weight:600">' + (g.metered ? '~$' + costStr : '-$' + costStr) + (label ? ' <span style="font-size:.6rem;opacity:.6">' + label + '</span>' : '') + '</span>'
          + '</div>';
      } else {
        var sign = g.amount >= 0 ? '+' : '';
        var color = g.amount >= 0 ? '#22c55e' : '#D96F6F';
        return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eee">'
          + '<span style="color:#4B5563">' + escHtml(g.date) + ' ' + escHtml(g.time) + ' \u2014 ' + escHtml(g.description) + '</span>'
          + '<span style="color:' + color + ';font-weight:600">' + sign + '$' + (Math.abs(g.amount) / 100).toFixed(2) + '</span>'
          + '</div>';
      }
    }).join('');
  } catch (e) {}
}

// ── Partner gate (sign-up required for partner mode) ────────────────
export function showPartnerGate() {
  const overlay = document.createElement('div');
  overlay.id = 'partnerGateOverlay';
  overlay.className = 'paywall-overlay';
  const card = document.createElement('div');
  card.className = 'paywall-mini';
  card.innerHTML = `
    <div class="paywall-badge"><span class="paywall-badge-dot"></span>\uD83C\uDFAD</div>
    <h2 class="paywall-title" style="font-size:1.2rem">${tt('partnerGateTitle', 'Create an account to invite a partner.')}</h2>
    <p class="paywall-copy">${tt('partnerGateDesc', 'Sign up for free to unlock partner mode.')}</p>
    <div class="paywall-actions">
      <button class="paywall-primary" onclick="openAuthModal();document.getElementById('partnerGateOverlay').remove()">${tt('partnerGateSignup', 'Cr\u00e9er un compte')}</button>
      <button class="paywall-secondary" onclick="document.getElementById('partnerGateOverlay').remove();goSetupAi()">${tt('partnerGateSolo', 'Continuer seul')}</button>
    </div>`;
  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── Buy PAYG block (delegates to topup) ─────────────────────────────
export function buyPaygBlock() {
  openTopupModal('pack_5');
}

// ── Post-sign-in handler ────────────────────────────────────────────
export function onUserSignedIn(user) {
  const u = getUserData();
  if (u.tier === 'figurant') {
    const prefs = { ...u.preferences };
    const merged = window.mergeUserDataDefaults(window.createFreshUserData('audition'));
    merged.preferences = { ...merged.preferences, ...prefs };
    merged.flags = { ...merged.flags, ...u.flags };
    merged.billing = { ...merged.billing, ...u.billing };
    if (user && user.id) merged.email = String(user.id);
    if (user && user.userId) merged.userId = String(user.userId);
    saveUserData(merged);
  } else if (u.tier === 'audition') {
    u.aiMinutes.remainingSeconds = Math.max(u.aiMinutes.remainingSeconds || 0, 120 * 60);
    u.aiMinutes.nextResetAt = u.aiMinutes.nextResetAt || Date.now() + AUDITION_WINDOW_MS;
    if (user && user.id) u.email = String(user.id);
    if (user && user.userId) u.userId = String(user.userId);
    saveUserData(u);
  } else if (user && (user.id || user.userId)) {
    if (user.id) u.email = String(user.id);
    if (user.userId) u.userId = String(user.userId);
    saveUserData(u);
  }
  if (S.elevenLabsDisableReason === 'credits_depleted') {
    S.elevenLabsTemporarilyDisabled = false;
    S.elevenLabsDisableReason = '';
  }
  dismissPaywall();
  window.updateTimerBadge();
}
