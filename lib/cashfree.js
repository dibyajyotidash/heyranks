/**
 * Cashfree Payment Gateway client (Orders API, version 2023-08-01).
 * Mirrors the integration in market_forecast_web (lib/cashfree/client.ts) but uses Web Crypto,
 * so it runs on Cloudflare Workers as well as Node.
 *
 * Env: CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (sandbox | production),
 *      CASHFREE_WEBHOOK_SECRET (optional; Cashfree signs with the secret key when unset)
 */

import { activatePlan } from "./plans.js";

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

// ─── settlement ──────────────────────────────────────────────────────────────

/**
 * Reads the order from Cashfree and grants the plan once it's PAID. Safe to call any number of
 * times: only the call that flips the payment from 'pending' to 'paid' grants the plan, and it
 * returns granted: true so the caller can send the receipt email exactly once.
 */
export async function settleCashfreeOrder(db, env, orderId) {
  const pay = await db.prepare("SELECT * FROM payments WHERE provider = 'cashfree' AND provider_ref = ?").bind(orderId).first();
  if (!pay) return { status: "unknown" };
  const base = { order_id: orderId, plan: pay.plan, user_id: pay.user_id, amount: pay.amount, currency: pay.currency };
  if (pay.status !== "pending") return { ...base, status: pay.status, granted: false };

  const cf = await getOrder(env, orderId);
  const status = String(cf.order_status || "").toUpperCase();
  if (status === "PAID") {
    if (Math.round(Number(cf.order_amount) * 100) !== pay.amount || String(cf.order_currency).toUpperCase() !== pay.currency) {
      console.error("[cashfree] amount mismatch, plan NOT granted", orderId, cf.order_amount, cf.order_currency, pay.amount);
      return { ...base, status: "pending", granted: false };
    }
    const won = await db.prepare("UPDATE payments SET status = 'paid', applied_at = ? WHERE id = ? AND status = 'pending' RETURNING id")
      .bind(new Date().toISOString(), pay.id).first();
    if (won && pay.user_id) await activatePlan(db, pay.user_id, pay.plan);
    return { ...base, status: "paid", granted: !!(won && pay.user_id) };
  }
  if (status === "EXPIRED" || status === "TERMINATED") {
    await db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").bind(pay.id).run();
    return { ...base, status: "failed", granted: false };
  }
  return { ...base, status: "pending", granted: false }; // ACTIVE: not paid yet, or an attempt failed and can be retried
}

/**
 * Daily safety net: re-checks orders from the last 7 days that are still 'pending'. Catches buyers
 * who paid, closed the tab before the return page loaded, and whose webhook never reached us.
 */
export async function settlePendingCashfreeOrders(db, env, limit = 50) {
  if (!cashfreeConfigured(env)) return { checked: 0, granted: [] };
  const { results } = await db.prepare(`SELECT provider_ref FROM payments
    WHERE provider = 'cashfree' AND status = 'pending' AND session_id IS NOT NULL AND created_at > ?
    ORDER BY created_at LIMIT ?`).bind(new Date(Date.now() - 7 * 864e5).toISOString(), limit).all();
  const granted = [];
  for (const { provider_ref } of results) {
    try {
      const s = await settleCashfreeOrder(db, env, provider_ref);
      if (s.granted) granted.push(s);
    } catch (err) {
      console.error("[cashfree] daily check failed for", provider_ref, err.message);
    }
  }
  return { checked: results.length, granted };
}

/** Cashfree wants a 10-digit Indian mobile number; fall back to the placeholder it accepts. */
export function cashfreePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? last10 : "9999999999";
}
