# The Atlas skin for Comic Studio

Comic Studio renders in the **Atlas design language** (the owner is unifying the studio designs; a
"fun" theme comes back later as a sibling skin). This page is the one-page reference for how the
skin works, what it maps, where it applies and how it is kept in step with Atlas. Phase D0 is the
token layer, the skin block, the fonts, the tokenized shared constants, a transitional accent shim,
the tests and the visual proof; the **wave 5 port** (Atlas `acd9fdfc`, see the changelog at the end)
brought the skin up to Atlas's refined foundations. Phases D1/D2 (later packages) rewrite the files
that still hard-code the old accent and move components onto the Atlas primitive recipes.

## The language in one paragraph

White paper, black ink, neutral greys. Hue only ever carries meaning — success, warning,
destructive, info — and is always paired with a word or an icon, never colour alone; one status
vocabulary (healthy, active, waiting, attention, error). Flat surfaces with a hairline border and a
soft shadow; overlays a step above the cards they cover, with a lighter edge in dark; no frosted
glass except the sticky header's blur; modal scrims dim without blur. 12 px cards, 10 px controls
(and chips), 4 px small. IBM Plex Sans body at 14 px, Space Grotesk for display/headings. Motion is
100 / 150 / 200 ms on `cubic-bezier(.2,.8,.2,1)`, panels 220 ms, modals 180 ms, entrances 280 ms on a
long-tail ease-out and exits a quicker 160 ms, the theme switch one 260 ms cross-fade of the page,
press feedback (scale .98 / .97), tooltips after 300 ms — all off under reduced motion. A crisp 2 px
ink focus outline offset 2 px on every control; fields with an edge that clears 3:1; inverted-ink
selection; thin ink-tinted scrollbars; 44 px touch targets; the OS increase-contrast setting
strengthens hairlines, secondary text and field edges. Dark theme = the same system inverted
(#0a0a0a paper, #fafafa ink). Generic icons are lucide; brand marks only from checked-in SVGs.

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

### Theme switch

Changing light / dark under the skin is **one cross-fade of the whole page**, as in Atlas since wave
5: `services/theme.ts` → `services/dsSkin.ts` `switchDsTheme` flips `.dark` inside
`document.startViewTransition`, the root snapshots fade over `--ds-motion-theme` (260 ms) on the
compositor (`html[data-ds-skin="atlas"].ds-theme-transition::view-transition-old/new(root)`), and
`ds-no-transitions` holds every element's own CSS transition for that one style change, so the
hundreds of `TRANSITION` colour fades never start. Only a change the person just asked for fades
(`setThemePreference`, with a live user activation, a visible page and motion allowed); the stored
preference applied at mount, a system-theme correction, reduced motion and browsers without the API
switch at once — still with transitions held for that frame. It runs where `<html>` carries the skin
(the comics host). **Outside the skin `applyTheme` is exactly the old `.dark` toggle**, and the apex
Comic Studio roots switch at once as before. D0's mechanism — the colour tokens registered as typed
`<color>` properties at boot and transitioned on `<html>` (`data-ds-skin-fade`) — is gone: Atlas
dropped it because it restyled every element on every frame of the fade.

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
| `--ds-surface-strong` | `--popover` | `#ffffff` | `#1a1a1a` (wave 5; was `#161616`) |
| `--ds-raised` | `--surface-elevated` | `#ffffff` | `#1a1a1a` (wave 5; was `#141414`) |
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
| `--ds-focus` (wave 5) | `--foreground` as `.atlas-focus-ring` / the primitives' `outline-foreground` | `var(--ds-ink)` | same |
| `--ds-control-border` (wave 5) | `--control-border` | `color-mix(in srgb, var(--ds-ink) 45%, transparent)` | same |
| `--ds-control-border-hover` (wave 5) | `--control-border-hover` | `… 60% …` | same |
| `--ds-overlay-edge` (wave 5) | overlays' `border-border/80`, dark `border-white/[0.14]` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.14)` |
| `--ds-scrim` (wave 5) | modal overlay `bg-black/40 dark:bg-black/60`, no blur | `rgba(0,0,0,0.40)` | `rgba(0,0,0,0.60)` |
| `--ds-danger-mark` (wave 5) | `bg-destructive dark:bg-destructive-foreground` (dots, status edges) | `var(--ds-danger)` | `oklch(0.637 0.237 25.331)` |
| `--ds-skeleton` / `-glint` (wave 5) | `.atlas-skeleton`, `.dark .atlas-skeleton` | ink at 4.5 % (= `--muted` `#f4f4f4` on white, but translucent: `.studio-shimmer` overlays a queued page's wireframe) / canvas at 55 % | ink at 9 % / 7 % |
| `--ds-segment-pill` (wave 5) | PanelTabs pill `bg-background dark:bg-accent` | `#ffffff` | `#1f1f1f` |
| `--ds-segment-track` (wave 5) | PanelTabs track `bg-muted/60 dark:bg-muted/50` | `--ds-well-strong` at 60 % | `--ds-well-strong` at 50 % |
| `--ds-overlay-hover` (wave 5) | menu / select / dropdown items `focus:bg-accent dark:focus:bg-white/[0.08]` | `var(--ds-accent-soft)` (`#efefef`) | `rgba(255,255,255,0.08)` |
| `--ds-status-error-edge` / `-tint` (wave 5) | status error `border-destructive/35 bg-destructive/[0.06]`, dark `border-destructive-foreground/40 bg-destructive-foreground/[0.08]` | `--ds-danger-mark` at 35 % / 6 % | `--ds-danger-mark` at 40 % / 8 % |
| `--ds-toast-edge` (wave 5) | toast `border-border/70 dark:border-white/[0.12]` | hairline at 70 % (`rgba(0,0,0,0.07)`) | `rgba(255,255,255,0.12)` |

Under the OS **increase contrast** setting (`@media (prefers-contrast: more)`, wave 5) the skin applies
Atlas's high-contrast tokens: `--ds-hairline` `rgba(0,0,0,0.32)` / dark `oklch(0.52 0 0)` (the soft
hairline 60 % of it in both themes — the dark block restates it, because the base dark block outranks
the light high-contrast one), `--ds-muted` `#404040` / `#d4d4d4`, `--ds-ring` `#000` / `#fff`,
`--ds-control-border` ink 70 % and its hover the full ink. (Atlas's own Settings toggle,
`.atlas-high-contrast`, has no Comic Studio counterpart.)

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
| `--ds-shadow-overlay` (wave 5) | overlays' `shadow-lg`, dark `inset 0 1px 0 0 rgb(255 255 255/.06), var(--shadow-lg)` | shadow-lg · dark `inset 0 1px 0 0 rgb(255 255 255 / 0.06), 0 18px 40px -12px rgb(0 0 0 / 0.75)` | `var(--ds-shadow-soft)` (what menus use today) |
| `--ds-shadow-segment` (wave 5) | PanelTabs pill shadow | `0 1px 2px rgb(0 0 0 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.06)` · dark `inset 0 1px 0 rgb(255 255 255 / 0.06), 0 0 0 1px rgb(255 255 255 / 0.08)` | `0 1px 2px rgba(0,0,0,0.08)` (the board Segmented's pill) |
| `--ds-motion-fast/medium/slow` | `--motion-fast/medium/slow` | 100 / 150 / 200 ms | 120 / **200** / 300 ms (`duration-200`) |
| `--ds-motion-panel/modal` | `--motion-panel/modal` | 220 / 180 ms | 220 / 180 ms |
| `--ds-motion-theme` | `--motion-theme` | 260 ms | 0 ms (no cross-fade) |
| `--ds-ease` | `--motion-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | `cubic-bezier(0.4, 0, 0.2, 1)` (Tailwind's default) |
| `--ds-ease-spring` | `--motion-spring` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | same |
| `--ds-ease-enter` (wave 5) | `--motion-ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | same |
| `--ds-motion-enter` / `-exit` (wave 5) | `--motion-enter-quick` / `--motion-exit` | 280 / 160 ms | same |
| `--ds-tooltip-delay` | `--tooltip-delay` | 300 ms | 300 ms |
| `--ds-surface-blur` | the sticky header's `blur(18px)` | 18 px | 12 px (`backdrop-blur-md`) |

The wave 5 tokens default, outside the skin, to what the page paints today (`--ds-control-border`
and `--ds-overlay-edge` = the hairline, `--ds-focus` = `--ds-ring`, `--ds-shadow-overlay` = the soft
shadow, `--ds-danger-mark` = `--ds-danger`, `--ds-skeleton(-glint)` = `.studio-shimmer`'s slate,
`--ds-segment-pill` / `--ds-shadow-segment` / `--ds-segment-track` = the live segmented controls'
raised pill, 8 % drop shadow and well, `--ds-overlay-hover` = `--ds-hover` (so `MENU_ITEM` in chat
paints exactly as before), `--ds-status-error-*` = the light Atlas mix, `--ds-toast-edge` = the
overlay edge); `--ds-scrim` and the enter / exit motion tokens had no prior equivalent and take the
Atlas values.

A token written as `var(--ds-other)` is resolved where it is declared and inherits as that computed
colour, so every such token is restated in the skin blocks (the apex roots are `<div>`s under an
unskinned `<html>`), and a rule that swaps a token inside a subtree (the inverse surface) must
restate whatever is derived from it — or, as the inverse surface now does, not swap it.
`tests/config/tokenContrast.test.ts` models exactly that inheritance.

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

Wave 5 adds, all skin-scoped: under reduced motion `transition-transform` hover nudges land without
travelling and `animate-spin` / `-ping` / `-bounce` hold still (a spinner's icon and label still say
"loading"); `.animate-scale-in` (the popover / sheet / toast pop-in) runs on `--ds-ease-enter`;
`.studio-shimmer` skeletons take the Atlas block and glint (no slate hue, lifted with ink in dark);
the toast helpers `.ds-toast-countdown` (one compositor animation over `--ds-toast-duration`, held by
`data-paused` on `.ds-toast`, hidden under reduced motion) and `.ds-toast-enter` / `-exit`; and
`.ds-inverse-surface` (the inverted ink panel stays a raised dark panel in dark, focus inside it in
the page colour). Scrollbars and selection did not change in wave 5 (Atlas only moved its `::selection`
rules out of `@layer` so Tailwind stops cloning them; the skin's rules were never in a layer). A guard
test proves every rule in the skin section is scoped to the attribute.

## The shared constants (`components/chat/studioDesign.ts`)

Chat and Comic Studio both import this file, so its strings must keep producing today's look outside
the skin. Every constant is now token-driven with the same defaults: `RADIUS_PANEL` →
`rounded-[var(--ds-radius-panel)]`, `RADIUS_CONTROL` → `rounded-[var(--ds-radius-control)]`,
`RADIUS_PILL` → `rounded-[var(--ds-radius-chip)]`, `SHADOW_SOFT` → `shadow-[shadow:var(--ds-shadow-soft)]`,
`TRANSITION` → `transition-all duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]` (still
`transition-all`: consumers outside the skin animate position with it — the provider switch knob in
`components/ApiConfiguration.tsx` slides `left-*` — so Atlas's narrow property list,
`color,background-color,border-color,box-shadow,opacity,transform`, lands in Phase D2 with the
restyle), `GLASS`/`GLASS_STRONG`/`MENU` →
`backdrop-blur-[var(--ds-surface-blur)]`, `ACCENT_SOFT_BG` → `bg-[var(--ds-accent-soft)]`. New:
`ON_ACCENT_TEXT`, `FONT_DISPLAY`, `PRESS`, and the status helpers `TONE_TEXT` / `TONE_SURFACE` /
`TONE_FILL` / `TONE_CHIP` mirroring Atlas's `tone.ts` (always pair a tone with a word or icon).
`PRIMARY_BTN` now uses `ON_ACCENT_TEXT` instead of `text-white` (white by default; paper on ink in the
dark skin).

**Wave 5 recipes** (new constants; nothing outside the skin reads them yet — D2 moves components onto
them):

| Constant | Atlas source | What it is |
| --- | --- | --- |
| `FOCUS_RING`, `FOCUS_RING_FLUSH`, `FOCUS_ITEM` | `.atlas-focus-ring`; button / badge / checkbox / switch / select / tabs `focus-visible:outline-*-foreground`; menu items' inset ring and `dark:focus:bg-white/[0.08]` highlight | 2 px `--ds-focus` outline offset 2 (tabs: 0), 3 px under increase contrast; list rows highlight in `--ds-overlay-hover` with an inset `--ds-ring` ring |
| `FIELD`, `FIELD_EMBEDDED`, `FIELD_GROUP` | `ui-generated/input.tsx`, `textarea`, `select` trigger; the document viewer / PDF / sheet search pills | the 3:1 control edge, focus drawn as a **ring** (2 px, offset 2) so an embedded field drops ring **and** offset; the group rests on the hairline as Atlas's pills do (hover ink 25 %) and shows focus **as a field does** — the edge in `--ds-focus` plus the 2 px ring (deviation below) |
| `OVERLAY`, `SCRIM` | dialog / popover / dropdown / select / hover-card / sheet content and overlays | raised step, overlay edge and shadow, opaque; 40 / 60 % scrim without blur |
| `OVERLINE` | `.atlas-overline` | 11 px semibold, 0.12em, uppercase, muted |
| `CHIP`, `CHIP_VARIANT` | `MetaChip` outline / filled / dashed | neutral chips |
| `StatusState`, `STATUS_INK`, `STATUS_SURFACE`, `STATUS_DOT`, `STATUS_CHIP(_TONE)` | `components/connectors/status.tsx` | one status vocabulary: healthy / active / waiting / attention / error |
| `SEGMENTED_TRACK`, `_ITEM`, `_ACTIVE`, `_PILL` | `PanelTabs` (CSS-positioned gliding pill; track `bg-muted/60 dark:bg-muted/50 border-border/70`) | segmented tabs on `--ds-segment-track` with a 70 % hairline; the pill (`--ds-segment-pill` + the `--ds-shadow-segment` ring) glides on `--ds-motion-panel` + spring, jumps under reduced motion. **Live now:** every Comic Studio segmented control paints `SEGMENTED_ACTIVE` on a `--ds-segment-track` well (below) |
| `SECTION_CARD`, `_HEADER`, `_ICON_TILE`, `_TITLE`, `_DESCRIPTION`, `_BODY` | `SectionCard` with `icon` | settings-style section header |
| `TOAST`, `TOAST_EDGE`, `TOAST_COUNTDOWN`, `TOAST_ENTER` / `_EXIT`, `TOAST_TITLE` / `_MESSAGE`, `TOAST_SLOT(_OPEN/_CLOSED)`, `TOAST_EXIT_MS`, `TOAST_EXIT_FALLBACK_MS` | `GlobalNotificationBar` | monochrome toast — `rounded-2xl`, the raised step (Atlas `bg-card`, dark `bg-surface-elevated`), `--ds-toast-edge`, `shadow-panel`; title clamped to 2 lines, message to 3; in over 300 ms (12 px, zoom .98), out over 200 ms (8 px), removed after 240 ms even without an `animationend`; hue only on the edge, bar and icon; the stack glides closed |
| `INVERSE_SURFACE` | `.atlas-inverse-surface` | the inverted ink panel; in dark only ink and page swap back (never the accent, as Atlas) |

`TONE_FILL.danger` and `TONE_SURFACE.danger` read `--ds-danger-mark` (identical paint outside the skin
and in Atlas light; the brighter Atlas red in Atlas dark, where the deep red is under 3:1 as a dot).
`STATUS_SURFACE.error` reads `--ds-status-error-edge` / `-tint` (Atlas's 35 % / 6 % in light, 40 % / 8 %
of the brighter mark in dark).

**Live segmented controls.** The selected segment of every segmented control in Comic Studio is
`SEGMENTED_ACTIVE` on a `bg-[var(--ds-segment-track)]` well: `board/ui.tsx` `Segmented` (the studio
Easy / Pro switch, the board density switch, the reader's Scroll / Page / Spread switch through
`ComicReaderView`, …), `conversation/ui.tsx` `Segmented`, the `ProLetteringPanel` tabs, the
`LetteringToolbar` balloon group, the `CostInsights` tabs and the `ShareSheet` "Who can read it"
group. Outside the skin the tokens are exactly the old paint (raised pill, 8 % drop shadow, the
well; `CostInsights` used the soft shadow, and it only renders inside the always-skinned Comic Studio
root). In the dark skin the pill is the `#1f1f1f` accent step ringed in white 8 % on the half-strength
track — the first wave 5 port had left the raised `#1a1a1a` pill on the `#1a1a1a` well.
`tokenContrast.test.ts` measures pill against track in all six contexts.

**Deliberate deviations from the Atlas source** (kept, with the reason):
- `FIELD_GROUP` focus: Atlas's pills show focus as ink 70 % plus a 20 % ring. Under "increase
  contrast" (and against a 3:1 resting edge) that is under a 3:1 change, so the group shows focus as
  a field does (the focus-colour edge and a 2 px ring); its resting edge is Atlas's hairline.
- `--ds-danger-text` in dark mixes 55 % (Atlas 60 %): the deep dark red at 60 % is 4.36:1 on a hover row.
- Chip radius 10 px (see Skipped).
- `--ds-overlay-hover` in light is Atlas's item highlight (`bg-accent`, `#efefef`) rather than
  `--menu-hover` (`#f2f2f2`): menus under the light skin highlight one step deeper than before.

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
  base rules, the theme-switch rules, the wave 5 tokens, the increase-contrast block, the wave 5
  recipes, and that every rule in the skin section is scoped to the attribute.
- `tests/config/atlasSkinShim.test.ts` — the shim covers every literal utility; the literal count.
- `services/productHost.skin.test.ts` — the attribute is set on the comics host and alias, never on
  the apex; the boot does only what the brief allows (attribute + two preloads; no registration).
- `services/dsSkin.theme.test.ts` also overlaps two cross-fades: only the latest one clears
  `ds-theme-transition`, in either finishing order.
- `services/dsSkin.theme.test.ts` — the theme switch: outside the skin exactly the old toggle; under
  it one view-transition cross-fade for a change the person asked for, instant (transitions held one
  frame) for boot syncs, system corrections, reduced motion, hidden pages and missing / failing APIs.
- `tests/config/tokenContrast.test.ts` also measures the two "increase contrast" contexts, field edges
  and the focus colour (≥ 3:1), the danger mark and every status-vocabulary text on its own surface,
  and the wave 5 outcomes in all six contexts: the selected segment against its track (fill or ring
  ≥ 1.08:1; the two default-dark glass rows are pre-existing outside the skin and listed), a
  highlighted row on an overlay (≥ 1.1:1), the panel text / primary button / focus inside the inverse
  surface (with the custom-property inheritance modelled), `FIELD_GROUP`'s focused vs resting edge and
  its ring (≥ 3:1), and both hairlines strengthening under "increase contrast".
- `components/comicstudio/atlasSkinRoots.test.tsx` — the three roots carry the attribute on the apex.
- The chat tests and the 4-viewport layout smoke (`node scripts/layout-smoke.mjs`) stay green: the
  skin changes nothing outside its scope. The smoke runs the scenes **without** `?skin=atlas`, i.e.
  in the apex case (roots skinned, page not); the page-level skin (fonts, scrollbars, focus outline,
  shim rules on `<html>`) is only covered by the screenshot script below until the harness owner adds
  a `QA_SKIN=atlas` env that `tests/e2e/helpers/harness.ts` `open()` appends as `skin=atlas`, plus
  two smoke projects (`smoke-360x740-atlas`, `smoke-1440x900-atlas`) in `tests/e2e/playwright.config.ts`.
- **Visual proof:** `node scripts/design/atlas-skin-shots.mjs` captures the studio, board, editor,
  immersive reader and public reader at 1440×900 and 360×740, light and dark, with the skin on, into
  `node_modules/.cache/comic-qa/atlas-skin/` (plus `index.json`), from the offline QA harness.

## Synced from Atlas

- Repo: `atlasd`, branch **`origin/claude/quirky-darwin-fpx23q`**, commit **`acd9fdfc`** (2026-10-29,
  "Merge wave 5: system-foundations refinements"; previous sync `07935fcf`). Re-sync:
  `git -C /home/user/atlasd diff acd9fdfc origin/claude/quirky-darwin-fpx23q -- app/globals.css
  tailwind.config.js app/layout.tsx ui-generated docs/current/guides/ui-ux-and-design-language.md`.
- Files that define the language, and what each token group was derived from:
  - `app/globals.css` — `:root` / `.dark` colours (wave 5: overlays `#1a1a1a`, `--control-border`,
    the dark `--shadow-lg` behind `--ds-shadow-overlay`), radius, shadows, motion system (`--motion-ease-enter`, `-enter-quick`,
    `-exit`), scrollbars, the theme switch (view transition + `.atlas-no-transitions`), `@layer base`
    (tap highlight, text-wrap, selection, focus-visible, overlay curves), the effects layer
    (`.atlas-press`, `.atlas-skeleton`, `.atlas-toast-countdown`, `.atlas-inverse-surface`,
    `.atlas-overline`, reduced-motion and `prefers-contrast: more` handling).
  - `tailwind.config.js` — semantic colour names (wave 5: `control`), radius mapping (md = radius − 2,
    sm = radius − 4), shadows soft/panel/lift.
  - `ui-generated/{button,badge,checkbox,input,textarea,select,switch,tabs,scroll-area,dialog,
    alert-dialog,sheet,drawer,popover,dropdown-menu,hover-card,progress,card,tone,tooltip}.tsx` —
    primitive recipes (wave 5: the solid ink focus outline, the field ring and control edge, overlay
    edge / shadow / step, scrims without blur, menu / select item highlights in dark).
  - `components/connectors/status.tsx`, `components/WorkspacePrimitives.tsx`,
    `components/workspace-pages/primitives.tsx`, `components/GlobalNotificationBar.tsx`,
    `providers/ThemeProvider.tsx` — the status vocabulary, section card, segmented tabs, chips, toasts
    and the theme switch.
  - `app/layout.tsx` + `public/fonts/*.woff2` — IBM Plex Sans 400/500/600/700, Space Grotesk 500/600/700
    (unchanged in wave 5).
  - `components/AuthenticatedAppHeader.tsx`, `app/AppShell.tsx`, `components/AppToolbar.tsx` — the
    sticky header (wave 5: a plain surface at the top, frosted only once content scrolls beneath).
  - `docs/current/guides/ui-ux-and-design-language.md`, `docs/brand-asset-source-of-truth.md` —
    lucide for generic icons, brand marks only from checked-in SVGs (unchanged in wave 5).

## Changelog

### Wave 5 port (Atlas `07935fcf` → `acd9fdfc`, 2026-10-29)

Ported (all inside the skin block, `services/dsSkin.ts` and new `studioDesign` constants; nothing
outside `[data-ds-skin="atlas"]` changes):
- **Contrast:** dark overlays a step above cards (`--ds-surface-strong` / `--ds-raised` `#1a1a1a`);
  fields get a 3:1 edge (`--ds-control-border(-hover)`); keyboard focus is the solid ink
  (`--ds-focus`, `FOCUS_RING`); the OS increase-contrast setting applies the high-contrast tokens;
  the danger mark is the brighter red in dark (`--ds-danger-mark`, `TONE_FILL.danger`).
- **Depth:** overlay edge and shadow with the dark top catch (`--ds-overlay-edge`,
  `--ds-shadow-overlay`, `OVERLAY`); scrims without blur (`--ds-scrim`, `SCRIM`).
- **Motion:** the theme switch is one view-transition cross-fade (registration and token transition
  removed); the enter / exit vocabulary (`--ds-ease-enter`, `--ds-motion-enter` / `-exit`); overlay
  pop-ins on the enter curve; reduced motion stops `transition-transform` nudges and Tailwind loops.
- **Primitives:** field ring + embedded-field rule, chips, one status vocabulary, segmented tabs with a
  gliding pill, section cards, toasts (countdown, edge, slot), overline, inverse surface, skeletons.

Review fixes (same port):
- The dark skin's `#1a1a1a` raised step had erased the selected pill of every live segmented control
  (raised pill on the `#1a1a1a` well): they now paint `SEGMENTED_ACTIVE` on `--ds-segment-track`
  (Atlas's PanelTabs pill and track); paint outside the skin unchanged.
- Menu / list highlights on the dark overlays: `--ds-overlay-hover` (white 8 %, Atlas's
  `dark:focus:bg-white/[0.08]`) in `MENU_ITEM` and `FOCUS_ITEM`.
- `.ds-inverse-surface` in dark swaps only ink and page, as Atlas: the accent swap had left the
  root-computed `--ds-accent-fill` behind, a paper label on a paper fill.
- `FIELD_GROUP` shows focus as a field does (see the deviations above).
- Under dark "increase contrast" the soft hairline now strengthens too.
- Recipes aligned with the source: toast (radius, edge, line clamps, 300 / 200 ms), the dark error
  surface (40 % / 8 %), the segmented track (60 % / 50 % muted, 70 % hairline).

Skipped, and why:
- Atlas product surfaces — connectors / profile / settings / about pages, the search home, emails and
  the reading surfaces (document, PDF, sheet, media viewers), the command palette, the workspace
  boot skeleton, the demo seed, public / legal / FAQ / 404 pages, the footer, `getConnectionStatus`
  and its copy ("Reconnect needed", "Not synced for N days") — Atlas's pages, data and words; only
  the vocabulary and recipes behind them were ported.
- tailwindcss-animate overlay rules (`[class*="animate-in"]` curves and their reduced-motion stop) —
  Comic Studio has no tailwindcss-animate; its overlay pop-in (`.animate-scale-in`) got the curve.
- Atlas's Settings toggles (`.atlas-reduced-motion`, `.atlas-high-contrast`, the `atlas:rendering`
  boot preferences, font scale) — Comic Studio has no such settings; the OS media queries are ported.
- `data-inview` loop pausing, `.atlas-live-dot-settle`, `.atlas-disclosure` height animation,
  `.atlas-overline-display`, `Collapse` / `usePresence` / `useInViewPause` hooks, the header's
  scroll-aware glass and its pending-progress sweep — behaviour that needs component or hook code
  (D2 when a Comic Studio surface needs it; the header rule is noted for the D2 shell restyle).
- `::selection` moved out of `@layer` and the removed `:has()` typography block — Atlas build
  performance only; the skin's selection rules were never layered.
- Chip radius: Atlas's MetaChip / StatusChip are `rounded-full` (unchanged in wave 5); the skin keeps
  D0's `--ds-radius-chip` 10 px (badge `rounded-md`) and the recipes read `RADIUS_PILL`. Flagged for
  the lead.
- Dark `--shadow-sm` / `-md` / `-xl` (Atlas deepened them for black pages): Comic Studio has no
  matching tokens — its chrome reads `--ds-shadow-soft` / `-panel` / `-lift` (already Atlas's dark
  values) and `--ds-shadow-overlay` (Atlas's dark `--shadow-lg`). The literal Tailwind `shadow-sm` /
  `shadow-lg` / `shadow-2xl` overlays in Comic Studio files stay 10 % black in dark until D2 moves
  them onto `OVERLAY` / the tokens; a blanket skin rule over `.shadow-lg` would also override their
  `shadow-black/NN` colour modifiers. Listed under Next.

Next (D2): move the Comic Studio controls onto `FOCUS_RING` / `FIELD*` / `OVERLAY` / `SCRIM` /
`STATUS_*` / `TOAST*` (the segmented controls are already on `SEGMENTED_ACTIVE`), the 37
`focus-visible:ring-[var(--ds-ring)]` and the shimmed literal rings onto the ink outline, entrances
(`.animate-fade-in`) onto the 280 ms rise, and the sticky header onto the scroll-aware glass. Also,
each needing a component change Comic Studio has no shared primitive for yet:
- the literal `shadow-lg` / `shadow-2xl` overlays onto `OVERLAY` (`--ds-shadow-overlay`, the dark
  `--shadow-lg`), so they stop vanishing on black (see Skipped);
- the selected tiles of the phone tab bar and the editor toolbar (`--ds-hover` / `--ds-accent-soft`
  `#1f1f1f` on the `#1a1a1a` strong surface, 1.06:1 in dark) onto `--ds-overlay-hover` or
  `SEGMENTED_ACTIVE`;
- forced colours: Atlas's progress bar outlines its track in `CanvasText` and fills in `Highlight`,
  and its switch thumb carries a transparent border so it survives high-contrast mode — Comic Studio's
  progress bars and switches are ad-hoc `div`s (no `Progress` / `Switch` primitive), so these land
  when D2 gives them one;
- Atlas's `ScrollArea` viewport draws focus as a 2 px inset ink outline (an outset one is clipped by the
  scroller): Comic Studio's focusable scroll regions (`tabIndex={0}` panels) still get the base
  outset outline.
