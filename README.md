# Castwing — Audition Studio

A browser-based audition/rehearsal studio for actors. Load a screenplay (PDF or pasted text), pick your character, and rehearse with an AI partner that reads the other lines aloud — or invite a real partner over WebRTC.

**Live:** https://castwing.sersoub-w.workers.dev

## Features

### Solo + AI mode
- Upload a PDF screenplay or paste dialogue text.
- Select your character from the parsed script.
- The AI reads the partner lines aloud using **ElevenLabs TTS** (cloud) or the **browser Speech Synthesis API** (offline fallback).
- Three reply modes:
  - **AI vocal** — AI auto-reads partner lines, user advances manually.
  - **Manual** — navigate lines with Prev/Next buttons, no auto-speech.
  - **Auto** — AI reads partner lines, then a **Voice Activity Detector (VAD)** listens for 1.5 s of silence after the user speaks, then auto-advances.
- Built-in teleprompter highlights the current line and scrolls automatically.
- Camera + mic preview with toggle controls.
- Record the session to a `.webm` file (downloaded locally).

### Partner mode (WebRTC)
- The actor creates a session and gets an 8-character code.
- The partner joins using the code (or a direct link with `?code=XXXX`).
- Peer-to-peer connection via **PeerJS** (uses Google STUN servers).
- Script is synced between peers; both see the teleprompter.
- Audio is streamed both ways.
- Share the code/link via clipboard, WhatsApp, Telegram, WeChat, or native share.

### Voice system
- **13 ElevenLabs voices** mapped by name (serena, daniel, rachel, etc.).
- **10+ locale/accent packs**: Arabic, Chinese, English, French, German, Hindi Belt, Italian, Japanese, Portuguese, Spanish — each with regional accents (e.g., French France / Belgium / Switzerland / Québec).
- Voices are grouped per locale; selecting a locale swaps the available voice grid.
- 5 **emotion presets**: Neutral, Excited, Sad, Angry, Whisper — each adjusts ElevenLabs `stability`, `similarity_boost`, and `style` parameters.
- 3 **speed presets**: Slow (0.7x), Normal (1x), Fast (1.6x) — adjusts both ElevenLabs voice settings and `audio.playbackRate`.
- Fallback voice IDs: if a primary ElevenLabs voice returns 404, the system tries configured fallback voices automatically.

### PDF parsing
- Uses **PDF.js** (CDN) to extract text from uploaded PDFs.
- Heuristic parser detects `CHARACTER: dialogue` patterns in standard screenplay format.
- Extracted characters populate a selection grid; the user picks their role.

### Internationalization (i18n)
- Full UI translation in **11 languages**: French, English, Spanish, Italian, Chinese, Arabic, Hebrew, German, Portuguese, Japanese, Russian.
- UI language selector on the home screen; persisted in localStorage.
- RTL support for Arabic and Hebrew.
- Voice preview text adapts to the selected locale language.

### Settings persistence
- All user preferences (UI language, voice locale, selected voice, emotion, speed, mode) are saved in `localStorage` under key `castwing_user_settings_v3`.

## Architecture

### File structure

```
index.html                   Single-page app (HTML + inline CSS + JS)
worker.js                    Cloudflare Worker entry point (routes /api/tts, serves assets)
wrangler.toml                Cloudflare Workers configuration
functions/api/tts.js         Cloudflare Pages Function (same TTS logic, Pages-compatible)
netlify/functions/tts.js     Netlify Function (same TTS logic, Netlify-compatible)
netlify.toml                 Netlify build config (legacy)
signaling.js                 Netlify Function for WebRTC signaling relay (not used by client)
AGENTS.md                    Cursor Cloud / AI assistant instructions
```

### No build step

There is no `package.json`, no bundler, no transpiler. The app is a single `index.html` with inline `<style>` and `<script>` tags. All external libraries are loaded via CDN:

- **PeerJS 1.5.4** — WebRTC abstraction
- **PDF.js 3.11.174** — PDF text extraction
- **DM Sans** (Google Fonts) — typography

### TTS proxy (`/api/tts`)

The frontend calls `POST /api/tts` which proxies to the ElevenLabs API. This is needed because the ElevenLabs API key must stay server-side.

The TTS proxy:
1. Reads `ELEVENLABS_API_KEY` from environment variables.
2. Accepts `{ text, voiceId, modelId, emotion, speed, languageCode }`.
3. Computes `voice_settings` (stability, similarity_boost, style) based on emotion + speed.
4. Tries the requested model, then falls back to `eleven_multilingual_v2`, then `eleven_flash_v2_5`.
5. For each model, tries with the requested `language_code`, then without.
6. Returns `audio/mpeg` on success, or a JSON error with diagnostic details.

Three implementations exist for different hosting platforms:
- `worker.js` — Cloudflare Workers (current production)
- `functions/api/tts.js` — Cloudflare Pages Functions
- `netlify/functions/tts.js` — Netlify Functions

The frontend (`fetchTTSFromBestEndpoint`) auto-detects the correct endpoint:
- On `*.netlify.app`: tries `/.netlify/functions/tts` first, then `/api/tts`
- Elsewhere: tries `/api/tts` first, then `/.netlify/functions/tts`
- Caches the working endpoint to avoid redundant 404 probes.

## Deployment

### Cloudflare Workers (current — free tier)

The app is deployed as a Cloudflare Worker with static assets.

**Config** (`wrangler.toml`):
- `main = "worker.js"` — Worker entry point handling `/api/tts` and asset serving.
- `[assets] directory = "."` — serves `index.html` and other static files.

**Environment secret**:
- `ELEVENLABS_API_KEY` — set in the Cloudflare dashboard under the Worker's Settings > Variables and Secrets.

**Deploy via CLI**:
```sh
npx wrangler deploy
```

**Deploy via Git** (if connected):
Push to the configured branch and Cloudflare auto-deploys.

### Cloudflare Pages (alternative — free tier)

If deployed as a Cloudflare Pages project instead of a Worker:
- Build command: *(empty)*
- Build output directory: `.`
- The `functions/api/tts.js` file is auto-detected as a Pages Function at `/api/tts`.
- Set `ELEVENLABS_API_KEY` in Pages project settings.

### Netlify (legacy)

- `netlify.toml` points to `netlify/functions/` as the functions directory.
- The Netlify Function `tts.js` handles `POST /.netlify/functions/tts`.
- Set `ELEVENLABS_API_KEY` in Netlify environment variables.

### Local development

Any static HTTP server works:
```sh
# Python
python3 -m http.server 8080

# Node
npx serve .

# Cloudflare local dev (includes /api/tts function)
npx wrangler dev
```

For local TTS testing with `wrangler dev`, create a `.dev.vars` file:
```
ELEVENLABS_API_KEY=your_key_here
```

## Key technical details

### WebRTC flow
1. Actor creates a PeerJS peer with ID `castwing-{CODE}`.
2. Partner creates a peer with ID `castwing-p-{CODE}-{random}` and connects to the actor's peer.
3. On connection, the actor sends the script; the partner sends a `ready` signal.
4. The actor then initiates a media call; audio streams both ways.
5. Prompter navigation is synced via the data channel.

### Voice Activity Detection (Auto mode)
- Uses `AudioContext` + `AnalyserNode` to compute RMS amplitude in real-time.
- State machine: `WAITING` → `SPEAKING` (RMS >= threshold) → `TRAILING` (RMS drops) → fires `onSpeechEnd` after 1.5 s of silence.
- On speech end, the prompter auto-advances and the AI speaks the next partner line.

### Camera handling
- Requests `getUserMedia({ video: true, audio: true })`.
- Falls back to audio-only if camera is denied.
- Ensures live audio tracks are attached (re-requests mic if needed).
- Graceful degradation: session works without any media permissions.
