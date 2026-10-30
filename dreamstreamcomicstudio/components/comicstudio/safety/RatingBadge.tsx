// Content rating pill: "G · PG · PG-13" (contract §13.3; owner P1-SAFETY). Calm-studio tokens;
// the reason ("Kids audience → up to PG") is the tooltip and the accessible description.

import React, { useId } from 'react';
import { RATING_LABEL, isContentRating, type ContentRating } from '../../../shared/comic/safety';

export interface RatingBadgeProps {
  rating: ContentRating;
  reason?: string;
}

const TONE: Record<ContentRating, string> = {
  G: 'bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
  PG: 'bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
  'PG-13': 'bg-[#D97757]/10 text-[var(--ds-ink)]'
};

export const RatingBadge: React.FC<RatingBadgeProps> = ({ rating, reason }) => {
  const descId = useId();
  if (!isContentRating(rating)) return null;
  const blurb = RATING_LABEL[rating].blurb;
  const title = reason ? `${reason} · ${blurb}` : blurb;
  return (
    <span
      data-rating={rating}
      title={title}
      role="img"
      aria-label={`Rated ${rating}`}
      aria-describedby={descId}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--ds-hairline)] px-2 py-0.5 text-[11px] font-semibold leading-4 tracking-wide tabular-nums ${TONE[rating]}`}
    >
      {rating}
      <span id={descId} className="sr-only">
        {title}
      </span>
    </span>
  );
};

export default RatingBadge;
