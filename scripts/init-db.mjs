// Creates / migrates the HeyRanks tables. Optional: the API also does this on its first request.
//   node --env-file=.env.local scripts/init-db.mjs        (Turso, after `vercel env pull .env.local`)
//   TURSO_DATABASE_URL=file:.data/dev.db npm run db:init   (local file)
import { d1 } from "../lib/db.js";
import { ensureSchema, SCHEMA_VERSION } from "../lib/schema.js";
import { rebuildAllReports } from "../lib/reports.js";

const db = d1(process.env);
if (!db) { console.error("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) first."); process.exit(1); }

await ensureSchema(db, rebuildAllReports);
const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(`Schema v${SCHEMA_VERSION}. Tables: ${results.map(r => r.name).join(", ")}`);
