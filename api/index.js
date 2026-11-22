/**
 * HeyRanks API on Vercel — one function for every /api/* route (see rewrites in vercel.json).
 *
 *   POST /api/scan      free SEO scan (public)
 *   POST /api/signup    register customer after payment
 *   POST /api/webhook   payment webhook
 *   POST /api/weekly    manual weekly run (header X-Admin-Secret)
 *   GET  /api/cron      Vercel Cron (header Authorization: Bearer $CRON_SECRET)
 */
import { waitUntil } from "@vercel/functions";
import { json, handleScan, handleSignup, handleWebhook, runWeekly } from "../lib/core.js";
import { d1 } from "../lib/db.js";

// Stop starting new customers after 240s; the function limit is 300s (vercel.json).
const WEEKLY_OPTS = { budgetMs: 240_000, concurrency: 4 };

function routeOf(request) {
  const url = new URL(request.url);
  // vercel.json rewrites /api/<route> -> /api?route=<route>
  return (url.searchParams.get("route") || url.pathname.replace(/^\/api\/?/, "")).replace(/\/+$/, "");
}

export default {
  async fetch(request) {
    const env = { ...process.env, DB: d1(process.env) };
    const ctx = { waitUntil };
    const route = routeOf(request);
    const method = request.method;

    if (route === "scan"    && method === "POST") return handleScan(request, env);
    if (route === "signup"  && method === "POST") return handleSignup(request, env, ctx);
    if (route === "webhook" && method === "POST") return handleWebhook(request, env);

    if (route === "weekly" && method === "POST") {
      if (!env.ADMIN_SECRET || request.headers.get("x-admin-secret") !== env.ADMIN_SECRET)
        return json({ error: "Unauthorized" }, 401);
      return json(await runWeekly(env, WEEKLY_OPTS));
    }

    if (route === "cron" && method === "GET") {
      if (!env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`)
        return json({ error: "Unauthorized" }, 401);
      console.log("[cron] weekly job started", new Date().toISOString());
      const result = await runWeekly(env, WEEKLY_OPTS);
      console.log("[cron] weekly job done", JSON.stringify(result));
      return json(result);
    }

    return json({ error: "Not found" }, 404);
  },
};
