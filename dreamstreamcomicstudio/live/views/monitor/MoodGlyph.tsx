// The baby's state as a small living picture instead of a coloured dot:
// asleep → a moon with drifting z's; stirring → a gentle sway; awake → open
// eyes that blink; noisy → bouncing sound bars; fussing → a wobble; crying →
// rings pulsing out. Motion respects reduced-motion settings (CSS).
import React from 'react';
import { cx } from '../../ui/primitives';

export type Mood = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying' | 'offline' | 'unknown';

export function MoodGlyph({ mood, size = 44 }: { mood: Mood; size?: number }) {
  return (
    <span className={cx('mood', `mood-${mood}`)} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 48 48" width={size} height={size}>
        {mood === 'crying' && (
          <>
            <circle className="mood-ring r1" cx="24" cy="24" r="14" />
            <circle className="mood-ring r2" cx="24" cy="24" r="14" />
          </>
        )}
        <circle className="mood-orb" cx="24" cy="24" r="15" />
        {mood === 'calm' && (
          <>
            <path className="mood-ink" d="M27.5 15.5a9 9 0 1 0 5 13.6 7.5 7.5 0 0 1-5-13.6z" />
            <text className="mood-z z1" x="33" y="15">z</text>
            <text className="mood-z z2" x="37" y="10">z</text>
          </>
        )}
        {(mood === 'awake' || mood === 'stirring' || mood === 'fussing') && (
          <g className="mood-face">
            <ellipse className="mood-eye" cx="19" cy="22" rx="1.8" ry={mood === 'stirring' ? 0.7 : 2.2} />
            <ellipse className="mood-eye" cx="29" cy="22" rx="1.8" ry={mood === 'stirring' ? 0.7 : 2.2} />
            <path className="mood-mouth" d={mood === 'fussing' ? 'M19 30q5-3 10 0' : mood === 'awake' ? 'M19 28q5 4 10 0' : 'M20 29h8'} />
          </g>
        )}
        {mood === 'crying' && (
          <g className="mood-face">
            <path className="mood-mouth" d="M19 21.5l3 1.5M29 21.5l-3 1.5" />
            <ellipse className="mood-ink" cx="24" cy="29.5" rx="3.2" ry="3.6" />
          </g>
        )}
        {mood === 'noisy' && (
          <g className="mood-bars">
            {[16, 21, 26, 31].map((x, i) => <rect key={x} className={`bar b${i}`} x={x} y="17" width="3" height="14" rx="1.5" />)}
          </g>
        )}
        {(mood === 'offline' || mood === 'unknown') && <path className="mood-mouth" d="M18 24h12" />}
      </svg>
    </span>
  );
}
