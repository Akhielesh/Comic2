// Line-art empty states (contract §13.3; owner P1-LIBRARY): currentColor strokes and one
// #D97757 accent, correct in light and dark at $0. Wave 0 (P0-C) stub: one simple drawing
// per variant.

import React from 'react';

export type EmptyArtVariant = 'pages' | 'cast' | 'style' | 'reader' | 'studio' | 'media';

export interface EmptyArtProps {
  variant: EmptyArtVariant;
}

const ACCENT = '#D97757';

const shapes = (variant: EmptyArtVariant): React.ReactNode => {
  switch (variant) {
    case 'cast':
      return (
        <>
          <circle cx={30} cy={30} r={10} />
          <path d="M14 58c3-10 10-15 16-15s13 5 16 15" />
          <circle cx={58} cy={34} r={8} stroke={ACCENT} />
          <path d="M46 58c2-7 7-11 12-11s10 4 12 11" stroke={ACCENT} />
        </>
      );
    case 'style':
      return (
        <>
          <rect x={10} y={14} width={18} height={44} rx={4} />
          <rect x={31} y={14} width={18} height={44} rx={4} stroke={ACCENT} />
          <rect x={52} y={14} width={18} height={44} rx={4} />
        </>
      );
    case 'reader':
      return (
        <>
          <path d="M40 18c-8-5-18-6-28-4v40c10-2 20-1 28 4 8-5 18-6 28-4V14c-10-2-20-1-28 4z" />
          <path d="M40 18v40" stroke={ACCENT} />
        </>
      );
    case 'media':
      return (
        <>
          <rect x={10} y={16} width={60} height={40} rx={5} />
          <circle cx={28} cy={30} r={5} stroke={ACCENT} />
          <path d="M14 52l16-14 10 8 10-10 16 16" />
        </>
      );
    case 'studio':
      return (
        <>
          <rect x={10} y={12} width={26} height={48} rx={4} />
          <rect x={42} y={12} width={28} height={22} rx={4} stroke={ACCENT} />
          <rect x={42} y={38} width={28} height={22} rx={4} />
        </>
      );
    case 'pages':
    default:
      return (
        <>
          <rect x={18} y={8} width={44} height={56} rx={4} />
          <path d="M18 30h44M40 30v34" />
          <rect x={22} y={12} width={36} height={14} rx={2} stroke={ACCENT} />
        </>
      );
  }
};

export const EmptyArt: React.FC<EmptyArtProps> = ({ variant }) => (
  <svg
    viewBox="0 0 80 72"
    width={80}
    height={72}
    aria-hidden
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="text-[var(--ds-muted)]"
  >
    {shapes(variant)}
  </svg>
);

export default EmptyArt;
