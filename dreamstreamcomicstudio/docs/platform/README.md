# The DreamStream platform

One owned docs, design and agent platform that every studio shares: Comic, Chat, Stream and every future studio. A
product in another repository can share it too. Nobody rebuilds Word, PowerPoint or email drafting per studio.

**What we own is the contract:**
- the document models;
- the tools an agent may call;
- the approval and budget rules and their wording;
- the brand;
- the wire between a host and the platform;
- the release.

**Hosts keep what is theirs:** each app keeps its own auth, model, budget, connectors, storage and consent. The
platform never logs anyone in, holds an OAuth token, calls a model, spends money or sends anything.

| Page | What it covers |
|---|---|
| [contract.md](contract.md) | The wire contract: headers, the signed string, derivation labels, claims, poll tokens, errors and reasons, limits and fixtures |
| [onboarding.md](onboarding.md) | How a studio or a future product onboards, in seven steps |
| [security.md](security.md) | The threat model, the holes wave 1 fixes, and the licence gate |
| [ADR 0008](../decisions/0008-shared-platform.md) | Why it is built this way, and every contract decision and amendment of wave 1 (Proposed) |

**The code:**
- [`packages/platform-core`](../../packages/platform-core/README.md) is the contract, in pure TypeScript with no
  dependencies: models, schema DSL, email, brand, prompts, tools, gates, cost, flows, wire, client and testing. See
  also its [CHANGELOG](../../packages/platform-core/CHANGELOG.md).
- [`packages/platform-render`](../../packages/platform-render/README.md) holds the light renderers: RichDoc to DOCX,
  DeckSpec to PPTX, and Markdown to RichDoc. They run in the browser, lazy-loaded.

## What wave 1 ships

Wave 1 is a value slice inside this repository, behind flags, with no new infrastructure:

- **The contract** (`packages/platform-core`, version 1.0.0):
  - **The document models:** RichDoc, DeckSpec and EmailDoc, with pure ops, exact undo and an overlap check for
    decks.
  - **The capped schema DSL** that validates them, with JSON Schema projections for function calling and MCP.
  - **Email:** a renderer and a recipient and link review, nine templates, the BrandKit, a font registry and prompt
    packs.
  - **Governance:** the capability, product and tool registries, gates and consent, governed usage wording, and the
    flow runner with single-use plan tokens.
  - **The wire and client,** a fake platform and a conformance kit.
- **Browser exports** (`packages/platform-render` and `services/platformExport.ts`): Word (.docx) and PowerPoint
  (.pptx), lazy-loaded so the entry bundle does not grow.
- **Chat tools** `email_draft` and `deck_create`, with their cards, and a Word download for chat documents
  ([Chat tools](#chat-tools)).
- **A comic pitch deck** (.pptx) from the reader's export menu ([Pitch deck](#pitch-deck-pptx)).
- **The `convert_image` hardening:** a magic-byte allowlist plus process-wide loader blocks. See
  [security.md](security.md#holes-fixed-in-wave-1).
- **The licence gate** over npm, the browser bundle, engines and data assets, with generated third-party notices.
- **The release workflow:** a `platform-core-v<version>` tag attaches both tarball flavours, `MANIFEST.json` and
  `SHA256SUMS` to a GitHub Release ([contract.md §12](contract.md#12-releases)).

**What wave 1 does not do:**
- **No sending email.** There is no send tool, no Send control and no `send` mode. A draft opens in the user's own
  mail client only when the user taps, and the prefill never carries an address only the model wrote.
- **No new infrastructure.** There is no Worker, container, R2 bucket, table, SQL or secret. Nothing calls a platform
  gateway; the gateway and the engine image arrive in wave 2, after their owner decisions.
- **No ledger-backed metering.** The wave-1 tools are text tools and reserve nothing. The DreamStream MeterPort over
  the existing ledger comes in W3.2 (ADR 0008, L3).
- **No removals.** The dormant Nango tool and the GSAP text in `render_video` stay as they are. Removing them
  (decision D16) is the owner's call (ADR 0008, L5).

## Flags

Anything a user can see needs **both** a kill switch that is exactly `on` **and** a stage that admits that user.
With the kill switches unset, nothing a user can see changes.

| Flag | Where | Values | Default |
|---|---|---|---|
| `PLATFORM_DOCS` | Server env (backend) | `off` \| `on` | unset, which means off |
| `VITE_PLATFORM_DOCS` | Pages build var (client) | `off` \| `on` | unset, which means off |
| `PLATFORM_DOCS_STAGE` | [`shared/platform/flags.ts`](../../shared/platform/flags.ts) | `'off'` \| `'admins'` \| `'everyone'` | `'admins'` |

**Each side has its own edge:**
- **The server** builds the platform tools per request from `platformDocsFor(req)`, only when `PLATFORM_DOCS` is on
  and the stage admits the user. They never reach `/api/connect/mcp`. The admin check is the server's own
  (`hydrateAccessProfile(req)`), and a client-supplied flag is ignored.
- **The client** shows a platform surface (the pitch deck, the Word download, the draft cards) only when
  `platformDocsVisible(isAdmin)` ([`services/platformFlags.ts`](../../services/platformFlags.ts)) says so. That reads
  `VITE_PLATFORM_DOCS` and the stage, with the admin signal from `hooks/useIsAdmin.ts`.
- Both use one rule, `platformDocsAllowed` in `shared/platform/flags.ts`. Never fork it.

**Rollout:** both switches must be exactly `on`:
- the server env `PLATFORM_DOCS`, as a wrangler `vars` entry or a D1 `backend_env` row;
- the Pages build var `VITE_PLATFORM_DOCS`.

The stage stays `'admins'` while admins run QA. Then change the stage to `everyone` with a one-line PR.

**Rollback:** Roll back the chat tools with `PLATFORM_DOCS=off`. Roll back the Word button and the pitch deck by
unsetting `VITE_PLATFORM_DOCS` and rebuilding. Do both, or set the stage to `'off'`, for a full rollback.

## Chat tools

`email_draft` and `deck_create` reach only a person the flags admit.

- **Nothing sends.** The email draft card has no Send control. The person copies the draft, or opens it in Gmail or
  their mail app, and sends it from there.
- **Only addresses the person typed are pre-filled.** An address inside a pasted-text block is flagged
  `From pasted text — not added`.
- **The email preview is inert.** It is an iframe with `sandbox=""` and the CSP
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'`.

## Pitch deck (.pptx)

**Where:** the Read tab → Share & export. Admins only in wave 1.

**What the deck holds:**
- a title slide;
- a cast slide: up to 6 characters on the slide, everyone in its speaker notes;
- up to 30 page slides, each page's script in its speaker notes;
- an end slide.

**Limits:** 30 page slides, 1 MB per picture, 40 MB per deck, and a 120 s hard limit. Cancel stops the export with
"Export cancelled."

## Releasing the contract

1. Admin QA passes on production at stage `admins`.
2. `packages/platform-core/package.json` `version` and `CHANGELOG.md` agree. A contract change has its note in
   ADR 0008.
3. The owner pushes the tag `platform-core-v<version>` on the commit to release.
4. [`release-platform-core.yml`](../../../.github/workflows/release-platform-core.yml) runs. It refuses a tag that
   differs from the package version, a `MANIFEST.json` whose `clean` is not `true`, and a pack that is not
   byte-identical twice. Then it publishes the release.

A consumer downloads the release with no token, or rebuilds the same bytes from the tag
([onboarding.md, step 3](onboarding.md#3-import-the-package)).
