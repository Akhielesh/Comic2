# 42 — Disaster Recovery & Backups

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (A0 brakes / kill switch, A9 isolation & SRE) +
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F0 audit/observability, F6
> migrations & data-store discipline) · builds on [§26 Data Model & Schema](./26-data-model-schema.md)
> (per-table backup & retention notes), [§32 Storage](./32-storage.md) (durability, quotas,
> cross-store backup) · adjacent to §37 Reliability & SRE (📋 planned, SLOs/error budgets) and
> §50 Runbooks (📋 planned, the operational procedures this DR runbook lives beside) ·
> grounded in [`docs/production/deployment-runbook.md`](../../../production/deployment-runbook.md)
> (rollback procedure) and the "containers disposable, projects durable" principle of
> [`../../06-DATA-MODEL.md`](../../06-DATA-MODEL.md).

## 42.1 What this section is (and what it is not)

This is the **disaster-recovery (DR) plane** for Autopilot: the targets, backup strategy,
restore procedures, and incident posture that bound how much data we can lose and how long
recovery takes when a data store, a region, or a vendor fails. Section 26 stated per-table
retention and "Backups: Postgres PITR (Supabase) covers all tables… DR specifics are §42";
section 32 stated "DR detail in §42." This section is that detail.

What it is **not**: it is not the SLO/error-budget framework (§37, planned — *steady-state*
reliability), nor the day-to-day operational runbooks (§50, planned). DR is the **worst-case**
plane: the data is gone, the region is dark, or the vendor is down. The two cross-reference but
do not overlap.

Three honesty rules, matching the rest of the spec:

1. **Mark shipped vs planned, and mark illustrative numbers.** Supabase PITR/backups and R2
   durability are **vendor-provided today**; the kill switch (`VENTURES_KILL`) is **specified
   in A0** (§24.7). The cross-account R2 copy, the periodic restore drill, and multi-region
   failover automation are **PLANNED**. RTO/RPO numbers below are **illustrative targets
   `[design]`**, not contractual SLAs — they set the engineering bar, and §37 will turn the
   steady-state subset into committed SLOs.
2. **Back up what we cannot recreate; do not back up what we can.** Source code, version
   history, the append-only audit/event logs, billing ledger, and IaC/config are
   *irreplaceable* and get layered backups. Build artifacts, logs, container state, and
   sandbox scratch are *regenerable* — a re-run recreates them, so they are not in the backup
   set (§32.10). This keeps the backup surface small and the restore fast.
3. **Secrets are never in our backups.** BYO credentials live only in Nango; our database and
   object stores hold *references*, never plaintext (§26.10, §32.1). A leaked or restored
   backup therefore cannot leak a customer's cloud credential — recovery of secrets is a
   re-authorize flow, not a restore (§42.4.4).

---

## 42.2 The organizing principle: containers are disposable, projects are durable

The single decision that shapes Autopilot's DR posture is inherited verbatim from
[§06 Data Model](../../06-DATA-MODEL.md):

> Containers are **disposable**; the **project is durable**. We persist files + history in
> Supabase so a sleeping/evicted container never loses work.

DR is just the extreme case of this rule. Losing a **container** (sandbox crash, Cloudflare
Container eviction, a whole colo going dark) loses **no durable work**, because the container
holds only *derived, in-flight* state: a checkout of files that already live in
`studio_files`/`studio_versions`, a build that can re-run, scratch on a local FS. The agent's
*intent and progress* live in durable Postgres rows (`venture_runs`, `venture_goals`,
`venture_events` — §26.8–26.9): a crash mid-Tick resumes from durable state on the next
schedule (§24.9 crash-safety), and the scheduler picks up active runs (`ended_at is null`).

This bounds the blast radius of the *common* failure to near-zero data loss and turns "recover
a container" into "schedule a new one" — no DR procedure required. DR effort therefore
concentrates entirely on the **durable tier**: Supabase Postgres, the object stores
(Supabase Storage + R2), the Nango secret vault, and the config/IaC in git.

| If we lose… | What is lost | Recovery |
|---|---|---|
| A sandbox container | derived checkout + in-flight build (regenerable) | scheduler launches a fresh container; run resumes from durable rows — **no DR** |
| A Durable Object instance (UserCoordinatorDO/VentureDO) | in-memory coordination state | DO storage is durable & replicated by Cloudflare; rehydrates from Postgres on next tick |
| A build artifact / log object | a bundle / a log (regenerable) | re-run the build; **not backed up** by design (§32.10) |
| **A Postgres table / row** | durable code, history, ledger, events | **PITR restore** (§42.4.1) — this is the DR case |
| **An object store / bucket** | image assets / spilled code / snapshots | R2 11-nines + cross-account copy; Supabase Storage backup (§42.4.2) |
| **A whole region/vendor** | availability of the above | failover posture (§42.5) + vendor continuity (§42.7) |

The rest of this section is about the bottom three rows.

---

## 42.3 RTO / RPO targets per data store (illustrative)

**RTO** (Recovery Time Objective) = how long until the store is usable again. **RPO**
(Recovery Point Objective) = how much recent data we can lose (the gap between the last
recoverable point and the failure). Targets are tiered by *irreplaceability*: the data we
cannot regenerate gets the tightest RPO; the data we can regenerate gets a loose one because
"restore" means "re-run."

| Data store | Contents | RPO target `[design]` | RTO target `[design]` | Basis |
|---|---|---|---|---|
| **Supabase Postgres** (all tables) | ventures, goals, runs, checkpoints, events, ledger, sessions, audit, studio_* refs | **≤ 1 min** (PITR / WAL) | **≤ 1–2 h** (PITR restore to new project) | continuous WAL; daily base backup |
| **`audit_log` + `venture_events`** (append-only) | forensic + activity record | **0 (no loss tolerated within retention)** | ≤ 2 h (in Postgres) + cold archive in R2 | append-only + R2 cold copy (§26.14) |
| **Token ledger / billing** | `token_ledger_entries`, wallets, cost events | **≤ 1 min** (financial — tightest) | ≤ 2 h | PITR; reconciled vs Stripe (§42.6) |
| **R2** (`autopilot-artifacts`, `app-assets`) | code spill, snapshots, app/user assets | **snapshots/assets: ~24 h** (cross-account copy); **logs/artifacts: regenerable, n/a** | spill/snapshots ≤ 4 h; artifacts = rebuild time | 11-nines durability + daily cross-account copy |
| **Supabase Storage** (`comic-assets`) | generated images (SHIPPED pipeline) | **~24 h** | ≤ 4 h | project backup; re-derivable from generation if needed |
| **Nango** (BYO secrets) | OAuth tokens / PATs for deploy adapters | **n/a — we never hold them** | re-authorize ≈ minutes per connection | vault is Nango's; recovery = re-auth (§42.4.4) |
| **Config / IaC** (git) | wrangler/migrations/env schema/deploy config | **0 (in git history)** | minutes (redeploy from a SHA) | git is the source of truth; pinned SHAs (deploy-runbook) |
| **Durable Objects** (Cloudflare) | per-user/venture coordination state | seconds (DO storage durable) | seconds (rehydrate from Postgres) | Cloudflare-managed durability |

**Reading the table.** The two numbers that matter most are the **financial/audit RPO (~1
min, append-only ⇒ effectively 0)** and the **Postgres RTO (≤ 1–2 h)**. Everything else is
either re-derivable (loose RPO, "restore = rebuild") or held by a vendor whose own durability
exceeds anything we could engineer. The aggressive RPOs ride on **vendor-native continuous
backup** (Supabase PITR, R2 versioning) — we do not build a custom WAL shipper; we *use* the
managed one and verify it (§42.4.5).

---

## 42.4 Backup strategy per store

### 42.4.1 Supabase Postgres — PITR + base backups

Postgres is the **system of record** for everything durable that is small + queryable
(§26, §32). It gets the strongest, most-tested backup posture.

| Layer | Mechanism | Cadence / window | Recovers from |
|---|---|---|---|
| **PITR (WAL)** | Supabase continuous Point-In-Time-Recovery | continuous; ~7–30 day window (plan-dependent) `[verify per plan]` | accidental `DELETE`/`UPDATE`, bad migration, corruption — restore to a timestamp *just before* the event |
| **Daily base backup** | Supabase automated full backup | daily, retained per plan | full-project loss; the floor under PITR |
| **Logical export `[design]`** | scheduled `pg_dump` of the irreplaceable tables → R2 (independent vendor) | daily | a Supabase-account-level disaster (defense beyond a single vendor) |
| **Migration source** | ordered, idempotent Supabase migration runner (§26.13) in git | per commit | rebuilding an *empty* schema deterministically from a SHA |

Two properties make Postgres restore reliable. First, **PITR gives a ~1-minute RPO** for the
whole relational tier in one operation — every table (ventures, ledger, audit, sessions,
studio refs) is consistent to the same point because they share one WAL. Second, the
**schema is reproducible from git** (idempotent migrations, F6): a *structural* recovery
("rebuild the database shape") is independent of a *data* recovery ("restore the rows"), so a
fresh project can be schema-provisioned in minutes and then PITR-loaded.

The **logical export to R2** is the deliberate hedge against the one thing PITR cannot cover —
loss of, or lockout from, the Supabase *account* itself: a daily `pg_dump` of the
hard-to-regenerate tables (ventures/goals/runs/checkpoints, ledger, `audit_log`,
`venture_events`, `studio_*` rows) lands in a **different vendor's** store (R2), so no single
provider holds the only copy of our irreplaceable data. This is the database analogue of
§32.10's "cross-account copy for the un-regenerable classes."

### 42.4.2 R2 — versioning, durability & cross-account copy

R2 holds code spill, version snapshots, build artifacts/logs, and app/user assets (§32.7). Its
backup posture is tiered by *regenerability*, per Rule 2:

| R2 class | Backup posture | Why |
|---|---|---|
| **Version snapshots** (`…/versions/…`) | **cross-account/bucket copy** (daily); object versioning on | un-regenerable history; the priority backup (§32.10) |
| **App static + end-user uploads** (`…/assets/…`, `…/uploads/…`) | **cross-account copy** + versioning | user data we cannot recreate |
| **Code-file spill** (`…/files/<sha256>`) | covered by the snapshot copy (a snapshot manifest references its files) | content-addressed; re-derivable from a restored snapshot |
| **Build artifacts** (`…/artifacts/…`) | **none** — regenerable | a re-run of the build rebuilds the bundle |
| **Build logs** (`…/logs/…`) | **none** — 7-day TTL; the durable fact is in `venture_events` | debug-tier (§32.7) |

Baseline durability is **R2's 11 nines, multi-region replicated by Cloudflare** `[verified
2026-06]` (§32.10). On top of that we add: **object versioning** (so an accidental overwrite
or delete is itself recoverable to the prior version) and a **daily cross-account copy** of
the un-regenerable classes into a separate Cloudflare account/bucket, so a single-account
compromise or fat-fingered bucket delete cannot erase history. Content-addressing
(`<sha256>`) makes every copy **self-verifying** — a restored object is correct iff its bytes
hash to its key, so integrity verification is free (§32.10, §42.4.6).

### 42.4.3 Supabase Storage — durability + export (image pipeline)

The SHIPPED image pipeline (`comic-assets`, §32.6) is durable object storage backed up with
the Supabase project. Its DR posture: the **reference rows** (`image_assets`) are covered by
Postgres PITR (§42.4.1); the **bytes** are durable in Supabase Storage and, for the
un-regenerable subset, included in the same daily export discipline as R2's assets. Generated
images are partly *re-derivable* (re-run generation from the stored prompt/params), so they sit
between "irreplaceable" and "regenerable" and get backup but not the tightest RPO.

### 42.4.4 Nango — secrets "recovery" is re-authorization, not restore

We **never hold** BYO credentials; `venture_connections` stores only a `nango_connection_id`
reference (§26.10). This is a DR *feature*, not a gap:

- **Nango is the vault.** Token storage, encryption, and refresh are Nango's responsibility;
  its own backup/durability is the recovery mechanism for the secret material. We do not, and
  must not, mirror plaintext tokens into our backups.
- **Our recoverable part** is the *reference + metadata* row (provider, label, scopes, status),
  which is in Postgres and covered by PITR. After a restore, the reference points back at the
  live Nango connection — no secret needs to move.
- **If Nango itself loses a connection** (or a token is revoked upstream), recovery is a
  **re-authorize**: the owner re-runs the short OAuth/PAT flow from the Integrations UI (§18),
  which mints a fresh Nango connection; we update the reference and `status`. This is **minutes
  per connection**, fully owner-driven, and audited. Per-venture, revocable, never-logged deploy
  tokens (Master Plan §5.9) mean a re-auth is low-risk and isolated.

The honest summary: **there is no secret backup to restore, by design**, and that removes the
single highest-severity item from the DR threat surface (a backup that leaks credentials).

### 42.4.5 Config / IaC in git — the source of truth

Everything that defines *how the system is shaped* — `wrangler` config (Workers/DO/Workflows/
R2 bindings, §23), the Supabase migration runner (§26.13), env-var schema and validation
(`STRICT_ENV_VALIDATION`, deploy-runbook), deploy config, retention SQL — lives in **git**.
Git history *is* the backup: any version is recoverable to a commit, and the deploy-runbook's
**SHA-pinning** discipline (pin frontend + backend to the same commit, set `GIT_SHA`) means a
known-good configuration can be redeployed deterministically. Secrets are **not** in git
(env vars in deploy targets / Nango); a config restore brings back structure and wiring, then
secrets are re-injected from the secret manager / re-authorized (§42.4.4).

### 42.4.6 Backup verification (a backup you have not restored is a rumor)

A backup is only real if it restores. The DR posture therefore includes **verification**, not
just creation:

- **Restore drill (PLANNED, A9):** a periodic (e.g. quarterly `[design]`) PITR restore into a
  throwaway Supabase project + an R2 cross-account restore into a scratch bucket, followed by
  the §42.4.7 verification checklist. The drill is itself a §50 runbook and its result is
  recorded (last-tested date is a DR metric).
- **Integrity checks (continuous):** content-addressed R2 objects are verified by hash on read
  (§32.10) — a corrupted object fails its hash and is re-fetched/regenerated. The logical
  `pg_dump` export's row counts and checksums are compared against the live DB after each run.
- **Schema reproducibility check (CI, F6):** the migration runner is asserted to build a fresh
  schema from empty on every CI run, so "rebuild the database shape" is continuously proven.

### 42.4.7 Restore procedures

| Scenario | Procedure (outline) | Target |
|---|---|---|
| **Accidental row/table delete or bad migration** | PITR restore to a timestamp *just before* the event → into a **new** project → verify → cut over (or selective table copy-back for a narrow blast radius) | RTO ≤ 1–2 h, RPO ≤ 1 min |
| **Postgres project-level loss** | Restore latest daily base backup + replay WAL to PITR point → new project → repoint `VITE_SUPABASE_URL`/service-role in deploy targets → smoke test | RTO ≤ 2 h |
| **Supabase-account disaster** | Provision fresh project → apply migrations from git (§26.13) → load latest logical `pg_dump` from R2 → reconcile ledger vs Stripe (§42.6) | RTO hours (rarer, deeper) |
| **R2 object loss / overwrite** | restore from object **version** (single object) or **cross-account copy** (bucket-level) → verify by sha256 | RTO ≤ 4 h, RPO ~24 h |
| **Supabase Storage loss** | restore from project backup / export; re-derive regenerable images if needed | RTO ≤ 4 h |
| **Nango connection loss** | owner **re-authorizes** from Integrations UI → update reference row | minutes/connection |
| **Config drift / bad deploy** | **rollback** to prior deployment (deploy-runbook §Rollback): redeploy previous Pages/Railway image; verify health/ready/version | minutes |

Every restore ends in the **verification checklist (§42.6)** before the incident is closed.
No restore is "done" until it is verified.

---

## 42.5 Multi-region & failover posture (Cloudflare + Supabase)

| Layer | Today's posture | Failover behavior | Planned hardening |
|---|---|---|---|
| **Cloudflare Workers / Pages / DO / Workflows** | runs at the **edge across Cloudflare's global network** by default | a single colo/PoP failure is absorbed transparently — requests route to the next healthy location; DO state is durable & rehydrates | none needed for compute; this is Cloudflare-native |
| **R2** | multi-region replicated by Cloudflare (11 nines) | object reads survive a region loss transparently | cross-account copy (§42.4.2) guards account-level, not region, loss |
| **Supabase Postgres** | **single primary region** (the realistic posture for a managed Postgres) | a region outage = a Postgres outage until Supabase recovers or we PITR-restore into another region | **PITR-restore into a different region** as the documented failover; evaluate read-replica / multi-region if scale justifies |

The honest picture: **the edge tier (Cloudflare) is inherently multi-region**; the **stateful
relational tier (Supabase) is single-region** and is therefore the binding constraint on
regional DR. Our regional-loss play for Postgres is **PITR-restore into a healthy region**
(RTO ≤ 1–2 h, RPO ≤ 1 min), not hot standby — multi-region active Postgres is a real cost and
complexity step we take only when scale/SLA demands it (§37 will own that decision). Crucially,
while Postgres is down, the **kill switch / safe-stop** (§42.8) halts the autonomous engine so
no Tick runs against a degraded or stale data plane — DR and the brakes are coupled by design.

---

## 42.6 Verification checklist (post-restore)

Reused from the deploy-runbook smoke test and extended for DR. A restore is closed only when
all pass:

1. **Health/readiness/version** — `/api/health`, `/api/system/ready`, `/api/system/version`
   green; `gitSha` matches the intended release (deploy-runbook §Smoke Test).
2. **Auth** — a login flow + a session check (sessions table consistent, no mass-logout beyond
   the restore point).
3. **Tenant isolation intact** — the A9 "user A cannot read user B" test passes against the
   restored data (§26.14) — a restore must never weaken RLS.
4. **Ledger reconciliation** — billing ledger vs Stripe for the restore window; any gap from
   the RPO is identified and reconciled (financial data is the tightest; §42.3).
5. **Object integrity** — sampled R2 objects pass sha256; reference rows resolve to live
   objects; no orphaned-ref / missing-object drift (the retention walk reclaims true orphans).
6. **Engine resumes cleanly** — with the kill switch still on, confirm active runs
   (`ended_at is null`) are consistent; then **lift the kill switch** and confirm one Tick
   completes end-to-end (DECIDE gate, budget read, event append).
7. **Audit continuity** — `audit_log`/`venture_events` show the incident and the restore as
   audited events; no gap before the RPO point.

---

## 42.7 Data-loss scenarios & mitigations

| Scenario | Primary mitigation | Backstop | Residual risk |
|---|---|---|---|
| **Accidental delete** (user or operator deletes rows/objects) | RLS limits blast radius to the owner; **PITR** (Postgres) / object **versioning** (R2) restores to just-before; Venture delete is **archival, not cascade** (§26.14 `on delete set null`) | logical `pg_dump` / cross-account copy | data created *after* the delete but *before* the restore point (bounded by RPO) |
| **Data corruption** (bad migration, app bug, bit-rot) | idempotent forward-only migrations + CI schema check (F6); PITR to before the bad migration; **content-addressed objects self-verify** on read | restore from cross-account copy; rebuild file tree from a clean version snapshot | corruption undetected past the PITR window |
| **Provider outage** (Supabase / R2 / Nango / model gateway down) | **kill switch / safe-stop** halts the engine (§42.8) so we degrade, not corrupt; Cloudflare edge stays up; model gateway has provider failover (§29) | wait + auto-resume on recovery; PITR-restore elsewhere if prolonged | availability gap during the outage (no data loss) |
| **Region loss** (a Supabase region goes dark) | PITR-restore into another region (§42.5); edge + R2 survive regionally | logical export → fresh project in a healthy region | RTO of a cross-region restore (≤ 1–2 h target) |
| **Account compromise / mass-delete of a store** | cross-account R2 copy + independent-vendor `pg_dump`; least-privilege service identities; kill switch | offline/immutable copy of the irreplaceable set | sophisticated attacker who also reaches the secondary copy (multi-account separation mitigates) |
| **Secret loss** (Nango connection gone) | **re-authorize** (§42.4.4) — we never held the secret | per-venture revocable tokens limit exposure | brief deploy-capability gap until re-auth |
| **In-flight work loss** (container/DO crash mid-Tick) | "containers disposable, projects durable" (§42.2): durable rows resume; crash-safe loop (§24.9) | scheduler relaunches; idempotent Workflow steps replay | the partial Tick re-runs (idempotent by construction) |

The pattern across every row: **availability incidents degrade (halt safely), they do not
corrupt**, because the kill switch stops the engine before it can write against a sick data
plane; and **destructive incidents are bounded by a backup whose RPO we have chosen** per data
class.

---

## 42.8 Kill switch & safe-stop of the autonomous engine during an incident

DR for an *autonomous* product has a dimension a normal app does not: an always-on engine that
keeps spending money and mutating state. During an incident — a data store degraded, a restore
in progress, a runaway loop, a provider outage — the **first action is to stop the engine
safely**, *before* any restore, so recovery happens against a quiescent system.

| Control | Scope | Mechanism | Source |
|---|---|---|---|
| **Global kill switch** | **all** ventures, all users | `VENTURES_KILL=true` (one flag), flipped via an admin route; re-checked at **both** schedule time and inside the DECIDE gate | §24.7 (line: "Global kill switch · scheduler + DECIDE · `VENTURES_KILL=true`") |
| **Per-venture pause** | one venture | `ventures.status='paused'` + `pause_reason` (`kill`/`budget`/`checkpoint`/`stuck`) (§26.4) | §24.5 DECIDE re-check |
| **Budget brake** | one venture | deterministic cap check pauses on breach (§26.5) | A0 |

**Safe-stop semantics (why it is *safe*, not just *stop*):**

- **No mid-write corruption.** The kill switch is checked at safe points — schedule and the
  DECIDE gate (§24.5) — not by killing a process mid-write. An in-flight Tick either has not
  yet passed DECIDE (so it never acts) or completes its current durable step; the loop is
  crash-safe (§24.9), so even a hard stop resumes cleanly from durable rows.
- **Halt = no new spend, no new mutation.** With the switch on, no Tick proceeds to ACT, so no
  money is spent and no external publish happens — exactly the property we need while a store
  is degraded or a restore is mid-flight.
- **Audited.** Flipping the kill switch writes an `audit_log` row (`action='kill_switch'`,
  §26.11) with actor + `request_id` — the DR timeline is reconstructable.
- **Reversible & verified.** Recovery lifts the switch **only after** the §42.6 checklist
  passes; the first post-restore Tick is watched end-to-end (checklist step 6). Per-venture
  pauses can be lifted selectively if only some ventures were affected.

The standing rule: **stop the engine first.** Restoring data while the engine is still acting
risks the engine writing stale or duplicate state over a restore in progress. The kill switch
is therefore step 0 of every data-plane DR runbook (§42.9).

---

## 42.9 DR runbook outline (detect → contain → restore → verify → post-mortem)

The full procedures live in **§50 Runbooks** (📋 planned); this is the DR-specific skeleton
they expand. Each phase has an owner and an exit condition.

| Phase | Actions | Exit condition |
|---|---|---|
| **1 · Detect** | alert fires (uptime ping, 5xx rate, advisor, integrity check, ledger drift — §38/deploy-runbook §Monitoring); on-call confirms it is a DR-class event (data loss / store down / region loss) vs a transient blip; open an incident, start the timeline | event classified + severity assigned |
| **2 · Contain** | **flip the kill switch (`VENTURES_KILL`)** — stop the engine (§42.8); stop the bleeding (revoke a compromised credential, fail the bad migration, isolate the affected store); freeze writes if needed; communicate status | engine halted; no further data loss possible |
| **3 · Restore** | choose the procedure (§42.4.7) for the store + scenario; PITR / version / cross-account / re-auth as applicable; restore into a **new** target where appropriate, never in-place on a corrupt store; track RPO actually achieved | data recovered to the chosen point; store usable |
| **4 · Verify** | run the **post-restore checklist (§42.6)** — health, auth, isolation, ledger reconciliation, object integrity, one clean Tick, audit continuity; **then lift the kill switch** | all checks green; engine resumed; incident closed |
| **5 · Post-mortem** | blameless write-up: timeline, root cause, RPO/RTO achieved vs target, what worked, action items (add an alert, tighten a backup, fix the migration gate); update this section + §50 if the procedure changed; record last-restore-tested date | post-mortem filed; action items tracked |

This is the standard **detect → contain → restore → verify → post-mortem** shape, with the
two Autopilot-specific twists baked in: **contain = kill switch first** (an autonomous engine
must be halted before recovery), and **verify includes a tenant-isolation + ledger-reconcile +
one-clean-Tick check** (a restore must not weaken RLS, lose money silently, or resume a broken
loop).

---

## 42.10 Vendor-dependency continuity

Autopilot stands on a small set of vendors; honest DR names what happens when each is down and
where the single points of failure (SPOFs) genuinely are.

| Vendor | Role | If it is **down** (availability) | If it is **lost** (durability) | SPOF? |
|---|---|---|---|---|
| **Cloudflare** (Workers/DO/Workflows/Pages/R2) | the compute + edge + one object tier | edge is multi-region, absorbs PoP loss; a *global* Cloudflare outage = product down (we run on it) | R2 11-nines + cross-account copy; DO durable | **partial SPOF** — accepted: it is the architecture (§23); mitigated by cross-account copy + git-deployable config |
| **Supabase** (Postgres/Auth/Storage) | system of record + auth + image bytes | region/project outage = data plane down; **kill switch halts the engine**, edge stays up; PITR-restore elsewhere if prolonged | PITR + daily base + **independent-vendor `pg_dump`** breaks the single-vendor durability SPOF | **the stateful SPOF** — most-mitigated store |
| **Nango** | BYO secret vault | deploys/integrations pause; managed hosting + the rest of the loop continue | **no secret backup by design**; recovery = re-authorize (§42.4.4) | low — references survive in PITR; secrets re-mintable |
| **Model gateway / LLM providers** | the agents' "thinking" | gateway **fails over across providers** (§29); if all down, ACT pauses, no corruption | stateless; nothing to restore | low — multi-provider by design |
| **Stripe** | billing | charges queue / retry; the engine can keep building on existing budget; reconcile on recovery (§42.6) | Stripe is system-of-record for payments; we reconcile our ledger to it | low |
| **Git host (GitHub)** | IaC + code source of truth | deploys from a SHA still work from a local/clone; can re-host | distributed by nature (every clone is a copy) | low |

The two honest truths: **Cloudflare and Supabase are the load-bearing vendors** — a total,
prolonged outage of either degrades the product, because they *are* the platform — and we do
not pretend otherwise. What DR *does* guarantee is that neither becomes a **data-loss** SPOF:
Cloudflare's durability is backstopped by a cross-account copy; Supabase's is backstopped by an
**independent-vendor logical export**, so our irreplaceable data never lives in exactly one
company. For *availability*, the mitigation is the kill switch (degrade safely) plus PITR-into-
another-region; multi-region active redundancy is a §37 cost/SLA decision, not an MVP claim.

---

## 42.11 Mapping to the plan (F0 / F6 / A9)

| Item | What this section commits to |
|---|---|
| **F0 — audit & observability** | the kill-switch flip and every restore are **audited** (`audit_log`, `action='kill_switch'`, `request_id` correlation, §26.11); detection rides the F0/deploy-runbook monitoring (uptime, 5xx, latency, budget alerts); the DR timeline is reconstructable from the append-only logs. |
| **F6 — migrations & data-store discipline** | restore depends on **reproducible schema** from the ordered, idempotent Supabase migration runner (§26.13) — a fresh project is provisionable from git; the CI schema-build check (§42.4.6) continuously proves it; backups are taken of the F6-governed stores. |
| **A9 — isolation, SRE & DR drills** | the **restore drill** (PLANNED) and the post-restore **tenant-isolation check** (the A9 "user A cannot read user B" test, §26.14) live here; A9 owns the periodic DR exercise and the last-tested-date metric. |

Adjacent: this section consumes the per-table backup/retention rules of [§26](./26-data-model-schema.md)
and the durability/cross-store-copy posture of [§32](./32-storage.md); it hands steady-state
reliability (SLOs, error budgets) to §37 (planned) and the expanded step-by-step procedures to
§50 (planned). It changes **no other file**.

---

## 42.12 Acceptance criteria

- **RTO/RPO targets** are specified **per data store**, tiered by irreplaceability, and clearly
  marked **illustrative `[design]`** (not contractual SLAs).
- **Backup strategy is specified per store:** Supabase Postgres (PITR + daily base + logical
  export to an independent vendor); R2 (11-nines + versioning + cross-account copy, tiered by
  regenerability); Supabase Storage (project backup + export); Nango (no secret backup —
  recovery = re-authorize); config/IaC (git as source of truth, SHA-pinned redeploy).
- **Restore procedures** are given for each store/scenario, each ending in a **verification
  checklist**, and **backup verification** (restore drill, integrity checks, schema-build CI)
  is explicit — "a backup you have not restored is a rumor."
- The **"containers disposable, projects durable"** principle is stated and used as the
  organizing rule (§42.2), cross-referencing §06 — in-flight container/DO loss costs no durable
  work.
- **Multi-region/failover posture** is honest: Cloudflare edge + R2 are multi-region; Supabase
  Postgres is single-region with PITR-into-another-region as the documented regional play.
- The **kill switch / safe-stop** (`VENTURES_KILL` + per-venture pause) is specified as **step
  0 of data-plane DR** — halt the engine first, audited, reversible only after verification.
- **Data-loss scenarios** (accidental delete, corruption, provider outage, region loss, account
  compromise, secret loss, in-flight loss) each have a primary mitigation, a backstop, and a
  named residual risk.
- A **DR runbook outline** (detect → contain → restore → verify → post-mortem) is given with
  per-phase owners/exit conditions, cross-referencing §50.
- **Vendor-dependency continuity** names the load-bearing vendors (Cloudflare, Supabase) as
  partial SPOFs honestly, and shows neither is a **data-loss** SPOF (cross-account copy +
  independent-vendor export).
- The section **maps to F0 / F6 / A9** and changes **no other file**.
