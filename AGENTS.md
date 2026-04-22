# Castwing — Studio d'Audition

## Cursor Cloud specific instructions

### Overview

Castwing is a French-language audition studio web app. The UI is a single-page app in `index.html` (inline CSS/JS). **PDF and pasted screenplay parsing** is done server-side: `netlify/functions/parse-screenplay.js` calls the **Anthropic Messages API** with the PDF (base64) or plain text and returns structured JSON (`characters` + `lines`). The browser no longer runs a regex/lightweight parser.

Optional **Cursor MCP** integration: submodule `tools/pdf-mcp-server` ([EEager/pdf-mcp-server](https://github.com/EEager/pdf-mcp-server)) — see `.cursor/mcp.json`. To build the MCP server locally: `cd tools/pdf-mcp-server && npm install && npm run build` (then point MCP at `dist/index.js` instead of `npx tsx` if you prefer). MCP is for the IDE only; **visitors on cast-wing.com** use the Netlify function, not MCP.

### Running the dev server

Static UI only (import PDF/text will fail until you hit the parse function):

```sh
python3 -m http.server 8080 --directory /workspace
```

Full stack (UI + `/.netlify/functions/*`):

```sh
netlify dev
```

Then open the URL Netlify prints (often `http://localhost:8888`). Set `ANTHROPIC_API_KEY` in Netlify env or a root `.env` for `netlify dev`.

### Key caveats

- **Anthropic:** Deploy with `ANTHROPIC_API_KEY` in Netlify environment variables. Optional: `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`.
- **No client-side PDF.js:** PDFs are sent to the API as base64; no OCR/Tesseract path in the browser.
- **Camera/mic permissions:** Solo + AI and Partner modes use `getUserMedia`. In headless/CI, camera access fails gracefully.
- **`signaling.js`** is a legacy Netlify handler; partner WebRTC still uses PeerJS CDN.
- **WebRTC partner mode** needs internet (PeerJS + STUN). Solo + AI can use Speech Synthesis offline once the script is loaded.
