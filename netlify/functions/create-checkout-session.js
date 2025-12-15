// netlify/functions/create-checkout-session.js
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
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function safeJsonParse(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

function normalizeBaseUrl(event) {
  const envUrl =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.SITE_URL ||
    "";

  if (envUrl) return envUrl.replace(/\/+$/, "");

  // Fallback from request headers (works in many Netlify contexts)
  const proto = event.headers?.["x-forwarded-proto"] || "https";
  const host = event.headers?.host;
  if (host) return `${proto}://${host}`;

  return "http://localhost:8888";
}

function safeReturnUrl(candidate, allowedOrigin) {
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.origin !== allowedOrigin) return null; // prevent open redirects
    return u.toString();
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  const baseUrl = normalizeBaseUrl(event);

  const allowedOrigin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return "*";
    }
  })();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event, allowedOrigin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" }, corsHeaders(event, allowedOrigin));
  }

  const parsed = safeJsonParse(event.body);
  if (parsed === null) {
    return json(400, { error: "Invalid JSON body" }, corsHeaders(event, allowedOrigin));
  }

  const {
    email,
    consent = false,
    source = "founders_page",
    success_url,
    cancel_url,
  } = parsed;

  // Email is optional for Stripe, but your UX expects it—so validate hard.
  const cleanEmail = String(email || "").trim();
  if (!cleanEmail || !isEmail(cleanEmail)) {
    return json(400, { error: "A valid email is required" }, corsHeaders(event, allowedOrigin));
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    return json(500, { error: "Missing STRIPE_PRICE_ID" }, corsHeaders(event, allowedOrigin));
  }

  // If you ever want one-time: set STRIPE_CHECKOUT_MODE=payment
  const mode = (process.env.STRIPE_CHECKOUT_MODE || "subscription").toLowerCase();
  if (!["subscription", "payment"].includes(mode)) {
    return json(500, { error: "Invalid STRIPE_CHECKOUT_MODE (use subscription|payment)" }, corsHeaders(event, allowedOrigin));
  }

  // Default return page (adjust if your real file is different)
  const returnPage = process.env.CHECKOUT_RETURN_PATH || "/founders.html";

  const defaultSuccess = `${baseUrl}${returnPage}?success=true&session_id={CHECKOUT_SESSION_ID}`;
  const defaultCancel  = `${baseUrl}${returnPage}?canceled=true`;

  // Only allow caller-provided URLs if they are same-origin
  const finalSuccessUrl = safeReturnUrl(success_url, allowedOrigin) || defaultSuccess;
  const finalCancelUrl  = safeReturnUrl(cancel_url, allowedOrigin) || defaultCancel;

  try {
    const metadata = {
      abtr_consent: consent ? "true" : "false",
      abtr_source: String(source || "founders_page"),
    };

    const sessionParams = {
      mode,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
      allow_promotion_codes: true,
      customer_email: cleanEmail,
      metadata,
    };

    // If subscription mode, also stamp subscription metadata (nice for reporting)
    if (mode === "subscription") {
      sessionParams.subscription_data = { metadata };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return json(
      200,
      {
        // Return both keys so any frontend works
        sessionId: session.id,
        id: session.id,
      },
      corsHeaders(event, allowedOrigin)
    );
  } catch (err) {
    console.error("create-checkout-session error:", err);
    const msg = err?.message || "Server error creating checkout session";
    const statusCode = err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    return json(statusCode, { error: msg }, corsHeaders(event, allowedOrigin));
  }
};
