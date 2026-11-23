/**
 * D1-compatible wrapper around Turso (libSQL), so the same code runs on Vercel and locally.
 * Supports the D1 calls the app uses: prepare(sql).bind(...args).first() / .all() / .run()
 * Tables are created by lib/schema.js (ensureSchema runs on the first API request).
 *
 * TURSO_DATABASE_URL can be a remote libsql:// URL or a local file (file:.data/dev.db).
 */
import { createClient } from "@libsql/client";

let client;

function getClient(env) {
  if (!client && env.TURSO_DATABASE_URL) {
    client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  }
  return client ?? null;
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
