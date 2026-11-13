/**
 * The studioDesign recipes the DreamStream primitives (components/ds) are built from, in one import
 * (docs/design/design-system.md). components/chat/studioDesign.ts stays the single source — chat and
 * Comic Studio import it directly, and DS-10 turns it into a re-export of this file — so a primitive
 * never spells a token, radius, duration or z-index a recipe already names.
 *
 * One composition rule lives here too. `cn` (lib/utils.ts) is tailwind-merge 3, which reads class names
 * with Tailwind 4 meanings; lib/utils.ts now configures it for this app's Tailwind 3.4 (a bare `outline` is
 * the outline STYLE), so cn(FOCUS_RING) keeps the ring (lib/utils.test.ts). The primitives still append
 * the focus recipe after the merge, in a template (`${cn(BASE, VARIANT[variant], className)} ${FOCUS_RING}`,
 * which the status-ink guard's class-list reader follows), so a caller's className can never cancel it,
 * and their tests assert every recipe class survives. Class strings never use the Tailwind 3 aliases
 * tailwind-merge cannot dedupe against their modern names (components/ds/cnAliases.test.ts).
 *
 * The colour layer "Ink & Spark" (SPARK_*, MAKING_*, HUE_*, ART_*, BENDAY) is a DreamStream extension, not from Atlas:
 * the spark marks creation only and never sits on a price (tests/config/sparkGuard.test.ts). MAKING_SWEEP, MAKING_TEXT
 * and BENDAY are hand-written CSS classes (styles/ds-motion.css), named in ds.hygiene.test.ts HAND_WRITTEN_CLASSES.
 * The colour layer "Ink, Paper & Colour" (CL-6: HUE_MARK / HUE_TEXT / HUE_SOFT_BG / HUE_SOLID, hueChip, chartHue and
 * CHART_HUE_ORDER, the chart ramps, the washes, ART_SOFT_BG / ART_EDGE, STUDIO_*) is re-exported here too. ART_SCOPE is
 * not: it is a hand-written class in index.css (`.ds-art-scope`), so it is imported from studioDesign until a
 * components/ds owner lists it in HAND_WRITTEN_CLASSES.
 */

export {
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  ACCENT_TEXT,
  ARROW_NUDGE,
  ART_EDGE,
  ART_GLOW,
  ART_PLACEHOLDER,
  ART_SOFT_BG,
  BENDAY,
  CHART_DIV_BG,
  CHART_DIV_FILL,
  CHART_HUE_ORDER,
  CHART_PLOT_BG,
  CHART_SEQ_BG,
  CHART_SEQ_FILL,
  chartHue,
  CHIP,
  CLIP_TEXT,
  CHIP_VARIANT,
  CTA_LG,
  DANGER_FILL,
  DANGER_FILL_HOVER,
  DENSITY,
  DIALOG_TITLE,
  DIALOG_TITLE_FROM_SM,
  DISPLAY_CARD_TITLE,
  DISPLAY_HERO,
  DISPLAY_SECTION,
  FIELD,
  FIELD_EMBEDDED,
  FIELD_GROUP,
  FOCUS_ITEM,
  FOCUS_RING,
  FOCUS_RING_FLUSH,
  FONT_DISPLAY,
  HEADER_GLASS,
  HUE_DOT,
  HUE_FILL,
  HUE_MARK,
  HUE_NAMES,
  HUE_SLOTS,
  HUE_SOFT_BG,
  HUE_SOLID,
  HUE_SOLID_TEXT_SLOTS,
  HUE_STROKE,
  HUE_TEXT,
  HUE_TEXT_SLOTS,
  hueChip,
  hueClass,
  hueIndex,
  INK_TILE,
  INVERSE_ACTION,
  INVERSE_ACTION_QUIET,
  LIFT,
  MAKING_DOT,
  MAKING_SWEEP,
  MAKING_TEXT,
  ON_ACCENT_TEXT,
  OVERLAY,
  OVERLINE,
  OVERLINE_DISPLAY,
  PRESS,
  PUBLIC_BODY,
  PUBLIC_LEAD,
  RADIUS_CONTROL,
  RADIUS_FEATURE,
  RADIUS_HERO,
  RADIUS_PANEL,
  RADIUS_PILL,
  RADIUS_ROUND,
  RISE_IN,
  SCRIM,
  SECTION_BODY,
  SECTION_CARD,
  SECTION_DESCRIPTION,
  SECTION_HEADER,
  SECTION_ICON_TILE,
  SECTION_TITLE,
  SEGMENTED_ACTIVE_FILL,
  SEGMENTED_ITEM,
  SEGMENTED_PILL,
  SEGMENTED_TRACK,
  SHADOW_HERO,
  SHADOW_SOFT,
  SPARK_FILL,
  SPARK_RING_ON_ART,
  SPARK_SOFT_BG,
  SPARK_TEXT,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_DOT,
  STATUS_EDGE,
  STATUS_INK,
  STATUS_SURFACE,
  STICKY_HEADER,
  STUDIO_MARK,
  STUDIO_SOFT_BG,
  TEXT_2XL,
  TEXT_3XL,
  TEXT_XL,
  TONE_CHIP,
  TONE_TEXT,
  TWO_LINE_TEXT,
  WASH_EMPTY,
  WASH_HERO,
  WRAP_TEXT,
  Z
} from '../chat/studioDesign';
export type { Density, HueSlot, StatusState, StatusTone, ZLayer } from '../chat/studioDesign';

