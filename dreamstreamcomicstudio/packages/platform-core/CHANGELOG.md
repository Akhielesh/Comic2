# Changelog

All notable changes to `@dreamstream/platform-core`. Semver; minor versions are additive only. A change to
`src/contract/**` or `fixtures/**` is a contract change and is noted in ADR 0008.

## 1.0.0 — unreleased (wave 1)

Tagged `platform-core-v1.0.0` after admin QA.

### Kernel (W1.1)

- **Contract v1, frozen** (`src/contract/**`): the schema DSL's node types, `Infer`, `CheckResult` / `CheckError` /
  `CHECK_ERROR_CODES` and `JsonSchemaTarget`; the shared model primitives (`Run`, `RunMark`, `SafeLink`, `SafeHref`,
  `ListItem`, `TableCell`, `TableRow`, `HexColor`, `AssetRef`) and op envelope (`OpId`, `OpActor`, `OpBase`,
  `OpRejection`, `OpResult`); RichDoc v1 (`DocSection`, seven block types including comic `script`, `DocOp`,
  `DocSuggestion`); DeckSpec v1 (`Slide`, five element kinds on `DeckRect` fractions, `DeckOp`, `OverlapPair`);
  EmailDoc v1 (eight block types, `AttachmentSpec`, `EmailOp` with `set_recipients` for `actor: 'user'` only) and the
  render/review result types (`RenderedEmail`, `EmailReviewContext`, `EmailReview`); the caps of every model
  (`SCHEMA_LIMITS`, `MODEL_LIMITS`, `RICHDOC_LIMITS`, `DECK_LIMITS`, `EMAIL_LIMITS`).
- **Contract fixtures** for every block, element, layout and op.
- **Schema DSL** (`s`, `check`, `toJsonSchema`, `assertSchema`): mandatory caps, unknown keys rejected, strict /
  MCP / flattened-llm JSON Schema.
- **Errors**: `PLATFORM_ERROR_CODES` with HTTP status and retry rule, `platformErrorBody`, `platformFailure`,
  `platformErrorCodeForStatus`, `SchemaDefinitionError`.
- **Scripts**: `check-consumers.mjs` (pure, Comic2 web, an Atlas-shaped tsconfig over both flavours, the backend with
  strict off and on) and `export.mjs` (both tarball flavours, `MANIFEST.json`, `SHA256SUMS`; byte-deterministic).

### Contract review before the freeze (W1.1 fixes; each is noted in ADR 0008)

- **RichDoc:** `remove_section` (`DocRemoveSectionOp`, in `DocOp`), so `insert_section` has an inverse; `Section` as
  the plan's name for `DocSection` (a type alias). Fixture: `richdoc/ops.json` gains `remove_section`.
- **EmailDoc:** `EmailAttachOp.index?` (insert position; absent appends), so `detach` has an exact inverse;
  `AgentEmailOp` (every `EmailOp` except `set_recipients`) for model-facing tool inputs. Documented: the block ops
  address top-level blocks only, and an absent `cc` / `bcc` in `set_recipients` clears that field. Fixture:
  `email/ops.json` gains an `attach` with `index`.
- **Op rules:** accepting a `DocSuggestion` re-stamps its `baseRev` to the current `rev` once its targets are checked,
  so accepting one never makes the others stale; every op's inverse is in its own union.
- **Caps:** `SCHEMA_LIMITS.assetDataMaxBytes` is 5,000,000 (5 MB as the plan counts it), not 5 MiB.
- **Links:** a `mailto:` query may set only `subject` and `body` (any case); `to`, `cc`, `bcc`, other headers, a
  percent-encoded field name and an encoded line break in the subject are refused. Fixtures: 5 invalid, 1 valid.
- **llm JSON Schema:** `toJsonSchema(…, {target: 'llm'})` throws `SchemaDefinitionError` when union variants or tuple
  items give one field two JSON types (it used to emit a property with no `type`).
- **export.mjs:** `MANIFEST.json` always carries `clean` (`true`, `false`, or `null` outside a git checkout), so
  `--git-sha <HEAD>` and a plain run write the same bytes; the test now pins every tar header field and the gzip
  MTIME, and accepts the conformance kit's `*.test.ts`.
