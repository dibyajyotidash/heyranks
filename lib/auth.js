/**
 * Accounts: password hashing, sessions, single-use email tokens, rate limiting.
 * Uses only Web Crypto, so it runs unchanged on Cloudflare Workers and Node 20+ (Vercel).
 *
 * Security model
 *   - Passwords: PBKDF2-SHA256, 100k iterations (the Cloudflare Workers maximum), 16-byte salt.
 *   - Sessions: 32 random bytes in an HttpOnly, SameSite=Lax cookie. The DB stores only the SHA-256
 *     of the token, so a database leak doesn't expose live sessions. Logout deletes the row.
 *   - Magic-link / reset tokens: same hashing, single use (atomic UPDATE ... RETURNING), short expiry.
 *   - Admin: role = 'admin' in the DB, or an ADMIN_EMAILS address whose owner has proved the email
 *     (logged in by magic link or reset). A password signup alone never grants admin.
 */
import { HttpError, getCookie, clientIp, isHttps } from "./http.js";

const enc = new TextEncoder();
const SESSION_COOKIE = "hr_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;

const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256 = async s => b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));

// ─── passwords ────────────────────────────────────────────────────────────────

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export function checkPasswordRules(password) {
  const p = String(password || "");
  if (p.length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
  if (p.length > 200) throw new HttpError(400, "That password is too long.");
  return p;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64u(salt)}$${b64u(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

// Used when the email doesn't exist, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || DUMMY_HASH).split("$");
  if (alg !== "pbkdf2" || !salt || !hash) return false;
  const got = await pbkdf2(String(password || ""), fromB64u(salt), Number(iter));
  const want = fromB64u(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0 && !!stored;
}

// ─── sessions ─────────────────────────────────────────────────────────────────

function cookie(request, value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(request) ? "; Secure" : ""}`;
}

/** Creates a session and returns the Set-Cookie header value. */
export async function createSession(db, request, userId) {
  const token = randomToken();
  const now = new Date();
  await db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 864e5).toISOString(),
      clientIp(request), (request.headers.get("user-agent") || "").slice(0, 200)).run();
  await db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now.toISOString(), userId).run();
  return cookie(request, token, SESSION_DAYS * 86400);
}

export async function destroySession(db, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  return cookie(request, "", 0);
}

/** The logged-in user for this request, or null. */
export async function getUser(db, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  return db.prepare(`
    SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'`)
    .bind(await sha256(token), new Date().toISOString()).first();
}

export async function requireUser(db, request) {
  const user = await getUser(db, request);
  if (!user) throw new HttpError(401, "Please log in.");
  return user;
}

export function isAdmin(user, env) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const admins = String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  return !!user.email_verified_at && admins.includes(user.email);
}

export async function requireAdmin(db, request, env) {
  const user = await requireUser(db, request);
  if (!isAdmin(user, env)) throw new HttpError(403, "Admins only.");
  return user;
}

// ─── single-use email tokens ──────────────────────────────────────────────────

export async function createAuthToken(db, userId, purpose, minutes) {
  const token = randomToken();
  const now = Date.now();
  await db.prepare(`INSERT INTO auth_tokens (id, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(await sha256(token), userId, purpose, new Date(now).toISOString(), new Date(now + minutes * 60_000).toISOString()).run();
  return token;
}

/** Marks the token used and returns its user id, or null if it is unknown, expired or already used. */
export async function consumeAuthToken(db, token, purpose) {
  if (!token || String(token).length > 100) return null;
  const now = new Date().toISOString();
  const row = await db.prepare(`
    UPDATE auth_tokens SET used_at = ? WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
    RETURNING user_id`).bind(now, await sha256(String(token)), purpose, now).first();
  return row?.user_id ?? null;
}

// ─── rate limiting ────────────────────────────────────────────────────────────

/** Fixed-window counter. Throws 429 once `key` is hit more than `limit` times in `windowSec`. */
export async function rateLimit(db, key, limit, windowSec, message = "Too many attempts. Please wait a few minutes and try again.") {
  const now = new Date().toISOString();
  const row = await db.prepare(`
    INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET
      count    = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING count`).bind(key, new Date(Date.now() + windowSec * 1000).toISOString(), now, now).first();
  if (row && row.count > limit) throw new HttpError(429, message);
}
