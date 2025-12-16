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

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

async function postToAppsScript(payload) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) throw new Error("Missing APPS_SCRIPT_URL");
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

  const email = String(parsed.email || "").trim();
  const sessionId = String(parsed.session_id || "").trim();

  if (!isEmail(email)) return json(400, { error: "A valid email is required" });
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return json(400, { error: "Invalid session_id format" });
  }

  try {
    // 1) Verify payment with Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const paid =
      session.status === "complete" &&
      (session.payment_status === "paid" || session.payment_status === "no_payment_required");

    if (!paid) {
      return json(200, { ok: true, paid: false, message: "Not paid yet" });
    }

    // 2) Log to Google Sheet + send email via Apps Script
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
    });

    // If Apps Script fails, we still return paid=true (payment is real),
    // but expose the logging/email error so you can fix it.
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
