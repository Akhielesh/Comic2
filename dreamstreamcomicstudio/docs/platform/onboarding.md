# Onboarding a studio or a future product

How a DreamStream studio, or a product in another repository, gets the shared platform: the document models, email
drafting, governed tools, flows and, from wave 2, the engine capabilities. The platform is a **capability of a
product, not a product of its own**, so no access table or SQL changes when a studio gets it.

Read first: [what the platform is](README.md), the [wire contract](contract.md) and the
[security model](security.md).

## The seven steps

| Step | What the team does | Time (estimate) |
|---|---|---|
| 1 | Register the product: a manifest, plus any new capability or tool | 30 min |
| 2 | From wave 2: get an app key (**outside DreamStream only**) and hold a sub secret (**every host**) | 10 min |
| 3 | Import the package by relative path, or vendor a release | 30 min |
| 4 | Implement the five ports against your own auth, ledger, audit, consent UI and model | 3 h |
| 5 | Bind the tools and register them in your agent loop | 1 h |
| 6 | Render the artifacts with your own components | 2–4 h |
| 7 | Run the conformance kit | 30 min |

### 1. Register the product, its capabilities and its tools

**The manifest.** Add a manifest with `defineProduct` in
[`packages/platform-core/src/products.ts`](../../packages/platform-core/src/products.ts) and list it in
`PRODUCTS`. It names:
- `id` and `studio`: the host's studio id, or `null` for an app with no studios;
- `app` and `skin`;
- the `capabilities`, `tools`, `flows` and email `templates` the product may use;
- its default approval `policy` (a user may choose a stricter one, never a looser floor);
- `governedWording`: whether its users see shares of usage, never dollars.

`defineProduct` throws on an unknown capability, tool or flow, so a manifest cannot name something that does not
exist.

**For a DreamStream studio,** [`tests/config/platformProducts.test.ts`](../../tests/config/platformProducts.test.ts)
fails until every entry in `PRODUCT_IDS` and `StudioId` has a manifest (`baby_monitor` is in `NO_PLATFORM`), and
the other way round. A new studio cannot ship without platform access.

**For a product in another repository:**
- add its app id to `PLATFORM_APPS` and its policy shape to `HostPolicy`. Both are additive, minor-version changes;
- give it a manifest with `studio: null`.

**A new capability** is an entry in `CAPABILITIES` in
[`src/capabilities.ts`](../../packages/platform-core/src/capabilities.ts), with its id in `CAPABILITY_IDS`. It needs:
- its kind, where it runs, its trust, its gate and its wave;
- an ordered engine list, where every capability names a fallback engine or a host-native path;
- its limits: `maxBytes` (10^6 bytes per MB), `maxPages` and `timeoutMs`;
- `plans` and a `stageCeiling` where they apply;
- the evidence that must exist before it moves up.

A number the plan does not give carries a `provisional` note naming its owner. The registry refuses a placeholder
engine version without one, and ADR 0008 confirms each.

**A new tool** goes in the registry in `src/tools/registry.ts`. Its name must be unique. No tool may send: a name like
send, deliver, dispatch or post_message is refused, and so is a `send` mode. A tool that writes outside the app is
`external-write`, which always resolves to `confirm`.

**A new engine, font, model file, vendored copy or dependency** goes through the licence policy first. See
[security.md, Licences](security.md#licences).

### 2. Keys and the sub secret (from wave 2)

The gateway arrives in wave 2. Wave 1 creates no secret: DreamStream's wave-1 tools make no gateway call.

DreamStream's own signing key and sub secret are created with the wave 2 gateway package; the sub secret rules below
apply to every host, DreamStream included.

**For each app, the owner creates:**
- **a signing secret per key id**, stored as a gateway secret named `PLATFORM_APP_SECRET_<APP>_<KID>`:
  - at least 32 bytes, in unpadded base64url form;
  - to rotate it, add a second key id, move the host to it, then remove the first. Two key ids may overlap;
- **an allowlist entry** for the app: its capabilities, its quotas and the host it serves signed URLs from.

**Every host, DreamStream included, also creates and holds its own sub secret** (ADR 0008, L2):
- It is non-rotating, base64url and at least 32 bytes.
- It is distinct from every app signing secret, and it is never sent to the gateway.
- The host computes each user's pseudonymous subject with `pseudonymousSub(crypto, subSecret, userId)`:
  `sub = hex(HMAC(HMAC(subSecret, "platform-sub-v1"), userId))[0..32]`.
- **It must not rotate with the signing key.** A new sub secret gives every user a new `sub` and orphans their jobs,
  files and quotas.

Keep both secrets in your secret store, never in the repository.

### 3. Import the package

- **Inside this repository,** import by relative path, always ending in `.js`. From `server/src/ai/tools/` that is
  `'../../../../packages/platform-core/src/index.js'`. The backend compiles under `Node16`, where an extensionless
  import fails.
- **Outside it,** vendor a release. Each tag `platform-core-v<version>` has a GitHub Release with four files:
  - `platform-core-<version>.tgz`: every relative import ends in `.js`, for Node16 and for bundlers that map `.js`
    to `.ts`;
  - `platform-core-bundler-<version>.tgz`: the same sources without the suffixes;
  - `MANIFEST.json` and `SHA256SUMS`.

  Download them with no token. Check `SHA256SUMS` and `MANIFEST.json`, then write the sources into a generated,
  do-not-edit folder. As a fallback, clone the tag and run
  `node dreamstreamcomicstudio/packages/platform-core/scripts/export.mjs --out dist`: it gives the same bytes.
  In your CI, recompute every hash and run the shipped fixtures under your own `tsconfig`.
- **Keep `./client` server-side** (for example with a lint rule that forbids importing it from browser code), because
  it holds the app secret. The pure models, `renderEmail` and `reviewEmail` may run anywhere.

### 4. Implement the five ports

Each port is implemented over the host's own systems. The platform never logs anyone in, holds a token, spends money
or calls a model. The interfaces are in `src/gates/ports.ts` and `src/audit/event.ts`.

| Port | Rule |
|---|---|
| `IdentityPort` | Mints a user claim only for a request your own auth has authenticated, and throws otherwise. A service claim, if you have one, carries only `doc.convert`, `doc.extract` and `doc.thumbnail`. |
| `MeterPort` | Reserves, claims, settles and releases on your own ledger, and never throws. With the ledger down, `reserve` and `claim` answer `unavailable`, which fails closed for governed users. A second claim of the same reservation answers `used`. A sweep of open holds releases an unclaimed platform hold; it never settles it. |
| `ApproverPort` | Records a draft action that a person later approves with a click in your own UI |
| `AuditPort` | Records content-free events: ids, hashes, codes and costs, never text |
| `LlmPort` | One JSON completion on your own model, with a versioned prompt pack (`emailDraft.v1`) |

**DreamStream in wave 1:** `email_draft` and `deck_create` are text tools, so they reserve nothing. The host passes a
meter that answers `unavailable` and never throws, and the tests prove the tools never call it. The ledger-backed
MeterPort comes in W3.2 (ADR 0008, L3).

### 5. Bind the tools

`bindTools(manifest, {handlers, policy, meter, audit, now, newId})` returns one bound tool per manifest tool.
- Register each tool's spec in your agent loop: `toChatSpec` for function calling, `toDirectorSpec` for the comic
  Director.
- Call `run(args, {userId, callsThisTurn, turnSpendUsd})` and map the outcome (`ok`, `invalid`, `needs-approval`,
  `refused` or `failed`) to your own tool result.
- `bindTools` throws at bind time when a tool that reserves has no meter, so such a tool can never run unmetered.

Model-facing schemas carry no image and no asset reference. Any picture you add must come from the requesting user's
own assets.

**In DreamStream,** the tools are built per request from a server-only check: the `PLATFORM_DOCS` kill switch, the
stage, and the server's own admin check. A client-supplied flag is ignored. See [README.md, Flags](README.md#flags).

### 6. Render the artifacts

Render with your own components, from core's results:
- **Email:** `renderEmail(doc, brandKit)` gives `{html, text}`. Show the HTML in a `srcdoc` iframe with `sandbox=""`.
- **Review:** `reviewEmail(doc, ctx)` gives the prefill, the flagged recipients, the links and the warnings. Build
  every mail-client link from the prefill only, never from the draft's own recipients.
- **Documents and decks:** export in the browser through DreamStream's lazy loader (`services/platformExport.ts`),
  never by importing the renderers directly.

DreamStream adds a Gallery demo for every new artifact; `gallery.coverage.test.ts` enforces it.

### 7. Run the conformance kit

`runConformance(subject)` from `./testing` runs your ports and `createFakePlatform()` through eleven checks:
1. a user claim cannot be minted without a session;
2. service claims carry only preview capabilities;
3. governed usage wording never shows `$`;
4. an external write resolves to `confirm` under every policy;
5. `MeterPort.reserve` fails closed with the ledger down;
6. tool names are unique and present in your catalogue;
7. the HMAC golden vectors verify with your crypto;
8. `reviewEmail` never pre-fills a model-only address;
9. email previews use `sandbox=""`;
10. a flow with more than one model call resolves to `propose` unless the user chose `never`;
11. a resume with an expired plan token or an already-used reservation is refused.

A check you have not wired yet reports `skip`, with the reason. Do not ship with a `fail`.

## What a product gets

- the models (RichDoc, DeckSpec, EmailDoc), their ops, validation and undo;
- the email renderer, the recipient and link review, and nine templates;
- prompt packs, and tool schemas projected for function calling and MCP;
- gates, consent and governed wording;
- the flow runner;
- the signed client and the fake platform;
- BrandKit-themed outputs and skin data;
- from wave 2, every engine capability, with quotas, kill switches, fallbacks and licence vetting.

## Rules that do not bend

- **Hosts own auth, the model, money and consent.**
- **Nothing sends.** Drafts open in the user's own mail client only when the user taps, and the prefill never carries
  a model-only address.
- **No paid call runs without a confirm.** Usage reserves and settles through the host's ledger, and governed users
  never see `$`.
- **Third parties extend only through MCP** (later). No third-party code runs in the engine, and plugins are
  compile-time registries reviewed in this repository.
