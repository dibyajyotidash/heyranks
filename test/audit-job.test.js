// Full-site audit end to end through the API: a fake website, a fake competitor, fake PageSpeed, fake
// Claude and OpenAI. Checks the crawl, findings, scoring, roadmap, entitlements and tenant isolation.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync(".data", { recursive: true });
const dir = mkdtempSync(join(process.cwd(), ".data", "test-auditjob-"));
process.env.TURSO_DATABASE_URL = `file:${join(dir, "a.db").replace(/\\/g, "/")}`;
const { handleApi } = await import("../lib/api.js");
const { d1 } = await import("../lib/db.js");
const { runAudit } = await import("../lib/audit.js");

const SITE = "93.184.216.34", COMP = "93.184.216.35", EXT_OK = "93.184.216.40", EXT_GONE = "93.184.216.41";
const S = `https://${SITE}`;
const env = { ...process.env, DB: d1(process.env), ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "ok", OPENAI_MODEL: "test-model", PSI_KEY: "psi" };
const jobs = [];
const ctx = { waitUntil: p => jobs.push(p) };
const drain = async () => { while (jobs.length) await jobs.shift(); };

// ─── fake web ─────────────────────────────────────────────────────────────────
const words = n => Array.from({ length: n }, (_, i) => `service${i % 97} detail${i}`).join(" ");
const page = (title, body, extra = "") => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width">
<meta name="description" content="A useful description of this page for searchers and AI tools to read.">${extra}</head><body>${body}</body></html>`;
const PAGES = {
  "/": page("Example Dental Bhubaneswar | Family dentist", `<h1>Family dentist</h1><p>${words(200)}</p>
    <a href="/about">About</a> <a href="/services">Services</a> <a href="/contact">Contact us</a> <a href="/old">Old page</a>
    <a href="/missing">Missing</a> <a href="/chain1">Offers</a> <a href="/private/area">Staff</a> <a href="tel:+911">Call</a>
    <a href="https://${EXT_OK}/">Partner</a> <a href="https://${EXT_GONE}/x">Dead partner</a> <a href="/privacy">Privacy</a>`,
    `<link rel="canonical" href="${S}/"><script type="application/ld+json">{"@type":"Dentist","name":"Example Dental"}</script><meta property="og:title" content="x"><meta property="og:image" content="y">`),
  "/about": page("About us | Example Dental", `<h1>About</h1><p>${words(200)}</p><a href="/">Home</a>`),
  "/services": page("About us | Example Dental", `<h1>Services</h1><p>${words(180)} unique services text</p><a href="/services/implants">Implants</a>`),
  "/services/implants": page("Dental implants in Bhubaneswar", `<h1>Implants</h1><p>${words(60)}</p><img src="i.jpg">`),
  "/contact": page("Contact Example Dental", `<h1>Contact</h1><p>Call us.</p><form><input name="email"></form>`),
  "/privacy": page("Privacy policy", `<h1>Privacy</h1><p>${words(150)}</p>`),
  "/blog/post": page("A blog post nobody links to", `<h1>Post</h1><p>${words(150)}</p>`),
};
const REDIRECTS = { "/old": "/about", "/chain1": "/chain2", "/chain2": "/services" };
let missingFixed = false;
const net = { calls: [], claude: [] };

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  net.calls.push(`${init.method || "GET"} ${u}`);
  if (u.startsWith("https://www.googleapis.com/pagespeedonline/")) {
    const strategy = new URL(u).searchParams.get("strategy");
    return Response.json({ lighthouseResult: { lighthouseVersion: "12", categories: { performance: { score: strategy === "mobile" ? 0.48 : 0.9, auditRefs: [{ id: "unused-javascript" }] }, accessibility: { score: 0.81, auditRefs: [{ id: "color-contrast" }] } },
      audits: { "largest-contentful-paint": { numericValue: 4600 }, "cumulative-layout-shift": { numericValue: 0.02 }, "total-blocking-time": { numericValue: 350 },
        "unused-javascript": { id: "unused-javascript", title: "Reduce unused JavaScript", score: 0.3, scoreDisplayMode: "numeric", details: { overallSavingsMs: 600 } },
        "color-contrast": { id: "color-contrast", title: "Low contrast text", score: 0, scoreDisplayMode: "binary", details: { items: [{}] } } } } });
  }
  if (u === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(init.body);
    net.claude.push(body);
    const props = body.output_config?.format?.schema?.properties || {};
    let text;
    if (props.executive_summary) {
      const refs = [...body.messages[0].content.matchAll(/"ref":"(F\d+)"/g)].map(m => m[1]);
      text = JSON.stringify({ executive_summary: "Broken links and a slow mobile page are holding the site back.", top_priorities: [{ finding_ref: refs[0], why_first: "Most severe." }], week_focus: [{ week: 1, focus: "Fix broken links." }] });
    } else if (props.meta_suggestions) {
      text = JSON.stringify({ meta_suggestions: [{ page_ref: "P1", title: "New title", description: "New description", reason: "Clearer." }], article_ideas: [{ title: "Implant costs explained", target_query: "dental implant cost", outline: ["Costs", "Process"], why: "Common question." }], internal_links: [], content_improvements: [] });
    } else if (props.items) {
      text = JSON.stringify({ items: [...body.messages[0].content.matchAll(/"ref":"(A\d+)"/g)].map(m => ({ ref: m[1], sentiment: "positive", reason: "well reviewed" })) });
    } else text = "Example Dental and a few other clinics are well reviewed.";
    return Response.json({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 800 }, content: [{ type: "text", text }] });
  }
  if (u === "https://api.openai.com/v1/chat/completions") return Response.json({ model: "test-model", choices: [{ message: { content: `Try ${COMP} or a local clinic.` } }] });
  const p = new URL(u);
  if (p.hostname === EXT_OK) return new Response("ok", { headers: { "content-type": "text/html" } });
  if (p.hostname === EXT_GONE) return new Response("gone", { status: 404 });
  if (p.hostname === COMP) {
    if (p.pathname === "/") return new Response(page("Competitor clinic", `<h1>Clinic</h1><p>${words(300)}</p>`, `<script type="application/ld+json">{"@type":"Dentist"}</script>`), { headers: { "content-type": "text/html" } });
    if (p.pathname === "/llms.txt") return new Response("# Competitor\n\n> A clinic that publishes an llms.txt file.");
    return new Response("nf", { status: 404 });
  }
  if (p.hostname !== SITE) throw new Error("unexpected fetch " + u);
  if (p.protocol === "http:") return new Response(null, { status: 301, headers: { location: `${S}${p.pathname}` } });
  if (p.pathname === "/robots.txt") return new Response(`User-agent: *\nDisallow: /private/\nSitemap: ${S}/sitemap.xml`);
  if (p.pathname === "/sitemap.xml") return new Response(`<urlset>${["/", "/about", "/services", "/blog/post", "/gone-from-sitemap"].map(x => `<url><loc>${S}${x}</loc></url>`).join("")}</urlset>`, { headers: { "content-type": "application/xml" } });
  if (p.pathname.startsWith("/private/")) throw new Error("robots.txt-disallowed URL was requested: " + u);
  if (REDIRECTS[p.pathname]) return new Response(null, { status: 301, headers: { location: REDIRECTS[p.pathname] } });
  if (p.pathname === "/missing" && missingFixed) return new Response(page("Back", "<h1>Back</h1>"), { headers: { "content-type": "text/html" } });
  const html = PAGES[p.pathname];
  return html ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
};

async function call(method, route, { body, cookie } = {}) {
  const h = { host: "heyranks.test", "user-agent": "Mozilla/5.0" };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const res = await handleApi(new Request(`https://heyranks.test/api/${route}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx, route.split("?")[0]);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

let paid, free, other, siteId, auditId, report;
before(async () => {
  paid = (await call("POST", "auth/signup", { body: { email: "owner@example.com", password: "owner password", website: SITE } })).cookie;
  free = (await call("POST", "auth/signup", { body: { email: "free@example.com", password: "free password", website: SITE } })).cookie;
  other = (await call("POST", "auth/signup", { body: { email: "other@example.com", password: "other password" } })).cookie;
  await env.DB.prepare("UPDATE users SET plan = '180day', plan_expires_at = ? WHERE email = 'owner@example.com'").bind(new Date(Date.now() + 90 * 864e5).toISOString()).run();
  siteId = (await call("GET", "sites", { cookie: paid })).data.sites[0].id;
});

test("free plans can't start a full audit", async () => {
  const fSite = (await call("GET", "sites", { cookie: free })).data.sites[0].id;
  assert.equal((await call("POST", `sites/${fSite}/audits`, { cookie: free, body: {} })).status, 403);
});

test("settings and competitors are validated and owner-only", async () => {
  const s = await call("PATCH", `sites/${siteId}`, { cookie: paid, body: { brand: "Example Dental", market: "IN", keywords: ["dentist"], ai_questions: ["Who is the best family dentist in Bhubaneswar?", "short"] } });
  assert.equal(s.status, 200);
  assert.deepEqual(s.data.site.ai_questions, ["Who is the best family dentist in Bhubaneswar?"], "too-short questions are dropped");
  assert.equal((await call("PATCH", `sites/${siteId}`, { cookie: paid, body: { market: "XX" } })).status, 400);
  assert.equal((await call("POST", `sites/${siteId}/competitors`, { cookie: paid, body: { website: SITE } })).status, 400, "not your own site");
  const c = await call("POST", `sites/${siteId}/competitors`, { cookie: paid, body: { website: `https://${COMP}/` } });
  assert.equal(c.status, 200);
  assert.equal(c.data.competitors[0].hostname, COMP);
  assert.equal((await call("POST", `sites/${siteId}/competitors`, { cookie: paid, body: { website: COMP } })).status, 409);
  assert.equal((await call("GET", `sites/${siteId}/competitors`, { cookie: other })).status, 404, "other users can't see them");
});

test("starting an audit while one is running joins it instead of crawling twice", async () => {
  const now = new Date().toISOString(), lease = new Date(Date.now() + 60_000).toISOString();
  await env.DB.prepare(`INSERT INTO audits (id, site_id, user_id, kind, status, stage, page_limit, lease_until, created_at, updated_at)
    SELECT 'running-one', id, user_id, 'premium', 'running', 'crawl', 50, ?, ?, ? FROM sites WHERE id = ?`).bind(lease, now, now, siteId).run();
  await drain();
  const r = await call("POST", `sites/${siteId}/audits`, { cookie: paid, body: {} });
  const started = jobs.length;
  await env.DB.prepare("DELETE FROM audits WHERE id = 'running-one'").run();
  assert.equal(r.data.audit.id, "running-one");
  assert.equal(r.data.reused, true);
  assert.equal(started, 0, "the running worker holds the lease, so nothing new is started");
});

test("a paid audit crawls, checks links, gathers data, and completes", async () => {
  const r = await call("POST", `sites/${siteId}/audits`, { cookie: paid, body: {} });
  assert.equal(r.status, 202);
  auditId = r.data.audit.id;
  await drain();
  const res = await call("GET", `audits/${auditId}`, { cookie: paid });
  assert.equal(res.status, 200);
  report = res.data;
  assert.equal(report.audit.status, "complete", report.audit.error);
  assert.ok(!net.calls.some(c => c.includes("/private/")), "robots.txt is respected");
});

const finding = id => report.findings.find(f => f.check_id === id);

test("findings reflect the site, with evidence and fix instructions", () => {
  const urls = report.pages.map(p => p.url);
  assert.ok(urls.includes(`${S}/about`) && urls.includes(`${S}/services/implants`));
  assert.equal(urls.filter(u => u === `${S}/about`).length, 1, "a redirect to /about isn't a second copy of /about");
  assert.ok(report.pages.find(p => p.url === `${S}/services/implants`).depth === 2);

  const broken = finding("broken_links");
  assert.deepEqual(broken.items.map(i => i.url), [`${S}/missing`]);
  assert.deepEqual(broken.items[0].from, [`${S}/`]);
  assert.ok(broken.steps.length && broken.why && broken.verify && broken.refs.length);
  assert.ok(finding("redirect_chains").items.some(i => i.url === `${S}/chain1`));
  assert.deepEqual(finding("sitemap_errors").items.map(i => i.url), [`${S}/gone-from-sitemap`]);
  assert.deepEqual(finding("broken_external").items.map(i => i.url), [`https://${EXT_GONE}/x`]);
  assert.ok(finding("duplicate_titles").items.some(i => i.url === `${S}/services`));
  assert.ok(finding("orphan_pages").items.some(i => i.url === `${S}/blog/post`));
  assert.ok(finding("thin_content").items.some(i => i.url === `${S}/services/implants`));
  assert.ok(!finding("thin_content").items.some(i => i.url === `${S}/contact`), "utility pages aren't judged on length");
  assert.ok(finding("img_alt") && finding("form_labels"));
  assert.ok(finding("perf_score") && finding("lcp") && finding("a11y_score"));
  assert.equal(finding("http_redirect"), undefined, "http:// redirects to https://");
});

test("scores, coverage, summary, roadmap and modules", () => {
  assert.equal(typeof report.audit.score, "number");
  assert.ok(report.audit.coverage > 60);
  assert.equal(report.categories.performance.score !== null, true);
  assert.equal(report.categories.email.score, null, "an IP address has no email domain: not measured, not failed");
  assert.match(report.summary.executive_summary, /Broken links/);
  assert.match(report.summary.executive_summary_source, /Claude/);
  assert.equal(report.summary.roadmap.length, 4);
  assert.ok(report.summary.roadmap[0].tasks.some(t => t.fingerprint === "broken_links"));
  assert.equal(report.summary.roadmap[0].focus, "Fix broken links.");
  assert.equal(report.summary.content.meta_suggestions[0].url.startsWith(S), true);
  assert.equal(report.modules.keywords.status, "unavailable", "no keyword provider configured");
  assert.equal(report.modules.backlinks.status, "unavailable");
  assert.equal(report.modules.performance.data.desktop.scores.performance, 90);
  const comp = report.modules.competitors.data;
  assert.equal(comp.sites[0].host, COMP);
  assert.ok(finding("competitor_gap")?.items.some(i => /llms\.txt/i.test(i.actual)), "competitor has llms.txt, we don't");
  const vis = report.modules.ai_visibility.data;
  assert.equal(vis.sample_size, 2, "1 question × (Claude + OpenAI)");
  assert.equal(vis.providers.find(p => p.provider === "anthropic").mentioned, 1);
  assert.equal(vis.competitors[0].mentioned, 1);
  assert.ok(net.claude.every(b => b.model === "claude-opus-5-5"));
  assert.equal(report.summary.cost_usd, undefined, "internal cost isn't shown to customers");
  assert.ok(report.methodology.limitations.length && report.integrations.dataforseo.configured === false);
});

test("other users can't read, cancel or update this audit", async () => {
  assert.equal((await call("GET", `audits/${auditId}`, { cookie: other })).status, 404);
  assert.equal((await call("POST", `audits/${auditId}/cancel`, { cookie: other, body: {} })).status, 404);
  assert.equal((await call("PATCH", `sites/${siteId}/findings`, { cookie: other, body: { fingerprint: "broken_links", status: "done" } })).status, 404);
});

test("progress can be tracked, and re-checking a fix marks it done", async () => {
  const ignore = await call("PATCH", `sites/${siteId}/findings`, { cookie: paid, body: { fingerprint: "orphan_pages", status: "ignored" } });
  assert.equal(ignore.status, 200);
  assert.equal((await call("PATCH", `sites/${siteId}/findings`, { cookie: paid, body: { fingerprint: "nope", status: "done" } })).status, 404);
  const still = await call("POST", `sites/${siteId}/recheck`, { cookie: paid, body: { fingerprint: "broken_links" } });
  assert.equal(still.data.passing, false);
  missingFixed = true;
  const fixed = await call("POST", `sites/${siteId}/recheck`, { cookie: paid, body: { fingerprint: "broken_links" } });
  assert.equal(fixed.data.supported, true);
  assert.equal(fixed.data.passing, true);
  const r = (await call("GET", `audits/${auditId}`, { cookie: paid })).data;
  assert.equal(r.findings.find(f => f.check_id === "broken_links").progress, "done");
  assert.equal(r.findings.find(f => f.check_id === "orphan_pages").progress, "ignored");
  assert.equal(r.summary.roadmap[0].tasks.find(t => t.fingerprint === "broken_links").progress, "done");
  const kw = await call("POST", `sites/${siteId}/recheck`, { cookie: paid, body: { fingerprint: "competitor_gap" } });
  assert.equal(kw.data.supported, false, "provider data needs a new audit");
});

test("a second audit reports what changed; cancelled audits stop", async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run();
  const second = (await call("POST", `sites/${siteId}/audits`, { cookie: paid, body: {} })).data.audit.id;
  await drain();
  const r = (await call("GET", `audits/${second}`, { cookie: paid })).data;
  assert.equal(r.audit.status, "complete");
  assert.ok(r.summary.diff.resolved.some(f => f.fingerprint === "broken_links"));
  assert.equal(r.history.length, 2);
  assert.equal(r.modules.ai_visibility.status, "ok");

  const { startAudit } = await import("../lib/audit.js");
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first();
  const third = (await startAudit(env.DB, { site })).audit.id; // queued, not started
  assert.equal((await call("POST", `audits/${third}/cancel`, { cookie: paid, body: {} })).status, 200);
  assert.deepEqual(await runAudit(env.DB, env, third), { skipped: true });
  assert.equal((await call("GET", `audits/${third}`, { cookie: paid })).data.audit.status, "cancelled");
});

test("usage costs are recorded for the admin; deleting the site removes its audits", async () => {
  const usage = await env.DB.prepare("SELECT provider, SUM(cost_usd) AS usd FROM usage_events GROUP BY provider").all();
  assert.ok(usage.results.find(u => u.provider === "anthropic").usd > 0);
  assert.ok(usage.results.find(u => u.provider === "openai"), "non-Anthropic calls are recorded with an estimated cost");
  assert.equal((await call("DELETE", `sites/${siteId}`, { cookie: paid, body: {} })).status, 200);
  for (const t of ["audits", "findings", "competitors", "finding_status"]) {
    assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`).bind(siteId).first()).n, 0, t);
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_pages WHERE audit_id = ?").bind(auditId).first()).n, 0);
});
