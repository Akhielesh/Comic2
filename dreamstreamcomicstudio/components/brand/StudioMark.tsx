import React, { useId } from 'react';
import { clsx } from 'clsx';
import { MARK_POINT_RADIUS, MARK_STROKE, MARK_TILE_RADIUS, MARK_VIEWBOX, STUDIO_MARKS, type Studio } from './studios';
import './studio-marks.css';

export interface StudioMarkProps {
  studio: Studio;
  /**
   * Accessible name. Give it when the mark stands alone (it becomes `role="img"` with this name);
   * omit it when a visible wordmark sits beside the mark (it is then `aria-hidden`).
   */
  label?: string;
  /** Loops the studio's motion moment, for splash and loading screens. Pauses under
   *  `[data-inview="false"]` and holds still under reduced motion; pair it with a visible or
   *  screen-reader "Loading…" label, since the mark itself announces nothing. */
  loading?: boolean;
  /** Width and height (a number is px). Without it the mark is 1em square, or whatever a class sets. */
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * A DreamStream studio mark, drawn like the Atlas mark: one tile in currentColor with the glyph cut
 * out through a mask, so the same mark is right on white, on black and on inverted panels. Motion
 * (hover tilt, the studio's moment, `loading`) lives in studio-marks.css, which works without
 * Tailwind, so Stream Studio's plain-CSS bundle renders it the same way as the main app.
 */
export function StudioMark({ studio, label, loading = false, size, className, style }: StudioMarkProps) {
  // useId output differs across React versions (":r0:", "«r0»", "_r_0_"): keep only id-safe characters,
  // so url(#…) resolves and every instance on the page owns its own mask.
  const maskId = `ds-${studio}-mark-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const spec = STUDIO_MARKS[studio];
  const name = label?.trim() || undefined;
  const sized = size === undefined ? style : { width: size, height: size, ...style };

  return (
    <svg
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={name ? 'img' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      focusable="false"
      data-studio={studio}
      className={clsx('ds-logo-mark', `ds-logo-mark--${studio}`, loading && 'ds-logo-mark--loading', className)}
      style={sized}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={MARK_VIEWBOX} height={MARK_VIEWBOX}>
          <rect width={MARK_VIEWBOX} height={MARK_VIEWBOX} rx={MARK_TILE_RADIUS} fill="#fff" />
          <path
            className="ds-logo-cut"
            d={spec.cut}
            fill="none"
            stroke="#000"
            strokeWidth={MARK_STROKE}
            strokeLinejoin="miter"
          />
          <circle className="ds-logo-point" cx={spec.point[0]} cy={spec.point[1]} r={MARK_POINT_RADIUS} fill="#000" />
        </mask>
      </defs>
      <rect width={MARK_VIEWBOX} height={MARK_VIEWBOX} rx={MARK_TILE_RADIUS} fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
