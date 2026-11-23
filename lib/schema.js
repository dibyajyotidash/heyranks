/**
 * HeyRanks database schema and migrations. This file is the single source of truth.
 * Works on Cloudflare D1 and Turso/libSQL (both SQLite) through the D1-style API.
 *
 * Tables
 *   users          one row per account (login, profile, plan)
 *   sessions       logged-in browsers. id = SHA-256 of the cookie token, so a DB leak can't hijack sessions
 *   auth_tokens    single-use magic-link and password-reset tokens (hashed the same way)
 *   sites          websites a user tracks (Free/180-day: 1, Lifetime: 3)
 *   scans          every raw scan result: signup, weekly, manual rescan
 *   reports        roll-ups of scans per period: weekly, monthly, quarterly, half_yearly, yearly.
 *                  Upserted after every scan, so the current period is always live.
 *   payments       every verified payment (webhook or manual entry by an admin), source of revenue stats
 *   rate_limits    fixed-window counters for login/scan abuse protection and unique-visit counting
 *   page_views     daily visit counts per public page (no IPs or personal data stored)
 *   meta           schema_version
 *
 *   users 1─* sites 1─* scans
 *                  1─* reports
 *   users 1─* sessions, auth_tokens, payments
 *
 * Dates are ISO-8601 UTC strings ("2026-11-23T06:00:00.000Z"); period bounds are "YYYY-MM-DD"
 * (start inclusive, end exclusive), so plain string comparison works for range queries.
 *
 * Migrations run automatically on the first request of each server instance (see ensureSchema).
 * To change the schema later: append a new function to MIGRATIONS. Never edit an old one.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE,
    name              TEXT,
    company           TEXT,
    whatsapp          TEXT,
    password_hash     TEXT,                              -- pbkdf2$iter$salt$hash, NULL = magic-link only
    role              TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
    status            TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'disabled'
    plan              TEXT NOT NULL DEFAULT 'free',      -- 'free' | '180day' | 'lifetime'
    plan_expires_at   TEXT,                              -- NULL for free and lifetime
    email_verified_at TEXT,                              -- set when the user proves the email (magic link / reset)
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    last_login_at     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL,                           -- 'magic' | 'reset'
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sites (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hostname        TEXT NOT NULL,
    keywords        TEXT NOT NULL DEFAULT '[]',          -- JSON array, max 5
    status          TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'paused'
    created_at      TEXT NOT NULL,
    last_scan_at    TEXT,
    last_weekly_at  TEXT,                                -- weekly job idempotency marker
    UNIQUE (user_id, hostname)
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id            TEXT PRIMARY KEY,
    site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                         -- 'first' | 'weekly' | 'manual' | 'legacy' | 'demo'
    score         INTEGER NOT NULL,
    speed         INTEGER,
    checks_count  INTEGER NOT NULL DEFAULT 0,
    issues_count  INTEGER NOT NULL DEFAULT 0,
    passed        TEXT NOT NULL DEFAULT '[]',            -- JSON array of labels
    issues        TEXT NOT NULL DEFAULT '[]',            -- JSON array of {id,label,w,fix}
    created_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id               TEXT PRIMARY KEY,
    site_id          TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_type      TEXT NOT NULL,                      -- 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly'
    period_start     TEXT NOT NULL,                      -- YYYY-MM-DD inclusive
    period_end       TEXT NOT NULL,                      -- YYYY-MM-DD exclusive
    scans_count      INTEGER NOT NULL,
    score_start      INTEGER NOT NULL,                   -- last score before the period (or first in it)
    score_end        INTEGER NOT NULL,
    score_avg        INTEGER NOT NULL,
    score_min        INTEGER NOT NULL,
    score_max        INTEGER NOT NULL,
    speed_avg        INTEGER,
    issues_resolved  INTEGER NOT NULL DEFAULT 0,
    issues_new       INTEGER NOT NULL DEFAULT 0,
    issues_open      INTEGER NOT NULL DEFAULT 0,
    summary          TEXT NOT NULL DEFAULT '{}',         -- JSON: trend, resolved, new, open, persistent
    emailed_at       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (site_id, period_type, period_start)
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
    email         TEXT NOT NULL,
    provider      TEXT NOT NULL,                         -- 'stripe' | 'razorpay' | 'lemonsqueezy' | 'manual'
    provider_ref  TEXT NOT NULL,
    plan          TEXT NOT NULL,
    amount        INTEGER NOT NULL DEFAULT 0,            -- minor units (cents / paise)
    currency      TEXT NOT NULL DEFAULT 'USD',
    status        TEXT NOT NULL DEFAULT 'paid',          -- 'paid' | 'refunded'
    applied_at    TEXT,                                  -- when the plan was granted to a user
    created_at    TEXT NOT NULL,
    UNIQUE (provider, provider_ref)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key       TEXT PRIMARY KEY,
    count     INTEGER NOT NULL,
    reset_at  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS page_views (
    day       TEXT NOT NULL,                             -- YYYY-MM-DD
    path      TEXT NOT NULL,
    views     INTEGER NOT NULL DEFAULT 0,
    visitors  INTEGER NOT NULL DEFAULT 0,                -- unique per IP per day (IP never stored here)
    PRIMARY KEY (day, path)
  )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_users_created     ON users(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_expires    ON auth_tokens(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sites_user        ON sites(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scans_site_time   ON scans(site_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_scans_time        ON scans(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_site      ON reports(site_id, period_type, period_start)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_unsent    ON reports(period_type, emailed_at, period_end)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_email    ON payments(email)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_time     ON payments(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at)`,
];

async function tableExists(db, name) {
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first());
}

async function runAll(db, statements) {
  for (const sql of statements) await db.prepare(sql).run();
}

const MIGRATIONS = [
  // v1: accounts + period reports. Moves the pre-accounts tables (customers, reports) aside and copies their data.
  async db => {
    const legacy = await tableExists(db, "customers");
    if (legacy) {
      // Old "reports" had one row per customer-week; the new "reports" table has a different shape.
      if (await tableExists(db, "reports")) await db.prepare("ALTER TABLE reports RENAME TO legacy_reports").run();
      await db.prepare("ALTER TABLE customers RENAME TO legacy_customers").run();
    }
    await runAll(db, TABLES);
    await runAll(db, INDEXES);
    if (!legacy) return;

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT OR IGNORE INTO users (id, email, whatsapp, plan, plan_expires_at, created_at, updated_at)
      SELECT id, email, whatsapp,
             CASE WHEN status = 'active' THEN plan ELSE 'free' END,
             CASE WHEN status = 'active' THEN expires_at ELSE NULL END,
             created_at, ?
      FROM legacy_customers`).bind(now).run();
    await db.prepare(`
      INSERT OR IGNORE INTO sites (id, user_id, hostname, keywords, created_at, last_scan_at, last_weekly_at)
      SELECT id, id, website, keywords, created_at, last_report_at, last_report_at FROM legacy_customers`).run();
    if (await tableExists(db, "legacy_reports")) {
      await db.prepare(`
        INSERT OR IGNORE INTO scans (id, site_id, user_id, kind, score, speed, checks_count, issues_count, passed, issues, created_at)
        SELECT id, customer_id, customer_id, 'legacy', score, speed,
               json_array_length(passed) + json_array_length(issues), json_array_length(issues),
               passed, issues, created_at
        FROM legacy_reports`).run();
    }
    // Period reports for the copied scans are rebuilt by ensureSchema's caller (needs lib/reports.js).
    return { rebuildAll: true };
  },

  // v2: Cashfree checkout. A Cashfree order is a payments row from the moment it's created:
  //   status 'pending' (order open) -> 'paid' (Cashfree's API says PAID) | 'failed' (expired)
  //   -> 'refunded' (refund webhook). Only 'paid' rows count anywhere (revenue, plans).
  //   session_id = Cashfree payment_session_id, reused if the user clicks "Pay" again.
  async db => {
    await db.prepare("ALTER TABLE payments ADD COLUMN session_id TEXT").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, status)").run();
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

let ready;

/**
 * Brings the database up to SCHEMA_VERSION. Cheap after the first call (one cached promise per instance).
 * onRebuild(db) is called when a migration imported legacy scans that need period reports.
 */
export function ensureSchema(db, onRebuild) {
  ready ??= migrate(db, onRebuild).catch(err => { ready = undefined; throw err; });
  return ready;
}

async function migrate(db, onRebuild) {
  await db.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const result = await MIGRATIONS[version](db);
    version++;
    await db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(version)).run();
    if (result?.rebuildAll && onRebuild) await onRebuild(db);
  }
}
