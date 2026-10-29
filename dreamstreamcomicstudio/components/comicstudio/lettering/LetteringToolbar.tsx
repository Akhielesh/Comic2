// Lettering toolbar for the page editor's mode row (lettering.md §7.2): add a Speech / Thought /
// Caption / SFX balloon (pick, then click on the page), undo / redo, Tidy (free re-layout of balloons
// you haven't placed by hand), Fix edges (move balloons back inside the safe area) and the Easy/Pro view.
// Wraps instead of overflowing; every control is a 44 px target on touch.

import React from 'react';
import { Cloud, MessageCircle, Redo2, Sparkles, Square, Undo2, Wand2, Zap } from 'lucide-react';
import type { LineKind } from '../../../shared/comic/doc';
import type { StudioMode } from '../../../shared/comic/capabilities';
import { Segmented, cx } from '../board/ui';

export interface LetteringToolbarProps {
  addKind: LineKind | null;
  onAddKind(kind: LineKind | null): void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  onUndo(): void;
  onRedo(): void;
  /** null = nothing to tidy. */
  onTidy: (() => void) | null;
  /** Balloons outside the safe area (0 hides the button). */
  outsideCount: number;
  onFixEdges(): void;
  mode: StudioMode;
  onModeChange(mode: StudioMode): void;
  canPro: boolean;
  disabled?: boolean;
}

const ADD: { kind: LineKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'speech', label: 'Speech', icon: <MessageCircle className="h-3.5 w-3.5" aria-hidden /> },
  { kind: 'thought', label: 'Thought', icon: <Cloud className="h-3.5 w-3.5" aria-hidden /> },
  { kind: 'caption', label: 'Caption', icon: <Square className="h-3.5 w-3.5" aria-hidden /> },
  { kind: 'sfx', label: 'Sound effect', icon: <Zap className="h-3.5 w-3.5" aria-hidden /> }
];

// Touch: real 44 px buttons (a 30x28 button's ::after hit area overlapped its neighbours' — P1-QA
// lettering-toolbar-small-add); fine pointers keep the compact 28 px row.
const BTN =
  'inline-flex h-7 items-center justify-center gap-1 rounded-lg px-2 text-[11.5px] font-medium text-[var(--ds-muted)] transition-colors duration-150 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none coarse:h-11 coarse:min-w-11 coarse:px-2.5 coarse:text-[12.5px]';

export const LetteringToolbar: React.FC<LetteringToolbarProps> = ({
  addKind,
  onAddKind,
  canUndo,
  canRedo,
  undoLabel,
  onUndo,
  onRedo,
  onTidy,
  outsideCount,
  onFixEdges,
  mode,
  onModeChange,
  canPro,
  disabled
}) => (
  <div role="toolbar" aria-label="Lettering tools" className="flex min-w-0 flex-wrap items-center gap-1" data-testid="lettering-toolbar">
    <div className="flex flex-wrap items-center gap-0.5 rounded-xl bg-[var(--ds-well-strong)] p-0.5" role="group" aria-label="Add a balloon">
      {ADD.map((a) => (
        <button
          key={a.kind}
          type="button"
          disabled={disabled}
          aria-pressed={addKind === a.kind}
          title={addKind === a.kind ? 'Click on the page to place it (Esc to cancel)' : a.kind === 'sfx' ? 'Add a sound effect (SFX)' : `Add a ${a.label.toLowerCase()} balloon`}
          // The name contains the visible words ("+ Sound effect" → "Add a sound effect"; WCAG 2.5.3).
          aria-label={a.kind === 'sfx' ? 'Add a sound effect' : `Add ${a.label.toLowerCase()} balloon`}
          onClick={() => onAddKind(addKind === a.kind ? null : a.kind)}
          className={cx(BTN, addKind === a.kind && 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]')}
        >
          {a.icon}
          <span aria-hidden className="hidden sm:inline">
            + {a.label}
          </span>
        </button>
      ))}
    </div>
    <button type="button" className={BTN} disabled={!canUndo} onClick={onUndo} title={undoLabel ? `Undo: ${undoLabel} (⌘Z)` : 'Undo (⌘Z)'} aria-label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}>
      <Undo2 className="h-3.5 w-3.5" aria-hidden />
    </button>
    <button type="button" className={BTN} disabled={!canRedo} onClick={onRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
      <Redo2 className="h-3.5 w-3.5" aria-hidden />
    </button>
    <button type="button" className={BTN} disabled={disabled || !onTidy} onClick={() => onTidy?.()} title={onTidy ? 'Re-place the balloons you haven’t moved by hand (free)' : 'Nothing to tidy — every balloon is placed by hand'}>
      <Wand2 className="h-3.5 w-3.5" aria-hidden /> Tidy
    </button>
    {outsideCount > 0 && (
      <button type="button" className={cx(BTN, 'text-amber-700 dark:text-amber-300')} disabled={disabled} onClick={onFixEdges} title="Move balloons that hug the page edge back inside the safe area (free)">
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> Fix edges ({outsideCount})
      </button>
    )}
    {canPro && (
      <Segmented<StudioMode>
        label="Editor view"
        size="xs"
        value={mode}
        onChange={onModeChange}
        options={[
          { value: 'easy', label: 'Easy' },
          { value: 'pro', label: 'Pro' }
        ]}
      />
    )}
  </div>
);

export default LetteringToolbar;
