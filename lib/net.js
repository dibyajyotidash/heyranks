/**
 * Outbound HTTP for everything that touches a customer's website. Every request (and every redirect hop)
 * must resolve to a public address: no localhost, private ranges, link-local/cloud-metadata, CGNAT or
 * internal names. Bodies are capped and only text is read.
 */

export const UA = "HeyRanksBot/2.0 (+https://heyranks.com/bot)";
export const MAX_PAGE_BYTES = 600_000;
const NOT_TEXT = /^(image|video|audio|font)\/|application\/(pdf|zip|gzip|x-tar|x-7z|octet-stream|vnd\.)/i;

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

export const isIpLiteral = host => /^\d+\.\d+\.\d+\.\d+$/.test(host) || String(host).includes(":");

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

// A crawl asks about the same host dozens of times in a minute; answers are kept for 30 seconds.
const publicCache = new Map();

/**
 * Resolves the hostname and rejects it if any address is private (stops DNS names that point at
 * internal IPs). Uses node:dns where it exists (Vercel, Node); elsewhere (Cloudflare Workers)
 * asks DNS-over-HTTPS, so the check never silently passes. Unresolvable names count as not public.
 */
export async function resolvesToPublic(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) return !isPrivateAddress(host);
  const hit = publicCache.get(host);
  if (hit && Date.now() - hit.at < 30_000) return hit.ok;
  let dns = null;
  try { dns = await import("node:dns"); } catch { /* not available on this runtime */ }
  let ok;
  try {
    const addrs = dns?.promises?.lookup
      ? (await dns.promises.lookup(host, { all: true })).map(a => a.address)
      : await resolveOverHttps(host);
    ok = addrs.length > 0 && addrs.every(a => !isPrivateAddress(a));
  } catch {
    ok = false; // doesn't resolve
  }
  publicCache.set(host, { ok, at: Date.now() });
  if (publicCache.size > 500) publicCache.delete(publicCache.keys().next().value);
  return ok;
}

/** Reads at most `max` bytes of a response body as text, then stops downloading. */
export async function readCapped(r, max = MAX_PAGE_BYTES) {
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

const headerMap = r => { const h = {}; for (const [k, v] of r.headers) h[k.toLowerCase()] = v; return h; };

/**
 * GET (or HEAD) that follows redirects by hand (up to 5) and checks every hop with the same rules as
 * the first URL, so a public site redirecting to 127.0.0.1 or the cloud metadata address counts as
 * unreachable instead of being fetched. `ms` covers the whole redirect chain.
 *
 * Returns { ok, status, text, finalUrl, headers, chain: [{ url, status }], blocked, error }.
 *   ok       a 2xx text response was read (text is "" for HEAD and non-text bodies)
 *   blocked  a hop pointed at a private / non-web address and was not requested
 */
export async function fetchPublic(url, ms = 9000, { method = "GET", readBody = true } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  let current = String(url);
  const chain = [];
  const fail = (extra = {}) => ({ ok: false, status: 0, text: "", finalUrl: current, headers: {}, chain, ...extra });
  try {
    for (let hop = 0; hop <= 5; hop++) {
      let u;
      try { u = new URL(current); } catch { return fail({ error: "bad-url" }); }
      if (!/^https?:$/.test(u.protocol) || isPrivateAddress(u.hostname) || !(await resolvesToPublic(u.hostname))) {
        return fail({ blocked: true, error: "not-public" });
      }
      const r = await fetch(current, { method, headers: { "User-Agent": UA }, redirect: "manual", signal: ctrl.signal });
      const location = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
      chain.push({ url: current, status: r.status });
      if (location) {
        await r.body?.cancel().catch(() => {});
        current = new URL(location, current).toString();
        continue;
      }
      const headers = headerMap(r);
      // Pages and text files only, and at most 600 KB of them: a huge or binary file can't eat memory or bandwidth.
      const textual = !NOT_TEXT.test(headers["content-type"] || "");
      if (!r.ok || !textual || !readBody || method === "HEAD") {
        await r.body?.cancel().catch(() => {});
        return { ok: r.ok && (textual || !readBody || method === "HEAD"), status: r.status, text: "", finalUrl: current, headers, chain };
      }
      return { ok: true, status: r.status, text: await readCapped(r), finalUrl: current, headers, chain };
    }
    return fail({ error: "too-many-redirects" });
  } catch (err) {
    return fail({ error: err?.name === "AbortError" ? "timeout" : "network" });
  } finally {
    clearTimeout(t);
  }
}
