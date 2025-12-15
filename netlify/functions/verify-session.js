// netlify/functions/verify-session.js
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

function json(statusCode, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
  };
}

function corsHeaders(event, allowedOrigin) {
  const reqOrigin = event.headers?.origin || event.headers?.Origin;
  const origin = reqOrigin && reqOrigin === allowedOrigin ? reqOrigin : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

exports.handler = async (event) => {
  const baseUrl =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.SITE_URL ||
    "";

  const allowedOrigin = (() => {
    try {
      return baseUrl ? new URL(baseUrl).origin : "*";
    } catch {
      return "*";
    }
  })();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event, allowedOrigin), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method Not Allowed" }, corsHeaders(event, allowedOrigin));
  }

  const sessionId = event.queryStringParameters?.session_id;
  if (!sessionId || typeof sessionId !== "string") {
    return json(400, { error: "Missing session_id" }, corsHeaders(event, allowedOrigin));
  }

  // Stripe session IDs look like: cs_test_..., cs_live_...
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return json(400, { error: "Invalid session_id format" }, corsHeaders(event, allowedOrigin));
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const paid =
      session.status === "complete" &&
      (session.payment_status === "paid" || session.payment_status === "no_payment_required");

    const email =
      session.customer_details?.email ||
      session.customer_email ||
      null;

    // Return BOTH formats:
    // - "paid/email" for your page logic (if you adopt it)
    // - "ok/customer_email" for your current function shape
    return json(
      200,
      {
        paid,
        email,

        ok: paid,
        status: session.status,
        payment_status: session.payment_status,
        customer_email: email || undefined,

        // extra helpful fields (safe, non-sensitive)
        mode: session.mode,
        amount_total: session.amount_total ?? null,
        currency: session.currency ?? null,
        subscription: session.subscription ?? null,
      },
      corsHeaders(event, allowedOrigin)
    );
  } catch (err) {
    console.error("verify-session error:", err);

    // If Stripe gives a known error type, surface cleanly
    const msg = err?.message || "Server error verifying session";
    const statusCode = err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;

    return json(statusCode, { error: msg }, corsHeaders(event, allowedOrigin));
  }
};
