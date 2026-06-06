// StudioAurora — the soft violet→cyan aurora glow behind the Code Studio (Linear/AI-studio
// dark aesthetic). Absolutely positioned, pointer-events-none, behind all content. Only
// renders on dark themes; the drift animation honors prefers-reduced-motion (see index.css).

import React from 'react';
import { useStudioTheme } from './themeStore';

export const StudioAurora: React.FC<{ className?: string }> = ({ className }) => {
  const t = useStudioTheme();
  if (!t.isDark) return null;

  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}>
      {/* Top vignette glow */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 100% at 50% -10%, rgba(124,92,255,0.16), transparent 55%)',
        }}
      />
      {/* Drifting colored blobs (blurred). */}
      <div className="studio-aurora-blob absolute -top-40 left-1/4 h-[42rem] w-[42rem] -translate-x-1/2 rounded-full bg-violet-600/20 blur-[120px]" />
      <div className="studio-aurora-blob-2 absolute top-1/4 -right-32 h-[34rem] w-[34rem] rounded-full bg-cyan-500/15 blur-[120px]" />
      <div className="studio-aurora-blob absolute bottom-[-12rem] left-1/3 h-[30rem] w-[30rem] rounded-full bg-fuchsia-500/10 blur-[120px]" />
      {/* Faint grid for depth. */}
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(100% 80% at 50% 0%, black, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(100% 80% at 50% 0%, black, transparent 75%)',
        }}
      />
    </div>
  );
};
