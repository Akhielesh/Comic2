// "Leaf" mid-turn demo for the Component Gallery (CLAUDE.md: every new visual is reachable there;
// buildplan P3-GALLERY-DOCS mounts it). A two-page spread with the right page caught mid-turn, drawn by
// the real geometry (computeFold + leafStyles) — no images, no network. With motion allowed it breathes
// slowly between progress 0.25 and 0.55; under reduced motion it holds still at 0.4.

import React, { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '../../studio/kit/motion';
import { computeFold, cssMatrix, leafFrame, leafStyles, BAND_REACH } from './flipGeometry';
import { autoPath, AUTO_GRAB } from './flipPhysics';
import { CAST_GRADIENT, CURL_GRADIENT } from './ReaderSlot';

const Art: React.FC<{ hue: number; label: string }> = ({ hue, label }) => (
  <div className="absolute inset-0 bg-white p-[7%]">
    <div className="grid h-full grid-rows-[1.2fr_1fr] gap-[5%]">
      <div className="rounded-[3px]" style={{ background: `linear-gradient(160deg, hsl(${hue} 70% 72%), hsl(${hue + 30} 60% 52%))` }} />
      <div className="grid grid-cols-2 gap-[6%]">
        <div className="rounded-[3px]" style={{ background: `linear-gradient(200deg, hsl(${hue + 60} 55% 70%), hsl(${hue + 90} 50% 48%))` }} />
        <div className="rounded-[3px]" style={{ background: `linear-gradient(120deg, hsl(${hue - 30} 60% 74%), hsl(${hue} 55% 50%))` }} />
      </div>
    </div>
    <span className="absolute bottom-[3%] left-1/2 -translate-x-1/2 text-[10px] text-black/40">{label}</span>
  </div>
);

export const LeafDemo: React.FC<{ width?: number; progress?: number }> = ({ width = 360, progress }) => {
  const reduced = usePrefersReducedMotion();
  const [t, setT] = useState(0.4);
  useEffect(() => {
    if (reduced || progress !== undefined || typeof requestAnimationFrame !== 'function') return;
    let id = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setT(0.4 + 0.15 * Math.sin((now - t0) / 1400));
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [reduced, progress]);
  const W = width / 2;
  const H = W * 1.5;
  const g = progress ?? (reduced ? 0.4 : t);
  const frame = leafFrame(W, 0, W, H, false);
  const fold = computeFold({ W, H, grab: { x: W, y: AUTO_GRAB * H }, pointer: autoPath(W, H, AUTO_GRAB * H, g) });
  const st = fold ? leafStyles(frame, fold) : null;
  const k = fold ? Math.sin(Math.PI * fold.progress) : 0;
  return (
    <div className="relative mx-auto" style={{ width, height: H }} role="img" aria-label="A comic page caught mid-turn" data-testid="leaf-demo">
      <div className="absolute left-0 top-0 overflow-hidden shadow-[0_18px_40px_-16px_rgba(0,0,0,0.5)]" style={{ width: W, height: H }}>
        <Art hue={200} label="2" />
      </div>
      {/* The page revealed under the leaf, with the cast shadow along the fold. */}
      <div className="absolute top-0 overflow-hidden shadow-[0_18px_40px_-16px_rgba(0,0,0,0.5)]" style={{ left: W, width: W, height: H }}>
        <Art hue={30} label="5" />
        {st && <div className="absolute left-0 top-0" style={{ width: W, height: BAND_REACH, transformOrigin: '0 0', transform: cssMatrix(st.castBand), background: CAST_GRADIENT, opacity: Math.min(1, st.shade.cast * 1.6) }} />}
      </div>
      {/* The turning page: its static part… */}
      <div className="absolute top-0 overflow-hidden" style={{ left: W, width: W, height: H, clipPath: st?.frontClip }}>
        <Art hue={320} label="3" />
      </div>
      {/* …and its back (page 4) folding over, with the curl highlight. */}
      {st && (
        <div className="absolute top-0 overflow-hidden" style={{ left: 0, width: W, height: H, transformOrigin: '0 0', transform: cssMatrix(st.backTransform), clipPath: st.backClip }}>
          <Art hue={120} label="4" />
          <div className="absolute left-0 top-0" style={{ width: W, height: BAND_REACH, transformOrigin: '0 0', transform: cssMatrix(st.curlBand), background: CURL_GRADIENT, opacity: Math.min(1, k * 1.1) }} />
        </div>
      )}
    </div>
  );
};

export default LeafDemo;
