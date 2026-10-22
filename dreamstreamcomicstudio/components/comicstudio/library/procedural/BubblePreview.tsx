// Balloon swatch for pickers and the gallery (contract §13.3, assets.md §6; owner P1-LIBRARY).
// Drawn with the SAME geometry the lettering engine uses on pages (lettering/shapes
// bubbleGeometry: squircle, oval, cloud, burst, explosion, scroll, ribbon, … with their tails and
// thought trails), resolved over the classic preset for the line kind, so what a picker shows is
// what the page gets. "Aa" is set in the style's own font family. $0, deterministic.

import React from 'react';
import type { LineKind } from '../../../../shared/comic/doc';
import { LETTERING_PRESETS, type LetterStyle, type LetterStylePatch } from '../../../../shared/comic/lettering/style';
import { EXTRA_SHADE, borderDashArray, bubbleGeometry, resolveTailStyle, shadeColor } from '../../../../shared/comic/lettering/shapes';
import { fontFamilyStack } from '../../../../shared/comic/lettering/fonts';

export interface BubblePreviewProps {
  style: LetterStylePatch;
  kind: LineKind;
  /** Width in px (default 48). */
  size?: number;
}

const VB_W = 48;
const VB_H = 40;
const INK = '#111111';

/** The style a line of `kind` would get from `style` over the classic preset. */
export const resolvePreviewStyle = (style: LetterStylePatch, kind: LineKind): LetterStyle => {
  const classic = LETTERING_PRESETS.classic;
  return { ...classic.base, ...(classic.kinds[kind] || {}), ...(style || {}) } as LetterStyle;
};

const paint = (c: string | undefined, fallback: string): string => (!c || c === 'auto' ? fallback : c);
const fin = (n: number, d: number) => (Number.isFinite(n) ? n : d);

export const BubblePreview: React.FC<BubblePreviewProps> = ({ style, kind, size = 48 }) => {
  const s = resolvePreviewStyle(style, kind);
  const shape = s.shape;
  const fill = s.fill === 'none' ? 'none' : paint(s.fill, '#ffffff');
  const stroke = s.border === 'none' || s.borderStyle === 'none' ? 'none' : paint(s.border, INK);
  const strokeW = Math.max(0.6, Math.min(3.2, 1.4 * fin(s.borderWidth, 1)));
  const dash = borderDashArray(s.borderStyle, strokeW);
  const textColor = paint(s.textColor, INK);
  const width = Math.max(16, Math.round(fin(size, 48)));

  // Text box inside the swatch; the tail points down-left like a speaker below the balloon.
  const box = { x: 7, y: 6, w: 34, h: 18 };
  const tailStyle = resolveTailStyle(s.tail, kind, shape);
  const geo =
    shape === 'rect' || shape === 'none'
      ? null
      : bubbleGeometry(shape, box.w, box.h, {
          inset: { x: 3, y: 2.5 },
          seed: 7,
          tip: tailStyle === 'none' ? null : { x: 6, y: 28 },
          tail: tailStyle,
          tailWidth: fin(s.tailWidth, 1),
          stroke: strokeW,
          borderStyle: s.borderStyle
        });
  const common = {
    fill,
    stroke,
    strokeWidth: stroke === 'none' ? 0 : strokeW,
    strokeLinejoin: 'round' as const,
    ...(dash ? { strokeDasharray: dash.join(' ') } : {})
  };
  const textStroke = s.textStroke && kind === 'sfx' ? { stroke: s.textStroke.color, strokeWidth: Math.max(0.6, s.textStroke.width * 16), paintOrder: 'stroke' as const } : {};
  const sfx = kind === 'sfx' || shape === 'none';
  const sfxFill = sfx && (s.textColor === 'auto' || !s.textColor) ? '#ffd23f' : textColor;

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width={width} height={Math.round((width * VB_H) / VB_W)} aria-hidden focusable="false" overflow="visible">
      {shape === 'rect' && <rect x={box.x - 2} y={box.y + 1} width={box.w + 4} height={box.h - 2} rx={0.5} {...common} />}
      {geo && (
        <g transform={`translate(${box.x} ${box.y})`}>
          {geo.bubbles.map((c, i) => (
            <circle key={i} cx={c.cx} cy={c.cy} r={c.r} {...common} />
          ))}
          {geo.extras?.map((d, i) => (
            <path key={`x${i}`} d={d} {...common} fill={fill === 'none' ? 'none' : shadeColor(fill, EXTRA_SHADE[shape] ?? 0)} />
          ))}
          {/* Stroke under fill: a double-width outline of body + tail, then their fills on top, so the
              union reads as one balloon with no seam where the tail joins (as on the page). */}
          {stroke !== 'none' && (
            <g fill={fill === 'none' ? 'none' : fill} stroke={stroke} strokeWidth={fill === 'none' ? strokeW : strokeW * 2} strokeLinejoin="round" {...(dash ? { strokeDasharray: dash.map((d) => (fill === 'none' ? d : d * 2)).join(' ') } : {})}>
              {geo.tail && <path d={geo.tail} />}
              {geo.body && <path d={geo.body} />}
            </g>
          )}
          {fill !== 'none' && (
            <g fill={fill} stroke="none">
              {geo.tail && <path d={geo.tail} />}
              {geo.body && <path d={geo.body} />}
            </g>
          )}
          {geo.inner && <path d={geo.inner} fill="none" stroke={stroke === 'none' ? INK : stroke} strokeWidth={Math.max(0.5, strokeW * 0.6)} />}
        </g>
      )}
      <text
        x={VB_W / 2}
        y={sfx ? 22 : box.y + box.h / 2 + 0.5}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={sfx ? 17 : 10.5}
        fontWeight={s.weight || 700}
        fontStyle={s.italic ? 'italic' : undefined}
        fill={sfx ? sfxFill : textColor}
        fontFamily={fontFamilyStack(s.font)}
        transform={sfx ? `rotate(-8 ${VB_W / 2} 22)` : undefined}
        {...textStroke}
      >
        {sfx ? 'POW' : 'Aa'}
      </text>
    </svg>
  );
};

export default BubblePreview;
