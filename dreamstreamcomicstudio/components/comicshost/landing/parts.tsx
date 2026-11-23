// Small pieces every section of the comics landing shares: the section ids (in page order), the section head
// (eyebrow and a focusable h2), the framed figure that holds a picture or the clip with its visible caption, and the
// helpers that move a visitor to a section (scroll under the sticky header, then focus its heading or its first field).
import React from 'react';
import { cn } from '../../../lib/utils';
import { FONT_DISPLAY, OVERLINE_DISPLAY } from '../../chat/studioDesign';
import { prefersReducedMotion } from '../../ds/useReducedMotion';
import type { LandingMedia } from './landingMedia';
import { LandingClip } from './LandingClip';
import { LandingShot } from './LandingShot';

import type { LandingSectionId } from '../hostRouting';
export { LANDING_SECTION_IDS, isLandingSectionId, type LandingSectionId } from '../hostRouting';

const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');

/**
 * Scroll a section under the sticky header (smooth unless reduced motion, or `behavior`), then focus the first match of
 * each selector in `focus`, in that order of preference (by default its heading).
 */
export const showSection = (id: string, focus: string | readonly string[] = 'h2, h3', behavior: ScrollBehavior = scrollBehavior()): void => {
  if (typeof document === 'undefined') return;
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView?.({ block: 'start', behavior });
  const target = (typeof focus === 'string' ? [focus] : focus).map((sel) => section.querySelector<HTMLElement>(sel)).find(Boolean);
  target?.focus({ preventScroll: true });
};

/** Focus the signup action when arriving from the footer. */
export const showRegister = (): void => showSection('register', ['button', 'h2']);

/**
 * Arriving on a section link (…/#pricing): wait for the web fonts and two frames, so the page above has its final
 * height, then jump (no smooth scroll, which would aim at a moving target) and check once more a frame later that the
 * heading sits below the sticky header. Returns a cancel for the effect's cleanup. No timer: fonts and frames only.
 */
export const arriveAtSection = (id: LandingSectionId): (() => void) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  let live = true;
  const frame = (run: () => void): void => {
    const step = () => {
      if (live) run();
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(step);
    else step();
  };
  const go = () => showSection(id, 'h2, h3', 'auto');
  const settled = document.fonts?.ready ?? Promise.resolve();
  settled
    .catch(() => undefined)
    .then(() =>
      frame(() =>
        frame(() => {
          go();
          frame(() => {
            const section = document.getElementById(id);
            const margin = section ? parseFloat(getComputedStyle(section).scrollMarginTop) || 0 : 0;
            if (section && Math.abs(section.getBoundingClientRect().top - margin) > 2) go();
          });
        })
      )
    );
  return () => {
    live = false;
  };
};

export const SectionHead: React.FC<{ id: string; eyebrow?: string; title: string; children?: React.ReactNode }> = ({ id, eyebrow, title, children }) => (
  <div className="landing-head">
    {eyebrow ? <p className={OVERLINE_DISPLAY}>{eyebrow}</p> : null}
    <h2 id={id} tabIndex={-1} className={cn('landing-title focus:outline-none', FONT_DISPLAY)}>
      {title}
    </h2>
    {children}
  </div>
);

/** The frame and caption around one landing picture or clip. */
export const LandingFigure: React.FC<{ media: LandingMedia; className?: string }> = ({ media, className }) => (
  <figure className={cn('landing-figure', className)} style={{ maxWidth: media.width }}>
    <div className="landing-frame">{media.kind === 'clip' ? <LandingClip media={media} /> : <LandingShot media={media} />}</div>
    <figcaption className="landing-caption">{media.caption}</figcaption>
  </figure>
);
