# The Atlas skin for Comic Studio

Comic Studio renders in the **Atlas design language** (the owner is unifying the studio designs; a
"fun" theme comes back later as a sibling skin). This page is the one-page reference for how the
skin works, what it maps, where it applies and how it is kept in step with Atlas. Phase D0 (this
document) is the token layer, the skin block, the fonts, the tokenized shared constants, a
transitional accent shim, the tests and the visual proof. Phases D1/D2 (later packages) rewrite the
files that still hard-code the old accent and restyle components to the Atlas primitive recipes.

## The language in one paragraph

White paper, black ink, neutral greys. Hue only ever carries meaning — success, warning,
destructive, info — and is always paired with a word or an icon, never colour alone. Flat surfaces
with a hairline border and a soft shadow; no frosted glass except the sticky header's 82 % blur.
12 px cards, 10 px controls (and chips), 4 px small. IBM Plex Sans body at 14 px, Space Grotesk for
display/headings. Motion is 100 / 150 / 200 ms on `cubic-bezier(.2,.8,.2,1)`, panels 220 ms, modals
180 ms, a 260 ms theme cross-fade, press feedback (scale .98 / .97), tooltips after 300 ms — all off
under reduced motion. A crisp 2 px ink focus outline offset 2 px; inverted-ink selection; thin
ink-tinted scrollbars; 44 px touch targets. Dark theme = the same system inverted (#0a0a0a paper,
#fafafa ink). Generic icons are lucide; brand marks only from checked-in SVGs.

## Scope and mechanism

The skin is selected by one attribute, **`data-ds-skin="atlas"`**, which turns on one block of
`--ds-*` token overrides in `index.css`. Nothing outside the attribute changes: chat, settings, home
and Stream Studio render pixel-identical (the tests below prove it).

| Where | Who sets it | When |
| --- | --- | --- |
| `<html>` — the whole page | `index.tsx` → `services/dsSkin.ts` `bootDsSkin()` | Synchronously at the very top of `index.tsx`, before React renders, **only on the comics host** (`services/productHost.ts` `comicsSkin()`: `comics.dreamstreamstudio.ai` and its alias) — home, gallery, sign-in, the studio, the readers and the `/c/<slug>` share pages all live there. The same boot appends the two body-weight font preloads. Never on the apex, never via an inline script in `index.html` (its only inline script is CSP-hashed). |
| The Comic Studio root (`ComicStudioShell`) | `components/comicstudio/ComicStudio.tsx` | Always — on the apex (`dreamstreamstudio.ai`) this root is the skin's boundary. |
| The public reader root | `components/comicstudio/PublicComicReader.tsx` | Always, including while loading. |
| The immersive reader root | `components/comicstudio/immersive/ImmersiveReader.tsx` | Always — it is portaled to `<body>`, so it must carry its own. The room stays a content surface (`--ds-reader-*`). |

Because the apex roots are `<div>`s, every override is written against the attribute selector
(`[data-ds-skin="atlas"]`, `.dark[data-ds-skin="atlas"]` **and** `.dark [data-ds-skin="atlas"]`),
never against `html`.

The QA harness takes `?skin=atlas` (`qa/ComicQaApp.tsx`) to boot the page-level skin exactly as the
comics host does; without it only the three roots are skinned (the apex case), which is what the
kit scenes render in when the switch is off.

### Theme cross-fade

Atlas registers its colour tokens as typed `<color>` properties and transitions them over
`--motion-theme` when `.dark` toggles. Comic Studio copies the mechanism with one difference: the
registration is done from the boot code (`CSS.registerProperty`, the script form of `@property`) on
the comics host only, not as a CSS `@property` block. A registration is document-wide, and Chromium
animates registered properties under `transition: all` — a CSS block would have given every
`transition-all` element *outside* the skin a theme cross-fade. `<html>` gets the transition only
once the boot code has let the first style pass settle (`data-ds-skin-fade`, two frames later), so
the boot itself never animates. The apex roots mount with the attribute (nothing to animate from)
and, with no registration there, the declaration is inert. Off under reduced motion.

## Token mapping

Every pre-existing `--ds-*` name is kept (122 Comic Studio files and 270 app files consume them).
The semantic tokens Atlas has that Comic Studio lacked were added to `:root` / `.dark` with
**defaults that reproduce today's look exactly**, then overridden under the skin.

### Colours (Comic Studio token → Atlas token → Atlas light / dark)

| Comic Studio | Atlas | Light | Dark |
| --- | --- | --- | --- |
| `--ds-canvas` | `--background` | `#ffffff` | `#0a0a0a` |
| `--ds-sidebar` | `--sidebar` | `#fafafa` | `#0d0d0d` |
| `--ds-surface` | `--card` (opaque) | `#ffffff` | `#111111` |
| `--ds-surface-soft` | `--secondary` | `#f4f4f4` | `#1a1a1a` |
| `--ds-surface-strong` | `--popover` | `#ffffff` | `#161616` |
| `--ds-raised` | `--surface-elevated` | `#ffffff` | `#141414` |
| `--ds-well` | `--surface-subtle` | `#fafafa` | `#0f0f0f` |
| `--ds-well-strong` | `--muted` | `#f4f4f4` | `#1a1a1a` |
| `--ds-hover` | `--menu-hover` | `#f2f2f2` | `#1f1f1f` |
| `--ds-active` | `--menu-active` | `rgba(0,0,0,0.07)` | `#262626` |
| `--ds-ink` | `--foreground` | `#0a0a0a` | `#fafafa` |
| `--ds-muted` | `--muted-foreground` | `#5c5c5c` | `#a3a3a3` |
| `--ds-faint` | foreground at 35 % | `rgba(10,10,10,0.35)` | `rgba(250,250,250,0.35)` |
| `--ds-hairline` | `--border` | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.12)` |
| `--ds-hairline-soft` | border at 60 % | `rgba(0,0,0,0.06)` | `rgba(255,255,255,0.072)` |
| `--ds-accent` | `--primary` (ink — hue never decorates) | `#0a0a0a` | `#fafafa` |
| `--ds-accent-hover` | primary at 85 % over the background | `#2f2f2f` | `#d6d6d6` |
| `--ds-on-accent` | `--primary-foreground` | `#ffffff` | `#0a0a0a` |
| `--ds-accent-soft` | `--accent` | `#efefef` | `#1f1f1f` |
| `--ds-success` | `--success` | `#16a34a` | `oklch(0.5 0.15 142)` |
| `--ds-warning` | `--warning` | `#f59e0b` | `oklch(0.7 0.15 85)` |
| `--ds-danger` | `--destructive` | `#d4183d` | `oklch(0.396 0.141 25.723)` |
| `--ds-info` | `--info` | `#262626` | `#e5e5e5` |
| `--ds-{success,warning,danger,info}-text` | `ui-generated/tone.ts` `toneText` | `color-mix(in srgb, var(--ds-<tone>) 60%, var(--ds-ink))` | same |
| `--ds-ring` | `--ring` | `oklch(0.55 0 0)` | `#8a8a8a` |

The `-text` variants are the readable status colours (≥ 4.5:1 on the page, on cards and on the
tinted status surfaces, both themes); the base tokens are for fills and borders.

### Type, shape, depth, motion

| Comic Studio | Atlas | Skin value | Default outside the skin |
| --- | --- | --- | --- |
| `--ds-font-sans` | `--font-atlas-sans` | `"IBM Plex Sans", sans-serif` | `Inter, sans-serif` (Tailwind `font-sans`) |
| `--ds-font-display` | `--font-atlas-display` | `"Space Grotesk", sans-serif` | `Inter, sans-serif` (headings inherit) |
| `--ds-text-base` / `-lg` | `--text-sm` / `--text-base` | `0.875rem` / `1rem` | `0.875rem` / `1rem` (unchanged) |
| `--ds-radius-panel` | `--radius-xl` | `0.75rem` (12 px) | `1rem` (`rounded-2xl`) |
| `--ds-radius-control` | `--radius-lg` = radius − 2 | `0.625rem` (10 px) | `0.75rem` (`rounded-xl`) |
| `--ds-radius-chip` | badge `rounded-md` | `0.625rem` (10 px) | `9999px` (`rounded-full`) |
| `--ds-radius-sm` | `--radius-sm` | `0.25rem` | `0.25rem` |
| `--ds-shadow-soft` | `--atlas-soft-shadow` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` · dark `0 1px 2px 0 rgb(0 0 0 / 0.4)` | the old `SHADOW_SOFT` (`0 1px 2px rgba(0,0,0,0.04), 0 8px 24px var(--ds-hairline)`) |
| `--ds-shadow-panel` | `--atlas-panel-shadow` | shadow-lg · dark `0 16px 36px -16px rgb(0 0 0 / 0.7)` | the old soft shadow |
| `--ds-shadow-lift` | `--atlas-lift-shadow` | shadow-xl · dark `0 22px 44px -18px rgb(0 0 0 / 0.8)` | `0 4px 16px rgba(0,0,0,0.16)` |
| `--ds-motion-fast/medium/slow` | `--motion-fast/medium/slow` | 100 / 150 / 200 ms | 120 / **200** / 300 ms (`duration-200`) |
| `--ds-motion-panel/modal` | `--motion-panel/modal` | 220 / 180 ms | 220 / 180 ms |
| `--ds-motion-theme` | `--motion-theme` | 260 ms | 0 ms (no cross-fade) |
| `--ds-ease` | `--motion-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | `cubic-bezier(0.4, 0, 0.2, 1)` (Tailwind's default) |
| `--ds-ease-spring` | `--motion-spring` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | same |
| `--ds-tooltip-delay` | `--tooltip-delay` | 300 ms | 300 ms |
| `--ds-surface-blur` | the sticky header's `blur(18px)` | 18 px | 12 px (`backdrop-blur-md`) |

Reader-room tokens (`--ds-reader-room`, `--ds-reader-paper-back`, `--ds-reader-endpaper`) are
content, not chrome, and are deliberately not overridden.

## Fonts

IBM Plex Sans 400/500/600/700 and Space Grotesk 500/600/700, the same latin woff2 files Atlas ships,
self-hosted under `public/fonts/` (SIL OFL 1.1 — `public/fonts/LICENSE-OFL.md`), declared with
`font-display: swap` and a latin `unicode-range`, used only under the skin:
`[data-ds-skin="atlas"] { font-family: var(--ds-font-sans) }`, and `h1–h4` plus the `HEADING`
constant (`.ds-font-display`) in `--ds-font-display`. The 400 and 600 body weights are preloaded by
the boot code on the comics host. There is no Google Fonts link for them; Bangers / Comic Neue / Inter
keep lettering the comic pages (content). The CSP already allows `font-src 'self'`.

## Base rules under the skin

Scoped copies of Atlas's `@layer base`: transparent tap highlight, thin ink-tinted scrollbars
(`scrollbar-color` plus the WebKit fallback), `text-wrap-style: balance` on headings and `pretty` on
running text (the longhand on purpose — the shorthand would break `whitespace-nowrap` parents),
inverted-ink selection with the inverted-surface exception, a `:focus-visible` 2 px ink outline
offset 2 px (3 px under `prefers-contrast: more`, `Highlight` under forced colours) in the base layer
so components that draw their own ring still win, and the press helper **`.ds-press`** (`PRESS` in
`studioDesign.ts`): scale .97 while pressed (`.ds-press-soft`: .98), springs back, motion-safe only.

## The shared constants (`components/chat/studioDesign.ts`)

Chat and Comic Studio both import this file, so its strings must keep producing today's look outside
the skin. Every constant is now token-driven with the same defaults: `RADIUS_PANEL` →
`rounded-[var(--ds-radius-panel)]`, `RADIUS_CONTROL` → `rounded-[var(--ds-radius-control)]`,
`RADIUS_PILL` → `rounded-[var(--ds-radius-chip)]`, `SHADOW_SOFT` → `shadow-[shadow:var(--ds-shadow-soft)]`,
`TRANSITION` → `transition-[color,background-color,border-color,box-shadow,opacity,transform]
duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]`, `GLASS`/`GLASS_STRONG`/`MENU` →
`backdrop-blur-[var(--ds-surface-blur)]`, `ACCENT_SOFT_BG` → `bg-[var(--ds-accent-soft)]`. New:
`ON_ACCENT_TEXT`, `FONT_DISPLAY`, `PRESS`, and the status helpers `TONE_TEXT` / `TONE_SURFACE` /
`TONE_FILL` / `TONE_CHIP` mirroring Atlas's `tone.ts` (always pair a tone with a word or icon).
`PRIMARY_BTN` now uses `ON_ACCENT_TEXT` instead of `text-white` (white by default; paper on ink in the
dark skin).

## The transitional accent shim (Phase D0 only)

Many Comic Studio files still hard-code the terracotta literal in Tailwind utilities
(`bg-[#D97757]/10`, `text-[#D97757]`, `focus-visible:ring-[#D97757]/45`, …). Rewriting them is Phase
D1. Until then the **last block of `index.css`** maps every such utility, under the skin only, to the
accent (ink) / accent-soft / hover / active / ring tokens, so nothing terracotta leaks through. The
block is generated by `node scripts/design/atlas-skin-shim.mjs` and checked by
`tests/config/atlasSkinShim.test.ts`, which fails when a literal utility in the tree has no rule and
*records* (never fails on) how many files still carry the literal. When that count reaches zero,
delete the block and the generator.

## The fun skin (later, not now)

A second skin is one more block of overrides over the **same** semantic tokens:
`[data-ds-skin="fun"]` / `.dark[data-ds-skin="fun"]` with its own canvas, accent, radii, shadows,
motion and fonts, and the value `"fun"` added to `DsSkin` in `services/productHost.ts`. Nothing in
the components changes — they only ever read tokens and the `studioDesign` constants. Designing the
token layer this way is what makes "unify" and the fun theme two values of one attribute.

## Tests and proof

- `tests/config/atlasSkin.test.ts` — parses `index.css`: every `:root` / `.dark` `--ds-*` token has a
  skin override (reader tokens excepted) with the Atlas values; the new tokens' defaults reproduce
  today's look; ink/muted ≥ 4.5:1 on canvas/surface/surface-soft/well in both skin themes; fonts,
  base rules and the cross-fade mechanism.
- `tests/config/atlasSkinShim.test.ts` — the shim covers every literal utility; the literal count.
- `services/productHost.skin.test.ts` — the attribute is set on the comics host and alias, never on
  the apex; the boot does only what the brief allows.
- `components/comicstudio/atlasSkinRoots.test.tsx` — the three roots carry the attribute on the apex.
- The chat tests and the 4-viewport layout smoke (`node scripts/layout-smoke.mjs`) stay green: the
  skin changes nothing outside its scope.
- **Visual proof:** `node scripts/design/atlas-skin-shots.mjs` captures the studio, board, editor,
  immersive reader and public reader at 1440×900 and 360×740, light and dark, with the skin on, into
  `node_modules/.cache/comic-qa/atlas-skin/` (plus `index.json`), from the offline QA harness.

## Synced from Atlas

- Repo: `atlasd`, branch **`origin/claude/quirky-darwin-fpx23q`**, commit **`07935fcf`** (2026-10-28).
  Re-sync against that SHA: `git -C /home/user/atlasd show origin/claude/quirky-darwin-fpx23q:<path>`.
- Files that define the language, and what each token group was derived from:
  - `app/globals.css` — `:root` / `.dark` colours, radius, shadows, motion system, scrollbars, the
    `@property` cross-fade, `@layer base` (tap highlight, text-wrap, selection, focus-visible), the
    effects layer (`.atlas-press`, `--motion-spring`, reduced-motion handling).
  - `tailwind.config.js` — semantic colour names, radius mapping (md = radius − 2, sm = radius − 4),
    shadows soft/panel/lift.
  - `ui-generated/{button,card,badge,tone,tabs,dialog,input,tooltip,sheet}.tsx` — primitive recipes
    (default button = ink on paper, hover /85, press .98, focus ring 3 px ring/50; card = border +
    rounded-xl; badge = rounded-md; status tones mixed 60 % with the foreground).
  - `app/layout.tsx` + `public/fonts/*.woff2` — IBM Plex Sans 400/500/600/700, Space Grotesk 500/600/700.
  - `components/AuthenticatedAppHeader.tsx`, `app/AppShell.tsx`, `components/AppToolbar.tsx` — the
    sticky header (background 82–85 % + blur 18 px, hairline border), monochrome nav.
  - `docs/current/guides/ui-ux-and-design-language.md`, `docs/brand-asset-source-of-truth.md` —
    lucide for generic icons, brand marks only from checked-in SVGs.
