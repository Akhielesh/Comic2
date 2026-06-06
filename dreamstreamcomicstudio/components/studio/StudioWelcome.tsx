// First-run welcome for Code Studio (Sprint 4, S4.1): a dismissible, persisted card that
// orients a new user in three steps. Shown once (localStorage), themed + animated.

import React, { useState } from 'react';
import { Sparkles, X, FileCode2, Wand2, GitCompare } from 'lucide-react';
import { Reveal, useStudioTheme } from './kit';

const STORAGE_KEY = 'studio.onboarded';

const readDone = (): boolean => {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY) === '1'; }
  catch { return false; }
};

const STEPS = [
  { icon: FileCode2, text: 'Describe an app right here, or start from a template.' },
  { icon: Wand2, text: 'The agent writes it, runs it, and self-heals errors.' },
  { icon: GitCompare, text: 'Iterate by editing or prompting, then share the running app.' },
];

export const StudioWelcome: React.FC = () => {
  const t = useStudioTheme();
  const [dismissed, setDismissed] = useState<boolean>(readDone);
  if (dismissed) return null;

  const close = () => {
    try { window.localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <Reveal>
      <div className={`relative mb-6 rounded-2xl border ${t.edgeStrong} ${t.panel} p-5 overflow-hidden`}>
        <button onClick={close} aria-label="Dismiss welcome" className={`absolute right-2 top-2 rounded p-1 ${t.hover} ${t.textFaint}`}>
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2">
          <Sparkles className={`w-5 h-5 ${t.accent}`} />
          <h2 className={`font-display text-xl tracking-wide ${t.text}`}>Welcome to Code Studio</h2>
        </div>
        <p className={`mt-1 text-sm ${t.textDim}`}>Describe an app and watch it build, run, and fix itself — then make it yours.</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <div key={i} className={`rounded-xl border ${t.edge} ${t.panelAlt} p-3`}>
                <div className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide ${t.textFaint}`}>
                  <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${t.accentSoft} ${t.accent}`}>{i + 1}</span>
                </div>
                <Icon className={`mt-2 w-5 h-5 ${t.accent}`} />
                <p className={`mt-1.5 text-xs ${t.textDim}`}>{s.text}</p>
              </div>
            );
          })}
        </div>

        <button
          onClick={close}
          className={`mt-4 inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-4 py-1.5 ${t.accentText} ${t.accentBg} ${t.accentBgHover} ${t.focusRing}`}
        >
          Got it
        </button>
      </div>
    </Reveal>
  );
};
