/**
 * D1-compatible wrapper around Turso (libSQL), so lib/core.js runs unchanged on Vercel.
 * Supports the D1 calls core.js uses: prepare(sql).bind(...args).first() / .all() / .run()
 */
import { createClient } from "@libsql/client";

// Same tables as schema.sql. Created automatically on first use (IF NOT EXISTS
// makes this safe to run on every cold start), so no manual setup step is needed.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  website TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  plan TEXT NOT NULL DEFAULT '180day',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  whatsapp TEXT,
  last_report_at TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  week TEXT NOT NULL,
  score INTEGER NOT NULL,
  prev_score INTEGER,
  passed TEXT NOT NULL DEFAULT '[]',
  issues TEXT NOT NULL DEFAULT '[]',
  speed INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(customer_id, week)
);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_reports_customer ON reports(customer_id);
`;

let client;
let ready;

function getClient(env) {
  if (!client) {
    if (!env.TURSO_DATABASE_URL) return null;
    const c = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
    // Wrap execute so every query waits for the schema to exist first.
    client = {
      execute: async q => {
        ready ??= c.executeMultiple(SCHEMA).catch(e => { ready = undefined; throw e; });
        await ready;
        return c.execute(q);
      },
    };
  }
  return client;
}

function toObjects(rs) {
  return rs.rows.map(row => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));
}

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args.map(a => (a === undefined ? null : a))); }
  async all()   { return { results: toObjects(await this.db.execute({ sql: this.sql, args: this.args })), success: true }; }
  async first() { return (await this.all()).results[0] ?? null; }
  async run()   {
    const rs = await this.db.execute({ sql: this.sql, args: this.args });
    return { success: true, meta: { changes: rs.rowsAffected } };
  }
}

/** Returns a D1-like object, or null if Turso isn't configured. */
export function d1(env) {
  const db = getClient(env);
  return db ? { prepare: sql => new Statement(db, sql) } : null;
}
