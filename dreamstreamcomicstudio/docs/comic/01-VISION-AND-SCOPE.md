# 01 — Vision & Scope

## The thesis

There is no tool that makes a *non-artist* produce a **coherent, consistent comic
book** end-to-end — and lets them **edit it like a professional** when they care to.
Generic image apps give you one inconsistent picture at a time. Comic apps give you
templates but no AI. We sit in the gap: **AI does the heavy lifting (story →
pages → consistent art → lettering); the human stays in control with an Adobe-grade
editor on top.**

Two truths shape the whole design:
- **A comic is mostly pictures, and pictures are expensive + inconsistent.** So the
  product's job is to spend the *fewest, smartest* image calls and to make every one
  *reusable* (reference sheets, seeds, caching). Text (the "brain") is cheap/free.
- **Different users want different depth.** The same product must serve a 3-click
  "make me a comic from this idea" user and a power user who repositions every bubble
  and re-renders a hand on panel 4. **One document, progressive disclosure.**

## Who it's for (personas → what they need)

| Persona | Wants | What we give them |
|---|---|---|
| **Riya, the storyteller** (non-artist) | "Turn my idea/script into a finished comic I can publish." | Quick flow: idea + style + format → AI aggregates a whole book → reader → publish. Auto-everything. |
| **Sam, the tinkerer** | "Mostly auto, but let me fix the bits I hate." | Quick flow + targeted depth: regen a panel, circle-and-fix a face, move a bubble. |
| **Dev, the power creator** | "I want per-panel control like a real studio." | Studio depth: layer canvas, per-panel model/prompt/seed, explode page→panels, variations, style overrides. |
| **You (owner), the first user** | "I need to actually use this soon, on my own keys, without burning money." | BYOK, cost preview, caching, the whole flow working for one person before multi-tenant. |

## The product promise (what "done" feels like)

1. Paste an idea or a script. Pick a style (or "surprise me") and a format
   (page / webtoon / square). Press **Create**.
2. Watch the AI build the book: outline → script → page plan → a locked **Style
   Bible** and **character reference sheets** → rendered pages with lettering.
3. Read it. Like it? **Publish/share.** Want changes? **Open the page in the editor.**
4. In the editor: drag a speech bubble, swap its design, resize it; **circle** a
   messy region and type "fix the left hand" → it re-renders just that area;
   **re-roll** a whole panel and pick from variations. Bubbles and edits are
   **layers** — non-destructive, reorderable.
5. Export: PDF / webtoon strip / CBZ / PNG pages.

## Scope (v1) — IN

- One **Comic Document** model (the solid base template) — book/pages/panels/layers
  + Style Bible + Cast + Continuity.
- **Quick-generate engine** (page-first): idea/script → comic book.
- **Layer canvas editor**: bubbles (drag/resize/restyle, many designs, layer-on-layer),
  circle/region-to-edit (inpaint), single-panel regen + variations, on-canvas dialogue.
- **BYOK** key setup + **cost preview** + **token-optimization + result caching**.
- **Multi-model orchestration**: capability-gated routing, consistency primitives
  (reference sheets, seeds, scoped reference packs), graceful model fallback.
- **Reader + publish/share + export** (these largely exist; keep them).

## Scope (v1) — OUT (explicit non-goals)

- **AI Chat product, Code Studio product, Model Library** as *features we develop* —
  frozen legacy (D1). Hidden from default nav.
- **Platform billing / CT credits / Stripe in the user path** (D3) — code stays,
  UI off.
- **Object/character pose-swap, replace-this-character** editing — fast-follow (D4).
- **Self-hosted models / fine-tuned LoRAs** — later; v1 is BYOK API models only.
- **Real-time multiplayer editing** — later.
- **Mobile-native apps** — responsive web only in v1; native later.

## What success looks like (v1 acceptance)

- The owner can, on their own OpenRouter key, take an idea to a published 6–12 page
  comic with consistent characters in **under ~15 minutes** and **under a known,
  previewed cost**, and can hand-edit any page (bubbles + one region fix + one panel
  re-roll) **without leaving the app**.
- No reference to the three-engine confusion remains in the UI: there is **one**
  "Create" entry and **one** editor.
