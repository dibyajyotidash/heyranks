/**
 * D1-compatible wrapper around Turso (libSQL), so lib/core.js runs unchanged on Vercel.
 * Supports the D1 calls core.js uses: prepare(sql).bind(...args).first() / .all() / .run()
 */
import { createClient } from "@libsql/client";

let client;

function getClient(env) {
  if (!client) {
    if (!env.TURSO_DATABASE_URL) return null;
    client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
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
