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
  /** Keep the HUD mounted but non-interactive while hidden. */
  onFocusWithin(): void;
}

export const ReaderHud: React.FC<ReaderHudProps> = (p) => {
  const hidden = !p.visible;
  const bar = 'pointer-events-auto flex items-center gap-1 rounded-full p-1 shadow-[0_8px_30px_rgba(0,0,0,0.35)]';
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
          hidden ? 'pointer-events-none -translate-y-1.5 opacity-0' : 'opacity-100'
        ].join(' ')}
        aria-hidden={hidden ? true : undefined}
      >
        <div className={`${bar} ${glass} min-w-0 max-w-[min(560px,60%)] pr-3`}>
          <HudButton label="Close reader" onClick={p.onClose} tabIndex={hidden ? -1 : 0}>
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
        <div className={`${bar} ${glass} min-w-0 flex-wrap justify-end`}>
          {p.language && p.language.options.length > 1 && (
            <div className="pointer-events-auto" data-no-turn>
              <ReaderLanguagePicker {...p.language} />
            </div>
          )}
          {p.guided.available && (
            <HudButton label={p.guided.on ? 'Leave Guided View' : 'Guided View — panel by panel'} active={p.guided.on} onClick={p.onGuided} tabIndex={hidden ? -1 : 0}>
              <ScanEye className="h-5 w-5" aria-hidden />
              {!p.compact && <span>Guided</span>}
            </HudButton>
          )}
          {p.layout.show && !p.compact && (p.layout.allowSpread || p.layout.effective === 'spread') && (
            <HudButton
              label={p.layout.effective === 'spread' ? 'One page at a time' : 'Facing pages'}
              onClick={() => p.onLayout(p.layout.effective === 'spread' ? 'single' : 'spread')}
              tabIndex={hidden ? -1 : 0}
            >
              {p.layout.effective === 'spread' ? <Square className="h-5 w-5" aria-hidden /> : <Columns2 className="h-5 w-5" aria-hidden />}
            </HudButton>
          )}
          {p.onShare && !p.compact && (
            <HudButton label="Share this comic" onClick={p.onShare} tabIndex={hidden ? -1 : 0}>
              <Share2 className="h-5 w-5" aria-hidden />
            </HudButton>
          )}
          {p.onDownload && !p.compact && (
            <HudButton label={p.downloadBusy ? 'Preparing download…' : 'Download'} onClick={p.onDownload} disabled={p.downloadBusy} tabIndex={hidden ? -1 : 0}>
              <Download className="h-5 w-5" aria-hidden />
            </HudButton>
          )}
          <HudButton label="Reader settings" active={p.settingsOpen} onClick={p.onSettings} tabIndex={hidden ? -1 : 0} aria-haspopup="dialog" aria-expanded={p.settingsOpen}>
            <Settings2 className="h-5 w-5" aria-hidden />
          </HudButton>
          {p.fullscreen.supported && (
            <HudButton label={p.fullscreen.on ? 'Exit full screen' : 'Full screen'} onClick={p.onFullscreen} tabIndex={hidden ? -1 : 0}>
              {p.fullscreen.on ? <Minimize2 className="h-5 w-5" aria-hidden /> : <Maximize2 className="h-5 w-5" aria-hidden />}
            </HudButton>
          )}
        </div>
      </div>

      <div
        className={[
          'absolute inset-x-0 bottom-0 flex justify-center px-[max(12px,var(--sa-left))] pr-[max(12px,var(--sa-right))] pb-[max(10px,var(--sa-bottom))]',
          'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-opacity',
          hidden ? 'pointer-events-none translate-y-1.5 opacity-0' : 'opacity-100'
        ].join(' ')}
        aria-hidden={hidden ? true : undefined}
      >
        {p.guided.on ? (
          <div className={`${bar} ${glass}`} data-no-turn>
            <HudButton label={p.rtl ? 'Next panel' : 'Previous panel'} onClick={() => p.onPanel(p.rtl ? 1 : -1)} tabIndex={hidden ? -1 : 0}>
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </HudButton>
            <HudButton label={p.guided.playing ? 'Pause' : 'Play panel by panel'} active={p.guided.playing} onClick={p.onPlay} tabIndex={hidden ? -1 : 0}>
              {p.guided.playing ? <Pause className="h-5 w-5" aria-hidden /> : <Play className="h-5 w-5" aria-hidden />}
            </HudButton>
            <span className="min-w-[6.5rem] px-1 text-center text-[12px] tabular-nums text-white/85">{p.guided.label}</span>
            <HudButton label={p.rtl ? 'Previous panel' : 'Next panel'} onClick={() => p.onPanel(p.rtl ? -1 : 1)} tabIndex={hidden ? -1 : 0}>
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
