# HeyRanks — deploy guide

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing page — free scan calls `/api/scan` |
| `signup.html` | Post-payment onboarding form |
| `lib/core.js` | All logic — scan, signup, weekly job, email (shared) |
| `_worker.js` | Cloudflare entry point |
| `api/index.js` | Vercel entry point |
| `schema.sql` | D1 database schema (run once) |
| `wrangler.toml` | Cloudflare config — D1 binding + Monday 6am cron |
| `terms.html`, `privacy.html`, `refund.html` | Legal pages |
| `robots.txt`, `sitemap.xml`, `llms.txt` | SEO & AI-visibility files |

> `_worker.js` (Cloudflare) and `api/index.js` (Vercel) both route to `lib/core.js`.
> It supersedes `functions/api/scan.js` — that file is kept for reference only.

---

## Deploy on Vercel (+ Turso database)

The site runs on Vercel or Cloudflare from the same code. All logic lives in
`lib/core.js`. Vercel uses `api/index.js`, `vercel.json` and Turso (SQLite).
Cloudflare uses `_worker.js`, `wrangler.toml` and D1.

| Vercel file | Purpose |
|---|---|
| `api/index.js` | One function for all `/api/*` routes + the cron endpoint |
| `lib/db.js` | Makes Turso look like D1, so `lib/core.js` is unchanged |
| `vercel.json` | Build, clean URLs, `/api/*` routing, 300s limit, daily cron |
| `scripts/build-static.mjs` | Copies only the public pages into `public/` |
| `scripts/init-db.mjs` | Creates the tables in Turso (`npm run db:init`) |

### 1. Import the repo
vercel.com → **Add New → Project** → import `dibyajyotidash/heyranks`.
Framework preset: **Other**. Leave build settings as they are (vercel.json sets them). Deploy.

### 2. Add the database
Project → **Storage** → **Create Database** → **Turso Cloud** (free plan) → connect it to the project.
This adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` automatically.

Create the tables once, from your computer:
```
npm i -g vercel
vercel link
vercel env pull .env.local
npm install
node --env-file=.env.local scripts/init-db.mjs
```

### 3. Environment variables
Project → **Settings → Environment Variables** (Production):

| Name | Value |
|---|---|
| `RESEND_API_KEY` | from resend.com |
| `ADMIN_SECRET` | any long random string (manual weekly run) |
| `CRON_SECRET` | any long random string. Vercel sends it to `/api/cron` automatically |
| `PSI_KEY` | optional, Google PageSpeed key |

Then **Deployments → Redeploy** so they take effect.

### 4. Domain
Project → **Settings → Domains** → add `heyranks.com` and `www.heyranks.com`,
then set the DNS records Vercel shows at your domain registrar.

### Weekly reports on Vercel
`vercel.json` runs `/api/cron` **daily at 06:00 UTC** (Hobby plan minimum is daily;
timing can drift up to 59 min). Each run only reports customers who haven't had a
report since this week's Monday, so on Monday it sends everyone's report and the other
days it just retries anyone who failed or didn't fit in Monday's 300-second run. New
signups get their welcome scan right away and their first weekly report the next Monday.

Manual run: `curl -X POST https://heyranks.com/api/weekly -H "X-Admin-Secret: YOUR_ADMIN_SECRET"`

---

## Deploy (Cloudflare Pages + D1)

### 1 — Create the D1 database

```
wrangler d1 create heyranks-prod
```

Copy the `database_id` from the output and paste it into `wrangler.toml`.

### 2 — Run the schema

```
wrangler d1 execute heyranks-prod --file=schema.sql
```

### 3 — Set secrets

```
wrangler pages secret put RESEND_API_KEY     # get from resend.com (free tier: 100 emails/day)
wrangler pages secret put ADMIN_SECRET       # any random string — protects the manual trigger
wrangler pages secret put PSI_KEY            # optional: Google PageSpeed Insights API key
```

### 4 — Deploy

```
npm i -g wrangler
wrangler login
wrangler pages deploy . --project-name heyranks
```

### 5 — Custom domain

Cloudflare → Workers & Pages → heyranks → Custom domains → add `heyranks.com`.

---

## Weekly reports

The cron fires every **Monday at 6:00 AM UTC**.  

**Set up the cron trigger in the Cloudflare dashboard** (Pages does not support `[triggers]` in wrangler.toml):
1. Workers & Pages → `heyranks` → **Settings** → **Triggers**
2. Add Cron Trigger: `0 6 * * 1`

To trigger a test run manually:

```
curl -X POST https://heyranks.com/api/weekly \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"
```

---

## Payment integration

The "Start for $10" and "Claim lifetime deal" buttons go to `/signup?plan=180day` and `/signup?plan=lifetime`.

**Option A — no webhook (simplest for launch):**  
Customers pay via your Razorpay/Stripe/Lemon Squeezy payment link, then land on `/signup` to enter their details. Manual verification is not needed — you trust that they paid.

**Option B — Stripe webhook:**  
In your Stripe dashboard, add a webhook pointing to `https://heyranks.com/api/webhook`.  
Put the signing secret in `STRIPE_SECRET`. Pass `{"plan":"180day","website":"..."}` as metadata on the checkout session.

**Option C — Lemon Squeezy webhook:**  
In Lemon Squeezy, add a webhook to `https://heyranks.com/api/webhook`.  
Pass `{"plan":"180day","website":"..."}` as custom data on the product.

---

## Still to do before launch

1. **Payment links** — replace `href="/signup?plan=180day"` on paid plan buttons with your actual Razorpay/Stripe payment link (redirect to `/signup?plan=180day&email={email}` after payment).
2. **WhatsApp number** — replace `+91 00000 00000` in `index.html`.
3. **Email domain** — verify `heyranks.com` in Resend and configure DKIM.
4. **Google Search Console** — verify domain and submit `sitemap.xml`.
5. **Legal review** — have `terms.html`, `privacy.html`, `refund.html` checked before taking payments.
