# 32 — Storage & File Management

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (Epic A1 control plane, Epic A5 deploy adapters) ·
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F6 migrations & data-store
> discipline) · existing substrate: [`../../06-DATA-MODEL.md`](../../06-DATA-MODEL.md)
> (file storage strategy), [`./26-data-model-schema.md`](./26-data-model-schema.md)
> (schema + retention), [`./23-cloudflare-topology.md`](./23-cloudflare-topology.md) (R2
> binding, §23.5.1) · grounded in [`server/src/services/imageStorage.ts`](../../../../server/src/services/imageStorage.ts)
> and [`server/sql/image_assets_retention.sql`](../../../../server/sql/image_assets_retention.sql).

## 32.1 What this section is (and what it is not)

This is the **storage plane** for Autopilot: where every byte a venture produces or consumes
lives, how it is named, served, isolated per tenant, retained, backed up, quota'd, and
migrated when a venture moves from managed to bring-your-own (BYO) hosting. Section 26 gave
the *relational* schema (tables, columns, RLS); this section governs **what does and does
not belong in those tables**, and where the rest goes.

The single organizing decision — inherited verbatim from
[`06-DATA-MODEL.md`](../../06-DATA-MODEL.md) and §26 — is a **tiered model**:

> **Small + queryable → Postgres. Large + binary → object storage, by reference.**

We do not invent a new storage system. The studio already runs a working object-storage
pipeline today (`imageStorage.ts` → Supabase Storage, compressed WebP, metadata row +
lifecycle cron); Autopilot **reuses its patterns** (compress-on-write, reference row, RLS
owner isolation, reference-counted retention) and extends them to a second object tier —
**Cloudflare R2** — for code artifacts, version spill, build logs, and user-app assets where
free egress and the edge matter.

Three honesty rules, matching the rest of the spec:

1. **Mark shipped vs planned.** The image pipeline (Supabase Storage, WebP, retention cron)
   is **SHIPPED TODAY**. R2 (artifacts/spill/logs), the autopilot quota system, and the
   managed→BYO migration are **PLANNED** (A1/A5). We say so each time it matters.
2. **Extend, don't replace.** No table from §26 changes shape here. R2 references are stored
   as columns/jsonb that already exist (`studio_files.content` can hold a ref sentinel;
   `studio_versions.files` is `jsonb` that holds inline content *or* a ref). The image
   pipeline is consumed, not rebuilt.
3. **Tenant isolation is a storage property, not just a database one.** Every stored object
   carries the owning `user_id` in its key prefix; signed-URL TTLs are short; no bucket is
   world-listable. RLS on the *reference* row is the access-control authority; the object key
   is never a capability on its own.

---

## 32.2 The five classes of stored data

Autopilot stores five distinct kinds of bytes, with different size, access, sensitivity, and
durability profiles. Putting them in one tier would be wrong on at least one axis each.

| # | Class | Example | Size | Tier | Status |
|---|---|---|---|---|---|
| 1 | **Project source files** | `/src/App.tsx`, `package.json` | KB each, MB/project | Postgres `studio_files` (small) → R2 spill (large) | files SHIPPED; spill PLANNED |
| 2 | **Version snapshots** | "build ✓" history for diff/restore | KB–MB/version | `studio_versions.files` jsonb (inline) → R2 (large) | inline SHIPPED; spill PLANNED |
| 3 | **Generated-image assets** | AI-generated images in the comic studio | 100s KB WebP | **Supabase Storage** (`comic-assets`) | **SHIPPED** |
| 4 | **User uploads / app assets** | logos, files uploaded *into* a built app | KB–GB | R2 (per-venture prefix) | PLANNED (A1/A6) |
| 5 | **Build artifacts & logs** | bundles, dist/, `npm i` + build logs | MB–100s MB | R2 (`autopilot-artifacts`) | PLANNED (A5) |

The decision tree for any new byte:

```
 Is it small (≤ ~256 KB) AND text AND queried/diffed?
   yes → Postgres (studio_files / studio_versions jsonb)
   no  → object storage, store only a REFERENCE row in Postgres
          ├─ is it an end-user-facing IMAGE in the comic studio?  → Supabase Storage (SHIPPED pipeline)
          └─ everything else (code spill, app uploads, artifacts, logs) → Cloudflare R2
```

**Why two object tiers (Supabase Storage *and* R2), honestly.** Supabase Storage already
holds the shipped image pipeline and is tightly coupled to the `comic-assets` retention SQL;
ripping it out buys nothing. R2 is added for the *new* classes (4, 5, spill) because
[§23.5.1](./23-cloudflare-topology.md) puts Workers/Workflows at the edge, R2 is
**egress-free to Workers** and to the public CDN, and these objects are read by the build
pipeline and by deployed apps — exactly where free egress and edge locality pay off. The two
tiers are not a permanent split: §32.11 notes that the image pipeline *could* migrate to R2
later behind the same reference-row interface, but that is not in scope and not claimed.

---

## 32.3 Project files — `studio_files` (small) with R2 spill (large)

**Shipped baseline.** Per [`06-DATA-MODEL.md`](../../06-DATA-MODEL.md), the durable file tree
lives in `studio_files` — one row per file, PK `(project_id, path)`, `content text`. This is
cheap, queryable, diffable, and survives container eviction (containers are disposable; the
project is durable). RLS flows through the parent `studio_projects` (owner-isolated).

**The spill problem.** A single Postgres row should not hold a 5 MB minified vendor bundle, a
committed binary, or a generated `package-lock.json` the size of a small novel. Postgres `text`
will *accept* it, but it bloats the table, slows the per-write version snapshot, and burns the
F2 versioned-upsert transaction. So we add a **size threshold** (`[design]` ~256 KB per file,
tunable): above it, the content goes to R2 and the row holds a **reference sentinel** instead
of inline text.

We do **not** add a column (Rule 2 — no schema change). The reference is encoded in the
existing `content` field with an unambiguous sentinel the file-repository understands:

```
 studio_files.content  =  "@r2:proj/<projectId>/files/<sha256>"     // large file → R2 object
                       |  "<actual source text>"                     // small file → inline (today's path)
```

- The sentinel is content-addressed (`sha256` of the bytes), so identical large files
  **deduplicate** within a project and a re-save of unchanged bytes is a no-op write.
- The file repository (`server/src/services/studioFiles.ts`, extended) resolves the sentinel
  on read (fetch from R2) and chooses the tier on write (inline vs spill) by byte length —
  callers (the build loop, the editor) see a uniform `{path, content}` API and never know
  which tier served them.
- RLS is unchanged: the **reference row** in `studio_files` is still owner-isolated through
  `studio_projects`; the R2 object key is *not itself* an access grant (§32.7).

**Why a sentinel and not a join table.** The studio file API is hot and per-path; a sentinel
in the existing column keeps reads to a single `(project_id, path)` lookup and avoids a second
table + join on the write path. This mirrors the project's existing "lean model" stance
(jsonb deps over join tables in §26).

---

## 32.4 Version snapshots — jsonb inline vs R2 spill

**Shipped baseline.** Each successful agent build writes a `studio_versions` row whose
`files jsonb` is a `{path: content}` map — the immutable snapshot that powers diff and restore
(§06-DATA-MODEL lifecycle). For a normal app (tens of small files) this is a few hundred KB of
jsonb: fine inline, and a single row read reconstructs the whole tree for a diff.

**The spill rule** (already foreshadowed in `06-DATA-MODEL.md` "files jsonb inline for normal
projects; spill to R2 for big ones" and §26.3 "Large blobs spill to R2 with a reference; the
column shape is unchanged"):

| Snapshot size | Storage | `files` jsonb holds |
|---|---|---|
| ≤ ~1 MB (typical app) | **inline** (SHIPPED) | the full `{path: content}` map |
| > ~1 MB, or any single file already spilled (§32.3) | **R2 spill** (PLANNED) | a manifest: `{ "@r2_snapshot": "proj/<id>/versions/<versionId>.json.gz", "size": N, "files": M }` |

- The spilled snapshot is a **single gzipped JSON object in R2** (the whole tree in one
  object → one GET to restore, one PUT to create; no per-file fan-out). Gzip on a code tree is
  ~5–10× — cheap to store, cheap to move.
- The `files jsonb` column shape **does not change**: it holds either the inline map or the
  one-key manifest. The version repository branches on the `@r2_snapshot` key. This is the
  same discipline as §32.3: extend the value, not the schema.
- A version is **immutable** once written (history/diff/restore depend on it), so a spilled
  snapshot object is write-once and content-stable — which makes it a clean candidate for R2's
  object lifecycle (§32.6) and never needs an in-place update.
- **Restore** = fetch the inline map or the spill object, then write each file via the §32.3
  tiering rules (re-spilling large files as it goes), bump `studio_projects.version`, and
  point `current_version_id` at the restored snapshot.

This keeps the *common* case (small app) on the fast inline path it already uses today, and
only pays the R2 round-trip for the genuinely large project where Postgres would have hurt.

---

## 32.5 User uploads & assets inside generated apps

A built venture is a real app, so its **end users upload things** — a logo, a CSV, a profile
photo, a document — and the app's own build may produce **static assets** (an `public/` tree,
generated images). These are not the venture's *source code*; they are runtime data of the
deployed product. They go to **R2** under a per-venture prefix, never to Postgres.

| Sub-class | Where | Notes |
|---|---|---|
| **App build assets** (`public/`, bundled images) | R2 `proj/<projectId>/assets/…`; served via CDN or copied to the deploy target | produced at SHIP; immutable per deploy |
| **End-user uploads** (managed hosting) | R2 `venture/<ventureId>/uploads/<userScope>/…` | written via a signed, size-capped upload URL the app requests through the API |
| **End-user uploads** (BYO hosting) | the **user's own** provider storage (their R2/Supabase bucket), provisioned by the A5 adapter | once BYO, the venture's runtime data lives in the *owner's* account, not ours (§32.10) |

Design rules for app uploads:

- **Direct-to-R2, presigned, capped.** The built app requests a presigned `PUT` from the
  Autopilot API (which checks the app's auth + per-venture quota), uploads directly to R2
  (no proxy through our Workers), and the API records a reference row. Same shape as the
  image pipeline's "upload then register metadata," just on R2 and for arbitrary content.
- **Content-type allowlist + virus/secret scan hook** on register (ties to F8 input
  hardening; the A4/A9 danger-scan path is reused for uploaded code-like content).
- **Reference-counted retention** (§32.8): an upload with no live reference from the app's
  data becomes a retention candidate, exactly as `image_assets` does today.

This class is **PLANNED** (lands with A1's data plane and A6's app-runtime needs); the comic
studio's user-image uploads run *today* through the shipped Supabase Storage pipeline (source
`'upload'` in `imageStorage.ts`), which is the existence proof of the pattern.

---

## 32.6 The shipped image pipeline — SHIPPED, marked

The existing image-asset pipeline is the **reference implementation** every other tier copies.
It is real today; we describe it so the rest of the section can say "like that, but on R2."

**Path:** [`server/src/services/imageStorage.ts`](../../../../server/src/services/imageStorage.ts)
→ Supabase Storage bucket `comic-assets` (`STORAGE_BUCKET`, default `'comic-assets'`,
[`server/src/config.ts:190`](../../../../server/src/config.ts)).

**What it does (verified from the code):**

| Step | Behavior | Why it is the template |
|---|---|---|
| **Compress on write** | decode data-URL → optional center-crop to ratio → **WebP** at quality `82/78/74` for `1K/2K/4K`, `effort: 4` (`sharp`) | every tier compresses before store; bytes are never stored raw |
| **Deterministic, tenant-scoped key** | `u/<userId>/p/<projectId>/img/<imageId>.webp`, or `u/<userId>/tmp/<imageId>.webp` when no real project UUID | the **per-tenant key prefix** model §32.7 generalizes |
| **Reference row** | insert `image_assets` (id, user_id, project_id, bucket, path, bytes, w/h, source, `created_at`, `last_referenced_at`, `expires_at`, `deleted_at`) | the **reference-row-is-the-authority** pattern §32.1 rule 3 |
| **Atomicity** | on metadata-insert failure, the just-uploaded object is removed (compensating delete) | object and reference never drift |
| **Long cache** | `cacheControl: '31536000'` (1 year) + public URL | immutable assets → aggressive CDN cache (§32.7) |

**Retention** ([`server/sql/image_assets_retention.sql`](../../../../server/sql/image_assets_retention.sql)),
also SHIPPED and the template for §32.8:

- `collect_active_image_paths()` — walks `projects.state` + `artifacts.data` to find every
  image id **still referenced** (cover, panels, history, characters/items/locations + their
  reference images, style variants, tags, artifact in/out). This is the **reference counter**.
- `refresh_image_asset_references(30, 15)` — re-touches `last_referenced_at` for live assets;
  marks **unreferenced + stale ≥ 30 days** with `expires_at = now() + 15-day grace`.
- `purge_expired_image_assets()` — deletes the `storage.objects` row **and** soft-deletes the
  metadata (`deleted_at`) once `expires_at` passes.
- `run_image_asset_retention()` on a **daily `pg_cron`** schedule (`15 3 * * *`).

Autopilot inherits this exact shape for R2 (§32.8): reference-walk → stale-mark with grace →
purge object + soft-delete row, on a schedule.

---

## 32.7 R2 bucket layout, naming & serving

**Binding (from [§23.6](./23-cloudflare-topology.md)):** `r2_buckets: [{ binding: "ARTIFACTS",
bucket_name: "autopilot-artifacts" }]`. We use a **small number of buckets by lifecycle
profile**, with the *tenant* expressed in the **key prefix**, not in the bucket name — so we
never provision a bucket per user (which does not scale and complicates lifecycle rules).

| Bucket | Holds | Lifecycle profile | Public? |
|---|---|---|---|
| `autopilot-artifacts` | code-file spill, version-snapshot spill, build artifacts, build logs | mostly write-once, age-tiered; logs short-TTL | **No** — private; served only via signed URL or copied to deploy |
| `autopilot-app-assets` | end-user uploads + app static assets for **managed** ventures | reference-counted (§32.8) | static assets via CDN; uploads private/signed |

**Key naming** — tenant-prefixed, content/entity-addressed, mirrors the image pipeline:

```
 # code & versions (private)
 proj/<projectId>/files/<sha256>                      # spilled large file (content-addressed → dedup)
 proj/<projectId>/versions/<versionId>.json.gz        # spilled snapshot (immutable, one object/version)
 proj/<projectId>/artifacts/<deployId>/<bundle>       # build output for a deploy
 proj/<projectId>/logs/<runId>/<step>.log             # build/run logs (short-TTL)

 # app runtime data
 venture/<ventureId>/uploads/<appUserHash>/<assetId>  # end-user upload into a managed app
 venture/<ventureId>/assets/<sha256>                  # app static asset
```

**Naming rules** `[design]`:
- **Tenant prefix first** (`proj/<projectId>/…`, `venture/<ventureId>/…`). The owning
  `user_id` is recoverable through the project/venture and is also written into the R2 object's
  **custom metadata** (`x-amz-meta-owner`) so an object is self-describing for audit. This is
  the R2 analogue of `imageStorage.ts`'s `u/<userId>/p/<projectId>/…`.
- **Content-addressed where immutable** (`<sha256>`) → dedup + idempotent re-write (a Workflow
  step that replays writes the same key — §23.3.3 idempotency, satisfied by construction).
- **Entity-addressed where versioned** (`<versionId>`, `<deployId>`, `<runId>`) → one object
  per logical thing, never overwritten.
- Keys are sanitized (`[^a-zA-Z0-9_/-] → -`), exactly as `sanitizeSegment` does today.

**R2 object lifecycle (bucket-level rules, `[design]`):**

| Prefix | Lifecycle rule | Rationale |
|---|---|---|
| `…/logs/…` | expire **7 days** | logs are debug-tier; the durable audit fact is in `venture_events` |
| `…/artifacts/…` (non-current deploy) | transition to **R2 Infrequent Access** after 30 days; expire after 180 | only the live deploy's bundle is hot |
| `…/versions/…` | keep while the version is retained (§32.8); IA after 90 days | history is read rarely but must survive |
| `…/files/<sha256>` | reference-counted purge (§32.8), not time-based | a file is live as long as a version references it |
| abandoned multipart uploads | abort after 7 days | never pay for half-finished uploads |

**Serving & signed URLs:**

- **Private objects (code spill, snapshots, logs, uploads):** served only via **short-TTL
  presigned URLs** (`[design]` GET ~5 min, PUT ~15 min) minted by the API *after* it checks the
  reference row's RLS-equivalent ownership in code. The object key alone is **never** a
  capability — guessing a key gets a 403 because the bucket is not public-list and reads go
  through the signing endpoint (§32.7 isolation).
- **Public app static assets:** served from R2 behind the **Cloudflare CDN** with a long
  `cacheControl` (immutable, content-addressed → safe to cache forever, like the image
  pipeline's 1-year header). A custom domain / public bucket binding fronts only the
  `…/assets/…` prefix, never the private prefixes.
- **Workers read R2 with zero egress** ([§23.5.1](./23-cloudflare-topology.md)): the build
  pipeline (Workflow `write`/`ship` steps) and the preview path read spill/artifacts directly
  via the binding, no signed URL needed — signed URLs are for *clients*.

---

## 32.8 Retention policies (extending `image_assets_retention`)

Autopilot generalizes the shipped image-retention machine (§32.6) to every reference-counted
object class. The shape is identical — **reference-walk → stale-mark with grace → purge object
+ soft-delete row, on a daily schedule** — so the on-call story and the SQL idioms are the same
ones already running in production.

| Class | Reference source (the "is it live?" walk) | Stale window | Grace | Hard floor |
|---|---|---|---|---|
| Image assets (SHIPPED) | `collect_active_image_paths()` over `projects`/`artifacts` | 30 d unreferenced | 15 d | — |
| Code-file spill (`proj/.../files`) | referenced by any **retained** `studio_versions` snapshot OR current `studio_files` | n/a (ref-counted) | 7 d after last ref drops | live while any version refs it |
| Version snapshots | retained per §32.8 venture-life rule | per venture | — | newest N + tagged versions kept |
| Build logs | none (debug) | n/a | n/a | **7 d TTL** (R2 lifecycle), `venture_events` keeps the fact |
| Build artifacts (non-current) | superseded by a newer deploy | 30 d | — | current deploy's bundle pinned |
| App uploads (managed) | referenced by the app's data / a `studio_app_assets` ref row | 30 d | 15 d | (mirrors `image_assets` exactly) |

**The reference-counted purge for code spill** (`[design]`, new SQL in
`server/sql/r2_artifact_retention.sql`, following the `image_assets_retention.sql` style —
`security definer`, idempotent, daily `pg_cron`):

```
 1. collect_referenced_r2_keys()  -- union of:
       studio_files.content sentinels  (@r2:…)
       studio_versions.files manifests (@r2_snapshot:…)  for RETAINED versions
       studio_deployments current-bundle keys
 2. mark spill rows whose key ∉ referenced  AND  last_referenced_at ≤ now()-window
       → set expires_at = now() + grace
 3. purge:  delete the R2 object (binding/S3 API) + soft-delete the ref row (deleted_at)
```

**Version-retention rule (`[design]`):** keep **all versions for the life of the venture by
default** (history is the product), but allow a per-venture cap — *keep the newest N + every
user-tagged/"before deploy"/shipped version, prune the rest after 90 days* — so an extremely
chatty venture (hundreds of micro-builds) does not accrue unbounded snapshot spill. Pruning a
version soft-deletes its row and lets §32.8 step 1 drop now-unreferenced `files/<sha256>`
objects.

**Cost model (R2, `[verified 2026-06]` pricing; volumes `[design]`):**

| Line | Rate | Illustrative monthly @ 1,000 active ventures |
|---|---|---|
| Storage | **$0.015 / GB-mo** | 1,000 × ~200 MB spill/artifacts ≈ 200 GB → **~$3.00** |
| Class A ops (writes) | $4.50 / million | builds + uploads, ~5 M/mo → **~$22.50** |
| Class B ops (reads) | $0.36 / million | serves + pipeline reads, ~20 M/mo → **~$7.20** |
| **Egress** | **$0.00** | the reason we chose R2 for served/edge objects |
| IA tier (cold artifacts) | $0.01 / GB-mo + per-GB retrieval | shaves storage on aged bundles |

The headline is **free egress**: the classes that get *served* (app assets, downloads,
pipeline reads from Workers) cost nothing to move, which is precisely why these went to R2 and
not to a tier that bills per-GB out. Storage itself is a rounding error vs LLM + container
cost (the §23.8.2 stance). Daily retention keeps the storage line from drifting up over time.

---

## 32.9 Per-tenant isolation of stored objects

Storage isolation is a **defense-in-depth stack**, not a single check — matching the §25 "secure
by construction" posture. A cross-tenant read of a stored object would be as severe as a
cross-tenant DB read, so every layer below must hold independently.

| Layer | Control | Inherited from |
|---|---|---|
| **Reference row** | the `studio_files`/`studio_versions`/`*_assets` row is **RLS owner-isolated**; you cannot even learn an object exists without owning its row | §26 RLS; `image_assets_select_own` today |
| **Key prefix** | every object key leads with the owning `proj/<projectId>` or `venture/<ventureId>` / `u/<userId>`; objects carry `x-amz-meta-owner` | `imageStorage.ts` `u/<userId>/…` |
| **No world-list** | private buckets are not publicly listable; there is no "list all objects" client path — listing is server-side, owner-scoped | R2 private by default |
| **Signed-URL gate** | a presigned URL is minted **only after** the API re-checks ownership in code (service-role write, owner check before sign); TTL is minutes | image-pipeline "register then serve" |
| **Service-identity scoping** | the worker writes via service role (bypasses RLS) but **always scopes by `user_id`/`venture_id` in code** — no unscoped object reads | §26.14 service-identity rule |
| **Sandbox boundary** | generated code reads/writes objects only via the per-`(user,project)` sandbox + the API; it never holds raw bucket creds | §23.4.5 sandbox isolation |

The load-bearing rule, restated: **the object key is not a capability.** Possessing a key
yields nothing without a signed URL, and a signed URL is only issued after an owner check on
the reference row. This is the storage analogue of "RLS is the tenant boundary" — proven by the
A9 isolation audit, which must include an automated "user A cannot fetch user B's object"
test alongside the DB-isolation test (§26.14).

---

## 32.10 Backup, durability & quotas

**Durability of the record (reference rows):** all reference rows live in Supabase Postgres,
covered by **Supabase PITR** (point-in-time recovery) along with every other table (§26.14,
DR detail in §42). Losing a reference row would orphan an object, not lose data; the retention
walk treats an object with no referencing row as garbage and reclaims it.

**Durability of the bytes:**
- **Supabase Storage** (image pipeline) — durable object store, backed up with the project.
- **R2** — **11 nines** object durability `[verified 2026-06]`, multi-region replicated by
  Cloudflare. Immutable, content-addressed objects (`<sha256>`) are inherently
  re-derivable/verifiable; a corrupted object fails its hash check on read and is re-fetched
  or re-generated from the source-of-truth (the version snapshot can rebuild a file tree).
- **Cross-store backup `[design]`:** the *append-only, hard-to-regenerate* classes —
  long-retained version snapshots and `audit_log`/`venture_events` cold archives (§26.14) —
  are the priority for a periodic **R2 cross-account/bucket copy** so a single-account
  compromise cannot erase history. Logs and regenerable artifacts are **not** backed up
  (re-running a build regenerates them) — we back up what we cannot recreate.

**Quotas** (PLANNED, A1; ties to billing §41 and budgets §26.5):

| Quota | Default tier `[design]` | Enforced where |
|---|---|---|
| Storage per venture | e.g. 5 GB (free) / 50 GB (paid) of R2 spill+assets | checked at presign + at SHIP; over-quota → checkpoint/upgrade prompt |
| Single-upload size | e.g. 100 MB | presigned-PUT content-length cap (hard) |
| Uploads/day per app | rate-limited per venture | API rate-limit on the presign endpoint |
| Versions retained | newest N + tagged (§32.8) | retention job |
| Image assets | existing per-user behavior | existing pipeline |

Quota counters are maintained from the **reference rows** (sum `bytes` per venture), not by
scanning R2 — the row is already the metadata authority, so quota is a cheap aggregate query.
A venture approaching its storage cap raises a soft alert (A7 notification) before it hard-fails
a write, mirroring the budget 80%-alert pattern (§26.5).

---

## 32.11 Migrating artifacts when a venture moves managed → BYO

When an owner connects their own cloud (Cloudflare/Vercel/Railway/Supabase via
`venture_connections`, Epic A5) and a venture flips from **managed** to **BYO** hosting, the
venture's *runtime artifacts and data* must move from **our** storage to the **owner's** —
because BYO means "your app runs entirely in your account." Source code never had this problem
(it lives in Supabase Postgres / the user's GitHub, both already owner-data); the migration is
about classes 4 and 5 (uploads + artifacts) and any served assets.

**What moves vs what stays:**

| Class | Managed (ours) | After BYO migration |
|---|---|---|
| Source files / versions | Supabase Postgres (ours, owner-isolated) | **stays** — code is portable, pushed to the owner's GitHub by the adapter |
| Build artifacts / bundles | R2 `autopilot-artifacts` (ours) | **rebuilt** in the owner's account by the BYO adapter's deploy (re-derivable; no copy needed) |
| App static assets | R2 `autopilot-app-assets` (ours) | **copied** to the owner's bucket (Cloudflare R2 / Supabase Storage), then served from theirs |
| End-user uploads | R2 `venture/<ventureId>/uploads/…` (ours) | **copied** to the owner's bucket; new uploads write directly to theirs |

**Migration procedure (`[design]`, runs as an A5 adapter step, durable Workflow):**

```
 1. Provision     adapter (supabaseProvision.ts / cloudflare adapter) ensures the owner's
                  bucket exists, via venture_connections (Nango ref — no raw secrets held).
 2. Copy assets   stream each ours-R2 object → owner bucket, preserving key suffix + content
                  type + cache header; verify by sha256 (content-addressed → trivial integrity check).
 3. Rewrite refs  update reference rows to point at the owner's bucket (a "bucket" + "owner"
                  field on the ref / sentinel); the app's asset URLs now resolve to the owner's CDN.
 4. Cut over      flip the deploy adapter; new writes go to the owner's bucket; build re-runs
                  there so artifacts are regenerated natively.
 5. Verify + grace keep OUR copies for a grace window (e.g. 30 d), verify the BYO app serves
                  correctly, then retention reclaims our copies. Audited in venture_events.
```

**Properties this migration must have:**
- **Idempotent + resumable.** It is a Workflow (§23.3): each object copy is a `step.do`,
  content-addressed so a replay re-copies safely; a crash resumes mid-copy. A half-done
  migration never corrupts either side.
- **No data loss across the cut.** Refs are rewritten only after a verified copy; our copy is
  kept through a grace window before reclaim — the same "copy, verify, then delete" discipline
  the image pipeline uses for its compensating delete.
- **Checkpoint-gated + audited.** Moving a user's data is a sensitive action; it runs under the
  same approval/audit posture as the production-deploy checkpoint and writes `venture_events`
  for the whole sequence. **Secrets stay in Nango** — the adapter uses a per-venture, revocable
  connection reference, never a stored credential (§26.10).
- **Reversible.** Because our copy survives the grace window, a failed BYO cutover rolls back
  to managed serving by flipping refs back — no irreversible step until grace expires.

---

## 32.12 Mapping to the plan (A1 / A5 / F6)

| Epic | What this section commits to |
|---|---|
| **A1 — control plane (data plane)** | the tiered model on the `studio_*` tables (file/version spill via sentinel + manifest, no schema change); per-venture R2 prefixes; quota counters from reference rows; reference-counted retention generalized from the image pipeline. Migrations are *additive*, applied via the F6 runner. |
| **A5 — deploy adapters (managed + BYO)** | build artifacts + app assets in R2; the **managed→BYO artifact migration** (§32.11) as an adapter step using `venture_connections` (Nango ref, no raw secrets); BYO runtime data lands in the owner's bucket. |
| **F6 — migrations & data-store discipline** | every storage table/policy ships through the ordered Supabase migration runner (§26.13); the new `r2_artifact_retention.sql` follows the shipped `image_assets_retention.sql` idioms (security-definer, idempotent, `pg_cron`); RLS coverage on every reference table is gated in CI. |

Adjacent: this section consumes the **R2 binding** from [§23.6](./23-cloudflare-topology.md),
realizes the **storage isolation** layer of [§25](./25-multitenancy-isolation.md), and stores
**only references** for the secrets-free posture of [§26](./26-data-model-schema.md) (no
credential ever lives in a stored object — BYO creds live in Nango).

---

## 32.13 Acceptance criteria

- A tiered model is specified for **all five data classes** with an explicit
  small→Postgres / large→object-storage decision rule, each tagged **shipped** or **planned**.
- **Project files** use `studio_files` inline today and spill large files to R2 via a
  content-addressed **sentinel in the existing `content` column** — no schema change.
- **Version snapshots** stay inline jsonb for normal projects and spill to a **single gzipped
  R2 object** via a one-key manifest for large ones — `files jsonb` shape unchanged.
- **User uploads / app assets** are specified on R2 under a per-venture prefix via presigned,
  size-capped, scanned uploads with reference-counted retention.
- The **shipped image pipeline** (`imageStorage.ts` → Supabase Storage, compressed WebP,
  metadata row, compensating delete, daily retention cron) is described accurately and marked
  **SHIPPED**, and is named as the template the R2 tiers copy.
- An **R2 bucket layout + naming scheme** (tenant-prefixed, content/entity-addressed) +
  **object-lifecycle rules** + **CDN/serving with short-TTL signed URLs** is specified, with
  the object-key-is-not-a-capability rule stated.
- **Per-tenant isolation** is a defense-in-depth stack (RLS reference row, key prefix, no
  world-list, signed-URL gate, service-identity scoping, sandbox boundary) tied to the A9 audit.
- **Retention** extends the `image_assets_retention` machine (reference-walk → stale-mark +
  grace → purge object + soft-delete, daily `pg_cron`) to every reference-counted class, with a
  concrete **R2 cost model** (free egress called out).
- **Backup/durability** (Postgres PITR for refs, R2 11-nines for bytes, cross-account copy for
  the un-regenerable classes) and **quotas** (per-venture storage, upload size/rate, version cap)
  are specified.
- The **managed→BYO artifact migration** is specified as an idempotent, resumable,
  checkpoint-gated, reversible Workflow that copies assets to the owner's bucket, rewrites refs,
  cuts over, and reclaims after a grace window — secrets staying in Nango.
- The section **maps to A1 / A5 / F6** and changes **no other file**.
