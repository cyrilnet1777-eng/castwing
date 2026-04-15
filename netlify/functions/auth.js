const crypto = require("crypto");

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function b64urlEncode(text) {
  return Buffer.from(String(text || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(text) {
  const padded = String(text || "").replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((String(text || "").length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex");
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const payload = JSON.parse(event.body || "{}");
    const action = String(payload.action || "").trim().toLowerCase();
    const email = String(payload.email || "").trim().toLowerCase();
    const secret = String(process.env.AUTH_CODE_SECRET || "dev-auth-secret-change-me");

    if (!["request_code", "verify_code"].includes(action)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid action" }) };
    }
    if (!isEmail(email)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid email" }) };
    }

    if (action === "request_code") {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const exp = Date.now() + 10 * 60 * 1000;
      const sig = sha256Hex(`${email}|${code}|${exp}|${secret}`);
      const token = b64urlEncode(JSON.stringify({ email, exp, sig }));

      const resendKey = String(process.env.RESEND_API_KEY || "").trim();
      const fromEmail = String(process.env.AUTH_FROM_EMAIL || "").trim();
      if (resendKey && fromEmail) {
        const ok = await sendResendEmail(resendKey, fromEmail, email, code);
        if (!ok) return { statusCode: 502, body: JSON.stringify({ error: "Unable to send email code" }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, token, delivery: "email" }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, token, delivery: "debug", debugCode: code }) };
    }

    const token = String(payload.token || "");
    const code = String(payload.code || "").trim();
    if (!token || !code) return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing token or code" }) };
    let parsed;
    try {
      parsed = JSON.parse(b64urlDecode(token));
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid token" }) };
    }
    if (!parsed || parsed.email !== email || Number(parsed.exp || 0) < Date.now()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Token expired or mismatched" }) };
    }
    const expected = sha256Hex(`${email}|${code}|${parsed.exp}|${secret}`);
    if (expected !== parsed.sig) return { statusCode: 401, body: JSON.stringify({ ok: false, error: "Invalid code" }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e && e.message ? e.message : e || "Unexpected error") }) };
  }
};
