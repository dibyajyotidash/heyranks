// Fixes from the 23 Nov 2026 product audit. Fake network throughout: a fake site at a public IP literal
// (so the DNS check answers locally), fake PageSpeed, fake Resend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

mkdirSync(".data", { recursive: true });
const dir = mkdtempSync(join(process.cwd(), ".data", "test-audit-"));
process.env.TURSO_DATABASE_URL = `file:${join(dir, "audit.db").replace(/\\/g, "/")}`;
const { handleApi } = await import("../lib/api.js");
const { d1 } = await import("../lib/db.js");
const { runScan, runWeekly, sendPeriodSummaries, fetchPublic, resolveOverHttps } = await import("../lib/core.js");
const { activatePlan, LIFETIME_CAP } = await import("../lib/plans.js");
const { siteOrigin } = await import("../lib/http.js");
const { ensureSchema } = await import("../lib/schema.js");
const { rebuildAllReports } = await import("../lib/reports.js");

const SITE = "93.184.216.34";
const env = { ...process.env, DB: d1(process.env), RESEND_API_KEY: "re_test", RAZORPAY_SECRET: "rzp_secret",
  CASHFREE_APP_ID: "TEST_APP", CASHFREE_SECRET_KEY: "TEST_SECRET", SITE_URL: "https://heyranks.test" };
await ensureSchema(env.DB, rebuildAllReports);
const run = (sql, ...a) => env.DB.prepare(sql).bind(...a).run();
const one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();

// ─── fake network ─────────────────────────────────────────────────────────────
const net = { resend: [], psi: null, calls: [] };
const PAGE = `<html><head><title>Sunrise Dental Clinic Bhubaneswar</title><meta name=viewport content="width=device-width"></head><body><h1>Dentist</h1></body></html>`;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  net.calls.push(u);
  if (u.startsWith("https://api.resend.com/")) {
    const status = net.resend.length ? net.resend.shift() : 200;
    return Response.json(status === 200 ? { id: "em_" + net.calls.length } : { message: "rate limited" }, { status });
  }
  if (u.includes("pagespeedonline")) {
    return net.psi === null ? new Response("quota", { status: 429 })
      : Response.json({ lighthouseResult: { categories: { performance: { score: net.psi / 100 } } } });
  }
  if (u === `https://${SITE}/`) return new Response(PAGE, { headers: { "content-type": "text/html" } });
  if (u.startsWith(`https://${SITE}/`)) return new Response("not found", { status: 404 });
  throw new Error("unexpected fetch " + u);
};

async function call(method, route, { body, cookie, headers = {} } = {}) {
  const h = { host: "heyranks.test", "user-agent": "Mozilla/5.0 Chrome/130", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const req = new Request(`https://heyranks.test/api/${route}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const res = await handleApi(req, env, { waitUntil: p => p.catch(() => {}) }, route.split("?")[0]);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

async function paidUserWithSite(email) {
  const id = crypto.randomUUID(), siteId = crypto.randomUUID(), now = new Date().toISOString();
  await run(`INSERT INTO users (id, email, plan, plan_expires_at, email_verified_at, created_at, updated_at) VALUES (?, ?, '180day', ?, ?, ?, ?)`,
    id, email, new Date(Date.now() + 90 * 864e5).toISOString(), now, now, now);
  await run(`INSERT INTO sites (id, user_id, hostname, created_at) VALUES (?, ?, ?, ?)`, siteId, id, SITE, now);
  return { id, siteId };
}

// ─── #5 score ─────────────────────────────────────────────────────────────────
test("#5 the score doesn't change when PageSpeed doesn't answer", async () => {
  net.psi = null;
  const without = await runScan(SITE, env);
  net.psi = 35;
  const withSlow = await runScan(SITE, env);
  assert.equal(without.speed, null);
  assert.equal(withSlow.speed, 35);
  assert.equal(without.score, withSlow.score, "speed is shown, not scored");
  assert.ok(withSlow.issues.some(i => i.id === "speed"), "a slow site still gets the speed fix");
  net.psi = null;
});

// ─── #2 weekly report delivery ────────────────────────────────────────────────
test("#2 a weekly report the email provider rejects isn't marked sent, and the retry reuses the scan", async () => {
  const { siteId } = await paidUserWithSite("weekly@example.com");
  net.resend = [500];
  const first = await runWeekly(env);
  assert.equal(first.sent, 0);
  assert.equal(first.failed, 1);
  assert.equal((await one("SELECT last_weekly_at FROM sites WHERE id = ?", siteId)).last_weekly_at, null, "still due");
  assert.equal((await one("SELECT COUNT(*) AS n FROM scans WHERE site_id = ?", siteId)).n, 1);

  const retry = await runWeekly(env); // Resend accepts this time
  assert.equal(retry.sent, 1);
  assert.equal((await one("SELECT COUNT(*) AS n FROM scans WHERE site_id = ?", siteId)).n, 1, "no second scan");
  assert.ok((await one("SELECT last_weekly_at FROM sites WHERE id = ?", siteId)).last_weekly_at);
  assert.ok((await one("SELECT emailed_at FROM reports WHERE site_id = ? AND period_type = 'weekly'", siteId)).emailed_at);
  assert.equal((await runWeekly(env)).due, 0, "done for this week");
});

test("#2 without an email key nothing pretends to be sent", async () => {
  const { sendEmail } = await import("../lib/core.js");
  assert.equal((await sendEmail("a@example.com", "s", "<p>x</p>", { ...env, RESEND_API_KEY: "" })).ok, false);
});

// ─── #6 period summaries ──────────────────────────────────────────────────────
test("#6 summaries still go out after a long scheduler outage, but an upgrade doesn't send a backlog", async () => {
  const { id, siteId } = await paidUserWithSite("summary@example.com");
  const now = new Date().toISOString();
  await run(`INSERT INTO reports (id, site_id, user_id, period_type, period_start, period_end, scans_count, score_start, score_end, score_avg,
    score_min, score_max, created_at, updated_at) VALUES (?, ?, ?, 'monthly', '2026-09-01', '2026-10-01', 4, 50, 70, 60, 50, 70, ?, ?)`,
    crypto.randomUUID(), siteId, id, now, now); // ended ~8 weeks ago
  assert.equal((await sendPeriodSummaries(env)).summaries, 1);

  // A Free user with an old unsent summary upgrades: that report is marked handled, not emailed.
  const free = crypto.randomUUID(), freeSite = crypto.randomUUID();
  await run(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, 'upgrade@example.com', ?, ?)`, free, now, now);
  await run(`INSERT INTO sites (id, user_id, hostname, created_at) VALUES (?, ?, 'upgrade.example', ?)`, freeSite, free, now);
  await run(`INSERT INTO reports (id, site_id, user_id, period_type, period_start, period_end, scans_count, score_start, score_end, score_avg,
    score_min, score_max, created_at, updated_at) VALUES (?, ?, ?, 'monthly', '2026-09-01', '2026-10-01', 1, 40, 40, 40, 40, 40, ?, ?)`,
    crypto.randomUUID(), freeSite, free, now, now);
  await activatePlan(env.DB, free, "180day");
  assert.equal((await sendPeriodSummaries(env)).summaries, 0);
});

// ─── #3 other providers' webhooks ─────────────────────────────────────────────
async function razorpay(entity) {
  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity } } });
  const sig = createHmac("sha256", env.RAZORPAY_SECRET).update(raw).digest("hex");
  return call("POST", "webhook", { body: raw, headers: { "x-razorpay-signature": sig } });
}
test("#3 signed webhooks for the wrong plan, currency or amount grant nothing", async () => {
  const { id } = await paidUserWithSite("payer@example.com");
  await run("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ?", id);
  const base = { email: "payer@example.com", currency: "INR", notes: { plan: "lifetime" } };
  for (const [ref, extra] of [["pay_low", { amount: 84900 }], ["pay_usd", { amount: 414900, currency: "USD" }],
                              ["pay_noplan", { amount: 414900, notes: {} }], ["pay_badplan", { amount: 414900, notes: { plan: "forever" } }]]) {
    const r = await razorpay({ ...base, id: ref, ...extra });
    assert.equal(r.status, 200);
    assert.ok(r.data.rejected, ref);
    assert.equal((await one("SELECT status FROM payments WHERE provider_ref = ?", ref)).status, "rejected");
  }
  assert.equal((await one("SELECT plan FROM users WHERE id = ?", id)).plan, "free");
  // Full price plus tax on top is fine.
  assert.equal((await razorpay({ ...base, id: "pay_ok", amount: 489582 })).data.rejected, undefined);
  assert.equal((await one("SELECT plan FROM users WHERE id = ?", id)).plan, "lifetime");
  const rev = await one("SELECT SUM(amount) AS n FROM payments WHERE status = 'paid' AND email = 'payer@example.com'");
  assert.equal(rev.n, 489582, "rejected events never count as revenue");
});

// ─── Lifetime cap ─────────────────────────────────────────────────────────────
test("Lifetime checkout stops at the 500 cap", async () => {
  const cookie = (await call("POST", "auth/signup", { body: { email: "late-buyer@example.com", password: "late buyer pw" } })).cookie;
  const before = (await call("GET", "config")).data.lifetime;
  assert.equal(before.cap, LIFETIME_CAP);
  const taken = LIFETIME_CAP - before.left;
  const rows = Array.from({ length: LIFETIME_CAP - taken }, (_, i) => [crypto.randomUUID(), `b${i}@example.com`, `fill_${i}`]);
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await env.DB.prepare(`INSERT INTO payments (id, email, provider, provider_ref, plan, amount, currency, status, created_at) VALUES
      ${chunk.map(() => "(?, ?, 'manual', ?, 'lifetime', 414900, 'INR', 'paid', datetime('now'))").join(", ")}`).bind(...chunk.flat()).run();
  }
  assert.equal((await call("GET", "config")).data.lifetime.left, 0);
  const r = await call("POST", "checkout", { cookie, body: { plan: "lifetime" } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /sold out/);
});

// ─── #7 resource limits ───────────────────────────────────────────────────────
test("#7 oversized request bodies are refused", async () => {
  const r = await call("POST", "track", { body: JSON.stringify({ path: "/", pad: "x".repeat(70 * 1024) }) });
  assert.equal(r.status, 413);
});

test("#7 the scanner stops reading at 600 KB and skips binary files", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(c) { c.enqueue(new TextEncoder().encode("a".repeat(64 * 1024))); }, // never ends on its own
    }), { headers: { "content-type": "text/html" } });
    const big = await fetchPublic(`https://${SITE}/`);
    assert.equal(big.ok, true);
    assert.equal(big.text.length, 600000);
    globalThis.fetch = async () => new Response("binary", { headers: { "content-type": "application/pdf" } });
    assert.equal((await fetchPublic(`https://${SITE}/robots.txt`)).ok, false);
  } finally { globalThis.fetch = real; }
});

test("#7 DNS-over-HTTPS answers are read when node:dns isn't available", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async url => Response.json(String(url).includes("type=A&") || String(url).endsWith("type=A")
      ? { Answer: [{ type: 5, data: "alias.example." }, { type: 1, data: "10.0.0.5" }] } : { Answer: [] });
    assert.deepEqual(await resolveOverHttps("internal.example"), ["10.0.0.5"]);
  } finally { globalThis.fetch = real; }
});

// ─── #8 links in emails ───────────────────────────────────────────────────────
test("#8 login and payment links never use a Host header from the request", () => {
  const req = host => new Request(`https://${host}/api/auth/magic`, { headers: { host } });
  assert.equal(siteOrigin(req("evil.example"), {}), "https://heyranks.com");
  assert.equal(siteOrigin(req("evil.example"), { SITE_URL: "https://www.heyranks.com/" }), "https://www.heyranks.com");
  assert.equal(siteOrigin(req("evil.example"), { VERCEL_ENV: "preview", VERCEL_URL: "heyranks-git-x.vercel.app" }), "https://heyranks-git-x.vercel.app");
  assert.equal(siteOrigin(new Request("http://localhost:8787/x", { headers: { host: "localhost:8787" } }), {}), "http://localhost:8787");
});
