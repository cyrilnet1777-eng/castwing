// ── Takes system ─────────────────────────────────────────────────────
// A "scene" is one imported script (identified by content hash); each
// recording of that scene is a numbered take. Take metadata is stored
// alongside the recording blob in IndexedDB (see idb.js saveRecToDB).

import { S } from './state.js';
import { track, escHtml, showToast } from './utils.js';
import { t } from './i18n.js';
import { getRecsFromDB, scriptContentHash, deleteRecFromDB, formatRecDate, formatRecSize } from './idb.js';

// ── Scene identity ───────────────────────────────────────────────────

export function getSceneId() {
  try {
    if (S.scriptRawText && S.scriptRawText.trim()) return scriptContentHash(S.scriptRawText);
  } catch (_e) { /* fall through */ }
  // No raw text (e.g. manual lines): fall back to a name-based id
  const name = String(S.currentScriptName || 'scene');
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return 'n' + (h >>> 0).toString(36);
}

// ── Take counter ─────────────────────────────────────────────────────

/** Resume take numbering from previously saved takes of this scene. */
export async function initTakeCounter() {
  try {
    const sceneId = getSceneId();
    const recs = await getRecsFromDB();
    let maxTake = 0;
    for (const r of recs) {
      if (r && r.sceneId === sceneId && Number.isFinite(r.takeNumber) && r.takeNumber > maxTake) {
        maxTake = r.takeNumber;
      }
    }
    if (maxTake > (S.takeNumber || 0)) S.takeNumber = maxTake;
  } catch (_e) { /* keep current counter */ }
}

/** Start a new take: bump the counter and snapshot take metadata on S. */
export function beginTake() {
  S.takeNumber = (S.takeNumber || 0) + 1;
  S.currentTake = {
    sceneId: getSceneId(),
    sceneName: S.currentScriptName || '',
    takeNumber: S.takeNumber,
    startedAt: Date.now(),
    pausedAccumMs: 0,
    pauseStartedAt: null,
    wasPaused: false,
  };
  track('take_begin', { take_number: S.takeNumber, mode: S.sessionMode });
  if (typeof window.updateTakeInfo === 'function') window.updateTakeInfo();
}

/** Wall-clock take duration excluding paused time, in ms. */
export function takeDurationMs() {
  const tk = S.currentTake;
  if (!tk || !tk.startedAt) return 0;
  let paused = tk.pausedAccumMs || 0;
  if (tk.pauseStartedAt) paused += Date.now() - tk.pauseStartedAt;
  return Math.max(0, Date.now() - tk.startedAt - paused);
}

/** Called when the session pauses/resumes to keep duration accurate. */
export function markTakePaused(paused) {
  const tk = S.currentTake;
  if (!tk) return;
  if (paused) {
    tk.wasPaused = true;
    if (!tk.pauseStartedAt) tk.pauseStartedAt = Date.now();
  } else if (tk.pauseStartedAt) {
    tk.pausedAccumMs = (tk.pausedAccumMs || 0) + (Date.now() - tk.pauseStartedAt);
    tk.pauseStartedAt = null;
  }
}

// ── "Mes Takes" screen ───────────────────────────────────────────────

function _fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export async function renderMyTakes() {
  const list = document.getElementById('myTakesList');
  if (!list) return;
  const recs = await getRecsFromDB();
  track('takes_list_view', { count: recs.length });
  list.innerHTML = '';
  if (!recs.length) {
    list.innerHTML = '<div class="mt-empty" id="myTakesEmpty"></div>';
    const e = list.querySelector('.mt-empty');
    if (e) e.textContent = t('myTakesEmpty');
    return;
  }
  // Group by scene, newest scene first (legacy recordings grouped last)
  const groups = new Map();
  for (const r of recs.sort((a, b) => b.date - a.date)) {
    const key = r.sceneId || 'legacy';
    if (!groups.has(key)) groups.set(key, { name: r.sceneId === 'legacy' ? t('legacyRecsGroup') : (r.sceneName || t('legacyRecsGroup')), recs: [] });
    groups.get(key).recs.push(r);
  }
  for (const [, g] of groups) {
    const header = document.createElement('div');
    header.className = 'mt-scene-header';
    header.textContent = g.name.replace(/\.(pdf|fdx|txt)$/i, '');
    list.appendChild(header);
    for (const r of g.recs) {
      const card = document.createElement('div');
      card.className = 'mt-card';
      const thumbHtml = r.thumb
        ? `<img class="mt-thumb" src="${r.thumb}" alt="">`
        : '<div class="mt-thumb mt-thumb-empty">🎬</div>';
      const takeLabel = r.takeNumber > 0 ? (t('takeLabel') + ' ' + r.takeNumber) : (r.fname || '');
      const durStr = _fmtDuration(r.duration);
      card.innerHTML = thumbHtml +
        '<div class="mt-meta">' +
        '<div class="mt-title">' + escHtml(takeLabel) + '</div>' +
        '<div class="mt-sub">' + (durStr ? escHtml(durStr) + ' · ' : '') + escHtml(formatRecSize(r.size || 0)) + ' · ' + escHtml(formatRecDate(r.date)) + '</div>' +
        '</div>' +
        '<div class="mt-actions">' +
        `<button class="mt-btn" onclick="reShareRec(${r.id})" title="Share">📤</button>` +
        `<button class="mt-btn" onclick="reDownloadRec(${r.id})" title="Download">⬇️</button>` +
        `<button class="mt-btn mt-btn-danger" onclick="deleteTake(${r.id})" title="Delete">🗑️</button>` +
        '</div>';
      list.appendChild(card);
    }
  }
}

export async function deleteTake(id) {
  if (!confirm(t('deleteTakeConfirm'))) return;
  track('take_delete', { rec_id: id });
  await deleteRecFromDB(id);
  showToast(t('takeDeleted'));
  await renderMyTakes();
  if (typeof window.renderRecordingsList === 'function') window.renderRecordingsList();
  if (typeof window.renderProfileRecordings === 'function') window.renderProfileRecordings();
}

export function goMyTakes() {
  void renderMyTakes();
  window.showScreen('myTakes');
}
