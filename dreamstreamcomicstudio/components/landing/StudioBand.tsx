/**
 * One studio on the home page (bridge §8 "studio bands"): a numbered label with the studio's mark, the h2
 * in the display face, a two-line lead, three points, the studio's actions and one motion moment. Bands
 * alternate plain and tinted, and the moment alternates sides on wide screens. The words come from
 * ./content.ts; the band only lays them out.
 */
import React from 'react';
import { StudioMark } from '../brand/StudioMark';
import type { StudioBandCopy } from './content';
import { COPY, LEAD, META, PAGE_COLUMN, SCROLL_TARGET, SECTION_H2 } from './landingStyles';
import { MomentFrame, type MomentId } from './MomentFrame';

export interface StudioBandProps {
  copy: StudioBandCopy;
  /** 1-based position: the label's "01". */
  index: number;
  moment: MomentId;
  /** A tinted band (the well, between hairlines). */
  tinted?: boolean;
  /** Moment on the left on wide screens. */
  flip?: boolean;
  /** The dark stage frame (Stream Studio). */
  stage?: boolean;
  /** The studio's links and buttons. */
  actions: React.ReactNode;
  /** One line under the actions: who can use it. */
  note?: string;
}

export function StudioBand({ copy, index, moment, tinted = false, flip = false, stage = false, actions, note }: StudioBandProps) {
  const headingId = `${copy.id}-title`;
  return (
    <section
      id={copy.id}
      aria-labelledby={headingId}
      className={`${SCROLL_TARGET} py-16 sm:py-24 ${tinted ? 'border-y border-ds-hairline bg-ds-well' : ''}`}
    >
      <div className={`${PAGE_COLUMN} grid items-center gap-10 lg:grid-cols-2 lg:gap-16`}>
        <div className={`ds-reveal min-w-0 ${flip ? 'lg:order-2' : ''}`}>
          <p className="ds-overline-display flex items-center gap-3">
            <span className="font-mono tabular-nums">{String(index).padStart(2, '0')}</span>
            <span aria-hidden="true" className="h-px w-6 bg-ds-ink/25" />
            <span className="inline-flex items-center gap-2">
              <StudioMark studio={copy.studio} size={14} className="text-ds-ink" />
              {copy.name}
            </span>
          </p>
          <h2 id={headingId} data-jump-target className={`mt-4 max-w-xl focus:outline-none ${SECTION_H2}`}>
            {copy.title}
          </h2>
          <p className={`mt-4 max-w-xl ${LEAD}`}>{copy.lead}</p>
          <ul className="mt-6 flex max-w-xl flex-col gap-3">
            {copy.points.map((point) => (
              <li key={point} className={`flex gap-3 ${COPY}`}>
                <span aria-hidden="true" className="mt-[11px] size-1.5 shrink-0 rounded-full bg-ds-ink" />
                <span className="min-w-0">{point}</span>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">{actions}</div>
          {note ? <p className={`mt-4 max-w-xl ${META}`}>{note}</p> : null}
        </div>
        <div className={`ds-reveal min-w-0 ${flip ? 'lg:order-1' : ''}`}>
          <MomentFrame moment={moment} studio={copy.studio} title={copy.momentTitle} label={copy.momentLabel} stage={stage} />
        </div>
      </div>
    </section>
  );
}
