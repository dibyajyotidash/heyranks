# HeyRanks

Weekly SEO + AI-visibility reports for small businesses. Users have accounts, track their sites,
and get weekly, monthly, quarterly, half-yearly and yearly reports. Admins see revenue, customers,
signups and visits.

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
| `dashboard.html` | User dashboard: scores, period reports, fixes, account settings |
| `admin.html` | Admin: revenue, customers, signups, visits, user management |
| `assets/app.css`, `assets/app.js` | Shared styles, API helper and SVG charts for the app pages |
| `lib/api.js` | Every `/api/*` route |
| `lib/schema.js` | **Database schema + migrations** (source of truth; runs automatically) |
| `lib/reports.js` | Weekly → yearly period roll-ups |
| `lib/auth.js` | Password hashing, sessions, login tokens, rate limits |
| `lib/cashfree.js` | Cashfree Orders API client and webhook signature check |
| `lib/core.js` | Site scanner, email templates, daily job |
| `lib/db.js` | Turso/libSQL adapter with the D1 API (Vercel + local) |
| `_worker.js` / `api/index.js` | Cloudflare / Vercel entry points (both call `lib/api.js`) |
| `scripts/dev.mjs` | Local server |
| `scripts/seed-demo.mjs` | Demo data (tagged, never counted in real stats) |

## Data model

```
users 1─* sites 1─* scans          every scan result (signup, weekly, manual)
               1─* reports        roll-ups per weekly | monthly | quarterly | half_yearly | yearly period
users 1─* sessions, auth_tokens   logins (only SHA-256 hashes of tokens are stored)
users 1─* payments                verified payments → revenue stats
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
| 180-Day Pass (₹849) | 1 | ✓ | ✓ | 10 |
| Lifetime (₹4,149) | 3 | ✓ | ✓ | 10 |

Prices live in `PLANS` in `lib/core.js` (in paise). The landing page copy repeats them, so change both.
New accounts start on Free. A paid plan is switched on by a **Cashfree payment**, by a verified
webhook from another provider, or by an admin (Admin → Users → Manage).

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Vercel | Database (added by the Turso integration) |
| `RESEND_API_KEY` | yes | Email (reports, login links, resets) |
| `ADMIN_EMAILS` | yes | Comma-separated. These users become admins once they confirm their email |
| `SITE_URL` | recommended | `https://heyranks.com`, used in emailed links |
| `CRON_SECRET` | Vercel | Protects `/api/cron` (Vercel sends it automatically) |
| `ADMIN_SECRET` | optional | Manual job run: `POST /api/weekly` with header `X-Admin-Secret` |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` | yes (payments) | Cashfree API keys (merchant.cashfree.com → Developers → API keys) |
| `CASHFREE_ENV` | yes (payments) | `sandbox` for test keys, `production` for live keys |
| `CASHFREE_WEBHOOK_SECRET` | optional | Webhook signing secret, if different from the secret key |
| `PAYMENT_LINK_180DAY`, `PAYMENT_LINK_LIFETIME` | optional | Fallback payment links, used only when Cashfree isn't configured |
| `STRIPE_SECRET` / `RAZORPAY_SECRET` / `LEMONSQUEEZY_SECRET` | optional | Signing secrets for other providers' webhooks. Unsigned webhooks are rejected |
| `CURRENCY` | optional | Main currency in the admin revenue view (default `INR`) |
| `PSI_KEY` | recommended | Google PageSpeed Insights API key. Without it Google's shared quota usually refuses, so scans have no speed score (`speed: null`) |

## Deploy on Vercel (+ Turso)

1. vercel.com → **Add New → Project** → import the repo. Framework preset: **Other** (vercel.json sets the rest).
2. Project → **Storage → Create Database → Turso Cloud** → connect. Tables are created on the first request.
3. Add the environment variables above, then **Redeploy**.
4. **Settings → Domains** → add `heyranks.com` and `www.heyranks.com`.
5. Log in once with **“Email me a login link”** using an `ADMIN_EMAILS` address to unlock `/admin`.

`vercel.json` runs `/api/cron` daily at 06:00 UTC. On the first run each week it sends the weekly
reports. The other days it retries failures and emails monthly, quarterly, half-yearly and yearly
summaries once those periods end. It also settles unpaid Cashfree orders and cleans up expired sessions and tokens.

After deploying, check that query strings reach the API through the `/api/:route*` rewrite (for example,
`/dashboard` → Monthly tab shows monthly rows).

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
   Cashfree order (₹849 or ₹4,149). Clicking again within 30 minutes reuses the same order.
2. The browser opens Cashfree's checkout (UPI, cards, net banking, wallets).
3. Cashfree sends the user to `/payment?order_id=…` and calls `/api/webhook/cashfree`.
4. Both of these ask Cashfree's API for the order. The plan is granted only when the order is `PAID`
   for the right amount, and only once, however many times webhooks or page loads arrive.
5. A full-refund webhook marks the payment `refunded` and removes it from revenue. Change the user's
   plan in Admin if needed.
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

1. Set `RESEND_API_KEY` and verify `heyranks.com` in Resend (DKIM).
2. Set the `CASHFREE_*` variables, add the Cashfree webhook, and do one sandbox purchase end to end.
3. Several landing-page features aren't built yet: AI-assistant answer tracking, competitor watch,
   WhatsApp alerts, PDF reports, review replies, content ideas. Build them or soften the copy.
4. Have `terms.html`, `privacy.html` and `refund.html` reviewed. The privacy policy should mention
   account data, session IPs (for security) and the anonymous visit counter.
