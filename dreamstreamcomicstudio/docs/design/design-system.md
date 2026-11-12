# The DreamStream design system

One rule for every surface: **tokens, then recipes, then primitives, then screens.** A screen never spells
a hue, a radius, a duration or a z-index; it uses a primitive, or a recipe when no primitive fits, and
both read the `--ds-*` tokens. The Atlas language (`docs/design/atlas-skin.md`) is one value of the
skin attribute over those tokens; a later "fun" skin is another value of the same attribute, and no
component changes for it.

| Layer | Where | What it holds |
| --- | --- | --- |
| Tokens | `index.css` — defaults in `:root` / `.dark`, the Atlas values in `[data-ds-skin="atlas"]` (+ its dark block) | colours, type, radii, shadows, motion, the z ladder, densities |
| Tokens as data | `packages/platform-core/src/brand/skins/{dreamstream,atlas}.ts` | the same blocks for email, decks and documents; `brand.test.ts` fails on any drift |
| Recipes | `components/chat/studioDesign.ts` (re-exported for the primitives by `components/ds/recipes.ts`) | Tailwind class strings built only from tokens |
| Primitives | `components/ds/*` (barrel `components/ds`; sheets from `components/ds/sheet`) | React components: Atlas `ui-generated` recipes 1:1 on the tokens |
| Motion classes | `styles/ds-motion.css` (imported first by `index.css`) | entrances, stagger, reveal, loading and live loops, edge fades, overlines: plain CSS on the tokens |
| Named colours | `tailwind.config.cjs` `ds` | every colour token as a Tailwind colour (`bg-ds-canvas`, `text-ds-ink/60`) |
| Gallery | `qa/app/scenes/ds-gallery.tsx` | every primitive, variant and state, light and dark, for the layout smoke |

Adoption starts in DS-2: in this wave (DS-1a) no existing screen was moved onto the primitives.

**One language on every host (wave 9, the bridge).** `index.html` ships `data-ds-skin="atlas"` on `<html>`, so
every page (chat, settings, home, public pages, the studio) reads the Atlas values of these tokens; the
comics host also sets it at boot. The build kill switch `VITE_DS_SKIN_EVERYWHERE=off`
(docs/infrastructure/ENV_MATRIX.md) strips the attribute from every HTML entry, so the token block is back
to the old scope (the comics host and the Comic Studio roots); dark from first paint on every page and the
bridge token moves stay (a code revert, docs/design/atlas-skin.md "Scope and mechanism"). `initTheme()` runs at the app root and
`public/theme-boot.js` puts the saved dark theme on `<html>` before first paint. Legacy-kit pages follow the
skin's tokens and keep their legacy structure until their migration package.

## Tokens

The colour, type, shape, depth and motion tokens, their defaults and their Atlas values are tabled in
`atlas-skin.md` ("Token mapping"); that page stays the source for them. DS-1a added these:

| Token | Default (`:root`) | Atlas skin | Use |
| --- | --- | --- | --- |
| `--ds-z-stage` | `0` | same | the canvas / page content; its own layers stack 1–30 inside it |
| `--ds-z-chrome`, `--ds-z-header` | `40` | same | toolbars, rails, the sticky header |
| `--ds-z-editor` | `70` | same | the full-screen page editor |
| `--ds-z-reader` | `80` | same | the full-screen reader |
| `--ds-z-scrim`, `--ds-z-sheet` | `85`, `86` | same | a sheet's scrim and the sheet (the ladder `mobile/sheets` already documents) |
| `--ds-z-dialog` | `88` | same | a modal dialog (`Z.dialog`, DS-1c): above every sheet, below the menus and popovers it opens |
| `--ds-z-popover` | `90` | same | menus, popovers, selects |
| `--ds-z-toast` | `95` | same | toasts |
| `--ds-z-tooltip` | `100` | same | tooltips |
| `--ds-density-compact` / `-comfortable` / `-touch` | `28px` / `36px` / `44px` | same | control row heights; touch = every control under a coarse pointer (= `--tap-min`) |
| `--ds-text-xl` / `-2xl` / `-3xl` | `1.25rem` / `1.5rem` / `1.875rem` | same (Atlas `--text-xl…3xl`) | heading steps above the 11–16 px chrome scale |
| `--ds-motion-enter-quick` | `var(--ds-motion-enter)` (280 ms) | same | Atlas's name for the 280 ms entrance; `--ds-motion-enter` keeps its name and value |
| `--ds-motion-enter-slow` | `420ms` | same (Atlas `--motion-enter`) | page and section entrances |
| `--ds-motion-stagger` | `40ms` | same (Atlas `--motion-stagger-step`) | the step between list items |
| `--ds-on-danger` | `#ffffff`; `.dark` `#1a1915` | `#ffffff` (both themes) | the label on a solid danger fill: white on the red, ink on the default dark theme's light red (white there is 2.8:1) |
| `--ds-glass-blur` (wave 9) | `12px` | `0` | the frosted glass of GLASS, GLASS_STRONG and MENU; Atlas surfaces are opaque |
| `--ds-header-blur` (wave 9) | `18px` | same | the sticky header's glass layer (HEADER_GLASS), the one blur Atlas keeps |
| `--ds-chart-1` … `-5` (wave 9) | `#0a0a0a #525252 #858585 #b0b0b0 #d4d4d4`; `.dark` `#fafafa #b8b8b8 #8a8a8a #5e5e5e #3d3d3d` | same | chart series, ink first; a chart picks a step, never a hue |
| `--ds-grid-dot` (wave 9) | ink at 14 % | same | the dot of `.ds-grid-backdrop` |
| `--ds-spot-ink` (wave 9) | `var(--ds-ink)` | same | the spotlight pool's ink (the header and home work) |
| `--ds-radius-hero` / `-feature` (wave 9) | `28px` / `16px` | same | the hero frame; feature cards |
| `--ds-reader-focus` (M1a) | `#3b3026` (the reader ink) | not skinned (reader content) | keyboard focus on the reader's paper: ≥ 4.5:1 on the page back and the endpaper. Paper only (1.5:1 on `--ds-reader-room`): controls over the room draw `--ds-reader-hud-focus` (readerDesigns.css, RD-A) |
| `--sidebar-w` (M1a) | `240px` | same | the wide-screen sidebar, beside `--rail-w` (72 px) |

Atlas has no z or density tokens: the skin restates the same values so every token has a skin value
(`tests/config/atlasSkin.test.ts`). The non-colour tokens are theme-invariant and are not repeated in
`.dark`. The wave 9 defaults equal their Atlas values, mirrored in both brand skins (`brand.test.ts`).
Under the skin the control and chip radius is 8 px (Atlas `rounded-md`). A `.dark` subtree inside a light
page restates the var()-derived tokens (`:where(.dark:not(:root))`), so a dark demo panel or preview reads
its own pill, edges and marks. `--ds-on-danger` on the danger fill and on its hover mix is measured in all six contexts by
`tests/config/tokenContrast.test.ts` (≥ 4.5:1).

**Reader tokens (RD-A).** `components/comicstudio/immersive/readerDesigns.css` on `[data-reader-root]` is the reader's
one motion and ink token set (not skin tokens: reserved DreamStream reader-scope names, `atlas-skin.md`), and
`readerTokens.ts` reads it once per mount; "fade" is 280 ms everywhere. Room-side focus and progress use
`--ds-reader-hud-focus` / `--ds-reader-accent` (Night `#fafafa`, Day `#3b3026`), ≥ 3:1 on the room and the HUD glass
(`tokenContrast.test.ts`, "the reader rooms"). The rest of the reader contract (never-blank turns, stand-ins, the
device-sized cache, preloads) is in `docs/features/comic-reader.md`.

## Colour layer ("Ink & Spark")

A DreamStream extension, not from Atlas (CL-0; the Atlas session has the 12 names as such, `atlas-skin.md`
"DreamStream extensions"). The studio is black ink on white paper. Colour is a **spot**, like a single printed ink,
and it appears for one of four reasons only:

1. **Spark** marks *creation*: the one place to start making something on this screen, what is being drawn right
   now, and what is selected on the art.
2. **Hues 1–5** tell series and tags apart.
3. **Status** says healthy / attention / error, always with words.
4. **Art tint** is the comic's own colour, around the comic.

Everything else stays ink: text, headings, navigation, icons, borders, menus, dialogs, focus rings, prices and every
control that spends money.

**Tokens** (`index.css`, in `:root`, `.dark`, `[data-ds-skin="atlas"]` and its dark block; mirrored in both brand
skins and the named `ds` Tailwind colours). The values are the same with and without the skin, like the chart steps.
The `var()`-derived ones are restated in every block, so a nested skin recomputes them.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ds-spark` | `#3d44e8` | `#8b9bfe` | the creation fill, the making dot and bar, the ring on art |
| `--ds-spark-hover` | `#3438cc` | `#a3b2fe` | the fill on hover |
| `--ds-on-spark` | `#ffffff` | `#0a0a0a` | the label on a spark fill |
| `--ds-spark-text` | `#3d44e8` | `#abb9fe` | spark as text, or an icon beside its words |
| `--ds-spark-soft` | spark 8 % into the canvas | spark 16 % into the canvas | the selected / making tint |
| `--ds-spark-glow` | spark at 24 % | spark at 30 % | shadows and the making sweep only, never under text |
| `--ds-hue-1` … `-5` | `#3d44e8 #d13d91 #db6b04 #079a94 #9548cc` | `#5568fd #d84497 #df6e07 #04a19b #a155da` | categorical series and tags, in this fixed order |
| `--ds-art` | `var(--ds-well-strong)` | same | a comic's own tint; components set it inline |

S2a lead decision: the values ship as CL-0 built them. Where they differ from the design report: the default skin's
`--ds-info` / `--ds-info-text` are neutral (`#525252` / `#404040` light, `#e5e5e5` dark; the old blue, and the
report's dark grey, sat too close to the spark); dark `--ds-hue-1` is `#5568fd`, one step lighter than the report's
`#5265f9`, which was 2.93:1 on the default dark card; only the 4↔5 hue swap keeps every gate (2↔4 fails); and the How
It Works pin is `:root.dark .hiw-gradient-text` (`atlas-skin.md`).

**Recipes** (`components/chat/studioDesign.ts`, re-exported by `components/ds/recipes.ts`): `SPARK_FILL`,
`SPARK_TEXT`, `SPARK_SOFT_BG`, `SPARK_RING_ON_ART` (a 2 px spark outline with a 2 px gap, selection on art only),
`MAKING_DOT` (on a `LiveDot`, always beside its words), `MAKING_SWEEP` (`.ds-making-sweep`, a spark glint across a
tile being drawn, paused off screen, still under reduced motion), `MAKING_TEXT` (the shimmer-text loop with a spark
glint), `BENDAY` (`.ds-benday`, comic Ben-Day dots in the spark behind hero art and empty states only: put it on the
container itself; the dots sit on its `::before` layer, behind its content), `ART_PLACEHOLDER`, `ART_GLOW`, and
`HUE_DOT` / `HUE_FILL` / `HUE_STROKE` (slots 1–5). `hueIndex(i)` and `hueClass(kind, i)` are 0-based (the n-th series
reads slot n + 1) and return null past the fifth: fold the rest into "Other", a chart step.

**Primitives.** Button has one DreamStream variant, `create`, the spark fill, named by meaning (`BUTTON_EXTENSION_VARIANTS`;
Atlas's six variants are untouched). Progress takes `tone="making"` (`PROGRESS_MAKING`, the bar in the spark);
`StatusState` is not widened.

**Where colour is allowed** (the rows are places; design report §3.7):

| Place | Spark | Hues 1–5 | Status | Art tint |
| --- | --- | --- | --- | --- |
| Primary call to action | **One** `create` fill per view, only to start something | — | — | — |
| Spend / price controls (Approve, Draw · price, Redraw, Translate, Get more) | **Never** (the ink primary) | — | — | — |
| AI at work | `MAKING_DOT`, `MAKING_SWEEP`, `Progress tone="making"`, "Drawing 2 of 6" in `SPARK_TEXT` | — | — | — |
| Selection | On art only: `SPARK_RING_ON_ART`. Elsewhere the Atlas selection (`SEGMENTED_ACTIVE`, accent-soft) | — | — | — |
| Status | — | — | the Atlas `STATUS_*` / `TONE_*`, always worded | — |
| Charts | the "highlight one" mark | series identity (≥ 2 series, fixed order, a legend always) | only when the series *means* good or bad | — |
| Tags (colour mode, medium, kind) | — | a 6 px dot before the word, in a neutral chip | — | — |
| Art-adjacent surfaces | — | — | — | placeholder, glow, reader room |
| Empty-state art | one spot element per drawing | — | — | — |
| Landing | the hero call to action; `BENDAY` behind the hero art | — | — | real covers |

When more than one place wants the one spark, page content wins in this order: the My comics header's New comic, then
the composer Send, then the landing hero. The panel's New comic stays ink.

**Where colour is forbidden** (§3.8): body text, headings, navigation labels and chrome icons (except a status icon
and the making dot beside its words); focus rings (they stay `--ds-focus`); card, sheet, dialog, menu and toast
surfaces or edges, hover and active tints, dividers; any control that spends money or shows a price; more than one
spark fill in a view, or two adjacent; destructive actions; gradient text; full-bleed colour on long-lived views;
colour as the only signal; hues as status or status as series; inside the comic page and the reader (the reader keeps
`--ds-reader-*`); raw Tailwind hue classes or hex literals in UI.

**Charts** (§3.9; `--ds-chart-1…5` keeps its meaning, so Atlas-shared charts render the same):

| Chart job | Colours |
| --- | --- |
| One series (magnitude over time) | `--ds-chart-1` |
| Ordinal or sequential (tiers, buckets) | `--ds-chart-1 → 5` (ink steps) |
| Highlight one against the rest | the one in `--ds-spark`, the rest in `--ds-chart-4` |
| Categorical identity, 2–5 series | `--ds-hue-1…5` in fixed order, a legend always; ≤ 4 series also labelled directly; "Other" past five |
| Good / bad state | the Atlas status tokens, an icon and words; never mixed with hues in one chart |
| Spend / price charts (any series count) | ink steps `--ds-chart-1 → 5`, never the spark family: light `--ds-hue-1` is the spark's own colour, and colour never nudges spending. `StackedBars palette="ink"` (Insights spend by kind); "Other" past five is an outline in `--ds-chart-3` |

**Guards.**
- `tests/config/tokenContrast.test.ts` ("the colour layer … in all six contexts"): spark text and the label on a
  fill ≥ 4.5:1, spark as a mark or ring ≥ 3:1 on every backdrop, hues ≥ 3:1 on the canvas and on a card, the spark
  far from every status colour, and no ink-system or reader token reads a layer token.
- `tests/config/huePalette.test.ts`: the hues are a validated categorical set (band, chroma, adjacent CVD ≥ 8 and
  normal ΔE ≥ 15, the first three slots for all pairs, the order is load-bearing).
- `tests/config/sparkGuard.test.ts`, six rules:
  1. spark fills, in every spelling, only where its `ALLOWLIST` pins them; only the four `SPARK_DEFINITIONS` files are
     exempt, and the `components/ds` composites are held like screens;
  2. one per file, and never in a list;
  3. navigation (`INK_ONLY`) takes no spark except the making dot;
  4. no spark in the reader, its CSS included;
  5. no price inside or beside a fill (the `PRICE_CALLS` / `PRICE_IDENTS` list; a ratchet over the cost modules
     forces a new formatter onto it);
  6. no spend label (Approve, Draw, Redraw, Translate, Get more) on a fill.

  The gallery (`SPECIMENS`) may show several fills, but never beside a price or with a spend label. The layout
  smoke's `one-spark` check counts visible `create` fills per viewport on every app scene except the gallery.
- Measured caveats: on the default dark raised chip, hues 1, 2 and 5 fall under 3:1 (charts never sit on one; a test
  pins it); tritanopia separation is reported, not gated (between 5 and 8; CL-0 measured 6.3 light and 5.5 dark); hues
  are never status.

## Recipes

All in `components/chat/studioDesign.ts`. The families and what they are for (details and Atlas sources
in `atlas-skin.md`, "The shared constants"):

| Recipe | For |
| --- | --- |
| `CANVAS_BG`, `SIDEBAR_BG`, `GLASS`, `GLASS_STRONG`, `PANEL`, `HAIRLINE` | surfaces and edges |
| `RADIUS_PANEL` / `_CONTROL` / `_PILL`, `SHADOW_SOFT` | shape and depth |
| `INK`, `MUTED`, `HEADING`, `FONT_DISPLAY`, `OVERLINE`, `DIALOG_TITLE(_FROM_SM)` | type (every small uppercase label is `OVERLINE`) |
| **`TEXT_XL`, `TEXT_2XL`, `TEXT_3XL`** (DS-1a) | the 20 / 24 / 30 px heading steps (size and leading) |

**The display face (wave 9).** Space Grotesk only where a recipe asks for it: `FONT_DISPLAY` (`.ds-font-display`),
`HEADING`, `PAGE_TITLE` and the page and public titles built on them (the comics landing's hero and section
titles, the public reader cover). Card, section-card, dialog, sheet and empty-state titles are IBM Plex Sans
semibold (`CARD_TITLE`, `SECTION_TITLE`, `DIALOG_TITLE`, `STATE_TITLE`), as Atlas's. Tailwind's
`font-display` is Bangers, lettering content: never in chrome.
| `ACCENT_*`, `ON_ACCENT_TEXT`, `PRIMARY_BTN` | the accent (ink under the skin) and the text-bearing accent fill |
| **`DANGER_FILL`, `DANGER_FILL_HOVER`** (DS-1a) | a solid danger fill under `--ds-on-danger` (destructive buttons and badges) |
| `TONE_TEXT` / `_SURFACE` / `_FILL` / `_CHIP` / `_CHIP_ON_ART` | status hue — always next to words or an icon |
| `StatusState`, `STATUS_INK` / `_EDGE` / `_SURFACE` / `_DOT` / `_CHIP(_TONE)` | the one status vocabulary: healthy, active, waiting, attention, error |
| `FOCUS_RING`, `FOCUS_RING_FLUSH`, `FOCUS_ITEM` | keyboard focus (2 px focus-colour outline, 2 px off) |
| `FIELD`, `FIELD_EMBEDDED`, `FIELD_GROUP` | text fields and selects |
| `OVERLAY`, `SCRIM` | menus, popovers, dialogs, sheets and the dim behind them |
| `CHIP`, `CHIP_VARIANT` | neutral chips |
| `SEGMENTED_TRACK` / `_ITEM` / `_ACTIVE` / `_PILL` | segmented controls and tab lists |
| `SECTION_*`, `TOAST*`, `INVERSE_SURFACE` | section cards, toasts, the inverted ink panel |
| `TRANSITION`, `PRESS`, `HOVER_LIFT` | motion |
| **`LIFT`**, **`RISE_IN`** (M1a) | the card lift (hover-capable pointers, the 2 px rise motion-safe, `--ds-shadow-lift`); the entrance (`.ds-rise-in`) |
| **`STICKY_HEADER`**, **`HEADER_GLASS`** (wave 9) | the sticky header and its glass layer: plain at rest, frosted with `--ds-header-blur` once `data-scrolled="true"` |
| **`SEGMENTED_ACTIVE_FILL`** (wave 9) | the selected pill's paint without an ink, for an item on `SEGMENTED_ITEM` (which inks the selected item itself) |
| **`Z`** (DS-1a) | `Z.stage … Z.tooltip` = `z-[var(--ds-z-*)]`: the only place a z-index class is spelled |
| **`DENSITY`** (DS-1a) | `compact` / `comfortable` / `touch` row heights; `coarse` (44 px tall under a coarse pointer) and `coarseSquare` (44 × 44) |

## Composing classes

- **`cn` from `lib/utils.ts`** (clsx + tailwind-merge: later classes win). Never a local `cx` — it joins
  without merging, and a tone stacked on a base ink renders the base ink.
- **Focus goes on after the merge.** tailwind-merge 3 reads class names with Tailwind 4 meanings, where a
  bare `outline` is an outline *width*. `lib/utils.ts` now configures `cn` for Tailwind 3.4 (a bare
  `outline` is the style; `lib/utils.test.ts`), so `cn(FOCUS_RING)` keeps the ring; primitives still write
  `` `${cn(BASE, VARIANT[variant], className)} ${FOCUS_RING}` `` so a caller's className can never cancel it,
  and their tests assert every recipe class survives.
- **The cn rule: no Tailwind 3 alias tailwind-merge cannot dedupe.** Never `flex-shrink-*` / `flex-grow*`
  (write `shrink-*` / `grow*`), `overflow-ellipsis` (`text-ellipsis`), `decoration-slice` / `-clone`
  (`box-decoration-*`), or a shadow without its type hint, `shadow-[var(…)]` (write
  `shadow-[shadow:var(…)]`). cn keeps both sides of such a pair, so an override silently loses to the CSS
  order. `components/ds/cnAliases.test.ts` scans the app and carries the probe that shows it.
- **Named `ds` colours make `/NN` legal.** `bg-ds-surface`, `text-ds-ink/60`, `border-ds-hairline/50`
  (tailwind.config.cjs) compile to the token, or to `color-mix(in srgb, var(--ds-…) NN%, transparent)` with
  an opacity; a slash on a bare `var()` arbitrary value (`text-[var(--ds-ink)]/60`) is still invalid CSS.
  The list equals index.css's colour tokens (`tests/config/dsColours.test.ts`).
- **Choose a colour, never stack two.** One unvariant text colour per class list
  (`danger ? TONE_TEXT.danger : 'text-[var(--ds-ink)]'`); the status-ink guard fails on a stacked pair.
- **44 px under a coarse pointer** on every interactive control (`DENSITY.coarse` / `coarseSquare`); a
  control that is small by design (Switch, Checkbox) gets an invisible 44 × 44 hit area instead of growing,
  and one that is always taller (Textarea's 64 px floor) skips the rule, which would lower its minimum.
- **Forced colours:** every interactive primitive keeps a 1 px edge (transparent when Atlas draws none),
  which forced-colours mode paints; selected states and progress use `Highlight` there.
- **Reduced motion:** transitions read the motion tokens; spinners, pills and thumbs hold still or jump.
- **Tailwind's `max-*` / `min-*` breakpoint variants throw here** (the screens include raw queries): write
  `w-full sm:w-auto`, not `max-sm:w-full`.
- **This app runs Tailwind 3.4, not Atlas's Tailwind 4.** Some Atlas variants have no 3.4 name and compile
  to nothing: 3.4's `aria-*` set has no `invalid`, so the danger edge is
  `aria-[invalid=true]:border-[var(--ds-danger-mark)]` (`peer-aria-[invalid=true]:` from a peer input).
  `components/ds/ds.hygiene.test.ts` asks Tailwind (built from `tailwind.config.cjs`) for every class of
  every exported class string in `components/ds`, so a class that would paint nothing fails by name.
- **Disabled dims once, and never the help text.** The control dims itself (`disabled:opacity-50`), its
  label may follow (the label of a disabled control); no wrapper dims the description or the error, which
  must stay 4.5:1 to say why the control is locked.

## Primitives (`components/ds`)

Import from the barrel: `import { Button, Field, Input } from '../ds'` (adjust the path). One example
each.

**Controls**

```tsx
<Button variant="outline" size="sm" onClick={save} loading={saving}>Save</Button>
// variants: default | destructive | outline | secondary | ghost | link; sizes: sm | default | lg | icon.
// buttonClasses({ variant, size }) styles a link the same way.

<IconButton label="Close panel" onClick={close}><X /></IconButton>   // 32 px, 44 × 44 coarse; the label names it

<Field label="Comic title" description="Shown on the cover." error={titleError} required>
  <Input value={title} onChange={(e) => setTitle(e.target.value)} />
</Field>                                      // id, aria-describedby (error, then help), aria-invalid, required

<Field label="Notes"><Textarea /></Field>

<Field label="Page size">
  <Select placeholder="Choose a size" options={[{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }]} />
</Field>                                      // a styled native <select>

<Segmented<View> label="Reading view" value={view} onChange={setView}
  options={[{ value: 'scroll', label: 'Scroll' }, { value: 'page', label: 'Page' }]} />   // radios; arrows choose

<Tabs defaultValue="pages">
  <TabsList label="Comic sections"><TabsTrigger value="pages">Pages</TabsTrigger><TabsTrigger value="cast">Cast</TabsTrigger></TabsList>
  <TabsContent value="pages">…</TabsContent><TabsContent value="cast">…</TabsContent>
</Tabs>                                       // automatic activation, roving focus, labelled panels

<Field label="Autosave"><Switch checked={on} onCheckedChange={setOn} /></Field>   // role switch; Space / Enter

<Field label="Panel gutter"><Slider min={0} max={48} step={2} value={gutter} onValueChange={setGutter} /></Field>

<Progress label="Drawing pages" value={40} valueText="4 of 10 pages" />            // no value = indeterminate

<Checkbox label="Select all pages" checked={some ? 'indeterminate' : all} onCheckedChange={setAll} />
```

**Labels**

```tsx
<Chip variant="filled" icon={<BookOpen />}>The Lake Series</Chip>     // outline | filled | dashed
<Badge variant="warning">Draft</Badge>                                 // default | secondary | destructive | outline | success | warning
<StatusChip state="attention">Check the lettering</StatusChip>         // healthy | active | waiting | attention | error — words required
```

**Containers**

```tsx
<Card><CardHeader><CardTitle>Cast</CardTitle><CardDescription>Who appears.</CardDescription><CardAction>…</CardAction></CardHeader>
  <CardContent>…</CardContent><CardFooter>…</CardFooter></Card>
<SectionCard title="Look and feel" description="Fonts and colours." icon={<Palette />} aside={<StatusChip state="healthy">Saved</StatusChip>}>…</SectionCard>
<PageHeader eyebrow="Library" title="Your comics" description="Everything you started." actions={<Button>New comic</Button>} />
<MetricCard title="Pages drawn" value="12" meta="of 24 planned" icon={<Image />} />
```

**States**

```tsx
<EmptyState title="No comics yet" description="Start one from a sentence." action={{ label: 'New comic', onClick: create }} />  // role status; panel | bare | inline
<LoadingState title="Loading your comics…" />                                       // role status; panel | inline
<ErrorState title="Your comics didn’t load" description="Check your connection." onRetry={reload} />  // role alert
<Skeleton shape="text" className="w-2/3" />                                         // aria-hidden; block | text | circle
<ErrorBoundary onError={report} resetKeys={[comicId]}>…</ErrorBoundary>             // ErrorState fallback, never the error text
```

**Sheets** — `import { AdaptiveSheet, BottomSheet, SideSheet } from '../ds/sheet'`: the mobile sheets,
re-exported where they live (`components/comicstudio/mobile/sheets`), layered at `Z.scrim` / `Z.sheet`.

**Overlays** (DS-1c) are Radix (lead decision D6: `@radix-ui/react-{dialog,alert-dialog,dropdown-menu,popover,tooltip}`,
MIT). Radix supplies the focus trap, roving focus, typeahead, dismissal (Esc, a press outside), the portal and the ARIA;
the primitives add the recipes. All portal to `<body>`. Nothing enters with motion under reduced motion (the hook drops
`ds-fade-in` / `ds-scale-in`, and `styles/ds-motion.css` stops them too); there is no exit animation, so a closing
overlay leaves at once. Each root (`Dialog`, `AlertDialog`, `Menu`, `Popover`, `Tooltip`) takes `open` + `onOpenChange`
or `defaultOpen`, as Radix's does.

**The top layer** (`components/ds/overlayLayer.ts`). On phones the overlays open from sheets, and an open overlay is the top
layer of the app: it is drawn above the sheets (the dialog scrim is on `Z.dialog`, 88, above `Z.sheet`); Esc closes the
newest overlay and nothing beneath it (a caller's `onEscapeKeyDown` with `preventDefault()` keeps it open, and the sheet
too); and while a Dialog, AlertDialog, Menu or Popover is open the sheet that opened it stands down, so a press on a menu
row, an answer or a popover control never reads as a press outside the sheet, and Tab inside a dialog stays in the dialog.
The back gesture (`backStack.ts`) closes a Dialog or AlertDialog before the sheet or editor under it. The Dialog is always
modal (a non-modal panel is a Popover). A finger opens a Menu on its tap, never on touch-down, so a scroll that starts on
a ⋯ trigger does not open it.

```tsx
<Dialog>
  <DialogTrigger asChild><Button variant="outline">Comic details</Button></DialogTrigger>
  <DialogContent size="default">        {/* sm 384 | default 512 | lg 672 px; SCRIM on the dialog layer, the OVERLAY panel, a Close button */}
    <DialogHeader><DialogTitle>Comic details</DialogTitle><DialogDescription>Shown on the cover.</DialogDescription></DialogHeader>
    …
    <DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose><Button onClick={save}>Save</Button></DialogFooter>
  </DialogContent>
</Dialog>                                {/* focus trapped; Esc, the scrim or Close; focus back to the trigger; DIALOG_TITLE */}

<AlertDialog>                           {/* the confirm step (replaces window.confirm as surfaces move) */}
  <AlertDialogTrigger asChild><Button variant="outline">Delete page 3</Button></AlertDialogTrigger>
  <AlertDialogContent>                  {/* focus starts on Cancel; a press on the scrim does not close it; Esc cancels */}
    <AlertDialogHeader><AlertDialogTitle>Delete page 3?</AlertDialogTitle><AlertDialogDescription>It stays in Assets › Deleted.</AlertDialogDescription></AlertDialogHeader>
    <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={remove}>Delete page</AlertDialogAction></AlertDialogFooter>
  </AlertDialogContent>                 {/* destructive = DANGER_FILL; the words say what happens, never "OK" */}
</AlertDialog>

<Menu>
  <MenuTrigger asChild><IconButton label="Page actions" title={null}><MoreHorizontal /></IconButton></MenuTrigger>
  <MenuContent>                         {/* OVERLAY on Z.popover; ↑ ↓ Home End, typeahead, Esc back to the trigger; 44 px rows on touch */}
    <MenuLabel>Page 3</MenuLabel>
    <MenuItem onSelect={rename}>Rename<MenuShortcut>F2</MenuShortcut></MenuItem>
    <MenuCheckboxItem checked={grid} onCheckedChange={setGrid}>Show the grid</MenuCheckboxItem>
    <MenuRadioGroup value={view} onValueChange={setView}><MenuRadioItem value="page">One page</MenuRadioItem>…</MenuRadioGroup>
    <MenuSub><MenuSubTrigger>Move to</MenuSubTrigger><MenuSubContent>…</MenuSubContent></MenuSub>
    <MenuSeparator /><MenuItem variant="destructive" onSelect={remove}>Delete page</MenuItem>
  </MenuContent>
</Menu>

<Popover>                               {/* non-modal; focus in on open and back on close; opens on a press only */}
  <PopoverTrigger asChild><Button variant="outline">Filters</Button></PopoverTrigger>
  <PopoverContent aria-label="Filters">…</PopoverContent>
</Popover>

<TooltipProvider>                       {/* around a toolbar or a lazy surface: one skip delay for the tooltips inside */}
  <Tooltip>
    <TooltipTrigger asChild><IconButton label="Undo" title={null}><Undo2 /></IconButton></TooltipTrigger>
    <TooltipContent>Undo · Ctrl+Z</TooltipContent>
  </Tooltip>                            {/* INVERSE_SURFACE on Z.tooltip: hover 300 ms, focus at once, a long press on touch */}
</TooltipProvider>
```

A tooltip repeats or adds to a name, never replaces one: its trigger keeps its own label (an IconButton's `label`, with
`title={null}` so the native title does not double it). On touch it never depends on hover: a long press (500 ms) shows
it for 1.5 s after the finger lifts, and that press does not press the control; a plain tap is a plain tap.

**The one toast slot.** `toast({ title, message?, tone?, action?, duration?, onDismiss?, onLost? })` shows an app
toast in `<ToastHost />` (mounted once at the App root; a second mounted host renders nothing) and returns
`{ id, dismiss() }`. Every toast in the app shares one slot: a newer toast replaces the shown one and tells it
(`onLost`), so toasts never stack. Component toasts take the same slot with `claimToast(onLost)` and read it with
`useToastSlot(id)` (the timeline's `claimUndoToast` is `claimToast`; History's restore toast claims it too). The host sits
above the phone tab bar and the safe area (`--tabbar-h` + `--sa-bottom-eff` + 12 px) on `Z.toast`, centred, at most
420 px wide. The card is Atlas's TOAST recipe: the status hue only on its edge, its icon and its time-left bar; a title
of two lines at most and a message of three; one action, which also dismisses it. The clock (`TOAST_DURATION_MS`, 8 s;
`duration: 0` stays until dismissed) holds while the toast is hovered or focused (`data-paused`); Esc and Dismiss close
it; `tone: 'error'` is an alert of its own (announced at once), everything else is read politely from the host's status
region, which stays in the page while idle (live regions never nest). `ToastCard` shows a static card (a scene, a doc).
No timer runs while no toast is shown.

**Bundle cost.** Together the overlays weigh about 45 KB gz (Menu about 34 KB with floating-ui, Dialog about 17.5 KB,
Tooltip 22 KB, Popover 26 KB, sharing the popper and the overlay layer, which brings the sheets' stack and the back stack,
about 1.7 KB of it). An unused overlay costs next to nothing, also through this barrel: their top-level `forwardRef` /
`createContext` calls are marked pure, so importing an unrelated primitive through such a barrel drops every overlay and
all of Radix (`components/ds/overlays.hygiene.test.ts` bundles both cases and caps what is left at 1.5 KB gz). The Toast
host uses no Radix (about 2.3 KB gz). A `TooltipProvider` costs about 3.8 KB gz: mount it inside the lazy surface whose
toolbar shares a skip delay, not at the App root (a Tooltip outside any provider brings its own). Keep the Radix overlays out
of the first-load chunk (master plan §1.6 risk 6: `components/ds` adds at most 25 KB gz there): use them from surfaces that
load lazily.

The shell primitives (AppHeader, TabBar, NavRail) landed with DS-2 ("Shell (DS-2)" below). **Not yet:** the creative
editor kit (Program 2, promoted to `components/ds/creative` in DS-10).

### Deliberate deviations from Atlas

- Atlas's `hover:bg-accent` on outline / secondary / ghost buttons is `--ds-hover` (Atlas's menu hover):
  the same step in dark, a hair lighter in light, and neutral outside the skin, where `--ds-accent-soft` is
  the brand tint.
- The destructive fill's label is `--ds-on-danger`, not white (white fails on the default dark red); its
  hover mixes 12 % of the ink in rather than fading to 90 %, so the label only gains contrast.
- The destructive fill stays solid in dark: Atlas's `dark:bg-destructive/80` (and its hover back to full) is
  dropped, because an 80 % fill lets the dark page through under a label measured on the solid
  `--ds-danger` (`--ds-on-danger` is 4.5:1 or better on the fill and its hover mix in all six contexts).
- Textarea focuses like Input: the FIELD recipe's 2 px ring, 2 px off (Atlas's Input ring). Atlas's Textarea
  alone draws the ink outline (`focus-visible:outline-2 … outline-foreground`); here every text field shows
  the same focus, and a field set inside a group can drop the ring the same way.
- Input, Textarea and Select are 16 px on phones (iOS zooms into smaller fields) and the 14 px body size
  from `md` up; Atlas's Input is 14 px everywhere.
- Select is a styled native `<select>`, Slider a native range and Checkbox a native checkbox (no overlay
  library in this wave); the keyboard on Slider is handled in the component so every browser steps alike.
- Progress grows by width (so it fills from the reading start right-to-left too) on `--ds-motion-enter-slow`
  (Atlas: a 500 ms translate).
- Dialog and AlertDialog panels take OVERLAY's panel radius (12 px under the skin) rather than Atlas's 16 px
  `rounded-2xl`, so every overlay shares one shape; their header is left-aligned at every width (Atlas centres it on
  phones) and leaves room for the close button. The scrim centres the panel as a grid, not with a translate.
- Overlays enter but do not animate out (this app has no `animate-out` keyframes); the Toast host keeps TOAST_EXIT.
- The dialog scrim sits on its own step, `Z.dialog` (`--ds-z-dialog`, 88), above the sheets (Atlas has no sheets): a
  confirm opened from a phone sheet is never under it, and a menu or popover it opens (90) stays above it.
- A Menu opens on a finger's tap, not on touch-down (Radix toggles on any primary pointer-down).
- The Toast host is one slot, bottom-centre above the tab bar (redesign plan §2), not Atlas's stack at the top right
  under the header.
- Tooltips wait 300 ms (Atlas's `--tooltip-delay`; its ui-generated Provider passes 0) and show on a long press on touch.
- The Toast host ports GlobalNotificationBar onto the TOAST recipes instead of Radix Toast: one slot needs no queue or
  swipe machinery (`@radix-ui/react-toast` is pinned by PE-FONTS and not imported; lead decision D19 at the S2b
  integration keeps it pinned for now, so the lockfile does not churn mid-integration, and the next dependency pass drops
  it).

### Motion classes and hooks (wave 9)

`styles/ds-motion.css` is Atlas's motion system, renamed `ds-*` and reading the tokens (`--ds-motion-enter-slow`
420 ms for page and list entrances, `--ds-motion-enter-quick` 280 ms for fades and pops, `--ds-motion-stagger`
40 ms, `--ds-ease-enter`): entrances `.ds-rise-in .ds-fade-in .ds-scale-in .ds-slide-in-right .ds-blur-in
.ds-pop .ds-draw .ds-flash` (backwards fill, landing on `transform: none`), `.ds-stagger` (children, or
`--ds-i` to place one), `.ds-reveal` (on the scroll timeline only, so it is visible without JavaScript),
`.ds-disclosure` (a `<details>` whose body glides), `.ds-lift` and `.ds-link`, the loading and live loops
`.ds-skeleton .ds-shimmer-text .ds-progress-indeterminate .ds-live-dot .ds-caret .ds-marquee`, and
`.ds-fade-edge-x/-y .ds-grid-backdrop .ds-overline .ds-overline-display .ds-display`. One reduced-motion block
stops every entrance and loop, wraps the marquee and makes shimmer text plain (`tests/config/dsMotion.test.ts`).
`.studio-stagger` runs on the same tokens.

The hooks and primitives that go with them (Atlas `hooks/` and `components/effects`):

| Export | What it does |
| --- | --- |
| `useInViewPause(ref)`, `<InViewPause as>` | ONE shared IntersectionObserver marks the host `data-inview="false"` while off screen or while the tab is hidden; the CSS loops inside it pause |
| `<LiveDot settle?>` | the decorative live dot (`.ds-live-dot`, current colour), paused off screen; a word beside it says what is live |
| `<CountUp value format?>` | counts up once in view; the final value at once, with no JavaScript animation, under reduced motion |
| `<Collapse open>` | a grid-rows height disclosure that exits on `--ds-motion-exit` and is instant under reduced motion |
| `usePresence`, `useReducedMotion` | the mount-for-exit helper and the live OS motion setting |
| `useImageReveal(key, { enabled })` (MO-1) | art never animates before it arrives. Phases: `loading`, then `decoding` (`img.decode()` pending), then `revealed`, or `error`. A cached picture reveals in the same frame (`fromCache`, no entrance); a box with no `<img>` reveals at once, flagged `empty` (no entrance); a stuck decode reveals 1 s after load. Entrances use `playEntrance`: Web Animations, opacity and transform only, on the compositor, timed by `motionMs` / `motionEase` on the `--ds-motion-*` tokens. No entrance animates a filter; `allowFilterEffects` is the gate for any future filter (none on coarse pointers, low power — Save-Data, or ≤ 4 cores with ≤ 2 GB — or art wider than 640 px). Reduced motion means a decode-gated swap with no entrance. The `<img>` is looked up when the element or the key changes, so key the component by its picture |
- The switch's off track is ink at 18 % over the page (Atlas's `--switch-background`, #d4d4d4 / #3a3a3a).

### Content kit (DS-R1)

The content kit is the shared vocabulary for the library, Discover, the media bin and the studio layout. No screen uses it
yet (DS-R4 onward); its scene is `qa/app/scenes/ds-content.tsx`, and `components/ds/content.test.tsx`,
`layout.test.ts`, `models.test.tsx`, `storage.test.ts` and `useOnline.test.ts` pin it. Inspector and FilterSheet stay
out of the barrel (they pull in the mobile sheets, like `./sheet`); import them by path.

**21 components:** ComicCard, CoverImage (and RevealImage), MediaTile, CardGrid, Shelf, SearchField, FilterChips,
SelectionBar, Lightbox, InlineMeta, Row, NavTrack, Sidebar, StatusBanner, StatusPill, SplitPane, SourceBadge,
PresetTile, PresetGrid, Inspector, FilterSheet. **6 models:** `layoutFor` (layout.ts), the storage key registry
(storage.ts), `announce` (announce.ts), `useOnline` / `useConnectivity`, `useSelection` and `useScrollRestore`.

The rules:
- One primary control inside the card's h3, with Read and Open outside it. A selected card's spark ring is drawn inside
  the art (`MediaTile ring="inside"`, an overlay over the picture), since a container that clips the tile would cut an
  outside ring. The spark appears only as `SPARK_RING_ON_ART`: a ring, never a fill.
- The row variant is 72 px (`library.listRowPx`) with a 48×64 cover and a one-line title.
- CoverImage: a reserved box; artColor via `ART_PLACEHOLDER` / `--ds-art`; lazy unless `priority`; w480 / w1080;
  it resolves once in view; publication cards take `pub/` paths only, with handed-in URLs only from known origins
  (storage, same origin, `coverOrigins`); a decode-gated reveal keyed per picture (`useImageReveal`).
- CardGrid: an explicit-column list (`role="list"`) with arrow keys only in selection mode, where only the first 12
  items of a first page rise in (`CARD_GRID_STAGGER_MAX`). `.ds-stagger` likewise animates only its first 12 children.
- Shelf: hidden when empty, arrows on fine pointers, a polite error row.
- `layoutFor` is the single source for chrome, nav, the Director (tabletop: the place gets the top segment), columns and
  the inspector.
- SplitPane: per-pane ranges, saved when a drag ends.
- `useScrollRestore` waits for content and never overwrites the position while waiting.
- The storage key registry names every stored key; `useOnline` follows the browser and the appStatus network signal,
  with a 30 s "unreachable" hold that the next request to get any answer ends (`services/apiClient.ts` safeFetch calls
  `markReachable()`); it never polls. One polite announcer for the whole app.
- Amounts arrive formatted, and the kit never prints a currency.
- The edge fades (`.ds-fade-edge-x/-y`) and every entrance stop under reduced motion in the one reduced-motion block.

### Shell (DS-2)

- **AppHeader** (`components/ds/AppHeader.tsx`): the `STICKY_HEADER` + `HEADER_GLASS` layer, `data-scrolled` from
  `useScrolledPast(4)` (one read per frame). Brand · nav · actions on `HEADER_GRID` (min-h `--header-h`).
  `AppHeaderSkeleton` paints the same header, `HEADER_INNER` and `HEADER_GRID` with Skeletons. Props: brand, nav,
  actions, banner, children, scrolled, innerClassName. The site header (`components/layout/StaticSiteHeader.tsx`) is an
  AppHeader.
- **TabBar<Id extends string>** (`components/ds/TabBar.tsx`): flex-1 min-w-0 items at `--ds-density-touch`;
  badge/badgeLabel; dot accent | amber | pulse (LiveDot); aria-disabled items say why in a role=status bubble for
  `TAB_HINT_MS` on `Z.tooltip`; `navItemName` gives the item's spoken name. The bar is `--tabbar-h` + `--sa-bottom-eff`,
  max 560 px centred, hidden under `html.kb-open`.
- **NavRail<Id>** (`components/ds/NavRail.tsx`): `--rail-w` + `--sa-left`, optional leading Back `{label, onBack}`.
- These are not wrappers over `mobile/shell/*`: the studio's `MobileTabBar` stays until v2 (it takes `navItemName`).
- NotificationBell's panel is pinned to the viewport below sm (inset-x-4, its top `var(--bell-top)` = the bell's bottom
  + 8 px, measured on open and on resize). From sm it hangs from the bell. It stops 1rem above the screen's bottom.
- NavDropdown opens on hover for pointerType `'mouse'` only; touch and pen open it by tap. Both triggers are disclosures
  (no aria-haspopup).
- Overlays enter with `ds-scale-in` (280 ms) and the tab hint with `ds-fade-in`, never the 420 ms `ds-rise-in`.
- **UserAvatar** (`components/UserAvatar.tsx`, DS-2 #6 at the S2b integration) is on the Atlas tokens: a hairline ring
  on `--ds-well`, the initial in `MUTED`, the signed-in dot on `--ds-success`. An avatar with `onClick` (CommentSection)
  is a real, named button.
- The browser chrome colour and the first paint follow the Atlas paper (lead decision D8; `docs/design/atlas-skin.md`
  changelog, S2b). The shell's Contact link is `CONTACT_HREF` = `mailto:${SUPPORT_EMAIL}` (lead decision D9).

## Guards and the ratchet (DS-0 owns the code)

App-wide guards in `tests/config`, scanning `components/**`, `App.tsx` and `qa/**` (tests and specs
excluded; `live/**` excluded until DS-11):

| Guard | Fails on |
| --- | --- |
| `legacyKitGuard` | `border-black`, `shadow-comic`, `font-comic`, `brand-*`, Tailwind `font-display` (Bangers) |
| `terracottaGuard` | the terracotta literal and its hover hex |
| `localCxGuard` | a local `const cx =` |
| `zLadderGuard` | `z-[…]` / `z-NN` outside the `Z` recipe (`components/ds/**` and `studioDesign.ts` are excluded from this one guard only) |
| `statusInkGuard` | raw chromatic text colours (content and data-viz allowlisted, one line of reason each) |
| `overlineGuard`, `dialogTitle` | hand-rolled eyebrows; untitled or wrongly titled modals |
| `pulseGuard` (DC-0, C9) | each raw `animate-pulse` / `-ping` / `-bounce`, and any without `motion-safe:` or `motion-reduce:animate-none`; the rubric and its loop are `docs/design/clean-and-smooth.md` |
| `sparkGuard`, `huePalette` (CL-0) | a spark fill outside its allowlist, beside a price or on a spend control; an unvalidated hue set (§ Colour layer) |

**Ratchet** (the full rules: `tests/config/baselines/README.md`).
- Roots: `components/**`, `App.tsx`, `qa/**`. Excluded: `*.test.*`, `*.spec.*`, `__tests__`, `__mocks__`,
  `__fixtures__` and `live/**`.
- Baselines are per-file, per-token counts in `tests/config/baselines/<guard>.json`. A file or token not
  listed must count 0; a count above its entry fails; a count *below* it fails too until the entry is
  lowered, so the ratchet only ever moves down.
- `UPDATE_BASELINES=1` only lowers. `UPDATE_BASELINES=reset` rewrites from the tree and needs a reviewer;
  it is never used to clear an "over" failure (fix the file instead). Hand-edited JSON fails
  `ratchet.test.ts` by design (a byte-identical check): use the updater.
- A moved file is recorded with `BASELINE_MOVES='old=new' UPDATE_BASELINES=1` (README "Moving a file"),
  never with `reset`.
- Every scanned file is parsed in its own language (`.ts` as TypeScript, `.tsx` as TSX); `ratchet.test.ts`
  fails on a syntax error.
- Allowlists pin exact uses (the token and its trimmed line) with a one-line reason; a pin that matches
  nothing is stale and fails.
- zLadder skips `components/ds/**` and `components/chat/studioDesign.ts` (where the `Z` recipe spells the
  ladder). statusInk, overline and dialogTitle keep their exact pins in `components/comicstudio`.
- Sizes at DS-0's base: zLadder 122 files and 216 uses (119 `z-NN` including `-z-`, 97 `z-[…]`); legacyKit
  74 files and 1,719 uses. The totals line of each JSON has today's numbers.
- A package that shrinks a baseline writes the new numbers in a wave note; the slot's integration owner
  runs the updater once after merging, so no two packages edit the same baseline in one slot.

`components/ds/ds.hygiene.test.ts` holds the primitives and the gallery scene to zero on all of these
(stricter: comments included, and no spelled duration), so they enter the guards at 0.

## QA

**QA scenes.** The contract is in `qa/app/index.tsx`: each `qa/app/scenes/<id>.tsx` default-exports
`{ id, title, Scene }` with `id` equal to the file name; a scene is a whole page with exactly one `<main>`
(the harness mounts it bare; `qa/ComicQaApp.test.tsx` checks every discovered scene), unique ids, no
network, and nothing that moves under `prefers-reduced-motion`. The URL is
`/qa/comic-qa.html?surface=app[&scene=<id>]&theme=light|dark&skin=atlas|none`. Run them with
`npm run qa:build && npx playwright test -c tests/e2e/playwright.config.ts --grep @app`.

The smoke matrix for the app scenes (redesign plan M2, `tests/e2e/devices.ts` `APP_SCENE_MATRIX`):
reflow-320 (320×640), 320×568, 360×740, 768×1024, 1024×768, 1280×800, 1440×900, the Fold5 book posture and
852×393, each in light and dark under reduced motion, plus the Atlas-skin phone, the OS-dark desktop and
motion-on. Each page: no overflow, no coarse target under 44 px (on every screen of the page), no legacy class,
no duplicate id, axe, and on phones the `<main>` keeps ≥ 45 % of the height.

`qa/app/scenes/ds-gallery.tsx` default-exports `{ id: 'ds-gallery', title, Scene }`; the app harness
(`qa/app/index.tsx`, DS-1b) discovers scenes by glob and the layout smoke runs each at 320–1440 px, light
and dark, with and without the Atlas skin: no overflow, no coarse target under 44 px, no legacy class, axe.
The gallery shows every primitive in every variant and state in the page theme and, while the page is
light, again in a dark panel. The overlays have their own scene, `qa/app/scenes/ds-overlays.tsx` (DS-1c): a trigger for
each (they start closed, so an open modal never hides the page from the smoke), the Toast host and a static card in
every status. The content kit has its own scene too, `qa/app/scenes/ds-content.tsx` (DS-R1). DS-3 (S2): the comics landing, the
sign-in card, the tester invite, Project info and its image gallery, and the legacy share link's state views compose the
DS primitives and recipes; their guard baselines are 0; QA scenes landing, auth, auth-signin, auth-access, shared. The app
shell has the `shell` scene (DS-2). A new primitive is not done until the gallery shows it
(`components/ds/gallery.test.tsx` checks every primitive is there).

Clutter ratchet: `--project=declutter` (tests/e2e/declutter.spec.ts, baseline tests/e2e/baselines/declutter.json; 320,
360 and 1280 px); the loop is docs/design/clean-and-smooth.md §4. The layout smoke's `one-spark` check fails a viewport
that shows more than one visible `create` fill (every app scene but the gallery, a spark specimen).

Granted e2e files outside their packages' folders (S2a lead decisions): `tests/e2e/studio.chat.images.spec.ts` (PF-2:
chat tiles load the small variant; the `chat-14` fixture, 14 or more tiles) and `tests/e2e/reader.turns.spec.ts`
(RD-A: never-blank turns). The reader spec delays images through the public `QaHarness.delayImages`, not the
harness's private route.
