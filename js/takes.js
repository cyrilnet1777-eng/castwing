// ── Takes system ─────────────────────────────────────────────────────
// A "scene" is one imported script (identified by content hash); each
// recording of that scene is a numbered take. Take metadata is stored
// alongside the recording blob in IndexedDB (see idb.js saveRecToDB).

import { S } from './state.js';
import { track } from './utils.js';
import { getRecsFromDB, scriptContentHash } from './idb.js';

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
