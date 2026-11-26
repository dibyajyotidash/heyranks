// Regression tests for behaviour found in review: certificate / robots / redirect handling, honest
// "verify my fix" results, SPF include problems and score-version-aware period summaries. No network:
// the sites are public IP literals and fetch is faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSite } from "../lib/scan.js";
import { runChecks } from "../lib/analysis.js";
import { recheckFinding } from "../lib/audit.js";
import { analyzeEmail } from "../lib/domain.js";
import { presentFinding } from "../lib/catalog.js";
import { summarise } from "../lib/reports.js";
import { extractPage } from "../lib/crawler.js";

const HOST = "93.184.216.34", S = `https://${HOST}`;
const html = body => new Response(`<!doctype html><html lang="en"><head><title>A page title</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
const nf = () => new Response("nf", { status: 404 });
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(new URL(url), init);
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const collect = () => collectSite(HOST, {}, { psi: false });

test("a rejected certificate is a critical finding, not an unreachable site", async () => {
  await withFetch(url => {
    if (url.protocol === "https:") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } });
    return url.pathname === "/" ? html("<h1>Plain</h1>") : nf();
  }, async () => {
    const data = await collect();
    assert.ok(!data.unreachable);
    const https = runChecks(data, "scan").find(c => c.id === "https");
    assert.equal(https.status, "fail");
    assert.equal(https.finding_id, "tls_cert");
    assert.equal(https.severity, "critical");
  });
});

test("robots.txt answering 5xx means don't crawl, and the check says so", async () => {
  await withFetch(url => (url.pathname === "/robots.txt" ? new Response("boom", { status: 503 }) : url.pathname === "/" ? html("<h1>Home</h1>") : nf()), async () => {
    const data = await collect();
    assert.equal(data.robots.serverError, true);
    assert.equal(data.robots.measured, true);
    assert.deepEqual(data.robots.crawlRules.groups.flatMap(g => g.rules.map(r => r.allow)), [false]);
  });
});

test("http:// redirecting to https:// counts even if the HTTPS hop afterwards is slow", async () => {
  await withFetch(url => {
    if (url.protocol === "http:") return new Response(null, { status: 301, headers: { location: `${S}/landing` } });
    if (url.pathname === "/landing") throw Object.assign(new Error("slow"), { name: "TimeoutError" });
    return url.pathname === "/" ? html("<h1>Home</h1>") : nf();
  }, async () => assert.equal((await collect()).httpRedirect.toHttps, true));
});

// ─── "verify my fix" ──────────────────────────────────────────────────────────
const site = { hostname: HOST };
const broken = { check_id: "broken_links", items: [{ url: `${S}/missing`, from: [`${S}/`] }] };
const pageRec = (url, body) => ({ url, final_url: url, status: 200, redirects: 0, chain: [], headers: {}, page: extractPage(`<html><body>${body}</body></html>`, url) });
const head = status => async url => ({ url, status, final_url: url, redirects: 0, chain: [], error: status ? null : "timeout" });

test("re-check: a blocked or timed-out link is 'couldn't check', never fixed", async () => {
  for (const status of [403, 429, 0]) {
    const r = await recheckFinding({}, site, broken, { headCheck: head(status) });
    assert.equal(r.passing, null, `status ${status}`);
    assert.equal(r.checked, 0);
  }
});

test("re-check: a still-404 link is fixed only once the linking page stops linking to it", async () => {
  const still = await recheckFinding({}, site, broken, { headCheck: head(404), fetchPage: async u => pageRec(u, `<a href="/missing">x</a>`) });
  assert.equal(still.passing, false);
  const removed = await recheckFinding({}, site, broken, { headCheck: head(404), fetchPage: async u => pageRec(u, `<a href="/other">x</a>`) });
  assert.equal(removed.passing, true);
  assert.match(removed.details[0].actual, /no longer linked/);
  const unreadable = await recheckFinding({}, site, broken, { headCheck: head(404), fetchPage: async u => ({ url: u, status: 0, error: "timeout" }) });
  assert.equal(unreadable.passing, false, "can't read the linking page: it stays broken");
});

test("re-check: a page that can't be loaded doesn't count as fixed", async () => {
  const f = { check_id: "title", items: [{ url: `${S}/about` }] };
  const r = await recheckFinding({}, site, f, { fetchPage: async u => ({ url: u, final_url: u, status: 0, redirects: 0, chain: [], headers: {}, error: "timeout" }) });
  assert.equal(r.passing, null);
  assert.equal(r.checked, 0);
});

test("re-check: an unreachable site reports 'not measured'", async () => {
  await withFetch(() => new Response("down", { status: 503 }), async () => {
    const r = await recheckFinding({}, site, { check_id: "hsts", items: [] }, {});
    assert.equal(r.passing, null);
  });
});

// ─── SPF include problems ─────────────────────────────────────────────────────
const dns = zone => async (name, type) => {
  const data = zone[`${name} ${type}`] || [];
  return { ok: true, nxdomain: !data.length, answers: data.map(d => ({ type: { TXT: 16, MX: 15 }[type], data: d })) };
};
const emailChecks = async zone => runChecks({ host: "example.com", org: "example.com", email: await analyzeEmail("example.com", { dns: dns(zone) }),
  home: { final_url: "https://example.com/", headers: {}, page: null }, pages: [] }, "scan");

test("an SPF include with no SPF record behind it fails; a repeated include only warns", async () => {
  const dead = (await emailChecks({ "example.com TXT": ['"v=spf1 include:gone.example.net ~all"'] })).find(c => c.id === "spf");
  assert.equal(dead.finding_id, "spf_include");
  assert.equal(dead.status, "fail");
  assert.match(presentFinding({ check_id: "spf_include", data: dead.data }, { host: "example.com", org: "example.com" }).code, /include gone\.example\.net: 0 SPF records/);

  const twice = (await emailChecks({ "example.com TXT": ['"v=spf1 include:a.example.net include:a.example.net ~all"'], "a.example.net TXT": ['"v=spf1 ip4:1.2.3.4 ~all"'] })).find(c => c.id === "spf");
  assert.equal(twice.finding_id, "spf_include");
  assert.equal(twice.status, "warn");
  assert.equal(twice.severity, "low");
});

// ─── period summaries across a scoring-method change ──────────────────────────
const scan = (score, ids, at, version) => ({ score, speed: null, created_at: at, issues: JSON.stringify(ids.map(id => ({ id, label: id, w: 5, fix: "" }))),
  details: version ? JSON.stringify({ score_version: version }) : null });

test("period summaries never compare scores or issues across scoring methods", () => {
  const s = summarise([scan(90, ["old"], "2026-11-02T06:00:00Z"), scan(60, ["a", "b"], "2026-11-09T06:00:00Z", 2), scan(70, ["a"], "2026-11-16T06:00:00Z", 2)],
    scan(88, ["old"], "2026-10-26T06:00:00Z"));
  assert.equal(s.score_start, 60);
  assert.equal(s.score_end, 70);
  assert.equal(s.score_max, 70);
  assert.deepEqual(s.summary.resolved, ["b"]);
  assert.equal(s.summary.method_changed, true);
  assert.equal(s.scans_count, 3);
  assert.equal(summarise([scan(60, [], "2026-11-09T06:00:00Z", 2)], scan(50, [], "2026-11-02T06:00:00Z", 2)).summary.method_changed, false);
});
