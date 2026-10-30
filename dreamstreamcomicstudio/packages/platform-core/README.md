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
| `src/index.ts` | The kernel barrel: contract, schema, errors |
| `src/models/*`, `src/email`, `src/brand`, `src/prompts`, `src/tools`, `src/gates`, `src/cost`, `src/flows`, `src/wire`, `src/client`, `src/testing` | Built on the contract by the following wave-1 packages; each has its own entry point in `package.json` `exports` |
| `fixtures/contract/` | Valid documents and ops for every block, element, layout and op: **the contract by example** |
| `fixtures/schema/` | The DSL's 55 invalid and 20 valid cases (path and code), and the `toJsonSchema` snapshots |
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

- **Inside this repo**, import by relative path, always with `.js`: from `server/src/ai/tools/` that is
  `'../../../../packages/platform-core/src/index.js'`. Nothing in the apps imports it yet.
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

## Tests

`npx vitest run packages/platform-core` (from the app root): every invalid fixture rejected at its exact path and code,
schemas without caps throwing, unknown keys rejected at every depth, the `toJsonSchema` snapshots, `Infer` equal to the
frozen contract types, every contract fixture valid, the purity rules (AST-based), `check-consumers` for every target
plus planted ES2018+ APIs and an extensionless import failing, and two exports byte-identical.
