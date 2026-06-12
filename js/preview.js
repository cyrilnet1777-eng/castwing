// ── Camera preview screen ────────────────────────────────────────────
// Shown between scene config and the session: live camera framing,
// front/back flip, mic level meter, and the START button that launches
// the 5-second countdown. The actor checks framing/light/background
// BEFORE any recording starts.

import { S } from './state.js';
import { track } from './utils.js';
import { unlockAudio } from './sfx.js';

let _micMeterRaf = null;
let _micAudioCtx = null;
let _resolveDecision = null;

function _startMicMeter() {
  _stopMicMeter();
  const bar = document.getElementById('previewMicBar');
  const stream = window._cwMicStream || S.localStream;
  if (!bar || !stream || !stream.getAudioTracks().length) return;
  try {
    _micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = _micAudioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const analyser = _micAudioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      if (!_micAudioCtx) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / buf.length);
      bar.style.width = Math.min(100, Math.round(rms * 320)) + '%';
      _micMeterRaf = requestAnimationFrame(loop);
    };
    _micMeterRaf = requestAnimationFrame(loop);
  } catch (_e) { /* meter is cosmetic */ }
}

function _stopMicMeter() {
  if (_micMeterRaf) { cancelAnimationFrame(_micMeterRaf); _micMeterRaf = null; }
  if (_micAudioCtx) { try { _micAudioCtx.close(); } catch (_e) {} _micAudioCtx = null; }
}

function _bindPreviewVideo() {
  const v = document.getElementById('previewVideo');
  if (!v) return;
  const hasVideo = S.localStream && S.localStream.getVideoTracks().some(t => t.readyState === 'live' && t.enabled);
  v.srcObject = hasVideo ? S.localStream : null;
  v.muted = true;
  v.playsInline = true;
  // Mirror the front camera; scale up to match what the recording will
  // capture when the iPad centered crop is active
  const crop = (S.recCropFactor > 0 && S.recCropFactor < 1) ? S.recCropFactor : 1;
  v.style.transform = (S.currentFacingMode === 'user' ? 'scaleX(-1) ' : '') + (crop < 1 ? `scale(${(1 / crop).toFixed(3)})` : '');
  const off = document.getElementById('previewCamOff');
  if (off) off.style.display = hasVideo ? 'none' : 'flex';
  if (hasVideo) { try { v.play().catch(() => {}); } catch (_e) {} }
}

/**
 * Show the camera preview screen. Resolves true when the user taps
 * START, false when they cancel. The session stream must already be
 * acquired (ensureSessionStream) before calling this.
 */
export function openCameraPreview({ flow }) {
  return new Promise(resolve => {
    _resolveDecision = resolve;
    S._previewFlow = flow || 'ai';
    track('camera_preview_view', { flow: S._previewFlow });
    window.showScreen('cameraPreview');
    _bindPreviewVideo();
    _startMicMeter();
  });
}

export function previewStartTake() {
  unlockAudio(); // tap gesture — unlock audio for countdown beeps + TTS
  _stopMicMeter();
  const r = _resolveDecision;
  _resolveDecision = null;
  if (r) r(true);
}

export async function previewFlipCamera() {
  track('preview_flip_camera');
  if (typeof window.toggleCam === 'function') await window.toggleCam();
  _bindPreviewVideo();
}

export function cancelCameraPreview() {
  track('preview_cancel', { flow: S._previewFlow });
  _stopMicMeter();
  const r = _resolveDecision;
  _resolveDecision = null;
  if (r) r(false);
}
