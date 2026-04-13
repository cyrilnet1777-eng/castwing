export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const rawKey =
    (globalThis.Netlify && Netlify.env && typeof Netlify.env.get === "function" ? Netlify.env.get("ELEVENLABS_API_KEY") : "") ||
    process.env.ELEVENLABS_API_KEY ||
    "";
  const apiKey = String(rawKey).trim().replace(/^['"]|['"]$/g, "").replace(/^Bearer\s+/i, "");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const { text, voiceId, modelId } = body;
  if (!text || !voiceId) return new Response("Missing text or voiceId", { status: 400 });
  const cleanVoiceId = String(voiceId).trim();
  const requestedModelId = String(modelId || "").trim();
  const modelCandidates = [];
  if (requestedModelId) modelCandidates.push(requestedModelId);
  modelCandidates.push("eleven_multilingual_v2");
  if (!modelCandidates.includes("eleven_flash_v2_5")) modelCandidates.push("eleven_flash_v2_5");

  async function callElevenLabs(model) {
    return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cleanVoiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
  }

  let r = null;
  let usedModel = null;
  let lastDetailsText = "";
  let lastDetailsJson = null;
  for (const candidate of modelCandidates) {
    r = await callElevenLabs(candidate);
    if (r.ok) {
      usedModel = candidate;
      break;
    }
    if (r.status !== 404) break;
    try { lastDetailsText = await r.text(); } catch { lastDetailsText = ""; }
    try { lastDetailsJson = lastDetailsText ? JSON.parse(lastDetailsText) : null; } catch { lastDetailsJson = null; }
  }

  if (!r || !r.ok) {
    let detailsText = lastDetailsText;
    let detailsJson = lastDetailsJson;
    if (!detailsText) {
      try { detailsText = await r.text(); } catch { detailsText = ""; }
    }
    if (!detailsJson) {
      try { detailsJson = detailsText ? JSON.parse(detailsText) : null; } catch { detailsJson = null; }
    }
    const detailMsg =
      (detailsJson && (detailsJson.detail || detailsJson.message || detailsJson.error)) ||
      detailsText ||
      "";
    const hint =
      r.status === 401 && /text_to_speech|permission|unauthorized/i.test(detailMsg)
        ? "Check ElevenLabs key scope: enable text_to_speech permission."
        : r.status === 404
        ? "Voice/model combination not found. Verify voiceId or try another model/voice."
        : "";
    return new Response(
      JSON.stringify({ error: "ElevenLabs error " + r.status, details: detailMsg, hint }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
  return new Response(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": "audio/mpeg", "X-Elevenlabs-Model": usedModel || "" } });
};

export const config = {
  path: "/api/tts",
  method: "POST"
};
