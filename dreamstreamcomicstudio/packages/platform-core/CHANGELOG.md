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
