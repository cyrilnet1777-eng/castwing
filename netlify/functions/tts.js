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
  const { text, voiceId, modelId, emotion, speed } = body;
  if (!text || !voiceId) return new Response("Missing text or voiceId", { status: 400 });
  const cleanVoiceId = String(voiceId).trim();
  const cleanEmotion = String(emotion || "neutral").trim().toLowerCase();
  const cleanSpeed = Number.isFinite(Number(speed)) ? Number(speed) : 1;
  const emotionSettingsMap = {
    neutral: { stability: 0.55, similarity_boost: 0.75, style: 0.2 },
    excited: { stability: 0.28, similarity_boost: 0.7, style: 0.92 },
    sad: { stability: 0.92, similarity_boost: 0.58, style: 0.0 },
    angry: { stability: 0.22, similarity_boost: 0.85, style: 1.0 },
    whisper: { stability: 0.98, similarity_boost: 0.52, style: 0.0 },
  };
  const baseVoiceSettings = emotionSettingsMap[cleanEmotion] || emotionSettingsMap.neutral;
  const speedBoost = cleanSpeed > 1 ? Math.min(0.22, (cleanSpeed - 1) * 0.3) : 0;
  const speedSlow = cleanSpeed < 1 ? Math.min(0.22, (1 - cleanSpeed) * 0.3) : 0;
  const voiceSettings = {
    stability: Math.max(0.1, Math.min(1, baseVoiceSettings.stability + speedBoost - speedSlow)),
    similarity_boost: Math.max(0.1, Math.min(1, baseVoiceSettings.similarity_boost + speedSlow * 0.5)),
    style: Math.max(0, Math.min(1, baseVoiceSettings.style + speedBoost)),
  };
  const fallbackVoiceIds = [
    "bHkOO3JOGzSRKwMpGIbB", // Serena
    "EXAVITQu4vr4xnSDxMaL", // Bella
    "ErXwobaYiN019PkySvjV", // Antoni
  ];
  const voiceCandidates = [cleanVoiceId, ...fallbackVoiceIds.filter((id) => id !== cleanVoiceId)];
  const requestedModelId = String(modelId || "").trim();
  const modelCandidates = [];
  if (requestedModelId) modelCandidates.push(requestedModelId);
  modelCandidates.push("eleven_multilingual_v2");
  if (!modelCandidates.includes("eleven_flash_v2_5")) modelCandidates.push("eleven_flash_v2_5");

  async function callElevenLabs(model, candidateVoiceId) {
    return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(candidateVoiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: voiceSettings
      })
    });
  }

  let r = null;
  let usedModel = null;
  let usedVoiceId = cleanVoiceId;
  let lastDetailsText = "";
  let lastDetailsJson = null;
  outer: for (const candidateVoiceId of voiceCandidates) {
    for (const candidateModel of modelCandidates) {
      r = await callElevenLabs(candidateModel, candidateVoiceId);
      if (r.ok) {
        usedModel = candidateModel;
        usedVoiceId = candidateVoiceId;
        break outer;
      }
      if (r.status !== 404) break outer;
      try { lastDetailsText = await r.text(); } catch { lastDetailsText = ""; }
      try { lastDetailsJson = lastDetailsText ? JSON.parse(lastDetailsText) : null; } catch { lastDetailsJson = null; }
    }
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
        ? "Voice/model not found. Tried fallback voices automatically; check your ElevenLabs voice library."
        : "";
    return new Response(
      JSON.stringify({ error: "ElevenLabs error " + r.status, details: detailMsg, hint }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
  return new Response(await r.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "X-Elevenlabs-Model": usedModel || "",
      "X-Elevenlabs-Voice": usedVoiceId || cleanVoiceId
    }
  });
};

export const config = {
  path: "/api/tts",
  method: "POST"
};
