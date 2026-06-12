// ── WebRTC Module ───────────────────────────────────────────────────
// Extracted from index.html: PeerJS connection management, ICE/TURN
// credential caching, data-channel message handling, partner code
// sharing, and partner session bootstrapping.

import { S } from './state.js';
import { showToast, showOverlay, hideOverlay, escHtml, track, genCode, isMobileDevice } from './utils.js';
import { t } from './i18n.js';
import { playSfx } from './sfx.js';

// ── ICE / TURN credentials ──────────────────────────────────────────

export async function getIceServers() {
  if (S._cachedIceServers && Date.now() < S._iceExpiry) return S._cachedIceServers;
  try {
    const r = await fetch('/api/turn-credentials');
    if (!r.ok) throw new Error('status ' + r.status);
    const d = await r.json();
    S._cachedIceServers = d.iceServers || d;
    S._iceExpiry = Date.now() + 12 * 3600 * 1000;
    return S._cachedIceServers;
  } catch (e) {
    console.warn('[TURN] credential fetch failed, using STUN only:', e.message);
    return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  }
}

// ── Peer keepalive ──────────────────────────────────────────────────

export function startPeerKeepalive() {
  stopPeerKeepalive();
  S._peerKeepalive = setInterval(function () {
    if (S.peer && !S.peer.disconnected && !S.peer.destroyed) {
      try { S.peer.socket.send({ type: 'heartbeat' }); } catch (e) { /* ignore */ }
    }
  }, 25000);
}

export function stopPeerKeepalive() {
  if (S._peerKeepalive) { clearInterval(S._peerKeepalive); S._peerKeepalive = null; }
}

// ── Peer creation ───────────────────────────────────────────────────

export async function createPeer(id) {
  var ice = await getIceServers();
  return new Peer(id, { config: { iceServers: ice } });
}

// ── Status dot helper ───────────────────────────────────────────────

export function setStatus(s, txt) {
  document.getElementById('statusDot').className = 'status-dot ' + s;
  document.getElementById('statusText').textContent = txt;
}

// ── Prompter sync over data channel ─────────────────────────────────

export function syncPrompter() {
  if (S.conn && S.conn.open) S.conn.send({ type: 'prompter', index: S.prompterIndex });
}

// ── Data-channel message handling ───────────────────────────────────

/** Safe i18n lookup with fallback */
function tt(key, fallback) {
  try { const v = t(key); return (v && v !== key && !/\$\{/.test(v)) ? v : fallback; } catch (e) { return fallback; }
}

export function handleDataMessage(d) {
  if (d.type === 'end-session') { showToast('Partner ended the session'); window.endSession(); return; }
  if (d.type === 'pause') { window.togglePause(true); return; }
  if (d.type === 'resume') { window.togglePause(false); return; }
  if (d.type === 'prompter' || d.type === 'jump') {
    if (window._scrollOwner === 'local') return; // last-touch-wins: local user is scrolling
    S.prompterIndex = d.index;
    // Lightweight update: move active class without full DOM rebuild
    const pa = document.getElementById('prompterArea');
    const target = pa && pa.querySelector('[data-line-index="' + d.index + '"]');
    if (target) {
      pa.querySelectorAll('.prompter-line.active').forEach(el => el.classList.remove('active'));
      target.classList.add('active');
      // Use instant scroll for remote sync
      window._scrollSyncProgrammatic = true;
      requestAnimationFrame(() => {
        const targetY = pa.scrollTop + target.getBoundingClientRect().top - pa.getBoundingClientRect().top - pa.clientHeight * 0.3;
        pa.scrollTo({ top: Math.max(0, targetY), behavior: 'instant' });
        setTimeout(() => { window._scrollSyncProgrammatic = false; }, 100);
      });
    } else {
      window.renderPrompter();
    }
  } else if (d.type === 'script') {
    S.prompterLines = (d.lines || []).map(l => ({ ...l }));
    S.prompterIndex = d.index || 0;
    window.debugPrompterPdfScriptKinds('peerScript');
    window.renderPrompter();
  } else if (d.type === 'ready') {
    if (S.role === 'actor') {
      S.call = S.localStream ? S.peer.call(S.conn.peer, S.localStream) : S.peer.call(S.conn.peer);
      setupCallHandlers(S.call);
    }
  }
}

// ── Data connection setup ───────────────────────────────────────────

export function setupDataConnection(c) {
  S.conn = c;
  S.conn.on('open', () => {
    setStatus('', 'Connected');
    hideOverlay();
    showToast('Partner connected!');
    playSfx('swoosh', 0.45);
    if (S.role === 'actor' && S.prompterLines.length > 0)
      S.conn.send({ type: 'script', lines: S.prompterLines, index: S.prompterIndex });
    if (S.role === 'partner') { S.conn.send({ type: 'ready' }); }
  });
  S.conn.on('data', handleDataMessage);
  S.conn.on('close', () => {
    setStatus('disconnected', 'Disconnected');
    showToast(tt('partnerDisconnected', 'Partner disconnected'), 4000);
    const rv = document.getElementById('remoteVideo');
    if (rv) { rv.srcObject = null; rv.style.display = 'none'; }
    document.getElementById('localVideo').style.display = '';
    if (S.localStream) document.getElementById('localVideo').srcObject = S.localStream;
  });
  S.conn.on('error', e => showToast(tt('error', 'Error') + ': ' + e.message));
}

// ── Call (audio/video) handlers ─────────────────────────────────────

export function setupCallHandlers(c) {
  S.call = c;
  S.call.on('stream', s => {
    document.getElementById('remoteAudio').srcObject = s;
    const hasVideo = s.getVideoTracks().length > 0;
    if (hasVideo && S.role === 'partner') {
      const rv = document.getElementById('remoteVideo');
      const lv = document.getElementById('localVideo');
      rv.srcObject = s; rv.style.display = 'block';
      lv.style.display = 'none';
      document.getElementById('noVideoMsg').style.display = 'none';
      try { rv.play().catch(() => {}); } catch (e) { /* ignore */ }
    }
    // Keep recording stream alive: mix remote audio + restart recorder if video track died
    if (S.isRecording && S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
      if (S._recAudioCtx && S._recDest && s.getAudioTracks().length > 0) {
        try {
          var remSrc = S._recAudioCtx.createMediaStreamSource(s);
          remSrc.connect(S._recDest);
        } catch (e) { console.warn('[rec] remote audio mix:', e); }
      }
      // Recording uses canvas draw loop -- video track changes are transparent
    }
  });
  S.call.on('close', () => {
    document.getElementById('remoteVideo').style.display = 'none';
    document.getElementById('localVideo').style.display = '';
    if (S.localStream) document.getElementById('localVideo').srcObject = S.localStream;
  });
  S.call.on('error', e => {
    console.error('Call error:', e);
    showToast(tt('error', 'Error') + ': ' + e.message, 3000);
  });
}

// ── Partner code & sharing ──────────────────────────────────────────

export function getPartnerCode() {
  const code = (document.getElementById('mySessionCodeText').textContent || '').trim();
  return code && code !== '\u2014' ? code : '';
}

export function getJoinLink() {
  const code = getPartnerCode();
  if (!code) return '';
  return 'https://citizentape.com/?join=' + encodeURIComponent(code);
}

export function getPartnerShareText() {
  const code = getPartnerCode();
  if (!code) return '';
  return '\uD83C\uDFAC Join me on CitizenTape\n' + getJoinLink();
}

export async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text); return true;
    }
  } catch (e) { /* fallback below */ }
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
  return ok;
}

export async function copyPartnerCode() {
  const code = getPartnerCode();
  if (!code) { showToast(t('codeUnavailable')); return; }
  const ok = await copyToClipboard(code);
  showToast(ok ? t('codeCopied') + ' \u2705' : t('copyFailed'));
  if (ok) {
    const el = document.getElementById('mySessionCode');
    if (el) { el.classList.remove('copied'); void el.offsetWidth; el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 600); }
  }
}

export async function copyPartnerLink() {
  const link = getJoinLink();
  if (!link) { showToast(t('linkUnavailable')); return; }
  const ok = await copyToClipboard(link);
  showToast(ok ? t('linkCopied') + ' \u2705' : t('copyFailed'));
}

export async function shareVia(channel) {
  const text = getPartnerShareText();
  const link = getJoinLink();
  if (!text || !link) { showToast(t('codeUnavailable')); return; }
  if (channel === 'native') {
    if (isMobileDevice() && navigator.share) {
      try { await navigator.share({ title: 'CitizenTape \u2014 Join my session', text: 'Join my CitizenTape session', url: link }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const ok = await copyToClipboard(link);
    showToast(ok ? t('linkCopied') + ' \u2705' : t('copyFailed'));
    return;
  }
  if (channel === 'whatsapp') { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); return; }
  if (channel === 'telegram') { window.open('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Join my CitizenTape session'), '_blank'); return; }
  if (channel === 'wechat') { await copyToClipboard(text); window.open('https://web.wechat.com/', '_blank'); showToast(t('shareTextCopied')); return; }
  const ok = await copyToClipboard(text);
  showToast(ok ? t('shareTextCopied') + ' \u2705' : t('shareUnavailable'));
}

export async function smartShare() {
  track('share_session');
  const link = getJoinLink();
  if (!link) { showToast(t('codeUnavailable')); return; }
  const isMobile = window.matchMedia('(max-width:767px)').matches;
  if (isMobile && navigator.share) {
    try { await navigator.share({ title: 'CitizenTape', text: 'Join my CitizenTape session', url: link }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const ok = await copyToClipboard(link);
  showToast(ok ? t('linkCopied') : t('copyFailed'));
}

// ── Join-code from URL ──────────────────────────────────────────────

export function applyJoinCodeFromURL() {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get('join') || params.get('code') || '').toUpperCase();
  const clean = raw.replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (!clean) return false;
  const input = document.getElementById('joinCodeInput');
  if (input) input.value = clean;
  window.showScreen('joinScreen');
  try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }
  setTimeout(() => { joinAsPartner(); }, 600);
  return true;
}

// ── Start partner session (host / actor) ────────────────────────────

export async function startPartnerSession() {
  track('start_session', { mode: 'partner_host' });
  await window.cwEnqueueSessionBoot(async () => {
    if (window.__cwSessionActive) return false;
    window.unlockAudio();
    if (S.pdfScript.length > 0 && !S.selectedChar) { showToast(t('pickCharacterFirst')); return false; }
    S.role = 'actor'; S.sessionMode = 'partner'; S.mode = 'manual';
    window.cancelSpeechFlow();
    const code = document.getElementById('mySessionCodeText').textContent;
    if (!code || code === '\u2014') return false;
    window.setPrompterLinesForSession(2, 'startPartnerSession');
    S.prompterIndex = 0;
    window.__cwPendingSessionTag = 'partner';
    window.showScreen('session');
    window.renderPrompter();
    setStatus('waiting', 'Waiting for partner\u2026');
    hideOverlay();
    window.hideAiOnlyControls();
    const ssb = document.getElementById('sessionShareBtn'); if (ssb) ssb.style.display = 'flex';
    const msb = document.getElementById('mobShareBtn'); if (msb) msb.style.display = 'flex';
    window.renderRecordingsList();
    window.cwCommitSessionLive();
    window.showClapperboard();
    showToast('Share code: ' + code, 4500);
    await window.ensureSessionStream();
    if (window.canRecord() && S.localStream && !S.isRecording) window.startRecording();
    const pid = 'citizentape-' + code;
    S.peer = await createPeer(pid);
    S.peer.on('open', function () { startPeerKeepalive(); });
    S.peer.on('connection', c => setupDataConnection(c));
    S.peer.on('call', ic => {
      if (S.localStream) ic.answer(S.localStream); else ic.answer();
      setupCallHandlers(ic);
    });
    S.peer.on('error', e => {
      hideOverlay();
      console.warn('[peer] actor error:', e.type, e.message);
      if (e.type === 'peer-unavailable' || e.type === 'negotiation')
        showToast('Partner connection failed \u2014 ask them to rejoin', 5000);
      else showToast('Connection error \u2014 try again', 5000);
    });
    S.connectionTimeout = setTimeout(() => {
      if (!S.conn || !S.conn.open) { hideOverlay(); setStatus('waiting', 'Waiting\u2026 (you can start solo)'); }
    }, 15000);
    return true;
  });
}

// ── Join as partner ─────────────────────────────────────────────────

export async function joinAsPartner() {
  track('start_session', { mode: 'partner_join' });
  await window.cwEnqueueSessionBoot(async () => {
    if (window.__cwSessionActive) return false;
    S.role = 'partner'; S.sessionMode = 'partner';
    window.cancelSpeechFlow();
    const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
    if (!code) { showToast('Enter a code'); return false; }
    window.__cwPendingSessionTag = 'partner_join';
    window.showScreen('session');
    setStatus('waiting', 'Connecting\u2026');
    showOverlay('Connecting\u2026', 'Looking for ' + code + '\u2026');
    window.hideAiOnlyControls();
    window.renderRecordingsList();
    // Partner: hide recording, end session, and done button
    var mobRec = document.getElementById('mobRecBtn'); if (mobRec) mobRec.style.display = 'none';
    var mobEnd = document.getElementById('mobEndBtn'); if (mobEnd) mobEnd.style.display = 'none';
    var doneBtn = document.getElementById('quitBtn'); if (doneBtn) doneBtn.style.display = 'none';
    var mobRecs = document.getElementById('mobRecsBtn'); if (mobRecs) mobRecs.style.display = 'none';
    var endBtn = document.getElementById('sessionEndBtn'); if (endBtn) endBtn.style.display = 'none';
    var btnRec = document.getElementById('btnRec'); if (btnRec) btnRec.style.display = 'none';
    var btnPause = document.getElementById('btnPause'); if (btnPause) btnPause.style.display = 'none';
    var mobMain = document.getElementById('mobMainBtn'); if (mobMain) mobMain.style.display = 'none';
    var psQuit = document.querySelector('.ps-quit-btn'); if (psQuit) psQuit.style.display = 'none';
    var pe = document.getElementById('prompterEmptyText');
    if (pe) pe.textContent = 'Waiting for actor to start the session\u2026';
    window.cwCommitSessionLive();
    document.getElementById('noVideoMsg').textContent = 'Audio only';
    // Partner only needs audio, not video
    try {
      S.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      var lv = document.getElementById('localVideo');
      if (lv) { lv.style.display = 'none'; }
    } catch (e) { console.warn('[partner] mic denied:', e.message); }
    var attempts = 0; var maxAttempts = 30; var connected = false;
    async function tryConnect() {
      if (connected || window._pdfParseCancelled) return;
      attempts++;
      if (S.peer && !S.peer.destroyed) { try { S.peer.destroy(); } catch (e) { /* ignore */ } }
      var mid = 'citizentape-p-' + code + '-' + Math.random().toString(36).substr(2, 4);
      S.peer = await createPeer(mid);
      S.peer.on('open', function () {
        var c = S.peer.connect('citizentape-' + code, { reliable: true });
        c.on('open', function () { connected = true; startPeerKeepalive(); });
        setupDataConnection(c);
      });
      S.peer.on('call', function (ic) {
        if (S.localStream) ic.answer(S.localStream); else ic.answer();
        setupCallHandlers(ic);
      });
      S.peer.on('error', function (e) {
        if (!connected && attempts < maxAttempts) {
          showOverlay('Waiting for actor\u2026', 'The actor hasn\'t started yet. Retrying\u2026 (' + attempts + '/' + maxAttempts + ')');
          setTimeout(tryConnect, 3000);
        } else if (!connected) {
          hideOverlay();
          showToast('Could not connect. Ask the actor to start the session first.', 6000);
          setStatus('disconnected', 'Not found');
        }
      });
    }
    tryConnect();
    return true;
  });
}
