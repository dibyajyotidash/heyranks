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

/** Grants a plan. A 180-day pass stacks on top of an unexpired one; lifetime never downgrades. */
export async function activatePlan(db, userId, plan) {
  const user = await db.prepare("SELECT plan, plan_expires_at FROM users WHERE id = ?").bind(userId).first();
  if (!user) return;
  const now = new Date().toISOString();
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
