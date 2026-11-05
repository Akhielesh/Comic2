/**
 * Questions, answered (Atlas home FAQ): native <details> with the shared `.ds-disclosure` glide, so each
 * answer opens with no script, from the keyboard, and in find-in-page. The +/− glyph is two hairlines.
 */
import React from 'react';
import { FOCUS_RING, FONT_DISPLAY } from '../chat/studioDesign';
import { FAQ } from './content';
import { COPY, PAGE_COLUMN_NARROW, SCROLL_TARGET, SECTION_H2_SMALL } from './landingStyles';

const SUMMARY = `flex cursor-pointer list-none items-center justify-between gap-6 rounded-[var(--ds-radius-sm)] py-5 text-left [&::-webkit-details-marker]:hidden ${FOCUS_RING}`;
const GLYPH =
  'relative size-4 shrink-0 before:absolute before:left-0 before:top-1/2 before:h-px before:w-4 before:bg-ds-ink after:absolute after:left-1/2 after:top-0 after:h-4 after:w-px after:bg-ds-ink after:transition-transform after:duration-[var(--ds-motion-slow)] after:ease-[var(--ds-ease)] motion-reduce:after:transition-none group-open:after:scale-y-0';

export function HomeFaq() {
  return (
    <section id="home-faq" aria-labelledby="home-faq-title" className={`${SCROLL_TARGET} py-16 sm:py-24`}>
      <div className={PAGE_COLUMN_NARROW}>
        <h2 id="home-faq-title" data-jump-target className={`ds-reveal focus:outline-none ${SECTION_H2_SMALL}`}>
          Questions, answered
        </h2>
        <div className="mt-8 divide-y divide-ds-hairline border-y border-ds-hairline">
          {FAQ.map((entry) => (
            <details key={entry.q} className="ds-disclosure group py-1">
              <summary className={SUMMARY}>
                <span className={`${FONT_DISPLAY} text-lg font-medium tracking-tight text-ds-ink sm:text-xl`}>{entry.q}</span>
                <span aria-hidden="true" className={GLYPH} />
              </summary>
              <div className={`pb-6 pr-2 sm:pr-10 ${COPY}`}>
                <p>{entry.a}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
