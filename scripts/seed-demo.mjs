// Seeds demo data so the dashboards have something to show: a demo login with 70 weeks of
// scan history (so weekly → yearly reports are all populated) plus demo users and payments for
// the admin view. Everything is tagged (role 'demo', provider 'demo', scan kind 'demo'), excluded
// from the public counters and the jobs, and hidden in the admin view unless "Include demo data" is on.
// Re-running replaces the previous demo data.
//
//   npm run seed:demo                    local dev DB (.data/dev.db)
//   npm run seed:demo -- --remove        delete demo data only
//   ... --allow-remote                   required to touch a non-file (Turso) database
//
// Demo login: demo@heyranks.com / demo-password
import { mkdirSync } from "node:fs";

if (!process.env.TURSO_DATABASE_URL) {
  mkdirSync(".data", { recursive: true });
  process.env.TURSO_DATABASE_URL = "file:.data/dev.db";
}
const local = process.env.TURSO_DATABASE_URL.startsWith("file:");
if (!local && !process.argv.includes("--allow-remote")) {
  console.error("Refusing to seed a remote database. Pass --allow-remote if you really mean it.");
  process.exit(1);
}

const { d1 } = await import("../lib/db.js");
const { ensureSchema } = await import("../lib/schema.js");
const { rebuildReports, rebuildAllReports } = await import("../lib/reports.js");
const { hashPassword } = await import("../lib/auth.js");

const db = d1(process.env);
await ensureSchema(db, rebuildAllReports);
const DAY = 864e5;
const iso = t => new Date(t).toISOString();
const run = (sql, ...args) => db.prepare(sql).bind(...args).run();

// Deterministic randomness so every seed looks the same.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

// ─── remove old demo data ─────────────────────────────────────────────────────
const demoIds = (await db.prepare("SELECT id FROM users WHERE role = 'demo'").all()).results.map(r => r.id);
for (const id of demoIds) {
  for (const t of ["reports", "scans", "sites", "sessions", "auth_tokens"]) await run(`DELETE FROM ${t} WHERE user_id = ?`, id);
  await run("DELETE FROM users WHERE id = ?", id);
}
await run("DELETE FROM payments WHERE provider = 'demo'");
await run("DELETE FROM visits WHERE session_id LIKE 'demo%'");
console.log(`Removed ${demoIds.length} demo users.`);
if (process.argv.includes("--remove")) process.exit(0);

// ─── the demo login ───────────────────────────────────────────────────────────
const CHECKS = [
  { id: "https",    label: "Secure HTTPS",                 w: 10, fix: "Enable HTTPS — free via Cloudflare or Let's Encrypt." },
  { id: "title",    label: "Page title",                   w: 10, fix: "Title is 78 chars — keep it 10–65." },
  { id: "desc",     label: "Meta description",             w: 10, fix: "Add a meta description — the text Google and AI tools show." },
  { id: "h1",       label: "Main heading (H1)",            w: 5,  fix: "Add one clear <h1> saying what you do." },
  { id: "viewport", label: "Mobile friendly",              w: 10, fix: "Add a viewport meta tag so the site works on phones." },
  { id: "schema",   label: "Structured data (Schema.org)", w: 15, fix: "Add LocalBusiness or Organization schema so AI understands who you are." },
  { id: "og",       label: "Social preview (Open Graph)",  w: 5,  fix: "Add Open Graph tags so links look good on WhatsApp and LinkedIn." },
  { id: "ai",       label: "AI crawlers allowed",          w: 15, fix: "Your robots.txt blocks: GPTBot, ClaudeBot. AI assistants can't read your site." },
  { id: "llms",     label: "llms.txt present",             w: 10, fix: "Create /llms.txt that summarises your business for AI models." },
  { id: "sitemap",  label: "XML sitemap",                  w: 10, fix: "Add /sitemap.xml and submit it in Google Search Console." },
];

/**
 * Builds one scan, scored like runScan, from: the week each check gets fixed (99 = never),
 * weeks a check broke again ({ id: [fromWeek, toWeek] }), and the speed for that week.
 */
function makeScan(week, fixedAt, speed, broken = {}) {
  const isBroken = id => broken[id] && week >= broken[id][0] && week <= broken[id][1];
  const checks = CHECKS.map(c => ({ ...c, pass: week >= (fixedAt[c.id] ?? 0) && !isBroken(c.id) }));
  checks.push({ id: "speed", label: `Mobile speed (${speed}/100)`, w: 10, pass: speed >= 70,
    fix: `Mobile speed is ${speed}/100. Compress images and remove unused scripts.` });
  const scored = checks.filter(c => c.id !== "speed"); // same rule as runScan: speed is shown, not scored
  const total = scored.reduce((a, c) => a + c.w, 0);
  const score = Math.round(scored.reduce((a, c) => a + (c.pass ? c.w : 0), 0) / total * 100);
  const passed = checks.filter(c => c.pass).map(c => c.label);
  const issues = checks.filter(c => !c.pass).sort((a, b) => b.w - a.w).map(({ id, label, w, fix }) => ({ id, label, w, fix }));
  return { score, speed, passed, issues };
}

async function addSite(userId, hostname, weeks, fixedAt, speedFrom, speedTo, regress, broken) {
  const siteId = crypto.randomUUID();
  const lastMonday = (() => { const d = new Date(); d.setUTCHours(6, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime(); })();
  const start = lastMonday - (weeks - 1) * 7 * DAY;
  await run(`INSERT INTO sites (id, user_id, hostname, keywords, created_at, last_scan_at, last_weekly_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    siteId, userId, hostname, JSON.stringify(["dentist near me", "teeth cleaning", "root canal cost"]), iso(start - DAY), iso(lastMonday), iso(lastMonday));
  let n = 0;
  for (let w = 0; w < weeks; w++) {
    let speed = Math.round(speedFrom + (speedTo - speedFrom) * (w / (weeks - 1)) + (rand() - 0.5) * 10);
    if (regress && w >= regress[0] && w <= regress[1]) speed -= 25; // a heavy plugin slowed the site down for a few weeks
    speed = Math.max(15, Math.min(98, speed));
    const times = [start + w * 7 * DAY];
    if (rand() < 0.25) times.push(times[0] + Math.floor(2 + rand() * 3) * DAY + 5 * 3600e3); // occasional manual rescan
    for (const t of times) {
      const s = makeScan(w, fixedAt, speed, broken);
      await run(`INSERT INTO scans (id, site_id, user_id, kind, score, speed, checks_count, issues_count, passed, issues, created_at)
        VALUES (?, ?, ?, 'demo', ?, ?, ?, ?, ?, ?, ?)`, crypto.randomUUID(), siteId, userId, s.score, s.speed,
        s.passed.length + s.issues.length, s.issues.length, JSON.stringify(s.passed), JSON.stringify(s.issues), iso(t));
      n++;
    }
  }
  const written = await rebuildReports(db, { id: siteId, user_id: userId });
  // Closed periods look like they were emailed when they ended.
  await run(`UPDATE reports SET emailed_at = period_end || 'T06:00:00.000Z' WHERE site_id = ? AND period_end <= ?`, siteId, iso(Date.now()).slice(0, 10));
  console.log(`  ${hostname}: ${n} scans, ${written} period reports`);
}

const now = Date.now();
const demoId = crypto.randomUUID();
await run(`INSERT INTO users (id, email, name, company, password_hash, role, plan, email_verified_at, created_at, updated_at)
  VALUES (?, 'demo@heyranks.com', 'Priya (demo)', 'Sunrise Dental (demo)', ?, 'demo', 'lifetime', ?, ?, ?)`,
  demoId, await hashPassword("demo-password"), iso(now - 500 * DAY), iso(now - 500 * DAY), iso(now));
console.log("Demo login: demo@heyranks.com / demo-password");
await addSite(demoId, "sunrise-dental.example", 70,
  { https: 0, viewport: 0, h1: 3, title: 6, desc: 10, sitemap: 15, og: 20, ai: 26, schema: 34, llms: 99 }, 38, 84, [57, 61],
  { ai: [66, 69] }); // a site update re-blocked GPTBot in the last few weeks: shows up as a new problem
await addSite(demoId, "sunrise-smiles.example", 20,
  { https: 0, viewport: 0, title: 0, h1: 2, desc: 5, sitemap: 8, ai: 12, og: 99, schema: 99, llms: 99 }, 52, 71, null);

// ─── demo customers + payments for the admin view ─────────────────────────────
const NAMES = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Sara", "Vikram", "Anya", "Ishaan", "Nisha", "Arjun", "Zoya", "Dev", "Tara", "Kiran"];
let payments = 0;
for (let i = 0; i < 60; i++) {
  const created = now - Math.floor(rand() ** 0.7 * 90) * DAY - Math.floor(rand() * 86400e3);
  const r = rand();
  const plan = r < 0.55 ? "free" : r < 0.9 ? "180day" : "lifetime";
  const id = crypto.randomUUID();
  const name = `${NAMES[i % NAMES.length]} (demo)`;
  await run(`INSERT INTO users (id, email, name, role, plan, plan_expires_at, email_verified_at, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, 'demo', ?, ?, ?, ?, ?, ?)`, id, `demo${i + 1}@example.com`, name, plan,
    plan === "180day" ? iso(created + 180 * DAY) : null, iso(created), iso(created), iso(created), iso(created + rand() * (now - created)));
  if (plan !== "free") {
    await run(`INSERT INTO payments (id, user_id, email, provider, provider_ref, plan, amount, currency, status, applied_at, created_at)
      VALUES (?, ?, ?, 'demo', ?, ?, ?, 'INR', 'paid', ?, ?)`, crypto.randomUUID(), id, `demo${i + 1}@example.com`,
      crypto.randomUUID(), plan, plan === "lifetime" ? 414900 : 84900, iso(created), iso(created));
    payments++;
  }
}
console.log(`  60 demo customers, ${payments} demo payments`);

// Visit counts can't be tagged as demo, so they're only seeded into a local dev database.
if (local) {
  const pages = [["/", 1], ["/signup", 0.18], ["/login", 0.1], ["/privacy", 0.02], ["/terms", 0.02]];
  for (let d = 89; d >= 0; d--) {
    const day = iso(now - d * DAY).slice(0, 10);
    const base = 40 + (89 - d) * 1.4 + (rand() - 0.5) * 30;
    for (const [path, share] of pages) {
      const visitors = Math.max(0, Math.round(base * share));
      await run(`INSERT INTO page_views (day, path, views, visitors) VALUES (?, ?, ?, ?)
        ON CONFLICT (day, path) DO UPDATE SET views = excluded.views, visitors = excluded.visitors`,
        day, path, Math.round(visitors * 1.4), visitors);
    }
  }
  console.log("  90 days of page visits (local only)");

  // Detailed visits for Admin → Visitors. Session ids start with "demo" so a re-seed replaces them.
  const pick = list => { let r = rand() * list.reduce((a, [, w]) => a + w, 0); for (const [v, w] of list) if ((r -= w) <= 0) return v; return list[0][0]; };
  const REFERRERS = [[null, 40], ["google.com", 25], ["chatgpt.com", 8], ["instagram.com", 8], ["linkedin.com", 6], ["facebook.com", 5], ["perplexity.ai", 4], ["bing.com", 4]];
  const UTM = [[null, 85], [["instagram", "social", "launch"], 6], [["google", "cpc", "seo-reports"], 5], [["whatsapp", "share", null], 4]];
  const DEVICES = [[["Mobile", "Chrome", "Android", 412], 44], [["Mobile", "Safari", "iOS", 390], 18], [["Desktop", "Chrome", "Windows", 1536], 22],
                   [["Desktop", "Edge", "Windows", 1920], 5], [["Desktop", "Safari", "macOS", 1440], 6], [["Tablet", "Safari", "iOS", 820], 5]];
  const PLACES = [[["IN", "OD", "Bhubaneswar", "Asia/Kolkata"], 18], [["IN", "MH", "Mumbai", "Asia/Kolkata"], 16], [["IN", "KA", "Bengaluru", "Asia/Kolkata"], 15],
                  [["IN", "DL", "Delhi", "Asia/Kolkata"], 12], [["IN", "TG", "Hyderabad", "Asia/Kolkata"], 8], [["IN", "WB", "Kolkata", "Asia/Kolkata"], 6],
                  [["IN", "MH", "Pune", "Asia/Kolkata"], 5], [["US", "CA", "San Francisco", "America/Los_Angeles"], 5], [["AE", "DU", "Dubai", "Asia/Dubai"], 5],
                  [["GB", "ENG", "London", "Europe/London"], 4], [["SG", null, "Singapore", "Asia/Singapore"], 3], [["AU", "NSW", "Sydney", "Australia/Sydney"], 3]];
  const HOURS_IST = [1, 1, 1, 1, 1, 2, 3, 5, 7, 9, 11, 12, 12, 11, 10, 9, 9, 10, 12, 14, 14, 11, 7, 3].map((w, h) => [h, w]);
  const JOURNEYS = [[["/"], 50], [["/", "/signup"], 18], [["/", "/login"], 8], [["/", "/privacy"], 4], [["/signup"], 6], [["/", "/signup", "/login"], 4], [["/login"], 10]];
  const rows = [];
  for (let d = 89; d >= 0; d--) {
    const sessionsToday = Math.round((30 + (89 - d) * 1.1) * (0.8 + rand() * 0.4));
    for (let s = 0; s < sessionsToday; s++) {
      const [device, browser, os, width] = pick(DEVICES);
      const [country, region, city, tz] = pick(PLACES);
      const utm = pick(UTM);
      const referrer = utm?.[0] === "instagram" ? "instagram.com" : pick(REFERRERS);
      const sid = "demo" + Math.floor(rand() * 1e12).toString(36) + s;
      const visitor = Math.floor(rand() * 2 ** 52).toString(16).padStart(16, "0");
      // A time on that day (UTC) whose India-time hour follows a typical daily curve.
      let t = Date.parse(iso(now - d * DAY).slice(0, 10) + "T00:00:00Z") + (pick(HOURS_IST) * 60 - 330 + rand() * 50) * 60e3;
      if (t > now) t = now - rand() * 3600e3;
      pick(JOURNEYS).forEach((path, i) => {
        const at = new Date(t + i * (20 + rand() * 90) * 1000).toISOString();
        rows.push([at, at.slice(0, 10), sid, visitor, path, i ? null : referrer, i ? null : utm?.[0] ?? null, i ? null : utm?.[1] ?? null,
          i ? null : utm?.[2] ?? null, country, region, city, device, browser, os, width, country === "IN" ? "en-IN" : "en-US", tz]);
      });
    }
  }
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await db.prepare(`INSERT INTO visits (at, day, session_id, visitor, path, referrer, utm_source, utm_medium, utm_campaign,
      country, region, city, device, browser, os, screen_width, language, timezone) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`)
      .bind(...chunk.flat()).run();
  }
  console.log(`  ${rows.length} detailed visits for Admin → Visitors (local only)`);
}
console.log("Done.");
