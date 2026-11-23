/**
 * Plans and granting them. No imports, so both the API (lib/api.js) and the daily job
 * (lib/core.js -> lib/cashfree.js) can use it without circular imports.
 */

/** What each plan includes and its one-time price in paise (charged through Cashfree in INR). */
export const PLANS = {
  free:     { label: "Free",             sites: 1, weekly: false, rescansPerDay: 3,  price: 0 },
  "180day": { label: "180-Day Pass",     sites: 1, weekly: true,  rescansPerDay: 10, price: 84900, days: 180 },
  lifetime: { label: "Lifetime Founder", sites: 3, weekly: true,  rescansPerDay: 10, price: 414900 },
};
export const PRICE_CURRENCY = "INR";

/** The plan a user actually has right now (an expired 180-day pass counts as free). */
export function effectivePlan(user, now = new Date().toISOString()) {
  if (user.plan === "lifetime") return "lifetime";
  if (user.plan === "180day" && user.plan_expires_at && user.plan_expires_at > now) return "180day";
  return "free";
}

/** The Lifetime founder deal is limited to this many sales (site + Terms say "first 500 customers"). */
export const LIFETIME_CAP = 500;

/**
 * Lifetime deals sold so far: paid ones, plus Cashfree checkouts opened in the last 30 minutes, so two
 * people buying the last place at once can't both get it. Demo data doesn't count.
 */
export async function lifetimeTaken(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE plan = 'lifetime' AND provider != 'demo'
    AND (status = 'paid' OR (status = 'pending' AND created_at > ?))`).bind(new Date(Date.now() - 30 * 60_000).toISOString()).first();
  return row?.n ?? 0;
}

/** Grants a plan. A 180-day pass stacks on top of an unexpired one; lifetime never downgrades. */
export async function activatePlan(db, userId, plan) {
  const user = await db.prepare("SELECT plan, plan_expires_at FROM users WHERE id = ?").bind(userId).first();
  if (!user) return;
  const now = new Date().toISOString();
  // Coming from Free: reports from the unpaid stretch were never meant to be emailed. Mark them handled so the
  // summary job doesn't send a backlog the moment someone upgrades.
  if (plan !== "free" && effectivePlan(user, now) === "free") {
    await db.prepare("UPDATE reports SET emailed_at = ? WHERE user_id = ? AND emailed_at IS NULL AND period_end <= ?")
      .bind(now, userId, now.slice(0, 10)).run();
  }
  if (plan === "lifetime") {
    await db.prepare("UPDATE users SET plan = 'lifetime', plan_expires_at = NULL, updated_at = ? WHERE id = ?").bind(now, userId).run();
  } else if (plan === "180day" && user.plan !== "lifetime") {
    const base = user.plan === "180day" && user.plan_expires_at > now ? new Date(user.plan_expires_at).getTime() : Date.now();
    await db.prepare("UPDATE users SET plan = '180day', plan_expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(new Date(base + PLANS["180day"].days * 864e5).toISOString(), now, userId).run();
  } else if (plan === "free") {
    await db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = ? WHERE id = ?").bind(now, userId).run();
  }
}

/**
 * Takes back what a fully refunded payment granted. Call it after the payment is marked 'refunded'.
 *   180-day pass: its 180 days come off the end date; back to Free if nothing is left.
 *   Lifetime: back to Free, unless another paid Lifetime payment exists. (Days from an older 180-day pass
 *   aren't restored: Lifetime replaced them when it was granted.)
 */
export async function revokePlan(db, userId, plan) {
  const user = await db.prepare("SELECT plan, plan_expires_at FROM users WHERE id = ?").bind(userId).first();
  if (!user) return;
  const now = new Date().toISOString();
  const toFree = () => db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = ? WHERE id = ?").bind(now, userId).run();
  if (plan === "lifetime" && user.plan === "lifetime") {
    const other = await db.prepare("SELECT 1 FROM payments WHERE user_id = ? AND plan = 'lifetime' AND status = 'paid' LIMIT 1").bind(userId).first();
    if (!other) await toFree();
  } else if (plan === "180day" && user.plan === "180day" && user.plan_expires_at) {
    const end = new Date(user.plan_expires_at).getTime() - PLANS["180day"].days * 864e5;
    if (end > Date.now()) {
      await db.prepare("UPDATE users SET plan_expires_at = ?, updated_at = ? WHERE id = ?").bind(new Date(end).toISOString(), now, userId).run();
    } else {
      await toFree();
    }
  }
}
