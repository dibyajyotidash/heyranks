// The scoring engine and issue catalogue. Pure; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks, scoreChecks, toFindings, buildRoadmap, diffFindings, legacyIssues } from "../lib/analysis.js";
import { CHECKS, CATEGORIES, presentFinding } from "../lib/catalog.js";
import { extractPage } from "../lib/crawler.js";

const page = (url, body, head = "") => ({ url, final_url: url, status: 200, redirects: 0, chain: [{ url, status: 200 }], headers: {},
  page: extractPage(`<html lang="en"><head>${head}</head><body>${body}</body></html>`, url) });
const GOOD_HEAD = `<title>A good title for the page</title><meta name="description" content="${"A clear description of this page. ".repeat(2)}"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"><meta property="og:title" content="x"><meta property="og:image" content="y"><script type="application/ld+json">{"@type":"Organization"}</script>`;
const words = n => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

function base(extra = {}) {
  const home = { ...page("https://example.com/", `<h1>Home</h1><p>${words(400)}</p><a href="/contact">Contact us</a><a href="/privacy">Privacy</a><a href="tel:1">Call</a> testimonials`, GOOD_HEAD + '<script src="https://plausible.io/js/script.js"></script>'), isHome: true, depth: 0 };
  return {
    host: "example.com", org: null, origin: "https://example.com", home, pages: [home],
    robots: { measured: true, found: true, parsed: { groups: [], sitemaps: [] } }, sitemap: { measured: true, found: true, valid: true, files: ["s"], urls: [] },
    llms: { measured: true, found: true }, httpRedirect: { measured: true, toHttps: true, final: "https://example.com/", chain: [] },
    email: null, rdap: null, dnssec: null, tls: null, psi: { mobile: null, error: "not run" }, ...extra,
  };
}

test("every catalogue check is complete and belongs to a known category", () => {
  for (const [id, c] of Object.entries(CHECKS)) {
    assert.ok(CATEGORIES[c.category], `${id}: category`);
    for (const k of ["title", "why", "impact", "time", "expertise"]) assert.ok(c[k], `${id}: ${k}`);
    assert.equal(typeof c.steps, "function", `${id}: steps`);
    assert.equal(typeof c.verify, "function", `${id}: verify`);
    assert.ok(Array.isArray(c.refs), `${id}: refs`);
    for (const r of c.refs) assert.match(r.url, /^https:\/\//, `${id}: reference URL`);
    const p = presentFinding({ check_id: id, items: [{ url: "https://example.com/x", actual: "y" }], data: {}, evidence: {} }, { host: "example.com", org: "example.com" });
    assert.ok(p.steps.length >= 1, `${id}: renders steps`);
  }
  const health = Object.values(CATEGORIES).reduce((s, c) => s + c.weight, 0);
  assert.equal(health, 100, "health category weights add up to 100");
});

test("unmeasured checks never count as failures", () => {
  const checks = runChecks(base(), "scan");
  assert.ok(checks.filter(c => c.category === "performance").every(c => c.status === "na"));
  assert.ok(checks.filter(c => c.category === "email").every(c => c.status === "na"), "no domain -> email not measured");
  const s = scoreChecks(checks);
  assert.equal(s.categories.performance.score, null);
  assert.equal(s.categories.email.score, null);
  assert.ok(s.coverage < 100);
  const measured = Object.values(s.categories).filter(c => c.score !== null);
  const avg = Math.round(measured.reduce((a, c) => a + c.score * c.weight, 0) / measured.reduce((a, c) => a + c.weight, 0));
  assert.equal(s.overall, avg);
});

test("a critical problem caps the overall score; domain expiry is an alert, not a deduction", () => {
  const ok = scoreChecks(runChecks(base(), "scan"));
  const home = { ...base().home, final_url: "http://example.com/" };
  const insecure = scoreChecks(runChecks(base({ home, pages: [home] }), "scan"));
  assert.ok(insecure.capped, "HTTPS failure caps the score");
  assert.equal(insecure.overall, 59);
  assert.ok(insecure.alerts.some(a => a.id === "https"));

  const expiring = scoreChecks(runChecks(base({ rdap: { domain: "example.com", expires: new Date(Date.now() + 10 * 864e5).toISOString(), days_left: 10, registrar: "R" } }), "scan"));
  assert.ok(expiring.alerts.some(a => a.id === "domain_expiry" && a.severity === "critical"));
  const withoutCap = expiring.capped ? expiring.capped.from : expiring.overall;
  assert.equal(withoutCap, ok.overall, "expiry doesn't change the category maths");
});

test("page-level checks give proportional credit and soften severity when few pages are affected", () => {
  const good = n => page(`https://example.com/p${n}`, `<h1>P${n}</h1><p>${words(350)}</p>`, GOOD_HEAD.replace("A good title for the page", `A good title for page ${n}`));
  const bad = page("https://example.com/bad", `<h1>Bad</h1><p>${words(350)}</p>`, "");
  const pages = [base().home, ...Array.from({ length: 9 }, (_, i) => good(i)), bad];
  const checks = runChecks(base({ pages }), "audit");
  const title = checks.find(c => c.id === "title");
  assert.equal(title.status, "warn");
  assert.ok(Math.abs(title.credit - (1 - 1 / 11)) < 1e-9);
  assert.equal(title.severity, "low", "1 of 11 pages, not the homepage: lowered from medium");
  assert.equal(title.items[0].url, "https://example.com/bad");
});

test("one problem is scored once: SPF sub-problems share the SPF check", () => {
  const ids = Object.entries(CHECKS).filter(([, c]) => c.category === "email" && c.weight > 0).map(([id]) => id);
  assert.ok(ids.includes("spf") && ids.includes("spf_multiple"));
  const checks = runChecks(base({ org: "example.com", email: { domain: "example.com", host: "example.com", mx: { measured: true, records: [] },
    spf: { measured: true, records: ["v=spf1 a ~all", "v=spf1 mx ~all"], includes: [] }, dmarc: { measured: true, records: [] }, dkim: { measured: true, selectors_found: [], selectors_probed: ["google"] }, provider: null } }), "scan");
  const email = checks.filter(c => c.category === "email" && c.weight > 0);
  assert.deepEqual(email.map(c => c.id).sort(), ["dmarc", "spf"], "only two scored email checks");
});

test("findings carry evidence; legacy issues keep stable ids and severity order", () => {
  const home = { ...base().home, page: extractPage("<html><head></head><body></body></html>", "https://example.com/") };
  const findings = toFindings(runChecks(base({ home, pages: [home] }), "scan"));
  assert.ok(findings.length > 3);
  for (const f of findings) { assert.ok(f.fingerprint && f.check_id && f.severity && f.title); assert.ok(f.evidence?.detected || f.items?.length, `${f.check_id} has evidence`); }
  const legacy = legacyIssues(findings);
  assert.ok(legacy.some(i => i.id === "title"));
  assert.ok(legacy.every((x, i) => i === 0 || legacy[i - 1].w >= x.w), "sorted by priority");
});

test("roadmap is built from findings only, and diffs compare fingerprints", () => {
  const f = (id, severity, category) => ({ fingerprint: id, check_id: id, severity, category, title: id, items: [] });
  const findings = [f("https", "critical", "security"), f("title", "medium", "onpage"), f("kw_striking", "info", "keywords"), f("cta", "medium", "conversion"), f("dkim_unverified", "info", "email")];
  const weeks = buildRoadmap(findings, x => presentFinding(x, { host: "example.com", org: "example.com" }));
  assert.deepEqual(weeks.map(w => w.tasks.map(t => t.fingerprint)), [["https"], ["title"], ["kw_striking"], ["cta"]]);
  assert.ok(weeks[0].tasks[0].instructions.length && weeks[0].tasks[0].verify);
  const d = diffFindings([f("a", "low"), f("b", "low")], [f("b", "low"), f("c", "high")]);
  assert.deepEqual(d.new.map(x => x.fingerprint), ["a"]);
  assert.deepEqual(d.resolved.map(x => x.fingerprint), ["c"]);
  assert.equal(d.persisting, 1);
});

test("robots.txt that blocks Googlebot is critical; blocking only others is high", () => {
  const blocked = runChecks(base({ robots: { measured: true, found: true, parsed: { groups: [{ agents: ["*"], rules: [{ allow: false, path: "/" }], crawlDelay: null }], sitemaps: [] } } }), "scan");
  assert.equal(blocked.find(c => c.id === "robots_blocked").severity, "critical");
  const othersOnly = runChecks(base({ robots: { measured: true, found: true, parsed: { groups: [{ agents: ["*"], rules: [{ allow: false, path: "/" }], crawlDelay: null }, { agents: ["googlebot"], rules: [], crawlDelay: null }], sitemaps: [] } } }), "scan");
  const r = othersOnly.find(c => c.id === "robots_blocked");
  assert.equal(r.status, "warn");
  assert.equal(r.severity, "high");
  const ai = blocked.find(c => c.id === "ai");
  assert.equal(ai.status, "fail", "AI crawlers fall under * too");
});
