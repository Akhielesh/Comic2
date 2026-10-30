// The back of a single page while it turns (reader.md §3.3): warm paper with the front's ink showing
// through faintly and mirrored, as real paper does; or the inside cover when the cover board opens.
// Positioned where it lands when the turn completes; the turn engine writes its transform and clip.

import React from 'react';
import { BAND_REACH } from './flipGeometry';
import type { LeafPart } from './leafEngine';
import { CURL_GRADIENT, ENDPAPER_BG } from './ReaderSlot';

export interface PaperBackProps {
  setRef(p: LeafPart): void;
  x: number;
  W: number;
  H: number;
  z: number;
  variant: 'paper' | 'endpaper';
  showThroughSrc?: string;
  showThroughBox?: { x: number; y: number; w: number; h: number };
  texture: boolean;
  dedication?: string;
}

export const PaperBack: React.FC<PaperBackProps> = ({ setRef, x, W, H, z, variant, showThroughSrc, showThroughBox, texture, dedication }) => {
  const p = React.useRef<LeafPart>({ root: null, curl: null, shade: null });
  const box = showThroughBox ?? { x: 0, y: 0, w: W, h: H };
  return (
    <div
      ref={(el) => {
        p.current.root = el;
        setRef(p.current);
      }}
      aria-hidden
      data-testid="paper-back"
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: x,
        top: 0,
        width: W,
        height: H,
        zIndex: z,
        visibility: 'hidden',
        background: variant === 'endpaper' ? ENDPAPER_BG : 'var(--ds-reader-paper-back)',
        boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.14)'
      }}
    >
      {variant === 'paper' && showThroughSrc && (
        // The back of the sheet: the front's art seen through the paper, mirrored and faint.
        <img
          src={showThroughSrc}
          alt=""
          draggable={false}
          className="absolute select-none object-contain"
          style={{ left: W - box.x - box.w, top: box.y, width: box.w, height: box.h, transform: 'scaleX(-1)', opacity: 0.07, filter: 'grayscale(1)' }}
        />
      )}
      {texture && <div className="ds-reader-paper" />}
      {variant === 'endpaper' && dedication && (
        <p className="absolute inset-x-[12%] top-[38%] text-center font-serif text-[clamp(12px,2.2vmin,20px)] italic leading-relaxed text-[var(--ds-reader-ink-soft)] [overflow-wrap:anywhere]">{dedication}</p>
      )}
      <div
        ref={(el) => {
          p.current.curl = el;
          setRef(p.current);
        }}
        className="pointer-events-none absolute left-0 top-0 opacity-0"
        style={{ width: W, height: BAND_REACH, transformOrigin: '0 0', background: CURL_GRADIENT }}
      />
      <div
        ref={(el) => {
          p.current.shade = el;
          setRef(p.current);
        }}
        className="pointer-events-none absolute inset-0 bg-black opacity-0"
      />
    </div>
  );
};
