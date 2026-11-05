import React from 'react';
import { clsx } from 'clsx';
import { StudioMark } from './StudioMark';
import { STUDIO_MARKS, type Studio } from './studios';
import './studio-marks.css';

/**
 * Lockup sizes from the mark family sheet (mark / wordmark, px):
 *   header   32 / 20  site and app headers (the default)
 *   display  56 / 34  hero, splash, sign-in cards
 *   compact  28 / 17  tight headers, menus, the studio switcher
 * `endorsed` stacks a small DREAMSTREAM overline over the wordmark and grows the mark to the two
 * lines (header 40 / 22, as on the sheet). Other sizes: set --ds-logo-mark-size,
 * --ds-logo-text-size and --ds-logo-gap from a class or `style`.
 */
export type StudioLogoSize = 'header' | 'display' | 'compact';

export interface StudioLogoProps {
  studio: Studio;
  size?: StudioLogoSize;
  /** "DreamStream" overline above "Comic Studio" / "Stream Studio" (inside a studio). Ignored for
   *  the DreamStream house mark and for Atlas, which carry no endorsement. */
  endorsed?: boolean;
  /** false renders the mark alone, named for assistive tech (role="img", aria-label = studio name). */
  showLabel?: boolean;
  /** Loops the mark's motion moment (see StudioMark). */
  loading?: boolean;
  className?: string;
  markClassName?: string;
  labelClassName?: string;
  style?: React.CSSProperties;
}

/** Studios a DreamStream endorsement applies to. */
const ENDORSABLE: ReadonlySet<Studio> = new Set<Studio>(['comic', 'stream']);

/**
 * Mark plus wordmark in the AtlasLogo style: "<First> Studio", Space Grotesk 600 with tight tracking
 * and "Studio" at 55%. Styled only by studio-marks.css (no Tailwind), in currentColor, so it sits on
 * white, black and inverse surfaces alike. The visible text is the accessible name; the mark beside
 * it is decorative. Brand names are never machine-translated (translate="no").
 */
export function StudioLogo({
  studio,
  size = 'header',
  endorsed = false,
  showLabel = true,
  loading = false,
  className,
  markClassName,
  labelClassName,
  style,
}: StudioLogoProps) {
  const spec = STUDIO_MARKS[studio];
  const isEndorsed = showLabel && endorsed && ENDORSABLE.has(studio);
  const word = (
    <span className={clsx('ds-logo-word', labelClassName)}>
      {spec.first} <span className="ds-logo-word-muted">Studio</span>
    </span>
  );

  return (
    <span
      className={clsx('ds-logo', `ds-logo--${size}`, isEndorsed && 'ds-logo--endorsed', className)}
      style={style}
      translate="no"
    >
      <StudioMark studio={studio} loading={loading} className={markClassName} label={showLabel ? undefined : spec.name} />
      {showLabel ? (
        isEndorsed ? (
          <span className="ds-logo-stack">
            <span className="ds-logo-overline">DreamStream</span>
            {word}
          </span>
        ) : (
          word
        )
      ) : null}
    </span>
  );
}
