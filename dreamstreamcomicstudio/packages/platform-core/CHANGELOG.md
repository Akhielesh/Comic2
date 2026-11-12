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

### Models (W1.2)

- **Barrels** `./models/richdoc`, `./models/deck`, `./models/email` (also on the root barrel): the schemas
  (`RichDocSchema`, `DeckSpecSchema`, `EmailDocSchema` and their block, op and agent variants), `checkRichDoc` /
  `checkDeckSpec` / `checkEmailDoc` and the op and suggestion checks (schema plus refinements), `migrate*` (v1 only),
  `applyDocOps` / `applyDeckOps` / `applyEmailOps`, `invert*Op(s)`, `acceptDocSuggestion`, `overlapCheck` /
  `deckOverlaps`, `stampAgentEmailOp`, `emailBodyTextLength` with `EMAIL_TEXT_ALLOWANCE` and `listPrefixWidth`.
- **Op rules:** pure; never throws (unreadable input is refused); the same reference when nothing applies;
  `baseRev` / `rev` as in `OpBase`; each op id at most once, including the host's log (`{seenOpIds}`; required by
  `acceptDocSuggestion`, which checks the targets, then re-stamps); `invert*Ops` returns checked ops or `null`; at
  most 1,000 ops per call.
- **Refinements:** deck rects inside the slide; chart series as long as the categories; only a `line` shape may be
  flat; the email body's plain text (laid out as `emailToPlainText` writes it) at most 10,000 characters; an
  attachment's kind matches its spec; an empty `attachments` list is invalid (absent means none); repeated ids and
  marks are refused.
- **Fixtures** `fixtures/models/**`: hostile documents, page-break and SmartArt-over-chart, apply/undo goldens.

### Email, brand and prompts (W1.3)

- `renderEmail`, `emailToPlainText`, `reviewEmail` (plus `addressesIn`, `mailtoRecipients`, `EMAIL_WARNING_CODES`):
  escaped text, `https:` / `mailto:` links all listed by the review, only sniffed `data:` images, no network,
  deterministic bytes; model-only addresses are flagged and never prefilled; reply modes prefill nothing.
- The 9 templates (`fillTemplate`, `fillEmailTemplate`, typed `EmailTemplateSlots`).
- BrandKit (`DREAMSTREAM_BRAND`, `ATLAS_BRAND`, `checkBrandKit`, `contrastRatio`), the skins (`DREAMSTREAM_SKIN`,
  `ATLAS_SKIN`) and the font registry with reserved-font-name flags. `checkBrandKit` also checks document sizes
  (whole points 6 to 96), line spacing (1 to 3), the accent colour and the deck theme preset, and refuses unknown
  fields.
- Prompt packs `emailDraft.v1` and `deckOutline.v1` (`buildPrompt`, `parseModelJson`, `repairMessage`, `trimThread`,
  `outlineToDeck`). A deck outline has at most 12 content slides, 100-character bullets and 500 characters of notes;
  its budget is 8,000 output tokens.
- Fixtures `fixtures/email/**` with golden HTML and text hashes.
- Skins: the colour-layer tokens (--ds-spark, --ds-spark-hover, --ds-on-spark, --ds-spark-text, --ds-spark-soft,
  --ds-spark-glow, --ds-hue-1…5, --ds-art) in both skins, a DreamStream extension not from Atlas; DREAMSTREAM_SKIN
  --ds-info / --ds-info-text are now neutral (#525252 / #404040 light, #e5e5e5 dark). Atlas may consume
  DREAMSTREAM_SKIN / ATLAS_SKIN as package API (CL-0, S2a). Both skins also carry the art develop tokens
  (--ds-develop-light, --ds-develop-sheen; MO-1), another DreamStream extension.
- Skins: `--ds-z-dialog: 88` in both skins (DS-1c, S2b), the dialog scrim's own step above the sheets (86) and under
  the popover (90), so a confirm opened from a phone sheet is never under it. Additive; every other z step is unchanged.

### Governance (W1.4)

- The capability registry, product manifests (`defineProduct`), agent tools with `toChatSpec` / `toDirectorSpec` /
  `toMcpTool` and `bindTools`, `decideGate` with its floors, consent (`DraftAction`, `ConsentRecord`,
  `executeExternalWrite`), host ports, `usageLabel` / `costLabel`, audit events and `inputHash`, flows (`runFlow`,
  plan tokens), the fakes in `./testing` and the conformance kit.

### Wire and client (W1.5)

- `signRequest` / `verifySignature`, `canonicalQuery` / `canonicalPath`, `mintUserClaim` / `mintServiceClaim` /
  `verifyClaim`, `mintPollToken` / `verifyPollToken` (with the job record's `owner`), `preflightRequest` /
  `verifyRequestSignature` / `verifyRequest` (`VerifiedRequest`, `VerifiedRequestResult`, `ReceivedBody`),
  `idempotencyScope`, `pseudonymousSub`, `errorResponse` / `failureFromResponse`.
- `createPlatformClient` (never throws; refuses a POST without an Idempotency-Key or a body POST without a claim),
  `verifyCallback`, `SERVED_FILE_TYPES`, `RENDER_MAX_BYTES`.
- Fixtures `fixtures/wire/{hmac,claims,poll}.json`: the golden vectors.

### Contract additions before the tag (stage C; each is noted in ADR 0008)

- **`CHECK_ERROR_CODES` gains `duplicate-id`** (amendment A1, additive: appended after the frozen codes, none renamed or
  reordered). `checkRichDoc`, `checkDeckSpec` and `checkEmailDoc` refuse a repeated section, block, slide, element or
  attachment id, and a run that names a mark twice (A2), with `duplicate-id` at the repeated item's `id` (or at that
  `marks`), where the interim build used `too-many`. `check()` alone never raises it. Fixture: the 11 repeated-id and
  repeated-mark cases of `models/invalid.json` now carry `duplicate-id`.
- **`./audit`** is an entry point of its own (`src/audit/index.ts`; still re-exported by `./gates`).
- **The root barrel** re-exports the three model barrels (no name collides; a test checks every export).
- **One definition of the claim vocabulary:** `CLAIM_PURPOSES` and `SERVICE_PREVIEW_CAPS` in `./gates` are the wire's
  `USER_CLAIM_PURPOSES` and `PREVIEW_CAPABILITIES` (same names, same values); `ClaimCapability` is now `CapabilityId`
  (a type narrowing before the tag), and every preview capability is a registered one.
- **The fakes use the wire.** `createFakeIdentity` mints with `mintUserClaim` / `mintServiceClaim` (sub from
  `pseudonymousSub` with its own sub secret; the wire's 120 s default lifetime). `createFakePlatform` checks every
  request but health and poll-token reads with `verifyRequest` (so requests must be signed), answers refusals with
  `errorResponse`, uses `idempotencyScope` as the job id and mints and checks poll tokens with the wire.
  New test helpers: `FAKE_WIRE_CRYPTO`, `FAKE_APP_SECRET`, `FAKE_KEY_ID`, `FAKE_SUB_SECRET`, `fakeSub`,
  `fakeKeyRing`, `fakeClientConfig` (the real client against the fake).

### Release (W1.11)

- `.github/workflows/release-platform-core.yml` attaches both flavours, `MANIFEST.json` (`clean === true` asserted)
  and `SHA256SUMS` to the GitHub Release of a `platform-core-v<version>` tag.
- `docs/platform/contract.md` is the public wire contract.
