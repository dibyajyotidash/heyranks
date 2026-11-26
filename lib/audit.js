/**
 * Full-site audits: a resumable job that crawls up to `page_limit` pages, checks links, runs the data
 * modules (competitors, keywords, backlinks, AI visibility), asks the AI analysts and stores findings.
 *
 * Stages: collect -> crawl -> links -> modules -> analyze -> complete.
 * Every stage saves its progress, so an audit interrupted by a function timeout continues on the next call
 * (status poll, cron or retry). A lease (lease_until) makes sure only one worker runs an audit at a time.
 * Crawling respects robots.txt (and Crawl-delay), stays on the site's own host, and every request goes
 * through the SSRF-safe fetcher in net.js.
 */
import { fetchPublic } from "./net.js";
import { robotsAllows, robotsCrawlDelay, fetchPageRecord, normalizeUrl, sameSite, isCrawlable, CRAWLER_TOKEN } from "./crawler.js";
import { collectSite, runScan } from "./scan.js";
import { runChecks, scoreChecks, toFindings, buildRoadmap, diffFindings, SCORE_VERSION } from "./analysis.js";
import { presentFinding, CHECKS } from "./catalog.js";
import { organizationalDomain } from "./domain.js";
import { keywordsModule, backlinksModule, competitorsModule, aiVisibilityModule, suggestCompetitors, defaultQuestions, MARKETS, dfsConfigured, unavailable } from "./providers.js";
import { Budget, growthStrategist, contentStrategist } from "./ai.js";

export const PAGE_LIMIT = 50;
const LEASE_MS = 150_000;
const MAX_ATTEMPTS = 8;
const MAX_QUEUE = 600;
const nowIso = () => new Date().toISOString();
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ─── lifecycle ────────────────────────────────────────────────────────────────

/** Creates an audit, or returns the site's audit that is already queued/running (no duplicate crawls). */
export async function startAudit(db, { site, kind = "premium", pageLimit = PAGE_LIMIT }) {
  const active = await db.prepare("SELECT * FROM audits WHERE site_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1").bind(site.id).first();
  if (active) return { audit: active, reused: true };
  const id = crypto.randomUUID(), now = nowIso();
  await db.prepare(`INSERT INTO audits (id, site_id, user_id, kind, status, stage, page_limit, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 'collect', ?, ?, ?)`).bind(id, site.id, site.user_id, kind, pageLimit, now, now).run();
  return { audit: await db.prepare("SELECT * FROM audits WHERE id = ?").bind(id).first(), reused: false };
}

export async function cancelAudit(db, id) {
  await db.prepare("UPDATE audits SET status = 'cancelled', lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')")
    .bind(nowIso(), nowIso(), id).run();
}

/** True when the audit should be picked up: queued, or running with an expired lease. */
export const auditIsStale = a => (a.status === "queued" || a.status === "running") && (!a.lease_until || a.lease_until < nowIso());

async function claim(db, id) {
  const now = nowIso();
  return db.prepare(`UPDATE audits SET status = 'running', lease_until = ?, started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?) RETURNING *`)
    .bind(new Date(Date.now() + LEASE_MS).toISOString(), now, now, id, now).first();
}

const save = (db, id, fields) => {
  const keys = Object.keys(fields);
  return db.prepare(`UPDATE audits SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map(k => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k])), nowIso(), id).run();
};
const renew = (db, id) => db.prepare("UPDATE audits SET lease_until = ? WHERE id = ? AND status = 'running'").bind(new Date(Date.now() + LEASE_MS).toISOString(), id).run();
const isCancelled = async (db, id) => (await db.prepare("SELECT status FROM audits WHERE id = ?").bind(id).first())?.status === "cancelled";

/**
 * Works on one audit until it completes or `budgetMs` runs out. Safe to call repeatedly and concurrently:
 * a second caller finds the lease taken and returns { skipped: true }.
 * opts.scan: options passed to collectSite / runScan (tests pass stubs).
 */
export async function runAudit(db, env, auditId, { budgetMs = 240_000, scan = {} } = {}) {
  const deadline = Date.now() + budgetMs;
  const a = await claim(db, auditId);
  if (!a) return { skipped: true };
  if (a.attempts > MAX_ATTEMPTS) {
    await save(db, a.id, { status: "failed", error: "The audit was interrupted too many times. Please start it again.", lease_until: null, finished_at: nowIso() });
    return { status: "failed" };
  }
  const site = await db.prepare("SELECT * FROM sites WHERE id = ?").bind(a.site_id).first();
  if (!site) { await save(db, a.id, { status: "failed", error: "Site removed.", lease_until: null }); return { status: "failed" }; }
  const state = parse(a.state, {});
  const modules = parse(a.modules, {});
  state.usage ??= [];
  const budget = new Budget(Number(env.AUDIT_COST_CAP_USD) || 1.5, ev => state.usage.push({ ...ev, at: nowIso() }));
  budget.spent = state.usage.reduce((s, u) => s + (u.cost_usd || 0), 0);
  let stage = a.stage || "collect";
  const timeLeft = () => deadline - Date.now();
  const persist = extra => save(db, a.id, { stage, state, modules, cost_usd: Math.round(budget.spent * 10000) / 10000, ...extra });

  try {
    while (timeLeft() > 4000) {
      if (await isCancelled(db, a.id)) return { status: "cancelled" };
      if (stage === "collect") {
        const data = await collectSite(site.hostname, env, { psi: "full", ...scan });
        if (!data || data.unreachable) throw new UserError(`We couldn't open ${site.hostname}${data?.home?.status ? ` (HTTP ${data.home.status})` : ""}. Check the site is online and try again.`);
        state.collected = { ...compactCollected(data), homeUrl: normalizeUrl(data.home.final_url) || normalizeUrl(`${data.origin}/`) };
        modules.performance = data.psi.mobile ? { status: "ok", source: "Google PageSpeed Insights (Lighthouse lab + Chrome UX Report field data)", fetched_at: nowIso(), data: { mobile: data.psi.mobile, desktop: data.psi.desktop } }
          : unavailable("Google PageSpeed Insights", data.psi.error || "PageSpeed Insights didn't return a result.");
        await seedQueue(db, a, site, data);
        stage = "crawl";
        await persist();
      } else if (stage === "crawl") {
        const done = await crawlBatch(db, a, site, state, timeLeft);
        await renew(db, a.id);
        if (done) { stage = "links"; }
        await persist({ pages_crawled: await countPages(db, a.id, "done"), pages_queued: await countPages(db, a.id, "queued") });
      } else if (stage === "links") {
        const done = await checkLinks(db, a, site, state, timeLeft);
        if (done) stage = "modules";
        await persist();
      } else if (stage === "modules") {
        const step = await runModules(db, env, a, site, state, modules, budget, timeLeft, scan);
        if (step === "done") stage = "analyze";
        await persist();
        if (step === "wait") break; // the next module needs more time than this run has left
      } else if (stage === "analyze") {
        if (timeLeft() < 60_000 && env.ANTHROPIC_API_KEY) break; // leave room for the AI analysts on the next run
        await analyze(db, env, a, site, state, modules, budget);
        return { status: "complete" };
      }
      await renew(db, a.id);
    }
    await save(db, a.id, { lease_until: null });
    return { status: "running", stage };
  } catch (err) {
    const message = err instanceof UserError ? err.message : "Something went wrong while auditing. Please try again.";
    if (!(err instanceof UserError)) console.error(`[audit] ${a.id} failed at ${stage}:`, err);
    await save(db, a.id, { status: "failed", stage, error: message, lease_until: null, finished_at: nowIso(), state, modules });
    return { status: "failed" };
  }
}

class UserError extends Error {}

/** Runs due audits (queued, or interrupted) oldest first until the time budget is used. For the cron. */
export async function processAudits(db, env, { budgetMs = 100_000, scan } = {}) {
  const deadline = Date.now() + budgetMs;
  let ran = 0;
  while (Date.now() < deadline - 20_000) {
    const next = await db.prepare(`SELECT id FROM audits WHERE status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY created_at LIMIT 1`).bind(nowIso()).first();
    if (!next) break;
    const r = await runAudit(db, env, next.id, { budgetMs: deadline - Date.now(), scan });
    ran++;
    if (r.status === "running" || r.skipped) break;
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

function compactCollected(d) {
  return {
    host: d.host, org: d.org, origin: d.origin,
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
  const room = Math.max(0, MAX_QUEUE - n);
  for (const url of urls.slice(0, room)) {
    await db.prepare("INSERT OR IGNORE INTO audit_pages (audit_id, url, state, priority, found_from) VALUES (?, ?, 'queued', ?, ?)").bind(auditId, url, priority, from).run();
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
  await enqueueLinks(db, a, site, data.robots.parsed, home, 1);
  const allowed = u => isCrawlable(u) && robotsAllows(data.robots.parsed, CRAWLER_TOKEN, pathOf(u));
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
async function crawlBatch(db, a, site, state, timeLeft) {
  const robots = state.collected.robots.parsed;
  const delay = Math.min(5, robotsCrawlDelay(robots, CRAWLER_TOKEN) ?? 0);
  const concurrency = delay ? 1 : 4;
  while (timeLeft() > 15_000) {
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
  if (r.status === 405 || r.status === 501 || r.status === 0 && !r.blocked) r = await fetchPublic(url, 8000, { readBody: false });
  return { url, status: r.status, final_url: r.finalUrl, redirects: Math.max(0, r.chain.length - 1), chain: r.chain, error: r.blocked ? "blocked: not a public address" : r.error || null };
}

async function pool(items, size, fn, timeLeft) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length && timeLeft() > 10_000) { const x = items[i++]; out.push(await fn(x)); }
  }));
  return out;
}

/** HEAD-checks internal link targets beyond the crawl, a sample of outbound links, and sitemap URLs. */
async function checkLinks(db, a, site, state, timeLeft) {
  const pages = await loadPages(db, a.id);
  const aliases = await loadPages(db, a.id, "alias");
  const crawled = new Map([...pages, ...aliases].map(p => [p.url, p]));
  const inbound = new Map();
  for (const p of pages) for (const l of p.page?.links.internal || []) inbound.set(l.url, (inbound.get(l.url) || 0) + 1);
  state.links ??= { internal: [], external: [] };

  if (!state.links.internalDone) {
    const robots = state.collected.robots.parsed;
    const pending = [...inbound.keys()].filter(u => !crawled.has(u) && isCrawlable(u) && robotsAllows(robots, CRAWLER_TOKEN, pathOf(u)) && !state.links.internal.some(x => x.url === u))
      .sort((x, y) => inbound.get(y) - inbound.get(x)).slice(0, 80 - state.links.internal.length);
    state.links.internal.push(...await pool(pending, 6, headCheck, timeLeft));
    if (timeLeft() < 10_000) return false;
    state.links.internalDone = true;
  }
  if (!state.links.externalDone) {
    const ext = [...new Set(pages.flatMap(p => (p.page?.links.external || []).map(l => l.url)))].filter(u => isCrawlable(u)).slice(0, 30);
    state.links.external = await pool(ext, 6, headCheck, timeLeft);
    if (timeLeft() < 10_000) return false;
    state.links.externalDone = true;
  }
  if (!state.sitemapChecks) {
    const sm = state.collected.sitemap.urls.slice(0, 60);
    const known = sm.filter(u => crawled.has(u)).map(u => { const p = crawled.get(u); return { url: u, status: p.status, final_url: p.final_url, redirects: p.redirects, noindex: !!p.page?.noindex }; });
    const unknown = sm.filter(u => !crawled.has(u) && robotsAllows(state.collected.robots.parsed, CRAWLER_TOKEN, pathOf(u))).slice(0, 40);
    const checked = await pool(unknown, 6, headCheck, timeLeft);
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

async function runModules(db, env, a, site, state, modules, budget, timeLeft, scanOpts) {
  const domain = organizationalDomain(site.hostname) || site.hostname;
  const market = MARKETS[site.market] ? site.market : null;
  const { results: compRows } = await db.prepare("SELECT hostname FROM competitors WHERE site_id = ? ORDER BY created_at").bind(site.id).all();
  const competitors = compRows.map(c => c.hostname);
  const charge = ev => budget.charge(ev);
  const affordable = () => budget.allows(0.1);

  // One module per call, so progress is saved between them. "wait" = not enough time left in this run.
  if (!modules.competitors) {
    if (competitors.length && timeLeft() < 50_000) return "wait";
    const selfScan = competitors.length ? await runScan(site.hostname, env, { psi: "mobile", ...scanOpts }) : null;
    modules.competitors = !competitors.length ? unavailable("HeyRanks", "Add up to 5 competitor websites in the report settings to compare against.")
      : selfScan ? await competitorsModule(env, { self: site.hostname, selfScan, competitors, market: market || "US" }, h => runScan(h, env, { psi: "mobile", ...scanOpts }), charge)
      : unavailable("HeyRanks", "Couldn't rescan the site for the comparison.");
    if (dfsConfigured(env) && affordable()) modules.competitors.suggestions = await suggestCompetitors(env, { domain, market: market || "US" }, charge);
    return "progress";
  }
  if (!modules.keywords) {
    modules.keywords = !dfsConfigured(env) ? await keywordsModule(env, { domain, market }, charge)
      : !market ? unavailable("DataForSEO", "Choose your target country in the report settings to measure keywords.")
      : affordable() ? await keywordsModule(env, { domain, market }, charge) : unavailable("DataForSEO", "Skipped: this audit's data budget is used up.");
    return "progress";
  }
  if (!modules.backlinks) {
    const prev = await db.prepare("SELECT modules FROM audits WHERE site_id = ? AND status = 'complete' AND id != ? ORDER BY finished_at DESC LIMIT 1").bind(site.id, a.id).first();
    modules.backlinks = !dfsConfigured(env) || affordable()
      ? await backlinksModule(env, { domain, competitors: competitors.map(c => organizationalDomain(c) || c), previous: parse(prev?.modules, {}).backlinks?.data }, charge)
      : unavailable("DataForSEO", "Skipped: this audit's data budget is used up.");
    return "progress";
  }
  if (!modules.ai_visibility) {
    // AI answers are sampled at most once every 6 days per site (cost control); weekly audits reuse a recent sample.
    const recent = await db.prepare(`SELECT modules, finished_at FROM audits WHERE site_id = ? AND status = 'complete' AND finished_at > ? ORDER BY finished_at DESC LIMIT 1`)
      .bind(site.id, new Date(Date.now() - 6 * 864e5).toISOString()).first();
    const prevVis = parse(recent?.modules, {}).ai_visibility;
    if (prevVis && ["ok", "partial"].includes(prevVis.status) && a.kind === "weekly") { modules.ai_visibility = { ...prevVis, reused_from: recent.finished_at }; return "progress"; }
    const custom = parse(site.ai_questions, []);
    const questions = custom.length ? custom : defaultQuestions(parse(site.keywords, []), market ? MARKETS[market].label : null);
    const providersOn = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"].some(k => env[k]);
    if (providersOn && questions.length && timeLeft() < 60_000) return "wait";
    modules.ai_visibility = await aiVisibilityModule(env, { domain, brand: site.brand || null, questions, competitors: competitors.map(c => organizationalDomain(c) || c), marketLabel: market ? MARKETS[market].label : null }, budget);
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
  if (crit.length) parts.push(`${crit.length} critical issue${crit.length === 1 ? " needs" : "s need"} attention first: ${crit.slice(0, 3).map(f => f.title.toLowerCase()).join("; ")}.`);
  else if (high.length) parts.push(`The most important fixes are: ${high.slice(0, 3).map(f => f.title.toLowerCase()).join("; ")}.`);
  if (cats.length > 1) parts.push(`Strongest area: ${cats.at(-1).label} (${cats.at(-1).score}). Weakest: ${cats[0].label} (${cats[0].score}).`);
  return parts.join(" ");
}

async function analyze(db, env, a, site, state, modules, budget) {
  const pages = await loadPages(db, a.id);
  const data = auditData(state.collected, pages, state, modules, await loadPages(db, a.id, "alias"));
  const checks = runChecks(data, "audit");
  const scores = scoreChecks(checks);
  const findings = toFindings(checks);
  const ctx = { host: site.hostname, org: state.collected.org || site.hostname, origin: state.collected.origin };

  // AI analysts (optional; deterministic text is used when they're unavailable).
  let strategist = { status: env.ANTHROPIC_API_KEY ? "skipped" : "unavailable", message: env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY isn't set." };
  let content = { ...strategist };
  if (env.ANTHROPIC_API_KEY) {
    const needsMeta = new Set(findings.filter(f => f.check_id === "title" || f.check_id === "desc").flatMap(f => (f.items || []).map(i => i.url)));
    const contentPages = data.pages.filter(r => r.page && r.status === 200 && !r.page.noindex).map(r => ({ ...r.page, url: r.final_url, needs_meta: needsMeta.has(r.final_url) }))
      .sort((x, y) => Number(y.needs_meta) - Number(x.needs_meta));
    const gaps = modules.keywords?.status === "ok" ? (modules.keywords.data.ideas || []).slice(0, 15).map(k => k.keyword) : [];
    [strategist, content] = await Promise.all([
      growthStrategist(env, { host: site.hostname, scores, findings, modules }, budget).catch(err => ({ status: "error", message: String(err.message) })),
      contentStrategist(env, { host: site.hostname, keywords: parse(site.keywords, []), pages: contentPages, gaps }, budget).catch(err => ({ status: "error", message: String(err.message) })),
    ]);
  }

  const prev = await db.prepare("SELECT id FROM audits WHERE site_id = ? AND status = 'complete' AND id != ? ORDER BY finished_at DESC LIMIT 1").bind(site.id, a.id).first();
  const prevFindings = prev ? (await db.prepare("SELECT fingerprint, title, severity FROM findings WHERE audit_id = ?").bind(prev.id).all()).results : null;
  const diff = prev ? diffFindings(findings, prevFindings) : null;

  await db.prepare("DELETE FROM findings WHERE audit_id = ?").bind(a.id).run();
  const now = nowIso();
  for (const f of findings) {
    f.id = `${a.id.slice(0, 8)}-${hashId(f.fingerprint)}`;
    await db.prepare(`INSERT INTO findings (id, audit_id, site_id, user_id, fingerprint, check_id, category, severity, title, subject, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(f.id, a.id, site.id, site.user_id, f.fingerprint, f.check_id, f.category, f.severity, f.title, f.subject,
      JSON.stringify({ status: f.status, weight: f.weight, credit: f.credit, evidence: f.evidence, items: f.items, data: f.data }), now).run();
  }
  const roadmap = buildRoadmap(findings, f => presentFinding(f, ctx));
  if (strategist.status === "ok") for (const w of strategist.week_focus) if (roadmap[w.week - 1]) roadmap[w.week - 1].focus = w.focus;

  for (const u of state.usage) {
    await db.prepare(`INSERT INTO usage_events (id, user_id, site_id, audit_id, provider, operation, units, cost_usd, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), site.user_id, site.id, a.id, u.provider, String(u.operation).slice(0, 80), u.units || 1, u.cost_usd || 0, u.ok === false ? 0 : 1, u.at || now).run();
  }

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
    cost_usd: Math.round(budget.spent * 10000) / 10000,
  };
  await save(db, a.id, {
    status: "complete", stage: "complete", score: scores.overall, coverage: scores.coverage, scores: scores.categories, summary, modules,
    state: { collected: state.collected, links: state.links, sitemapChecks: state.sitemapChecks, crawl_complete: state.crawl_complete, usage: [] },
    cost_usd: summary.cost_usd, lease_until: null, finished_at: nowIso(), error: null,
  });
}

const hashId = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

// ─── re-checking one finding ("verify my fix") ────────────────────────────────

const PARENT = { spf_multiple: "spf", spf_syntax: "spf", spf_lookups: "spf", spf_permissive: "spf", dmarc_invalid: "dmarc", dmarc_policy: "dmarc" };
const LINK_CHECKS = new Set(["broken_links", "server_errors", "redirect_chains", "broken_external", "sitemap_errors"]);

/**
 * Re-measures one finding now. Returns { supported, passing, checked, details, at }.
 *   site-level checks: re-collect the site's evidence (homepage, DNS, headers...) and re-run the check
 *   page-level checks: re-fetch the affected URLs (up to 10) and re-run the check on them
 *   link checks:       request each affected URL again
 */
export async function recheckFinding(env, site, f, scanOpts = {}) {
  const at = nowIso();
  const def = CHECKS[f.check_id];
  if (!def || def.opportunity) return { supported: false, at, message: "This comes from provider data. Run a new audit to refresh it." };
  const urls = [...new Set((f.items || []).map(i => i.url).filter(u => u && (f.check_id === "broken_external" || sameSite(u, site.hostname))))].slice(0, 10);

  if (LINK_CHECKS.has(f.check_id)) {
    if (!urls.length) return { supported: false, at, message: "No URLs to re-check." };
    const res = await Promise.all(urls.map(headCheck));
    const bad = res.filter(r => f.check_id === "redirect_chains" ? r.redirects >= 2 : !(r.status >= 200 && r.status < 400) || (f.check_id === "sitemap_errors" && r.redirects > 0));
    return { supported: true, passing: !bad.length, checked: res.length, at, details: res.map(r => ({ url: r.url, actual: r.status ? `HTTP ${r.status}${r.redirects ? `, ${r.redirects} redirect${r.redirects === 1 ? "" : "s"}` : ""}` : r.error })) };
  }

  let data;
  if (def.scope === "page" && urls.length) {
    const recs = await Promise.all(urls.map(u => fetchPageRecord(u)));
    const home = { ...recs[0], isHome: false };
    data = { host: site.hostname, org: organizationalDomain(site.hostname), home, pages: recs.map(r => ({ ...r, depth: 1 })), robots: null, sitemap: null, llms: null, email: null, rdap: null, tls: null, psi: null, httpRedirect: null, dnssec: null };
  } else {
    const psi = def.category === "performance" ? "mobile" : f.check_id === "a11y_score" ? "full" : false;
    data = await collectSite(site.hostname, env, { psi, ...scanOpts });
    if (!data || data.unreachable) return { supported: true, passing: false, checked: 0, at, details: [{ url: `https://${site.hostname}/`, actual: "site couldn't be opened" }] };
  }
  const results = runChecks(data, "audit");
  const parent = PARENT[f.check_id] || f.check_id;
  const own = results.filter(r => r.id === parent || r.finding_id === f.check_id);
  const failing = own.filter(r => r.status === "fail" || r.status === "warn");
  if (!own.length || own.every(r => r.status === "na")) {
    // Zero-weight checks only appear when they find something; no result means the problem is gone.
    if (!def.weight && !own.length) return { supported: true, passing: true, checked: urls.length || 1, at, details: [] };
    return { supported: true, passing: null, checked: 0, at, details: [{ actual: own[0]?.evidence?.detected || "Couldn't be measured right now." }] };
  }
  return { supported: true, passing: !failing.length, checked: urls.length || 1, at,
    details: failing.length ? (failing[0].items || [{ actual: failing[0].evidence?.detected }]).slice(0, 10) : [{ actual: own[0].evidence?.detected }] };
}
