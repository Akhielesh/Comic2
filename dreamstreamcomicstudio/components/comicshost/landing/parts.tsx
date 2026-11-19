// Small pieces every section of the comics landing shares: the section ids (in page order), the section head
// (eyebrow and a focusable h2), the framed figure that holds a picture or the clip with its visible caption, and the
// helpers that move a visitor to a section (scroll under the sticky header, then focus its heading).
import React from 'react';
import { cn } from '../../../lib/utils';
import { FONT_DISPLAY, OVERLINE_DISPLAY } from '../../chat/studioDesign';
import { prefersReducedMotion } from '../../ds/useReducedMotion';
import type { LandingMedia } from './landingMedia';
import { LandingClip } from './LandingClip';
import { LandingShot } from './LandingShot';

/** Every section of the landing, in page order (the hero is `top`). */
export const LANDING_SECTION_IDS = ['top', 'features', 'looks', 'how-it-works', 'models', 'pricing', 'read', 'register', 'faq'] as const;
export type LandingSectionId = (typeof LANDING_SECTION_IDS)[number];
export const isLandingSectionId = (id: string): id is LandingSectionId => (LANDING_SECTION_IDS as readonly string[]).includes(id);

const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');

/** Scroll a section under the sticky header (smooth unless reduced motion), then focus `focus` inside it (its heading). */
export const showSection = (id: string, focus = 'h2'): void => {
  if (typeof document === 'undefined') return;
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() });
  section.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
};

/** "Register your interest": the section, with the cursor in its first field when there is one. */
export const showRegister = (): void => showSection('register', 'input, textarea, h2');

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
