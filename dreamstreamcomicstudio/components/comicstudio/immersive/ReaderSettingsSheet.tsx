// Reader settings (reader.md §2.2): the viewer's own preferences, layered over the creator's choices.
// A glass panel inside the reading room (top-right on wide screens, a bottom sheet on phones),
// so it never fights the page for contrast. Everything here is local to this device.

import React from 'react';
import { Download, Keyboard, Share2, X } from 'lucide-react';
import type { ReaderSettings } from '../../../shared/comic/doc';
import type { LayoutPref } from './readerLayout';
import type { ReaderPrefs, RoomLight, Tri, Wpm } from './readerPrefs';
import { HudButton } from './ReaderHud';

export interface ReaderSettingsSheetProps {
  open: boolean;
  compact: boolean;
  prefs: ReaderPrefs;
  onPrefs(patch: Partial<ReaderPrefs>): void;
  creator: ReaderSettings;
  layout: { pref: LayoutPref; allowSpread: boolean; options: LayoutPref[] };
  onLayout(pref: LayoutPref): void;
  lowPower: { on: boolean; measured: boolean };
  osReducedMotion: boolean;
  onShortcuts(): void;
  onClose(): void;
  onShare?: () => void;
  onDownload?: () => void;
  downloadBusy?: boolean;
}

function Choice<T extends string | number>({ label, value, options, onChange, hint }: { label: string; value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange(v: T): void; hint?: string }) {
  const name = React.useId();
  return (
    <fieldset className="min-w-0 space-y-1.5">
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
      {hint && <p className="text-[11px] leading-snug text-[var(--ds-reader-hud-muted)]">{hint}</p>}
    </fieldset>
  );
}

const Toggle: React.FC<{ label: string; checked: boolean; onChange(v: boolean): void; hint?: string }> = ({ label, checked, onChange, hint }) => (
  <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
    <span className="min-w-0">
      <span className="block text-[13px]">{label}</span>
      {hint && <span className="block text-[11px] leading-snug text-[var(--ds-reader-hud-muted)]">{hint}</span>}
    </span>
    <span className="relative inline-flex shrink-0 items-center">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span className="h-6 w-11 rounded-full bg-[var(--ds-reader-hud-active)] transition-colors peer-checked:bg-[var(--ds-reader-accent)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ds-reader-hud-focus)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--ds-reader-hud-inverse)]" />
      <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--ds-reader-hud-ink)] shadow transition-transform peer-checked:translate-x-5 peer-checked:bg-[var(--ds-reader-hud-inverse)] motion-reduce:transition-none" />
    </span>
  </label>
);

const triFrom = (on: boolean, creator: boolean): Tri => (on === creator ? 'auto' : on ? 'on' : 'off');
const triValue = (t: Tri, creator: boolean) => (t === 'on' ? true : t === 'off' ? false : creator);

const TURN_LABEL: Record<ReaderSettings['turn'], string> = { paper: 'Paper', slide: 'Slide', fade: 'Fade' };
const LAYOUT_LABEL: Record<LayoutPref, string> = { auto: 'Auto', single: 'One page', spread: 'Facing', scroll: 'Scroll' };

export const ReaderSettingsSheet: React.FC<ReaderSettingsSheetProps> = (p) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (p.open) ref.current?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
  }, [p.open]);
  if (!p.open) return null;
  const { prefs, creator } = p;
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
        <Choice<RoomLight>
          label="Room light"
          value={prefs.room}
          onChange={(room) => p.onPrefs({ room })}
          options={[
            { value: 'night', label: 'Night' },
            { value: 'day', label: 'Day' }
          ]}
        />
        <Choice<'auto' | ReaderSettings['turn']>
          label="Page turns"
          value={prefs.turn}
          onChange={(turn) => p.onPrefs({ turn })}
          options={[
            { value: 'auto', label: `Auto (${TURN_LABEL[creator.turn]})`, title: 'The creator’s choice' },
            { value: 'paper', label: 'Paper' },
            { value: 'slide', label: 'Slide' },
            { value: 'fade', label: 'Fade' }
          ]}
          hint={p.lowPower.on && prefs.fancyTurns !== 'on' ? 'Pages slide on this device to keep turns smooth.' : undefined}
        />
        {p.layout.options.length > 1 && (
          <Choice<LayoutPref>
            label="Layout"
            value={p.layout.pref}
            onChange={p.onLayout}
            options={p.layout.options.map((o) => ({
              value: o,
              label: LAYOUT_LABEL[o],
              disabled: o === 'spread' && !p.layout.allowSpread,
              title: o === 'spread' && !p.layout.allowSpread ? 'Facing pages need a wider screen' : undefined
            }))}
            hint={!p.layout.allowSpread ? 'Facing pages appear on wider screens (turn your tablet sideways).' : undefined}
          />
        )}
        <Choice<Tri>
          label="Fancy page turns"
          value={prefs.fancyTurns}
          onChange={(fancyTurns) => p.onPrefs({ fancyTurns })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' }
          ]}
          hint={p.lowPower.measured && prefs.fancyTurns === 'auto' ? 'Turned off automatically: the first turn looked slow on this device.' : undefined}
        />
        <div className="divide-y divide-[var(--ds-reader-hud-wash)]">
          <Toggle label="Paper texture" checked={triValue(prefs.paper, creator.paperTexture)} onChange={(v) => p.onPrefs({ paper: triFrom(v, creator.paperTexture) })} />
          <Toggle label="Room glows with the page’s colours" checked={triValue(prefs.ambient, creator.ambient)} onChange={(v) => p.onPrefs({ ambient: triFrom(v, creator.ambient) })} />
          <Toggle label="Page-turn sound" checked={prefs.sound} onChange={(sound) => p.onPrefs({ sound })} />
          <Toggle
            label="Reduce motion"
            checked={prefs.reduceMotion || p.osReducedMotion}
            onChange={(reduceMotion) => p.onPrefs({ reduceMotion })}
            hint={p.osReducedMotion ? 'On in your device settings: pages crossfade.' : 'Pages crossfade instead of turning.'}
          />
        </div>
        <div className="space-y-2 rounded-2xl bg-[var(--ds-reader-hud-wash)] p-3">
          <p className="text-[12px] font-medium text-[var(--ds-reader-hud-muted)]">Guided View</p>
          <Toggle label="Show the whole page first" checked={triValue(prefs.guidedOverview, creator.guidedOverview)} onChange={(v) => p.onPrefs({ guidedOverview: triFrom(v, creator.guidedOverview) })} />
          <Toggle label="Balloons appear one by one" checked={prefs.balloonPop} onChange={(balloonPop) => p.onPrefs({ balloonPop })} />
          <Choice<Wpm>
            label="Play speed"
            value={prefs.wpm}
            onChange={(wpm) => p.onPrefs({ wpm })}
            options={[
              { value: 170, label: 'Slow' },
              { value: 210, label: 'Normal' },
              { value: 260, label: 'Fast' }
            ]}
          />
        </div>
        <button type="button" onClick={p.onShortcuts} className="press inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ds-reader-hud-wash)] text-[13px] outline-none hover:bg-[var(--ds-reader-hud-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-hud-focus)]">
          <Keyboard className="h-4 w-4" aria-hidden /> Keyboard shortcuts
        </button>
      </div>
    </div>
  );
};

export default ReaderSettingsSheet;
