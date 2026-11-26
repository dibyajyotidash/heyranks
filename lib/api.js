/**
 * HeyRanks API router. Both entry points call handleApi():
 *   Cloudflare: _worker.js     Vercel: api/index.js     Local: scripts/dev.mjs
 *
 * Public
 *   POST /api/scan                    free scan (rate limited per IP)
 *   GET  /api/stats                   live counters for the landing page (demo accounts excluded)
 *   GET  /api/config                  payment links for the upgrade buttons
 *   POST /api/track                   anonymous page-visit counter
 * Auth
 *   POST /api/auth/signup             {name,email,password,website?,keywords?}
 *   POST /api/auth/login              {email,password}
 *   POST /api/auth/logout
 *   POST /api/auth/magic              {email}           emails a login link
 *   POST /api/auth/magic/verify       {token}
 *   POST /api/auth/forgot             {email}           emails a reset link
 *   POST /api/auth/reset              {token,password}
 * Signed-in user
 *   GET|PATCH|DELETE /api/me          profile / delete account
 *   POST /api/me/password             {current?,password}
 *   GET|POST /api/sites               list / add
 *   GET|PATCH|DELETE /api/sites/:id   detail (latest scan + fixes) / keywords+pause / remove
 *   POST /api/sites/:id/scan          rescan now
 *   GET|POST /api/sites/:id/audits    list / start a full-site audit (paid plans)
 *   GET  /api/audits/:id              audit progress, or the full report when complete
 *   POST /api/audits/:id/cancel
 *   POST /api/audits/:id/continue     machine: next run of a long audit (header X-Audit-Token, HMAC-signed)
 *   PATCH /api/sites/:id/findings     {fingerprint,status}  mark a finding done / ignored / open
 *   POST /api/sites/:id/recheck       {fingerprint}         re-measure one finding now
 *   GET|POST /api/sites/:id/competitors, DELETE /api/sites/:id/competitors/:cid
 *   GET  /api/sites/:id/reports?type=weekly|monthly|quarterly|half_yearly|yearly
 *   GET  /api/reports/:id             one period report with its issues
 * Admin
 *   GET  /api/admin/overview?days=30  users, revenue, reports, visits + daily series
 *   GET  /api/admin/analytics?days=30 visitors: traffic, pages, referrers, devices, locations, sessions, funnel
 *   GET  /api/admin/users?q=          user list
 *   PATCH /api/admin/users/:id        {plan,status,role,payment:{amount,currency}}
 * Payments (Cashfree)
 *   POST /api/checkout                {plan}  -> Cashfree order + payment_session_id for the JS SDK
 *   GET  /api/checkout/:orderId       settles the order (asks Cashfree) and returns its status
 *   POST /api/webhook/cashfree        Cashfree webhook (signature verified, then re-checked via the API)
 * Machines
 *   POST /api/webhook                 Stripe / Razorpay / Lemon Squeezy (signature verified)
 *   POST /api/weekly                  manual daily job (header X-Admin-Secret)
 *   GET  /api/cron                    Vercel Cron (header Authorization: Bearer $CRON_SECRET)
 */
import { HttpError, json, readJson, assertSameOrigin, clientIp, siteOrigin, isEmail } from "./http.js";
import { ensureSchema } from "./schema.js";
import { rebuildAllReports, presentReport, periodLabel, PERIOD_TYPES } from "./reports.js";
import {
  getUser, requireUser, requireAdmin, isAdmin, createSession, destroySession, hashPassword, verifyPassword,
  checkPasswordRules, createAuthToken, consumeAuthToken, rateLimit, sha256,
} from "./auth.js";
import {
  runScan, saveScan, normalize, codeSnippet, sendEmail, simpleEmail, welcomeEmail, escHtml,
  PLANS, PRICE_CURRENCY, effectivePlan, runDaily, notifyPlanActivated, generateAiSummary,
} from "./core.js";
import { activatePlan, revokePlan, CASHFREE_CURRENCY } from "./plans.js";
import { startAudit, runAudit, cancelAudit, auditIsStale, auditData, recheckFinding, continuationToken, requestContinuation, canContinue, PAGE_LIMIT } from "./audit.js";
import { presentFinding, CATEGORIES, CHECKS, SEVERITY_RANK } from "./catalog.js";
import { organizationalDomain } from "./domain.js";
import { MARKETS, AI_PROVIDERS, dfsConfigured } from "./providers.js";
import { claudeModel } from "./ai.js";
import { isBot, recordVisit, visitorAnalytics } from "./analytics.js";
import {
  cashfreeConfigured, cashfreeMode, cashfreePhone, createOrder, verifyWebhook, settleCashfreeOrder,
} from "./cashfree.js";

const DAY = 864e5;
const nowIso = () => new Date().toISOString();
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ─── router ───────────────────────────────────────────────────────────────────

const ROUTES = [
  ["POST",   /^scan$/,                     publicScan,       { db: false }],
  ["GET",    /^stats$/,                    publicStats],
  ["GET",    /^config$/,                   publicConfig,     { db: false }],
  ["POST",   /^track$/,                    trackVisit],
  ["POST",   /^auth\/signup$/,             signup],
  ["POST",   /^auth\/login$/,              login],
  ["POST",   /^auth\/logout$/,             logout],
  ["POST",   /^auth\/magic$/,              sendMagicLink],
  ["POST",   /^auth\/magic\/verify$/,      verifyMagicLink],
  ["POST",   /^auth\/forgot$/,             forgotPassword],
  ["POST",   /^auth\/reset$/,              resetPassword],
  ["GET",    /^me$/,                       getMe],
  ["PATCH",  /^me$/,                       updateMe],
  ["DELETE", /^me$/,                       deleteMe],
  ["POST",   /^me\/password$/,             changePassword],
  ["GET",    /^sites$/,                    listSites],
  ["POST",   /^sites$/,                    addSite],
  ["GET",    /^sites\/([\w-]+)$/,          getSite],
  ["PATCH",  /^sites\/([\w-]+)$/,          updateSite],
  ["DELETE", /^sites\/([\w-]+)$/,          deleteSite],
  ["POST",   /^sites\/([\w-]+)\/scan$/,    rescanSite],
  ["GET",    /^sites\/([\w-]+)\/audits$/,  listAudits],
  ["POST",   /^sites\/([\w-]+)\/audits$/,  createAudit],
  ["PATCH",  /^sites\/([\w-]+)\/findings$/, setFindingStatus],
  ["POST",   /^sites\/([\w-]+)\/recheck$/, recheck],
  ["GET",    /^sites\/([\w-]+)\/competitors$/, listCompetitors],
  ["POST",   /^sites\/([\w-]+)\/competitors$/, addCompetitor],
  ["DELETE", /^sites\/([\w-]+)\/competitors\/([\w-]+)$/, removeCompetitor],
  ["GET",    /^audits\/([\w-]+)$/,         getAudit],
  ["POST",   /^audits\/([\w-]+)\/cancel$/, cancelAuditRoute],
  ["POST",   /^audits\/([\w-]+)\/continue$/, continueAuditRoute, { csrf: false }],
  ["GET",    /^sites\/([\w-]+)\/reports$/, listReports],
  ["GET",    /^reports\/([\w-]+)$/,        getReport],
  ["GET",    /^admin\/overview$/,          adminOverview],
  ["GET",    /^admin\/analytics$/,         adminAnalytics],
  ["GET",    /^admin\/users$/,             adminUsers],
  ["PATCH",  /^admin\/users\/([\w-]+)$/,   adminUpdateUser],
  ["POST",   /^checkout$/,                 startCheckout],
  ["GET",    /^checkout\/([\w-]+)$/,       checkoutStatus],
  ["POST",   /^webhook\/cashfree$/,        cashfreeWebhook,  { csrf: false }],
  ["POST",   /^webhook$/,                  webhook,          { csrf: false }],
  ["POST",   /^weekly$/,                   manualDaily,      { csrf: false }],
  ["GET",    /^cron$/,                     cron,             { csrf: false }],
];

/**
 * @param route  path after /api/, e.g. "sites/abc/scan"
 * @param opts   { jobOpts } passed to the daily job (time budget, concurrency)
 */
export async function handleApi(request, env, ctx, route, opts = {}) {
  try {
    const path = route.replace(/^\/+|\/+$/g, "");
    const match = ROUTES.map(([m, re, fn, o = {}]) => ({ m, fn, o, p: path.match(re) })).filter(r => r.p);
    if (!match.length) return json({ error: "Not found" }, 404);
    const hit = match.find(r => r.m === request.method);
    if (!hit) return json({ error: "Method not allowed" }, 405);

    if (hit.o.csrf !== false && request.method !== "GET") assertSameOrigin(request);
    const db = env.DB;
    if (hit.o.db !== false) {
      if (!db) return json({ error: "Database not configured." }, 503);
      await ensureSchema(db, rebuildAllReports);
    }
    return await hit.fn({ request, env, ctx, db, params: hit.p.slice(1), url: new URL(request.url), opts });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("[api]", route, err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

// ─── shared helpers ───────────────────────────────────────────────────────────

function presentUser(u, env) {
  const plan = effectivePlan(u);
  return {
    id: u.id, email: u.email, name: u.name, company: u.company, whatsapp: u.whatsapp,
    plan: u.plan, plan_active: plan, plan_label: PLANS[plan].label, plan_expires_at: u.plan_expires_at,
    limits: PLANS[plan], email_verified: !!u.email_verified_at, has_password: !!u.password_hash,
    is_admin: isAdmin(u, env), created_at: u.created_at,
  };
}

async function ownedSite(db, user, id) {
  const site = await db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!site) throw new HttpError(404, "Site not found.");
  return site;
}

function parseKeywords(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(",");
  return list.map(k => str(k, 80)).filter(Boolean).slice(0, 5);
}

/** Applies payments made with this email before the account existed (or before it was verified). */
async function claimPayments(db, userId, email) {
  const { results } = await db.prepare(
    "SELECT * FROM payments WHERE email = ? AND user_id IS NULL AND status = 'paid' ORDER BY created_at").bind(email).all();
  for (const p of results) {
    await activatePlan(db, userId, p.plan);
    await db.prepare("UPDATE payments SET user_id = ?, applied_at = ? WHERE id = ?").bind(userId, nowIso(), p.id).run();
  }
}

/** The user proved they own the email (magic link or reset): mark verified and claim payments. */
async function markVerified(db, userId) {
  const u = await db.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").bind(userId).first();
  if (!u) return;
  if (!u.email_verified_at) await db.prepare("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), userId).run();
  await claimPayments(db, userId, u.email);
}

async function emailLoginLink(c, user, minutes, title, intro) {
  const token = await createAuthToken(c.db, user.id, "magic", minutes);
  const link = `${siteOrigin(c.request, c.env)}/login?magic=${encodeURIComponent(token)}`;
  await sendEmail(user.email, title, simpleEmail(title, intro, "Log in to HeyRanks →", link), c.env);
}

// ─── public ───────────────────────────────────────────────────────────────────

// Each scan makes a few dozen outside requests (the site's pages, robots.txt and sitemap, DNS-over-HTTPS
// lookups, RDAP, a TLS handshake and PageSpeed), so scans are limited three ways: per visitor (10 an hour),
// site-wide for the free scan (FREE_SCANS_PER_HOUR, default 300), and at most SCAN_SLOTS at once per
// server instance. Extra requests wait up to 15 seconds for a slot, then get a "busy" answer.
const SCAN_SLOTS = 6;
let scansRunning = 0;
async function withScanSlot(fn) {
  const giveUp = Date.now() + 15000;
  while (scansRunning >= SCAN_SLOTS) {
    if (Date.now() > giveUp) throw new HttpError(503, "Scans are very busy right now. Please try again in a minute.");
    await new Promise(r => setTimeout(r, 250));
  }
  scansRunning++;
  try { return await fn(); } finally { scansRunning--; }
}

async function publicScan({ request, env, db }) {
  const body = await readJson(request);
  // Validate first, so a mistyped address doesn't use up one of the visitor's free scans.
  let site;
  try { site = normalize(body.url); } catch (e) { throw new HttpError(400, e.message); }
  if (db) {
    await ensureSchema(db, rebuildAllReports);
    await rateLimit(db, `scan:${clientIp(request)}`, 10, 3600, "You've run a lot of free scans. Please try again in an hour.");
    await rateLimit(db, "scan:all", Number(env.FREE_SCANS_PER_HOUR) || 300, 3600,
      "Free scans are very busy right now. Please try again in a few minutes, or create a free account.");
  }
  const scan = await withScanSlot(() => runScan(site.hostname, env));
  if (scan.unreachable) throw new HttpError(422, scan.message);
  const d = scan.details;
  return json({
    site: site.hostname, score: scan.score, speed: scan.speed, passed: scan.passed,
    top_issues: scan.top_issues.map(c => ({ label: c.label, fix: c.fix, severity: c.severity, category: CATEGORIES[c.category]?.label || c.category })),
    more_issues: scan.more_issues,
    categories: Object.entries(d.scores.categories).map(([id, c]) => ({ id, label: c.label, score: c.score })),
    coverage: d.scores.coverage, confidence: d.scores.confidence, capped: !!d.scores.capped, counts: d.scores.counts,
    alerts: d.alerts.map(a => ({ title: a.title, severity: a.severity, detected: a.detected })),
    email: d.email ? { domain: d.email.domain, spf: d.email.spf.length === 1, dmarc: !!d.email.dmarc, provider: d.email.provider, dkim: d.email.dkim_selectors.length > 0 } : null,
    domain: d.domain ? { expires: d.domain.expires, days_left: d.domain.days_left } : null,
  });
}

async function publicStats({ db }) {
  const real = "user_id NOT IN (SELECT id FROM users WHERE role = 'demo')";
  const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM sites WHERE ${real}) AS sites,
      (SELECT COUNT(*) FROM scans WHERE ${real}) AS scans,
      (SELECT COALESCE(SUM(checks_count), 0) FROM scans WHERE ${real}) AS checks,
      (SELECT COALESCE(SUM(issues_count), 0) FROM scans WHERE ${real}) AS issues,
      (SELECT COUNT(*) FROM reports WHERE ${real} AND emailed_at IS NOT NULL) AS reports_sent`).first();
  return json(row, 200, { "cache-control": "public, max-age=300" });
}

async function publicConfig({ env }) {
  return json({
    cashfree: cashfreeConfigured(env) ? { mode: cashfreeMode(env) } : null,
    payment_links: { "180day": env.PAYMENT_LINK_180DAY || null },
    plans: PLANS,
    currency: PRICE_CURRENCY,
  }, 200, { "cache-control": "public, max-age=60" });
}

async function trackVisit({ request, db, env }) {
  const body = await readJson(request);
  const path = str(body.path, 64).toLowerCase().replace(/\/+$/, "") || "/";
  if (!/^\/[a-z0-9\-/]*$/.test(path)) throw new HttpError(400, "Bad path.");
  const skip = new Response(null, { status: 204 });
  if (isBot(request.headers.get("user-agent") || "")) return skip;
  // Your own browsing as an admin doesn't count as traffic.
  const user = await getUser(db, request);
  if (isAdmin(user, env) || user?.role === "demo") return skip;
  // A runaway script can't flood the table: past 300 page views an hour from one visitor, stop recording.
  try { await rateLimit(db, `pvr:${await sha256(`${clientIp(request)}|${request.headers.get("user-agent")}`)}`, 300, 3600); }
  catch { return skip; }

  await recordVisit(db, request, env, body, path, user?.id);
  const day = nowIso().slice(0, 10);
  // Unique-visitor marker: a hash in rate_limits that expires tomorrow. The IP itself is never stored.
  const key = `pv:${await sha256(`${clientIp(request)}|${day}|${path}`)}`;
  const first = await db.prepare("INSERT OR IGNORE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)")
    .bind(key, new Date(Date.now() + DAY).toISOString()).run();
  const unique = first.meta?.changes ? 1 : 0;
  await db.prepare(`INSERT INTO page_views (day, path, views, visitors) VALUES (?, ?, 1, ?)
    ON CONFLICT (day, path) DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors`).bind(day, path, unique).run();
  return new Response(null, { status: 204 });
}

// ─── auth ─────────────────────────────────────────────────────────────────────

async function signup(c) {
  const { request, db, env } = c;
  const body = await readJson(request);
  await rateLimit(db, `signup:${clientIp(request)}`, 10, 3600);

  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid email address.");
  const password = checkPasswordRules(body.password);
  const name = str(body.name, 80) || null;

  let hostname = null;
  if (str(body.website, 255)) {
    try { hostname = normalize(body.website).hostname; } catch (e) { throw new HttpError(400, e.message); }
  }
  if (await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first())
    throw new HttpError(409, "An account with this email already exists. Log in instead, or use “Forgot password”.");

  const id = crypto.randomUUID();
  const now = nowIso();
  await db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, email, name, await hashPassword(password), now, now).run();
  if (hostname) {
    // last_weekly_at = now: the first scan runs from the dashboard; the first weekly report comes next Monday.
    await db.prepare(`INSERT INTO sites (id, user_id, hostname, keywords, created_at, last_weekly_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, hostname, JSON.stringify(parseKeywords(body.keywords)), now, now).run();
  }

  // Confirms the email. Payments made with this address are applied once it's confirmed.
  const user = { id, email };
  const confirm = emailLoginLink(c, user, 24 * 60, "Confirm your HeyRanks email",
    `Hi${name ? " " + escHtml(name) : ""}, click below to confirm your email address. If you've already paid, this also activates your plan.`)
    .catch(err => console.error("[signup] confirm email failed", err));
  c.ctx?.waitUntil ? c.ctx.waitUntil(confirm) : await confirm;

  return json({ ok: true }, 200, { "set-cookie": await createSession(db, request, id) });
}

async function login({ request, db }) {
  const body = await readJson(request);
  const email = str(body.email, 254).toLowerCase();
  await rateLimit(db, `login:${email}`, 10, 900);
  await rateLimit(db, `login-ip:${clientIp(request)}`, 50, 900);

  const user = isEmail(email) ? await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first() : null;
  const ok = await verifyPassword(body.password, user?.password_hash);
  if (user && !user.password_hash)
    throw new HttpError(400, "This account doesn't have a password yet. Use “Email me a login link” instead.");
  if (!user || !ok) throw new HttpError(401, "Wrong email or password.");
  if (user.status !== "active") throw new HttpError(403, "This account is disabled. Contact hello@dexosoftsolutions.com.");
  return json({ ok: true }, 200, { "set-cookie": await createSession(db, request, user.id) });
}

async function logout({ request, db }) {
  return json({ ok: true }, 200, { "set-cookie": await destroySession(db, request) });
}

async function sendMagicLink(c) {
  const body = await readJson(c.request);
  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid email address.");
  await rateLimit(c.db, `magic:${email}`, 5, 3600);
  await rateLimit(c.db, `magic-ip:${clientIp(c.request)}`, 20, 3600);
  const user = await c.db.prepare("SELECT id, email FROM users WHERE email = ? AND status = 'active'").bind(email).first();
  if (user) await emailLoginLink(c, user, 15, "Your HeyRanks login link", "Click below to log in. The link works once and expires in 15 minutes.");
  // Same answer whether or not the account exists, so this can't be used to discover emails.
  return json({ ok: true });
}

async function verifyMagicLink({ request, db }) {
  const body = await readJson(request);
  const userId = await consumeAuthToken(db, body.token, "magic");
  if (!userId) throw new HttpError(400, "This login link has expired or was already used. Request a new one below.");
  await markVerified(db, userId);
  return json({ ok: true }, 200, { "set-cookie": await createSession(db, request, userId) });
}

async function forgotPassword(c) {
  const body = await readJson(c.request);
  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid email address.");
  await rateLimit(c.db, `forgot:${email}`, 5, 3600);
  await rateLimit(c.db, `forgot-ip:${clientIp(c.request)}`, 20, 3600);
  const user = await c.db.prepare("SELECT id, email FROM users WHERE email = ? AND status = 'active'").bind(email).first();
  if (user) {
    const token = await createAuthToken(c.db, user.id, "reset", 60);
    const link = `${siteOrigin(c.request, c.env)}/reset?token=${encodeURIComponent(token)}`;
    await sendEmail(user.email, "Reset your HeyRanks password",
      simpleEmail("Reset your password", "Click below to choose a new password. The link works once and expires in 1 hour. If you didn't ask for this, ignore this email.", "Choose a new password →", link), c.env);
  }
  return json({ ok: true });
}

async function resetPassword({ request, db }) {
  const body = await readJson(request);
  const password = checkPasswordRules(body.password);
  const userId = await consumeAuthToken(db, body.token, "reset");
  if (!userId) throw new HttpError(400, "This reset link has expired or was already used. Request a new one.");
  await db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(password), nowIso(), userId).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run(); // log out everywhere else
  await markVerified(db, userId);
  return json({ ok: true }, 200, { "set-cookie": await createSession(db, request, userId) });
}

// ─── me ───────────────────────────────────────────────────────────────────────

async function getMe({ request, db, env }) {
  const user = await requireUser(db, request);
  return json({ user: presentUser(user, env) });
}

async function updateMe({ request, db, env }) {
  const user = await requireUser(db, request);
  const body = await readJson(request);
  const whatsapp = str(body.whatsapp, 24);
  if (whatsapp && !/^\+?[0-9 ()-]{6,24}$/.test(whatsapp)) throw new HttpError(400, "Enter the WhatsApp number with country code, e.g. +91 98765 43210.");
  await db.prepare("UPDATE users SET name = ?, company = ?, whatsapp = ?, updated_at = ? WHERE id = ?")
    .bind(str(body.name, 80) || null, str(body.company, 120) || null, whatsapp || null, nowIso(), user.id).run();
  return json({ user: presentUser(await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first(), env) });
}

async function changePassword({ request, db }) {
  const user = await requireUser(db, request);
  const body = await readJson(request);
  await rateLimit(db, `pw:${user.id}`, 10, 3600);
  if (user.password_hash && !(await verifyPassword(body.current, user.password_hash)))
    throw new HttpError(400, "Your current password is wrong.");
  const password = checkPasswordRules(body.password);
  await db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(password), nowIso(), user.id).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, user.session_id).run();
  return json({ ok: true });
}

async function deleteMe({ request, db }) {
  const user = await requireUser(db, request);
  const body = await readJson(request);
  if (str(body.confirm, 254).toLowerCase() !== user.email) throw new HttpError(400, "Type your email address to confirm.");
  await db.prepare("DELETE FROM audit_pages WHERE audit_id IN (SELECT id FROM audits WHERE user_id = ?)").bind(user.id).run();
  await db.prepare("DELETE FROM finding_status WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?)").bind(user.id).run();
  await db.prepare("UPDATE usage_events SET user_id = NULL, site_id = NULL WHERE user_id = ?").bind(user.id).run(); // costs kept, anonymised
  for (const t of ["findings", "audits", "competitors", "reports", "scans", "sites", "sessions", "auth_tokens"])
    await db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id).run();
  await db.prepare("UPDATE payments SET user_id = NULL WHERE user_id = ?").bind(user.id).run(); // kept for accounting
  await db.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  return json({ ok: true }, 200, { "set-cookie": await destroySession(db, request) });
}

// ─── sites ────────────────────────────────────────────────────────────────────

async function listSites({ request, db }) {
  const user = await requireUser(db, request);
  const { results } = await db.prepare(`
    SELECT s.id, s.hostname, s.keywords, s.status, s.created_at, s.last_scan_at,
      (SELECT score FROM scans WHERE site_id = s.id ORDER BY created_at DESC LIMIT 1) AS score,
      (SELECT COUNT(*) FROM scans WHERE site_id = s.id) AS scans_count
    FROM sites s WHERE s.user_id = ? ORDER BY s.created_at`).bind(user.id).all();
  return json({ sites: results.map(s => ({ ...s, keywords: parseJson(s.keywords, []) })) });
}

async function addSite({ request, db }) {
  const user = await requireUser(db, request);
  const body = await readJson(request);
  const plan = PLANS[effectivePlan(user)];
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?").bind(user.id).first();
  if (n >= plan.sites) throw new HttpError(403, `Your plan includes ${plan.sites} site${plan.sites > 1 ? "s" : ""}. Remove a site to add another.`);
  let hostname;
  try { hostname = normalize(body.website).hostname; } catch (e) { throw new HttpError(400, e.message); }
  if (await db.prepare("SELECT 1 FROM sites WHERE user_id = ? AND hostname = ?").bind(user.id, hostname).first())
    throw new HttpError(409, "You're already tracking that site.");
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.prepare(`INSERT INTO sites (id, user_id, hostname, keywords, created_at, last_weekly_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, user.id, hostname, JSON.stringify(parseKeywords(body.keywords)), now, now).run();
  return json({ site: { id, hostname } }, 201);
}

/** Site + its latest scan with copy-paste fixes. Shared by GET and the rescan response. */
async function siteDetail(db, site) {
  const { results: recent } = await db.prepare(
    "SELECT * FROM scans WHERE site_id = ? ORDER BY created_at DESC LIMIT 2").bind(site.id).all();
  const [latest, prev] = recent;
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM scans WHERE site_id = ?").bind(site.id).first();
  const details = latest ? parseJson(latest.details ?? "null", null) : null;
  const findingsById = new Map((details?.findings || []).map(f => [f.check_id, f]));
  // A score from the older scoring method isn't comparable, so no "since last scan" change is shown across it.
  const version = s => parseJson(s?.details ?? "null", null)?.score_version ?? 1;
  const comparable = prev && version(prev) === version(latest);
  const audit = await db.prepare(`SELECT id, kind, status, stage, score, coverage, pages_crawled, page_limit, summary, created_at, finished_at, error
    FROM audits WHERE site_id = ? ORDER BY created_at DESC LIMIT 1`).bind(site.id).first();
  const auditSummary = audit ? parseJson(audit.summary, {}) : null;
  return {
    site: { id: site.id, hostname: site.hostname, keywords: parseJson(site.keywords, []), status: site.status,
      created_at: site.created_at, last_scan_at: site.last_scan_at, scans_count: n,
      brand: site.brand || null, market: site.market || null, ai_questions: parseJson(site.ai_questions, []) },
    latest: latest ? {
      score: latest.score, prev_score: comparable ? prev.score : null, score_method_changed: !!prev && !comparable,
      speed: latest.speed, at: latest.created_at,
      checks: latest.checks_count, passed: parseJson(latest.passed, []),
      issues: parseJson(latest.issues, []).map(i => ({ ...i, snippet: codeSnippet(i, site.hostname, findingsById.get(i.id)) })),
      details,
    } : null,
    audit: audit ? { id: audit.id, kind: audit.kind, status: audit.status, stage: audit.stage, score: audit.score, coverage: audit.coverage,
      pages_crawled: audit.pages_crawled, page_limit: audit.page_limit, created_at: audit.created_at, finished_at: audit.finished_at, error: audit.error,
      counts: auditSummary?.counts || null, diff: auditSummary?.diff ? { new: auditSummary.diff.new.length, resolved: auditSummary.diff.resolved.length } : null } : null,
  };
}

async function getSite({ request, db, params }) {
  const user = await requireUser(db, request);
  return json(await siteDetail(db, await ownedSite(db, user, params[0])));
}

async function updateSite({ request, db, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  const body = await readJson(request);
  const keywords = body.keywords !== undefined ? JSON.stringify(parseKeywords(body.keywords)) : site.keywords;
  const status = body.status === "paused" || body.status === "active" ? body.status : site.status;
  const brand = body.brand !== undefined ? str(body.brand, 80) || null : site.brand;
  if (body.market !== undefined && body.market !== null && body.market !== "" && !MARKETS[body.market]) throw new HttpError(400, "Choose a country from the list.");
  const market = body.market !== undefined ? body.market || null : site.market;
  const questions = body.ai_questions !== undefined ? JSON.stringify(parseQuestions(body.ai_questions)) : site.ai_questions;
  await db.prepare("UPDATE sites SET keywords = ?, status = ?, brand = ?, market = ?, ai_questions = ? WHERE id = ?")
    .bind(keywords, status, brand, market, questions, site.id).run();
  return json(await siteDetail(db, { ...site, keywords, status, brand, market, ai_questions: questions }));
}

/** Up to 5 questions customers might ask an AI assistant, 8–200 characters each. */
function parseQuestions(input) {
  const list = Array.isArray(input) ? input : String(input || "").split("\n");
  return list.map(q => str(q, 200)).filter(q => q.length >= 8).slice(0, 5);
}

async function deleteSite({ request, db, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  await db.prepare("DELETE FROM audit_pages WHERE audit_id IN (SELECT id FROM audits WHERE site_id = ?)").bind(site.id).run();
  await db.prepare("UPDATE usage_events SET site_id = NULL WHERE site_id = ?").bind(site.id).run();
  for (const t of ["findings", "finding_status", "audits", "competitors", "reports", "scans"]) await db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(site.id).run();
  await db.prepare("DELETE FROM sites WHERE id = ?").bind(site.id).run();
  return json({ ok: true });
}

async function rescanSite({ request, db, env, ctx, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  const plan = effectivePlan(user);
  await rateLimit(db, `rescan:${user.id}`, PLANS[plan].rescansPerDay, 86400,
    `You've used today's ${PLANS[plan].rescansPerDay} rescans. Your scores update automatically every Monday on paid plans.`);

  const scan = await withScanSlot(() => runScan(site.hostname, env));
  if (scan.unreachable) throw new HttpError(422, scan.message);
  const { n: userScans } = await db.prepare("SELECT COUNT(*) AS n FROM scans WHERE user_id = ?").bind(user.id).first();
  const { n: siteScans } = await db.prepare("SELECT COUNT(*) AS n FROM scans WHERE site_id = ?").bind(site.id).first();
  // Paid plans get a two-sentence AI summary (within the customer's monthly AI budget).
  if (plan !== "free") {
    const summary = await generateAiSummary(db, env, site, scan).catch(() => null);
    if (summary) scan.details.aiSummary = summary;
  }
  await saveScan(db, site, scan, siteScans ? "manual" : "first");

  if (!userScans) {
    const mail = sendEmail(user.email, `Welcome to HeyRanks — your site scores ${scan.score}/100`,
      welcomeEmail({ email: user.email, website: site.hostname, keywords: site.keywords, paid: plan !== "free" }, scan), env)
      .catch(err => console.error("[welcome] email failed", err));
    ctx?.waitUntil ? ctx.waitUntil(mail) : await mail;
  }
  return json(await siteDetail(db, site));
}

// ─── full-site audits ─────────────────────────────────────────────────────────

const AUDITS_PER_SITE_PER_DAY = 3;
const AUDITS_PER_USER_PER_MONTH = 20;
const RECHECKS_PER_DAY = 40;
const MAX_COMPETITORS = 5;

/**
 * Starts (or resumes) work on an audit in the background, within the platform's function time limit.
 * A run that ends with work left asks for its own continuation in a fresh function run (see audit.js).
 */
function kickAudit(c, auditId) {
  const job = runAudit(c.db, c.env, auditId, { budgetMs: c.opts?.auditBudgetMs ?? 240_000, scan: c.opts?.scan })
    .then(r => (r.status === "running" && !c.opts?.noContinuation ? requestContinuation(c.env, auditId) : null))
    .catch(err => console.error(`[audit] background run of ${auditId} failed:`, err));
  if (c.ctx?.waitUntil) c.ctx.waitUntil(job);
  return job;
}

const STAGE_LABELS = { collect: "Checking site-wide settings, DNS and speed", crawl: "Crawling pages", links: "Checking links",
  modules: "Gathering competitor, keyword, backlink and AI-visibility data", analyze: "Analysing and writing your plan", complete: "Done" };

function auditMeta(a) {
  return {
    id: a.id, site_id: a.site_id, hostname: a.hostname, kind: a.kind, status: a.status, stage: a.stage, stage_label: STAGE_LABELS[a.stage] || null,
    page_limit: a.page_limit, pages_crawled: a.pages_crawled, pages_queued: a.pages_queued, score: a.score, coverage: a.coverage,
    created_at: a.created_at, started_at: a.started_at, finished_at: a.finished_at, error: a.error,
  };
}

async function createAudit(c) {
  const { request, db, params } = c;
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  if (effectivePlan(user) === "free") throw new HttpError(403, "Full-site audits are part of the 180-Day Pass. Upgrade to audit up to 50 pages with a 30-day growth plan.");
  const active = await db.prepare("SELECT * FROM audits WHERE site_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1").bind(site.id).first();
  if (active) {
    if (auditIsStale(active)) kickAudit(c, active.id);
    return json({ audit: auditMeta({ ...active, hostname: site.hostname }), reused: true });
  }
  await rateLimit(db, `audit:${site.id}`, AUDITS_PER_SITE_PER_DAY, 86400, `You've started ${AUDITS_PER_SITE_PER_DAY} audits of this site today. Please try again tomorrow; your weekly audit also runs automatically.`);
  await rateLimit(db, `audit-month:${user.id}`, AUDITS_PER_USER_PER_MONTH, 30 * 86400, "You've reached this month's audit limit. Your weekly audits still run automatically.");
  const { audit } = await startAudit(db, { site, kind: "premium", pageLimit: PAGE_LIMIT });
  kickAudit(c, audit.id);
  return json({ audit: auditMeta({ ...audit, hostname: site.hostname }) }, 202);
}

async function listAudits({ request, db, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  const { results } = await db.prepare(`SELECT id, site_id, kind, status, stage, score, coverage, page_limit, pages_crawled, pages_queued, created_at, started_at, finished_at, error
    FROM audits WHERE site_id = ? ORDER BY created_at DESC LIMIT 30`).bind(site.id).all();
  return json({ audits: results.map(a => auditMeta({ ...a, hostname: site.hostname })) });
}

/** Machine route: a finished run asks for the next one. Signed with HMAC(CRON_SECRET or ADMIN_SECRET) over the audit id. */
async function continueAuditRoute(c) {
  const { request, db, env, params } = c;
  const expected = await continuationToken(env, params[0]);
  if (!expected || !safeEqual(request.headers.get("x-audit-token") || "", expected)) throw new HttpError(401, "Unauthorized");
  const a = await db.prepare("SELECT id, status, lease_until FROM audits WHERE id = ?").bind(params[0]).first();
  if (!a) throw new HttpError(404, "Audit not found.");
  const started = auditIsStale(a);
  if (started) kickAudit(c, a.id);
  return json({ ok: true, started }, 202);
}

async function cancelAuditRoute({ request, db, params }) {
  const user = await requireUser(db, request);
  const a = await db.prepare("SELECT id FROM audits WHERE id = ? AND user_id = ?").bind(params[0], user.id).first();
  if (!a) throw new HttpError(404, "Audit not found.");
  await cancelAudit(db, a.id);
  return json({ ok: true });
}

/** Which data sources are switched on. Setting names (env vars) are only shown to admins. */
function integrations(env, admin = false) {
  const out = {
    pagespeed: { configured: !!env.PSI_KEY },
    dataforseo: { configured: dfsConfigured(env) },
    ai_visibility: AI_PROVIDERS.map(p => ({ id: p.id, label: p.label, configured: p.configured(env) })),
    analysts: { configured: !!env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_API_KEY ? claudeModel(env) : null },
  };
  if (admin) {
    out.pagespeed.needs = "PSI_KEY (without it, Google's shared quota may refuse requests)";
    out.dataforseo.needs = "DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD";
    AI_PROVIDERS.forEach((p, k) => { out.ai_visibility[k].needs = p.needs; });
    out.analysts.needs = "ANTHROPIC_API_KEY";
  }
  return out;
}

const METHODOLOGY = {
  rules: [
    "Every check is pass (full credit), warn (partial credit, usually half), fail (no credit), or not measured. Checks that couldn't be measured are left out of every score; they never count as failures.",
    "Page-level and link checks earn credit in proportion to the share of pages or links that pass, so one bad page out of fifty costs little.",
    "A category's score is the points earned divided by the points possible among its measured checks. The overall Website Growth Health Score weights the categories as listed.",
    "If any critical issue is found, the overall score is capped at 59, so a good average can't hide a serious problem.",
    "Each underlying problem is scored once, in one category.",
    "Domain expiry is an operational alert: it doesn't change any category score, but a domain within 14 days of expiring is a critical issue and caps the overall score like any other. Keyword, competitor, backlink and AI-visibility data come from outside providers and are shown separately; they never change the health score.",
  ],
  limitations: [
    "We read each page's HTML and don't run JavaScript. Content added only by JavaScript may be missed (pages where this seems likely are flagged).",
    "The crawl covers up to 50 pages, starting from the homepage links and the sitemap. Larger sites are sampled, and orphan-page detection only runs when every discovered link was followed.",
    "Automated accessibility checks (Lighthouse) find only some accessibility problems; a manual review is still needed.",
    "DKIM can only be confirmed for selectors we know; not finding one doesn't prove DKIM is missing.",
    "Conversion checks read text and links, not images or visual design.",
    "AI-visibility answers come from each provider's API at the time asked. Consumer apps (with web search, memory and personalisation) can answer differently, and answers change over time. The sample is small.",
    "Security checks look at publicly visible configuration. A missing header is a configuration gap, not a confirmed vulnerability. No intrusive testing is done.",
  ],
};

async function getAudit(c) {
  const { request, db, env, params } = c;
  const user = await requireUser(db, request);
  const a = await db.prepare(`SELECT a.*, s.hostname, s.keywords AS site_keywords, s.brand, s.market, s.ai_questions FROM audits a JOIN sites s ON s.id = a.site_id
    WHERE a.id = ? AND a.user_id = ?`).bind(params[0], user.id).first();
  if (!a) throw new HttpError(404, "Audit not found.");
  if (auditIsStale(a)) kickAudit(c, a.id); // resume an audit an earlier run didn't finish
  const meta = auditMeta(a);
  if (a.status !== "complete") return json({ audit: meta });

  const summary = parseJson(a.summary, {});
  const modules = parseJson(a.modules, {});
  const state = parseJson(a.state, null);
  const ctxF = { host: a.hostname, org: organizationalDomain(a.hostname) || a.hostname, origin: state?.collected?.origin || `https://${a.hostname}` };
  const [{ results: rows }, { results: statuses }, { results: history }, { results: comps }] = await Promise.all([
    db.prepare("SELECT * FROM findings WHERE audit_id = ?").bind(a.id).all(),
    db.prepare("SELECT fingerprint, status, note, verified_at, verified_result FROM finding_status WHERE site_id = ?").bind(a.site_id).all(),
    db.prepare("SELECT id, score, coverage, finished_at, kind FROM audits WHERE site_id = ? AND status = 'complete' ORDER BY finished_at DESC LIMIT 12").bind(a.site_id).all(),
    db.prepare("SELECT id, hostname, created_at FROM competitors WHERE site_id = ? ORDER BY created_at").bind(a.site_id).all(),
  ]);
  const statusBy = new Map(statuses.map(s => [s.fingerprint, s]));
  const findings = rows.map(r => {
    const d = parseJson(r.data, {}), s = statusBy.get(r.fingerprint);
    return presentFinding({ id: r.id, fingerprint: r.fingerprint, check_id: r.check_id, category: r.category, severity: r.severity, title: r.title, subject: r.subject, ...d,
      progress: s?.status || "open", note: s?.note || null, verified_at: s?.verified_at || null, verified: parseJson(s?.verified_result, null) }, ctxF);
  }).sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
  for (const w of summary.roadmap || []) for (const t of w.tasks) t.progress = statusBy.get(t.fingerprint)?.status || "open";

  // Crawled pages (kept 45 days; always for the site's latest audit).
  let pages = null;
  if (state?.collected) {
    const { results: pr } = await db.prepare("SELECT url, status_code, final_url, redirects, data, state FROM audit_pages WHERE audit_id = ? AND state = 'done' ORDER BY priority, rowid").bind(a.id).all();
    if (pr.length) {
      const loaded = pr.map(r => { const d = parseJson(r.data, {}); return { url: r.url, status: r.status_code, final_url: r.final_url || r.url, redirects: r.redirects || 0, chain: d.chain || [], headers: d.headers || {}, page: d.page }; });
      const recs = auditData(state.collected, loaded, state, modules).pages;
      const perUrl = new Map();
      for (const f of findings) for (const i of f.items || []) if (i.url) perUrl.set(i.url, (perUrl.get(i.url) || 0) + 1);
      pages = recs.map(r => ({ url: r.final_url, status: r.status, depth: r.depth === 99 ? null : r.depth, redirects: r.redirects,
        title: r.page?.title ?? null, words: r.page?.words ?? null, noindex: !!r.page?.noindex, canonical: r.page?.canonical ?? null,
        h1: r.page?.h1.length ?? null, description_length: r.page?.description?.length ?? null, issues: perUrl.get(r.final_url) || 0 }));
    }
  }

  // What was measured about the site as a whole (records, headers, certificate), for the Security / Email sections.
  const col = state?.collected;
  const facts = col ? {
    email: col.email ? { domain: col.email.domain, host: col.email.host, spf: col.email.spf.records, spf_lookups: col.email.spf.lookups,
      dmarc: col.email.dmarc.records, dmarc_domain: col.email.dmarc.domain, mx: col.email.mx.records.map(m => `${m.priority} ${m.host}`),
      dmarc_host_record: col.email.dmarc.host_record || null, dmarc_host_domain: col.email.dmarc.host_domain || null, spf_subdomains: col.email.spf.subdomains || [],
      provider: col.email.provider, senders: col.email.senders, dkim_found: col.email.dkim.selectors_found, dkim_probed: col.email.dkim.selectors_probed } : null,
    domain: col.rdap ? { registrar: col.rdap.registrar, created: col.rdap.created, expires: col.rdap.expires, days_left: col.rdap.days_left, nameservers: col.rdap.nameservers, status: col.rdap.status } : null,
    tls: col.tls, dnssec: col.dnssec, headers: col.home_headers || null,
    robots: { found: col.robots.found, sitemaps: col.robots.parsed?.sitemaps || [] },
    sitemap: { files: col.sitemap.files, urls: col.sitemap.urls.length }, llms: col.llms,
    http_redirect: col.httpRedirect,
  } : null;

  return json({
    audit: meta,
    categories: parseJson(a.scores, {}),
    summary: { ...summary, cost_usd: undefined },
    findings, modules, pages, facts,
    history: history.reverse(),
    settings: { keywords: parseJson(a.site_keywords, []), brand: a.brand || null, market: a.market || null, ai_questions: parseJson(a.ai_questions, []),
      competitors: comps, markets: Object.entries(MARKETS).map(([code, m]) => ({ code, label: m.label })) },
    category_meta: Object.entries(CATEGORIES).map(([id, cat]) => ({ id, label: cat.label, weight: cat.weight, market: !!cat.market })),
    methodology: METHODOLOGY,
    integrations: integrations(env, isAdmin(user, env)),
  });
}

async function latestFinding(db, siteId, fingerprint) {
  return db.prepare(`SELECT f.* FROM findings f JOIN audits a ON a.id = f.audit_id WHERE f.site_id = ? AND f.fingerprint = ? AND a.status = 'complete'
    ORDER BY a.finished_at DESC LIMIT 1`).bind(siteId, fingerprint).first();
}

async function setFindingStatus({ request, db, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  const body = await readJson(request);
  const fingerprint = str(body.fingerprint, 400);
  if (!["open", "done", "ignored"].includes(body.status)) throw new HttpError(400, "Status must be open, done or ignored.");
  if (!fingerprint || !(await latestFinding(db, site.id, fingerprint))) throw new HttpError(404, "Finding not found.");
  await db.prepare(`INSERT INTO finding_status (site_id, fingerprint, status, note, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (site_id, fingerprint) DO UPDATE SET status = excluded.status, note = COALESCE(excluded.note, finding_status.note), updated_at = excluded.updated_at`)
    .bind(site.id, fingerprint, body.status, body.note !== undefined ? str(body.note, 500) || null : null, nowIso()).run();
  return json({ ok: true, fingerprint, status: body.status });
}

async function recheck({ request, db, env, params, opts }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  if (effectivePlan(user) === "free") throw new HttpError(403, "Re-checking fixes is part of the 180-Day Pass.");
  const body = await readJson(request);
  const row = await latestFinding(db, site.id, str(body.fingerprint, 400));
  if (!row) throw new HttpError(404, "Finding not found.");
  await rateLimit(db, `recheck:${user.id}`, RECHECKS_PER_DAY, 86400, "You've used today's re-checks. Your next audit will re-check everything.");
  const d = parseJson(row.data, {});
  const result = await withScanSlot(() => recheckFinding(env, site, { check_id: row.check_id, category: row.category, items: d.items, data: d.data }, opts?.scan));
  if (result.supported) {
    await db.prepare(`INSERT INTO finding_status (site_id, fingerprint, status, verified_at, verified_result, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (site_id, fingerprint) DO UPDATE SET status = CASE WHEN ? THEN 'done' ELSE finding_status.status END,
        verified_at = excluded.verified_at, verified_result = excluded.verified_result, updated_at = excluded.updated_at`)
      .bind(site.id, row.fingerprint, result.passing ? "done" : "open", result.at, JSON.stringify(result), result.at, result.passing ? 1 : 0).run();
  }
  return json({ fingerprint: row.fingerprint, ...result });
}

async function listCompetitors({ request, db, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  const { results } = await db.prepare("SELECT id, hostname, source, created_at FROM competitors WHERE site_id = ? ORDER BY created_at").bind(site.id).all();
  const last = await db.prepare("SELECT modules FROM audits WHERE site_id = ? AND status = 'complete' ORDER BY finished_at DESC LIMIT 1").bind(site.id).first();
  const suggestions = (parseJson(last?.modules, {}).competitors?.suggestions || []).filter(s => !results.some(r => r.hostname === s.domain));
  return json({ competitors: results, suggestions, limit: MAX_COMPETITORS });
}

async function addCompetitor({ request, db, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  const body = await readJson(request);
  let host;
  try { host = normalize(body.website).hostname; } catch (e) { throw new HttpError(400, e.message); }
  if ((organizationalDomain(host) || host) === (organizationalDomain(site.hostname) || site.hostname)) throw new HttpError(400, "That's your own site.");
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM competitors WHERE site_id = ?").bind(site.id).first();
  if (n >= MAX_COMPETITORS) throw new HttpError(400, `You can track up to ${MAX_COMPETITORS} competitors. Remove one first.`);
  const res = await db.prepare("INSERT OR IGNORE INTO competitors (id, site_id, user_id, hostname, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)")
    .bind(crypto.randomUUID(), site.id, user.id, host, nowIso()).run();
  if (!res.meta?.changes) throw new HttpError(409, "You're already tracking that competitor.");
  return listCompetitors({ request, db, params });
}

async function removeCompetitor({ request, db, params }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  await db.prepare("DELETE FROM competitors WHERE id = ? AND site_id = ?").bind(params[1], site.id).run();
  return listCompetitors({ request, db, params });
}

// ─── reports ──────────────────────────────────────────────────────────────────

async function listReports({ request, db, params, url }) {
  const user = await requireUser(db, request);
  const site = await ownedSite(db, user, params[0]);
  const type = url.searchParams.get("type") || "weekly";
  if (!PERIOD_TYPES.includes(type)) throw new HttpError(400, `type must be one of ${PERIOD_TYPES.join(", ")}.`);
  const { results } = await db.prepare(`
    SELECT * FROM reports WHERE site_id = ? AND period_type = ? ORDER BY period_start DESC LIMIT 104`).bind(site.id, type).all();
  const today = nowIso().slice(0, 10);
  return json({ type, reports: results.map(r => presentReport(r, today)) });
}

async function getReport({ request, db, params }) {
  const user = await requireUser(db, request);
  const r = await db.prepare(`SELECT r.*, s.hostname FROM reports r JOIN sites s ON s.id = r.site_id
    WHERE r.id = ? AND r.user_id = ?`).bind(params[0], user.id).first();
  if (!r) throw new HttpError(404, "Report not found.");
  const prev = await db.prepare(`SELECT period_start, score_end FROM reports
    WHERE site_id = ? AND period_type = ? AND period_start < ? ORDER BY period_start DESC LIMIT 1`)
    .bind(r.site_id, r.period_type, r.period_start).first();
  const summary = parseJson(r.summary, {});
  summary.open = (summary.open || []).map(i => ({ ...i, snippet: codeSnippet(i, r.hostname) }));
  return json({
    report: { ...presentReport(r), hostname: r.hostname, summary },
    previous: prev ? { label: periodLabel(r.period_type, prev.period_start), score_end: prev.score_end } : null,
  });
}

// ─── admin ────────────────────────────────────────────────────────────────────

const ACTIVE_PAID = "(u.plan = 'lifetime' OR (u.plan = '180day' AND u.plan_expires_at > ?))";

async function adminOverview({ request, db, env, url }) {
  await requireAdmin(db, request, env);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const demo = url.searchParams.get("demo") === "1";
  const noDemoU = demo ? "" : "AND u.role != 'demo'";
  const noDemoP = demo ? "" : "AND provider != 'demo'";
  const now = nowIso();
  const sinceDay = new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10);
  // Revenue is shown in the currency actually charged (Cashfree settles in INR), not the advertised USD price.
  const currency = (env.CURRENCY || CASHFREE_CURRENCY).toUpperCase();

  const one = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

  const [users, paid, scans, reports, visits, revenue, signupRows, visitRows, revenueRows, pages, planMix] = await Promise.all([
    one(`SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM users u WHERE 1=1 ${noDemoU}`, sinceDay),
    one(`SELECT COUNT(*) AS n FROM users u WHERE ${ACTIVE_PAID} ${noDemoU}`, now),
    one(`SELECT COUNT(*) AS n FROM scans sc JOIN users u ON u.id = sc.user_id WHERE sc.created_at >= ? ${noDemoU}`, sinceDay),
    one(`SELECT COUNT(*) AS n FROM reports r JOIN users u ON u.id = r.user_id WHERE r.emailed_at >= ? ${noDemoU}`, sinceDay),
    one(`SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(visitors), 0) AS visitors FROM page_views WHERE day >= ?`, sinceDay),
    all(`SELECT currency, SUM(amount) AS total, SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END) AS recent, COUNT(*) AS n
         FROM payments WHERE status = 'paid' ${noDemoP} GROUP BY currency ORDER BY total DESC`, sinceDay),
    all(`SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM users u WHERE created_at >= ? ${noDemoU} GROUP BY d`, sinceDay),
    all(`SELECT day AS d, SUM(visitors) AS n, SUM(views) AS v FROM page_views WHERE day >= ? GROUP BY day`, sinceDay),
    all(`SELECT substr(created_at, 1, 10) AS d, SUM(amount) AS n FROM payments
         WHERE status = 'paid' AND currency = ? AND created_at >= ? ${noDemoP} GROUP BY d`, currency, sinceDay),
    all(`SELECT path, SUM(visitors) AS visitors, SUM(views) AS views FROM page_views WHERE day >= ?
         GROUP BY path ORDER BY visitors DESC LIMIT 8`, sinceDay),
    all(`SELECT CASE WHEN u.plan = 'lifetime' THEN 'lifetime' WHEN u.plan = '180day' AND u.plan_expires_at > ? THEN '180day' ELSE 'free' END AS plan,
         COUNT(*) AS n FROM users u WHERE 1=1 ${noDemoU} GROUP BY 1`, now),
  ]);

  // One entry per day, zero-filled, oldest first.
  const index = rows => new Map(rows.map(r => [r.d, r]));
  const s = index(signupRows), v = index(visitRows), rv = index(revenueRows);
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    return { day: d, signups: s.get(d)?.n ?? 0, visitors: v.get(d)?.n ?? 0, views: v.get(d)?.v ?? 0, revenue: rv.get(d)?.n ?? 0 };
  });

  // External API spend (AI, keyword/backlink data) and what an average audit costs to produce.
  // Audit health: outcomes over the period, and audits waiting with no worker (nothing has touched them for an hour).
  const [costRows, auditCost, auditStatus, auditStuck] = await Promise.all([
    all(`SELECT provider, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events WHERE created_at >= ? GROUP BY provider ORDER BY usd DESC`, sinceDay),
    one(`SELECT COUNT(*) AS n, COALESCE(AVG(cost_usd), 0) AS avg_usd, COALESCE(MAX(cost_usd), 0) AS max_usd FROM audits WHERE status = 'complete' AND finished_at >= ?`, sinceDay),
    all(`SELECT status, COUNT(*) AS n FROM audits WHERE created_at >= ? GROUP BY status`, sinceDay),
    one(`SELECT COUNT(*) AS n FROM audits WHERE status IN ('queued', 'running') AND updated_at < ?`, new Date(Date.now() - 3600_000).toISOString()),
  ]);

  return json({
    days, currency, include_demo: demo,
    costs: { by_provider: costRows, total_usd: costRows.reduce((s, r) => s + r.usd, 0), audits: auditCost.n, avg_per_audit_usd: auditCost.avg_usd, max_per_audit_usd: auditCost.max_usd },
    audits: { by_status: Object.fromEntries(auditStatus.map(r => [r.status, r.n])), stuck: auditStuck?.n ?? 0, continuation: canContinue(env) },
    kpis: {
      users: users.total, users_recent: users.recent ?? 0, paid_active: paid.n,
      scans: scans.n, reports_sent: reports.n, visits: visits.views, visitors: visits.visitors,
    },
    revenue, plan_mix: planMix, pages, series,
  });
}

async function adminAnalytics({ request, db, env, url }) {
  await requireAdmin(db, request, env);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  return json(await visitorAnalytics(db, days));
}

async function adminUsers({ request, db, env, url }) {
  await requireAdmin(db, request, env);
  const q = str(url.searchParams.get("q"), 100);
  const like = `%${q}%`;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const noDemo = url.searchParams.get("demo") === "1" ? "" : "AND u.role != 'demo'";
  const where = `WHERE (? = '' OR u.email LIKE ? OR u.name LIKE ? OR u.company LIKE ?) ${noDemo}`;
  const { results } = await db.prepare(`
    SELECT u.id, u.email, u.name, u.company, u.role, u.status, u.plan, u.plan_expires_at, u.email_verified_at,
      u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM sites WHERE user_id = u.id) AS sites,
      (SELECT score FROM scans WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_score,
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE user_id = u.id AND status = 'paid') AS paid_total
    FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).bind(q, like, like, like, limit, offset).all();
  const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(q, like, like, like).first();
  return json({
    total: n,
    users: results.map(u => ({ ...u, plan_active: effectivePlan(u), email_verified: !!u.email_verified_at })),
  });
}

async function adminUpdateUser({ request, db, env, params }) {
  const admin = await requireAdmin(db, request, env);
  const body = await readJson(request);
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(params[0]).first();
  if (!user) throw new HttpError(404, "User not found.");
  const now = nowIso();

  if (body.status === "active" || body.status === "disabled") {
    if (user.id === admin.id && body.status === "disabled") throw new HttpError(400, "You can't disable your own account.");
    await db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(body.status, now, user.id).run();
    if (body.status === "disabled") await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
  }
  if (body.role === "user" || body.role === "admin") {
    if (user.id === admin.id && body.role !== "admin") throw new HttpError(400, "You can't remove your own admin role.");
    await db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").bind(body.role, now, user.id).run();
  }
  if (body.plan && PLANS[body.plan]) {
    const amount = Math.round(Number(body.payment?.amount || 0) * 100);
    if (amount > 0) {
      // Manual payment (e.g. a Razorpay link paid outside the webhook) so revenue stats stay complete.
      await db.prepare(`INSERT INTO payments (id, user_id, email, provider, provider_ref, plan, amount, currency, status, applied_at, created_at)
        VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, 'paid', ?, ?)`).bind(crypto.randomUUID(), user.id, user.email,
        str(body.payment.ref, 100) || crypto.randomUUID(), body.plan, amount,
        str(body.payment.currency, 3).toUpperCase() || (env.CURRENCY || CASHFREE_CURRENCY).toUpperCase(), now, now).run();
    }
    await activatePlan(db, user.id, body.plan);
  }
  const fresh = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ user: { ...presentUser(fresh, env), status: fresh.status, role: fresh.role } });
}

// ─── payments webhook ─────────────────────────────────────────────────────────

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Verifies the provider's signature and turns the event into a payment, or null if it isn't one. */
async function parsePaymentEvent(request, env, raw) {
  const h = request.headers;
  if (h.get("stripe-signature")) {
    if (!env.STRIPE_SECRET) throw new HttpError(400, "STRIPE_SECRET not set.");
    const parts = Object.fromEntries(h.get("stripe-signature").split(",").map(p => p.split("=")));
    const v1s = h.get("stripe-signature").split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
    const expected = await hmacHex(env.STRIPE_SECRET, `${parts.t}.${raw}`);
    if (!v1s.some(v => safeEqual(v, expected)) || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300)
      throw new HttpError(400, "Bad signature.");
    const e = JSON.parse(raw);
    if (e.type !== "checkout.session.completed") return null;
    const s = e.data.object;
    return { provider: "stripe", ref: s.id, email: s.customer_details?.email || s.customer_email, plan: s.metadata?.plan,
      amount: s.amount_total ?? 0, currency: s.currency };
  }
  if (h.get("x-razorpay-signature")) {
    if (!env.RAZORPAY_SECRET) throw new HttpError(400, "RAZORPAY_SECRET not set.");
    if (!safeEqual(h.get("x-razorpay-signature"), await hmacHex(env.RAZORPAY_SECRET, raw))) throw new HttpError(400, "Bad signature.");
    const e = JSON.parse(raw);
    if (e.event !== "payment.captured") return null;
    const p = e.payload.payment.entity;
    return { provider: "razorpay", ref: p.id, email: p.email, plan: p.notes?.plan, amount: p.amount, currency: p.currency };
  }
  if (h.get("x-signature")) {
    if (!env.LEMONSQUEEZY_SECRET) throw new HttpError(400, "LEMONSQUEEZY_SECRET not set.");
    if (!safeEqual(h.get("x-signature"), await hmacHex(env.LEMONSQUEEZY_SECRET, raw))) throw new HttpError(400, "Bad signature.");
    const e = JSON.parse(raw);
    if (e.meta?.event_name !== "order_created") return null;
    const a = e.data.attributes;
    return { provider: "lemonsqueezy", ref: String(e.data.id), email: a.user_email, plan: e.meta.custom_data?.plan,
      amount: a.total, currency: a.currency };
  }
  throw new HttpError(400, "Unsigned webhook rejected.");
}

/**
 * Why a signed payment event still can't grant a plan, or null if it can. Fails closed: the plan must
 * be named, and the amount (minor units) must be at least that plan's price in our currency.
 * Paying more is accepted (for example tax added on top); paying less is not.
 */
function paymentProblem(p) {
  if (p.plan !== "180day") return p.plan === "lifetime" ? "the Lifetime plan is no longer sold" : `unknown plan "${p.plan ?? ""}"`;
  if (!p.ref) return "missing payment reference";
  const currency = String(p.currency || "").toUpperCase();
  const plan = PLANS[p.plan];
  // Accept USD (Stripe) or INR (Cashfree/Razorpay); validate amount against the matching minor-unit price.
  const minAmount = currency === CASHFREE_CURRENCY ? plan.cashfree_price : (currency === PRICE_CURRENCY ? plan.price : null);
  if (minAmount === null) return `currency ${currency || "missing"}, expected ${PRICE_CURRENCY} or ${CASHFREE_CURRENCY}`;
  const amount = Number(p.amount);
  if (!Number.isInteger(amount) || amount < minAmount) return `amount ${p.amount} is below the ${minAmount} ${currency} price`;
  return null;
}

async function webhook({ request, db, env }) {
  const raw = await request.text();
  if (raw.length > 256 * 1024) throw new HttpError(413, "Request too large.");
  const p = await parsePaymentEvent(request, env, raw);
  if (!p || !p.email) return json({ received: true });
  const email = String(p.email).trim().toLowerCase();
  const problem = paymentProblem(p);
  // A rejected event is kept for the record (status 'rejected' never counts as revenue or grants a plan),
  // and answered 200 so the provider stops retrying something that will never be accepted.
  const res = await db.prepare(`INSERT OR IGNORE INTO payments (id, email, provider, provider_ref, plan, amount, currency, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), email, p.provider, String(p.ref || crypto.randomUUID()),
    problem ? String(p.plan || "unknown").slice(0, 20) : p.plan, Number.isFinite(Number(p.amount)) ? Math.round(Number(p.amount)) : 0,
    String(p.currency || "").toUpperCase().slice(0, 3) || "?", problem ? "rejected" : "paid", nowIso()).run();
  if (problem) {
    console.error(`[webhook] ${p.provider} payment ${p.ref} rejected: ${problem}`);
    return json({ received: true, rejected: problem });
  }
  if (!res.meta?.changes) return json({ received: true, duplicate: true }); // provider retried

  // Verified accounts get the plan now; otherwise it's applied when the owner confirms the email.
  const user = await db.prepare("SELECT id, email_verified_at FROM users WHERE email = ?").bind(email).first();
  if (user?.email_verified_at) await claimPayments(db, user.id, email);
  return json({ received: true });
}

// ─── Cashfree checkout ────────────────────────────────────────────────────────
// Flow: POST /checkout creates a 'pending' payments row and a Cashfree order -> the browser opens
// Cashfree's checkout with the payment_session_id -> Cashfree returns to /payment?order_id=... and
// calls /api/webhook/cashfree. Both of those only *prompt* settleCashfreeOrder(), which asks
// Cashfree's API for the order and grants the plan once, when the order is PAID. The order belongs
// to the logged-in user, so no email matching is needed.

async function startCheckout({ request, db, env }) {
  const user = await requireUser(db, request);
  const body = await readJson(request);
  const plan = body.plan;
  if (plan !== "180day") throw new HttpError(400, "Only the 180-Day Pass is currently available.");
  if (!cashfreeConfigured(env)) throw new HttpError(503, "Online payment isn't switched on yet. Email hello@dexosoftsolutions.com to upgrade.");
  if (effectivePlan(user) === "lifetime") throw new HttpError(400, "You already have the Lifetime plan.");
  await rateLimit(db, `checkout:${user.id}`, 10, 600, "Too many payment attempts. Please wait a few minutes.");
  const mode = cashfreeMode(env);

  // A double-click or quick retry reuses the order that's already open.
  const open = await db.prepare(`SELECT provider_ref, session_id FROM payments
    WHERE user_id = ? AND provider = 'cashfree' AND plan = ? AND status = 'pending' AND session_id IS NOT NULL AND created_at > ?
    ORDER BY created_at DESC LIMIT 1`).bind(user.id, plan, new Date(Date.now() - 30 * 60_000).toISOString()).first();
  if (open) return json({ order_id: open.provider_ref, payment_session_id: open.session_id, mode });

  const orderId = `hr_${crypto.randomUUID().replace(/-/g, "")}`;
  // Cashfree processes in INR; use cashfree_price (paise) regardless of display currency.
  const amount = PLANS[plan].cashfree_price;
  // Our record exists before Cashfree knows about the order, so a webhook can always find it.
  await db.prepare(`INSERT INTO payments (id, user_id, email, provider, provider_ref, plan, amount, currency, status, created_at)
    VALUES (?, ?, ?, 'cashfree', ?, ?, ?, ?, 'pending', ?)`)
    .bind(crypto.randomUUID(), user.id, user.email, orderId, plan, amount, CASHFREE_CURRENCY, nowIso()).run();

  const origin = siteOrigin(request, env);
  let order;
  try {
    order = await createOrder(env, {
      order_id: orderId,
      order_amount: amount / 100,
      order_currency: CASHFREE_CURRENCY,
      customer_details: {
        customer_id: user.id, customer_email: user.email,
        customer_name: user.name || user.email.split("@")[0], customer_phone: cashfreePhone(user.whatsapp),
      },
      order_note: `HeyRanks ${PLANS[plan].label}`,
      order_meta: {
        return_url: `${origin}/payment?order_id={order_id}`,
        // Cashfree only calls https URLs. Locally, the return page settles the order instead.
        ...(origin.startsWith("https://") ? { notify_url: `${origin}/api/webhook/cashfree` } : {}),
      },
      order_tags: { user_id: user.id, plan },
    });
  } catch {
    await db.prepare("UPDATE payments SET status = 'failed' WHERE provider = 'cashfree' AND provider_ref = ?").bind(orderId).run();
    throw new HttpError(502, "We couldn't start the payment. Please try again in a minute.");
  }
  await db.prepare("UPDATE payments SET session_id = ? WHERE provider = 'cashfree' AND provider_ref = ?")
    .bind(order.payment_session_id, orderId).run();
  return json({ order_id: orderId, payment_session_id: order.payment_session_id, mode });
}

/** Sends the receipt email if this settlement is the one that switched the plan on. */
async function receiptIfGranted(env, ctx, s) {
  if (!s.granted) return;
  const mail = notifyPlanActivated(env, s).catch(err => console.error("[cashfree] receipt email failed", err));
  ctx?.waitUntil ? ctx.waitUntil(mail) : await mail;
}

async function checkoutStatus({ request, db, env, ctx, params }) {
  const user = await requireUser(db, request);
  const pay = await db.prepare("SELECT user_id FROM payments WHERE provider = 'cashfree' AND provider_ref = ?").bind(params[0]).first();
  if (!pay || pay.user_id !== user.id) throw new HttpError(404, "Order not found.");
  await rateLimit(db, `cfstatus:${user.id}`, 60, 600);
  const result = await settleCashfreeOrder(db, env, params[0]);
  await receiptIfGranted(env, ctx, result);
  const fresh = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ status: result.status, plan: result.plan, user: presentUser(fresh, env) });
}

async function cashfreeWebhook({ request, db, env, ctx }) {
  const raw = await request.text();
  const ok = await verifyWebhook(env, raw, request.headers.get("x-webhook-signature"), request.headers.get("x-webhook-timestamp"));
  if (!ok) throw new HttpError(401, "Invalid signature.");
  const event = JSON.parse(raw);
  const type = String(event.type || "").toUpperCase();
  const data = event.data || {};

  if (type.startsWith("REFUND")) {
    const r = data.refund || {};
    if (r.order_id && String(r.refund_status || "").toUpperCase() === "SUCCESS") {
      const pay = await db.prepare("SELECT * FROM payments WHERE provider = 'cashfree' AND provider_ref = ?").bind(r.order_id).first();
      // A full refund takes the access away; a partial refund leaves it.
      if (pay && Math.round(Number(r.refund_amount) * 100) >= pay.amount) {
        const flipped = await db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ? AND status = 'paid' RETURNING id").bind(pay.id).first();
        if (flipped && pay.user_id) await revokePlan(db, pay.user_id, pay.plan);
      }
    }
    return json({ received: true });
  }

  const orderId = data.order?.order_id;
  if (!orderId) return json({ received: true });
  // A failure here returns 500, so Cashfree retries the webhook later.
  const result = await settleCashfreeOrder(db, env, String(orderId));
  await receiptIfGranted(env, ctx, result);
  return json({ received: true, status: result.status });
}

// ─── jobs ─────────────────────────────────────────────────────────────────────

async function manualDaily({ request, env, opts }) {
  if (!env.ADMIN_SECRET || request.headers.get("x-admin-secret") !== env.ADMIN_SECRET) throw new HttpError(401, "Unauthorized");
  return json(await runDaily(env, opts.jobOpts));
}

async function cron({ request, env, opts }) {
  if (!env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) throw new HttpError(401, "Unauthorized");
  console.log("[cron] daily job started", nowIso());
  const result = await runDaily(env, opts.jobOpts);
  console.log("[cron] daily job done", JSON.stringify(result));
  return json(result);
}
