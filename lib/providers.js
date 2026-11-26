/**
 * External data providers. Every module returns
 *   { status: "ok" | "unavailable" | "error" | "partial", source, fetched_at, data, message }
 * "unavailable" means the integration isn't configured; the report says so and names the setting
 * instead of showing numbers. Nothing here estimates or invents a metric the provider didn't return.
 */
import { claudeRequest, claudeModel, classifySentiment } from "./ai.js";
import { sameSite } from "./crawler.js";

const now = () => new Date().toISOString();
export const unavailable = (source, message) => ({ status: "unavailable", source, fetched_at: now(), data: null, message });
const failed = (source, message) => ({ status: "error", source, fetched_at: now(), data: null, message });

// ─── Google PageSpeed Insights (Lighthouse lab + Chrome UX Report field data) ──

const n = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const score100 = c => (c && typeof c.score === "number" ? Math.round(c.score * 100) : null);

export function parsePageSpeed(j, strategy) {
  const lh = j.lighthouseResult || {};
  const a = lh.audits || {};
  const cat = lh.categories || {};
  const fieldOf = le => {
    const m = le?.metrics;
    if (!m) return null;
    const p = k => n(m[k]?.percentile);
    const cls = p("CUMULATIVE_LAYOUT_SHIFT_SCORE");
    return { lcp_ms: p("LARGEST_CONTENTFUL_PAINT_MS"), inp_ms: p("INTERACTION_TO_NEXT_PAINT"), cls: cls === null ? null : cls / 100,
      fcp_ms: p("FIRST_CONTENTFUL_PAINT_MS"), ttfb_ms: p("EXPERIMENTAL_TIME_TO_FIRST_BYTE"), overall: le.overall_category || null };
  };
  // Prefer this URL's own field data; fall back to the whole origin (labelled as such).
  const urlField = j.loadingExperience && !j.loadingExperience.origin_fallback ? fieldOf(j.loadingExperience) : null;
  const originField = fieldOf(j.originLoadingExperience);
  const field = urlField ? { ...urlField, source: "url" } : originField ? { ...originField, source: "origin" } : null;

  const failing = (catKey, filter) => (cat[catKey]?.auditRefs || [])
    .map(ref => ({ ref, audit: a[ref.id] }))
    .filter(({ ref, audit }) => audit && filter(ref, audit));
  const opportunities = failing("performance", (ref, x) => ref.group !== "metrics" && typeof x.score === "number" && x.score < 0.9
    && !["informative", "notApplicable", "manual", "error"].includes(x.scoreDisplayMode))
    .map(({ audit: x }) => ({ id: x.id, title: x.title, display: x.displayValue || null,
      savings_ms: n(x.details?.overallSavingsMs) ?? n(x.metricSavings?.LCP) ?? null, savings_bytes: n(x.details?.overallSavingsBytes) }))
    .sort((p, q) => (q.savings_ms || 0) - (p.savings_ms || 0)).slice(0, 10);
  const a11y_failures = failing("accessibility", (ref, x) => x.score === 0 && x.scoreDisplayMode === "binary")
    .map(({ audit: x }) => ({ id: x.id, title: x.title, items: Array.isArray(x.details?.items) ? x.details.items.length : null })).slice(0, 15);

  return {
    strategy, fetched_at: now(), final_url: lh.finalDisplayedUrl || lh.finalUrl || j.id || null,
    lighthouse_version: lh.lighthouseVersion || null,
    scores: { performance: score100(cat.performance), accessibility: score100(cat.accessibility), best_practices: score100(cat["best-practices"]), seo: score100(cat.seo) },
    lab: { lcp_ms: n(a["largest-contentful-paint"]?.numericValue), cls: n(a["cumulative-layout-shift"]?.numericValue), tbt_ms: n(a["total-blocking-time"]?.numericValue),
      fcp_ms: n(a["first-contentful-paint"]?.numericValue), si_ms: n(a["speed-index"]?.numericValue) },
    field, opportunities, a11y_failures,
  };
}

/** One PageSpeed Insights run. { result } or { error }. */
export async function pageSpeed(url, strategy, env, { categories = ["PERFORMANCE"], ms = 60_000 } = {}) {
  const params = new URLSearchParams({ url, strategy });
  for (const c of categories) params.append("category", c);
  if (env?.PSI_KEY) params.set("key", env.PSI_KEY);
  try {
    const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) {
      console.warn(`[psi] ${r.status} for ${url} (${strategy})${env?.PSI_KEY ? "" : " — PSI_KEY not set"}`);
      return { error: `Google PageSpeed Insights answered ${r.status}${env?.PSI_KEY ? "" : " (PSI_KEY isn't set, so Google's shared quota applies)"}.` };
    }
    return { result: parsePageSpeed(await r.json(), strategy) };
  } catch (err) {
    return { error: `Google PageSpeed Insights didn't answer in time (${err?.name || "error"}).` };
  }
}

// ─── DataForSEO (keywords, SERP competitors, backlinks) ───────────────────────

export const MARKETS = {
  IN: { code: 2356, lang: "en", label: "India" }, US: { code: 2840, lang: "en", label: "United States" },
  GB: { code: 2826, lang: "en", label: "United Kingdom" }, AU: { code: 2036, lang: "en", label: "Australia" },
  CA: { code: 2124, lang: "en", label: "Canada" }, AE: { code: 2784, lang: "en", label: "United Arab Emirates" },
  SG: { code: 2702, lang: "en", label: "Singapore" }, NZ: { code: 2554, lang: "en", label: "New Zealand" },
  ZA: { code: 2710, lang: "en", label: "South Africa" }, IE: { code: 2372, lang: "en", label: "Ireland" },
};
export const dfsConfigured = env => !!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
const DFS_SOURCE = "DataForSEO";

/** One DataForSEO "live" task. Returns the task's result array; throws with the provider's message. */
export async function dfsTask(env, path, task, charge) {
  const r = await fetch(`https://api.dataforseo.com/v3/${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`)}`, "content-type": "application/json" },
    body: JSON.stringify([task]), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => null);
  const t = j?.tasks?.[0];
  const ok = r.ok && j?.status_code === 20000 && t?.status_code === 20000;
  charge?.({ provider: "dataforseo", operation: path, units: 1, cost_usd: Number(t?.cost ?? j?.cost) || 0, ok });
  if (!ok) throw new Error(t?.status_message || j?.status_message || `HTTP ${r.status}`);
  return t.result || [];
}

const kwRow = (kd, extra = {}) => ({
  keyword: String(kd?.keyword || ""), volume: n(kd?.keyword_info?.search_volume), cpc: n(kd?.keyword_info?.cpc),
  difficulty: n(kd?.keyword_properties?.keyword_difficulty), intent: kd?.search_intent_info?.main_intent || null, ...extra,
});

/** Keywords the domain ranks for, related keyword ideas and a reproducible search-visibility score. */
export async function keywordsModule(env, { domain, market }, charge) {
  if (!dfsConfigured(env)) return unavailable(DFS_SOURCE, "Keyword volumes, difficulty and rankings need a keyword data provider. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to turn this on.");
  const m = MARKETS[market] || MARKETS.US;
  try {
    const [ranked, ideas] = await Promise.all([
      dfsTask(env, "dataforseo_labs/google/ranked_keywords/live", { target: domain, location_code: m.code, language_code: m.lang, limit: 100 }, charge),
      dfsTask(env, "dataforseo_labs/google/keywords_for_site/live", { target: domain, location_code: m.code, language_code: m.lang, limit: 50 }, charge),
    ]);
    const rankedRows = (ranked[0]?.items || []).map(it => kwRow(it.keyword_data, {
      position: n(it.ranked_serp_element?.serp_item?.rank_absolute) ?? n(it.ranked_serp_element?.serp_item?.rank_group),
      url: it.ranked_serp_element?.serp_item?.url || null,
    })).filter(k => k.keyword && k.position !== null).sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const ideaRows = (ideas[0]?.items || []).map(it => kwRow(it)).filter(k => k.keyword).sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const vol = rankedRows.reduce((s, k) => s + (k.volume || 0), 0);
    const top10 = rankedRows.filter(k => k.position <= 10).reduce((s, k) => s + (k.volume || 0), 0);
    return {
      status: "ok", source: `${DFS_SOURCE} Labs (Google, ${m.label})`, fetched_at: now(),
      data: {
        market: m.label, ranked: rankedRows, ideas: ideaRows.slice(0, 50), total_ranked: ranked[0]?.total_count ?? rankedRows.length,
        // Share of the ranked keywords' search volume where the site is on page one. Shown as "Search visibility".
        visibility_score: vol ? Math.round((top10 / vol) * 100) : null,
      },
    };
  } catch (err) {
    console.error("[keywords] DataForSEO failed:", err.message);
    return failed(DFS_SOURCE, `The keyword provider returned an error: ${err.message}`);
  }
}

/** Domains DataForSEO sees competing for the same keywords (suggestions only; the owner decides). */
export async function suggestCompetitors(env, { domain, market }, charge) {
  if (!dfsConfigured(env)) return [];
  const m = MARKETS[market] || MARKETS.US;
  try {
    const res = await dfsTask(env, "dataforseo_labs/google/competitors_domain/live", { target: domain, location_code: m.code, language_code: m.lang, limit: 10, exclude_top_domains: true }, charge);
    return (res[0]?.items || []).filter(i => i.domain && i.domain !== domain).slice(0, 8)
      .map(i => ({ domain: i.domain, shared_keywords: n(i.intersections), avg_position: n(i.avg_position) }));
  } catch (err) { console.error("[competitors] suggestions failed:", err.message); return []; }
}

async function backlinkSummary(env, target, charge) {
  const s = (await dfsTask(env, "backlinks/summary/live", { target, include_subdomains: true }, charge))[0] || {};
  return { target, backlinks: n(s.backlinks), referring_domains: n(s.referring_domains), referring_domains_nofollow: n(s.referring_domains_nofollow),
    rank: n(s.rank), broken_backlinks: n(s.broken_backlinks), spam_score: n(s.backlinks_spam_score),
    nofollow_links: n(s.referring_links_attributes?.nofollow) };
}

/** Backlink profile for the domain and (up to 3) competitors. Score only relative to measured competitors. */
export async function backlinksModule(env, { domain, competitors = [], previous = null }, charge) {
  if (!dfsConfigured(env)) return unavailable(DFS_SOURCE, "Backlink data needs a backlink provider. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to turn this on.");
  try {
    const [self, anchors, domains] = await Promise.all([
      backlinkSummary(env, domain, charge),
      dfsTask(env, "backlinks/anchors/live", { target: domain, include_subdomains: true, limit: 10, order_by: ["backlinks,desc"] }, charge),
      dfsTask(env, "backlinks/referring_domains/live", { target: domain, include_subdomains: true, limit: 10, order_by: ["rank,desc"] }, charge),
    ]);
    const comp = [];
    for (const c of competitors.slice(0, 3)) { try { comp.push(await backlinkSummary(env, c, charge)); } catch (err) { comp.push({ target: c, error: err.message }); } }
    const rds = comp.map(c => c.referring_domains).filter(v => v !== null && v !== undefined).sort((a, b) => a - b);
    const median = rds.length ? rds[Math.floor(rds.length / 2)] : null;
    return {
      status: "ok", source: `${DFS_SOURCE} Backlinks`, fetched_at: now(),
      data: {
        self, competitors: comp,
        anchors: (anchors[0]?.items || []).map(a => ({ anchor: a.anchor || "(empty)", backlinks: n(a.backlinks), referring_domains: n(a.referring_domains) })),
        top_referring_domains: (domains[0]?.items || []).map(d => ({ domain: d.domain, rank: n(d.rank), backlinks: n(d.backlinks), first_seen: d.first_seen || null })),
        // Referring domains relative to the median tracked competitor, capped at 100. Null without competitor data.
        score: median ? Math.min(100, Math.round((100 * (self.referring_domains || 0)) / median)) : null,
        change_since_last: previous?.self?.referring_domains != null && self.referring_domains != null ? self.referring_domains - previous.self.referring_domains : null,
      },
    };
  } catch (err) {
    console.error("[backlinks] DataForSEO failed:", err.message);
    return failed(DFS_SOURCE, `The backlink provider returned an error: ${err.message}`);
  }
}

/** Keywords two domains both rank for (DataForSEO domain intersection). */
export async function keywordOverlap(env, { domain, competitor, market }, charge) {
  const m = MARKETS[market] || MARKETS.US;
  const res = await dfsTask(env, "dataforseo_labs/google/domain_intersection/live", { target1: domain, target2: competitor, location_code: m.code, language_code: m.lang, limit: 10 }, charge);
  return { shared: n(res[0]?.total_count), examples: (res[0]?.items || []).slice(0, 5).map(i => i.keyword_data?.keyword).filter(Boolean) };
}

// ─── competitors (our own scans of their homepages; no provider needed) ───────

/**
 * Runs the HeyRanks homepage scan on each competitor and compares it with the site's own scan.
 * scanFn(host) -> the runScan result (or null if unreachable).
 */
export async function competitorsModule(env, { self, selfScan, competitors, market }, scanFn, charge) {
  if (!competitors.length) return unavailable("HeyRanks", "Add up to 5 competitor websites to compare against.");
  const sites = await Promise.all(competitors.slice(0, 5).map(async host => {
    const scan = await scanFn(host).catch(() => null);
    if (!scan) return { host, error: "Couldn't open this site." };
    const p = scan.home?.page;
    return {
      host, score: scan.score, speed: scan.speed,
      categories: Object.fromEntries(Object.values(scan.scores.categories).map(c => [c.id, c.score])),
      checks: scan.checks.filter(c => c.status !== "na").map(c => ({ id: c.id, status: c.status })),
      structure: { sitemap_urls: scan.sitemapUrls ?? null, nav: (p?.links.internal || []).filter(l => l.text).slice(0, 12).map(l => ({ text: l.text.slice(0, 40), url: l.url })) },
      topics: (p?.headings || []).filter(h => h.level <= 2).slice(0, 8).map(h => h.text),
      schema_types: p?.jsonld.types.slice(0, 8) || [], words: p?.words ?? null,
    };
  }));
  if (dfsConfigured(env)) {
    for (const s of sites.filter(x => !x.error)) {
      try { s.keyword_overlap = await keywordOverlap(env, { domain: self, competitor: s.host, market }, charge); } catch (err) { s.keyword_overlap = { error: err.message }; }
    }
  }
  const labels = {};
  for (const c of selfScan.checks) labels[c.id] = c.title;
  return {
    status: sites.every(s => s.error) ? "error" : "ok", source: "HeyRanks scans of competitor homepages" + (dfsConfigured(env) ? " + DataForSEO keyword overlap" : ""), fetched_at: now(),
    data: {
      self: { host: self, score: selfScan.score, speed: selfScan.speed, categories: Object.fromEntries(Object.values(selfScan.scores.categories).map(c => [c.id, c.score])),
        checks: selfScan.checks.filter(c => c.status !== "na").map(c => ({ id: c.id, status: c.status })), sitemap_urls: selfScan.sitemapUrls ?? null,
        words: selfScan.home?.page?.words ?? null, schema_types: selfScan.home?.page?.jsonld.types.slice(0, 8) || [] },
      sites, labels,
    },
    message: sites.some(s => s.error) ? "Some competitor sites couldn't be opened." : null,
  };
}

// ─── AI search visibility ─────────────────────────────────────────────────────

const ESTIMATED_CALL_USD = 0.01; // non-Anthropic providers: flat estimate per answer, labelled as an estimate

async function askClaude(env, q, budget) {
  const r = await claudeRequest(env, { prompt: q, maxTokens: 2500, effort: "low", purpose: "ai_visibility" }, budget);
  if (r.status !== "ok") throw new Error(r.message || r.status);
  return { text: r.text, model: r.model, citations: [] };
}
async function askOpenAI(env, q) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.OPENAI_MODEL, messages: [{ role: "user", content: q }], max_completion_tokens: 1200 }), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return { text: j.choices?.[0]?.message?.content || "", model: j.model || env.OPENAI_MODEL, citations: [] };
}
async function askGemini(env, q) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: q }] }] }), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return { text: (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join(""), model: j.modelVersion || env.GEMINI_MODEL, citations: [] };
}
async function askPerplexity(env, q) {
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${env.PERPLEXITY_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.PERPLEXITY_MODEL, messages: [{ role: "user", content: q }] }), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  const cites = [...(j.citations || []), ...(j.search_results || []).map(s => s.url)].filter(u => typeof u === "string");
  return { text: j.choices?.[0]?.message?.content || "", model: j.model || env.PERPLEXITY_MODEL, citations: [...new Set(cites)] };
}

export const AI_PROVIDERS = [
  { id: "anthropic", label: "Claude", grounded: false, configured: env => !!env.ANTHROPIC_API_KEY, needs: "ANTHROPIC_API_KEY", ask: askClaude, model: env => claudeModel(env) },
  { id: "openai", label: "ChatGPT (OpenAI API)", grounded: false, configured: env => !!(env.OPENAI_API_KEY && env.OPENAI_MODEL), needs: "OPENAI_API_KEY and OPENAI_MODEL", ask: askOpenAI, model: env => env.OPENAI_MODEL },
  { id: "gemini", label: "Gemini (Google AI)", grounded: false, configured: env => !!(env.GEMINI_API_KEY && env.GEMINI_MODEL), needs: "GEMINI_API_KEY and GEMINI_MODEL", ask: askGemini, model: env => env.GEMINI_MODEL },
  { id: "perplexity", label: "Perplexity", grounded: true, configured: env => !!(env.PERPLEXITY_API_KEY && env.PERPLEXITY_MODEL), needs: "PERPLEXITY_API_KEY and PERPLEXITY_MODEL", ask: askPerplexity, model: env => env.PERPLEXITY_MODEL },
];

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Brand / competitor names to look for: the brand, the domain, and the domain's distinctive first label. */
export function nameTerms(brand, domain) {
  const terms = new Set();
  if (brand && brand.trim().length >= 3) terms.add(brand.trim());
  if (domain) { terms.add(domain); const label = domain.split(".")[0]; if (label.length >= 5) terms.add(label); }
  return [...terms];
}
const termRe = terms => (terms.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${terms.map(t => escRe(t).replace(/\s+/g, "[\\s-]*")).join("|")})(?![\\p{L}\\p{N}])`, "iu") : null);

/** Does the answer mention the brand / which competitors; the sentences that mention the brand. */
export function detectMentions(text, brandTerms, competitors) {
  const brandRe = termRe(brandTerms);
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const contexts = brandRe ? sentences.filter(s => brandRe.test(s)).slice(0, 3).map(s => s.slice(0, 300)) : [];
  return {
    brand: !!brandRe && brandRe.test(text),
    contexts,
    competitors: competitors.filter(c => termRe(c.terms)?.test(text)).map(c => c.domain),
    urls: [...new Set((String(text).match(/https?:\/\/[^\s)\]>"']+/g) || []).map(u => u.replace(/[.,;]+$/, "")))].slice(0, 10),
  };
}

/** Default questions from the owner's keywords (the owner can replace them in Settings). */
export function defaultQuestions(keywords, marketLabel) {
  return (keywords || []).slice(0, 4).map(k => `What are the best options for ${k}${marketLabel ? ` in ${marketLabel}` : ""}? Please name specific businesses or websites.`);
}

/**
 * Asks each configured assistant every question once (sample size = questions × providers) and records
 * whether the brand and competitors are mentioned, the citations and the passages that mention the brand.
 */
export async function aiVisibilityModule(env, { domain, brand, questions, competitors = [], marketLabel }, budget) {
  const providers = AI_PROVIDERS.filter(p => p.configured(env));
  if (!providers.length) return unavailable("AI providers", `No AI provider is configured. Set ${AI_PROVIDERS.map(p => p.needs).join("; ")}.`);
  const qs = questions.slice(0, Number(env.AI_VISIBILITY_MAX_QUESTIONS) || 5);
  if (!qs.length) return unavailable("AI providers", "Add the questions your customers ask (or keywords) in the report settings to measure AI visibility.");
  const brandName = brand || domain;
  const brandQ = `What do you know about ${brandName} (${domain})? Answer briefly.`;
  const all = [...qs.map(q => ({ q, brand_question: false })), { q: brandQ, brand_question: true }];
  const brandTerms = nameTerms(brand, domain);
  const comp = competitors.map(d => ({ domain: d, terms: nameTerms(null, d) }));

  const jobs = providers.flatMap(p => all.map(x => ({ p, ...x })));
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const asked_at = now();
      if (budget && j.p.id !== "anthropic" && !budget.allows(ESTIMATED_CALL_USD)) {
        results.push({ provider: j.p.id, provider_label: j.p.label, model: j.p.model(env), question: j.q, brand_question: j.brand_question, asked_at, error: "Skipped: the data budget for this audit is used up." });
        continue;
      }
      try {
        const a = await j.p.ask(env, j.q, budget);
        if (j.p.id !== "anthropic") budget?.charge({ provider: j.p.id, operation: "ai_visibility", units: 1, cost_usd: ESTIMATED_CALL_USD, ok: true, estimated: true });
        const m = detectMentions(a.text, brandTerms, comp);
        const citations = [...new Set([...a.citations, ...m.urls])].slice(0, 12);
        results.push({ provider: j.p.id, provider_label: j.p.label, grounded: j.p.grounded, model: a.model, question: j.q, brand_question: j.brand_question, asked_at,
          brand_mentioned: m.brand, competitors: m.competitors, citations, cites_site: citations.some(u => sameSite(u, domain)), contexts: m.contexts,
          answer: a.text.slice(0, 2500) });
      } catch (err) {
        results.push({ provider: j.p.id, provider_label: j.p.label, model: j.p.model(env), question: j.q, brand_question: j.brand_question, asked_at, error: String(err.message || err).slice(0, 200) });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // Sentiment of the passages that mention the brand (Claude, when configured).
  const passages = results.flatMap((r, i) => (r.contexts || []).length ? [{ ref: `A${i}`, text: r.contexts.join(" ") }] : []);
  const sentiment = env.ANTHROPIC_API_KEY ? await classifySentiment(env, brandName, passages, budget) : { status: "unavailable", map: new Map() };
  results.forEach((r, i) => { const s = sentiment.map.get(`A${i}`); if (s) Object.assign(r, { sentiment: s.sentiment, sentiment_reason: s.reason }); else if (r.contexts?.length) r.sentiment = null; });

  const answered = results.filter(r => !r.error && !r.brand_question);
  const mentioned = answered.filter(r => r.brand_mentioned).length;
  const byProvider = providers.map(p => {
    const rs = answered.filter(r => r.provider === p.id);
    return { provider: p.id, label: p.label, model: results.find(r => r.provider === p.id && r.model)?.model || p.model(env), grounded: p.grounded,
      answered: rs.length, mentioned: rs.filter(r => r.brand_mentioned).length, errors: results.filter(r => r.provider === p.id && r.error).length,
      rate: rs.length ? Math.round((rs.filter(r => r.brand_mentioned).length / rs.length) * 100) : null };
  });
  const questionsOut = all.map(x => {
    const rs = results.filter(r => r.question === x.q && !r.error);
    return { question: x.q, brand_question: x.brand_question, answered: rs.length, mentions: rs.filter(r => r.brand_mentioned).length,
      competitors_mentioned: [...new Set(rs.flatMap(r => r.competitors))] };
  });
  return {
    status: answered.length ? (results.some(r => r.error) ? "partial" : "ok") : "error",
    source: providers.map(p => p.label).join(", "), fetched_at: now(),
    message: results.some(r => r.error) ? `${results.filter(r => r.error).length} of ${results.length} questions failed.` : null,
    data: {
      sample_size: answered.length,
      score: answered.length ? Math.round((mentioned / answered.length) * 100) : null,
      confidence: answered.length >= 20 ? "medium" : "low",
      providers: byProvider,
      questions: questionsOut,
      competitors: comp.map(c => ({ domain: c.domain, mentioned: answered.filter(r => r.competitors.includes(c.domain)).length, rate: answered.length ? Math.round((answered.filter(r => r.competitors.includes(c.domain)).length / answered.length) * 100) : null })),
      sentiment: sentiment.status,
      results,
    },
  };
}
