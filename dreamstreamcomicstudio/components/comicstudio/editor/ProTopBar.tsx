// The Pro editor's top bar (master plan §2.2 "The switch", §2.7 "Top bar"; redesign plan §11.3 M6). It sits in the
// page editor's header, beside the page switcher (prev · "Page n of m" · next) and Close, on every layout while
// COMIC_PRO_EDITOR_V2 is on:
//
//   [Undo · move balloon] [Redo] [100%]   [Easy | Pro]   [?]
//
//  - The Easy | Pro switch is ONE Segmented (SEGMENTED_ACTIVE on --ds-segment-track) bound to the studio's mode
//    (useStudioMode through studio.setMode); its group is "Easy or Pro mode" and its Pro option reads "Pro mode" to
//    a screen reader (M6; no ⋯ copy). Switching never sends an op (zero-confusion rule 1). DS-R10 reuses ProModeSwitch
//    for the Pages toolbar.
//  - Undo shows what it undoes; the zoom is read-only here (pinch, Ctrl + scroll or the Zoom tool change it).
//  - Phones show the switch only (the header has no room for more at 320 px); the shortcut sheet is reachable from the
//    tools sheet there.
//  - Preview ▶ and Export arrive with PE-ANIMATE / PE-SHELL-2 (S3): no button is drawn for something that cannot run.

import React from 'react';
import { CircleHelp, Redo2, Undo2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { StudioMode } from '../../../shared/comic/capabilities';
import { DENSITY, FOCUS_RING, INK, MUTED, RADIUS_CONTROL, TRANSITION } from '../../chat/studioDesign';
import { IconButton, Segmented } from '../board/ui';

/** The switch's group name (M6: not "Editor view"). */
export const MODE_GROUP_LABEL = 'Easy or Pro mode';

export interface ProModeSwitchProps {
  value: StudioMode;
  onChange(mode: StudioMode): void;
  /** caps.proEditor (true for everyone today; "Pro" is never "paid"). */
  canPro: boolean;
  size?: 'xs' | 'sm';
  className?: string;
}

/** The one Easy | Pro switch (header on every layout; the Pages toolbar under DS-R10). */
export const ProModeSwitch: React.FC<ProModeSwitchProps> = ({ value, onChange, canPro, size = 'xs', className }) => (
  <span className={cn('inline-flex shrink-0', className)} data-testid="pro-mode-switch">
    <Segmented<StudioMode>
      label={MODE_GROUP_LABEL}
      size={size}
      value={canPro ? value : 'easy'}
      onChange={(m) => m !== value && onChange(m)}
      options={[
        {
          value: 'easy',
          title: 'Easy mode: the essentials. Everything stays on the page.',
          label: (
            <>
              Easy <span className="sr-only">mode</span>
            </>
          )
        },
        {
          value: 'pro',
          disabled: !canPro,
          title: canPro ? 'Pro mode: tools, layers and exact numbers. Free, done by the editor.' : 'Pro mode isn’t available here',
          label: (
            <>
              Pro <span className="sr-only">mode</span>
            </>
          )
        }
      ]}
    />
  </span>
);

export interface ProTopBarProps {
  mode: StudioMode;
  onModeChange(mode: StudioMode): void;
  canPro: boolean;
  /** 'phone': the switch only; 'full': undo / redo with its label, the zoom and the shortcut sheet. */
  variant: 'phone' | 'tablet' | 'full';
  canUndo?: boolean;
  canRedo?: boolean;
  undoLabel?: string;
  onUndo?(): void;
  onRedo?(): void;
  /** The stage's zoom (1 = fit). */
  zoom?: number;
  helpOpen?: boolean;
  onHelp?(): void;
}

const LABEL_BTN = `inline-flex h-8 min-w-0 max-w-[13rem] items-center gap-1 px-2 text-[12px] font-medium ${RADIUS_CONTROL} ${TRANSITION} motion-reduce:transition-none hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-40`;

export const ProTopBar: React.FC<ProTopBarProps> = ({ mode, onModeChange, canPro, variant, canUndo, canRedo, undoLabel, onUndo, onRedo, zoom = 1, helpOpen, onHelp }) => {
  const pro = mode === 'pro';
  const extras = variant !== 'phone' && pro;
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1" data-testid="pro-top-bar" data-variant={variant}>
      {extras && (
        <span role="group" aria-label="Undo and redo" className="hidden min-w-0 items-center gap-0.5 md:inline-flex">
          <button
            type="button"
            className={`${cn(LABEL_BTN, INK, DENSITY.coarse)} ${FOCUS_RING}`}
            disabled={!canUndo}
            onClick={() => onUndo?.()}
            aria-label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
            title={undoLabel ? `Undo: ${undoLabel} (⌘Z)` : 'Undo (⌘Z)'}
            data-testid="pro-undo"
          >
            <Undo2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span aria-hidden className="min-w-0 truncate">
              {undoLabel ? `Undo · ${undoLabel}` : 'Undo'}
            </span>
          </button>
          <IconButton size="sm" label="Redo" disabled={!canRedo} onClick={() => onRedo?.()}>
            <Redo2 className="h-3.5 w-3.5" aria-hidden />
          </IconButton>
        </span>
      )}
      {extras && variant === 'full' && (
        <span className={cn('hidden px-1 text-[12px] tabular-nums lg:inline', MUTED)} aria-label={`Zoom ${Math.round(zoom * 100)} percent`} data-testid="pro-zoom">
          {Math.round(zoom * 100)}%
        </span>
      )}
      <ProModeSwitch value={mode} onChange={onModeChange} canPro={canPro} />
      {variant !== 'phone' && onHelp && (
        <IconButton label="Shortcuts and Pro tips (?)" aria-expanded={!!helpOpen} aria-keyshortcuts="?" onClick={onHelp} data-testid="pro-help">
          <CircleHelp className="h-4 w-4" aria-hidden />
        </IconButton>
      )}
    </div>
  );
};
