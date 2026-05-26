# CitizenTape — Your Scene Partner

A premium acting rehearsal studio. Import a screenplay, pick your role, and rehearse with an AI partner that reads the other lines aloud — or invite a real partner over WebRTC.

**Live:** https://citizentape.com
**Staging:** https://beta.citizentape.com
**Legacy domain:** cast-wing.com (301 redirects to citizentape.com)

### Design
- Luxury cinematic aesthetic: dark charcoal (#1a1a1a) / cream (#f5efe0) / raspberry (#d92027) palette
- Playfair Display serif for headings, DM Sans for UI
- Landing page: full-bleed studio photo with director's chair (responsive mobile/desktop images)
- Inner pages: outlined buttons, square corners, editorial spacing
- All toggles, selections, and active states use the same outlined highlight style

### Product flow
1. **Import a scene** — PDF, Final Draft (.fdx), or plain text (drag & drop or file picker)
2. **Select your character** from the parsed script
3. **Choose how to rehearse** — with AI or with a partner
4. **Configure voice** (AI mode) or **share session code** (partner mode)
5. **Rehearse** — real-time teleprompter with visual hierarchy

Partners join directly via the "Join a session" link on the landing page (no import needed).

## Features

### Solo + AI mode
- Upload PDF, FDX (Final Draft), or paste dialogue text.
- Smart character detection with AI-powered merging of variants (e.g. JUVE / JUVE (CONT'D) / JUVE OFF → JUVE).
- The AI reads partner lines using **ElevenLabs TTS**. Browser Speech Synthesis as silent fallback.
- Three reply modes: **Voice AI** (auto-read), **Manual** (Prev/Next), **Auto** (VAD-based silence detection).
- Built-in teleprompter with 3-level visual hierarchy:
  - Active line: +30% size, bold, raspberry left border
  - Normal lines: off-white
  - Stage directions: gray, italic, smaller
- Auto-scroll positions active line at 30% from top (teleprompter style).
- Parenthetical stage directions (e.g. `(ironique)`, `(whispering)`) stripped from TTS.
- Record session as WebM/MP4. Save & download on session end.
- `beforeunload` warning prevents accidental tab close during recording.

### Partner mode (WebRTC)
- Actor creates session → gets 8-character code → shares with partner.
- Partner joins with code only (no script upload needed — receives it from actor).
- Partner is read-only: no recording, no pause, no end session — just reads lines.
- Only the actor can end the session and save the recording.
- Peer-to-peer via **PeerJS** with STUN + TURN servers.
- Scroll sync via WebRTC DataChannel (<50ms latency):
  - Sends line indices (not pixels)
  - 50ms debounce + lightweight CSS class swap (no DOM rebuild)
  - Bidirectional: last-touch-wins with 500ms lock
- Script synced between peers; both see the teleprompter.

### Pause screen
- **Partner's Pace**: controls AI speech speed (x0.0 to x5.0)
- **Reaction Time**: delay before AI follows up after your line (0.5s-5s)
- **Display**: Text / 50-50 / Video toggle
- Inverted hierarchy: passive info at top, Resume button at bottom (under thumb)

### Voice system
- 13+ ElevenLabs voices across 10+ locale/accent packs
- 5 emotion presets: Neutral, Excited, Sad, Angry, Whisper
- Speed slider (0-5 range) maps to ElevenLabs native `speed` parameter
- Italienne mode at speed >= 4.5 (fast run-through)

### PDF / script parsing
- **Extract-then-label** architecture:
  1. PDF.js extracts text client-side (smart Y-position grouping)
  2. Claude Haiku labels each line (dialogue/action/slug/character_cue)
  3. Client merges text with labels
- **FDX (Final Draft)** parsing: extracts Character and Dialogue from XML
- Large scripts (>800 lines) split and labeled in parallel
- Character variant merging: deterministic (strip CONT'D, OFF, accent normalization) + AI-powered disambiguation

### Credit system
- Visitors: 2 free TTS lines. Signed-up: $1.50 free credit.
- Top-up: $5/$10/$25 via **Polar.sh** (Merchant of Record, handles tax).
- Auto top-up: when enabled, redirects to Polar checkout when balance drops below $2.
- $0.30 per 1K characters. PDF parsing and partner mode are free.
- Atomic debit-before-call prevents concurrent overdraft.

### Internationalization
- **25 languages**: French, English, Spanish, Italian, Chinese, Arabic, Hebrew, Thai, Vietnamese, Polish, Dutch, Swedish, Norwegian, Greek, Czech, Bahasa Indonesia, Bahasa Melayu, Urdu, German, Portuguese, Japanese, Korean, Hindi, Turkish, Russian.
- RTL support for Arabic, Hebrew, and Urdu.
- Auto-detects browser language first, geo/IP as fallback.

### Auth & security
- Email verification codes via **Resend** (rate-limited: 3 codes/15min, 5 verify attempts/10min)
- Google Sign-In (OAuth) — requires Google Cloud project with `citizentape.com` as authorized origin
- Session cookies (HttpOnly, Secure, SameSite=Lax, 30-day expiry)
- All AI parsing and TTS endpoints require authentication
- CORS restricted to `https://citizentape.com`
- TTS rate-limited: 30 calls/min per user + 500/min global (protects ElevenLabs API quota)
- Anthropic concurrency capped at 50 simultaneous parsing requests (KV semaphore)
- XSS-safe: all user-controlled innerHTML escaped via `escHtml()`

### Analytics
- **Google Analytics** (G-90E8W237ZN) tracks: screen views, sign up/login, session starts, script imports, checkout/purchase, language changes, share actions

## Architecture

### Repo workflow
- `main` is the production branch. Push triggers GitHub Actions → `wrangler deploy --keep-vars`.
- **Always commit and push before deploying.** CI auto-deploys on push.
- Staging: `npx wrangler deploy --env staging --keep-vars` (manual, preserves secrets).

### Versioning
- `APP_BUILD` in index.html uses today's date: `YYYY-MM-DDa` (e.g. `2026-05-26a`)
- Increment the letter suffix (a→b→c) for multiple deploys on the same day
- **Never** reuse or increment from a previous day's version — always use today's actual date

### File structure
```
index.html                   Single-page app (HTML + inline CSS + JS)
worker.js                    Cloudflare Worker (API routes)
wrangler.toml                Cloudflare Workers configuration
_headers                     Cache-control headers
favicon.svg                  Charcoal + raspberry dot favicon
og-image.svg                 Social sharing image
citizentape_logo.svg/png     Brand logo assets
background-image-*.jpg       Landing page hero backgrounds
sounds/                      SFX (swoosh, countdown, ambience, etc.)
functions/api/               Cloudflare Pages Functions (legacy)
AGENTS.md                    AI assistant instructions
```

### Secrets (Cloudflare Worker dashboard)
- `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `AUTH_CODE_SECRET`
- `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`
- `AUTH_FROM_EMAIL` — set in wrangler.toml as plain var (`hello@citizentape.com`)
- Stripe secrets kept but inactive: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- For staging: set as **Encrypt** variables in dashboard, deploy with `--keep-vars`

### Local development
```sh
npx wrangler dev
```
Create `.dev.vars` with your API keys.

### Polar webhook
- Endpoint: `https://citizentape.com/api/polar-webhook`
- Event: `order.paid`
- Signature: Standard Webhooks HMAC-SHA256 (secret = raw UTF-8 bytes of full `polar_whs_*` string)
- Fallback: `/api/credits/reconcile` fetches recent orders from Polar API on payment return

### Google Auth setup
Google Sign-In requires a Google Cloud project with:
- OAuth 2.0 Client ID (Web application type)
- Authorized JavaScript origins: `https://citizentape.com`, `https://beta.citizentape.com`
- Authorized redirect URIs: `https://citizentape.com`, `https://beta.citizentape.com`
- The Client ID is loaded via `<script src="https://accounts.google.com/gsi/client">` in index.html

### D1 Database tables
- `users` — email, tier, admin flag, login timestamps
- `invites` — admin-created invite tokens with credit grants
- `credit_transactions` — append-only ledger (topups, TTS debits, free grants)
- `usage_events` — audit log for TTS usage

**Indexes** (auto-created by `ensureD1Tables`):
- `idx_credit_email` — `credit_transactions(email)` — balance lookups
- `idx_credit_stripe_id` — `credit_transactions(stripe_session_id)` — idempotency checks
- `idx_credit_created` — `credit_transactions(email, created_at DESC)` — history queries
- `idx_invite_redemptions_email` — `invite_redemptions(email)`
- `idx_usage_events_email` — `usage_events(email, created_at DESC)`
- Unique partial index on `stripe_session_id` — prevents duplicate topup credits

### Scalability notes
- **Cloudflare Workers**: auto-scales, no config needed
- **D1**: single-writer SQLite — indexed queries keep writes fast; atomic debit-before-call prevents overdraft
- **ElevenLabs**: global 500 req/min cap prevents API quota exhaustion; upgrade plan or add keys to scale
- **Anthropic**: max 50 concurrent requests via KV semaphore; increase limit as plan allows
- **KV rate limiting**: eventually consistent (get→put race possible at extreme concurrency); migrate to Durable Objects at 10K+ daily active users
- **CDN caching**: HTML cached 5min, images/sounds 24h immutable
- **PeerJS**: uses default public signaling server; self-host on Fly.io when partner mode exceeds ~500 concurrent sessions
