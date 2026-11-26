/**
 * HeyRanks API on Vercel — one function for every /api/* route (see rewrites in vercel.json).
 * All routes live in lib/api.js; this file only adapts Vercel's environment to it.
 */
import { waitUntil } from "@vercel/functions";
import { handleApi } from "../lib/api.js";
import { d1 } from "../lib/db.js";

// Stop starting new weekly scans after 240s; the function limit is 300s (vercel.json).
const JOB_OPTS = { budgetMs: 240_000, concurrency: 4 };

function routeOf(request) {
  const url = new URL(request.url);
  // vercel.json rewrites /api/<route> -> /api?route=<route>
  return url.searchParams.get("route") || url.pathname.replace(/^\/api\/?/, "");
}

export default {
  async fetch(request) {
    const env = { ...process.env, DB: d1(process.env) };
    return handleApi(request, env, { waitUntil }, routeOf(request), { jobOpts: JOB_OPTS });
  },
};
