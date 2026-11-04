/**
 * The studioDesign recipes the DreamStream primitives (components/ds) are built from, in one import
 * (docs/design/design-system.md). components/chat/studioDesign.ts stays the single source — chat and
 * Comic Studio import it directly, and DS-10 turns it into a re-export of this file — so a primitive
 * never spells a token, radius, duration or z-index a recipe already names.
 *
 * One composition rule lives here too. `cn` (lib/utils.ts) is tailwind-merge 3, which reads class names
 * with Tailwind 4 meanings: there a bare `outline` is an outline WIDTH, so merging FOCUS_RING drops its
 * `focus-visible:outline` (the outline STYLE in this app's Tailwind 3) and the focus ring disappears.
 * A primitive therefore merges its own classes with `cn` and appends the focus recipe after the merge,
 * in a template (`${cn(BASE, VARIANT[variant], className)} ${FOCUS_RING}`, which the status-ink guard's
 * class-list reader follows), and its tests assert every recipe class survives.
 */

export {
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  ACCENT_TEXT,
  CHIP,
  CHIP_VARIANT,
  DANGER_FILL,
  DANGER_FILL_HOVER,
  DENSITY,
  FIELD,
  FOCUS_RING,
  FOCUS_RING_FLUSH,
  FONT_DISPLAY,
  ON_ACCENT_TEXT,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RADIUS_PILL,
  SECTION_BODY,
  SECTION_CARD,
  SECTION_DESCRIPTION,
  SECTION_HEADER,
  SECTION_ICON_TILE,
  SECTION_TITLE,
  SEGMENTED_ITEM,
  SEGMENTED_PILL,
  SEGMENTED_TRACK,
  SHADOW_SOFT,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_DOT,
  STATUS_EDGE,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_2XL,
  TEXT_3XL,
  TEXT_XL,
  TONE_CHIP,
  TONE_TEXT,
  Z
} from '../chat/studioDesign';
export type { Density, StatusState, StatusTone, ZLayer } from '../chat/studioDesign';

