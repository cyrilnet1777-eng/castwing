# Castwing — Studio d'Audition

## Cursor Cloud specific instructions

### Overview

Castwing is a French-language audition studio web app. The UI is `index.html` (inline CSS/JS). **PDF and pasted screenplay parsing** runs on **`worker.js`** (Cloudflare Workers): **`POST /api/parse-screenplay`** sends the PDF (base64) or plain text to **Anthropic Messages API** and returns JSON `{ characters, lines }`.

Optional **Cursor MCP**: submodule `tools/pdf-mcp-server` — see `.cursor/mcp.json`.

### Running locally

**Recommended (same stack as prod — parsing + `/api/*`) :**

```sh
npx wrangler dev
```

Uses `worker.js` + static assets from `wrangler.toml` (`[assets]`).

Define secrets (once):

```sh
wrangler secret put ANTHROPIC_API_KEY
```

Optional vars in `wrangler.toml` or dashboard: `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`.

Static-only (UI only; import script will fail until `/api/parse-screenplay` is reachable):

```sh
python3 -m http.server 8080 --directory .
```

### Key caveats

- **`ANTHROPIC_API_KEY`** must be set on the Worker (`wrangler secret put` or Cloudflare dashboard → Workers/Pages → Settings → Variables).
- No client-side PDF.js for parsing; PDF is sent as base64 to Claude.
- **TTS** (`/api/tts`) still uses Worker + ElevenLabs when deployed on Pages.
- **Legacy** `POST /api/parse-script` (multipart) remains for older clients; the SPA uses **`/api/parse-screenplay`** only.
