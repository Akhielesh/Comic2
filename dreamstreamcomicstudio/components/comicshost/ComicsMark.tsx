// The Comic Studio mark, drawn in ink: the same 48 × 48 drawing as public/icons/comics-mark.svg (tile, page,
// balloon, three dots), coloured by the page's tokens instead of the logo's terracotta. The tile is the ink
// (currentColor, `text-[var(--ds-ink)]` unless a caller overrides it), the glyphs are the page colour
// (var(--ds-canvas)), so it inverts in dark and on an INVERSE_SURFACE panel like every other piece of ink.
// The coloured drawing stays only in public/icons/comics-mark.svg, the source of the app icons and the link
// preview (comics-edge/scripts/gen-comics-icons.mjs).

import React from 'react';
import { cn } from '../../lib/utils';

export const ComicsMark: React.FC<{ size?: number; className?: string; title?: string }> = ({ size = 40, className, title }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    className={cn('shrink-0 text-[var(--ds-ink)]', className)}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
    focusable="false"
    data-slot="comics-mark"
  >
    <rect x="2" y="2" width="44" height="44" rx="12" fill="currentColor" />
    <g fill="none" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" opacity=".6" style={{ stroke: 'var(--ds-canvas)' }}>
      <rect x="9.5" y="12" width="20" height="25" rx="2.5" />
      <path d="M9.5 23h20M18.5 23v14" />
    </g>
    <path
      d="M26.5 13h8.5a5 5 0 0 1 5 5v4.5a5 5 0 0 1-5 5h-3.4l-4.6 4.2v-4.2h-.5a5 5 0 0 1-5-5V18a5 5 0 0 1 5-5z"
      strokeWidth="2.2"
      strokeLinejoin="round"
      style={{ fill: 'var(--ds-canvas)', stroke: 'currentColor' }}
    />
    <g fill="currentColor">
      <circle cx="26.6" cy="20.3" r="1.5" />
      <circle cx="30.8" cy="20.3" r="1.5" />
      <circle cx="35" cy="20.3" r="1.5" />
    </g>
  </svg>
);

export default ComicsMark;
