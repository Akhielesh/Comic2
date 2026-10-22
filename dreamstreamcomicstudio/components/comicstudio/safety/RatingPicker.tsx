// Content rating picker (safety.md §10; owner P1-SAFETY): a three-option segmented control with
// the RATING_LABEL blurbs. Options above the ceiling (kids audience, account age) are disabled
// and say why. It sends `settings.rating` (the author's wish; the server clamps at use).
// Lives in StoryTab next to the audience (P2-BOARD mounts it).

import React, { useId } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import {
  CONTENT_RATINGS,
  PLATFORM_CEILING,
  RATING_LABEL,
  audienceCeiling,
  effectiveRating,
  isLittleKidsAudience,
  minRating,
  ratingRank,
  type ContentRating
} from '../../../shared/comic/safety';
import type { StudioController } from '../types';

export interface RatingPickerProps {
  /** The effective rating now (what the comic is drawn and checked at). */
  value: ContentRating;
  /** The highest rating allowed (min of the audience and account ceilings). */
  ceiling: ContentRating;
  /** Why the ceiling is below PG-13 ("Kids audience → up to PG"). */
  ceilingReason?: string;
  /** The author's own wish when it is above the ceiling (shown as "you chose PG-13"). */
  chosen?: ContentRating;
  onChange(rating: ContentRating): void;
  disabled?: boolean;
  compact?: boolean;
}

/** Derive the picker's props from the doc and the user's caps (pure; also used by tests). */
export const ratingPickerState = (doc: Pick<ComicDoc, 'brief' | 'format' | 'settings'>, caps?: Pick<StudioCaps, 'ratingCeiling'>) => {
  const account = caps?.ratingCeiling ?? PLATFORM_CEILING;
  const audience = audienceCeiling(doc);
  const ceiling = minRating(audience, account);
  const value = effectiveRating(doc, account).rating;
  let ceilingReason: string | undefined;
  if (ratingRank(ceiling) < ratingRank(PLATFORM_CEILING)) {
    if (ratingRank(account) < ratingRank(audience)) ceilingReason = `Your account → up to ${ceiling}`;
    else ceilingReason = `${isLittleKidsAudience(doc) ? 'Little-kids' : 'Kids'} audience → up to ${ceiling}`;
  }
  const chosen = doc.settings?.rating;
  return { value, ceiling, ceilingReason, ...(chosen && chosen !== value ? { chosen } : {}) };
};

export const RatingPicker: React.FC<RatingPickerProps> = ({ value, ceiling, ceilingReason, chosen, onChange, disabled, compact }) => {
  const groupId = useId();
  const hintId = useId();
  return (
    <div className="min-w-0">
      <div id={groupId} className="mb-1.5 text-[12px] font-medium text-[var(--ds-muted)]">
        Content rating
      </div>
      <div role="radiogroup" aria-labelledby={groupId} aria-describedby={ceilingReason ? hintId : undefined} className="grid min-w-0 grid-cols-3 gap-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-1">
        {CONTENT_RATINGS.map((r) => {
          const above = ratingRank(r) > ratingRank(ceiling);
          const selected = r === value;
          const off = disabled || above;
          return (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${r}: ${RATING_LABEL[r].blurb}${above && ceilingReason ? ` (${ceilingReason})` : ''}`}
              aria-disabled={off || undefined}
              disabled={off}
              title={above && ceilingReason ? ceilingReason : RATING_LABEL[r].blurb}
              onClick={() => {
                if (!off && !selected) onChange(r);
              }}
              className={[
                'flex min-h-[44px] min-w-0 flex-col items-center justify-center rounded-lg px-1.5 py-1 text-center transition-colors motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45',
                selected ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-sm' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]',
                off ? 'cursor-not-allowed opacity-45 hover:bg-transparent' : ''
              ].join(' ')}
            >
              <span className="text-[13px] font-semibold tabular-nums">{r}</span>
              {!compact && <span className="mt-0.5 line-clamp-2 break-words text-[10.5px] leading-tight">{RATING_LABEL[r].blurb.split(' — ')[0]}</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 break-words text-[12px] leading-snug text-[var(--ds-muted)]">
        {RATING_LABEL[value].blurb}.
        {ceilingReason && (
          <span id={hintId} className="block">
            {ceilingReason}
            {chosen && ratingRank(chosen) > ratingRank(ceiling) ? ` (you chose ${chosen}).` : '.'}
          </span>
        )}
      </p>
    </div>
  );
};

/** The picker wired to a studio: reads the doc + caps, writes `settings.rating` (undoable). */
export const StudioRatingPicker: React.FC<{ studio: StudioController; compact?: boolean }> = ({ studio, compact }) => {
  if (!studio.doc) return null;
  const state = ratingPickerState(studio.doc, studio.caps);
  return (
    <RatingPicker
      {...state}
      compact={compact}
      onChange={(rating) => {
        void studio.patch([{ op: 'settings', patch: { rating } }], { label: `Rating ${rating}` });
      }}
    />
  );
};

export default RatingPicker;
