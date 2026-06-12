// ── Post-take review ─────────────────────────────────────────────────
// After a take stops, NOTHING is saved automatically. The blob is held
// in memory and the actor decides: watch, save, redo, or discard.
// Version A (clean take): big Watch + Save, small Redo.
// Version B (interrupted take, was paused): big Redo, small Watch/Save.

import { S } from './state.js';
import { showToast, track } from './utils.js';
import { t } from './i18n.js';
import { saveRecToDB, renderRecordingsList } from './idb.js';
import { getSceneId } from './takes.js';

let _pending = null;   // { blob, fname, mime, meta } — nulled on every exit for GC
let _playerUrl = null;

function _revokePlayer() {
  const v = document.getElementById('trvPlayer');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.style.display = 'none'; }
  if (_playerUrl) { try { URL.revokeObjectURL(_playerUrl); } catch (_e) {} _playerUrl = null; }
}

function _close() {
  _revokePlayer();
  _pending = null;
  const m = document.getElementById('takeReviewModal');
  if (m) m.classList.remove('active');
}

export function showTakeReviewModal(blob, meta) {
  const m = document.getElementById('takeReviewModal');
  if (!m) { // fallback: never lose footage if the modal is missing
    saveRecToDB(blob, meta.fname, meta.mime, meta).then(() => renderRecordingsList()).catch(() => {});
    return;
  }
  _pending = { blob, fname: meta.fname, mime: meta.mime, meta };
  const interrupted = !!meta.wasPaused;
  const title = document.getElementById('trvTitle');
  const sub = document.getElementById('trvSub');
  if (title) title.textContent = interrupted ? t('trvTitleInterrupted') : t('trvTitleDone', { n: meta.takeNumber || S.takeNumber });
  if (sub) {
    const sizeStr = blob.size < 1048576 ? (blob.size / 1024).toFixed(0) + ' KB' : (blob.size / 1048576).toFixed(1) + ' MB';
    const dur = meta.duration ? Math.round(meta.duration / 1000) : 0;
    sub.textContent = (dur ? Math.floor(dur / 60) + ':' + String(dur % 60).padStart(2, '0') + ' · ' : '') + sizeStr;
  }
  document.getElementById('trvBtnsA').style.display = interrupted ? 'none' : '';
  document.getElementById('trvBtnsB').style.display = interrupted ? '' : 'none';
  document.getElementById('trvSavedPhase').style.display = 'none';
  document.getElementById('trvReviewPhase').style.display = '';
  _revokePlayer();
  m.classList.add('active');
}

export function trvWatch() {
  if (!_pending) return;
  track('take_review_action', { action: 'watch' });
  const v = document.getElementById('trvPlayer');
  if (!v) return;
  _revokePlayer();
  _playerUrl = URL.createObjectURL(_pending.blob);
  v.src = _playerUrl;
  v.style.display = '';
  try { v.play().catch(() => {}); } catch (_e) {}
}

export async function trvSave() {
  if (!_pending) return;
  track('take_review_action', { action: 'save' });
  const p = _pending;
  try {
    await saveRecToDB(p.blob, p.fname, p.mime, { ...p.meta, status: 'saved' });
    track('take_saved', { take_number: p.meta.takeNumber, size_mb: Math.round(p.blob.size / 1048576 * 10) / 10, mime: p.mime });
    track('recording_save', { target: 'idb', take_number: p.meta.takeNumber });
    renderRecordingsList();
  } catch (e) {
    console.error('[take-review] save failed:', e);
    showToast(t('trvSaveFailed'), 4000);
    return;
  }
  _revokePlayer();
  _pending = null;
  // Post-save choice: new take or finish
  document.getElementById('trvReviewPhase').style.display = 'none';
  document.getElementById('trvSavedPhase').style.display = '';
}

export function trvRedo() {
  if (!confirm(t('trvRedoConfirm'))) return;
  track('take_review_action', { action: 'redo' });
  track('recording_redo', { take_number: S.takeNumber });
  _close();
  // Streams are still alive (endTake keeps them) — straight into a new take
  if (typeof window.restartTake === 'function') window.restartTake();
}

export function trvDiscard() {
  if (!confirm(t('trvDeleteConfirm'))) return;
  track('take_review_action', { action: 'delete' });
  track('recording_delete', { take_number: S.takeNumber, from: 'review' });
  _close();
  if (typeof window.teardownSession === 'function') window.teardownSession();
  window.showScreen('home');
}

export function trvNewTake() {
  _close();
  if (typeof window.restartTake === 'function') window.restartTake();
}

export function trvFinish() {
  _close();
  if (typeof window.teardownSession === 'function') window.teardownSession();
  if (typeof window.renderMyTakes === 'function') {
    window.renderMyTakes();
    window.showScreen('myTakes');
  } else {
    window.showScreen('home');
  }
}
