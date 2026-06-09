# 03 — Generative In-Chat UI (the first vertical slice)

## Why this first

The brief asks for agents that "build efficient in-chat components, having full ability
and control to provide and customize the response… custom-build structures, alignments
and so much more" — quickly and safely. Today our artifacts are **fixed types**; there
is no way for the agent to compose a *bespoke* layout. This slice adds that, and it is
the render target the sandbox later emits into.

## The architecture decision (research-backed)

There are two ways to let an agent "build a component":

- **(A) Whitelisted structured spec** — the agent emits JSON describing a tree of
  *known* block types; we render with trusted React components. Safe (no code
  execution, props validated), fast, streamable, limited to the whitelist.
- **(B) Agent writes JSX/HTML/JS** — rendered in a **sandboxed cross-origin iframe**
  (`sandbox="allow-scripts"`, strict CSP, `postMessage`). Unlimited, riskier, slower.

Every safety-conscious vendor (tambo, CopilotKit, assistant-ui, Vercel AI SDK)
converges on **(A) as the default**, **(B) as an escape hatch**. We already run both:
(A) is the artifact system; (B) is `CodeBlock.tsx`'s `sandbox="allow-scripts"` iframe
and the WebContainer path. **This slice deepens (A).** (Note: Sandpack is now legacy —
CodeSandbox was acquired by Together AI, EOL ~July 2026 — so the long-term (B) hatch is
WebContainer + raw sandboxed iframe, never `react-live` which evals in-origin.)

> **Hard safety rule:** never combine `allow-scripts` with `allow-same-origin` on an
> untrusted iframe — together they let the framed doc remove its own sandbox and read
> parent cookies/tokens. Our existing `CodeBlock.tsx` already does this correctly.

## The `generative_ui` artifact

A recursive **block tree** the agent emits as `{ type: 'generative_ui', data: GenerativeUI }`.

### Block grammar (whitelisted)

```ts
// apiTypes.ts (Phase 0)
export interface GenerativeUI {
  title?: string;
  accent?: string;              // hex; recolors the card strip
  palette?: PaletteName;        // 'brand' | 'bull' | ... (kit theme)
  root: UIBlock;                // the tree
}

export type UIBlock =
  // ---- layout / structure (the "alignments" the brief wants) ----
  | { kind: 'stack';   gap?: 0|1|2|3|4; align?: 'start'|'center'|'end'|'stretch'; children: UIBlock[] }
  | { kind: 'row';     gap?: 0|1|2|3|4; align?: 'start'|'center'|'end'|'baseline'; wrap?: boolean; children: UIBlock[] }
  | { kind: 'grid';    columns?: 1|2|3|4; gap?: 0|1|2|3|4; children: UIBlock[] }
  | { kind: 'section'; title?: string; accent?: string; children: UIBlock[] }
  | { kind: 'divider' }
  // ---- content primitives ----
  | { kind: 'heading'; text: string; level?: 1|2|3 }
  | { kind: 'text';    text: string; tone?: 'default'|'muted'|'strong'; align?: 'left'|'center'|'right' }
  | { kind: 'badge';   text: string; tone?: 'neutral'|'good'|'warn'|'bad'|'info' }
  | { kind: 'pill';    label: string; change?: number; changePercent?: number }   // TrendPill
  | { kind: 'keyValue'; items: { label: string; value: string }[] }
  | { kind: 'callout'; tone?: 'info'|'good'|'warn'|'bad'; title?: string; text: string }
  | { kind: 'image';   src: string; alt?: string; caption?: string; ratio?: '1:1'|'4:3'|'16:9' }
  | { kind: 'progress'; value: number; max?: number; label?: string }            // LinearGauge
  // ---- data viz (reuse existing kit + cards) ----
  | { kind: 'metric'; label: string; value: string|number; unit?: string; delta?: number; deltaPercent?: number; spark?: number[] }
  | { kind: 'sparkline'; values: number[]; color?: string }
  | { kind: 'chart'; chart: ChartArtifact }            // reuse ChartCard
  | { kind: 'table'; table: DataTableArtifact };       // reuse DataTableCard
```

### Renderer (`GenerativeUICard.tsx`)

A pure, recursive renderer built **only** on the Primitive Kit + existing cards:

- `stack`/`row`/`grid`/`section` → fl/grid containers using the house spacing scale.
- `heading`/`text`/`badge`/`pill`/`keyValue`/`callout`/`divider`/`image`/`progress` →
  small kit-styled elements.
- `metric`/`sparkline` → `Sparkline` + the MetricBoard tile style.
- `chart`/`table` → delegate to existing `ChartCard` / `DataTableCard` (so a chart
  inside a generated layout is identical to a standalone chart artifact).

**Safety + robustness built in (this is also enterprise-fix #4):**

1. **Runtime validation** before render — `validateGenerativeUI(data)` walks the tree,
   drops unknown `kind`s, coerces/bounds props (e.g. `columns ∈ 1..4`, `gap ∈ 0..4`),
   caps **depth** (≤ 6) and **total node count** (≤ 200) to stop pathological/DoS
   trees, and sanitizes `image.src` to `https:`/`data:image/` only. Invalid nodes
   render a small inline "unsupported block" placeholder, never throw.
2. **Per-artifact error boundary** — a new `ArtifactBoundary` wraps *every* artifact in
   `ChatArtifacts.tsx` so one malformed card (from any tool or MCP) can't blank the
   whole message. Fixes the unvalidated-`data` weakness for all 24+ existing types too.
3. **No HTML injection** — text is rendered as text (no `dangerouslySetInnerHTML`); the
   block grammar has no raw-HTML escape hatch. Arbitrary HTML stays in the existing
   iframe-sandboxed path, not here.

### Animation / polish (the brief asked for this)

- `framer-motion@12` is already a dep (also published as `motion`). Use **`LazyMotion`
  + `m`** (loads ~4.6kb instead of ~34kb) for in-chat reveals.
- Blocks reveal with a short **staggered fade/slide** (children animate in sequence) —
  matches the existing `animate-fade-in` house style but feels "assembled."
- During streaming, show a **skeleton** for not-yet-arrived blocks (mirrors the Vercel
  AI SDK `input-streaming → output-available` part-state model), then cross-fade to the
  real block. Respect `prefers-reduced-motion`.

### The tool: `render_ui`

`server/src/ai/tools/generativeUi.ts` registers a `ChatTool`:

- `name: "render_ui"`, described for the model as: *compose a custom in-chat layout
  from blocks (stacks/rows/grids + text, metrics, charts, tables, images, callouts)
  when a fixed card type doesn't fit and you need a bespoke structure/alignment.*
- `parameters`: JSON Schema mirroring `GenerativeUI` (kept shallow enough for reliable
  emission; the renderer tolerates extras).
- `execute`: validates/normalizes server-side too (defense in depth), then returns
  `{ content: "<short text summary>", artifacts: [{ type: 'generative_ui', data }] }`.
- A `toolCatalog.ts` entry (routable on keywords: layout, dashboard, compose, custom,
  arrange, build, panel) so smart-routing surfaces it.

### Gallery demo (mandatory)

A `GALLERY_DEMOS` entry for `generative_ui` showing a realistic composed layout (a
mini dashboard: title + a 2-col grid of metrics + a chart + a callout). Required by
`gallery.coverage.test.ts`.

### How the sandbox plugs in later

In Phase 1+, when the agent writes code to solve a task, the code's *result* is emitted
as a `generative_ui` spec (or a `chart`/`data_table`/`resource_bundle`). So the same
renderer serves both "model composed a layout directly" and "sandbox produced a result"
— one render path, validated once.

## Chart rendering note (whitelist stays dependency-free)

The repo deliberately uses **inline-SVG** charts (no chart libs) via the kit. We keep
that for in-chat interactivity. The research's Vega-Lite/ECharts recommendation applies
to the **server/sandbox** path (deterministic image output) — see
[`04-toolbelt-and-verification.md`](./04-toolbelt-and-verification.md). A Vega-Lite spec
produced in the sandbox can render server-side to an image *or* map onto our
`ChartArtifact` for the interactive kit renderer; we are not forced to ship a chart lib
to the client.
