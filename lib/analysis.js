/**
 * Turns collected evidence into check results, findings and scores. Pure: no network, no database.
 *
 * Scoring (score_version 2), documented on the report's Methodology section:
 *   - Every check is pass / warn / fail / na. "na" (not measured) is left out of the maths entirely.
 *   - Site-level checks earn all or nothing (warn = half). Page-level checks earn points in proportion to
 *     the share of pages that pass, so 1 bad page out of 40 costs little and 40 out of 40 costs everything.
 *   - Category score = earned / possible points of its measured checks. Overall = category scores weighted
 *     by CATEGORIES[].weight, over categories with at least one measured check.
 *   - Any critical problem caps the overall score at 59, so an average can't hide an outage-level issue.
 *   - Each underlying problem belongs to exactly one check in one category (no double penalties).
 *   - Coverage = share of check weight that was actually measured.
 */
import { CHECKS, CATEGORIES, SEVERITY_RANK, SEVERITIES } from "./catalog.js";
import { robotsAllows, similarity, sameSite } from "./crawler.js";

export const SCORE_VERSION = 2;
export const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "Google-Extended", "PerplexityBot"];
const CRITICAL_CAP = 59;
const UTILITY_PATH = /\/(contact|privacy|terms|legal|cookie|login|log-in|signin|sign-in|register|signup|cart|basket|checkout|thank|404|search|tag|tags|category|author|feed|sitemap|policy|account)(\/|$|[-.?])/i;

// Checks a homepage-only scan doesn't run (they need a crawl). They don't count against its coverage.
const AUDIT_ONLY = new Set(["sitemap_errors", "noindex_pages", "canonical_conflict", "broken_links", "server_errors", "redirect_chains",
  "duplicate_titles", "duplicate_descriptions", "duplicate_content", "orphan_pages", "url_structure", "deep_pages", "broken_external",
  "cannibalization", "stale_content", "a11y_score", "kw_striking", "kw_gap", "competitor_gap", "ai_visibility_gap"]);

const pct = n => `${Math.round(n * 100)}%`;
const lowerSeverity = s => SEVERITIES[Math.min(SEVERITY_RANK[s] + 1, SEVERITIES.length - 2)];

/**
 * One check result. `findingId` lets a check report under a more specific catalogue entry (spf ->
 * spf_multiple) while still scoring as the parent check, so its category isn't penalised twice.
 */
function result(id, status, x = {}, findingId = null) {
  const def = CHECKS[id];
  const credit = x.credit ?? (status === "pass" ? 1 : status === "warn" ? 0.5 : 0);
  const child = findingId ? CHECKS[findingId] : null;
  return {
    id, category: def.category, weight: def.weight, status, credit: Math.max(0, Math.min(1, credit)),
    severity: x.severity ?? child?.severity ?? def.severity, title: x.title ?? child?.title ?? def.title, subject: x.subject ?? null,
    evidence: x.evidence ?? null, items: x.items ?? null, data: x.data ?? null, finding_id: findingId,
  };
}
const na = (id, why) => result(id, "na", { evidence: { detected: why } });

/** Page-level check. test(page, record) returns null when the page is fine, else { actual, ...extra }. */
function pageCheck(id, records, test, { expected, minPages = 1, severityFor } = {}) {
  if (records.length < minPages) return na(id, "Not enough pages to check.");
  const items = [];
  for (const r of records) {
    const bad = test(r.page, r);
    if (bad) items.push({ url: r.final_url || r.url, ...bad });
  }
  if (!items.length) return result(id, "pass", { evidence: { detected: `All ${records.length} page${records.length === 1 ? "" : "s"} pass.`, expected } });
  const share = items.length / records.length;
  const homeAffected = items.some(i => i.home);
  let severity = severityFor ? severityFor(items, share) : CHECKS[id].severity;
  if (!severityFor && share < 0.2 && !homeAffected && SEVERITY_RANK[severity] <= SEVERITY_RANK.medium) severity = lowerSeverity(severity);
  return result(id, share <= 0.2 ? "warn" : "fail", {
    credit: 1 - share, severity,
    evidence: { detected: records.length === 1 ? `${records[0].isHome ? "Homepage" : "Page"}: ${items[0].actual}.` : `${items.length} of ${records.length} pages affected (${pct(share)}).`, expected, actual: items[0].actual },
    items: items.slice(0, 50),
    data: { affected: items.length, checked: records.length },
  });
}

function mergedSpf(records) {
  const terms = new Set(); let all = "~all";
  for (const r of records) for (const t of r.trim().split(/\s+/).slice(1)) {
    if (/^[+\-~?]?all$/i.test(t)) { if (t.toLowerCase() === "-all") all = "-all"; continue; }
    terms.add(t);
  }
  return `v=spf1 ${[...terms].join(" ")} ${all}`.replace(/\s+/g, " ");
}

// ─── checks ───────────────────────────────────────────────────────────────────

function securityChecks(d, out) {
  const home = d.home;
  // HTTPS that fails certificate validation is reported once, as a certificate problem (not "no HTTPS").
  const tlsFailed = home.httpsError === "tls";
  const https = !tlsFailed && home.status > 0 && home.final_url?.startsWith("https://");
  if (tlsFailed) out.push(result("https", "fail", { severity: "critical", title: "HTTPS fails: browsers don't trust the certificate",
    evidence: { detected: `Connecting to https://${d.host}/ failed certificate validation${d.tls?.error ? ` (${d.tls.error})` : ""}.`,
      expected: "A valid certificate from a trusted authority, covering this host", source: "tls",
      actual: d.tls ? `Issuer: ${d.tls.issuer || "unknown"}; subject: ${d.tls.subject || "unknown"}; valid until ${d.tls.valid_to?.slice(0, 10) || "unknown"}` : "TLS handshake rejected" } }, "tls_cert"));
  else out.push(https ? result("https", "pass", { evidence: { detected: `Homepage served at ${home.final_url}`, source: "crawl" } })
    : result("https", "fail", { evidence: { detected: `The homepage loads at ${home.final_url} (not HTTPS).`, expected: "https://", actual: home.final_url, source: "crawl" } }));

  if (!https && !tlsFailed) out.push(na("http_redirect", "Covered by the HTTPS check."));
  else if (!d.httpRedirect?.measured) out.push(na("http_redirect", "Couldn't request the http:// version."));
  else out.push(d.httpRedirect.toHttps
    ? result("http_redirect", "pass", { evidence: { detected: `http:// redirects to ${d.httpRedirect.final}` } })
    : result("http_redirect", "fail", { evidence: { detected: `http://${d.host}/ ends at ${d.httpRedirect.final || "an error"}.`, expected: "A 301 redirect to https://", actual: (d.httpRedirect.chain || []).map(c => `${c.status} ${c.url}`).join(" → ") } }));

  const t = d.tls;
  if (!https || tlsFailed) out.push(na("tls_cert", "Covered by the HTTPS check."));
  else if (!t) out.push(na("tls_cert", "The certificate couldn't be inspected from our server."));
  else if (!t.authorized) out.push(result("tls_cert", "fail", { severity: "critical", title: "Browsers don't trust the SSL/TLS certificate", evidence: { detected: `Certificate validation failed: ${t.error}`, expected: "A certificate from a trusted authority covering this host", actual: `Issuer: ${t.issuer || "unknown"}, subject: ${t.subject || "unknown"}`, source: "tls" } }));
  else if (t.days_left !== null && t.days_left < 14) out.push(result("tls_cert", "fail", { severity: t.days_left < 7 ? "critical" : "high", title: t.days_left < 0 ? "The SSL/TLS certificate has expired" : `SSL/TLS certificate expires in ${t.days_left} days`, evidence: { detected: `Valid until ${t.valid_to}`, expected: "Renewed automatically at least 2 weeks before expiry", actual: `${t.days_left} days left (issuer ${t.issuer})`, source: "tls" } }));
  else out.push(result("tls_cert", "pass", { evidence: { detected: `Valid until ${t.valid_to?.slice(0, 10)} (${t.days_left} days), issuer ${t.issuer}`, source: "tls" } }));

  const pages = d.pages.filter(r => r.page && (r.final_url || "").startsWith("https://"));
  out.push(pageCheck("mixed_content", pages, (p, r) => (p.mixed.active.length || p.mixed.passive.length)
    ? { actual: `${p.mixed.active.length} blocked, ${p.mixed.passive.length} flagged`, files: [...p.mixed.active, ...p.mixed.passive].slice(0, 5), active: p.mixed.active.length > 0, home: r.isHome } : null,
  { expected: "Every image, script and stylesheet loaded over https://", severityFor: items => (items.some(i => i.active) ? "high" : "medium") }));

  const h = home.headers || {};
  if (!https) { for (const id of ["hsts", "x_frame", "x_cto", "csp"]) out.push(na(id, "Security headers only apply over HTTPS.")); }
  else {
    const hsts = h["strict-transport-security"];
    out.push(hsts && /max-age=\s*[1-9]/i.test(hsts) ? result("hsts", "pass", { evidence: { detected: hsts } })
      : result("hsts", "fail", { evidence: { detected: hsts ? `Header present but max-age is 0: ${hsts}` : "No Strict-Transport-Security header on the homepage.", expected: "Strict-Transport-Security: max-age=31536000", actual: hsts || "missing", source: "headers" } }));
    const csp = h["content-security-policy"] || "";
    const xfo = h["x-frame-options"];
    out.push(xfo || /frame-ancestors/i.test(csp) ? result("x_frame", "pass", { evidence: { detected: xfo ? `X-Frame-Options: ${xfo}` : "CSP frame-ancestors" } })
      : result("x_frame", "fail", { evidence: { detected: "Neither X-Frame-Options nor CSP frame-ancestors is set.", expected: "X-Frame-Options: SAMEORIGIN", actual: "missing", source: "headers" } }));
    out.push(/nosniff/i.test(h["x-content-type-options"] || "") ? result("x_cto", "pass", { evidence: { detected: "X-Content-Type-Options: nosniff" } })
      : result("x_cto", "fail", { evidence: { detected: "X-Content-Type-Options is missing.", expected: "nosniff", actual: h["x-content-type-options"] || "missing", source: "headers" } }));
    out.push(csp ? result("csp", "pass", { evidence: { detected: `Content-Security-Policy: ${csp.slice(0, 120)}` } })
      : h["content-security-policy-report-only"] ? result("csp", "warn", { evidence: { detected: "Only a report-only policy is set (not enforced).", expected: "An enforcing Content-Security-Policy", actual: "Content-Security-Policy-Report-Only", source: "headers" } })
      : result("csp", "fail", { evidence: { detected: "No Content-Security-Policy header.", expected: "A Content-Security-Policy header", actual: "missing", source: "headers" } }));
  }

  const ds = d.dnssec;
  if (!d.org) out.push(na("dnssec", "Not a domain name."));
  else if (!ds || ds.signed === null) out.push(na("dnssec", "DNSSEC status couldn't be checked."));
  else out.push(ds.signed ? result("dnssec", "pass", { evidence: { detected: `DS record published for ${d.org} (${ds.source}).` } })
    : result("dnssec", "fail", { evidence: { detected: `No DS record for ${d.org}.`, expected: "DNSSEC enabled", actual: "not signed", source: ds.source } }));
}

function emailChecks(d, out) {
  const e = d.email;
  const ids = ["spf", "dmarc"];
  if (!e) { for (const id of ids) out.push(na(id, "Email checks need a domain name.")); return; }
  const base = { subject: e.domain, source: "dns" };
  const spf = e.spf;
  const mxCount = e.mx.records.length;
  const providerData = { provider: e.provider, mx_count: mxCount };
  const dmarcEnforced = ["quarantine", "reject"].includes(e.dmarc.parsed?.policy);
  if (!spf.measured) out.push(na("spf", `DNS lookup for ${e.domain} failed; SPF not measured.`));
  else if (!spf.records.length && spf.subdomains?.length) out.push(result("spf", "warn", { ...base, severity: dmarcEnforced ? "low" : "medium", data: { ...providerData, subdomains: spf.subdomains },
    evidence: { detected: `${e.domain} itself has no SPF record, but mail is sent from ${spf.subdomains.map(s => s.name).join(", ")}, which has SPF (${spf.subdomains[0].record}).`,
      expected: `SPF on every domain used as a sender, and v=spf1 -all on ${e.domain} if it never sends`, actual: `none on ${e.domain}`, source: "dns" } }, "spf_root"));
  else if (!spf.records.length) out.push(result("spf", "fail", { ...base, data: providerData,
    evidence: { detected: `No TXT record starting with v=spf1 on ${e.domain}${e.host !== e.domain ? ` (your email domain; ${e.host} is only the web address)` : ""}.${dmarcEnforced && !e.dkim.selectors_found.length ? ` Your DMARC policy is p=${e.dmarc.parsed.policy}, so your own mail can be sent to spam unless it passes DKIM.` : ""}`, expected: "Exactly one SPF record", actual: "none", source: "dns" } }));
  else if (spf.records.length > 1) out.push(result("spf", "fail", { ...base, title: CHECKS.spf_multiple.title, data: { records: spf.records, merged: mergedSpf(spf.records) },
    evidence: { detected: `${spf.records.length} SPF records on ${e.domain}.`, expected: "Exactly one SPF record", actual: spf.records.join("  |  "), source: "dns" } }, "spf_multiple"));
  else {
    const p = spf.parsed, record = spf.records[0];
    if (p.errors.length) out.push(result("spf", "fail", { ...base, title: CHECKS.spf_syntax.title, data: { record }, evidence: { detected: p.errors.join(" "), expected: "Valid SPF syntax", actual: record, source: "dns" } }, "spf_syntax"));
    else if (p.all === "+") out.push(result("spf", "fail", { ...base, severity: "critical", title: CHECKS.spf_permissive.title, data: { record }, evidence: { detected: `The record ends in ${p.mechanisms.find(m => m.type === "all")?.raw}.`, expected: "~all or -all", actual: record, source: "dns" } }, "spf_permissive"));
    else if (spf.lookups > 10) out.push(result("spf", "fail", { ...base, title: CHECKS.spf_lookups.title, data: { record, lookups: spf.lookups, tree: spf.tree }, evidence: { detected: `${spf.lookups} DNS lookups needed (limit 10).`, expected: "≤ 10 lookups", actual: String(spf.lookups), source: "dns" } }, "spf_lookups"));
    else if (!p.all && !p.redirect || p.all === "?") out.push(result("spf", "warn", { ...base, severity: "medium", title: "SPF record doesn't tell receivers to reject other senders", data: { record },
      evidence: { detected: p.all === "?" ? "The record ends in ?all (neutral)." : "The record has no 'all' ending.", expected: "~all or -all", actual: record, source: "dns" } }, "spf_permissive"));
    else if (spf.problems?.length) {
      // A target with no (or several) SPF records, or nesting too deep, is a permanent error for receivers; a repeat is only wasteful.
      const permerror = spf.problems.some(x => !/included more than once/.test(x));
      out.push(result("spf", permerror ? "fail" : "warn", { ...base, severity: permerror ? "high" : "low", title: permerror ? CHECKS.spf_include.title : "An SPF include is repeated", data: { record, problems: spf.problems, tree: spf.tree },
        evidence: { detected: spf.problems.join(" "), expected: "Every include: and redirect= target publishes exactly one SPF record, once", actual: record, source: "dns" } }, "spf_include"));
    }
    else out.push(result("spf", "pass", { ...base, evidence: { detected: `${record} (${spf.lookups} lookup${spf.lookups === 1 ? "" : "s"})` } }));

    if (e.provider?.via === "mx" && !spf.includes.includes(e.provider.include) && !p.errors.length) {
      const suggested = record.replace(/\s+([+\-~?]?all)\s*$/i, ` include:${e.provider.include} $1`);
      out.push(result("spf_provider_missing", "warn", { ...base, data: { provider: e.provider, record, suggested: suggested === record ? `${record} include:${e.provider.include}` : suggested },
        evidence: { detected: `MX records point to ${e.provider.name} (${e.provider.evidence}), but SPF has no include:${e.provider.include}.`, expected: `include:${e.provider.include}`, actual: record, source: "dns" } }));
    }
  }

  const dm = e.dmarc;
  if (!dm.measured) out.push(na("dmarc", "DNS lookup for _dmarc failed; DMARC not measured."));
  else if (!dm.records.length && dm.host_record) out.push(result("dmarc", "fail", { ...base, title: `DMARC record is on ${dm.host_domain}, not on your email domain ${e.domain}`, data: { host_record: dm.host_record, host_domain: dm.host_domain },
    evidence: { detected: `A DMARC record exists at _dmarc.${dm.host_domain}, but mail from @${e.domain} is governed by _dmarc.${e.domain}, which has none.`,
      expected: `A v=DMARC1 record at _dmarc.${e.domain}`, actual: `only at _dmarc.${dm.host_domain}: ${dm.host_record}`, source: "dns" } }, "dmarc_misplaced"));
  else if (!dm.records.length) out.push(result("dmarc", "fail", { ...base, evidence: { detected: `No DMARC record at _dmarc.${e.domain}.`, expected: "v=DMARC1; p=quarantine (or reject)", actual: "none", source: "dns" } }));
  else if (dm.records.length > 1 || dm.parsed?.errors.length) out.push(result("dmarc", "fail", { ...base, title: CHECKS.dmarc_invalid.title, data: { domain: dm.domain, records: dm.records },
    evidence: { detected: dm.records.length > 1 ? `${dm.records.length} DMARC records at _dmarc.${dm.domain}.` : dm.parsed.errors.join(" "), expected: "One valid v=DMARC1 record", actual: dm.records.join("  |  "), source: "dns" } }, "dmarc_invalid"));
  else if (dm.parsed.policy === "none") out.push(result("dmarc", "warn", { ...base, title: CHECKS.dmarc_policy.title, data: { domain: dm.domain, record: dm.records[0] },
    evidence: { detected: `p=none at _dmarc.${dm.domain}.`, expected: "p=quarantine or p=reject", actual: dm.records[0], source: "dns" } }, "dmarc_policy"));
  else out.push(result("dmarc", "pass", { ...base, evidence: { detected: `p=${dm.parsed.policy}${dm.parsed.pct < 100 ? ` (applied to ${dm.parsed.pct}% of mail)` : ""} at _dmarc.${dm.domain}` } }));

  if (e.dkim.measured && !e.dkim.selectors_found.length) out.push(result("dkim_unverified", "warn", { ...base, data: { provider: e.provider },
    evidence: { detected: `No DKIM key at the ${e.dkim.selectors_probed.length} common selectors we tested (${e.dkim.selectors_probed.slice(0, 6).join(", ")}…).`, expected: "A DKIM key for your provider's selector", actual: "not found at tested selectors", source: "dns" } }));
  if (e.mx.measured && !mxCount) out.push(result("mx_missing", "warn", { ...base, evidence: { detected: `No MX records on ${e.domain}.`, source: "dns" } }));
}

function domainChecks(d, out) {
  const r = d.rdap;
  if (!r || r.days_left === null) return; // RDAP unavailable for some TLDs: no alert rather than a guess
  const days = r.days_left;
  if (days > 60) { out.push(result("domain_expiry", "pass", { subject: r.domain, evidence: { detected: `Registered until ${r.expires.slice(0, 10)} (${days} days).`, source: "rdap" } })); return; }
  out.push(result("domain_expiry", "fail", { subject: r.domain, severity: days <= 14 ? "critical" : days <= 30 ? "high" : "medium",
    title: days <= 0 ? `The domain ${r.domain} has expired` : `The domain ${r.domain} expires in ${days} days`, data: { registrar: r.registrar },
    evidence: { detected: `Registry expiry date ${r.expires.slice(0, 10)}.`, expected: "More than 60 days left, auto-renew on", actual: `${days} days left`, source: "rdap" } }));
}

function technicalChecks(d, out, audit) {
  const home = d.home, hp = home.page;
  const rb = d.robots;
  if (!rb?.measured) { out.push(na("robots_missing", "robots.txt couldn't be fetched.")); out.push(na("robots_blocked", "robots.txt couldn't be fetched.")); }
  else if (rb.serverError) {
    out.push(na("robots_missing", `robots.txt returned a server error (HTTP ${rb.status}).`));
    out.push(result("robots_blocked", "fail", { severity: "high", title: "robots.txt returns a server error, so search engines may stop crawling",
      evidence: { detected: `https://${d.host}/robots.txt returned HTTP ${rb.status}. Google treats a robots.txt that fails with a 5xx error as "don't crawl anything" until it loads again.`,
        expected: "HTTP 200 (or 404 if you have no rules)", actual: `HTTP ${rb.status}`, source: "crawl" } }));
  }
  else if (!rb.found) { out.push(result("robots_missing", "fail", { evidence: { detected: `https://${d.host}/robots.txt returned ${rb.status || "an error"}.`, expected: "A robots.txt file", actual: String(rb.status), source: "crawl" } })); out.push(result("robots_blocked", "pass", { evidence: { detected: "No robots.txt, so nothing is blocked." } })); }
  else {
    out.push(result("robots_missing", "pass", { evidence: { detected: "robots.txt found." } }));
    const google = robotsAllows(rb.parsed, "Googlebot", "/"), others = robotsAllows(rb.parsed, "heyranks-any-crawler", "/");
    out.push(!google ? result("robots_blocked", "fail", { evidence: { detected: `robots.txt disallows "/" for Googlebot${others ? "" : " and all other crawlers"}.`, expected: "Allow: / for Googlebot", actual: "Disallow: /", source: "robots.txt" } })
      : !others ? result("robots_blocked", "warn", { severity: "high", title: "robots.txt blocks every crawler except Googlebot", evidence: { detected: "The 'User-agent: *' group disallows \"/\"; Googlebot has its own group that allows crawling.", expected: "Bing and other search engines allowed too", actual: "Disallow: / for *", source: "robots.txt" } })
      : result("robots_blocked", "pass", { evidence: { detected: "Googlebot and other crawlers may crawl the homepage." } }));
  }

  const sm = d.sitemap;
  if (!sm?.measured) out.push(na("sitemap", "Sitemap couldn't be fetched."));
  else out.push(sm.valid ? result("sitemap", "pass", { evidence: { detected: `${sm.files.length} sitemap file${sm.files.length === 1 ? "" : "s"}, ${sm.urls.length} URL${sm.urls.length === 1 ? "" : "s"} (${sm.files[0]}).` } })
    : result("sitemap", "fail", { evidence: { detected: sm.found ? "A sitemap URL responded but isn't valid sitemap XML." : "No sitemap at /sitemap.xml, /sitemap_index.xml or in robots.txt.", expected: "A valid XML sitemap", actual: sm.found ? "invalid" : "missing", source: "crawl" } }));

  const headerNoindex = /noindex|none/i.test(home.headers?.["x-robots-tag"] || "");
  if (!hp && !headerNoindex) out.push(na("noindex_home", "The homepage HTML couldn't be read."));
  else out.push(hp?.noindex || headerNoindex
    ? result("noindex_home", "fail", { evidence: { detected: headerNoindex ? `X-Robots-Tag header: ${home.headers["x-robots-tag"]}` : `<meta name="robots" content="${hp.robots}">`, expected: "index (no noindex)", actual: "noindex", source: "crawl" } })
    : result("noindex_home", "pass", { evidence: { detected: "Homepage is indexable." } }));

  const html = d.pages.filter(r => r.page && r.status === 200);
  const indexable = html.filter(r => !r.page.noindex);
  out.push(pageCheck("canonical", indexable, p => (p.canonical ? null : { actual: "no canonical tag" }), { expected: '<link rel="canonical"> on every page' }));

  if (!audit) return;
  const byUrl = new Map();
  for (const r of d.pages) { byUrl.set(r.url, r); if (r.final_url) byUrl.set(r.final_url, r); }
  for (const l of d.links?.internal || []) if (!byUrl.has(l.url)) byUrl.set(l.url, l);

  // A broken page that is also linked internally is reported once, under broken links / server errors.
  const inbound = d.inbound || new Map();
  const linkedBroken = url => (inbound.get(url) || []).length > 0 && (byUrl.get(url)?.status >= 400 || byUrl.get(url)?.status === 0);
  const smChecks = (d.sitemapChecks || []).filter(s => !linkedBroken(s.url));
  if (!d.sitemapChecks?.length) out.push(na("sitemap_errors", "No sitemap URLs were checked."));
  else out.push(pageCheck("sitemap_errors", smChecks.map(s => ({ ...s, page: {} })), (p, s) => {
    if (!s.status || s.status >= 400) return { actual: s.status ? `HTTP ${s.status}` : "no response" };
    if (s.redirects > 0) return { actual: `redirects to ${s.final_url}` };
    if (s.noindex) return { actual: "noindex" };
    return null;
  }, { expected: "Every sitemap URL returns 200 and is indexable" }));

  const noidx = html.filter(r => r.page.noindex && !r.isHome);
  if (noidx.length) out.push(result("noindex_pages", "warn", { items: noidx.slice(0, 50).map(r => ({ url: r.final_url, actual: r.page.robots })), evidence: { detected: `${noidx.length} page${noidx.length === 1 ? "" : "s"} marked noindex.`, source: "crawl" } }));

  out.push(pageCheck("canonical_conflict", indexable, (p, r) => {
    if (!p.canonical) return null;
    if (!sameSite(p.canonical, d.host)) return { actual: `points to another domain: ${p.canonical}`, home: r.isHome };
    if (r.final_url.startsWith("https://") && p.canonical.startsWith("http://")) return { actual: `points to http://: ${p.canonical}`, home: r.isHome };
    const target = byUrl.get(p.canonical);
    if (target && target.status && (target.status >= 400 || (target.redirects || 0) > 0)) return { actual: `points to ${p.canonical} (${target.status >= 400 ? `HTTP ${target.status}` : "a redirect"})`, home: r.isHome };
    if (r.isHome && new URL(p.canonical).pathname !== new URL(r.final_url).pathname) return { actual: `homepage canonical is ${p.canonical}`, home: true };
    return null;
  }, { expected: "Each page's canonical is its own final URL" }));

  // Broken links / errors / chains: link targets (crawled pages and HEAD-checked URLs) that some page links to.
  const targets = [...new Map([...d.pages, ...(d.links?.internal || [])].map(t => [t.url, t])).values()]
    .filter(t => (inbound.get(t.url) || []).length || t.url === d.home.url);
  const broken = targets.filter(t => t.status >= 400 && t.status < 500 && t.status !== 401 && t.status !== 403 && t.status !== 429);
  out.push(broken.length
    ? result("broken_links", broken.length >= 5 || broken.some(t => (inbound.get(t.url) || []).includes(d.home.final_url)) ? "fail" : "warn", {
      credit: Math.max(0, 1 - broken.length / Math.max(10, targets.length)),
      severity: broken.length >= 5 || broken.some(t => (inbound.get(t.url) || []).includes(d.home.final_url)) ? "high" : "medium",
      items: broken.slice(0, 50).map(t => ({ url: t.url, actual: `HTTP ${t.status}`, from: (inbound.get(t.url) || []).slice(0, 5) })),
      evidence: { detected: `${broken.length} internal URL${broken.length === 1 ? "" : "s"} return${broken.length === 1 ? "s" : ""} an error (of ${targets.length} checked).`, expected: "200 OK", actual: `HTTP ${broken[0].status}`, source: "crawl" } })
    : result("broken_links", "pass", { evidence: { detected: `${targets.length} internal URLs checked, none broken.` } }));

  // Only failures that mean "the server didn't serve the page": not certificate, DNS or private-address errors (reported elsewhere).
  const errors = targets.filter(t => t.status >= 500 || (t.status === 0 && ["timeout", "refused", "network"].includes(t.error)));
  out.push(errors.length
    ? result("server_errors", "fail", { credit: Math.max(0, 1 - errors.length / Math.max(10, targets.length)), items: errors.slice(0, 50).map(t => ({ url: t.url, actual: t.status ? `HTTP ${t.status}` : t.error, from: (inbound.get(t.url) || []).slice(0, 3) })),
      evidence: { detected: `${errors.length} URL${errors.length === 1 ? "" : "s"} failed with a server error or timeout.`, expected: "200 OK", source: "crawl" } })
    : result("server_errors", "pass", { evidence: { detected: "No server errors or timeouts." } }));

  const chains = targets.filter(t => (t.redirects || 0) >= 2);
  out.push(chains.length
    ? result("redirect_chains", "warn", { credit: Math.max(0, 1 - chains.length / Math.max(10, targets.length)), items: chains.slice(0, 50).map(t => ({ url: t.url, actual: (t.chain || []).map(c => `${c.url} (${c.status})`).join(" → ") })),
      evidence: { detected: `${chains.length} internal URL${chains.length === 1 ? "" : "s"} redirect 2+ times.`, expected: "At most one redirect", source: "crawl" } })
    : result("redirect_chains", "pass", { evidence: { detected: "No redirect chains." } }));

  const dupGroups = (key, records) => {
    const g = new Map();
    for (const r of records) { const k = key(r.page); if (k) g.set(k, [...(g.get(k) || []), r]); }
    return [...g.values()].filter(x => x.length > 1);
  };
  const dupCheck = (id, key, label) => {
    if (indexable.length < 2) return out.push(na(id, "Needs at least two indexable pages."));
    const groups = dupGroups(key, indexable);
    const affected = groups.flat();
    out.push(groups.length
      ? result(id, affected.length / indexable.length <= 0.2 ? "warn" : "fail", { credit: 1 - affected.length / indexable.length,
        items: affected.slice(0, 50).map(r => ({ url: r.final_url, actual: `${label}: "${(key(r.page) || "").slice(0, 90)}"` })),
        evidence: { detected: `${groups.length} group${groups.length === 1 ? "" : "s"} of pages share a ${label.toLowerCase()} (${affected.length} pages).`, expected: `A unique ${label.toLowerCase()} per page`, source: "crawl" } })
      : result(id, "pass", { evidence: { detected: `${indexable.length} pages, all unique.` } }));
  };
  dupCheck("duplicate_titles", p => p.title?.trim().toLowerCase() || null, "Title");
  dupCheck("duplicate_descriptions", p => p.description?.trim().toLowerCase() || null, "Description");

  const content = indexable.filter(r => r.page.words >= 50 && r.page.minhash);
  const clusters = [];
  for (let i = 0; i < content.length; i++) for (let j = i + 1; j < content.length; j++) {
    const a = content[i].page, b = content[j].page;
    const sim = a.text_hash === b.text_hash ? 1 : similarity(a.minhash, b.minhash);
    if (sim >= 0.9) clusters.push({ a: content[i].final_url, b: content[j].final_url, sim });
  }
  if (content.length < 2) out.push(na("duplicate_content", "Needs at least two pages with text."));
  else {
    const urls = new Set(clusters.flatMap(c => [c.a, c.b]));
    out.push(clusters.length ? result("duplicate_content", urls.size / content.length <= 0.2 ? "warn" : "fail", { credit: 1 - urls.size / content.length,
      items: clusters.slice(0, 50).map(c => ({ url: c.a, actual: `${Math.round(c.sim * 100)}% the same as ${c.b}` })),
      evidence: { detected: `${clusters.length} pair${clusters.length === 1 ? "" : "s"} of pages with ≥90% identical text.`, expected: "Distinct content on every page", source: "crawl (MinHash estimate)" } })
      : result("duplicate_content", "pass", { evidence: { detected: `${content.length} pages compared, no duplicates.` } }));
  }

  if (!d.crawlComplete) out.push(na("orphan_pages", "The page limit was reached before every link was followed, so orphans can't be identified reliably."));
  else if (!sm?.urls?.length) out.push(na("orphan_pages", "No sitemap URLs to compare against."));
  else {
    // Match regardless of www / trailing slash, and through redirects we observed (sitemap URL -> final URL).
    const key = u => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname.replace(/\/+$/, "") || "/") + x.search; } catch { return u; } };
    const finalOf = new Map([...(d.links?.internal || []), ...(d.sitemapChecks || [])].filter(t => t.final_url).map(t => [t.url, t.final_url]));
    const linked = new Set(d.pages.flatMap(r => (r.page?.links.internal || []).flatMap(l => [key(l.url), key(finalOf.get(l.url) || l.url)])));
    const homeKey = key(d.home.final_url || d.home.url);
    const orphans = sm.urls.filter(u => sameSite(u, d.host) && !linked.has(key(u)) && !linked.has(key(finalOf.get(u) || u)) && key(u) !== homeKey && key(finalOf.get(u) || u) !== homeKey);
    out.push(orphans.length ? result("orphan_pages", "warn", { credit: Math.max(0, 1 - orphans.length / Math.max(10, sm.urls.length)), items: orphans.slice(0, 50).map(u => ({ url: u, actual: "in sitemap, no internal links found" })),
      evidence: { detected: `${orphans.length} sitemap URL${orphans.length === 1 ? " is" : "s are"} not linked from any crawled page.`, source: "crawl + sitemap" } })
      : result("orphan_pages", "pass", { evidence: { detected: "Every sitemap URL is linked from a crawled page." } }));
  }

  out.push(pageCheck("url_structure", html.filter(r => !r.isHome), (p, r) => {
    const u = new URL(r.final_url), probs = [];
    if (r.final_url.length > 115) probs.push(`${r.final_url.length} characters`);
    if (/[A-Z]/.test(u.pathname)) probs.push("upper-case letters");
    if (/_/.test(u.pathname)) probs.push("underscores");
    if ([...u.searchParams.keys()].length > 2) probs.push(`${[...u.searchParams.keys()].length} query parameters`);
    return probs.length ? { actual: probs.join(", ") } : null;
  }, { expected: "Short, lower-case, hyphenated paths" }));

  out.push(pageCheck("deep_pages", html, (p, r) => (r.depth > 3 ? { actual: `${r.depth} clicks from the homepage` } : null), { expected: "≤ 3 clicks from the homepage" }));

  const ext = d.links?.external || [];
  // 403 / 429 / timeouts are often bot protection, so only definite failures count: not found, gone, or a domain that doesn't exist.
  const extBroken = ext.filter(t => t.status === 404 || t.status === 410 || t.error === "dns");
  if (!ext.length) out.push(na("broken_external", "No outbound links were checked."));
  else out.push(extBroken.length ? result("broken_external", "warn", { credit: 1 - extBroken.length / ext.length,
    items: extBroken.slice(0, 50).map(t => ({ url: t.url, actual: t.status ? `HTTP ${t.status}` : "domain doesn't resolve", from: (inbound.get(t.url) || []).slice(0, 3) })),
    evidence: { detected: `${extBroken.length} of ${ext.length} outbound links checked are broken.`, expected: "Working links", source: "crawl" } })
    : result("broken_external", "pass", { evidence: { detected: `${ext.length} outbound links checked.` } }));

  const js = html.filter(r => r.page.words < 50 && r.page.scripts >= 8);
  if (js.length) out.push(result("js_rendered", "warn", { items: js.slice(0, 50).map(r => ({ url: r.final_url, actual: `${r.page.words} words in HTML, ${r.page.scripts} scripts` })), evidence: { detected: `${js.length} page${js.length === 1 ? "" : "s"} with almost no text in the HTML.`, source: "crawl" } }));
}

function onpageChecks(d, out) {
  const recs = d.pages.filter(r => r.page && r.status === 200 && !r.page.noindex);
  if (!recs.length) { for (const id of ["title", "desc", "h1", "heading_order", "img_alt"]) out.push(na(id, "No indexable HTML page was read.")); }
  else {
    out.push(pageCheck("title", recs, (p, r) => {
      const t = p.title || "";
      if (!t) return { actual: "missing", home: r.isHome };
      if (t.length < 10 || t.length > 65) return { actual: `"${t.slice(0, 80)}" (${t.length} characters)`, home: r.isHome };
      return null;
    }, { expected: "A unique title of 10–65 characters" }));
    out.push(pageCheck("desc", recs, (p, r) => {
      const t = p.description || "";
      if (!t) return { actual: "missing", home: r.isHome };
      if (t.length < 50 || t.length > 160) return { actual: `${t.length} characters`, home: r.isHome };
      return null;
    }, { expected: "A meta description of 50–160 characters" }));
    out.push(pageCheck("h1", recs, (p, r) => (p.h1.length === 1 ? null : { actual: p.h1.length ? `${p.h1.length} H1 headings` : "no H1", home: r.isHome }), { expected: "Exactly one <h1>" }));
    out.push(pageCheck("heading_order", recs, p => {
      for (let i = 1; i < p.headings.length; i++) if (p.headings[i].level - p.headings[i - 1].level > 1) return { actual: `H${p.headings[i - 1].level} → H${p.headings[i].level} ("${p.headings[i].text.slice(0, 50)}")` };
      return null;
    }, { expected: "No skipped heading levels" }));
    out.push(pageCheck("img_alt", recs.filter(r => r.page.images.total), (p, r) => (p.images.missing_alt_count ? { actual: `${p.images.missing_alt_count} of ${p.images.total} images`, examples: p.images.missing_alt.slice(0, 3), home: r.isHome } : null),
      { expected: "An alt attribute on every <img>" }));
  }
  const og = d.home.page?.og;
  if (!og) out.push(na("og", "Homepage not readable."));
  else out.push(og.title && og.image ? result("og", "pass", { evidence: { detected: `og:title "${og.title.slice(0, 60)}" with an image.` } })
    : og.title ? result("og", "warn", { evidence: { detected: "og:title is set but there's no og:image.", expected: "og:title, og:description, og:image", actual: "og:image missing", source: "crawl" } })
    : result("og", "fail", { evidence: { detected: "No og:title on the homepage.", expected: "og:title, og:description, og:image", actual: "missing", source: "crawl" } }));
}

function contentChecks(d, out, audit) {
  const recs = d.pages.filter(r => r.page && r.status === 200 && !r.page.noindex && !UTILITY_PATH.test(new URL(r.final_url).pathname));
  if (!recs.length) out.push(na("thin_content", "No content page was read."));
  else out.push(pageCheck("thin_content", recs, (p, r) => (p.words < 300 ? { actual: `${p.words} words`, home: r.isHome } : null), { expected: "At least 300 words of useful text" }));
  if (!audit) return;

  const tokens = s => new Set(String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2));
  const jac = (a, b) => { const i = [...a].filter(x => b.has(x)).length; return i / (a.size + b.size - i || 1); };
  const pairs = [];
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    const a = recs[i].page, b = recs[j].page;
    if (!a.title || !b.title || a.title.toLowerCase() === b.title.toLowerCase()) continue; // identical titles: duplicate_titles covers it
    const ta = tokens(a.title), tb = tokens(b.title);
    if (ta.size < 2 || tb.size < 2) continue;
    const sameH1 = a.h1[0] && a.h1[0].toLowerCase() === (b.h1[0] || "").toLowerCase();
    if (jac(ta, tb) >= 0.8 || sameH1) pairs.push({ url: recs[i].final_url, actual: `competes with ${recs[j].final_url} ("${a.title.slice(0, 50)}" / "${b.title.slice(0, 50)}")` });
  }
  if (recs.length < 2) out.push(na("cannibalization", "Needs at least two content pages."));
  else out.push(pairs.length ? result("cannibalization", "warn", { credit: Math.max(0, 1 - pairs.length / recs.length), items: pairs.slice(0, 50), evidence: { detected: `${pairs.length} pair${pairs.length === 1 ? "" : "s"} of pages with near-identical titles or H1s.`, source: "crawl" } })
    : result("cannibalization", "pass", { evidence: { detected: "No competing page pairs found." } }));

  const cutoff = Date.now() - 2 * 365 * 864e5;
  // Newest parseable date on the page; pages without one are never called stale.
  const latest = r => { const t = r.page.dates.map(x => Date.parse(x)).filter(Number.isFinite); return t.length ? Math.max(...t) : null; };
  const stale = recs.filter(r => r.page.dates.length && latest(r) !== null && latest(r) < cutoff);
  if (stale.length) out.push(result("stale_content", "warn", { items: stale.slice(0, 50).map(r => ({ url: r.final_url, actual: `last dated ${new Date(latest(r)).toISOString().slice(0, 10)}` })), evidence: { detected: `${stale.length} page${stale.length === 1 ? "" : "s"} dated more than 2 years ago.`, source: "page dates" } }));
}

function aiChecks(d, out) {
  const rb = d.robots;
  if (!rb?.measured) out.push(na("ai", "robots.txt couldn't be fetched."));
  else if (rb.serverError) out.push(na("ai", "robots.txt returned a server error (reported under Technical SEO)."));
  else {
    const blocked = rb.found ? AI_BOTS.filter(b => !robotsAllows(rb.parsed, b, "/")) : [];
    out.push(blocked.length ? result("ai", "fail", { severity: blocked.length >= 3 ? "high" : "medium", data: { blocked }, evidence: { detected: `robots.txt blocks: ${blocked.join(", ")}.`, expected: "AI crawlers allowed (unless you block them on purpose)", actual: `${blocked.length} of ${AI_BOTS.length} blocked`, source: "robots.txt" } })
      : result("ai", "pass", { evidence: { detected: `${AI_BOTS.join(", ")} may crawl the site.` } }));
  }
  const l = d.llms;
  if (!l?.measured) out.push(na("llms", "llms.txt couldn't be fetched."));
  else out.push(l.found ? result("llms", "pass", { evidence: { detected: "llms.txt found." } }) : result("llms", "fail", { evidence: { detected: `https://${d.host}/llms.txt not found.`, expected: "A Markdown llms.txt", actual: "missing", source: "crawl" } }));

  const ld = d.home.page?.jsonld;
  if (!ld) { out.push(na("schema", "Homepage not readable.")); return; }
  if (!ld.types.length) out.push(result("schema", "fail", { evidence: { detected: ld.errors.length ? `JSON-LD present but unreadable: ${ld.errors[0]}` : "No JSON-LD structured data on the homepage.", expected: "Organization / LocalBusiness JSON-LD", actual: ld.errors.length ? "invalid JSON" : "none", source: "crawl" } }));
  else {
    out.push(result("schema", "pass", { evidence: { detected: `Types: ${ld.types.slice(0, 8).join(", ")}` } }));
    const identity = /Organization|LocalBusiness|Corporation|Store|Restaurant|Dentist|Physician|Medical|Clinic|LegalService|Attorney|ProfessionalService|Business|Establishment|Hotel|School|NGO|Person|Brand/;
    out.push(ld.types.some(t => identity.test(t)) ? result("schema_identity", "pass", { evidence: { detected: ld.types.filter(t => identity.test(t)).join(", ") } })
      : result("schema_identity", "fail", { evidence: { detected: `Types found: ${ld.types.join(", ")}.`, expected: "Organization or LocalBusiness", actual: "no identity type", source: "crawl" } }));
  }
}

const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
function performanceChecks(d, out, audit) {
  const m = d.psi?.mobile;
  if (!m) { for (const id of ["perf_score", "lcp", "cls", "inp", "tbt"]) out.push(na(id, d.psi?.error || "Google PageSpeed Insights didn't return a result.")); return; }
  const s = m.scores.performance;
  if (s === null) out.push(na("perf_score", "No performance score returned."));
  else out.push(result("perf_score", s >= 90 ? "pass" : s >= 50 ? "warn" : "fail", { credit: s / 100, severity: s < 50 ? "high" : "medium", data: { opportunities: m.opportunities },
    evidence: { detected: `Lighthouse mobile performance ${s}/100 (lab test${m.lighthouse_version ? `, Lighthouse ${m.lighthouse_version}` : ""}).`, expected: "90+", actual: `${s}/100`, source: "PageSpeed Insights (lab)" } }));
  const metric = (id, field, lab, good, poor, fmt, unitLabel) => {
    const v = field ?? lab;
    if (v === null || v === undefined) return out.push(na(id, `${unitLabel} not available.`));
    const src = field !== null && field !== undefined ? `real Chrome users, 75th percentile (${m.field.source === "url" ? "this page" : "whole origin"})` : "Lighthouse lab test, mobile";
    out.push(result(id, v <= good ? "pass" : v <= poor ? "warn" : "fail", { evidence: { detected: `${unitLabel}: ${fmt(v)} (${src}).`, expected: `≤ ${fmt(good)}`, actual: fmt(v), source: field != null ? "Chrome UX Report (field)" : "Lighthouse (lab)" } }));
  };
  metric("lcp", m.field?.lcp_ms, m.lab.lcp_ms, 2500, 4000, fmtMs, "Largest Contentful Paint");
  metric("cls", m.field?.cls, m.lab.cls, 0.1, 0.25, v => v.toFixed(2), "Cumulative Layout Shift");
  if (m.field?.inp_ms == null) out.push(na("inp", "Not enough real-user data in the Chrome UX Report for INP."));
  else metric("inp", m.field.inp_ms, null, 200, 500, fmtMs, "Interaction to Next Paint");
  metric("tbt", null, m.lab.tbt_ms, 200, 600, fmtMs, "Total Blocking Time");
  if (audit) {
    const a = m.scores.accessibility;
    if (a === null || a === undefined) out.push(na("a11y_score", "Lighthouse accessibility score not returned."));
    else out.push(result("a11y_score", a >= 90 ? "pass" : a >= 70 ? "warn" : "fail", { credit: a / 100, data: { failures: m.a11y_failures },
      evidence: { detected: `Lighthouse accessibility ${a}/100 (automated checks only).`, expected: "90+", actual: `${a}/100`, source: "PageSpeed Insights (lab)" } }));
  }
}

function uxChecks(d, out) {
  const hp = d.home.page;
  if (!hp) { out.push(na("viewport", "Homepage not readable.")); out.push(na("lang", "Homepage not readable.")); return; }
  out.push(hp.viewport ? result("viewport", "pass", { evidence: { detected: "Viewport meta tag present." } }) : result("viewport", "fail", { evidence: { detected: "No <meta name=\"viewport\"> on the homepage.", expected: "width=device-width, initial-scale=1", actual: "missing", source: "crawl" } }));
  out.push(hp.lang ? result("lang", "pass", { evidence: { detected: `<html lang="${hp.lang}">` } }) : result("lang", "fail", { evidence: { detected: "<html> has no lang attribute.", expected: 'lang="en" (or your language)', actual: "missing", source: "crawl" } }));
  const withForms = d.pages.filter(r => r.page?.forms.fields);
  if (withForms.length) out.push(pageCheck("form_labels", withForms, p => (p.forms.unlabelled ? { actual: `${p.forms.unlabelled} of ${p.forms.fields} fields` } : null), { expected: "A label for every form field" }));
}

function conversionChecks(d, out) {
  const hp = d.home.page;
  if (!hp) { for (const id of ["cta", "contact_info", "trust_signals", "analytics", "privacy_link"]) out.push(na(id, "Homepage not readable.")); return; }
  const c = hp.conversion, any = f => d.pages.some(r => r.page && f(r.page));
  out.push(c.cta.length || c.phones || c.whatsapp || hp.forms.count ? result("cta", "pass", { evidence: { detected: c.cta.length ? `Calls to action: ${c.cta.slice(0, 3).map(t => `"${t}"`).join(", ")}` : "A form or phone link is on the homepage." } })
    : result("cta", "fail", { evidence: { detected: "No button or link with action wording, no form and no phone link on the homepage.", expected: "A clear primary action", actual: "none detected", source: "crawl (text only)" } }));
  out.push(c.phones || c.emails || c.whatsapp || c.contact_link ? result("contact_info", "pass", { evidence: { detected: [c.phones && "phone link", c.emails && "email link", c.whatsapp && "WhatsApp link", c.contact_link && "contact page link"].filter(Boolean).join(", ") } })
    : result("contact_info", "fail", { evidence: { detected: "No tel:, mailto:, WhatsApp or contact-page link on the homepage.", expected: "At least one way to get in touch", actual: "none detected", source: "crawl" } }));
  out.push(any(p => p.conversion.trust) ? result("trust_signals", "pass", { evidence: { detected: "Reviews, testimonials or similar proof found." } })
    : result("trust_signals", "fail", { evidence: { detected: "No testimonial/review wording or Review schema found.", expected: "Visible social proof", actual: "none detected", source: "crawl (text only)" } }));
  out.push(hp.analytics.length ? result("analytics", "pass", { evidence: { detected: hp.analytics.join(", ") } })
    : result("analytics", "fail", { evidence: { detected: "No common analytics script found in the homepage HTML.", expected: "An analytics tool", actual: "none detected", source: "crawl" } }));
  out.push(any(p => p.conversion.privacy_link) ? result("privacy_link", "pass", { evidence: { detected: "Privacy policy linked." } })
    : result("privacy_link", "fail", { evidence: { detected: "No link containing 'privacy' found.", expected: "A privacy policy link", actual: "none", source: "crawl" } }));
}

/** Opportunity findings from provider modules (never scored into health). */
function opportunityChecks(d, out) {
  const kw = d.modules?.keywords;
  if (kw?.status === "ok") {
    const striking = (kw.data.ranked || []).filter(k => k.position >= 11 && k.position <= 20).sort((a, b) => (b.volume || 0) - (a.volume || 0));
    if (striking.length) out.push(result("kw_striking", "warn", { items: striking.slice(0, 20).map(k => ({ url: k.url, keyword: k.keyword, actual: `"${k.keyword}" at #${k.position} (${k.volume ?? "?"} searches/mo)` })), evidence: { detected: `${striking.length} keywords rank 11–20.`, source: kw.source } }));
    const ranked = new Set((kw.data.ranked || []).map(k => k.keyword.toLowerCase()));
    const gaps = (kw.data.ideas || []).filter(k => !ranked.has(k.keyword.toLowerCase()) && (k.volume || 0) > 0).sort((a, b) => b.volume - a.volume);
    if (gaps.length) out.push(result("kw_gap", "warn", { items: gaps.slice(0, 20).map(k => ({ keyword: k.keyword, actual: `"${k.keyword}": ${k.volume} searches/mo${k.difficulty != null ? `, difficulty ${k.difficulty}` : ""}${k.intent ? `, ${k.intent}` : ""}` })), evidence: { detected: `${gaps.length} related keywords with search demand where you don't rank.`, source: kw.source } }));
  }
  const comp = d.modules?.competitors;
  if (comp?.status === "ok" && comp.data.sites?.length) {
    const mine = new Map((comp.data.self?.checks || []).map(c => [c.id, c.status]));
    const gaps = [];
    for (const [id, label] of Object.entries(comp.data.labels || {})) {
      if (mine.get(id) !== "fail") continue;
      const passing = comp.data.sites.filter(s => s.checks?.find(c => c.id === id)?.status === "pass").map(s => s.host);
      if (passing.length && passing.length >= comp.data.sites.length / 2) gaps.push({ actual: `${label}: ${passing.join(", ")} ${passing.length === 1 ? "has" : "have"} it, you don't.`, check: id });
    }
    if (gaps.length) out.push(result("competitor_gap", "warn", { items: gaps, evidence: { detected: `${gaps.length} basics most tracked competitors have and you don't.`, source: "HeyRanks scans of competitor homepages" } }));
  }
  const vis = d.modules?.ai_visibility;
  if (vis?.status === "ok" || vis?.status === "partial") {
    const missed = (vis.data.questions || []).filter(q => !q.brand_question && q.answered && q.mentions === 0);
    if (missed.length) out.push(result("ai_visibility_gap", "warn", { items: missed.slice(0, 20).map(q => ({ actual: `"${q.question}": not mentioned by ${q.answered} assistant${q.answered === 1 ? "" : "s"}${q.competitors_mentioned?.length ? `; competitors named: ${q.competitors_mentioned.join(", ")}` : ""}` })),
      evidence: { detected: `Not mentioned for ${missed.length} of ${(vis.data.questions || []).filter(q => !q.brand_question).length} questions.`, source: (vis.data.providers || []).map(p => `${p.provider} (${p.model})`).join(", ") } }));
  }
}

// ─── scoring ──────────────────────────────────────────────────────────────────

/** All check results for a scan ("scan") or a full audit ("audit"). */
export function runChecks(d, kind = "scan") {
  const audit = kind === "audit";
  const out = [];
  securityChecks(d, out); emailChecks(d, out); domainChecks(d, out); technicalChecks(d, out, audit);
  onpageChecks(d, out); contentChecks(d, out, audit); aiChecks(d, out); performanceChecks(d, out, audit);
  uxChecks(d, out); conversionChecks(d, out);
  if (audit) opportunityChecks(d, out);
  return out.filter(c => audit || !AUDIT_ONLY.has(c.id));
}

/** Category scores, overall score, coverage, confidence and alerts from check results. */
export function scoreChecks(checks) {
  const categories = {};
  for (const [id, cat] of Object.entries(CATEGORIES)) {
    if (!cat.weight) continue;
    const own = checks.filter(c => c.category === id && c.weight > 0);
    const measured = own.filter(c => c.status !== "na");
    const possible = measured.reduce((a, c) => a + c.weight, 0);
    const earned = measured.reduce((a, c) => a + c.weight * c.credit, 0);
    const total = own.reduce((a, c) => a + c.weight, 0);
    categories[id] = {
      id, label: cat.label, weight: cat.weight,
      score: possible ? Math.round((earned / possible) * 100) : null,
      earned: Math.round(earned * 10) / 10, possible,
      coverage: total ? Math.round((possible / total) * 100) : 0,
      checks: own.length, measured: measured.length,
      passed: measured.filter(c => c.status === "pass").length,
    };
  }
  const scored = Object.values(categories).filter(c => c.score !== null);
  const wsum = scored.reduce((a, c) => a + c.weight, 0);
  let overall = wsum ? Math.round(scored.reduce((a, c) => a + c.score * c.weight, 0) / wsum) : 0;

  const problems = checks.filter(c => c.status === "fail" || c.status === "warn");
  const critical = problems.filter(c => c.severity === "critical");
  let capped = null;
  if (critical.length && overall > CRITICAL_CAP) { capped = { from: overall, to: CRITICAL_CAP, because: critical.map(c => c.title) }; overall = CRITICAL_CAP; }

  const applicable = checks.filter(c => c.weight > 0 && CATEGORIES[c.category]?.weight);
  const measuredW = applicable.filter(c => c.status !== "na").reduce((a, c) => a + c.weight, 0);
  const totalW = applicable.reduce((a, c) => a + c.weight, 0);
  const coverage = totalW ? Math.round((measuredW / totalW) * 100) : 0;

  const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  let opportunities = 0;
  for (const c of problems) { if (CHECKS[c.finding_id || c.id]?.opportunity) opportunities++; else counts[c.severity]++; }

  return {
    score_version: SCORE_VERSION, overall, capped, coverage,
    confidence: coverage >= 85 ? "high" : coverage >= 60 ? "medium" : "low",
    categories, counts, opportunities,
    alerts: problems.filter(c => c.severity === "critical" || c.category === "domain").map(c => ({ id: c.finding_id || c.id, severity: c.severity, title: c.title, detected: c.evidence?.detected || "" })),
  };
}

/** Problems (fail/warn) as findings, sorted most severe first. fingerprint is stable across audits. */
export function toFindings(checks) {
  return checks.filter(c => c.status === "fail" || c.status === "warn").map(c => {
    const checkId = c.finding_id || c.id;
    return {
      fingerprint: `${checkId}${c.subject ? `|${c.subject}` : ""}`,
      check_id: checkId, category: c.category, severity: c.severity, title: c.title, subject: c.subject,
      status: c.status, weight: c.weight, credit: c.credit,
      evidence: c.evidence, items: c.items, data: c.data,
    };
  }).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.weight * (1 - b.credit) - a.weight * (1 - a.credit));
}

const SEVERITY_W = { critical: 20, high: 15, medium: 10, low: 5, info: 1 };
/** The {id,label,w,fix} issue list the scans table, period reports and emails already understand. */
export function legacyIssues(findings) {
  return findings.filter(f => f.severity !== "info").map(f => ({
    id: f.check_id, label: f.title, w: SEVERITY_W[f.severity], severity: f.severity, category: f.category,
    fix: [f.evidence?.detected, CHECKS[f.check_id]?.impact].filter(Boolean).join(" ").slice(0, 400),
  }));
}
export const passedLabels = checks => checks.filter(c => c.status === "pass" && CHECKS[c.id]?.pass).map(c => CHECKS[c.id].pass);

// ─── roadmap & diffs ──────────────────────────────────────────────────────────

const OUTCOMES = {
  technical: "Search engines can crawl and index the affected pages properly.",
  security: "Visitors get a secure connection with no browser warnings.",
  email: "Email from your domain is authenticated: harder to spoof, less likely to land in spam.",
  domain: "No risk of your website and email going offline.",
  onpage: "Clearer, more clickable search listings for the affected pages.",
  content: "Pages that answer searchers' questions more fully.",
  performance: "Faster loading on mobile.",
  ai: "AI crawlers can read and correctly understand your business.",
  ux: "More visitors can use your pages comfortably.",
  conversion: "More visitors turn into enquiries.",
  keywords: "Better positions for searches with measured demand.",
  competitors: "Fewer reasons for search engines to prefer competitors.",
  ai_visibility: "More chances to be named by AI assistants.",
};
const WEEK_THEMES = [
  "Critical fixes and technical SEO", "Content and on-page optimisation",
  "Keyword opportunities and competitor gaps", "AI visibility, conversion and performance",
];

/** A 30-day plan built only from this audit's findings. `present(f)` attaches catalogue text. */
export function buildRoadmap(findings, present) {
  const weeks = [[], [], [], []];
  for (const f of findings) {
    if (f.severity === "info" && !CHECKS[f.check_id]?.opportunity) continue;
    const c = f.category;
    let w;
    if (f.severity === "critical" || (["technical", "security", "email", "domain"].includes(c) && f.severity === "high")) w = 0;
    else if (c === "onpage" || c === "content") w = 1;
    else if (c === "keywords" || c === "competitors" || c === "ai" || (["technical", "security", "email"].includes(c) && f.severity === "medium")) w = 2;
    else w = 3;
    weeks[w].push(f);
  }
  return weeks.map((list, i) => ({
    week: i + 1, theme: WEEK_THEMES[i],
    tasks: list.slice(0, 8).map(f => {
      const p = present(f);
      return {
        fingerprint: f.fingerprint, finding_id: f.id, category: f.category, priority: f.severity,
        title: f.title, outcome: OUTCOMES[f.category] || "", action: p.steps[0] || "",
        affected: (f.items || []).map(x => x.url).filter(Boolean).slice(0, 5),
        instructions: p.steps, time: p.time, verify: p.verify,
      };
    }),
    more: Math.max(0, list.length - 8),
  }));
}

/** New / resolved / persisting fingerprints between two audits. */
export function diffFindings(current, previous) {
  const prev = new Map((previous || []).map(f => [f.fingerprint, f]));
  const cur = new Map(current.map(f => [f.fingerprint, f]));
  return {
    new: current.filter(f => !prev.has(f.fingerprint)).map(f => ({ fingerprint: f.fingerprint, title: f.title, severity: f.severity })),
    resolved: [...prev.values()].filter(f => !cur.has(f.fingerprint)).map(f => ({ fingerprint: f.fingerprint, title: f.title, severity: f.severity })),
    persisting: current.filter(f => prev.has(f.fingerprint)).length,
  };
}
