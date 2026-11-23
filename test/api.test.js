// End-to-end API tests against a throwaway SQLite file. No network: scans are inserted directly.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "heyranks-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(dir, "test.db").replace(/\\/g, "/")}`;
const { handleApi } = await import("../lib/api.js");
const { d1 } = await import("../lib/db.js");
const { saveScan } = await import("../lib/core.js");
const { createAuthToken } = await import("../lib/auth.js");

const env = { ...process.env, DB: d1(process.env), ADMIN_EMAILS: "owner@example.com", RAZORPAY_SECRET: "rzp_test_secret" };
const ctx = { waitUntil: p => p.catch(() => {}) };
const HOST = "heyranks.test";

async function call(method, route, { body, cookie, headers = {} } = {}) {
  const h = { host: HOST, ...headers };
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const req = new Request(`https://${HOST}/api/${route}`, {
    method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleApi(req, env, ctx, route.split("?")[0]); // entry points pass the path only
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

const fakeScan = (score, ids) => ({
  score, speed: 70, passed: ["Secure HTTPS"],
  issues: ids.map(id => ({ id, label: id, w: 10, fix: `fix ${id}` })),
});

let alice;

before(async () => {
  const r = await call("POST", "auth/signup", { body: { name: "Alice", email: "Alice@Example.com", password: "correct horse", website: "https://alice-bakery.com/menu" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.cookie, /^hr_session=.{20,}/);
  alice = r.cookie;
});

test("signup creates a free, unverified account with the site", async () => {
  const me = await call("GET", "me", { cookie: alice });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, "alice@example.com");
  assert.equal(me.data.user.plan_active, "free");
  assert.equal(me.data.user.email_verified, false);
  assert.equal(me.data.user.is_admin, false);
  const sites = await call("GET", "sites", { cookie: alice });
  assert.equal(sites.data.sites.length, 1);
  assert.equal(sites.data.sites[0].hostname, "alice-bakery.com");
});

test("duplicate signup and bad input are rejected", async () => {
  assert.equal((await call("POST", "auth/signup", { body: { email: "alice@example.com", password: "another pw" } })).status, 409);
  assert.equal((await call("POST", "auth/signup", { body: { email: "not-an-email", password: "another pw" } })).status, 400);
  assert.equal((await call("POST", "auth/signup", { body: { email: "short@example.com", password: "short" } })).status, 400);
});

test("login, wrong password, logout", async () => {
  assert.equal((await call("POST", "auth/login", { body: { email: "alice@example.com", password: "nope nope" } })).status, 401);
  assert.equal((await call("POST", "auth/login", { body: { email: "nobody@example.com", password: "nope nope" } })).status, 401);
  const ok = await call("POST", "auth/login", { body: { email: "ALICE@example.com", password: "correct horse" } });
  assert.equal(ok.status, 200);
  assert.equal((await call("POST", "auth/logout", { cookie: ok.cookie, body: {} })).status, 200);
  assert.equal((await call("GET", "me", { cookie: ok.cookie })).status, 401, "session is gone after logout");
  assert.equal((await call("GET", "me")).status, 401);
});

test("cross-site requests and non-JSON bodies are blocked", async () => {
  const evil = await call("PATCH", "me", { cookie: alice, body: { name: "x" }, headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const form = await call("PATCH", "me", { cookie: alice, body: "name=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415);
});

test("free plan is limited to one site", async () => {
  const r = await call("POST", "sites", { cookie: alice, body: { website: "second-site.com" } });
  assert.equal(r.status, 403);
});

test("scans roll up into all five period reports", async () => {
  const { data } = await call("GET", "sites", { cookie: alice });
  const site = { id: data.sites[0].id, user_id: (await call("GET", "me", { cookie: alice })).data.user.id };
  await saveScan(env.DB, site, fakeScan(40, ["ai", "llms", "title"]), "first", "2026-10-26T06:00:00.000Z");
  await saveScan(env.DB, site, fakeScan(55, ["ai", "llms"]), "weekly", "2026-11-02T06:00:00.000Z");
  await saveScan(env.DB, site, fakeScan(70, ["llms"]), "weekly", "2026-11-09T06:00:00.000Z");

  const weekly = await call("GET", `sites/${site.id}/reports?type=weekly`, { cookie: alice });
  assert.equal(weekly.data.reports.length, 3);
  const monthly = await call("GET", `sites/${site.id}/reports?type=monthly`, { cookie: alice });
  assert.deepEqual(monthly.data.reports.map(r => r.label), ["Nov 2026", "Oct 2026"]);
  const nov = monthly.data.reports[0];
  assert.equal(nov.score_start, 40, "baseline is October's last scan");
  assert.equal(nov.score_end, 70);
  assert.equal(nov.change, 30);
  assert.equal(nov.issues_resolved, 2);
  for (const type of ["quarterly", "half_yearly", "yearly"]) {
    const r = await call("GET", `sites/${site.id}/reports?type=${type}`, { cookie: alice });
    assert.equal(r.data.reports.length, 1, type);
    assert.equal(r.data.reports[0].scans_count, 3, type);
  }
  const detail = await call("GET", `reports/${nov.id}`, { cookie: alice });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.report.summary.resolved.sort(), ["ai", "title"]);
  assert.equal(detail.data.previous.label, "Oct 2026");
  assert.equal((await call("GET", `sites/${site.id}/reports?type=daily`, { cookie: alice })).status, 400);

  const siteDetail = await call("GET", `sites/${site.id}`, { cookie: alice });
  assert.equal(siteDetail.data.latest.score, 70);
  assert.equal(siteDetail.data.latest.prev_score, 55);
});

test("users can't read each other's data", async () => {
  const bob = (await call("POST", "auth/signup", { body: { email: "bob@example.com", password: "bob password" } })).cookie;
  const { data } = await call("GET", "sites", { cookie: alice });
  const siteId = data.sites[0].id;
  assert.equal((await call("GET", `sites/${siteId}`, { cookie: bob })).status, 404);
  assert.equal((await call("GET", `sites/${siteId}/reports`, { cookie: bob })).status, 404);
  assert.equal((await call("DELETE", `sites/${siteId}`, { cookie: bob })).status, 404);
  const reports = await call("GET", `sites/${siteId}/reports?type=monthly`, { cookie: alice });
  assert.equal((await call("GET", `reports/${reports.data.reports[0].id}`, { cookie: bob })).status, 404);
  assert.equal((await call("GET", "admin/overview", { cookie: bob })).status, 403);
});

test("payment before verification is applied when the email is confirmed", async () => {
  const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
    id: "pay_123", email: "alice@example.com", amount: 84900, currency: "INR", notes: { plan: "180day" } } } } });
  const unsigned = await call("POST", "webhook", { body: payload });
  assert.equal(unsigned.status, 400, "unsigned webhooks are rejected");
  const forged = await call("POST", "webhook", { body: payload, headers: { "x-razorpay-signature": "0".repeat(64) } });
  assert.equal(forged.status, 400, "wrong signature is rejected");

  const sig = createHmac("sha256", env.RAZORPAY_SECRET).update(payload).digest("hex");
  assert.equal((await call("POST", "webhook", { body: payload, headers: { "x-razorpay-signature": sig } })).status, 200);
  const retry = await call("POST", "webhook", { body: payload, headers: { "x-razorpay-signature": sig } });
  assert.equal(retry.data.duplicate, true, "provider retries are idempotent");
  assert.equal((await call("GET", "me", { cookie: alice })).data.user.plan_active, "free", "not applied to an unverified email");

  // Alice clicks the confirmation link.
  const me = (await call("GET", "me", { cookie: alice })).data.user;
  const token = await createAuthToken(env.DB, me.id, "magic", 15);
  const verify = await call("POST", "auth/magic/verify", { body: { token } });
  assert.equal(verify.status, 200);
  assert.equal((await call("POST", "auth/magic/verify", { body: { token } })).status, 400, "tokens are single use");
  const after = (await call("GET", "me", { cookie: verify.cookie })).data.user;
  assert.equal(after.email_verified, true);
  assert.equal(after.plan_active, "180day");
  assert.ok(new Date(after.plan_expires_at) > new Date(Date.now() + 179 * 864e5));
});

test("ADMIN_EMAILS grants admin only after the email is verified", async () => {
  const owner = (await call("POST", "auth/signup", { body: { email: "owner@example.com", password: "owner password" } })).cookie;
  assert.equal((await call("GET", "admin/overview", { cookie: owner })).status, 403, "password signup alone isn't enough");
  const { user } = (await call("GET", "me", { cookie: owner })).data;
  const token = await createAuthToken(env.DB, user.id, "magic", 15);
  const admin = (await call("POST", "auth/magic/verify", { body: { token } })).cookie;

  const overview = await call("GET", "admin/overview?days=7", { cookie: admin });
  assert.equal(overview.status, 200);
  assert.equal(overview.data.series.length, 7);
  assert.ok(overview.data.kpis.users >= 3);
  assert.equal(overview.data.revenue[0].total, 84900);

  const users = await call("GET", "admin/users?q=bob", { cookie: admin });
  assert.equal(users.data.users.length, 1);
  const upd = await call("PATCH", `admin/users/${users.data.users[0].id}`, { cookie: admin, body: { plan: "lifetime", payment: { amount: 4149 } } });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.user.plan_active, "lifetime");
  const after = await call("GET", "admin/overview?days=7", { cookie: admin });
  assert.equal(after.data.revenue[0].total, 499800, "manual payment counted in revenue");
});

test("login attempts are rate limited", async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call("POST", "auth/login", { body: { email: "victim@example.com", password: "guess " + i } });
  assert.equal(last.status, 429);
});

test("password reset logs out other sessions", async () => {
  const me = (await call("GET", "me", { cookie: alice })).data.user;
  const { createAuthToken: mk } = await import("../lib/auth.js");
  const token = await mk(env.DB, me.id, "reset", 60);
  const r = await call("POST", "auth/reset", { body: { token, password: "brand new password" } });
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "me", { cookie: alice })).status, 401, "old session revoked");
  assert.equal((await call("POST", "auth/login", { body: { email: "alice@example.com", password: "brand new password" } })).status, 200);
});

test("visits are counted once per visitor per day", async () => {
  const hit = ip => call("POST", "track", { body: { path: "/pricing" }, headers: { "x-real-ip": ip } });
  await hit("1.1.1.1"); await hit("1.1.1.1"); await hit("2.2.2.2");
  const row = await env.DB.prepare("SELECT views, visitors FROM page_views WHERE path = '/pricing'").first();
  assert.equal(row.views, 3);
  assert.equal(row.visitors, 2);
  assert.equal((await call("POST", "track", { body: { path: "/<script>" } })).status, 400);
});

test("public stats and account deletion", async () => {
  const stats = await call("GET", "stats");
  assert.equal(stats.status, 200);
  assert.equal(stats.data.scans, 3);
  const bob = (await call("POST", "auth/login", { body: { email: "bob@example.com", password: "bob password" } })).cookie;
  assert.equal((await call("DELETE", "me", { cookie: bob, body: { confirm: "wrong@example.com" } })).status, 400);
  assert.equal((await call("DELETE", "me", { cookie: bob, body: { confirm: "bob@example.com" } })).status, 200);
  assert.equal((await call("POST", "auth/login", { body: { email: "bob@example.com", password: "bob password" } })).status, 401);
  const pay = await env.DB.prepare("SELECT user_id FROM payments WHERE provider = 'manual'").first();
  assert.equal(pay.user_id, null, "payments are kept for accounting, detached from the deleted user");
});

test("malformed free-scan input doesn't use up the visitor's free scans", async () => {
  for (let i = 0; i < 12; i++) {
    const r = await call("POST", "scan", { body: { url: i % 2 ? "not a website" : "127.0.0.1" }, headers: { "x-real-ip": "9.9.9.9" } });
    assert.equal(r.status, 400);
  }
  const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = 'scan:9.9.9.9'").first();
  assert.equal(row, null, "no free scans were counted");
});
