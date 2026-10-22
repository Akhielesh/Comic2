# 0007. Stream Studio cost transparency and frugality

- **Status:** Proposed
- **Date:** 2026-10-22
- **Design and plan:** [`docs/features/stream-studio-costs.md`](../features/stream-studio-costs.md). It holds the cost model,
  the owner and user views, the ranked frugality plan and the phased implementation.
- **Related:**
  - ADR 0002: billing UI removed; backend dormant.
  - ADR 0003: BYOK and per-key limits.
  - ADR 0006: native apps, local-first and security. It also holds the cost model and the Phase 0 cost cuts.
- **Scope:** Stream Studio (broadcasts, meetings, recordings), the baby monitor, and family/direct calls. These all run on the
  `dreamstream-live` Worker and its Durable Objects (`EventRoom`, `MonitorRoom`, `UserLine`, `CallRoom`), the R2 bucket, Cloudflare
  Realtime TURN (switched on 2026-10-22), the backend container (Drive, auth emails) and Supabase.

## Context

**The owner's requirements:**
1. The owner must know what Stream Studio costs.
2. The users must know too.
3. Every avoidable cost should be avoided, including by doing the work on users' devices and by making proper direct
   connections.

Cost optimisation and frugality through better technology are critical.

**Facts as of 2026-10-22.** Prices were checked against Cloudflare's docs that day; the details are in the feature doc §2.

- **Today's marginal cost is ≈ $0** on top of the $5/month Workers Paid plan, which the backend container already needs.
  Everything fits inside the included allowances.
- **Stream Studio spends on infrastructure, not AI.** The meters are:
  - Durable Object requests, rows written and active time;
  - R2 storage and operations;
  - Worker requests;
  - TURN egress;
  - email;
  - container wake-ups.

  Media, encoding and ML already run on users' devices. Media is peer-to-peer where networks allow.
- **The fastest-growing meters:**
  - **`MonitorRoom` rows written.** ≈ 9,850 per 10 h night, ≈ $0.32 per nursery-month at list price (93% of a nursery's cost).
    The main cause is a 15 s alarm that calls `setAlarm` and rewrites a 7-day blob every time (`monitorRoom.ts:318, 2815, 2826`).
  - **TURN (switched on 2026-10-22).** $0.05/GB after a free 1 TB shared across the whole Cloudflare account; ≈ $4.66 per all-night
    TURN viewer-month.
    - Today's TURN code would hand **one shared 24-hour credential** to every socket, with no attribution and no revocation
      (`ice.ts:23-27, 43`).
    - A leaked credential could cost ≈ $54 a day.
- **A default nobody chose:** recordings are copied to R2 automatically at 2.5× the stream bitrate (`live/prefs.ts:71`,
  `SaveSheet.tsx:165-166`).
- **What the owner sees today:** the Admin Cost centre hard-codes Stream Studio to `$0` (`server/src/services/costCentre.ts:756-769`).
  It reads no Durable Object, TURN or R2-operations data and attributes nothing per feature, nursery, account or event.
- **What users see today:** path pills ("Home Wi-Fi", "Encrypted · relay", "Via our server") but no costs, usage or limits.
- **Comic Studio's lesson** (`server/src/comic/billing.ts:113-114`; `api-proxy/wrangler.jsonc:61`):
  - Its platform ledger is wired to the billing switch. With `BILLING_ENABLED` off in production, comic spend never reaches the
    owner's Cost centre.
  - Its user-facing patterns are good and worth copying: an estimate on the verb, a running total, receipts, the who-pays chip
    and honest "est." labels.
- **Constraints:**
  - The repo is public: no secrets in the tree.
  - The `dreamstream-live` Worker deliberately holds no Supabase service-role key (`live-worker/src/index.ts:44-56`).
  - The backend container must stay asleep: nothing may call `/api/*` on a timer.
  - Durable Objects must stay hibernation-eligible: no timers, no held-open I/O.

## Decision

### D1. Meter always; charge never (for now)

- Stream Studio cost telemetry is **independent of `BILLING_ENABLED`** and of any payment system.
- We do not charge users for Stream Studio. Limits are protected with fair-use allowances (D5).
- Charging later needs a new ADR.

### D2. Cheap, honest metering with three sources

**1. Measured: Cloudflare GraphQL** (Durable Object datasets per namespace, R2 operations, TURN `egressBytes`, Workers).
- It is the control total.
- It is read only when an admin opens the Cost centre, and by a daily GitHub Actions job.

**2. Estimated: in-room counters**, in a shared helper `live-worker/src/usageMeter.ts`.
- They are incremented in memory on code paths that already run.
- Per-socket totals are kept in WebSocket attachments so they survive hibernation without storage writes.
- They are flushed **at most hourly per object**, as one KV row (`use:YYYY-MM`) plus one Workers Analytics Engine data point
  (an optional binding). Flushes ride alarms and close events that already happen.

**3. Display only: client session summaries.** Minutes per path, and TURN bytes received from `getStats`. They are sent as
cumulative totals over the existing socket, at most about 4 times an hour. **They never enforce a limit.** Enforcement uses the
room's own counters and Cloudflare's per-identifier TURN data.

**Rules:**
- No storage write per frame, per segment GET or per message.
- No `await` on a hot path; metering fails open.
- One price table with a `checkedOn` date (`STREAM_UNIT_PRICES` in `shared/stream/usage.ts`).
- Metering costs ≤ 1% of DO rows and ≤ 0.5% of DO requests (verified in production).

### D3. Owner view

Admin → Costs gets a **Stream Studio** tab:
- a product row computed from data: the marginal share of the account's overage, plus the list-price value;
- cost per feature;
- the path mix (Home Wi-Fi / Direct / TURN / our server);
- top nurseries, accounts and events;
- free-tier headroom with month-end projections. The meters are labelled account-wide, because other Workers on the same
  Cloudflare account share them;
- the ADR 0006 per-nursery-day KPIs;
- alerts.

Every figure carries the existing provenance badges: measured, estimated or fixed.

**Alert delivery costs nothing:**
- an admin badge;
- a daily GitHub Actions job that opens or updates an issue;
- the owner's own Cloudflare account budget alert, as a backstop.

This work is the cost-telemetry task of ADR 0006 WS-8, done once.

### D4. User view: path first, units second, dollars as "our cost"

- **Before an action:** a one-line path and cost statement. Examples: "Direct between you and your guests — free";
  "Free · through our servers · replay kept 24 h"; "7-day link · 2.84 GB · kept 7 days".
- **While live:** path pills in three user words: **Home Wi-Fi**, **Direct**, **Through our server/relay**. Tooltips carry cost
  and the existing, test-guarded privacy wording.
- **After:** receipts in the event recap, at call end, and in the nursery ("Last night: 10 h · 98% direct · free").
- **Monthly:** a calm **Settings → Usage** card. It shows what was free (and why) next to what went through our servers, with
  allowance meters and tips to stay free.
- **Dollars** appear only in an expander, "What this costs DreamStream", marked "est.". They are never presented as a charge.
- All user copy comes from one module (`live/costCopy.ts`), with tests:
  - never "free" on the TURN or server paths;
  - never "end-to-end" for the server relay until it is.

### D5. Fair-use allowances, not prices

**Proposed allowances** (the numbers are the owner's call):
- relay data 10 GB per account-month, and 10 GB per nursery for monitor viewers;
- picture through our server 16 h a day per nursery;
- 7-day cloud copies 10 GB rolling per account;
- the existing broadcast, meeting, call and retention caps.

**Rules:**
- **Never cut baby-monitor sound or alerts.**
- **Never silently downgrade privacy.** When relay data runs out, the monitor defaults to *sound only*. Moving the picture to
  the not-yet-end-to-end server relay is an explicit parent choice.
- Notices are in-app only, at 80% and 100%, with a reset date.

### D6. Frugal by construction

**Path order for every product:**
1. Home Wi-Fi
2. direct P2P
3. TURN for the side that receives less
4. the end-to-end encrypted server relay (one-way monitor video, after ADR 0006 Phase 0)
5. viewer-side TURN, last

**Other defaults:**
- Recordings go to the device or Google Drive first. The 7-day R2 copy is **opt-in and capped**.
- Hidden viewers switch to sound only.
- Relay paths are bitrate-capped everywhere (calls and meeting guests included).
- Push replaces polling.
- The container stays asleep.

**TURN is not switched on in production until the guardrails are in place:** per-socket, on-demand credentials with an HMAC
`customIdentifier`, TTL ≤ 4 h (guests ≤ 2 h), and revocation.

The ranked list and targets are in the feature doc §5 and §7.

### D7. Privacy of usage data

- Usage data is aggregates only: per nursery, account or event, per month, plus per-session points.
- No per-viewer tracking. Guests are never identified. No IPs, names, emails, SDP or candidates.
- TURN identifiers are HMACs.
- Members see their own usage. Parents see their nursery's. The admin sees aggregates, and top consumers by email **only in
  the admin console**.
- Monthly rows are kept 13 months.

## Alternatives considered

| Alternative | Verdict | Why |
|---|---|---|
| **Charge users** (Stripe metering, CT credits, paid relay packs) | Rejected for now | Cost per nursery is $0.03–0.32 a month. A card payment's fixed fee (about $0.30 plus a percentage in the US) is larger than the thing billed. ADR 0002 removed billing UI on purpose. Charging needs billing-grade metering (signed, reconciled, auditable) and support. The counters in D2 keep the option open, and a relay-data pack is the natural unit if it ever comes back |
| **Fair-use allowances** (chosen, D5) | Accepted | Protects the pooled free tiers and the bill from a few heavy or abusive users. No payment friction. Honest about what happens at the limit |
| **BYO TURN** (a user supplies a TURN URL and credentials, or their own Cloudflare TURN key; stored on device like BYOK in ADR 0003) | Not the default; possible later under Advanced | It moves TURN cost to the user, and a free Cloudflare account includes its own 1 TB. But few families can set it up. Credentials kept in the browser can leak. Minting from a user's API token would mean holding their secret. It adds support burden and does nothing for guests. If built, it follows Comic Studio's same-payer rule: a BYO session never silently falls back to our TURN, and ours never moves onto theirs |
| **No in-app metering; rely on the Cloudflare bill and dashboard** | Rejected | No attribution per feature, nursery or user. No user transparency. Allowances can't be enforced. A leaked TURN credential is invisible until the invoice |
| **Percent-only allowances for users** (Comic Studio's platform allowance pattern) | Partly adopted | Allowances show GB and percent. Dollars are kept but moved into a clearly labelled "our cost" expander, because the owner asked that users know the costs. Owner question 1 can turn dollars off |
| **A Supabase table as the meter sink** (like `providerUsage.ts` → `provider_usage_log`) | Rejected | The live Worker holds only the publishable key, by design. Writing from the backend would wake the container. Workers Analytics Engine needs no secret and no storage rows |
| **Per-viewer, per-frame or per-request logging** for exact attribution | Rejected | Privacy cost. It also costs more than what it measures (a write per frame would multiply the rows-written bill) |
| **Cloudflare Stream or the Realtime SFU** for meetings, calls or small broadcasts | Rejected | $1 per 1,000 delivered minutes or $0.05/GB, against a free mesh and a ≈ $0.01–0.03/h R2 rail |
| **Self-hosted coturn now** | Deferred | Ops burden. Worth it only past ~1 TB a month of TURN egress (ADR 0006 D5.4) |
| **Keep the 7-day R2 copy on by default** | Rejected | It duplicates bytes already on the device (and on Drive when chosen). It costs the user 2.9–7.7 GB/h of upload. The free 10 GB covers only ≈ 15 recorded hours a month |

## Consequences

**Easier**
- The owner sees real Stream Studio numbers: per feature, per top consumer, against every free allowance, with projections and
  alerts. The `$0` placeholder goes away.
- Users can see that most of what they do is free, and why ("your devices", "your Wi-Fi", "your Google Drive"). They also see
  what they can do to keep it free.
- Switching TURN on becomes safe. It is a reliability fix for calls and meeting guests on carrier NAT, and the guardrails bound
  its cost tail.
- Phase C targets are measurable from day one. Two examples: server-relayed video minutes per monitored night (median ≤ 5,
  p90 ≤ 60), and DO rows per active nursery-day ≤ 1,800.

**Harder, and the risks**
- **Small code in hot Durable Object paths.** A careless `await` or timer would break hibernation (worst case ≈ $20k/month at
  10k nurseries). Mitigation: spy tests on the hot paths, plus the GB-s-per-nursery-day alert.
- **Estimates can drift from the bill.** Mitigation: they are labelled "est.", calibrated against GraphQL (target ±15%), and the
  measured control total sits beside them.
- **Workers Analytics Engine** becomes a soft dependency. The binding is optional and fails open. Analytics Engine is unbilled
  today; the published price is $0.25 per million data points beyond 10M.
- **User copy across many screens** must stay consistent with the privacy wording. Mitigation: one copy module with tests,
  next to `privacyCopy.unit.test.ts`.
- **File ownership overlaps ADR 0006 Phase 0** (WS-4/5/6/7/8/9/11) and the in-flight monitor relay fixes. The feature doc §7
  sequences each step after the owning workstream, or hands it to that workstream.

**Follow-ups and owner actions**
1. Answer the open questions in the feature doc §8: dollars for users, allowance numbers, TURN timing and ceiling, the
   cloud-copy default, charging later, attribution, the shared Cloudflare account, the DO-relay terms check, the Supabase plan.
2. Set `CF_ANALYTICS_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the backend. The token is read-only, with Account Analytics
   Read for Analytics Engine.
3. Add the same read-only token as a GitHub Actions secret for the daily cost watch.
4. Set a Cloudflare account budget alert, for example $10.
5. Run the 1-hour metered lab test of camera-side TURN billing before any "free relay" claim.
6. Apply the R2 lifecycle rules (expire `events/` after 9 days; abort incomplete multipart uploads after 1 day).

**Ruled out**
- Charging for Stream Studio without a new ADR.
- Enabling TURN without the D6 guardrails.
- Automatic R2 cloud copies.
- Per-viewer usage tracking.
- Any storage write per frame, segment GET or message for metering.
- Coupling cost telemetry to a billing switch.
