/**
 * HeyRanks core: email templates and the scheduled jobs. The homepage scan lives in lib/scan.js and the
 * full-site audit in lib/audit.js. HTTP routing lives in lib/api.js; both entry points (_worker.js,
 * api/index.js) call it.
 */
import { json } from "./http.js";
import { periodRange, periodLabel, rebuildReports, rebuildAllReports } from "./reports.js";
import { ensureSchema } from "./schema.js";
import { PLANS } from "./plans.js";
import { settlePendingCashfreeOrders } from "./cashfree.js";
import { runScan, codeSnippet } from "./scan.js";
import { scanSummary, Budget } from "./ai.js";
import { enqueueWeeklyAudits, processAudits } from "./audit.js";
import { attrs } from "./crawler.js";

export { json };
export { PLANS, PRICE_CURRENCY, effectivePlan } from "./plans.js";
export { isPrivateAddress, resolveOverHttps, fetchPublic } from "./net.js";
export { runScan, normalize, codeSnippet } from "./scan.js";

const FROM     = "HeyRanks <reports@heyranks.com>";
const SITE_URL = "https://heyranks.com";

// ─── utilities ───────────────────────────────────────────────────────────────

export function escHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Attributes of every <meta> tag, lower-cased names; handles "double", 'single' and unquoted values in any order. */
export function metaTags(html) {
  return [...String(html).matchAll(/<meta\b([^>]*)>/gi)].map(m => attrs(m[1]));
}

const scoreVersion = s => { try { return JSON.parse(s.details || "null")?.score_version ?? 1; } catch { return 1; } };

/**
 * Stores a scan, refreshes the five period reports containing it, and stamps the site.
 * Returns the previous scan's score (for "up/down since last time"), or null when there is none or it
 * was measured with an older scoring method (a change would reflect the method, not the site).
 */
export async function saveScan(db, site, scan, kind, at = new Date().toISOString()) {
  const prev = await db.prepare("SELECT score, details FROM scans WHERE site_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1")
    .bind(site.id, at).first();
  await db.prepare(`
    INSERT INTO scans (id, site_id, user_id, kind, score, speed, checks_count, issues_count, passed, issues, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), site.id, site.user_id, kind, scan.score, scan.speed,
    scan.passed.length + scan.issues.length, scan.issues.length,
    JSON.stringify(scan.passed), JSON.stringify(scan.issues.map(({ id, label, w, fix, severity, category }) => ({ id, label, w, fix, severity, category }))),
    scan.details ? JSON.stringify(scan.details) : null, at,
  ).run();
  await db.prepare("UPDATE sites SET last_scan_at = ? WHERE id = ?").bind(at, site.id).run();
  await rebuildReports(db, site, at);
  if (!prev) return null;
  return scoreVersion(prev) === (scan.details?.score_version ?? 1) ? prev.score : null;
}

/**
 * Two-sentence AI summary of a scan for paid plans, or null (no ANTHROPIC_API_KEY, failure, or the
 * customer's monthly AI budget is used up). Reuses the last summary when the same issues were already
 * summarised in the past 24 hours, and records the cost in usage_events.
 */
export async function generateAiSummary(db, env, site, scan) {
  if (!env.ANTHROPIC_API_KEY || !scan.issues.length) return null;
  const prev = await db.prepare("SELECT issues, details FROM scans WHERE site_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(site.id, new Date(Date.now() - 864e5).toISOString()).first();
  const ids = list => list.map(i => i.id).sort().join(",");
  if (prev) {
    try {
      const old = JSON.parse(prev.details || "null")?.aiSummary;
      if (old && ids(JSON.parse(prev.issues)) === ids(scan.issues)) return old;
    } catch { /* fall through and write a new one */ }
  }
  const month = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events WHERE user_id = ? AND created_at > ?")
    .bind(site.user_id, new Date(Date.now() - 30 * 864e5).toISOString()).first();
  const events = [];
  const budget = new Budget(Math.max(0, (Number(env.USER_MONTHLY_COST_CAP_USD) || 3) - (month?.usd || 0)), ev => events.push(ev));
  const text = await scanSummary(env, scan, site.hostname, budget).catch(() => null);
  for (const ev of events) {
    await db.prepare(`INSERT INTO usage_events (id, user_id, site_id, provider, operation, units, cost_usd, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(crypto.randomUUID(), site.user_id, site.id, ev.provider, ev.operation, ev.units || 1, ev.cost_usd || 0, new Date().toISOString()).run();
  }
  return text;
}

// ─── email templates ──────────────────────────────────────────────────────────

const SEV = {
  critical: { color: "#b91c1c", bg: "#fee2e2", label: "CRITICAL" },
  high:     { color: "#dc2626", bg: "#fee2e2", label: "HIGH" },
  medium:   { color: "#d97706", bg: "#fef3c7", label: "MEDIUM" },
  low:      { color: "#16a34a", bg: "#dcfce7", label: "LOW" },
  info:     { color: "#475569", bg: "#f1f5f9", label: "INFO" },
};
const sevOf = issue => SEV[issue.severity] || (issue.w >= 15 ? SEV.high : issue.w >= 10 ? SEV.medium : SEV.low);

function issueBlock(issue, site, finding) {
  const p = sevOf(issue);
  const snippet = codeSnippet(issue, site, finding);
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

function auditBlock(audit) {
  if (!audit) return "";
  const s = audit.summary || {};
  const d = s.diff;
  return `
  <tr><td style="padding:24px 32px;border-top:1px solid #f1f5f9">
    <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:10px">Full-site audit · ${escHtml(new Date(audit.finished_at).toUTCString().slice(5, 16))}</div>
    <div style="font-size:.92rem;color:#334155;line-height:1.6">
      Health score <b>${audit.score}/100</b> across ${s.pages?.crawled ?? "?"} pages (coverage ${audit.coverage}%).
      ${s.counts ? `${s.counts.critical} critical, ${s.counts.high} high and ${s.counts.medium} medium issues.` : ""}
      ${d ? `<br>Since the previous audit: <b style="color:#16a34a">${d.resolved.length} resolved</b>, <b style="color:#dc2626">${d.new.length} new</b>.` : ""}
    </div>
    <a href="${SITE_URL}/report?audit=${encodeURIComponent(audit.id)}" style="display:inline-block;margin-top:12px;color:#ff5a1f;font-weight:700;text-decoration:none">Open the full report →</a>
  </td></tr>`;
}

function reportEmail({ email, website }, scan, prevScore, weekLabel, audit) {
  const scoreColor = scan.score >= 75 ? "#16a34a" : scan.score >= 45 ? "#d97706" : "#dc2626";
  const delta = prevScore !== null && prevScore !== undefined
    ? (scan.score > prevScore ? `<span style="color:#16a34a">▲ ${scan.score - prevScore} from last week</span>`
     : scan.score < prevScore ? `<span style="color:#dc2626">▼ ${prevScore - scan.score} from last week</span>`
     : `<span style="color:#64748b">no change from last week</span>`)
    : `<span style="color:#64748b">${scan.details?.score_version === 2 ? "new scoring method" : "first report"}</span>`;
  const findings = new Map((scan.details?.findings || []).map(f => [f.check_id, f]));
  const alerts = (scan.details?.alerts || []).map(a => `<div style="padding:10px 14px;margin-bottom:8px;background:#fee2e2;border-radius:10px;color:#991b1b;font-size:.88rem"><b>${escHtml(a.title)}</b><br>${escHtml(a.detected)}</div>`).join("");
  const passedRows = scan.passed.map(p => `<div style="padding:4px 0;font-size:.88rem;color:#334155">✅ ${escHtml(p)}</div>`).join("");
  const issueRows = scan.issues.slice(0, 5).map(iss => issueBlock(iss, website, findings.get(iss.id))).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeyRanks report — ${escHtml(website)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:28px 16px">
<table width="100%" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

  <tr><td style="background:#0f1720;padding:24px 32px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="color:#d9f99d;font-weight:700;font-size:1.05rem">📈 HeyRanks</td>
      <td align="right" style="color:#94a3b8;font-size:.82rem">${escHtml(weekLabel)}</td>
    </tr></table>
    <div style="margin-top:10px;color:#fff;font-size:1.25rem;font-weight:700">Weekly report: ${escHtml(website)}</div>
  </td></tr>

  ${alerts ? `<tr><td style="padding:20px 32px 4px">${alerts}</td></tr>` : ""}

  <tr><td style="padding:28px 32px;border-bottom:1px solid #f1f5f9">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <div style="font-size:4rem;font-weight:800;line-height:1;color:${scoreColor}">${scan.score}</div>
        <div style="font-size:.88rem;color:#64748b;margin-top:4px">homepage health out of 100 &nbsp;·&nbsp; ${delta}</div>
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

  ${scan.passed.length ? `
  <tr><td style="padding:20px 32px;border-bottom:1px solid #f1f5f9;background:#f9fafb">
    <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:10px">What's working</div>
    ${passedRows}
  </td></tr>` : ""}

  <tr><td style="padding:28px 32px">
    <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:16px">This week's fixes</div>
    ${issueRows || `<div style="font-size:.9rem;color:#16a34a">Nothing to fix on the homepage this week.</div>`}
    ${scan.issues.length > 5 ? `<div style="font-size:.85rem;color:#64748b;margin-top:8px">+ ${scan.issues.length - 5} more on your dashboard.</div>` : ""}
  </td></tr>

  ${auditBlock(audit)}

  <tr><td style="background:#f8fafc;padding:28px 32px;border-top:1px solid #e2e8f0;text-align:center">
    <div style="font-size:.92rem;color:#334155;margin-bottom:18px">
      Your next report arrives next Monday. Your monthly, quarterly and yearly trends are on your dashboard.
    </div>
    <a href="${SITE_URL}/dashboard" style="display:inline-block;background:#ff5a1f;color:#fff;padding:13px 32px;border-radius:99px;font-weight:700;text-decoration:none;font-size:.95rem">
      Open my dashboard →
    </a>
  </td></tr>

  <tr><td style="padding:20px 32px;text-align:center;border-top:1px solid #f1f5f9">
    <div style="font-size:.78rem;color:#94a3b8;line-height:1.6">
      HeyRanks by DexoSoft Solutions &nbsp;·&nbsp;
      <a href="mailto:hello@dexosoftsolutions.com" style="color:#94a3b8">hello@dexosoftsolutions.com</a><br>
      You're receiving this because you signed up for weekly reports for ${escHtml(website)}.<br>
      <a href="mailto:hello@dexosoftsolutions.com?subject=Unsubscribe%20${encodeURIComponent(email)}" style="color:#94a3b8">Unsubscribe</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function welcomeEmail({ email, website, keywords, paid }, scan) {
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
    <div style="color:#94a3b8;font-size:.92rem;margin-top:6px">Your weekly website reports are live</div>
  </td></tr>

  <tr><td style="padding:28px 32px">
    <div style="background:#ecfccb;border-radius:12px;padding:16px 20px;margin-bottom:24px">
      <div style="font-weight:700;color:#166534;font-size:.95rem">✅ You're set up</div>
      <div style="color:#166534;font-size:.88rem;margin-top:4px">Site: <b>${escHtml(website)}</b></div>
      ${keywordsLine}
    </div>

    ${paid ? `
    <div style="font-size:1rem;color:#0f1720;font-weight:700;margin-bottom:8px">Your first full report is coming next Monday.</div>
    <div style="font-size:.92rem;color:#334155;line-height:1.6;margin-bottom:24px">
      Every Monday morning we scan your site and send you a plain-English report with the 5 things to fix that week. You can also run a full-site audit from your dashboard at any time.
    </div>` : `
    <div style="font-size:1rem;color:#0f1720;font-weight:700;margin-bottom:8px">Your free account is ready.</div>
    <div style="font-size:.92rem;color:#334155;line-height:1.6;margin-bottom:24px">
      You can rescan your homepage from your dashboard at any time. Upgrade to the 180-Day Pass for full-site audits of up to 50 pages, a 30-day growth plan and a report every Monday.
    </div>`}

    ${topFixes ? `
    <div style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;font-weight:700;margin-bottom:12px">While you wait — 3 quick wins we found:</div>
    ${topFixes}` : ""}

  </td></tr>

  <tr><td style="background:#f8fafc;padding:24px 32px;text-align:center;border-top:1px solid #e2e8f0">
    <div style="font-size:.88rem;color:#334155;margin-bottom:16px">Any questions? Just reply to this email.</div>
    <a href="${SITE_URL}/dashboard" style="display:inline-block;background:#0f1720;color:#fff;padding:12px 28px;border-radius:99px;font-weight:700;text-decoration:none;font-size:.92rem">
      Open my dashboard →
    </a>
  </td></tr>

  <tr><td style="padding:16px 32px;text-align:center;border-top:1px solid #f1f5f9">
    <div style="font-size:.78rem;color:#94a3b8">
      HeyRanks by DexoSoft Solutions &nbsp;·&nbsp;
      <a href="mailto:hello@dexosoftsolutions.com" style="color:#94a3b8">hello@dexosoftsolutions.com</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

/** Plain one-card email: login links, password resets, notices. `body` is trusted HTML. */
export function simpleEmail(title, body, ctaText, ctaUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden">
  <tr><td style="background:#0f1720;padding:20px 28px;color:#d9f99d;font-weight:700">📈 HeyRanks</td></tr>
  <tr><td style="padding:28px">
    <div style="font-size:1.2rem;font-weight:700;color:#0f1720;margin-bottom:12px">${escHtml(title)}</div>
    <div style="font-size:.93rem;color:#334155;line-height:1.6">${body}</div>
    ${ctaUrl ? `<div style="margin-top:24px"><a href="${escHtml(ctaUrl)}" style="display:inline-block;background:#ff5a1f;color:#fff;padding:12px 28px;border-radius:99px;font-weight:700;text-decoration:none">${escHtml(ctaText)}</a></div>
    <div style="margin-top:16px;font-size:.78rem;color:#94a3b8;word-break:break-all">Or paste this link into your browser: ${escHtml(ctaUrl)}</div>` : ""}
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #f1f5f9;font-size:.78rem;color:#94a3b8">HeyRanks by DexoSoft Solutions · hello@dexosoftsolutions.com</td></tr>
</table></td></tr></table></body></html>`;
}

const PERIOD_NAMES = { monthly: "monthly", quarterly: "quarterly", half_yearly: "half-yearly", yearly: "yearly" };

/** Summary email sent once a month / quarter / half-year / year has ended. */
function periodEmail(hostname, report) {
  const s = JSON.parse(report.summary || "{}");
  const change = report.score_end - report.score_start;
  const changeText = change > 0 ? `up ${change} points` : change < 0 ? `down ${-change} points` : "unchanged";
  const list = (items, empty) => items?.length
    ? `<ul style="margin:6px 0 0;padding-left:18px">${items.slice(0, 6).map(i => `<li>${escHtml(i)}</li>`).join("")}</ul>`
    : `<div style="color:#94a3b8">${empty}</div>`;
  const body = `
    Your score for <b>${escHtml(hostname)}</b> ended the period at <b>${report.score_end}/100</b>, ${changeText}
    (average ${report.score_avg}, best ${report.score_max}, across ${report.scans_count} scan${report.scans_count === 1 ? "" : "s"}).
    <div style="margin-top:16px;font-weight:700;color:#16a34a">Fixed this period (${report.issues_resolved})</div>${list(s.resolved, "Nothing fixed yet.")}
    <div style="margin-top:14px;font-weight:700;color:#dc2626">New problems (${report.issues_new})</div>${list(s.new, "No new problems.")}
    <div style="margin-top:14px;font-weight:700;color:#0f1720">Still open (${report.issues_open})</div>${list((s.open || []).map(i => i.label), "Nothing open. Great work.")}`;
  return simpleEmail(`Your ${PERIOD_NAMES[report.period_type]} report: ${periodLabel(report.period_type, report.period_start)}`,
    body, "See the full report →", `${SITE_URL}/dashboard`);
}

// ─── email sender (Resend) ────────────────────────────────────────────────────

/**
 * Sends through Resend. ok is true only when Resend accepted the message, so callers can mark a
 * report as sent only then (acceptance, not inbox delivery). Never throws.
 */
export async function sendEmail(to, subject, html, env) {
  if (!env.RESEND_API_KEY) {
    // Dev mode: no email provider, so print links (login, reset) to the server log instead.
    // Not "ok": nothing was sent, so reports stay unsent and are retried once a key is set.
    const links = [...html.matchAll(/href="([^"]+(?:magic|token)=[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, "&"));
    console.log(`[email] no RESEND_API_KEY — would send to ${to}: ${subject}${links.length ? `\n[email] link: ${links[0]}` : ""}`);
    return { ok: false, dry: true };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) console.error("[email] Resend error", r.status, JSON.stringify(body));
    return { ok: r.ok && !!body.id, id: body.id, status: r.status };
  } catch (err) {
    console.error("[email] Resend request failed", err?.name || err);
    return { ok: false, status: 0 };
  }
}

// ─── scheduled jobs ───────────────────────────────────────────────────────────

async function latestAudit(db, siteId, since) {
  const a = await db.prepare(`SELECT id, score, coverage, summary, finished_at FROM audits WHERE site_id = ? AND status = 'complete' AND finished_at > ?
    ORDER BY finished_at DESC LIMIT 1`).bind(siteId, since).first();
  if (!a) return null;
  try { return { ...a, summary: JSON.parse(a.summary || "{}") }; } catch { return { ...a, summary: {} }; }
}

// opts.budgetMs: stop starting new sites after this long, so the run ends before the
// platform's function timeout. Unfinished sites are picked up by the next run (their
// last_weekly_at is still older than this week's Monday).
export async function runWeekly(env, opts = {}) {
  if (!env.DB) return { error: "No DB binding" };
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? Infinity;
  const concurrency = opts.concurrency ?? 1;
  const now = new Date().toISOString();
  const week = periodRange("weekly", now).start;
  const d = new Date();
  const weekLabel = `${d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

  // Active sites of paying users that haven't had this week's report yet.
  const { results: sites } = await env.DB.prepare(`
    SELECT s.*, u.email FROM sites s JOIN users u ON u.id = s.user_id
    WHERE s.status = 'active' AND u.status = 'active' AND u.role != 'demo'
      AND (u.plan = 'lifetime' OR (u.plan = '180day' AND u.plan_expires_at > ?))
      AND (s.last_weekly_at IS NULL OR s.last_weekly_at < ?)
  `).bind(now, week).all();

  let sent = 0, failed = 0, skipped = 0, next = 0;
  async function processOne(site) {
    try {
      // A retry (the email failed on an earlier run this week) reuses this week's scan instead of scanning again.
      const earlier = await env.DB.prepare(`SELECT * FROM scans WHERE site_id = ? AND kind = 'weekly' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`).bind(site.id, week).first();
      let scan, prevScore;
      if (earlier) {
        scan = { score: earlier.score, speed: earlier.speed, passed: JSON.parse(earlier.passed), issues: JSON.parse(earlier.issues),
          details: earlier.details ? JSON.parse(earlier.details) : null };
        const prev = await env.DB.prepare("SELECT score, details FROM scans WHERE site_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1")
          .bind(site.id, earlier.created_at).first();
        prevScore = prev && scoreVersion(prev) === scoreVersion(earlier) ? prev.score : null;
      } else {
        scan = await runScan(site.hostname, env, opts.scan);
        if (!scan) { failed++; return; }
        const sum = await generateAiSummary(env.DB, env, site, scan).catch(() => null);
        if (sum) scan.details.aiSummary = sum;
        prevScore = await saveScan(env.DB, site, scan, "weekly", now);
      }

      const audit = await latestAudit(env.DB, site.id, new Date(Date.now() - 8 * 864e5).toISOString());
      const subject = `HeyRanks ${weekLabel} — ${site.hostname} scores ${scan.score}/100`
        + (prevScore !== null ? (scan.score > prevScore ? ` ↑${scan.score - prevScore}` : scan.score < prevScore ? ` ↓${prevScore - scan.score}` : "") : "");
      const mail = await sendEmail(site.email, subject, reportEmail({ email: site.email, website: site.hostname }, scan, prevScore, weekLabel, audit), env);
      // Only an email the provider accepted counts as sent. Otherwise the site stays due and the next run retries.
      if (!mail.ok) { failed++; return; }

      await env.DB.prepare("UPDATE sites SET last_weekly_at = ? WHERE id = ?").bind(now, site.id).run();
      await env.DB.prepare(`UPDATE reports SET emailed_at = ? WHERE site_id = ? AND period_type = 'weekly' AND period_start = ?`)
        .bind(now, site.id, week).run();
      sent++;
    } catch (err) {
      console.error(`[weekly] failed for ${site.hostname}:`, err);
      failed++;
    }
  }

  async function worker() {
    while (next < sites.length) {
      if (Date.now() - started > budgetMs) { skipped = sites.length - next; next = sites.length; return; }
      await processOne(sites[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  return { week, due: sites.length, sent, failed, deferred: skipped };
}

/**
 * Emails monthly / quarterly / half-yearly / yearly summaries for ended periods that haven't been
 * emailed yet, oldest first, `limit` per run. No short window: if the scheduler was down, the next
 * runs catch up. (Reports from a stretch on the Free plan are marked handled when a paid plan starts,
 * see activatePlan, so upgrading doesn't send a backlog.) Each report is emailed once.
 */
export async function sendPeriodSummaries(env, limit = 50) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const oldest = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10); // sanity bound only
  const { results } = await env.DB.prepare(`
    SELECT r.*, s.hostname, u.email FROM reports r
    JOIN sites s ON s.id = r.site_id JOIN users u ON u.id = r.user_id
    WHERE r.period_type != 'weekly' AND r.emailed_at IS NULL
      AND r.period_end <= ? AND r.period_end > ?
      AND u.status = 'active' AND u.role != 'demo'
      AND (u.plan = 'lifetime' OR (u.plan = '180day' AND u.plan_expires_at > ?))
    ORDER BY r.period_end LIMIT ?`).bind(today, oldest, now, limit).all();

  let sent = 0;
  for (const r of results) {
    const label = periodLabel(r.period_type, r.period_start);
    const res = await sendEmail(r.email, `HeyRanks ${label} summary — ${r.hostname} at ${r.score_end}/100`, periodEmail(r.hostname, r), env);
    if (res.ok) {
      await env.DB.prepare("UPDATE reports SET emailed_at = ? WHERE id = ?").bind(now, r.id).run();
      sent++;
    }
  }
  return { summaries: sent };
}

/**
 * Housekeeping: expired sessions, tokens and rate-limit windows; visits older than ~13 months; and the
 * audit retention policy: crawled page data is kept 45 days (always for each site's latest audit),
 * failed/cancelled crawls 7 days, audits, findings and usage records about 13 months.
 */
export async function cleanup(env) {
  const now = new Date().toISOString();
  const ago = days => new Date(Date.now() - days * 864e5).toISOString();
  const db = env.DB;
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await db.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").bind(now).run();
  await db.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(now).run();
  await db.prepare("DELETE FROM visits WHERE day < ?").bind(ago(400).slice(0, 10)).run();
  const old = `SELECT a.id FROM audits a WHERE a.finished_at < ? AND a.id != COALESCE((SELECT b.id FROM audits b WHERE b.site_id = a.site_id AND b.status = 'complete' ORDER BY b.finished_at DESC LIMIT 1), '')`;
  await db.prepare(`DELETE FROM audit_pages WHERE audit_id IN (${old})`).bind(ago(45)).run();
  await db.prepare(`UPDATE audits SET state = NULL WHERE id IN (${old})`).bind(ago(45)).run();
  await db.prepare("DELETE FROM audit_pages WHERE audit_id IN (SELECT id FROM audits WHERE status IN ('failed', 'cancelled') AND updated_at < ?)").bind(ago(7)).run();
  await db.prepare("DELETE FROM findings WHERE created_at < ?").bind(ago(400)).run();
  await db.prepare("DELETE FROM audits WHERE created_at < ?").bind(ago(400)).run();
  await db.prepare("DELETE FROM usage_events WHERE created_at < ?").bind(ago(400)).run();
}

/**
 * Receipt + confirmation once a payment switches a plan on. `s` is what settleCashfreeOrder returns
 * when it grants a plan. Sent from every path (return page, webhook, daily check), because a buyer
 * who closed the payment tab otherwise never hears that it worked.
 */
export async function notifyPlanActivated(env, s) {
  const u = await env.DB.prepare("SELECT email, name, plan, plan_expires_at FROM users WHERE id = ?").bind(s.user_id).first();
  if (!u) return;
  const label = PLANS[s.plan]?.label || s.plan;
  const paid = s.currency === "INR" ? `₹${(s.amount / 100).toLocaleString("en-IN")}` : `${(s.amount / 100).toFixed(2)} ${s.currency}`;
  const until = u.plan === "lifetime" ? "for life"
    : `until ${new Date(u.plan_expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;
  const body = `Thanks${u.name ? ", " + escHtml(u.name) : ""}! We've received your payment of <b>${paid}</b>, and your
    <b>${escHtml(label)}</b> is active ${until}.<br><br>
    Run your first full-site audit from the dashboard. Your report arrives every Monday, with monthly, quarterly and yearly summaries when each period ends.<br><br>
    <span style="color:#94a3b8">Order reference: ${escHtml(s.order_id)}</span>`;
  await sendEmail(u.email, `Your HeyRanks ${label} is active`, simpleEmail(`Your ${label} is active`, body, "Open my dashboard →", `${SITE_URL}/dashboard`), env);
}

/**
 * The daily cron: unpaid-order check, weekly full-site audits (queued and processed for part of the time
 * budget), weekly reports (Mondays + catch-up), period summaries, housekeeping.
 */
export async function runDaily(env, opts = {}) {
  if (!env.DB) return { error: "No DB binding" };
  const started = Date.now();
  await ensureSchema(env.DB, rebuildAllReports); // the cron can be an instance's first call
  // First, so a long weekly run can't crowd it out: payments whose webhook never arrived.
  const payments = await settlePendingCashfreeOrders(env.DB, env);
  for (const s of payments.granted) await notifyPlanActivated(env, s).catch(err => console.error("[daily] receipt email failed", err));
  const budget = opts.budgetMs ?? 240_000;
  const queued = await enqueueWeeklyAudits(env.DB);
  const audits = await processAudits(env.DB, env, { budgetMs: Math.min(110_000, budget * 0.45), scan: opts.scan });
  const weekly = await runWeekly(env, { ...opts, budgetMs: Math.max(30_000, budget - (Date.now() - started)) });
  const summaries = await sendPeriodSummaries(env);
  await cleanup(env);
  return { ...weekly, ...summaries, ...queued, ...audits, cashfree_checked: payments.checked, cashfree_settled: payments.granted.length };
}

export { welcomeEmail };
