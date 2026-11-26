/**
 * HeyRanks _worker.js — Cloudflare Pages advanced-mode Worker.
 * All API routes live in lib/api.js (shared with Vercel's api/index.js).
 * `wrangler pages deploy` bundles this file together with its imports.
 */
import { handleApi } from "./lib/api.js";
import { runDaily } from "./lib/core.js";

// Pages uploads the whole folder, so only serve the public site: pages, assets and SEO files.
// Source (lib/, scripts/, *.md, *.json, .wrangler/) stays private, matching the Vercel build.
const PUBLIC = /^\/($|assets\/|[\w-]+(\.(html|txt|xml|css|ico|png|jpe?g|svg|webp))?$)/i;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return handleApi(request, env, ctx, pathname.slice(5));
    if (!PUBLIC.test(pathname)) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },

  // Add a daily Cron Trigger (0 6 * * *) in the dashboard. Weekly reports go out on the first
  // run each week; the other days retry failures and email monthly/quarterly/yearly summaries.
  async scheduled(event, env, ctx) {
    console.log("[cron] daily job started", new Date().toISOString());
    const result = await runDaily(env);
    console.log("[cron] daily job done", JSON.stringify(result));
  },
};
