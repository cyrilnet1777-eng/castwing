# Castwing — Studio d'Audition

## Cursor Cloud specific instructions

### Overview

Castwing is a French-language audition studio web app. It is a zero-dependency, zero-build-step project: `index.html` (single-page app with inline CSS/JS) and `signaling.js` (unused Netlify Functions handler). All libraries (PeerJS, PDF.js) are loaded via CDN.

### Running the dev server

```sh
python3 -m http.server 8080 --directory /workspace
```

Then open `http://localhost:8080/` in Chrome. Any static HTTP server works (`npx serve`, etc.).

### Key caveats

- **No package manager / no dependencies to install.** There is no `package.json`, no `node_modules`, no build step.
- **No lint/test/build commands exist.** The project has no configured linter, test runner, or build pipeline.
- **Camera/mic permissions:** The Solo + AI and Partner modes use `getUserMedia`. In headless/CI environments, camera access will fail gracefully — the teleprompter and session UI still work without a camera.
- **`signaling.js`** is a Netlify Functions handler not referenced by `index.html`. It is not needed for local dev.
- **WebRTC partner mode** requires internet access for PeerJS cloud signaling (`0.peerjs.com`) and Google STUN servers. Solo + AI mode works fully offline (uses browser Speech Synthesis API).
