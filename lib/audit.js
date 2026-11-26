/**
 * Full-site audits: a resumable job that crawls up to `page_limit` pages, checks links, runs the data
 * modules (competitors, keywords, backlinks, AI visibility), asks the AI analysts and stores findings.
 *
 * Stages: collect -> crawl -> links -> modules -> analyze -> complete.
 * Every stage saves its progress. A run that ends before the audit is done asks for its own continuation
 * (requestContinuation); status polls and the daily cron also pick up anything left waiting.
 * One worker at a time: a run claims a lease with its own token, a heartbeat renews it while the worker is
 * alive, and every write requires the token, so a worker that lost its lease (or whose audit was cancelled)
 * stops without overwriting anything.
 * Crawling respects robots.txt (Crawl-delay is honoured up to 5 s), stays on the site's own host, and every
 * request goes through the SSRF-safe fetcher in net.js.
 */
import { fetchPublic } from "./net.js";
import { robotsAllows, robotsCrawlDelay, parseRobots, fetchPageRecord, normalizeUrl, sameSite, isCrawlable, CRAWLER_TOKEN } from "./crawler.js";
import { collectSite, runScan, discoverSitemap } from "./scan.js";
import { runChecks, scoreChecks, toFindings, buildRoadmap, diffFindings, SCORE_VERSION } from "./analysis.js";
import { presentFinding, CHECKS } from "./catalog.js";
import { organizationalDomain } from "./domain.js";
import { keywordsModule, backlinksModule, competitorsModule, aiVisibilityModule, suggestCompetitors, defaultQuestions, MARKETS, dfsConfigured, unavailable } from "./providers.js";
import { Budget, envNumber, growthStrategist, contentStrategist } from "./ai.js";

export const PAGE_LIMIT = 50;
const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 12;
const MAX_QUEUE = 600;
const nowIso = () => new Date().toISOString();
const leaseUntil = () => new Date(Date.now() + LEASE_MS).toISOString();
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const round4 = n => Math.round(n * 10000) / 10000;
const crawlRules = state => state.collected.robots.crawlRules ?? state.collected.robots.parsed;

// ─── lifecycle ────────────────────────────────────────────────────────────────

/** Creates an audit, or returns the site's audit that is already queued/running (no duplicate crawls). */
export async function startAudit(db, { site, kind = "premium", pageLimit = PAGE_LIMIT }) {
  const id = crypto.randomUUID(), now = nowIso();
  // A single statement, so two clicks at the same moment can't both create an audit.
  await db.prepare(`INSERT INTO audits (id, site_id, user_id, kind, status, stage, page_limit, created_at, updated_at)
    SELECT ?, ?, ?, ?, 'queued', 'collect', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM audits WHERE site_id = ? AND status IN ('queued', 'running'))`)
    .bind(id, site.id, site.user_id, kind, pageLimit, now, now, site.id).run();
  const audit = await db.prepare("SELECT * FROM audits WHERE site_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1").bind(site.id).first();
  return { audit, reused: audit.id !== id };
}

export async function cancelAudit(db, id) {
  await db.prepare("UPDATE audits SET status = 'cancelled', lease_until = NULL, lease_token = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')")
    .bind(nowIso(), nowIso(), id).run();
}

/** True when the audit should be picked up: queued, or running with an expired lease. */
export const auditIsStale = a => (a.status === "queued" || a.status === "running") && (!a.lease_until || a.lease_until < nowIso());

/** The lease one worker holds on one audit. Every write goes through it and requires the token. */
class Job {
  constructor(db, id, token, deadline) {
    Object.assign(this, { db, id, token, deadline, lost: false });
    this.timer = setInterval(() => this.renew().catch(err => console.error(`[audit] ${id} heartbeat failed:`, err?.message || err)), HEARTBEAT_MS);
    this.timer.unref?.();
  }
  timeLeft() { return this.deadline - Date.now(); }
  /** Still ours, with at least `ms` left in this run. */
  ok(ms = 0) { return !this.lost && this.timeLeft() > ms; }
  async renew() {
    if (this.lost) return false;
    const r = await this.db.prepare("UPDATE audits SET lease_until = ? WHERE id = ? AND lease_token = ? AND status = 'running'").bind(leaseUntil(), this.id, this.token).run();
    if (!r.meta?.changes) this.lost = true;
    return !this.lost;
  }
  /** Writes fields only while this worker holds the audit; false (and lost) once cancelled or taken over. */
  async save(fields) {
    if (this.lost) return false;
    const keys = Object.keys(fields);
    const r = await this.db.prepare(`UPDATE audits SET ${keys.map(k => `${k} = ?`).join(", ")}, lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND status = 'running'`)
      .bind(...keys.map(k => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k])), leaseUntil(), nowIso(), this.id, this.token).run();
    if (!r.meta?.changes) this.lost = true;
    return !this.lost;
  }
  /** Final write: status changes from running to complete/failed, and the lease is cleared in the same statement. */
  async finish(fields) {
    const ok = await this.save({ ...fields, lease_token: null });
    if (ok) { this.finished = true; this.lost = true; } // nothing more may be written
    return ok;
  }
  async release() {
    await this.db.prepare("UPDATE audits SET lease_until = NULL, lease_token = NULL WHERE id = ? AND lease_token = ?").bind(this.id, this.token).run();
  }
  stop() { clearInterval(this.timer); }
}

async function claim(db, id) {
  const now = nowIso(), token = crypto.randomUUID();
  const audit = await db.prepare(`UPDATE audits SET status = 'running', lease_token = ?, lease_until = ?, started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?) RETURNING *`)
    .bind(token, leaseUntil(), now, now, id, now).first();
  return audit ? { audit, token } : null;
}

/** Spend recorded so far for this audit, and for its owner over the last 30 days. */
async function spendSoFar(db, auditId, userId) {
  const [audit, month] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events WHERE audit_id = ?").bind(auditId).first(),
    db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events WHERE user_id = ? AND created_at > ?").bind(userId, new Date(Date.now() - 30 * 864e5).toISOString()).first(),
  ]);
  return { audit: audit?.usd || 0, month: month?.usd || 0 };
}

/**
 * Works on one audit until it completes, this run's time (`budgetMs`) is used, or the audit is cancelled.
 * Safe to call repeatedly and concurrently: a caller that finds the lease taken returns { skipped: true }.
 * Returns { status: "complete" | "running" | "failed" | "lost" }; "running" means call it again (see
 * requestContinuation). opts.scan: options passed to collectSite / runScan (tests pass stubs).
 */
export async function runAudit(db, env, auditId, { budgetMs = 240_000, scan = {} } = {}) {
  const claimed = await claim(db, auditId);
  if (!claimed) return { skipped: true };
  const { audit: a, token } = claimed;
  const job = new Job(db, a.id, token, Date.now() + budgetMs);
  let stage = a.stage || "collect", site = null, state = parse(a.state, {}), modules = parse(a.modules, {});
  const writes = [];
  const flush = () => Promise.all(writes.splice(0));
  try {
    if (a.attempts > MAX_ATTEMPTS) {
      console.error(`[audit] ${a.id} gave up after ${a.attempts - 1} runs at stage ${stage}`);
      await job.finish({ status: "failed", error: "The audit was interrupted too many times. Please start it again.", lease_until: null, finished_at: nowIso() });
      return { status: "failed" };
    }
    site = await db.prepare("SELECT * FROM sites WHERE id = ?").bind(a.site_id).first();
    if (!site) { await job.finish({ status: "failed", error: "Site removed.", finished_at: nowIso() }); return { status: "failed" }; }

    // Paid calls (AI, keyword/backlink data) are capped per audit and per customer per 30 days, so a $10
    // customer can't cost more than they pay. Each call is recorded the moment it's made, so spend on a
    // cancelled, failed or interrupted audit still counts.
    const spend = await spendSoFar(db, a.id, site.user_id);
    const limit = Math.min(envNumber(env.AUDIT_COST_CAP_USD, 1.5) - spend.audit, envNumber(env.USER_MONTHLY_COST_CAP_USD, 3) - spend.month);
    const budget = new Budget(Math.max(0, limit), ev => writes.push(recordUsage(db, site, a.id, ev)));
    const cost = () => round4(spend.audit + budget.spent);
    const persist = async extra => { await flush(); return job.save({ stage, state, modules, cost_usd: cost(), ...extra }); };

    while (job.ok(4000)) {
      if (stage === "collect") {
        const data = await collectSite(site.hostname, env, { psi: "full", ...scan });
        if (!data || data.unreachable) throw new UserError(data?.message || `We couldn't open ${site.hostname}. Check the site is online and try again.`);
        state.collected = { ...compactCollected(data), homeUrl: normalizeUrl(data.home.final_url) || normalizeUrl(`${data.origin}/`) };
        modules.performance = data.psi.mobile
          ? { status: "ok", source: "Google PageSpeed Insights (Lighthouse lab + Chrome UX Report field data)", fetched_at: nowIso(), data: { mobile: data.psi.mobile, desktop: data.psi.desktop } }
          : { status: "error", source: "Google PageSpeed Insights", fetched_at: nowIso(), data: null, message: "Google didn't return speed data for this audit; it's tried again next time." };
        if (!data.psi.mobile) console.warn(`[audit] ${a.id} ${site.hostname}: PageSpeed unavailable: ${data.psi.detail || data.psi.error}`);
        await seedQueue(db, a, site, data);
        stage = data.home.page ? "crawl" : "modules"; // a homepage we couldn't read (e.g. certificate rejected) has nothing to crawl
        if (!data.home.page) state.crawl_complete = false;
        await persist();
      } else if (stage === "crawl") {
        const done = await crawlBatch(db, a, site, state, job);
        if (done) stage = "links";
        await persist({ pages_crawled: await countPages(db, a.id, "done"), pages_queued: await countPages(db, a.id, "queued") });
      } else if (stage === "links") {
        if (await checkLinks(db, a, site, state, job)) stage = "modules";
        await persist();
      } else if (stage === "modules") {
        const step = await runModules(db, env, a, site, state, modules, budget, job, scan);
        if (step === "done") stage = "analyze";
        await persist();
        if (step === "wait") break; // the next module needs more time than this run has left
      } else if (stage === "analyze") {
        if (job.timeLeft() < 60_000 && env.ANTHROPIC_API_KEY) break; // leave room for the AI analysts on the next run
        await analyze(db, env, a, site, state, modules, budget, job, cost, flush);
        return { status: job.finished ? "complete" : "lost" };
      }
    }
    await flush();
    if (job.lost) return { status: "lost" }; // cancelled or taken over: leave the row to whoever has it
    await job.release();
    return { status: "running", stage };
  } catch (err) {
    await flush().catch(() => {});
    const message = err instanceof UserError ? err.message : "Something went wrong while auditing. Please try again.";
    if (err instanceof UserError) console.warn(`[audit] ${a.id} ${site?.hostname || ""}: ${message}`);
    else console.error(`[audit] ${a.id} ${site?.hostname || ""} failed at ${stage}:`, err);
    await job.finish({ status: "failed", stage, error: message, finished_at: nowIso(), state, modules }).catch(() => {});
    return { status: "failed" };
  } finally {
    job.stop();
  }
}

class UserError extends Error {}

/** Writes one paid call to usage_events immediately (the monthly cap reads this table). */
function recordUsage(db, site, auditId, ev) {
  return db.prepare(`INSERT INTO usage_events (id, user_id, site_id, audit_id, provider, operation, units, cost_usd, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), site.user_id, site.id, auditId, ev.provider, String(ev.operation).slice(0, 80), ev.units || 1, ev.cost_usd || 0, ev.ok === false ? 0 : 1, nowIso()).run()
    .catch(err => console.error(`[audit] ${auditId}: couldn't record usage of ${ev.provider}:`, err?.message || err));
}

// ─── continuation ─────────────────────────────────────────────────────────────
// A run is limited by the platform (240 s here). Instead of waiting for a status poll or the daily cron,
// a run that ends early asks the API to start the next one: POST /api/audits/:id/continue, signed with
// HMAC(CRON_SECRET or ADMIN_SECRET). Without SITE_URL and a secret, polls and the cron carry audits forward.

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

export async function continuationToken(env, auditId) {
  const secret = env.CRON_SECRET || env.ADMIN_SECRET;
  if (!secret) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`audit-continue:${auditId}`)));
}

export const canContinue = env => !!(env.SITE_URL && (env.CRON_SECRET || env.ADMIN_SECRET));

/** Asks the API (a fresh function invocation) to carry on with this audit. True if it accepted. */
export async function requestContinuation(env, auditId) {
  if (!canContinue(env)) return false;
  try {
    const r = await fetch(`${env.SITE_URL.replace(/\/+$/, "")}/api/audits/${encodeURIComponent(auditId)}/continue`, {
      method: "POST", headers: { "x-audit-token": await continuationToken(env, auditId) }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) console.error(`[audit] continuation of ${auditId} refused: HTTP ${r.status}`);
    return r.ok;
  } catch (err) {
    console.error(`[audit] couldn't request continuation of ${auditId}:`, err?.name || err);
    return false;
  }
}

/**
 * For the daily cron. With continuations available, starts up to `maxStarts` due audits, each in its own
 * function run (they then continue themselves). Otherwise works through due audits inline for `budgetMs`.
 */
export async function advanceDueAudits(db, env, { budgetMs = 100_000, maxStarts = envNumber(env.AUDIT_DAILY_STARTS, 25), scan } = {}) {
  if (canContinue(env)) {
    const { results } = await db.prepare(`SELECT id FROM audits WHERE status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY created_at LIMIT ?`).bind(nowIso(), maxStarts).all();
    let started = 0;
    for (const r of results) if (await requestContinuation(env, r.id)) started++;
    return { audits_started: started, audits_due: results.length };
  }
  return processAudits(db, env, { budgetMs, scan });
}

/** Works through due audits (queued, or interrupted) oldest first, inline, until the time budget is used. */
export async function processAudits(db, env, { budgetMs = 100_000, scan } = {}) {
  const deadline = Date.now() + budgetMs;
  let ran = 0;
  while (Date.now() < deadline - 20_000) {
    const next = await db.prepare(`SELECT id FROM audits WHERE status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY created_at LIMIT 1`).bind(nowIso()).first();
    if (!next) break;
    const r = await runAudit(db, env, next.id, { budgetMs: deadline - Date.now(), scan });
    ran++;
    if (r.status === "running") break; // out of time for this run
  }
  return { audits_run: ran };
}

/** Queues a weekly audit for every active paid site whose last audit is over 6 days old. */
export async function enqueueWeeklyAudits(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - 6 * 864e5).toISOString();
  const { results } = await db.prepare(`
    SELECT s.* FROM sites s JOIN users u ON u.id = s.user_id
    WHERE s.status = 'active' AND u.status = 'active' AND u.role != 'demo'
      AND (u.plan = 'lifetime' OR (u.plan = '180day' AND u.plan_expires_at > ?))
      AND NOT EXISTS (SELECT 1 FROM audits a WHERE a.site_id = s.id AND (a.created_at > ? OR a.status IN ('queued', 'running')))`)
    .bind(now.toISOString(), cutoff).all();
  for (const site of results) await startAudit(db, { site, kind: "weekly" });
  return { audits_queued: results.length };
}

// ─── collect + crawl ──────────────────────────────────────────────────────────

const SECURITY_HEADERS = ["strict-transport-security", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "x-robots-tag"];

function compactCollected(d) {
  return {
    host: d.host, org: d.org, origin: d.origin,
    home_headers: Object.fromEntries(SECURITY_HEADERS.map(h => [h, d.home.headers?.[h] ?? null])),
    robots: { ...d.robots, text: d.robots.text?.slice(0, 4000) ?? null },
    sitemap: d.sitemap, llms: d.llms, httpRedirect: d.httpRedirect, email: d.email, rdap: d.rdap ? { ...d.rdap, secureDNS: undefined } : null,
    dnssec: d.dnssec, tls: d.tls, psi: d.psi,
  };
}

function pageRow(rec) {
  const p = rec.page;
  const trimmed = p ? { ...p, links: { internal: p.links.internal.slice(0, 200).map(l => ({ url: l.url, text: l.text.slice(0, 60) })), external: p.links.external.slice(0, 60).map(l => ({ url: l.url, text: l.text.slice(0, 60) })) } } : null;
  return JSON.stringify({ page: trimmed, chain: rec.chain, headers: { "x-robots-tag": rec.headers?.["x-robots-tag"] || null, "content-type": rec.content_type }, error: rec.error, ms: rec.ms });
}

async function enqueue(db, auditId, urls, priority, from) {
  if (!urls.length) return;
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM audit_pages WHERE audit_id = ?").bind(auditId).first();
  const list = urls.slice(0, Math.max(0, MAX_QUEUE - n));
  for (let i = 0; i < list.length; i += 100) { // one statement per 100 URLs, not one per link
    const chunk = list.slice(i, i + 100);
    await db.prepare(`INSERT OR IGNORE INTO audit_pages (audit_id, url, state, priority, found_from) VALUES ${chunk.map(() => "(?, ?, 'queued', ?, ?)").join(", ")}`)
      .bind(...chunk.flatMap(url => [auditId, url, priority, from])).run();
  }
}

async function seedQueue(db, a, site, data) {
  const home = data.home;
  const homeUrl = normalizeUrl(home.final_url) || normalizeUrl(`${data.origin}/`);
  const put = (url, state, rec) => db.prepare(`INSERT OR REPLACE INTO audit_pages (audit_id, url, state, priority, found_from, status_code, final_url, redirects, data, fetched_at)
    VALUES (?, ?, ?, 0, 'seed', ?, ?, ?, ?, ?)`).bind(a.id, url, state, rec.status, rec.final_url, rec.redirects, pageRow(rec), nowIso()).run();
  await put(homeUrl, "done", home);
  // The address we started from redirected (e.g. to www): keep it as an alias, not a second copy of the homepage.
  const start = normalizeUrl(home.url);
  if (start && start !== homeUrl) await put(start, "alias", { ...home, page: null });
  await enqueueLinks(db, a, site, data.robots.crawlRules, home, 1);
  const allowed = u => isCrawlable(u) && robotsAllows(data.robots.crawlRules, CRAWLER_TOKEN, pathOf(u));
  await enqueue(db, a.id, data.sitemap.urls.filter(allowed), 50, "sitemap");
}

const pathOf = u => { const x = new URL(u); return x.pathname + x.search; };

async function enqueueLinks(db, a, site, robots, rec, depth) {
  const links = (rec.page?.links.internal || []).map(l => l.url).filter(u => sameSite(u, site.hostname) && isCrawlable(u));
  const allowed = [...new Set(links)].filter(u => robotsAllows(robots, CRAWLER_TOKEN, pathOf(u)));
  await enqueue(db, a.id, allowed, depth, "link");
}

const countPages = async (db, id, state) => (await db.prepare("SELECT COUNT(*) AS n FROM audit_pages WHERE audit_id = ? AND state = ?").bind(id, state).first()).n;

/** Crawls queued pages in small parallel batches. Returns true when the crawl is finished. */
async function crawlBatch(db, a, site, state, job) {
  const robots = crawlRules(state);
  const delay = Math.min(5, robotsCrawlDelay(robots, CRAWLER_TOKEN) ?? 0);
  const concurrency = delay ? 1 : 4;
  while (job.ok(15_000)) {
    const done = await countPages(db, a.id, "done");
    if (done >= a.page_limit) return true;
    const { results: batch } = await db.prepare("SELECT url, priority FROM audit_pages WHERE audit_id = ? AND state = 'queued' ORDER BY priority, rowid LIMIT ?")
      .bind(a.id, Math.min(concurrency, a.page_limit - done)).all();
    if (!batch.length) { state.crawl_complete = true; return true; }
    const recs = await Promise.all(batch.map(b => fetchPageRecord(b.url, { ms: 10_000 })));
    for (let i = 0; i < batch.length; i++) {
      const rec = recs[i], url = batch[i].url;
      const depth = Math.min(batch[i].priority, 49) + 1;
      const setRow = (key, rowState, r) => db.prepare(`UPDATE audit_pages SET state = ?, status_code = ?, final_url = ?, redirects = ?, data = ?, fetched_at = ? WHERE audit_id = ? AND url = ?`)
        .bind(rowState, r.status, r.final_url, r.redirects, pageRow(r), nowIso(), a.id, key).run();
      const finalKey = normalizeUrl(rec.final_url);
      if (finalKey && finalKey !== url) {
        // A redirect: the redirecting URL becomes an alias (its redirect chain still counts for link checks),
        // and the page itself is stored once, under its final URL, so it's never analysed twice.
        await setRow(url, "alias", { ...rec, page: null });
        if (!sameSite(finalKey, site.hostname) || !rec.page) continue;
        const have = await db.prepare("SELECT state FROM audit_pages WHERE audit_id = ? AND url = ?").bind(a.id, finalKey).first();
        if (have?.state === "done" || have?.state === "alias") continue;
        await db.prepare(`INSERT OR REPLACE INTO audit_pages (audit_id, url, state, priority, found_from, status_code, final_url, redirects, data, fetched_at)
          VALUES (?, ?, 'done', ?, 'redirect', ?, ?, 0, ?, ?)`).bind(a.id, finalKey, batch[i].priority, rec.status, rec.final_url, pageRow({ ...rec, redirects: 0 }), nowIso()).run();
        await enqueueLinks(db, a, site, robots, rec, depth);
        continue;
      }
      await setRow(url, "done", rec);
      if (rec.page) await enqueueLinks(db, a, site, robots, rec, depth);
    }
    if (delay) await new Promise(r => setTimeout(r, delay * 1000));
  }
  return false;
}

// ─── link checks ──────────────────────────────────────────────────────────────

async function headCheck(url) {
  let r = await fetchPublic(url, 8000, { method: "HEAD", readBody: false });
  // Many servers mishandle HEAD (405/501, or a 4xx they wouldn't send for GET): confirm failures with a GET.
  if (r.status >= 400 || (r.status === 0 && ["timeout", "network", "refused"].includes(r.error))) r = await fetchPublic(url, 8000, { readBody: false });
  return { url, status: r.status, final_url: r.finalUrl, redirects: Math.max(0, r.chain.length - 1), chain: r.chain, error: r.error || null };
}

async function pool(items, size, fn, job) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length && job.ok(10_000)) { const x = items[i++]; out.push(await fn(x)); }
  }));
  return out;
}

/** HEAD-checks internal link targets beyond the crawl, a sample of outbound links, and sitemap URLs. */
async function checkLinks(db, a, site, state, job) {
  const pages = await loadPages(db, a.id);
  const aliases = await loadPages(db, a.id, "alias");
  const crawled = new Map([...pages, ...aliases].map(p => [p.url, p]));
  const inbound = new Map();
  for (const p of pages) for (const l of p.page?.links.internal || []) inbound.set(l.url, (inbound.get(l.url) || 0) + 1);
  state.links ??= { internal: [], external: [] };

  if (!state.links.internalDone) {
    const robots = crawlRules(state);
    const pending = [...inbound.keys()].filter(u => !crawled.has(u) && isCrawlable(u) && robotsAllows(robots, CRAWLER_TOKEN, pathOf(u)) && !state.links.internal.some(x => x.url === u))
      .sort((x, y) => inbound.get(y) - inbound.get(x)).slice(0, 80 - state.links.internal.length);
    state.links.internal.push(...await pool(pending, 6, headCheck, job));
    if (!job.ok(10_000)) return false;
    state.links.internalDone = true;
  }
  if (!state.links.externalDone) {
    const ext = [...new Set(pages.flatMap(p => (p.page?.links.external || []).map(l => l.url)))].filter(u => isCrawlable(u)).slice(0, 30);
    state.links.external = await pool(ext, 6, headCheck, job);
    if (!job.ok(10_000)) return false;
    state.links.externalDone = true;
  }
  if (!state.sitemapChecks) {
    const sm = state.collected.sitemap.urls.slice(0, 60);
    const known = sm.filter(u => crawled.has(u)).map(u => { const p = crawled.get(u); return { url: u, status: p.status, final_url: p.final_url, redirects: p.redirects, noindex: !!p.page?.noindex }; });
    const unknown = sm.filter(u => !crawled.has(u) && robotsAllows(crawlRules(state), CRAWLER_TOKEN, pathOf(u))).slice(0, 40);
    const checked = await pool(unknown, 6, headCheck, job);
    if (!job.ok(10_000)) return false;
    state.sitemapChecks = [...known, ...checked.map(c => ({ url: c.url, status: c.status, final_url: c.final_url, redirects: c.redirects, noindex: false }))];
  }
  return true;
}

async function loadPages(db, auditId, state = "done") {
  const { results } = await db.prepare("SELECT url, status_code, final_url, redirects, data, found_from FROM audit_pages WHERE audit_id = ? AND state = ? ORDER BY priority, rowid")
    .bind(auditId, state).all();
  return results.map(r => { const d = parse(r.data, {}); return { url: r.url, status: r.status_code, final_url: r.final_url || r.url, redirects: r.redirects || 0, chain: d.chain || [], headers: d.headers || {}, page: d.page, error: d.error, found_from: r.found_from }; });
}

// ─── data modules ─────────────────────────────────────────────────────────────

async function runModules(db, env, a, site, state, modules, budget, job, scanOpts) {
  const domain = organizationalDomain(site.hostname) || site.hostname;
  const market = MARKETS[site.market] ? site.market : null;
  const { results: compRows } = await db.prepare("SELECT hostname FROM competitors WHERE site_id = ? ORDER BY created_at").bind(site.id).all();
  const competitors = compRows.map(c => c.hostname);
  const charge = ev => budget.charge(ev);
  const affordable = () => budget.allows(0.1);
  const overBudget = source => unavailable(source, "Skipped to stay within this month's data budget for your plan. It refreshes automatically.");

  // Provider data is reused while fresh (cost control): 27 days for weekly audits, 6 days for audits the owner
  // starts. Freshness is the data's own fetch date, and data is only reused when the settings that produced it
  // (market, keywords, competitors, brand, questions) are unchanged, so new settings take effect next audit.
  const reuseDays = a.kind === "weekly" ? 27 : 6;
  const { results: recentRows } = await db.prepare(`SELECT modules FROM audits WHERE site_id = ? AND status = 'complete' AND id != ? AND finished_at > ?
    ORDER BY finished_at DESC LIMIT 8`).bind(site.id, a.id, new Date(Date.now() - reuseDays * 864e5).toISOString()).all();
  const recent = recentRows.map(r => parse(r.modules, {}));
  const reuse = (key, inputs) => {
    for (const mods of recent) {
      const m = mods[key];
      if (m && ["ok", "partial"].includes(m.status) && m.inputs === inputs && Date.now() - Date.parse(m.fetched_at) < reuseDays * 864e5) return { ...m, reused: true };
    }
    return null;
  };
  const fresh = (m, inputs) => ({ ...m, inputs });
  const custom = parse(site.ai_questions, []);
  const questions = custom.length ? custom : defaultQuestions(parse(site.keywords, []), market ? MARKETS[market].label : null);
  const inputs = {
    keywords: JSON.stringify([domain, market]),
    backlinks: JSON.stringify([domain, [...competitors].sort()]),
    ai_visibility: JSON.stringify([domain, site.brand || null, questions, [...competitors].sort()]),
  };

  // One module per call, so progress is saved between them. "wait" = not enough time left in this run.
  if (!modules.competitors) {
    if (competitors.length && job.timeLeft() < 50_000) return "wait";
    const self = competitors.length ? await runScan(site.hostname, env, { psi: "mobile", ...scanOpts }) : null;
    const selfScan = self && !self.unreachable ? self : null;
    modules.competitors = !competitors.length ? unavailable("HeyRanks", "Add up to 5 competitor websites in the report settings to compare against.")
      : selfScan ? await competitorsModule(env, { self: site.hostname, selfScan, competitors, market: market || "US" }, h => runScan(h, env, { psi: "mobile", ...scanOpts }), budget)
      : unavailable("HeyRanks", "Couldn't rescan the site for the comparison.");
    if (dfsConfigured(env) && affordable()) modules.competitors.suggestions = await suggestCompetitors(env, { domain, market: market || "US" }, charge);
    return "progress";
  }
  if (!modules.keywords) {
    modules.keywords = !dfsConfigured(env) ? await keywordsModule(env, { domain, market }, charge)
      : !market ? unavailable("DataForSEO", "Choose your target country in the report settings to measure keywords.")
      : reuse("keywords", inputs.keywords) || (affordable() ? fresh(await keywordsModule(env, { domain, market }, charge), inputs.keywords) : overBudget("DataForSEO"));
    return "progress";
  }
  if (!modules.backlinks) {
    const prev = await db.prepare("SELECT modules FROM audits WHERE site_id = ? AND status = 'complete' AND id != ? ORDER BY finished_at DESC LIMIT 1").bind(site.id, a.id).first();
    modules.backlinks = !dfsConfigured(env) ? await backlinksModule(env, { domain }, charge)
      : reuse("backlinks", inputs.backlinks) || (affordable() ? fresh(await backlinksModule(env, { domain, competitors: competitors.map(c => organizationalDomain(c) || c), previous: parse(prev?.modules, {}).backlinks?.data }, charge), inputs.backlinks) : overBudget("DataForSEO"));
    return "progress";
  }
  if (!modules.ai_visibility) {
    const reused = reuse("ai_visibility", inputs.ai_visibility);
    if (reused) { modules.ai_visibility = reused; return "progress"; }
    const providersOn = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"].some(k => env[k]);
    if (providersOn && questions.length && job.timeLeft() < 60_000) return "wait";
    modules.ai_visibility = fresh(await aiVisibilityModule(env, { domain, brand: site.brand || null, questions, competitors: competitors.map(c => organizationalDomain(c) || c), marketLabel: market ? MARKETS[market].label : null }, budget), inputs.ai_visibility);
    return "progress";
  }
  return "done";
}

// ─── analysis + storage ───────────────────────────────────────────────────────

/** BFS click depth from the homepage over the crawled link graph (following redirects). */
function depths(pages, aliases, homeUrl) {
  const out = new Map([[homeUrl, 0]]);
  const byUrl = new Map(pages.map(p => [p.url, p]));
  const resolve = new Map(aliases.map(x => [x.url, normalizeUrl(x.final_url)]));
  const queue = [homeUrl];
  while (queue.length) {
    const u = queue.shift();
    for (const l of byUrl.get(u)?.page?.links.internal || []) {
      const target = resolve.get(l.url) || l.url;
      if (!out.has(target)) { out.set(target, out.get(u) + 1); queue.push(target); }
    }
  }
  return out;
}

export function auditData(collected, pages, state, modules, aliases = []) {
  const homeUrl = collected.homeUrl || normalizeUrl(`${collected.origin}/`);
  const dep = depths(pages, aliases, homeUrl);
  const recs = pages.map(p => ({ ...p, isHome: p.url === homeUrl, depth: dep.get(p.url) ?? 99 }));
  const home = recs.find(r => r.isHome) || recs[0];
  // Stored page rows keep only a couple of headers; the homepage's full security headers were kept at collect time.
  if (home) home.headers = { ...(collected.home_headers || {}), ...home.headers };
  const inbound = new Map();
  for (const p of recs) for (const l of p.page?.links.internal || []) { const arr = inbound.get(l.url) || []; if (!arr.includes(p.final_url)) arr.push(p.final_url); inbound.set(l.url, arr); }
  for (const p of recs) for (const l of p.page?.links.external || []) { const arr = inbound.get(l.url) || []; if (!arr.includes(p.final_url)) arr.push(p.final_url); inbound.set(l.url, arr); }
  return {
    ...collected, home, pages: recs, inbound,
    links: { internal: [...aliases.map(x => ({ url: x.url, status: x.status, final_url: x.final_url, redirects: x.redirects, chain: x.chain })), ...(state.links?.internal || [])], external: state.links?.external || [] },
    sitemapChecks: state.sitemapChecks || [], crawlComplete: !!state.crawl_complete, modules,
  };
}

function plainSummary(host, scores, findings) {
  const cats = Object.values(scores.categories).filter(c => c.score !== null).sort((x, y) => x.score - y.score);
  const crit = findings.filter(f => f.severity === "critical"), high = findings.filter(f => f.severity === "high");
  const parts = [`${host} scores ${scores.overall}/100 for overall website health, based on ${scores.coverage}% of our checks (confidence: ${scores.confidence}).`];
  if (crit.length) parts.push(`${crit.length} critical issue${crit.length === 1 ? " needs" : "s need"} attention first: ${crit.slice(0, 3).map(f => f.title).join("; ")}.`);
  else if (high.length) parts.push(`Fix ${high.length === 1 ? "this first" : "these first"}: ${high.slice(0, 3).map(f => f.title).join("; ")}.`);
  if (cats.length > 1) parts.push(`Strongest area: ${cats.at(-1).label} (${cats.at(-1).score}). Weakest: ${cats[0].label} (${cats[0].score}).`);
  return parts.join(" ");
}

async function analyze(db, env, a, site, state, modules, budget, job, cost, flush) {
  const pages = await loadPages(db, a.id);
  const data = auditData(state.collected, pages, state, modules, await loadPages(db, a.id, "alias"));
  const checks = runChecks(data, "audit");
  const scores = scoreChecks(checks);
  const findings = toFindings(checks);
  const ctx = { host: site.hostname, org: state.collected.org || site.hostname, origin: state.collected.origin };

  // AI analysts (optional; deterministic text is used when they're unavailable). Weekly audits reuse an AI
  // analysis from the last 27 days instead of paying for a new one (cost control).
  let strategist = { status: env.ANTHROPIC_API_KEY ? "skipped" : "unavailable", message: env.ANTHROPIC_API_KEY ? null : "AI analysis isn't included in this report." };
  let content = { ...strategist };
  let runAnalysts = !!env.ANTHROPIC_API_KEY;
  if (runAnalysts && a.kind === "weekly") {
    const { results: recent } = await db.prepare("SELECT summary, finished_at FROM audits WHERE site_id = ? AND status = 'complete' AND finished_at > ? ORDER BY finished_at DESC LIMIT 5")
      .bind(site.id, new Date(Date.now() - 27 * 864e5).toISOString()).all();
    const withAi = recent.map(r => ({ ...parse(r.summary, {}), finished_at: r.finished_at })).find(s => s.analysts?.strategist?.status === "ok");
    if (withAi) {
      runAnalysts = false;
      strategist = { status: "skipped", message: `Weekly audits reuse the AI analysis from ${withAi.finished_at.slice(0, 10)}; it refreshes every 4 weeks or when you run an audit yourself.` };
      content = withAi.content ? { ...withAi.content, reused_from: withAi.finished_at } : { status: "skipped", message: strategist.message };
    }
  }
  if (runAnalysts) {
    const needsMeta = new Set(findings.filter(f => f.check_id === "title" || f.check_id === "desc").flatMap(f => (f.items || []).map(i => i.url)));
    const contentPages = data.pages.filter(r => r.page && r.status === 200 && !r.page.noindex).map(r => ({ ...r.page, url: r.final_url, needs_meta: needsMeta.has(r.final_url) }))
      .sort((x, y) => Number(y.needs_meta) - Number(x.needs_meta));
    const gaps = modules.keywords?.status === "ok" ? (modules.keywords.data.ideas || []).slice(0, 15).map(k => k.keyword) : [];
    const failed = name => err => { console.error(`[audit] ${a.id} ${name} crashed:`, err); return { status: "error", message: "The AI analysis didn't complete this time." }; };
    const deadline = job.deadline;
    [strategist, content] = await Promise.all([
      growthStrategist(env, { host: site.hostname, scores, findings, modules, deadline }, budget).catch(failed("growth strategist")),
      contentStrategist(env, { host: site.hostname, keywords: parse(site.keywords, []), pages: contentPages, gaps, deadline }, budget).catch(failed("content strategist")),
    ]);
  }
  await flush();
  if (job.lost) return; // cancelled or taken over while the analysts were working

  const prev = await db.prepare("SELECT id FROM audits WHERE site_id = ? AND status = 'complete' AND id != ? ORDER BY finished_at DESC LIMIT 1").bind(site.id, a.id).first();
  const prevFindings = prev ? (await db.prepare("SELECT fingerprint, title, severity FROM findings WHERE audit_id = ?").bind(prev.id).all()).results : null;
  const diff = prev ? diffFindings(findings, prevFindings) : null;

  if (!(await job.renew())) return;
  await db.prepare("DELETE FROM findings WHERE audit_id = ?").bind(a.id).run();
  const now = nowIso();
  for (const f of findings) {
    f.id = `${a.id.slice(0, 8)}-${hashId(f.fingerprint)}`;
    await db.prepare(`INSERT OR REPLACE INTO findings (id, audit_id, site_id, user_id, fingerprint, check_id, category, severity, title, subject, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(f.id, a.id, site.id, site.user_id, f.fingerprint, f.check_id, f.category, f.severity, f.title, f.subject,
      JSON.stringify({ status: f.status, weight: f.weight, credit: f.credit, evidence: f.evidence, items: f.items, data: f.data }), now).run();
  }
  const roadmap = buildRoadmap(findings, f => presentFinding(f, ctx));
  if (strategist.status === "ok") for (const w of strategist.week_focus) if (roadmap[w.week - 1]) roadmap[w.week - 1].focus = w.focus;

  const summary = {
    score_version: SCORE_VERSION,
    executive_summary: strategist.status === "ok" ? strategist.executive_summary : plainSummary(site.hostname, scores, findings),
    executive_summary_source: strategist.status === "ok" ? strategist.source : "HeyRanks (from measured findings)",
    top_priorities: strategist.status === "ok" ? strategist.top_priorities : findings.filter(f => !CHECKS[f.check_id]?.opportunity && f.severity !== "info").slice(0, 5).map(f => ({ fingerprint: f.fingerprint, why_first: null })),
    analysts: { strategist: { status: strategist.status, message: strategist.message || null, model: strategist.model || null }, content: { status: content.status, message: content.message || null, model: content.model || null } },
    content: content.status === "ok" ? content : null,
    roadmap, diff, previous_audit: prev?.id || null,
    counts: scores.counts, opportunities: scores.opportunities, alerts: scores.alerts, capped: scores.capped, confidence: scores.confidence,
    pages: { crawled: pages.length, limit: a.page_limit, complete: !!state.crawl_complete, sitemap_urls: state.collected.sitemap.urls.length,
      queued_left: await countPages(db, a.id, "queued"), links_checked: (state.links?.internal.length || 0) + (state.links?.external.length || 0) },
    cost_usd: cost(),
  };
  const done = await job.finish({
    status: "complete", stage: "complete", score: scores.overall, coverage: scores.coverage, scores: scores.categories, summary, modules,
    state: { collected: state.collected, links: state.links, sitemapChecks: state.sitemapChecks, crawl_complete: state.crawl_complete },
    cost_usd: summary.cost_usd, lease_until: null, finished_at: nowIso(), error: null,
  });
  // One line per audit, so a provider that's down shows up in the logs (and in Admin → Overview).
  if (done) console.log(`[audit] ${a.id} complete site=${site.hostname} kind=${a.kind} score=${scores.overall} pages=${pages.length} cost=${summary.cost_usd} ${
    Object.entries(modules).map(([k, m]) => `${k}=${m.status}${m.reused ? "(reused)" : ""}`).join(" ")} analysts=${strategist.status}/${content.status}`);
}

const hashId = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

// ─── re-checking one finding ("verify my fix") ────────────────────────────────

const PARENT = { spf_multiple: "spf", spf_syntax: "spf", spf_lookups: "spf", spf_permissive: "spf", spf_root: "spf", spf_include: "spf", dmarc_invalid: "dmarc", dmarc_policy: "dmarc", dmarc_misplaced: "dmarc" };
const LINK_CHECKS = new Set(["broken_links", "server_errors", "redirect_chains", "broken_external", "sitemap_errors"]);
// Zero-weight checks only report when they find something, so "no result" means fixed only if the evidence was measured.
const MEASURED = {
  spf_provider_missing: d => !!(d.email?.spf.measured && d.email.mx.measured),
  dkim_unverified: d => !!d.email?.dkim.measured,
  mx_missing: d => !!d.email?.mx.measured,
  domain_expiry: d => d.rdap?.days_left != null,
};
const RECHECK_CONCURRENCY = 4;

/** Runs fn over items, at most `size` at a time; results keep the input order. */
async function mapLimit(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** A response that tells us nothing about the page: blocked, rate-limited, timed out or erroring. */
const unmeasured = r => !r.status || r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500;
const describe = r => r.status ? `HTTP ${r.status}${r.redirects ? `, ${r.redirects} redirect${r.redirects === 1 ? "" : "s"}` : ""}` : (r.error || "no response");
const notMeasured = (checked, actual = "Couldn't be measured right now.") => ({ supported: true, passing: null, checked, at: nowIso(), details: [{ actual }] });

/**
 * Re-measures one finding now. Returns { supported, passing, checked, details, at }.
 * passing: true = measured and fixed, false = measured and still there, null = couldn't be measured right now
 * (blocked, rate-limited, timed out, or the data source didn't answer). It never reports a fix it didn't measure.
 *   site-level checks: re-collect the site's evidence (homepage, DNS, headers...) and re-run the check
 *   page-level checks: re-fetch the affected URLs (up to 10) and re-run the check on them
 *   link checks:       request each affected URL again; a link that's still broken counts as fixed once the pages
 *                      that linked to it no longer do (or, for sitemap errors, once the sitemap no longer lists it)
 */
export async function recheckFinding(env, site, f, scanOpts = {}) {
  const at = nowIso();
  const def = CHECKS[f.check_id];
  if (!def || def.opportunity) return { supported: false, at, message: "This comes from provider data. Run a new audit to refresh it." };
  const items = (f.items || []).filter(i => i.url && (f.check_id === "broken_external" || sameSite(i.url, site.hostname)));
  const urls = [...new Set(items.map(i => i.url))].slice(0, 10);

  if (LINK_CHECKS.has(f.check_id)) {
    if (!urls.length) return { supported: false, at, message: "No URLs to re-check." };
    return recheckLinks(f.check_id, site, urls, items, scanOpts);
  }

  let data, recs = null;
  if (def.scope === "page" && urls.length) {
    recs = await mapLimit(urls, RECHECK_CONCURRENCY, u => (scanOpts.fetchPage || fetchPageRecord)(u));
    const home = { ...recs[0], isHome: false };
    data = { host: site.hostname, org: organizationalDomain(site.hostname), home, pages: recs.map(r => ({ ...r, depth: 1 })), robots: null, sitemap: null, llms: null, email: null, rdap: null, tls: null, psi: null, httpRedirect: null, dnssec: null };
  } else {
    const psi = def.category === "performance" ? "mobile" : f.check_id === "a11y_score" ? "full" : false;
    data = await collectSite(site.hostname, env, { psi, ...scanOpts });
    if (!data || data.unreachable) return { ...notMeasured(0, data?.message || "The site couldn't be opened right now."), details: [{ url: `https://${site.hostname}/`, actual: data?.message || "The site couldn't be opened right now." }] };
  }
  const results = runChecks(data, "audit");
  const parent = PARENT[f.check_id] || f.check_id;
  const own = results.filter(r => r.id === parent || r.finding_id === f.check_id);
  const failing = own.filter(r => r.status === "fail" || r.status === "warn");
  if (failing.length) return { supported: true, passing: false, checked: recs ? recs.filter(r => !unmeasured(r)).length : 1, at,
    details: (failing[0].items || [{ actual: failing[0].evidence?.detected }]).slice(0, 10) };

  if (recs) {
    // Page checks: a page we couldn't load can't count as fixed.
    const blind = recs.filter(unmeasured);
    const checked = recs.length - blind.length;
    if (blind.length) return { supported: true, passing: null, checked, at, details: blind.map(r => ({ url: r.url, actual: `couldn't load the page (${describe(r)})` })) };
    if (own.length ? own.every(r => r.status === "na") : def.weight) return notMeasured(0, own[0]?.evidence?.detected);
    return { supported: true, passing: true, checked, at, details: own[0] ? [{ actual: own[0].evidence?.detected }] : [] };
  }
  if (!own.length) {
    const measured = !def.weight && (MEASURED[f.check_id] ? MEASURED[f.check_id](data) : true);
    return measured ? { supported: true, passing: true, checked: 1, at, details: [] } : notMeasured(0, "The data behind this check didn't answer right now. Try again later.");
  }
  if (own.every(r => r.status === "na")) return notMeasured(0, own[0].evidence?.detected);
  return { supported: true, passing: true, checked: 1, at, details: [{ actual: own[0].evidence?.detected }] };
}

/** Per-URL verdict for a link check: "ok", "bad" or "unknown". */
function linkVerdict(check, r) {
  const works = r.status >= 200 && r.status < 400;
  if (check === "redirect_chains") return !works ? "unknown" : r.redirects >= 2 ? "bad" : "ok";
  if (check === "sitemap_errors") return !r.status || [401, 403, 429].includes(r.status) || r.status >= 500 ? "unknown"
    : r.status >= 400 || r.redirects > 0 || r.page?.noindex ? "bad" : "ok";
  if (check === "server_errors") return works ? "ok" : r.status >= 500 || ["timeout", "refused", "network"].includes(r.error) ? "bad" : "unknown";
  if (check === "broken_external") return works ? "ok" : r.status === 404 || r.status === 410 || r.error === "dns" ? "bad" : "unknown";
  return works ? "ok" : r.status >= 400 && r.status < 500 && ![401, 403, 429].includes(r.status) ? "bad" : "unknown"; // broken_links
}

async function recheckLinks(check, site, urls, items, scanOpts = {}) {
  const at = nowIso();
  const fetchPage = scanOpts.fetchPage || fetchPageRecord, head = scanOpts.headCheck || headCheck;
  const fromOf = new Map(items.map(i => [i.url, (i.from || []).slice(0, 5)]));
  // Sitemap URLs are fetched in full so a noindex tag is seen; other links only need the status.
  const res = await mapLimit(urls, RECHECK_CONCURRENCY, async u => {
    const r = check === "sitemap_errors" ? await fetchPage(u) : await head(u);
    return { ...r, url: u, verdict: linkVerdict(check, r) };
  });

  const stillBad = res.filter(r => r.verdict === "bad");
  if (stillBad.length && check !== "sitemap_errors") {
    // Still broken: is it still linked? Re-fetch the pages that linked to it (shared across URLs, at most 10).
    const sources = [...new Set(stillBad.flatMap(r => fromOf.get(r.url) || []))].filter(u => sameSite(u, site.hostname)).slice(0, 10);
    const fetched = await mapLimit(sources, RECHECK_CONCURRENCY, u => fetchPage(u));
    const pages = new Map(fetched.map((p, k) => [sources[k], p]));
    const linksOf = p => [...(p.page.links.internal || []), ...(p.page.links.external || [])].map(l => normalizeUrl(l.url));
    for (const r of stillBad) {
      const linking = (fromOf.get(r.url) || []).map(u => pages.get(u));
      // Unknown linking pages, or one we couldn't read: we can't tell, so it stays "still broken".
      if (!linking.length || linking.some(p => !p || unmeasured(p) || !p.page)) continue;
      const target = normalizeUrl(r.url);
      if (!linking.some(p => linksOf(p).includes(target))) { r.verdict = "ok"; r.unlinked = true; }
    }
  }
  if (stillBad.length && check === "sitemap_errors") {
    const origin = new URL(urls[0]).origin;
    const robots = await fetchPublic(`${origin}/robots.txt`, 8000);
    const sitemap = await (scanOpts.discoverSitemap || discoverSitemap)(origin, site.hostname, robots.ok ? parseRobots(robots.text) : null);
    if (sitemap.measured && sitemap.found) {
      const listed = new Set(sitemap.urls.map(u => normalizeUrl(u)));
      for (const r of stillBad) if (!listed.has(normalizeUrl(r.url))) { r.verdict = "ok"; r.unlinked = true; }
    }
  }

  const bad = res.filter(r => r.verdict === "bad"), unknown = res.filter(r => r.verdict === "unknown");
  const detail = r => ({ url: r.url, actual: r.unlinked ? (check === "sitemap_errors" ? "no longer in the sitemap" : "no longer linked")
    : r.verdict === "unknown" ? `couldn't check (${describe(r)})` : describe(r) });
  return { supported: true, passing: bad.length ? false : unknown.length ? null : true, checked: res.length - unknown.length, at, details: res.map(detail) };
}
