# HeyRanks

Website growth intelligence for small businesses: a free 40-check homepage scan, and on the $10 pass a
50-page full-site audit with evidence for every finding, category scores, competitor comparison, optional
keyword / backlink / AI-visibility data, a 30-day roadmap, weekly monitoring and period reports.
Admins see revenue, customers, signups, visits and external API costs.

## Run it locally

```
npm install
npm run seed:demo      # optional: demo login with 70 weeks of history + demo customers
npm run dev            # http://localhost:8787  (SQLite file in .data/dev.db)
npm test               # API, period maths and legacy-migration tests
```

Demo login: `demo@heyranks.com` / `demo-password`. To open `/admin` locally, start the server with
`ADMIN_EMAILS=demo@heyranks.com npm run dev`. Without `RESEND_API_KEY`, no email is sent: login and
reset links are printed in the terminal instead.

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing page: free scan, live counters, pricing |
| `signup.html`, `login.html`, `reset.html` | Accounts: password, email login link, password reset |
| `payment.html` | Return page after Cashfree checkout: confirms the payment and shows the plan |
| `dashboard.html` | User dashboard: scores, category health, full-audit card, period reports, fixes, account settings |
| `report.html` | Full-site audit report: 19 sections, issue drawer, filters, roadmap, settings; prints to PDF |
| `admin.html` | Admin: revenue, customers, signups, visits, user management |
| `assets/app.css`, `assets/app.js` | Shared styles, API helper and SVG charts for the app pages |
| `lib/api.js` | Every `/api/*` route |
| `lib/schema.js` | **Database schema + migrations** (source of truth; runs automatically) |
| `lib/reports.js` | Weekly → yearly period roll-ups |
| `lib/auth.js` | Password hashing, sessions, login tokens, rate limits |
| `lib/cashfree.js` | Cashfree Orders API client and webhook signature check |
| `lib/plans.js` | Plans, prices and granting a plan (shared by the API and the daily job) |
| `lib/analytics.js` | Visitor analytics: records page views, builds the Admin → Visitors report |
| `assets/track.js` | Page-view tracker included on the public pages (no cookies) |
| `lib/core.js` | Email templates, saving scans, the daily job |
| `lib/scan.js` | Homepage scan: collects site-wide evidence in parallel and scores it |
| `lib/audit.js` | Full-site audit job: resumable crawl, link checks, data modules, AI analysts, findings, re-checks |
| `lib/analysis.js` | Pure scoring engine: checks → findings, category scores, coverage, roadmap, diffs |
| `lib/catalog.js` | Every check's meaning: severity, why, impact, steps, code, time, expertise, verification, references |
| `lib/crawler.js` | robots.txt (RFC 9309), sitemaps, URL rules, HTML extraction |
| `lib/domain.js` | Organizational domain, SPF / DMARC / DKIM / MX analysis, DNSSEC, RDAP, TLS certificate |
| `lib/net.js` | SSRF-safe fetching (every redirect hop must resolve to a public address), size caps |
| `lib/providers.js` | PageSpeed Insights, DataForSEO, AI-visibility providers, competitor comparison |
| `lib/ai.js` | Claude calls (structured JSON, budgets, refusal fallbacks) and the AI analysts |
| `lib/db.js` | Turso/libSQL adapter with the D1 API (Vercel + local) |
| `_worker.js` / `api/index.js` | Cloudflare / Vercel entry points (both call `lib/api.js`) |
| `scripts/dev.mjs` | Local server |
| `scripts/seed-demo.mjs` | Demo data (tagged, never counted in real stats) |
| `scripts/make-admin.mjs` | Makes an existing account an admin directly in the database |

## Data model

```
users 1─* sites 1─* scans          every scan result (signup, weekly, manual)
               1─* reports        roll-ups per weekly | monthly | quarterly | half_yearly | yearly period
users 1─* sessions, auth_tokens   logins (only SHA-256 hashes of tokens are stored)
users 1─* payments                verified payments → revenue stats
sites 1─* audits 1─* audit_pages  full-site audits; crawl queue + extracted pages (kept 45 days)
                 1─* findings     problems found by an audit (evidence only; text comes from lib/catalog.js)
sites 1─* finding_status          the owner's done / ignored / verified state per finding, kept across audits
sites 1─* competitors             competitor domains the owner tracks
usage_events                      every paid external call and its cost (AI, keyword/backlink data)
rate_limits, page_views, meta     abuse limits, anonymous daily visit counts, schema version
```

Every scan updates the five reports whose period contains it, so the current week, month,
quarter, half-year and year are always live in the database. A period's report stops changing
when the period ends. Each report stores start/end/average/min/max score, mobile speed, and the issues
fixed, new and still open, compared with the last scan before the period began. Periods are calendar
periods in UTC (weeks run Monday to Sunday).

The schema migrates itself on the first API request. The old `customers`/`reports` tables are renamed
to `legacy_customers`/`legacy_reports`, and their data is copied into users, sites, scans and reports
(`test/migration.test.js`).

## Plans

| Plan | Sites | Weekly email | Period summaries by email | Rescans/day |
|---|---|---|---|---|
| Free | 1 | – | – | 3 |
| 180-Day Pass ($10, charged as ₹849) | 1 | ✓ | ✓ | 10 |
| Lifetime (no longer sold; existing customers keep it) | 3 | ✓ | ✓ | 10 |

Prices live in `PLANS` in `lib/plans.js`: `price` is the advertised USD price in cents, `cashfree_price`
is what Cashfree charges in paise. The landing page copy repeats the $10, so change both.
New accounts start on Free. A paid plan is switched on by a **Cashfree payment**, by a verified
webhook from another provider (INR at ≥ `cashfree_price`, or USD at ≥ `price`), or by an admin
(Admin → Users → Manage).

- **A full refund removes access automatically.** A refunded 180-Day Pass loses its 180 days, and a refunded
  Lifetime plan returns to Free. Partial refunds don't change access.
- **Full-site audits are paid-plan only** (3 per site per day, 20 per user per month, plus one automatic
  weekly audit per site). The free plan gets the homepage scan.

## Scoring (score_version 2)

Every check is pass / warn (half credit) / fail / not measured. Not-measured checks are left out of every
score, never counted as failures. Page-level checks earn credit in proportion to the share of crawled pages
that pass. A category score is earned ÷ possible points of its measured checks; the overall Website Growth
Health Score weights the nine health categories (Technical 20, On-page 15, Performance 15, Content 10,
AI readiness 10, Security 10, Email 10, UX 5, Conversion 5). Any critical problem caps the overall score at
59. Each problem is scored once, in one category. Domain expiry is an alert, not a deduction. Keyword,
competitor, backlink and AI-visibility data never change the health score. Coverage (share of check weight
measured) and confidence are shown with every score. Scores from before this method (v1) aren't compared
with v2 scores ("since last scan" is hidden across the change).

Email checks use the **organizational domain** (`www.example.co.uk` → `example.co.uk`): SPF and MX are read
there, DMARC at `_dmarc.<organizational domain>` (a record found only at `_dmarc.www…` is reported as
misplaced), SPF on common sending subdomains (`send.`, `bounce.`, `mg.`…) is recognised, and
provider-specific SPF advice is given only when MX or SPF records prove the provider.

## Full-site audits (lib/audit.js)

`POST /api/sites/:id/audits` creates an audit and works on it in the background (`waitUntil`, 240 s per run).
Stages: collect (site-wide evidence, PageSpeed mobile + desktop) → crawl (up to 50 pages: homepage links
first, then sitemap URLs; robots.txt and Crawl-delay respected; same host and its www twin only) → links
(HEAD checks of uncrawled internal links, 30 outbound links, 60 sitemap URLs) → modules (competitors,
keywords, backlinks, AI visibility) → analyze (findings, scores, AI analysts, roadmap, diff). Each stage
saves its progress; a lease stops two workers running one audit. An interrupted audit resumes on the next
status poll or the daily cron. Starting an audit while one is running joins it.

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Vercel | Database (added by the Turso integration) |
| `RESEND_API_KEY` | yes | Email (reports, login links, resets) |
| `ADMIN_EMAILS` | yes | Comma-separated. These users become admins once they confirm their email |
| `SITE_URL` | yes | `https://heyranks.com`. Used for links in emails and payment return URLs. Without it, links use `https://heyranks.com` (never the request's Host header) |
| `FREE_SCANS_PER_HOUR` | optional | Site-wide cap on free homepage scans (default 300), on top of 10 per visitor per hour |
| `CRON_SECRET` | Vercel | Protects `/api/cron` (Vercel sends it automatically) |
| `ADMIN_SECRET` | optional | Manual job run: `POST /api/weekly` with header `X-Admin-Secret` |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` | yes (payments) | Cashfree API keys (merchant.cashfree.com → Developers → API keys) |
| `CASHFREE_ENV` | yes (payments) | `sandbox` for test keys, `production` for live keys |
| `CASHFREE_WEBHOOK_SECRET` | optional | Webhook signing secret, if different from the secret key |
| `PAYMENT_LINK_180DAY`, `PAYMENT_LINK_LIFETIME` | optional | Fallback payment links, used only when Cashfree isn't configured |
| `STRIPE_SECRET` / `RAZORPAY_SECRET` / `LEMONSQUEEZY_SECRET` | optional | Signing secrets for other providers' webhooks. Unsigned webhooks are rejected |
| `CURRENCY` | optional | Main currency in the admin revenue view (default `INR`) |
| `ANTHROPIC_API_KEY` | recommended | Claude: executive summary, content suggestions, sentiment, and Claude as an AI-visibility provider. Without it, summaries are written from the findings and those sections say "not configured" |
| `HEYRANKS_CLAUDE_MODEL` | optional | Claude model for all of the above (default `claude-opus-5-5`). `claude-sonnet-5-5` or `claude-haiku-5-5` cost less; see the cost model below |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | optional | Keyword volumes/difficulty/rankings, competitor suggestions, keyword overlap and backlinks. Without them those sections say "not configured" (nothing is estimated) |
| `OPENAI_API_KEY` + `OPENAI_MODEL` | optional | ChatGPT (OpenAI API) as an AI-visibility provider. Both must be set |
| `GEMINI_API_KEY` + `GEMINI_MODEL` | optional | Gemini as an AI-visibility provider |
| `PERPLEXITY_API_KEY` + `PERPLEXITY_MODEL` | optional | Perplexity (web search with citations) as an AI-visibility provider |
| `AI_VISIBILITY_MAX_QUESTIONS` | optional | Questions per audit (default 5, plus one "what do you know about us" question) |
| `AUDIT_COST_CAP_USD` | optional | Hard cap on paid calls per audit (default 1.50) |
| `USER_MONTHLY_COST_CAP_USD` | optional | Hard cap on paid calls per customer per 30 days (default 3.00). Past it, audits still run but skip paid modules |
| `ANALYTICS_SALT` | optional | Any random string, mixed into the daily anonymous visitor ID |
| `PSI_KEY` | recommended | Google PageSpeed Insights API key. Without it Google's shared quota usually refuses, so scans have no speed score (`speed: null`) |

## Cost model (per full audit)

Every paid call is recorded in `usage_events` with its cost (Claude: priced from token usage; DataForSEO:
the cost its API returns; other AI providers: a flat $0.01 estimate per answer). Admin → Overview shows
the spend by provider and the average and maximum cost per audit.

Rough cost of one owner-started audit with **every** integration on, at the defaults:

| Part | Calls | Approx. cost |
|---|---|---|
| Crawl, DNS, RDAP, TLS, PageSpeed (with `PSI_KEY`) | ~150 HTTP requests | $0 (function time only) |
| Claude analysts (`claude-opus-5-5`) | 2 + sentiment | $0.10–0.25 |
| AI visibility: Claude | 6 answers | $0.05–0.20 |
| AI visibility: OpenAI / Gemini / Perplexity | 6 answers each | ~$0.06 each (estimate; depends on the models you set) |
| DataForSEO (keywords, competitors, backlinks) | ~10–15 live tasks | roughly $0.15–0.40 (actual cost is recorded) |

So **about $0.45–1.10 per audit with everything on**, and $0.15–0.45 with only Claude. Guards that keep a $10
customer profitable:
- weekly audits reuse keyword, backlink and AI-visibility data, and the AI analysis, for 27 days; audits the
  owner starts reuse provider data for 6 days;
- `AUDIT_COST_CAP_USD` (default $1.50) per audit and `USER_MONTHLY_COST_CAP_USD` (default $3) per customer per
  30 days are hard stops: past them, audits complete with measured findings only;
- 3 owner-started audits per site per day, 20 per user per month.

Setting `HEYRANKS_CLAUDE_MODEL=claude-haiku-5-5` cuts the Claude part by roughly 40x; `claude-sonnet-5-5` by
about half. Whether the cheaper model's output is good enough is a product decision, so the default is the
most capable Opus model.

## Deploy on Vercel (+ Turso)

1. vercel.com → **Add New → Project** → import the repo. Framework preset: **Other** (vercel.json sets the rest).
2. Project → **Storage → Create Database → Turso Cloud** → connect. Tables are created on the first request.
3. Add the environment variables above, then **Redeploy**.
4. **Settings → Domains** → add `heyranks.com` and `www.heyranks.com`.
5. Log in once with **“Email me a login link”** using an `ADMIN_EMAILS` address to unlock `/admin`.

`vercel.json` runs `/api/cron` daily at 06:00 UTC. On the first run each week it sends the weekly
reports. The other days it retries failures and emails monthly, quarterly, half-yearly and yearly
summaries once those periods end. It also settles unpaid Cashfree orders, queues a weekly full audit for every
paid site whose last audit is over 6 days old, works on queued audits for up to ~110 s, and cleans up expired
sessions, tokens and old audit data (crawled pages after 45 days, audits and findings after ~13 months).

After deploying, check that query strings reach the API through the `/api/:route*` rewrite (for example,
`/dashboard` → Monthly tab shows monthly rows).

## Admin access

Admins see the business overview, the Visitors tab and user management at `/admin`. There are two ways in.

1. **With email working** (`RESEND_API_KEY` set): add the address to `ADMIN_EMAILS` in Vercel (for example
   `ADMIN_EMAILS=you@example.com`) and redeploy. Sign up with that address, then log in once with
   **“Email me a login link”**. The login link proves you own the address, which unlocks admin.
2. **Without email:** sign up at `/signup`, then copy `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from Vercel
   into `.env.local` (it's git-ignored). Run `node --env-file=.env.local scripts/make-admin.mjs you@example.com`.

After that, an admin can promote others from Admin → Users → Manage.

## Visitor analytics (Admin → Visitors)

Modelled on the market_forecast_web analytics page. It shows:
- unique visitors, page views, pages per visit and sign-up rate;
- daily traffic and a visitor → sign-up → checkout → paid funnel;
- top pages, referrers and UTM campaigns;
- devices, browsers and operating systems;
- countries, cities and traffic by hour (IST);
- recent sessions, with CSV export.

Unlike market_forecast_web, it's private by design:
- **No IP address is stored.** Unique visitors use a hash of IP + browser that changes every day.
- **No third-party lookup.** Location comes from Vercel/Cloudflare geo headers, not an IP lookup service.
- **Minimal referrers.** Only the referring host name is kept, not the full URL.
- **No cookies.**
- **Limited retention.** Rows are deleted after about 13 months.

Bots, headless browsers and admins aren't counted. The public pages load `assets/track.js`; the
dashboard and admin pages aren't tracked.

## Deploy on Cloudflare Pages (+ D1)

```
wrangler pages deploy . --project-name heyranks
wrangler pages secret put RESEND_API_KEY      # and the other variables above
```

The D1 binding is in `wrangler.toml`. Tables are created on the first request (no `d1 execute` step).
`_worker.js` serves only public files, so `lib/`, `scripts/` and other source files aren't downloadable.
For scheduled jobs, use a daily trigger (`0 6 * * *`) that calls `/api/weekly` with `X-Admin-Secret`.

## Payments (Cashfree)

Same approach as the market_forecast_web integration: Orders API `2023-08-01` and the JS SDK v3.

1. A logged-in user clicks a plan. `POST /api/checkout` saves a `pending` payment and creates a
   Cashfree order for ₹849 (the $10 pass). Clicking again within 30 minutes reuses the same order.
2. The browser opens Cashfree's checkout (UPI, cards, net banking, wallets).
3. Cashfree sends the user to `/payment?order_id=…` and calls `/api/webhook/cashfree`.
4. Both of these ask Cashfree's API for the order. The plan is granted only when the order is `PAID`
   for the right amount, and only once, however many times webhooks or page loads arrive.
5. A full-refund webhook marks the payment `refunded`, removes it from revenue and takes back the
   plan it paid for. Partial refunds change nothing.
6. Safety net: the daily cron re-checks Cashfree orders from the last 7 days that are still pending
   (the buyer paid but closed the tab, and the webhook never arrived). Whichever path switches a plan
   on also emails the buyer a receipt.

Setup in the Cashfree dashboard: add the webhook URL `https://heyranks.com/api/webhook/cashfree`
(payment success, failed and refund events), whitelist `heyranks.com`, then set the `CASHFREE_*`
variables. Test with sandbox keys and `CASHFREE_ENV=sandbox` first. Locally, Cashfree can't reach
your webhook, so the `/payment` page settles the order instead.

**Other providers:** `/api/webhook` still accepts signed Stripe (`checkout.session.completed`),
Razorpay (`payment.captured`) and Lemon Squeezy (`order_created`) events, with `plan` in the
metadata. These are matched by email and applied once the user has confirmed that email.
If you take a payment some other way, record it in Admin → Users → Manage so revenue stays accurate.

## Still to do before launch

1. Set `SITE_URL=https://heyranks.com` and `RESEND_API_KEY`, and verify `heyranks.com` in Resend (DKIM).
   Until Resend is set, no report is marked as sent; they all go out once it is.
2. Set the `CASHFREE_*` variables, add the Cashfree webhook, and do one sandbox purchase end to end:
   pay, duplicate webhook, full refund (the plan should end) and partial refund (the plan should stay).
3. Set `PSI_KEY` so speed and Core Web Vitals show on every scan and audit (without it, Performance is
   "not measured").
4. Set `ANTHROPIC_API_KEY` for AI summaries and content suggestions; optionally `DATAFORSEO_*` and the
   OpenAI / Gemini / Perplexity keys + models. Each report lists which sources it used.
5. Have a lawyer review `terms.html`, `privacy.html` and `refund.html` for India (privacy now lists the AI
   and data providers that receive site data).
6. Before adding features to the landing page, ship and test them. Keyword, backlink and AI-answer data
   are described as "where those data sources are switched on".
