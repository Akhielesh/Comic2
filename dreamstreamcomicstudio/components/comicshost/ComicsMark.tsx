import React from 'react';
import { cn } from '../../lib/utils';
import './comicsMark.css';

/** Match public/icons/comics-mark.svg, with the front page split out for the turn. */
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
    <path d="M15 13h18l4 4v20H15z" fill="none" style={{ stroke: 'var(--ds-canvas)' }} strokeWidth="2" strokeLinejoin="round" opacity=".55" />
    <g data-comics-mark-page="">
      <path d="M11 10h17l6 6v19H11z" style={{ fill: 'var(--ds-canvas)' }} />
      <path d="M27 10v7h7M15 20h15v11H15zM15 25h15M22 25v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </g>
  </svg>
);

export default ComicsMark;
