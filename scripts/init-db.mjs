// Creates the HeyRanks tables in Turso. Run once:
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:init
// (or `vercel env pull .env.local` first, then `node --env-file=.env.local scripts/init-db.mjs`)
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
if (!url) { console.error("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) first."); process.exit(1); }

const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const sql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
await db.executeMultiple(sql);
const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log("Tables:", rows.map(r => r.name).join(", "));
