# Component quality standard (chat widgets)

This is the **enforced** standard for every rich-output component (chat artifact)
in `components/chat/artifacts/`. It exists so quality stops depending on anyone —
human or AI — remembering the house style. The non-negotiable rules are checked
by `components/chat/artifacts/widget-quality.test.ts` (run `npm run lint:widgets`);
breaking one fails the build.

> TL;DR — scaffold every new widget with `npm run new:widget` (it starts compliant),
> then follow the **Definition of done** checklist at the bottom before you call it done.

---

## The calm-studio language (what "good" looks like)

House style is the macOS **"calm studio" glass** language (same family as
`components/chat/studioDesign.ts`): quiet, layered, precise. Build from the
dependency-free Primitive Kit in `components/chat/artifacts/kit/` — never reach for
a charting/UI library.

- **Shell:** wrap the card in `<Surface>` (rounded-2xl, hairline border, frosted
  glass, soft ambient shadow). Use `<SurfaceTitle>` / `<SurfaceSubtitle>` for headers.
- **Numbers:** columnar/figures use `tabular-nums`.
- **Charts:** inline SVG via the kit (`Chart`, `Sparkline`, gauges) — no libraries.
- **Motion:** subtle (`animate-fade-in`, `useCountUp`, `useMountFlag`); never gratuitous.
- **Color:** comes from theme tokens (below) or the kit palette — never invented per-card.

## The three hard rules (build-breaking)

### 1. No legacy comic styles
The chat is calm-studio, **not** the comic page. Banned anywhere in a widget:
`border-2 border-black`, `shadow-comic`, `font-display`, `font-comic`.

```tsx
// ✗ comic styling leaking into a widget
<div className="border-2 border-black shadow-comic font-display">…</div>
// ✓ calm-studio shell
<Surface header={<SurfaceTitle>Sales</SurfaceTitle>}>…</Surface>
```

### 2. Colors come from `--ds-*` tokens (no off-palette hex in classes)
Structural color uses the theme tokens so light + Claude-style dark themes both work:

| Purpose | Token |
| --- | --- |
| Primary text | `text-[var(--ds-ink)]` |
| Secondary text | `text-[var(--ds-muted)]` / faint: `text-[var(--ds-faint)]` |
| Surfaces | `bg-[var(--ds-canvas\|sidebar\|surface\|surface-soft\|surface-strong\|raised\|well)]` |
| Hairlines | `border-[var(--ds-hairline)]` / `border-[var(--ds-hairline-soft)]` |
| Hover | `hover:bg-[var(--ds-hover)]` |
| Accent | `bg-[var(--ds-accent)]` `hover:bg-[var(--ds-accent-hover)]` |

The **only** sanctioned hard-coded color in a class is the theme-invariant brand
accent `#D97757` (and its tints, e.g. `bg-[#D97757]/10`, `text-[#D97757]`). Any
other semantic color must come from `kit/theme.ts` `PALETTES` (or `BULL`/`BEAR`/
`NEUTRAL`) — pass it through `style={{ color }}` / a prop, not as a random
`bg-[#abc123]` class. Tailwind's named palette classes (`text-emerald-600`,
`bg-amber-50`, …) remain fine for semantic accents — the gate does not police those.

```tsx
// ✗ off-palette hex baked into a class
<span className="text-[#7c3aed]">…</span>
// ✓ token, accent tint, or kit color
<span className="text-[var(--ds-muted)]">…</span>
<span className="bg-[#D97757]/10 text-[var(--ds-accent)]">…</span>
<span style={{ color: BULL }}>+2.4%</span>   // BULL from the kit palette
```

### 3. Never put a Tailwind opacity modifier on a `var()` color
`bg-[var(--ds-well)]/95` is **invalid CSS** — the opacity silently does nothing.
Use a solid token, or `color-mix` when you genuinely need translucency:

```tsx
// ✗ invalid
<div className="bg-[var(--ds-well)]/95 backdrop-blur-sm" />
// ✓ valid translucent token
<div className="bg-[color-mix(in_srgb,var(--ds-well)_92%,transparent)] backdrop-blur-sm" />
```

## Two densities (always)
Every widget is wrapped by `WidgetFrame`, which offers a **compact ⇄ detailed**
toggle and resize. Read the mode with `useCompact()` / `useDensity()` and render a
real **glance** layout when compact (key facts only) — not a clamped version of the
detailed view. When you add a bespoke compact layout, list the type in
`DENSITY_AWARE_TYPES` (`ChatArtifacts.tsx`); unlisted types get an automatic clamped
preview. The model can pre-pick a mode via `density: 'compact' | 'detailed'` in the data.

## Show up in the Gallery (enforced separately)
Every renderable artifact type **must** have a live demo in `ComponentGallery.tsx`
with realistic sample data — enforced by `gallery.coverage.test.ts`. This is how a
new component is always visible/reviewable in Settings → Gallery.

## Resilience & a11y
- The card receives `data: unknown` cast to its type — guard missing/empty fields and
  `return null` (or a tiny notice) instead of throwing. `ArtifactBoundary` is the last net.
- Real controls are `<button>`/`<a>` with `aria-*` and visible focus rings; decorative
  icons are `aria-hidden`. Hit targets stay comfortably tappable.

---

## Definition of done (paste into the PR)

- [ ] Composed from the kit; wrapped in `<Surface>`; calm-studio, no comic styles.
- [ ] Colors are `--ds-*` tokens / the `#D97757` accent / a `kit/theme.ts` palette color.
- [ ] No Tailwind opacity modifier on any `var()` color.
- [ ] Real **compact** glance layout via `useCompact()`; type added to `DENSITY_AWARE_TYPES`.
- [ ] Type declared in `apiTypes.ts`; renderer registered in `ChatArtifacts.tsx`.
- [ ] Live demo added to `GALLERY_DEMOS` in `ComponentGallery.tsx` (realistic data).
- [ ] Degrades gracefully on missing data; controls are accessible.
- [ ] `npm run lint:widgets` and `npm run typecheck` pass.
- [ ] I can name *how this is better* than the obvious version (per CLAUDE.md ideology).
