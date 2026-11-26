/**
 * Small HTTP helpers shared by every route (Cloudflare and Vercel).
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

const MAX_JSON_BYTES = 64 * 1024;

/**
 * Parses a JSON body of at most 64 KB (every form in the app sends far less). Requiring the JSON
 * content type also blocks cross-site form posts (CSRF).
 */
export async function readJson(request, max = MAX_JSON_BYTES) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "Expected a JSON body.");
  if (Number(request.headers.get("content-length")) > max) throw new HttpError(413, "Request too large.");
  let text;
  try { text = await request.text(); } catch { throw new HttpError(400, "Invalid body."); }
  if (text.length > max) throw new HttpError(413, "Request too large.");
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
}

export function isHttps(request) {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

export const DEFAULT_SITE_URL = "https://heyranks.com";

/**
 * Public origin for links in emails and payment return URLs. These links carry login tokens, so the
 * request's Host header is never trusted for them: SITE_URL wins, then Vercel's own preview URL on
 * preview deployments, then the request host only for local development, else the real domain.
 */
export function siteOrigin(request, env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/+$/, "");
  if (env.VERCEL_ENV === "preview" && env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  const host = (request.headers.get("host") || new URL(request.url).host).toLowerCase();
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return `${isHttps(request) ? "https" : "http"}://${host}`;
  return DEFAULT_SITE_URL;
}

/** Rejects state-changing requests sent from another site (defence in depth on top of SameSite cookies). */
export function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("host") || new URL(request.url).host;
  if (new URL(origin).host !== host) throw new HttpError(403, "Cross-site request blocked.");
}

export const isEmail = s => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s);
