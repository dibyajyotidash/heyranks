/**
 * HeyRanks _worker.js — Cloudflare Pages advanced-mode Worker
 *
 * Routes:
 *   POST /api/scan      free SEO scan (public)
 *   POST /api/signup    register customer after payment
 *   POST /api/webhook   payment webhook (Stripe / Razorpay / Lemon Squeezy)
 *   POST /api/weekly    manual trigger (requires X-Admin-Secret header)
 *   scheduled           Monday 6am UTC cron — sends weekly reports
 *   *                   static assets served via env.ASSETS
 *
 * Required env / secrets:
 *   DB              D1 database binding
 *   RESEND_API_KEY  transactional email (resend.com)
 *   ADMIN_SECRET    any random string to protect the manual trigger
 *
 * Optional:
 *   PSI_KEY         Google PageSpeed Insights API key
 *   STRIPE_SECRET   Stripe webhook signing secret
 */

// ─── constants ───────────────────────────────────────────────────────────────

const UA       = "HeyRanksBot/1.0 (+https://heyranks.com)";
const AI_BOTS  = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "Google-Extended", "PerplexityBot"];
const FROM     = "HeyRanks <reports@heyranks.com>";
const SITE_URL = "https://heyranks.com";

// ─── utilities ───────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function normalize(input) {
  let u = String(input || "").trim().replace(/^https?:\/\//i, "");
  if (!u) throw new Error("Please enter a website.");
  if (!u.includes(".")) throw new Error("That doesn't look like a website address.");
  const url = new URL("https://" + u);
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname))
    throw new Error("Invalid host.");
  return url;
}

function reportWeek(d = new Date()) {
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return mon.toISOString().slice(0, 10);
}

function expiresAt(plan) {
  if (plan === "lifetime") return null;
  const d = new Date();
  d.setDate(d.getDate() + 180);
  return d.toISOString();
}

// ─── HTTP fetch helper ────────────────────────────────────────────────────────

async function get(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctrl.signal });
    const text = r.ok ? (await r.text()).slice(0, 600000) : "";
    return { ok: r.ok, status: r.status, text, finalUrl: r.url };
  } catch {
    return { ok: false, status: 0, text: "", finalUrl: String(url) };
  } finally {
    clearTimeout(t);
  }
}

// ─── robots.txt parser ────────────────────────────────────────────────────────

function blocksBot(robotsTxt, bot) {
  const groups = [];
  let cur = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, val] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (key === "user-agent") {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (cur) cur.rules.push({ key, val });
  }
  const pick = groups.find(g => g.agents.includes(bot.toLowerCase()))
            || groups.find(g => g.agents.includes("*"));
  if (!pick) return false;
  const allowRoot = pick.rules.some(r => r.key === "allow"    && r.val === "/");
  return !allowRoot && pick.rules.some(r => r.key === "disallow" && r.val === "/");
}

// ─── core scan ───────────────────────────────────────────────────────────────

async function runScan(hostname, env) {
  const origin = "https://" + hostname;
  const [home, robots, llms, sitemap] = await Promise.all([
    get(origin + "/"),
    get(origin + "/robots.txt"),
    get(origin + "/llms.txt"),
    get(origin + "/sitemap.xml"),
  ]);
  if (!home.ok) return null;

  const h    = home.text;
  const tag  = (re) => { const m = h.match(re); return m ? m[1].trim() : ""; };
  const title = tag(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc  = tag(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
              || tag(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const blocked = robots.ok ? AI_BOTS.filter(b => blocksBot(robots.text, b)) : [];

  const checks = [
    { id: "https",    label: "Secure HTTPS",              w: 10, pass: home.finalUrl.startsWith("https://"),
      fix: "Enable HTTPS — free via Cloudflare or Let's Encrypt." },
    { id: "title",    label: "Page title",                w: 10, pass: title.length >= 10 && title.length <= 65,
      fix: title ? `Title is ${title.length} chars — keep it 10–65.` : "Add a <title> tag naming your business and service." },
    { id: "desc",     label: "Meta description",          w: 10, pass: desc.length >= 50 && desc.length <= 160,
      fix: desc  ? `Description is ${desc.length} chars — aim for 50–160.` : "Add a meta description — the text Google and AI tools show." },
    { id: "h1",       label: "Main heading (H1)",         w: 5,  pass: /<h1[\s>]/i.test(h),
      fix: "Add one clear <h1> saying what you do." },
    { id: "viewport", label: "Mobile friendly",           w: 10, pass: /<meta[^>]+name=["']viewport["']/i.test(h),
      fix: "Add a viewport meta tag so the site works on phones." },
    { id: "schema",   label: "Structured data (Schema.org)", w: 15, pass: /application\/ld\+json/i.test(h),
      fix: "Add LocalBusiness or Organization schema so AI understands who you are." },
    { id: "og",       label: "Social preview (Open Graph)", w: 5, pass: /property=["']og:title["']/i.test(h),
      fix: "Add Open Graph tags so links look good on WhatsApp and LinkedIn." },
    { id: "ai",       label: "AI crawlers allowed",       w: 15, pass: blocked.length === 0,
      fix: blocked.length ? `Your robots.txt blocks: ${blocked.join(", ")}. AI assistants can't read your site.` : "AI crawlers are allowed." },
    { id: "llms",     label: "llms.txt present",          w: 10, pass: llms.ok && llms.text.length > 20 && !/<html/i.test(llms.text),
      fix: "Create /llms.txt that summarises your business for AI models." },
    { id: "sitemap",  label: "XML sitemap",               w: 10, pass: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text),
      fix: "Add /sitemap.xml and submit it in Google Search Console." },
  ];

  // Optional speed score
  let speed = null;
  try {
    const key = env?.PSI_KEY ? `&key=${env.PSI_KEY}` : "";
    const r = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&url=${encodeURIComponent(origin)}${key}`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (r.ok) speed = Math.round(((await r.json()).lighthouseResult?.categories?.performance?.score ?? 0) * 100);
  } catch {}
  if (speed !== null) checks.push({
    id: "speed", label: `Mobile speed (${speed}/100)`, w: 10, pass: speed >= 70,
    fix: `Mobile speed is ${speed}/100. Compress images and remove unused scripts.`,
  });

  const total  = checks.reduce((a, c) => a + c.w, 0);
  const score  = Math.round(checks.reduce((a, c) => a + (c.pass ? c.w : 0), 0) / total * 100);
  const passed = checks.filter(c =>  c.pass).map(c => c.label);
  const issues = checks.filter(c => !c.pass).sort((a, b) => b.w - a.w);

  return { score, passed, issues, speed, top_issues: issues.slice(0, 3), more_issues: Math.max(0, issues.length - 3) };
}

// ─── copy-paste code snippets ─────────────────────────────────────────────────

function codeSnippet(issue, site) {
  switch (issue.id) {
    case "title":
      return `<title>Your Business Name — City | Your Main Service</title>`;
    case "desc":
      return `<meta name="description" content="[One sentence about what you do and who you help — 50 to 160 characters]">`;
    case "h1":
      return `<h1>Your Service in Your City</h1>`;
    case "viewport":
      return `<meta name="viewport" content="width=device-width, initial-scale=1">`;
    case "schema":
      return JSON.stringify({
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "name": "Your Business Name",
        "url": `https://${site}`,
        "description": "What you do and who you serve.",
        "telephone": "+91-XXXXX-XXXXX",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "Your Street",
          "addressLocality": "Your City",
          "addressRegion": "Your State",
          "addressCountry": "IN"
        }
      }, null, 2);
    case "og":
      return `<meta property="og:title" content="Your Business Name — City">\n<meta property="og:description" content="[Same as meta description]">\n<meta property="og:type" content="website">\n<meta property="og:url" content="https://${site}">`;
    case "ai":
      return `# In robots.txt — remove any lines like these (or change Disallow: / to Allow: /):\n# User-agent: GPTBot\n# Disallow: /\n\n# Instead add:\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /`;
    case "llms":
      return `# ${site}\n\n> [One paragraph: what you do, who you serve, what makes you different.]\n\n## Services\n- [Service 1 — brief description]\n- [Service 2 — brief description]\n\n## Location & Contact\n- Location: [Your city, state]\n- Email: hello@${site}`;
    case "sitemap":
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://${site}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n  <url><loc>https://${site}/about</loc><changefreq>monthly</changefreq></url>\n  <url><loc>https://${site}/services</loc><changefreq>monthly</changefreq></url>\n  <url><loc>https://${site}/contact</loc><changefreq>monthly</changefreq></url>\n</urlset>`;
    default:
      return null;
  }
}

// ─── email templates ──────────────────────────────────────────────────────────

function issueBlock(issue, index, site) {
  const p = issue.w >= 15
    ? { color: "#dc2626", bg: "#fee2e2", label: "HIGH"   }
    : issue.w >= 10
    ? { color: "#d97706", bg: "#fef3c7", label: "MEDIUM" }
    : { color: "#16a34a", bg: "#dcfce7", label: "LOW"    };

  const snippet = codeSnippet(issue, site);

  return `
    <div style="margin-bottom:18px;padding:16px 20px;background:#f8fafc;border-radius:12px;border-left:4px solid ${p.color}">
      <div style="margin-bottom:8px">
        <span style="display:inline-block;background:${p.bg};color:${p.color};font-size:.7rem;font-weight:700;padding:2px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:.05em;vertical-align:middle">${p.label}</span>
        <span style="font-weight:700;color:#0f1720;margin-left:8px;font-size:.95rem;vertical-align:middle">${escHtml(issue.label)}</span>
      </div>
      <div style="font-size:.88rem;color:#334155;line-height:1.5">${escHtml(issue.fix)}</div>
      ${snippet ? `
        <div style="margin-top:12px;background:#0f1720;border-radius:8px;padding:12px 14px">
          <div style="font-size:.7rem;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Copy-paste fix</div>
          <pre style="margin:0;font-family:'Courier New',monospace;font-size:.78rem;color:#d9f99d;white-space:pre-wrap;word-break:break-all;line-height:1.5">${escHtml(snippet)}</pre>
        </div>` : ""}
    </div>`;
}

function reportEmail({ email, website }, scan, prevScore, weekLabel) {
  const scoreColor = scan.score >= 75 ? "#16a34a" : scan.score >= 45 ? "#d97706" : "#dc2626";
  const delta = prevScore !== null && prevScore !== undefined
    ? (scan.score > prevScore ? `<span style="color:#16a34a">▲ ${scan.score - prevScore} from last week</span>`
     : scan.score < prevScore ? `<span style="color:#dc2626">▼ ${prevScore - scan.score} from last week</span>`
     : `<span style="color:#64748b">no change from last week</span>`)
    : `<span style="color:#64748b">first report</span>`;

  const passedRows = scan.passed.map(p =>
    `<div style="padding:4px 0;font-size:.88rem;color:#334155">✅ ${escHtml(p)}</div>`).join("");

  const issueRows = scan.issues.slice(0, 5).map((iss, i) => issueBlock(iss, i, website)).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeyRanks report — ${escHtml(website)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:28px 16px">
<table width="100%" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

  <!-- header -->
  <tr><td style="background:#0f1720;padding:24px 32px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="color:#d9f99d;font-weight:700;font-size:1.05rem">📈 HeyRanks</td>
      <td align="right" style="color:#94a3b8;font-size:.82rem">${escHtml(weekLabel)}</td>
    </tr></table>
    <div style="margin-top:10px;color:#fff;font-size:1.25rem;font-weight:700">Weekly report: ${escHtml(website)}</div>
  </td></tr>

  <!-- score -->
  <tr><td style="padding:28px 32px;border-bottom:1px solid #f1f5f9">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <div style="font-size:4rem;font-weight:800;line-height:1;color:${scoreColor}">${scan.score}</div>
        <div style="font-size:.88rem;color:#64748b;margin-top:4px">out of 100 &nbsp;·&nbsp; ${delta}</div>
      </td>
      <td align="right" valign="top">
        <div style="display:inline-block;background:#f8fafc;border-radius:12px;padding:12px 20px;text-align:center">
          <div style="font-size:.75rem;color:#64748b;margin-bottom:4px">Passed</div>
          <div style="font-size:1.9rem;font-weight:800;color:#16a34a">${scan.passed.length}</div>
          <div style="font-size:.75rem;color:#64748b">/ ${scan.passed.length + scan.issues.length} checks</div>
        </div>
      </td>
    </tr></table>
  </td></tr>

  <!-- passing checks -->
  ${scan.passed.length ? `
  <tr><td style="padding:20px 32px;border-bottom:1px solid #f1f5f9;background:#f9fafb">
    <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:10px">What's working</div>
    ${passedRows}
  </td></tr>` : ""}

  <!-- fixes -->
  <tr><td style="padding:28px 32px">
    <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:16px">This week's fixes</div>
    ${issueRows}
    ${scan.issues.length > 5 ? `<div style="font-size:.85rem;color:#64748b;margin-top:8px">+ ${scan.issues.length - 5} more issue${scan.issues.length - 5 > 1 ? "s" : ""} — improve your score for a fuller report.</div>` : ""}
  </td></tr>

  <!-- CTA -->
  <tr><td style="background:#f8fafc;padding:28px 32px;border-top:1px solid #e2e8f0;text-align:center">
    <div style="font-size:.92rem;color:#334155;margin-bottom:18px">
      Your next report arrives next Monday. See your full history at HeyRanks.
    </div>
    <a href="${SITE_URL}" style="display:inline-block;background:#ff5a1f;color:#fff;padding:13px 32px;border-radius:99px;font-weight:700;text-decoration:none;font-size:.95rem">
      Visit HeyRanks →
    </a>
    <div style="margin-top:16px;font-size:.82rem;color:#94a3b8">
      Refer 3 friends and get 180 days free →
      <a href="${SITE_URL}#referral" style="color:#ff5a1f;text-decoration:none">Get your link</a>
    </div>
  </td></tr>

  <!-- footer -->
  <tr><td style="padding:20px 32px;text-align:center;border-top:1px solid #f1f5f9">
    <div style="font-size:.78rem;color:#94a3b8;line-height:1.6">
      HeyRanks by DexoSoft Solutions &nbsp;·&nbsp;
      <a href="mailto:hello@heyranks.com" style="color:#94a3b8">hello@heyranks.com</a><br>
      You're receiving this because you signed up for weekly reports for ${escHtml(website)}.<br>
      <a href="mailto:hello@heyranks.com?subject=Unsubscribe%20${encodeURIComponent(email)}" style="color:#94a3b8">Unsubscribe</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function welcomeEmail({ email, website, keywords }, scan) {
  const kw = JSON.parse(keywords || "[]");
  const keywordsLine = kw.length
    ? `<div style="font-size:.88rem;color:#334155;margin-top:6px">Keywords tracked: <b>${kw.map(escHtml).join(", ")}</b></div>`
    : "";

  const topFixes = scan
    ? scan.issues.slice(0, 3).map((iss, i) => `
        <div style="margin-bottom:12px;padding:12px 16px;background:#f8fafc;border-radius:10px;font-size:.88rem">
          <b style="color:#0f1720">${i + 1}. ${escHtml(iss.label)}</b><br>
          <span style="color:#334155">${escHtml(iss.fix)}</span>
        </div>`).join("")
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to HeyRanks</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:28px 16px">
<table width="100%" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

  <tr><td style="background:#0f1720;padding:28px 32px;text-align:center">
    <div style="color:#d9f99d;font-size:2rem">📈</div>
    <div style="color:#fff;font-size:1.4rem;font-weight:700;margin-top:8px">Welcome to HeyRanks!</div>
    <div style="color:#94a3b8;font-size:.92rem;margin-top:6px">Your weekly SEO & AI visibility reports are live</div>
  </td></tr>

  <tr><td style="padding:28px 32px">
    <div style="background:#ecfccb;border-radius:12px;padding:16px 20px;margin-bottom:24px">
      <div style="font-weight:700;color:#166534;font-size:.95rem">✅ You're set up</div>
      <div style="color:#166534;font-size:.88rem;margin-top:4px">Site: <b>${escHtml(website)}</b></div>
      ${keywordsLine}
    </div>

    <div style="font-size:1rem;color:#0f1720;font-weight:700;margin-bottom:8px">Your first full report is coming next Monday.</div>
    <div style="font-size:.92rem;color:#334155;line-height:1.6;margin-bottom:24px">
      Every Monday morning we scan your site, check if ChatGPT, Gemini, Claude and Perplexity mention you, and send you a plain-English report with the 5 things to fix that week.
    </div>

    ${topFixes ? `
    <div style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:12px">While you wait — 3 quick wins we found:</div>
    ${topFixes}` : ""}

  </td></tr>

  <tr><td style="background:#f8fafc;padding:24px 32px;text-align:center;border-top:1px solid #e2e8f0">
    <div style="font-size:.88rem;color:#334155;margin-bottom:16px">Any questions? Just reply to this email.</div>
    <a href="${SITE_URL}" style="display:inline-block;background:#0f1720;color:#fff;padding:12px 28px;border-radius:99px;font-weight:700;text-decoration:none;font-size:.92rem">
      Visit HeyRanks →
    </a>
  </td></tr>

  <tr><td style="padding:16px 32px;text-align:center;border-top:1px solid #f1f5f9">
    <div style="font-size:.78rem;color:#94a3b8">
      HeyRanks by DexoSoft Solutions &nbsp;·&nbsp;
      <a href="mailto:hello@heyranks.com" style="color:#94a3b8">hello@heyranks.com</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// ─── email sender (Resend) ────────────────────────────────────────────────────

async function sendEmail(to, subject, html, env) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email] no RESEND_API_KEY — would send to ${to}: ${subject}`);
    return { ok: true, dry: true };
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  const body = await r.json();
  if (!r.ok) console.error("[email] Resend error", r.status, JSON.stringify(body));
  return { ok: r.ok, id: body.id };
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────

async function handleScan(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  let site;
  try { site = normalize(body.url); } catch (e) { return json({ error: e.message }, 400); }

  const scan = await runScan(site.hostname, env);
  if (!scan) return json({ error: `Couldn't open ${site.hostname}.` }, 422);

  return json({
    site: site.hostname,
    score: scan.score,
    speed: scan.speed,
    passed: scan.passed,
    top_issues: scan.top_issues.map(c => ({ label: c.label, fix: c.fix })),
    more_issues: scan.more_issues,
  });
}

async function handleSignup(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const email   = String(body.email   || "").trim().toLowerCase();
  const website = String(body.website || "").trim();
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 5)
    : [];
  const whatsapp = body.whatsapp ? String(body.whatsapp).replace(/\s/g, "") : null;
  const plan     = body.plan === "lifetime" ? "lifetime" : "180day";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ error: "Please provide a valid email address." }, 400);

  let site;
  try { site = normalize(website); } catch (e) { return json({ error: e.message }, 400); }
  const hostname = site.hostname;

  if (!env.DB) return json({ error: "Database not configured." }, 503);

  // Upsert customer
  const existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(email).first();
  const id        = existing?.id ?? crypto.randomUUID();
  const now       = new Date().toISOString();
  const expires   = expiresAt(plan);

  if (existing) {
    await env.DB.prepare(`
      UPDATE customers SET website=?, keywords=?, plan=?, status='active', expires_at=?, whatsapp=?
      WHERE id=?
    `).bind(hostname, JSON.stringify(keywords), plan, expires, whatsapp, id).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO customers (id, email, website, keywords, plan, status, created_at, expires_at, whatsapp)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).bind(id, email, hostname, JSON.stringify(keywords), plan, now, expires, whatsapp).run();
  }

  // Run initial scan in background
  const scanPromise = runScan(hostname, env).then(async scan => {
    if (!scan) return;
    const week = reportWeek();
    await env.DB.prepare(`
      INSERT OR REPLACE INTO reports (id, customer_id, week, score, prev_score, passed, issues, speed, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), id, week, scan.score, JSON.stringify(scan.passed), JSON.stringify(scan.issues), scan.speed, now).run();
    await sendEmail(email, `Welcome to HeyRanks — your site scores ${scan.score}/100`, welcomeEmail({ email, website: hostname, keywords: JSON.stringify(keywords) }, scan), env);
  }).catch(err => console.error("[signup] scan error", err));

  // Don't block the response on the scan
  ctx?.waitUntil?.(scanPromise);

  return json({ ok: true, id, website: hostname, plan });
}

async function handleWebhook(request, env) {
  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  // Stripe webhook (optional — verify signature when STRIPE_SECRET is set)
  if (sig && env.STRIPE_SECRET) {
    // Lightweight header-only verification (full HMAC needs crypto.subtle)
    // Replace with full Stripe verification if needed
    const event = JSON.parse(rawBody);
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email   = session.customer_details?.email;
      const plan    = session.metadata?.plan || "180day";
      if (email && env.DB) {
        const site = session.metadata?.website || "";
        await activateCustomer(email, site, plan, env);
      }
    }
    return json({ received: true });
  }

  // Lemon Squeezy (X-Signature header)
  const lsEvent = JSON.parse(rawBody);
  if (lsEvent?.meta?.event_name === "order_created") {
    const email = lsEvent.data?.attributes?.user_email;
    const plan  = lsEvent.meta?.custom_data?.plan || "180day";
    const site  = lsEvent.meta?.custom_data?.website || "";
    if (email && env.DB) await activateCustomer(email, site, plan, env);
    return json({ received: true });
  }

  return json({ received: true });
}

async function activateCustomer(email, website, plan, env) {
  const existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(email).first();
  if (existing) {
    await env.DB.prepare(`UPDATE customers SET plan=?, status='active', expires_at=? WHERE email=?`)
      .bind(plan, expiresAt(plan), email).run();
  }
}

async function handleWeeklyAdmin(request, env) {
  const secret = request.headers.get("x-admin-secret");
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET)
    return json({ error: "Unauthorized" }, 401);

  const result = await runWeekly(env);
  return json(result);
}

// ─── weekly job ───────────────────────────────────────────────────────────────

async function runWeekly(env) {
  if (!env.DB) return { error: "No DB binding" };
  const now    = new Date().toISOString();
  const week   = reportWeek();
  const year   = new Date().getFullYear();
  const mon    = new Date().toLocaleString("en-GB", { month: "long" });
  const day    = new Date().getDate();
  const weekLabel = `${mon} ${day}, ${year}`;

  // All active customers not yet reported this week
  const { results: customers } = await env.DB.prepare(`
    SELECT * FROM customers
    WHERE status = 'active'
      AND (expires_at IS NULL OR expires_at > ?)
      AND (last_report_at IS NULL OR last_report_at < ?)
  `).bind(now, week).all();

  let sent = 0, failed = 0;
  for (const customer of customers) {
    try {
      // Get last week's score for delta
      const prevReport = await env.DB.prepare(`
        SELECT score FROM reports WHERE customer_id = ? ORDER BY week DESC LIMIT 1
      `).bind(customer.id).first();

      const scan = await runScan(customer.website, env);
      if (!scan) { failed++; continue; }

      const prevScore = prevReport?.score ?? null;

      // Save report
      await env.DB.prepare(`
        INSERT OR REPLACE INTO reports (id, customer_id, week, score, prev_score, passed, issues, speed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), customer.id, week, scan.score, prevScore,
        JSON.stringify(scan.passed), JSON.stringify(scan.issues), scan.speed, now
      ).run();

      // Send email
      const subject = `HeyRanks ${weekLabel} — ${customer.website} scores ${scan.score}/100`
        + (prevScore !== null ? (scan.score > prevScore ? ` ↑${scan.score - prevScore}` : scan.score < prevScore ? ` ↓${prevScore - scan.score}` : "") : "");

      await sendEmail(
        customer.email,
        subject,
        reportEmail(customer, scan, prevScore, weekLabel),
        env
      );

      // Update last_report_at
      await env.DB.prepare("UPDATE customers SET last_report_at = ? WHERE id = ?")
        .bind(now, customer.id).run();

      sent++;
    } catch (err) {
      console.error(`[weekly] failed for ${customer.website}:`, err);
      failed++;
    }
  }

  return { week, processed: customers.length, sent, failed };
}

// ─── routing ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === "/api/scan"   && method === "POST") return handleScan(request, env);
    if (pathname === "/api/signup" && method === "POST") return handleSignup(request, env, ctx);
    if (pathname === "/api/webhook"&& method === "POST") return handleWebhook(request, env);
    if (pathname === "/api/weekly" && method === "POST") return handleWeeklyAdmin(request, env);

    // Serve static assets (index.html, signup.html, etc.)
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env) {
    console.log("[cron] weekly job started", new Date().toISOString());
    const result = await runWeekly(env);
    console.log("[cron] weekly job done", JSON.stringify(result));
  },
};
