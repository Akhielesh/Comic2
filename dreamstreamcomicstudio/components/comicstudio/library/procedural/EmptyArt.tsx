// Line-art empty states (contract §13.3, assets.md §6; owner P1-LIBRARY): calm editorial spot
// drawings in currentColor strokes with soft currentColor washes and one terracotta (#D97757,
// the theme-invariant accent) detail, so each reads well in light and dark themes at $0.
// Tier 2 under the library's AI empty-state art (LibraryImage falls back to it).

import React from 'react';

export type EmptyArtVariant = 'pages' | 'cast' | 'style' | 'reader' | 'studio' | 'media';

export interface EmptyArtProps {
  variant: EmptyArtVariant;
}

const ACCENT = '#D97757';
const WASH = { fill: 'currentColor', fillOpacity: 0.07, stroke: 'none' } as const;
const SOFT = { strokeOpacity: 0.45 } as const;

const shapes = (variant: EmptyArtVariant): React.ReactNode => {
  switch (variant) {
    case 'cast':
      // Three figures on a model-sheet grid, the middle one picked out in the accent.
      return (
        <>
          <path d="M8 62h64M8 52h64" {...SOFT} strokeDasharray="2 3" />
          <path d="M20 14v48M40 14v48M60 14v48" {...SOFT} strokeDasharray="2 3" />
          <ellipse cx={20} cy={60} rx={8} ry={1.6} {...WASH} />
          <ellipse cx={40} cy={60} rx={9} ry={1.8} {...WASH} />
          <ellipse cx={60} cy={60} rx={8} ry={1.6} {...WASH} />
          <circle cx={20} cy={30} r={5} />
          <path d="M13 59c.5-9 3.1-15 7-15s6.5 6 7 15" />
          <circle cx={40} cy={26} r={6} stroke={ACCENT} />
          <path d="M31.5 59c.6-11 3.8-18 8.5-18s7.9 7 8.5 18" stroke={ACCENT} />
          <path d="M40 41v-3" stroke={ACCENT} />
          <circle cx={60} cy={32} r={4.5} />
          <path d="M54 59c.4-8 2.7-13 6-13s5.6 5 6 13" />
          <path d="M66 14l6-6M68.5 10.5l2 2" {...SOFT} />
        </>
      );
    case 'style':
      // Four swatches, a round brush and a fine pen on paper.
      return (
        <>
          <rect x={8} y={10} width={64} height={52} rx={5} {...WASH} />
          <rect x={8} y={10} width={64} height={52} rx={5} {...SOFT} />
          <rect x={15} y={17} width={13} height={13} rx={3} />
          <rect x={33} y={17} width={13} height={13} rx={3} fill={ACCENT} fillOpacity={0.85} stroke={ACCENT} />
          <rect x={15} y={35} width={13} height={13} rx={3} fill="currentColor" fillOpacity={0.18} />
          <rect x={33} y={35} width={13} height={13} rx={3} fill="currentColor" fillOpacity={0.35} />
          <path d="M55 48l10-28c.6-1.6 2.9-1 2.6.6L62 49" />
          <path d="M53.5 52c0-2.4 1.6-4 3.6-4.3 2-.2 3.6 1.4 3.4 3.4-.4 3.6-4.6 5.2-7 3.3" fill="currentColor" fillOpacity={0.25} />
          <path d="M18 56h26" {...SOFT} />
        </>
      );
    case 'reader':
      // An open book with a ribbon bookmark.
      return (
        <>
          <path d="M40 20c-8-5-18-6-29-4v42c11-2 21-1 29 4 8-5 18-6 29-4V16c-11-2-21-1-29 4z" {...WASH} />
          <path d="M40 20c-8-5-18-6-29-4v42c11-2 21-1 29 4 8-5 18-6 29-4V16c-11-2-21-1-29 4z" />
          <path d="M40 20v42" />
          <path d="M17 27c6-1 12-.6 17 1.4M17 34c6-1 12-.6 17 1.4M17 41c6-1 12-.6 17 1.4" {...SOFT} />
          <path d="M46 28.4c5-2 11-2.4 17-1.4M46 35.4c5-2 11-2.4 17-1.4" {...SOFT} />
          <path d="M55 16.4V38l3.5-3 3.5 3V15.6" stroke={ACCENT} fill={ACCENT} fillOpacity={0.15} />
        </>
      );
    case 'media':
      // A stack of frames: a picture card over two cards behind it.
      return (
        <>
          <rect x={18} y={8} width={50} height={34} rx={4} {...SOFT} />
          <rect x={14} y={13} width={52} height={36} rx={4} {...SOFT} />
          <rect x={10} y={19} width={56} height={40} rx={5} {...WASH} />
          <rect x={10} y={19} width={56} height={40} rx={5} />
          <circle cx={26} cy={32} r={5} stroke={ACCENT} />
          <path d="M14 54l15-13 9 7 9-9 15 15" />
          <path d="M60 64l8 0M64 60v8" stroke={ACCENT} />
        </>
      );
    case 'studio':
      // A drafting desk from above: blank page with faint panels, a pencil, tea, an empty balloon.
      return (
        <>
          <rect x={8} y={14} width={40} height={52} rx={3} {...WASH} />
          <rect x={8} y={14} width={40} height={52} rx={3} />
          <path d="M13 19h30v14H13zM13 37h14v24H13zM31 37h12v24H31z" {...SOFT} strokeDasharray="2.5 2.5" />
          <path d="M56 22c0-5.5 5.4-9 12-9s12 3.5 12 9-5.4 9-12 9c-1.6 0-3-.2-4.4-.6L58 34l1.6-5.2C57.4 27 56 24.6 56 22z" stroke={ACCENT} fill={ACCENT} fillOpacity={0.12} />
          <path d="M55 66l15-15 3 3-15 15-4 1z" />
          <path d="M67 54l3 3" />
          <path d="M58 40h9v4.5c0 2.5-2 4.5-4.5 4.5S58 47 58 44.5z" {...SOFT} />
          <path d="M67 41.5h1.2a1.8 1.8 0 0 1 0 3.6H66.6" {...SOFT} />
        </>
      );
    case 'pages':
    default:
      // A page of panel roughs, the first panel being inked.
      return (
        <>
          <rect x={16} y={6} width={48} height={60} rx={4} {...WASH} />
          <rect x={16} y={6} width={48} height={60} rx={4} />
          <rect x={21} y={11} width={38} height={16} rx={2} stroke={ACCENT} />
          <path d="M25 23c4-6 8-6 11-2 3-3 6-3 9 0" stroke={ACCENT} />
          <rect x={21} y={31} width={18} height={30} rx={2} {...SOFT} />
          <rect x={43} y={31} width={16} height={14} rx={2} {...SOFT} />
          <rect x={43} y={48} width={16} height={13} rx={2} {...SOFT} />
          <path d="M66 52l7-7 2 2-7 7-3 1z" />
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
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="max-w-full text-[var(--ds-muted)]"
    data-empty-art={variant}
  >
    {shapes(variant)}
  </svg>
);

export default EmptyArt;
