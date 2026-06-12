// ── IndexedDB helpers ────────────────────────────────────────────────
// Recording history, generic KV store, script snapshots, script history.

import { S } from './state.js';
import { LINE_TYPE } from './constants.js';
import { escHtml, showToast } from './utils.js';
import { t, detectTextLanguage } from './i18n.js';
import {
  VOICE_LOCALES,
  applyLocaleVoices,
  initVoiceCountrySelect,
  initVoiceGrid,
} from './voices.js';

// ── Constants ────────────────────────────────────────────────────────
const CW_IDB_NAME         = 'citizentape-script-db';
const CW_LEGACY_IDB_NAME  = 'CastwingDB';
const CW_IDB_STORE        = 'kv';
const CW_SNAPSHOT_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const CW_RESTORE_SUPPRESS_KEY = 'cw_restore_suppress';

const REC_DB    = 'citizentape-recordings';
const REC_STORE = 'recs';

const SCRIPT_HIST_KEY = 'cw.scriptHistory.v1';
const SCRIPT_HIST_MAX = 10;

// ── Internal state (lives on S) ─────────────────────────────────────
// S._cwIdb caches the open CW KV database handle
S._cwIdb = null;

// ══════════════════════════════════════════════════════════════════════
//  Recording History (IndexedDB: citizentape-recordings)
// ══════════════════════════════════════════════════════════════════════

function openRecDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(REC_DB, 2);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      const tx = e.target.transaction;
      let store;
      if (!db.objectStoreNames.contains(REC_STORE)) {
        store = db.createObjectStore(REC_STORE, { keyPath: 'id', autoIncrement: true });
      } else {
        store = tx.objectStore(REC_STORE);
      }
      if (!store.indexNames.contains('sceneId')) store.createIndex('sceneId', 'sceneId', { unique: false });
      if (e.oldVersion > 0 && e.oldVersion < 2) {
        // v1 → v2: stamp legacy recordings with takes-system defaults
        store.openCursor().onsuccess = ev => {
          const c = ev.target.result;
          if (!c) return;
          const v = c.value;
          if (v.sceneId === undefined) {
            c.update(Object.assign(v, {
              sceneId: 'legacy', sceneName: v.fname || '', takeNumber: 0,
              status: 'saved', wasPaused: false, duration: null, thumb: null,
            }));
          }
          c.continue();
        };
      }
    };
    r.onblocked = () => console.warn('[idb] recordings DB upgrade blocked by another tab');
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function saveRecToDB(blob, fname, mime, meta) {
  try {
    const db = await openRecDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(REC_STORE, 'readwrite');
      const m = meta || {};
      tx.objectStore(REC_STORE).add({
        blob, fname, mime, date: Date.now(), size: blob.size,
        sceneId: m.sceneId || 'legacy',
        sceneName: m.sceneName || (S.currentScriptName || ''),
        takeNumber: Number.isFinite(m.takeNumber) ? m.takeNumber : (S.takeNumber || 0),
        status: m.status || 'saved',
        wasPaused: !!m.wasPaused,
        duration: Number.isFinite(m.duration) ? m.duration : null,
        thumb: m.thumb || null,
      });
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  } catch (e) { console.warn('saveRecToDB failed', e); }
}

async function getRecsFromDB() {
  try {
    const db = await openRecDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(REC_STORE, 'readonly');
      const req = tx.objectStore(REC_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  } catch (e) { return []; }
}

async function deleteRecFromDB(id) {
  try {
    const db = await openRecDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(REC_STORE, 'readwrite');
      tx.objectStore(REC_STORE).delete(id);
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  } catch (e) { /* swallow */ }
}

// ── Recording display helpers ────────────────────────────────────────

function formatRecSize(b) {
  if (b < 1024)    return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(0) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
}

function formatRecDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function downloadRecToDevice(rec) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
  if (isIOS) {
    var shareMime  = rec.mime || 'video/mp4';
    var shareFname = rec.fname || ('citizentape-' + Date.now() + '.mp4');
    if (!shareMime.startsWith('video/mp4')) {
      shareMime  = 'video/mp4';
      shareFname = shareFname.replace(/\.\w+$/, '.mp4');
    }
    try {
      const file = new File([rec.blob], shareFname, { type: shareMime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        showToast(t('iosSaveVideoHint') || 'Tap "Save Video" to save to Photos', 4000);
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('[rec] iOS share:', e);
    }
    const u = URL.createObjectURL(new Blob([rec.blob], { type: shareMime }));
    const w = window.open(u, '_blank');
    if (w) {
      showToast('Tap the download arrow to save to Photos', 5000);
    } else {
      const a = document.createElement('a');
      a.href = u; a.download = shareFname; a.style.display = 'none';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      showToast('Long-press the video to save it', 4000);
    }
    setTimeout(() => URL.revokeObjectURL(u), 120000);
    return;
  }
  const u = URL.createObjectURL(rec.blob);
  const a = document.createElement('a');
  a.href = u; a.download = rec.fname; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}

async function shareOrDownloadRec(rec) {
  const file = new File([rec.blob], rec.fname, { type: rec.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ title: 'CitizenTape Audition', files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadRecToDevice(rec);
  showToast('Recording saved!');
}

function toggleRecPanel() {
  const p = document.getElementById('recPanel');
  p.classList.toggle('active');
}

async function renderRecordingsList() {
  const recs = await getRecsFromDB();
  const list = document.getElementById('recPanelList');
  const btn  = document.getElementById('recToggleBtn');
  const badge = document.getElementById('recBadge');
  const mobBtn   = document.getElementById('mobRecsBtn');
  const mobBadge = document.getElementById('mobRecBadge');
  if (!recs.length) {
    btn.style.display = 'none';
    if (mobBtn) mobBtn.style.display = 'none';
    list.innerHTML = '<div style="font-size:.72rem;color:var(--text-muted);text-align:center;padding:.5rem">' + t('noRecordingsYet') + '</div>';
    return;
  }
  btn.style.display = 'flex';
  badge.style.display = 'flex';
  badge.textContent = recs.length;
  if (mobBtn) {
    mobBtn.style.display = 'flex';
    if (mobBadge) { mobBadge.style.display = 'flex'; mobBadge.textContent = recs.length; }
  }
  list.innerHTML = recs.sort((a, b) => b.date - a.date).map(r =>
    `<div class="rec-item"><div class="rec-item-info"><div class="rec-item-name">${escHtml(r.fname)}</div><div class="rec-item-meta">${formatRecDate(r.date)} \u00b7 ${formatRecSize(r.size)}</div></div><button class="rec-item-btn" onclick="reShareRec(${r.id})" title="Share/Download"><svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9a3 3 0 1 0 0 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.88 2.88 0 0 0 5.84 0 2.88 2.88 0 0 0-2.92-2.88z"/></svg></button><button class="rec-item-btn del" onclick="deleteRec(${r.id})" title="Delete"><svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></div>`
  ).join('');
}

async function reShareRec(id) {
  const recs = await getRecsFromDB();
  const rec = recs.find(r => r.id === id);
  if (rec) shareOrDownloadRec(rec);
}

async function reDownloadRec(id) {
  const recs = await getRecsFromDB();
  const rec = recs.find(r => r.id === id);
  if (rec) downloadRecToDevice(rec);
}

async function deleteRec(id) {
  if (!confirm('Delete this recording?')) return;
  await deleteRecFromDB(id);
  renderRecordingsList();
  renderProfileRecordings();
  showToast('Recording deleted');
}

async function renderProfileRecordings() {
  const list = document.getElementById('profileRecList');
  if (!list) return;
  const recs = await getRecsFromDB();
  const wrap    = document.getElementById('profileRecordings');
  const countEl = document.getElementById('profileRecCount');
  if (!recs.length) { if (wrap) wrap.style.display = 'none'; return; }
  if (wrap) wrap.style.display = '';
  if (countEl) countEl.textContent = '(' + recs.length + ')';
  list.innerHTML = recs.sort((a, b) => b.date - a.date).map(r =>
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08)">'
    + '<div style="min-width:0;flex:1"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--white);font-size:.78rem">' + escHtml(r.fname) + '</div>'
    + '<div style="font-size:.68rem;color:var(--text-muted)">' + formatRecDate(r.date) + ' \u00b7 ' + formatRecSize(r.size) + '</div></div>'
    + '<div style="display:flex;gap:4px;flex-shrink:0">'
    + '<button onclick="reDownloadRec(' + r.id + ')" style="background:none;border:1px solid var(--border);color:var(--white);padding:4px 8px;font-size:.68rem;cursor:pointer" title="Save to device">Save</button>'
    + '<button onclick="reShareRec(' + r.id + ')" style="background:none;border:1px solid var(--border);color:var(--white);padding:4px 8px;font-size:.68rem;cursor:pointer" title="Share">Share</button>'
    + '<button onclick="deleteRec(' + r.id + ')" style="background:none;border:1px solid var(--border);color:#d92027;padding:4px 8px;font-size:.68rem;cursor:pointer" title="Delete">&times;</button>'
    + '</div></div>'
  ).join('');
}

// ══════════════════════════════════════════════════════════════════════
//  Generic KV store (IndexedDB: citizentape-script-db)
// ══════════════════════════════════════════════════════════════════════

function cwAwaitIndexedDbDelete(dbName) {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(); return; }
    try {
      if (dbName === CW_IDB_NAME && S._cwIdb) {
        try { S._cwIdb.close(); } catch (_e) { /* ignore */ }
        S._cwIdb = null;
      }
      const rq = indexedDB.deleteDatabase(dbName);
      rq.onsuccess = rq.onerror = rq.onblocked = () => resolve();
    } catch (_e) { resolve(); }
  });
}

function _cwOpenDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no-idb'));
  if (S._cwIdb) return Promise.resolve(S._cwIdb);
  return new Promise((res, rej) => {
    const r = indexedDB.open(CW_IDB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(CW_IDB_STORE)) db.createObjectStore(CW_IDB_STORE);
    };
    r.onsuccess = () => { S._cwIdb = r.result; res(S._cwIdb); };
    r.onerror   = () => rej(r.error);
  });
}

async function cwIdbGet(key) {
  try {
    const db = await _cwOpenDb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(CW_IDB_STORE, 'readonly');
      const rq = tx.objectStore(CW_IDB_STORE).get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror   = () => rej(rq.error);
    });
  } catch (_e) { return undefined; }
}

async function cwIdbSet(key, val) {
  try {
    const db = await _cwOpenDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(CW_IDB_STORE, 'readwrite');
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
      tx.objectStore(CW_IDB_STORE).put(val, key);
    });
  } catch (_e) { /* swallow */ }
}

async function cwIdbDel(key) {
  try {
    const db = await _cwOpenDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(CW_IDB_STORE, 'readwrite');
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
      tx.objectStore(CW_IDB_STORE).delete(key);
    });
  } catch (_e) { /* swallow */ }
}

// ══════════════════════════════════════════════════════════════════════
//  Script cache / snapshot persistence
// ══════════════════════════════════════════════════════════════════════

/**
 * Purge: deleteDatabase(CastwingDB) -> localStorage cw.lastPdf* -> deleteDatabase(citizentape-script-db).
 */
async function clearScriptCache() {
  try {
    localStorage.removeItem('cw.lastPdfHash');
    localStorage.removeItem('cw.lastPdfName');
  } catch (_e) { /* ignore */ }
  if (typeof indexedDB === 'undefined') return;
  try {
    await cwAwaitIndexedDbDelete(CW_LEGACY_IDB_NAME);
    await cwIdbDel('cw.snapshot.v1');
    console.log('[cache] cleared (kept script history)');
  } catch (_e) { /* ignore */ }
}

/** Hash stable du contenu (texte canonique) pour dedoublonner imports identiques */
function scriptContentHash(raw) {
  const canon = window.normalizeScreenplayWhitespace(String(raw || '').replace(/\u00A0/g, ' '));
  let h = 2166136261;
  for (let i = 0; i < canon.length; i++) h = Math.imul(h ^ canon.charCodeAt(i), 16777619);
  return 'h' + (h >>> 0).toString(36);
}

function schedulePersistScriptSnapshot() {
  /* disabled: no IndexedDB script persistence */
}

async function persistScriptSnapshotNow() {
  if (!S.pdfScript || !S.pdfScript.length || !S.scriptRawText) return;
  try {
    await cwIdbSet('cw.snapshot.v1', {
      scriptRawText:    S.scriptRawText,
      pdfScript:        S.pdfScript,
      currentScriptName: S.currentScriptName || 'Script',
      lockedVoiceLocale: S.lockedVoiceLocale || '',
      savedAt:          Date.now(),
    });
  } catch (_e) { console.warn('[snapshot] save failed', _e); }
}

async function clearPersistedScriptMemory() {
  await cwIdbDel('cw.snapshot.v1');
}

// ══════════════════════════════════════════════════════════════════════
//  Script History (persisted analyzed scripts)
// ══════════════════════════════════════════════════════════════════════

async function getScriptHistory() {
  return (await cwIdbGet(SCRIPT_HIST_KEY)) || [];
}

async function saveToScriptHistory() {
  if (!S.pdfScript || !S.pdfScript.length || !S.scriptRawText) return;
  try {
    var hist = await getScriptHistory();
    var name = S.currentScriptName || 'Script';
    // Dedupe by name -- replace existing entry
    hist = hist.filter(h => h.name !== name);
    var chars = window.getChars().map(c => c.char);
    var dialogueCount = S.pdfScript.filter(r => r && r.kind === LINE_TYPE.DIALOGUE).length;
    hist.unshift({
      name:            name,
      pdfScript:       S.pdfScript,
      scriptRawText:   S.scriptRawText,
      characters:      chars,
      dialogueCount:   dialogueCount,
      lockedVoiceLocale: S.lockedVoiceLocale || '',
      savedAt:         Date.now(),
    });
    if (hist.length > SCRIPT_HIST_MAX) hist = hist.slice(0, SCRIPT_HIST_MAX);
    await cwIdbSet(SCRIPT_HIST_KEY, hist);
    renderScriptHistory();
  } catch (_e) { console.warn('[history] save failed', _e); }
}

async function deleteFromScriptHistory(idx) {
  var hist = await getScriptHistory();
  hist.splice(idx, 1);
  await cwIdbSet(SCRIPT_HIST_KEY, hist);
  renderScriptHistory();
}

async function restoreFromScriptHistory(idx) {
  var hist = await getScriptHistory();
  var entry = hist[idx];
  if (!entry) return;
  S.pdfScript       = entry.pdfScript;
  S.scriptRawText   = entry.scriptRawText;
  S.currentScriptName = entry.name;
  if (entry.lockedVoiceLocale) {
    S.lockedVoiceLocale = entry.lockedVoiceLocale;
    applyLocaleVoices(entry.lockedVoiceLocale, false);
    initVoiceCountrySelect();
    initVoiceGrid();
  }
  window.syncPdfScriptDebugMirror();
  var ta = document.getElementById('scriptInput1');
  if (ta) ta.value = '';
  var detectedLang = entry.lockedVoiceLocale || detectTextLanguage(S.scriptRawText);
  window.finishPdfSetupUi(1, S.scriptRawText, entry.characters || [], detectedLang);
  showToast(entry.name + ' restored', 2500);
}

async function renderScriptHistory() {
  var sec  = document.getElementById('scriptHistorySection');
  var list = document.getElementById('scriptHistoryList');
  var sub  = document.getElementById('importSceneSub');
  if (!sec || !list) return;
  var hist = await getScriptHistory();
  if (!hist.length) { sec.style.display = 'none'; if (sub) sub.style.display = ''; return; }
  sec.style.display = 'block';
  if (sub) sub.style.display = 'none';
  list.innerHTML = hist.map(function (h, i) {
    var dateStr = new Date(h.savedAt).toLocaleDateString() + ' ' + new Date(h.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var chars = (h.characters || []).slice(0, 3).join(', ') + (h.characters && h.characters.length > 3 ? ' +' : '');
    return '<div class="sh-card" onclick="restoreFromScriptHistory(' + i + ')"><div class="sh-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg></div><div class="sh-info"><div class="sh-name">' + escHtml(h.name) + '</div><div class="sh-meta">' + (h.dialogueCount || '?') + ' lines \u00b7 ' + chars + ' \u00b7 ' + dateStr + '</div></div><button class="sh-del" onclick="event.stopPropagation();deleteFromScriptHistory(' + i + ')" title="Delete"><svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></div>';
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════
//  Script snapshot restore (app boot)
// ══════════════════════════════════════════════════════════════════════

/** Au chargement : restaure le dernier script et enchaine la repetition sans etape manuelle */
async function tryRestorePersistedScriptFromIdb() {
  if (typeof indexedDB === 'undefined') return false;
  try {
    try {
      if (localStorage.getItem(CW_RESTORE_SUPPRESS_KEY) === '1') return false;
    } catch (_e) { /* ignore */ }
    const snap = await cwIdbGet('cw.snapshot.v1');
    if (!snap || typeof snap.scriptRawText !== 'string' || !snap.scriptRawText.trim()) return false;
    if (!Array.isArray(snap.pdfScript) || !snap.pdfScript.length) return false;
    if (typeof snap.savedAt === 'number' && Date.now() - snap.savedAt > CW_SNAPSHOT_MAX_AGE_MS) return false;
    S.scriptRawText    = snap.scriptRawText;
    S.pdfScript        = snap.pdfScript;
    S.currentScriptName = snap.currentScriptName || 'Script';
    if (snap.lockedVoiceLocale && VOICE_LOCALES.some(l => l.id === snap.lockedVoiceLocale)) {
      S.lockedVoiceLocale = snap.lockedVoiceLocale;
    }
    window.syncPdfScriptDebugMirror();
    const norm = window.normalizeScreenplayWhitespace(S.scriptRawText);
    const ta = document.getElementById('scriptInput1');
    if (ta) ta.value = norm;
    const fname = document.getElementById('fileName1');
    if (fname) fname.textContent = S.currentScriptName;
    const uz = document.getElementById('uploadZone1');
    const uo = document.getElementById('uploadOk1');
    if (uz) uz.style.display = 'none';
    if (uo) uo.style.display = 'flex';
    const chars = window.getChars();
    if (!chars.length) return false;
    if (S.lockedVoiceLocale && VOICE_LOCALES.some(l => l.id === S.lockedVoiceLocale)) {
      applyLocaleVoices(S.lockedVoiceLocale, false);
      initVoiceCountrySelect();
      initVoiceGrid();
    }
    const detectedLang = S.lockedVoiceLocale || detectTextLanguage(S.scriptRawText);
    window.showScreen('importScene');
    window.initDragDrop('uploadZone1');
    window.finishPdfSetupUi(1, S.scriptRawText, chars.map(c => c.char), detectedLang);
    renderScriptHistory();
    return true;
  } catch (_e) { return false; }
}

// ── Expose to monolith via window.* ─────────────────────────────────
// Functions called from inline onclick handlers or from code still in index.html.
Object.assign(window, {
  // Recording panel
  saveRecToDB,
  getRecsFromDB,
  deleteRecFromDB,
  downloadRecToDevice,
  shareOrDownloadRec,
  toggleRecPanel,
  renderRecordingsList,
  reShareRec,
  reDownloadRec,
  deleteRec,
  renderProfileRecordings,
  // Generic KV
  cwIdbGet,
  cwIdbSet,
  cwIdbDel,
  cwAwaitIndexedDbDelete,
  // Script cache / snapshot
  clearScriptCache,
  scriptContentHash,
  schedulePersistScriptSnapshot,
  persistScriptSnapshotNow,
  clearPersistedScriptMemory,
  // Script history
  getScriptHistory,
  saveToScriptHistory,
  deleteFromScriptHistory,
  restoreFromScriptHistory,
  renderScriptHistory,
  // Boot restore
  tryRestorePersistedScriptFromIdb,
});

// ── Named exports ───────────────────────────────────────────────────
export {
  // Recording
  openRecDB,
  saveRecToDB,
  getRecsFromDB,
  deleteRecFromDB,
  formatRecSize,
  formatRecDate,
  downloadRecToDevice,
  shareOrDownloadRec,
  toggleRecPanel,
  renderRecordingsList,
  reShareRec,
  reDownloadRec,
  deleteRec,
  renderProfileRecordings,
  // Generic KV
  cwAwaitIndexedDbDelete,
  cwIdbGet,
  cwIdbSet,
  cwIdbDel,
  // Script cache / snapshot
  clearScriptCache,
  scriptContentHash,
  schedulePersistScriptSnapshot,
  persistScriptSnapshotNow,
  clearPersistedScriptMemory,
  // Script history
  getScriptHistory,
  saveToScriptHistory,
  deleteFromScriptHistory,
  restoreFromScriptHistory,
  renderScriptHistory,
  // Boot restore
  tryRestorePersistedScriptFromIdb,
  // Constants (may be needed by other modules)
  CW_IDB_NAME,
  CW_LEGACY_IDB_NAME,
  CW_RESTORE_SUPPRESS_KEY,
  CW_SNAPSHOT_MAX_AGE_MS,
};
