/**
 * SelectionBar — what you picked and what you can do with it (redesign plan §4: the Pages multi-select bar, Assets
 * bulk, Library bulk). The count is a polite live region, so "3 comics selected" is heard as it changes; then the
 * screen's actions (Download, Move, Delete — passed in, the screen owns their dialogs), then Select all and Clear.
 *
 * Placement follows layout.ts (`library.selectionBar`): at the top of the content from 1024 px and beside a rail, at
 * the bottom with the safe area below it on phones, where the thumb is. It sticks while the grid scrolls, on the
 * chrome layer. Esc in the grid (CardGrid) and Clear here both leave selection mode. Nothing here prints a price:
 * an action that spends says so in its own confirm.
 */
import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { countWords } from './announce';
import { DENSITY, RADIUS_PANEL, SHADOW_SOFT, Z } from './recipes';

export interface SelectionBarProps {
  /** How many are selected. */
  count: number;
  /** What they are, singular ("comic", "page", "image"). */
  noun?: string;
  plural?: string;
  /** The screen's bulk actions (Buttons); disable them yourself at count 0. */
  actions?: React.ReactNode;
  onClear: () => void;
  /** Select every item shown (hidden once all are selected). */
  onSelectAll?: () => void;
  /** How many items are shown (for Select all). */
  total?: number;
  placement?: 'top' | 'bottom';
  className?: string;
}

/** The selected count in words: "3 comics selected", "Nothing selected". */
export function selectionText(count: number, noun = 'item', plural = `${noun}s`): string {
  return count > 0 ? `${countWords(count, noun, plural)} selected` : 'Nothing selected';
}

export function SelectionBar({ count, noun = 'item', plural, actions, onClear, onSelectAll, total, placement = 'bottom', className }: SelectionBarProps) {
  const words = selectionText(count, noun, plural);
  const allSelected = typeof total === 'number' && total > 0 && count >= total;
  return (
    <div
      role="region"
      aria-label="Selection"
      data-slot="selection-bar"
      data-placement={placement}
      className={cn(
        'sticky flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-3 py-2 text-[var(--ds-ink)]',
        RADIUS_PANEL,
        SHADOW_SOFT,
        Z.chrome,
        placement === 'top' ? 'top-2' : 'bottom-2 mb-[var(--sa-bottom-eff,0px)]',
        className
      )}
    >
      <span role="status" aria-live="polite" aria-atomic="true" data-slot="selection-count" className="min-w-0 flex-1 truncate text-[length:var(--ds-text-base)] font-medium tabular-nums">
        {words}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {actions}
        {onSelectAll && !allSelected ? (
          <Button variant="ghost" size="sm" onClick={onSelectAll}>
            Select all
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onClear} aria-label="Clear selection" className={DENSITY.coarse}>
          <X aria-hidden="true" />
          Clear
        </Button>
      </div>
    </div>
  );
}
