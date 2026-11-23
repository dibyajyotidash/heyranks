// Visitor analytics: parsing helpers, the /api/track recorder and the admin report. No network.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "heyranks-an-"));
process.env.TURSO_DATABASE_URL = `file:${join(dir, "an.db").replace(/\\/g, "/")}`;
const { handleApi } = await import("../lib/api.js");
const { d1 } = await import("../lib/db.js");
const { parseUserAgent, isBot, referrerHost } = await import("../lib/analytics.js");

const env = { ...process.env, DB: d1(process.env) };
const HOST = "heyranks.test";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function call(method, route, { body, cookie, headers = {} } = {}) {
  const h = { host: HOST, "user-agent": CHROME_ANDROID, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const req = new Request(`https://${HOST}/api/${route}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleApi(req, env, { waitUntil: p => p.catch(() => {}) }, route.split("?")[0]);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

test("user agents, bots and referrers", () => {
  assert.deepEqual(parseUserAgent(CHROME_ANDROID), { device: "Mobile", browser: "Chrome", os: "Android" });
  assert.deepEqual(parseUserAgent(SAFARI_IPHONE), { device: "Mobile", browser: "Safari", os: "iOS" });
  assert.equal(parseUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0").browser, "Edge");
  assert.equal(parseUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 OPR/114.0").browser, "Opera", "Opera also says Chrome");
  assert.equal(parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1").device, "Tablet");
  assert.ok(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)") && isBot("") && isBot("curl/8.0"));
  assert.ok(!isBot(SAFARI_IPHONE));
  assert.equal(referrerHost("https://www.google.com/search?q=dentist", HOST), "google.com", "host only, no query");
  assert.equal(referrerHost(`https://${HOST}/signup`, HOST), null, "own site isn't a referrer");
  assert.equal(referrerHost("", HOST), null);
});

let admin, alice;
before(async () => {
  alice = (await call("POST", "auth/signup", { body: { email: "alice@example.com", password: "alice password" } })).cookie;
  admin = (await call("POST", "auth/signup", { body: { email: "boss@example.com", password: "boss password" } })).cookie;
  await env.DB.prepare("UPDATE users SET role = 'admin' WHERE email = 'boss@example.com'").run();
});

test("a page view is stored with location from the host's headers and no IP address", async () => {
  const r = await call("POST", "track", {
    body: { path: "/", referrer: "https://www.google.com/search?q=seo", session_id: "sess_abcdef12", utm_source: "instagram",
      utm_medium: "social", screen_width: 412, language: "en-IN", timezone: "Asia/Kolkata" },
    headers: { "x-real-ip": "203.0.113.9", "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "OD", "x-vercel-ip-city": "Bhubaneswar" },
  });
  assert.equal(r.status, 204);
  const v = await env.DB.prepare("SELECT * FROM visits").first();
  assert.equal(v.path, "/");
  assert.equal(v.referrer, "google.com");
  assert.deepEqual([v.country, v.region, v.city], ["IN", "OD", "Bhubaneswar"]);
  assert.deepEqual([v.device, v.browser, v.os], ["Mobile", "Chrome", "Android"]);
  assert.equal(v.utm_source, "instagram");
  assert.equal(v.visitor.length, 16);
  assert.ok(!JSON.stringify(v).includes("203.0.113.9"), "the IP address is not stored anywhere in the row");
  // Same visitor's next page, logged in: linked to the account.
  await call("POST", "track", { cookie: alice, body: { path: "/signup", session_id: "sess_abcdef12" }, headers: { "x-real-ip": "203.0.113.9" } });
});

test("bots and admins don't count as visitors", async () => {
  const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM visits").first()).n;
  await call("POST", "track", { body: { path: "/" }, headers: { "user-agent": "Googlebot/2.1" } });
  await call("POST", "track", { cookie: admin, body: { path: "/" } });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM visits").first()).n, before);
});

test("the Visitors report is admin-only and adds up", async () => {
  assert.equal((await call("GET", "admin/analytics?days=7", { cookie: alice })).status, 403);
  // A visit at 06:00 UTC today is 11:00 in India.
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(`INSERT INTO visits (at, day, session_id, visitor, path, device, browser, os)
    VALUES (?, ?, 'sess_ist00001', 'v2', '/privacy', 'Desktop', 'Firefox', 'Linux')`).bind(`${today}T06:00:00.000Z`, today).run();

  const { status, data } = await call("GET", "admin/analytics?days=7", { cookie: admin });
  assert.equal(status, 200);
  assert.equal(data.daily.length, 7);
  assert.equal(data.hours.length, 24);
  assert.ok(data.hours[11].visits >= 1, "06:00 UTC shows as 11:00 IST");
  assert.equal(data.totals.visits, 3);
  assert.equal(data.totals.sessions, 2);
  assert.equal(data.totals.pages_per_session, 1.5);
  assert.equal(data.compare.today_visits, 3);
  assert.deepEqual(data.pages.map(p => p.label).sort(), ["/", "/privacy", "/signup"]);
  assert.equal(data.referrers.find(r => r.label === "google.com").visits, 1);
  assert.equal(data.countries[0].label, "IN");
  assert.equal(data.utm[0].label, "instagram / social");
  const s = data.sessions.find(x => x.session_id === "sess_abcdef12");
  assert.equal(s.pages, "/ → /signup", "pages in the order they were seen");
  assert.equal(s.email, "alice@example.com");
  assert.equal(data.funnel.signups, 2);
  assert.equal(data.funnel.visitors, 2);
});
