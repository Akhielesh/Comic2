// SwatchPopover — a colour well that opens a small popover of swatches and a hex field (master plan §2.4; the Pro
// inspector's fill, text and border colours). User colours are content (§2.9 "User colours are content and exempt"),
// so they are painted with inline styles, never a hue class; the chrome is OVERLAY on the popover layer. Non-modal:
// Esc or a press outside closes it and focus returns to the well. Every swatch is a named 44 px target on touch.

import React, { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../../lib/utils';
import { DENSITY, FIELD, FOCUS_RING, INK, MUTED, OVERLAY, RADIUS_CONTROL, SEGMENTED_ACTIVE } from '../../../chat/studioDesign';
import { editorZ } from './zLayers';

export interface SwatchPopoverProps {
  label: string;
  /** #rrggbb or #rrggbbaa (null: none set). */
  value: string | null;
  swatches: readonly string[];
  onPick(color: string): void;
  disabled?: boolean;
  className?: string;
}

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** A colour the field accepts (#rrggbb / #rrggbbaa, lower case), or null. Pure; tested. */
export const normalizeHex = (text: string): string | null => {
  const t = text.trim().toLowerCase();
  const withHash = t.startsWith('#') ? t : `#${t}`;
  return HEX.test(withHash) ? withHash : null;
};

export const SwatchPopover: React.FC<SwatchPopoverProps> = ({ label, value, swatches, onPick, disabled, className }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const well = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => setDraft(value ?? ''), [value, open]);
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (panel.current?.contains(t) || well.current?.contains(t))) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  const close = () => {
    setOpen(false);
    well.current?.focus();
  };
  const pick = (c: string) => {
    onPick(c);
    close();
  };
  return (
    <span data-slot="swatch-popover" className={cn('relative inline-flex', className)}>
      <button
        ref={well}
        type="button"
        aria-label={`${label}: ${value ?? 'none'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`${cn('inline-flex size-7 items-center justify-center border border-[var(--ds-control-border)] disabled:cursor-not-allowed disabled:opacity-50', RADIUS_CONTROL, DENSITY.coarseSquare)} ${FOCUS_RING}`}
      >
        <span aria-hidden="true" data-testid="swatch-well" className={cn('block size-4 border border-[var(--ds-hairline)]', RADIUS_CONTROL)} style={value ? { background: value } : undefined} />
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label={label}
          data-testid="swatch-panel"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
          className={cn('absolute left-0 top-full mt-1 flex w-48 flex-col gap-2 p-2', OVERLAY, editorZ('popover'))}
        >
          <div role="group" aria-label={`${label} swatches`} className="grid grid-cols-6 gap-1">
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={value?.toLowerCase() === c.toLowerCase()}
                onClick={() => pick(c)}
                className={`${cn('inline-flex size-7 items-center justify-center', RADIUS_CONTROL, DENSITY.coarseSquare, value?.toLowerCase() === c.toLowerCase() && SEGMENTED_ACTIVE)} ${FOCUS_RING}`}
              >
                <span aria-hidden="true" className={cn('block size-5 border border-[var(--ds-hairline)]', RADIUS_CONTROL)} style={{ background: c }} />
              </button>
            ))}
          </div>
          <label className={cn('flex min-w-0 items-center gap-1.5 text-[11.5px]', MUTED)}>
            Hex
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const c = normalizeHex(draft);
                if (c) pick(c);
              }}
              aria-invalid={draft !== '' && !normalizeHex(draft) ? true : undefined}
              spellCheck={false}
              className={`${cn(FIELD, RADIUS_CONTROL, 'h-7 min-w-0 flex-1 px-1.5 font-mono text-[12px]', INK, DENSITY.coarse, 'coarse:text-[16px]')} ${FOCUS_RING}`}
            />
          </label>
        </div>
      )}
    </span>
  );
};
