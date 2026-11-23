// Cashfree checkout end to end, against a fake Cashfree API (no network, no real keys).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "heyranks-cf-"));
process.env.TURSO_DATABASE_URL = `file:${join(dir, "cf.db").replace(/\\/g, "/")}`;
const { handleApi } = await import("../lib/api.js");
const { d1 } = await import("../lib/db.js");

const env = { ...process.env, DB: d1(process.env), CASHFREE_APP_ID: "TEST_APP", CASHFREE_SECRET_KEY: "TEST_SECRET",
  CASHFREE_ENV: "sandbox", CASHFREE_WEBHOOK_SECRET: "whsec_test" };
const HOST = "heyranks.test";

// ─── fake Cashfree ────────────────────────────────────────────────────────────
const orders = new Map();
let created = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith("https://sandbox.cashfree.com/pg/")) return realFetch(url, init);
  assert.equal(init.headers["x-client-id"], "TEST_APP");
  assert.equal(init.headers["x-api-version"], "2023-08-01");
  const path = u.slice("https://sandbox.cashfree.com/pg".length);
  if (path === "/orders" && init.method === "POST") {
    const body = JSON.parse(init.body);
    created++;
    const order = { ...body, order_status: "ACTIVE", payment_session_id: `session_${body.order_id}` };
    orders.set(body.order_id, order);
    return Response.json(order);
  }
  const m = path.match(/^\/orders\/(.+)$/);
  if (m && orders.has(decodeURIComponent(m[1]))) return Response.json(orders.get(decodeURIComponent(m[1])));
  return Response.json({ message: "order not found" }, { status: 404 });
};

async function call(method, route, { body, cookie, headers = {} } = {}) {
  const h = { host: HOST, ...headers };
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const req = new Request(`https://${HOST}/api/${route}`, {
    method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleApi(req, env, { waitUntil: p => p.catch(() => {}) }, route.split("?")[0]);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

function signedWebhook(event, secret = env.CASHFREE_WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  const ts = String(Date.now());
  const sig = createHmac("sha256", secret).update(ts + raw).digest("base64");
  return call("POST", "webhook/cashfree", { body: raw, headers: { "x-webhook-signature": sig, "x-webhook-timestamp": ts } });
}
const paidEvent = orderId => ({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: orderId }, payment: { payment_status: "SUCCESS" } } });

let priya, ravi;
before(async () => {
  priya = (await call("POST", "auth/signup", { body: { name: "Priya", email: "priya@example.com", password: "priya password" } })).cookie;
  ravi = (await call("POST", "auth/signup", { body: { email: "ravi@example.com", password: "ravi password" } })).cookie;
  await call("PATCH", "me", { cookie: priya, body: { name: "Priya", whatsapp: "+91 98765 43210" } });
});

test("config advertises Cashfree and INR prices", async () => {
  const { data } = await call("GET", "config");
  assert.deepEqual(data.cashfree, { mode: "sandbox" });
  assert.equal(data.currency, "INR");
  assert.equal(data.plans["180day"].price, 84900);
  assert.equal(data.plans.lifetime.price, 414900);
});

test("checkout needs a login and a paid plan name", async () => {
  assert.equal((await call("POST", "checkout", { body: { plan: "180day" } })).status, 401);
  assert.equal((await call("POST", "checkout", { cookie: priya, body: { plan: "free" } })).status, 400);
});

let orderId;
test("checkout creates a ₹849 Cashfree order and reuses it on a retry", async () => {
  const r = await call("POST", "checkout", { cookie: priya, body: { plan: "180day" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mode, "sandbox");
  orderId = r.data.order_id;
  assert.match(orderId, /^hr_[0-9a-f]{32}$/);
  assert.equal(r.data.payment_session_id, `session_${orderId}`);

  const sent = orders.get(orderId);
  assert.equal(sent.order_amount, 849);
  assert.equal(sent.order_currency, "INR");
  assert.equal(sent.customer_details.customer_email, "priya@example.com");
  assert.equal(sent.customer_details.customer_phone, "9876543210");
  assert.equal(sent.order_meta.return_url, `https://${HOST}/payment?order_id={order_id}`);
  assert.equal(sent.order_meta.notify_url, `https://${HOST}/api/webhook/cashfree`);
  assert.equal(sent.order_tags.plan, "180day");

  const again = await call("POST", "checkout", { cookie: priya, body: { plan: "180day" } });
  assert.equal(again.data.order_id, orderId, "double-click reuses the open order");
  assert.equal(created, 1);
});

test("an unpaid order changes nothing", async () => {
  const r = await call("GET", `checkout/${orderId}`, { cookie: priya });
  assert.equal(r.data.status, "pending");
  assert.equal(r.data.user.plan_active, "free");
  assert.equal((await call("GET", `checkout/${orderId}`, { cookie: ravi })).status, 404, "other users can't see it");
});

test("forged webhooks are rejected", async () => {
  orders.get(orderId).order_status = "PAID";
  assert.equal((await signedWebhook(paidEvent(orderId), "wrong secret")).status, 401);
  const unsigned = await call("POST", "webhook/cashfree", { body: JSON.stringify(paidEvent(orderId)) });
  assert.equal(unsigned.status, 401);
  const me = await call("GET", "me", { cookie: priya });
  assert.equal(me.data.user.plan_active, "free");
});

test("a verified webhook grants the plan once, even when repeated", async () => {
  const r = await signedWebhook(paidEvent(orderId));
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "paid");
  await signedWebhook(paidEvent(orderId));                       // Cashfree retry
  await call("GET", `checkout/${orderId}`, { cookie: priya });   // return page polling at the same time
  const { user } = (await call("GET", "me", { cookie: priya })).data;
  assert.equal(user.plan_active, "180day");
  const days = (new Date(user.plan_expires_at) - Date.now()) / 864e5;
  assert.ok(days > 179 && days < 181, `granted once, not stacked: ${days} days`);
});

test("a webhook can't be believed over Cashfree's API", async () => {
  const r = await call("POST", "checkout", { cookie: ravi, body: { plan: "lifetime" } });
  assert.equal(orders.get(r.data.order_id).order_amount, 4149);
  // Signed event says paid, but the API still shows the order ACTIVE.
  assert.equal((await signedWebhook(paidEvent(r.data.order_id))).data.status, "pending");
  // Paid, but for the wrong amount.
  Object.assign(orders.get(r.data.order_id), { order_status: "PAID", order_amount: 1 });
  assert.equal((await signedWebhook(paidEvent(r.data.order_id))).data.status, "pending");
  assert.equal((await call("GET", "me", { cookie: ravi })).data.user.plan_active, "free");
  // Correct amount: Lifetime granted, and no more checkouts needed.
  orders.get(r.data.order_id).order_amount = 4149;
  assert.equal((await call("GET", `checkout/${r.data.order_id}`, { cookie: ravi })).data.user.plan_active, "lifetime");
  assert.equal((await call("POST", "checkout", { cookie: ravi, body: { plan: "180day" } })).status, 400);
});

test("a full refund takes the payment out of revenue", async () => {
  await signedWebhook({ type: "REFUND_STATUS_WEBHOOK", data: { refund: { order_id: orderId, refund_status: "SUCCESS", refund_amount: 849 } } });
  const row = await env.DB.prepare("SELECT status FROM payments WHERE provider_ref = ?").bind(orderId).first();
  assert.equal(row.status, "refunded");
  const paid = await env.DB.prepare("SELECT SUM(amount) AS n FROM payments WHERE status = 'paid'").first();
  assert.equal(paid.n, 414900, "only Ravi's lifetime payment counts");
});
