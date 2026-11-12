// One drawing of LetterPlans as an SVG element tree (pure, DOM-free). Two thin consumers:
//   - LetteringSvg (React) for the board, editor, reader, preset chips and font previews;
//   - letteringSvgMarkup() (escaped string) for the print window (P2-EXPORT) and any static use.
// Both draw the SAME nodes, so screen and print can never disagree. The canvas exporter draws the same
// plans in the same order (documented below) — renderers never re-wrap, re-measure or re-place.
//
// Draw order per z-ordered group (a balloon plus its linked chain), chosen so the `classic` preset is
// pixel-identical to the pre-v5 board and PNG exporter:
//   1. extras (scroll rolls, ribbon fishtails): fill (shaded) + 1× stroke — behind the body
//   2. tail and link-neck "fat strokes" (2× width) — the visible half sits outside the fill
//   3. thought-trail circles and the body: fill + 1× stroke (dashes per borderStyle)
//   4. tail and neck fills over the body edge (so the joins merge seamlessly)
//   5. the `inner` outline (double border, explosion core, scroll curls)
//   6. text: shadow copy, then fill with an optional outline (paint-order: stroke).
//      Pro text styling (PE-LETTER) draws in the same step, back to front: glow (stacked round strokes, never a filter,
//      so canvas matches), the shadow or the SFX 3D extrusion, the stacked outlines (`strokes`, outermost first; they
//      supersede `textStroke`), then the fill (a <linearGradient> for `fillGradient` or the SFX 'gradient' effect).
//      SFX 'shatter' draws that whole stack twice, clipped (<clipPath>) above and below a seeded crack and pulled apart.
//      Gradients and clip paths sit in a <defs> inside the balloon's text group, with ids from `idPrefix`.
// Translucent or transparent fills (alpha < 1 or 'none'): every shape is stroked at 2× through a mask
// that hides the inside of the shapes, then the fills are drawn in one layer at the fill's alpha. The
// border stays crisp and opaque, nothing shows through the fill, and tails still merge with the body.
// Strokes never go below 1.25 CSS px at the rendered size (widthPx) — the board's long-standing floor.

import type { LineKind } from '../../../shared/comic/doc';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { borderDashArray, EXTRA_SHADE, hashSeed, linkNeck, shadeColor, type BubbleGeometry } from '../../../shared/comic/lettering/shapes';
import { proLetterOf, type FillGradient, type StrokeLayer } from '../../../shared/comic/lettering/style';
import { PRO_LETTER_LIMITS } from '../../../shared/comic/limits';
import { languageSpec } from '../../../shared/comic/languages';
import { graphemes } from '../../../shared/comic/textLayout';
import { fontFamilyStack } from '../../../shared/comic/lettering/fonts';

const FONT_RE = /^(italic\s+)?(?:(\d{3})\s+)?([\d.]+)px\s+"([^"]+)"/;

export interface ParsedFont {
  italic: boolean;
  weight: number;
  px: number;
  family: string;
}

/** Parse a lettering font shorthand ("italic 700 17px "DSL Comic Neue", …"). */
export const parseFont = (font: string): ParsedFont | null => {
  const m = FONT_RE.exec((font || '').trim());
  if (!m) return null;
  return { italic: !!m[1], weight: m[2] ? Number(m[2]) : 400, px: Number(m[3]), family: m[4] };
};

export interface SvgNode {
  tag: string;
  attrs: Record<string, string | number | undefined>;
  children?: SvgNode[];
  /** Text content (escaped by the string renderer; React escapes it natively). */
  text?: string;
}

export interface LetteringDrawOptions {
  /** Page width / height. viewBox = 0 0 1000 1000/aspect. */
  aspect: number;
  /** Rendered page width in CSS px (keeps strokes ≥ 1.25 px). */
  widthPx?: number;
  /** Balloons not in the set render at opacity 0 (guided reading); undefined = all visible. */
  visibleLineIds?: ReadonlySet<string>;
  /** Balloons drawn with a selection outline. */
  selectedLineIds?: ReadonlySet<string>;
  /** The doc's lettering language; plans in another language are untranslated fallbacks. */
  docLang?: string;
  /** Show the subtle "not translated yet" marker on fallback lines (reader toggle). */
  markFallbackLang?: boolean;
  /** Unique id prefix for masks (several pages on one screen). */
  idPrefix?: string;
  /** Accessible label per plan (default: kind + text). */
  labelFor?: (plan: LetterPlan) => string;
}

const KIND_LABEL: Record<LineKind, string> = {
  speech: 'Speech',
  thought: 'Thought',
  whisper: 'Whisper',
  shout: 'Shout',
  caption: 'Caption',
  sfx: 'Sound effect'
};
const ACCENT = '#D97757';
const INK = '#111111';
const r2 = (n: number) => Math.round(n * 100) / 100;

/** '#rrggbb[aa]' → colour + opacity; 'none' / invalid → null (nothing to paint). */
export function paintOf(color: string | null | undefined): { color: string; opacity: number } | null {
  if (typeof color !== 'string') return null;
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!m) return null;
  const opacity = m[2] ? parseInt(m[2], 16) / 255 : 1;
  return { color: `#${m[1].toLowerCase()}`, opacity: Math.round(opacity * 1000) / 1000 };
}

/** Text of a plan as the reader reads it (runs joined). */
export const planText = (plan: LetterPlan): string => plan.runs.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();

/** Outline box of a plan in page units (text box + the shape's real bounds). */
export const planOutline = (plan: LetterPlan): { x: number; y: number; w: number; h: number } => ({
  x: plan.x + plan.geometry.bounds.x,
  y: plan.y + plan.geometry.bounds.y,
  w: plan.geometry.bounds.w,
  h: plan.geometry.bounds.h
});

const defaultLabel = (plan: LetterPlan) => `${KIND_LABEL[plan.kind] ?? 'Line'}: ${planText(plan)}`;

/** Effective stroke in page units (≥ 1.25 CSS px at widthPx). 0 = no border. */
export const strokeFor = (plan: LetterPlan, widthPx?: number): number => {
  if (!(plan.stroke > 0) || plan.style.borderStyle === 'none') return 0;
  const min = widthPx && widthPx > 0 ? (1.25 * 1000) / widthPx : 0;
  return r2(Math.max(plan.stroke, min));
};

const memberTransform = (plan: LetterPlan): string => {
  const t = `translate(${r2(plan.x)} ${r2(plan.y)})`;
  const rot = plan.transform?.rotate;
  if (!rot) return t;
  // Rotate the whole balloon around its text-box centre (absolute), then place it.
  return `rotate(${r2(rot)} ${r2(plan.transform!.cx)} ${r2(plan.transform!.cy)}) ${t}`;
};

const dashOf = (plan: LetterPlan, stroke: number): string | undefined => {
  const d = borderDashArray(plan.style.borderStyle, stroke);
  return d ? d.map(r2).join(' ') : undefined;
};

interface Member {
  plan: LetterPlan;
  stroke: number;
  fill: { color: string; opacity: number } | null;
  border: { color: string; opacity: number } | null;
  g: BubbleGeometry;
}

const pathNode = (d: string, attrs: SvgNode['attrs']): SvgNode => ({ tag: 'path', attrs: { d, ...attrs } });

/** Body/tail/extras/bubbles/necks for one group, in the documented order. */
function artNodes(members: Member[], necks: { d: string; owner: Member }[], maskId: string): SvgNode[] {
  const out: SvgNode[] = [];
  const translucent = members.some((m) => !m.fill || m.fill.opacity < 1) || necks.some((n) => !n.owner.fill || n.owner.fill.opacity < 1);
  const wrap = (m: Member, children: SvgNode[]): SvgNode | null => (children.length ? { tag: 'g', attrs: { transform: memberTransform(m.plan) }, children } : null);
  const push = (n: SvgNode | null) => {
    if (n) out.push(n);
  };
  const strokeAttrs = (m: Member, width: number, dash?: string): SvgNode['attrs'] => ({
    stroke: m.border!.color,
    'stroke-opacity': m.border!.opacity < 1 ? m.border!.opacity : undefined,
    'stroke-width': r2(width),
    'stroke-linejoin': 'round',
    'stroke-linecap': m.plan.style.borderStyle === 'dotted' ? 'round' : undefined,
    'stroke-dasharray': dash
  });

  if (!translucent) {
    // 1. extras
    for (const m of members) {
      const extras = m.g.extras || [];
      if (!extras.length) continue;
      const shade = EXTRA_SHADE[m.plan.style.shape] ?? 0;
      const fill = shadeColor(m.fill!.color, shade);
      push(wrap(m, extras.map((d) => pathNode(d, { fill, ...(m.border && m.stroke ? strokeAttrs(m, m.stroke) : { stroke: 'none' }) }))));
    }
    // 2. tail + neck fat strokes
    for (const m of members) {
      if (m.g.tail && m.border && m.stroke) push(wrap(m, [pathNode(m.g.tail, { fill: m.fill!.color, ...strokeAttrs(m, m.stroke * 2, dashOf(m.plan, m.stroke)) })]));
    }
    for (const n of necks) if (n.owner.border && n.owner.stroke) out.push(pathNode(n.d, { fill: n.owner.fill!.color, ...strokeAttrs(n.owner, n.owner.stroke * 2) }));
    // 3. bubbles + body
    for (const m of members) {
      const kids: SvgNode[] = m.g.bubbles.map((c) => ({
        tag: 'circle',
        attrs: { cx: c.cx, cy: c.cy, r: c.r, fill: m.fill!.color, ...(m.border && m.stroke ? strokeAttrs(m, m.stroke) : { stroke: 'none' }) }
      }));
      if (m.g.body) kids.push(pathNode(m.g.body, { fill: m.fill!.color, ...(m.border && m.stroke ? strokeAttrs(m, m.stroke, dashOf(m.plan, m.stroke)) : { stroke: 'none' }) }));
      push(wrap(m, kids));
    }
    // 4. tail + neck fills over the body edge
    for (const m of members) if (m.g.tail) push(wrap(m, [pathNode(m.g.tail, { fill: m.fill!.color, stroke: 'none' })]));
    for (const n of necks) out.push(pathNode(n.d, { fill: n.owner.fill!.color, stroke: 'none' }));
  } else {
    // Masked fat strokes (outside half only), then one fill layer per member at its alpha.
    const shapes = (m: Member, attrs: SvgNode['attrs'], dashed: boolean): SvgNode[] => [
      ...(m.g.extras || []).map((d) => pathNode(d, attrs)),
      ...(m.g.tail ? [pathNode(m.g.tail, { ...attrs, 'stroke-dasharray': dashed ? dashOf(m.plan, m.stroke) : undefined })] : []),
      ...m.g.bubbles.map((c) => ({ tag: 'circle', attrs: { cx: c.cx, cy: c.cy, r: c.r, ...attrs } }) as SvgNode),
      ...(m.g.body ? [pathNode(m.g.body, { ...attrs, 'stroke-dasharray': dashed ? dashOf(m.plan, m.stroke) : undefined })] : [])
    ];
    const maskKids: SvgNode[] = [{ tag: 'rect', attrs: { x: -5000, y: -5000, width: 11000, height: 11000, fill: '#ffffff' } }];
    for (const m of members) {
      const w = wrap(m, shapes(m, { fill: '#000000', stroke: 'none' }, false));
      if (w) maskKids.push(w);
    }
    for (const n of necks) maskKids.push(pathNode(n.d, { fill: '#000000', stroke: 'none' }));
    const hasStroke = members.some((m) => m.border && m.stroke);
    if (hasStroke) {
      out.push({
        tag: 'mask',
        attrs: { id: maskId, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse', x: -5000, y: -5000, width: 11000, height: 11000 },
        children: maskKids
      });
      const strokes: SvgNode[] = [];
      for (const m of members) {
        if (!m.border || !m.stroke) continue;
        const w = wrap(m, shapes(m, { fill: 'none', ...strokeAttrs(m, m.stroke * 2) }, true));
        if (w) strokes.push(w);
      }
      for (const n of necks) if (n.owner.border && n.owner.stroke) strokes.push(pathNode(n.d, { fill: 'none', ...strokeAttrs(n.owner, n.owner.stroke * 2) }));
      out.push({ tag: 'g', attrs: { mask: `url(#${maskId})` }, children: strokes });
    }
    for (const m of members) {
      if (!m.fill) continue;
      const shade = EXTRA_SHADE[m.plan.style.shape] ?? 0;
      const kids: SvgNode[] = [
        ...(m.g.extras || []).map((d) => pathNode(d, { fill: shadeColor(m.fill!.color, shade), stroke: 'none' })),
        ...(m.g.tail ? [pathNode(m.g.tail, { fill: m.fill.color, stroke: 'none' })] : []),
        ...m.g.bubbles.map((c) => ({ tag: 'circle', attrs: { cx: c.cx, cy: c.cy, r: c.r, fill: m.fill!.color, stroke: 'none' } }) as SvgNode),
        ...(m.g.body ? [pathNode(m.g.body, { fill: m.fill.color, stroke: 'none' })] : [])
      ];
      const ownNecks = necks.filter((n) => n.owner === m).map((n) => pathNode(n.d, { fill: m.fill!.color, stroke: 'none' }));
      const layer: SvgNode[] = [];
      const w = wrap(m, kids);
      if (w) layer.push(w);
      layer.push(...ownNecks);
      if (layer.length) out.push({ tag: 'g', attrs: { opacity: m.fill.opacity < 1 ? m.fill.opacity : undefined }, children: layer });
    }
  }
  // 5. inner outlines
  for (const m of members) {
    if (m.g.inner && m.border && m.stroke) push(wrap(m, [pathNode(m.g.inner, { fill: 'none', ...strokeAttrs(m, m.stroke) })]));
  }
  return out;
}

const anchorFor = (align: LetterPlan['style']['align'], rtl: boolean): 'start' | 'middle' | 'end' =>
  align === 'center' ? 'middle' : align === 'left' ? (rtl ? 'end' : 'start') : rtl ? 'start' : 'end';

/** Pro text-styling steps a plan draws (PE-LETTER); null for a plan that draws exactly as before. */
interface ProText {
  glow: { color: string; opacity: number; size: number } | null;
  /** Stacked outlines, innermost first (supersede textStroke); null = textStroke as before. */
  strokes: StrokeLayer[] | null;
  gradient: FillGradient | null;
  /** SFX 3D extrusion: copies stepped toward the shadow offset (em), in this paint. */
  extrude: { color: string; opacity: number; dx: number; dy: number } | null;
  shatter: boolean;
}

const proTextOf = (plan: LetterPlan): ProText | null => {
  const st = plan.style;
  const pro = proLetterOf(st);
  const effect = plan.kind === 'sfx' ? (st.sfxEffect as string) : '';
  const glowP = pro.glow && pro.glow.size > 0 ? paintOf(pro.glow.color) : null;
  // The load keeps any finite stored size (rollback rule), so the drawing clamps to the write bounds.
  const glow = glowP && pro.glow ? { ...glowP, size: Math.min(PRO_LETTER_LIMITS.glowSizeMax, pro.glow.size) } : null;
  // Stored strokes win; the SFX outline stack derives three rings from the line's outline.
  let strokes: StrokeLayer[] | null = Array.isArray(st.strokes)
    ? st.strokes
        .filter((x) => !!x && !!paintOf(x.color) && x.w > 0)
        .slice(0, PRO_LETTER_LIMITS.strokes)
        .map((x) => ({ color: x.color, w: Math.min(PRO_LETTER_LIMITS.strokeWMax, x.w) }))
    : null;
  if (!strokes && effect === 'outline_stack') {
    const w = st.textStroke?.width && st.textStroke.width > 0 ? st.textStroke.width : 0.1;
    const c = st.textStroke && paintOf(st.textStroke.color) ? st.textStroke.color : INK;
    strokes = [{ color: c, w }, { color: '#ffffff', w: w * 0.9 }, { color: c, w: w * 0.7 }];
  }
  let gradient: FillGradient | null = pro.fillGradient && paintOf(pro.fillGradient.from) && paintOf(pro.fillGradient.to) ? pro.fillGradient : null;
  if (!gradient && effect === 'gradient') {
    const from = paintOf(st.textColor) ? st.textColor : INK;
    gradient = { from, to: shadeColor(from, 0.55), angle: 90 };
  }
  let extrude: ProText['extrude'] = null;
  if (effect === 'extrude3d') {
    const base = paintOf(st.textColor)?.color ?? INK;
    const sp = st.shadow ? paintOf(st.shadow.color) : null;
    extrude = { ...(sp ?? { color: shadeColor(base, -0.55), opacity: 1 }), dx: st.shadow?.dx ?? 0.07, dy: st.shadow?.dy ?? 0.07 };
  }
  const shatter = effect === 'shatter';
  return glow || strokes || gradient || extrude || shatter ? { glow, strokes, gradient, extrude, shatter } : null;
};

/** userSpaceOnUse end points of a two-stop gradient across the text box at `angle` degrees (0 = left to right). */
const gradientLine = (plan: LetterPlan, angle: number) => {
  const rad = (angle * Math.PI) / 180;
  const cx = plan.x + plan.w / 2;
  const cy = plan.y + plan.h / 2;
  const half = (Math.abs(plan.w * Math.cos(rad)) + Math.abs(plan.h * Math.sin(rad))) / 2;
  return { x1: r2(cx - half * Math.cos(rad)), y1: r2(cy - half * Math.sin(rad)), x2: r2(cx + half * Math.cos(rad)), y2: r2(cy + half * Math.sin(rad)) };
};

const gradientNode = (id: string, plan: LetterPlan, g: FillGradient): SvgNode => {
  const stop = (offset: number, c: string): SvgNode => {
    const p = paintOf(c)!;
    return { tag: 'stop', attrs: { offset, 'stop-color': p.color, 'stop-opacity': p.opacity < 1 ? p.opacity : undefined } };
  };
  return { tag: 'linearGradient', attrs: { id, gradientUnits: 'userSpaceOnUse', ...gradientLine(plan, g.angle) }, children: [stop(0, g.from), stop(1, g.to)] };
};

/** SFX 'shatter': a seeded crack across the text box; the two clip polygons above and below it (plan units). */
const shatterClips = (plan: LetterPlan): { top: string; bottom: string } => {
  const fs = plan.fontSize;
  const x0 = r2(plan.x - fs);
  const x1 = r2(plan.x + plan.w + fs);
  const y0 = r2(plan.y - fs);
  const y1 = r2(plan.y + plan.h + fs);
  let h = hashSeed(`${plan.lineId}|crack`) || 1;
  const next = () => {
    h = (Math.imul(h ^ (h >>> 13), 0x5bd1e995) + 0x9e3779b9) >>> 0;
    return h / 4294967296;
  };
  const mid = plan.y + plan.h / 2;
  const n = 6;
  const crack = Array.from({ length: n + 1 }, (_v, k) => ({ x: r2(x0 + ((x1 - x0) * k) / n), y: r2(mid + (next() - 0.5) * 0.45 * plan.h) }));
  const pts = (list: { x: number; y: number }[]) => list.map((q) => `${q.x} ${q.y}`).join('L');
  return {
    top: `M${x0} ${y0}L${x1} ${y0}L${pts([...crack].reverse())}Z`,
    bottom: `M${pts(crack)}L${x1} ${y1}L${x0} ${y1}Z`
  };
};

/** The text of one plan: shadow copy, then fill with optional outline (Pro steps: see the file note). */
function textNodes(plan: LetterPlan, idBase = 'lt'): SvgNode[] {
  const parsed = parseFont(plan.font);
  const fs = plan.fontSize;
  const rtl = plan.dir === 'rtl';
  const fill = paintOf(plan.style.textColor) ?? { color: INK, opacity: 1 };
  const strokeP = plan.style.textStroke ? paintOf(plan.style.textStroke.color) : null;
  const shadowP = plan.style.shadow ? paintOf(plan.style.shadow.color) : null;
  const pro = proTextOf(plan);
  const base: SvgNode['attrs'] = {
    'font-family': fontFamilyStack(plan.fontId),
    'font-size': r2(fs),
    'font-weight': parsed?.weight ?? 400,
    'font-style': parsed?.italic ? 'italic' : undefined,
    direction: rtl ? 'rtl' : undefined
  };
  const runNodes = (paint: SvgNode['attrs']): SvgNode[] =>
    plan.runs.map((run) => {
      if (run.scales?.length && run.xs?.length) {
        const gs = graphemes(run.text, plan.lang);
        return {
          tag: 'g',
          attrs: {},
          children: gs.map((g, i) => ({
            tag: 'text',
            attrs: {
              ...base,
              ...paint,
              'text-anchor': 'start',
              transform: `translate(${r2(run.xs![i] ?? run.x)} ${r2(run.ys?.[i] ?? run.y)})${run.rotates?.[i] ? ` rotate(${r2(run.rotates[i])})` : ''} scale(1 ${r2(run.scales![i] ?? 1)})`,
              x: 0,
              y: 0
            },
            text: g
          }))
        };
      }
      if (run.xs?.length) {
        const gs = graphemes(run.text, plan.lang);
        return {
          tag: 'text',
          attrs: { ...base, ...paint, 'text-anchor': 'start' },
          children: gs.map((g, i) => ({
            tag: 'tspan',
            attrs: { x: r2(run.xs![i] ?? run.x), y: r2(run.ys?.[i] ?? run.y), rotate: run.rotates?.[i] ? r2(run.rotates[i]) : undefined },
            text: g
          }))
        };
      }
      return { tag: 'text', attrs: { ...base, ...paint, x: r2(run.x), y: r2(run.y), 'text-anchor': anchorFor(plan.style.align, rtl) }, text: run.text };
    });
  let out: SvgNode[] = [];
  if (!pro) {
    if (shadowP && plan.style.shadow) {
      out.push({
        tag: 'g',
        attrs: { transform: `translate(${r2(plan.style.shadow.dx * fs)} ${r2(plan.style.shadow.dy * fs)})`, opacity: shadowP.opacity < 1 ? shadowP.opacity : undefined },
        children: runNodes({ fill: shadowP.color })
      });
    }
    const strokeW = plan.style.textStroke && strokeP ? r2(plan.style.textStroke.width * fs) : 0;
    out.push({
      tag: 'g',
      attrs: { 'fill-opacity': fill.opacity < 1 ? fill.opacity : undefined },
      children: runNodes({
        fill: fill.color,
        ...(strokeW > 0
          ? { stroke: strokeP!.color, 'stroke-opacity': strokeP!.opacity < 1 ? strokeP!.opacity : undefined, 'stroke-width': strokeW, 'stroke-linejoin': 'round', 'paint-order': 'stroke' }
          : {})
      })
    });
  } else {
    const defs: SvgNode[] = [];
    // 1. Glow: four round strokes, widest and faintest first (no filter: canvas draws the same strokes).
    if (pro.glow) {
      const steps = 4;
      for (let k = steps; k >= 1; k -= 1) {
        const width = r2(2 * pro.glow.size * fs * (k / steps));
        const a = Math.round(pro.glow.opacity * (0.18 + (0.5 * (steps - k)) / steps) * 1000) / 1000;
        out.push({
          tag: 'g',
          attrs: { 'data-pro': 'glow' },
          children: runNodes({ fill: pro.glow.color, 'fill-opacity': a, stroke: pro.glow.color, 'stroke-opacity': a, 'stroke-width': width, 'stroke-linejoin': 'round' })
        });
      }
    }
    // 2. Shadow, or the SFX 3D extrusion (six copies stepping out to the shadow offset).
    if (pro.extrude) {
      const steps = 6;
      for (let k = steps; k >= 1; k -= 1) {
        out.push({
          tag: 'g',
          attrs: { 'data-pro': 'extrude', transform: `translate(${r2((pro.extrude.dx * fs * k) / steps)} ${r2((pro.extrude.dy * fs * k) / steps)})`, 'fill-opacity': pro.extrude.opacity < 1 ? pro.extrude.opacity : undefined },
          children: runNodes({ fill: pro.extrude.color })
        });
      }
    } else if (shadowP && plan.style.shadow) {
      out.push({
        tag: 'g',
        attrs: { transform: `translate(${r2(plan.style.shadow.dx * fs)} ${r2(plan.style.shadow.dy * fs)})`, opacity: shadowP.opacity < 1 ? shadowP.opacity : undefined },
        children: runNodes({ fill: shadowP.color })
      });
    }
    // 3. Stacked outlines, outermost first: ring i is drawn at the summed width of rings 0..i.
    const stack = pro.strokes;
    if (stack) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const p = paintOf(stack[i].color)!;
        const width = r2(stack.slice(0, i + 1).reduce((n, x) => n + x.w, 0) * fs);
        out.push({
          tag: 'g',
          attrs: { 'data-pro': 'stroke' },
          children: runNodes({ fill: p.color, 'fill-opacity': p.opacity < 1 ? p.opacity : undefined, stroke: p.color, 'stroke-opacity': p.opacity < 1 ? p.opacity : undefined, 'stroke-width': width, 'stroke-linejoin': 'round' })
        });
      }
    }
    // 4. The fill: a gradient or the text colour, with the line's outline only when no stack supersedes it.
    let fillPaint: string = fill.color;
    if (pro.gradient) {
      const id = `${idBase}-grad`;
      defs.push(gradientNode(id, plan, pro.gradient));
      fillPaint = `url(#${id})`;
    }
    const strokeW = !stack && plan.style.textStroke && strokeP ? r2(plan.style.textStroke.width * fs) : 0;
    out.push({
      tag: 'g',
      attrs: { 'fill-opacity': !pro.gradient && fill.opacity < 1 ? fill.opacity : undefined },
      children: runNodes({
        fill: fillPaint,
        ...(strokeW > 0
          ? { stroke: strokeP!.color, 'stroke-opacity': strokeP!.opacity < 1 ? strokeP!.opacity : undefined, 'stroke-width': strokeW, 'stroke-linejoin': 'round', 'paint-order': 'stroke' }
          : {})
      })
    });
    // 5. Shatter: the whole stack twice, clipped above and below the crack and pulled apart.
    if (pro.shatter) {
      const clips = shatterClips(plan);
      const topId = `${idBase}-clip-a`;
      const bottomId = `${idBase}-clip-b`;
      defs.push({ tag: 'clipPath', attrs: { id: topId }, children: [{ tag: 'path', attrs: { d: clips.top } }] });
      defs.push({ tag: 'clipPath', attrs: { id: bottomId }, children: [{ tag: 'path', attrs: { d: clips.bottom } }] });
      const piece = (id: string, dx: number, dy: number): SvgNode => ({
        tag: 'g',
        attrs: { 'data-pro': 'shard', 'clip-path': `url(#${id})`, transform: `translate(${r2(dx * fs)} ${r2(dy * fs)})` },
        children: out
      });
      out = [piece(topId, -0.03, -0.04), piece(bottomId, 0.03, 0.04)];
    }
    if (defs.length) out.unshift({ tag: 'defs', attrs: {}, children: defs });
  }
  const skew = plan.transform?.skewX;
  if (skew) {
    const { cx, cy } = plan.transform!;
    return [{ tag: 'g', attrs: { transform: `translate(${r2(cx)} ${r2(cy)}) skewX(${r2(skew)}) translate(${r2(-cx)} ${r2(-cy)})` }, children: out }];
  }
  return out;
}

const groupsOf = (plans: LetterPlan[]): LetterPlan[][] => {
  const index = new Map(plans.map((p, i) => [p.lineId, i]));
  const parent = plans.map((_p, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  plans.forEach((p, i) => {
    const j = p.linkTo ? index.get(p.linkTo) : undefined;
    if (j !== undefined && j !== i) parent[find(i)] = find(j);
  });
  const by = new Map<number, LetterPlan[]>();
  plans.forEach((p, i) => {
    const r = find(i);
    by.set(r, [...(by.get(r) || []), p]);
  });
  // Draw a group where its LAST member (highest z) would be drawn.
  const last = (g: LetterPlan[]) => Math.max(...g.map((p) => index.get(p.lineId)!));
  return [...by.values()].sort((a, b) => last(a) - last(b));
};

/** The children of the lettering <svg> (one entry per z-ordered group). */
export function letteringNodes(plans: readonly LetterPlan[], opts: LetteringDrawOptions): SvgNode[] {
  const prefix = (opts.idPrefix || 'ls').replace(/[^a-zA-Z0-9_-]/g, '');
  const docLang = opts.docLang;
  const label = opts.labelFor ?? defaultLabel;
  const out: SvgNode[] = [];
  groupsOf([...plans]).forEach((group, gi) => {
    const members: Member[] = group.map((plan) => {
      const stroke = strokeFor(plan, opts.widthPx);
      return { plan, stroke, fill: paintOf(plan.style.fill), border: stroke ? paintOf(plan.style.border) : null, g: plan.geometry };
    });
    const byId = new Map(members.map((m) => [m.plan.lineId, m]));
    const necks: { d: string; owner: Member }[] = [];
    for (const m of members) {
      const other = m.plan.linkTo ? byId.get(m.plan.linkTo) : undefined;
      if (!other || !m.g.body || !other.g.body) continue;
      const a = m.plan;
      const b = other.plan;
      const d = linkNeck({ cx: a.x + a.w / 2, cy: a.y + a.h / 2, w: a.w, h: a.h }, { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h }, Math.max(m.stroke, 1));
      if (d) necks.push({ d, owner: m });
    }
    const art = artNodes(members, necks, `${prefix}-m${gi}`);
    const lineGroup = (m: Member, children: SvgNode[]): SvgNode => {
      const p = m.plan;
      const hidden = opts.visibleLineIds ? !opts.visibleLineIds.has(p.lineId) : false;
      const fallbackLang = docLang && p.lang && p.lang !== docLang ? p.lang : undefined;
      const extra: SvgNode[] = [];
      if (fallbackLang && opts.markFallbackLang) {
        const name = languageSpec(fallbackLang)?.english ?? fallbackLang;
        extra.push({
          tag: 'rect',
          attrs: { x: r2(p.x + 2), y: r2(p.y + 2), width: r2(Math.max(1, p.w - 4)), height: r2(Math.max(1, p.h - 4)), rx: 4, fill: 'none', 'stroke-dasharray': '1 3', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', style: 'stroke: var(--ds-muted, #8a8580)', 'data-fallback-marker': 'true' },
          children: [{ tag: 'title', attrs: {}, text: `Shown in ${name}: not translated yet` }]
        });
      }
      if (opts.selectedLineIds?.has(p.lineId)) {
        const o = planOutline(p);
        extra.push({
          tag: 'rect',
          attrs: { x: r2(o.x - 4), y: r2(o.y - 4), width: r2(o.w + 8), height: r2(o.h + 8), rx: 6, fill: 'none', stroke: ACCENT, 'stroke-width': 1.5, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke', 'data-selection': 'true' }
        });
      }
      return {
        tag: 'g',
        attrs: {
          'data-testid': 'balloon',
          'data-line-id': p.lineId,
          'data-kind': p.kind,
          'data-fallback-lang': fallbackLang,
          'data-overflow': p.overflow ? 'true' : undefined,
          lang: p.lang || undefined,
          dir: p.dir === 'rtl' ? 'rtl' : undefined,
          role: 'img',
          'aria-label': label(p),
          opacity: hidden ? 0 : undefined,
          class: 'ds-lettering-balloon'
        },
        children: [...children, ...extra]
      };
    };
    const texts = (m: Member, mi: number): SvgNode => {
      const rot = m.plan.transform?.rotate;
      const nodes = textNodes(m.plan, `${prefix}-t${gi}-${mi}`);
      return rot ? { tag: 'g', attrs: { transform: `rotate(${r2(rot)} ${r2(m.plan.transform!.cx)} ${r2(m.plan.transform!.cy)})` }, children: nodes } : { tag: 'g', attrs: {}, children: nodes };
    };
    if (members.length === 1) {
      out.push(lineGroup(members[0], [...art, texts(members[0], 0)]));
    } else {
      out.push({ tag: 'g', attrs: { 'data-link-group': members.map((m) => m.plan.lineId).join(' ') }, children: [...art, ...members.map((m, mi) => lineGroup(m, [texts(m, mi)]))] });
    }
  });
  return out;
}

// ── String renderer (print / static) ──────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ATTR_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/;
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

/** Serialize nodes (every attribute value and text escaped; unknown names dropped). */
export function nodesToMarkup(nodes: readonly SvgNode[]): string {
  const one = (n: SvgNode): string => {
    if (!TAG_NAME.test(n.tag)) return '';
    const attrs = Object.entries(n.attrs)
      .filter(([k, v]) => v !== undefined && v !== '' && ATTR_NAME.test(k) && !/^on/i.test(k))
      .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
      .join('');
    const inner = `${n.text !== undefined ? esc(n.text) : ''}${(n.children || []).map(one).join('')}`;
    return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
  };
  return nodes.map(one).join('');
}

/** A complete standalone <svg> for a page's plans (viewBox 1000 × 1000/aspect). */
export function letteringSvgMarkup(plans: readonly LetterPlan[], opts: LetteringDrawOptions & { width?: string; height?: string; ariaHidden?: boolean }): string {
  const H = r2(1000 / (opts.aspect > 0 ? opts.aspect : 2 / 3));
  const body = nodesToMarkup(letteringNodes(plans, opts));
  const size = `${opts.width ? ` width="${esc(opts.width)}"` : ''}${opts.height ? ` height="${esc(opts.height)}"` : ''}`;
  const a11y = opts.ariaHidden ? ' aria-hidden="true"' : ' role="group" aria-label="Lettering"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${H}" preserveAspectRatio="none"${size}${a11y}>${body}</svg>`;
}
