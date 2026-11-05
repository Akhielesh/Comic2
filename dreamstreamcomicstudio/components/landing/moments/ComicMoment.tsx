/**
 * Comic Studio's moment: a page draws itself. The three panel borders stroke in one after another, then
 * the art inside them (`.ds-draw`), a speech balloon pops in (`.ds-pop`) and the caption is lettered one
 * character at a time with a blinking caret. Monochrome: ink strokes on the page's paper.
 */
import React from 'react';
import { Check } from 'lucide-react';
import { TONE_TEXT } from '../../chat/studioDesign';
import { useMomentClock, type MomentStep } from './useMomentClock';

const CAPTION = 'Meanwhile, at the lighthouse…';

const STEPS: readonly MomentStep[] = [
  { id: 'draw', ms: 1500 },
  { id: 'balloon', ms: 650 },
  { id: 'caption', ms: 300, type: CAPTION },
  { id: 'hold', ms: 2800 },
  { id: 'clear', ms: 450 }
];

/** Panel borders, then the art inside them, in drawing order (each path is normalised to length 100). */
const PANELS = ['M16 16 H384 V128 H16 Z', 'M16 138 H196 V254 H16 Z', 'M206 138 H384 V254 H206 Z'];
const ART = [
  'M16 104 H384',
  'M28 116 q10 -5 20 0 t20 0 t20 0',
  'M214 116 q10 -5 20 0 t20 0 t20 0 t20 0',
  'M300 104 L307 52 H321 L328 104',
  'M305 52 V42 H323 V52 M303 42 L314 34 L325 42',
  'M323 46 L372 34 M323 48 L372 60',
  'M228 46 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0',
  'M92 192 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 M78 238 C78 210 126 210 126 238',
  'M30 238 H182 M150 238 V210 M140 210 H160 L155 200 H145 Z',
  'M262 196 H330 V246 H262 Z M296 196 V246 M262 221 H330'
];

const STATUS: Record<string, string> = {
  draw: 'Drawing panels',
  balloon: 'Lettering',
  caption: 'Lettering',
  hold: 'Page ready',
  clear: 'Page ready'
};

export function ComicMoment() {
  const clock = useMomentClock(STEPS, 'hold');
  const { animated, cycle, step } = clock;
  const status = STATUS[step] ?? 'Page ready';
  const ready = status === 'Page ready';
  const drawStyle = { '--ds-draw-length': 100 } as React.CSSProperties;

  return (
    <div ref={clock.ref} data-inview={clock.inview} className="flex h-full flex-col bg-ds-well">
      <div className="flex h-9 shrink-0 items-center justify-between px-4 text-xs text-ds-muted">
        <span>3 panels · lettered</span>
        <span key={status} className={`inline-flex items-center gap-1 font-medium ${animated ? 'ds-blur-in' : ''}`}>
          {ready ? (
            <>
              <Check className={`size-3.5 ${TONE_TEXT.success}`} aria-hidden="true" />
              <span className="text-ds-ink">{status}</span>
            </>
          ) : (
            <span className="ds-shimmer-text">{status}</span>
          )}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 px-3 pb-3">
        <svg
          viewBox="0 0 400 270"
          className={`h-full w-full transition-opacity duration-[var(--ds-motion-panel)] ease-[var(--ds-ease)] ${step === 'clear' ? 'opacity-0' : ''}`}
          preserveAspectRatio="xMidYMid meet"
          fill="none"
        >
          <rect x="6" y="6" width="388" height="258" rx="6" className="fill-ds-canvas stroke-ds-hairline" strokeWidth="1" />
          <g key={`panels-${cycle}`} className={animated ? 'ds-draw' : undefined} style={drawStyle} strokeLinejoin="round" strokeLinecap="round">
            {PANELS.map((d, i) => (
              <path key={d} d={d} pathLength={100} className="stroke-ds-ink" strokeWidth="2.25" style={{ animationDelay: `${60 + i * 110}ms` }} />
            ))}
            {ART.map((d, i) => (
              <path key={d} d={d} pathLength={100} className="stroke-ds-muted" strokeWidth="1.5" style={{ animationDelay: `${420 + i * 55}ms` }} />
            ))}
          </g>
          {clock.reached('balloon') ? (
            <g key={`balloon-${cycle}`} className={animated ? 'ds-pop' : undefined} style={{ transformBox: 'fill-box', transformOrigin: '30% 100%' }}>
              {/* One outline: the tail, then the long way round the ellipse (centre 296,166; 74 × 20). */}
              <path d="M284 185.7 L256 204 L270 184.7 A74 20 0 1 1 284 185.7 Z" className="fill-ds-canvas stroke-ds-ink" strokeWidth="1.75" strokeLinejoin="round" />
              <text x="296" y="171" textAnchor="middle" fontSize="13.5" fontWeight="600" className="fill-ds-ink">
                Someone’s still up.
              </text>
            </g>
          ) : null}
          {clock.reached('caption') ? (
            <g>
              <rect x="22" y="22" width="208" height="24" className="fill-ds-canvas stroke-ds-ink" strokeWidth="1" />
              <text x="30" y="38.5" fontSize="12.5" fontWeight="500" className="fill-ds-ink">
                {clock.typed('caption')}
                {clock.typing('caption') ? <tspan className="ds-home-blink">▍</tspan> : null}
              </text>
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}
