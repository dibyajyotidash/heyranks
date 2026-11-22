# HeyRanks — deploy guide

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing page — free scan calls `/api/scan` |
| `signup.html` | Post-payment onboarding form |
| `_worker.js` | Cloudflare Pages Worker — scan, signup, weekly cron, email |
| `schema.sql` | D1 database schema (run once) |
| `wrangler.toml` | Cloudflare config — D1 binding + Monday 6am cron |
| `terms.html`, `privacy.html`, `refund.html` | Legal pages |
| `robots.txt`, `sitemap.xml`, `llms.txt` | SEO & AI-visibility files |

> `_worker.js` (advanced mode) handles all requests and the scheduled cron.
> It supersedes `functions/api/scan.js` — that file is kept for reference only.

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
