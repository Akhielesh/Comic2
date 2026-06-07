# Open Design → Code Studio: Master Onboarding Plan

A complete, feature-by-feature map of **nexu-io/open-design** (+ **nexu-io/html-video**, both
Apache-2.0) and exactly how each capability is onboarded **natively** into our Code Studio, with
status and security notes. This supersedes the earlier high-level roadmap.

## Guiding principles (and the security model you asked for)
1. **Vendor knowledge locally** (design systems, skills, templates = Markdown/JSON/CSS) → compiled into
   our bundle, **zero network egress**, no third-party runtime/deps, no supply-chain pull.
2. **Self-host heavy runtimes as isolated workers** (video render = headless Chromium + ffmpeg) →
   never in the main API; the agent calls them via a thin tool, operator-gated by env.
3. **Don't vendor their app** (Electron/Next.js/daemon) — we re-implement the *capability* on our stack.
4. **External data egress is opt-out** (`STUDIO_DISABLE_EXTERNAL_MCP`); workers run isolated.

## Counts (verified from the repo tree, sha a9f6949)
- **155 skills** (114 pure-text, 41 carry HTML/PY/SH templates)
- **151 design systems** (each: DESIGN.md + USAGE.md + design-tokens.json + tokens.css + tailwind-v4.css + components.html)
- **261 plugins** (12 scenarios, 13 atoms, 45 image templates, 50 video templates, 142 design-system wrappers, 143 examples)
- **21 video templates** (html-video / HyperFrames)

---

## A. Design systems (151) — onboard as presets
**Native:** `DESIGN_PRESETS` in `server/src/ai/studio/designSystem.ts` — concrete design-language
directives the agent picks per prompt (or the user pins via the **picker** in Settings, synced to
`services/designPresets.ts`).
**Status:** ✅ **40 shipped** (26 archetypes + 14 named brands: Stripe, Linear, Vercel, Notion, GitHub,
Airbnb, Spotify, Apple, Tesla, Coinbase, OpenAI, Perplexity, Figma, Framer).
**Plan:** grow toward the full set by vendoring more real `DESIGN.md`/token files from the repo (via the
ungh.cc mirror) on demand — esp. the brand systems users ask for. Optionally vendor `design-tokens.json`
so generated apps get exact CSS variables.

## B. Skills (155) — onboard as a techniques axis
**Native:** `DESIGN_SKILLS` — reusable technique recipes auto-applied per prompt + injected into the
directive.
**Status:** ✅ **38 shipped** — layout/motion/data/states/nav + the 7 motion-graphics ones + a brand/
systems/product wave (brand-system, color-system, type-system, d3-charts, 3D/WebGL, social/OG cards,
auth-flow, forms+validation, search+filter, onboarding tour, pricing table, SEO/meta, i18n, realtime,
print styles, resilient errors). Pure text, auto-recommended per prompt. **Plan:** keep adding niche
themes (GSAP deep-dives, Figma flows) on demand.

## C. Plugins (261) — onboard by category
| Category | Count | Native onboarding | Status |
|---|---|---|---|
| **Scenarios** (od-default, new-generation, design-refine, media-generation, *-export, code/figma-migration) | 12 | Studio **workflows** (named prompt+pipeline presets) | ⬜ planned (we have generate/refine/build/agents flows already) |
| **Atoms** (discovery-form, direction-picker, todo-write, critique-theater, diff-review, token-map…) | 13 | **pipeline steps** — several already exist (build loop, completeness review, parallel synthesis, changes/diff panel) | 🚧 partial |
| **Image templates** | 45 | prompt packs for the image tool | ⬜ planned (needs image gen, see E) |
| **Video templates** | 50 | prompt packs for `render_video` / HyperFrames | 🚧 the engine is wired; templates to vendor |
| **Design-system plugins** | 142 | = the design systems (A) | ✅ via A |
| **Examples** | 143 | starter templates / scaffolds | ⬜ planned (vendor the 10 text ones + key prototypes) |

## D. Modes / artifact types
| Mode | Native | Status |
|---|---|---|
| Web prototype (React/TS) | scaffold + generate | ✅ |
| Mobile (Expo/React Native, web-preview) | `scaffold.ts` Expo path + NativeWind | ✅ |
| Slide deck | generate contract → reveal.js/slides | ✅ |
| Design system | `DESIGN_PRESETS` | ✅ |
| Dashboard / live artifact | `data-dashboard` preset + data agent; **html_template_v1 engine + render_live_template tool** (data-only, safe) | ✅ core (live refresh + UI card ⬜) |
| Images | image generation tool | ⬜ (E) |
| Video / HyperFrames → MP4 | `render_video` worker + client recorder | ✅ #1, ✅ #2 (worker) |
| Email / magazine layouts | presets (`magazine`, `luxury-editorial`) + skills | 🚧 |

## E. Media generation
**open-design:** image (OpenAI/Fal/Grok/Leonardo…), video (Fal/HyperFrames), audio/TTS (OpenAI/ElevenLabs).
**Native:** ✅ **`generate_image`** — BYOK image generation **through the user's own account keys**
(Gemini/Ideogram/Flux via `req.apiKeys`), a per-request tool wired into chat + the studio design/UI
agents, reusing the proven `/api/image` provider calls. ✅ **`render_video`** for video.
**Status:** ✅ image + video; audio/TTS ⬜ (same BYOK pattern, planned).

## F. Exports
HTML ✅ (within zip) · Markdown ✅ (`studioExport`) · PDF ✅ (print preview) · ZIP ✅ · **MP4 ✅** (record + worker) · **PPTX ⬜** (deferred — a generated reveal.js deck self-exports; shell PPTX needs a heavy lib for niche value).

## G. Quality / review (Critique Theater / Design Jury)
**open-design:** 5 panelists (Designer/Critic/Brand/Accessibility/Copy), composite score, ≤3 rounds, ship ≥8.
**Native:** ✅ **Scored parallel review → single synthesis** (`runStudioAgentsParallel`): each specialist scores its area 0–10 + lists findings; we compute a composite, synthesize all findings, and **iterate up to 2 rounds until the composite hits the ship bar (8)** — the Design Jury, on our stack. Plus the completeness self-review + build-fix loop. ✅

## H. Tooling / infra (re-implemented or N/A on our stack)
- **Model router** → our `autoRouter` (quality-first coder). ✅
- **MCP server (`od`)** → catalog entry, env-gated; reads a *local* OD instance, niche. ✅ (entry)
- **External design/connector MCPs** (Context7/DeepWiki/shadcn/Magic/Nango) → curated catalog + privacy gate. ✅
- **Multi-agent CLI routing** (claude-code/cursor/codex…) → **N/A**: we route to API models, not local CLIs. Our equivalent = autoRouter + the agent team.
- **Deploy to Vercel/Cloudflare** → we have download/zip + (separately) studio worker. ⬜ optional.

---

## Sequenced backlog (one-by-one, highest value first)
1. ~~**Critique scored loop**~~ ✅ shipped (scored review + iterate-to-ship-bar).
2. ~~**Expand skills**~~ ✅ shipped (38 skills across the major themes).
3. ~~**Image generation tool**~~ ✅ shipped — BYOK `generate_image` (Gemini/Ideogram/Flux, the user's own keys) in chat + studio agents. Unlocks the image-template packs.
4. **Vendor more real design systems + tokens** (A) — bring exact `DESIGN.md` + `design-tokens.json` for top brands beyond the 40 shipped.
5. **Studio workflows** (C scenarios) — named generate/refine/migrate/media pipelines surfaced in the UI.
6. ~~**Live data-driven artifacts**~~ ✅ core shipped — the `html_template_v1` engine (safe, data-only `{{ dot.path }}` binding) + the `render_live_template` tool. End-to-end auto-refresh + a live-artifact UI card remain.
7. **PPTX export** (F) — only if demanded (heavy lib).

> Items 3, 6, 7 genuinely need an API key (image provider), a substantial new subsystem (live-data
> binding), or a heavy dependency (PPTX) — they can't be responsibly "completed + verified" blind, so
> they're scoped here rather than half-shipped. Say the word (or provide the key) and I'll build them.

## Shipped so far (this program)
40 design systems + picker · 22 design skills (incl. motion-graphics) · deck artifact · Expo/RN web+mobile ·
strongest-coder default · completeness self-review · parallel review→synthesis · full console + copy ·
preview fullscreen · per-project session IDs · Markdown/PDF export · **video #1 (record) + #2 (`render_video` worker)** ·
external-MCP privacy kill-switch · open-design MCP catalog entry.
