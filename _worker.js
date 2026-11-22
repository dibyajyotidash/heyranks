/**
 * HeyRanks _worker.js — Cloudflare Pages advanced-mode Worker
 * All logic lives in lib/core.js (shared with the Vercel deployment in api/index.js).
 * `wrangler pages deploy` bundles this file together with its imports.
 */
import { handleScan, handleSignup, handleWebhook, handleWeeklyAdmin, runWeekly } from "./lib/core.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === "/api/scan"    && method === "POST") return handleScan(request, env);
    if (pathname === "/api/signup"  && method === "POST") return handleSignup(request, env, ctx);
    if (pathname === "/api/webhook" && method === "POST") return handleWebhook(request, env);
    if (pathname === "/api/weekly"  && method === "POST") return handleWeeklyAdmin(request, env);

    // Serve static assets (index.html, signup.html, etc.)
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env) {
    console.log("[cron] weekly job started", new Date().toISOString());
    const result = await runWeekly(env);
    console.log("[cron] weekly job done", JSON.stringify(result));
  },
};
