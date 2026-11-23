/**
 * Cashfree Payment Gateway client (Orders API, version 2023-08-01).
 * Mirrors the integration in market_forecast_web (lib/cashfree/client.ts) but uses Web Crypto,
 * so it runs on Cloudflare Workers as well as Node.
 *
 * Env: CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (sandbox | production),
 *      CASHFREE_WEBHOOK_SECRET (optional; Cashfree signs with the secret key when unset)
 */

const API_VERSION = "2023-08-01";

export function cashfreeConfigured(env) {
  return !!(env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY);
}

export function cashfreeMode(env) {
  const v = String(env.CASHFREE_ENV || "sandbox").toLowerCase().trim();
  return v === "production" || v === "prod" ? "production" : "sandbox";
}

async function request(env, path, init = {}) {
  if (!cashfreeConfigured(env)) throw new Error("Cashfree is not configured (CASHFREE_APP_ID / CASHFREE_SECRET_KEY).");
  const base = cashfreeMode(env) === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  const res = await fetch(base + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-client-id": env.CASHFREE_APP_ID,
      "x-client-secret": env.CASHFREE_SECRET_KEY,
      "x-api-version": API_VERSION,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: `Cashfree answered ${res.status} with a non-JSON body` }; }
  if (!res.ok) {
    console.error("[cashfree] API error", res.status, JSON.stringify(data));
    throw Object.assign(new Error(data.message || `Cashfree request failed (${res.status})`), { status: res.status });
  }
  return data;
}

/** Creates an order. The order id doubles as the idempotency key, so a retry returns the same order. */
export function createOrder(env, order) {
  return request(env, "/orders", {
    method: "POST",
    headers: { "x-idempotency-key": order.order_id },
    body: JSON.stringify(order),
  });
}

export function getOrder(env, orderId) {
  return request(env, `/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
}

/**
 * Cashfree signs webhooks as base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secret)).
 * `raw` must be the body exactly as received.
 */
export async function verifyWebhook(env, raw, signature, timestamp) {
  const secret = env.CASHFREE_WEBHOOK_SECRET || env.CASHFREE_SECRET_KEY;
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp ?? ""}${raw}`)));
  const expected = btoa(String.fromCharCode(...mac));
  const given = String(signature).trim();
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Cashfree wants a 10-digit Indian mobile number; fall back to the placeholder it accepts. */
export function cashfreePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? last10 : "9999999999";
}
