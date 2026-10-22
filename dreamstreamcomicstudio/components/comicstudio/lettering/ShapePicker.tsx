// Bubble shape + tail pickers (lettering.md §5, §7.3–7.4). Every icon is drawn by the shared vector
// library itself (bubbleGeometry), so what you pick is exactly what the balloon becomes. Easy shows six
// friendly shapes; Pro shows the whole library and every tail style.

import React, { useMemo } from 'react';
import { bubbleGeometry, borderDashArray } from '../../../shared/comic/lettering/shapes';
import { BUBBLE_SHAPES, TAIL_STYLES, type BorderStyle, type BubbleShape, type TailStyle } from '../../../shared/comic/lettering/style';
import { EASY_SHAPES, type EasyShapeId } from './styleOps';
import { cx } from '../board/ui';

export const SHAPE_LABEL: Record<BubbleShape, string> = {
  squircle: 'Speech',
  oval: 'Oval',
  rounded_rect: 'Rounded box',
  rect: 'Box',
  notched: 'Notched box',
  scroll: 'Scroll',
  ribbon: 'Ribbon',
  cloud: 'Cloud',
  burst: 'Burst',
  explosion: 'Explosion',
  jagged: 'Jagged',
  wavy: 'Wavy',
  electronic: 'Electronic',
  none: 'No bubble'
};
export const TAIL_LABEL: Record<TailStyle, string> = {
  auto: 'Auto',
  curved: 'Curved',
  straight: 'Straight',
  pointer: 'Pointer',
  bubbles: 'Bubbles',
  lightning: 'Lightning',
  none: 'No tail'
};

const W = 64;
const Hh = 34;
const TIP = { x: 20, y: 56 };

/** A shape icon drawn with the real geometry (balloon-local units, fixed seed). */
export const ShapeIcon: React.FC<{ shape: BubbleShape; tail?: TailStyle; border?: BorderStyle; size?: number; className?: string }> = ({
  shape,
  tail = 'auto',
  border = 'solid',
  size = 44,
  className
}) => {
  const g = useMemo(
    () => bubbleGeometry(shape, W, Hh, { inset: { x: 7, y: 6 }, seed: 11, tip: tail === 'none' ? null : TIP, tail, tailWidth: 1, stroke: 1.6, borderStyle: border }),
    [shape, tail, border]
  );
  const dash = borderDashArray(border, 1.6)?.join(' ');
  const stroke = 'currentColor';
  return (
    <svg viewBox="-18 -16 100 82" width={size} height={(size * 82) / 100} aria-hidden focusable="false" className={className}>
      {(g.extras || []).map((d, i) => (
        <path key={`e${i}`} d={d} fill="var(--ds-surface-soft, #f4f1ec)" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" />
      ))}
      {g.tail && <path d={g.tail} fill="#ffffff" stroke={stroke} strokeWidth={3.2} strokeLinejoin="round" strokeDasharray={dash} />}
      {g.bubbles.map((c, i) => (
        <circle key={`b${i}`} cx={c.cx} cy={c.cy} r={c.r} fill="#ffffff" stroke={stroke} strokeWidth={1.6} />
      ))}
      {g.body ? (
        <path d={g.body} fill="#ffffff" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={dash} />
      ) : (
        <text x={W / 2} y={Hh / 2 + 6} textAnchor="middle" fontSize={16} fontWeight={800} fill={stroke}>
          Aa
        </text>
      )}
      {g.tail && <path d={g.tail} fill="#ffffff" stroke="none" />}
      {g.inner && <path d={g.inner} fill="none" stroke={stroke} strokeWidth={1.2} />}
      {g.body && (
        <g fill={stroke} opacity={0.55}>
          <rect x={14} y={12} width={36} height={3} rx={1.5} />
          <rect x={18} y={19} width={28} height={3} rx={1.5} />
        </g>
      )}
    </svg>
  );
};

const TILE =
  'tap-target flex min-w-0 flex-col items-center gap-0.5 rounded-xl border px-1 py-1 text-[10.5px] leading-tight transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50';

/** Pro: the whole bubble library. */
export const ShapePicker: React.FC<{ value: BubbleShape | undefined; onChange(shape: BubbleShape): void; label?: string }> = ({ value, onChange, label = 'Bubble shape' }) => (
  <div role="radiogroup" aria-label={label} className="grid grid-cols-4 gap-1.5 text-[var(--ds-ink)]">
    {BUBBLE_SHAPES.map((s) => (
      <button
        key={s}
        type="button"
        role="radio"
        aria-checked={value === s}
        title={SHAPE_LABEL[s]}
        onClick={() => onChange(s)}
        className={cx(TILE, value === s ? 'border-[#D97757]/60 bg-[#D97757]/10' : 'border-transparent hover:bg-[var(--ds-hover)]')}
      >
        <ShapeIcon shape={s} tail="none" size={40} />
        <span className="w-full truncate text-center text-[var(--ds-muted)]">{SHAPE_LABEL[s]}</span>
      </button>
    ))}
  </div>
);

/** Pro: tail styles. */
export const TailPicker: React.FC<{ value: TailStyle | undefined; shape?: BubbleShape; onChange(tail: TailStyle): void }> = ({ value, shape = 'squircle', onChange }) => (
  <div role="radiogroup" aria-label="Tail style" className="grid grid-cols-4 gap-1.5 text-[var(--ds-ink)]">
    {TAIL_STYLES.map((t) => (
      <button
        key={t}
        type="button"
        role="radio"
        aria-checked={value === t}
        title={TAIL_LABEL[t]}
        onClick={() => onChange(t)}
        className={cx(TILE, value === t ? 'border-[#D97757]/60 bg-[#D97757]/10' : 'border-transparent hover:bg-[var(--ds-hover)]')}
      >
        <ShapeIcon shape={shape === 'none' ? 'squircle' : shape} tail={t} size={40} />
        <span className="w-full truncate text-center text-[var(--ds-muted)]">{TAIL_LABEL[t]}</span>
      </button>
    ))}
  </div>
);

const EASY_ICON: Record<EasyShapeId, { shape: BubbleShape; tail: TailStyle; border?: BorderStyle }> = {
  speech: { shape: 'squircle', tail: 'curved' },
  thought: { shape: 'cloud', tail: 'bubbles' },
  shout: { shape: 'burst', tail: 'straight' },
  whisper: { shape: 'squircle', tail: 'curved', border: 'dashed' },
  caption: { shape: 'rect', tail: 'none' },
  robot: { shape: 'electronic', tail: 'lightning' }
};

/** Easy: six friendly shapes (semantic ones change the line's kind). */
export const EasyShapePicker: React.FC<{ value: EasyShapeId | undefined; onChange(id: EasyShapeId): void }> = ({ value, onChange }) => (
  <div role="radiogroup" aria-label="Balloon type" className="grid grid-cols-3 gap-1.5 text-[var(--ds-ink)]">
    {EASY_SHAPES.map((s) => (
      <button
        key={s.id}
        type="button"
        role="radio"
        aria-checked={value === s.id}
        title={s.hint}
        onClick={() => onChange(s.id)}
        className={cx(TILE, value === s.id ? 'border-[#D97757]/60 bg-[#D97757]/10' : 'border-transparent hover:bg-[var(--ds-hover)]')}
      >
        <ShapeIcon {...EASY_ICON[s.id]} size={40} />
        <span className="w-full truncate text-center text-[var(--ds-muted)]">{s.label}</span>
      </button>
    ))}
  </div>
);

export default ShapePicker;
