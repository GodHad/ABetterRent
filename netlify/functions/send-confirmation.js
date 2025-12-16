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
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const paid =
      session.status === "complete" &&
      (session.payment_status === "paid" || session.payment_status === "no_payment_required");

    if (!paid) return json(200, { ok: false, paid: false });
    return json(200, { ok: true, paid: true });
  } catch (err) {
    return json(err?.statusCode || 500, { error: err?.message || "Server error" });
  }
};
