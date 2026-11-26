// The pre-accounts schema (customers + weekly reports) must migrate without losing data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Test databases live in the git-ignored .data folder: some system temp paths contain "#", which libSQL reads as a URL fragment.
mkdirSync(".data", { recursive: true });
const dir = mkdtempSync(join(process.cwd(), ".data", "test-mig-"));
process.env.TURSO_DATABASE_URL = `file:${join(dir, "legacy.db").replace(/\\/g, "/")}`;
const { d1 } = await import("../lib/db.js");
const { ensureSchema } = await import("../lib/schema.js");
const { rebuildAllReports } = await import("../lib/reports.js");

test("legacy customers and reports become users, sites, scans and period reports", async () => {
  const db = d1(process.env);
  // The schema as it was before this change (lib/db.js / schema.sql at commit b079511).
  for (const sql of [
    `CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, website TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]',
      plan TEXT NOT NULL DEFAULT '180day', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, expires_at TEXT,
      whatsapp TEXT, last_report_at TEXT)`,
    `CREATE TABLE reports (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), week TEXT NOT NULL,
      score INTEGER NOT NULL, prev_score INTEGER, passed TEXT NOT NULL DEFAULT '[]', issues TEXT NOT NULL DEFAULT '[]',
      speed INTEGER, created_at TEXT NOT NULL, UNIQUE(customer_id, week))`,
    `INSERT INTO customers VALUES ('c1', 'paid@example.com', 'paid.com', '["kw"]', '180day', 'active', '2026-09-01T00:00:00.000Z', '2027-02-28T00:00:00.000Z', '+911234567890', '2026-11-16T06:00:00.000Z')`,
    `INSERT INTO customers VALUES ('c2', 'refunded@example.com', 'gone.com', '[]', '180day', 'refunded', '2026-09-01T00:00:00.000Z', '2027-02-28T00:00:00.000Z', NULL, NULL)`,
    `INSERT INTO reports VALUES ('r1', 'c1', '2026-11-09', 50, NULL, '["Secure HTTPS"]', '[{"id":"ai","label":"AI crawlers allowed","w":15,"fix":"x"}]', 60, '2026-11-09T06:00:00.000Z')`,
    `INSERT INTO reports VALUES ('r2', 'c1', '2026-11-16', 64, 50, '["Secure HTTPS","AI crawlers allowed"]', '[]', 72, '2026-11-16T06:00:00.000Z')`,
  ]) await db.prepare(sql).run();

  await ensureSchema(db, rebuildAllReports);

  const users = (await db.prepare("SELECT email, plan, plan_expires_at, whatsapp FROM users ORDER BY email").all()).results;
  assert.deepEqual(users.map(u => [u.email, u.plan]), [["paid@example.com", "180day"], ["refunded@example.com", "free"]]);
  assert.equal(users[0].whatsapp, "+911234567890");
  const site = await db.prepare("SELECT * FROM sites WHERE user_id = 'c1'").first();
  assert.equal(site.hostname, "paid.com");
  assert.equal(site.keywords, '["kw"]');
  const scans = (await db.prepare("SELECT score, issues_count FROM scans ORDER BY created_at").all()).results;
  assert.deepEqual(scans.map(s => [s.score, s.issues_count]), [[50, 1], [64, 0]]);
  const weekly = (await db.prepare("SELECT score_end FROM reports WHERE period_type = 'weekly' ORDER BY period_start").all()).results;
  assert.deepEqual(weekly.map(r => r.score_end), [50, 64]);
  const month = await db.prepare("SELECT score_start, score_end, issues_resolved FROM reports WHERE period_type = 'monthly'").first();
  assert.deepEqual({ ...month }, { score_start: 50, score_end: 64, issues_resolved: 1 });
  assert.ok(await db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'legacy_customers'").first(), "old data kept for reference");
});
