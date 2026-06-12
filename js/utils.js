import { S } from './state.js';
import { APP_BUILD } from './constants.js';

/* ── Analytics ── */
export function gaEvent(name, params) { try { window.gtag('event', name, params || {}); } catch(e) {} }

/* Dual-write analytics: GA + first-party /api/track (D1).
   Fire-and-forget; sendBeacon survives page unload (session_abandon). */
export function track(name, params) {
  gaEvent(name, params);
  try {
    const payload = JSON.stringify({
      event_type: name,
      meta: params || {},
      sid: S._analyticsSid,
      build: APP_BUILD,
      lang: S.selectedUILanguage || '',
      device: isMobileDevice() ? 'mobile' : 'desktop',
    });
    if (navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }))) return;
    fetch('/api/track', { method: 'POST', body: payload, keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  } catch (e) { /* analytics must never break the app */ }
}

/* ── Tiny helpers ── */
export function genCode(){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let r='';for(let i=0;i<8;i++)r+=c[Math.floor(Math.random()*c.length)];return r}
export function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

/* ── Toast / Overlay ── */
export function showToast(m,d=3000){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),d)}
export function showOverlay(t,m){document.getElementById('overlayTitle').textContent=t;document.getElementById('overlayMsg').textContent=m;document.getElementById('connectOverlay').classList.add('active')}
export function hideOverlay(){document.getElementById('connectOverlay').classList.remove('active')}

/* ── Async / Device ── */
export function yieldToBrowser(){
  return new Promise(resolve=>{
    if(typeof requestAnimationFrame==='function'){
      requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()));
    }else{
      setTimeout(resolve,0);
    }
  });
}
export function isMobileDevice(){
  try{if(navigator.userAgentData&&typeof navigator.userAgentData.mobile==='boolean')return navigator.userAgentData.mobile}catch(_e){}
  return /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(navigator.userAgent||'');
}

/* ── Pull-to-refresh (home screen only) ── */
export function initPullToRefresh() {
  if (!('ontouchstart' in window)) return;
  const ind = document.createElement('div');
  ind.setAttribute('style',
    'position:fixed;top:-48px;left:50%;transform:translateX(-50%);z-index:99999;' +
    'background:var(--bg-2);color:var(--white);padding:6px 18px;border-radius:20px;' +
    'font-size:13px;font-family:"DM Sans",sans-serif;opacity:0;transition:top .18s,opacity .18s;' +
    'pointer-events:none;border:1px solid var(--border-light);');
  ind.textContent = '\u2193 Pull to refresh';
  document.body.appendChild(ind);

  let startY = 0, pulling = false;
  const THRESHOLD = 90;

  document.addEventListener('touchstart', e => {
    const home = document.getElementById('home');
    if (!home || !home.classList.contains('active')) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 10) { ind.style.top = '-48px'; ind.style.opacity = '0'; return; }
    const pct = Math.min(dy / THRESHOLD, 1);
    ind.style.top = (-48 + 68 * pct) + 'px';
    ind.style.opacity = String(pct);
    ind.textContent = dy >= THRESHOLD ? '\u2191 Release to refresh' : '\u2193 Pull to refresh';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    const wasReady = ind.textContent.startsWith('\u2191');
    pulling = false;
    ind.style.top = '-48px';
    ind.style.opacity = '0';
    if (wasReady) { location.replace(location.pathname); }
  }, { passive: true });
}

/* ── Email initials (for avatar badges) ── */
export function emailInitials(email){
  if(!email)return'?';
  const local=email.split('@')[0].replace(/[^a-zA-Z0-9]/g,' ').trim();
  const parts=local.split(/\s+/).filter(Boolean);
  if(parts.length>=2)return(parts[0][0]+parts[parts.length-1][0]).toUpperCase();
  const word=parts[0]||'';
  if(word.length<=2)return word.toUpperCase();
  const consonants=word.replace(/[aeiou]/gi,'');
  if(consonants.length>=2)return(consonants[0]+consonants[consonants.length-1]).toUpperCase();
  return word.slice(0,2).toUpperCase();
}
