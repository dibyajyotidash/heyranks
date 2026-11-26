/**
 * Period reports: weekly, monthly, quarterly, half-yearly and yearly roll-ups of a site's scans.
 *
 * Every scan triggers rebuildReports(site, scanDate), which upserts the five reports whose period
 * contains that scan. So the current week/month/quarter/half/year is always live in the DB, and a
 * period's row stops changing once the period ends. Periods are calendar-based in UTC:
 *   weekly       Monday to Sunday
 *   monthly      calendar month
 *   quarterly    Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec
 *   half_yearly  Jan-Jun, Jul-Dec
 *   yearly       calendar year
 */

export const PERIOD_TYPES = ["weekly", "monthly", "quarterly", "half_yearly", "yearly"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = d => d.toISOString().slice(0, 10);
const utc = (y, m, d = 1) => new Date(Date.UTC(y, m, d));

/** { start, end } (YYYY-MM-DD, end exclusive) of the period of `type` containing `date`. */
export function periodRange(type, date) {
  const d = new Date(typeof date === "string" && date.length === 10 ? date + "T00:00:00Z" : date);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (type) {
    case "weekly": {
      const start = utc(y, m, d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return { start: day(start), end: day(new Date(start.getTime() + 7 * 864e5)) };
    }
    case "monthly":     return { start: day(utc(y, m)), end: day(utc(y, m + 1)) };
    case "quarterly":   { const q = m - (m % 3); return { start: day(utc(y, q)), end: day(utc(y, q + 3)) }; }
    case "half_yearly": { const h = m < 6 ? 0 : 6; return { start: day(utc(y, h)), end: day(utc(y, h + 6)) }; }
    case "yearly":      return { start: day(utc(y, 0)), end: day(utc(y + 1, 0)) };
    default: throw new Error(`Unknown period type: ${type}`);
  }
}

export function periodLabel(type, start) {
  const d = new Date(start + "T00:00:00Z");
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (type) {
    case "weekly":      return `Week of ${d.getUTCDate()} ${MONTHS[m]} ${y}`;
    case "monthly":     return `${MONTHS[m]} ${y}`;
    case "quarterly":   return `Q${m / 3 + 1} ${y}`;
    case "half_yearly": return `H${m < 6 ? 1 : 2} ${y}`;
    case "yearly":      return String(y);
    default:            return start;
  }
}

const parse = s => { try { return JSON.parse(s || "[]"); } catch { return []; } };
const avg = xs => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** The scoring method a scan was scored with (v1 scans have no details.score_version). */
export const scoreVersionOf = s => { try { return JSON.parse(s?.details || "null")?.score_version ?? 1; } catch { return 1; } };

/**
 * Summarises the scans of one period. `baseline` is the last scan before the period (or null),
 * so "issues fixed" and the score change compare against where the site stood when the period began.
 * Scores and issues are only compared between scans scored with the same method: when the method changed
 * during (or just before) the period, the summary starts from the first scan using the current method and
 * says so (summary.method_changed).
 */
export function summarise(allScans, baseline) {
  const last = allScans[allScans.length - 1];
  const version = scoreVersionOf(last);
  const scans = allScans.filter(s => scoreVersionOf(s) === version);
  const sameBase = baseline && scoreVersionOf(baseline) === version ? baseline : null;
  const methodChanged = scans.length < allScans.length || (!!baseline && !sameBase);
  const first = sameBase ?? scans[0];
  const issuesOf = s => new Map(parse(s.issues).map(i => [i.id, i]));
  const startIssues = issuesOf(first), endIssues = issuesOf(last);

  const resolved = [...startIssues.values()].filter(i => !endIssues.has(i.id)).map(i => i.label);
  const added    = [...endIssues.values()].filter(i => !startIssues.has(i.id)).map(i => i.label);
  const open     = [...endIssues.values()].sort((a, b) => b.w - a.w).map(i => ({ id: i.id, label: i.label, w: i.w, fix: i.fix }));

  // How many of the period's scans each issue failed in: the ones that never go away.
  const fails = new Map();
  for (const s of scans) for (const i of parse(s.issues)) {
    const f = fails.get(i.id) ?? { label: i.label, fails: 0 };
    f.fails++;
    fails.set(i.id, f);
  }
  const persistent = [...fails.values()].sort((a, b) => b.fails - a.fails).slice(0, 5);

  // One point per day (last scan wins) keeps yearly trends small.
  const byDay = new Map();
  for (const s of scans) byDay.set(s.created_at.slice(0, 10), s.score);
  const scores = scans.map(s => s.score);

  return {
    scans_count: allScans.length,
    score_start: first.score,
    score_end: last.score,
    score_avg: avg(scores),
    score_min: Math.min(...scores),
    score_max: Math.max(...scores),
    speed_avg: avg(scans.map(s => s.speed).filter(v => v !== null && v !== undefined)),
    issues_resolved: resolved.length,
    issues_new: added.length,
    issues_open: open.length,
    summary: { trend: [...byDay], resolved, new: added, open, persistent, scans: allScans.length, score_version: version, method_changed: methodChanged },
  };
}

async function upsertReport(db, site, type, range, s, now) {
  await db.prepare(`
    INSERT INTO reports (id, site_id, user_id, period_type, period_start, period_end, scans_count,
      score_start, score_end, score_avg, score_min, score_max, speed_avg,
      issues_resolved, issues_new, issues_open, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (site_id, period_type, period_start) DO UPDATE SET
      period_end = excluded.period_end, scans_count = excluded.scans_count,
      score_start = excluded.score_start, score_end = excluded.score_end, score_avg = excluded.score_avg,
      score_min = excluded.score_min, score_max = excluded.score_max, speed_avg = excluded.speed_avg,
      issues_resolved = excluded.issues_resolved, issues_new = excluded.issues_new,
      issues_open = excluded.issues_open, summary = excluded.summary, updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(), site.id, site.user_id, type, range.start, range.end, s.scans_count,
    s.score_start, s.score_end, s.score_avg, s.score_min, s.score_max, s.speed_avg,
    s.issues_resolved, s.issues_new, s.issues_open, JSON.stringify(s.summary), now, now,
  ).run();
}

/**
 * Recomputes period reports for one site.
 *   since = a date  -> only the 5 periods containing that date (the normal after-scan path)
 *   since = null    -> every period the site has scans in (migration, backfill, demo seed)
 * Returns the number of reports written.
 */
export async function rebuildReports(db, site, since = null) {
  const now = new Date().toISOString();
  const sinceDay = since ? new Date(since).toISOString().slice(0, 10) : null;
  const ranges = sinceDay ? PERIOD_TYPES.map(t => periodRange(t, sinceDay)) : [];
  const minStart = ranges.length ? ranges.map(r => r.start).sort()[0] : null;

  let rows;
  if (minStart) {
    const base = await db.prepare(`SELECT * FROM scans WHERE site_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`)
      .bind(site.id, minStart).first();
    const { results } = await db.prepare(`SELECT * FROM scans WHERE site_id = ? AND created_at >= ? ORDER BY created_at`)
      .bind(site.id, minStart).all();
    rows = base ? [base, ...results] : results;
  } else {
    rows = (await db.prepare(`SELECT * FROM scans WHERE site_id = ? ORDER BY created_at`).bind(site.id).all()).results;
  }

  let written = 0;
  for (const type of PERIOD_TYPES) {
    let i = 0;
    while (i < rows.length) {
      const range = periodRange(type, rows[i].created_at);
      let j = i;
      while (j < rows.length && rows[j].created_at < range.end) j++;
      const wanted = sinceDay ? range.start <= sinceDay && sinceDay < range.end : true;
      if (wanted) {
        await upsertReport(db, site, type, range, summarise(rows.slice(i, j), rows[i - 1] ?? null), now);
        written++;
      }
      i = j;
    }
  }
  return written;
}

/** Rebuilds every period report for every site. Used after migrating legacy data. */
export async function rebuildAllReports(db) {
  const { results: sites } = await db.prepare("SELECT id, user_id FROM sites").all();
  let written = 0;
  for (const site of sites) written += await rebuildReports(db, site);
  return written;
}

/** Shapes a reports row for the API. */
export function presentReport(r, today = new Date().toISOString().slice(0, 10)) {
  return {
    id: r.id,
    site_id: r.site_id,
    period_type: r.period_type,
    period_start: r.period_start,
    period_end: r.period_end,
    label: periodLabel(r.period_type, r.period_start),
    status: r.period_end <= today ? "final" : "in_progress",
    scans_count: r.scans_count,
    score_start: r.score_start,
    score_end: r.score_end,
    change: r.score_end - r.score_start,
    method_changed: (() => { try { return !!JSON.parse(r.summary || "{}").method_changed; } catch { return false; } })(),
    score_avg: r.score_avg,
    score_min: r.score_min,
    score_max: r.score_max,
    speed_avg: r.speed_avg,
    issues_resolved: r.issues_resolved,
    issues_new: r.issues_new,
    issues_open: r.issues_open,
    updated_at: r.updated_at,
  };
}
