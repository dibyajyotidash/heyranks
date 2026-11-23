/**
 * Visitor analytics (admin → Visitors), modelled on market_forecast_web's /api/analytics.
 * Differences, on purpose:
 *   - No IP address is stored or sent anywhere. "visitor" is a hash of IP + browser + day, so it
 *     counts unique visitors per day and can't be traced back or linked across days.
 *   - Location comes from the host's geo headers (Vercel: x-vercel-ip-*, Cloudflare: request.cf),
 *     not a third-party IP lookup.
 *   - Referrers are kept as host names only (no full URLs with query strings).
 */
import { clientIp } from "./http.js";
import { sha256 } from "./auth.js";

const DAY = 864e5;
const IST_OFFSET_MIN = 330; // traffic-by-hour is shown in India time

/** Bots, crawlers, uptime monitors and headless browsers (from market_forecast_web, plus a few). */
export function isBot(ua) {
  if (!ua) return true;
  return /bot|crawler|spider|crawling|slurp|bingpreview|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|googlebot|adsbot|duckduckbot|baiduspider|yandex|facebookexternalhit|whatsapp|telegrambot|preview|monitor|uptime|pingdom|gtmetrix|httrack|wget|curl|python-requests|axios|node-fetch|java\/|go-http-client/i.test(ua);
}

/** Device / browser / OS from the user agent. Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari". */
export function parseUserAgent(ua = "") {
  const device = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobile|Android|iPhone/i.test(ua) ? "Mobile" : "Desktop";
  const browser = /Edg\//i.test(ua) ? "Edge" : /OPR\/|Opera/i.test(ua) ? "Opera" : /SamsungBrowser/i.test(ua) ? "Samsung Internet"
    : /Firefox|FxiOS/i.test(ua) ? "Firefox" : /Chrome|CriOS/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "Other";
  const os = /Windows/i.test(ua) ? "Windows" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android"
    : /Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "Other";
  return { device, browser, os };
}

/** Referring host, or null for direct visits and links from our own site. */
export function referrerHost(referrer, ownHost) {
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, "").toLowerCase();
    const own = String(ownHost || "").replace(/^www\./, "").replace(/:\d+$/, "").toLowerCase();
    return host && host !== own ? host.slice(0, 100) : null;
  } catch {
    return null;
  }
}

/** Approximate location from the hosting platform's headers. Nothing is looked up externally. */
export function geoFromRequest(request) {
  const h = request.headers;
  const dec = v => { try { return v ? decodeURIComponent(v).slice(0, 80) : null; } catch { return null; } };
  const country = h.get("x-vercel-ip-country") || h.get("cf-ipcountry") || request.cf?.country || null;
  return {
    country: country && /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null,
    region: dec(h.get("x-vercel-ip-country-region")) || request.cf?.region || null,
    city: dec(h.get("x-vercel-ip-city")) || request.cf?.city || null,
  };
}

const clip = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));

/** Stores one page view. `path` has already been validated by the caller. */
export async function recordVisit(db, request, env, body, path, userId) {
  const ua = request.headers.get("user-agent") || "";
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const visitor = (await sha256(`${day}|${clientIp(request)}|${ua}|${env.ANALYTICS_SALT || "heyranks"}`)).slice(0, 16);
  const { device, browser, os } = parseUserAgent(ua);
  const geo = geoFromRequest(request);
  const sid = /^[A-Za-z0-9_-]{8,40}$/.test(String(body.session_id || "")) ? body.session_id : null;
  const width = Number(body.screen_width);
  await db.prepare(`INSERT INTO visits (at, day, session_id, visitor, path, referrer, utm_source, utm_medium, utm_campaign,
      country, region, city, device, browser, os, screen_width, language, timezone, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    now.toISOString(), day, sid, visitor, path, referrerHost(body.referrer, request.headers.get("host")),
    clip(body.utm_source, 100), clip(body.utm_medium, 100), clip(body.utm_campaign, 100),
    geo.country, geo.region, geo.city, device, browser, os,
    Number.isFinite(width) && width > 0 && width < 10000 ? Math.round(width) : null,
    clip(body.language, 20), clip(body.timezone, 60), userId || null,
  ).run();
}

/** Everything the admin Visitors tab shows, for the last `days` days. */
export async function visitorAnalytics(db, days) {
  const now = Date.now();
  const since = new Date(now - (days - 1) * DAY).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
  const breakdown = (col, limit) => all(`SELECT ${col} AS label, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors
    FROM visits WHERE day >= ? AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY visitors DESC, visits DESC LIMIT ?`, since, limit);

  const [totals, compare, dailyRows, pages, referrers, direct, utm, devices, browsers, os, countries, cities, hourRows, sessions, funnel] = await Promise.all([
    one(`SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT session_id) AS sessions
         FROM visits WHERE day >= ?`, since),
    one(`SELECT COUNT(CASE WHEN day = ? THEN 1 END) AS today_visits, COUNT(DISTINCT CASE WHEN day = ? THEN visitor END) AS today_visitors,
                COUNT(CASE WHEN day = ? THEN 1 END) AS yesterday_visits, COUNT(DISTINCT CASE WHEN day = ? THEN visitor END) AS yesterday_visitors
         FROM visits WHERE day >= ?`, today, today, yesterday, yesterday, yesterday),
    all(`SELECT day, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ? GROUP BY day`, since),
    all(`SELECT path AS label, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ?
         GROUP BY path ORDER BY visits DESC LIMIT 15`, since),
    breakdown("referrer", 10),
    one(`SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ? AND referrer IS NULL`, since),
    all(`SELECT utm_source || COALESCE(' / ' || utm_medium, '') AS label, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors
         FROM visits WHERE day >= ? AND utm_source IS NOT NULL GROUP BY label ORDER BY visitors DESC LIMIT 10`, since),
    breakdown("device", 5),
    breakdown("browser", 8),
    breakdown("os", 8),
    breakdown("country", 15),
    all(`SELECT city || COALESCE(', ' || country, '') AS label, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors
         FROM visits WHERE day >= ? AND city IS NOT NULL GROUP BY city, country ORDER BY visitors DESC LIMIT 15`, since),
    all(`SELECT CAST(strftime('%H', at, '+${IST_OFFSET_MIN} minutes') AS INTEGER) AS hour, COUNT(*) AS visits
         FROM visits WHERE day >= ? GROUP BY hour`, since),
    all(`SELECT v.session_id, MAX(v.at) AS last_at, MIN(v.at) AS first_at, COUNT(*) AS views,
                group_concat(v.path, ' → ') AS pages, MAX(v.city) AS city, MAX(v.country) AS country,
                MAX(v.device) AS device, MAX(v.browser) AS browser, MAX(v.referrer) AS referrer,
                MAX(v.utm_source) AS utm_source, MAX(u.email) AS email
         FROM (SELECT * FROM visits WHERE day >= ? AND session_id IS NOT NULL ORDER BY at) v
         LEFT JOIN users u ON u.id = v.user_id
         GROUP BY v.session_id ORDER BY last_at DESC LIMIT 30`, since),
    one(`SELECT
           (SELECT COUNT(DISTINCT visitor) FROM visits WHERE day >= ?) AS visitors,
           (SELECT COUNT(*) FROM users WHERE created_at >= ? AND role != 'demo') AS signups,
           (SELECT COUNT(DISTINCT user_id) FROM payments WHERE provider != 'demo' AND created_at >= ? AND user_id IS NOT NULL) AS checkouts,
           (SELECT COUNT(DISTINCT p.user_id) FROM payments p JOIN users u ON u.id = p.user_id
              WHERE p.status = 'paid' AND p.created_at >= ? AND p.provider != 'demo' AND u.role != 'demo') AS paid`,
      since, since, since, since),
  ]);

  const byDay = new Map(dailyRows.map(r => [r.day, r]));
  const daily = Array.from({ length: days }, (_, i) => {
    const day = new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    return { day, visits: byDay.get(day)?.visits ?? 0, visitors: byDay.get(day)?.visitors ?? 0 };
  });
  const byHour = new Map(hourRows.map(r => [r.hour, r.visits]));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, visits: byHour.get(h) ?? 0 }));

  return {
    days,
    totals: { ...totals, pages_per_session: totals.sessions ? +(totals.visits / totals.sessions).toFixed(1) : 0 },
    compare,
    daily,
    hours,
    pages,
    referrers: direct.visits ? [{ label: null, ...direct }, ...referrers].sort((a, b) => b.visitors - a.visitors).slice(0, 10) : referrers,
    utm,
    devices, browsers, os, countries, cities,
    sessions,
    funnel,
  };
}
