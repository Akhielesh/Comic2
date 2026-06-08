# 36 — Privacy, Compliance & Data Governance

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> Pairs with [35 — Security architecture & threat model](./35-security-threat-model.md)
> (the *confidentiality/integrity* half; this section is the *governance* half) ·
> [Master Plan](../00-MASTER-PLAN.md) (**§5** security & multi-tenancy, **A9** hardening &
> GA) · [F-Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (**F3** session/identity,
> **F6** migrations & RLS coverage, F0 audit log) ·
> [26 — Data Model & Schema](./26-data-model-schema.md) (the tables governed here) ·
> [25 — Multi-tenancy & isolation](./25-multitenancy-isolation.md) ·
> [30 — Integrations framework](./30-integrations-framework.md) (Nango/BYO) ·
> [32 — Storage](./32-storage.md) (R2). Grounded in existing privacy SQL:
> [`server/sql/image_assets_retention.sql`](../../../../server/sql/image_assets_retention.sql),
> [`server/sql/profile_private_email_preferences.sql`](../../../../server/sql/profile_private_email_preferences.sql),
> [`server/sql/auth_signup_policy_min_age_8.sql`](../../../../server/sql/auth_signup_policy_min_age_8.sql).

## 36.1 Scope & the honest one-line story

This section is the **data-governance contract** for Code Studio Autopilot: what personal and
sensitive data exists, where it physically lives, the lawful basis for holding it, the rights
users have over it, how long we keep it, who the sub-processors are, and — stated plainly —
**which parts of compliance are real today and which are roadmap.** Section 35 keeps the data
*safe* (isolation, secrets, threat model); this section keeps the data *accountable*.

The honest story in one line: **the privacy primitives that matter most are already shipped or
already designed** — owner-isolated RLS on every table (§26), BYO secrets held only in Nango
and never in our database (§5.3), a delete-cascade erasure path anchored on `auth.users`
(§26.14), a working retention engine (`image_assets_retention.sql`), explicit email-consent
preferences (`profile_private_email_preferences.sql`), and an enforced minimum-age policy
(`auth_signup_policy_min_age_8.sql`) — **but the formal program around them is not done.** We do
not have a signed DPA register, a self-serve "export my data" button, a published privacy
notice for the venture layer, a DPIA, or a SOC 2 report. Calling any of those "done" would be
dishonest. The roadmap (§36.13) says exactly what is needed and when.

Three governance rules govern everything below:

1. **Mark shipped vs planned.** Every control is tagged **SHIPPED** (in code/SQL today),
   **DESIGNED** (specified in §26/§30/§33, not yet built), or **PLANNED (A9)** (the GA gate).
   No control is described as operational unless it is.
2. **Data minimisation is the default.** We store the smallest amount of personal data that
   makes the product work. `venture_events` stores a `prompt_hash` and `model`, **not** the raw
   prompt (§26.7); `venture_connections` stores a Nango *reference*, **not** a credential
   (§26.10). The cheapest data to govern is data we never collected.
3. **The user's content can live in the user's cloud.** BYOK + BYO-account (§30, §31) means a
   user's generated app, its database, and its secrets can be deployed to *their* Cloudflare /
   Vercel / Supabase / Railway account — data we never hold, governed by *their* terms. This is
   a deliberate privacy posture, not an accident (§36.10).

---

## 36.2 Data classification

Every datum Autopilot touches falls into one of five classes. The class drives the controls:
encryption, RLS anchor, retention, who may read it, and whether it may appear in a log.

| Class | What it is | Examples | Sensitivity | Default control |
|---|---|---|---|---|
| **C1 · PII** | Data identifying a natural person | email, username, first/last name, phone, DOB, IP, device label/UA | High | RLS owner-isolation; `profile_private` split from public `profiles`; never in logs in clear |
| **C2 · Secrets / credentials** | Material that grants access | BYO provider OAuth tokens/PATs, Stripe keys, platform env secrets, MFA factors | **Critical** | **Never in our DB** (Nango / host env only, §5.3); never logged; never in client bundle |
| **C3 · User content** | What the user creates or supplies | venture idea/scope, goals, prompts, uploaded app assets, the generated app's runtime data | High (may contain *their users'* PII) | RLS owner-isolation; BYO cloud option (§36.10); no model-training use (§36.11) |
| **C4 · Generated code & artifacts** | Output the agents produce | `studio_files`, `studio_versions`, build bundles/logs in R2 | Medium (may embed secrets if the agent errs — scanned, §35) | RLS via parent project; secret-scan before ship (§5.4) |
| **C5 · Telemetry & operational** | How the system behaves | `venture_events`, `audit_log`, request ids, metrics, cost ledger, traces | Medium (event payloads can carry C1/C3 fragments) | Append-only, owner-read; `prompt_hash` not prompt; PII-scrubbing in logs (DESIGNED) |

**Cross-cutting rule.** A field's class is the *highest* class of anything it can contain. A
`venture_events.payload` jsonb is C5 by table, but because it *can* carry a snippet of C3 user
content, it is governed at C3 for retention and access. The data dictionary (§54) tags every
column with its class so the classification is machine-checkable, not folklore.

---

## 36.3 Data inventory — what lives where

The inventory below is the authoritative "where is my data?" map across all stores. It is the
backbone of every right-request (§36.5), every retention rule (§36.7), and every sub-processor
entry (§36.9).

| Datum (class) | Primary store | Region | Sub-processor | Status |
|---|---|---|---|---|
| Auth identity, email, hashed creds (C1/C2) | Supabase Auth (`auth.users`) | Supabase project region | Supabase | **SHIPPED** |
| Profile PII — name, phone, DOB, email prefs (C1) | Supabase Postgres (`profiles`, `profile_private`) | Supabase region | Supabase | **SHIPPED** |
| Sessions & devices — IP, UA, device label (C1/C5) | Supabase Postgres (`sessions`, `user_devices`) | Supabase region | Supabase | **DESIGNED (F3)** |
| Venture idea / scope / goals (C3) | Supabase Postgres (`ventures`, `venture_goals`) | Supabase region | Supabase | **DESIGNED (A0/A1)** |
| Generated code & version history (C4) | Postgres (`studio_files/_versions`) + R2 spill | Supabase + Cloudflare | Supabase, Cloudflare | files **SHIPPED**; R2 spill **DESIGNED** |
| Uploaded app assets, build artifacts/logs (C3/C4) | Cloudflare R2 (`autopilot-artifacts`, per-venture prefix) | Cloudflare R2 (jurisdiction-bound bucket) | Cloudflare | **DESIGNED (A5/A6)** |
| Image assets (C3) | Supabase Storage (`comic-assets`) + `image_assets` metadata | Supabase region | Supabase | **SHIPPED** |
| Activity & decision log (C5, may embed C3) | Postgres (`venture_events`) → R2 cold archive | Supabase + Cloudflare | Supabase, Cloudflare | **DESIGNED (A0)** |
| Security/admin audit (C5) | Postgres (`audit_log`) → R2 archive | Supabase + Cloudflare | Supabase, Cloudflare | **DESIGNED (F0)** |
| Cost/usage ledger (C5) | Postgres (`token_ledger_entries`, wallets) | Supabase region | Supabase | **SHIPPED** |
| **BYO provider credentials (C2)** | **Nango (encrypted)** — we hold only a reference | Nango region | Nango | ref **SHIPPED**; venture wiring **DESIGNED** |
| Billing — customer id, subscription, card metadata (C1/C2) | Stripe (we store only the customer/subscription id) | Stripe (US/EU) | Stripe | **SHIPPED** |
| LLM prompt/response in flight (C3/C4) | Model providers (transient) | Provider region | OpenAI, Anthropic, Google, OpenRouter, etc. | **SHIPPED** (no-train terms, §36.11) |
| App data the user deploys to *their* cloud (C3) | **The user's own** Cloudflare/Vercel/Supabase/Railway | User-chosen | **Not our sub-processor** | **DESIGNED (A5)** |
| Edge cache / WAF logs, request metadata (C5) | Cloudflare | Cloudflare global edge | Cloudflare | **SHIPPED** |

**Reading the table.** Two facts do the heavy lifting. First, **secrets never appear as a
store we control** — Nango and the host env are the only homes for C2, exactly per Master Plan
§5.3. Second, the **last two rows are the BYO escape hatch**: a user can choose to have their
content and their app's data live entirely in their own accounts, where Autopilot is not a
processor at all (§36.10).

---

## 36.4 Lawful basis & consent

We map each processing purpose to a GDPR Article 6 lawful basis (and the CCPA "business
purpose" equivalent). The default basis is **contract** — we process what we must to deliver
the studio the user asked for — with **consent** carved out only for genuinely optional things
(marketing).

| Purpose | Data | Lawful basis (GDPR Art. 6) | How obtained / where shipped |
|---|---|---|---|
| Provide the studio / run ventures | C1 identity, C3 content, C4 code | **Contract** (6(1)(b)) | Account creation + ToS acceptance (`profiles.terms_accepted`, SHIPPED) |
| Billing & fraud prevention | C1, C2 billing, C5 ledger | **Contract** + **legal obligation** (6(1)(c)) | Required to charge; Stripe handles card data |
| Security, audit, abuse prevention | C5 audit, IP, device | **Legitimate interest** (6(1)(f)) | `audit_log`, anomaly detection (A9) |
| Product-update email | C1 email | **Legitimate interest**, opt-out | `email_pref_product_updates` default **true**, opt-out (SHIPPED) |
| **Marketing email** | C1 email | **Consent** (6(1)(a)) | `email_pref_marketing` default **false**, explicit opt-in (SHIPPED) |
| Model inference on user content | C3 content | **Contract** (the user asked the agent to build) | In-product; no-train terms (§36.11) |

**Consent is already real, not aspirational.** `profile_private_email_preferences.sql` ships
two distinct preference columns with the right defaults — product updates **opt-out** (`true`),
marketing **opt-in** (`false`) — and a trigger (`sync_marketing_consent_from_private`) that
keeps the public `profiles.marketing_consent` mirror in sync so consent has one source of
truth. The signup handler (`handle_auth_user_created`) captures `terms_accepted` and the
preference flags at the moment of account creation. **What is still owed:** a versioned
record of *which* ToS/privacy-notice version was accepted (today `terms_accepted` is a bare
boolean), and a venture-layer privacy notice describing autonomous processing (§36.13).

---

## 36.5 Data-subject rights — GDPR / CCPA and how they're implemented

GDPR grants access, rectification, erasure, restriction, portability, and objection; CCPA/CPRA
grants know, delete, correct, and opt-out-of-sale (we do **not** sell data, so the last is
trivially satisfied). The implementation rests on three mechanisms already in the schema.

| Right | Mechanism | Implementation | Status |
|---|---|---|---|
| **Access / Know** | Owner-RLS read | The user can already read every row they own (RLS `auth.uid() = user_id`); an export job (below) packages it | RLS **SHIPPED**; export job **PLANNED (A9)** |
| **Portability / Export** | Export job | A service-role job walks the inventory (§36.3) per `user_id`, emits a single ZIP: JSON for Postgres rows, files from R2/Storage, a manifest | **PLANNED (A9)** |
| **Rectification / Correct** | Owner-RLS write | User edits profile/venture fields directly (RLS update policies) | **SHIPPED** for profile; venture fields **DESIGNED** |
| **Erasure / Delete** | `on delete cascade` from `auth.users` | Deleting the auth user cascades every owned row (§26.14); R2/Storage objects purged by the retention engine; Nango connections revoked | cascade **DESIGNED (A0/A1)**; storage purge **SHIPPED** pattern |
| **Restriction / Object** | Venture pause + flags | Pause a venture (stops processing); opt out of marketing; disable telemetry-derived emails | pause **DESIGNED (A0)**; consent **SHIPPED** |
| **No sale / share opt-out** | N/A — we don't sell | No data sold or shared for cross-context ads; affirmed in the notice | **policy SHIPPED** (nothing to opt out of) |

**Erasure — the load-bearing detail.** Section 26.14 makes the erasure path concrete: **every
root table FKs to `auth.users(id) ON DELETE CASCADE`** (`ventures`, `venture_connections`,
`user_devices`, `sessions`, `user_settings`, `image_assets`, `profiles`/`profile_private`), and
every child table cascades from its venture. Deleting the auth user is therefore a *true*
erasure of database rows in one operation. Three things must accompany the cascade for it to be
complete and that is where the work remains:

1. **Object stores.** R2 (`autopilot-artifacts`, per-venture prefix) and Supabase Storage
   (`comic-assets`) hold objects that a Postgres cascade does not reach. The shipped
   `purge_expired_image_assets()` already deletes from `storage.objects` for image assets; the
   erasure job extends the same pattern to the per-user R2 prefix. **PLANNED (A9).**
2. **Nango.** On account deletion we call Nango to revoke and delete every connection; because
   we hold only references, there is no secret of ours left to scrub (§36.10). **DESIGNED.**
3. **Append-only logs.** `venture_events` and `audit_log` are intentionally append-only and
   `audit_log` is retained ≥ 1 year for security/legal obligation (§36.7). Erasure here is
   handled by **crypto-shredding / pseudonymisation** — null the `actor_id`/`target_user_id`
   FKs (`on delete set null` is already specified on `audit_log`) so the forensic record
   survives without remaining linkable to the person. This is the lawful balance between the
   right to erasure and the legal-obligation basis for keeping a security log.

Operationally, GDPR/CCPA give a **30-day** (extendable to 90) response window. Until the
self-serve export/delete jobs ship (A9), requests are honoured **manually** by an operator
running a documented runbook (§50) — honest interim, not a gap we hide.

---

## 36.6 Data residency

Residency is a function of three knobs we set and one the user sets.

| Layer | Where data sits | Control | Status |
|---|---|---|---|
| Supabase Postgres + Auth + Storage (C1/C3/C4/C5) | The **project's chosen region** (pinned at project creation) | We pick the region; a second region = a second project (no built-in multi-region) | **SHIPPED** (single region) |
| Cloudflare R2 (C3/C4/C5) | Bucket **jurisdiction** (`default`, `eu`, etc.) set at bucket creation | We can pin an EU-restricted bucket for EU artifacts | **DESIGNED (A5)** |
| Cloudflare Workers/DO/edge (C5 in transit, DO state) | Runs at the **global edge**; DO state has a location hint | Workers are global by design; DO placement hint can bias region | **SHIPPED** |
| Model providers (C3/C4 transient) | Provider's serving region | Routing/provider choice (§29); some providers offer regional endpoints | **SHIPPED** (best-effort) |
| **User's BYO cloud (C3)** | **Wherever the user's account is** | The user chooses entirely | **DESIGNED (A5)** |

**Honest posture.** Today this is a **single-region** product: one Supabase project in one
region, Workers at the global edge, R2 in the default jurisdiction. That is fine for launch but
it is **not** EU-data-residency-guaranteed end to end — Workers and some model providers are
global, and our control plane is single-region. The path to a residency guarantee (§36.13) is:
pin an EU Supabase project + EU R2 jurisdiction + EU-endpoint model routing for EU tenants, and
document the edge-processing-is-transient stance. We will not claim "EU data residency" until
that path is built; we *can* truthfully say data **at rest** lives in the pinned region today.

---

## 36.7 Retention policies — per data class

Retention is "delete by default, keep only with a reason." We **extend the shipped retention
engine** (`image_assets_retention.sql`) — a `pg_cron` job that marks stale, grace-periods, then
purges from both the metadata table and `storage.objects` — to every new data class. Reusing
that proven mark → grace → purge machinery (rather than inventing a new one) is the whole point.

| Data class / table | Retention | Mechanism | Status |
|---|---|---|---|
| Image assets (`image_assets` + Storage) | Stale after **30d** unreferenced, **15d** grace, then purge | `run_image_asset_retention()` daily `pg_cron` (03:15) | **SHIPPED** |
| `venture_events` (C5, hot) | **~90d** full fidelity in Postgres | partition by month; older → R2 cold (compressed JSONL) + daily summary kept | **DESIGNED (A0)** — extend the engine |
| `venture_events` (R2 cold archive) | **~1 year** then delete | scheduled R2 lifecycle / archive sweep | **PLANNED** |
| `audit_log` (C5, security) | **≥ 1 year** (legal/security), then R2 archive; never hard-delete in window | append-only; FKs `set null` on user delete (crypto-shred) | **DESIGNED (F0)** |
| `sessions` (C1/C5) | Prune **revoked/expired** rows after **~30d** (the fact survives in `audit_log`) | sweep on `idle_expires_at` / `revoked_at` | **DESIGNED (F3)** |
| `venture_connections` (C2 ref) | Kept while `active`; on revoke keep row (status `revoked`) for audit; **secret destroyed in Nango** | status flip + Nango revoke | **DESIGNED (A1)** |
| Generated code / versions / artifacts (C4) | Life of the venture; old version spill + build logs in R2 expire on R2 lifecycle | parent-venture lifetime; R2 lifecycle rules | **DESIGNED** |
| Ventures / goals / runs / checkpoints (C3/C5) | Life of the venture; **archive ≠ delete** | `on delete set null` on `studio_*` so archiving a venture never deletes code | **DESIGNED** |
| Profile / identity (C1) | Life of the account; erased on account delete | `on delete cascade` from `auth.users` | **SHIPPED** pattern |
| Backups (PITR + R2 cold) | Supabase PITR window; R2 archives per above | covered by §42 DR | **SHIPPED** (PITR) |

The engineering pattern to copy from the shipped SQL: a **mark** step that sets `expires_at`
once an object is no longer referenced, a **grace** window before deletion, and a **purge** step
that deletes the row *and* the object atomically — with the whole thing idempotent and
cron-scheduled. The new `venture_events`/`audit_log` archivers are the same shape, swapping
"delete from `storage.objects`" for "write a gzipped partition to R2, then drop it."

---

## 36.8 Minors policy

The signup trigger **already enforces a minimum age of 8** (`auth_signup_policy_min_age_8.sql`):
DOB is required, must be a valid date, must not be in the future, and **must be ≥ 8 years before
today**, raising an exception at the database layer (in `handle_auth_user_created`, fired by the
`on_auth_user_created` trigger) — so the rule cannot be bypassed by a client that skips a form
check. This is **SHIPPED** and is the floor.

| Concern | Stance | Status |
|---|---|---|
| Minimum age | **8** enforced in DB trigger; DOB validated | **SHIPPED** |
| Under-13 (COPPA, US) | Between 8 and 13, treat as a minor: no marketing email, conservative defaults; parental-consent flow needed before broad US marketing to this cohort | **PARTIAL** — need explicit COPPA flow |
| GDPR digital-consent age (13–16, member-state dependent) | For EU minors below the local digital-consent age, consent-based processing (marketing) requires parental authorisation | **PLANNED** |
| Autonomous agents for minors | Budgets, checkpoints, and human-gate on irreversibles (§5.10) apply to all users; a minor cannot let an agent spend real money without an approval | brakes **DESIGNED (A0/A8)** |
| Honest gap | DOB self-attestation; no hard age verification (industry norm at this tier) | acknowledged |

The honest read: the **age floor is real and enforced at the database**, but the *graduated*
minors program (COPPA parental consent for 8–13 in the US, GDPR digital-consent-age handling in
the EU, and "no marketing to minors") is **only partially built** — the age-band data exists
(`profile_private.dob`), the marketing default is conservative, but the parental-consent flow
and the marketing-suppression-by-age rule are roadmap (§36.13).

---

## 36.9 Sub-processors & DPAs

A sub-processor is any third party that processes personal data on our behalf. Transparency
here is a GDPR Art. 28 requirement (we must list them, have a DPA with each, and notify users of
changes). The list mirrors the inventory (§36.3).

| Sub-processor | Purpose | Data class | DPA status |
|---|---|---|---|
| **Supabase** | Auth, Postgres, Storage (primary store) | C1, C3, C4, C5 | DPA available — **must execute & file** |
| **Cloudflare** | Workers/DO/Workflows/Containers, R2, edge/WAF | C3, C4, C5 (+ transient) | DPA available — **must execute & file** |
| **Nango** | BYO credential vault (encrypted) | C2 (reference held by us) | DPA available — **must execute & file** |
| **Stripe** | Payments & subscriptions | C1, C2 billing | DPA available — **must execute & file** |
| **Model providers** (OpenAI, Anthropic, Google, OpenRouter, …) | LLM inference on prompts/content | C3, C4 (transient) | Per-provider DPA + no-train terms — **must confirm per provider** (§36.11) |
| **Railway / host** | Backend runtime (platform secrets in env) | C2 platform, C5 logs | DPA — **must execute & file** |
| **Email provider** (transactional/marketing) | Checkpoint/budget alerts, marketing | C1 email | DPA — **must execute & file** |

**Honest status: this register is specified, not signed.** We know exactly who the
sub-processors are and what each touches; we have **not** yet executed and filed every DPA, nor
published a customer-facing sub-processor page with a change-notification subscription. Both are
explicit A9/GA gates (§36.13). The BYO providers a *user* connects (their own Cloudflare/Vercel/
etc.) are **not our sub-processors** — they are the user's own processors under the user's own
terms (§36.10), which is why they are absent from this table.

---

## 36.10 BYOK / BYO-account data flows — the user's data in the user's cloud

The hybrid hosting model (a locked decision) is also Autopilot's strongest privacy feature: a
user can run the autonomous studio such that **their content and their app's data live in their
own cloud, governed by their own terms, where we are not a processor at all.**

| Mode | Where the app + its data live | Secrets | Our role |
|---|---|---|---|
| **Managed preview** (default) | Our Cloudflare account | Platform env / Nango | Controller + processor (full §36 applies) |
| **BYO-account deploy** (A5) | The **user's** Cloudflare / Vercel / Supabase / Railway | In **the user's** account + Nango | We orchestrate; **the user's cloud holds the data** |
| **BYOK model keys** | inference billed to the user's provider account | the user's API key in **Nango** | We route; provider terms are between **user ↔ provider** |

The mechanics that make this private by construction:

- **Credentials never touch our database.** `venture_connections` holds only a
  `nango_connection_id` reference + non-secret metadata (account id, region) — never a token
  (§26.10, §5.3). The secret material is encrypted in Nango; we *use* it via Nango at deploy
  time and **never log it** (§5.9).
- **Least-privilege, per-venture, revocable tokens.** Each adapter requests the minimum scopes
  (`venture_connections.scopes`), deploy tokens are scoped per venture, and revocation flips
  `status` to `revoked` and revokes in Nango (§5.9, §36.7).
- **The user remains the data controller of their deployed app.** When the agent deploys a
  database to the user's Supabase, *that database's* contents (including the app's end-users'
  PII) are the user's to govern. Our DPA with the user makes this division explicit: we are the
  processor for the studio; the user is the controller of what they ship.

This is the answer to the sharpest enterprise question — "do you hold my keys / my customer
data?" — **no:** keys live in Nango, and in BYO mode the customer data lives in the customer's
cloud.

---

## 36.11 Model-provider data handling — no-training, BYOK

User content (C3) and generated code (C4) transit model providers for inference. Two
commitments govern this and both must hold for every provider on the gateway (§29).

1. **No training on our data.** We only route to providers (or provider tiers/endpoints) whose
   terms state that API/inference data is **not used to train or improve their models** and is
   **not retained** beyond a short abuse-monitoring window. This is a procurement gate: a
   provider without acceptable no-train terms is not added to the routing table.
2. **BYOK strengthens it further.** When a user supplies their own key, inference runs under
   *their* account and *their* contract with the provider — the data-handling terms are then
   directly between the user and the provider, and we are merely the conduit.

| Control | Detail | Status |
|---|---|---|
| No-train terms per provider | Confirmed before a provider joins the gateway | **must confirm per provider** (A9) |
| Minimised prompt persistence | We store `prompt_hash` + `model`, **not** the raw prompt, in `venture_events` (§26.7) | **DESIGNED (A0)** |
| Zero/short retention tier | Prefer provider endpoints with zero-retention / no-log where offered | **PLANNED** |
| BYOK isolation | Key in Nango; inference on the user's account | ref **SHIPPED**; venture wiring **DESIGNED** |
| Output secret-scan | Generated code scanned for leaked secrets before ship (§5.4, §35) | **DESIGNED (A4/A9)** |

The `prompt_hash`-not-prompt choice (§26.7) is the quiet hero here: it gives full
**explainability** ("this model made this decision, with this prompt fingerprint") **without**
persisting the user's content into our most-replicated, longest-lived table.

---

## 36.12 Audit log for data access

Two append-only logs together answer "who touched this data, and why?" — the cornerstone of
both the security story (§35) and the accountability principle of GDPR Art. 5(2).

| Log | Scope | What it records | RLS / access | Status |
|---|---|---|---|---|
| `audit_log` (F0) | Whole platform | role changes, project/account deletes, auth events, deploys, **kill-switch**, **data-export/erasure requests** | **deny-all to clients**, admin-only via service role | **DESIGNED (F0)** |
| `venture_events` (A0) | Per venture | every loop step, decision (`model` + `prompt_hash`), cost, checkpoint, deploy | owner-read + insert; **append-only** | **DESIGNED (A0)** |

Design points that make these *governance* tools, not just debug logs:

- **Append-only by construction.** `venture_events` has SELECT+INSERT policies and *deliberately
  no* UPDATE/DELETE policy (§26.7); `audit_log` has no client policy at all and never accepts
  UPDATE/DELETE. A record, once written, cannot be quietly altered — which is exactly what an
  auditor needs.
- **Right-request actions are themselves audited.** Every export, deletion, rectification, and
  consent change writes an `audit_log` row (action `data.export` / `data.erase` /
  `consent.change`), so we can prove a request was honoured and when.
- **`request_id` correlation.** `audit_log.request_id` ties an audited action to the F0 trace
  context across logs and metrics (§38), so a data-access event is reconstructable end to end.
- **PII discipline in the logs themselves.** Logs record *references and hashes* (user id,
  resource id, `prompt_hash`), not payloads; the logging layer scrubs known-PII fields
  (DESIGNED, §38) so the audit trail does not become a second uncontrolled copy of C1/C3.

---

## 36.13 Compliance roadmap — honestly not-yet

This is the deliberately blunt part. The primitives are strong; the **program** is early. Below
is what GDPR/CCPA readiness and SOC 2 actually require, and where each stands.

| Item | Needed for | Status | Lands |
|---|---|---|---|
| Owner-RLS on every table | GDPR access/erasure foundation | **SHIPPED / DESIGNED** (F6 CI gate enforces) | now |
| Delete-cascade erasure path | Right to erasure | **DESIGNED (A0/A1)** | A1 |
| Self-serve **export** job (ZIP per user) | Portability / access | **PLANNED** | A9 |
| Self-serve **delete account** + R2/Nango purge | Erasure (full) | **PLANNED** | A9 |
| **Privacy notice** for the venture layer | Transparency (Art. 13/14) | **NOT STARTED** | pre-GA |
| Versioned ToS/consent record (which version accepted) | Defensible consent | **PARTIAL** (`terms_accepted` bool only) | pre-GA |
| **DPA register** signed + filed (all §36.9) | Art. 28 | **NOT STARTED** | pre-GA |
| Public **sub-processor page** + change notice | Art. 28 transparency | **NOT STARTED** | pre-GA |
| Per-provider **no-train** confirmation | Model data handling | **PARTIAL** | A9 |
| EU **data-residency** path (EU Supabase + R2 jurisdiction + EU routing) | Residency guarantee | **NOT STARTED** | post-GA |
| **DPIA** for autonomous processing | High-risk processing (Art. 35) | **NOT STARTED** | pre-GA |
| Graduated **minors** program (COPPA 8–13, GDPR digital-consent-age) | Children's data | **PARTIAL** (age floor SHIPPED) | post-GA |
| **DPO / privacy contact** + breach-notification (72h) runbook | Accountability / Art. 33 | **NOT STARTED** | pre-GA |
| **SOC 2 Type I → Type II** | Enterprise trust | **NOT STARTED** | post-GA (6–12mo for Type II) |
| RLS-coverage + `get_advisors` in CI; tenant-isolation audit | Provable isolation | **DESIGNED (F6/A9)** | A9 |

**The honest GA stance.** We will not call Autopilot "GDPR/CCPA compliant" or "SOC 2 certified"
at GA, because it won't be. What we *can* truthfully say at GA (the A9 gate, §5/A9): owner
isolation is provable (CI + tenant-isolation audit + `get_advisors`); secrets are only in Nango;
there is a working erasure path and a manual-then-automated right-request process; consent and
the age floor are enforced in the database; sub-processors are listed and (by GA) under DPA. SOC
2 Type II and a hard EU-residency guarantee are **post-GA**, on the dates above — stated as
roadmap, not as quietly-implied facts.

---

## 36.14 Mapping to F3 / F6 / A9

| This section | Realised by | What it contributes |
|---|---|---|
| **F3** — session/identity | §36.3, §36.5 (sessions/devices PII), §36.7 (session retention), §36.12 (auth events audited) | Governs the C1 session/device data F3 creates; idle/absolute timeouts and revocation are also a *minimisation* control |
| **F6** — migrations & RLS coverage | §36.2–§36.5 (RLS is the access/erasure foundation), §36.13 (CI gate) | The F6 RLS-coverage CI check is *the* technical control that makes "access" and "erasure" enforceable on every table; idempotent migrations make the schema (and its governance) reproducible |
| **A9** — hardening & GA | §36.5 (export/erase jobs), §36.9 (DPAs), §36.11 (no-train confirm), §36.13 (the whole roadmap) | A9 is the compliance GA gate: tenant-isolation audit, secret-handling review, the privacy-program items, and "approve GA" all live here |
| F0 — audit log | §36.5 (erasure crypto-shred), §36.12 | The append-only `audit_log` is the accountability spine |
| §5 — security & multi-tenancy | §36.10 (BYO secrets in Nango), §36.2 (classification), §36.7 (spend-cap-as-control adjacency) | Privacy and security share the same isolation + secret-handling substrate |

---

## 36.15 Consistency check (this section vs the rest)

| Concern | This section realizes |
|---|---|
| Data model (§26) | Classification + retention + rights map onto the exact tables, RLS anchors, and cascade rules in §26.14 |
| Storage (§32) | R2 tiers (artifacts/spill/logs) carry residency + retention rules; image assets reuse the shipped engine |
| Integrations (§30) / Adapters (§31) | BYO credential flow (Nango reference only) and BYO-account deploys are the §36.10 privacy posture |
| Model gateway (§29) | No-train + BYOK + `prompt_hash`-not-prompt is the §36.11 model-data contract |
| Security & threat model (§35) | This is the governance complement; both rest on RLS + Nango + append-only logs |
| Master Plan §5 / A9 | Secrets-only-in-Nango, spend-caps, kill-switch, and the A9 GA gate are honoured, not re-litigated |
| Existing privacy SQL | `image_assets_retention.sql` (retention engine, extended), `profile_private_email_preferences.sql` (consent, reused), `auth_signup_policy_min_age_8.sql` (age floor, the minors baseline) |

The governance above is only as true as the schema and the SQL it points at. When a column's
class, a retention window, or a sub-processor changes, it changes in the migration / DPA
register first, then here and in the data dictionary (§54) — the code and the contracts are the
source of truth, this section is their honest, auditable summary.
