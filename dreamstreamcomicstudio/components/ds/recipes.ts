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
 * The colour layer "Ink & Spark" (SPARK_*, MAKING_DOT, HUE_*, ART_*) is a DreamStream extension, not from Atlas: the
 * spark marks creation only and never sits on a price (tests/config/sparkGuard.test.ts). Its three hand-written CSS
 * classes (MAKING_SWEEP, MAKING_TEXT, BENDAY: styles/ds-motion.css) are imported from studioDesign directly.
 */

export {
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  ACCENT_TEXT,
  ART_GLOW,
  ART_PLACEHOLDER,
  CHIP,
  CHIP_VARIANT,
  DANGER_FILL,
  DANGER_FILL_HOVER,
  DENSITY,
  FIELD,
  FOCUS_RING,
  FOCUS_RING_FLUSH,
  FONT_DISPLAY,
  HEADER_GLASS,
  HUE_DOT,
  HUE_FILL,
  HUE_STROKE,
  hueSlot,
  LIFT,
  MAKING_DOT,
  ON_ACCENT_TEXT,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RADIUS_PILL,
  RISE_IN,
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
  TEXT_2XL,
  TEXT_3XL,
  TEXT_XL,
  TONE_CHIP,
  TONE_TEXT,
  Z
} from '../chat/studioDesign';
export type { Density, StatusState, StatusTone, ZLayer } from '../chat/studioDesign';

