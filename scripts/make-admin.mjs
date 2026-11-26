// Makes an existing HeyRanks account an admin, directly in the database.
// Use it when the email login link can't be sent yet (RESEND_API_KEY not set), so ADMIN_EMAILS can't be confirmed.
// The account must exist first: sign up at /signup with that email.
//
//   Production (Turso): copy TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from Vercel → heyranks → Settings →
//   Environment Variables into a file called .env.local (it's git-ignored), then:
//     node --env-file=.env.local scripts/make-admin.mjs you@example.com
//   Local dev database:
//     npm run make-admin -- you@example.com
import { mkdirSync } from "node:fs";

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!email.includes("@")) { console.error("Usage: node scripts/make-admin.mjs you@example.com"); process.exit(1); }
if (!process.env.TURSO_DATABASE_URL) {
  mkdirSync(".data", { recursive: true });
  process.env.TURSO_DATABASE_URL = "file:.data/dev.db";
}

const { d1 } = await import("../lib/db.js");
const { ensureSchema } = await import("../lib/schema.js");
const { rebuildAllReports } = await import("../lib/reports.js");
const db = d1(process.env);
await ensureSchema(db, rebuildAllReports);

const user = await db.prepare("SELECT id, role FROM users WHERE email = ?").bind(email).first();
if (!user) {
  console.error(`No account for ${email} in ${process.env.TURSO_DATABASE_URL.split("?")[0]}. Sign up at /signup first, then run this again.`);
  process.exit(1);
}
const now = new Date().toISOString();
await db.prepare("UPDATE users SET role = 'admin', email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?")
  .bind(now, now, user.id).run();
console.log(`${email} is now an admin${user.role === "admin" ? " (already was)" : ""}. Log in and open /admin.`);
