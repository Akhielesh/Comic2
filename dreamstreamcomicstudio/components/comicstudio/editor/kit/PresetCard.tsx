// PresetCard — one choosable preset (a look, a motion preset, a sample) in a Pro panel grid (master plan §2.4–§2.6): a
// preview, the name, and "Free" (every Pro edit is free software; "Pro" is never "paid"). Selected = accent-soft with an
// ink edge (the chrome rule for a selected row), never a hue. A real button, 44 px tall at least under a coarse pointer.

import React from 'react';
import { cn } from '../../../../lib/utils';
import { ACCENT_SOFT_BG, DENSITY, FOCUS_RING, INK, RADIUS_PANEL, TONE_TEXT, TRANSITION } from '../../../chat/studioDesign';

export interface PresetCardProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  name: string;
  /** The preview (a poster, a balloon, a swatch strip). */
  preview?: React.ReactNode;
  selected?: boolean;
  /** Show the "Free" word (default true). */
  free?: boolean;
}

export const PresetCard: React.FC<PresetCardProps> = ({ name, preview, selected = false, free = true, className, ...rest }) => (
  <button
    {...rest}
    type="button"
    data-slot="preset-card"
    aria-pressed={selected}
    className={`${cn(
      'flex min-w-0 flex-col items-stretch gap-1.5 border p-1.5 text-left',
      RADIUS_PANEL,
      TRANSITION,
      'motion-reduce:transition-none',
      DENSITY.coarse,
      selected ? cn(ACCENT_SOFT_BG, 'border-[var(--ds-ink)]') : 'border-[var(--ds-hairline)] hover:bg-[var(--ds-hover)]',
      className
    )} ${FOCUS_RING}`}
  >
    {preview && (
      <span aria-hidden="true" className="block min-w-0 overflow-hidden">
        {preview}
      </span>
    )}
    <span className="flex min-w-0 items-center justify-between gap-1.5">
      <span className={cn('min-w-0 truncate text-[12px] font-medium', INK)}>{name}</span>
      {free && <span className={cn('shrink-0 text-[10.5px] font-semibold', TONE_TEXT.success)}>Free</span>}
    </span>
  </button>
);
