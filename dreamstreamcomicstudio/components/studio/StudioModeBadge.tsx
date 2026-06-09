// An honest, at-a-glance indicator of which build mode the Code Studio is actually in:
// "Agentic · live" (the cloud Worker is configured → the app runs and self-fixes runtime errors) vs
// "One-shot mode" (generate + static verify only). Click it for a one-line explanation of the gap.
// Presentational — the server truth comes from getStudioStatus(), the copy from services/studioMode.

import React, { useState } from 'react';
import { Zap, Layers, Info } from 'lucide-react';
import { useStudioTheme } from './kit';
import { studioModeInfo } from '../../services/studioMode';

export const StudioModeBadge: React.FC<{ liveConfigured?: boolean; className?: string }> = ({
  liveConfigured,
  className
}) => {
  const t = useStudioTheme();
  const [open, setOpen] = useState(false);
  const info = studioModeInfo(liveConfigured);
  if (info.mode === 'unknown') return null; // don't show a guess before we know

  const agentic = info.mode === 'agentic';
  const Icon = agentic ? Zap : Layers;
  const tone = agentic
    ? 'border-emerald-500/40 text-emerald-600 bg-emerald-500/10'
    : 'border-amber-500/50 text-amber-600 bg-amber-500/10';

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={info.summary}
        aria-label={`Build mode: ${info.label}. ${info.summary}`}
        aria-expanded={open}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${tone} ${t.focusRing}`}
      >
        <Icon className="w-3 h-3" /> {info.label}
        <Info className="w-2.5 h-2.5 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div role="dialog" className={`absolute right-0 z-50 mt-1 w-72 rounded-lg border ${t.edgeStrong} ${t.panel} p-3 text-left shadow-lg`}>
            <p className={`text-xs font-bold ${t.text} mb-1`}>{agentic ? 'Agentic build (live)' : 'One-shot mode'}</p>
            <p className={`text-[11px] leading-relaxed ${t.textDim}`}>{info.summary}</p>
          </div>
        </>
      )}
    </div>
  );
};
