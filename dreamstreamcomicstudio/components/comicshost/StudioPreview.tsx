// The comics landing's product proof: a still replica of the studio's own screen — the comic's title bar with
// the Easy / Pro switch, the Director's "Here's what I've got" plan card, and the board with drawn pages — built
// from the same primitives and recipes the studio uses (Card, Chip, StatusChip, SEGMENTED_*, OVERLINE), so the
// landing shows the product a visitor is about to use instead of a generic illustration.
//
// It is art, not UI: nothing in it is interactive (no buttons, no links), its headings are paragraphs, and the
// landing renders it inside an aria-hidden frame with a visible caption saying what it is. Ben-Day dots sit
// behind the pages (BENDAY: the colour layer's hero-art spot). The pages are ComicPageSpecimen: procedural, $0.

import React from 'react';
import { cn } from '../../lib/utils';
import { BENDAY, OVERLINE, RADIUS_ROUND, SEGMENTED_ACTIVE_FILL, SEGMENTED_ITEM, SEGMENTED_TRACK } from '../chat/studioDesign';
import { Card, CARD_TITLE } from '../ds/Card';
import { Chip } from '../ds/Chip';
import { StatusChip } from '../ds/StatusChip';
import { ComicPageSpecimen } from './ComicPageSpecimen';

const ROW = 'grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-t border-[var(--ds-hairline-soft)] py-2 first:border-t-0';
const VALUE = 'text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-ink)]';

/** The plan rows; the middle two only from `md` (the phone replica keeps Story, Look and Cast). */
const PLAN: ReadonlyArray<{ term: string; value: string; wide?: boolean }> = [
  { term: 'Story', value: 'A girl and her terrier chase a paper boat down the canal before the rain.' },
  { term: 'Format', value: 'Comic · 4 pages · 2:3', wide: true },
  { term: 'For', value: 'Everyone · cosy adventure', wide: true },
  { term: 'Look', value: 'Ligne claire · locked' }
];

const CAST = ['Mira', 'Biscuit'] as const;

const PageTile: React.FC<{ label: string; layout: 'opening' | 'chase'; className?: string }> = ({ label, layout, className }) => (
  <div className={cn('mx-auto flex w-full max-w-[15rem] flex-col gap-2', className)}>
    <div className="flex items-center justify-between text-[length:var(--ds-text-sm)] font-semibold text-[var(--ds-ink)]">
      <span>{label}</span>
      <StatusChip state="healthy">Drawn</StatusChip>
    </div>
    <ComicPageSpecimen look="ligne-claire" layout={layout} />
  </div>
);

export const StudioPreview: React.FC = () => (
  <div data-testid="studio-preview" className="text-left text-[var(--ds-ink)]">
    <div className="flex h-11 items-center gap-3 border-b border-[var(--ds-hairline-soft)] px-4">
      <p className="truncate text-[length:var(--ds-text-base)] font-semibold">The Paper Boat</p>
      <span className="flex-1" />
      {/* The studio's own switch, as drawn there: the item inks itself through aria-checked (SEGMENTED_ITEM), the
          selected one takes the pill's paint. Inside the aria-hidden frame, so nobody can reach it. */}
      <span role="radiogroup" className={SEGMENTED_TRACK}>
        <span role="radio" aria-checked="true" className={cn(SEGMENTED_ITEM, 'h-7', SEGMENTED_ACTIVE_FILL)}>
          Easy
        </span>
        <span role="radio" aria-checked="false" className={cn(SEGMENTED_ITEM, 'h-7')}>
          Pro
        </span>
      </span>
    </div>
    <div className="grid md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="border-b border-[var(--ds-hairline-soft)] p-4 medium:p-5 md:border-b-0 md:border-r">
        <Card className="gap-3 p-4">
          <p className={CARD_TITLE}>Here’s what I’ve got</p>
          <dl>
            {PLAN.map((row) => (
              <div key={row.term} className={cn(ROW, row.wide && 'hidden md:grid')}>
                <dt className={OVERLINE}>{row.term}</dt>
                <dd className={VALUE}>{row.value}</dd>
              </div>
            ))}
            <div className={ROW}>
              <dt className={OVERLINE}>Cast</dt>
              <dd className="flex flex-wrap gap-1.5">
                {CAST.map((name) => (
                  <Chip key={name} variant="outline" className="gap-1.5 py-0.5 pl-1">
                    <span aria-hidden className={cn(RADIUS_ROUND, 'size-[18px] shrink-0 bg-[var(--ds-well-strong)]')} />
                    <span className="text-[var(--ds-ink)]">{name}</span>
                  </Chip>
                ))}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
      <div className={cn(BENDAY, 'grid grid-cols-1 gap-4 bg-[var(--ds-well)] p-4 medium:grid-cols-2 medium:p-5')}>
        <PageTile label="Page 1" layout="opening" />
        <PageTile label="Page 2" layout="chase" className="hidden medium:flex" />
      </div>
    </div>
  </div>
);

export default StudioPreview;
