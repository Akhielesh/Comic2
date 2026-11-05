/**
 * The public landing's type ramp and shapes (bridge §1.2 "Public type ramp", Atlas app/page.tsx), spelled
 * once on the tokens. Plain strings with no class merging, so the eager home page pulls no class-merge
 * library into the first-paint bundle: compose by choosing a constant, never by stacking two that set
 * the same property.
 */
import { FOCUS_RING, FONT_DISPLAY } from '../chat/studioDesign';

/** The page column (Atlas max-w-6xl with a 16 px phone gutter). */
export const PAGE_COLUMN = 'mx-auto w-full max-w-6xl px-4 sm:px-6';
/** The reading column (the questions list). */
export const PAGE_COLUMN_NARROW = 'mx-auto w-full max-w-4xl px-4 sm:px-6';

/** Hero h1: Atlas `text-5xl sm:text-7xl leading-[1.02] tracking-[-0.035em]`, a step smaller on a 320 px phone. */
export const HERO_TITLE = `${FONT_DISPLAY} text-[2.625rem] font-semibold leading-[1.02] tracking-[-0.035em] text-ds-ink medium:text-5xl sm:text-7xl`;
/** Section h2 (Atlas features page: `text-3xl sm:text-[2.5rem] leading-[1.1]`). */
export const SECTION_H2 = `${FONT_DISPLAY} text-3xl font-semibold leading-[1.1] tracking-[-0.03em] text-ds-ink sm:text-[2.5rem]`;
/** A smaller section h2 (the questions list). */
export const SECTION_H2_SMALL = `${FONT_DISPLAY} text-3xl font-semibold leading-[1.15] tracking-[-0.03em] text-ds-ink`;
/** Hero lead (Atlas `text-xl leading-8`; 17 px on a phone). */
export const HERO_LEAD = 'text-[17px] leading-7 text-ds-muted sm:text-xl sm:leading-8';
/** Section lead (Atlas subpage lead). */
export const LEAD = 'text-[17px] leading-7 text-ds-muted';
/** Body copy (Atlas `text-[15px] leading-7`). */
export const COPY = 'text-[15px] leading-7 text-ds-muted';
/** Meta line (Atlas `text-xs text-muted-foreground`). */
export const META = 'text-xs leading-5 text-ds-muted';

const PILL_BASE = `group inline-flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full border px-6 text-[15px] font-medium ds-press transition-[color,background-color,border-color,box-shadow] duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] ${FOCUS_RING}`;
/** The ink pill CTA (Atlas public CTA: `h-11 rounded-full px-7 text-[15px]`). */
export const PILL_PRIMARY = `${PILL_BASE} border-transparent bg-ds-accent-fill text-ds-on-accent shadow-[shadow:var(--ds-shadow-soft)] hover:bg-ds-accent-fill-hover`;
/** The outline pill CTA. */
export const PILL_OUTLINE = `${PILL_BASE} border-ds-hairline bg-ds-raised text-ds-ink hover:border-ds-ink/25 hover:bg-ds-hover`;
/** The arrow inside a pill: nudges right on hover, never under reduced motion. */
export const PILL_ARROW = 'size-4 transition-transform duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] motion-safe:can-hover:group-hover:translate-x-0.5';

/** An inline text link that draws its underline in (.ds-link), at least 44 px tall on touch. */
export const TEXT_LINK = `ds-link inline-flex items-center gap-1 text-sm font-medium text-ds-ink coarse:min-h-[var(--ds-density-touch)] ${FOCUS_RING}`;

/** A feature card: 16 px radius, hairline, the surface (Atlas `rounded-2xl border bg-card`). */
export const FEATURE_CARD = 'rounded-[var(--ds-radius-feature)] border border-ds-hairline bg-ds-surface';

/** The moment frame's shadow (Atlas's demo frame: a long soft drop). */
export const FRAME_SHADOW = 'shadow-[shadow:var(--ds-shadow-panel)]';

/** Sections a hero link jumps to sit below the sticky header (h-16). */
export const SCROLL_TARGET = 'scroll-mt-20';

/** The decorative layers behind the hero content. */
export const BACKDROP_LAYER = 'pointer-events-none absolute inset-0';

