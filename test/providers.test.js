// External providers and the Claude helper, against fake HTTP responses. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageSpeed, keywordsModule, backlinksModule, detectMentions, nameTerms, aiVisibilityModule, defaultQuestions } from "../lib/providers.js";
import { claudeJson, claudeRequest, validateSchema, Budget, claudeCost, growthStrategist, contentStrategist } from "../lib/ai.js";

async function withFetch(handler, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null }); return handler(String(url), init); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test("PageSpeed: lab metrics, field data (URL first, then origin), failing audits", () => {
  const r = parsePageSpeed({
    lighthouseResult: {
      lighthouseVersion: "12.0.0", finalDisplayedUrl: "https://example.com/",
      categories: { performance: { score: 0.42, auditRefs: [{ id: "largest-contentful-paint", group: "metrics" }, { id: "render-blocking-insight" }, { id: "unused-javascript" }] },
        accessibility: { score: 0.78, auditRefs: [{ id: "color-contrast" }, { id: "image-alt" }] } },
      audits: {
        "largest-contentful-paint": { numericValue: 5200, score: 0.1 }, "cumulative-layout-shift": { numericValue: 0.31 }, "total-blocking-time": { numericValue: 640 },
        "render-blocking-insight": { id: "render-blocking-insight", title: "Render blocking requests", score: 0, scoreDisplayMode: "metricSavings", metricSavings: { LCP: 900 } },
        "unused-javascript": { id: "unused-javascript", title: "Reduce unused JavaScript", score: 0.5, scoreDisplayMode: "numeric", displayValue: "Est savings of 120 KiB", details: { overallSavingsMs: 300 } },
        "color-contrast": { id: "color-contrast", title: "Low contrast text", score: 0, scoreDisplayMode: "binary", details: { items: [{}, {}] } },
        "image-alt": { id: "image-alt", title: "Image alt", score: 1, scoreDisplayMode: "binary" },
      },
    },
    loadingExperience: { origin_fallback: true, metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 9999 } } },
    originLoadingExperience: { overall_category: "SLOW", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 }, INTERACTION_TO_NEXT_PAINT: { percentile: 280 } } },
  }, "mobile");
  assert.equal(r.scores.performance, 42);
  assert.equal(r.scores.accessibility, 78);
  assert.equal(r.lab.lcp_ms, 5200);
  assert.equal(r.field.source, "origin", "URL data that fell back to origin isn't treated as URL data");
  assert.equal(r.field.lcp_ms, 3100);
  assert.equal(r.field.cls, 0.12, "CrUX reports CLS ×100");
  assert.deepEqual(r.opportunities.map(o => o.id), ["render-blocking-insight", "unused-javascript"]);
  assert.deepEqual(r.a11y_failures, [{ id: "color-contrast", title: "Low contrast text", items: 2 }]);
});

test("DataForSEO: unavailable without credentials, nothing invented", async () => {
  await withFetch(() => { throw new Error("must not call"); }, async () => {
    const k = await keywordsModule({}, { domain: "example.com", market: "IN" });
    assert.equal(k.status, "unavailable");
    assert.equal(k.data, null);
    assert.match(k.message, /DATAFORSEO_LOGIN/);
    assert.equal((await backlinksModule({}, { domain: "example.com" })).status, "unavailable");
  });
});

test("DataForSEO: parses ranked keywords and ideas, records cost, computes visibility", async () => {
  const env = { DATAFORSEO_LOGIN: "u", DATAFORSEO_PASSWORD: "p" };
  const charges = [];
  await withFetch(url => {
    const ok = result => Response.json({ status_code: 20000, cost: 0.02, tasks: [{ status_code: 20000, cost: 0.02, result }] });
    if (url.endsWith("ranked_keywords/live")) return ok([{ total_count: 2, items: [
      { keyword_data: { keyword: "dentist bhubaneswar", keyword_info: { search_volume: 900, cpc: 1.2 }, keyword_properties: { keyword_difficulty: 31 }, search_intent_info: { main_intent: "commercial" } }, ranked_serp_element: { serp_item: { rank_absolute: 14, url: "https://example.com/" } } },
      { keyword_data: { keyword: "root canal cost", keyword_info: { search_volume: 100 } }, ranked_serp_element: { serp_item: { rank_absolute: 3, url: "https://example.com/rct" } } },
    ] }]);
    if (url.endsWith("keywords_for_site/live")) return ok([{ items: [{ keyword: "teeth whitening", keyword_info: { search_volume: 500 }, keyword_properties: { keyword_difficulty: 20 } }] }]);
    throw new Error("unexpected " + url);
  }, async calls => {
    const k = await keywordsModule(env, { domain: "example.com", market: "IN" }, ev => charges.push(ev));
    assert.equal(k.status, "ok");
    assert.equal(calls[0].init.headers.authorization, `Basic ${btoa("u:p")}`);
    assert.equal(calls[0].body[0].location_code, 2356);
    assert.deepEqual(k.data.ranked.map(r => [r.keyword, r.position, r.volume, r.difficulty]), [["dentist bhubaneswar", 14, 900, 31], ["root canal cost", 3, 100, null]]);
    assert.equal(k.data.visibility_score, 10, "100 of 1000 monthly searches are on page one");
    assert.equal(charges.reduce((s, c) => s + c.cost_usd, 0), 0.04);
  });
});

test("DataForSEO errors are reported, not hidden", async () => {
  await withFetch(() => Response.json({ status_code: 40100, status_message: "You are not authorized" }, { status: 401 }), async () => {
    const k = await keywordsModule({ DATAFORSEO_LOGIN: "u", DATAFORSEO_PASSWORD: "bad" }, { domain: "example.com", market: "US" });
    assert.equal(k.status, "error");
    assert.match(k.message, /not authorized/);
  });
});

test("AI visibility: mention detection is word-bounded and finds competitors and URLs", () => {
  const terms = nameTerms("Sunrise Dental", "sunrisedental.in");
  assert.deepEqual(terms, ["Sunrise Dental", "sunrisedental.in", "sunrisedental"]);
  const m = detectMentions("Try Sunrise  Dental near the station. Also SmileCare (https://smilecare.in/about). Sunrisedentalia is unrelated.", terms,
    [{ domain: "smilecare.in", terms: nameTerms(null, "smilecare.in") }]);
  assert.equal(m.brand, true);
  assert.equal(m.contexts.length, 1);
  assert.deepEqual(m.competitors, ["smilecare.in"]);
  assert.deepEqual(m.urls, ["https://smilecare.in/about"]);
  assert.equal(detectMentions("Sunrisedentalia is a different firm.", terms, []).brand, false);
  assert.match(defaultQuestions(["dentist"], "India")[0], /dentist in India/);
});

test("AI visibility: unavailable without providers; samples every configured provider", async () => {
  assert.equal((await aiVisibilityModule({}, { domain: "example.com", questions: ["q1 is long enough"] })).status, "unavailable");
  const env = { OPENAI_API_KEY: "k", OPENAI_MODEL: "test-model", PERPLEXITY_API_KEY: "p", PERPLEXITY_MODEL: "sonar-test" };
  await withFetch(url => {
    if (url.includes("openai")) return Response.json({ model: "test-model-2026", choices: [{ message: { content: "Popular choices are SmileCare and Example Dental." } }] });
    if (url.includes("perplexity")) return Response.json({ model: "sonar-test", citations: ["https://example.com/", "https://smilecare.in/"], choices: [{ message: { content: "Example Dental is well reviewed [1]." } }] });
    throw new Error("unexpected " + url);
  }, async () => {
    const v = await aiVisibilityModule(env, { domain: "example.com", brand: "Example Dental", questions: ["Best dentist in town?"], competitors: ["smilecare.in"] }, new Budget(1));
    assert.equal(v.status, "ok");
    assert.equal(v.data.sample_size, 2, "1 question × 2 providers (the brand question is reported separately)");
    assert.equal(v.data.score, 100);
    assert.equal(v.data.providers.find(p => p.provider === "perplexity").grounded, true);
    const px = v.data.results.find(r => r.provider === "perplexity" && !r.brand_question);
    assert.equal(px.cites_site, true);
    assert.equal(v.data.sentiment, "unavailable", "no Claude key, so sentiment isn't guessed");
    assert.equal(v.data.competitors[0].mentioned, 1);
  });
});

test("Claude: request shape, structured output, refusal, schema mismatch and budget", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" };
  const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
  let reply;
  await withFetch(() => Response.json(reply), async calls => {
    reply = { model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 500 }, content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":"ok"}' }] };
    const budget = new Budget(1);
    const ok = await claudeJson(env, { prompt: "hi", schema, purpose: "t" }, budget);
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.data, { a: "ok" });
    const req = calls[0];
    assert.equal(req.init.headers["anthropic-version"], "2026-10-21");
    assert.equal(req.init.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal(req.body.model, "claude-opus-5-5");
    assert.equal(req.body.fallbacks, "default");
    assert.deepEqual(req.body.output_config.format, { type: "json_schema", schema });
    assert.equal(req.body.temperature, undefined, "no sampling parameters on API 2026-10-21");
    assert.equal(budget.spent, claudeCost("claude-opus-5-5", { input_tokens: 1000, output_tokens: 500 }));
    assert.equal(budget.spent, 0.014);

    reply = { ...reply, content: [{ type: "text", text: '{"a":1}' }] };
    assert.equal((await claudeJson(env, { prompt: "hi", schema }, null)).data, null, "outside the schema is discarded");
    reply = { ...reply, stop_reason: "refusal", stop_details: { explanation: "no" }, content: [] };
    assert.equal((await claudeRequest(env, { prompt: "hi" })).status, "refused");
    const n = calls.length;
    assert.equal((await claudeRequest(env, { prompt: "x".repeat(100), maxTokens: 8000 }, new Budget(0.01))).status, "over_budget");
    assert.equal(calls.length, n, "an over-budget call is never sent");
  });
  assert.equal((await claudeRequest({}, { prompt: "hi" })).status, "unavailable");
  assert.deepEqual(validateSchema(schema, { a: "x", b: 1 }), ["$.b isn't allowed"]);
});

test("Analysts: only references to real findings and crawled pages survive", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" };
  const answers = {
    growth: { executive_summary: "Fix HTTPS first.", top_priorities: [{ finding_ref: "F1", why_first: "Browsers warn visitors." }, { finding_ref: "F99", why_first: "made up" }], week_focus: [{ week: 1, focus: "HTTPS" }, { week: 9, focus: "nope" }] },
    content: { meta_suggestions: [{ page_ref: "P1", title: "T", description: "D", reason: "R" }, { page_ref: "P7", title: "x", description: "x", reason: "x" }], article_ideas: [], internal_links: [{ from_ref: "P1", to_ref: "P1", anchor: "self", reason: "x" }], content_improvements: [] },
  };
  await withFetch((url, init) => {
    const body = JSON.parse(init.body);
    const which = body.output_config.format.schema.properties.executive_summary ? "growth" : "content";
    if (which === "content") assert.match(body.messages[0].content, /<untrusted_website_data>/, "page text is fenced as untrusted data");
    return Response.json({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: "text", text: JSON.stringify(answers[which]) }] });
  }, async () => {
    const g = await growthStrategist(env, { host: "example.com", scores: { overall: 50, coverage: 90, confidence: "high", categories: {} }, findings: [{ fingerprint: "https", severity: "critical", category: "security", title: "No HTTPS", evidence: {} }], modules: {} }, new Budget(1));
    assert.deepEqual(g.top_priorities, [{ fingerprint: "https", why_first: "Browsers warn visitors." }]);
    assert.deepEqual(g.week_focus.map(w => w.week), [1]);
    const c = await contentStrategist(env, { host: "example.com", pages: [{ url: "https://example.com/", title: "Home", words: 10, needs_meta: true, headings: [] }] }, new Budget(1));
    assert.equal(c.meta_suggestions.length, 1);
    assert.equal(c.meta_suggestions[0].url, "https://example.com/");
    assert.equal(c.internal_links.length, 0, "a page linking to itself is dropped");
  });
});
