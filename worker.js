/* =========================================================
   CITIZENTAPE WORKER — Backend
   Routes: /api/tts, /api/claude-parse-script (pdfText → Claude JSON),
           /api/parse-screenplay (multipart PDF or JSON text → Claude native PDF reading),
           /api/parse-script (multipart legacy), /api/auth, /api/auth/google,
           /api/geo, /api/session, /api/credits/consume,
           /api/invite/redeem,
           /api/admin/create-invite, /api/admin/list-invites,
           /api/admin/revoke-invite
========================================================= */

// In-memory rate limiter (replaces KV-based rate limiting to avoid free-tier exhaustion)
const _rateCounters = new Map();
function rateCheck(key, maxCount, windowSec) {
  const now = Date.now();
  // Lazy cleanup: purge stale entries when map grows large
  if (_rateCounters.size > 200) {
    for (const [k, v] of _rateCounters) {
      if (now - v.start > 300000) _rateCounters.delete(k);
    }
  }
  let entry = _rateCounters.get(key);
  if (!entry || now - entry.start > windowSec * 1000) {
    entry = { start: now, count: 0 };
    _rateCounters.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxCount;
}

// In-memory Anthropic concurrency semaphore (replaces KV-based semaphore)
let _anthropicConcurrent = 0;

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

function getAnthropicKey(env) {
  const multi = String(env.ANTHROPIC_API_KEYS || "").trim().replace(/^['"]|['"]$/g, "");
  if (multi) {
    const keys = multi.split(",").map(k => k.trim().replace(/^['"]|['"]$/g, "")).filter(k => k.startsWith("sk-"));
    if (keys.length) return keys[Math.floor(Math.random() * keys.length)];
  }
  const single = String(env.ANTHROPIC_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
  if (single.includes(",")) {
    const keys = single.split(",").map(k => k.trim()).filter(k => k.startsWith("sk-"));
    if (keys.length) return keys[Math.floor(Math.random() * keys.length)];
  }
  return single;
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
  const secret = String(env.INVITE_SIGNING_SECRET || env.AUTH_CODE_SECRET || "");
  if (!secret) throw new Error("Session signing secret not configured");
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = JSON.stringify({ email: email.toLowerCase(), exp });
  const sig = await sha256Hex(payload + "|" + secret);
  const value = b64urlEncode(payload) + "." + sig;
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

async function readSignedSessionCookie(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) { console.log("[session] no cookie found"); return null; }
  const parts = match[1].split(".");
  if (parts.length !== 2) { console.log("[session] cookie malformed"); return null; }
  try {
    const payload = b64urlDecode(parts[0]);
    const secret = String(env.INVITE_SIGNING_SECRET || env.AUTH_CODE_SECRET || "");
    const expected = await sha256Hex(payload + "|" + secret);
    if (expected !== parts[1]) { console.log("[session] sig mismatch"); return null; }
    const parsed = JSON.parse(payload);
    if (!parsed.email) { console.log("[session] no email in payload"); return null; }
    if (parsed.exp && parsed.exp < Date.now()) { console.log("[session] expired"); return null; }
    return parsed.email.toLowerCase();
  } catch (e) {
    console.log("[session] parse error", e);
    return null;
  }
}

async function resolveCurrentUser(request, env) {
  const email = await readSignedSessionCookie(request, env);
  return email || null;
}

/* =========================================================
   CREDIT SYSTEM — Pricing & Helpers
========================================================= */

const CREDIT_PRICING = {
  TTS_COST_PER_1K_CHARS_CENTS: 30,   // $0.30/1K chars (3x ElevenLabs cost)
  FREE_SIGNUP_GRANT_CENTS: 150,       // $1.50 free credit on signup
};

/* ── Polar product mapping ── */
const POLAR_PACKS = {
  pack_5:  { product_id: "7bd95b3c-100d-46a9-887c-50c3ee1a2b19", amount_cents: 500,  label: "$5 credit pack" },
  pack_10: { product_id: "816fcdb6-707b-4286-bc44-2aaa8b07584a", amount_cents: 1000, label: "$10 credit pack" },
  pack_25: { product_id: "74e79ddc-8e62-4a4d-84dc-14cc6122bb9d", amount_cents: 2500, label: "$25 credit pack" },
};

/* ── Stripe packs (kept for reference) ── */
// const STRIPE_PACKS = {
//   pack_5:  { amount_cents: 500,  label: "$5 credit pack" },
//   pack_10: { amount_cents: 1000, label: "$10 credit pack" },
//   pack_25: { amount_cents: 2500, label: "$25 credit pack" },
// };

async function getCreditBalance(db, email) {
  if (!db || !email) return { balance_cents: 0 };
  try {
    const result = await db.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) as balance FROM credit_transactions WHERE lower(email) = ?"
    ).bind(email.toLowerCase()).first();
    return { balance_cents: result ? result.balance : 0 };
  } catch (e) { return { balance_cents: 0 }; }
}

async function handleCreditsBalance(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  const { balance_cents } = await getCreditBalance(env.DB, email);
  let transactions = [];
  if (env.DB) {
    try {
      const recent = await env.DB.prepare(
        `SELECT id, amount_cents, type, description, char_count, created_at
         FROM credit_transactions WHERE lower(email) = ?
         ORDER BY created_at DESC LIMIT 20`
      ).bind(email.toLowerCase()).all();
      transactions = recent.results || [];
    } catch (e) { /* table may not exist yet */ }
  }
  return json({
    ok: true,
    balance_cents,
    balance_display: "$" + (balance_cents / 100).toFixed(2),
    transactions,
  });
}

/* =========================================================
   POLAR INTEGRATION
========================================================= */

async function verifyPolarWebhook(body, headers, secret) {
  // Standard Webhooks spec: HMAC-SHA256 over "msg_id.timestamp.body"
  // Secret is base64-encoded (after stripping prefix)
  try {
    const msgId = headers.get("webhook-id") || "";
    const timestamp = headers.get("webhook-timestamp") || "";
    const signatures = headers.get("webhook-signature") || "";
    if (!msgId || !timestamp || !signatures) {
      console.error("[polar-wh] missing headers:", { msgId: !!msgId, timestamp: !!timestamp, signatures: !!signatures });
      return false;
    }
    // Reject if timestamp is more than 5 minutes old
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (age > 300) {
      console.error("[polar-wh] timestamp too old:", age, "seconds");
      return false;
    }
    // Polar SDK uses raw UTF-8 bytes of the full secret as the HMAC key
    // (it base64-encodes the whole string, then Standard Webhooks base64-decodes it back)
    const keyBytes = new TextEncoder().encode(secret);
    const signedContent = msgId + "." + timestamp + "." + body;
    const key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    // Check each space-separated signature (supports key rotation)
    for (const s of signatures.split(" ")) {
      const val = s.startsWith("v1,") ? s.slice(3) : null;
      if (val && val === expected) return true;
    }
    console.error("[polar-wh] signature mismatch. expected:", expected, "got:", signatures);
    return false;
  } catch (e) { console.error("[polar-wh] verify error:", e); return false; }
}

async function handleCreditsTopup(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  const polarKey = String(env.POLAR_ACCESS_TOKEN || "").trim();
  if (!polarKey) return json({ ok: false, error: "POLAR_NOT_CONFIGURED" }, 500);
  const payload = await request.json().catch(() => ({}));
  const packId = String(payload.pack || "").trim();
  const pack = POLAR_PACKS[packId];
  if (!pack) return json({ ok: false, error: "INVALID_PACK", valid: Object.keys(POLAR_PACKS) }, 400);

  const origin = new URL(request.url).origin;
  const rsp = await fetch("https://api.polar.sh/v1/checkouts/", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + polarKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      products: [pack.product_id],
      customer_email: email,
      success_url: origin + "/?payment=success",
      metadata: { email, pack: packId, amount_cents: String(pack.amount_cents) },
    }),
  });
  const session = await rsp.json().catch(() => ({}));
  if (!rsp.ok || !session.url) return json({ ok: false, error: "POLAR_ERROR", detail: session.detail || "" }, 502);
  return json({ ok: true, checkoutUrl: session.url, sessionId: session.id });
}

async function handlePolarReconcile(request, env) {
  // Called after checkout redirect — fetches recent orders from Polar and credits any missing ones
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  const polarKey = String(env.POLAR_ACCESS_TOKEN || "").trim();
  if (!polarKey || !env.DB) return json({ ok: false, error: "NOT_CONFIGURED" }, 500);
  try {
    const rsp = await fetch("https://api.polar.sh/v1/orders/?limit=10&sorting=-created_at", {
      headers: { "Authorization": "Bearer " + polarKey },
    });
    const data = await rsp.json().catch(() => ({}));
    if (!data.items) return json({ ok: false, error: "POLAR_API_ERROR" }, 502);
    let credited = 0;
    for (const order of data.items) {
      if (order.status !== "paid") continue;
      const orderEmail = ((order.metadata && order.metadata.email) || (order.customer && order.customer.email) || "").toLowerCase();
      if (orderEmail !== email.toLowerCase()) continue;
      const amountCents = parseInt((order.metadata && order.metadata.amount_cents) || "0") || (order.product_price && order.product_price.price_amount) || 0;
      if (!amountCents) continue;
      // Idempotency check
      try {
        const existing = await env.DB.prepare("SELECT id FROM credit_transactions WHERE stripe_session_id = ?").bind(order.id).first();
        if (existing) continue;
      } catch (e) {}
      const packId = (order.metadata && order.metadata.pack) || "";
      const pack = POLAR_PACKS[packId];
      try {
        await env.DB.prepare(
          `INSERT INTO credit_transactions (id, email, amount_cents, type, description, stripe_session_id, created_at)
           VALUES (?, ?, ?, 'topup', ?, ?, datetime('now'))`
        ).bind(generateId("ctx"), orderEmail, amountCents, pack ? pack.label : "$" + (amountCents / 100).toFixed(2) + " credit pack", order.id).run();
        credited++;
      } catch (e) { console.error("reconcile insert:", e); }
    }
    const { balance_cents } = await getCreditBalance(env.DB, email);
    return json({ ok: true, credited, balance_cents });
  } catch (e) { return json({ ok: false, error: "RECONCILE_ERROR" }, 500); }
}

async function handlePolarWebhook(request, env) {
  const webhookSecret = String(env.POLAR_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) return json({ error: "Not configured" }, 500);
  const body = await request.text();
  const verified = await verifyPolarWebhook(body, request.headers, webhookSecret);
  if (!verified) return json({ error: "Invalid signature" }, 400);

  const event = JSON.parse(body);
  // Handle order.paid — credit the user's account
  if (event.type === "order.paid") {
    const order = event.data;
    const email = ((order.metadata && order.metadata.email) || (order.customer && order.customer.email) || "").toLowerCase();
    const packId = (order.metadata && order.metadata.pack) || "";
    const amountCents = parseInt((order.metadata && order.metadata.amount_cents) || "0") || (order.total_amount || 0);
    if (!email || !amountCents || !env.DB) return json({ ok: true, skipped: "missing_data" });

    // Idempotency: check if this order was already processed
    try {
      const existing = await env.DB.prepare(
        "SELECT id FROM credit_transactions WHERE stripe_session_id = ?"
      ).bind(order.id).first();
      if (existing) return json({ ok: true, skipped: "already_processed" });
    } catch (e) {}

    const pack = POLAR_PACKS[packId];
    try {
      await env.DB.prepare(
        `INSERT INTO credit_transactions (id, email, amount_cents, type, description, stripe_session_id, created_at)
         VALUES (?, ?, ?, 'topup', ?, ?, datetime('now'))`
      ).bind(
        generateId("ctx"), email, amountCents,
        pack ? pack.label : "$" + (amountCents / 100).toFixed(2) + " credit pack",
        order.id
      ).run();
    } catch (e) { console.error("polar webhook insert:", e); }

    await logUsageEvent(env.DB, { email, eventType: "credit_topup", meta: { packId, amountCents, orderId: order.id } });
  }

  // Handle subscription events — activate metered billing
  if (event.type === "subscription.active" || event.type === "subscription.created") {
    const sub = event.data;
    const email = ((sub.metadata && sub.metadata.email) || (sub.customer && sub.customer.email) || "").toLowerCase();
    const isMeteredSub = sub.product && sub.product.id === POLAR_METERED_PRODUCT_ID;
    if (email && isMeteredSub && env.DB) {
      const customerId = (sub.customer && sub.customer.id) || "";
      await activateMeteredBilling(env.DB, email, customerId);
      await logUsageEvent(env.DB, { email, eventType: "metered_activated", meta: { subscriptionId: sub.id, customerId } });
    }
  }

  // Handle subscription cancellation — revert to credits
  if (event.type === "subscription.canceled" || event.type === "subscription.revoked") {
    const sub = event.data;
    const email = ((sub.metadata && sub.metadata.email) || (sub.customer && sub.customer.email) || "").toLowerCase();
    if (email && env.DB) {
      await env.DB.prepare("UPDATE users SET billing_mode = 'credits' WHERE lower(email) = ?").bind(email).run();
      await logUsageEvent(env.DB, { email, eventType: "metered_canceled", meta: { subscriptionId: sub.id } });
    }
  }

  return json({ ok: true });
}

/* =========================================================
   STRIPE INTEGRATION (commented out — kept for reference)
=========================================================

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = {};
    for (const item of sigHeader.split(",")) {
      const eq = item.indexOf("=");
      if (eq > 0) parts[item.slice(0, eq).trim()] = item.slice(eq + 1);
    }
    const timestamp = parts.t;
    const sig = parts.v1;
    if (!timestamp || !sig) return false;
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
    const signedPayload = timestamp + "." + payload;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
    return expected === sig;
  } catch (e) { return false; }
}

async function handleCreditsTopup_STRIPE(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  const stripeKey = String(env.STRIPE_SECRET_KEY || "").trim();
  if (!stripeKey) return json({ ok: false, error: "STRIPE_NOT_CONFIGURED" }, 500);
  const payload = await request.json().catch(() => ({}));
  const packId = String(payload.pack || "").trim();
  const pack = STRIPE_PACKS[packId];
  if (!pack) return json({ ok: false, error: "INVALID_PACK", valid: Object.keys(STRIPE_PACKS) }, 400);
  const customerId = await getOrCreateStripeCustomer(env.DB, email, stripeKey);
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.append("mode", "payment");
  if (customerId) params.append("customer", customerId);
  else params.append("customer_email", email);
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][product_data][name]", pack.label);
  params.append("line_items[0][price_data][unit_amount]", String(pack.amount_cents));
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", origin + "/?payment=success");
  params.append("cancel_url", origin + "/?payment=cancel");
  params.append("metadata[email]", email);
  params.append("metadata[pack]", packId);
  params.append("metadata[amount_cents]", String(pack.amount_cents));
  const rsp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + stripeKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const session = await rsp.json().catch(() => ({}));
  if (!rsp.ok) return json({ ok: false, error: "STRIPE_ERROR", detail: (session.error && session.error.message) || "" }, 502);
  return json({ ok: true, checkoutUrl: session.url, sessionId: session.id });
}

async function stripeRequest(path, params, stripeKey) {
  const rsp = await fetch("https://api.stripe.com/v1" + path, {
    method: "POST",
    headers: { "Authorization": "Bearer " + stripeKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return rsp.json().catch(() => ({}));
}

async function getOrCreateStripeCustomer(db, email, stripeKey) {
  if (db) {
    try {
      const row = await db.prepare("SELECT stripe_customer_id FROM users WHERE lower(email) = ?").bind(email.toLowerCase()).first();
      if (row && row.stripe_customer_id) return row.stripe_customer_id;
    } catch (e) {}
  }
  const searchRsp = await fetch("https://api.stripe.com/v1/customers?email=" + encodeURIComponent(email) + "&limit=1", {
    headers: { "Authorization": "Bearer " + stripeKey },
  });
  const searchData = await searchRsp.json().catch(() => ({}));
  if (searchData.data && searchData.data.length > 0) {
    const custId = searchData.data[0].id;
    if (db) try { await db.prepare("UPDATE users SET stripe_customer_id = ? WHERE lower(email) = ?").bind(custId, email.toLowerCase()).run(); } catch (e) {}
    return custId;
  }
  const params = new URLSearchParams();
  params.append("email", email);
  const cust = await stripeRequest("/customers", params, stripeKey);
  if (cust.id && db) {
    try { await db.prepare("UPDATE users SET stripe_customer_id = ? WHERE lower(email) = ?").bind(cust.id, email.toLowerCase()).run(); } catch (e) {}
  }
  return cust.id || null;
}

async function handleSetupCard(request, env) { ... }
async function handleAutoCharge(request, env) { ... }
async function handleStripeWebhook(request, env) { ... }

END STRIPE COMMENTED BLOCK */

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
          let creditBalance = 0;
          let autoTopupCents = 0;
          let billingMode = "credits";
          try { creditBalance = (await getCreditBalance(env.DB, email)).balance_cents; } catch (e) {}
          try { const u = await env.DB.prepare("SELECT auto_topup_cents, billing_mode FROM users WHERE lower(email) = ?").bind(email.toLowerCase()).first(); if (u) { autoTopupCents = u.auto_topup_cents || 0; billingMode = u.billing_mode || "credits"; } } catch (e) {}
          return { email, isAdmin: false, plan: "tester", creditsRemaining: remaining, inviteLabel: redemption.label, expiresAt: redemption.expires_at, creditBalance, autoTopupCents, billingMode };
        }
      }
    } catch (e) { /* DB not ready yet */ }
  }
  // Get credit balance and auto-topup setting for authenticated users
  let creditBalance = 0;
  let autoTopupCents = 0;
  try {
    const { balance_cents } = await getCreditBalance(env.DB, email);
    creditBalance = balance_cents;
  } catch (e) { /* ignore */ }
  let billingMode = "credits";
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT auto_topup_cents, billing_mode FROM users WHERE lower(email) = ?").bind(email.toLowerCase()).first();
      if (row) {
        autoTopupCents = row.auto_topup_cents || 0;
        billingMode = row.billing_mode || "credits";
      }
    } catch (e) { /* columns may not exist yet */ }
  }
  return { email, isAdmin: false, plan: "free", creditsRemaining: null, creditBalance, autoTopupCents, billingMode };
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

    // Credit metering
    const email = await resolveCurrentUser(request, env);
    const isAdmin = email && isAdminEmail(email, env);
    const charCount = text.length;
    const costCents = Math.max(1, Math.ceil((charCount / 1000) * CREDIT_PRICING.TTS_COST_PER_1K_CHARS_CENTS));

    // Check billing mode: metered users skip credit deduction
    const _isMetered = !isAdmin && email && await isMeteredUser(env.DB, email);

    // Atomic credit deduction: debit BEFORE making TTS call (prevents overdraft race condition)
    let _ttsDebitId = null;
    if (!isAdmin && !_isMetered && email && env.DB) {
      _ttsDebitId = generateId("ctx");
      try {
        const result = await env.DB.prepare(
          `INSERT INTO credit_transactions (id, email, amount_cents, type, description, char_count, created_at)
           SELECT ?, ?, ?, 'tts_debit', ?, ?, datetime('now')
           WHERE (SELECT COALESCE(SUM(amount_cents),0) FROM credit_transactions WHERE lower(email) = ?) >= ?`
        ).bind(_ttsDebitId, email.toLowerCase(), -costCents, "TTS " + charCount + " chars", charCount, email.toLowerCase(), costCents).run();
        if (!result.meta || !result.meta.changes) {
          const { balance_cents } = await getCreditBalance(env.DB, email);
          return json({
            ok: false, error: "INSUFFICIENT_CREDITS",
            balance_cents, cost_cents: costCents, char_count: charCount,
          }, 402);
        }
      } catch (e) {
        console.error("credit pre-debit:", e);
        const { balance_cents } = await getCreditBalance(env.DB, email);
        return json({ ok: false, error: "INSUFFICIENT_CREDITS", balance_cents, cost_cents: costCents, char_count: charCount }, 402);
      }
    }
    // Rate limit: max 30 TTS calls per minute per user (in-memory, no KV)
    if (!isAdmin && email) {
      if (!rateCheck(`tts:${email}`, 30, 60)) {
        if (_ttsDebitId && env.DB) try { await env.DB.prepare("DELETE FROM credit_transactions WHERE id = ?").bind(_ttsDebitId).run(); } catch(e) {}
        return json({ ok: false, error: "RATE_LIMIT", message: "Too many requests" }, 429);
      }
    }
    // Global rate limit: max 500 TTS calls per minute across all users (in-memory, no KV)
    if (!rateCheck("tts:global", 500, 60)) {
      if (_ttsDebitId && env.DB) try { await env.DB.prepare("DELETE FROM credit_transactions WHERE id = ?").bind(_ttsDebitId).run(); } catch(e) {}
      return json({ ok: false, error: "RATE_LIMIT", message: "High demand, try again in a moment" }, 429);
    }

    const emotionMap = {
      neutral: { stability: 0.58, similarity_boost: 0.74, style: 0.28, use_speaker_boost: true },
      excited: { stability: 0.18, similarity_boost: 0.82, style: 0.95, use_speaker_boost: true },
      sad:     { stability: 0.9,  similarity_boost: 0.46, style: 0.06, use_speaker_boost: true },
      angry:   { stability: 0.12, similarity_boost: 0.88, style: 1.0,  use_speaker_boost: true },
      whisper: { stability: 0.94, similarity_boost: 0.28, style: 0.0,  use_speaker_boost: false },
    };
    const base = emotionMap[emotion] || emotionMap.neutral;
    const voiceSettings = {
      stability:        base.stability,
      similarity_boost: base.similarity_boost,
      style:            base.style,
      use_speaker_boost: Boolean(base.use_speaker_boost),
      speed:            Math.max(0.7, Math.min(1.2, speed)),
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
            // Send usage event to Polar for metered users (fire-and-forget)
            if (_isMetered) sendPolarUsageEvent(env, email, charCount);
            // Credits already debited atomically before TTS call
            let newBalance = null;
            if (!isAdmin && !_isMetered && email && env.DB) {
              try { newBalance = (await getCreditBalance(env.DB, email)).balance_cents; } catch (e) {}
            }
            const headers = {
              "Content-Type": "audio/mpeg",
              "Cache-Control": "no-store",
              "X-Elevenlabs-Model": candidateModel,
              "X-Elevenlabs-Language": candidateLang || "default",
              "X-Elevenlabs-Voice": candidateVoice,
            };
            if (newBalance !== null) headers["X-Credits-Balance"] = String(newBalance);
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
            if (_ttsDebitId && env.DB) try { await env.DB.prepare("DELETE FROM credit_transactions WHERE id = ?").bind(_ttsDebitId).run(); } catch(e) {}
            return json({ ok: false, error: "TTS_PROVIDER_ERROR", message: `Auth error ${response.status}`, details: detail }, 502);
          }
        }
      }
    }

    // Refund pre-debited credits on TTS failure
    if (_ttsDebitId && env.DB) try { await env.DB.prepare("DELETE FROM credit_transactions WHERE id = ?").bind(_ttsDebitId).run(); } catch(e) {}
    const errorCode = lastStatus === 404 ? "VOICE_UNAVAILABLE" : "TTS_PROVIDER_ERROR";
    return json({ ok: false, error: errorCode, message: lastDetail, fallbackTried: usedFallback, status: lastStatus }, 502);
  } catch (error) {
    // Refund pre-debited credits on TTS failure
    if (_ttsDebitId && env.DB) try { await env.DB.prepare("DELETE FROM credit_transactions WHERE id = ?").bind(_ttsDebitId).run(); } catch(e) {}
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
    subject: "Ton code CitizenTape",
    title: "Voici ton code.",
    subtitle: "Colle-le dans CitizenTape pour te connecter.",
    expiry: "Ce code expire dans 10 minutes. Si tu n'as pas demandé à te connecter, ignore simplement ce message.",
    asideTitle: "Entre nous.",
    asideBody: "CitizenTape est quasi gratuit. Deux heures d'AI toutes les trois heures, juste en étant inscrit. Largement de quoi préparer une audition. Si un jour tu veux les voix premium ou la direction AI, Oscar est à 9,99 € par mois. Tant que t'en as pas besoin, n'en prends pas.",
    asideClose: "Bonnes prises. Décroche ce rôle.",
    signature: "— Solo + IA",
  },
  en: {
    subject: "Your CitizenTape code",
    title: "Here's your code.",
    subtitle: "Paste it into CitizenTape to sign in.",
    expiry: "This code expires in 10 minutes. If you didn't request it, just ignore this email.",
    asideTitle: "Between us.",
    asideBody: "CitizenTape is nearly free. Two hours of AI every three hours, just for being signed up. Plenty to prep an audition. If one day you want premium voices or AI direction, Oscar is €9.99/month. Until you need it, don't buy it.",
    asideClose: "Break a leg. Land the role.",
    signature: "— Solo + AI",
  },
  es: {
    subject: "Tu código CitizenTape",
    title: "Aquí está tu código.",
    subtitle: "Pégalo en CitizenTape para iniciar sesión.",
    expiry: "Este código expira en 10 minutos. Si no lo solicitaste, ignora este mensaje.",
    asideTitle: "Entre nosotros.",
    asideBody: "CitizenTape es casi gratis. Dos horas de IA cada tres horas, solo por estar inscrito. Suficiente para preparar una audición. Si algún día quieres voces premium o dirección de escena AI, Oscar cuesta 9,99 € al mes. Mientras no lo necesites, no lo tomes.",
    asideClose: "Mucha mierda. A por ese papel.",
    signature: "— Solo + IA",
  },
  it: {
    subject: "Il tuo codice CitizenTape",
    title: "Ecco il tuo codice.",
    subtitle: "Incollalo in CitizenTape per accedere.",
    expiry: "Questo codice scade tra 10 minuti. Se non l'hai richiesto, ignora questo messaggio.",
    asideTitle: "Tra noi.",
    asideBody: "CitizenTape è quasi gratuito. Due ore di IA ogni tre ore, solo per essere iscritto. Più che sufficiente per preparare un'audizione. Se un giorno vuoi le voci premium o la direzione AI, Oscar costa 9,99 € al mese. Finché non ti serve, non prenderlo.",
    asideClose: "In bocca al lupo. Prendi quel ruolo.",
    signature: "— Solo + IA",
  },
  de: {
    subject: "Dein CitizenTape-Code",
    title: "Hier ist dein Code.",
    subtitle: "Füge ihn in CitizenTape ein, um dich anzumelden.",
    expiry: "Dieser Code läuft in 10 Minuten ab. Wenn du ihn nicht angefordert hast, ignoriere diese Nachricht.",
    asideTitle: "Unter uns.",
    asideBody: "CitizenTape ist fast kostenlos. Zwei Stunden KI alle drei Stunden, einfach weil du angemeldet bist. Mehr als genug für eine Audition-Vorbereitung. Wenn du eines Tages Premium-Stimmen oder KI-Regie willst, Oscar kostet 9,99 € pro Monat. Solange du es nicht brauchst, kauf es nicht.",
    asideClose: "Toi, toi, toi. Hol dir die Rolle.",
    signature: "— Solo + KI",
  },
  pt: {
    subject: "Seu código CitizenTape",
    title: "Aqui está seu código.",
    subtitle: "Cole-o no CitizenTape para entrar.",
    expiry: "Este código expira em 10 minutos. Se você não o solicitou, ignore esta mensagem.",
    asideTitle: "Entre nós.",
    asideBody: "CitizenTape é quase gratuito. Duas horas de IA a cada três horas, apenas por estar registrado. Mais que suficiente para preparar uma audição. Se um dia quiser vozes premium ou direção AI, Oscar custa 9,99 € por mês. Até você precisar, não compre.",
    asideClose: "Merda! Pegue esse papel.",
    signature: "— Solo + IA",
  },
  ja: {
    subject: "CitizenTape 認証コード",
    title: "あなたのコード",
    subtitle: "CitizenTape に貼り付けてサインインしてください。",
    expiry: "このコードは10分で期限切れになります。リクエストしていない場合は無視してください。",
    asideTitle: "ここだけの話。",
    asideBody: "CitizenTape はほぼ無料で使えます。登録するだけで3時間ごとに2時間のAI。オーディション準備には十分です。プレミアム音声やAIディレクションが欲しくなったら、Oscarは月額9.99ユーロです。必要になるまで、買わなくて大丈夫。",
    asideClose: "頑張って。その役を勝ち取ろう。",
    signature: "— Solo + AI",
  },
  zh: {
    subject: "你的 CitizenTape 验证码",
    title: "这是你的验证码。",
    subtitle: "粘贴到 CitizenTape 中登录。",
    expiry: "此验证码将在 10 分钟后失效。如果不是你请求的,请忽略此邮件。",
    asideTitle: "悄悄话。",
    asideBody: "CitizenTape 几乎免费。注册就能每三小时获得两小时 AI 使用时间,足够准备一场试镜。如果哪天你想要高级语音或 AI 执导,Oscar 每月 9.99 欧元。不需要就别买。",
    asideClose: "祝你好运。拿下那个角色。",
    signature: "— Solo + AI",
  },
  ko: {
    subject: "CitizenTape 인증 코드",
    title: "인증 코드를 보내드립니다.",
    subtitle: "CitizenTape에 붙여넣어 로그인하세요.",
    expiry: "이 코드는 10분 후 만료됩니다. 요청하지 않았다면 이 메일을 무시하셔도 됩니다.",
    asideTitle: "우리끼리 얘기.",
    asideBody: "CitizenTape은 거의 무료예요. 가입만 하면 3시간마다 2시간의 AI 사용이 가능해요. 오디션 준비에 충분하죠. 언젠가 프리미엄 음성이나 AI 디렉팅이 필요하면, Oscar가 월 9.99유로예요. 필요하기 전까진 사지 마세요.",
    asideClose: "행운을 빌어요. 그 역할 꼭 따내세요.",
    signature: "— Solo + AI",
  },
  ar: {
    subject: "رمز CitizenTape الخاص بك",
    title: "إليك رمزك.",
    subtitle: "الصقه في CitizenTape لتسجيل الدخول.",
    expiry: "ينتهي هذا الرمز خلال 10 دقائق. إذا لم تطلبه، تجاهل هذه الرسالة.",
    asideTitle: "بيننا.",
    asideBody: "CitizenTape مجاني تقريباً. ساعتان من الذكاء الاصطناعي كل ثلاث ساعات، فقط بالتسجيل. أكثر من كافٍ لتحضير اختبار أداء. إذا أردت يوماً أصواتاً مميزة أو إخراجاً بالذكاء الاصطناعي، Oscar بـ 9,99 € شهرياً. حتى تحتاجه، لا تشتريه.",
    asideClose: "بالتوفيق. احصل على الدور.",
    signature: "— Solo + AI",
  },
  he: {
    subject: "הקוד שלך ב-CitizenTape",
    title: "הנה הקוד שלך.",
    subtitle: "הדבק אותו ב-CitizenTape כדי להתחבר.",
    expiry: "הקוד פג תוקף בעוד 10 דקות. אם לא ביקשת, התעלם מההודעה הזו.",
    asideTitle: "בינינו.",
    asideBody: "CitizenTape כמעט חינם. שעתיים של AI כל שלוש שעות, רק על ידי הרשמה. מספיק בהחלט להכין אודישן. אם יום אחד תרצה קולות פרימיום או הכוונת AI, Oscar עולה 9.99 € לחודש. עד שתצטרך, אל תקנה.",
    asideClose: "בהצלחה. תשיג את התפקיד.",
    signature: "— Solo + AI",
  },
  ru: {
    subject: "Ваш код CitizenTape",
    title: "Вот ваш код.",
    subtitle: "Вставьте его в CitizenTape, чтобы войти.",
    expiry: "Код истечёт через 10 минут. Если вы его не запрашивали, просто проигнорируйте это письмо.",
    asideTitle: "Между нами.",
    asideBody: "CitizenTape почти бесплатный. Два часа ИИ каждые три часа, просто за регистрацию. Более чем достаточно, чтобы подготовить прослушивание. Если однажды захотите премиум-голоса или режиссуру ИИ, Oscar стоит 9,99 € в месяц. Пока не нужно — не покупайте.",
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
<body style="margin:0;padding:0;background:#1a1a1a;font-family:'Helvetica Neue','Segoe UI',system-ui,-apple-system,sans-serif;color:#f5efe0;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;padding:48px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#212121;border:1px solid rgba(245,239,224,0.12);">
          <tr>
            <td style="padding:40px 40px 32px;">
              <span style="font-size:13px;font-weight:500;letter-spacing:0.22em;color:rgba(245,239,224,0.7);text-transform:uppercase;">CITIZENTAPE</span><span style="display:inline-block;width:5px;height:5px;background:#d92027;border-radius:50%;margin-left:6px;vertical-align:middle;"></span>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 8px;">
              <h1 style="margin:0;font-size:22px;font-weight:400;color:#f5efe0;letter-spacing:-0.01em;line-height:1.3;font-family:Georgia,'Times New Roman',serif;">${t.title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0;font-size:14px;color:rgba(245,239,224,0.55);line-height:1.5;">${t.subtitle}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <div style="border:1px solid rgba(245,239,224,0.15);padding:28px 24px;text-align:center;">
                <div style="font-family:'SF Mono','JetBrains Mono','Menlo','Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:12px;color:#f5efe0;line-height:1;padding-left:12px;">${escCode}</div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0;font-size:13px;color:rgba(245,239,224,0.4);line-height:1.5;">${t.expiry}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px;"><div style="height:1px;background:rgba(245,239,224,0.1);"></div></td>
          </tr>
          <tr>
            <td style="padding:28px 40px 32px;">
              <p style="margin:0 0 10px;font-size:14px;font-weight:500;color:#f5efe0;">${t.asideTitle}</p>
              <p style="margin:0;font-size:13px;color:rgba(245,239,224,0.5);line-height:1.65;">${t.asideBody}</p>
              <p style="margin:16px 0 0;font-size:13px;color:rgba(245,239,224,0.5);line-height:1.65;">${t.asideClose}</p>
              <p style="margin:14px 0 0;font-size:13px;color:#f5efe0;font-weight:500;">${t.signature}</p>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid rgba(245,239,224,0.1);padding:20px 40px;text-align:center;">
              <p style="margin:0;font-size:10px;color:rgba(245,239,224,0.3);line-height:1.5;letter-spacing:0.12em;text-transform:uppercase;">
                <a href="https://citizentape.com" style="color:rgba(245,239,224,0.4);text-decoration:none;">citizentape.com</a>
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
      from: `CitizenTape <${fromEmail}>`,
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
  // Grant free signup credits
  try {
    await env.DB.prepare(
      `INSERT INTO credit_transactions (id, email, amount_cents, type, description, created_at)
       VALUES (?, ?, ?, 'free_grant', 'Welcome bonus', datetime('now'))`
    ).bind(generateId("ctx"), email, CREDIT_PRICING.FREE_SIGNUP_GRANT_CENTS).run();
  } catch (e) { /* best effort */ }
  return { isNewUser: true, userId, tier: "audition" };
}

/* =========================================================
   GOOGLE OAUTH — Verify ID token from Google Identity Services
========================================================= */

const GOOGLE_CLIENT_ID = "580840125965-vrcb9nvptv4mj1ua0v66mq1asl5t6o51.apps.googleusercontent.com";

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
      // Rate limit: max 3 code requests per 15 minutes per email
      if (env.AUTH_KV) {
        const rateKey = `rate:code:${email}`;
        const attempts = parseInt(await env.AUTH_KV.get(rateKey) || "0");
        if (attempts >= 3) return json({ ok: false, error: "Too many requests. Try again later." }, 429);
        await env.AUTH_KV.put(rateKey, String(attempts + 1), { expirationTtl: 900 });
      }
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

    // Rate limit: max 5 verification attempts per 10 minutes per email
    if (env.AUTH_KV) {
      const verifyKey = `rate:verify:${email}`;
      const verifyAttempts = parseInt(await env.AUTH_KV.get(verifyKey) || "0");
      if (verifyAttempts >= 5) return json({ ok: false, error: "Too many attempts. Try again later." }, 429);
      await env.AUTH_KV.put(verifyKey, String(verifyAttempts + 1), { expirationTtl: 600 });
    }

    if (env.AUTH_KV) {
      const stored = await env.AUTH_KV.get(`auth_code:${email}`);
      if (!stored || stored !== code) {
        return json({ ok: false, error: "Code invalide ou expiré" }, 401);
      }
      await env.AUTH_KV.delete(`auth_code:${email}`);
    } else {
      const token = String(payload.token || "");
      if (!token) return json({ ok: false, error: "Missing token" }, 400);
      const secret = String(env.AUTH_CODE_SECRET || "");
      if (!secret) return json({ ok: false, error: "Auth not configured" }, 500);
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
    inviteUrl: `https://citizentape.com/?invite=${rawToken}`,
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

async function handleSetAutoTopup(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  if (!env.DB) return json({ ok: false, error: "DB not configured" }, 500);
  const payload = await request.json().catch(() => ({}));

  // Handle billing_mode change
  if (payload.billing_mode === "credits") {
    await env.DB.prepare("UPDATE users SET billing_mode = 'credits' WHERE lower(email) = ?").bind(email.toLowerCase()).run();
    return json({ ok: true, billingMode: "credits" });
  }

  const cents = parseInt(payload.amount_cents) || 0;
  if (cents !== 0 && cents !== 500 && cents !== 1000 && cents !== 2500) {
    return json({ ok: false, error: "Invalid amount" }, 400);
  }
  await env.DB.prepare("UPDATE users SET auto_topup_cents = ? WHERE lower(email) = ?").bind(cents, email.toLowerCase()).run();
  return json({ ok: true, autoTopupCents: cents });
}

const POLAR_METERED_PRODUCT_ID = "418d12be-cac3-4b87-a900-b80e07761392";

async function handleMeteredSubscribe(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  const polarKey = String(env.POLAR_ACCESS_TOKEN || "").trim();
  if (!polarKey) return json({ ok: false, error: "POLAR_NOT_CONFIGURED" }, 500);
  if (!env.DB) return json({ ok: false, error: "DB not configured" }, 500);

  // Check if already subscribed
  const user = await env.DB.prepare("SELECT billing_mode, polar_customer_id FROM users WHERE lower(email) = ?").bind(email.toLowerCase()).first();
  if (user && user.billing_mode === "metered") {
    return json({ ok: true, already: true, billingMode: "metered" });
  }

  const origin = new URL(request.url).origin;
  const rsp = await fetch("https://api.polar.sh/v1/checkouts/", {
    method: "POST",
    headers: { "Authorization": "Bearer " + polarKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      products: [POLAR_METERED_PRODUCT_ID],
      customer_email: email,
      success_url: origin + "/?payment=metered-active",
      metadata: { email, type: "metered_subscribe" },
    }),
  });
  const session = await rsp.json().catch(() => ({}));
  if (!rsp.ok || !session.url) return json({ ok: false, error: "POLAR_ERROR", detail: session.detail || "" }, 502);
  return json({ ok: true, checkoutUrl: session.url });
}

async function activateMeteredBilling(db, email, polarCustomerId) {
  if (!db) return;
  await db.prepare("UPDATE users SET billing_mode = 'metered', polar_customer_id = ? WHERE lower(email) = ?")
    .bind(polarCustomerId || "", email.toLowerCase()).run();
}

async function sendPolarUsageEvent(env, email, charCount) {
  const polarKey = String(env.POLAR_ACCESS_TOKEN || "").trim();
  if (!polarKey || !email) {
    if (env.DB) try { await logUsageEvent(env.DB, { email: email || "unknown", eventType: "polar_skip", meta: { reason: !polarKey ? "no_token" : "no_email", charCount } }); } catch(_e){}
    return;
  }
  // Get polar customer ID
  let customerId = null;
  if (env.DB) {
    const row = await env.DB.prepare("SELECT polar_customer_id FROM users WHERE lower(email) = ?").bind(email.toLowerCase()).first();
    if (row) customerId = row.polar_customer_id;
  }
  try {
    const event = { name: "tts_usage", metadata: { tts_characters: charCount } };
    // Use Polar customer_id (UUID) if available, otherwise fall back to external_customer_id (email)
    if (customerId) event.customer_id = customerId;
    else event.external_customer_id = email.toLowerCase();
    const body = JSON.stringify({ events: [event] });
    const resp = await fetch("https://api.polar.sh/v1/events/ingest", {
      method: "POST",
      headers: { "Authorization": "Bearer " + polarKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body,
    });
    const respText = await resp.text().catch(() => "");
    // Log result to DB for debugging
    if (env.DB) try { await logUsageEvent(env.DB, { email, eventType: "polar_event_sent", meta: { charCount, customerId, status: resp.status, ok: resp.ok, response: respText.slice(0, 500) } }); } catch(_e){}
    if (!resp.ok) console.error("Polar event error:", resp.status, respText);
  } catch (e) {
    console.error("Polar event ingestion error:", e.message);
    if (env.DB) try { await logUsageEvent(env.DB, { email, eventType: "polar_event_error", meta: { charCount, error: e.message } }); } catch(_e){}
  }
}

async function isMeteredUser(db, email) {
  if (!db || !email) return false;
  try {
    const row = await db.prepare("SELECT billing_mode FROM users WHERE lower(email) = ?").bind(email.toLowerCase()).first();
    return row && row.billing_mode === "metered";
  } catch (e) { return false; }
}

/* =========================================================
   ANTHROPIC CONCURRENCY SEMAPHORE
========================================================= */

const ANTHROPIC_MAX_CONCURRENT = 50;

async function acquireAnthropicSlot(_env) {
  if (_anthropicConcurrent >= ANTHROPIC_MAX_CONCURRENT) return false;
  _anthropicConcurrent++;
  return true;
}

async function releaseAnthropicSlot(_env) {
  _anthropicConcurrent = Math.max(0, _anthropicConcurrent - 1);
}

const DEFAULT_API_CORS = {
  "Access-Control-Allow-Origin": "https://citizentape.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Access-Control-Allow-Credentials": "true",
};

async function withAnthropicSlot(env, handler, request, corsHeaders) {
  const cors = corsHeaders || DEFAULT_API_CORS;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const acquired = await acquireAnthropicSlot(env);
  if (!acquired) return json({ ok: false, error: "SERVER_BUSY", message: "High demand, please try again" }, 503, cors);
  try { return await handler(request, env); }
  finally { await releaseAnthropicSlot(env); }
}

/* =========================================================
   PARSE SCREENPLAY JSON (ANTHROPIC) — contrat index.html
========================================================= */

const PARSE_SCREENPLAY_CORS = {
  "Access-Control-Allow-Origin": "https://citizentape.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Access-Control-Allow-Credentials": "true",
};

function buildCitizenTapePlaySchemaPrompt() {
  return [
    "Tu extrais un scénario pour une application de répétition (ordre des répliques et didascalies).",
    "Réponds uniquement avec un objet JSON UTF-8 valide, sans markdown ni texte hors JSON.",
    "Schéma exact :",
    '{"characters":["NOM",...],"lines":[{"character":"NOM ou null","text":"…","type":"dialogue | action | slug"}]}',
    "- characters : personnages ayant au moins une réplique (orthographe du document).",
    "- lines : ordre chronologique du document.",
    '- type "dialogue" : réplique ; character = locuteur ; texte sans répéter le nom en tête.',
    '- type "action" : didascalie, description, transitions ; character doit être null.',
    '- type "slug" : INT./EXT./SCÈNE uniquement ; character null.',
    '- Si nom et réplique sont collés sur une ligne (ex: "LUCIE I leave"), sépare character "LUCIE" et texte "I leave".',
  ].join("\n");
}

function extractAnthropicMessageTextBlocks(message) {
  const blocks = message && message.content ? message.content : [];
  let out = "";
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b && b.type === "text" && b.text) out += b.text;
  }
  return out;
}

function parseCitizenTapePlayModelJson(rawText) {
  let s = String(rawText || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```/im.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Pas de JSON dans la réponse");
  return JSON.parse(s.slice(start, end + 1));
}

async function handleParseScreenplay(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401, PARSE_SCREENPLAY_CORS);
  const apiKey = getAnthropicKey(env);
  if (!apiKey) {
    return json({ error: "Missing ANTHROPIC_API_KEY" }, 500, PARSE_SCREENPLAY_CORS);
  }

  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  let pdfBase64 = "";
  let screenplayText = "";
  let fileName = "";

  if (contentType.includes("multipart/form-data")) {
    // PDF file uploaded directly — Claude reads it natively
    const form = await request.formData().catch(() => null);
    if (!form) {
      return json({ error: "Invalid form data" }, 400, PARSE_SCREENPLAY_CORS);
    }
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ error: "No file provided" }, 400, PARSE_SCREENPLAY_CORS);
    }
    if (file.size > 10 * 1024 * 1024) {
      return json({ error: "File too large (max 10MB)" }, 413, PARSE_SCREENPLAY_CORS);
    }
    fileName = String(file.name || "script.pdf");
    const buffer = await file.arrayBuffer();
    pdfBase64 = arrayBufferToBase64(buffer);
  } else {
    // JSON body (legacy or text-based)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "Invalid JSON body" }, 400, PARSE_SCREENPLAY_CORS);
    }
    pdfBase64 =
      typeof body.pdfBase64 === "string"
        ? body.pdfBase64.replace(/^data:application\/pdf[^,]*,/i, "").trim()
        : "";
    screenplayText = typeof body.screenplayText === "string" ? body.screenplayText : "";
    fileName = typeof body.fileName === "string" ? body.fileName : "";
  }

  if (!pdfBase64 && !screenplayText.trim()) {
    return json({ error: "Provide a PDF file or screenplayText" }, 400, PARSE_SCREENPLAY_CORS);
  }

  if (pdfBase64.length > 45 * 1024 * 1024) {
    return json({ error: "PDF trop volumineux pour l’API" }, 413, PARSE_SCREENPLAY_CORS);
  }

  const model = "claude-haiku-4-5";
  const max_tokens = 32768;

  const userContent = [];
  if (pdfBase64) {
    userContent.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdfBase64,
      },
    });
    userContent.push({
      type: "text",
      text:
        (fileName ? `Fichier : ${fileName}\n\n` : "") +
        buildCitizenTapePlaySchemaPrompt() +
        "\nAnalyse le PDF joint et produis le JSON.",
    });
  } else {
    userContent.push({
      type: "text",
      text:
        "Scénario en texte :\n---\n" +
        screenplayText +
        "\n---\n\n" +
        buildCitizenTapePlaySchemaPrompt(),
    });
  }

  const payload = {
    model,
    max_tokens,
    system:
      "Tu renvoies uniquement un JSON compact avec les clés characters (tableau de chaînes) et lines (tableau d’objets). Aucune prose en dehors du JSON.",
    messages: [{ role: "user", content: userContent }],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = null;
    }

    if (!resp.ok) {
      const msg =
        (data && data.error && data.error.message) ||
        raw.slice(0, 400) ||
        `HTTP ${resp.status}`;
      return json({ error: msg }, resp.status >= 400 && resp.status < 600 ? resp.status : 502, PARSE_SCREENPLAY_CORS);
    }

    const textOut = extractAnthropicMessageTextBlocks(data);
    let parsed;
    try {
      parsed = parseCitizenTapePlayModelJson(textOut);
    } catch (e) {
      return json(
        {
          error: "Réponse non JSON : " + (e && e.message ? e.message : String(e)),
          rawPreview: textOut.slice(0, 1200),
        },
        502,
        PARSE_SCREENPLAY_CORS,
      );
    }

    if (!parsed.characters || !Array.isArray(parsed.lines)) {
      return json({ error: "JSON invalide : characters ou lines manquants" }, 502, PARSE_SCREENPLAY_CORS);
    }

    return json({ characters: parsed.characters, lines: parsed.lines }, 200, PARSE_SCREENPLAY_CORS);
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "anthropic_timeout" : toText(e);
    return json({ error: msg }, 502, PARSE_SCREENPLAY_CORS);
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   REMOTE SCRIPT PARSE (ANTHROPIC)
========================================================= */

const MAX_REMOTE_PARSE_BYTES = 10 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 25000;

function logParse(event, data = {}) {
  try {
    console.log(JSON.stringify({ scope: "parse-script", event, ...data }));
  } catch (_) {}
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function stripJsonFence(text) {
  const s = String(text || "").trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : s;
}

function validateParsedScript(raw) {
  let items = raw;
  let language = "";
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    language = String(raw.language || "").trim().slice(0, 5);
    items = raw.script;
  }
  if (!Array.isArray(items)) return { ok: false, error: "not_array" };
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i];
    if (!row || typeof row !== "object") return { ok: false, error: `row_${i}_not_object` };
    const kind = String(row.kind || "").trim();
    if (!["slug", "action", "dialogue"].includes(kind)) {
      return { ok: false, error: `row_${i}_invalid_kind` };
    }
    if (kind === "dialogue") {
      const char = String(row.char || "").replace(/\s+/g, " ").trim();
      const text = String(row.text || "").replace(/\s+/g, " ").trim();
      if (!char || !text) return { ok: false, error: `row_${i}_invalid_dialogue` };
      out.push({ kind: "dialogue", char, text });
      continue;
    }
    const text = String(row.text || "").replace(/\s+/g, " ").trim();
    if (!text) return { ok: false, error: `row_${i}_empty_text` };
    out.push({ kind, text });
  }
  if (!out.length) return { ok: false, error: "empty_output" };
  if (out.length > 5000) return { ok: false, error: "too_many_rows" };
  return { ok: true, script: out, language };
}

async function callAnthropicParse({ env, parseId, model, pdfBase64, fileName, attempt }) {
  const systemPrompt = [
    "You are a screenplay/script parser. You return structured JSON only.",
    "",
    "Return a JSON object with two keys:",
    '{"language":"<ISO 639-1 code, e.g. fr, en, es>","script":[...]}',
    "",
    "The script array contains items of these types:",
    '{"kind":"slug","text":"..."} — scene headings (INT./EXT.)',
    '{"kind":"action","text":"..."} — stage directions, descriptions of what characters DO (movement, gestures, actions)',
    '{"kind":"dialogue","char":"CHARACTER NAME","text":"..."} — spoken words ONLY',
    "",
    "CRITICAL RULES FOR CHARACTER NAMES (char field):",
    "- A character name is a PROPER NOUN: a first name, last name, or both (1-3 words max).",
    "- Short uppercase phrases that are spoken dialogue are NOT character names. Examples of NON-characters: OUI ABSOLUMENT, DE L'AMMONIAQUE, TU ME L'ENVOIES, SUR L'ÉCRAN, MINUTES, BIEN SÛR, ALLÔ, MERCI.",
    "- If a candidate contains a French/English article (DE, DU, D', L', LE, LA, LES, UN, UNE, DES, THE, A, AN) it is NOT a character name.",
    "- If a candidate is a common dictionary word (OUI, NON, MINUTES, STOP, OK, etc.) it is NOT a character name.",
    "- A real character name appears MULTIPLE times in the script as a speaker cue. If it only appears once, do NOT treat it as a character.",
    "- When in doubt, do NOT create a new character — assign the line to the previous speaker or mark it as action.",
    "",
    "CRITICAL RULES FOR ACTION vs DIALOGUE:",
    "- kind:dialogue = ONLY the words a character SPEAKS out loud.",
    "- kind:action = any description of what happens on screen: movement, gestures, camera directions, scene descriptions.",
    "- If a line describes what a character DOES (verbs like: pose, entre, sort, regarde, s'assoit, se lève, prend, ouvre, ferme, marche, court, frappe, embrasse, arrives, walks, sits, stands, looks, puts, places, opens, closes) it is ALWAYS kind:action, NEVER kind:dialogue.",
    "- Parenthetical acting directions within dialogue (e.g. (en colère), (whispering)) should be excluded from the text; only keep the spoken words.",
    "",
    "OTHER RULES:",
    "- Ignore OCR/page noise: watermarks, revision headers (Pink Rev, Blue Rev…), page numbers, margin markers.",
    "- Normalize speaker names: remove (CONT'D), (O.S.), (V.O.), (SUITE) suffixes.",
    "- Keep original order. Do not invent lines.",
    "- No prose, no markdown fences. Output raw JSON only."
  ].join("\n");
  const userPrompt = [
    "Parse this screenplay PDF into structured JSON.",
    'Output must be a JSON object: {"language":"...","script":[...]}',
    "Preserve the original order of the script.",
    "Ignore revision/page/header/footer noise."
  ].join(" ");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), PARSE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const rsp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": getAnthropicKey(env),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32768,
        temperature: 0,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfBase64,
                },
              },
              { type: "text", text: `${userPrompt} File name: ${fileName || "script.pdf"}` },
            ],
          },
        ],
      }),
    });
    const duration = Date.now() - t0;
    const body = await rsp.json().catch(() => ({}));
    if (!rsp.ok) {
      logParse("anthropic_http_error", {
        parse_id: parseId, model, attempt, status: rsp.status, duration_ms: duration,
      });
      return { ok: false, error: `anthropic_http_${rsp.status}`, providerBody: body };
    }
    const text = Array.isArray(body.content)
      ? body.content.filter(x => x && x.type === "text").map(x => x.text || "").join("\n")
      : "";
    const cleaned = stripJsonFence(text);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_) {
      logParse("anthropic_invalid_json", { parse_id: parseId, model, attempt, duration_ms: duration });
      return { ok: false, error: "invalid_json" };
    }
    const validated = validateParsedScript(parsed);
    if (!validated.ok) {
      logParse("anthropic_schema_invalid", {
        parse_id: parseId, model, attempt, duration_ms: duration, schema_error: validated.error,
      });
      return { ok: false, error: `schema_${validated.error}` };
    }
    logParse("anthropic_success", {
      parse_id: parseId, model, attempt, duration_ms: duration, rows: validated.script.length, language: validated.language || "",
    });
    return { ok: true, script: validated.script, language: validated.language || "" };
  } catch (err) {
    const duration = Date.now() - t0;
    const timeoutErr = String(err && err.message || err).toLowerCase().includes("timeout")
      || String(err && err.name || "").toLowerCase() === "aborterror";
    logParse("anthropic_exception", {
      parse_id: parseId, model, attempt, duration_ms: duration, timeout: timeoutErr, error: toText(err),
    });
    return { ok: false, error: timeoutErr ? "anthropic_timeout" : "anthropic_exception" };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropicParseText({ env, parseId, model, scriptText, fileName, attempt, partLabel }) {
  const systemPrompt = [
    "You are a screenplay/script parser. You return structured JSON only.",
    "",
    "Return a JSON object with two keys:",
    '{"language":"<ISO 639-1 code, e.g. fr, en, es>","script":[...]}',
    "",
    "The script array contains items of these types:",
    '{"kind":"slug","text":"..."} — scene headings (INT./EXT.)',
    '{"kind":"action","text":"..."} — stage directions, descriptions of what characters DO (movement, gestures, actions)',
    '{"kind":"dialogue","char":"CHARACTER NAME","text":"..."} — spoken words ONLY',
    "",
    "CRITICAL RULES FOR CHARACTER NAMES (char field):",
    "- A character name is a PROPER NOUN: a first name, last name, or both (1-3 words max).",
    "- Short uppercase phrases that are spoken dialogue are NOT character names.",
    "- If a candidate contains a French/English article (DE, DU, D', L', LE, LA, LES, UN, UNE, DES, THE, A, AN) it is NOT a character name.",
    "- If a candidate is a common dictionary word it is NOT a character name.",
    "- A real character name appears MULTIPLE times as a speaker cue.",
    "- When in doubt, do NOT create a new character — assign the line to the previous speaker or mark it as action.",
    "",
    "CRITICAL RULES FOR ACTION vs DIALOGUE:",
    "- kind:dialogue = ONLY the words a character SPEAKS out loud.",
    "- kind:action = any description of what happens on screen.",
    "- Parenthetical acting directions within dialogue should be excluded from the text.",
    "",
    "OTHER RULES:",
    "- Ignore OCR/page noise: watermarks, revision headers, page numbers.",
    "- Normalize speaker names: remove (CONT'D), (O.S.), (V.O.), (SUITE) suffixes.",
    "- Keep original order. Do not invent lines.",
    "- No prose, no markdown fences. Output raw JSON only."
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), PARSE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const rsp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": getAnthropicKey(env),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32768,
        temperature: 0,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: `Parse this screenplay text (${partLabel || "full"}) into structured JSON. File: ${fileName}\n\n${scriptText}`,
        }],
      }),
    });
    const duration = Date.now() - t0;
    const body = await rsp.json().catch(() => ({}));
    if (!rsp.ok) {
      logParse("anthropic_text_http_error", { parse_id: parseId, model, attempt, status: rsp.status, duration_ms: duration });
      return { ok: false, error: `anthropic_http_${rsp.status}` };
    }
    const text = Array.isArray(body.content)
      ? body.content.filter(x => x && x.type === "text").map(x => x.text || "").join("\n")
      : "";
    const cleaned = stripJsonFence(text);
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (_) {
      logParse("anthropic_text_invalid_json", { parse_id: parseId, model, attempt, duration_ms: duration });
      return { ok: false, error: "invalid_json" };
    }
    const validated = validateParsedScript(parsed);
    if (!validated.ok) {
      logParse("anthropic_text_schema_invalid", { parse_id: parseId, model, attempt, duration_ms: duration, schema_error: validated.error });
      return { ok: false, error: `schema_${validated.error}` };
    }
    logParse("anthropic_text_success", { parse_id: parseId, model, attempt, duration_ms: duration, rows: validated.script.length, language: validated.language || "" });
    return { ok: true, script: validated.script, language: validated.language || "" };
  } catch (err) {
    const duration = Date.now() - t0;
    const timeoutErr = String(err && err.message || err).toLowerCase().includes("timeout")
      || String(err && err.name || "").toLowerCase() === "aborterror";
    logParse("anthropic_text_exception", { parse_id: parseId, model, attempt, duration_ms: duration, timeout: timeoutErr, error: toText(err) });
    return { ok: false, error: timeoutErr ? "anthropic_timeout" : "anthropic_exception" };
  } finally {
    clearTimeout(timeout);
  }
}

const SPLIT_TEXT_THRESHOLD = 30000;

async function handleParseScript(request, env) {
  const parseId = generateId("parse");
  const startedAt = Date.now();
  if (!getAnthropicKey(env)) {
    return json({ ok: false, error: "missing_anthropic_api_key", fallback_recommended: true, meta: { parse_id: parseId } }, 500);
  }
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({ ok: false, error: "expected_multipart_form_data", fallback_recommended: true, meta: { parse_id: parseId } }, 400);
  }
  const form = await request.formData().catch(() => null);
  const file = form ? form.get("file") : null;
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ ok: false, error: "missing_file", fallback_recommended: true, meta: { parse_id: parseId } }, 400);
  }
  const fileName = String(file.name || "script.pdf");
  const fileType = String(file.type || "");
  const fileBytes = Number(file.size || 0);
  if (fileBytes > MAX_REMOTE_PARSE_BYTES) {
    return json({
      ok: false, error: "payload_too_large_for_remote_parse", fallback_recommended: true,
      meta: { parse_id: parseId, file_bytes: fileBytes },
    }, 413);
  }
  if (!fileType.includes("pdf") && !/\.pdf$/i.test(fileName)) {
    return json({ ok: false, error: "invalid_file_type", fallback_recommended: true, meta: { parse_id: parseId, file_type: fileType } }, 400);
  }
  const extractedText = form.get("extracted_text") ? String(form.get("extracted_text")) : "";
  const useSplitText = extractedText.length >= SPLIT_TEXT_THRESHOLD;

  if (useSplitText) {
    logParse("split_text_mode", { parse_id: parseId, text_length: extractedText.length });
    const mid = Math.floor(extractedText.length / 2);
    const splitAt = extractedText.lastIndexOf("\n", mid);
    const splitPos = splitAt > mid * 0.3 ? splitAt : mid;
    const half1 = extractedText.slice(0, splitPos);
    const half2 = extractedText.slice(splitPos);
    const model = "claude-haiku-4-5";
    const [r1, r2] = await Promise.all([
      callAnthropicParseText({ env, parseId, model, scriptText: half1, fileName, attempt: 1, partLabel: "part 1/2" }),
      callAnthropicParseText({ env, parseId, model, scriptText: half2, fileName, attempt: 2, partLabel: "part 2/2" }),
    ]);
    if (r1.ok && r2.ok) {
      const merged = [...r1.script, ...r2.script];
      return json({
        ok: true, provider: "anthropic", model, script: merged,
        language: r1.language || r2.language || "",
        meta: { parse_id: parseId, split: true, attempts: 2, duration_ms: Date.now() - startedAt, file_bytes: fileBytes },
      });
    }
    if (r1.ok) {
      return json({
        ok: true, provider: "anthropic", model, script: r1.script,
        language: r1.language || "",
        meta: { parse_id: parseId, split: true, partial: true, attempts: 2, duration_ms: Date.now() - startedAt, file_bytes: fileBytes },
      });
    }
    if (r2.ok) {
      return json({
        ok: true, provider: "anthropic", model, script: r2.script,
        language: r2.language || "",
        meta: { parse_id: parseId, split: true, partial: true, attempts: 2, duration_ms: Date.now() - startedAt, file_bytes: fileBytes },
      });
    }
    logParse("split_text_all_failed", { parse_id: parseId });
  }

  const buffer = await file.arrayBuffer();
  const pdfBase64 = arrayBufferToBase64(buffer);
  const attempts = [
    { model: "claude-haiku-4-5", attempt: 1 },
    { model: "claude-haiku-4-5", attempt: 2 },
    { model: "claude-haiku-4-5", attempt: 3 },
  ];
  let lastError = "unknown";
  for (const step of attempts) {
    const result = await callAnthropicParse({
      env, parseId, model: step.model, pdfBase64, fileName, attempt: step.attempt,
    });
    if (result.ok) {
      return json({
        ok: true,
        provider: "anthropic",
        model: step.model,
        script: result.script,
        language: result.language || "",
        meta: {
          parse_id: parseId,
          attempts: step.attempt,
          duration_ms: Date.now() - startedAt,
          file_bytes: fileBytes,
        },
      });
    }
    lastError = result.error || "parse_failed";
  }
  return json({
    ok: false,
    error: lastError,
    fallback_recommended: true,
    meta: {
      parse_id: parseId,
      attempts: attempts.length,
      duration_ms: Date.now() - startedAt,
      file_bytes: fileBytes,
    },
  }, 502);
}

/* =========================================================
   VALIDATE CHARACTERS (lightweight)
========================================================= */

async function handleValidateCharacters(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  if (!getAnthropicKey(env)) {
    return json({ ok: false, error: "missing_anthropic_api_key", characters: [] }, 500);
  }
  let body;
  try { body = await request.json(); } catch (_) {
    return json({ ok: false, error: "invalid_json", characters: [] }, 400);
  }
  const candidates = String(body.candidates || "").slice(0, 2000);
  const lang = String(body.lang || "").slice(0, 20);
  if (!candidates) return json({ ok: false, error: "empty_candidates", characters: [] }, 400);

  const prompt = [
    `You are a screenplay expert. Below are candidate character names extracted from a ${lang || "unknown language"} screenplay.`,
    "Each candidate is followed by its occurrence count in parentheses.",
    "Return ONLY a JSON array of strings containing the REAL character names.",
    "Exclude any that are: common words, shouted dialogue, stage directions, scene headings, or noise.",
    "A real character name is a proper noun (first name, last name, or nickname) that appears as a speaker cue.",
    "",
    `Candidates: ${candidates}`,
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 15000);
  try {
    const rsp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": getAnthropicKey(env),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await rsp.json().catch(() => ({}));
    if (!rsp.ok) return json({ ok: false, error: `http_${rsp.status}`, characters: [] }, 502);
    const text = Array.isArray(data.content)
      ? data.content.filter(x => x && x.type === "text").map(x => x.text || "").join("")
      : "";
    const cleaned = stripJsonFence(text);
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (_) {
      return json({ ok: false, error: "invalid_json_response", characters: [] }, 502);
    }
    if (!Array.isArray(parsed)) return json({ ok: false, error: "not_array", characters: [] }, 502);
    const characters = parsed.map(c => String(c).trim()).filter(Boolean).slice(0, 100);
    return json({ ok: true, characters });
  } catch (err) {
    return json({ ok: false, error: "timeout_or_exception", characters: [] }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleClassifyLines(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  if (!getAnthropicKey(env)) {
    return json({ ok: false, error: "missing_anthropic_api_key" }, 500);
  }
  let body;
  try { body = await request.json(); } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  /** Keep chunks small: large prompts + 200-line outputs hit timeouts and truncation. */
  const MAX_LINES = 55;
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, MAX_LINES) : [];
  const characters = Array.isArray(body.characters) ? body.characters : [];
  const lang = String(body.lang || "fr").slice(0, 10);
  if (!lines.length) return json({ ok: true, classified: [] });

  let charList = characters.join(", ");
  if (charList.length > 6000) charList = charList.slice(0, 6000) + " …";

  const numberedLines = lines.map((l, i) => `${i}: ${l}`).join("\n");

  const prompt = `You are a screenplay classification expert. The validated character names are: ${charList}

Below are ${lines.length} lines from a ${lang} screenplay. For EACH line index from 0 to ${lines.length - 1}, output EXACTLY one classification (same number of lines as input):
D:CHARACTER_NAME — dialogue (spoken words only; CHARACTER must be one of the validated names or the best match)
A — action / stage direction (not spoken)
S — scene heading / slug (INT./EXT./SCÈNE…)

Rules:
- Physical actions (enters, exits, looks…) → A
- Third-person narration (Il/Elle + verb) → A
- Only spoken lines → D with speaker name

Output format ONLY (no prose, no markdown fences):
0:D:JUVE
1:A
2:S

Lines:
${numberedLines}`;

  const apiKey = getAnthropicKey(env).replace(/^['"]|['"]$/g, "").replace(/^Bearer\s+/i, "");
  const payloadBase = {
    model: "claude-haiku-4-5",
    max_tokens: 32768,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  };

  let lastErr = "";
  let lastDetail = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 25000);
    try {
      const rsp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payloadBase),
      });
      const data = await rsp.json().catch(() => ({}));
      if (!rsp.ok) {
        lastErr = `anthropic_${rsp.status}`;
        lastDetail = toText(data.error || data.message || data.type || "");
        clearTimeout(timeout);
        if (rsp.status === 429 || rsp.status >= 500) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        return json({ ok: false, error: lastErr, detail: lastDetail.slice(0, 500) }, 502);
      }
      let text = Array.isArray(data.content)
        ? data.content.filter((x) => x && x.type === "text").map((x) => x.text || "").join("")
        : "";
      text = text.replace(/^```[\w]*\n?/m, "").replace(/\n?```$/m, "").trim();

      const classified = new Array(lines.length).fill(null);
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^(\d+)\s*:\s*(D)\s*:\s*(.+)$/i) || line.match(/^(\d+)\s*:\s*(A|S)$/i);
        if (m) {
          const idx = parseInt(m[1], 10);
          const type = m[2].toUpperCase();
          const char = m[3] ? String(m[3]).trim() : "";
          if (idx >= 0 && idx < lines.length) classified[idx] = { type, char };
        }
      }
      clearTimeout(timeout);
      return json({ ok: true, classified });
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err && err.name === "AbortError" ? "timeout" : "exception";
      lastDetail = toText(err && err.message);
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  return json({ ok: false, error: lastErr || "classify_failed", detail: lastDetail.slice(0, 500) }, 502);
}

async function handleMergeCharacters(request, env) {
  const email = await resolveCurrentUser(request, env);
  if (!email) return json({ ok: false, error: "AUTH_REQUIRED" }, 401);
  if (!getAnthropicKey(env)) return json({ error: "missing_anthropic_api_key" }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "invalid_json" }, 400); }
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return json({ merges: [] });
  const prompt = `You are analyzing a screenplay's character list. Some character names may be typos, abbreviations, or variants of the same person. Others may be genuinely different roles.

For each pair below, decide: are they the SAME character (merge) or DIFFERENT characters (keep separate)?

Pairs to evaluate:
${candidates.map((p, i) => `${i + 1}. "${p[0]}" (${p[2] || '?'} lines) vs "${p[1]}" (${p[3] || '?'} lines)`).join('\n')}

Reply with a JSON array of objects: [{"pair": 1, "same": true/false, "canonical": "preferred name"}]
Only include pairs where same=true. If all are different, return [].
Return ONLY the JSON array, no explanation.`;

  try {
    const model = env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": getAnthropicKey(env),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return json({ merges: [], error: "api_error" });
    const data = await res.json();
    const text = (data.content || []).map(b => b.text || "").join("");
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return json({ merges: [] });
    const merges = JSON.parse(match[0]);
    return json({ merges });
  } catch (e) {
    return json({ merges: [], error: String(e.message || e) });
  }
}

/* =========================================================
   D1 MIGRATION HELPER
========================================================= */

async function ensureD1Tables(db) {
  if (!db) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, is_admin INTEGER DEFAULT 0, tier TEXT DEFAULT 'audition', last_login_at INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT, email_restriction TEXT, credits_granted INTEGER NOT NULL DEFAULT 0, expires_at TEXT, revoked INTEGER DEFAULT 0, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS invite_redemptions (id TEXT PRIMARY KEY, invite_id TEXT NOT NULL, email TEXT, credits_used INTEGER DEFAULT 0, redeemed_at TEXT DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, FOREIGN KEY (invite_id) REFERENCES invites(id))`,
    `CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, email TEXT, invite_id TEXT, event_type TEXT NOT NULL, meta_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS credit_transactions (id TEXT PRIMARY KEY, email TEXT NOT NULL, amount_cents INTEGER NOT NULL, type TEXT NOT NULL, description TEXT, stripe_session_id TEXT, char_count INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  ];
  for (const sql of statements) {
    try { await db.prepare(sql).run(); } catch (ee) { /* ignore */ }
  }
  try { await db.prepare("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT").run(); } catch (e) { /* already exists */ }
  try { await db.prepare("ALTER TABLE users ADD COLUMN auto_topup_cents INTEGER DEFAULT 0").run(); } catch (e) { /* already exists */ }
  try { await db.prepare("ALTER TABLE users ADD COLUMN polar_customer_id TEXT").run(); } catch (e) { /* already exists */ }
  try { await db.prepare("ALTER TABLE users ADD COLUMN billing_mode TEXT DEFAULT 'credits'").run(); } catch (e) { /* already exists */ }
  // Performance indexes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_credit_email ON credit_transactions(email)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_stripe_id ON credit_transactions(stripe_session_id) WHERE stripe_session_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_credit_created ON credit_transactions(email, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_invite_redemptions_email ON invite_redemptions(email)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_events_email ON usage_events(email, created_at DESC)`,
  ];
  for (const idx of indexes) {
    try { await db.prepare(idx).run(); } catch (e) { /* ignore */ }
  }
}

/* =========================================================
   CLAUDE PARSE SCRIPT (texte PDF extrait → JSON)
========================================================= */

async function handleClaudeParseScript(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "https://citizentape.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cookie",
    "Access-Control-Allow-Credentials": "true",
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return Response.json({ success: false, error: "Method not allowed" }, { status: 405, headers: cors });
  }
  const _cpEmail = await resolveCurrentUser(request, env);
  if (!_cpEmail) return json({ ok: false, error: "AUTH_REQUIRED" }, 401, cors);

  const apiKey = getAnthropicKey(env);
  if (!apiKey) {
    return Response.json({ success: false, error: "Missing ANTHROPIC_API_KEY" }, { status: 500, headers: cors });
  }

  try {
    const body = await request.json().catch(() => null);
    const pdfText = body && typeof body.pdfText === "string" ? body.pdfText : "";
    if (!pdfText.trim()) {
      return Response.json({ success: false, error: "Missing pdfText" }, { status: 400, headers: cors });
    }

    const slice = pdfText.substring(0, 15000);

    const prompt = `Parse ce script de théâtre. Retourne UNIQUEMENT du JSON sans aucun texte avant ou après.

Règles :
- Une ligne qui commence par un NOM EN MAJUSCULES (ex: JUVE, FANTÔMAS) = dialogue → type "dialogue", isSpoken true
- Sinon = action → type "action", isSpoken false
- Les lignes INT./EXT./SCÈNE = type "slug", isSpoken false

Format JSON attendu :
{"characters":["NOM1","NOM2"],"lines":[{"character":"NOM","text":"la réplique","type":"dialogue","isSpoken":true}]}

Texte à parser :
${slice}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 32768,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (data && data.error && data.error.message) || `anthropic_http_${response.status}`;
      return Response.json({ success: false, error: msg }, { status: response.status >= 400 && response.status < 600 ? response.status : 502, headers: cors });
    }

    const blocks = data && Array.isArray(data.content) ? data.content : [];
    const firstText = blocks.find((b) => b && b.type === "text" && b.text);
    const jsonText = firstText ? String(firstText.text).trim() : "";
    if (!jsonText) {
      return Response.json({ success: false, error: "Empty model response" }, { status: 502, headers: cors });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_) {
      const start = jsonText.indexOf("{");
      const end = jsonText.lastIndexOf("}");
      if (start < 0 || end <= start) {
        return Response.json({ success: false, error: "Invalid JSON from model", rawPreview: jsonText.slice(0, 400) }, { status: 502, headers: cors });
      }
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    }

    return Response.json({ success: true, ...parsed }, { headers: cors });
  } catch (e) {
    return Response.json({ success: false, error: toText(e && e.message ? e.message : e) }, { status: 500, headers: cors });
  }
}


/* =========================================================
   LABEL SCRIPT LINES (text extracted client-side, Claude labels only)
========================================================= */

async function handleLabelScript(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "https://citizentape.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cookie",
    "Access-Control-Allow-Credentials": "true",
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return Response.json({ success: false, error: "Method not allowed" }, { status: 405, headers: cors });
  }
  const _lsEmail = await resolveCurrentUser(request, env);
  if (!_lsEmail) return json({ ok: false, error: "AUTH_REQUIRED" }, 401, cors);

  const apiKey = getAnthropicKey(env);
  if (!apiKey) {
    return Response.json({ success: false, error: "Missing ANTHROPIC_API_KEY" }, { status: 500, headers: cors });
  }

  try {
    const body = await request.json().catch(() => null);
    const numberedText = body && typeof body.numberedText === "string" ? body.numberedText : "";
    if (!numberedText.trim()) {
      return Response.json({ success: false, error: "Missing numberedText" }, { status: 400, headers: cors });
    }

    const prompt = `You are a screenplay parser. Below are numbered lines extracted from a screenplay PDF.

For each line, return its label as a JSON array entry: [line_number, type, character_name_or_null]
- type is one of: "dialogue", "action", "slug", "character_cue"
- "slug" = scene headings (INT./EXT./SCENE/etc)
- "dialogue" = spoken words by a character. The character name comes from the preceding character_cue line.
- "action" = stage directions, descriptions, narrative, transitions, camera directions. These are NEVER spoken.
- "character_cue" = a line that is JUST a character name in caps (e.g. "JUVE"), indicating the next line(s) are their dialogue

CRITICAL RULES:
- Descriptive/narrative lines between dialogue (e.g. "L'homme entre dans la piece." or "Georges se retourne :") are ALWAYS "action", even if they appear between two dialogue lines.
- Parenthetical directions like "(criant)" or "(se raidissant soudain)" at the start of a dialogue line do NOT make it action — it is still "dialogue".
- Only lines that contain actual spoken words are "dialogue". If a line describes what happens or what someone does, it is "action".

Return ONLY a JSON object, no markdown, no prose:
{"characters":["NAME1","NAME2"],"labels":[[1,"slug",null],[2,"action",null],[3,"dialogue","JUVE"],...]}

IMPORTANT: Do NOT reproduce the line text. Only return line numbers and labels. Be concise.

NUMBERED LINES:
${numberedText}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16384,
        system: "Return only compact JSON. No prose, no markdown fences. Minimize output tokens.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (data && data.error && data.error.message) || `anthropic_http_${response.status}`;
      return Response.json({ success: false, error: msg }, { status: response.status >= 400 && response.status < 600 ? response.status : 502, headers: cors });
    }

    const blocks = data && Array.isArray(data.content) ? data.content : [];
    const firstText = blocks.find((b) => b && b.type === "text" && b.text);
    const jsonText = firstText ? String(firstText.text).trim() : "";
    if (!jsonText) {
      return Response.json({ success: false, error: "Empty model response" }, { status: 502, headers: cors });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_) {
      const start = jsonText.indexOf("{");
      const end = jsonText.lastIndexOf("}");
      if (start < 0 || end <= start) {
        return Response.json({ success: false, error: "Invalid JSON from model", rawPreview: jsonText.slice(0, 400) }, { status: 502, headers: cors });
      }
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    }

    return Response.json({ success: true, ...parsed }, { headers: cors });
  } catch (e) {
    return Response.json({ success: false, error: toText(e && e.message ? e.message : e) }, { status: 500, headers: cors });
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
      return Response.redirect(url.toString(), 308);
    }

    if (env.DB) await ensureD1Tables(env.DB);

    if (url.pathname === "/api/geo" && request.method === "GET") {
      const country = (request.cf && request.cf.country) ? request.cf.country : "";
      const acceptLanguage = request.headers.get("Accept-Language") || "";
      return json({ country, acceptLanguage });
    }

    if (url.pathname === "/api/tts" && request.method === "POST") return handleTTS(request, env);
    if (url.pathname === "/api/label-script") return withAnthropicSlot(env, handleLabelScript, request);
    if (url.pathname === "/api/claude-parse-script") return withAnthropicSlot(env, handleClaudeParseScript, request);
    if (url.pathname === "/api/parse-screenplay") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PARSE_SCREENPLAY_CORS });
      if (request.method === "POST") return withAnthropicSlot(env, handleParseScreenplay, request, PARSE_SCREENPLAY_CORS);
      return json({ error: "Method not allowed" }, 405, PARSE_SCREENPLAY_CORS);
    }
    if (url.pathname === "/api/parse-script" && request.method === "POST") return withAnthropicSlot(env, handleParseScript, request);
    if (url.pathname === "/api/validate-characters" && request.method === "POST") return withAnthropicSlot(env, handleValidateCharacters, request);
    if (url.pathname === "/api/classify-lines" && request.method === "POST") return withAnthropicSlot(env, handleClassifyLines, request);
    if (url.pathname === "/api/auth" && request.method === "POST") return handleAuth(request, env);
    if (url.pathname === "/api/auth/google" && request.method === "POST") return handleGoogleAuth(request, env);
    if (url.pathname === "/api/session" && request.method === "GET") return handleSession(request, env);
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }
    if (url.pathname === "/api/credits/consume" && request.method === "POST") return handleCreditsConsume(request, env);
    if (url.pathname === "/api/credits/balance" && request.method === "GET") return handleCreditsBalance(request, env);
    if (url.pathname === "/api/credits/topup" && request.method === "POST") return handleCreditsTopup(request, env);
    if (url.pathname === "/api/credits/auto-topup" && request.method === "POST") return handleSetAutoTopup(request, env);
    if (url.pathname === "/api/credits/metered-subscribe" && request.method === "POST") return handleMeteredSubscribe(request, env);
    if (url.pathname === "/api/credits/reconcile" && request.method === "POST") return handlePolarReconcile(request, env);
    if (url.pathname === "/api/polar-webhook" && request.method === "POST") return handlePolarWebhook(request, env);
    // Stripe routes (disabled — kept for reference):
    // if (url.pathname === "/api/stripe-webhook" && request.method === "POST") return handleStripeWebhook(request, env);
    // if (url.pathname === "/api/credits/setup-card" && request.method === "POST") return handleSetupCard(request, env);
    // if (url.pathname === "/api/credits/auto-charge" && request.method === "POST") return handleAutoCharge(request, env);
    if (url.pathname === "/api/invite/redeem" && request.method === "POST") return handleRedeemInvite(request, env);
    if (url.pathname === "/api/admin/create-invite" && request.method === "POST") return handleCreateInvite(request, env);
    if (url.pathname === "/api/admin/list-invites" && request.method === "GET") return handleListInvites(request, env);
    if (url.pathname === "/api/admin/revoke-invite" && request.method === "POST") return handleRevokeInvite(request, env);
    if (url.pathname === "/api/merge-characters" && request.method === "POST") return withAnthropicSlot(env, handleMergeCharacters, request);

    const apiPaths = ["/api/tts", "/api/claude-parse-script", "/api/label-script", "/api/parse-screenplay", "/api/parse-script", "/api/validate-characters", "/api/classify-lines", "/api/merge-characters", "/api/geo", "/api/auth", "/api/auth/google", "/api/session", "/api/credits/", "/api/polar-webhook", "/api/invite/redeem", "/api/admin/"];
    if (apiPaths.some(p => url.pathname.startsWith(p))) {
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const newResponse = new Response(assetResponse.body, assetResponse);
      newResponse.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      newResponse.headers.set("Pragma", "no-cache");
      newResponse.headers.set("Expires", "0");
      newResponse.headers.set("X-App-Version", "2026.05.10a");
      return newResponse;
    }
    return assetResponse;
  },
};
