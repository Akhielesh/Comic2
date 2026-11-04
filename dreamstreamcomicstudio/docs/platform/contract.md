# Platform wire contract, v1

What crosses HTTPS between a host (a DreamStream backend, or another product's server) and the platform gateway.
Nothing in wave 1 calls a gateway: the gateway arrives in wave 2. The wire is frozen now so that every host, the fake
platform and the gateway build against the same bytes.

**The code is the contract.** This page describes
[`packages/platform-core/src/wire/`](../../packages/platform-core/src/wire/index.ts) and
[`src/client/`](../../packages/platform-core/src/client/index.ts), with the error codes in
[`src/errors.ts`](../../packages/platform-core/src/errors.ts). The golden vectors in
[`fixtures/wire/`](../../packages/platform-core/fixtures/wire/hmac.json) pin every byte. Where this page and the code
disagree, the code wins and this page has a bug.

Related: [platform overview](README.md), [onboarding](onboarding.md), [security model](security.md),
[ADR 0008](../decisions/0008-shared-platform.md).

## 1. Versions

- Every request carries `X-Platform-Contract: 1` (`PLATFORM_CONTRACT`). A verifier refuses a contract it does not
  serve (reason `contract`). The gateway serves majors N and N−1 for at least 90 days.
- Minor versions are additive only: an optional field, a union member or an export. Nothing is renamed, removed or
  narrowed.
- The package is `@dreamstream/platform-core` 1.0.0. Releases are tagged `platform-core-v<version>` (§12).
- **A fixture change is a contract change.** It needs a note in ADR 0008.

## 2. Request headers

| Header | Value | Rule |
|---|---|---|
| `X-Platform-App` | The app id, e.g. `dreamstream` | `^[a-z][a-z0-9-]{1,31}$`. With the key id, it selects the key from the gateway's allowlist. |
| `X-Platform-Key-Id` | The key id, e.g. `ds-2026-11` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Two key ids may be live at once while a key rotates. |
| `X-Platform-Timestamp` | Decimal Unix seconds | At most 300 s from the verifier's clock (`skew`). |
| `X-Platform-Signature` | base64url HMAC-SHA256 (§3) | Exactly 43 characters: the canonical encoding of the 32-byte MAC. Any other encoding of the same bytes is refused. |
| `X-Platform-Claim` | A claim token (§5) | Required on every POST that carries a body, and wherever an endpoint asks for one. At most 4,096 characters. |
| `X-Platform-Contract` | `1` | Required. |
| `Idempotency-Key` | 1–128 characters of `[A-Za-z0-9._:-]` | Required on every POST. Optional on a GET, but checked when present. |
| `Content-Length` | Decimal bytes | Required on every POST (`length-required`). Checked against the body cap before any byte is read. |
| `X-Request-Id` | 1–128 characters of `[A-Za-z0-9._:-]` | Optional. Echoed back. |
| `X-Platform-File-Name` | `POST /v1/files` only | RFC 3986 percent-encoded UTF-8. At most 255 characters before encoding, no control characters. |
| `X-Atlas-File-Name` | `POST /v1/convert` only | The same rule as `X-Platform-File-Name`. The name is kept from the converter's established wire format. |
| `X-Atlas-Target-Format` | `POST /v1/convert` only | `html` or `pdf`. |

Only `GET` and `POST` can be signed or verified. Any other method is refused by the signer and the verifier alike.

## 3. The signed string

```
signature = base64url(HMAC-SHA256(appSecret[kid],
  "v1\n" + METHOD + "\n" + PATH + "?" + CANONICAL_QUERY + "\n" + TS + "\n" +
  hex(sha256(body)) + "\n" + (claim ? hex(sha256(claim)) : "-") + "\n" + IDEMPOTENCY_KEY))
```

- **METHOD** is `GET` or `POST`.
- **PATH** is the request path in RFC 3986 normal form: percent-escapes of unreserved characters are decoded and every
  other escape is upper-cased. Dot segments (raw or escaped), empty segments (`//`) and characters outside RFC 3986
  `pchar` are refused, never repaired. The path is at most 1,024 characters.
- **CANONICAL_QUERY** is the query read the way a server reads it (`+` is a space), then RFC 3986-encoded with
  upper-case hex, sorted by key and joined as `key=value` with `&`. It is empty when there is no query.
  - So `a+b` and `a%20b` sign alike, while `a%2Bb` (a literal plus) signs differently.
  - Empty pairs (`a=1&&b=2`) are skipped, and `?a` equals `?a=`.
  - Refused (reason `query`): a repeated key, an empty key, a malformed escape, invalid UTF-8, a `#`, raw non-ASCII,
    more than 64 parameters, or more than 2,048 characters.
  - With one value per key, no reordering can change what a server reads without changing the signature. Changing
    `?maxPages=` after signing breaks it.
- **TS** is `X-Platform-Timestamp` exactly as sent.
- **The body hash** covers the exact bytes sent. An empty body hashes the empty string.
- **The claim hash** is `hex(sha256(claim token))`, or `-` without a claim.
- **IDEMPOTENCY_KEY** is empty when the request has none.

Signatures are compared in constant time. `formatCanonicalRequest` builds the string, and `signRequest` and
`verifySignature` sign and check it.

## 4. Keys and derivation labels

Every key the wire uses comes from a secret and a fixed label, so the request-signing key never signs a string a host
supplied. The canonical string always starts with `v1\n`, which no label does.

| Key | Derivation | Used for |
|---|---|---|
| Signing key | The app secret for `(app, kid)` itself | The request signature (§3) |
| Claim key | `HMAC-SHA256(appSecret, "platform-claim-v1")` | Claim MACs (§5) |
| Poll key | `HMAC-SHA256(appSecret, "platform-poll-v1")` | Poll-token MACs (§7) |
| Sub key | `HMAC-SHA256(subSecret, "platform-sub-v1")` | `sub = hex(HMAC-SHA256(subKey, userId))[0..32]` |

- The labels are `WIRE_KEY_LABELS`. Changing one is a contract change.
- **Secrets** are at least 32 bytes. Their text form is unpadded base64url (`decodeSecret`).
- **The sub secret is the host's own** (ADR 0008, L2). It is distinct from every app signing secret, is never sent
  to the gateway, and **never rotates**: a new sub secret would give every user a new `sub` and orphan their jobs,
  files and quotas. `pseudonymousSub(crypto, subSecret, userId)` computes the sub. The platform never sees a host's
  user id.
- **The job record id** of an idempotent POST is
  `hex(sha256("platform-job-v1\n" + app + "\n" + (sub or "svc") + "\n" + idempotencyKey))` (`idempotencyScope`).
  It is scoped per caller, so two users who send the same key get two jobs, and a replay by the same caller finds the
  first one. The record keeps the body hash, and the same key with a different body is a `conflict` (409).

## 5. Claims

```
claim = base64url(json) + "." + base64url(HMAC-SHA256(claimKey, base64url(json)))
```

**User claim** (`UserClaim`). A host mints one only after its own auth.

| Field | Value |
|---|---|
| `v` | `1` |
| `kind` | `'user'` |
| `app` | The app id; it must equal `X-Platform-App` (`wrong-app`) |
| `product` | `^[a-z][a-z0-9_-]{0,31}$`, e.g. `comic`, `chat` |
| `sub` | 32 lower-case hex characters (§4) |
| `ws` | Optional: the host's workspace id, when the user acts inside one |
| `tier` | `free`, `creator`, `studio`, `admin` or `atlas-beta`. Set by the host, for the gateway's count quotas. |
| `purpose` | `compose`, `render`, `extract`, `pdf`, `export` or `job-read` |
| `caps` | Up to 32 capability ids (`^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$`, e.g. `doc.extract`) |
| `exp` | Unix seconds |
| `jti` | An id, for audit correlation only. Replay safety comes from `Idempotency-Key`. |

**Service claim** (`ServiceClaim`). It carries no user: `{v:1, kind:'service', app, product, purpose:'preview',
caps, exp, jti}`. Its `caps` hold 1 to 32 entries, all from `doc.convert`, `doc.extract` and `doc.thumbnail`
(`PREVIEW_CAPABILITIES`). Minting refuses anything else, and so does verifying, so a buggy or compromised minter
cannot widen it (`service-scope`). A service claim can never reach PDF editing, render or jobs.

**Lifetimes.** A claim lives at most 300 s. The default is 120 s, so a minter whose clock runs up to 180 s ahead
still mints an `exp` the verifier accepts.

**Verification order** (`verifyClaim`):
1. shape and size;
2. the MAC, in constant time, before the payload is even decoded;
3. the payload against its schema (exact fields, caps, unknown keys rejected);
4. the service scope;
5. the app;
6. the time window: `exp` must be after now (`expired`) and at most 300 s ahead (`exp-too-far`);
7. purpose, capability and product.

The fixture [`fixtures/wire/claims.json`](../../packages/platform-core/fixtures/wire/claims.json) pins a user
claim, a user claim with a workspace and the longest lifetime, and a service claim, plus the sub derivation.

## 6. Verifying a request: two phases

A gateway never writes a byte of an unauthenticated body anywhere.

**Phase 1, `preflightRequest`**, runs before any byte is staged. In order:
1. the signing headers are present and well formed;
2. the key ring: the app is allowlisted and the key id is known;
3. the contract;
4. the timestamp skew (±300 s);
5. the method;
6. for a POST: the `Idempotency-Key` and a decimal `Content-Length`;
7. the body cap (`maxBodyBytes`, by default 50,000,000 bytes; leaving it out never uncaps the body);
8. the claim (§5).

Its result has `stage: 'preflight'` and is **not authenticated**: anyone who has seen one claim can attach it to a
request with a made-up signature. Act on it only to stage the body.

**Phase 2, `verifyRequestSignature`**, takes the body as bytes, or as the SHA-256 hex and the byte count measured
while streaming it (`ReceivedBody`).
- The byte count must equal the declared `Content-Length` (0 for a GET). Otherwise the result is `bad-signature`.
- Then the signature is checked over the request as received.
- Only its result, `stage: 'verified'` (a `VerifiedRequest`), is an authenticated request. Downstream code takes
  only a `VerifiedRequest`. It still carries the key: never log it.
- On a failure, the gateway deletes whatever it staged.

`verifyRequest` runs both phases for a body already in memory.

**Claims on requests:**
- A POST with a body needs a claim (`claim-required`). An empty POST does not.
- An endpoint may require a claim on a GET too (`claimRequired`).
- `claim: 'none'` is for the gateway's callback, which refuses a claim header.

## 7. Poll tokens

```
token = base64url(json) + "." + base64url(HMAC-SHA256(pollKey, base64url(json)))
```

- **Payload** (`PollTokenPayload`): `{v:1, kind:'poll', app, kid, sub, jobId, exp}`. `kid` lets the verifier find the
  key during a rotation overlap.
- **Lifetime:** at most one hour; 900 s by default. A token is at most 2,048 characters.
- **Use:** a browser may call only `GET /v1/jobs/:id?t=` and `GET /v1/files/:ref?t=` with one. The gateway mints a
  token when it answers `202` (`mintPollToken`), and the client builds the browser's URL with `jobPollUrl`.
- **Verification order** (`verifyPollToken`):
  1. the method is GET (`method`);
  2. shape and size;
  3. the key, looked up from the payload's `app` and `kid` (nothing else in the payload is trusted yet);
  4. the MAC, in constant time;
  5. `exp` (`expired`, `exp-too-far`);
  6. the job id;
  7. the owner: the payload's `app` and `sub` must equal the job record's (`wrong-job`).

  The owner always comes from the job record, never from the token. For `/v1/files/:ref`, the gateway passes the id
  and owner of the job that owns the file.
- The poll key differs from the claim key, so a claim is never accepted as a poll token, or the other way round.

The fixture [`fixtures/wire/poll.json`](../../packages/platform-core/fixtures/wire/poll.json) pins two tokens.

## 8. Endpoints, as the client sees them

`createPlatformClient(config)` is server-side only, because it holds the app secret. **It never throws**: every call
resolves to `{ok: true, …}` or a `WireFailure`. It refuses before sending:
- a POST without an `Idempotency-Key`;
- a POST with a body but no claim;
- a body over 50,000,000 bytes;
- a header value that is not printable ASCII.

It always sends `redirect: 'error'`, so a redirect can never carry a signed request to another host.

| Call | Request | A good answer |
|---|---|---|
| `convert` | `POST /v1/convert`: raw bytes, `Content-Type`, `X-Atlas-File-Name`, `X-Atlas-Target-Format` | 200 with `application/pdf` (starting `%PDF-`), `text/html` or `text/plain`. Synchronous, never 202. HTML stays server-to-server; re-sanitise it before showing it. |
| `extract` | `POST /v1/extract[?maxPages=1..300]`: raw bytes (the gateway's default is 24 pages) | 200 JSON `{plainText, sections: [{id, title, kind, content, pageNumber?}], pageCount, truncated, engine}` within `EXTRACT_RESULT_LIMITS`. The text is untrusted data. |
| `uploadFile` | `POST /v1/files`: raw bytes, `X-Platform-File-Name` | 200/201 JSON `{fileRef, sha256, bytes, sniffed}`. `sha256` and `bytes` must match exactly the bytes sent. |
| `downloadFile` | `GET /v1/files/:ref` (optionally with a `job-read` claim) | 200 with one of `SERVED_FILE_TYPES`: PDF, DOCX, PPTX, PNG, JPEG, WebP or PSD. Never HTML or SVG. |
| `pdf` | `POST /v1/pdf`: JSON `{fileRef, job: {op, …}}` | 200 JSON `{fileRef, report}`, or 202 `{jobId, pollToken}`. The original is never modified. |
| `render` | `POST /v1/render`: JSON `{kind: 'docx' \| 'pdf' \| 'pptx', spec}` | 200 bytes of the asked kind (`PK\x03\x04` for DOCX and PPTX, `%PDF-` for PDF) with the matching media type, at most 10,000,000 bytes (`RENDER_MAX_BYTES`); or 202 with a job. Attachments only: email bodies never come here. |
| `jobs.create` | `POST /v1/jobs`: JSON `{op, input}` | 200/201/202 JSON `{jobId, pollToken, state}` |
| `jobs.get` | `GET /v1/jobs/:id` (optionally with a `job-read` claim) | 200 JSON `{state, progress: 0..1, result?, error?: {code, message}}` |

- **Job states** are `queued`, `running`, `succeeded` and `failed` (`JOB_STATES`).
- **An answer that breaks these rules** is a failure with reason `response` (code `engine-failed`). That covers a
  wrong shape, a cap exceeded, wrong magic bytes or a refused media type.
- **Response headers** the client reads:

  | Header | Meaning |
  |---|---|
  | `X-Platform-Engine` | The engine that did the work, e.g. `pdfcraft@0.15.0` |
  | `X-Platform-Warnings` | A URL-encoded JSON array of strings. At most 32 warnings of 500 characters are kept, and anything malformed reads as none. |
  | `X-Platform-Cost-Micros` | A whole number. Server-to-server only, and never shown to a governed user. |
  | `X-Request-Id` | Echoed |

- **The completion callback** is used only if async callbacks are adopted. It is a signed POST from the gateway, with
  an `Idempotency-Key` and no claim, of at most 65,536 bytes. Its JSON is exactly
  `{type: 'platform.job.completed', jobId, app, state: 'succeeded' | 'failed', resultRef?, error?, finishedAt}` for
  the signing app (`verifyCallback`).

## 9. Errors

**Error body:** `{error: {code, message, retryable, requestId}}`.

| Code | HTTP | Retryable | Retry rule | Meaning |
|---|---|---|---|---|
| `invalid` | 400 | no | — | — |
| `unauthorized` | 401 | no | — | — |
| `forbidden` | 403 | no | — | — |
| `not-found` | 404 | no | — | — |
| `conflict` | 409 | no | — | An `Idempotency-Key` reused with a different body, a stale op, or an already-used plan reservation |
| `too-large` | 413 | no | — | — |
| `unsupported` | 415 | no | — | — |
| `input-rejected` | 422 | no | — | The engine's preflight refused the input (a zip bomb, a 60 MP image, a broken PDF) |
| `quota` | 429 | yes | After the quota window resets | — |
| `engine-failed` | 502 | yes | Once | — |
| `disabled` | 503 | yes | With backoff | A capability is switched off or draining |
| `timeout` | 504 | yes | With backoff | — |

**Reading an error.** The client reads an error body defensively: a body over 64 KB, a body that is not JSON or an
unknown code reads as no body. A non-2xx answer without a platform body maps by status: every status in the table
above maps to its own code (for example 429 → `quota`, 503 → `disabled`), any other 4xx → `invalid`, and any other
5xx or a 3xx → `engine-failed`. So an edge proxy's own 413, 429 or 504 page maps the same way. `retryable` always
follows the code's rule.

**Refusal reasons.** Every refusal is a `WireFailure`: `{ok: false, code, message, retryable, reason, status?,
requestId?}`. `WIRE_REASON_CODES` fixes the code for each reason (`WIRE_REASONS`):

| Code | Reasons |
|---|---|
| `unauthorized` | `missing-header`, `malformed`, `unknown-key`, `bad-signature`, `skew`, `expired`, `exp-too-far`, `claim-required`, `wrong-app` |
| `forbidden` | `wrong-purpose`, `capability`, `wrong-product`, `service-scope`, `wrong-job`, `method` |
| `invalid` | `idempotency-key`, `length-required`, `path`, `query`, `contract`, `input` |
| `too-large` | `too-large` |
| `engine-failed` | `network` (retryable), `response`, `internal`, and `gateway` (the gateway answered with an error; its code wins) |

A signing or minting call refuses bad input with `invalid`, whatever the verifier would answer for the same fault,
because the caller is at fault, not an attacker. A network failure is `{code: 'engine-failed', retryable: true}`.

## 10. Limits

Every bound the wire enforces is in `WIRE_LIMITS`. MB is 10^6 bytes, as everywhere in the contract.

| Limit | Value |
|---|---|
| Timestamp skew | 300 s |
| Claim lifetime | at most 300 s; 120 s by default |
| Poll-token lifetime | at most 3,600 s; 900 s by default |
| `Idempotency-Key` | 128 characters |
| Claim token / poll token | 4,096 / 2,048 characters |
| Capabilities per claim | 32 |
| Secret | at least 32 bytes |
| Path / raw query / query parameters | 1,024 characters / 2,048 characters / 64 parameters |
| Request body | 50,000,000 bytes |
| Response body read by the client | 64,000,000 bytes by default (`render`: 10,000,000) |
| `?maxPages=` on extract | 24 by default, at most 300 |
| Warnings read | 32, of at most 500 characters each |
| File name | 255 characters before percent-encoding |
| Error message kept | 2,000 characters |
| Callback body | 65,536 bytes |

**How the client caps a response.** It refuses an answer before reading when `Content-Length` says it is too big. It
also refuses while reading when the response exposes a body stream, as fetch's own `Response` does. Otherwise it can
check only after reading the whole body, so a host whose `fetch` returns no stream should wrap it with a size-limiting
reader.

## 11. Fixtures: the contract by example

| Fixture | What it pins |
|---|---|
| [`fixtures/wire/hmac.json`](../../packages/platform-core/fixtures/wire/hmac.json) | Six request-signing vectors: a GET, a POST with a sorted query, a claim and a key, the same POST with `maxPages=300`, the query rules (`+`, escapes, empty values, UTF-8), path escapes, and a JSON body with non-ASCII text |
| [`fixtures/wire/claims.json`](../../packages/platform-core/fixtures/wire/claims.json) | The claim key, the sub derivation and three claims |
| [`fixtures/wire/poll.json`](../../packages/platform-core/fixtures/wire/poll.json) | The poll key and two tokens |

**`fixtures/wire` is the wire contract by example.** It was computed once by an independent `node:crypto` script,
uses synthetic secrets only, and runs under both `node:crypto` and WebCrypto adapters. Every host should run it under
its own crypto; conformance check 7 does.

The document models have their own contract fixtures, and a change to any of them is a contract change too:
- `fixtures/contract/` holds every block, element, layout and op;
- `fixtures/schema/` holds the DSL's invalid and valid cases and the JSON Schema snapshots;
- `fixtures/models/` holds hostile documents and golden apply and undo cases;
- `fixtures/email/` holds hostile input, a creator BrandKit and golden renders.

**Email drafts never cross the wire.** Hosts render and review them in process with `renderEmail` and `reviewEmail`.
The rules that make that safe are in [security.md](security.md#email-drafts). Two rules matter to every composer:
- **Links.** The review lists every `https:` and `mailto:` link, with its full URL, in document order. That covers
  runs in headings, paragraphs, quotes and list items (inside columns too) and buttons.
- **Display names.** A participant's display name is pre-filled only when it is one line with no control or bidi
  characters, and never from text the model wrote.

## 12. Releases

The tag `platform-core-v<version>` runs
[`.github/workflows/release-platform-core.yml`](../../../.github/workflows/release-platform-core.yml). It attaches
four files to the GitHub Release:
- `platform-core-<version>.tgz`: the sources as they are, where every relative import ends in `.js`;
- `platform-core-bundler-<version>.tgz`: the same sources without the `.js` suffixes;
- `MANIFEST.json`: the version, the git SHA, `clean: true`, and the sha256 of each tarball and of every file in it;
- `SHA256SUMS`.

Consumers download them with no token and check `SHA256SUMS` and `MANIFEST.json`. A consumer can also rebuild the
same bytes from the tag with
`node dreamstreamcomicstudio/packages/platform-core/scripts/export.mjs --out dist`.
