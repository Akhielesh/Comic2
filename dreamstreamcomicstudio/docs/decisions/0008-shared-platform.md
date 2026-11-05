# 0008. One shared, owned docs, design and agent platform

- **Status:** Proposed
- **Date:** 2026-10-30
- **Overview:** [`docs/platform/`](../platform/README.md) covers what the platform is, what wave 1 ships and the
  flags. The [wire contract](../platform/contract.md), [onboarding](../platform/onboarding.md) and the
  [security model](../platform/security.md) are there too.
- **Code:** [`packages/platform-core`](../../packages/platform-core/README.md) (the contract, version 1.0.0) and
  [`packages/platform-render`](../../packages/platform-render/README.md) (the light renderers).
- **Related:**
  - ADR 0001: the AI control plane, which hosts keep.
  - ADR 0002: billing UI removed. Governed users see usage, never dollars.
  - ADR 0003: per-key usage limits.
- **Scope:** wave 1, a no-infrastructure value slice in this repository. This record also holds every contract
  decision and amendment the wave-1 packages routed here.

## Context

Every studio needs the same document work: Word and PowerPoint files, email drafts, decks, PDFs, and later print and
layered art. So could a product in another repository. Rebuilding that per studio multiplies code, risk and licence
exposure.

The open-source "Craft" engines can do the heavy work, but they are large, fast-moving and partly untrusted. They
must not run in our 1 GiB backend or be hard-forked. Hosts already own auth, models, budgets and consent, and must
keep owning them.

**Constraints:**
- This repository is public.
- The backend must stay sleepable.
- The backend compiles under `Node16` resolution.
- Wave 1 may add no infrastructure, no table, no SQL and no secret.

## Decision

A contract-first platform. A small pure package (`platform-core`) owns the document models, tools, gates, wording,
flows and wire. Hosts implement five ports over their own systems. Engines run behind a gateway from wave 2. Nothing
sends.

| # | Decision | Owner | Status |
|---|---|---|---|
| 1 | `platform-core` is pure TypeScript against ES2017: no dependencies, injected crypto, fetch and clock, and every relative import ending in `.js`. Hosts own auth, the model, money and consent. There is no send tool, mode, op or control. | W1.1, all | Proposed (owner decision D1) |
| 2 | The platform is a **capability of a product**, not a product id. Every studio has a manifest (`platformProducts.test.ts`). | W1.4 | Proposed |
| 3 | Wave 1 adds **no infrastructure**. It ships behind `PLATFORM_DOCS` (server), `VITE_PLATFORM_DOCS` (client) and `PLATFORM_DOCS_STAGE` (`'admins'`). | Lead | Proposed |
| 4 | **Contract v1 is frozen** in `src/contract/**`. Minor versions are additive only, and **a fixture change is a contract change** with a note here. | W1.1 | Proposed |
| 5 | [Lead decisions L1–L5](#1-lead-decisions-l1l5) | Lead | Decided by the lead; the owner confirms |
| 6 | [Kernel decisions and the contract review before the freeze](#2-kernel-and-contract-w11) | W1.1 | Proposed |
| 7 | [Keeping the schema DSL in-house past the plan's fallback threshold](#23-the-dsl-stays-in-house) | W1.1 | **Open:** the lead confirms |
| 8 | [Model decisions; A1 interim code, superseded by `duplicate-id`; A2 resolved](#3-models-w12) | W1.2, integration | Proposed; `duplicate-id` lands before the tag |
| 9 | [Email, brand and prompts; `fixtures/email` is contract by example](#4-email-brand-and-prompts-w13) | W1.3 | Proposed |
| 10 | [Renderers: docx 9.11.0, PptxGenJS 4.0.1, patches P8 and P9](#5-renderers-w17) | W1.7 | Proposed |
| 11 | [Governance (a)–(n)](#6-governance-w14) | W1.4 | Proposed |
| 12 | [PROVISIONAL numbers (o), each with its owner](#63-provisional-numbers-o) | Each named owner | **Open:** confirm each |
| 13 | [Wire amendments 1–14 and A–G; `fixtures/wire` is the wire contract by example](#7-wire-w15) | W1.5 | Proposed; amendment 1 accepted (L2) |
| 14 | [Release workflow and the public-docs guard](#8-release-and-public-docs-w111) | W1.11 | Proposed |
| 15 | [Plan corrections from the wave](#9-plan-corrections) | Lead | Recorded |

### 1. Lead decisions (L1–L5)

These win over the package notes.

- **L1. Licence.** `BlueOak-1.0.0` and `Zlib` join `scopes.browser.allow` in `scripts/licence-policy.json`, with a
  `$comment` that both are permissive, notice-only, OSI-approved licences.
  - Why: docx's single-module bundle carries sax (BlueOak-1.0.0) and jszip's bundled pako (MIT AND Zlib).
  - The notices print sax's and pako's texts under docx.
  - The integration package makes the change.
- **L2. The sub formula (wire amendment 1) is accepted.**
  - Each host holds a non-rotating sub secret, distinct from every signing secret.
  - `sub = hex(HMAC(HMAC(subSecret, "platform-sub-v1"), userId))[0..32]`. Onboarding step 2 says so.
  - W1.5's three helper files (`src/wire/bytes.ts`, `src/wire/crypto.ts`, `src/client/request.ts`) are accepted into
    its row.
- **L3. Metering.** The wave-1 tools (`email_draft`, `deck_create`) are text tools and reserve nothing.
  - W1.9 passes `bindTools` a meter that answers `{ok: false, code: 'unavailable'}` from `reserve` and `claim` and
    never throws, and it proves the wave-1 tools never call it.
  - The ledger-backed DreamStream MeterPort and the stranded-holds change move to W3.2, because they change money
    paths.
- **L4. Schema deduplication deferred.** `src/tools/schemas.ts` keeps its own model-facing schemas, and the type
  tests keep them pinned to the contract. When they are deduplicated with W1.2's block schemas, these differences
  stay:
  - no `v` or `rev` at the top level;
  - no `actor` and no `set_recipients`;
  - no attachments in `email_draft`;
  - no image block or element anywhere a model writes.
- **L5. D16 stays an owner decision.** Nothing in wave 1 removes the dormant Nango tool, its catalogue entries or the
  GSAP text in `render_video`. The licence gate does not scan or report them.

### 2. Kernel and contract (W1.1)

#### 2.1 Decisions frozen in `src/contract/**`

1. **Links.**
   - `SafeLink` is `{href: SafeHref}`, and a run's `link` is a `SafeLink`.
   - The email button is `{type: 'button', id, label, href: SafeHref}`, where `SafeHref` is an `https:` or `mailto:`
     string.
2. **Discriminators.**
   - RichDoc and EmailDoc blocks use `type`, because the comic script block's own `kind` is
     `scene | panel | dialogue | caption | sfx`.
   - Deck elements and `AssetRef` use `kind`, and ops use `op`.
3. **`AttachmentSpec`** is `{id, name, kind: 'docx' | 'pdf' | 'pptx', spec: {type: 'doc', doc} | {type: 'deck', deck}}`.
   The DSL's unions are tagged, and `id` gives `detach` a target.
4. **Revisions.**
   - Each model has `rev?`, where absent means 0.
   - An op applies only while `op.baseRev === doc.rev` at the start of the `apply*Ops` call.
   - A call that applies at least one op bumps `rev` by 1, so a replayed batch is `stale`.
   - `OpResult` is `{doc, applied, rejected}`, and `OpRejection` is `{index, opId?, code, message}`.
5. **Email ops** carry `actor?: 'user' | 'agent'`, stamped by the host; absent means agent. `set_recipients` requires
   `actor: 'user'`.
6. **EmailDoc.**
   - `to` is required; `cc` and `bcc` are optional.
   - Recipients are `{address, name?}`.
   - `signature` is plain text of at most 10,000 characters, and `brand` is a BrandKit id.
   - `EMAIL_LIMITS.field` (10,000) also caps the whole plain-text body, as a model refinement.
7. **DSL additions:** `s.tuple`, `s.id` and numeric `s.enum`. `toJsonSchema` has three targets:
   - `strict`: JSON Schema 2020-12 with `$schema`;
   - `mcp`: the same without `$schema`, and the root must be an object;
   - `llm`: flattened. A field every variant has stays required; any other field says "Only when <tag> is …".
8. **`CheckResult`** is `{ok: true; value; errors?: undefined} | {ok: false; errors; value?: undefined}`, so it is
   readable with `strict` off.
9. **Text policy.**
   - Control characters, bidi embedding, override and isolate characters, and unpaired surrogates are rejected
     everywhere.
   - Email addresses use a conservative ASCII subset.
   - Links are lowercase `https://` or `mailto:` only, with no userinfo and RFC 3986 characters only (IDNs as
     punycode), and every `%` must be a valid escape.
10. **Caps the plan did not name:**
    - titles 300;
    - runs per block: 500 in RichDoc, 200 in email;
    - list items: 500 in RichDoc, 100 in email;
    - deck notes 5,000; deck tables 20 × 10; charts 50 categories × 8 series;
    - alt text 1,000; links 2,048; ids 64;
    - the `check()` node budget 200,000.
11. **The version is 1.0.0,** so the planned tag `platform-core-v1.0.0` needs no bump.

#### 2.2 Contract review before the freeze

All of these were made before anything was released.
- **RichDoc:** `remove_section` (`DocRemoveSectionOp`, in `DocOp`), so `insert_section` has an inverse. `Section` is
  an alias of `DocSection`.
- **`EmailAttachOp.index?`:** the insert position; absent appends. So `detach` has an exact inverse.
- **`AgentEmailOp`** is `Exclude<EmailOp, EmailSetRecipientsOp>`. Model-facing tools take it, never `EmailOp`.
- **Email block ops address top-level blocks only.** A block inside `columns` changes through `update_block` on its
  `columns` block.
- **`set_recipients`** replaces `to`, `cc` and `bcc` together, so an absent `cc` or `bcc` clears that field.
- **The `DocSuggestion` re-stamp rule.** Accepting a suggestion re-stamps its op's `baseRev` to `doc.rev` after its
  target ids are checked; a missing target is `not-found`.
- **Every op's inverse is in its own union.**
- **`SCHEMA_LIMITS.assetDataMaxBytes`** is 5,000,000 (5 MB, with MB = 10^6), not 5,242,880.
- **`mailto:`** may set only `subject` and `body`, and the subject may not carry an encoded CR or LF.
- **`toJsonSchema` (`llm`)** throws when union variants or tuple items give one field two JSON types.
- **`MANIFEST.json`** always carries `clean` (`true`, `false`, or `null` outside a git checkout).
- **Fixture changes:**
  - `richdoc/ops.json` gains `remove_section`;
  - `email/ops.json` gains an `attach` with `index`;
  - `schema/invalid.json` gains 5 cases, and `schema/valid.json` 1.

**Accepted risks:**
- The narrowings can refuse a link that sets cc or bcc, and `data:` images between 5,000,001 and 5,242,880 bytes.
  Hosts may need a repair retry.
- The re-stamp rule checks only that the target ids still exist. A host that must not overwrite a newer user edit
  compares the target block too.

#### 2.3 The DSL stays in-house

The plan §5.1 fallback threshold was exceeded (≈960 code lines). The DSL was kept in-house because TypeBox lacks the
link, email and data-URI sniffing guards and the flattened `llm` projection. **The lead confirms this, or chooses the
vendored-TypeBox swap behind the same `s.*` facade.**

### 3. Models (W1.2)

- **A1, interim code, now superseded.** W1.2 refused repeated ids with the existing `too-many` code, at the repeated
  item's `id` path. The scopes:
  - section ids per document, and block ids across a RichDoc;
  - slide ids per deck, and element ids per slide;
  - email block ids, columns included, and attachment ids per email;
  - an attached doc or deck, checked within itself.

  **The integration package is adding `duplicate-id` to `CHECK_ERROR_CODES`** (additive). It switches `REPEATED_ID`
  in `src/models/common.ts` and the 9 repeated-id cases in `fixtures/models/invalid.json`. That supersedes the interim
  `too-many` and must land before the `platform-core-v1.0.0` tag.
- **A2, resolved inside W1.2.** A run that names a mark more than once is refused as `too-many` at `…marks`, in
  documents and in what ops and suggestions carry.
- **Decisions:**
  - `MODEL_OPS_MAX` is 1,000 ops per call; the rest are refused as `limit`.
  - The op log (`seenOpIds`) is an optional third argument of `apply*Ops`, and the frozen `OpResult` is unchanged.
    `acceptDocSuggestion` requires it.
  - `set_title` and `set_subject` are single-line.
  - An agent's `set_recipients` is refused as `forbidden` before its shape is read.
  - An index past the end is `invalid`, never clamped.
  - Detaching the last attachment removes the field. An email with no attachments has no `attachments` field, so an
    empty list is invalid.
  - A block op that grows the email body past its cap is `limit`. One that shrinks an over-cap body is allowed.
  - `emailBodyTextLength` is an upper bound: the text, hrefs, labels, cites and alts, plus `EMAIL_TEXT_ALLOWANCE`:
    `{block 2, listItem 10, link 3, button 4, image 9, divider 4, quote 2, cite 5, lineBreak 2}`, plus
    `listPrefixWidth` for list items.
  - **Overlap.** Only a `line` shape may have zero width or height (epsilon 1e-6). A line collides only with a box it
    runs through, and any other flat element collides with whatever it touches. `overlapCheck` ignores overlaps
    thinner than 1e-6, and rect sums allow a 1e-9 tolerance.
  - `invert*Ops` returns only checked, valid ops, otherwise `null`.
  - `migrate*()` accepts v1 only.
- **`fixtures/models/**` is contract by example.** A change there is a contract change.

### 4. Email, brand and prompts (W1.3)

- **`fixtures/email/**` is contract by example:** `hostile.json`, `creator-brand.json`, the golden renders and
  `golden.json`. `hostile.json` and its golden changed in the fix round; that change is recorded here.
- **Additive decisions inside the frozen types:**
  - `renderEmail(doc, brandKit?, options?)`. The options are `{resolveAsset?, lang?}`; `resolveAsset` hands back a
    `data:` URI the host already holds and never fetches.
  - `EmailWarning.code` is an open set, published as `EMAIL_WARNING_CODES`. It has nine codes: `reply-recipients`,
    `mode-mismatch`, `invalid-recipient`, `duplicate-recipient`, `unsafe-link`, `link-text-mismatch`,
    `mailto-untrusted`, `body-too-long` and `attachments-separate`.
  - The reply rule applies when either the host's mode or the draft's is a reply mode, so a draft cannot widen the
    prefill. Display names come only from the thread's participants.
  - BrandKit, the font registry and `PromptPack` are non-frozen types. Two helper files exist: `src/email/read.ts`
    and `src/prompts/pack.ts`.
  - `checkBrandKit` validates the fields renderers read and rejects unknown fields. `BrandIssueCode` gains `size`
    and `unknown`, and `BRAND_LIMITS` gains doc sizes 6–96 pt, line spacing 1–3 and `unknownReported` 10.
  - The deck outline is narrowed before release: 12 slides, 100-character bullets and 500 characters of notes.
    `deckOutline.v1` allows 8,000 output tokens (`DECK_OUTLINE_CHARS_PER_TOKEN` = 3).
  - `emailDraft.v1` keeps the plan's 1,500 output tokens: enough for typical drafts, not for the largest EmailDoc the
    contract allows.

### 5. Renderers (W1.7)

- **docx is pinned at 9.11.0, not the plan's 9.15.0.** On 2026-10-30, 9.12.0 to 9.15.0 were all under the two-week
  age rule; 9.11.0 is the newest 9.x past it. (9.15.0 also swapped jszip for fflate.)
- **PptxGenJS 4.0.1 is confirmed as the latest release.** It is vendored, and the licence policy's record matches. A
  test asserts that the record's version equals the vendored banner.
- **The patches to the vendored PptxGenJS** are P0–P9, listed in its `PATCHES.md`:
  - **P8 is a correctness fix, not a security patch.** Upstream writes a second `<a:pPr>` into every multi-run
    paragraph, which the DrawingML schema does not allow. It is worth upstreaming.
  - **P9 is metadata.** Each chart's embedded workbook now names the presentation's author (the BrandKit's name),
    XML-escaped, instead of `PptxGenJS`.
  - Re-vendoring a new release must keep or re-port P8 and P9, or the goldens fail.
- **Files beyond the plan's row:**
  - `src/{errors,images,style}.ts`;
  - a hand-written `pptxgen.es.d.ts`;
  - `scripts/vendor-pptxgenjs.mjs` with `pptxgenjs-patches.json`, for reproducible vendoring;
  - `src/render.testkit.ts`.

### 6. Governance (W1.4)

#### 6.1 Builder decisions (a)–(e)

- **(a)** `MeterPort` has an atomic `claim(reservationId)` that answers `claimed`, `used` or `unknown`. It is the
  single-use guard behind plan tokens.
- **(b) The plan-token format** is `base64url(canonical JSON payload) "." base64url(HMAC-SHA256(k, "platform-plan-v1." + payload))`.
  - `k = HMAC(hostKey, "platform-plan-v1")`, and the host key is at least 32 bytes.
  - The payload is `{v, sub, iat, exp ≤ iat + 900 s, reservationId, planHash}`.
  - **Refusals:**
    - tampered or malformed → 401;
    - expired, another user, another plan or a bad lifetime → 403;
    - reservation already used → 409;
    - ledger down → 503 (`disabled`).
- **(c)** `runFlow` reserves the estimate when it plans, so the token can carry `reservationId`. A resume fails closed
  whenever the ledger is down, for ungoverned users too, because single use cannot be proven without it.
- **(d) `decideGate`:**
  - `read` is exempt from the user-content propose floor.
  - A `spend` tool with no estimate counts as unknown cost.
  - The `atlas` policy `always` confirms any spend above zero, and `before_execute` confirms at $0.50 a turn.
  - A tool's own `confirm` gate is a floor.
- **(e)** Tools carry a `target` field and an `agentOps` flag, so the host stamps `actor`.

#### 6.2 Fix-round decisions (f)–(n)

- **(f)** The plan-token verifier checks the subject before expiry. An authentic but expired token from the same user
  returns 403 `expired` with its payload. `runFlow` claims and releases the hold on plan-expired, plan-stale,
  plan-params and estimate-changed, and `cancelPlan` does the same for an expired token.
- **(g)** A flow's own policy can only tighten the user's policy:
  - the stricter answer wins: deny > confirm > propose > spend-confirm > quota-check > run;
  - a flow definition may not set `never` or `none`.
- **(h)** Inside `runFlow`, a `propose`, or a `spend-confirm` without an approved plan, stops at `awaiting_confirm`
  with a proposal, and the tool never runs.
- **(i)** `MeterClaimResult` gains `unavailable`, and `claim` never throws. A throw counts as `unavailable`, and either
  one gives 503 ledger-down.
- **(j)** `settleFailed?: true` on flow and tool results. A ledger failure also records an audit event,
  `settle-failed` or `release-failed`.
- **(k) A model never places an image anywhere.** Agent variants of the email blocks, attachments, doc and deck
  schemas and doc ops carry no image block or element.
- **(l)** `bindTools` throws at bind time when a tool that reserves is bound without a meter. When a handler reports
  no cost, the call settles at the whole hold.
- **(m) Audit routing:**
  - security guard codes, and any unknown blocked code, go to `audit_log`;
  - routine guard codes go to a log line: quota, ledger-down, max-per-turn, reservation-used, estimate-changed,
    plan-expired and plan-stale;
  - `settle-failed` and `release-failed` go to a log line marked stranded;
  - the flow external-write refusal is `blocked`.
- **(n) Core wording equals the host's word for word:**
  - `costLabel` matches `formatCostForUser`, and `formatUsd` matches the host's, with no thousands separator
    (`$1250.50`);
  - the unknown share reads "uses a little of your usage";
  - an ungoverned zero shows `$0.00`.

**Behaviour changes to confirm:**
- `FLOW_ESTIMATE_MAX_USD` 10 → 2;
- PDF-tool page caps 200 → 300;
- `formatUsd` without a thousands separator;
- an unreported tool cost settles at the whole hold.

#### 6.3 PROVISIONAL numbers (o)

Each is marked in code with its owner. `CapabilitySpec.provisional` is a new optional field, and the registry refuses
a placeholder engine version without a provisional note. **Each needs its owner's confirmation:**

| Number | Owner |
|---|---|
| `email.render`: 2 MB, 2 s | W1.3 |
| `richdoc.export`: 40 MB (W1.8's deck cap), 60 s | W1.7 |
| `deck.export`: 120 s | W1.8 |
| `pdf.sanitize` and `pdf.*`: 50 MB, 300 pages, 25 s (from `/v1/extract`; previously 200 pages) | W2.3 / W2.6 |
| `asset.normalize`: 50 MB in bytes (the plan caps 50 MP) | W2.3 |
| `print.book`: 150 MB, 800 pages, 300 s | W2.4 |
| `print.preflight`: 150 MB, 800 pages, 120 s; poppler's `pinned` version is a placeholder | W2.4 |
| `doc.convert`: the zip-9 build's `pending` version is a placeholder | W4.2 |
| `image.psd`: 150 MB, 120 s | W5.1 |
| `layout.idml`: 150 MB, 120 s | W5.2 |
| `comic.*`: 200 MB, 120 s; plans creator, studio and admin (§10, pending D8) | W3.7 |
| `maxPerTurn`: `email_draft` 3, `deck_create` 2 | W1.9 |
| `DocReadOutput`: 200,000 characters | W2.6 |
| `CONSENT_TTL_MS`: 15 min | W1.9 / W3.2 |
| `FLOW_ESTIMATE_MAX_USD`: 2 (was 10) | W3.2 |
| `FLOW_CATALOG` titles are working names | Waves 3–4 |

**From the spec, not provisional:**
- extract: 50 MB and 300 pages;
- render: 10 MB;
- convert: 50 MB;
- the 25 s synchronous budget;
- `deck.export`: 40 MB.

### 7. Wire (W1.5)

**`fixtures/wire/{hmac,claims,poll}.json` are the wire contract by example.** A fixture change needs a note here. The
full rules are in [contract.md](../platform/contract.md).

1. **The sub** is domain-separated, under its own secret (accepted, L2): `sub = hex(HMAC(HMAC(subSecret,
   "platform-sub-v1"), userId))[0..32]`. The sub secret never rotates with the signing key.
2. **Derivation labels are pinned:** the claim key is `HMAC(appSecret, "platform-claim-v1")` and the poll key is
   `HMAC(appSecret, "platform-poll-v1")`. A canonical string always starts with `v1\n`, so no label collides with it.
3. **Poll tokens** are `base64url(json).base64url(HMAC(pollKey, b64json))`, with payload
   `{v: 1, kind: 'poll', app, kid, sub, jobId, exp}`. `kid` finds the key during a rotation overlap. Verification
   order: method, shape, key lookup, MAC, `exp`, job id.
4. **The canonical query** is decoded as a server reads it (`+` is a space), RFC 3986-encoded with upper-case hex,
   and sorted by key. Refused: a repeated key, a bad escape, invalid UTF-8, an empty key, a `#`, raw non-ASCII, more
   than 64 parameters or 2,048 characters. Empty pairs are skipped, and `?a` equals `?a=`.
5. **The canonical path** follows RFC 3986 §6.2.2 normalisation. Dot segments, empty segments and non-`pchar`
   characters are refused.
6. **Claims:**
   - the default lifetime is 120 s and the maximum 300 s;
   - a service claim needs at least one capability;
   - the MAC is checked before the payload is decoded, then the payload is validated with the DSL;
   - the claim's app must equal `X-Platform-App`.
7. **Two-phase verification.** `preflightRequest` runs before any byte is staged; `verifyRequestSignature` takes the
   bytes or the streamed hash. A POST with a body needs a claim, and an empty POST does not. `claim: 'none'` is for
   callbacks.
8. **Failures** are `WireFailure` (a `PlatformFailure` plus `reason`), with a fixed reason-to-code table. A malformed
   gateway answer is reason `response`, code `engine-failed`.
9. **The job record id** is `hex(sha256("platform-job-v1\n" + app + "\n" + (sub or "svc") + "\n" + key))`.
10. **`X-Platform-Signature`** must be the canonical 43-character base64url of the MAC.
11. **`X-Platform-File-Name` and `X-Atlas-File-Name`** are RFC 3986 percent-encoded UTF-8, at most 255 characters
    before encoding, with no control characters.
12. **The client** always sends `redirect: 'error'`, and checks every answer: shape and caps, `%PDF-` and
    `PK\x03\x04` magic with the matching media type, and that an upload's sha256 equals the bytes sent.
13. **`JOB_STATES`** are `queued | running | succeeded | failed`. The callback is a signed POST with an
    `Idempotency-Key` and no claim, and building one needs an explicit `callback: true`.
14. **`WIRE_LIMITS`** (MB = 10^6):
    - request bodies at most 50,000,000 bytes;
    - responses read up to 64,000,000 bytes by default;
    - claim tokens at most 4,096 characters, and poll tokens at most 2,048;
    - secrets at least 32 bytes.

**Fix round, A–G:**
- **A.** `verifyPollToken` requires the job record's owner (`{app, sub}`), never taken from the token. Order: GET,
  shape, key, MAC, `exp`, job id, then owner; a mismatch is `wrong-job` (403).
- **B.** `maxBodyBytes` defaults to 50,000,000, and a non-integer or negative cap is invalid. Leaving the option out
  no longer uncaps the body.
- **C.** Phase 2 takes `ReceivedBody`: `{bytes}` or `{sha256Hex, length}`. The hashed byte count must equal the
  declared `Content-Length` (0 for a GET), otherwise the result is `bad-signature`.
- **D.** `preflightRequest` returns `stage: 'preflight'`, which is not authenticated. Only `stage: 'verified'` (a
  `VerifiedRequest`) is. `verifyRequest` returns `VerifiedRequestResult`, a superset of the old fields.
- **E.** Only GET and POST can be signed or verified.
- **F.** `downloadFile` accepts only `SERVED_FILE_TYPES`, and render answers are capped at `RENDER_MAX_BYTES`
  (10,000,000).
- **G.** Amendment 1 is unchanged in code. The lead accepted it (L2).

**Helper files.** W1.5 also owns `src/wire/bytes.ts`, `src/wire/crypto.ts` and `src/client/request.ts` (L2).

### 8. Release and public docs (W1.11)

- **The release workflow.** A tag `platform-core-v*` runs `.github/workflows/release-platform-core.yml`.
  - **The pack job** (`contents: read`) runs `export.mjs` and refuses unless:
    - the tag equals `package.json` and the `MANIFEST.json` version;
    - `MANIFEST.json` `clean === true`, and its `gitSha` is the tagged commit;
    - `SHA256SUMS` verifies, with both flavours present;
    - a second pack is byte-identical.
  - **The release job** (`contents: write`, the only job with write access) rebuilds on a fresh runner, refuses
    unless its `SHA256SUMS` digest equals the pack job's, and creates the release with the runner's `gh`. No
    third-party release action is used.
  - Actions are pinned to the SHAs the other workflows use, and the jobs run Node 22.
- **The public-docs guard.** This repository is public, so `tests/config/publicDocs.test.ts` fails when
  `docs/platform/**`, this ADR, or either release tarball (built in the test) carries:
  - another product's repository name;
  - its internal server paths;
  - security advisory identifiers;
  - one of its high-risk file names.

  It also runs the workflow's own steps as a dry run, twice, with a fake `gh`. Material specific to another product
  travels only as a session message, never committed here.

### 9. Plan corrections

- **sharp's message.** A loader blocked by `sharp.block` makes sharp report "unsupported image format", not
  "blocked".
  - The blocked loaders are `VipsForeignLoad{Tiff,Magick,Magick7,Pdf,Jp2k,Fits,Openslide,Matrix}`. Magick needs both
    the IM6 and the IM7 loader.
  - Under the "JPEG, PNG, WebP, GIF" allowlist, `convert_image` no longer accepts AVIF input. AVIF output is
    unchanged.
- **The licence gate does not report Nango or GSAP.** Plan §11's line saying it would is dropped (L5).

### 10. Integration (stage C)

- **A1 landed.** `duplicate-id` is appended to `CHECK_ERROR_CODES` (additive; the frozen 22 codes keep their order). Repeated
  ids (A1) and repeated marks (A2) raise it; the 11 changed cases in `fixtures/models/invalid.json` are a contract-by-example
  change. The interim `too-many` for these cases is gone.
- **One definition of claim purposes and preview capabilities.** `ClaimCapability` is narrowed to `CapabilityId` before the
  tag; `gates/ports.ts` re-exports the wire's `USER_CLAIM_PURPOSES` and `PREVIEW_CAPABILITIES` under its old names.
- **The fake platform runs the wire's real checks.** It verifies every request with `verifyRequest`, answers refusals with
  `errorResponse`, keys jobs by `idempotencyScope` and checks poll tokens with `verifyPollToken`. Its route purposes are
  test choices; the wave 2 gateway decides the real ones.
- **Exports.** `./audit` is an export; the root barrel re-exports the three model barrels (no name is ambiguous, a test
  proves it).
- **`renderPptx` validates first.** It runs `checkDeckSpec` before the overlap rule and draws only the checked copy. A
  refused image or link is `blocked`, an exceeded cap `too-large`, anything else `invalid`. Unsafe links and flat non-line
  elements, which were dropped or drawn before, are now refused. Goldens are unchanged.
- **L1 as built.** `BlueOak-1.0.0` and `Zlib` are browser-allowed. The app's own jszip already ships pako's zlib port to
  the browser, so the decision covers today's bundle as well. The licence gate now records every library a bundled
  package's dist file carries (`BUNDLED_LIBRARIES` in `scripts/licence-check.mjs`: 45 under docx, 4 under jszip), judges
  each under the browser rules and fails on an unrecorded one. Notices print sax's and pako's texts under docx and jszip.
  The sax copyright line comes from its package author field (`Copyright (c) Isaac Z. Schlueter and Contributors`); sax
  1.6.1's own licence file has none.
- **Owner question (open).** docx 9.11.0's dist also carries 43 small libraries under MIT, ISC or BSD-3-Clause (polyfills,
  hashing helpers), and jszip's carries lie, immediate and setimmediate (MIT). Those licences ask for their notices in
  copies; today `THIRD-PARTY-NOTICES.txt` prints them only for sax and pako. Recommendation: print every recorded library's
  notice (a follow-up, below).
- **To confirm (W1.8): the pitch deck's numbers.**
  - `deck.export`'s 120 s is now a hard client-side limit: a timer and an `AbortController` that live only while an
    export runs. It is browser code, so the backend stays sleepable.
  - The 1 MB per-picture cap and the 30-page cap.
  - The cast slide: up to 6 characters on the slide, everyone in its speaker notes.
- **To confirm (W1.9): the compose-link caps.** `EMAIL_GMAIL_URL_MAX` (8000) and `EMAIL_MAILTO_URL_MAX` (2000) are
  PROVISIONAL. The real Gmail and mailto URL limits are UNVERIFIED.
- **W1.9's row accepts** `server/src/ai/tools/registry.catalog.test.ts` and `components/chat/widgetStudioMeta.ts`. Both
  diffs are small, and the tests they keep green would fail without them.
- **W3.2 owns the ledger-backed MeterPort.** Conformance checks 5, 10 and 11 come off the skip list then.
- **P10 fixes speaker-notes line breaks.** The vendored PptxGenJS now writes one paragraph per notes line; upstream
  put the whole text, CR/LF included, into one run. §5's list is now P0–P10.

## Consequences

**Easier:**
- A studio gets Word, PowerPoint, email drafting, governed tools and, later, engine capabilities through one manifest
  and five ports.
- A product in another repository vendors a hash-checked public release, or rebuilds identical bytes from the tag.
- The contract is pinned by fixtures and golden vectors, so drift fails CI.

**Harder:**
- Every contract change needs a fixture update and a note here.
- Minor versions can only add.
- Hosts carry the port implementations and the conformance kit.

**Ruled out:**
- a send capability anywhere;
- a platform-side model or OAuth token;
- engines inside the backend;
- hard forks of the engines;
- committing another product's internals to this public repository.

**Follow-ups:**
- notices for every library bundled inside docx and jszip (§10's owner question; recommended yes);
- the owner's confirmation of §2.3 and §6.3;
- W3.2's ledger-backed MeterPort and stranded-holds release (L3);
- deduplicating the tool schemas (L4);
- D16 (L5);
- the wave 2 gateway and engine image, after their owner decisions.
