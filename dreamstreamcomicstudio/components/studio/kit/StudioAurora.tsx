// StudioAurora — the soft violet→cyan glow behind the Code Studio (Linear/AI-studio dark
// aesthetic). Absolutely positioned, pointer-events-none, behind all content. Only renders on
// dark themes.
//
// IMPORTANT: this uses cheap STATIC radial-gradients — no `filter: blur()`, no `will-change`, no
// animation. An earlier version used animated `blur(120px)` blobs which triggered a GPU
// compositing glitch (the whole studio rendered blank until a repaint was forced, e.g. opening
// DevTools). Radial gradients are inherently soft and composite cleanly, so keep it filter-free.

import React from 'react';
import { useStudioTheme } from './themeStore';

export const StudioAurora: React.FC<{ className?: string }> = ({ className }) => {
  const t = useStudioTheme();
  if (!t.isDark) return null;

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 ${className ?? ''}`}
      style={{
        background: [
          'radial-gradient(55rem 38rem at 15% -8%, rgba(124,92,255,0.18), transparent 60%)',
          'radial-gradient(48rem 34rem at 100% 6%, rgba(34,211,238,0.10), transparent 60%)',
          'radial-gradient(40rem 30rem at 55% 115%, rgba(217,70,239,0.08), transparent 60%)',
        ].join(', '),
      }}
    />
  );
};
