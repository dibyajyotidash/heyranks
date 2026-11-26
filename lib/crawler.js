/**
 * Crawling primitives: robots.txt (RFC 9309), XML sitemaps, URL normalisation and HTML extraction.
 * Pure functions except fetchPageRecord, which goes through net.js (SSRF-safe, capped).
 * Page HTML is untrusted input: it is only parsed into plain data here, never executed.
 */
import { fetchPublic } from "./net.js";

export const CRAWLER_TOKEN = "heyranksbot";

// ─── robots.txt ───────────────────────────────────────────────────────────────

/** { groups: [{ agents, rules: [{ allow, path }], crawlDelay }], sitemaps } */
export function parseRobots(text) {
  const groups = [], sitemaps = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") { if (val) sitemaps.push(val); continue; }
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      if (val || key === "allow") cur.rules.push({ allow: key === "allow", path: val }); // "Disallow:" (empty) allows everything
    } else if (key === "crawl-delay") {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

/** Rules for one crawler: every group naming it (case-insensitive), else the "*" groups (RFC 9309 §2.2.1). */
function groupFor(robots, agent) {
  const a = agent.toLowerCase();
  const named = robots.groups.filter(g => g.agents.includes(a));
  const pick = named.length ? named : robots.groups.filter(g => g.agents.includes("*"));
  return { rules: pick.flatMap(g => g.rules), crawlDelay: pick.find(g => g.crawlDelay !== null)?.crawlDelay ?? null };
}

/** Does a robots.txt path pattern (with * and $) match this path? */
export function robotsPatternMatches(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching rule wins; on a tie, allow wins (RFC 9309 §2.2.2). /robots.txt itself is always allowed. */
export function robotsAllows(robots, agent, pathWithQuery) {
  if (!robots) return true;
  const path = pathWithQuery || "/";
  if (path === "/robots.txt") return true;
  let best = null;
  for (const r of groupFor(robots, agent).rules) {
    if (!robotsPatternMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

export const robotsCrawlDelay = (robots, agent) => (robots ? groupFor(robots, agent).crawlDelay : null);

// ─── sitemaps ─────────────────────────────────────────────────────────────────

const decodeXml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

/** { type: "urlset" | "index" | null, urls: [{ loc, lastmod }], sitemaps: [loc] } */
export function parseSitemap(xml) {
  const s = String(xml || "");
  const type = /<sitemapindex[\s>]/i.test(s) ? "index" : /<urlset[\s>]/i.test(s) ? "urlset" : null;
  const blocks = tag => [...s.matchAll(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi"))].map(m => m[0]);
  const field = (block, name) => { const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i")); return m ? decodeXml(m[1]) : null; };
  return {
    type,
    urls: type === "urlset" ? blocks("url").map(b => ({ loc: field(b, "loc"), lastmod: field(b, "lastmod") })).filter(u => u.loc) : [],
    sitemaps: type === "index" ? blocks("sitemap").map(b => field(b, "loc")).filter(Boolean) : [],
  };
}

// ─── URLs ─────────────────────────────────────────────────────────────────────

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|zip|rar|7z|gz|tar|dmg|exe|msi|apk|docx?|xlsx?|pptx?|csv|woff2?|ttf|eot|css|js|json|xml|rss|txt)$/i;

/** Absolute, fragment-free http(s) URL with a lower-case host and no default port, or null. */
export function normalizeUrl(href, base) {
  let u;
  try { u = new URL(String(href).trim(), base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u.toString();
}

const bareHost = h => h.toLowerCase().replace(/^www\./, "");
/** Same website: the host itself or its www / non-www twin. */
export const sameSite = (url, host) => { try { return bareHost(new URL(url).hostname) === bareHost(host); } catch { return false; } };
export const isCrawlable = url => { try { return !SKIP_EXT.test(new URL(url).pathname); } catch { return false; } };

// ─── HTML extraction ──────────────────────────────────────────────────────────

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Attributes of one tag's attribute string; names lower-cased; "double", 'single' and unquoted values. */
export function attrs(str) {
  const out = {};
  for (const a of String(str).matchAll(/([a-zA-Z_:@][-a-zA-Z0-9_:.@]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[a[1].toLowerCase()] ??= decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
  }
  return out;
}
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))].map(m => attrs(m[1]));
const clean = s => decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const ANALYTICS = [
  ["Google Analytics / Tag Manager", /googletagmanager\.com\/(gtag\/js|gtm\.js)|google-analytics\.com\/(analytics|ga)\.js|gtag\(\s*['"]config/i],
  ["Plausible", /plausible\.io\/js/i], ["Matomo", /matomo(\.js|\.php)|_paq\.push/i], ["Microsoft Clarity", /clarity\.ms\/tag/i],
  ["Hotjar", /static\.hotjar\.com/i], ["Meta Pixel", /connect\.facebook\.net\/[^"']+\/fbevents\.js|fbq\(\s*['"]init/i],
  ["Umami", /umami(\.is)?\/script\.js|data-website-id/i], ["Fathom", /cdn\.usefathom\.com/i], ["Segment", /cdn\.segment\.com/i],
  ["Vercel Analytics", /\/_vercel\/insights\/script\.js/i], ["Cloudflare Web Analytics", /static\.cloudflareinsights\.com/i],
];
const CTA_TEXT = /\b(contact( us)?|call( us| now)?|book( now| a| an| your)?|get (a |your )?(quote|started|in touch|free)|request|enquire|enquiry|inquire|buy|order|shop now|sign ?up|start (now|free|your)|subscribe|schedule|try (it )?(free|now)|download|apply now|whatsapp|get directions|reserve)\b/i;
const TRUST_TEXT = /\b(testimonials?|reviews?|rated \d|\d(\.\d)? ?(stars?|★)|trusted by|case stud(y|ies)|our clients|happy (customers|clients|patients)|as seen (in|on)|award|certified|accredited)\b/i;
const PRICE_TEXT = /(\b(pricing|price list|plans? (&|and) pricing|per month|\/mo(nth)?\b|starting at|from \$|fees)\b|[$€£₹]\s?\d)/i;

/** Small, fast 53-bit string hash (cyrb53). */
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const MINHASH_SEEDS = 32;
/** MinHash signature of 5-word shingles; two signatures' agreement estimates text overlap (Jaccard). */
export function minhash(words) {
  const sig = new Array(MINHASH_SEEDS).fill(Number.MAX_SAFE_INTEGER);
  for (let i = 0; i + 5 <= Math.min(words.length, 3000); i++) {
    const sh = words.slice(i, i + 5).join(" ");
    for (let k = 0; k < MINHASH_SEEDS; k++) { const v = hash53(sh, k + 1); if (v < sig[k]) sig[k] = v; }
  }
  return words.length >= 5 ? sig : null;
}
export const similarity = (a, b) => (a && b ? a.filter((v, i) => v === b[i]).length / a.length : 0);

/** Every JSON-LD @type in the page (nested and @graph included), plus dates. */
function jsonLd(html) {
  const types = new Set(), dates = [], errors = [];
  let blocks = 0;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    blocks++;
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { errors.push("A JSON-LD block isn't valid JSON."); continue; }
    const walk = (n, depth = 0) => {
      if (!n || typeof n !== "object" || depth > 8) return;
      if (Array.isArray(n)) return n.forEach(x => walk(x, depth + 1));
      const t = n["@type"];
      for (const x of Array.isArray(t) ? t : t ? [t] : []) types.add(String(x));
      for (const k of ["dateModified", "datePublished"]) if (typeof n[k] === "string") dates.push(n[k]);
      for (const v of Object.values(n)) if (v && typeof v === "object") walk(v, depth + 1);
    };
    walk(data);
  }
  return { blocks, types: [...types].slice(0, 30), dates, errors };
}

/**
 * Plain-data summary of one HTML page: everything the page-level checks and the AI analysts need.
 * `url` is the final URL after redirects (relative links resolve against it).
 */
export function extractPage(html, url) {
  const h = String(html || "");
  const head = h.match(/<head\b[\s\S]*?<\/head>/i)?.[0] || h.slice(0, 20000);
  const metas = tags(head, "meta");
  const meta = (attr, val) => metas.find(m => (m[attr] || "").toLowerCase() === val)?.content ?? null;
  const links = tags(head, "link");
  const rel = r => links.filter(l => (l.rel || "").toLowerCase().split(/\s+/).includes(r));
  const base = tags(head, "base")[0]?.href;
  const baseUrl = normalizeUrl(base || url, url) || url;

  const titleRaw = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const robotsMeta = [meta("name", "robots"), meta("name", "googlebot")].filter(Boolean).join(", ").toLowerCase();

  // Visible document only: markup inside scripts, templates and comments (e.g. JS template strings) isn't part of the page.
  const bodyHtml = h.replace(/<!--[\s\S]*?-->/g, " ").replace(/<head\b[\s\S]*?<\/head>/i, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");

  const headings = [...bodyHtml.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].slice(0, 60).map(m => ({ level: Number(m[1]), text: clean(m[2]).slice(0, 160) }));

  const anchors = [];
  for (const m of bodyHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (anchors.length >= 400) break;
    const a = attrs(m[1]);
    if (!a.href) continue;
    const text = clean(m[2]).slice(0, 120) || (attrs(m[2].match(/<img\b([^>]*)>/i)?.[1] || "").alt ?? "");
    anchors.push({ href: a.href, text, nofollow: /\bnofollow\b/i.test(a.rel || "") });
  }
  const resolved = anchors.map(a => ({ ...a, url: normalizeUrl(a.href, baseUrl) }));
  const host = new URL(url).hostname;
  const internal = [], external = [];
  for (const a of resolved) {
    if (!a.url) continue;
    (sameSite(a.url, host) ? internal : external).push({ url: a.url, text: a.text, nofollow: a.nofollow });
  }

  const images = tags(bodyHtml, "img").slice(0, 300).map(i => ({ src: (i.src || i["data-src"] || "").slice(0, 300), alt: i.alt === undefined ? null : i.alt, sized: !!(i.width && i.height) }));

  const text = clean(bodyHtml);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);

  const ld = jsonLd(h);
  const scripts = tags(h, "script").map(s => s.src).filter(Boolean);
  const scriptHosts = [...new Set(scripts.map(s => { try { return new URL(s, baseUrl).hostname; } catch { return null; } }).filter(x => x && !sameSite(`https://${x}/`, host)))];

  // Mixed content: http:// subresources on an https page. Scripts, frames and stylesheets are blocked by browsers.
  const mixed = { active: [], passive: [] };
  if (url.startsWith("https://")) {
    const isHttp = v => /^http:\/\//i.test(v || "");
    for (const s of tags(h, "script")) if (isHttp(s.src)) mixed.active.push(s.src);
    for (const f of tags(h, "iframe")) if (isHttp(f.src)) mixed.active.push(f.src);
    for (const l of tags(h, "link")) if (/stylesheet/i.test(l.rel || "") && isHttp(l.href)) mixed.active.push(l.href);
    for (const t of ["img", "source", "video", "audio"]) for (const x of tags(h, t)) if (isHttp(x.src)) mixed.passive.push(x.src);
    mixed.active = [...new Set(mixed.active)].slice(0, 10); mixed.passive = [...new Set(mixed.passive)].slice(0, 10);
  }

  // Forms: inputs a screen reader can't name (no <label for>, wrapping <label>, aria-label or aria-labelledby).
  const labelled = new Set(tags(h, "label").map(l => l.for).filter(Boolean));
  const formFields = html => [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].map(m => ({ tag: m[1].toLowerCase(), a: attrs(m[2]) }))
    .filter(f => f.tag !== "input" || !/^(hidden|submit|button|reset|image)$/i.test(f.a.type || ""));
  const fields = formFields(bodyHtml);
  const outsideLabels = formFields(bodyHtml.replace(/<label\b[^>]*>[\s\S]*?<\/label>/gi, " "));
  const unlabelled = outsideLabels.filter(f => !(f.a.id && labelled.has(f.a.id)) && !f.a["aria-label"] && !f.a["aria-labelledby"]).length;

  const buttons = [...bodyHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map(m => clean(m[1]));
  const ctaTexts = [...buttons, ...anchors.map(a => a.text)].filter(t => t && CTA_TEXT.test(t)).slice(0, 8);
  const phones = anchors.filter(a => /^tel:/i.test(a.href)).length, emails = anchors.filter(a => /^mailto:/i.test(a.href)).length;
  const whatsapp = anchors.filter(a => /(wa\.me|api\.whatsapp\.com)/i.test(a.href)).length;
  const lowerHrefs = anchors.map(a => a.href.toLowerCase());

  return {
    url,
    title: titleRaw === undefined ? null : clean(titleRaw),
    description: meta("name", "description")?.trim() ?? null,
    robots: robotsMeta || null,
    noindex: /\bnoindex\b|\bnone\b/.test(robotsMeta),
    canonical: (() => { const c = rel("canonical")[0]?.href; return c ? normalizeUrl(c, baseUrl) : null; })(),
    lang: (h.match(/<html\b([^>]*)>/i) && attrs(h.match(/<html\b([^>]*)>/i)[1]).lang) || null,
    viewport: meta("name", "viewport") !== null,
    og: { title: meta("property", "og:title"), description: meta("property", "og:description"), image: meta("property", "og:image"), site_name: meta("property", "og:site_name") },
    hreflang: rel("alternate").filter(l => l.hreflang).length,
    headings,
    h1: headings.filter(x => x.level === 1).map(x => x.text),
    links: { internal: internal.slice(0, 300), external: external.slice(0, 100) },
    images: { total: images.length, missing_alt: images.filter(i => i.alt === null).map(i => i.src).slice(0, 20), missing_alt_count: images.filter(i => i.alt === null).length, unsized: images.filter(i => !i.sized).length },
    words: words.length,
    text_excerpt: text.slice(0, 600),
    text_hash: words.length ? hash53(words.join(" ")) : null,
    minhash: minhash(words),
    jsonld: ld,
    dates: [meta("property", "article:modified_time"), meta("property", "article:published_time"), ...ld.dates].filter(Boolean).slice(0, 4),
    scripts: scripts.length,
    third_party_hosts: scriptHosts.slice(0, 20),
    analytics: ANALYTICS.filter(([, re]) => re.test(h)).map(([n]) => n),
    mixed,
    forms: { count: (h.match(/<form\b/gi) || []).length, fields: fields.length, unlabelled },
    conversion: {
      cta: ctaTexts, phones, emails, whatsapp,
      contact_link: lowerHrefs.some(x => /contact|enquir|get-in-touch|book/.test(x)),
      privacy_link: lowerHrefs.some(x => /privacy/.test(x)),
      trust: TRUST_TEXT.test(text) || ld.types.some(t => /Review|AggregateRating/i.test(t)),
      pricing: PRICE_TEXT.test(text) || lowerHrefs.some(x => /pricing|prices|plans/.test(x)),
      address: ld.types.some(t => /PostalAddress|LocalBusiness/i.test(t)),
    },
  };
}

/**
 * Fetches one page for the crawler and extracts it. Retries once on a network error or a 5xx.
 * Returns { url, final_url, status, chain, redirects, content_type, page (null unless HTML), error, ms }.
 */
export async function fetchPageRecord(url, { ms = 10000, retries = 1 } = {}) {
  const started = Date.now();
  let r;
  for (let attempt = 0; attempt <= retries; attempt++) {
    r = await fetchPublic(url, ms);
    if (r.blocked || (r.status && r.status < 500)) break;
    if (attempt < retries) await new Promise(res => setTimeout(res, 800));
  }
  const ct = r.headers["content-type"] || "";
  const html = r.ok && /html|xml/i.test(ct) && /<html|<head|<body|<title/i.test(r.text.slice(0, 5000));
  return {
    url, final_url: r.finalUrl, status: r.status, chain: r.chain, redirects: Math.max(0, r.chain.length - 1),
    content_type: ct.split(";")[0] || null, headers: r.headers,
    page: html ? extractPage(r.text, r.finalUrl) : null,
    error: r.blocked ? "blocked: not a public address" : r.error || null,
    ms: Date.now() - started,
  };
}
