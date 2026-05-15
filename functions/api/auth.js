function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
      subject: "CitizenTape verification code",
      html: `<p>Your CitizenTape verification code is: <b>${code}</b></p><p>This code expires in 10 minutes.</p>`,
    }),
  });
  return rsp.ok;
}

export async function onRequestPost(context) {
  try {
    const payload = await context.request.json().catch(() => ({}));
    const action = String(payload.action || "").trim().toLowerCase();
    const email = String(payload.email || "").trim().toLowerCase();
    const secret = String(context.env.AUTH_CODE_SECRET || "dev-auth-secret-change-me");

    if (!["request_code", "verify_code"].includes(action)) {
      return json({ error: "Invalid action" }, 400);
    }
    if (!isEmail(email)) {
      return json({ error: "Invalid email" }, 400);
    }

    if (action === "request_code") {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const exp = Date.now() + 10 * 60 * 1000;
      const sig = await sha256Hex(`${email}|${code}|${exp}|${secret}`);
      const token = b64urlEncode(JSON.stringify({ email, exp, sig }));

      const resendKey = String(context.env.RESEND_API_KEY || "").trim();
      const fromEmail = String(context.env.AUTH_FROM_EMAIL || "").trim();
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
    return json({ error: String(error && error.message ? error.message : error || "Unexpected error") }, 500);
  }
}
