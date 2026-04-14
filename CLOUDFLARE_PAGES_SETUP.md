# Cloudflare Pages setup (free)

This project is now compatible with Cloudflare Pages:

- static site files at repository root
- server function at `functions/api/tts.js` (served as `/api/tts`)

## 1) Create the Cloudflare Pages project

1. In Cloudflare dashboard, go to **Workers & Pages** -> **Create** -> **Pages**.
2. Connect your GitHub repository: `cyrilnet1777-eng/castwing`.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `.`
4. Enable automatic deployments on push.

## 2) Add secret

In the Pages project settings:

- **Settings** -> **Variables and Secrets** -> **Add secret**
  - Name: `ELEVENLABS_API_KEY`
  - Value: your ElevenLabs API key

Add it for both **Production** and **Preview** environments.

## 3) Deploy

Push your branch and Cloudflare will deploy automatically.

## 4) Validate

After deploy:

- open the app URL
- click voice preview
- check that `POST /api/tts` returns `200` (or backend error details, but not route 404)

## Notes

- `netlify/functions/tts.js` and `netlify.toml` are kept for backward compatibility.
- On Cloudflare, the app uses `functions/api/tts.js`.
