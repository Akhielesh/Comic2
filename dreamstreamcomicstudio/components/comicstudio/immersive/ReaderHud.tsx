// Reader HUD (reader.md §2.2): dark glass chips over the room, so contrast never depends on the page's
// ambient colour. Top: close, title and position, then language, Guided View, layout, settings and full
// screen. Bottom: the page scrubber (or panel controls in Guided View). Auto-hides; padding follows
// the safe areas; every control is ≥ 44 px.

import React from 'react';
import { ChevronLeft, ChevronRight, Columns2, Download, Maximize2, Minimize2, Pause, Play, ScanEye, Settings2, Share2, Square, X } from 'lucide-react';
import { ReaderLanguagePicker, type ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';
import type { LayoutPref } from './readerLayout';

export const glass = 'bg-black/45 text-white backdrop-blur-md';

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
      'focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] disabled:opacity-40',
      active ? 'bg-white/25 text-white' : 'text-white/90 hover:bg-white/15',
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
  guided: { on: boolean; playing: boolean; available: boolean; label?: string };
  onGuided(): void;
  onPlay(): void;
  onPanel(delta: 1 | -1): void;
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
  rtl: boolean;
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
          'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-opacity',
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
            <p className="truncate text-[11px] tabular-nums text-white/75" data-testid="reader-hud-counter">
              {p.counter}
              {p.chapter ? ` · ${p.chapter}` : ''}
            </p>
          </div>
        </div>
        <div className={`${bar} ${glass} shrink-0 justify-end`}>
          {p.language && p.language.options.length > 1 && (
            <div className={`${hidden ? 'pointer-events-none' : 'pointer-events-auto'} min-w-0`} data-no-turn>
              {/* Phones: globe-only trigger, so close + language + guided + settings + full screen fit at 320 px. */}
              <ReaderLanguagePicker {...p.language} compact={p.compact} />
            </div>
          )}
          {p.guided.available && (
            <HudButton label={p.guided.on ? 'Leave Guided View' : 'Guided View — panel by panel'} active={p.guided.on} onClick={p.onGuided}>
              <ScanEye className="h-5 w-5" aria-hidden />
              {!p.compact && <span>Guided</span>}
            </HudButton>
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
          'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-opacity',
          hidden ? `${HUD_HIDDEN_ROW} translate-y-1.5 opacity-0` : 'opacity-100'
        ].join(' ')}
      >
        {p.guided.on ? (
          <div className={`${bar} ${glass}`} data-no-turn>
            <HudButton label={p.rtl ? 'Next panel' : 'Previous panel'} onClick={() => p.onPanel(p.rtl ? 1 : -1)}>
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </HudButton>
            <HudButton label={p.guided.playing ? 'Pause' : 'Play panel by panel'} active={p.guided.playing} onClick={p.onPlay}>
              {p.guided.playing ? <Pause className="h-5 w-5" aria-hidden /> : <Play className="h-5 w-5" aria-hidden />}
            </HudButton>
            <span className="min-w-[6.5rem] px-1 text-center text-[12px] tabular-nums text-white/85">{p.guided.label}</span>
            <HudButton label={p.rtl ? 'Previous panel' : 'Next panel'} onClick={() => p.onPanel(p.rtl ? -1 : 1)}>
              <ChevronRight className="h-5 w-5" aria-hidden />
            </HudButton>
          </div>
        ) : (
          p.scrubber
        )}
      </div>
    </div>
  );
};

export default ReaderHud;
