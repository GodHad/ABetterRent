// netlify/functions/send-confirmation.js
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(bodyObj),
  };
}

function safeJsonParse(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return null; }
}

function normalizeEmail(v) {
  return String(v ?? "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
    .replace(/\u00A0/g, " ")               // non-breaking space
    .replace(/\s+/g, "")                   // no whitespace inside email
    .replace(/[),.;:]+$/g, "");            // strip trailing punctuation
}

function isEmail(v) {
  const e = normalizeEmail(v);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e);
}

async function postToAppsScript(payload) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) throw new Error("Missing APPS_SCRIPT_URL");

  // IMPORTANT: Netlify functions should run Node 18+ for global fetch()
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data, raw: text };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const parsed = safeJsonParse(event.body);
  if (parsed === null) return json(400, { error: "Invalid JSON body" });

  const sessionId = String(parsed.session_id || "").trim();
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return json(400, { error: "Invalid session_id format" });
  }

  try {
    // 1) Retrieve session (expand customer is helpful if you ever switch to customer=...)
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["customer"],
    });

    const paid =
      session.status === "complete" &&
      (session.payment_status === "paid" || session.payment_status === "no_payment_required");

    if (!paid) {
      return json(200, { ok: true, paid: false, message: "Not paid yet" });
    }

    // 2) Pull email FROM STRIPE (this is the key fix)
    const email =
      normalizeEmail(
        session.customer_details?.email ||
        session.customer_email ||
        session.customer?.email || // only if expanded customer is an object
        ""
      );

    if (!isEmail(email)) {
      return json(200, {
        ok: true,
        paid: true,
        sheet_email_ok: false,
        error: "Paid, but Stripe session did not contain a usable email.",
        debug_email_fields: {
          customer_details_email: session.customer_details?.email || null,
          customer_email: session.customer_email || null,
          customer_object_email:
            typeof session.customer === "object" ? (session.customer.email || null) : null,
        },
      });
    }

    // 3) Send to Apps Script
    const secret = process.env.APPS_SCRIPT_SECRET;
    if (!secret) throw new Error("Missing APPS_SCRIPT_SECRET");

    const driveUrl = process.env.FOUNDERS_DRIVE_URL || "";

    const result = await postToAppsScript({
      secret,
      email,
      session_id: sessionId,
      status: "paid",
      source: "stripe_checkout",
      drive_url: driveUrl,

      // optional useful fields
      amount_total: session.amount_total ?? null,
      currency: session.currency ?? null,
      mode: session.mode ?? null,
    });

    if (!result.ok || !result.data?.ok) {
      return json(200, {
        ok: true,
        paid: true,
        sheet_email_ok: false,
        apps_script_status: result.status,
        apps_script_response: result.data || result.raw,
      });
    }

    return json(200, { ok: true, paid: true, sheet_email_ok: true });
  } catch (err) {
    return json(err?.statusCode || 500, { error: err?.message || "Server error" });
  }
};
