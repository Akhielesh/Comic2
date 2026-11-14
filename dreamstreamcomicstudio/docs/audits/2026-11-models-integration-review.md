# Models and provider integration review — November 13, 2026

This is a scoped evidence snapshot for the API-key, current-model, Models redesign,
analytics and generated-output request. It is not a claim that every repository
issue or studio feature is complete. Release evidence below distinguishes deployed code, completed checks and remaining
external verification. No private provider credentials were read or used in this audit.

## Baseline and review coverage

- GitHub's default branch is `Dreamstrream-v1`. The reviewed production baseline
  is [`7948c976`, PR #293](https://github.com/Akhielesh/Comic2/pull/293).
  Follow-up [PR #294](https://github.com/Akhielesh/Comic2/pull/294) is deployed at
  `2053d748fc7581b5491a87bd4d93ed90f0e458e0`. The API deployment and Cloudflare
  Pages production deployment both report that exact merge commit.
- [PR #286](https://github.com/Akhielesh/Comic2/pull/286), including the Models
  redesign and provider/catalog corrections, is an ancestor of that baseline.
  The later combined release adds Comic/Chat workspace work without reverting the
  Models, key or catalog files. The older `11a8a840` Models worktree is not the
  current production baseline.
- Inspected the inventory and ancestry of 172 local remote refs, recent PR
  metadata, all 18 open PR records, the relevant #258 proposal/patch, selected
  older key/model branch commits, current key/account/limit middleware, Models
  contracts and consumers, and the latest 30 production workflow runs. An
  inventory or ancestry check does **not** mean every branch's contents were
  reviewed. No wholesale branch merge is justified by this audit.
- The GitHub search for open non-PR issues returned zero. This says nothing about
  unfiled defects, old draft PRs or broader product readiness.
- Read the latest relevant user direction in the sibling Comic setup chat. Its
  active scope is creation simplicity, draft recovery, varied scene layouts,
  sample-comic presentation and cast browsing. Those changes belong to that
  workflow and were not duplicated here.

## Original request mapped to evidence

| Requested outcome | Implemented evidence | Remaining verification or limitation |
|---|---|---|
| Provider keys work across studios/devices | Shared provider registry; device/account key resolution; selected-credential validation; source governance; stale validation protection in #286. PR #294 also repairs account-only legacy image limits. | A saved credential does not prove every model entitlement. Real paid generations were not run by this audit. |
| Models stay current | Live discovery, durable catalog observations, provenance, paging, cached/fallback states and batch-model exclusion in #286. | The deployed maintenance endpoint exposed a GitHub OIDC claim mismatch during its first live run; the narrowly scoped correction and rerun are tracked below. |
| Replace the old Models page | Atlas Image/Language/Usage tabs; ten featured makers; five image comparisons; three-way comparisons; filtering, details and connection state. | Ten makers are an editorial scope, not an invented quality ranking. Four image rows are Studio-supported; FLUX.3 is reference-only. |
| Show actual platform data | Recorded usage and Chat response observations; exact-model image benchmark source/date; published and owner-only output contracts with explicit model attribution. | Public snapshots without attribution cannot be assigned to a model. Empty/error states remain explicit. An authenticated production output smoke check remains a separate gate. |
| Good charts and useful comparison | Price/response chart excludes unknown values; usage charts derive from recorded counters; exact benchmark variants and dated prices stay separate from platform observations. | Full response time is not tokens/second. Different prompts are not a controlled quality comparison. Private owner measurements include successful-call latency; public aggregates retain their privacy floor. |
| Review branches/deployments/issues | Production ancestry, relevant open drafts and workflow results are recorded here. | Old security/legal/Stream/Code proposals are not silently included in this deliverable. |

## Concrete defect corrected in this follow-up

`server/src/middleware/limits.ts` used raw provider headers to decide whether a
legacy image request supplied BYOK. Account middleware correctly attached a saved
key to `req.apiKeys`, but did not invent a header. As a result, an account-only
Gemini, Pixazo or Ideogram key could receive `402 BILLING_LIMIT_REACHED` before
generation when the platform wallet was exhausted. Conversely, a raw key header
for a disabled source could bypass this preliminary limit check.

The correction uses the required provider's resolved nonempty credential,
`Byok === true`, and allowed-source governance. Platform credentials and keys for
another provider do not bypass billing. It preserves account middleware's
allowance and spending-consent decision; it does not fetch or inject another key.

Regression evidence: the new middleware suite failed in four cases before the
correction and passed all 19 afterward. Together with the existing key and account
key middleware suites, **33 tests passed**. The test run used Node 24 and mocked
billing; it did not read private credentials or call a generation provider.
Client/server typechecks and the production frontend build passed. The deployed
merge passed full CI, including the server boot and Workers typechecks.

## Operational and live-evidence gates

| Item | Last directly observed evidence | Completion condition |
|---|---|---|
| Production CI | [Run 43546294734](https://github.com/Akhielesh/Comic2/actions/runs/43546294734) succeeded for deployed `2053d748`, including verification, both Workers typechecks and server boot. | Any subsequent executable correction must pass its focused checks and deployment verification. |
| API and frontend deployment | [API run 43546294543](https://github.com/Akhielesh/Comic2/actions/runs/43546294543) succeeded and verified `2053d748`. Cloudflare Pages production deployment `1f54de61-4d1c-4863-8701-b1c5203c5acd` succeeded for the same commit. | Check the next authentication correction's backend identity separately. |
| Responsive rendering | [Run 43543830172](https://github.com/Akhielesh/Comic2/actions/runs/43543830172) completed its Playwright step: 294 passed, 2 skipped, no new findings. Screenshots were inspected at 320 px and 1280 px. | The workflow was canceled after artifact upload by a later workflow-only commit; this is passing test-step evidence, not an overall green run. Fixtures are visibly marked synthetic. |
| Scheduled model catalog | [Production run 43546605092](https://github.com/Akhielesh/Comic2/actions/runs/43546605092) reached the new endpoint but received `MAINTENANCE_UNAUTHORIZED`. A [read-only diagnostic run 43547186640](https://github.com/Akhielesh/Comic2/actions/runs/43547186640) confirmed GitHub includes `job_workflow_ref` equal to `workflow_ref` even for this direct job. All other policy checks and signature verification passed. | Accept absent or exactly the already approved workflow reference, then run the production refresh and independently confirm persisted catalog timestamps. Do not loosen repository IDs, branch, workflow, audience or signature checks. |
| NVIDIA model access | Both backend configuration stores were checked for key presence only: no platform `NVIDIA_API_KEY` exists. Public discovery works without authentication and cannot establish access. Account-specific 404s no longer mark a model globally unavailable. | An authorized platform credential is required for inference probing. The maintenance job must report missing configuration without making a provider generation request. |
| Actual image examples | Read-only aggregate queries found 57 ready, attributed Nano Banana 2.1 assets (49 at 2K, 8 at 1K) and qualifying owner measurements at 2K. No private identities, prompts, keys or image URLs were returned. Public snapshots without attribution remain excluded. | Signed-in browser verification remains blocked by the browser tool's saved/managed origin policy, including after both user approvals. No alternate browser or HTTP session was used to bypass it. |
| Performance data | PR #294 supplies owner-only medians by exact model, kind and resolution, a three-sample minimum, bounded history, and explicit Your results / Platform results selection. Regression tests cover owner isolation, private cache exclusion, account-switch clearing, missing/error states and signed-image retry. | Recorded provider cost is not the customer's bill; private measurements are not public aggregates. No controlled cross-provider performance or paid generation test was performed. |

The additive `model_catalog_callability_freshness` database migration was applied
successfully to the Comic project. Callability age is independent of metadata
freshness, expires after 48 hours, and remains unknown without conclusive evidence.
Final operational rerun links and outcomes are recorded in the follow-up release PR.


## Branch families and disposition

| Family | Inclusion/content evidence | Disposition |
|---|---|---|
| Current Models/catalog/connections: `codex/comic-research-and-creation`, responsive integration, #286 | Ancestry and scoped diff confirm included in `7948c976`. Current components/services examined. | Canonical delivered Models implementation; continue from current production. |
| API release identity: `codex/comic-api-release-verification`, #281 | Included; API deployment result inspected. | Preserve build identity and deployment checks. |
| Recent Comic/Chat workspace: home/library, editing/reader, navigation, cast/style, project dialog, #279–293 | Recent PR intent, ancestry and post-Models diff reviewed; not a complete feature audit. #292 still appears open despite combined-release inclusion. | Preserve combined production work; an open stacked PR is not proof its behavior is missing. |
| Shared responsive/Atlas checks: `codex/responsive-shared-checks`, #282 | Included; Models responsive corrections also included by #286. | Keep the shared overflow/target-size checks and deterministic QA scene. |
| Old Models Phase 0: `claude/atlas-models-phase0` | Unmerged single unique commit; commit explicitly says WIP, not for merge, review fixes not applied. Commit intent and changed-file scope inspected. | Historical design/review evidence, not a replacement for the shipped workspace. |
| Verify hotfix: `claude/atlas-models-verify-hotfix`, [#258](https://github.com/Akhielesh/Comic2/pull/258) | Current `/verify` protects platform telemetry and uses caller keys for non-admins. Its public catalog read can refresh like the public catalog endpoint. Old patch predates account governance and NVIDIA caching. | The proposed no-key 403 is an older hardening choice, not an evidenced current secret leak. Do not merge the patch wholesale. |
| Early key-limit change: `codex/refactor-limit-checking-for-route-keys` | February commit inspected; applies to a retired directory layout. Provider-specific routing intent is already present in current middleware. | Port only evidenced gaps: the account-only limitation above was fixed against current code. |
| Retired Code/agent branches: `claude/studio-verify-insights`, #198 and older #82 plans | Selected commit intent/patch and ADR 0005 reviewed; Code Studio was retired in October. Old #82's Chat-freeze/Comic-only premise is not current product scope. | Historical context. Do not restore retired surfaces or replace current Chat/Comic routing. |

## Separate backlog, not claims of completion

The remaining open PR inventory includes security/request-hardening #259/#260,
legal/privacy #251/#263, Stream UI/hotkeys #255–257, Atlas linking #235, maps #220,
widget checks #217, agent planning #198, older Comic planning #82, Finance #72,
and legacy #1–3 proposals. Their metadata and stated intent were reviewed for
scope; their implementations were not comprehensively audited here. They are not
automatically required to repair the Models/API-key path, and none was merged or
closed by this review.

The active sibling's new sample art must not be labeled as an output of one of
these five platform model routes unless its recorded generation provenance
supports that attribution. Likewise, a passing test or a published reference
price does not establish a user's live provider balance, access or generation
success.

Current feature guidance is [Models and API Configuration](../features/models-and-api-configuration.md),
[Models workspace](../MODELS_WORKSPACE.md), the shared registries and current
route implementations. Older launch plans and unmerged proposal branches remain
dated context. Accepted ADRs, especially [Code Studio retirement](../decisions/0005-retire-code-studio.md),
must be read before treating an older branch as current product intent.
