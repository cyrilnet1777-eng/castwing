export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const apiKey = Netlify.env.get("ELEVENLABS_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const { text, voiceId, modelId } = body;
  if (!text || !voiceId) return new Response("Missing text or voiceId", { status: 400 });
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: modelId || "eleven_flash_v2_5", language_code: "fr", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!r.ok) return new Response(JSON.stringify({ error: "ElevenLabs error " + r.status }), { status: 502, headers: { "Content-Type": "application/json" } });
  return new Response(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
};

export const config = {
  path: "/api/tts",
  method: "POST"
};
