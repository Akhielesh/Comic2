/**
 * The app's loading screens: one look from the first HTML paint to the first page.
 *
 *   AppLoader      the boot screen. It is the static index.html splash (#app-splash) redrawn in React with
 *                  the same numbers (bootGeometry.ts): the DreamStream lockup and a thin indeterminate bar on
 *                  the page canvas, light or dark from the first frame. The bar picks up the splash's sweep
 *                  where it was (bootPhase.ts), so the hand-off from HTML to React does not show. Full screen,
 *                  for the moments before the shell exists: the auth check at boot, and leaving the comics
 *                  host for the main site.
 *   ContentLoader  a loader INSIDE the content area, under the site header: opening a project or a comic, or
 *                  a full-bleed studio whose code is still arriving. The destination studio's mark plays its
 *                  loading moment beside a shimmering label. The header never makes way for it.
 *
 * Both are live regions that say what is loading in words, hold still under reduced motion, and show the
 * "Waking up the studio…" line when the server is cold (WakeHint). Tokens and recipes only.
 */
import React, { useState } from 'react';
import { cn } from '../../lib/utils';
import { StudioLogo } from '../brand/StudioLogo';
import { StudioMark } from '../brand/StudioMark';
import type { Studio } from '../brand/studios';
import { BOOT } from './bootGeometry';
import { splashSweepDelay } from './bootPhase';
import { WakeHint } from './WakeHint';

/** Fades a fallback in after a beat, so a route that loads at once never flashes a loader. CSS only: under
 *  reduced motion (ds-motion.css) it is simply there; without the stylesheet it is visible. */
export const DEFER_IN = 'ds-fade-in [animation-delay:150ms]';

export const BOOT_LABEL = 'Loading DreamStream Studio…';

/** A loader fills the visible height: below the 4rem site header, or all of it on a view without one. The
 *  site footer links then stay below the fold until the page arrives, instead of jumping up mid-screen. */
export const FILL_BELOW_HEADER = 'min-h-[calc(var(--app-h,100dvh)-4rem)]';
export const FILL_VIEWPORT = 'min-h-[var(--app-h,100dvh)]';

export interface AppLoaderProps {
  /** Said aloud, and shown under the bar: e.g. "Opening DreamStream…". Without it the screen is the plain
   *  splash, and "Loading DreamStream Studio…" is read to assistive tech only. */
  label?: string;
}

const LOCKUP_STYLE = {
  '--ds-logo-mark-size': `${BOOT.markPx}px`,
  '--ds-logo-text-size': `${BOOT.wordPx}px`,
  '--ds-logo-gap': `${BOOT.lockupGapPx}px`
} as React.CSSProperties;

export function AppLoader({ label }: AppLoaderProps) {
  // Read once, before React commits and clears the splash out of #root.
  const [sweepDelay] = useState(splashSweepDelay);
  const caption = label?.trim() || undefined;
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="app-loader"
      className="fixed inset-0 flex flex-col items-center justify-center bg-ds-canvas px-4 text-ds-ink"
    >
      <div className="relative flex flex-col items-center" style={{ gap: BOOT.stackGapPx }}>
        {/* The brand is decoration here: the status is the words below (or the sr-only label). */}
        <div aria-hidden="true" data-slot="boot-lockup" className="flex">
          <StudioLogo studio="dreamstream" style={LOCKUP_STYLE} />
        </div>
        <div
          aria-hidden="true"
          data-slot="boot-track"
          className="relative overflow-hidden rounded-full bg-ds-ink/10"
          style={{ width: BOOT.trackWidthPx, height: BOOT.trackHeightPx }}
        >
          <span
            data-slot="boot-bar"
            className="absolute inset-y-0 left-0 rounded-full bg-current animate-[ds-progress-indeterminate_1300ms_var(--ds-ease)_infinite] motion-reduce:animate-none motion-reduce:translate-x-[75%]"
            style={{ width: `${BOOT.barShare * 100}%`, animationDelay: sweepDelay }}
          />
        </div>
        <div
          className="absolute left-1/2 flex w-[min(300px,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-1.5 text-center"
          style={{ top: `calc(100% + ${BOOT.captionGapPx}px)` }}
        >
          {caption ? <p className="m-0 text-[length:var(--ds-text-base)] font-medium leading-5 text-ds-muted">{caption}</p> : null}
          <WakeHint />
        </div>
      </div>
      {caption ? null : <span className="sr-only">{BOOT_LABEL}</span>}
    </div>
  );
}

export interface ContentLoaderProps {
  /** What is loading, in words: "Opening the comic…". Visible, and read aloud. */
  label: string;
  /** Whose mark plays (the destination studio's). */
  studio?: Studio;
  /** `content`: below the site header. `viewport`: a full-bleed view with no header (studio, reader). */
  fill?: 'content' | 'viewport';
  className?: string;
}

export function ContentLoader({ label, studio = 'dreamstream', fill = 'content', className }: ContentLoaderProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="content-loader"
      data-fill={fill}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-4 bg-ds-canvas px-4 py-16 text-center text-ds-ink',
        fill === 'viewport' ? FILL_VIEWPORT : FILL_BELOW_HEADER,
        DEFER_IN,
        className
      )}
    >
      <StudioMark studio={studio} loading size={36} />
      <p className="ds-shimmer-text m-0 text-[length:var(--ds-text-base)] font-medium leading-5">{label}</p>
      <WakeHint className="max-w-[300px]" />
    </div>
  );
}
