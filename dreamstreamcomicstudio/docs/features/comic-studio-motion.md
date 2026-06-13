# Comic Studio v3 — Motion design

The Agent Stream should *feel* alive — cards arrive, the agent thinks, images develop,
costs tick up — without ever feeling busy or blocking. This is the motion layer for the
v3 redesign (`comic-studio-v3-agent-stream.md`).

## Principles

1. **Springs over linear eases.** Physical motion reads as "next-gen". We use the kit's
   `springSoft` (panels/reveals; settles without overshoot) and `springSnappy`
   (press/hover/selection). Durations are reserved for one-shot reveals (`easeOut`).
2. **Choreography, not chaos.** Things enter in sequence (staggered), newest last, so the
   eye follows the agent's "train of thought" down the column.
3. **Motion is meaning.** Every animation maps to a real state change (a card resolved, an
   image rendered, money was spent). Nothing animates for decoration alone.
4. **Always reversible to calm.** Every primitive honors `prefers-reduced-motion` via
   `usePrefersReducedMotion()` and degrades to an instant, static fallback. Reduced motion
   is a first-class path, tested.
5. **Cheap and non-blocking.** Transform/opacity/filter only (GPU-friendly); content is
   never gated behind JS — it renders, then enhances.

## Tokens (`components/studio/kit/motion.ts`)

| Token | Value | Use |
|---|---|---|
| `springSoft` | stiffness 320 · damping 30 · mass 0.9 | card entrance, layout, reveals |
| `springSnappy` | stiffness 520 · damping 32 | hover/press, selection, panel pop |
| `easeOut` | 0.45s · cubic(0.2,0.7,0.2,1) | one-shot develop/sheen |
| `STAGGER_STEP` | 0.06s | per-child delay in a stream/grid |

## The signature beats (`components/studio/kit/streamMotion.tsx`)

| Primitive | The moment | Motion |
|---|---|---|
| `StreamList` / `StreamItem` | agent cards arrive in the column | blur-up + rise + faint scale on `springSoft`, staggered; `layout` keeps the column smooth as heights change |
| `AgentThinking` | "composing the next card" | three accent dots looping opacity + lift; `role="status"` for SR |
| `ImageDevelop` | an AI render resolves | blur + over-bright → crisp, with a one-shot diagonal sheen sweep |
| `SelectPop` | lock a style board / cover | spring lift on hover, scale-down on press, accent ring + check-mark pop on select (`AnimatePresence`) |
| `CountUp` | the `$X.XX` cost chip updates | rAF ease-out-cubic tween; jumps instantly under reduced motion |
| `PanelGrid` / `PanelPop` | page panels finish rendering | each panel pops in (scale + rise) on `springSnappy`, staggered |

## How it maps to the stream

- **Plan card** approve → cost chip `CountUp` ticks; the next `StreamItem` slides in under it.
- **Style gallery** → tiles are `SelectPop`; the chosen board rings + checks, others dim.
- **Cast card** → reference thumbs are `ImageDevelop` (develop-in as each sheet renders).
- **Page card** → `PanelGrid` pops panels in as `render_panel` events land; cost `CountUp`s.
- **Confirm gate / Done** → enter/exit via `AnimatePresence` on the stream.

## Preview & tuning

`components/studio/kit/ComicMotionShowcase.tsx` is a self-contained demo of every beat
(with a **Replay** button). Render it on any route to judge and tune feel — the springs and
stagger live in `motion.ts`, so tuning is one file. Reduced-motion can be exercised via the
OS setting or the matchMedia mock used in `streamMotion.test.tsx`.

## Status

Motion **foundation** shipped (tokens + primitives + showcase + tests). Wiring these into the
real v3 stream cards happens with the stream UI build (Phase A of the v3 plan).
