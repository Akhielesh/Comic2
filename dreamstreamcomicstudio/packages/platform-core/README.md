# @dreamstream/platform-core

The DreamStream platform contract: one pure TypeScript package that every studio, the backend and external
consumers share. It holds the document models (RichDoc, DeckSpec, EmailDoc), the schema DSL that validates them, the
email renderer and recipient/link review, tool schemas, gates and cost wording, flows, and the wire protocol. Hosts
keep their own auth, models, money and consent; nothing here calls an LLM, holds a token, fetches a URL or sends.

## Rules

- **Pure.** `tsconfig.json` compiles `src/` against the **ES2017 library alone** (`types: []`): no DOM, no Node, no
  Workers types, no dependencies. `Object.fromEntries`, `.flat`, `.replaceAll`, `.at` and `structuredClone` do not
  exist here. Crypto, fetch and clocks are injected by the host.
- **Every relative import ends in `.js`** (`from './schema/index.js'`). The backend compiles these files under
  `Node16` resolution, where an extensionless import is error TS2835. `src/purity.test.ts` fails on one.
- **Every string and array has a cap.** `s.text({max})` and `s.array(items, {max})` throw `SchemaDefinitionError`
  without one; `s.email()`, `s.link()`, `s.id()` and `s.assetRef()` carry built-in caps.
- **No URL fields.** Links are `https:` or `mailto:` only (`s.link()`; a `mailto:` query may set only `subject` and
  `body`, never another recipient); images are `data:` URIs (PNG, JPEG or WebP, sniffed, at most 5 MB = 5,000,000
  bytes decoded) or host asset ids (`s.assetRef()`). Renderers never fetch or read paths.
- **No send.** There is no send tool, mode, op or field. Agents draft; people send from their own client. A
  model-facing tool takes `AgentEmailOp` (every email op except `set_recipients`), never `EmailOp`.

## Layout

| Path | What it is |
|---|---|
| `src/contract/{schema,richdoc,deck,email}.ts` | **The frozen public types and caps** (contract v1): the DSL's node types and `Infer`; the shared model primitives (`Run`, `SafeLink`, `AssetRef`, `ListItem`, `TableRow`) and op envelope (`OpBase`, `OpRejection`, `OpResult`); RichDoc, DeckSpec and EmailDoc v1 with their ops; the email render/review result types |
| `src/schema/` | `s` (the DSL), `check()` (the validator), `toJsonSchema()` (`strict`, `mcp`, `llm`), `assertSchema()` |
| `src/errors.ts` | The platform error codes with their HTTP status and retry rule, the error body, `PlatformFailure`, `SchemaDefinitionError` |
| `src/index.ts` | The root barrel: contract, schema, errors and the three model barrels |
| `src/models/{common,richdoc,deck,email}` | Schemas (`Infer` = contract), `check*` / `migrate*` (schema plus refinements), `apply*Ops` with exact inverses, `overlapCheck` / `deckOverlaps`, `stampAgentEmailOp` |
| `src/email` | `renderEmail`, `emailToPlainText`, `reviewEmail` (recipients and links), the 9 templates |
| `src/brand` (+ `skins/`) | BrandKit (`DREAMSTREAM_BRAND`, `ATLAS_BRAND`, `checkBrandKit`), the two skins, the font registry |
| `src/prompts` | Versioned prompt packs (`emailDraft.v1`, `deckOutline.v1`), `buildPrompt`, `parseModelJson`, `repairMessage` |
| `src/capabilities.ts`, `src/products.ts`, `src/tools`, `src/gates`, `src/cost`, `src/audit`, `src/flows` | Governance: the capability registry, product manifests, agent tools and their projections, gates and consent, host ports, usage wording, content-free audit events, flows and plan tokens |
| `src/wire` | Canonical request signing, claims, poll tokens, headers and errors; crypto, fetch and the clock are injected |
| `src/client` | The never-throwing gateway client; server-side only, because it holds the app secret |
| `src/testing`, `conformance/` | Fake host ports, the fake `/v1` platform (on the wire's verifier), the conformance kit and its tests |
| `fixtures/contract/` | Valid documents and ops for every block, element, layout and op: **the contract by example** |
| `fixtures/schema/` | The DSL's 55 invalid and 20 valid cases (path and code), and the `toJsonSchema` snapshots |
| `fixtures/models/` | Hostile documents (`invalid.json`, path and code each), the page-break and SmartArt-over-chart fixtures, golden apply/undo cases |
| `fixtures/email/` | Hostile and brand fixtures and the golden renders (HTML and text SHA-256); regenerate with `UPDATE_EMAIL_GOLDEN=1 npx vitest run packages/platform-core/src/email/render.test.ts` |
| `fixtures/wire/` | Golden vectors for request signatures, claims and poll tokens |
| `scripts/check-consumers.mjs` | Compiles the sources the way each consumer does |
| `scripts/export.mjs` | Writes the two release tarballs, `MANIFEST.json` and `SHA256SUMS` |

## The schema DSL

```ts
import { check, s, toJsonSchema, type Infer } from '../../packages/platform-core/src/index.js';

const Note = s.object({
  title: s.text({ max: 120, singleLine: true }),
  tags: s.optional(s.array(s.text({ max: 24 }), { max: 8 })),
  link: s.optional(s.link()),
});
type Note = Infer<typeof Note>; // { title: string; tags?: string[]; link?: string }

const r = check(Note, JSON.parse(body));
if (r.ok === false) return reply(400, r.errors); // [{ path: 'tags[2]', code: 'too-long', message }]
use(r.value); // a fresh plain copy: unknown keys were rejected, not dropped

toJsonSchema(Note, { target: 'llm' }); // flat: function-calling dialects accept it
toJsonSchema(Note, { target: 'mcp' }); // an MCP tool inputSchema (JSON Schema 2020-12, no $schema)
toJsonSchema(Note, { target: 'strict' }); // full JSON Schema 2020-12
```

Constructors: `s.object`, `s.array({max})`, `s.tuple`, `s.text({max})`, `s.id`, `s.enum`, `s.literal`,
`s.union(tag, variants)`, `s.int`, `s.number`, `s.bool`, `s.email`, `s.link`, `s.assetRef`, `s.optional`.

`check()` never throws on a bad value. It rejects unknown keys (an own `__proto__` key included), non-plain objects,
control characters, bidi overrides and unpaired surrogates in text, line breaks in `singleLine` text, `http:`,
`javascript:` and `data:` links, links with `user@` before the host, `mailto:` links whose query sets anything but
`subject` and `body` (a `to`, `cc` or `bcc` there would add a recipient), email addresses that carry a display name or
a header line, and `data:` images whose bytes are not what their MIME type says. `toJsonSchema(…, {target: 'llm'})`
throws when two union variants (or tuple items) give one field two JSON types, because the flat form would leave that
property without a `type`. `maxNodes` (default 200,000) bounds the
work. With `strict` off (the backend), narrow a result with `r.ok === false`; `r.errors` and `r.value` are readable
either way.

## Consumers

- **The wire contract** is [docs/platform/contract.md](../../docs/platform/contract.md): what a host and the platform
  send each other, as the code defines it.
- **Keep `./client` in server-only code.** It holds the app secret, so it never belongs in a browser bundle.
- **Inside this repo**, import by relative path, always with `.js`: from `server/src/ai/tools/` that is
  `'../../../../packages/platform-core/src/index.js'` (or a subpath such as `src/email/index.js`).
- **Outside this repo**, vendor a release: `node packages/platform-core/scripts/export.mjs --out dist` writes
  `platform-core-<ver>.tgz` (sources as they are), `platform-core-bundler-<ver>.tgz` (the same with the `.js`
  suffixes stripped, for a bundler that does not map `.js` to `.ts`), `MANIFEST.json` (version, git SHA, the sha256 of
  each tarball and of every file in it) and `SHA256SUMS`. The output is byte-identical on every run and machine (fixed
  tar headers, gzip with stored blocks), so a consumer can rebuild it from the tag and compare. Shipped: `package.json`,
  this README, `CHANGELOG.md`, `src/**` except tests, `fixtures/**` and `conformance/**`.
- `npm run check:consumers` (in this folder) compiles the sources as each consumer does: `pure` (ES2017 alone),
  `comic2-web` (ES2022 + DOM, React 19, bundler), `atlas` and `atlas-bundler-flavour` (a synthetic Next.js-style
  tsconfig, `scripts/tsconfig.atlas.json`: lib `dom`, `dom.iterable`, `es2017`; bundler resolution; isolated modules;
  strict; over both flavours), and `dreamstream-server` / `dreamstream-server-strict` (Node16 module and resolution,
  Node types, strict off and on).

## Versioning

- Semver, tagged `platform-core-v<ver>`. The wire carries `X-Platform-Contract: 1`; minor versions are **additive
  only**: add an optional field, a union member or an export, never rename, remove or narrow one.
- `src/contract/**` is frozen: W1.2–W1.5 and W1.7 build against it. A change there, or to any file under `fixtures/`,
  is a contract change and needs a note in ADR 0008.
- Every model carries `v` and gets a pure, fixture-tested `migrate()`; prompt packs are versioned by name
  (`emailDraft.v1`).

## Op rules (contract/schema.ts `OpBase`)

- An op applies only while `op.baseRev === doc.rev` (absent `rev` is 0) at the start of the `apply*Ops` call; a call
  that applies at least one op bumps `rev` by 1, so a replayed batch is refused as `stale`.
- Accepting a `DocSuggestion` re-stamps its op's `baseRev` to the current `doc.rev` after checking that its target ids
  still exist, so accepting one suggestion never makes the others stale.
- Every op has an exact inverse in its own union: `insert_block` ↔ `remove_block`, `insert_section` ↔
  `remove_section`, `add_slide` ↔ `remove_slide`, `attach` ↔ `detach` (the inverse `attach` carries the old
  `index`); `update_*`, `set_*` and `move_slide` invert to themselves.
- Email block ops address top-level blocks only (a block inside `columns` changes through an `update_block` of its
  `columns` block); `set_recipients` replaces `to`, `cc` and `bcc` together, and an absent `cc` / `bcc` clears it.
- `apply*Ops(doc, ops, {seenOpIds})` takes the host's op log: an op id in it is refused as `duplicate`, so a retried
  or re-stamped op still applies at most once. `acceptDocSuggestion` requires that log.
- `apply*Ops` is pure and never throws: unreadable input is refused, and a call that applies nothing returns the same
  document reference. `invert*Ops` returns checked ops or `null`.
- Ids are unique where they name something (sections, blocks, slides, a slide's elements, attachments) and a run
  names each mark once: the `check*` functions refuse a repeat as `duplicate-id`.

## Wire

- **Signed requests.** `X-Platform-Signature` is `base64url(HMAC-SHA256(secret, canonical))`, where canonical is
  `"v1\n" + METHOD + "\n" + PATH + "?" + CANONICAL_QUERY + "\n" + TS + "\n" + hex(sha256(body)) + "\n" +
  (claim ? hex(sha256(claim)) : "-") + "\n" + IDEMPOTENCY_KEY`, the query sorted by key and RFC 3986-encoded.
- **Derived keys.** The claim key is `HMAC(appSecret, "platform-claim-v1")`, the poll-token key
  `HMAC(appSecret, "platform-poll-v1")`. A claim's `sub` is `hex(HMAC(HMAC(subSecret, "platform-sub-v1"), userId))`
  cut to 32 characters, where `subSecret` is the host's own, never rotates and differs from every signing secret.
- **Two-phase verify.** `preflightRequest` checks everything but the body before anything is stored;
  `verifyRequestSignature` checks the signature over the received bytes; `verifyRequest` runs both for a body in memory.
- `fixtures/wire/` are the golden vectors: a change there is a contract change.
- `maxResponseBytes`: refused before reading when Content-Length says so; while reading when the response exposes a
  body stream (fetch's Response does); otherwise only after reading the whole body. A host whose fetch returns no
  stream should wrap it with a size-limiting reader.
- With `strict` off, narrow every result with `r.ok === false`.

## Tests

`npx vitest run packages/platform-core` (from the app root): every invalid fixture rejected at its exact path and code,
schemas without caps throwing, unknown keys rejected at every depth, the `toJsonSchema` snapshots, `Infer` equal to the
frozen contract types, every contract fixture valid, the purity rules (AST-based), `check-consumers` for every target
plus planted ES2018+ APIs and an extensionless import failing, and two exports byte-identical. Then the layers on
top: the model tests (hostile documents, purity under frozen inputs, apply and undo goldens, overlaps); the email
goldens and the property that `emailToPlainText(d)` never exceeds `emailBodyTextLength(d)`; governance and the
conformance kit; the wire's golden vectors under node:crypto and WebCrypto adapters, and the client end to end
through the wire's verifier and the fake platform.
