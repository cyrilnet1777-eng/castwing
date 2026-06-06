// ── Recording Module ─────────────────────────────────────────────────
// Extracted from index.html lines ~6374-6672.
// Canvas-based video capture, AudioContext mixing (mic + remote + TTS),
// MediaRecorder with codec selection, pause/resume, end-take modal, and
// post-recording save/share/delete flows.

import { S } from './state.js';
import { showToast, gaEvent, escHtml } from './utils.js';
import { t } from './i18n.js';
import {
  saveRecToDB, getRecsFromDB, deleteRecFromDB,
  formatRecDate, formatRecSize,
  downloadRecToDevice, renderRecordingsList, renderProfileRecordings,
} from './idb.js';
import { canRecord } from './plan-timer.js';
import { openAuthModal } from './auth.js';

// ── Module-level state (not on S — internal to recording) ───────────
let _recPaused    = false;
let _recCanvas    = null;
let _recCanvasCtx = null;
let _recDrawRaf   = null;
let _lastRecBlob  = null;
let _lastRecFname = '';
let _lastRecMime  = '';

// ══════════════════════════════════════════════════════════════════════
//  End-Take Modal
// ══════════════════════════════════════════════════════════════════════

function showEndTakeModal() {
  const m = document.getElementById('endTakeModal');
  if (!m) return;
  document.getElementById('etmConfirmPhase').style.display = '';
  document.getElementById('etmSavedPhase').style.display = 'none';
  m.classList.add('active');
}

function hideEndTakeModal() {
  const m = document.getElementById('endTakeModal');
  if (m) m.classList.remove('active');
  var home = document.getElementById('home');
  if (home) home.style.pointerEvents = '';
}

function confirmEndTake() {
  gaEvent('end_take', { mode: S.sessionMode });
  document.getElementById('etmConfirmPhase').style.display = 'none';
  // endSession lives in the monolith — late-bind via window
  if (typeof window.endSession === 'function') window.endSession();
}

// ══════════════════════════════════════════════════════════════════════
//  Recording-Saved Modal & Post-recording Actions
// ══════════════════════════════════════════════════════════════════════

function showRecSavedModal(blob, fname, mime) {
  _lastRecBlob = blob;
  _lastRecFname = fname;
  _lastRecMime = mime;
  const m = document.getElementById('endTakeModal');
  const info = document.getElementById('etmRecInfo');
  if (!m) return;
  document.getElementById('etmConfirmPhase').style.display = 'none';
  const phase = document.getElementById('etmSavedPhase');
  phase.style.display = '';
  var sizeStr = blob.size < 1048576
    ? (blob.size / 1024).toFixed(0) + ' KB'
    : (blob.size / 1048576).toFixed(1) + ' MB';
  var ext = fname.split('.').pop().toUpperCase();
  info.innerHTML =
    '<div class="etm-info-row"><span>File</span><span class="etm-info-val">' + escHtml(fname) + '</span></div>' +
    '<div class="etm-info-row"><span>Format</span><span class="etm-info-val">' + ext + '</span></div>' +
    '<div class="etm-info-row"><span>Size</span><span class="etm-info-val">' + sizeStr + '</span></div>';
  // Disable home screen touch capture on iOS Safari
  var home = document.getElementById('home');
  if (home) home.style.pointerEvents = 'none';
  m.classList.add('active');
}

function dismissRecModal() {
  _lastRecBlob = null;
  _lastRecFname = '';
  _lastRecMime = '';
  var home = document.getElementById('home');
  if (home) home.style.pointerEvents = '';
  hideEndTakeModal();
  if (typeof window.showScreen === 'function') window.showScreen('home');
}

async function etmSaveToDevice() {
  if (!_lastRecBlob) return;
  await downloadRecToDevice({ blob: _lastRecBlob, fname: _lastRecFname, mime: _lastRecMime });
  showToast('Saving to device\u2026', 3000);
}

async function etmShareRec() {
  if (!_lastRecBlob) return;
  var sMime = _lastRecMime || 'video/mp4';
  var sFname = _lastRecFname || ('citizentape-' + Date.now() + '.mp4');
  var _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
  if (_isIOS && !sMime.startsWith('video/mp4')) {
    sMime = 'video/mp4';
    sFname = sFname.replace(/\.\w+$/, '.mp4');
  }
  try {
    var file = new File([_lastRecBlob], sFname, { type: sMime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ title: 'CitizenTape Take', files: [file] });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('[rec] share:', e);
  }
  await downloadRecToDevice({ blob: _lastRecBlob, fname: _lastRecFname, mime: _lastRecMime });
  showToast('Saved to device (share not available)', 3000);
}

async function etmDeleteRec() {
  if (!confirm('Delete this recording?')) return;
  var recs = await getRecsFromDB();
  var last = recs.sort((a, b) => b.date - a.date)[0];
  if (last) await deleteRecFromDB(last.id);
  _lastRecBlob = null;
  _lastRecFname = '';
  _lastRecMime = '';
  renderRecordingsList();
  renderProfileRecordings();
  showToast('Recording deleted');
  var home = document.getElementById('home');
  if (home) home.style.pointerEvents = '';
  hideEndTakeModal();
  if (typeof window.showScreen === 'function') window.showScreen('home');
}

// ══════════════════════════════════════════════════════════════════════
//  Toggle / Pause / Resume
// ══════════════════════════════════════════════════════════════════════

function toggleRecording() {
  if (!S.isRecording) { startRecording(); return; }
  if (_recPaused) { resumeRecording(); return; }
  pauseRecording();
}

function pauseRecording() {
  if (!S.isRecording || !S.mediaRecorder) return;
  _recPaused = true;
  if (S.mediaRecorder.state === 'recording') try { S.mediaRecorder.pause(); } catch (e) {}
  // Update UI: show paused state + confirm bar
  var btnRec = document.getElementById('btnRec');
  if (btnRec) btnRec.classList.add('rec-paused');
  var mobRec = document.getElementById('mobRecBtn');
  if (mobRec) mobRec.classList.add('rec-paused');
  var ri = document.getElementById('recIndicator');
  if (ri) ri.style.display = 'none';
  _showRecPauseBar(true);
}

function resumeRecording() {
  if (!S.isRecording || !S.mediaRecorder) return;
  _recPaused = false;
  if (S.mediaRecorder.state === 'paused') try { S.mediaRecorder.resume(); } catch (e) {}
  var btnRec = document.getElementById('btnRec');
  if (btnRec) btnRec.classList.remove('rec-paused');
  var mobRec = document.getElementById('mobRecBtn');
  if (mobRec) mobRec.classList.remove('rec-paused');
  var ri = document.getElementById('recIndicator');
  if (ri) ri.style.display = 'flex';
  _showRecPauseBar(false);
  showToast('Recording resumed');
}

function _showRecPauseBar(show) {
  var bar = document.getElementById('recPauseBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'recPauseBar';
    bar.style.cssText =
      'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);' +
      'display:flex;gap:8px;z-index:10002;background:rgba(0,0,0,.85);' +
      'border:1px solid rgba(255,255,255,.2);border-radius:12px;' +
      'padding:6px 12px;align-items:center;font-family:DM Sans,sans-serif;font-size:.82rem';
    bar.innerHTML =
      '<span style="color:#f59e0b;font-weight:600">Paused</span>' +
      '<button onclick="resumeRecording()" style="background:#22c55e;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:.78rem;font-weight:600;cursor:pointer">Resume</button>' +
      '<button onclick="stopRecording()" style="background:#c1121f;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:.78rem;font-weight:600;cursor:pointer">End Take</button>';
    document.body.appendChild(bar);
  }
  bar.style.display = show ? 'flex' : 'none';
}

// ══════════════════════════════════════════════════════════════════════
//  Canvas draw loop (survives camera switches)
// ══════════════════════════════════════════════════════════════════════

function _startRecCanvasDraw() {
  if (_recDrawRaf) return;
  var cw = _recCanvas.width, ch = _recCanvas.height;
  function draw() {
    if (!_recCanvas || !S.isRecording) { _recDrawRaf = null; return; }
    var vid = document.getElementById('localVideo');
    if (vid && vid.videoWidth > 0) {
      // Scale video to fit locked canvas (letterbox/pillarbox on rotation)
      var vw = vid.videoWidth, vh = vid.videoHeight;
      var scale = Math.min(cw / vw, ch / vh);
      var dw = vw * scale, dh = vh * scale;
      var dx = (cw - dw) / 2, dy = (ch - dh) / 2;
      if (dx > 0 || dy > 0) _recCanvasCtx.clearRect(0, 0, cw, ch);
      _recCanvasCtx.drawImage(vid, dx, dy, dw, dh);
    }
    _recDrawRaf = requestAnimationFrame(draw);
  }
  _recDrawRaf = requestAnimationFrame(draw);
}

function _stopRecCanvasDraw() {
  if (_recDrawRaf) { cancelAnimationFrame(_recDrawRaf); _recDrawRaf = null; }
  _recCanvas = null;
  _recCanvasCtx = null;
}

// ══════════════════════════════════════════════════════════════════════
//  Build combined recording stream (canvas video + mixed audio)
// ══════════════════════════════════════════════════════════════════════

function _buildRecordingStream() {
  var combined = new MediaStream();
  // Use canvas capture for video (survives camera switches without stopping MediaRecorder)
  var vid = document.getElementById('localVideo');
  _recCanvas = document.createElement('canvas');
  _recCanvas.width = vid && vid.videoWidth > 0 ? vid.videoWidth : 1280;
  _recCanvas.height = vid && vid.videoHeight > 0 ? vid.videoHeight : 720;
  _recCanvasCtx = _recCanvas.getContext('2d');
  var canvasStream = _recCanvas.captureStream(30);
  canvasStream.getVideoTracks().forEach(function (t) { combined.addTrack(t); });

  var remoteVid = document.getElementById('remoteVideo');
  var remoteStream = remoteVid && remoteVid.srcObject;
  try {
    S._recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S._recDest = S._recAudioCtx.createMediaStreamDestination();
    S._recMicGain = S._recAudioCtx.createGain();
    S._recMicGain.gain.value = 1.0;
    // Mic audio (routed through gain node so we can mute during TTS to prevent echo)
    if (S.localStream && S.localStream.getAudioTracks().length > 0) {
      S._recMicSource = S._recAudioCtx.createMediaStreamSource(S.localStream);
      S._recMicSource.connect(S._recMicGain);
      S._recMicGain.connect(S._recDest);
    }
    // Remote audio (partner's voice for actor, actor's voice for partner)
    if (remoteStream && remoteStream.getAudioTracks().length > 0) {
      var remoteSource = S._recAudioCtx.createMediaStreamSource(remoteStream);
      remoteSource.connect(S._recDest);
    }
    // AI audio will be fed via playTtsIntoRecording() each time TTS plays
    S._recDest.stream.getAudioTracks().forEach(function (t) { combined.addTrack(t); });
  } catch (e) {
    console.warn('[rec] audio mix failed, mic only:', e.message);
    if (S.localStream) S.localStream.getAudioTracks().forEach(function (t) { combined.addTrack(t); });
  }
  return combined;
}

// ══════════════════════════════════════════════════════════════════════
//  MediaRecorder factory (codec selection, auto-restart on glitch)
// ══════════════════════════════════════════════════════════════════════

function _makeMediaRecorder(stream) {
  var _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
  var recMime = 'video/webm;codecs=vp9';
  if (_isIOS || MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2'))
    recMime = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
  else if (MediaRecorder.isTypeSupported('video/mp4'))
    recMime = 'video/mp4';
  else if (!MediaRecorder.isTypeSupported(recMime))
    recMime = 'video/webm';

  var isMP4 = recMime.startsWith('video/mp4');
  var recOpts = { mimeType: recMime };
  if (isMP4) recOpts.videoBitsPerSecond = 2500000;

  var rec = new MediaRecorder(stream, recOpts);
  rec.ondataavailable = function (e) {
    if (e.data.size > 0) S.recordedChunks.push(e.data);
  };
  rec.onstop = async function () {
    if (!S._recStopIntentional && S.isRecording && S._recStream) {
      // Accidental stop (camera switch, track glitch) — restart recorder
      console.warn('[rec] unexpected onstop, restarting MediaRecorder');
      try {
        S.mediaRecorder = _makeMediaRecorder(S._recStream);
        S.mediaRecorder.start(2000);
        return;
      } catch (e) { console.error('[rec] restart failed:', e); }
    }
    _closeRecAudioCtx();
    try {
      var ext = isMP4 ? 'mp4' : 'webm';
      var mime = isMP4 ? 'video/mp4' : 'video/webm';
      var blob = new Blob(S.recordedChunks, { type: mime });
      var fname = 'citizentape-' + Date.now() + '.' + ext;
      await saveRecToDB(blob, fname, mime);
      renderRecordingsList();
      showRecSavedModal(blob, fname, mime);
    } catch (e) {
      console.error('[rec] onstop error:', e);
      showToast('Recording saved!', 3000);
    }
  };
  return rec;
}

// ══════════════════════════════════════════════════════════════════════
//  Start / Stop
// ══════════════════════════════════════════════════════════════════════

function startRecording() {
  if (!canRecord()) { showToast(t('partnerGateTitle')); openAuthModal(); return; }
  if (!S.localStream) { showToast('No video stream'); return; }
  S.recordedChunks = [];
  S._recStopIntentional = false;
  var recStream = _buildRecordingStream();
  S._recStream = recStream;
  try {
    S.mediaRecorder = _makeMediaRecorder(recStream);
    S.mediaRecorder.start(2000);
    _startRecCanvasDraw();
    S.isRecording = true;
    document.getElementById('btnRec').classList.add('recording');
    document.getElementById('btnRec').innerHTML = '<span class="rec-dot"></span>';
    const _ri = document.getElementById('recIndicator');
    if (_ri) _ri.style.display = 'flex';
    const _mr = document.getElementById('mobRecBtn');
    if (_mr) _mr.classList.add('recording');
    const _qb = document.getElementById('quitBtn');
    if (_qb) { _qb.classList.add('has-recording'); _qb.textContent = 'Save & Exit'; }
    showToast('Recording\u2026');
  } catch (e) {
    showToast('Recording error');
  }
}

function _closeRecAudioCtx() {
  _stopRecCanvasDraw();
  if (S._recAudioCtx) { try { S._recAudioCtx.close(); } catch (e) {} S._recAudioCtx = null; }
  S._recDest = null;
  S._recMicSource = null;
  S._recMicGain = null;
  S._recStream = null;
}

function stopRecording() {
  _recPaused = false;
  S._recStopIntentional = true;
  _showRecPauseBar(false);
  if (S.mediaRecorder && S.mediaRecorder.state === 'paused') {
    try { S.mediaRecorder.resume(); } catch (_e) {}
  }
  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') S.mediaRecorder.stop();
  S.isRecording = false;
  document.getElementById('btnRec').classList.remove('recording');
  document.getElementById('btnRec').classList.remove('rec-paused');
  document.getElementById('btnRec').innerHTML = '<span class="rec-dot"></span>';
  const _ri = document.getElementById('recIndicator');
  if (_ri) _ri.style.display = 'none';
  const _mr = document.getElementById('mobRecBtn');
  if (_mr) { _mr.classList.remove('recording'); _mr.classList.remove('rec-paused'); }
  const _qb = document.getElementById('quitBtn');
  if (_qb) { _qb.classList.remove('has-recording'); _qb.textContent = 'Done'; }
}

// ══════════════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════════════

export {
  // End-take modal
  showEndTakeModal,
  hideEndTakeModal,
  confirmEndTake,
  // Recording-saved modal & actions
  showRecSavedModal,
  dismissRecModal,
  etmSaveToDevice,
  etmShareRec,
  etmDeleteRec,
  // Toggle / pause / resume
  toggleRecording,
  pauseRecording,
  resumeRecording,
  // Start / stop
  startRecording,
  stopRecording,
  // Internal helpers (exported for use by endSession in monolith)
  _closeRecAudioCtx,
  _buildRecordingStream,
  _makeMediaRecorder,
  _showRecPauseBar,
};
