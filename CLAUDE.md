# CitizenTape / CastWing

## Deployment
- Deploy: `npx wrangler deploy` (keep_vars=true is set in wrangler.toml)
- GitHub Actions auto-deploys on push to main with `--keep-vars`
- NEVER set API keys as plaintext vars in Cloudflare dashboard
- ALL API keys MUST be set via `wrangler secret put` — secrets survive deploys
- Current secrets: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, RESEND_API_KEY, POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, AUTH_CODE_SECRET, CF_TURN_TOKEN

## Architecture
- Single-page app: index.html (frontend) + worker.js (Cloudflare Worker backend)
- Database: Cloudflare D1 (castwing-db)
- KV: AUTH_KV for auth rate limiting
- TTS: ElevenLabs API (proxied through worker)
- PDF parsing: Anthropic Claude API (multi-key load balancing)
- Payments: Polar (credit packs + metered/PAYG billing)
- WebRTC: PeerJS + Cloudflare TURN relay (key ID: a11b92b9acd6aa82ef03a014442f24e5)
- Auth: Email code + Google OAuth, session cookies (cw_session)

## Key conventions
- Frontend: index.html (HTML only) + styles.css + js/ (ES modules) + worker.js (Cloudflare Worker backend)
- No build step, no bundler, no framework — native ES modules (`<script type="module">`)
- JS modules in js/: constants.js, state.js, utils.js, sfx.js, i18n.js, voices.js, plan-timer.js, paywall.js, auth.js, admin.js, idb.js, pdf-parse.js, script-ai.js, tts.js, recording.js, webrtc.js, session.js, app.js (entry point)
- Shared mutable state lives in js/state.js as a centralized `S` object
- HTML onclick handlers work via window.* registration in js/app.js

## Versioning
- APP_BUILD in js/constants.js MUST use today's actual date: `YYYY-MM-DDa` (e.g. `2026-05-26a`)
- Increment the letter suffix (a→b→c) for multiple deploys on the same day
- NEVER reuse or increment from a previous day's version — always use today's date
