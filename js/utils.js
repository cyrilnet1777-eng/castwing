import { S } from './state.js';

/* ── Analytics ── */
export function gaEvent(name, params) { try { window.gtag('event', name, params || {}); } catch(e) {} }

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
