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
`[email][COST-CAP]` line is written to the server logs. At 50% and again at 80% of each cap a
single `[email][COST]` warning fires (once per day / month, not once per send).

**Auth reserve (2026-11, abuse-ops-4).** Part of each cap is kept for auth mail (every `auth-*`
template: sign-up confirm, password reset, magic link …), so mail a stranger can trigger can never
use up what sign-in needs:

- `EMAIL_AUTH_RESERVE_PER_DAY` — default **50**; `EMAIL_AUTH_RESERVE_PER_MONTH` — default **500**.
  Every other template (newsletter, access requests, invites, admin sends) stops at the cap minus
  the reserve and is logged `rate_limited` with `error='auth_reserve'`. Auth mail may use the
  whole cap. A reserve is never more than half its cap; `0` turns it off.
- `EMAIL_ANON_MAX_PER_CLIENT_PER_DAY` — default **10**: mail a signed-out `/api/newsletter/subscribe`
  triggers (newsletter confirm, access-request acknowledgement) per IPv4 address / IPv6 /64 in a
  rolling day, in memory (`error='anon_sender_cap'`). The welcome after a confirm click is not
  counted (the click needs the token from the inbox). `0` turns it off.
- The caps count mail in flight (`status='queued'`) as well as `sent`, and the read-check-log step
  runs one send at a time per process, so parallel requests at the edge of a cap cannot all pass it.
- A pending newsletter address is re-sent its confirm link at most once per 10 minutes and 3
  times a day, both read from `email_log` (`queued` / `sent`), so a confirm that was refused or
  failed never blocks a retry; otherwise the link already in its inbox stays valid, and a
  throttled re-submit still records any new product picks or feedback.
- `getEmailUsageStatus()` (Admin → Email) also reports `authDay` / `authMonth`, `otherDay` /
  `otherMonth` against `otherMaxPerDay` / `otherMaxPerMonth`, and the effective reserves.
- Mailer log lines name recipients masked (`a***@example.com`), never in full (abuse-ops-15).

**You cannot incur overage charges unless you deliberately raise `EMAIL_MAX_PER_MONTH` above
3,000.** Usage is countable any time from `email_log` (`status` `queued` or `sent`) or via
`getEmailUsageStatus()`.

**Exception — Supabase auth emails.** Once the Send Email Hook is enabled
(`docs/email/SETUP.md` §5), sign-up / reset / email-change mail goes Supabase →
`dreamstream-email` `/auth-hook` → Cloudflare directly and does **not** pass the backend caps
above. Its only throttle is Supabase's *Auth → Rate Limits → emails sent* setting — keep that
at a level whose worst case (× 24 × 30) still fits your budget, and watch Cloudflare's Email
Sending logs.

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
