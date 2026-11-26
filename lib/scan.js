/**
 * The homepage scan (free scan, rescans, weekly reports) and the site-level evidence the full audit
 * reuses. Collects everything in parallel, then scores it with lib/analysis.js.
 */
import { fetchPublic, isPrivateAddress, resolvesToPublic, isIpLiteral } from "./net.js";
import { analyzeEmail, organizationalDomain, domainRegistration, dnssecSigned, tlsCertificate } from "./domain.js";
import { parseRobots, parseSitemap, fetchPageRecord, normalizeUrl, sameSite } from "./crawler.js";
import { pageSpeed } from "./providers.js";
import { runChecks, scoreChecks, toFindings, legacyIssues, passedLabels, SCORE_VERSION } from "./analysis.js";
import { presentFinding } from "./catalog.js";

/** Validates a user-typed website and returns its URL. Throws a user-facing message. */
export function normalize(input) {
  let u = String(input || "").trim().replace(/^https?:\/\//i, "");
  if (!u) throw new Error("Please enter a website.");
  if (!u.includes(".")) throw new Error("That doesn't look like a website address.");
  let url;
  try { url = new URL("https://" + u); } catch { throw new Error("That doesn't look like a website address."); }
  if (isPrivateAddress(url.hostname)) throw new Error("Invalid host.");
  return url;
}

const MAX_SITEMAP_URLS = 500;

/** Finds and reads the sitemap: robots.txt Sitemap: lines, then /sitemap.xml and /sitemap_index.xml. */
export async function discoverSitemap(origin, host, robotsParsed) {
  const candidates = [...new Set([...(robotsParsed?.sitemaps || []).map(s => normalizeUrl(s, origin)).filter(u => u && sameSite(u, host)).slice(0, 3),
    `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])];
  const out = { measured: false, found: false, valid: false, files: [], urls: [] };
  for (const url of candidates) {
    const r = await fetchPublic(url, 8000);
    if (r.status) out.measured = true; // any HTTP answer (even 404) means we could check
    if (!r.ok) continue;
    out.found = true;
    const sm = parseSitemap(r.text);
    if (!sm.type) continue;
    out.valid = true;
    out.files.push(url);
    if (sm.type === "urlset") out.urls.push(...sm.urls.map(u => u.loc));
    else {
      for (const child of sm.sitemaps.filter(s => sameSite(s, host)).slice(0, 4)) {
        const c = await fetchPublic(child, 8000);
        const cs = c.ok ? parseSitemap(c.text) : null;
        if (cs?.type === "urlset") { out.files.push(child); out.urls.push(...cs.urls.map(u => u.loc)); }
        if (out.urls.length >= MAX_SITEMAP_URLS) break;
      }
    }
    break;
  }
  out.urls = [...new Set(out.urls.map(u => normalizeUrl(u, origin)).filter(u => u && sameSite(u, host)))].slice(0, MAX_SITEMAP_URLS);
  return out;
}

/**
 * Everything a scan or an audit knows about the site apart from the crawl.
 * opts.psi: false | "mobile" (performance only) | "full" (mobile + desktop, all Lighthouse categories)
 * opts.tls: certificate inspector (tests pass a stub).
 */
export async function collectSite(hostname, env, opts = {}) {
  const host = hostname.toLowerCase();
  if (isPrivateAddress(host) || !(await resolvesToPublic(host))) return null;
  const org = organizationalDomain(host);
  let origin = `https://${host}`;
  const psiMode = opts.psi === undefined ? "mobile" : opts.psi;
  const tlsFn = opts.tls || tlsCertificate;

  const homeP = fetchPageRecord(`${origin}/`).then(async r => {
    if (r.status) return r;
    const plain = await fetchPageRecord(`http://${host}/`); // no HTTPS at all: read the http:// site instead
    return plain.status ? plain : r;
  });
  const robotsP = fetchPublic(`${origin}/robots.txt`, 8000);
  let [home, robotsRes, llmsRes, httpRes, email, rdap, tls, psiMobile, psiDesktop] = await Promise.all([
    homeP, robotsP,
    fetchPublic(`${origin}/llms.txt`, 8000),
    fetchPublic(`http://${host}/`, 8000, { readBody: false }),
    org ? analyzeEmail(host, opts.dns ? { dns: opts.dns } : {}) : null,
    org ? domainRegistration(org) : null,
    isIpLiteral(host) ? null : tlsFn(host),
    psiMode ? pageSpeed(`${origin}/`, "mobile", env, { categories: psiMode === "full" ? ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"] : ["PERFORMANCE"] }) : null,
    psiMode === "full" ? pageSpeed(`${origin}/`, "desktop", env, { categories: ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"] }) : null,
  ]);
  if (!home.status || home.status >= 400) return { unreachable: true, home };
  if (home.final_url?.startsWith("http://")) {
    origin = `http://${host}`;
    [robotsRes, llmsRes] = await Promise.all([fetchPublic(`${origin}/robots.txt`, 8000), fetchPublic(`${origin}/llms.txt`, 8000)]);
  }

  const robotsFound = robotsRes.ok && !/<html/i.test(robotsRes.text.slice(0, 500));
  const robots = { measured: robotsRes.status !== 0 || robotsRes.blocked, found: robotsFound, status: robotsRes.status,
    parsed: robotsFound ? parseRobots(robotsRes.text) : null, text: robotsFound ? robotsRes.text.slice(0, 4000) : null };
  const sitemap = await discoverSitemap(origin, host, robots.parsed);
  const dnssec = org ? await dnssecSigned(org, rdap, opts.dns ? { dns: opts.dns } : {}) : null;
  const finalHttp = httpRes.chain.at(-1)?.url || null;

  return {
    host, org, origin,
    home: { ...home, isHome: true },
    pages: [{ ...home, isHome: true, depth: 0 }],
    robots, sitemap,
    llms: { measured: llmsRes.status !== 0, found: llmsRes.ok && llmsRes.text.trim().length > 20 && !/<html/i.test(llmsRes.text.slice(0, 500)) },
    httpRedirect: { measured: httpRes.chain.length > 0, toHttps: !!finalHttp && finalHttp.startsWith("https://") && httpRes.status > 0 && httpRes.status < 400, final: finalHttp, chain: httpRes.chain },
    email, rdap, dnssec, tls,
    psi: { mobile: psiMobile?.result || null, desktop: psiDesktop?.result || null, error: psiMobile?.error || null },
  };
}

/** Compact, display-ready record of a scan for the scans.details column and the dashboard. */
export function scanDetails(data, scores, findings) {
  const e = data.email;
  return {
    score_version: SCORE_VERSION,
    scores: { overall: scores.overall, coverage: scores.coverage, confidence: scores.confidence, capped: scores.capped, counts: scores.counts,
      categories: Object.fromEntries(Object.values(scores.categories).map(c => [c.id, { label: c.label, score: c.score, coverage: c.coverage }])) },
    alerts: scores.alerts,
    findings: findings.map(f => ({ ...f, items: (f.items || []).slice(0, 10) })),
    email: e ? {
      domain: e.domain, host: e.host, spf: e.spf.records, spf_lookups: e.spf.lookups, dmarc: e.dmarc.records[0] || null, dmarc_domain: e.dmarc.domain,
      mx: e.mx.records.slice(0, 5).map(m => m.host), provider: e.provider?.name || null, dkim_selectors: e.dkim.selectors_found, senders: e.senders,
    } : null,
    security: { headers: Object.fromEntries(["strict-transport-security", "x-frame-options", "x-content-type-options", "content-security-policy", "referrer-policy", "permissions-policy"].map(h => [h, data.home.headers?.[h] ?? null])),
      tls: data.tls ? { valid_to: data.tls.valid_to, days_left: data.tls.days_left, issuer: data.tls.issuer, authorized: data.tls.authorized } : null, dnssec: data.dnssec?.signed ?? null },
    domain: data.rdap ? { registrar: data.rdap.registrar, created: data.rdap.created, expires: data.rdap.expires, days_left: data.rdap.days_left, age_years: data.rdap.age_years, nameservers: data.rdap.nameservers, status: data.rdap.status } : null,
    performance: data.psi?.mobile ? { mobile: { scores: data.psi.mobile.scores, lab: data.psi.mobile.lab, field: data.psi.mobile.field } } : null,
  };
}

/**
 * Homepage scan. Returns null when the site can't be opened. Shape (kept for period reports and emails):
 * { score, speed, passed, issues, top_issues, more_issues, details } plus checks / scores / findings / home.
 */
export async function runScan(hostname, env, opts = {}) {
  const data = await collectSite(hostname, env, opts);
  if (!data || data.unreachable) return null;
  const checks = runChecks(data, "scan");
  const scores = scoreChecks(checks);
  const findings = toFindings(checks);
  const issues = legacyIssues(findings);
  return {
    score: scores.overall,
    speed: data.psi.mobile?.scores.performance ?? null,
    passed: passedLabels(checks),
    issues,
    top_issues: issues.slice(0, 3),
    more_issues: Math.max(0, issues.length - 3),
    details: scanDetails(data, scores, findings),
    checks, scores, findings, home: data.home, sitemapUrls: data.sitemap.urls.length, data,
  };
}

/** Copy-paste fix for an issue: the catalogue's code for that check, using the stored finding when there is one. */
export function codeSnippet(issue, host, finding = null) {
  const f = finding || { check_id: issue.id, data: null, items: null, evidence: null };
  return presentFinding(f, { host, org: organizationalDomain(host) || host, origin: `https://${host}` }).code;
}
