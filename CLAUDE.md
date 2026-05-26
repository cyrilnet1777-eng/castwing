# CitizenTape / CastWing

## Deployment
- Deploy: `npx wrangler deploy` (keep_vars=true is set in wrangler.toml)
- GitHub Actions auto-deploys on push to main with `--keep-vars`
- NEVER set API keys as plaintext vars in Cloudflare dashboard
- ALL API keys MUST be set via `wrangler secret put` — secrets survive deploys
- Current secrets: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, RESEND_API_KEY, POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, AUTH_CODE_SECRET

## Architecture
- Single-page app: index.html (frontend) + worker.js (Cloudflare Worker backend)
- Database: Cloudflare D1 (castwing-db)
- KV: AUTH_KV for auth rate limiting
- TTS: ElevenLabs API (proxied through worker)
- PDF parsing: Anthropic Claude API (multi-key load balancing)
- Payments: Polar (credit packs + metered/PAYG billing)
- Auth: Email code + Google OAuth, session cookies (cw_session)

## Key conventions
- All code is in two files: index.html and worker.js
- CSS is inline in index.html <style> tags
- JavaScript is inline in index.html <script> tags
- No build step, no bundler, no framework

## Versioning
- APP_BUILD in index.html MUST use today's actual date: `YYYY-MM-DDa` (e.g. `2026-05-26a`)
- Increment the letter suffix (a→b→c) for multiple deploys on the same day
- NEVER reuse or increment from a previous day's version — always use today's date
