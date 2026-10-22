// Header slot positions (contract §13.2 header-slot registry). Built-ins sit at quality 100, spend 200,
// Read 300 and the ⋯ menu 900 (features.ts BUILTIN_HEADER_ORDER). Feature slots use these numbers so
// the header stays in one predictable order on every form factor.
//
// Slots with order ≥ HEADER_BANNER_MIN_ORDER do not render inside the header row: the shell renders
// them full-width in a banner strip directly UNDER the header (one calm line, e.g. a model-status
// banner from the reliability feature). They receive `compact` like any slot and must render null
// when there is nothing to say.

export const HEADER_BANNER_MIN_ORDER = 1000;

export const HEADER_SLOT_ORDER = {
  /** P1-PUBLISH Share button. */
  share: 10,
  /** Reserved: a model-status pill / health dot (reliability.md ModelHealthDot) — compact-safe (≤ 44 px). */
  status: 20,
  /** Easy / Pro view toggle (this package). */
  mode: 60,
  /** "Saved by software" chip (this package), right after the spend chip. */
  savings: 210,
  /** Reserved: the full-width model-status banner under the header (reliability.md ModelStatusBanner). */
  statusBanner: HEADER_BANNER_MIN_ORDER
} as const;
