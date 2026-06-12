// ── WebM → MP4 transcoding (ffmpeg.wasm) ─────────────────────────────
// Casting directors expect H.264/AAC .mp4. Safari and modern Chrome
// record MP4 natively; Firefox and older Chromium produce WebM, which
// gets transcoded lazily HERE — only at download/share time.
//
// Uses the SINGLE-THREADED @ffmpeg/core (no SharedArrayBuffer), because
// enabling COOP/COEP site-wide would break the Google OAuth popup, the
// PeerJS CDN script and GA. Slower but safe. All CDN files are loaded
// through blob: URLs (workers can't be instantiated cross-origin).

import { track } from './utils.js';

const FFMPEG_VERSION = '0.12.10';
const UTIL_VERSION = '0.12.1';
const CORE_VERSION = '0.12.6';
const CDN = 'https://cdn.jsdelivr.net/npm';

let _ffmpeg = null;
let _loading = null;

export async function ensureFfmpeg() {
  if (_ffmpeg) return _ffmpeg;
  if (_loading) return _loading;
  _loading = (async () => {
    const { FFmpeg } = await import(`${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/+esm`);
    const { toBlobURL } = await import(`${CDN}/@ffmpeg/util@${UTIL_VERSION}/+esm`);
    const base = `${CDN}/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
    const ff = new FFmpeg();
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      classWorkerURL: await toBlobURL(`${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/worker.js`, 'text/javascript'),
    });
    _ffmpeg = ff;
    _loading = null;
    return ff;
  })();
  return _loading;
}

/**
 * Transcode a WebM blob to H.264 Main + AAC-LC 48kHz stereo MP4
 * (5 Mbps, 30 fps, +faststart). onProgress receives 0..1.
 */
export async function transcodeToMp4(blob, onProgress) {
  const t0 = Date.now();
  track('export_mp4', { phase: 'start', size_mb: Math.round(blob.size / 1048576 * 10) / 10 });
  try {
    const ff = await ensureFfmpeg();
    const { fetchFile } = await import(`${CDN}/@ffmpeg/util@${UTIL_VERSION}/+esm`);
    const progressHandler = ({ progress }) => { if (onProgress) onProgress(Math.max(0, Math.min(1, progress))); };
    ff.on('progress', progressHandler);
    try {
      await ff.writeFile('in.webm', await fetchFile(blob));
      await ff.exec([
        '-i', 'in.webm',
        '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0',
        '-pix_fmt', 'yuv420p', '-b:v', '5M', '-maxrate', '5M', '-bufsize', '10M', '-r', '30',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
        'out.mp4',
      ]);
      const data = await ff.readFile('out.mp4');
      const out = new Blob([data.buffer], { type: 'video/mp4' });
      track('export_mp4', { phase: 'done', ms: Date.now() - t0, size_mb: Math.round(out.size / 1048576 * 10) / 10 });
      return out;
    } finally {
      ff.off('progress', progressHandler);
      try { await ff.deleteFile('in.webm'); } catch (_e) {}
      try { await ff.deleteFile('out.mp4'); } catch (_e) {}
    }
  } catch (e) {
    track('export_mp4', { phase: 'fail', ms: Date.now() - t0, reason: String(e && e.message || e).slice(0, 80) });
    throw e;
  }
}
