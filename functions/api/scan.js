// HeyRanks free scan — Cloudflare Pages Function (POST /api/scan  body: {"url":"example.com"})
// Runs real checks on a site and returns a score plus the top issues.
// Optional env var: PSI_KEY (Google PageSpeed Insights API key) for speed scores.

const UA = "HeyRanksBot/1.0 (+https://heyranks.com)";
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "Google-Extended", "PerplexityBot"];

function normalize(input) {
  let u = String(input || "").trim();
  if (!u) throw new Error("Please enter a website.");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  const url = new URL(u);
  if (!url.hostname.includes(".")) throw new Error("That doesn't look like a website address.");
  // Block private/internal targets
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname)) throw new Error("Invalid host.");
  return url;
}

async function get(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctrl.signal });
    const text = r.ok ? (await r.text()).slice(0, 600000) : "";
    return { ok: r.ok, status: r.status, text, finalUrl: r.url };
  } catch {
    return { ok: false, status: 0, text: "", finalUrl: url };
  } finally { clearTimeout(t); }
}

// Is `bot` disallowed from "/" by robots.txt?
function blocksBot(robots, bot) {
  const groups = [];
  let cur = null;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (cur) cur.rules.push({ key, val });
  }
  const pick = groups.find(g => g.agents.includes(bot.toLowerCase())) || groups.find(g => g.agents.includes("*"));
  if (!pick) return false;
  const allowRoot = pick.rules.some(r => r.key === "allow" && r.val === "/");
  return !allowRoot && pick.rules.some(r => r.key === "disallow" && r.val === "/");
}

const tag = (html, re) => { const m = html.match(re); return m ? m[1].trim() : ""; };

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  let site;
  try { site = normalize(body.url); } catch (e) { return json({ error: e.message }, 400); }
  const origin = site.origin;

  const [home, robots, llms, sitemap] = await Promise.all([
    get(origin + "/"), get(origin + "/robots.txt"), get(origin + "/llms.txt"), get(origin + "/sitemap.xml"),
  ]);
  if (!home.ok) return json({ error: `We couldn't open ${site.hostname} (status ${home.status || "timeout"}).` }, 422);

  const h = home.text;
  const title = tag(h, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = tag(h, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) ||
               tag(h, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const blocked = robots.ok ? AI_BOTS.filter(b => blocksBot(robots.text, b)) : [];

  const checks = [
    { id: "https", label: "Secure HTTPS", w: 10, pass: home.finalUrl.startsWith("https://"),
      fix: "Turn on HTTPS (free with Cloudflare or Let's Encrypt)." },
    { id: "title", label: "Page title", w: 10, pass: title.length >= 10 && title.length <= 65,
      fix: title ? `Your title is ${title.length} characters. Keep it between 10 and 65.` : "Add a <title> tag that names your business and service." },
    { id: "desc", label: "Meta description", w: 10, pass: desc.length >= 50 && desc.length <= 160,
      fix: desc ? `Your description is ${desc.length} characters. Aim for 50–160.` : "Add a meta description, the summary Google and AI tools show." },
    { id: "h1", label: "Main heading (H1)", w: 5, pass: /<h1[\s>]/i.test(h), fix: "Add one clear <h1> heading saying what you do." },
    { id: "viewport", label: "Mobile friendly", w: 10, pass: /<meta[^>]+name=["']viewport["']/i.test(h),
      fix: "Add a viewport meta tag so the site works on phones." },
    { id: "schema", label: "Structured data (Schema.org)", w: 15, pass: /application\/ld\+json/i.test(h),
      fix: "Add LocalBusiness or Organization schema so AI understands who you are." },
    { id: "og", label: "Social preview (Open Graph)", w: 5, pass: /property=["']og:title["']/i.test(h),
      fix: "Add Open Graph tags so links look good on WhatsApp, Facebook and LinkedIn." },
    { id: "ai", label: "AI crawlers allowed", w: 15, pass: blocked.length === 0,
      fix: `Your robots.txt blocks: ${blocked.join(", ")}. AI assistants can't read your site.` },
    { id: "llms", label: "llms.txt file", w: 10, pass: llms.ok && llms.text.length > 20 && !/<html/i.test(llms.text),
      fix: "Add an /llms.txt file that summarises your business for AI models." },
    { id: "sitemap", label: "XML sitemap", w: 10, pass: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text),
      fix: "Add /sitemap.xml and submit it in Google Search Console." },
  ];

  // Optional real speed score from Google PageSpeed Insights
  let speed = null;
  try {
    const key = env.PSI_KEY ? `&key=${env.PSI_KEY}` : "";
    const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&url=${encodeURIComponent(origin)}${key}`,
      { signal: AbortSignal.timeout(20000) });
    if (r.ok) speed = Math.round(((await r.json()).lighthouseResult?.categories?.performance?.score ?? 0) * 100);
  } catch {}
  if (speed !== null) checks.push({ id: "speed", label: `Mobile speed (${speed}/100)`, w: 10, pass: speed >= 70,
    fix: `Mobile speed score is ${speed}/100. Compress images and remove unused scripts.` });

  const total = checks.reduce((a, c) => a + c.w, 0);
  const score = Math.round(checks.reduce((a, c) => a + (c.pass ? c.w : 0), 0) / total * 100);
  const issues = checks.filter(c => !c.pass).sort((a, b) => b.w - a.w);

  return json({
    site: site.hostname, score, speed,
    passed: checks.filter(c => c.pass).map(c => c.label),
    top_issues: issues.slice(0, 3).map(c => ({ label: c.label, fix: c.fix })),
    more_issues: Math.max(0, issues.length - 3),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
