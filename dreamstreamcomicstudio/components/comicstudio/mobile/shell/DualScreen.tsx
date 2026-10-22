// DualScreen (mobile.md §3.6): foldables spanning two screen segments.
//
//  - Book posture (`axis: 'horizontal'`, segments side by side): first pane exactly in segment 0,
//    second in segment 1, and a gap equal to the hinge — no interactive element can straddle it.
//    There is no resizer: the hinge is the divider.
//  - Tabletop posture (`axis: 'vertical'`, segments stacked): first pane on top, second below.
// Sizes come from the Viewport Segments API rects when the browser reports them, else from the CSS
// `env(viewport-segment-*)` variables, else an even split. Graceful: one segment → plain flex.

import React from 'react';
import type { Segments } from '../formFactor';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export interface DualScreenProps {
  segments: Segments;
  first: React.ReactNode;
  second: React.ReactNode;
  /** Collapse one side (pane switcher): the other spans everything. */
  show?: 'both' | 'first' | 'second';
  className?: string;
}

/** Pane sizes in px from the segment rects, relative to the container's own origin. */
export const segmentSizes = (segments: Segments, containerStart = 0): { first: number; gap: number } | null => {
  const [a, b] = segments.rects;
  if (segments.count !== 2 || !a || !b) return null;
  if (segments.axis === 'horizontal') {
    const first = Math.max(0, a.left + a.width - containerStart);
    return { first, gap: Math.max(0, b.left - (a.left + a.width)) };
  }
  if (segments.axis === 'vertical') {
    const first = Math.max(0, a.top + a.height - containerStart);
    return { first, gap: Math.max(0, b.top - (a.top + a.height)) };
  }
  return null;
};

export const DualScreen: React.FC<DualScreenProps> = ({ segments, first, second, show = 'both', className }) => {
  const vertical = segments.axis === 'vertical';
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [start, setStart] = React.useState(0);
  React.useLayoutEffect(() => {
    const r = containerRef.current?.getBoundingClientRect();
    if (r) setStart(vertical ? r.top : r.left);
  }, [vertical, segments]);

  const sizes = segmentSizes(segments, start);
  const firstSize = sizes
    ? `${Math.round(sizes.first)}px`
    : vertical
      ? 'env(viewport-segment-height 0 0, 50%)'
      : 'calc(env(viewport-segment-width 0 0, 50%) - var(--sa-left, 0px))';
  const gapSize = sizes
    ? `${Math.round(sizes.gap)}px`
    : vertical
      ? 'calc(env(viewport-segment-top 0 1, 0px) - env(viewport-segment-bottom 0 0, 0px))'
      : 'calc(env(viewport-segment-left 1 0, 0px) - env(viewport-segment-right 0 0, 0px))';
  const both = show === 'both';
  const sizeProp = vertical ? 'height' : 'width';

  return (
    <div ref={containerRef} data-layout-dual={segments.axis || 'none'} className={cx('flex h-full min-h-0 w-full min-w-0', vertical ? 'flex-col' : 'flex-row', className)}>
      <div
        hidden={show === 'second'}
        inert={show === 'second' || undefined}
        className={cx(show === 'second' ? 'hidden' : 'flex', 'min-h-0 min-w-0 overflow-hidden', !both && 'flex-1')}
        style={both ? { [sizeProp]: firstSize, flexShrink: 0 } : undefined}
        data-segment="0"
      >
        {first}
      </div>
      {both && <div aria-hidden data-hinge className="shrink-0 bg-[var(--ds-hairline-soft)]" style={{ [sizeProp]: gapSize }} />}
      <div
        hidden={show === 'first'}
        inert={show === 'first' || undefined}
        className={cx(show === 'first' ? 'hidden' : 'flex', 'min-h-0 min-w-0 flex-1 overflow-hidden')}
        data-segment="1"
      >
        {second}
      </div>
    </div>
  );
};

export default DualScreen;
