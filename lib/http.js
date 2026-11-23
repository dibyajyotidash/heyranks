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

/** Parses a JSON body. Requiring the JSON content type also blocks cross-site form posts (CSRF). */
export async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "Expected a JSON body.");
  try {
    const body = await request.json();
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

/** Public origin for links in emails. SITE_URL wins so emails never point at a preview host. */
export function siteOrigin(request, env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/+$/, "");
  const host = request.headers.get("host");
  return host ? `${isHttps(request) ? "https" : "http"}://${host}` : new URL(request.url).origin;
}

/** Rejects state-changing requests sent from another site (defence in depth on top of SameSite cookies). */
export function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("host") || new URL(request.url).host;
  if (new URL(origin).host !== host) throw new HttpError(403, "Cross-site request blocked.");
}

export const isEmail = s => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s);
