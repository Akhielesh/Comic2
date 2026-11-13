// Reader HUD (reader.md §2.2): glass chips follow the room lighting. Top: close, title and position,
// then language, layout, settings and fullscreen. Bottom: the page scrubber.
// Auto-hides; padding follows safe areas; every control is ≥ 44 px.

import React from 'react';
import { Columns2, Download, Maximize2, Minimize2, Settings2, Share2, Square, X } from 'lucide-react';
import { ReaderLanguagePicker, type ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';
import type { LayoutPref } from './readerLayout';

export const glass = 'bg-[var(--ds-reader-glass)] text-[var(--ds-reader-hud-ink)] backdrop-blur-md';

export const HudButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; children: React.ReactNode }
> = ({ label, active, children, className, ...rest }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={active === undefined ? undefined : active}
    className={[
      'press inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium outline-none transition-colors',
      'focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-hud-focus)] disabled:opacity-40',
      active ? 'bg-[var(--ds-reader-hud-active)]' : 'hover:bg-[var(--ds-reader-hud-hover)]',
      className || ''
    ].join(' ')}
    {...rest}
  >
    {children}
  </button>
);

export interface ReaderHudProps {
  visible: boolean;
  title: string;
  counter: string;
  chapter?: string;
  compact: boolean;
  language?: ReaderLanguageSlot;
  layout: { effective: 'single' | 'spread' | 'scroll' | 'strip'; allowSpread: boolean; show: boolean };
  onLayout(pref: LayoutPref): void;
  onSettings(): void;
  settingsOpen: boolean;
  fullscreen: { on: boolean; supported: boolean };
  onFullscreen(): void;
  onClose(): void;
  onShare?: () => void;
  onDownload?: () => void;
  downloadBusy?: boolean;
  scrubber: React.ReactNode;
  /** The HUD fades but stays in the accessibility tree; keyboard focus brings it back. */
  onFocusWithin(): void;
}

/**
 * While hidden, nothing in a HUD row takes a tap: the rows are pointer-events-none AND so is every
 * descendant (the bars, the language picker and the host's scrubber set pointer-events-auto on
 * themselves, which would otherwise win). A tap on an invisible "Close reader" must never close the
 * reader — it falls through to the stage, which brings the HUD back. Keyboard focus still reaches the
 * controls (no `inert`): focusing one shows the HUD again (onFocusWithin).
 */
export const HUD_HIDDEN_ROW = 'pointer-events-none [&_*]:!pointer-events-none';

/**
 * The HUD rows show and hide on the reader motion tokens (reader.md §5.1): the skinned --ds-motion-medium and
 * --ds-ease, opacity and transform only; reduced motion keeps the opacity fade alone.
 */
export const HUD_ROW_MOTION = 'transition-[opacity,transform] duration-[var(--ds-reader-hud-motion)] ease-[var(--ds-ease)] motion-reduce:transition-opacity';

export const ReaderHud: React.FC<ReaderHudProps> = (p) => {
  const hidden = !p.visible;
  const bar = `${hidden ? 'pointer-events-none' : 'pointer-events-auto'} flex items-center gap-1 rounded-full p-1 shadow-[0_8px_30px_rgba(0,0,0,0.35)]`;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[40]"
      data-testid="reader-hud"
      data-visible={p.visible ? 'true' : 'false'}
      onFocusCapture={p.onFocusWithin}
    >
      <div
        className={[
          'absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-[max(12px,var(--sa-left))] pr-[max(12px,var(--sa-right))] pt-[max(10px,var(--sa-top))]',
          HUD_ROW_MOTION,
          hidden ? `${HUD_HIDDEN_ROW} -translate-y-1.5 opacity-0` : 'opacity-100'
        ].join(' ')}
      >
        {/* The title chip gives way (truncates) so the controls never wrap or overflow, even at 320 px. */}
        <div className={`${bar} ${glass} min-w-0 max-w-[min(560px,60%)] shrink pr-3`}>
          <HudButton label="Close reader" onClick={p.onClose}>
            <X className="h-5 w-5" aria-hidden />
          </HudButton>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[13px] font-semibold">{p.title}</p>
            <p className="truncate text-[11px] tabular-nums text-[var(--ds-reader-hud-muted)]" data-testid="reader-hud-counter">
              {p.counter}
              {p.chapter ? ` · ${p.chapter}` : ''}
            </p>
          </div>
        </div>
        <div className={`${bar} ${glass} shrink-0 justify-end`}>
          {p.language && p.language.options.length > 1 && (
            <div className={`${hidden ? 'pointer-events-none' : 'pointer-events-auto'} min-w-0`} data-no-turn>
              <ReaderLanguagePicker {...p.language} compact={p.compact} />
            </div>
          )}
          {p.layout.show && !p.compact && (p.layout.allowSpread || p.layout.effective === 'spread') && (
            <HudButton
              label={p.layout.effective === 'spread' ? 'One page at a time' : 'Facing pages'}
              onClick={() => p.onLayout(p.layout.effective === 'spread' ? 'single' : 'spread')}
            >
              {p.layout.effective === 'spread' ? <Square className="h-5 w-5" aria-hidden /> : <Columns2 className="h-5 w-5" aria-hidden />}
            </HudButton>
          )}
          {p.onShare && !p.compact && (
            <HudButton label="Share this comic" onClick={p.onShare}>
              <Share2 className="h-5 w-5" aria-hidden />
            </HudButton>
          )}
          {p.onDownload && !p.compact && (
            <HudButton label={p.downloadBusy ? 'Preparing download…' : 'Download'} onClick={p.onDownload} disabled={p.downloadBusy}>
              <Download className="h-5 w-5" aria-hidden />
            </HudButton>
          )}
          <HudButton label="Reader settings" active={p.settingsOpen} onClick={p.onSettings} aria-haspopup="dialog" aria-expanded={p.settingsOpen}>
            <Settings2 className="h-5 w-5" aria-hidden />
          </HudButton>
          {p.fullscreen.supported && (
            <HudButton label={p.fullscreen.on ? 'Exit full screen' : 'Full screen'} onClick={p.onFullscreen}>
              {p.fullscreen.on ? <Minimize2 className="h-5 w-5" aria-hidden /> : <Maximize2 className="h-5 w-5" aria-hidden />}
            </HudButton>
          )}
        </div>
      </div>

      <div
        className={[
          'absolute inset-x-0 bottom-0 flex justify-center px-[max(12px,var(--sa-left))] pr-[max(12px,var(--sa-right))] pb-[max(10px,var(--sa-bottom))]',
          HUD_ROW_MOTION,
          hidden ? `${HUD_HIDDEN_ROW} translate-y-1.5 opacity-0` : 'opacity-100'
        ].join(' ')}
      >
        {p.scrubber}
      </div>
    </div>
  );
};

export default ReaderHud;
