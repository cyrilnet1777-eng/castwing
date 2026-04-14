function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.detail === "string") return value.detail;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  return String(value);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchAccountFallbackVoiceId(apiKey, attemptedVoiceId) {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) return "";
    const payload = await response.json().catch(() => null);
    const voices = payload && Array.isArray(payload.voices) ? payload.voices : [];
    const first = voices.find((v) => v && typeof v.voice_id === "string" && v.voice_id && v.voice_id !== attemptedVoiceId);
    return first && first.voice_id ? first.voice_id : "";
  } catch (e) {
    return "";
  }
}

export async function onRequestPost(context) {
  try {
    const apiKey = String(context.env.ELEVENLABS_API_KEY || "")
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .replace(/^Bearer\s+/i, "");
    if (!apiKey) {
      return json({ error: "Missing ELEVENLABS_API_KEY" }, 500);
    }

    const payload = await context.request.json().catch(() => ({}));
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const voiceId = typeof payload.voiceId === "string" ? payload.voiceId.trim() : "";
    const emotion = typeof payload.emotion === "string" ? payload.emotion.trim().toLowerCase() : "neutral";
    const speed = Number.isFinite(Number(payload.speed)) ? Number(payload.speed) : 1;
    const languageCode = typeof payload.languageCode === "string" ? payload.languageCode.trim().toLowerCase() : "";
    const modelId = typeof payload.modelId === "string" ? payload.modelId.trim() : "";

    if (!text || !voiceId) {
      return json({ error: "Missing text or voiceId" }, 400);
    }

    const emotionMap = {
      neutral: { stability: 0.62, similarity_boost: 0.74, style: 0.18 },
      excited: { stability: 0.22, similarity_boost: 0.72, style: 1.0 },
      sad: { stability: 0.96, similarity_boost: 0.42, style: 0.02 },
      angry: { stability: 0.14, similarity_boost: 0.9, style: 1.0 },
      whisper: { stability: 1.0, similarity_boost: 0.2, style: 0.0 },
    };
    const base = emotionMap[emotion] || emotionMap.neutral;
    const speedBoost = speed > 1 ? Math.min(0.22, (speed - 1) * 0.3) : 0;
    const speedSlow = speed < 1 ? Math.min(0.22, (1 - speed) * 0.3) : 0;
    const voiceSettings = {
      stability: Math.max(0.1, Math.min(1, base.stability + speedBoost - speedSlow)),
      similarity_boost: Math.max(0.1, Math.min(1, base.similarity_boost + speedSlow * 0.5)),
      style: Math.max(0, Math.min(1, base.style + speedBoost)),
    };

    const modelCandidates = [];
    if (modelId) modelCandidates.push(modelId);
    if (!modelCandidates.includes("eleven_multilingual_v2")) modelCandidates.push("eleven_multilingual_v2");
    if (!modelCandidates.includes("eleven_flash_v2_5")) modelCandidates.push("eleven_flash_v2_5");
    const languageCandidates = languageCode ? [languageCode, ""] : [""];

    const attempts = [];
    const voiceCandidates = [voiceId];
    let accountFallbackVoiceId = "";
    let lastStatus = 502;
    let lastDetail = "ElevenLabs request failed";

    for (const candidateVoice of voiceCandidates) {
      for (const candidateModel of modelCandidates) {
        for (const candidateLang of languageCandidates) {
          const body = {
            text,
            model_id: candidateModel,
            voice_settings: voiceSettings,
          };
          if (candidateLang) body.language_code = candidateLang;

          const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(candidateVoice)}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": apiKey,
              Accept: "audio/mpeg",
            },
            body: JSON.stringify(body),
          });

          if (response.ok) {
            const audioBuffer = await response.arrayBuffer();
            return new Response(audioBuffer, {
              status: 200,
              headers: {
                "Content-Type": "audio/mpeg",
                "Cache-Control": "no-store",
                "X-Elevenlabs-Model": candidateModel,
                "X-Elevenlabs-Language": candidateLang || "default",
                "X-Elevenlabs-Voice": candidateVoice,
              },
            });
          }

          const rawDetail = await response.text().catch(() => "");
          let parsed = null;
          try {
            parsed = rawDetail ? JSON.parse(rawDetail) : null;
          } catch (e) {
            parsed = null;
          }
          const detail = toText(
            (parsed && (parsed.detail || parsed.message || parsed.error)) || rawDetail || `ElevenLabs error ${response.status}`
          );

          lastStatus = response.status;
          lastDetail = detail;
          attempts.push({
            status: response.status,
            voice: candidateVoice,
            model: candidateModel,
            language: candidateLang || "default",
            detail,
          });

          if (response.status === 404 && candidateVoice === voiceId) {
            if (!accountFallbackVoiceId) accountFallbackVoiceId = await fetchAccountFallbackVoiceId(apiKey, voiceId);
            if (accountFallbackVoiceId && !voiceCandidates.includes(accountFallbackVoiceId)) {
              voiceCandidates.push(accountFallbackVoiceId);
            }
          }

          if (response.status === 401 || response.status === 403) {
            const authHint =
              response.status === 401
                ? "Check ELEVENLABS_API_KEY validity and text_to_speech permission."
                : "Key exists but lacks permission. Enable text_to_speech scope.";
            return json(
              {
                error: `ElevenLabs error ${response.status}`,
                details: detail,
                hint: authHint,
                attempts,
              },
              502
            );
          }
        }
      }
    }

    const hint =
      lastStatus === 404
        ? "Voice/model/language unavailable on this account. The backend attempted account voice fallback."
        : lastStatus === 422
          ? "Language not supported by this voice. The backend already retried without language_code."
          : "";
    return json(
      {
        error: `ElevenLabs error ${lastStatus}`,
        details: lastDetail,
        hint,
        attempts,
      },
      502
    );
  } catch (error) {
    return json({ error: toText((error && error.message) || error || "Unexpected error") }, 500);
  }
}
