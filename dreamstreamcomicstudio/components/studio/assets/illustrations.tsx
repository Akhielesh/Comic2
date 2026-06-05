// Lightweight, on-brand inline SVG illustrations for Code Studio empty/error states. They use
// `currentColor` so the parent controls the tone (theme-aware); the accent spark is brand.

import React from 'react';

type ArtProps = { className?: string };

/** Friendly "start something" scene — a dashed canvas with a plus + spark. */
export const EmptyProjectsArt: React.FC<ArtProps> = ({ className }) => (
  <svg className={className} viewBox="0 0 132 96" width="120" height="88" fill="none" aria-hidden>
    <rect x="12" y="16" width="108" height="64" rx="12" stroke="currentColor" strokeWidth="3" strokeDasharray="7 8" opacity="0.45" />
    <circle cx="66" cy="48" r="15" stroke="currentColor" strokeWidth="3" opacity="0.55" />
    <path d="M66 40v16M58 48h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    <path d="M104 16l2.6 7.4L114 26l-7.4 2.6L104 36l-2.6-7.4L94 26l7.4-2.6z" fill="#FACC15" />
    <circle cx="26" cy="74" r="2.5" fill="currentColor" opacity="0.5" />
    <circle cx="112" cy="66" r="2" fill="currentColor" opacity="0.4" />
  </svg>
);

/** A "took a wrong turn" scene for errors — a broken/unplugged tile. */
export const BuildErrorArt: React.FC<ArtProps> = ({ className }) => (
  <svg className={className} viewBox="0 0 132 96" width="120" height="88" fill="none" aria-hidden>
    <rect x="14" y="18" width="104" height="60" rx="12" stroke="currentColor" strokeWidth="3" opacity="0.4" />
    <path d="M40 70L92 26" stroke="#EF4444" strokeWidth="3" strokeLinecap="round" opacity="0.7" />
    <circle cx="66" cy="48" r="13" stroke="currentColor" strokeWidth="3" opacity="0.5" />
    <path d="M66 42v8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    <circle cx="66" cy="55" r="1.8" fill="currentColor" />
  </svg>
);
