function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.detail === "string") return value.detail;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
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
    const candidates = voices
      .filter((v) => v && typeof v.voice_id === "string" && v.voice_id && v.voice_id !== attemptedVoiceId)
      .map((v) => v.voice_id);
    if (!candidates.length) return "";
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] || "";
  } catch (e) {
    return "";
  }
}

async function handleTTS(request, env) {
  try {
    const apiKey = String(env.ELEVENLABS_API_KEY || "")
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .replace(/^Bearer\s+/i, "");
    if (!apiKey) return json({ error: "Missing ELEVENLABS_API_KEY" }, 500);

    const payload = await request.json().catch(() => ({}));
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const voiceId = typeof payload.voiceId === "string" ? payload.voiceId.trim() : "";
    const emotion = typeof payload.emotion === "string" ? payload.emotion.trim().toLowerCase() : "neutral";
    const speed = Number.isFinite(Number(payload.speed)) ? Number(payload.speed) : 1;
    const rawLang = typeof payload.languageCode === "string" ? payload.languageCode.trim().toLowerCase() : "";
    const languageCode = rawLang.split("-")[0] || "";
    const modelId = typeof payload.modelId === "string" ? payload.modelId.trim() : "";

    if (!text || !voiceId) return json({ error: "Missing text or voiceId" }, 400);

    const emotionMap = {
      neutral: { stability: 0.58, similarity_boost: 0.74, style: 0.28, use_speaker_boost: true },
      excited: { stability: 0.18, similarity_boost: 0.82, style: 0.95, use_speaker_boost: true },
      sad:     { stability: 0.9,  similarity_boost: 0.46, style: 0.06, use_speaker_boost: true },
      angry:   { stability: 0.12, similarity_boost: 0.88, style: 1.0,  use_speaker_boost: true },
      whisper: { stability: 0.94, similarity_boost: 0.28, style: 0.0,  use_speaker_boost: false },
    };
    const base = emotionMap[emotion] || emotionMap.neutral;
    const speedBoost = speed > 1 ? Math.min(0.22, (speed - 1) * 0.3) : 0;
    const speedSlow  = speed < 1 ? Math.min(0.22, (1 - speed) * 0.3) : 0;
    const voiceSettings = {
      stability:        Math.max(0.1, Math.min(1, base.stability + speedBoost - speedSlow)),
      similarity_boost: Math.max(0.1, Math.min(1, base.similarity_boost + speedSlow * 0.5)),
      style:            Math.max(0,   Math.min(1, base.style + speedBoost)),
      use_speaker_boost: Boolean(base.use_speaker_boost),
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
          const body = { text, model_id: candidateModel, voice_settings: voiceSettings };
          if (candidateLang) body.language_code = candidateLang;

          const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(candidateVoice)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "xi-api-key": apiKey, Accept: "audio/mpeg" },
              body: JSON.stringify(body),
            }
          );

          if (response.ok) {
            return new Response(response.body, {
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
          try { parsed = rawDetail ? JSON.parse(rawDetail) : null; } catch (e) { parsed = null; }
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
            const authHint = response.status === 401
              ? "Check ELEVENLABS_API_KEY validity and text_to_speech permission."
              : "Key exists but lacks permission. Enable text_to_speech scope.";
            return json({ error: `ElevenLabs error ${response.status}`, details: detail, hint: authHint, attempts }, 502);
          }
        }
      }
    }

    const hint = lastStatus === 404
      ? "Voice/model/language unavailable on this account. The backend attempted account voice fallback."
      : lastStatus === 422
        ? "Language not supported by this voice. The backend already retried without language_code."
        : "";
    return json({ error: `ElevenLabs error ${lastStatus}`, details: lastDetail, hint, attempts }, 502);
  } catch (error) {
    return json({ error: toText((error && error.message) || error || "Unexpected error") }, 500);
  }
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(text) {
  const padded = String(text || "").replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((String(text || "").length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendResendEmail(apiKey, fromEmail, toEmail, code) {
  const rsp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject: "Castwing verification code",
      html: `<p>Your Castwing verification code is: <b>${code}</b></p><p>This code expires in 10 minutes.</p>`,
    }),
  });
  return rsp.ok;
}

async function handleAuth(request, env) {
  try {
    const payload = await request.json().catch(() => ({}));
    const action = String(payload.action || "").trim().toLowerCase();
    const email = String(payload.email || "").trim().toLowerCase();
    const secret = String(env.AUTH_CODE_SECRET || "dev-auth-secret-change-me");

    if (!["request_code", "verify_code"].includes(action)) return json({ error: "Invalid action" }, 400);
    if (!isEmail(email)) return json({ error: "Invalid email" }, 400);

    if (action === "request_code") {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const exp = Date.now() + 10 * 60 * 1000;
      const sig = await sha256Hex(`${email}|${code}|${exp}|${secret}`);
      const token = b64urlEncode(JSON.stringify({ email, exp, sig }));
      const resendKey = String(env.RESEND_API_KEY || "").trim();
      const fromEmail = String(env.AUTH_FROM_EMAIL || "").trim();
      if (resendKey && fromEmail) {
        const ok = await sendResendEmail(resendKey, fromEmail, email, code);
        if (!ok) return json({ error: "Unable to send email code" }, 502);
        return json({ ok: true, token, delivery: "email" });
      }
      return json({ ok: true, token, delivery: "debug", debugCode: code });
    }

    const token = String(payload.token || "");
    const code = String(payload.code || "").trim();
    if (!token || !code) return json({ ok: false, error: "Missing token or code" }, 400);
    let parsed;
    try {
      parsed = JSON.parse(b64urlDecode(token));
    } catch (e) {
      return json({ ok: false, error: "Invalid token" }, 400);
    }
    if (!parsed || parsed.email !== email || Number(parsed.exp || 0) < Date.now()) {
      return json({ ok: false, error: "Token expired or mismatched" }, 400);
    }
    const expected = await sha256Hex(`${email}|${code}|${parsed.exp}|${secret}`);
    if (expected !== parsed.sig) return json({ ok: false, error: "Invalid code" }, 401);
    return json({ ok: true });
  } catch (error) {
    return json({ error: toText((error && error.message) || error || "Unexpected error") }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/geo" && request.method === "GET") {
      const country = (request.cf && request.cf.country) ? request.cf.country : "";
      const acceptLanguage = request.headers.get("Accept-Language") || "";
      return json({ country, acceptLanguage });
    }

    if (url.pathname === "/api/tts" && request.method === "POST") {
      return handleTTS(request, env);
    }
    if (url.pathname === "/api/auth" && request.method === "POST") {
      return handleAuth(request, env);
    }

    if (url.pathname === "/api/tts" || url.pathname === "/api/geo" || url.pathname === "/api/auth") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return env.ASSETS.fetch(request);
  },
};
