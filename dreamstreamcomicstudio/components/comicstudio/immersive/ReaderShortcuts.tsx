// "?" — the reader's keyboard shortcuts (reader.md §2.3). Keyboard parity: every gesture has a key.

import React from 'react';
import { X } from 'lucide-react';
import { SHORTCUTS } from './readerInput';
import { HudButton } from './ReaderHud';

export const ReaderShortcuts: React.FC<{ open: boolean; onClose(): void }> = ({ open, onClose }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  return (
    <div className="pointer-events-auto absolute inset-0 z-[70] grid place-items-center bg-black/40 p-4" data-no-turn onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-testid="reader-shortcuts"
        className="max-h-full w-[min(440px,100%)] overflow-y-auto rounded-3xl bg-black/75 p-4 text-white shadow-[0_20px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Keyboard shortcuts</h2>
          <HudButton label="Close shortcuts" onClick={onClose}>
            <X className="h-5 w-5" aria-hidden />
          </HudButton>
        </div>
        <dl className="divide-y divide-white/10">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="shrink-0 font-mono text-[12px] text-white/90">{s.keys}</dt>
              <dd className="text-right text-[12px] text-white/70">{s.action}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-white/55">On touch screens: swipe or tap the edges to turn, tap the middle for controls, double-tap a panel for Guided View, pinch to zoom.</p>
      </div>
    </div>
  );
};

export default ReaderShortcuts;
