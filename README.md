# Castwing -- Audition Studio

A browser-based audition/rehearsal studio for actors. Load a screenplay (PDF or pasted text), pick your character, and rehearse with an AI partner that reads the other lines aloud -- or invite a real partner over WebRTC.

**Live:** https://cast-wing.com
**Staging:** https://v2.cast-wing.com (testing new voices/features before production)

## Features

### Solo + AI mode
- Upload a PDF screenplay or paste dialogue text.
- Select your character from the parsed script.
- The AI reads the partner lines aloud using **ElevenLabs TTS** (cloud). Browser Speech Synthesis is kept as a silent fallback if ElevenLabs is unavailable.
- Three reply modes:
  - **AI vocal** -- AI auto-reads partner lines, user advances manually.
  - **Manual** -- navigate lines with Prev/Next buttons, no auto-speech.
  - **Auto** -- AI reads partner lines, then a **Voice Activity Detector (VAD)** listens for silence after the user speaks, then auto-advances.
- Built-in teleprompter highlights the current line and scrolls automatically.
- **View modes** during session: Prompt only / Video only / 50-50 (switchable live or from pause menu).
- Camera + mic preview with toggle controls.
- Record the session and download as **MP4** (converted from WebM via **ffmpeg.wasm**, loaded on demand). Falls back to WebM if conversion fails.

### Partner mode (WebRTC)
- The actor creates a session and gets an 8-character code.
- The partner joins using the code (or a direct link with `?join=XXXX`).
- Peer-to-peer connection via **PeerJS** with **STUN + TURN** servers for reliable NAT traversal.
- Automatic **retry logic** (3 attempts with 2-second delays) if initial connection fails.
- **Keepalive heartbeat** every 25 seconds prevents the signaling server from dropping idle connections.
- Script is synced between peers; both see the teleprompter.
- Audio is streamed both ways.
- Share the code/link via clipboard, WhatsApp, Telegram, WeChat, or native share.

### Voice system
- **13+ ElevenLabs voices** mapped by alias (serena, daniel, rachel, nova_f, giulia_v2, etc.). Supports both pre-built voices and Voice Library voices by full ID.
- **10+ locale/accent packs**: Arabic, Chinese, English, French, German, Hindi Belt, Italian, Japanese, Portuguese, Spanish -- each with regional accents.
- Voices are grouped per locale; selecting a locale swaps the available voice grid.
- 5 **emotion presets**: Neutral, Excited, Sad, Angry, Whisper -- each adjusts ElevenLabs `stability`, `similarity_boost`, and `style` parameters. Speed is controlled separately via the native ElevenLabs `speed` voice setting.
- **Speed slider** (0-5 range, 0.5 increments, default 1.5): maps to ElevenLabs native `speed` parameter (0.7x-1.2x). Slider >= 4.5 auto-activates **Italienne mode** (fast run-through with special voice and minimal pauses).
- Configurable **pause between lines** (default 1000ms, 200ms in Italienne).
- Configurable **"Pause after my line"** slider (0.5s-5s) controls how long the AI waits after the user finishes speaking.
- Fallback voice IDs: if a primary ElevenLabs voice returns 404, the system tries configured fallback voices automatically.

### PDF / script parsing
- **Extract-then-label** architecture for fast, accurate parsing:
  1. **PDF.js** (loaded on demand) extracts text client-side, grouping by Y-position to reconstruct actual lines. Smart gap detection prevents letter-by-letter extraction on PDFs with individual character positioning.
  2. Lines are numbered and sent to `/api/label-script` where **Claude Haiku 4.5** labels each line as `dialogue`, `action`, `slug`, or `character_cue` -- without reproducing the text. This keeps output tokens minimal (~10x fewer than full-text parsing).
  3. The client merges original text with labels to build the structured script.
- For large scripts (>800 lines), text is split into chunks and labeled **in parallel**.
- Parenthetical stage directions (e.g. `(criant)`) are automatically stripped from dialogue so the AI doesn't read them aloud.
- Narrative/descriptive lines between dialogue are labeled as `action` and excluded from AI speech.
- Extracted characters populate a selection grid; the user picks their role.
- **Language auto-detection**: analyzes the script text to detect the language (French, Italian, English, etc.) and auto-switches the voice locale to match.
- Also supports pasted plain text via `/api/claude-parse-script`.

### Credit system (pay-as-you-go)
- **Visitors** (no signup): 2 free ElevenLabs TTS lines to experience the quality.
- **Signed-up users**: $1.50 free credit on signup (~50 lines).
- **Top-up**: $5 / $10 / $25 credit packs via **Stripe Checkout**.
- **Pricing**: $0.30 per 1K characters (3x markup on ElevenLabs cost).
- Credits deducted **after** successful TTS (not charged if ElevenLabs fails).
- **Append-only ledger** (`credit_transactions` table) -- balance = SUM of all transactions.
- User profile shows credit balance, top-up buttons ($5/$10/$25), and transaction history (TTS debits grouped by date, top-ups shown individually with timestamp).
- **Auto top-up**: save a card via Stripe Checkout (setup mode), then the system auto-charges the saved card when balance drops below $2 during a session -- no interruption, no redirect.
- PDF parsing is **free** (not gated behind credits).
- Recording and partner mode are **free** (no signup required).

### Internationalization (i18n)
- Full UI translation in **13 languages**: French, English, Spanish, Italian, Chinese, Arabic, Hebrew, German, Portuguese, Japanese, Korean, Hindi, Turkish, Russian.
- Default language is **English**; auto-detects browser/geo language.
- UI language selector on the home screen (top-right); persisted in localStorage.
- RTL support for Arabic and Hebrew.

### URL routing
- Hash-based routing: each screen has a shareable URL (`#solo`, `#partner`, `#create`, `#join`, `#session`).
- Browser back button navigates between screens.
- Direct links work: `cast-wing.com/#solo` opens the Solo + AI page directly.

### Settings persistence
- All user preferences (UI language, voice locale, selected voice, emotion, speed, mode, view mode) are saved in `localStorage`.

## Architecture

### Repo workflow (important)

- `main` is the deployment branch.
- Push to `main` triggers GitHub Actions deploy via `wrangler deploy`.

### File structure

```
index.html                   Single-page app (HTML + inline CSS + JS)
worker.js                    Cloudflare Worker (routes: /api/tts, /api/parse-screenplay,
                             /api/label-script, /api/claude-parse-script, /api/auth,
                             /api/credits/balance, /api/credits/topup,
                             /api/stripe-webhook, etc.)
wrangler.toml                Cloudflare Workers configuration
functions/api/tts.js         Cloudflare Pages Function (same TTS logic, Pages-compatible)
netlify/functions/tts.js     Netlify Function (same TTS logic, Netlify-compatible)
netlify.toml                 Netlify build config (legacy)
signaling.js                 Netlify Function for WebRTC signaling relay (not used by client)
AGENTS.md                    Cursor Cloud / AI assistant instructions
```

### No build step

There is no `package.json`, no bundler, no transpiler. The app is a single `index.html` with inline `<style>` and `<script>` tags. All external libraries are loaded via CDN:

- **PeerJS 1.5.4** -- WebRTC abstraction
- **PDF.js 3.11.174** -- PDF text extraction (loaded on demand)
- **pdf-lib 1.17.1** -- PDF splitting for large documents (loaded on demand)
- **ffmpeg.wasm 0.12.10** -- WebM to MP4 video conversion (loaded on demand)
- **DM Sans** (Google Fonts) -- typography

### TTS proxy (`/api/tts`)

The frontend calls `POST /api/tts` which proxies to the ElevenLabs API. This is needed because the ElevenLabs API key must stay server-side. The proxy also handles **credit metering**: checks the user's balance before proxying, deducts after a successful response, and returns the new balance in the `X-Credits-Balance` header.

## Deployment

### Cloudflare Workers (recommended)

The app is deployed as a Worker with static assets.

**Config** (`wrangler.toml`):
- `main = "worker.js"` -- Worker entry point.
- `[assets] directory = "."` -- serves `index.html` and other static files.

**Environment secrets (required):**
- `ELEVENLABS_API_KEY` -- ElevenLabs API key for TTS.
- `ANTHROPIC_API_KEY` -- Anthropic API key for script parsing (Claude Haiku 4.5).
- `STRIPE_SECRET_KEY` -- Stripe secret key for credit top-ups.
- `STRIPE_WEBHOOK_SECRET` -- Stripe webhook signing secret.
- `RESEND_API_KEY` -- Resend API key for email verification codes.
- `AUTH_FROM_EMAIL` -- sender email for auth codes (e.g. `hello@cast-wing.com`).

Set all in Cloudflare Worker Settings -> Variables and Secrets.

**Deploy via GitHub Actions** (current setup):
Push to `main` triggers `.github/workflows/deploy-cloudflare.yml` which runs `wrangler deploy --keep-vars`.
Requires `CLOUDFLARE_API_TOKEN` secret in GitHub repo settings.

### Stripe webhook setup

1. Stripe Dashboard -> Developers -> Webhooks -> Add endpoint
2. URL: `https://cast-wing.com/api/stripe-webhook`
3. Event: `checkout.session.completed`
4. Copy signing secret -> set as `STRIPE_WEBHOOK_SECRET` in Cloudflare

### Staging environment

A separate worker (`castwing-staging`) is configured in `wrangler.toml` under `[env.staging]`. It shares the same D1 database and KV namespace as production but runs independently.

- **URL:** https://v2.cast-wing.com (custom domain) or `castwing-staging.cyrilnet1777.workers.dev`
- **Deploy:** `npx wrangler deploy --env staging` (manual, not auto-deployed from git)
- **Secrets:** must be set once per env with `wrangler secret put <NAME> --env staging`
- **Use case:** test new ElevenLabs voices, speed changes, or UI features before promoting to production
- **Promote to prod:** apply same changes to `main`, push, then optionally `wrangler delete --env staging`

### Local development

```sh
npx wrangler dev
```

Create a `.dev.vars` file:
```
ELEVENLABS_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

## Key technical details

### WebRTC flow
1. Actor creates a PeerJS peer with ID `castwing-{CODE}` and starts a keepalive heartbeat.
2. Partner creates a peer with ID `castwing-p-{CODE}-{random}` and connects to the actor's peer. Retries up to 3 times on failure.
3. ICE uses STUN (Google) + TURN (openrelay.metered.ca) for NAT traversal.
4. On connection, the actor sends the script; the partner sends a `ready` signal.
5. The actor then initiates a media call; audio streams both ways.
6. Prompter navigation is synced via the data channel.

### Voice Activity Detection (Auto mode)
- Uses `AudioContext` + `AnalyserNode` to compute RMS amplitude in real-time.
- State machine: `WAITING` -> `SPEAKING` (RMS >= threshold) -> `TRAILING` (RMS drops) -> fires `onSpeechEnd` after configurable silence duration.
- On speech end, the prompter auto-advances and the AI speaks the next partner line.

### Camera handling
- Requests `getUserMedia({ video: true, audio: true })`.
- Falls back to audio-only if camera is denied.
- Ensures live audio tracks are attached (re-requests mic if needed).
- Graceful degradation: session works without any media permissions.

### D1 Database tables
- `users` -- email, tier, admin flag, login timestamps
- `invites` -- admin-created invite tokens with credit grants
- `invite_redemptions` -- tracks who redeemed invites
- `credit_transactions` -- append-only ledger (topups, TTS debits, free grants)
- `usage_events` -- audit log for TTS usage
