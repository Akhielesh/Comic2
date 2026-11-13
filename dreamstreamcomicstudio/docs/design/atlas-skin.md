# The Atlas skin for Comic Studio

Comic Studio renders in the **Atlas design language** (the owner is unifying the studio designs; a
"fun" theme comes back later as a sibling skin). This page is the one-page reference for how the
skin works, what it maps, where it applies and how it is kept in step with Atlas. Phase D0 is the
token layer, the skin block, the fonts, the tokenized shared constants, a transitional accent shim,
the tests and the visual proof; the **wave 5 port** (Atlas `acd9fdfc`, see the changelog at the end)
brought the skin up to Atlas's refined foundations, and the **wave 8 port** (Atlas `98240e5b`) moved
the studio's eyebrow labels onto OVERLINE, its status text onto the readable tone tokens and its
centred dialogs onto DIALOG_TITLE, each with a guard test. **Wave 9, the bridge** (S1, the "token
commit", see the changelog) put the skin on every host behind a build kill switch, split the glass blur
from the header blur, matched Atlas's 8 px control radius and display-face rule, added the shared motion
classes (`styles/ds-motion.css`), the named `ds` Tailwind colours and the chart / grid / spotlight / hero
tokens. Phases D1/D2 (later packages) rewrite the files that still hard-code the old accent and move
components onto the Atlas primitive recipes.

## The language in one paragraph

White paper, black ink, neutral greys. Hue only ever carries meaning — success, warning,
destructive, info — and is always paired with a word or an icon, never colour alone; one status
vocabulary (healthy, active, waiting, attention, error). Flat surfaces with a hairline border and a
soft shadow; overlays a step above the cards they cover, with a lighter edge in dark; no frosted
glass except the sticky header's blur; modal scrims dim without blur. 12 px cards, 8 px controls
(and chips), 4 px small; 16 px feature cards and a 28 px hero frame. IBM Plex Sans body at 14 px, semibold
for card, sheet and empty-state titles; Space Grotesk only for display type (page and public titles,
`.ds-font-display`). Charts are five monochrome steps of the ink. Motion is
100 / 150 / 200 ms on `cubic-bezier(.2,.8,.2,1)`, panels 220 ms, modals 180 ms, entrances 200 / 240 ms (a 24 ms
stagger step) on a long-tail ease-out and exits a quicker 160 ms, the theme switch one 260 ms cross-fade of the page,
press feedback (scale .98 / .97), tooltips after 300 ms — all off under reduced motion. A crisp 2 px
ink focus outline offset 2 px on every control; fields with an edge that clears 3:1; inverted-ink
selection; thin ink-tinted scrollbars; 44 px touch targets; the OS increase-contrast setting
strengthens hairlines, secondary text, field edges and the colour marks. Dark theme = the same system inverted
(#0a0a0a paper, #fafafa ink). Generic icons are lucide; brand marks only from checked-in SVGs.

## Scope and mechanism

The skin is selected by one attribute, **`data-ds-skin="atlas"`**, which turns on one block of
`--ds-*` token overrides in `index.css`. **Since wave 9 (the bridge, D5) the attribute is on every
host:** `index.html` ships it on `<html>`, so chat, settings, home and the public pages render in the
Atlas language too. The old promise that "chat, settings, home and Stream Studio render
pixel-identical" is retired on purpose: the owner asked for Atlas everywhere ("Atlas everywhere",
master plan §1.2 step 2). Legacy-kit pages read the tokens, so they follow the skin's colours and
radii, and look legacy in their structure until their migration package (DS-3 and on). The build
switch `VITE_DS_SKIN_EVERYWHERE=off` (docs/infrastructure/ENV_MATRIX.md) strips the skin attribute (the
Atlas token block) from every HTML entry, and then the old rule below (comics host only) applies again
to the skin. It does not roll back the rest of wave 9: dark on every page from first paint
(`public/theme-boot.js` plus the root `initTheme()` in `index.tsx`) and the D4 token moves stay, so a
saved dark theme still opens the legacy pages in dark (with the default dark tokens, see "Known limits"
under Wave 9 (bridge)). Reverting the theme change needs a code revert of the `theme-boot.js` script tag in
`index.html` and of that `initTheme()` call. Only the exact value `off` counts; the build warns when the
value looks like an attempt (`OFF`, `false`, `0`, …) and keeps the skin.

| Where | Who sets it | When |
| --- | --- | --- |
| `<html>` — the whole page | `index.html` (static attribute) and `index.tsx` → `services/dsSkin.ts` `bootDsSkin()` | Every host: `index.html` ships the attribute; the boot (synchronously at the very top of `index.tsx`, before React renders) keeps it and appends the two body-weight font preloads (`services/productHost.ts` `hostSkin()`). With the kill switch `VITE_DS_SKIN_EVERYWHERE=off` the build strips the attribute (`vite.config.ts` `dsSkinEverywherePlugin`, every HTML entry, `live.html` included once it carries it) and the boot sets it **only on the comics host** (`comicsSkin()`: `comics.dreamstreamstudio.ai` and its alias). Never via an inline script in `index.html` (its only inline script is CSP-hashed); the no-flash theme script is the external `public/theme-boot.js`. |
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
| `--ds-{success,warning,danger,info}-text` | `ui-generated/tone.ts` `toneText` | `color-mix(in srgb, var(--ds-<tone>) 60%, var(--ds-ink))`; warning **57 %** (wave 8) | same; danger: the **mark** at **65 %** (wave 8 review) |
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
| `--ds-on-danger` (DS-1a) | destructive under `text-white` | `#ffffff` | `#ffffff` (default dark theme: `#1a1915`, ink on its light red) |
| `--ds-chart-1` … `-5` (wave 9) | the chart steps (`--chart-1…5`, monochrome) | `#0a0a0a` `#525252` `#858585` `#b0b0b0` `#d4d4d4` | `#fafafa` `#b8b8b8` `#8a8a8a` `#5e5e5e` `#3d3d3d` (the defaults are the same) |
| `--ds-grid-dot` (wave 9) | `.atlas-grid-backdrop`'s dot | ink at 14 % | ink at 14 % |
| `--ds-spot-ink` (wave 9) | `--atlas-spot-ink` | the ink | the ink |

Under the OS **increase contrast** setting (`@media (prefers-contrast: more)`, wave 5) the skin applies
Atlas's high-contrast tokens: `--ds-hairline` `rgba(0,0,0,0.32)` / dark `oklch(0.52 0 0)` (the soft
hairline 60 % of it in both themes — the dark block restates it, because the base dark block outranks
the light high-contrast one), `--ds-muted` `#404040` / `#d4d4d4`, `--ds-ring` `#000` / `#fff`,
`--ds-control-border` ink 70 % and its hover the full ink. The colour layer's marks move along their
own hue so a dot or a thin bar reads as surely as text: light `--ds-hue-2` `#cd3c8e`, `--ds-hue-3`
`#ba5b03`, `--ds-hue-4` `#06847f`, `--ds-hue-7` `#006a9d`, `--ds-success` `#12873d`, `--ds-warning`
`#a46a07`; dark `--ds-hue-1` `#5a6dfd`, `--ds-hue-5` `#a45adb`, the branch's values exactly. Every light mark is
at least 4.5:1 on the page. The light teal has OKLCH chroma 0.095, just under the 0.10 floor for a hue, because sRGB
has no more chroma at that lightness and hue; it is the one exemption from the floor, pinned to the gamut's limit.
Their soft tints, solids and status text inks are declared on the skin element itself and recompute from the moved colour; the dark base block
outranks the light high-contrast one, so the light moves never reach the dark theme
(`tests/config/atlasHighContrast.test.ts`). (Atlas's own Settings toggle, `.atlas-high-contrast`, has no
Comic Studio counterpart.)

The `-text` variants are the readable status colours (≥ 4.5:1 on the page, on cards, on the soft
glass, on overlays and their highlighted menu rows and on the tinted status surfaces, all six contexts;
wave 8 added the glass, overlay and menu-row surfaces to the measurement); the base tokens are for
fills and borders. Outside the skin the default dark `--ds-danger-text` is `#fca5a5` (wave 8; it was
`#fb8b8b`, 4.15:1 on a hovered row of a raised sheet). Since wave 9 every host carries the skin, so
every page, chat, settings and home included, reads the skin's value (with the kill switch off, only the
comics host and the Comic Studio roots do, and the other pages read this default).

### Type, shape, depth, motion

| Comic Studio | Atlas | Skin value | Default outside the skin |
| --- | --- | --- | --- |
| `--ds-font-sans` | `--font-atlas-sans` | `"IBM Plex Sans", sans-serif` | `Inter, sans-serif` (Tailwind `font-sans`) |
| `--ds-font-display` | `--font-atlas-display` | `"Space Grotesk", sans-serif` | `Inter, sans-serif` (headings inherit) |
| `--ds-text-base` / `-lg` | `--text-sm` / `--text-base` | `0.875rem` / `1rem` | `0.875rem` / `1rem` (unchanged) |
| `--ds-text-xs` / `-sm` | none (Atlas's 11 px labels are `.atlas-overline`) | `0.6875rem` / `0.8125rem` | same |
| `--ds-text-xl` / `-2xl` / `-3xl` (DS-1a) | `--text-xl` / `--text-2xl` / `--text-3xl` | `1.25rem` / `1.5rem` / `1.875rem` | same |
| `--ds-radius-panel` | `--radius-xl` | `0.75rem` (12 px) | `1rem` (`rounded-2xl`) |
| `--ds-radius-control` | `rounded-md` (8 px; wave 9 bridge D1, was `--radius-lg` 10 px) | `0.5rem` (8 px) | `0.75rem` (`rounded-xl`) |
| `--ds-radius-chip` | badge `rounded-md` (8 px; bridge D1) | `0.5rem` (8 px) | `9999px` (`rounded-full`) |
| `--ds-radius-feature` (wave 9) | feature cards (`rounded-2xl`) | `16px` | same |
| `--ds-radius-hero` (wave 9) | the hero frame (`rounded-[28px]`) | `28px` | same |
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
| `--ds-motion-enter` / `-exit` | `--motion-enter-quick` / `--motion-exit` | 200 / 160 ms | 280 / 160 ms |
| `--ds-motion-enter-quick` | `--motion-enter-quick` | an alias of the 200 ms `--ds-motion-enter` | an alias of the 280 ms `--ds-motion-enter` |
| `--ds-motion-enter-slow` | `--motion-enter` (page and section entrances) | 240 ms | 420 ms |
| `--ds-motion-stagger` | `--motion-stagger-step` | 24 ms | 40 ms |
| `--ds-tooltip-delay` | `--tooltip-delay` | 300 ms | 300 ms |
| `--ds-glass-blur` (wave 9, bridge D3) | none: Atlas surfaces are opaque | `0` | 12 px (`backdrop-blur-md`; GLASS, GLASS_STRONG, MENU) |
| `--ds-header-blur` (wave 9, bridge D3) | the sticky header's `blur(18px)` | 18 px | 18 px (HEADER_GLASS, once content scrolls under) |
| `--ds-surface-blur` | the pre-split name | `var(--ds-glass-blur)` (an alias; nothing reads it) | `var(--ds-glass-blur)` |

**z ladder and densities** (`--ds-z-*`, `--ds-density-*`, DS-1a): DreamStream-only tokens, the same value
in every skin (Atlas has none); see `docs/design/design-system.md`.

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

Reader-room tokens (`--ds-reader-room`, `--ds-reader-paper-back`, `--ds-reader-endpaper`, and since
wave 9 `--ds-reader-focus`, the reader's focus-ring colour: the reader ink, ≥ 4.5:1 on the paper in every
context, and for the paper only: 1.5:1 on the room, where controls use `--ds-focus`) are content, not chrome, and are deliberately not overridden.

A `.dark` subtree inside a light page (a dark demo panel or preview) restates the var()-derived tokens
too (`:where(.dark:not(:root))`, zero specificity so a skin block on the same element still wins);
atlasSkin.test.ts keeps that list equal to `:root`'s.

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
| `OVERLINE` | `.atlas-overline` | 11 px semibold, leading 1rem, 0.12em, uppercase, muted. **Live since wave 8:** every eyebrow in `components/comicstudio` (below) |
| `DIALOG_TITLE`, `DIALOG_TITLE_FROM_SM` (wave 8) | `DialogTitle` / `AlertDialogTitle` (`text-xl font-semibold`) | 20 px semibold, leading 1.75rem, the body face (wave 9: Atlas's dialog titles are not `atlas-display`), no colour of its own; the `_FROM_SM` form applies from `sm` up for a dialog that is a bottom sheet on phones. **Live:** the five centred modal dialogs |
| `CHIP`, `CHIP_VARIANT` | `MetaChip` outline / filled / dashed | neutral chips |
| `StatusState`, `STATUS_INK`, `STATUS_SURFACE`, `STATUS_DOT`, `STATUS_CHIP(_TONE)` | `components/connectors/status.tsx` | one status vocabulary: healthy / active / waiting / attention / error |
| `STATUS_EDGE` (wave 8) | the status surfaces' border alone | a neutral surface (a toast, a hint bubble) that borders in a state's colour; `STATUS_SURFACE` is this edge plus the tint (same strings as before) |
| `TONE_CHIP_ON_ART` (wave 8 review) | `TONE_CHIP` over an image | the tone's 10 % tint mixed into the opaque `--ds-raised` (neutral: raised + muted), so a status pill on a thumbnail is the measured "tone surface on raised" pairing over any art |
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
- `--ds-danger-text` in dark mixes the danger **mark** (Atlas's `--destructive-foreground`) at 65 % into
  the ink, not Atlas's 60 % of the deep fill red: the deep red at 60 % is 4.36:1 on a hover row, and the
  50 % that cleared 4.5:1 (wave 8) was rgb(190,137,138), OKLCH chroma 0.065 beside the muted grey's 0, so
  the studio's danger menu rows read as dim secondary items. The mark at 65 % is rgb(250,116,123),
  chroma ≈ 0.16: 7.41:1 on the page and ≥ 5.20:1 everywhere it is measured (lowest: a highlighted
  menu row). `tokenContrast.test.ts` holds the danger text ≥ 0.1 chroma, and ≥ 0.08 above the muted
  grey's, in every context (wave 8 review).
- `--ds-warning-text` in light mixes 57 % (Atlas 60 %, wave 8): at 60 % it is 4.35:1 on its own tint over
  the soft glass (`#f4f4f4`) and 4.46:1 on a highlighted menu row; at 57 % 5.52:1 on the page and
  ≥ 4.69:1 everywhere it is measured.
- `DIALOG_TITLE` leading is 1.75rem (Atlas's AlertDialogTitle, text-xl's own) rather than DialogTitle's
  restated `leading-none`: Comic Studio's dialog headers truncate to one line, where a 20 px line box
  clips descenders, and wrap on phones, where it crowds the lines.
- Chip radius 10 px (see Skipped).
- `--ds-overlay-hover` in light is Atlas's item highlight (`bg-accent`, `#efefef`) rather than
  `--menu-hover` (`#f2f2f2`): menus under the light skin highlight one step deeper than before.

**Deliberate differences from Atlas** (the colour layer and the shell, as of the Atlas design branch at `43b2f8ec`):
- **Diverging chart steps 4-7.** Ours are light `#d4d4d4 #aabbf5 #6a81f2 #3d44e8`, dark `#4a4a4a #404dc1 #7085ff
  #a2b2ff`; the Atlas design branch carries `#e5e5e5 #a3b4f2 #6279f1 #322cd3` / `#3d3d3d #3d48b5 #6275fc #a2b2ff`.
  `tests/config/chartRamps.test.ts` asks for a grey midpoint and two arms equal within 0.01 OKLab L; ours pass
  (0.000-0.001), the branch's arms differ by up to 0.059 L in light and 0.041 in dark.
- **Chart series order.** Charts take the hues in `CHART_HUE_ORDER` = [1, 2, 6, 7, 3, 4, 5]; the branch uses the plain
  order 1-7. The plain order puts magenta and teal 1.1 ΔE apart under deuteranopia (`huePalette.test.ts`).
- **Hue text steps.** Ours are measured hexes (`--ds-hue-N-text`, ≥ 4.5:1 on every surface and on the hue's own tint);
  the branch mixes 60 % of the hue into the ink.
- **The dark tag tint base.** Our soft tint mixes the hue into the raised step (`#1a1a1a` in dark), the branch into its
  card (`#111111`); ink and the text steps are measured on ours.
- **Not taken yet:** per-hue glyph colours on a solid (the branch puts dark glyphs on magenta, orange, teal and sky in
  light; we keep one `--ds-on-hue` and icons only there); a named neutral hue and a named "Other" series token, and the
  chart animations (grow-x / grow-y) and forced-colours chart marks, which wait for the charts work; the shell patterns
  (the workspace frame and its wide steps, the left-dock slide-in, the floating offline pill, the skeleton loading
  panel), which wait for the shell work.

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
- `services/productHost.skin.test.ts` — wave 9: with the kill switch on (the default) the attribute
  index.html ships stays on every host, the apex included; with `VITE_DS_SKIN_EVERYWHERE=off` it is set
  on the comics host and alias only; the boot does only what the brief allows (attribute + two
  preloads; no registration).
- `services/dsSkin.theme.test.ts` also overlaps two cross-fades: only the latest one clears
  `ds-theme-transition`, in either finishing order.
- `services/dsSkin.theme.test.ts` — the theme switch: outside the skin exactly the old toggle; under
  it one view-transition cross-fade for a change the person asked for, instant (transitions held one
  frame) for boot syncs, system corrections, reduced motion, hidden pages and missing / failing APIs.
- `tests/config/overlineGuard.test.ts` (wave 8) — no hand-rolled eyebrow in `components/comicstudio/**`:
  an `uppercase` class whose class list also spells `tracking-wide|wider|widest` or a positive arbitrary
  tracking, or a plain `uppercase` at 9–12.5 px with no tracking at all. A class list is one literal, one
  template, one `cx(…)` call with its conditionals or one JSX `{…}` expression, however many lines it
  spans and wherever it lives; files are read with TypeScript's parser (`tests/config/classLists.ts`).
  Its commented allowlist pins the exact source lines it permits (not a count), and no studio file
  imports the pre-Atlas `LABEL`.
- `tests/config/statusInkGuard.test.ts` (wave 8) — Atlas's status-ink guard for `components/comicstudio/**`:
  no raw chromatic Tailwind text colour (`text-amber-700`, `dark:text-red-300`, …) outside its commented
  allowlist, which pins each permitted use (token and line), not a count. Also (wave 8 review): no class
  list in which two different unvariant text colours can apply together — `cx` joins, it does not
  merge, and Tailwind emits `--ds-danger-text` / `--ds-info-text` before `--ds-ink` / `--ds-muted`, so a
  tone stacked on a base constant's ink rendered plain ink; a tone or an emphasis is chosen against the
  neutral ink instead (`danger ? TONE_TEXT.danger : 'text-[var(--ds-ink)]'`). And no white text or icon
  on a light amber / yellow fill (2.15:1).
- `tests/config/dialogTitle.test.ts` (wave 8) — the recipe; every `aria-modal` surface in the studio is
  classified, centred dialogs title with `DIALOG_TITLE(_FROM_SM)`, sheet and popover headers stay 15 px.
- The three wave 8 guards above also ratchet the rest of the app (`components/**`, `App.tsx`, `qa/**`)
  against `tests/config/baselines/<guard>.json` (DS-0): `statusInk.json`, `overline.json`,
  `dialogTitle.json`. The rules are in `tests/config/baselines/README.md`.
- `tests/config/legacyKitGuard.test.ts` (DS-0) — `border-black`, `shadow-comic`, `font-comic`, the
  `brand-*` colours and Tailwind's `font-display` (Bangers), ratcheted per file against `legacyKit.json`.
- `tests/config/terracottaGuard.test.ts` (DS-0) — the `#D97757` / `#c2643f` literals, against
  `terracotta.json`; the third-party Anthropic logo fill is its one allowlisted use.
- `tests/config/localCxGuard.test.ts` (DS-0) — no local `cx` class joiner (it joins, it does not merge:
  the wave 8 ink bug); compose with `cn`.
- `tests/config/zLadderGuard.test.ts` (DS-0) — no raw `z-NN` / `z-[…]` outside the `Z` recipe
  (`components/ds/**` and `studioDesign.ts` are where the ladder is spelled).
- Every scanned file is parsed in its own language (`.ts` as TypeScript, `.tsx` as TSX), and
  `tests/config/baselines/ratchet.test.ts` fails on a syntax error, because the parser would otherwise guess
  past it and lose literals. A moved file is recorded with `BASELINE_MOVES='old=new' UPDATE_BASELINES=1`
  (README "Moving a file"), never with `reset`.
- The design system itself: `docs/design/design-system.md`, `components/ds/ds.hygiene.test.ts` (the
  primitives and the gallery scene count 0 for every guard), `tests/config/dsMotion.test.ts`
  (`styles/ds-motion.css`), `tests/config/dsColours.test.ts` (the named `ds` colours) and
  `tests/config/dsSkinEverywhere.test.ts` (the skin on every host and its kill switch).
- `tests/config/tokenContrast.test.ts` measures every status `-text` token on the page, cards, the soft
  glass, raised overlays, hovered and highlighted menu rows and its own tint over each (wave 8), and also
  measures the two "increase contrast" contexts, field edges
  and the focus colour (≥ 3:1), the danger mark and every status-vocabulary text on its own surface,
  and the wave 5 outcomes in all six contexts: the selected segment against its track (fill or ring
  ≥ 1.08:1; the two default-dark glass rows are pre-existing outside the skin and listed), a
  highlighted row on an overlay (≥ 1.1:1), the panel text / primary button / focus inside the inverse
  surface (with the custom-property inheritance modelled), `FIELD_GROUP`'s focused vs resting edge and
  its ring (≥ 3:1), and both hairlines strengthening under "increase contrast".
- `components/comicstudio/atlasSkinRoots.test.tsx` — the three roots carry the attribute on the apex.
- The layout smoke (`node scripts/layout-smoke.mjs`): `tests/e2e/helpers/harness.ts` honours
  `QA_SKIN=atlas` and `QA_THEME=dark` for any project, and each project's `look` (`tests/e2e/devices.ts`
  `APP_SMOKE_DEVICES`). `smoke-360x740-atlas` (page-level skin) and `smoke-1440x900-dark` (OS dark
  scheme) run the whole smoke over the app, studio, kit and model-picker scenes; `smoke-320x640` and
  `motion-on` run the app scenes (`@app`) only, and so do the redesign plan's M2 additions
  (`smoke-320x568`, `smoke-fold5-dual`, `smoke-852x393`; the full app-scene matrix is `APP_SCENE_MATRIX`).
  The studio scenes are therefore covered under the page-level skin at 360. The other studio projects
  still open the harness without `?skin=atlas` (the kill-switch-off case: roots skinned, page not).
- **Visual proof:** `node scripts/design/atlas-skin-shots.mjs` captures the studio, board, editor,
  immersive reader and public reader at 1440×900 and 360×740, light and dark, with the skin on, into
  `node_modules/.cache/comic-qa/atlas-skin/` (plus `index.json`), from the offline QA harness.

## Synced from Atlas

- The Atlas repository, its design branch, commit **`43b2f8ec`** (2026-11-13): taken from it are the
  high-contrast hue and status overrides, the shorter entrances under the skin (200 / 240 ms, a 24 ms step) and the
  guard against a status colour or a chart step used as text; what differs on purpose is listed under "Deliberate
  differences from Atlas" above. Before it, commit **`c567c621`** (checked 2026-11-12). The
  design files are byte-identical from `0677199b` through `c567c621`: the one commit after `7a6f3e16` touches none of
  them, and the 4 commits after `292b17b6` change only `lib/server`, deploy, CI and docs, nothing to port. At the S2a
  check (`292b17b6`) the 7 commits since `0677199b` changed connector,
  beta-copy and `lib/server` code, tests and docs, and the only design-list hit was again Atlas's own connector copy
  guard (`tests/lib/beta-connector-copy.test.ts`, a Google Photos case). At `0677199b` the design files
  were **byte-identical to `acbdaff7`**: `app/globals.css`, `tailwind.config.js`, `ui-generated/**`,
  `components/WorkspacePrimitives.tsx`, `components/shell/**`, `GlobalNotificationBar`, `PublicSiteChrome`,
  `GlobalFooter`, `WorkspaceShell`, `AuthenticatedAppHeader`, `app/layout.tsx`, `AppShell` and the UI guide; the
  12 commits since are security dependency bumps, connector fixes and public beta-copy pages, and the only
  design-list hit is a copy guard for Atlas's own connector pages (`tests/lib/beta-connector-copy.test.ts`), nothing
  to port. The wave 9 bridge (changelog) ports the motion system, the effects hooks and the token decisions
  agreed with the Atlas session from `0677199b`. Previous syncs `7a6f3e16`, `292b17b6`, `0677199b`, `acbdaff7` (= `98240e5b` design files),
  `496f265c`, `acd9fdfc`, `07935fcf`. Re-sync, in an Atlas checkout:
  `git diff 43b2f8ec <design branch> -- app/globals.css
  tailwind.config.js app/layout.tsx ui-generated components/shell hooks components/effects docs/current/guides/ui-ux-and-design-language.md tests/lib`.
- Port targets: `index.css`, `styles/ds-motion.css`, `components/chat/studioDesign.ts`, `components/ds/**`,
  `packages/platform-core/src/brand/skins/atlas.ts` and this page (master plan §1.5).
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
  - `tests/lib/status-ink-guard.test.ts`, `tests/lib/dialog-title-size-guard.test.ts` (wave 8) — the
    rules Comic Studio's status-ink guard and dialog-title test mirror.

## DreamStream extensions (not from Atlas)

These `--ds-*` names are DreamStream's own. Atlas has no counterpart, so an Atlas sync check-in diffs only Atlas names
and skips these. They take the same values with and without the skin (light and dark below), in `index.css` and both
brand skins (`packages/platform-core/src/brand/skins/{dreamstream,atlas}.ts`).

The colour layer "Ink & Spark" (CL-0; `docs/design/design-system.md` § Colour layer), 12 names:

| Token | Light | Dark |
| --- | --- | --- |
| `--ds-spark` | `#3d44e8` | `#8b9bfe` |
| `--ds-spark-hover` | `#3438cc` | `#a3b2fe` |
| `--ds-on-spark` | `#ffffff` | `#0a0a0a` |
| `--ds-spark-text` | `#3d44e8` | `#abb9fe` |
| `--ds-spark-soft` | `color-mix(in srgb, var(--ds-spark) 8%, var(--ds-canvas))` | the same at 16 % |
| `--ds-spark-glow` | `color-mix(in srgb, var(--ds-spark) 24%, transparent)` | the same at 30 % |
| `--ds-hue-1` | `#3d44e8` | `#5568fd` |
| `--ds-hue-2` | `#d13d91` | `#d84497` |
| `--ds-hue-3` | `#db6b04` | `#df6e07` |
| `--ds-hue-4` | `#079a94` | `#04a19b` |
| `--ds-hue-5` | `#9548cc` | `#a155da` |
| `--ds-art` | `var(--ds-well-strong)` | `var(--ds-well-strong)` |

The colour layer "Ink, Paper & Colour" (CL-6, R02; `docs/design/design-system.md` § Colour layer) adds 43 names in all
four blocks: `--ds-hue-6` leaf (`#567d01` / `#6e9e01`) and `--ds-hue-7` sky (`#0089c9` / `#0c9edc`); for each of the seven
hues a readable `--ds-hue-N-text`, an opaque `--ds-hue-N-soft` (12 % light, 16 % dark, over `--ds-raised`) and a
`--ds-hue-N-solid`; the one label colour `--ds-on-hue` (`#ffffff` / `#0a0a0a`); the chart ramps `--ds-chart-seq-1…6` and
`--ds-chart-div-1…7` (`--ds-chart-1…5`, the bridge's ink steps, are unchanged); the washes `--ds-wash-hero` (stronger
under this skin: 20 / 18 / 12 % light, 26 / 22 / 16 % dark) and `--ds-wash-empty`; the studio accent `--ds-studio` /
`--ds-studio-soft` (`[data-ds-studio]`: chat teal, live magenta, models violet, **atlas sky**; Comic Studio none); and the
art tint's card defaults `--ds-art-soft` / `--ds-art-edge` (derived inside `.ds-art-scope`). The build switch
`VITE_DS_COLOUR=off` turns all of them neutral.

**Offered to Atlas** (the same colours in Atlas; we never edit Atlas, the Atlas session decides):
`--hue-1…7` with the marks above, `--hue-N-text` and `--hue-N-soft` with the same values and rules (a tag is ink on the
soft tint; coloured words only on slots 1, 5 and 7; a chart takes the hues in the order 1, 2, 6, 7, 3, 4, 5), and the
studio accent sky for Atlas itself. Atlas's `--chart-1…5` stay its ink steps.

Also DreamStream's own: the art develop tokens `--ds-develop-light` (`rgb(255 255 255)`; dark
`rgb(255 255 255 / 0.55)`) and `--ds-develop-sheen` (white at 0.18; dark 0.15), read by `ImageDevelop` (MO-1).

The `--ds-reader-*` names (`--ds-reader-accent`, `--ds-reader-hud-focus`, `--ds-reader-glass`, `--ds-reader-turn*`,
`--ds-reader-spot*`, `--ds-reader-ink*` and the rest, on `[data-reader-root]` in
`components/comicstudio/immersive/readerDesigns.css`) are **reserved DreamStream reader-scope names**, not skin
tokens: they are not in `:root` or the brand skins, and Atlas should not define them. `--ds-reader-room`,
`--ds-reader-paper-back` and `--ds-reader-focus` stay on `:root` (reader content, not skinned).

No Atlas token changes name or value. The default (non-Atlas) skin's `--ds-info` / `--ds-info-text` are neutral since
CL-0 (`#525252` / `#404040` light, `#e5e5e5` dark): the old blue was ΔE 6.4 / 3.7 from the spark.

## Changelog

### S2b — the app shell (DS-2; Atlas `7a6f3e16`, design files = `0677199b`, 2026-11-12)

- DS-2 (S2): index.html's body and #app-splash read --ds-canvas/--ds-ink with the skin values as fallbacks (appShell.test.ts
  pins them); the body text stays the light ink for the legacy pages. The site header is AppHeader. The App root reads the
  canvas except LEGACY_PAPER_VIEWS (dashboard, learn, editor, fontlab).
- Lead decision D8: the browser chrome colour (both `theme-color` metas and `public/app.webmanifest` theme_color) is the
  Atlas paper, #ffffff light and #0a0a0a dark, pinned to the `[data-ds-skin="atlas"]` --ds-canvas by appShell.test.ts. The
  default skin's #FAF9F5 / #262624 read as a warm band above the dark Atlas page. Not changed: the manifests'
  background_color, `public/comics.webmanifest` and the QA page `qa/comic-qa.html`.
- Lead decision D9: the shell's Contact link, the home page, the comics landing (DS-3) and the studio-access refusal write
  to the one support address, `SUPPORT_EMAIL` (components/legal/contacts.ts, Atlas #263's constant). ComicReader's footer address (Atlas #263
  owns that line) and Stream Studio (live/**, owner to confirm) are unchanged.
- Atlas #263 (lead decision (a)): #263 is not in dev, so DS-2's `components/layout/LegalMicroLinks.tsx` ships as DS-2
  built it (on `SUPPORT_EMAIL`). The rebase recipe for when #263 reaches dev (keep #263's nav, anchors and handlers,
  DS-2's link class and 44 px targets, `CONTACT_HREF = mailto:${SUPPORT_EMAIL}`) is a carry note for the next
  integration.

### S2a — the colour layer (Atlas `292b17b6`, design files = `0677199b`, 2026-11-12)

- The 12 colour-layer tokens and the two develop tokens, as DreamStream extensions (above). Their values ship as CL-0
  built them (S2a lead decision). The Atlas session has the names.
- The default skin's info pair went neutral; Atlas values are untouched.
- The How It Works pin `:root.dark .hiw-gradient-text` (selector `:root.dark`, because `atlasSkin.test.ts` bridge D4
  rejects hex literals in rules whose selector starts with `.dark .hiw-gradient-text`; the pin sets token values only,
  so the paint rule still reads tokens).
- The reader's `--ds-reader-*` set moved into `readerDesigns.css` (RD-A): reserved reader names, not skin tokens.

### Wave 9 (bridge) — the S1 token commit (Atlas `0677199b`, design files = `acbdaff7`, 2026-11-05)

Decisions agreed with the Atlas session, applied in one integration with DS-0 (guards), DS-1a (tokens and
primitives) and DS-1b (the QA harness).

**Mapping.**
- D1: `--ds-radius-control` and `--ds-radius-chip` are `0.5rem` under the skin: Atlas's `rounded-md`
  resolves to 8 px. (The atlas brand kit's email button radius follows: 10 → 8 px.)
- D2: the display face (Space Grotesk) only on `.ds-font-display` — FONT_DISPLAY, HEADING, `PAGE_TITLE`
  and the page and public titles that use them. The blanket `[data-ds-skin] :is(h1…h4)` display rule is
  gone (headings still balance their lines). `CARD_TITLE`, `SECTION_TITLE`, `DIALOG_TITLE`, sheet headers
  and empty-state titles are IBM Plex Sans semibold. Tailwind's `font-display` (Bangers) is never used. The
  public titles that relied on the blanket rule now ask for it, as Atlas's own public hero and section
  titles carry `atlas-display`: the comics landing's hero `h1` and its section `h2`s (`ComicsLanding.tsx`,
  through `DISPLAY_HERO` / `DISPLAY_SECTION`) and the public reader cover's `h1` (`ReaderCoverCard.tsx`).
- D3: the glass blur and the header blur are two tokens. `--ds-glass-blur` (12 px by default, 0 under the
  skin) for GLASS, GLASS_STRONG and MENU; `--ds-header-blur` (18 px everywhere) for the new
  `STICKY_HEADER` + `HEADER_GLASS` recipes (the blur on an aria-hidden layer, only once content scrolls
  under, so the header never becomes a fixed descendant's containing block). `--ds-surface-blur` stays
  as an alias of the glass blur.
- D4: the chat markdown links (`--ds-info-text`, ink on hover), code blocks (well and hairline),
  `.studio-shimmer` (the skeleton tokens) and `.hiw-gradient-text` (status hues by default, the heading's
  own ink under the skin: `color: inherit`, since How It Works stays light in dark) read tokens; their
  hexes are gone.
- D5: Atlas on every host. `index.html` ships `data-ds-skin="atlas"` on `<html>`; the build kill switch
  `VITE_DS_SKIN_EVERYWHERE=off` strips it from every HTML entry (`vite.config.ts`, no file-name filter, so
  `live.html` rolls back with it once it carries the attribute). `initTheme()` runs at the app root and
  `public/theme-boot.js` (external, CSP `'self'`) sets `.dark` before first paint. The single inline script
  and its CSP hash are unchanged. Found in the visual check: the legacy-kit pages (dashboard, settings) keep
  their light surfaces in dark, but a bare form control took the dark UA field from
  `.dark { color-scheme: dark }` under the page's slate-900 ink (typed text 1.5:1). The kit's controls
  (`border-black`) keep `color-scheme: light` in dark until their package moves them to the DS Field
  (`index.css`; `atlasSkin.test.ts`).
- D6: the named `ds` colours in Tailwind (`bg-ds-canvas`, `text-ds-ink/60` via color-mix).
- D7: `styles/ds-motion.css`, Atlas's motion system on the `--ds-*` tokens (entrances, stagger, scroll
  reveal, disclosure, lift, link, skeleton, shimmer text, indeterminate progress, live dot, caret,
  marquee, edge fades, grid backdrop, overlines, display), with one reduced-motion block; the hooks and
  primitives `useInViewPause` / `InViewPause`, `LiveDot`, `CountUp`, `Collapse` in `components/ds`. The
  spotlight group is not ported (the header and home work owns it).
- §3.2 tokens: `--ds-chart-1…5`, `--ds-grid-dot`, `--ds-spot-ink`, `--ds-radius-hero` (28 px),
  `--ds-radius-feature` (16 px); the defaults equal the skin values.
- M1a: `--sidebar-w` (240 px, beside `--rail-w`), `--ds-reader-focus`, the `LIFT` and `RISE_IN` recipes,
  `.studio-stagger` on the entrance and stagger tokens.

**Deviations from Atlas.**
- `.ds-lift` lifts only on a pointer that really hovers (`(hover: hover) and (pointer: fine)`); Atlas's
  `.atlas-lift:hover` also lifts after a tap on touch.
- Atlas's own Settings › Reduced motion (`.atlas-reduced-motion`) has no counterpart: the OS setting is the
  one switch.
- The "pixel-identical outside the skin" promise is retired (Scope and mechanism): the owner asked for
  Atlas everywhere. The kill switch restores the old scope of the skin attribute only: dark on every page
  from first paint and the D4 token moves stay (Scope and mechanism).
- `.ds-reveal`'s range is `entry 0% entry min(200px, 100%)`, not Atlas's `entry 0% entry 200px`: with a
  fixed 200 px an element shorter than that at the end of a page, or anything in the bottom 200 px of a
  page that cannot scroll, never finished (a 60 px last row stayed at opacity 0.84, 3 px short). Tall
  panels arrive exactly as in Atlas (`dsMotion.test.ts`).
- `DIALOG_TITLE` is the body face, as Atlas's DialogTitle and SheetTitle (no `atlas-display`); until wave 9
  review it carried the display face, which Atlas never gave a dialog title (`dialogTitle.test.ts`).

**Known limits.**
- With the kill switch off, in dark, How It Works stays a light page: `:root.dark .hiw-gradient-text` pins the light
  info / danger / warning stops (#525252, #dc2626, #d97706: 7.8, 4.8 and 3.2:1 on white; tokenContrast.test.ts).
  Under the skin the words take the heading's own ink (`color: inherit`). (Since CL-0 this is no longer a known
  limit; until then the words took the default dark hues, 2.5, 2.8 and 1.6:1 on white.)
- The legacy Universal Assistant's answer bubble stays white in dark; `index.css` pins the light markdown
  tokens inside it (`.dark .bg-white.border-black .message-body`, link 6.7:1, code 16:1, table header
  13:1). The pin goes with the legacy-kit package, with the form-control rule.

### Wave 8 port (Atlas `496f265c` → `98240e5b`, 2026-10-30)

Atlas wave 8 changed four things in its design files (`app/globals.css`, `ui-generated/dialog.tsx`,
`ui-generated/alert-dialog.tsx`, `tests/lib/status-ink-guard.test.ts`); palette, fonts, radii, shadows and
motion are unchanged, so no colour, shape or motion token moved for the port's own sake.

**1. Type scale — verified, no token change.** Atlas's `--text-*` now mirror Tailwind (`lg` 20 → 18 px,
`xl` 24 → 20, `2xl` 32 → 24, new `3xl` 30) and its `.text-xs … .text-2xl` overrides are gone; it moved
every use, so its visible sizes are unchanged. Its 12 / 14 / 16 px steps (`--text-xs/sm/base`) did not
change. Comic Studio's chrome scale maps onto them as before: `--ds-text-base` 14 px = Atlas `--text-sm`,
`--ds-text-lg` 16 px = `--text-base`; `--ds-text-xs` 11 px and `--ds-text-sm` 13 px have no Atlas step
(Atlas's 11 px labels are `.atlas-overline`). Comic Studio never redefined Tailwind's `text-*` classes
(`tailwind.config.cjs` has no `fontSize`), so the inversion Atlas fixed (its `text-2xl` above `text-3xl`)
never existed here. No `--ds-text-*` value changed.

**2. Overlines — adopted, with a guard.** 35 eyebrows in `components/comicstudio/**` now use `OVERLINE`,
keeping their element, margins and copy: 26 hand-rolled labels (10.5–12 px, `uppercase` with
`tracking-wide` / `tracking-wider`, including the shared `SectionLabel` (conversation/ui) and
`SectionTitle` (board/ui), the recap card's row labels and the media bin's group toggles) and the 9 uses
of the pre-Atlas `LABEL` recipe (10 px, 0.05em) in the model detail sheet, the model picker and the cost
insights. Not overlines, left as they are and allowlisted (each pinned to its line): the script's speaker
names and the wireframe shot labels (`tracking-wide`; content of the script and the thumbnail), the
compare table's column headers (the version numbers being compared — Atlas wave 8 kept its spreadsheet
column letters off `.atlas-overline` too; wave 8 review) and the "Cover" word drawn at tile scale inside a
cover thumbnail; lettering case and first-letter capitals are not class-list eyebrows. Two eyebrows got
room for the wider overline (wave 8 review): the cost insights' "Where it went · share of your usage"
breaks at the dot on a 320 px phone (the suffix is one unbreakable span), and the library console's stat
labels wrap instead of truncating, in as many 5.75rem columns as fit (three from about 350 px, two on the
narrowest phones), values aligned along the bottom. `OVERLINE_DISPLAY` (`.atlas-overline-display`, 12 px medium 0.18em, Atlas's
public-page section labels) was not added: no Comic Studio surface has a matching larger eyebrow.
`components/usage/UsageMeter.tsx` also hand-rolls one but is shared with chat, so it stays.
Guard: `tests/config/overlineGuard.test.ts`.

**3. Readable status ink — adopted, with a guard.** Of the 118 raw Tailwind hue text classes in
`components/comicstudio/**` (`text-amber-700 dark:text-amber-300`, `text-red-600`, `text-emerald-*`,
`text-sky-*`), 116 now read the readable tone tokens through the recipes, across 33 files:
`TONE_TEXT.success|warning|danger|info` (`--ds-*-text`) for words and icons, `TONE_CHIP` for chips and
inline banners (the 10 % tint the contrast test measures), `STATUS_SURFACE` / `STATUS_CHIP_TONE` for
status rows and callouts, and the new `STATUS_EDGE` for a neutral toast or bubble that only borders in a
state's colour. Their 38 paired raw tints, edges and rings went with them (e.g. `bg-amber-500/15` →
`TONE_CHIP.warning`, `border-red-500/30` → `STATUS_EDGE.error`, the unpublish button's
`hover:bg-red-500/[0.08]` → `--ds-status-error-tint`). Under the skin, info is Atlas's monochrome (grey
ink), and warning / danger / success follow the skin in both themes. Allowlisted, with a comment each:
the marked-area chip's icon in the page editor (it echoes the red marquee drawn over the art) and the
starred glyph on the black scrim over a media thumbnail. Content colours (lettering, balloon and caption
swatches, pickers, art, the link-preview mock) are inline styles or hex, never hue classes.
Tokens: no new token was needed (`--ds-info-text` already existed); three values moved so the text
clears 4.5:1 on the menus, overlays and soft glass it now sits on — Atlas light `--ds-warning-text` 57 %,
Atlas dark `--ds-danger-text` from the mark at 65 % (deviations above; wave 8 review — the first port's
50 % of the deep red read as the muted grey) and the default dark `--ds-danger-text` `#fca5a5`.
Measured (WCAG 2.x, `tokenContrast.test.ts` cascade), on the page / lowest anywhere: default dark danger
7.99 / 5.00 (a hovered row on a raised sheet); Atlas light warning 5.52 / 4.69 (its tint over the soft
glass); Atlas dark danger 7.41 / 5.20 (a highlighted menu row). On the surfaces the matrix measures, every
status text in all six contexts is 4.61–17.26:1 (the `STATUS_*` 6 % / 8 % tints are held to ≥ 4.5:1 by the
vocabulary test). Guard: `tests/config/statusInkGuard.test.ts`.

Review fixes (same port): three destructive buttons — the Easy and Pro lettering panels' Delete and a
reference photo's Remove — had `TONE_TEXT.danger` stacked on a shared button constant that already said
`text-[var(--ds-ink)]`; `cx` joins without merging and Tailwind emits the danger ink first, so they
rendered plain ink. The constants are now a shape without an ink plus the neutral button
(`BTN_SHAPE` / `BTN`), and the tone is chosen, not stacked (also the lettering toolbar's Fix edges).
The guard's class-list check found six older lists with the same accident, where an emphasis on a muted
base never showed (the plan and breakdown cards' "Drawing…" note, the picked add-balloon segment, the
phone editor's active tool, the model row's price line, the timeline's add-clip glyph); each now
chooses its ink. Pills drawn OVER ART use the new `TONE_CHIP_ON_ART` (studioDesign): the tone's 10 % tint
mixed into the opaque `--ds-raised` instead of transparency, so the words are the measured "tone
surface on raised" pairing (≥ 4.5:1, every context) over any image — the media bin tile's Deleted /
Archived / Out of date badges (`Badge onArt`), the library console's entry pill, the page tile's Out of
date pill and quality-warning dot, the board's stale-page Re-render pill (inside a glass pill over the
page), the image frame's aspect-mismatch badge and the composer's failed-upload dot; the phone editor's
counter, which overlaps its tool's icon, uses it too. The first port had moved the first two onto the
translucent `TONE_CHIP` (whose page-tuned ink measured 1.1–2.3:1 over sample art) and described them as
left as before; the other six were white on `amber-500` (2.15:1).

**4. Dialog titles — `DIALOG_TITLE`.** Atlas's dialog and alert-dialog titles default to 20 px
semibold. Comic Studio's five centred modal dialogs title with `DIALOG_TITLE`: the immersive reader's
keyboard shortcuts (centred everywhere) and the share sheet's `dialog` / `wide` layouts (it stays a 16 px
sheet header as a phone bottom or side sheet); the timeline dialog and the model-change and lab-run
confirmations dock to the bottom as a sheet below `sm`, so they take `DIALOG_TITLE_FROM_SM` over their
15 / 16 px phone size. Bottom, side and pop sheet headers keep 15 px; no heading inside a sheet outranks
its header (the 16 px headings are the admin console's sections and page headings). The page editor's
dialog is a full-screen workspace with a toolbar header, not a titled dialog. Test:
`tests/config/dialogTitle.test.ts`.

Deferred (not wave 8's rule, which covers text ink): raw hue fill, border and ring classes remain in
`components/comicstudio/**` — solid `bg-red-600` / `bg-amber-700` buttons and badges under white text
(the confirm strips, the timeline clip badges; these pass, 4.8:1 and 5.0:1), status and quality dots
(the share button, the publish checklist, the phone tab bar, the stale-page pill's dot), the page
editor's red marquee over the art, the colour field's "no colour" slash (content), the timeline clip's
warning / failure rings, and `role="alert"` / `role="status"` banners with ink text such as
`border-red-500/30 bg-red-500/[0.07]`. Atlas leaves fills and tints alone too; moving the banners onto
`STATUS_SURFACE` and the fills onto a token is D2 work. The white-on-`amber-500` fills that failed
(2.15:1) are not deferred: they moved onto `TONE_CHIP_ON_ART` in the review fixes above,
and the status ink guard now fails on white text or icons on a light amber or yellow fill.
`UsageMeter` and `DictationButton` (shared with chat) keep their own hues.

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

## The comics home (Atlas public composition)

The landing of comics.dreamstreamstudio.ai (`components/comicshost/ComicsLanding.tsx`) takes Atlas's public page
composition, design values only: a centred hero over the dot grid (`.ds-grid-backdrop`, `.ds-stagger`), the product
proof (`StudioPreview`, a still replica of the studio: the Director's "Here's what I've got" card beside drawn pages,
in a `RADIUS_FEATURE` frame with `SHADOW_HERO`), the looks band (six `ComicPageSpecimen` pages: the library's
procedural art with real lettering), the steps rail and a three-card bento (`.ds-reveal`, `LIFT`), the read-and-share
section, the `INVERSE_SURFACE` access panel and a three-column footer. Its header is `ComicsHeader` on the app's
`AppHeader` (`--header-h`, the same object as the studio's header), with the ink `ComicsMark` and a one-line
"Comic Studio" lockup. One spark: the signed-out hero's "Start creating". The new public tokens
(`--ds-radius-pill`, `--ds-shadow-hero`, `--ds-text-md|4xl|5xl|7xl`) and recipes are in design-system.md.

The views one click off the landing are in the same language and chrome (`components/comicshost/hostRouting.ts`
`comicsChromeFor`, unit-tested, is what App.tsx renders). Signed out, sign-in, Privacy, Terms and the Library keep
`ComicsHeader` (`page="other"`: the Library link from `lg`, no "Sign in" on the sign-in page itself) and drop the
floating widgets; signed in, only the landing does, and every other view keeps the app header with its account menu.
On those views the App wrapper is the skin's paper (`CANVAS_BG` + ink), never the old `bg-slate-50`, so dark mode is
dark from header to footer. `AppHeader` owns its ink (`HEADER_INK`), so a ghost button or an icon in any header reads
on the header's paper in both themes. The page bodies:

- **Sign-in** (`AuthPage`, DS-3's card): the `Segmented` sign-in / join switch, `Field` inputs and calm status
  callouts on a `RADIUS_PANEL` card. On the comics host it centres in `calc(100dvh - var(--header-h))` and draws no
  brand of its own (the header carries it). App keys it per request, so a header "Sign in" / "Request access" pressed
  on the open page switches the form. Its "Request access" step (`WaitlistForm`, shared with the main site's "Stay
  updated" card) is on the tokens too: a `FIELD_GROUP` email field, the ink submit, outline toggle chips, a `Textarea`
  and `STATUS_SURFACE` callouts; its running text inherits the surrounding ink, so it also reads in that fixed-white
  card in dark mode.
- **Library** (`PublicGallery`): a `DISPLAY_SECTION` title, the search field (`FIELD_GROUP`), a `Segmented` sort and a
  pressed "Kids-friendly" toggle, a calm sign-in note with an outline "Sign in", then 2 / 3 / 4 covers a row with the
  title (`CARD_TITLE`), creator and counts under the art, in ink; the empty state is `EmptyState`. The rating pill on
  a cover is DS-R1's opaque on-art `RatingBadge` (no terracotta literal).
- **Privacy, Terms**: the `OVERLINE_DISPLAY` "Legal" eyebrow, a `DISPLAY_SECTION` title, the date as `OVERLINE`, then the
  text in a 3xl reading column on `SECTION_CARD`, styled by `LEGAL_PROSE` (the app ships no typography plugin). No
  Back button: the header's lockup goes home.

One fill per view: on the landing the hero holds the one filled control, so the header's "Sign in" / "My comics" is
`outline` there (the ink fill on the other views). The proof (`StudioPreview`) draws its pages in the Manga look (ink
and screentone) so the spark stays the only colour in the first view; the colour arrives with the six looks below. The
legal line's Contact is `mailto:SUPPORT_EMAIL` (`components/legal/contacts.ts`, the routed support mailbox), and on the
comics host it offers no FAQs (there is no FAQ page there). `comicsHome.guard.test.ts` holds the landing, its header,
`AppHeader`, `BrandLockup`, `LegalMicroLinks`, these views and `WaitlistForm` to 0 on every design guard.
