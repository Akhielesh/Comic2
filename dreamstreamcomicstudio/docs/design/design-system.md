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
| Gallery | `qa/app/scenes/ds-gallery.tsx` | every primitive, variant and state, light and dark, for the layout smoke |

Adoption starts in DS-2: in this wave (DS-1a) no existing screen was moved onto the primitives.

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
| `--ds-z-popover` | `90` | same | menus, popovers, selects |
| `--ds-z-toast` | `95` | same | toasts |
| `--ds-z-tooltip` | `100` | same | tooltips |
| `--ds-density-compact` / `-comfortable` / `-touch` | `28px` / `36px` / `44px` | same | control row heights; touch = every control under a coarse pointer (= `--tap-min`) |
| `--ds-text-xl` / `-2xl` / `-3xl` | `1.25rem` / `1.5rem` / `1.875rem` | same (Atlas `--text-xl…3xl`) | heading steps above the 11–16 px chrome scale |
| `--ds-motion-enter-quick` | `var(--ds-motion-enter)` (280 ms) | same | Atlas's name for the 280 ms entrance; `--ds-motion-enter` keeps its name and value |
| `--ds-motion-enter-slow` | `420ms` | same (Atlas `--motion-enter`) | page and section entrances |
| `--ds-motion-stagger` | `40ms` | same (Atlas `--motion-stagger-step`) | the step between list items |
| `--ds-on-danger` | `#ffffff`; `.dark` `#1a1915` | `#ffffff` (both themes) | the label on a solid danger fill: white on the red, ink on the default dark theme's light red (white there is 2.8:1) |

Atlas has no z or density tokens: the skin restates the same values so every token has a skin value
(`tests/config/atlasSkin.test.ts`). The non-colour tokens are theme-invariant and are not repeated in
`.dark`. `--ds-on-danger` on the danger fill and on its hover mix is measured in all six contexts by
`tests/config/tokenContrast.test.ts` (≥ 4.5:1).

## Recipes

All in `components/chat/studioDesign.ts`. The families and what they are for (details and Atlas sources
in `atlas-skin.md`, "The shared constants"):

| Recipe | For |
| --- | --- |
| `CANVAS_BG`, `SIDEBAR_BG`, `GLASS`, `GLASS_STRONG`, `PANEL`, `HAIRLINE` | surfaces and edges |
| `RADIUS_PANEL` / `_CONTROL` / `_PILL`, `SHADOW_SOFT` | shape and depth |
| `INK`, `MUTED`, `HEADING`, `FONT_DISPLAY`, `OVERLINE`, `DIALOG_TITLE(_FROM_SM)` | type (every small uppercase label is `OVERLINE`) |
| **`TEXT_XL`, `TEXT_2XL`, `TEXT_3XL`** (DS-1a) | the 20 / 24 / 30 px heading steps (size and leading) |
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
| **`Z`** (DS-1a) | `Z.stage … Z.tooltip` = `z-[var(--ds-z-*)]`: the only place a z-index class is spelled |
| **`DENSITY`** (DS-1a) | `compact` / `comfortable` / `touch` row heights; `coarse` (44 px tall under a coarse pointer) and `coarseSquare` (44 × 44) |

## Composing classes

- **`cn` from `lib/utils.ts`** (clsx + tailwind-merge: later classes win). Never a local `cx` — it joins
  without merging, and a tone stacked on a base ink renders the base ink.
- **Focus goes on after the merge.** tailwind-merge 3 reads class names with Tailwind 4 meanings, where a
  bare `outline` is an outline *width*; merging `FOCUS_RING` drops its `focus-visible:outline` (the outline
  *style* in this app's Tailwind 3) and the ring disappears. Primitives write
  `` `${cn(BASE, VARIANT[variant], className)} ${FOCUS_RING}` `` (and use `[outline-style:solid]` where
  an outline style must pass through `cn`); their tests assert every recipe class survives.
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

**Not yet:** Dialog, AlertDialog, Menu, Popover, Tooltip and the Toast host (DS-1c, after the overlay
library decision D6); the AppHeader / NavRail / TabBar wrappers (DS-2); the creative editor kit
(Program 2, promoted to `components/ds/creative` in DS-10).

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
- The switch's off track is ink at 18 % over the page (Atlas's `--switch-background`, #d4d4d4 / #3a3a3a).

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

**Ratchet.** Baselines are per-file, per-token counts in `tests/config/baselines/<guard>.json`. A file
absent from the baseline must count 0. A count above its baseline fails; a count *below* it fails too,
with a message to lower the baseline, so the ratchet only ever moves down. The exact-line pins in the
three Comic Studio guards stay as they are for `components/comicstudio`. A package that shrinks a baseline
writes the new numbers in a wave note; the slot's integration owner applies them, so no two packages edit
the same baseline in one slot.

`components/ds/ds.hygiene.test.ts` holds the primitives and the gallery scene to zero on all of these
(stricter: comments included, and no spelled duration), so they enter the guards at 0.

## QA

`qa/app/scenes/ds-gallery.tsx` default-exports `{ id: 'ds-gallery', title, Scene }`; the app harness
(`qa/app/index.tsx`, DS-1b) discovers scenes by glob and the layout smoke runs each at 320–1440 px, light
and dark, with and without the Atlas skin: no overflow, no coarse target under 44 px, no legacy class, axe.
The gallery shows every primitive in every variant and state in the page theme and, while the page is
light, again in a dark panel. A new primitive is not done until the gallery shows it
(`components/ds/gallery.test.tsx` checks every primitive is there).
