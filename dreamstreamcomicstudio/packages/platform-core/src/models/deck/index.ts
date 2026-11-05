/**
 * `@dreamstream/platform-core/models/deck`: DeckSpec v1 (plan §5.2): the schema (`Infer` is the frozen contract type)
 * with its rect and chart refinements, `checkDeckSpec` / `migrateDeckSpec`, `applyDeckOps` with exact inverses, and
 * `overlapCheck` / `deckOverlaps` (export is refused while content elements overlap).
 */
export type {
  ChartSeries,
  ChartType,
  DeckAddSlideOp,
  DeckChart,
  DeckElement,
  DeckElementKind,
  DeckImage,
  DeckLayer,
  DeckMoveSlideOp,
  DeckOp,
  DeckOpName,
  DeckOpResult,
  DeckParagraph,
  DeckRect,
  DeckRemoveSlideOp,
  DeckSetThemeOp,
  DeckShape,
  DeckSize,
  DeckSpec,
  DeckTable,
  DeckText,
  DeckTheme,
  DeckUpdateSlideOp,
  OverlapPair,
  ShapeType,
  Slide,
  SlideLayout,
  TextRole,
} from '../../contract/deck.js';
export { DECK_LIMITS } from '../../contract/deck.js';
export type { ApplyOptions, InverseMeta } from '../common.js';
export { MODEL_OPS_MAX } from '../common.js';
export {
  DECK_RECT_EPSILON,
  DeckElementSchema,
  DeckOpSchema,
  DeckSpecSchema,
  DeckThemeSchema,
  SlideSchema,
  checkDeckOp,
  checkDeckSpec,
  checkSlide,
  migrateDeckSpec,
  refineDeckOp,
  refineDeckSpec,
  refineSlide,
} from './schema.js';
export type { SlideOverlaps } from './ops.js';
export { DECK_OVERLAP_EPSILON, applyDeckOps, deckOverlaps, invertDeckOp, invertDeckOps, overlapCheck } from './ops.js';
