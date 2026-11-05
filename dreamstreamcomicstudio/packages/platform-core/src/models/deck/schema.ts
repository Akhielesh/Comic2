/**
 * DeckSpec v1 in the schema DSL (plan §5.2): `Infer<typeof DeckSpecSchema>` IS the frozen contract type `DeckSpec`.
 * Rules the DSL cannot say are refinements, run by `checkDeckSpec` and by `applyDeckOps` on every slide an op
 * carries:
 * - a rect stays on the slide: `x + w ≤ 1` and `y + h ≤ 1` (`above-max` at `rect[2]` / `rect[3]`);
 * - only a `line` shape may be flat: every other element has a width and a height over `DECK_OVERLAP_EPSILON`
 *   (`below-min` at `rect[2]` / `rect[3]`), because text and tables are drawn down from the top of their box whatever
 *   its height, and a flat box would slip past `overlapCheck`;
 * - a chart series holds one value per category (`too-many` / `too-few` at `series[i].values`);
 * - slide ids are unique in a deck and element ids within a slide; a run names each mark at most once.
 */
import type { CheckError, CheckOptions, CheckResult } from '../../contract/schema.js';
import { MODEL_LIMITS } from '../../contract/schema.js';
import type { DeckOp, DeckSpec, Slide } from '../../contract/deck.js';
import { DECK_LIMITS } from '../../contract/deck.js';
import { s } from '../../schema/s.js';
import type { RefinePath } from '../common.js';
import {
  checkRefined,
  hexColorSchema,
  idSchema,
  idScope,
  insertIndexSchema,
  migrateV1,
  opBaseFields,
  refineError,
  repeatedMarks,
  runsOf,
  tableRowsOf,
  unitSchema,
} from '../common.js';

const D = DECK_LIMITS;

/** Floating-point slack for `x + w ≤ 1` (0.1 + 0.9 is 1.0000000000000002 in binary). */
export const DECK_RECT_EPSILON = 1e-9;

/**
 * The thinnest width or height that counts (a slide fraction: 0.002 px on a 1920 px slide). Overlaps thinner than this
 * do not count, so edges that merely touch (`[0, 0, 0.5, 1]` beside `[0.5, 0, 0.5, 1]`, even after 0.1 + 0.4 rounds
 * in binary) are not an overlap; and only a `line` shape may be this thin.
 */
export const DECK_OVERLAP_EPSILON = 1e-6;

/** A `line` shape: the only element that may have no width or no height. */
export const isLineShape = (el: { kind?: unknown; shape?: unknown }): boolean => el.kind === 'shape' && el.shape === 'line';

const elementBase = {
  id: idSchema,
  rect: s.tuple([unitSchema, unitSchema, unitSchema, unitSchema]),
  layer: s.enum(['background', 'content']),
};

/** One element: text, image, shape, table or chart, each on an explicit rect in slide fractions. */
export const DeckElementSchema = s.union('kind', [
  s.object({
    kind: s.literal('text'),
    ...elementBase,
    role: s.optional(s.enum(['title', 'subtitle', 'body', 'caption', 'quote'])),
    align: s.optional(s.enum(['left', 'center', 'right'])),
    fontSize: s.optional(s.number({ min: D.fontSizeMin, max: D.fontSizeMax })),
    paragraphs: s.array(
      s.object({
        runs: runsOf(D.runsPerParagraph),
        bullet: s.optional(s.bool()),
        indent: s.optional(s.int({ min: 0, max: MODEL_LIMITS.listIndentMax })),
      }),
      { max: D.paragraphs },
    ),
  }),
  s.object({
    kind: s.literal('image'),
    ...elementBase,
    ref: s.assetRef(),
    alt: s.text({ max: MODEL_LIMITS.alt }),
    fit: s.optional(s.enum(['contain', 'cover'])),
  }),
  s.object({
    kind: s.literal('shape'),
    ...elementBase,
    shape: s.enum(['rect', 'roundRect', 'ellipse', 'line']),
    fill: s.optional(hexColorSchema),
    stroke: s.optional(hexColorSchema),
  }),
  s.object({ kind: s.literal('table'), ...elementBase, header: s.optional(s.bool()), rows: tableRowsOf(D.tableRows, D.tableCols, D.runsPerCell) }),
  s.object({
    kind: s.literal('chart'),
    ...elementBase,
    chart: s.enum(['bar', 'line', 'pie']),
    title: s.optional(s.text({ max: D.chartTitle })),
    categories: s.array(s.text({ max: D.label }), { max: D.chartCategories }),
    series: s.array(s.object({ name: s.text({ max: D.label }), values: s.array(s.number(), { max: D.chartCategories }) }), { max: D.chartSeries }),
  }),
]);

export const SlideSchema = s.object({
  id: idSchema,
  layout: s.enum(['title', 'section', 'content', 'image-full', 'two-col', 'end']),
  notes: s.optional(s.text({ max: D.notes })),
  elements: s.array(DeckElementSchema, { max: D.elementsPerSlide }),
});

export const DeckThemeSchema = s.object({
  preset: s.enum(['light', 'dark', 'brand']),
  background: s.optional(hexColorSchema),
  text: s.optional(hexColorSchema),
  accent: s.optional(hexColorSchema),
});

export const DeckSpecSchema = s.object({
  v: s.literal(1),
  rev: s.optional(s.int({ min: 0 })),
  title: s.text({ max: D.title, singleLine: true }),
  size: s.enum(['16:9', '4:3']),
  theme: DeckThemeSchema,
  slides: s.array(SlideSchema, { max: D.slides }),
});

export const DeckOpSchema = s.union('op', [
  s.object({ op: s.literal('add_slide'), ...opBaseFields, index: insertIndexSchema, slide: SlideSchema }),
  s.object({ op: s.literal('update_slide'), ...opBaseFields, slideId: idSchema, slide: SlideSchema }),
  s.object({ op: s.literal('remove_slide'), ...opBaseFields, slideId: idSchema }),
  s.object({ op: s.literal('move_slide'), ...opBaseFields, slideId: idSchema, index: s.int({ min: 0 }) }),
  s.object({ op: s.literal('set_theme'), ...opBaseFields, theme: DeckThemeSchema }),
]);

/**
 * The rules of one (schema-checked) slide; `path` is where the slide sits: rects on the slide and (but for a line
 * shape) not flat, one chart value per category, unique element ids, each mark at most once.
 */
export const refineSlide = (slide: Slide, path: RefinePath): CheckError[] => {
  const errors: CheckError[] = [];
  const ids = idScope('element');
  slide.elements.forEach((el, i) => {
    const at = path.concat(['elements', i]);
    ids.add(el.id, at);
    const [x, y, w, h] = el.rect;
    const flatOk = isLineShape(el);
    if (!flatOk && w <= DECK_OVERLAP_EPSILON) errors.push(refineError(at.concat(['rect', 2]), 'below-min', 'must be more than 0: only a line shape may have no width'));
    if (!flatOk && h <= DECK_OVERLAP_EPSILON) errors.push(refineError(at.concat(['rect', 3]), 'below-min', 'must be more than 0: only a line shape may have no height'));
    if (x + w > 1 + DECK_RECT_EPSILON) errors.push(refineError(at.concat(['rect', 2]), 'above-max', 'x + w must be at most 1 (the element runs off the right edge)'));
    if (y + h > 1 + DECK_RECT_EPSILON) errors.push(refineError(at.concat(['rect', 3]), 'above-max', 'y + h must be at most 1 (the element runs off the bottom edge)'));
    if (el.kind === 'chart') {
      el.series.forEach((series, j) => {
        const n = el.categories.length;
        if (series.values.length !== n) {
          const code = series.values.length > n ? 'too-many' : 'too-few';
          errors.push(refineError(at.concat(['series', j, 'values']), code, `must hold one value per category (${n})`));
        }
      });
    }
  });
  return errors.concat(ids.errors, repeatedMarks(slide.elements, path.concat(['elements'])));
};

/** The refinements of a whole (schema-checked) deck; `path` is where the deck sits (`[]` at the root). */
export const refineDeckSpec = (deck: DeckSpec, path: RefinePath = []): CheckError[] => {
  let errors: CheckError[] = [];
  const ids = idScope('slide');
  deck.slides.forEach((slide, i) => {
    const at = path.concat(['slides', i]);
    ids.add(slide.id, at);
    errors = errors.concat(refineSlide(slide, at));
  });
  return errors.concat(ids.errors);
};

/** Op rules the DSL cannot say: an op's slide obeys `refineSlide` (so its element ids are unique), and `update_slide` keeps the slide's id. */
export const refineDeckOp = (op: DeckOp): CheckError[] => {
  if (op.op !== 'add_slide' && op.op !== 'update_slide') return [];
  const errors = refineSlide(op.slide, ['slide']);
  if (op.op === 'update_slide' && op.slide.id !== op.slideId) errors.unshift(refineError(['slide', 'id'], 'literal', `must be the slideId, ${JSON.stringify(op.slideId)}`));
  return errors;
};

/** A DeckSpec v1 with its refinements (a fresh copy on success). */
export const checkDeckSpec = (value: unknown, options?: CheckOptions): CheckResult<DeckSpec> =>
  checkRefined(DeckSpecSchema, value, (deck) => refineDeckSpec(deck), options);

/** One `DeckOp`, with the refinements `applyDeckOps` applies. */
export const checkDeckOp = (value: unknown): CheckResult<DeckOp> => checkRefined(DeckOpSchema, value, refineDeckOp);

/** One `Slide`, with its refinements. */
export const checkSlide = (value: unknown): CheckResult<Slide> => checkRefined(SlideSchema, value, (slide) => refineSlide(slide, []));

/** Read a stored DeckSpec of any version into v1 (v1 is the only version yet: validated and copied). */
export const migrateDeckSpec = (value: unknown): CheckResult<DeckSpec> => migrateV1(value, 'DeckSpec', (v) => checkDeckSpec(v));
