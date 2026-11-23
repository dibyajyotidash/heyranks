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
| `dashboard.html` | User dashboard: scores, period reports, fixes, account settings |
| `admin.html` | Admin: revenue, customers, signups, visits, user management |
| `assets/app.css`, `assets/app.js` | Shared styles, API helper and SVG charts for the app pages |
| `lib/api.js` | Every `/api/*` route |
| `lib/schema.js` | **Database schema + migrations** (source of truth; runs automatically) |
| `lib/reports.js` | Weekly → yearly period roll-ups |
| `lib/auth.js` | Password hashing, sessions, login tokens, rate limits |
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
| 180-Day Pass ($10) | 1 | ✓ | ✓ | 10 |
| Lifetime ($49) | 3 | ✓ | ✓ | 10 |

New accounts start on Free. A paid plan is switched on by a **verified payment webhook** or by an
admin (Admin → Users → Manage). Payments are matched by email and only applied once the user has
confirmed that email, so nobody can claim someone else's payment by signing up with their address.

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Vercel | Database (added by the Turso integration) |
| `RESEND_API_KEY` | yes | Email (reports, login links, resets) |
| `ADMIN_EMAILS` | yes | Comma-separated. These users become admins once they confirm their email |
| `SITE_URL` | recommended | `https://heyranks.com`, used in emailed links |
| `CRON_SECRET` | Vercel | Protects `/api/cron` (Vercel sends it automatically) |
| `ADMIN_SECRET` | optional | Manual job run: `POST /api/weekly` with header `X-Admin-Secret` |
| `PAYMENT_LINK_180DAY`, `PAYMENT_LINK_LIFETIME` | optional | Stripe/Razorpay payment links for the upgrade buttons |
| `STRIPE_SECRET` / `RAZORPAY_SECRET` / `LEMONSQUEEZY_SECRET` | per provider | Webhook signing secrets. Unsigned webhooks are rejected |
| `CURRENCY` | optional | Main currency in the admin revenue view (default `USD`) |
| `PSI_KEY` | optional | Google PageSpeed key |

## Deploy on Vercel (+ Turso)

1. vercel.com → **Add New → Project** → import the repo. Framework preset: **Other** (vercel.json sets the rest).
2. Project → **Storage → Create Database → Turso Cloud** → connect. Tables are created on the first request.
3. Add the environment variables above, then **Redeploy**.
4. **Settings → Domains** → add `heyranks.com` and `www.heyranks.com`.
5. Log in once with **“Email me a login link”** using an `ADMIN_EMAILS` address to unlock `/admin`.

`vercel.json` runs `/api/cron` daily at 06:00 UTC. On the first run each week it sends the weekly
reports. The other days it retries failures and emails monthly, quarterly, half-yearly and yearly
summaries once those periods end. Expired sessions and tokens are cleaned up on every run.

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

## Payments

Point your provider's webhook at `https://heyranks.com/api/webhook` and set its signing secret.

- **Stripe:** event `checkout.session.completed`. Put `{"plan":"180day"}` or `{"plan":"lifetime"}` in the session metadata.
- **Razorpay:** event `payment.captured`. Put `plan` in the payment notes.
- **Lemon Squeezy:** event `order_created`. Put `plan` in the custom data.

Payments are idempotent: provider retries are ignored. If you take a payment outside the webhook, record
it in Admin → Users → Manage so revenue stays accurate.

## Still to do before launch

1. Set `RESEND_API_KEY` and verify `heyranks.com` in Resend (DKIM).
2. Create the payment links and webhooks, then set `PAYMENT_LINK_*` and the signing secret.
3. Replace the `+91 00000 00000` WhatsApp placeholder in `index.html`.
4. Several landing-page features aren't built yet: AI-assistant answer tracking, competitor watch,
   WhatsApp alerts, PDF reports, review replies, content ideas. Build them or soften the copy.
5. Have `terms.html`, `privacy.html` and `refund.html` reviewed. The privacy policy should mention
   account data, session IPs (for security) and the anonymous visit counter.
