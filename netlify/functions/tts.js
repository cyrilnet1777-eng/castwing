export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const rawKey =
    (globalThis.Netlify && Netlify.env && typeof Netlify.env.get === "function" ? Netlify.env.get("ELEVENLABS_API_KEY") : "") ||
    process.env.ELEVENLABS_API_KEY ||
    "";
  const apiKey = String(rawKey).trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const { text, voiceId, modelId } = body;
  if (!text || !voiceId) return new Response("Missing text or voiceId", { status: 400 });
  const cleanVoiceId = String(voiceId).trim();
  const cleanModelId = String(modelId || "eleven_flash_v2_5").trim() || "eleven_flash_v2_5";
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cleanVoiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: cleanModelId, language_code: "fr", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!r.ok) {
    let details = "";
    try { details = await r.text(); } catch {}
    return new Response(JSON.stringify({ error: "ElevenLabs error " + r.status, details }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
  return new Response(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
};

export const config = {
  path: "/api/tts",
  method: "POST"
};
