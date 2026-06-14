// ── Real-time speech-to-text (ElevenLabs Scribe v2 Realtime) ─────────
// Streams the actor's mic to ElevenLabs over a WebSocket and emits the
// running transcript (partial + committed) as normalized words. The
// session matcher (js/session.js) aligns those words to the script to
// drive the line-by-line highlight. The API key never reaches the
// client — the worker mints a single-use token (/api/stt-token).
//
// Graceful by design: any failure (token 402/401, WS error, no mic)
// just means startSttFollow returns false and the caller falls back to
// the VAD path. STT only runs during the actor's turn.

import { S } from './state.js';
import { track } from './utils.js';

const WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const STT_SAMPLE_RATE = 16000;

let _ws = null;
let _audioCtx = null;
let _srcNode = null;
let _procNode = null;
let _running = false;
let _capturing = false;   // only send audio during the actor's turn
let _onWords = null;
let _lang = '';

/** Float32 [-1,1] → 16-bit PCM little-endian → base64 (chunked, stack-safe). */
function floatToPcm16Base64(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function _normalizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // fold accents (FR/ES…)
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Start STT following. Returns true if the WS connected and audio
 * capture started, false on any failure (caller falls back to VAD).
 * onWords(words[], {committed}) fires on each transcript update.
 */
export async function startSttFollow({ lang, onWords } = {}) {
  if (_running) stopSttFollow();
  _onWords = onWords;
  _lang = (lang || '').split('-')[0] || '';

  const stream = window._cwMicStream;
  if (!stream || !stream.getAudioTracks().some(t => t.readyState === 'live')) return false;

  let token;
  try {
    const rsp = await fetch('/api/stt-token', { method: 'POST', credentials: 'same-origin' });
    const data = await rsp.json().catch(() => ({}));
    if (!rsp.ok || !data.ok || !data.token) { track('stt_token_fail', { status: rsp.status, error: data && data.error }); return false; }
    token = data.token;
  } catch (e) { track('stt_token_fail', { error: 'network' }); return false; }

  // Create the audio context FIRST so we know the real sample rate. Safari
  // often ignores a requested 16k and runs at 44.1/48k; we must tell
  // ElevenLabs the actual rate or it transcribes garbage. All of
  // 16000/22050/24000/44100/48000 are supported by Scribe.
  let realRate = STT_SAMPLE_RATE;
  try {
    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: STT_SAMPLE_RATE }); }
    catch (_e) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    _audioCtx = ctx;
    if (_audioCtx.state === 'suspended') await _audioCtx.resume();
    realRate = _audioCtx.sampleRate || STT_SAMPLE_RATE;
  } catch (e) { return false; }

  // model_id is optional; omit it so the default realtime model applies
  // (a wrong value rejects the connection).
  const params = new URLSearchParams({
    token,
    commit_strategy: 'vad',
    include_timestamps: 'false',
    sample_rate: String(realRate),
  });
  if (_lang) params.set('language_code', _lang);

  try {
    _ws = new WebSocket(WS_URL + '?' + params.toString());
  } catch (e) { try { _audioCtx.close(); } catch (_e) {} _audioCtx = null; return false; }

  const ready = await new Promise((resolve) => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    const to = setTimeout(() => done(false), 6000);
    _ws.onopen = () => { clearTimeout(to); done(true); };
    _ws.onerror = () => { clearTimeout(to); done(false); };
  });
  if (!ready) { try { _ws.close(); } catch (_e) {} _ws = null; try { _audioCtx.close(); } catch (_e) {} _audioCtx = null; return false; }

  _ws.onmessage = (ev) => {
    if (!_running) return;
    let msg; try { msg = JSON.parse(ev.data); } catch (_e) { return; }
    const type = msg.message_type;
    if (type === 'partial_transcript' || type === 'committed_transcript') {
      const words = _normalizeWords(msg.text);
      if (words.length && _onWords) _onWords(words, { committed: type === 'committed_transcript' });
    }
  };
  _ws.onclose = () => { if (_running) track('stt_ws_closed', {}); };

  try {
    _srcNode = _audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    // ScriptProcessor is deprecated but works everywhere incl. iOS Safari
    _procNode = _audioCtx.createScriptProcessor(4096, 1, 1);
    _procNode.onaudioprocess = (e) => {
      if (!_running || !_capturing || !_ws || _ws.readyState !== 1) return;
      const pcm = e.inputBuffer.getChannelData(0);
      try {
        _ws.send(JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: floatToPcm16Base64(pcm),
          sample_rate: realRate,
        }));
      } catch (_e) { /* socket mid-close */ }
    };
    _srcNode.connect(_procNode);
    _procNode.connect(_audioCtx.destination); // required for onaudioprocess to fire
  } catch (e) {
    stopSttFollow();
    return false;
  }

  _running = true;
  track('stt_start', { lang: _lang || 'auto', rate: realRate });
  return true;
}

/** Gate audio streaming to the actor's turn (avoids transcribing the
    AI's TTS bleeding through the speakers). WS stays open across turns. */
export function setSttCapturing(on) { _capturing = !!on && _running; }

export function stopSttFollow() {
  _running = false;
  _capturing = false;
  _onWords = null;
  if (_procNode) { try { _procNode.disconnect(); _procNode.onaudioprocess = null; } catch (_e) {} _procNode = null; }
  if (_srcNode) { try { _srcNode.disconnect(); } catch (_e) {} _srcNode = null; }
  if (_audioCtx) { try { _audioCtx.close(); } catch (_e) {} _audioCtx = null; }
  if (_ws) { try { _ws.close(); } catch (_e) {} _ws = null; }
}

export function isSttRunning() { return _running; }
