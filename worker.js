/* =========================================================
   CASTWING WORKER — Backend
   Routes: /api/tts, /api/auth, /api/auth/google, /api/geo,
           /api/session, /api/credits/consume,
           /api/invite/redeem,
           /api/admin/create-invite, /api/admin/list-invites,
           /api/admin/revoke-invite
========================================================= */

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

function json(body, status = 200, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  return new Response(JSON.stringify(body), { status, headers });
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

function generateId(prefix = "") {
  const rand = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(rand).map(b => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}_${hex}` : hex;
}

function generateRandomToken() {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(rand).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* =========================================================
   ADMIN HELPERS
========================================================= */

function parseAdminEmails(raw) {
  return String(raw || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
}

function isAdminEmail(email, env) {
  if (!email) return false;
  return parseAdminEmails(env.ADMIN_EMAILS).includes(String(email).toLowerCase());
}

/* =========================================================
   SESSION COOKIE (HttpOnly, signed)
========================================================= */

const SESSION_COOKIE_NAME = "cw_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

async function createSignedSessionCookie(email, env) {
  const secret = String(env.INVITE_SIGNING_SECRET || env.AUTH_CODE_SECRET || "dev-session-secret");
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = JSON.stringify({ email: email.toLowerCase(), exp });
  const sig = await sha256Hex(payload + "|" + secret);
  const value = b64urlEncode(payload) + "." + sig;
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

async function readSignedSessionCookie(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts.length !== 2) return null;
  try {
    const payload = b64urlDecode(parts[0]);
    const secret = String(env.INVITE_SIGNING_SECRET || env.AUTH_CODE_SECRET || "dev-session-secret");
    const expected = await sha256Hex(payload + "|" + secret);
    if (expected !== parts[1]) return null;
    const parsed = JSON.parse(payload);
    if (!parsed.email || (parsed.exp && parsed.exp < Date.now())) return null;
    return parsed.email.toLowerCase();
  } catch (e) {
    return null;
  }
}

async function resolveCurrentUser(request, env) {
  const email = await readSignedSessionCookie(request, env);
  return email || null;
}

/* =========================================================
   SESSION STATE
========================================================= */

async function getSessionState(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return { email: null, isAdmin: false, plan: "visitor", creditsRemaining: null };
  const admin = isAdminEmail(email, env);
  if (admin) return { email, isAdmin: true, plan: "admin", creditsRemaining: null };

  if (env.DB) {
    try {
      const redemption = await env.DB.prepare(
        `SELECT r.id, r.invite_id, r.credits_used, i.credits_granted, i.label, i.expires_at, i.revoked
         FROM invite_redemptions r JOIN invites i ON r.invite_id = i.id
         WHERE r.email = ? AND i.revoked = 0
         ORDER BY r.redeemed_at DESC LIMIT 1`
      ).bind(email).first();
      if (redemption) {
        const expired = redemption.expires_at && new Date(redemption.expires_at) < new Date();
        if (!expired) {
          const remaining = Math.max(0, (redemption.credits_granted || 0) - (redemption.credits_used || 0));
          return { email, isAdmin: false, plan: "tester", creditsRemaining: remaining, inviteLabel: redemption.label, expiresAt: redemption.expires_at };
        }
      }
    } catch (e) { /* DB not ready yet */ }
  }
  return { email, isAdmin: false, plan: "free", creditsRemaining: null };
}

async function logUsageEvent(db, event) {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO usage_events (id, email, invite_id, event_type, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(generateId("evt"), event.email || null, event.inviteId || null, event.eventType, JSON.stringify(event.meta || {})).run();
  } catch (e) { /* best effort */ }
}

/* =========================================================
   TTS HANDLER (improved error codes)
========================================================= */

async function fetchAccountFallbackVoiceId(apiKey, attemptedVoiceId) {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    });
    if (!response.ok) return "";
    const payload = await response.json().catch(() => null);
    const voices = payload && Array.isArray(payload.voices) ? payload.voices : [];
    const candidates = voices
      .filter((v) => v && typeof v.voice_id === "string" && v.voice_id && v.voice_id !== attemptedVoiceId)
      .map((v) => v.voice_id);
    if (!candidates.length) return "";
    return candidates[Math.floor(Math.random() * candidates.length)] || "";
  } catch (e) { return ""; }
}

async function handleTTS(request, env) {
  try {
    const apiKey = String(env.ELEVENLABS_API_KEY || "").trim().replace(/^['"]|['"]$/g, "").replace(/^Bearer\s+/i, "");
    if (!apiKey) return json({ ok: false, error: "TTS_PROVIDER_ERROR", message: "Missing API key" }, 500);

    const payload = await request.json().catch(() => ({}));
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const voiceId = typeof payload.voiceId === "string" ? payload.voiceId.trim() : "";
    const emotion = typeof payload.emotion === "string" ? payload.emotion.trim().toLowerCase() : "neutral";
    const speed = Number.isFinite(Number(payload.speed)) ? Number(payload.speed) : 1;
    const rawLang = typeof payload.languageCode === "string" ? payload.languageCode.trim().toLowerCase() : "";
    const languageCode = rawLang.split("-")[0] || "";
    const modelId = typeof payload.modelId === "string" ? payload.modelId.trim() : "";

    if (!text || !voiceId) return json({ ok: false, error: "INVALID_REQUEST", message: "Missing text or voiceId" }, 400);

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

    const voiceCandidates = [voiceId];
    let accountFallbackVoiceId = "";
    let lastStatus = 502;
    let lastDetail = "ElevenLabs request failed";
    let usedFallback = false;

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
            const headers = {
              "Content-Type": "audio/mpeg",
              "Cache-Control": "no-store",
              "X-Elevenlabs-Model": candidateModel,
              "X-Elevenlabs-Language": candidateLang || "default",
              "X-Elevenlabs-Voice": candidateVoice,
            };
            if (candidateVoice !== voiceId) {
              headers["X-Used-Fallback"] = "true";
              headers["X-Fallback-Voice"] = candidateVoice;
            }
            return new Response(response.body, { status: 200, headers });
          }

          const rawDetail = await response.text().catch(() => "");
          let parsed = null;
          try { parsed = rawDetail ? JSON.parse(rawDetail) : null; } catch (e) {}
          const detail = toText((parsed && (parsed.detail || parsed.message || parsed.error)) || rawDetail || `ElevenLabs error ${response.status}`);
          lastStatus = response.status;
          lastDetail = detail;

          if (response.status === 404 && candidateVoice === voiceId) {
            if (!accountFallbackVoiceId) accountFallbackVoiceId = await fetchAccountFallbackVoiceId(apiKey, voiceId);
            if (accountFallbackVoiceId && !voiceCandidates.includes(accountFallbackVoiceId)) {
              voiceCandidates.push(accountFallbackVoiceId);
              usedFallback = true;
            }
          }

          if (response.status === 401 || response.status === 403) {
            return json({ ok: false, error: "TTS_PROVIDER_ERROR", message: `Auth error ${response.status}`, details: detail }, 502);
          }
        }
      }
    }

    const errorCode = lastStatus === 404 ? "VOICE_UNAVAILABLE" : "TTS_PROVIDER_ERROR";
    return json({ ok: false, error: errorCode, message: lastDetail, fallbackTried: usedFallback, status: lastStatus }, 502);
  } catch (error) {
    return json({ ok: false, error: "TTS_PROVIDER_ERROR", message: toText((error && error.message) || error) }, 500);
  }
}

/* =========================================================
   AUTH HANDLER (existing, with session cookie)
========================================================= */

const VERIFICATION_EMAIL_LANGS = new Set(["fr", "en", "es", "it", "de", "pt", "ja", "zh", "ko", "ar", "he", "ru"]);

function normalizeAuthEmailLang(raw) {
  const base = String(raw || "fr").toLowerCase().split("-")[0];
  return VERIFICATION_EMAIL_LANGS.has(base) ? base : "fr";
}

const VERIFICATION_EMAIL_TRANSLATIONS = {
  fr: {
    subject: "Ton code Castwing",
    title: "Voici ton code.",
    subtitle: "Colle-le dans Castwing pour te connecter.",
    expiry: "Ce code expire dans 10 minutes. Si tu n'as pas demandé à te connecter, ignore simplement ce message.",
    asideTitle: "Entre nous.",
    asideBody: "Castwing est quasi gratuit. Deux heures d'AI toutes les trois heures, juste en étant inscrit. Largement de quoi préparer une audition. Si un jour tu veux les voix premium ou la direction AI, Oscar est à 9,99 € par mois. Tant que t'en as pas besoin, n'en prends pas.",
    asideClose: "Bonnes prises. Décroche ce rôle.",
    signature: "— Solo + IA",
  },
  en: {
    subject: "Your Castwing code",
    title: "Here's your code.",
    subtitle: "Paste it into Castwing to sign in.",
    expiry: "This code expires in 10 minutes. If you didn't request it, just ignore this email.",
    asideTitle: "Between us.",
    asideBody: "Castwing is nearly free. Two hours of AI every three hours, just for being signed up. Plenty to prep an audition. If one day you want premium voices or AI direction, Oscar is €9.99/month. Until you need it, don't buy it.",
    asideClose: "Break a leg. Land the role.",
    signature: "— Solo + AI",
  },
  es: {
    subject: "Tu código Castwing",
    title: "Aquí está tu código.",
    subtitle: "Pégalo en Castwing para iniciar sesión.",
    expiry: "Este código expira en 10 minutos. Si no lo solicitaste, ignora este mensaje.",
    asideTitle: "Entre nosotros.",
    asideBody: "Castwing es casi gratis. Dos horas de IA cada tres horas, solo por estar inscrito. Suficiente para preparar una audición. Si algún día quieres voces premium o dirección de escena AI, Oscar cuesta 9,99 € al mes. Mientras no lo necesites, no lo tomes.",
    asideClose: "Mucha mierda. A por ese papel.",
    signature: "— Solo + IA",
  },
  it: {
    subject: "Il tuo codice Castwing",
    title: "Ecco il tuo codice.",
    subtitle: "Incollalo in Castwing per accedere.",
    expiry: "Questo codice scade tra 10 minuti. Se non l'hai richiesto, ignora questo messaggio.",
    asideTitle: "Tra noi.",
    asideBody: "Castwing è quasi gratuito. Due ore di IA ogni tre ore, solo per essere iscritto. Più che sufficiente per preparare un'audizione. Se un giorno vuoi le voci premium o la direzione AI, Oscar costa 9,99 € al mese. Finché non ti serve, non prenderlo.",
    asideClose: "In bocca al lupo. Prendi quel ruolo.",
    signature: "— Solo + IA",
  },
  de: {
    subject: "Dein Castwing-Code",
    title: "Hier ist dein Code.",
    subtitle: "Füge ihn in Castwing ein, um dich anzumelden.",
    expiry: "Dieser Code läuft in 10 Minuten ab. Wenn du ihn nicht angefordert hast, ignoriere diese Nachricht.",
    asideTitle: "Unter uns.",
    asideBody: "Castwing ist fast kostenlos. Zwei Stunden KI alle drei Stunden, einfach weil du angemeldet bist. Mehr als genug für eine Audition-Vorbereitung. Wenn du eines Tages Premium-Stimmen oder KI-Regie willst, Oscar kostet 9,99 € pro Monat. Solange du es nicht brauchst, kauf es nicht.",
    asideClose: "Toi, toi, toi. Hol dir die Rolle.",
    signature: "— Solo + KI",
  },
  pt: {
    subject: "Seu código Castwing",
    title: "Aqui está seu código.",
    subtitle: "Cole-o no Castwing para entrar.",
    expiry: "Este código expira em 10 minutos. Se você não o solicitou, ignore esta mensagem.",
    asideTitle: "Entre nós.",
    asideBody: "Castwing é quase gratuito. Duas horas de IA a cada três horas, apenas por estar registrado. Mais que suficiente para preparar uma audição. Se um dia quiser vozes premium ou direção AI, Oscar custa 9,99 € por mês. Até você precisar, não compre.",
    asideClose: "Merda! Pegue esse papel.",
    signature: "— Solo + IA",
  },
  ja: {
    subject: "Castwing 認証コード",
    title: "あなたのコード",
    subtitle: "Castwing に貼り付けてサインインしてください。",
    expiry: "このコードは10分で期限切れになります。リクエストしていない場合は無視してください。",
    asideTitle: "ここだけの話。",
    asideBody: "Castwing はほぼ無料で使えます。登録するだけで3時間ごとに2時間のAI。オーディション準備には十分です。プレミアム音声やAIディレクションが欲しくなったら、Oscarは月額9.99ユーロです。必要になるまで、買わなくて大丈夫。",
    asideClose: "頑張って。その役を勝ち取ろう。",
    signature: "— Solo + AI",
  },
  zh: {
    subject: "你的 Castwing 验证码",
    title: "这是你的验证码。",
    subtitle: "粘贴到 Castwing 中登录。",
    expiry: "此验证码将在 10 分钟后失效。如果不是你请求的,请忽略此邮件。",
    asideTitle: "悄悄话。",
    asideBody: "Castwing 几乎免费。注册就能每三小时获得两小时 AI 使用时间,足够准备一场试镜。如果哪天你想要高级语音或 AI 执导,Oscar 每月 9.99 欧元。不需要就别买。",
    asideClose: "祝你好运。拿下那个角色。",
    signature: "— Solo + AI",
  },
  ko: {
    subject: "Castwing 인증 코드",
    title: "인증 코드를 보내드립니다.",
    subtitle: "Castwing에 붙여넣어 로그인하세요.",
    expiry: "이 코드는 10분 후 만료됩니다. 요청하지 않았다면 이 메일을 무시하셔도 됩니다.",
    asideTitle: "우리끼리 얘기.",
    asideBody: "Castwing은 거의 무료예요. 가입만 하면 3시간마다 2시간의 AI 사용이 가능해요. 오디션 준비에 충분하죠. 언젠가 프리미엄 음성이나 AI 디렉팅이 필요하면, Oscar가 월 9.99유로예요. 필요하기 전까진 사지 마세요.",
    asideClose: "행운을 빌어요. 그 역할 꼭 따내세요.",
    signature: "— Solo + AI",
  },
  ar: {
    subject: "رمز Castwing الخاص بك",
    title: "إليك رمزك.",
    subtitle: "الصقه في Castwing لتسجيل الدخول.",
    expiry: "ينتهي هذا الرمز خلال 10 دقائق. إذا لم تطلبه، تجاهل هذه الرسالة.",
    asideTitle: "بيننا.",
    asideBody: "Castwing مجاني تقريباً. ساعتان من الذكاء الاصطناعي كل ثلاث ساعات، فقط بالتسجيل. أكثر من كافٍ لتحضير اختبار أداء. إذا أردت يوماً أصواتاً مميزة أو إخراجاً بالذكاء الاصطناعي، Oscar بـ 9,99 € شهرياً. حتى تحتاجه، لا تشتريه.",
    asideClose: "بالتوفيق. احصل على الدور.",
    signature: "— Solo + AI",
  },
  he: {
    subject: "הקוד שלך ב-Castwing",
    title: "הנה הקוד שלך.",
    subtitle: "הדבק אותו ב-Castwing כדי להתחבר.",
    expiry: "הקוד פג תוקף בעוד 10 דקות. אם לא ביקשת, התעלם מההודעה הזו.",
    asideTitle: "בינינו.",
    asideBody: "Castwing כמעט חינם. שעתיים של AI כל שלוש שעות, רק על ידי הרשמה. מספיק בהחלט להכין אודישן. אם יום אחד תרצה קולות פרימיום או הכוונת AI, Oscar עולה 9.99 € לחודש. עד שתצטרך, אל תקנה.",
    asideClose: "בהצלחה. תשיג את התפקיד.",
    signature: "— Solo + AI",
  },
  ru: {
    subject: "Ваш код Castwing",
    title: "Вот ваш код.",
    subtitle: "Вставьте его в Castwing, чтобы войти.",
    expiry: "Код истечёт через 10 минут. Если вы его не запрашивали, просто проигнорируйте это письмо.",
    asideTitle: "Между нами.",
    asideBody: "Castwing почти бесплатный. Два часа ИИ каждые три часа, просто за регистрацию. Более чем достаточно, чтобы подготовить прослушивание. Если однажды захотите премиум-голоса или режиссуру ИИ, Oscar стоит 9,99 € в месяц. Пока не нужно — не покупайте.",
    asideClose: "Удачи. Получите эту роль.",
    signature: "— Solo + AI",
  },
};

function getVerificationEmailHtml(code, lang) {
  const safe = normalizeAuthEmailLang(lang);
  const t = VERIFICATION_EMAIL_TRANSLATIONS[safe] || VERIFICATION_EMAIL_TRANSLATIONS.fr;
  const dir = (safe === "ar" || safe === "he") ? "rtl" : "ltr";
  const escCode = String(code || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="${safe}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${t.subject}</title>
</head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'Inter','Helvetica Neue','Segoe UI','Noto Sans',system-ui,-apple-system,sans-serif;color:#0F1624;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF8;padding:48px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #EDEDEA;">
          <tr>
            <td style="padding:40px 40px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <div style="display:inline-block;position:relative;width:28px;height:28px;line-height:28px;text-align:center;">
                      <span style="font-family:'Inter','Helvetica Neue',sans-serif;font-size:26px;font-weight:700;color:#0F1624;letter-spacing:-0.04em;">C</span>
                      <span style="position:absolute;top:4px;right:-2px;width:5px;height:5px;background:#E63946;border-radius:50%;"></span>
                    </div>
                  </td>
                  <td style="vertical-align:middle;padding-left:8px;padding-bottom:2px;">
                    <span style="font-size:19px;font-weight:600;letter-spacing:-0.02em;color:#0F1624;">ast<em style="font-style:italic;font-weight:500;color:#4A7C59;">wing</em></span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 8px;">
              <h1 style="margin:0;font-size:24px;font-weight:600;color:#0F1624;letter-spacing:-0.015em;line-height:1.3;">${t.title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0;font-size:15px;color:#6B7280;line-height:1.5;letter-spacing:-0.005em;">${t.subtitle}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <div style="background:#FAFAF8;border:1px solid #EDEDEA;border-radius:12px;padding:28px 24px;text-align:center;">
                <div style="font-family:'SF Mono','JetBrains Mono','Menlo','Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:12px;color:#0F1624;line-height:1;padding-left:12px;">${escCode}</div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.5;">${t.expiry}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px;"><div style="height:1px;background:#EDEDEA;"></div></td>
          </tr>
          <tr>
            <td style="padding:28px 40px 32px;">
              <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#0F1624;letter-spacing:-0.005em;">${t.asideTitle}</p>
              <p style="margin:0;font-size:13.5px;color:#4B5563;line-height:1.65;">${t.asideBody}</p>
              <p style="margin:16px 0 0;font-size:13.5px;color:#4B5563;line-height:1.65;">${t.asideClose}</p>
              <p style="margin:14px 0 0;font-size:13.5px;color:#0F1624;font-weight:500;">${t.signature}</p>
            </td>
          </tr>
          <tr>
            <td style="background:#FAFAF8;border-top:1px solid #EDEDEA;padding:20px 40px;text-align:center;border-radius:0 0 16px 16px;">
              <p style="margin:0;font-size:11px;color:#9CA3AF;line-height:1.5;letter-spacing:0.01em;">
                <a href="https://cast-wing.com" style="color:#4A7C59;text-decoration:none;font-weight:500;">cast-wing.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendResendEmail(apiKey, fromEmail, toEmail, code, lang) {
  const safeLang = normalizeAuthEmailLang(lang);
  const t = VERIFICATION_EMAIL_TRANSLATIONS[safeLang] || VERIFICATION_EMAIL_TRANSLATIONS.fr;
  const html = getVerificationEmailHtml(code, safeLang);
  const rsp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: `Castwing <${fromEmail}>`,
      to: [toEmail],
      subject: t.subject,
      html,
    }),
  });
  if (!rsp.ok) {
    try { console.error("Resend error:", await rsp.text()); } catch (e) { /* ignore */ }
  }
  return rsp.ok;
}

async function ensureUserAuthColumns(db) {
  if (!db) return;
  try {
    const info = await db.prepare("PRAGMA table_info(users)").all();
    const names = new Set((info.results || []).map((c) => c.name));
    if (!names.has("tier")) {
      try { await db.prepare("ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'audition'").run(); } catch (e) { /* ignore */ }
    }
    if (!names.has("last_login_at")) {
      try { await db.prepare("ALTER TABLE users ADD COLUMN last_login_at INTEGER").run(); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

async function upsertAuthUserRecord(env, email) {
  if (!env.DB) return { isNewUser: null, userId: null, tier: null };
  await ensureUserAuthColumns(env.DB);
  const nowMs = Date.now();
  const existing = await env.DB.prepare("SELECT id, tier FROM users WHERE lower(email) = ?").bind(email).first();
  if (existing && existing.id) {
    try {
      await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(nowMs, existing.id).run();
    } catch (e) { /* ignore */ }
    return { isNewUser: false, userId: existing.id, tier: existing.tier || "audition" };
  }
  const userId = generateId("u");
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, email, is_admin, tier, last_login_at, created_at) VALUES (?, ?, 0, ?, ?, datetime('now'))"
    ).bind(userId, email, "audition", nowMs).run();
  } catch (e) {
    try {
      const again = await env.DB.prepare("SELECT id, tier FROM users WHERE lower(email) = ?").bind(email).first();
      if (again && again.id) {
        await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(nowMs, again.id).run();
        return { isNewUser: false, userId: again.id, tier: again.tier || "audition" };
      }
    } catch (e2) { /* ignore */ }
    console.error("upsertAuthUser insert:", e);
    return { isNewUser: null, userId: null, tier: null };
  }
  return { isNewUser: true, userId, tier: "audition" };
}

/* =========================================================
   GOOGLE OAUTH — Verify ID token from Google Identity Services
========================================================= */

const GOOGLE_CLIENT_ID = "690445077464-pg7tjrp06tfhd9nq0k626bsa9qlia4s5.apps.googleusercontent.com";

async function handleGoogleAuth(request, env) {
  try {
    const payload = await request.json().catch(() => ({}));
    const idToken = String(payload.idToken || "").trim();
    if (!idToken) return json({ ok: false, error: "Missing token" }, 400);

    const tokenInfo = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!tokenInfo.ok) return json({ ok: false, error: "Invalid Google token" }, 401);

    const claims = await tokenInfo.json();

    if (claims.aud !== GOOGLE_CLIENT_ID) return json({ ok: false, error: "Token audience mismatch" }, 401);
    if (!claims.email || claims.email_verified !== "true") return json({ ok: false, error: "Email not verified by Google" }, 401);

    const email = claims.email.toLowerCase().trim();
    const setCookie = await createSignedSessionCookie(email, env);
    const authMeta = await upsertAuthUserRecord(env, email);
    const body = { ok: true, email };
    if (authMeta.isNewUser !== null && authMeta.isNewUser !== undefined) {
      body.isNewUser = authMeta.isNewUser;
      body.userId = authMeta.userId;
      body.tier = authMeta.tier;
    }
    return json(body, 200, { "Set-Cookie": setCookie });
  } catch (error) {
    return json({ error: toText((error && error.message) || error) }, 500);
  }
}

async function handleAuth(request, env) {
  try {
    const payload = await request.json().catch(() => ({}));
    const action = String(payload.action || "").trim().toLowerCase();
    const email = String(payload.email || "").trim().toLowerCase();

    if (!["request_code", "verify_code"].includes(action)) return json({ error: "Invalid action" }, 400);
    if (!isEmail(email)) return json({ error: "Invalid email" }, 400);

    if (action === "request_code") {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const lang = normalizeAuthEmailLang(payload.lang);

      if (env.AUTH_KV) {
        await env.AUTH_KV.put(`auth_code:${email}`, code, { expirationTtl: 600 });
      }

      const resendKey = String(env.RESEND_API_KEY || "").trim();
      const fromEmail = String(env.AUTH_FROM_EMAIL || "").trim();
      if (!resendKey || !fromEmail) {
        return json({ ok: false, error: "Email service not configured" }, 500);
      }
      const sent = await sendResendEmail(resendKey, fromEmail, email, code, lang);
      if (!sent) {
        return json({ ok: false, error: "Envoi email échoué" }, 500);
      }
      return json({ ok: true, delivery: "email" });
    }

    const code = String(payload.code || "").trim();
    if (!code) return json({ ok: false, error: "Missing code" }, 400);

    if (env.AUTH_KV) {
      const stored = await env.AUTH_KV.get(`auth_code:${email}`);
      if (!stored || stored !== code) {
        return json({ ok: false, error: "Code invalide ou expiré" }, 401);
      }
      await env.AUTH_KV.delete(`auth_code:${email}`);
    } else {
      const token = String(payload.token || "");
      if (!token) return json({ ok: false, error: "Missing token" }, 400);
      const secret = String(env.AUTH_CODE_SECRET || "dev-auth-secret-change-me");
      let parsed;
      try { parsed = JSON.parse(b64urlDecode(token)); } catch (e) { return json({ ok: false, error: "Invalid token" }, 400); }
      if (!parsed || parsed.email !== email || Number(parsed.exp || 0) < Date.now()) {
        return json({ ok: false, error: "Token expired or mismatched" }, 400);
      }
      const expected = await sha256Hex(`${email}|${code}|${parsed.exp}|${secret}`);
      if (expected !== parsed.sig) return json({ ok: false, error: "Invalid code" }, 401);
    }

    const setCookie = await createSignedSessionCookie(email, env);
    const authMeta = await upsertAuthUserRecord(env, email);
    const extra = {};
    if (authMeta.isNewUser !== null && authMeta.isNewUser !== undefined) {
      extra.isNewUser = authMeta.isNewUser;
      extra.userId = authMeta.userId;
      extra.email = email;
      extra.tier = authMeta.tier;
    }
    return json({ ok: true, ...extra }, 200, { "Set-Cookie": setCookie });
  } catch (error) {
    return json({ error: toText((error && error.message) || error) }, 500);
  }
}

/* =========================================================
   SESSION ROUTE
========================================================= */

async function handleSession(request, env) {
  const state = await getSessionState(request, env);
  return json({ ok: true, ...state });
}

/* =========================================================
   INVITE ROUTES
========================================================= */

async function handleCreateInvite(request, env) {
  const session = await getSessionState(request, env);
  if (!session.isAdmin) return json({ ok: false, error: "Forbidden" }, 403);
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);

  const payload = await request.json().catch(() => ({}));
  const label = String(payload.label || "").trim() || "Invite";
  const emailRestriction = payload.emailRestriction ? String(payload.emailRestriction).trim().toLowerCase() : null;
  const creditsGranted = Math.max(1, Math.min(9999, parseInt(payload.creditsGranted) || 25));
  const expiresAt = payload.expiresAt ? String(payload.expiresAt) : null;

  const rawToken = generateRandomToken();
  const tokenHash = await sha256Hex(rawToken);
  const inviteId = generateId("inv");

  await env.DB.prepare(
    `INSERT INTO invites (id, token_hash, label, email_restriction, credits_granted, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(inviteId, tokenHash, label, emailRestriction, creditsGranted, expiresAt, session.email).run();

  return json({
    ok: true,
    inviteId,
    inviteUrl: `https://cast-wing.com/?invite=${rawToken}`,
    inviteCode: rawToken,
  });
}

async function handleListInvites(request, env) {
  const session = await getSessionState(request, env);
  if (!session.isAdmin) return json({ ok: false, error: "Forbidden" }, 403);
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);

  const rows = await env.DB.prepare(
    `SELECT i.id, i.label, i.email_restriction, i.credits_granted, i.revoked, i.expires_at, i.created_at,
            COALESCE(SUM(r.credits_used), 0) as credits_used,
            COUNT(r.id) as redemption_count
     FROM invites i LEFT JOIN invite_redemptions r ON r.invite_id = i.id
     GROUP BY i.id ORDER BY i.created_at DESC LIMIT 100`
  ).all();

  return json({
    ok: true,
    invites: (rows.results || []).map(r => ({
      id: r.id, label: r.label, emailRestriction: r.email_restriction,
      creditsGranted: r.credits_granted, creditsUsed: r.credits_used,
      revoked: !!r.revoked, expiresAt: r.expires_at, createdAt: r.created_at,
      redemptionCount: r.redemption_count,
    })),
  });
}

async function handleRevokeInvite(request, env) {
  const session = await getSessionState(request, env);
  if (!session.isAdmin) return json({ ok: false, error: "Forbidden" }, 403);
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);

  const payload = await request.json().catch(() => ({}));
  const inviteId = String(payload.inviteId || "").trim();
  if (!inviteId) return json({ ok: false, error: "Missing inviteId" }, 400);

  await env.DB.prepare(`UPDATE invites SET revoked = 1 WHERE id = ?`).bind(inviteId).run();
  return json({ ok: true });
}

async function handleRedeemInvite(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);

  const payload = await request.json().catch(() => ({}));
  const rawToken = String(payload.token || "").trim();
  const email = String(payload.email || "").trim().toLowerCase();
  if (!rawToken) return json({ ok: false, error: "Missing token" }, 400);

  const tokenHash = await sha256Hex(rawToken);
  const invite = await env.DB.prepare(
    `SELECT * FROM invites WHERE token_hash = ?`
  ).bind(tokenHash).first();

  if (!invite) return json({ ok: false, error: "Invalid invite" }, 404);
  if (invite.revoked) return json({ ok: false, error: "Invite revoked" }, 410);
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return json({ ok: false, error: "Invite expired" }, 410);
  }
  if (invite.email_restriction && email && invite.email_restriction !== email) {
    return json({ ok: false, error: "Email does not match invite restriction" }, 403);
  }

  let redemption = null;
  if (email) {
    redemption = await env.DB.prepare(
      `SELECT * FROM invite_redemptions WHERE invite_id = ? AND email = ?`
    ).bind(invite.id, email).first();
  }

  if (!redemption) {
    const redemptionId = generateId("red");
    const redeemEmail = email || null;
    await env.DB.prepare(
      `INSERT INTO invite_redemptions (id, invite_id, email, credits_used, redeemed_at, last_used_at)
       VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))`
    ).bind(redemptionId, invite.id, redeemEmail).run();
    redemption = { id: redemptionId, credits_used: 0 };
  }

  const remaining = Math.max(0, (invite.credits_granted || 0) - (redemption.credits_used || 0));

  const headers = {};
  if (email) {
    headers["Set-Cookie"] = await createSignedSessionCookie(email, env);
  }

  return json({
    ok: true,
    creditsRemaining: remaining,
    inviteLabel: invite.label,
    expiresAt: invite.expires_at,
  }, 200, headers);
}

/* =========================================================
   CREDITS CONSUME
========================================================= */

async function handleCreditsConsume(request, env) {
  const session = await getSessionState(request, env);

  if (session.isAdmin) {
    return json({ ok: true, creditsRemaining: null, plan: "admin" });
  }

  if (!env.DB) return json({ ok: true, creditsRemaining: null, plan: session.plan });

  if (session.plan !== "tester" || !session.email) {
    return json({ ok: true, creditsRemaining: null, plan: session.plan });
  }

  const redemption = await env.DB.prepare(
    `SELECT r.id, r.credits_used, i.credits_granted, i.id as invite_id
     FROM invite_redemptions r JOIN invites i ON r.invite_id = i.id
     WHERE r.email = ? AND i.revoked = 0
     ORDER BY r.redeemed_at DESC LIMIT 1`
  ).bind(session.email).first();

  if (!redemption) return json({ ok: false, error: "NO_CREDITS", message: "No active invite" }, 402);

  const remaining = (redemption.credits_granted || 0) - (redemption.credits_used || 0);
  if (remaining <= 0) return json({ ok: false, error: "NO_CREDITS", message: "No credits left", creditsRemaining: 0 }, 402);

  await env.DB.prepare(
    `UPDATE invite_redemptions SET credits_used = credits_used + 1, last_used_at = datetime('now') WHERE id = ?`
  ).bind(redemption.id).run();

  const payload = await request.json().catch(() => ({}));
  await logUsageEvent(env.DB, {
    email: session.email, inviteId: redemption.invite_id,
    eventType: payload.kind || "tts_line", meta: { voiceId: payload.voiceId },
  });

  return json({ ok: true, creditsRemaining: remaining - 1 });
}

/* =========================================================
   D1 MIGRATION HELPER
========================================================= */

async function ensureD1Tables(db) {
  if (!db) return;
  try {
    await db.prepare(`SELECT 1 FROM users LIMIT 1`).first();
  } catch (e) {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, is_admin INTEGER DEFAULT 0, tier TEXT DEFAULT 'audition', last_login_at INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT, email_restriction TEXT, credits_granted INTEGER NOT NULL DEFAULT 0, expires_at TEXT, revoked INTEGER DEFAULT 0, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS invite_redemptions (id TEXT PRIMARY KEY, invite_id TEXT NOT NULL, email TEXT, credits_used INTEGER DEFAULT 0, redeemed_at TEXT DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, FOREIGN KEY (invite_id) REFERENCES invites(id))`,
      `CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, email TEXT, invite_id TEXT, event_type TEXT NOT NULL, meta_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    ];
    for (const sql of statements) {
      try { await db.prepare(sql).run(); } catch (ee) { /* ignore */ }
    }
  }
}

/* =========================================================
   MAIN FETCH HANDLER
========================================================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    let clientScheme = url.protocol.replace(":", "");
    try {
      const cfv = request.headers.get("cf-visitor");
      if (cfv) { const p = JSON.parse(cfv); if (p && p.scheme) clientScheme = p.scheme; }
    } catch (_) {}
    if (clientScheme === "http" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    if (env.DB) await ensureD1Tables(env.DB);

    if (url.pathname === "/api/geo" && request.method === "GET") {
      const country = (request.cf && request.cf.country) ? request.cf.country : "";
      const acceptLanguage = request.headers.get("Accept-Language") || "";
      return json({ country, acceptLanguage });
    }

    if (url.pathname === "/api/tts" && request.method === "POST") return handleTTS(request, env);
    if (url.pathname === "/api/auth" && request.method === "POST") return handleAuth(request, env);
    if (url.pathname === "/api/auth/google" && request.method === "POST") return handleGoogleAuth(request, env);
    if (url.pathname === "/api/session" && request.method === "GET") return handleSession(request, env);
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }
    if (url.pathname === "/api/credits/consume" && request.method === "POST") return handleCreditsConsume(request, env);
    if (url.pathname === "/api/invite/redeem" && request.method === "POST") return handleRedeemInvite(request, env);
    if (url.pathname === "/api/admin/create-invite" && request.method === "POST") return handleCreateInvite(request, env);
    if (url.pathname === "/api/admin/list-invites" && request.method === "GET") return handleListInvites(request, env);
    if (url.pathname === "/api/admin/revoke-invite" && request.method === "POST") return handleRevokeInvite(request, env);

    const apiPaths = ["/api/tts", "/api/geo", "/api/auth", "/api/auth/google", "/api/session", "/api/credits/consume", "/api/invite/redeem", "/api/admin/"];
    if (apiPaths.some(p => url.pathname.startsWith(p))) {
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const newResponse = new Response(assetResponse.body, assetResponse);
      newResponse.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      newResponse.headers.set("Pragma", "no-cache");
      return newResponse;
    }
    return assetResponse;
  },
};
