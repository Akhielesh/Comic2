// Balloon swatch for pickers and the gallery (contract §13.3; owner P1-LIBRARY).
// Wave 0 (P0-C) stub: a plain oval / box / burst in the style's fill and border colours.

import React from 'react';
import type { LineKind } from '../../../../shared/comic/doc';
import type { LetterStylePatch } from '../../../../shared/comic/lettering/style';

export interface BubblePreviewProps {
  style: LetterStylePatch;
  kind: LineKind;
  /** Width in px (default 48). */
  size?: number;
}

const BOXY = new Set(['rect', 'rounded_rect', 'scroll']);
const SPIKY = new Set(['burst', 'explosion', 'jagged']);

export const BubblePreview: React.FC<BubblePreviewProps> = ({ style, kind, size = 48 }) => {
  const shape = style.shape ?? (kind === 'caption' ? 'rect' : kind === 'shout' ? 'burst' : kind === 'sfx' ? 'none' : 'oval');
  const fill = style.fill ?? (kind === 'caption' ? '#fff6c8' : '#ffffff');
  const stroke = style.border ?? '#111111';
  const text = style.textColor ?? '#111111';
  const body =
    shape === 'none' ? null : BOXY.has(shape) ? (
      <rect x={4} y={8} width={40} height={24} rx={shape === 'rect' ? 1 : 6} fill={fill} stroke={stroke} strokeWidth={1.6} />
    ) : SPIKY.has(shape) ? (
      <path d="M24 3l4 7 8-4-1 8 9 1-6 6 6 6-9 1 1 8-8-4-4 7-4-7-8 4 1-8-9-1 6-6-6-6 9-1-1-8 8 4z" fill={fill} stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" />
    ) : (
      <ellipse cx={24} cy={20} rx={20} ry={13} fill={fill} stroke={stroke} strokeWidth={1.6} strokeDasharray={style.borderStyle === 'dashed' ? '3 2' : undefined} />
    );
  return (
    <svg viewBox="0 0 48 40" width={size} height={Math.round((size * 40) / 48)} aria-hidden focusable="false">
      {body}
      <text x={24} y={24} textAnchor="middle" fontSize={11} fontWeight={700} fill={text} fontFamily="system-ui, sans-serif">
        Aa
      </text>
    </svg>
  );
};

export default BubblePreview;
