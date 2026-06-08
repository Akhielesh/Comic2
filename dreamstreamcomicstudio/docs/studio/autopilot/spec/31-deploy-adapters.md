# 31 — Deploy Adapters (Managed + BYO)

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (§6 hosting & adapters, Epic A5; §5 security; §8
> checkpoints) · [Cloudflare Topology](./23-cloudflare-topology.md) (§23.3 Workflows `ship`
> step, §23.4 Containers) · [UX: Integrations & Connections](./18-ux-integrations.md)
> (the connect flow + deploy-target picker that drive this layer) ·
> [Data Model & Schema](./26-data-model-schema.md) (`studio_deployments`, `venture_connections`) ·
> [Integrations Framework](./30-integrations-framework.md) (Nango/MCP plumbing this consumes)

## 31.1 Scope & stance

This section specs the **SHIP tier**: the provider-agnostic contract by which Autopilot turns
a verified build into a live URL, the concrete adapters behind that contract, the pipeline
that drives them, and the security rules that make holding users' cloud credentials
survivable. It is the engineering answer to **Epic A5** of the [Master Plan](../00-MASTER-PLAN.md);
[§18](./18-ux-integrations.md) already specced the *UX* (connect flow, deploy-target picker,
disconnect) and [§30](./30-integrations-framework.md) the *connection plumbing* (Nango,
MCP, webhooks). This file is where the loop's `SHIP` step actually ships.

**House rules for this section.** We mark **shipped** vs **planned** honestly, and we do not
overstate. The honest baseline:

| Capability | Status today | Where |
|---|---|---|
| Container preview URLs (`<port>-<id>-<token>.dreamstreamstudio.ai`) | **shipped** (the managed substrate) | `studio-worker/src/index.ts` (`exposePort`/`proxyToSandbox`) |
| GitHub two-way sync (push tree / pull tree, atomic commit) | **shipped** | `server/src/services/studioGithub.ts`, `routes/studioGithub.ts` |
| Nango connect-session + proxy meta-tools (the credential broker for BYO) | **shipped** (agent-side) | `server/src/ai/tools/nango.ts` |
| `studio_deployments` table (deploy history) | **shipped** (schema) | `server/sql/`, [§26](./26-data-model-schema.md) |
| **`DeployAdapter` interface + registry** | **planned (A5)** | `server/src/ventures/adapters/` |
| **managed-preview / cloudflare-pages / -workers / vercel / railway / supabase-provision adapters** | **planned (A5)** | this section |
| **SHIP step wired to adapters; prod-checkpoint gate; `ventures.deploy_url`** | **planned (A5)** | `server/src/ventures/tick.ts` / Workflow `ship` step |
| **Per-venture `venture_connections` (Nango ref + scopes)** | **planned (A1)** | [§18.2](./18-ux-integrations.md), [§26](./26-data-model-schema.md) |

**The single design idea.** One narrow `DeployAdapter` contract makes the loop
provider-agnostic: the loop knows "build → ship → URL," never "talk to the Cloudflare API."
That is what lets the **hybrid hosting model** ([Master Plan §6](../00-MASTER-PLAN.md)) —
managed for speed, BYO for production — be a *registry lookup*, not a branch in the engine.
The container preview substrate and the credential broker (Nango) and GitHub sync are
already shipped; A5 is mostly *wrapping shipped infrastructure behind a uniform contract* and
recording the result, not building cloud integrations from scratch.

## 31.2 The `DeployAdapter` interface

A deploy adapter is a pluggable `provision?()` / `deploy()` / `status()` / `rollback?()`
implementation for exactly one provider. The contract is deliberately small — five members,
two optional — because a fat interface would leak provider specifics into the loop and make
every new provider a large surface. The interface lives at
`server/src/ventures/adapters/types.ts` and refines the sketch in
[Master Plan §6](../00-MASTER-PLAN.md):

```ts
// server/src/ventures/adapters/types.ts  [design — A5]
export type AdapterId =
  | 'managed-preview'
  | 'cloudflare-pages'
  | 'cloudflare-workers'
  | 'vercel'
  | 'railway'
  | 'supabase-provision';

export type DeployEnv = 'preview' | 'production';

/** Everything an adapter needs, with NO raw secret in it (credentials resolve via Nango). */
export interface VentureCtx {
  ventureId: string;
  userId: string;                       // for RLS-scoped writes; never trusted from client
  projectId: string;                    // the studio_project this venture builds
  env: DeployEnv;                       // preview | production (gates checkpoints)
  /** Resolved at call time from venture_connections; a HANDLE, not a token. */
  connection?: ConnectionRef;           // absent ⇒ managed-preview only
  /** Optional desired hostname for custom-domain go-live (production only). */
  customDomain?: string;
  /** Idempotency key = workflowInstanceId + version (§31.4.3). */
  idempotencyKey: string;
  logger: ScopedLogger;                 // redacting logger — never accepts a credential value
}

/** A reference to a stored credential — resolved through Nango, never a secret in our DB. */
export interface ConnectionRef {
  nangoConnectionId: string;            // Nango connection_id
  providerConfigKey: string;            // Nango provider_config_key (e.g. 'cloudflare')
  scopes: string[];                     // granted scopes (for pre-flight scope checks)
  accountLabel?: string;                // display only, e.g. 'acme-team@cloudflare.com'
}

export interface BuildArtifact {
  kind: 'static' | 'spa' | 'worker' | 'node-server';
  versionId: string;                    // → studio_versions.id (what we are shipping)
  /** R2 key of the built bundle/dir tarball (pointer, not blob — §23.3.2). */
  artifactKey: string;
  entry?: string;                       // e.g. 'dist/_worker.js' for workers
  buildCommand?: string;                // recorded for reproducibility
  outputDir?: string;                   // e.g. 'dist'
  envVars?: Record<string, string>;     // non-secret build/runtime vars only
}

export interface ProvisionResult {
  resources: ProvisionedResource[];     // e.g. a Supabase project: db url, anon key ref…
  /** New connection references created during provisioning (e.g. project-scoped keys). */
  connections?: ConnectionRef[];
}

export interface ProvisionedResource {
  type: 'database' | 'auth' | 'storage' | 'kv' | 'project';
  id: string;                           // provider resource id
  /** Non-secret coordinates (urls, public keys). Secrets go to Nango, not here. */
  coords: Record<string, string>;
}

export type DeployStatus =
  | 'queued' | 'building' | 'deploying' | 'live' | 'failed' | 'rolled-back';

export interface DeployResult {
  deploymentId: string;                 // provider deployment id (stable, for status/rollback)
  status: DeployStatus;
  url?: string;                         // public URL when live
  /** True when the result was returned from the idempotency cache, not a fresh deploy. */
  reused?: boolean;
  logsRef?: string;                     // R2 key of build logs (pointer, never inline blob)
  error?: { code: string; message: string };  // redacted; never echoes a token
}

export interface DeployAdapter {
  readonly id: AdapterId;
  readonly supports: { provision: boolean; rollback: boolean; customDomain: boolean };
  /** Optional: stand up backing resources (DB/auth/storage) before first deploy. */
  provision?(ctx: VentureCtx): Promise<ProvisionResult>;
  /** Required: ship a built artifact; returns a URL + status. Must be idempotent. */
  deploy(ctx: VentureCtx, build: BuildArtifact): Promise<DeployResult>;
  /** Required: read current status of a prior deployment (drives health + UI). */
  status(ctx: VentureCtx, deploymentId: string): Promise<DeployResult>;
  /** Optional: roll back to a prior versioned deployment. */
  rollback?(ctx: VentureCtx, deploymentId: string): Promise<void>;
  /** Pre-flight: does the connection have the scopes this adapter needs? (least-privilege) */
  requiredScopes(env: DeployEnv): string[];
}
```

**Why these and only these.**

| Member | Why it exists | Why it is (or isn't) optional |
|---|---|---|
| `id` / `supports` | Registry key + capability flags so the loop can ask "can this adapter roll back?" without try/catch. | Required; `supports` lets the UI grey out unavailable actions. |
| `provision?` | Some targets need backing infra (a DB, auth, storage) *before* a first deploy; most do not. | **Optional** — only `supabase-provision` (and Railway, for a managed DB) implement it. |
| `deploy` | The one universal verb: build artifact → URL. | **Required** — an adapter that can't deploy isn't a deploy adapter. |
| `status` | Health verification (§31.6) and the Operator Console deployments panel poll this. | **Required** — feeds A6 and the UI; without it a deploy is fire-and-forget. |
| `rollback?` | Versioned providers (CF/Vercel) support instant rollback; managed preview is ephemeral, nothing to roll back to. | **Optional** — declared via `supports.rollback`. |
| `requiredScopes` | Lets the deploy-target picker ([§18.6](./18-ux-integrations.md)) show "Reconnect — missing scope" *before* a deploy fails opaquely. | Required; returns `[]` for managed-preview. |

**No secret ever crosses this interface.** `VentureCtx.connection` is a `ConnectionRef`
(Nango ids + granted scopes), never a token. Each adapter, internally, asks the credential
broker ([§30](./30-integrations-framework.md), `nango.ts` proxy) to make authenticated calls
*on its behalf* — the adapter sends the request, Nango injects the credential server-side, and
the raw token never enters the adapter's address space, our DB, or any log line (§31.7).

## 31.3 The adapter registry

A tiny registry maps `AdapterId → DeployAdapter`. The loop never instantiates a provider; it
asks the registry for the adapter the deploy-target picker selected (stored on the venture /
`venture_connections`), defaulting to `managed-preview`.

```ts
// server/src/ventures/adapters/registry.ts  [design — A5]
import { managedPreview } from './managedPreview';
import { cloudflarePages } from './cloudflarePages';
import { cloudflareWorkers } from './cloudflareWorkers';
import { vercel } from './vercel';
import { railway } from './railway';
import { supabaseProvision } from './supabaseProvision';

const REGISTRY: Record<AdapterId, DeployAdapter> = {
  'managed-preview':    managedPreview,
  'cloudflare-pages':   cloudflarePages,
  'cloudflare-workers': cloudflareWorkers,
  'vercel':             vercel,
  'railway':            railway,
  'supabase-provision': supabaseProvision,
};

export function getAdapter(id: AdapterId): DeployAdapter {
  const a = REGISTRY[id];
  if (!a) throw new Error(`unknown deploy adapter: ${id}`);
  return a;
}

/** Pick the SHIP target: explicit selection, else managed preview for non-prod. */
export function resolveTarget(ctx: VentureCtx, selected?: AdapterId): DeployAdapter {
  if (ctx.env === 'preview' && !selected) return REGISTRY['managed-preview'];
  return getAdapter(selected ?? 'managed-preview');
}
```

- **Adding a provider is one file + one registry line** — the loop, pipeline, schema, and UI
  are untouched. This is the payoff of the narrow contract.
- **The registry is the only place that knows the set of providers.** The deploy-target
  picker ([§18.6](./18-ux-integrations.md)) renders from it; the scope pre-flight reads
  `requiredScopes`; the data model's `studio_deployments.target` is exactly an `AdapterId`.
- **Capability-driven UI.** The console reads `supports` to enable/disable Rollback and
  Custom-domain controls per row, so a managed-preview deployment never shows a dead Rollback
  button.

## 31.4 The deploy pipeline

### 31.4.1 The path from build to live URL

`SHIP` is one step of the tick (Master Plan §4.1) / one durable Workflow step
([§23.3.1](./23-cloudflare-topology.md)). The end-to-end path:

```
 VERIFY passes (typecheck/build/tests + A9 safety scan)
   │
   ▼
 BUILD ARTIFACT  ── package the verified studio_version → tarball → R2  → BuildArtifact{artifactKey}
   │                (pointer, never an inline blob — §23.3.2)
   ▼
 RESOLVE TARGET  ── registry.resolveTarget(ctx, venture.deploy_target)
   │                (managed-preview default; BYO if a connection is selected)
   ▼
 DECIDE GATE     ── env==='production' ?  → raise/await PROD checkpoint (Master Plan §8)
   │                env==='preview'     ?  → proceed (managed previews auto-ship)
   ▼
 PRE-FLIGHT      ── adapter.requiredScopes(env) ⊆ connection.scopes ?  else → Reconnect checkpoint
   │              ── (first deploy & adapter.provision) ? → adapter.provision(ctx)
   ▼
 DEPLOY          ── adapter.deploy(ctx, build)  → { deploymentId, status, url }
   │                (idempotent on ctx.idempotencyKey — §31.4.3)
   ▼
 RECORD          ── INSERT studio_deployments(venture_id, project_id, target, url, status, …)
   │              ── on live: UPDATE ventures.deploy_url = url
   ▼
 HEALTH VERIFY   ── adapter.status(...) + HTTP probe (§31.6) → venture_event; feeds A6 SENSE
   │
   ▼
 REFLECT         ── append venture_event(ship: target/url/cost/result); update goal
```

### 31.4.2 managed-auto vs prod-checkpoint-gated

The hybrid model has exactly two ship modes, distinguished only by `DeployEnv`:

| Mode | Trigger | Target | Checkpoint? | Why |
|---|---|---|---|---|
| **managed-auto** | every successful preview build | `managed-preview` | **No** | Instant "it's live" wow; we host it, so it's quota- + budget-capped, never user-facing brand. |
| **prod-checkpoint-gated** | a goal that ships to production / a custom domain | a BYO adapter (or managed if the user chose it) | **Yes — always** | First prod go-live, custom-domain, and spending real money are irreversibles ([Master Plan §8](../00-MASTER-PLAN.md)); a human approves before the user's brand goes public. |

- **Managed previews never wait for a human.** `env: 'preview'` skips the DECIDE checkpoint
  branch entirely — that is the point of managed mode.
- **Production always waits.** `env: 'production'` raises a `first_production_deploy` (or
  `publish_external` / `spend_money` for paid custom domains) checkpoint
  ([§16](./16-ux-approvals-notifications.md)). In the Cloudflare-native design
  ([§23.3.1](./23-cloudflare-topology.md)) the Workflow `ship` step parks on
  `step.waitForEvent('prod-approval')` and **costs nothing while parked**; in the A2 BullMQ
  design the run pauses and the venture goes idle until the checkpoint is resolved. Either way
  the gate lives in the **deterministic DECIDE path**, backend-agnostic by construction, so the
  Railway→Cloudflare migration never weakens it.
- **The checkpoint *arms* the target; it does not silently push.** Selecting a BYO target in
  the picker ([§18.6](./18-ux-integrations.md)) is a no-op until the human approves.

### 31.4.3 Idempotency, versioned records & metering

Because the Workflow `ship` step can replay on resume ([§23.3.3](./23-cloudflare-topology.md)),
**deploy must be safe to run more than once**:

- `ctx.idempotencyKey = workflowInstanceId + ':' + versionId`. Adapters pass it to the
  provider as the provider's own idempotency key where supported (Vercel, Cloudflare), or
  consult `studio_deployments` for an existing row with that key and return it (`reused: true`)
  rather than double-deploying.
- Every ship writes one `studio_deployments` row (extended with `venture_id`, `version_id`,
  `idempotency_key` — see §31.9 / [§26](./26-data-model-schema.md)); a replay upserts on
  `(venture_id, idempotency_key)`, so a retry never creates a duplicate deployment.
- **Cost is metered at REFLECT, keyed by step + instance** ([§23.3.3](./23-cloudflare-topology.md)),
  tagged with `venture_id` via `costEstimator.ts`/`billingLedger.ts` (Master Plan §7). A
  managed deploy meters our hosting cost; a BYO deploy meters only agent/compute (the user pays
  the provider directly). A replayed REFLECT does not double-count.

## 31.5 The adapters in detail

Each adapter below states: its **credential model** (per-venture via Nango or a PAT, with
**least-privilege scopes** — Master Plan §5.9), **inputs**, **outputs**, and **failure
handling**. All BYO adapters resolve credentials through Nango at call time and never see a
raw token (§31.7).

### 31.5.1 `managed-preview` (no creds)

The default, always-available target — the "few clicks → it's live" path that carries no
credential at all because it ships to *our* infrastructure.

| Aspect | Detail |
|---|---|
| **Wraps** | The **shipped** `studio-worker/` substrate: `getSandbox()` → `writeFile` → `exec('npm install')` → `startProcess('npm run dev')` → `exposePort(port, { hostname })` → `proxyToSandbox`. The adapter is a thin Express→Worker HMAC client (the same control-plane hop the studio already uses). |
| **Credential** | **None.** No `ConnectionRef`. This is why managed preview always works and is the empty-state fallback ([§18.10](./18-ux-integrations.md)). |
| **Inputs** | `VentureCtx{ projectId, env:'preview' }`, `BuildArtifact{ kind, versionId, artifactKey }`. |
| **Outputs** | `DeployResult{ url: '<port>-u_<userId>_<projectId>-<token>.dreamstreamstudio.ai', status }`. Recorded in `studio_deployments(target:'managed-preview')`; `ventures.deploy_url` set. |
| **provision / rollback** | `supports: { provision:false, rollback:false, customDomain:false }`. Preview containers are **ephemeral** — there is no prior versioned deployment to roll back to; "rollback" of a preview is simply re-shipping the prior `studio_version` (the loop's concern, not the adapter's). |
| **Failure handling** | Maps the worker's structured errors verbatim: `{ phase:'install', log }` → `DeployResult{ status:'failed', error:{ code:'install', message } }`; HMAC reject → `unauthorized` (operator config error, surfaced to admin, never the user). Container cold-start handled by the warm pool ([§23.4.4](./23-cloudflare-topology.md)). Quota/budget cap breach → the **budget control is the limiter** (Master Plan §7): the venture pauses, it is not a deploy retry. |
| **Honest note** | Managed = **we front the cost**, so it is strictly quota- and budget-capped, and it is a `*.dreamstreamstudio.ai` host — never the user's brand. Real production belongs on BYO. |

### 31.5.2 `cloudflare-pages`

Static / SPA / framework-output sites on the user's own Cloudflare account.

| Aspect | Detail |
|---|---|
| **Credential** | Per-venture `ConnectionRef` via **Nango** (`providerConfigKey:'cloudflare'`) — OAuth (default) or a scoped API token (PAT path). **Least-privilege scopes:** `Pages:edit`, `Account:read` (and `DNS:edit` *only* if a custom domain is requested). Maps to the P1 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md), now **per-venture** not one global set. |
| **provision?** | No (`supports.provision:false`). Pages needs no backing infra; data is a separate `supabase-provision` concern. |
| **Inputs** | `BuildArtifact{ kind:'static'|'spa', outputDir:'dist', artifactKey }`; optional `customDomain`. |
| **Outputs** | `DeployResult{ deploymentId: <pages deployment id>, url: '<project>.pages.dev' or custom domain, status }`. |
| **status / rollback** | `supports.rollback:true` — Pages keeps **versioned, immutable deployments**; rollback re-points the alias to a prior deployment id (instant, free). `status()` reads the deployment's stage (`queued`→`building`→`live`). |
| **customDomain** | `supports.customDomain:true` — see §31.6.x; requires the `DNS:edit` scope and a prod checkpoint. |
| **Failure handling** | 401/403 → scope/credential error → raise a **Reconnect** checkpoint naming the missing scope (never a silent fail at deploy time, per [§18.5](./18-ux-integrations.md)). Build/deploy failure → `status:'failed'` with the provider's redacted message + `logsRef` (logs streamed to R2, not inlined). Idempotent on `idempotencyKey`. |

### 31.5.3 `cloudflare-workers`

Dynamic apps / APIs / SSR (`_worker.js`, Workers/Pages-Functions output) on the user's
Cloudflare account.

| Aspect | Detail |
|---|---|
| **Credential** | Same Nango `cloudflare` connection as Pages; **least-privilege scopes:** `Workers Scripts:edit`, `Account:read` (+ `Workers KV/R2:edit` only if the build declares those bindings; + `DNS:edit` for a custom route). |
| **provision?** | No by default; a venture needing KV/R2/D1 bindings declares them in `BuildArtifact.envVars`/manifest and the adapter creates the named resources idempotently as part of `deploy` (or defers data to `supabase-provision`). |
| **Inputs** | `BuildArtifact{ kind:'worker', entry:'dist/_worker.js', envVars }`; optional `customDomain` (a Workers route). |
| **Outputs** | `DeployResult{ deploymentId: <version/deployment id>, url: '<name>.<subdomain>.workers.dev' or a custom route, status }`. |
| **status / rollback** | `supports.rollback:true` — Workers supports **versioned deployments** (deploy a prior version id); `status()` reads deployment health. |
| **Failure handling** | As Pages, plus: a build whose declared bindings exceed granted scopes → targeted Reconnect for the specific binding scope; an `exceeded subrequest/CPU` style provider error is surfaced (not retried blindly) so the loop can right-size, not loop. |

### 31.5.4 `vercel`

Framework deploys (Next.js, Vite, static) on the user's Vercel account.

| Aspect | Detail |
|---|---|
| **Credential** | Per-venture Nango `vercel` connection (OAuth) or a scoped `VERCEL_TOKEN` (PAT path, per [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md) P1). **Least-privilege:** `deployments:write`, `projects:read` (+ `domains:write` only for custom domains); scoped to one team/project, never account-admin. |
| **provision?** | No (`supports.provision:false`). Vercel infers framework from the artifact; backing data is a separate connection. |
| **Inputs** | `BuildArtifact{ kind:'spa'|'static'|'node-server', buildCommand, outputDir, envVars }`; optional `customDomain`. |
| **Outputs** | `DeployResult{ deploymentId: <vercel deployment id>, url: '<project>-<hash>.vercel.app' or alias, status }`. Aliasing to a stable prod URL is part of a production ship. |
| **status / rollback** | `supports.rollback:true` — Vercel deployments are **immutable**; rollback re-aliases prod to a prior deployment id. `status()` reads `READY`/`ERROR`/`BUILDING`. Vercel's own idempotency is keyed off the deploy hash; we additionally guard with `idempotencyKey`. |
| **Failure handling** | 401/403 → Reconnect checkpoint; build error → `failed` + redacted message + `logsRef`; a deployment stuck `BUILDING` past the step timeout → the Workflow step times out and retries per policy, not an infinite poll. |

### 31.5.5 `railway`

Long-running services / containerized backends + (optionally) a managed Postgres on the
user's Railway account.

| Aspect | Detail |
|---|---|
| **Credential** | Per-venture Nango `railway` connection or a scoped `RAILWAY_TOKEN` (PAT path, P1). **Least-privilege:** `project.deploy` on a single project; not workspace-admin. |
| **provision?** | **Yes** (`supports.provision:true`) — Railway can stand up a **managed Postgres/Redis plugin** alongside the service. `provision()` returns the DB connection coords (non-secret) + a `ConnectionRef` for the credential (stored in Nango). For full DB+auth+storage, prefer `supabase-provision` (§31.5.6). |
| **Inputs** | `BuildArtifact{ kind:'node-server', buildCommand, envVars }`; provisioned resource coords injected as service env. |
| **Outputs** | `DeployResult{ deploymentId: <railway deployment id>, url: '<service>.up.railway.app' or custom domain, status }`. |
| **status / rollback** | `supports.rollback:true` — Railway keeps deployment history; rollback redeploys a prior deployment. `status()` reads `BUILDING`/`DEPLOYING`/`SUCCESS`/`CRASHED`. |
| **Failure handling** | Crash-on-boot (`CRASHED`) is treated as a **deploy failure that feeds VERIFY/health** (§31.6), not a silent live — the health probe catches a service that deploys but doesn't serve. 401/403 → Reconnect. Spending money (a paid plan/plugin) is itself a **spend checkpoint** (Master Plan §8). |

### 31.5.6 `supabase-provision`

Per-project **DB + auth + storage** for a venture — the "give my app a backend" adapter. This
is the only adapter whose primary job is `provision`, not `deploy`.

| Aspect | Detail |
|---|---|
| **Credential** | Per-venture **Supabase Management** connection — OAuth app or a management PAT (`SUPABASE_MANAGEMENT_TOKEN`, [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md) P1#5). **Least-privilege:** project-create/read within one org; never platform-owner. Distinct from the *platform* Supabase (our system-of-record) — this provisions a **user's** project. |
| **provision** | Creates a Supabase project (or branch), applies the venture's schema migrations, enables RLS, and returns `ProvisionResult{ resources:[{type:'database',coords:{url}}, {type:'auth'}, {type:'storage'}], connections:[ref] }`. Project anon/service keys land in **Nango** (a new `ConnectionRef`), never in our DB. Wraps the Supabase MCP/management API ([§30](./30-integrations-framework.md)). |
| **deploy** | Mostly a no-op pass-through (it provisions, it doesn't host a frontend); `deploy()` applies pending migrations idempotently and returns `status` of the project. The frontend ships via Pages/Workers/Vercel, wired to these coords via `envVars`. |
| **status / rollback** | `status()` reads project health/migration state. `rollback` (`supports.rollback:true` via branches): merge/rebase or drop a DB branch — but **any destructive DB op is a destructive checkpoint** (Master Plan §8); the adapter refuses a data-dropping rollback without an approved checkpoint. |
| **Failure handling** | Project-create quota / paid-tier needed → **spend checkpoint**, not a retry. Migration failure → `failed` + redacted SQL error; partial provision is reconciled (idempotent project name keyed on `ventureId`) so a retry adopts the existing project rather than spawning duplicates. Cost confirmation (Supabase paid project) is surfaced as a checkpoint before creation. |

### 31.5.7 Adapter capability matrix

| Adapter | Credential | Least-privilege scopes | `provision` | `rollback` | `customDomain` | Records as `target` |
|---|---|---|---|---|---|---|
| `managed-preview` | none | — | ✗ | ✗ | ✗ | `managed-preview` |
| `cloudflare-pages` | Nango/PAT | Pages:edit, Account:read (+DNS:edit) | ✗ | ✓ | ✓ | `cloudflare-pages` |
| `cloudflare-workers` | Nango/PAT | Workers Scripts:edit, Account:read (+KV/R2, DNS) | (bindings) | ✓ | ✓ | `cloudflare-workers` |
| `vercel` | Nango/PAT | deployments:write, projects:read (+domains:write) | ✗ | ✓ | ✓ | `vercel` |
| `railway` | Nango/PAT | project.deploy | ✓ | ✓ | ✓ | `railway` |
| `supabase-provision` | Nango/PAT | project create/read (one org) | ✓ | ✓ (branches) | ✗ | `supabase-provision` |

### 31.5.8 GitHub sync — shipped, adjacent, not a deploy adapter

GitHub two-way sync is **shipped today** (`server/src/services/studioGithub.ts`,
`routes/studioGithub.ts`): `pushFiles` commits the `studio_files` tree as one atomic
blobs→tree→commit→ref operation; `pullFiles` reads it back. It is deliberately **not** a
`DeployAdapter` — it is *source control*, classified under "Source" in the connections catalog
([§18.3](./18-ux-integrations.md)), not a deploy target. Two relationships matter:

- **It models the credential discipline this whole section follows.** `studioGithub.ts`
  already proves the house rule — "this codebase never stores provider secrets at rest; the
  GitHub PAT is supplied per call and never persisted; we store only the repo *name* on the
  project." A5's adapters generalize exactly that to Nango-brokered, per-venture credentials
  (§31.7). GitHub sync is the **reference implementation** for "tokens never persisted."
- **It can be a deploy *input*.** A "deploy from GitHub" flow (Vercel/Cloudflare connected to a
  repo) is a future composition — push via the shipped sync, then the provider builds from the
  repo — but the MVP path is artifact-based (`BuildArtifact.artifactKey` → R2), which needs no
  provider git integration and keeps the adapter contract uniform.

## 31.6 Health verification post-deploy (feeds A6)

A deploy that returns a URL is **not** a deploy that works. Every ship is followed by an
explicit verification pass whose result becomes a `venture_event` and a SENSE signal — closing
the iterate loop (Epic A6).

```
 adapter.deploy(...) → { deploymentId, url, status:'live' }
   │
   ▼
 1. adapter.status(deploymentId)         provider-side: is the deployment 'live'/'READY'/'SUCCESS'?
 2. HTTP probe url                        GET /  (+ /health if known) → expect 2xx within timeout
 3. (optional) smoke check                a cheap scripted check of a known route (A6 extension)
   │
   ├─ all pass → studio_deployments.status='live'; ventures.deploy_url=url; venture_event(deploy:ok)
   │
   └─ any fail → studio_deployments.status='failed'; venture_event(deploy:degraded)
                  → A6 SENSE signal → ORIENT may create a fix goal (within scope, else scope checkpoint)
```

- **Why a second probe at all.** Providers report "deployment live" before the app necessarily
  *serves* (Railway `SUCCESS` but the process crash-loops; a Worker deploys but throws on
  first request). The HTTP probe catches "deployed but broken," which is precisely the signal
  A6 needs to start "it keeps improving itself" behavior.
- **Feeds A6 SENSE.** A degraded result is written as a signal
  (`POST /api/ventures/:id/signals`, [§28](./28-api-realtime-events.md)); SENSE consumes it,
  ORIENT can propose a fix goal, and the loop iterates — the visible payoff of health
  verification.
- **Health, periodically.** Beyond the post-deploy probe, a periodic owner-scoped health check
  per *live* deployment (extending `verification/runner.ts` patterns,
  [§23.2.1](./23-cloudflare-topology.md) Alarm-driven) keeps `studio_deployments.status` honest
  and raises a notice when a previously-live deployment degrades.
- **Custom-domain go-live.** A custom domain is verified in the same pass: DNS/cert readiness
  (provider `status()`) + an HTTPS probe of the apex/host. A custom-domain go-live is a
  **production checkpoint** (it puts the user's brand public) and needs the provider's
  DNS-edit scope; the probe must succeed before the deployment is marked `live`.

## 31.7 Security — tokens never logged, scoped, revocable

This section holds the keys to users' clouds; [Master Plan §5](../00-MASTER-PLAN.md) is
load-bearing, not fine print. Every rule below is an adapter-layer obligation, and the A5
acceptance test "**tokens never logged**" is a hard gate.

| Rule | How the adapter layer enforces it | Source |
|---|---|---|
| **Secrets live in Nango, never our DB** | `ConnectionRef` carries only `nangoConnectionId` + `providerConfigKey` + granted scopes; the raw token is fetched/injected by the Nango proxy server-side, per request. `venture_connections` stores only the reference. | Master Plan §5.3; [§18.9](./18-ux-integrations.md) |
| **Tokens never logged** | `ctx.logger` is a redacting logger that refuses credential-shaped values; `DeployResult.error.message` is provider text *redacted* of any echoed token; logs stream to R2 as `logsRef`, scrubbed. No token enters `venture_events`, traces, or stdout. | Master Plan §5.9; A5 acceptance |
| **Least-privilege scopes** | Each adapter declares `requiredScopes(env)` (the minimal set in §31.5); the connect flow requests only those ([§18.4](./18-ux-integrations.md)); a missing scope is a targeted Reconnect, not an over-broad re-grant. | Master Plan §5.9; [§18.5](./18-ux-integrations.md) |
| **Per-venture, not global** | A credential is a `venture_connection` (scope `account`|`venture`); the loop scopes every adapter call by `(venture_id, user_id)`; no adapter reads another venture's connection. | Master Plan §6; [§18.2](./18-ux-integrations.md) |
| **Revocable** | Disconnect deletes the Nango credential + the reference and writes an audit event ([§18.8](./18-ux-integrations.md)); a revoked connection fails the pre-flight scope check and the next deploy raises Reconnect — revocation takes effect immediately, no cached token. | [§18.8](./18-ux-integrations.md); Master Plan §5.9 |
| **Human gate on irreversibles** | Production deploy, custom-domain go-live, spending money, and destructive (DB-drop/rollback) ops are **always** checkpoints, regardless of autonomy level — enforced in the deterministic DECIDE gate, not in adapter code, so no adapter can bypass it. | Master Plan §8; §31.4.2 |
| **Owner isolation** | `studio_deployments` + `venture_connections` rows are RLS owner-isolated (`auth.uid() = user_id`, mirroring `projects_rls_owner_isolation.sql`); the worker's service identity always scopes by `venture_id` + `user_id`. | Master Plan §5.1; [§26](./26-data-model-schema.md) |

**The credential never touches the adapter.** This is the architectural reason "tokens never
logged" is *true by construction*, not by discipline: the adapter constructs a request and
hands it to the Nango proxy, which injects the secret and forwards it; the adapter receives
only the provider's response. An adapter literally cannot log a token it never holds — the same
property `studioGithub.ts` achieves today by taking the PAT per-call and never persisting it
(§31.5.8).

## 31.8 Hybrid model — managed for speed, BYO for production

The two halves of [Master Plan §6](../00-MASTER-PLAN.md), expressed in this layer:

| Dimension | Managed (`managed-preview`) | BYO (CF / Vercel / Railway / Supabase) |
|---|---|---|
| **When** | Every preview build; the on-ramp | Production go-live; the user's brand/domain |
| **Credential** | None | Per-venture Nango/PAT, least-privilege |
| **Hosting cost** | **We front it** → strict quota + budget cap | **User pays the provider directly** → we meter only agent/compute |
| **Checkpoint** | Never | Always on first prod / custom domain / spend |
| **URL** | `*.dreamstreamstudio.ai` | `*.pages.dev` / `*.vercel.app` / `*.up.railway.app` / custom domain |
| **Rollback** | Re-ship prior version (ephemeral) | Provider-native versioned rollback |
| **Status today** | substrate **shipped** (`studio-worker/`) | broker **shipped** (Nango); adapters **planned** (A5) |

- **Why both.** Managed gives the instant "it's live" wow without the user owning a single
  account; BYO gives production-grade hosting, the user's own domain, cost pass-through, and an
  exit (no lock-in). One contract, one picker ([§18.6](./18-ux-integrations.md)), one switch.
- **The honest billing line** (Master Plan §7), surfaced in the picker: managed = "we front the
  cost, metered against your budget"; BYO = "you pay the provider directly; we meter only agent
  compute." No billing surprises.
- **The default progression.** A venture starts on managed previews (fast iteration), and when
  it is ready for production the user connects a BYO target and approves the prod checkpoint.
  Pushing real production to BYO accounts is also the abuse/cost-control stance (Master Plan
  §11) — keep managed quota-tight.

## 31.9 Data model touch-points

This layer reads/writes the **shipped** `studio_deployments` table (§[06-DATA-MODEL](../../06-DATA-MODEL.md),
[§26](./26-data-model-schema.md)) with the additive columns A1/A5 introduce. No existing column
changes meaning.

```sql
-- additive to shipped studio_deployments  [planned A1/A5]
ALTER TABLE studio_deployments
  ADD COLUMN venture_id      uuid REFERENCES ventures(id) ON DELETE CASCADE,
  ADD COLUMN version_id      uuid REFERENCES studio_versions(id),  -- what we shipped
  ADD COLUMN env             text NOT NULL DEFAULT 'preview',      -- preview | production
  ADD COLUMN deployment_id   text,        -- provider's stable id (for status/rollback)
  ADD COLUMN idempotency_key text,        -- workflowInstance + version (dedupe replays)
  ADD COLUMN logs_ref        text,        -- R2 key (pointer, never inline logs)
  ADD COLUMN custom_domain   text;        -- set on a custom-domain go-live
-- target column already exists and is exactly an AdapterId.
-- On a live production deploy: UPDATE ventures SET deploy_url = <url>.
```

- `target` is the registry key (`AdapterId`); `(venture_id, idempotency_key)` is the
  dedupe/upsert key for replay safety (§31.4.3).
- **No secret column.** Provider credentials are Nango references in `venture_connections`
  ([§18.2](./18-ux-integrations.md)); `studio_deployments` records *outcomes*, never tokens.
- RLS owner-isolated, joining through `studio_projects`/`ventures` to `user_id`, mirroring the
  shipped pattern.

## 31.10 Mapping to Epic A5

| A5 checklist item ([Master Plan §9](../00-MASTER-PLAN.md)) | Specced in |
|---|---|
| `adapters/types.ts` (the interface) + a registry | §31.2, §31.3 |
| `adapters/managedPreview.ts` — wrap `studio-worker/` (no creds) | §31.5.1 |
| `adapters/cloudflarePages.ts`, `vercel.ts`, `railway.ts` — BYO via Nango/PAT, least-privilege | §31.5.2, §31.5.4, §31.5.5 (+ `cloudflare-workers` §31.5.3) |
| `adapters/supabaseProvision.ts` — per-project DB/auth/storage | §31.5.6 |
| SHIP: managed auto; **prod deploy raises a checkpoint**; record `studio_deployments` (`venture_id`); update `ventures.deploy_url` | §31.4.1, §31.4.2, §31.9 |
| Connection flow → Nango → store ref in `venture_connections` | §31.7 (+ [§18.4](./18-ux-integrations.md), [§30](./30-integrations-framework.md)) |
| Tests: managed preview URL; prod blocks on checkpoint; BYO selected when connection exists; **tokens never logged** | §31.11 acceptance |

## 31.11 Acceptance criteria

- A single `DeployAdapter` interface (`id`, `supports`, `provision?`, `deploy`, `status`,
  `rollback?`, `requiredScopes`) and a registry exist; the loop selects a target by registry
  lookup, defaulting to `managed-preview`, and adding a provider is one file + one registry
  line. **No secret crosses the interface** — `VentureCtx` carries a `ConnectionRef`, never a
  token.
- Each adapter is specced with its credential model (per-venture Nango/PAT, least-privilege
  scopes), inputs, outputs, and failure handling: `managed-preview` (wraps the shipped
  `studio-worker/`, no creds), `cloudflare-pages`, `cloudflare-workers`, `vercel`, `railway`,
  and `supabase-provision` (per-project DB/auth/storage).
- The deploy pipeline is specced end-to-end (build artifact → registry → adapter →
  `studio_deployments` row → `ventures.deploy_url`), with **managed-auto** (preview, no
  checkpoint) vs **prod-checkpoint-gated** modes, replay-safe idempotency, versioned records,
  and venture-tagged metering.
- Rollback and versioned deploys are specced (provider-native for CF/Vercel/Railway,
  branch-based for Supabase, re-ship for ephemeral managed previews) with destructive ops gated
  by a checkpoint.
- Custom domains and **health verification post-deploy** (provider `status()` + HTTP probe +
  periodic check) are specced, and the degraded path feeds **A6** SENSE → a fix goal.
- The hybrid model is stated (managed for speed / BYO for production) with the honest cost +
  checkpoint distinction; security rules — tokens never logged, least-privilege scopes,
  per-venture + revocable credentials, owner isolation, human gate on irreversibles — are
  enforced at the adapter layer, true by construction because the credential never touches the
  adapter.
- Everything maps to **Epic A5**; **GitHub sync** is correctly marked **shipped** and adjacent
  (source, not a deploy adapter), and it is the reference implementation for "tokens never
  persisted."
