/**
 * HeyRanks core: the site scanner, email templates, and the scheduled jobs.
 * HTTP routing lives in lib/api.js; both entry points (_worker.js, api/index.js) call it.
 */
import { json } from "./http.js";
import { periodRange, periodLabel, rebuildReports, rebuildAllReports } from "./reports.js";
import { ensureSchema } from "./schema.js";
import { PLANS } from "./plans.js";
import { settlePendingCashfreeOrders } from "./cashfree.js";

export { json };
export { PLANS, PRICE_CURRENCY, effectivePlan } from "./plans.js";

// ─── constants ───────────────────────────────────────────────────────────────

const UA       = "HeyRanksBot/1.0 (+https://heyranks.com)";
const AI_BOTS  = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "Google-Extended", "PerplexityBot"];
const FROM     = "HeyRanks <reports@heyranks.com>";
const SITE_URL = "https://heyranks.com";

// ─── utilities ───────────────────────────────────────────────────────────────

export function escHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** True for loopback, private, link-local, CGNAT and other non-public addresses (IPv4 and IPv6). */
export function isPrivateAddress(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)   // CGNAT
      || (a === 169 && b === 254)             // link-local / cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    // IPv6 forms that carry an IPv4 address: mapped (::ffff:), NAT64 (64:ff9b::) and the old compatible
    // form (::). URL parsing rewrites "[::ffff:127.0.0.1]" as "[::ffff:7f00:1]", so decode the hex too.
    const embedded = h.match(/^(?:::ffff:|64:ff9b::|::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (embedded) {
      if (embedded[1]) return isPrivateAddress(embedded[1]);
      const hi = parseInt(embedded[2], 16), lo = parseInt(embedded[3], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(h);
  }
  return false;
}

export function normalize(input) {
  let u = String(input || "").trim().replace(/^https?:\/\//i, "");
  if (!u) throw new Error("Please enter a website.");
  if (!u.includes(".")) throw new Error("That doesn't look like a website address.");
  let url;
  try { url = new URL("https://" + u); } catch { throw new Error("That doesn't look like a website address."); }
  if (isPrivateAddress(url.hostname)) throw new Error("Invalid host.");
  return url;
}

/**
 * Resolves the hostname and rejects it if any address is private (stops DNS names that point at
 * internal IPs). Uses node:dns where it exists (Vercel, Node); elsewhere (Cloudflare Workers)
 * asks DNS-over-HTTPS, so the check never silently passes. Unresolvable names count as not public.
 */
async function resolvesToPublic(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return !isPrivateAddress(host); // an IP already
  let dns = null;
  try { dns = await import("node:dns"); } catch { /* not available on this runtime */ }
  try {
    const addrs = dns?.promises?.lookup
      ? (await dns.promises.lookup(host, { all: true })).map(a => a.address)
      : await resolveOverHttps(host);
    return addrs.length > 0 && addrs.every(a => !isPrivateAddress(a));
  } catch {
    return false; // doesn't resolve
  }
}

/** A and AAAA records via Cloudflare's DNS-over-HTTPS JSON API (for runtimes without node:dns). */
export async function resolveOverHttps(host) {
  const addrs = [];
  for (const type of ["A", "AAAA"]) {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`DNS-over-HTTPS answered ${r.status}`);
    for (const a of (await r.json()).Answer || []) if (a.type === 1 || a.type === 28) addrs.push(a.data);
  }
  return addrs;
}

/** Generic DNS-over-HTTPS query. Returns the Answer array (empty on failure or NXDOMAIN). */
async function dnsQuery(name, type, ms = 4000) {
  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(ms) }
    );
    if (!r.ok) return [];
    return (await r.json()).Answer || [];
  } catch { return []; }
}

/**
 * Lightweight HEAD request to collect response headers at the final URL.
 * Returns a lowercase header map; empty object on failure.
 */
async function fetchSecurityHeaders(url, ms = 7000) {
  try {
    const r = await fetch(url, {
      method: "HEAD", redirect: "follow",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(ms),
    });
    const h = {};
    for (const [k, v] of r.headers) h[k.toLowerCase()] = v;
    return h;
  } catch { return {}; }
}

/**
 * RDAP domain registration info. Returns the parsed JSON (which always has an `events` array) or null.
 * Uses rdap.org as an aggregator for all TLDs.
 */
async function fetchRdap(hostname, ms = 8000) {
  const domain = hostname.replace(/^www\./, "");
  try {
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/json", "User-Agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.events ? j : null;
  } catch { return null; }
}

const MAX_PAGE_BYTES = 600_000;
const NOT_TEXT = /^(image|video|audio|font)\/|application\/(pdf|zip|gzip|x-tar|x-7z|vnd\.)/i;

/** Reads at most `max` bytes of a response body as text, then stops downloading. */
async function readCapped(r, max = MAX_PAGE_BYTES) {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = "", bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += dec.decode(value, { stream: true });
    if (bytes >= max) { await reader.cancel().catch(() => {}); break; }
  }
  return (text + dec.decode()).slice(0, max);
}

// ─── HTML meta parsing ────────────────────────────────────────────────────────

/** Attributes of every <meta> tag, lower-cased names; handles "double", 'single' and unquoted values in any order. */
export function metaTags(html) {
  const out = [];
  for (const m of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    out.push(attrs);
  }
  return out;
}

const metaContent = (metas, attr, value) =>
  (metas.find(m => (m[attr] || "").toLowerCase() === value)?.content ?? null);

// ─── HTTP fetch helper ────────────────────────────────────────────────────────

/**
 * GET that follows redirects by hand (up to 5) and checks every hop with the same rules as the
 * first URL, so a public site redirecting to 127.0.0.1 or the cloud metadata address counts as
 * unreachable instead of being fetched. `ms` covers the whole redirect chain.
 */
export async function fetchPublic(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  let current = String(url);
  const fail = () => ({ ok: false, status: 0, text: "", finalUrl: current });
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const u = new URL(current);
      if (!/^https?:$/.test(u.protocol) || isPrivateAddress(u.hostname) || !(await resolvesToPublic(u.hostname))) return fail();
      const r = await fetch(current, { headers: { "User-Agent": UA }, redirect: "manual", signal: ctrl.signal });
      const location = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
      if (location) {
        await r.body?.cancel();
        current = new URL(location, current).toString();
        continue;
      }
      // Pages and text files only, and at most 600 KB of them: a huge or binary file can't eat memory or bandwidth.
      if (!r.ok || NOT_TEXT.test(r.headers.get("content-type") || "")) {
        await r.body?.cancel().catch(() => {});
        return { ok: false, status: r.status, text: "", finalUrl: current };
      }
      return { ok: true, status: r.status, text: await readCapped(r), finalUrl: current };
    }
    return fail(); // too many redirects
  } catch {
    return fail();
  } finally {
    clearTimeout(t);
  }
}

// ─── robots.txt parser ────────────────────────────────────────────────────────

function blocksBot(robotsTxt, bot) {
  const groups = [];
  let cur = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, val] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (key === "user-agent") {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (cur) cur.rules.push({ key, val });
  }
  const pick = groups.find(g => g.agents.includes(bot.toLowerCase()))
            || groups.find(g => g.agents.includes("*"));
  if (!pick) return false;
  const allowRoot = pick.rules.some(r => r.key === "allow"    && r.val === "/");
  return !allowRoot && pick.rules.some(r => r.key === "disallow" && r.val === "/");
}

// ─── core scan ───────────────────────────────────────────────────────────────

export async function runScan(hostname, env) {
  const origin = "https://" + hostname;
  if (isPrivateAddress(hostname) || !(await resolvesToPublic(hostname))) return null;
  const [home, robots, llms, sitemap, txtRecs, dmarcRecs, mxRecs, secHeaders, rdap] = await Promise.all([
    fetchPublic(origin + "/"),
    fetchPublic(origin + "/robots.txt"),
    fetchPublic(origin + "/llms.txt"),
    fetchPublic(origin + "/sitemap.xml"),
    dnsQuery(hostname, "TXT"),
    dnsQuery(`_dmarc.${hostname}`, "TXT"),
    dnsQuery(hostname, "MX"),
    fetchSecurityHeaders(origin + "/"),
    fetchRdap(hostname),
  ]);
  if (!home.ok) return null;

  const h    = home.text;
  const tag  = (re) => { const m = h.match(re); return m ? m[1].trim() : ""; };
  const title = tag(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metas = metaTags(h);
  const desc  = (metaContent(metas, "name", "description") || "").trim();
  const hasViewport = metaContent(metas, "name", "viewport") !== null;
  const hasOg = metaContent(metas, "property", "og:title") !== null;
  const blocked = robots.ok ? AI_BOTS.filter(b => blocksBot(robots.text, b)) : [];

  const checks = [
    { id: "https",    label: "Secure HTTPS",              w: 10, pass: home.finalUrl.startsWith("https://"),
      fix: "Enable HTTPS — free via Cloudflare or Let's Encrypt." },
    { id: "title",    label: "Page title",                w: 10, pass: title.length >= 10 && title.length <= 65,
      fix: title ? `Title is ${title.length} chars — keep it 10–65.` : "Add a <title> tag naming your business and service." },
    { id: "desc",     label: "Meta description",          w: 10, pass: desc.length >= 50 && desc.length <= 160,
      fix: desc  ? `Description is ${desc.length} chars — aim for 50–160.` : "Add a meta description — the text Google and AI tools show." },
    { id: "h1",       label: "Main heading (H1)",         w: 5,  pass: /<h1[\s>]/i.test(h),
      fix: "Add one clear <h1> saying what you do." },
    { id: "viewport", label: "Mobile friendly",           w: 10, pass: hasViewport,
      fix: "Add a viewport meta tag so the site works on phones." },
    { id: "schema",   label: "Structured data (Schema.org)", w: 15, pass: /application\/ld\+json/i.test(h),
      fix: "Add LocalBusiness or Organization schema so AI understands who you are." },
    { id: "og",       label: "Social preview (Open Graph)", w: 5, pass: hasOg,
      fix: "Add Open Graph tags so links look good on WhatsApp and LinkedIn." },
    { id: "ai",       label: "AI crawlers allowed",       w: 15, pass: blocked.length === 0,
      fix: blocked.length ? `Your robots.txt blocks: ${blocked.join(", ")}. AI assistants can't read your site.` : "AI crawlers are allowed." },
    { id: "llms",     label: "llms.txt present",          w: 10, pass: llms.ok && llms.text.length > 20 && !/<html/i.test(llms.text),
      fix: "Create /llms.txt that summarises your business for AI models." },
    { id: "sitemap",  label: "XML sitemap",               w: 10, pass: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text),
      fix: "Add /sitemap.xml and submit it in Google Search Console." },
  ];

  // Optional speed score
  let speed = null;
  try {
    const key = env?.PSI_KEY ? `&key=${env.PSI_KEY}` : "";
    const r = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&url=${encodeURIComponent(origin)}${key}`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (r.ok) speed = Math.round(((await r.json()).lighthouseResult?.categories?.performance?.score ?? 0) * 100);
    // Without PSI_KEY, Google's shared quota usually answers 429, so speed silently stays null.
    else console.warn(`[scan] PageSpeed API ${r.status} for ${hostname}${env?.PSI_KEY ? "" : " (PSI_KEY not set)"}`);
  } catch (err) {
    console.warn(`[scan] PageSpeed API failed for ${hostname}: ${err?.name || err}`);
  }
  if (speed !== null) checks.push({
    id: "speed", label: `Mobile speed (${speed}/100)`, w: 10, pass: speed >= 70,
    fix: `Mobile speed is ${speed}/100. Compress images and remove unused scripts.`,
  });

  // ─── email security (DNS) ────────────────────────────────────────────────────
  const spfRecord   = txtRecs.find(r => r.data?.replace(/"/g, "").trimStart().startsWith("v=spf1"));
  const dmarcRecord = dmarcRecs.find(r => r.data?.replace(/"/g, "").trimStart().startsWith("v=DMARC1"));
  checks.push(
    { id: "spf",   label: "SPF email protection",  w: 8, pass: !!spfRecord,
      fix: spfRecord ? "SPF record is present." : `No SPF record found. Spammers can forge @${hostname} emails. Add a DNS TXT record on your domain: v=spf1 include:your-email-provider ~all` },
    { id: "dmarc", label: "DMARC email protection", w: 8, pass: !!dmarcRecord,
      fix: dmarcRecord ? "DMARC record is present." : `No DMARC record found. Add a DNS TXT record on _dmarc.${hostname}: v=DMARC1; p=quarantine; rua=mailto:dmarc@${hostname}` },
  );

  // ─── security headers ────────────────────────────────────────────────────────
  const hsts   = !!secHeaders["strict-transport-security"];
  const xFrame = !!(secHeaders["x-frame-options"] || (secHeaders["content-security-policy"] || "").includes("frame-ancestors"));
  const xCto   = (secHeaders["x-content-type-options"] || "").toLowerCase().includes("nosniff");
  checks.push(
    { id: "hsts",    label: "HSTS security header",    w: 6, pass: hsts,
      fix: hsts ? "HSTS header is set." : "Missing HSTS header. Add: Strict-Transport-Security: max-age=31536000; includeSubDomains (or enable HSTS in Cloudflare under SSL/TLS → Edge Certificates)." },
    { id: "x_frame", label: "Clickjacking protection", w: 4, pass: xFrame,
      fix: xFrame ? "Clickjacking protection header is set." : "Missing X-Frame-Options header. Add: X-Frame-Options: SAMEORIGIN (or use Content-Security-Policy: frame-ancestors 'self')." },
    { id: "x_cto",   label: "MIME sniffing blocked",   w: 4, pass: xCto,
      fix: xCto ? "X-Content-Type-Options is set." : "Missing X-Content-Type-Options header. Add: X-Content-Type-Options: nosniff" },
  );

  // ─── domain expiry (RDAP) ────────────────────────────────────────────────────
  const expiryEvent = rdap?.events?.find(e => e.eventAction === "expiration");
  const expiryDate  = expiryEvent ? new Date(expiryEvent.eventDate) : null;
  const daysLeft    = expiryDate ? Math.round((expiryDate - Date.now()) / 864e5) : null;
  if (daysLeft !== null) {
    checks.push({
      id: "domain_expiry",
      label: daysLeft > 60 ? `Domain valid (${daysLeft} days left)` : daysLeft > 0 ? `Domain expires in ${daysLeft} days!` : "Domain has expired!",
      w: 10,
      pass: daysLeft > 60,
      fix: daysLeft <= 60
        ? `Your domain expires on ${expiryDate.toISOString().slice(0, 10)}. Log in to your registrar and renew it immediately — if it expires your website and email stop working.`
        : `Your domain is registered until ${expiryDate.toISOString().slice(0, 10)}. Set a renewal reminder well in advance.`,
    });
  }

  // ─── build details object (stored in DB, returned to dashboard) ──────────────
  const registrarEntity = rdap?.entities?.find(e => e.roles?.includes("registrar"));
  const registrarName   = registrarEntity?.vcardArray?.[1]?.find?.(v => v[0] === "fn")?.[3] ?? null;
  const regEvent        = rdap?.events?.find(e => e.eventAction === "registration");
  const domainAgeYears  = regEvent ? Math.floor((Date.now() - new Date(regEvent.eventDate)) / (365.25 * 864e5)) : null;

  const details = {
    email: {
      spf:   spfRecord?.data?.replace(/"/g, "").trim() ?? null,
      dmarc: dmarcRecord?.data?.replace(/"/g, "").trim() ?? null,
      mx:    mxRecs.slice(0, 5).map(r => r.data).filter(Boolean),
    },
    security: {
      hsts:        secHeaders["strict-transport-security"] ?? null,
      x_frame:     secHeaders["x-frame-options"] ?? null,
      x_cto:       secHeaders["x-content-type-options"] ?? null,
      csp_present: !!(secHeaders["content-security-policy"]),
      referrer:    secHeaders["referrer-policy"] ?? null,
    },
    domain: rdap ? {
      registrar:   registrarName,
      created:     regEvent?.eventDate ?? null,
      expires:     expiryDate?.toISOString() ?? null,
      days_left:   daysLeft,
      age_years:   domainAgeYears,
      nameservers: rdap.nameservers?.map(ns => ns.ldhName?.toLowerCase()).filter(Boolean) ?? [],
      status:      Array.isArray(rdap.status) ? rdap.status.slice(0, 4) : [],
    } : null,
  };

  // The score uses all named checks except the optional "speed" check.
  const scored = checks.filter(c => c.id !== "speed");
  const total  = scored.reduce((a, c) => a + c.w, 0);
  const score  = Math.round(scored.reduce((a, c) => a + (c.pass ? c.w : 0), 0) / total * 100);
  const passed = checks.filter(c =>  c.pass).map(c => c.label);
  const issues = checks.filter(c => !c.pass).sort((a, b) => b.w - a.w);

  return { score, passed, issues, speed, top_issues: issues.slice(0, 3), more_issues: Math.max(0, issues.length - 3), details };
}

/**
 * Stores a scan, refreshes the five period reports containing it, and stamps the site.
 * Returns the previous scan's score (for "up/down since last time"), or null.
 */
export async function saveScan(db, site, scan, kind, at = new Date().toISOString()) {
  const prev = await db.prepare("SELECT score FROM scans WHERE site_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1")
    .bind(site.id, at).first();
  await db.prepare(`
    INSERT INTO scans (id, site_id, user_id, kind, score, speed, checks_count, issues_count, passed, issues, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), site.id, site.user_id, kind, scan.score, scan.speed,
    scan.passed.length + scan.issues.length, scan.issues.length,
    JSON.stringify(scan.passed), JSON.stringify(scan.issues.map(({ id, label, w, fix }) => ({ id, label, w, fix }))),
    scan.details ? JSON.stringify(scan.details) : null, at,
  ).run();
  await db.prepare("UPDATE sites SET last_scan_at = ? WHERE id = ?").bind(at, site.id).run();
  await rebuildReports(db, site, at);
  return prev?.score ?? null;
}

// ─── copy-paste code snippets ─────────────────────────────────────────────────

export function codeSnippet(issue, site) {
  switch (issue.id) {
    case "title":
      return `<title>Your Business Name — City | Your Main Service</title>`;
    case "desc":
      return `<meta name="description" content="[One sentence about what you do and who you help — 50 to 160 characters]">`;
    case "h1":
      return `<h1>Your Service in Your City</h1>`;
    case "viewport":
      return `<meta name="viewport" content="width=device-width, initial-scale=1">`;
    case "schema":
      return JSON.stringify({
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "name": "Your Business Name",
        "url": `https://${site}`,
        "description": "What you do and who you serve.",
        "telephone": "+91-XXXXX-XXXXX",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "Your Street",
          "addressLocality": "Your City",
          "addressRegion": "Your State",
          "addressCountry": "IN"
        }
      }, null, 2);
    case "og":
      return `<meta property="og:title" content="Your Business Name — City">\n<meta property="og:description" content="[Same as meta description]">\n<meta property="og:type" content="website">\n<meta property="og:url" content="https://${site}">`;
    case "ai":
      return `# In robots.txt — remove any lines like these (or change Disallow: / to Allow: /):\n# User-agent: GPTBot\n# Disallow: /\n\n# Instead add:\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /`;
    case "llms":
      return `# ${site}\n\n> [One paragraph: what you do, who you serve, what makes you different.]\n\n## Services\n- [Service 1 — brief description]\n- [Service 2 — brief description]\n\n## Location & Contact\n- Location: [Your city, state]\n- Email: hello@${site}`;
    case "sitemap":
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://${site}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n  <url><loc>https://${site}/about</loc><changefreq>monthly</changefreq></url>\n  <url><loc>https://${site}/services</loc><changefreq>monthly</changefreq></url>\n  <url><loc>https://${site}/contact</loc><changefreq>monthly</changefreq></url>\n</urlset>`;
    case "spf":
      return `; Add a TXT record to your domain DNS\n; Name: @   Type: TXT\nv=spf1 include:_spf.google.com ~all\n; Replace 'include:_spf.google.com' with your email provider's SPF include.\n; Common values:\n;   Google Workspace:  include:_spf.google.com\n;   Microsoft 365:     include:spf.protection.outlook.com\n;   Zoho:              include:zoho.com\n;   Mailchimp/Mandrill: include:spf.mandrillapp.com`;
    case "dmarc":
      return `; Add a TXT record to your domain DNS\n; Name: _dmarc   Type: TXT\nv=DMARC1; p=quarantine; rua=mailto:dmarc@${site}; adkim=r; aspf=r\n; p=none     → monitor only (safe to start with)\n; p=quarantine → move suspicious mail to spam\n; p=reject    → block suspicious mail entirely`;
    case "hsts":
      return `# Nginx — add inside your server {} block:\nadd_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n\n# Apache — add to .htaccess or VirtualHost:\nHeader always set Strict-Transport-Security "max-age=31536000; includeSubDomains"\n\n# Cloudflare — no code needed:\n# SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS) → Enable`;
    case "x_frame":
      return `# Nginx:\nadd_header X-Frame-Options "SAMEORIGIN" always;\n\n# Apache:\nHeader always set X-Frame-Options "SAMEORIGIN"\n\n# Cloudflare Transform Rules → Modify Response Header:\n# Action: Set   Header: X-Frame-Options   Value: SAMEORIGIN`;
    case "x_cto":
      return `# Nginx:\nadd_header X-Content-Type-Options "nosniff" always;\n\n# Apache:\nHeader always set X-Content-Type-Options "nosniff"\n\n# Cloudflare Transform Rules → Modify Response Header:\n# Action: Set   Header: X-Content-Type-Options   Value: nosniff`;
    case "domain_expiry":
      return `# No code needed — log in to your domain registrar and renew your domain.\n# Common registrars:\n#   GoDaddy:   godaddy.com\n#   Namecheap: namecheap.com\n#   Google Domains → Squarespace Domains\n#   Hostinger, BigRock, GoDaddy India\n# Tip: set auto-renew so this never happens again.`;
    default:
      return null;
  }
}

// ─── AI analysis ─────────────────────────────────────────────────────────────

/**
 * Generates a 2-sentence plain-English executive summary using Claude.
 * Returns null when ANTHROPIC_API_KEY is absent, the scan has no issues, or the call fails.
 * Cost: ~200 input + ~100 output tokens per call (Haiku model, < $0.001).
 */
export async function generateAiSummary(scan, hostname, env) {
  if (!env?.ANTHROPIC_API_KEY || !scan?.issues?.length) return null;
  const topIssues = scan.issues.slice(0, 5).map(i => `- ${i.label}: ${i.fix}`).join("\n");
  const passing   = scan.passed.slice(0, 5).join(", ");
  const prompt =
    `Website: ${hostname}  Score: ${scan.score}/100\n\nTop issues:\n${topIssues}\n\nPassing: ${passing}\n\n` +
    `Write exactly 2 short sentences for a non-technical business owner: (1) the single most important issue and its business consequence, (2) one quick win or bright spot. Plain language, no jargon, no bullets.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL_FAST || "claude-haiku-4-5",
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(14000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

// ─── email templates ──────────────────────────────────────────────────────────

function issueBlock(issue, index, site) {
  const p = issue.w >= 15
    ? { color: "#dc2626", bg: "#fee2e2", label: "HIGH"   }
    : issue.w >= 10
    ? { color: "#d97706", bg: "#fef3c7", label: "MEDIUM" }
    : { color: "#16a34a", bg: "#dcfce7", label: "LOW"    };

  const snippet = codeSnippet(issue, site);

  return `
    <div style="margin-bottom:18px;padding:16px 20px;background:#f8fafc;border-radius:12px;border-left:4px solid ${p.color}">
      <div style="margin-bottom:8px">
        <span style="display:inline-block;background:${p.bg};color:${p.color};font-size:.7rem;font-weight:700;padding:2px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:.05em;vertical-align:middle">${p.label}</span>
        <span style="font-weight:700;color:#0f1720;margin-left:8px;font-size:.95rem;vertical-align:middle">${escHtml(issue.label)}</span>
      </div>
      <div style="font-size:.88rem;color:#334155;line-height:1.5">${escHtml(issue.fix)}</div>
      ${snippet ? `
        <div style="margin-top:12px;background:#0f1720;border-radius:8px;padding:12px 14px">
          <div style="font-size:.7rem;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Copy-paste fix</div>
          <pre style="margin:0;font-family:'Courier New',monospace;font-size:.78rem;color:#d9f99d;white-space:pre-wrap;word-break:break-all;line-height:1.5">${escHtml(snippet)}</pre>
        </div>` : ""}
    </div>`;
}

function reportEmail({ email, website }, scan, prevScore, weekLabel) {
  const scoreColor = scan.score >= 75 ? "#16a34a" : scan.score >= 45 ? "#d97706" : "#dc2626";
  const delta = prevScore !== null && prevScore !== undefined
    ? (scan.score > prevScore ? `<span style="color:#16a34a">▲ ${scan.score - prevScore} from last week</span>`
     : scan.score < prevScore ? `<span style="color:#dc2626">▼ ${prevScore - scan.score} from last week</span>`
     : `<span style="color:#64748b">no change from last week</span>`)
    : `<span style="color:#64748b">first report</span>`;

  const passedRows = scan.passed.map(p =>
    `<div style="padding:4px 0;font-size:.88rem;color:#334155">✅ ${escHtml(p)}</div>`).join("");

  const issueRows = scan.issues.slice(0, 5).map((iss, i) => issueBlock(iss, i, website)).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeyRanks report — ${escHtml(website)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:28px 16px">
<table width="100%" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

  <!-- header -->
  <tr><td style="background:#0f1720;padding:24px 32px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="color:#d9f99d;font-weight:700;font-size:1.05rem">📈 HeyRanks</td>
      <td align="right" style="color:#94a3b8;font-size:.82rem">${escHtml(weekLabel)}</td>
    </tr></table>
    <div style="margin-top:10px;color:#fff;font-size:1.25rem;font-weight:700">Weekly report: ${escHtml(website)}</div>
  </td></tr>

  <!-- score -->
  <tr><td style="padding:28px 32px;border-bottom:1px solid #f1f5f9">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <div style="font-size:4rem;font-weight:800;line-height:1;color:${scoreColor}">${scan.score}</div>
        <div style="font-size:.88rem;color:#64748b;margin-top:4px">out of 100 &nbsp;·&nbsp; ${delta}</div>
      </td>
      <td align="right" valign="top">
        <div style="display:inline-block;background:#f8fafc;border-radius:12px;padding:12px 20px;text-align:center">
          <div style="font-size:.75rem;color:#64748b;margin-bottom:4px">Passed</div>
          <div style="font-size:1.9rem;font-weight:800;color:#16a34a">${scan.passed.length}</div>
          <div style="font-size:.75rem;color:#64748b">/ ${scan.passed.length + scan.issues.length} checks</div>
        </div>
      </td>
    </tr></table>
  </td></tr>

  <!-- passing checks -->
  ${scan.passed.length ? `
  <tr><td style="padding:20px 32px;border-bottom:1px solid #f1f5f9;background:#f9fafb">
    <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:10px">What's working</div>
    ${passedRows}
  </td></tr>` : ""}

  <!-- fixes -->
  <tr><td style="padding:28px 32px">
    <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:16px">This week's fixes</div>
    ${issueRows}
    ${scan.issues.length > 5 ? `<div style="font-size:.85rem;color:#64748b;margin-top:8px">+ ${scan.issues.length - 5} more issue${scan.issues.length - 5 > 1 ? "s" : ""} — improve your score for a fuller report.</div>` : ""}
  </td></tr>

  <!-- CTA -->
  <tr><td style="background:#f8fafc;padding:28px 32px;border-top:1px solid #e2e8f0;text-align:center">
    <div style="font-size:.92rem;color:#334155;margin-bottom:18px">
      Your next report arrives next Monday. Your monthly, quarterly and yearly trends are on your dashboard.
    </div>
    <a href="${SITE_URL}/dashboard" style="display:inline-block;background:#ff5a1f;color:#fff;padding:13px 32px;border-radius:99px;font-weight:700;text-decoration:none;font-size:.95rem">
      Open my dashboard →
    </a>
    <div style="margin-top:16px;font-size:.82rem;color:#94a3b8">
      Refer 3 friends and get 180 days free →
      <a href="${SITE_URL}#referral" style="color:#ff5a1f;text-decoration:none">Get your link</a>
    </div>
  </td></tr>

  <!-- footer -->
  <tr><td style="padding:20px 32px;text-align:center;border-top:1px solid #f1f5f9">
    <div style="font-size:.78rem;color:#94a3b8;line-height:1.6">
      HeyRanks by DexoSoft Solutions &nbsp;·&nbsp;
      <a href="mailto:hello@dexosoftsolutions.com" style="color:#94a3b8">hello@dexosoftsolutions.com</a><br>
      You're receiving this because you signed up for weekly reports for ${escHtml(website)}.<br>
      <a href="mailto:hello@dexosoftsolutions.com?subject=Unsubscribe%20${encodeURIComponent(email)}" style="color:#94a3b8">Unsubscribe</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function welcomeEmail({ email, website, keywords, paid }, scan) {
  const kw = JSON.parse(keywords || "[]");
  const keywordsLine = kw.length
    ? `<div style="font-size:.88rem;color:#334155;margin-top:6px">Keywords tracked: <b>${kw.map(escHtml).join(", ")}</b></div>`
    : "";

  const topFixes = scan
    ? scan.issues.slice(0, 3).map((iss, i) => `
        <div style="margin-bottom:12px;padding:12px 16px;background:#f8fafc;border-radius:10px;font-size:.88rem">
          <b style="color:#0f1720">${i + 1}. ${escHtml(iss.label)}</b><br>
          <span style="color:#334155">${escHtml(iss.fix)}</span>
        </div>`).join("")
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to HeyRanks</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:28px 16px">
<table width="100%" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

  <tr><td style="background:#0f1720;padding:28px 32px;text-align:center">
    <div style="color:#d9f99d;font-size:2rem">📈</div>
    <div style="color:#fff;font-size:1.4rem;font-weight:700;margin-top:8px">Welcome to HeyRanks!</div>
    <div style="color:#94a3b8;font-size:.92rem;margin-top:6px">Your weekly website reports are live</div>
  </td></tr>

  <tr><td style="padding:28px 32px">
    <div style="background:#ecfccb;border-radius:12px;padding:16px 20px;margin-bottom:24px">
      <div style="font-weight:700;color:#166534;font-size:.95rem">✅ You're set up</div>
      <div style="color:#166534;font-size:.88rem;margin-top:4px">Site: <b>${escHtml(website)}</b></div>
      ${keywordsLine}
    </div>

    ${paid ? `
    <div style="font-size:1rem;color:#0f1720;font-weight:700;margin-bottom:8px">Your first full report is coming next Monday.</div>
    <div style="font-size:.92rem;color:#334155;line-height:1.6;margin-bottom:24px">
      Every Monday morning we scan your site and send you a plain-English report with the 5 things to fix that week. Monthly, quarterly, half-yearly and yearly summaries follow automatically.
    </div>` : `
    <div style="font-size:1rem;color:#0f1720;font-weight:700;margin-bottom:8px">Your free account is ready.</div>
    <div style="font-size:.92rem;color:#334155;line-height:1.6;margin-bottom:24px">
      You can rescan your site from your dashboard at any time. Upgrade to the 180-Day Pass to get a full report every Monday plus monthly, quarterly and yearly summaries.
    </div>`}

    ${topFixes ? `
    <div style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:12px">While you wait — 3 quick wins we found:</div>
    ${topFixes}` : ""}

  </td></tr>

  <tr><td style="background:#f8fafc;padding:24px 32px;text-align:center;border-top:1px solid #e2e8f0">
    <div style="font-size:.88rem;color:#334155;margin-bottom:16px">Any questions? Just reply to this email.</div>
    <a href="${SITE_URL}/dashboard" style="display:inline-block;background:#0f1720;color:#fff;padding:12px 28px;border-radius:99px;font-weight:700;text-decoration:none;font-size:.92rem">
      Open my dashboard →
    </a>
  </td></tr>

  <tr><td style="padding:16px 32px;text-align:center;border-top:1px solid #f1f5f9">
    <div style="font-size:.78rem;color:#94a3b8">
      HeyRanks by DexoSoft Solutions &nbsp;·&nbsp;
      <a href="mailto:hello@dexosoftsolutions.com" style="color:#94a3b8">hello@dexosoftsolutions.com</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

/** Plain one-card email: login links, password resets, notices. `body` is trusted HTML. */
export function simpleEmail(title, body, ctaText, ctaUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden">
  <tr><td style="background:#0f1720;padding:20px 28px;color:#d9f99d;font-weight:700">📈 HeyRanks</td></tr>
  <tr><td style="padding:28px">
    <div style="font-size:1.2rem;font-weight:700;color:#0f1720;margin-bottom:12px">${escHtml(title)}</div>
    <div style="font-size:.93rem;color:#334155;line-height:1.6">${body}</div>
    ${ctaUrl ? `<div style="margin-top:24px"><a href="${escHtml(ctaUrl)}" style="display:inline-block;background:#ff5a1f;color:#fff;padding:12px 28px;border-radius:99px;font-weight:700;text-decoration:none">${escHtml(ctaText)}</a></div>
    <div style="margin-top:16px;font-size:.78rem;color:#94a3b8;word-break:break-all">Or paste this link into your browser: ${escHtml(ctaUrl)}</div>` : ""}
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #f1f5f9;font-size:.78rem;color:#94a3b8">HeyRanks by DexoSoft Solutions · hello@dexosoftsolutions.com</td></tr>
</table></td></tr></table></body></html>`;
}

const PERIOD_NAMES = { monthly: "monthly", quarterly: "quarterly", half_yearly: "half-yearly", yearly: "yearly" };

/** Summary email sent once a month / quarter / half-year / year has ended. */
function periodEmail(hostname, report) {
  const s = JSON.parse(report.summary || "{}");
  const change = report.score_end - report.score_start;
  const changeText = change > 0 ? `up ${change} points` : change < 0 ? `down ${-change} points` : "unchanged";
  const list = (items, empty) => items?.length
    ? `<ul style="margin:6px 0 0;padding-left:18px">${items.slice(0, 6).map(i => `<li>${escHtml(i)}</li>`).join("")}</ul>`
    : `<div style="color:#94a3b8">${empty}</div>`;
  const body = `
    Your score for <b>${escHtml(hostname)}</b> ended the period at <b>${report.score_end}/100</b>, ${changeText}
    (average ${report.score_avg}, best ${report.score_max}, across ${report.scans_count} scan${report.scans_count === 1 ? "" : "s"}).
    <div style="margin-top:16px;font-weight:700;color:#16a34a">Fixed this period (${report.issues_resolved})</div>${list(s.resolved, "Nothing fixed yet.")}
    <div style="margin-top:14px;font-weight:700;color:#dc2626">New problems (${report.issues_new})</div>${list(s.new, "No new problems.")}
    <div style="margin-top:14px;font-weight:700;color:#0f1720">Still open (${report.issues_open})</div>${list((s.open || []).map(i => i.label), "Nothing open. Great work.")}`;
  return simpleEmail(`Your ${PERIOD_NAMES[report.period_type]} report: ${periodLabel(report.period_type, report.period_start)}`,
    body, "See the full report →", `${SITE_URL}/dashboard`);
}

// ─── email sender (Resend) ────────────────────────────────────────────────────

/**
 * Sends through Resend. ok is true only when Resend accepted the message, so callers can mark a
 * report as sent only then (acceptance, not inbox delivery). Never throws.
 */
export async function sendEmail(to, subject, html, env) {
  if (!env.RESEND_API_KEY) {
    // Dev mode: no email provider, so print links (login, reset) to the server log instead.
    // Not "ok": nothing was sent, so reports stay unsent and are retried once a key is set.
    const links = [...html.matchAll(/href="([^"]+(?:magic|token)=[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, "&"));
    console.log(`[email] no RESEND_API_KEY — would send to ${to}: ${subject}${links.length ? `\n[email] link: ${links[0]}` : ""}`);
    return { ok: false, dry: true };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) console.error("[email] Resend error", r.status, JSON.stringify(body));
    return { ok: r.ok && !!body.id, id: body.id, status: r.status };
  } catch (err) {
    console.error("[email] Resend request failed", err?.name || err);
    return { ok: false, status: 0 };
  }
}

// ─── scheduled jobs ───────────────────────────────────────────────────────────

// opts.budgetMs: stop starting new sites after this long, so the run ends before the
// platform's function timeout. Unfinished sites are picked up by the next run (their
// last_weekly_at is still older than this week's Monday).
export async function runWeekly(env, opts = {}) {
  if (!env.DB) return { error: "No DB binding" };
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? Infinity;
  const concurrency = opts.concurrency ?? 1;
  const now = new Date().toISOString();
  const week = periodRange("weekly", now).start;
  const d = new Date();
  const weekLabel = `${d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

  // Active sites of paying users that haven't had this week's report yet.
  const { results: sites } = await env.DB.prepare(`
    SELECT s.*, u.email FROM sites s JOIN users u ON u.id = s.user_id
    WHERE s.status = 'active' AND u.status = 'active' AND u.role != 'demo'
      AND (u.plan = 'lifetime' OR (u.plan = '180day' AND u.plan_expires_at > ?))
      AND (s.last_weekly_at IS NULL OR s.last_weekly_at < ?)
  `).bind(now, week).all();

  let sent = 0, failed = 0, skipped = 0, next = 0;
  async function processOne(site) {
    try {
      // A retry (the email failed on an earlier run this week) reuses this week's scan instead of scanning again.
      const earlier = await env.DB.prepare(`SELECT * FROM scans WHERE site_id = ? AND kind = 'weekly' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`).bind(site.id, week).first();
      let scan, prevScore;
      if (earlier) {
        scan = { score: earlier.score, speed: earlier.speed, passed: JSON.parse(earlier.passed), issues: JSON.parse(earlier.issues),
          details: earlier.details ? JSON.parse(earlier.details) : null };
        prevScore = (await env.DB.prepare("SELECT score FROM scans WHERE site_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1")
          .bind(site.id, earlier.created_at).first())?.score ?? null;
      } else {
        scan = await runScan(site.hostname, env);
        if (!scan) { failed++; return; }
        // AI summary for weekly paid scan (best-effort, never blocks delivery).
        if (scan.issues.length) {
          const sum = await generateAiSummary(scan, site.hostname, env).catch(() => null);
          if (sum) { scan.details = scan.details ?? {}; scan.details.aiSummary = sum; }
        }
        prevScore = await saveScan(env.DB, site, scan, "weekly", now);
      }

      const subject = `HeyRanks ${weekLabel} — ${site.hostname} scores ${scan.score}/100`
        + (prevScore !== null ? (scan.score > prevScore ? ` ↑${scan.score - prevScore}` : scan.score < prevScore ? ` ↓${prevScore - scan.score}` : "") : "");
      const mail = await sendEmail(site.email, subject, reportEmail({ email: site.email, website: site.hostname }, scan, prevScore, weekLabel), env);
      // Only an email the provider accepted counts as sent. Otherwise the site stays due and the next run retries.
      if (!mail.ok) { failed++; return; }

      await env.DB.prepare("UPDATE sites SET last_weekly_at = ? WHERE id = ?").bind(now, site.id).run();
      await env.DB.prepare(`UPDATE reports SET emailed_at = ? WHERE site_id = ? AND period_type = 'weekly' AND period_start = ?`)
        .bind(now, site.id, week).run();
      sent++;
    } catch (err) {
      console.error(`[weekly] failed for ${site.hostname}:`, err);
      failed++;
    }
  }

  async function worker() {
    while (next < sites.length) {
      if (Date.now() - started > budgetMs) { skipped = sites.length - next; next = sites.length; return; }
      await processOne(sites[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  return { week, due: sites.length, sent, failed, deferred: skipped };
}

/**
 * Emails monthly / quarterly / half-yearly / yearly summaries for ended periods that haven't been
 * emailed yet, oldest first, `limit` per run. No short window: if the scheduler was down, the next
 * runs catch up. (Reports from a stretch on the Free plan are marked handled when a paid plan starts,
 * see activatePlan, so upgrading doesn't send a backlog.) Each report is emailed once.
 */
export async function sendPeriodSummaries(env, limit = 50) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const oldest = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10); // sanity bound only
  const { results } = await env.DB.prepare(`
    SELECT r.*, s.hostname, u.email FROM reports r
    JOIN sites s ON s.id = r.site_id JOIN users u ON u.id = r.user_id
    WHERE r.period_type != 'weekly' AND r.emailed_at IS NULL
      AND r.period_end <= ? AND r.period_end > ?
      AND u.status = 'active' AND u.role != 'demo'
      AND (u.plan = 'lifetime' OR (u.plan = '180day' AND u.plan_expires_at > ?))
    ORDER BY r.period_end LIMIT ?`).bind(today, oldest, now, limit).all();

  let sent = 0;
  for (const r of results) {
    const label = periodLabel(r.period_type, r.period_start);
    const res = await sendEmail(r.email, `HeyRanks ${label} summary — ${r.hostname} at ${r.score_end}/100`, periodEmail(r.hostname, r), env);
    if (res.ok) {
      await env.DB.prepare("UPDATE reports SET emailed_at = ? WHERE id = ?").bind(now, r.id).run();
      sent++;
    }
  }
  return { summaries: sent };
}

/** Deletes expired sessions, tokens and rate-limit windows, and visit rows older than ~13 months. */
export async function cleanup(env) {
  const now = new Date().toISOString();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM visits WHERE day < ?").bind(new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)).run();
}

/**
 * Receipt + confirmation once a payment switches a plan on. `s` is what settleCashfreeOrder returns
 * when it grants a plan. Sent from every path (return page, webhook, daily check), because a buyer
 * who closed the payment tab otherwise never hears that it worked.
 */
export async function notifyPlanActivated(env, s) {
  const u = await env.DB.prepare("SELECT email, name, plan, plan_expires_at FROM users WHERE id = ?").bind(s.user_id).first();
  if (!u) return;
  const label = PLANS[s.plan]?.label || s.plan;
  const paid = s.currency === "INR" ? `₹${(s.amount / 100).toLocaleString("en-IN")}` : `${(s.amount / 100).toFixed(2)} ${s.currency}`;
  const until = u.plan === "lifetime" ? "for life"
    : `until ${new Date(u.plan_expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;
  const body = `Thanks${u.name ? ", " + escHtml(u.name) : ""}! We've received your payment of <b>${paid}</b>, and your
    <b>${escHtml(label)}</b> is active ${until}.<br><br>
    Your report arrives every Monday, with monthly, quarterly and yearly summaries when each period ends.<br><br>
    <span style="color:#94a3b8">Order reference: ${escHtml(s.order_id)}</span>`;
  await sendEmail(u.email, `Your HeyRanks ${label} is active`, simpleEmail(`Your ${label} is active`, body, "Open my dashboard →", `${SITE_URL}/dashboard`), env);
}

/** The daily cron: unpaid-order check, weekly reports (Mondays + catch-up), period summaries, housekeeping. */
export async function runDaily(env, opts = {}) {
  if (!env.DB) return { error: "No DB binding" };
  await ensureSchema(env.DB, rebuildAllReports); // the cron can be an instance's first call
  // First, so a long weekly run can't crowd it out: payments whose webhook never arrived.
  const payments = await settlePendingCashfreeOrders(env.DB, env);
  for (const s of payments.granted) await notifyPlanActivated(env, s).catch(err => console.error("[daily] receipt email failed", err));
  const weekly = await runWeekly(env, opts);
  const summaries = await sendPeriodSummaries(env);
  await cleanup(env);
  return { ...weekly, ...summaries, cashfree_checked: payments.checked, cashfree_settled: payments.granted.length };
}

export { welcomeEmail };
