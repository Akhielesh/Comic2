// Content rating pill: "G · PG · PG-13" (contract §13.3; owner P1-SAFETY). Calm-studio tokens;
// the reason ("Kids audience → up to PG") is the tooltip and the accessible description.
//
// `onArt` (redesign plan §4, DS-R1): the pill drawn over a cover (Discover's public cards, the Library's grid)
// is OPAQUE — the raised surface with the ink, and PG-13 the accent tint mixed into that surface — so it reads
// on any art, light or dark (the TONE_CHIP_ON_ART idea). Off art, PG-13 keeps its soft accent tint, now the
// token (ACCENT_SOFT_BG) instead of the old terracotta literal. No spark, ever: the reader shows this badge.

import React, { useId } from 'react';
import { RATING_LABEL, isContentRating, type ContentRating } from '../../../shared/comic/safety';
import { ACCENT_SOFT_BG } from '../../chat/studioDesign';

export interface RatingBadgeProps {
  rating: ContentRating;
  reason?: string;
  /** Drawn over art (a cover): an opaque pill, readable on any picture. */
  onArt?: boolean;
}

const TONE: Record<ContentRating, string> = {
  G: 'bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
  PG: 'bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
  'PG-13': `${ACCENT_SOFT_BG} text-[var(--ds-ink)]`
};

/** Over art: opaque surfaces only (no translucent tint for the picture to show through). */
export const RATING_TONE_ON_ART: Record<ContentRating, string> = {
  G: 'bg-[var(--ds-raised)] text-[var(--ds-ink)]',
  PG: 'bg-[var(--ds-raised)] text-[var(--ds-ink)]',
  'PG-13': 'bg-[color:color-mix(in_srgb,var(--ds-accent)_12%,var(--ds-raised))] text-[var(--ds-ink)]'
};

export const RatingBadge: React.FC<RatingBadgeProps> = ({ rating, reason, onArt = false }) => {
  const descId = useId();
  if (!isContentRating(rating)) return null;
  const blurb = RATING_LABEL[rating].blurb;
  const title = reason ? `${reason} · ${blurb}` : blurb;
  return (
    <span
      data-rating={rating}
      data-on-art={onArt ? '' : undefined}
      title={title}
      role="img"
      aria-label={`Rated ${rating}`}
      aria-describedby={descId}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--ds-hairline)] px-2 py-0.5 text-[11px] font-semibold leading-4 tracking-wide tabular-nums ${onArt ? RATING_TONE_ON_ART[rating] : TONE[rating]}`}
    >
      {rating}
      <span id={descId} className="sr-only">
        {title}
      </span>
    </span>
  );
};

export default RatingBadge;
