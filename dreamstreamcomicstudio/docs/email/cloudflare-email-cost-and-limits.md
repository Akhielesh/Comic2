# Cloudflare Email — cost & limits (honest breakdown)

> Verified against Cloudflare docs in June 2026. Email Sending is in **public beta**, so
> pricing/limits can still change — re-check the linked pages before relying on them.

## Can Cloudflare do this? Yes.

In **April 2026** Cloudflare shipped **Email Sending** — the send half of *Cloudflare Email
Service* — which sends real transactional email straight from a Worker:

```js
const { messageId } = await env.EMAIL.send({
  from: 'notifications@yourdomain.com',
  to: 'user@example.com',
  subject: 'Order confirmed',
  html: '<h1>Confirmed</h1>',
  text: 'Confirmed.'
});
```

This is newer than most write-ups online (which only describe Cloudflare *Email Routing*, the
**receive/forward** product, or the old `send_email` binding that could only mail verified
Email Routing destinations). We use the new send API.

## Pricing

| Item | Cost |
|------|------|
| **Workers Paid plan** (required) | **$5 / month** (also covers your existing Studio worker) |
| **Included email** | **3,000 / month free** |
| **Overage** | **$0.35 per 1,000** emails beyond 3,000 |

**Realistic bill for this app:** signup confirmations + newsletter confirms + the occasional
security/transactional notice almost certainly stay inside the free 3,000/mo → **effectively
$5/mo total**. 10,000 emails in a month would be $5 + (7 × $0.35) ≈ **$7.45**.

## Limits

| Limit | Value |
|-------|-------|
| Recipients per message | up to **50** (`to` + `cc` + `bcc`) |
| Plan gate | Workers **Paid** only |
| Sending domain | must be a **verified** domain in Cloudflare Email → Sending |
| Auth records | **SPF, DKIM, DMARC** DNS records required (Cloudflare generates them) |
| Status | public **beta** |

## How we cap cost (hard limits)

Cloudflare itself does not stop you at the free tier — it just bills the overage. So **the
backend enforces its own hard ceiling** before every send (`server/src/services/mailer.ts`):

- `EMAIL_MAX_PER_MONTH` — default **2,500** (deliberately under the 3,000 free tier)
- `EMAIL_MAX_PER_DAY` — default **200**

When a cap is hit the send is **skipped** (logged `status='rate_limited'`) and a
`[email][COST-CAP]` line is written to the server logs. At ≥80% of the monthly cap a
`[email][COST]` warning fires. **You cannot incur overage charges unless you deliberately
raise `EMAIL_MAX_PER_MONTH` above 3,000.** Usage is countable any time from `email_log`
(`status='sent'`) or via `getEmailUsageStatus()`.

## Comparison

| Provider | Per 1k | Free tier | Worker-native | Notes |
|----------|--------|-----------|---------------|-------|
| **Cloudflare Email Sending** | $0.35 | 3,000/mo | ✅ `env.EMAIL.send` | beta; simplest if you're already on Workers |
| Amazon SES | ~$0.10 | none (paid) | ❌ (HTTP/SMTP) | cheapest at scale, more setup, no binding |
| Resend | ~$0.20–1.00 tiers | 3,000/mo | ❌ (HTTP) | great DX, not Cloudflare-native |
| Postmark | ~$1.25+ | 100/mo | ❌ | premium deliverability |

For our volume and stack (already on Cloudflare Workers for the Studio container), Cloudflare
Email Sending is the lowest-friction, lowest-cost choice.

## Sources

- Cloudflare Email Service — pricing: https://developers.cloudflare.com/email-service/platform/pricing/
- Email Sending public beta announcement: https://blog.cloudflare.com/email-for-agents/
- Workers API (send): https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- Email Service docs: https://developers.cloudflare.com/email-service/
