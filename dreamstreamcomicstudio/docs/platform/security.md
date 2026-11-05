# Platform security model

The threat model for the shared platform: the trust zones, each threat with its control and the wave that delivers it,
the holes wave 1 closes, and the licence gate. The wire's exact rules are in [contract.md](contract.md); the decisions
behind them are in [ADR 0008](../decisions/0008-shared-platform.md).

To report a vulnerability, follow the repository's [security policy](../../../.github/SECURITY.md). Never use a public
issue.

**This repository is public.** These pages and the release tarballs describe only the platform's own wire contract
and controls. They never carry another product's internals, findings or advisories, and
[`tests/config/publicDocs.test.ts`](../../tests/config/publicDocs.test.ts) fails if they do.

## Trust zones

| Zone | Holds | Trusted with |
|---|---|---|
| **Browser** | Nothing secret | Nothing. It may call only `GET /v1/jobs/:id?t=` and `GET /v1/files/:ref?t=`, with a poll token. |
| **Host** (the DreamStream backend, another product's server) | Sessions, model keys, OAuth tokens, budgets, the app signing secret and the sub secret | Auth, consent, money and the model. It mints claims only after its own auth. |
| **Gateway** (wave 2) | Per-app signing secrets | Authenticating hosts, quotas, jobs and staging. It holds no user token, renders nothing and has no login. |
| **Engine pools** (wave 2 on) | No secrets and no network | Untrusted bytes, inside per-job limits |

## Threats and controls

| Threat | Control | When |
|---|---|---|
| **Agent output becomes code** | Agents send schema-checked data only: every string and array is capped, and unknown keys are rejected. They never send HTML, SVG, XML, CSS, scripts or URLs to fetch. Links are `https:` or `mailto:` only. Model-facing schemas carry no image and no asset reference at all (ADR 0008 (k)); any picture comes from the requesting user's own assets. In documents a host builds, images are `data:` PNG, JPEG or WebP (sniffed, at most 5,000,000 bytes decoded) or host asset ids. Renderers escape everything and never fetch or read paths. | Wave 1 |
| **Agent writes or sends on its own** | There is no send tool, mode, op or control anywhere; a registry test fails on one, and on any tool name like send, deliver, dispatch or post_message. An external write always needs `confirm` plus a consent record from a human click. Edits to user content are propose-only. A flow with more than one model call proposes its plan first, and an approved plan runs once. | Wave 1 (registry and gates); flows run in hosts from wave 3 |
| **Prompt injection from documents or threads** | Text is treated as data. Recipients come only from the thread's participants or addresses the user typed. A model-only address is flagged and never pre-filled. Every link is listed with its full URL. A host's drafting path can call no mail action. | Wave 1 |
| **Platform tools reached outside chat** | The tools are built per request from a server-only check (kill switch, stage and the server's own admin check). A client-supplied flag is ignored. The outbound MCP list never gets them. | Wave 1 (W1.9) |
| **Forged, replayed or cross-tenant calls** | Each app has an HMAC key, and a `kid` lets two keys overlap during rotation. The timestamp must be within ±300 s. The signature covers the method, the canonical path and query, the body hash, the claim hash and the `Idempotency-Key`. The job record id is scoped to (app, sub or `svc`, key), so two users with the same key never share a job. Storage keys are partitioned by app and owner, and reads need the same app and sub. Poll tokens last at most an hour, are bound to one job and its owner, and allow GET only. | Contract: wave 1. Gateway: wave 2. |
| **Impersonation** ("act as any user") | User claims are minted only after the host's own auth. They are bound to a purpose and capabilities, and last at most 300 s. `sub` is pseudonymous, keyed by the host's own non-rotating sub secret. Service claims are `preview` only, with no user and app-level quotas. The platform has no login and no OAuth tokens. | Contract: wave 1 |
| **Untrusted bytes at the gateway** | Every POST with a body needs a claim. The claim's MAC, the key id, the app allowlist, the timestamp skew and `Content-Length` against the cap are all checked before a byte is staged, so a bad or missing claim stages nothing. The body is hashed while it streams (`crypto.DigestStream` behaviour UNVERIFIED; the fallback is buffered hashing up to 25 MB, with larger inputs going through jobs), and the signature is checked against that digest before any engine sees the bytes; a mismatch deletes the staged copy. The gateway parses no zip. | Contract: wave 1. Gateway: wave 2. |
| **Hostile files in the engine** | A preflight child runs under its own uid before any engine. It scans the zip central directory (at most 2,000 entries, 200 MB declared uncompressed and a 100:1 ratio; no `..`, absolute names, symlinks or nested archives). It caps image headers at 50 MP and 12,000 px, and checks the PDF header and EOF. A PDF sanitiser then strips active content (JavaScript, open actions, launch actions, embedded files). The mechanism is UNVERIFIED until its wave 2 test passes. Unknown formats get 415. | Wave 2 |
| **Engine compromise** | The engine has no internet and no secrets in its environment. The adapter never parses content. Each engine runs as its own uid and can write only its job's output folder, under memory, CPU, file and process limits and a hard timeout. A whole process group is killed after every job. Each instance runs one job and is recycled after 50 jobs or any abnormal exit. A read-only root filesystem is not claimed. The gate is an isolation test: a second job cannot see the first's files, and a write outside its job folder is refused. Per-job tmpfs and uid switching on Cloudflare Containers are UNVERIFIED; until the isolation test passes, the fallback is to recycle the instance after every untrusted job. | Wave 2 |
| **Craft-specific** | GridCraft MCP is never used. PhotoCraft runs only in the heavy pool, on PNG or WebP written by `asset.normalize` (at most 50 MP and 12,000 px) and adapter-generated command JSON, with the Limits patch; never raw PSD, PSB, TIFF or HEIC. WordCraft and DeckCraft take untrusted OOXML/ODT only from our zip ≥ 9.0.5 build; DeckCraft media insert is off. PdfCraft ships no OCR models and never adds them: an image test proves no `*.rten` or `*.onnx` file exists and `PDFCRAFT_MODELS` is unset, because PdfCraft also looks beside its executable. Its sign and print tools are not allowlisted, and it stays at stage `admins` until our attested build (W4.1). The CLI's `run --script` takes only scripts the adapter generates; MCP runs with per-job roots. | Wave 2 on |
| **Output poisoning** | Outputs are checked: the magic bytes must match the declared kind, the size must be under its cap, and generated files must carry no upstream brand strings. Document metadata is rewritten to our product name (the qpdf flags are UNVERIFIED; otherwise the engine's own metadata setting is used). | Wave 2 |
| **SSRF** | Specs contain no URLs. Engines have no network. Only the gateway fetches, GET only, and only from each app's allowlisted signed-URL host. The vendored PptxGenJS throws on `path:` and `http:` images and refuses media. | Renderers: wave 1. Gateway: wave 2. |
| **XSS** | HTML comes only from our serialisers, which escape strings and allow only safe links. Email previews use `srcdoc` with `sandbox=""` and a CSP, and hosts re-sanitise. Platform downloads are served as an `attachment`, with `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and `no-store`, from a media-type allowlist without HTML or SVG, on a host that sets no cookies. The client refuses HTML and SVG from `/v1/files`. | Wave 1 (email, client). Gateway: wave 2. |
| **Cost and DoS** | Quotas per app, per sub per day and per minute; service claims have app ceilings. Each capability has a kill switch. Engine instances are capped, with one heavy job per user. Unauthenticated callers cannot stage bytes. In wave 1, no paid call runs without a confirm, and usage goes through the existing ledger. | Wave 1 (host gates). Gateway: wave 2. |
| **Supply chain** | Engines are SHA-pinned in `engines.lock.json`, later replaced by our attested builds with an SBOM and provenance. Every built lockfile gets an OSV scan. The licence gate covers npm, the browser bundle, engines and data assets (below). | Licence gate: wave 1. Engines: wave 2 on. |
| **Data handling** | Inputs and outputs are kept at most 24 h (print exports 30 days). No content goes into logs, analytics or audit events: they carry ids, hashes and codes only. Nothing is used for training. Gateway invocation logs are off, because poll tokens are capabilities. | Wave 1 (audit events). Gateway: wave 2. |

## Email drafts

Email bodies never cross the wire. Hosts render and review them in process with `renderEmail` and `reviewEmail` from
`packages/platform-core/src/email`. Agents draft and people send, from their own mail client.

**What `renderEmail` guarantees, for any input, checked or not:**
- every string is escaped, so text like `<img onerror=…>` or `<script>` shows as text and never becomes markup;
- no `<script>`, no `on*=` attribute, no `url()`, and no `<style>` beyond the fixed layout rules;
- every `href` is `https:` or `mailto:`, and `reviewEmail` lists it. An unsafe link is dropped and its text kept;
- every `src` is a sniffed `data:` PNG, JPEG or WebP image of at most 5,000,000 bytes. A host asset id is shown only
  when the host hands back such a `data:` URI it already holds; nothing is ever fetched;
- colours are `#RRGGBB` and fonts come from the font registry, so a BrandKit cannot inject CSS;
- no network call, and the same document and kit always give the same bytes.

**The recipient rule (`reviewEmail`):**
- A recipient is trusted when it is one of the thread's participants or an address the user typed in their own
  instruction. An address that also appears in text the user pasted is not trusted on that basis.
- A trusted recipient is pre-filled. A participant's display name is used only when it is one clean line, and never
  a name the model wrote.
- Any other recipient is flagged ("Suggested by AI — not added") and never pre-filled.
- In the reply modes the mail provider chooses the recipients, so the prefill is empty. The host's chosen mode
  decides; a draft that claims another mode can narrow the prefill but never widen it.

**Links.** The review lists every link with its full URL, in document order, wherever a run can sit (headings,
paragraphs, quotes and list items, inside columns too) and on buttons. A link whose text names another site, and a
`mailto:` link to an untrusted address, are warnings.

**Previews.** Hosts show previews in a `srcdoc` iframe with `sandbox=""` (no script can run) and a CSP of
`default-src 'none'; img-src data:; style-src 'unsafe-inline'`.

**Contract by example.** `fixtures/email/hostile.json` is what the renderer and the review must survive unchecked.
Changing anything under `fixtures/email/` is a contract change.

## Holes fixed in wave 1

**`convert_image` (W1.10).** Before wave 1 it accepted any `data:image/*` without checking the bytes. Now:
- `convert_image` admits only JPEG, PNG, WebP and GIF, by magic bytes (`services/sharpGuard.ts`, `checkImageBytes`).
  SVG, HEIC, TIFF and PDF inputs are refused, and so is AVIF input; AVIF output is unchanged.
- Server boot calls `sharp.block` on `VipsForeignLoad{Tiff,Magick,Magick7,Pdf,Jp2k,Fits,Openslide,Matrix}`. If it
  cannot, it logs `[sharpGuard] loader block NOT installed: …`.
- SVG, HEIF/AVIF, JPEG, PNG, WebP and GIF stay open for our own composites and uploads.
- A blocked format surfaces from sharp as "unsupported image format".
- `convert_image` never holds a fetched body past 12 MB. An over-cap `Content-Length` is refused before reading, and
  the stream is cancelled once it passes the cap.

## Licences

**Every addition goes through the policy.** Adding a dependency, engine, font, model file or vendored copy goes
through [`scripts/licence-policy.json`](../../scripts/licence-policy.json). CI's **Licence gate** step
(`scripts/licence-check.mjs`) enforces it, and fails on an empty bundle report.

**What the policy allows:**
- **Browser bundle:** MIT, Apache, BSD, ISC, MPL and OFL, plus the notice-only BlueOak-1.0.0 and Zlib (ADR 0008, L1).
  Libraries that a package's own dist file bundles (docx's polyfills, sax and jszip; jszip's pako) are recorded with
  their licences and judged too; an unrecorded one fails the gate.
- **GPL and LGPL:** server-side only, and only from the allowlist.
- **Blocked everywhere:** AGPL, SSPL, BUSL, PolyForm, CC-NC, source-available and unlicensed code.
- **Exceptions:** `X WITH <exception>` passes only if `withExceptions` lists the exception.

**Known violations and notices.**
- A known violation is an owner decision under `exceptions`. CI prints it as KNOWN on every run.
- Vendored code keeps its `LICENSE` and a `PATCHES.md`.
- The notices file is `/THIRD-PARTY-NOTICES.txt` on the web app, and `/licenses` in the engine image.

The licence gate covers dependencies, the browser bundle, `engines.lock.json` and data assets only. It does not scan
or report the dormant Nango tool or the GSAP mention in `render_video`. Removing those (decision D16) stays with the
owner (ADR 0008, L5).
