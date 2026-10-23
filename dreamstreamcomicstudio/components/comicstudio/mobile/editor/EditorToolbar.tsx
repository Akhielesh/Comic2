// The page editor's thumb-zone toolbar on phones (mobile.md §5.6): a bottom bar in portrait, a vertical
// rail on the stage's left edge in landscape.
//
//   [Move | Mark up] · Undo · Redo · Lettering · Tools
//
// "Lettering" opens the lettering tray (add Speech / Thought / Caption / SFX, Tidy, Fix edges, show or
// hide the lettering) — or, when balloons are selected, brings their inspector back. "Tools" opens the
// page tools sheet (Edit with AI, re-render, versions, quality check, script). Every control is a 44 px
// target with a visible label (portrait) or a name and tooltip (the rail), and the tray sits IN the
// layout — beside the rail or above the bar — so it never covers the page.

import React from 'react';
import { Cloud, Eye, EyeOff, MessageCircle, MousePointer2, PanelBottomOpen, Redo2, Sparkles, Square, SquareDashed, Type, Undo2, Wand2, Zap } from 'lucide-react';
import type { LineKind } from '../../../../shared/comic/doc';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export type EditorMode = 'move' | 'markup';

export interface LetteringTrayProps {
  addKind: LineKind | null;
  onAddKind(kind: LineKind | null): void;
  /** Adding lines changes the original script: off while editing a translated edition. */
  canAdd: boolean;
  /** null = nothing to tidy. */
  onTidy: (() => void) | null;
  outsideCount: number;
  onFixEdges(): void;
  hidden: boolean;
  onToggleHidden(): void;
}

export interface EditorToolbarProps {
  orientation: 'horizontal' | 'vertical';
  mode: EditorMode;
  onModeChange(mode: EditorMode): void;
  /** Mark up needs a drawing. */
  markupDisabled?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  onUndo(): void;
  onRedo(): void;
  /** null: this comic's lettering is drawn into the art (nothing to edit here). */
  lettering: { open: boolean; onToggle(): void; disabled?: boolean; attention?: number } | null;
  tools: { open: boolean; onToggle(): void };
  /** The tray's contents (shown while `lettering.open`). */
  tray?: LetteringTrayProps | null;
  className?: string;
}

const ADD: { kind: LineKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'speech', label: 'Speech', icon: <MessageCircle className="h-4 w-4" aria-hidden /> },
  { kind: 'thought', label: 'Thought', icon: <Cloud className="h-4 w-4" aria-hidden /> },
  { kind: 'caption', label: 'Caption', icon: <Square className="h-4 w-4" aria-hidden /> },
  { kind: 'sfx', label: 'SFX', icon: <Zap className="h-4 w-4" aria-hidden /> }
];

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';

const BarButton: React.FC<{
  label: string;
  short?: string;
  icon: React.ReactNode;
  onClick(): void;
  vertical: boolean;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  role?: 'radio';
  checked?: boolean;
  badge?: number;
  testId?: string;
}> = ({ label, short, icon, onClick, vertical, disabled, pressed, expanded, role, checked, badge, testId }) => {
  const on = role === 'radio' ? checked : pressed || expanded;
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'radio' ? !!checked : undefined}
      aria-pressed={role === 'radio' || pressed === undefined ? undefined : pressed}
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cx(
        'press relative flex shrink-0 select-none flex-col items-center justify-center gap-0.5 rounded-xl text-[var(--ds-muted)] transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40',
        vertical ? 'h-11 w-11' : 'h-12 min-w-[44px] flex-1 px-1',
        on ? 'bg-[#D97757]/[0.12] text-[var(--ds-ink)]' : 'hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]',
        FOCUS
      )}
    >
      {icon}
      {!vertical && <span className="max-w-full truncate text-[10.5px] font-medium leading-none">{short ?? label}</span>}
      {!!badge && badge > 0 && (
        <span aria-hidden className="absolute right-1 top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-amber-500 px-1 text-[9.5px] font-semibold tabular-nums text-white">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
};

const TrayButton: React.FC<{ label: string; short: string; icon: React.ReactNode; onClick(): void; vertical: boolean; disabled?: boolean; pressed?: boolean; tone?: 'warn'; title?: string }> = ({
  label,
  short,
  icon,
  onClick,
  vertical,
  disabled,
  pressed,
  tone,
  title
}) => (
  <button
    type="button"
    aria-label={label}
    title={title ?? label}
    aria-pressed={pressed}
    disabled={disabled}
    onClick={onClick}
    className={cx(
      'press inline-flex h-11 shrink-0 items-center justify-center gap-1 rounded-xl border text-[12px] font-medium transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40',
      vertical ? 'w-11' : 'px-3',
      pressed ? 'border-[#D97757]/50 bg-[#D97757]/[0.12] text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] hover:bg-[var(--ds-hover)]',
      tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-[var(--ds-ink)]',
      FOCUS
    )}
  >
    {icon}
    {!vertical && <span className="whitespace-nowrap">{short}</span>}
  </button>
);

/** The lettering tray: add balloons and the free whole-page fixes. */
export const LetteringTray: React.FC<LetteringTrayProps & { vertical: boolean }> = ({ addKind, onAddKind, canAdd, onTidy, outsideCount, onFixEdges, hidden, onToggleHidden, vertical }) => (
  <div
    role="toolbar"
    aria-label="Lettering tools"
    aria-orientation={vertical ? 'vertical' : 'horizontal'}
    data-testid="lettering-tray"
    className={cx(
      'flex min-h-0 min-w-0 shrink-0 gap-1.5 bg-[var(--ds-surface)] p-1.5 [scrollbar-width:none]',
      vertical ? 'max-h-full flex-col overflow-y-auto overscroll-y-contain border-r border-[var(--ds-hairline)]' : 'max-w-full overflow-x-auto overscroll-x-contain border-t border-[var(--ds-hairline)]'
    )}
  >
    {ADD.map((a) => (
      <TrayButton
        key={a.kind}
        vertical={vertical}
        icon={a.icon}
        short={a.label}
        label={a.kind === 'sfx' ? 'Add a sound effect' : `Add a ${a.label.toLowerCase()} balloon`}
        title={canAdd ? (addKind === a.kind ? 'Tap the page to place it' : undefined) : 'Add lines in the original language'}
        pressed={addKind === a.kind}
        disabled={!canAdd || hidden}
        onClick={() => onAddKind(addKind === a.kind ? null : a.kind)}
      />
    ))}
    <TrayButton
      vertical={vertical}
      icon={<Wand2 className="h-4 w-4" aria-hidden />}
      short="Tidy"
      label="Tidy the balloons (free)"
      title={onTidy ? 'Re-place the balloons you haven’t moved by hand (free)' : 'Nothing to tidy — every balloon is placed by hand'}
      disabled={!onTidy || hidden}
      onClick={() => onTidy?.()}
    />
    {outsideCount > 0 && (
      <TrayButton
        vertical={vertical}
        tone="warn"
        icon={<Sparkles className="h-4 w-4" aria-hidden />}
        short={`Fix edges (${outsideCount})`}
        label={`Move ${outsideCount} balloon${outsideCount === 1 ? '' : 's'} inside the safe area (free)`}
        disabled={hidden}
        onClick={onFixEdges}
      />
    )}
    <TrayButton
      vertical={vertical}
      icon={hidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
      short={hidden ? 'Show lettering' : 'Hide lettering'}
      label={hidden ? 'Show lettering' : 'Hide lettering'}
      pressed={hidden}
      onClick={onToggleHidden}
    />
  </div>
);

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  orientation,
  mode,
  onModeChange,
  markupDisabled,
  canUndo,
  canRedo,
  undoLabel,
  onUndo,
  onRedo,
  lettering,
  tools,
  tray,
  className
}) => {
  const vertical = orientation === 'vertical';
  const bar = (
    <div
      role="toolbar"
      aria-label="Page editor"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      data-testid="editor-toolbar"
      data-orientation={orientation}
      className={cx(
        'flex shrink-0 bg-[var(--ds-surface-strong)]',
        vertical
          ? 'h-full w-14 flex-col items-center gap-1 overflow-y-auto overscroll-y-contain border-r border-[var(--ds-hairline)] px-1.5 py-1.5 [scrollbar-width:none]'
          : 'w-full items-stretch gap-0.5 border-t border-[var(--ds-hairline)] px-1.5 pt-1'
      )}
      style={vertical ? undefined : { paddingBottom: 'calc(var(--sa-bottom-eff, 0px) + 4px)' }}
    >
      <div role="radiogroup" aria-label="Editing mode" className={cx('flex', vertical ? 'flex-col gap-1' : 'min-w-0 flex-[2] gap-0.5')}>
        <BarButton
          vertical={vertical}
          role="radio"
          checked={mode === 'move'}
          label="Move"
          icon={<MousePointer2 className="h-4 w-4" aria-hidden />}
          onClick={() => onModeChange('move')}
        />
        <BarButton
          vertical={vertical}
          role="radio"
          checked={mode === 'markup'}
          label="Mark up"
          icon={<SquareDashed className="h-4 w-4" aria-hidden />}
          disabled={markupDisabled}
          onClick={() => onModeChange('markup')}
        />
      </div>
      <span aria-hidden className={cx('shrink-0 bg-[var(--ds-hairline)]', vertical ? 'my-0.5 h-px w-8' : 'mx-0.5 my-2 w-px')} />
      <BarButton vertical={vertical} label={undoLabel ? `Undo ${undoLabel}` : 'Undo'} short="Undo" icon={<Undo2 className="h-4 w-4" aria-hidden />} disabled={!canUndo} onClick={onUndo} />
      <BarButton vertical={vertical} label="Redo" icon={<Redo2 className="h-4 w-4" aria-hidden />} disabled={!canRedo} onClick={onRedo} />
      <span aria-hidden className={cx('shrink-0 bg-[var(--ds-hairline)]', vertical ? 'my-0.5 h-px w-8' : 'mx-0.5 my-2 w-px')} />
      {lettering && (
        <BarButton
          vertical={vertical}
          label="Lettering"
          icon={<Type className="h-4 w-4" aria-hidden />}
          expanded={lettering.open}
          disabled={lettering.disabled}
          badge={lettering.attention}
          testId="toolbar-lettering"
          onClick={lettering.onToggle}
        />
      )}
      <BarButton
        vertical={vertical}
        label={tools.open ? 'Hide page tools' : 'Page tools'}
        short="Tools"
        icon={<PanelBottomOpen className={cx('h-4 w-4', vertical && '-rotate-90')} aria-hidden />}
        expanded={tools.open}
        testId="toolbar-tools"
        onClick={tools.onToggle}
      />
    </div>
  );
  const showTray = !!(tray && lettering?.open);
  return (
    <div className={cx('flex min-h-0 min-w-0 shrink-0', vertical ? 'h-full flex-row' : 'w-full flex-col', className)} data-testid="editor-toolbar-host">
      {vertical ? (
        <>
          {bar}
          {showTray && <LetteringTray {...tray!} vertical />}
        </>
      ) : (
        <>
          {showTray && <LetteringTray {...tray!} vertical={false} />}
          {bar}
        </>
      )}
    </div>
  );
};

export default EditorToolbar;
