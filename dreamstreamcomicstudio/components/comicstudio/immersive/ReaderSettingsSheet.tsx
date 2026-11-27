// Reader settings (reader.md §2.2): the viewer's own preferences, layered over the creator's choices.
// A glass panel inside the reading room (top-right on wide screens, a bottom sheet on phones),
// so it never fights the page for contrast. Everything here is local to this device.

import React from 'react';
import { Download, Keyboard, Share2, X } from 'lucide-react';
import type { PageTurnStyle } from '../../../shared/comic/doc';
import type { LayoutPref } from './readerLayout';
import { PAGE_TURN_OPTIONS, pageTurnLabel, turnStyleFor, type ReaderPrefs, type RoomLight } from './readerPrefs';
import { HudButton } from './ReaderHud';
import { lighterOnLowPower } from './turnPlan';

export interface ReaderSettingsSheetProps {
  open: boolean;
  compact: boolean;
  prefs: ReaderPrefs;
  onPrefs(patch: Partial<ReaderPrefs>): void;
  layout: { pref: LayoutPref; canTurnPages: boolean };
  onLayout(pref: LayoutPref): void;
  /** The creator's page-turn style (creatorTurnOf): marked in the picker, and picking it follows the creator again. */
  creatorTurn: PageTurnStyle;
  lowPower: boolean;
  osReducedMotion: boolean;
  onShortcuts(): void;
  onClose(): void;
  onShare?: () => void;
  pageNumber?: number;
  onCopyPageLink?(n: number): void;
  onDownload?: () => void;
  downloadBusy?: boolean;
}

function Choice<T extends string | number>({ label, value, options, onChange, hint }: { label: string; value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange(v: T): void; hint?: string }) {
  const name = React.useId();
  return (
    <fieldset className="min-w-0 space-y-1.5" aria-describedby={hint ? name + '-hint' : undefined}>
      <legend className="mb-1 text-[12px] font-medium text-[var(--ds-reader-hud-muted)]">{label}</legend>
      <div className="flex flex-wrap gap-1 rounded-2xl bg-[var(--ds-reader-hud-wash)] p-1">
        {options.map((o) => (
          <label
            key={String(o.value)}
            title={o.title}
            className="relative min-w-0 flex-1"
          >
            <input type="radio" name={name} className="peer sr-only" checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} />
            <span className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl px-2.5 text-center text-[13px] hover:bg-[var(--ds-reader-hud-hover)] peer-checked:bg-[var(--ds-reader-hud-ink)] peer-checked:text-[var(--ds-reader-hud-inverse)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ds-reader-hud-focus)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--ds-reader-hud-inverse)] peer-disabled:cursor-default peer-disabled:opacity-40">
              {o.label}
            </span>
          </label>
        ))}
      </div>
      {hint && <p id={name + '-hint'} className="text-[11px] leading-snug text-[var(--ds-reader-hud-muted)]">{hint}</p>}
    </fieldset>
  );
}

const Toggle: React.FC<{ label: string; checked: boolean; onChange(v: boolean): void; hint?: string; disabled?: boolean }> = ({ label, checked, onChange, hint, disabled }) => (
  <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
    <span className="min-w-0">
      <span className="block text-[13px]">{label}</span>
      {hint && <span className="block text-[11px] leading-snug text-[var(--ds-reader-hud-muted)]">{hint}</span>}
    </span>
    <span className="relative inline-flex shrink-0 items-center">
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span className="h-6 w-11 rounded-full bg-[var(--ds-reader-hud-active)] transition-colors peer-checked:bg-[var(--ds-reader-accent)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ds-reader-hud-focus)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--ds-reader-hud-inverse)]" />
      <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--ds-reader-hud-ink)] shadow transition-transform peer-checked:translate-x-5 peer-checked:bg-[var(--ds-reader-hud-inverse)] motion-reduce:transition-none" />
    </span>
  </label>
);

export const ReaderSettingsSheet: React.FC<ReaderSettingsSheetProps> = (p) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (p.open) ref.current?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
  }, [p.open]);
  if (!p.open) return null;
  const { prefs } = p;
  const reduced = prefs.reduceMotion || p.osReducedMotion;
  const turn = turnStyleFor({ turn: p.creatorTurn, turnChosen: true }, prefs.turn);
  let modeHint = turn === 'paper' ? 'Drag a page edge or use the arrows to turn the page.' : 'Swipe, tap a page edge or use the arrows to turn the page.';
  if (p.layout.pref === 'scroll') modeHint = 'Read down the comic.';
  else if (reduced) modeHint = 'Use the arrows or swipe. Reduced motion is on.';
  // Only a style that low power lightens (the paper and the fade slide) says so; the flip and the slide play unchanged.
  else if (p.lowPower && lighterOnLowPower(turn)) modeHint = 'Use the arrows or swipe. A lighter transition keeps pages responsive.';
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label="Reader settings"
      data-no-turn
      data-testid="reader-settings"
      className={[
        'pointer-events-auto absolute z-[60] overflow-y-auto overscroll-contain rounded-3xl bg-[var(--ds-reader-panel)] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl',
        p.compact
          ? 'inset-x-[max(8px,var(--sa-left))] bottom-[max(8px,var(--sa-bottom))] max-h-[min(78vh,calc(100%-24px))]'
          : 'right-[max(12px,var(--sa-right))] top-[calc(max(10px,var(--sa-top))+60px)] max-h-[calc(100%-96px)] w-[min(360px,calc(100%-24px))]'
      ].join(' ')}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Reader settings</h2>
        <HudButton label="Close settings" onClick={p.onClose}>
          <X className="h-5 w-5" aria-hidden />
        </HudButton>
      </div>
      <div className="space-y-4">
        {p.layout.canTurnPages ? (
          <Choice<'turn' | 'scroll'>
            label="Reading mode"
            value={p.layout.pref === 'scroll' ? 'scroll' : 'turn'}
            onChange={(mode) => {
              // Back to turning pages: the turn style the reader picked (or the creator's) stays as it is.
              if (mode === 'turn') p.onPrefs({ fancyTurns: 'auto' });
              p.onLayout(mode === 'scroll' ? 'scroll' : 'auto');
            }}
            options={[{ value: 'turn', label: 'Page turn' }, { value: 'scroll', label: 'Scroll' }]}
            hint={modeHint}
          />
        ) : <p className="text-[13px]">Scroll down to read this continuous page.</p>}
        {p.layout.canTurnPages && p.layout.pref !== 'scroll' && (
          <Choice<PageTurnStyle>
            label="Page turn style"
            value={turn}
            // Picking the creator's own style follows the creator again ('auto'), so a later change of theirs reaches you.
            onChange={(next) => p.onPrefs(next === p.creatorTurn ? { turn: 'auto' } : { turn: next, turnPicked: true })}
            options={PAGE_TURN_OPTIONS.map(({ value, label, title }) => ({ value, label, title: value === p.creatorTurn ? `${title} (this comic’s own style)` : title }))}
            // Said on screen (and read with the group): which style is the comic's own, so a phone shows it too.
            hint={`${pageTurnLabel(p.creatorTurn)} is this comic’s own style.${reduced ? ' Reduced motion is on: pages change at once.' : ''}`}
          />
        )}
        {p.onCopyPageLink && !!p.pageNumber && p.pageNumber > 0 && (
          <button type="button" onClick={() => p.onCopyPageLink?.(p.pageNumber!)} className="press min-h-11 w-full rounded-xl bg-[var(--ds-reader-hud-hover)] text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-hud-focus)]">
            Copy link to page {p.pageNumber}
          </button>
        )}
        {p.compact && (p.onShare || p.onDownload) && (
          <div className="flex gap-2">
            {p.onShare && (
              <button type="button" onClick={p.onShare} className="press inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--ds-reader-hud-hover)] text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-hud-focus)]">
                <Share2 className="h-4 w-4" aria-hidden /> Share
              </button>
            )}
            {p.onDownload && (
              <button type="button" onClick={p.onDownload} disabled={p.downloadBusy} className="press inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--ds-reader-hud-hover)] text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-hud-focus)] disabled:opacity-50">
                <Download className="h-4 w-4" aria-hidden /> {p.downloadBusy ? 'Preparing…' : 'Download'}
              </button>
            )}
          </div>
        )}
        <details className="rounded-xl bg-[var(--ds-reader-hud-wash)] px-3">
          <summary className="min-h-11 cursor-pointer rounded-lg py-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-hud-focus)]">Display and accessibility</summary>
          <div className="space-y-3 pb-3">
            <Choice<RoomLight>
              label="Room light"
              value={prefs.room}
              onChange={(room) => p.onPrefs({ room })}
              options={[
                { value: 'night', label: 'Night' },
                { value: 'day', label: 'Day' }
              ]}
            />
            <div className="divide-y divide-[var(--ds-reader-hud-wash)]">
              <Toggle label="Page-turn sound" checked={prefs.sound} onChange={(sound) => p.onPrefs({ sound })} />
              <Toggle
                label="Reduce motion"
                checked={prefs.reduceMotion || p.osReducedMotion}
                onChange={(reduceMotion) => p.onPrefs({ reduceMotion })}
                disabled={p.osReducedMotion}
                hint={p.osReducedMotion ? 'Enabled in your device settings.' : 'Use a gentle crossfade.'}
              />
            </div>
            <button type="button" onClick={p.onShortcuts} className="press inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ds-reader-hud-wash)] text-[13px] outline-none hover:bg-[var(--ds-reader-hud-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-hud-focus)]">
              <Keyboard className="h-4 w-4" aria-hidden /> Keyboard shortcuts
            </button>
          </div>
        </details>
      </div>
    </div>
  );
};

export default ReaderSettingsSheet;
