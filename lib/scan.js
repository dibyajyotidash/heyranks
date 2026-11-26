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
/** An answer that settles whether a file exists: 2xx, or a 4xx other than 429. 5xx, 429 and no answer don't. */
const definite = s => (s >= 200 && s < 300) || (s >= 400 && s < 500 && s !== 429);
const DISALLOW_ALL = { groups: [{ agents: ["*"], rules: [{ allow: false, path: "/" }], crawlDelay: null }], sitemaps: [] };

/** A specific, customer-facing reason the homepage couldn't be read. */
export function unreachableMessage(host, home) {
  const s = home.status;
  if (s === 401 || s === 403) return `${host} refused our crawler (HTTP ${s}). If you use a firewall or bot protection (for example Cloudflare), allow the user agent "HeyRanksBot" and try again.`;
  if (s === 429) return `${host} asked us to slow down (HTTP 429). Please try again in a few minutes.`;
  if (s === 404 || s === 410) return `${host}'s homepage returned HTTP ${s} (not found).`;
  if (s >= 500) return `${host} returned a server error (HTTP ${s}). Check the site is up and try again.`;
  if (s >= 400) return `${host}'s homepage returned HTTP ${s}.`;
  const why = home.httpsError && home.httpsError !== home.error ? home.httpsError : home.error;
  if (why === "dns") return `${host} doesn't resolve in DNS. Check the address is spelled correctly.`;
  if (why === "private") return "That address points to a private network, which we don't scan.";
  if (why === "timeout") return `${host} didn't respond within 10 seconds. Check the site is online and try again.`;
  if (why === "refused") return `${host} refused the connection. Check the site is online and try again.`;
  return `We couldn't open ${host}. Check the site is online and try again.`;
}

/** Finds and reads the sitemap: robots.txt Sitemap: lines, then /sitemap.xml and /sitemap_index.xml. */
export async function discoverSitemap(origin, host, robotsParsed) {
  const candidates = [...new Set([...(robotsParsed?.sitemaps || []).map(s => normalizeUrl(s, origin)).filter(u => u && sameSite(u, host)).slice(0, 3),
    `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])];
  const out = { measured: false, found: false, valid: false, files: [], urls: [] };
  for (const url of candidates) {
    const r = await fetchPublic(url, 8000);
    if (definite(r.status)) out.measured = true; // a 2xx or a real "not there" means we could check; 5xx, 429 and timeouts don't
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

  // HTTPS first; if it can't connect, read the http:// site instead, remembering why HTTPS failed.
  const homeP = fetchPageRecord(`${origin}/`).then(async r => {
    if (r.status) return r;
    const plain = await fetchPageRecord(`http://${host}/`);
    return { ...(plain.status ? plain : r), httpsError: r.error };
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
  // A certificate browsers reject is a finding (critical), not "we couldn't open the site".
  const tlsBlocked = !home.status && home.httpsError === "tls";
  if (!tlsBlocked && (!home.status || home.status >= 400)) return { unreachable: true, home, message: unreachableMessage(host, home) };
  if (home.final_url?.startsWith("http://")) {
    origin = `http://${host}`;
    [robotsRes, llmsRes] = await Promise.all([fetchPublic(`${origin}/robots.txt`, 8000), fetchPublic(`${origin}/llms.txt`, 8000)]);
  }

  // robots.txt: 2xx = rules; other 4xx = no rules (allow all); 5xx = Google treats it as "don't crawl", and so do we;
  // 429 / no answer = not measured.
  const robotsFound = robotsRes.ok && !/<html/i.test(robotsRes.text.slice(0, 500));
  const robotsServerError = robotsRes.status >= 500;
  const robotsParsed = robotsFound ? parseRobots(robotsRes.text) : null;
  const robots = { measured: definite(robotsRes.status) || robotsServerError, found: robotsFound, serverError: robotsServerError, status: robotsRes.status,
    parsed: robotsParsed, crawlRules: robotsServerError ? DISALLOW_ALL : robotsParsed, text: robotsFound ? robotsRes.text.slice(0, 4000) : null };
  const sitemap = await discoverSitemap(origin, host, robots.parsed);
  const dnssec = org ? await dnssecSigned(org, rdap, opts.dns ? { dns: opts.dns } : {}) : null;
  // http:// -> https://: judged by where the first redirect points, so a slow HTTPS hop afterwards doesn't count against it.
  const hops = [...httpRes.chain.map(c => c.url), httpRes.finalUrl];
  const firstRedirect = httpRes.chain[0]?.status >= 300 && httpRes.chain[0]?.status < 400;
  const toHttps = firstRedirect && hops.slice(1).some(u => u?.startsWith("https://") && sameSite(u, host));
  const finalHttp = httpRes.chain.at(-1)?.url || null;

  return {
    host, org, origin,
    home: { ...home, isHome: true },
    pages: [{ ...home, isHome: true, depth: 0 }],
    robots, sitemap,
    llms: { measured: definite(llmsRes.status), found: llmsRes.ok && llmsRes.text.trim().length > 20 && !/<html/i.test(llmsRes.text.slice(0, 500)) },
    httpRedirect: { measured: httpRes.chain.length > 0, toHttps: !!toHttps, final: toHttps ? hops.find((u, i) => i > 0 && u?.startsWith("https://")) : finalHttp, chain: httpRes.chain },
    email, rdap, dnssec, tls,
    psi: { mobile: psiMobile?.result || null, desktop: psiDesktop?.result || null, error: psiMobile?.error || null, detail: psiMobile?.detail || null },
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
 * Homepage scan. Returns { unreachable: true, message } when the site can't be opened; otherwise (shape kept for period reports and emails):
 * { score, speed, passed, issues, top_issues, more_issues, details } plus checks / scores / findings / home.
 */
export async function runScan(hostname, env, opts = {}) {
  const data = await collectSite(hostname, env, opts);
  if (!data) return { unreachable: true, message: unreachableMessage(hostname, { status: 0, error: "private" }) };
  if (data.unreachable) return { unreachable: true, message: data.message };
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
