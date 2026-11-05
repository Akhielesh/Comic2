// Reader language picker (contract §13.3, i18n.md §11.2). Owner: P1-I18N.
//
// A globe button showing the current language in its own script (తెలుగు) opens a listbox:
// endonym, English name, "Original" on the source. Arrow keys / Home / End move, Enter or Space
// picks, Esc closes and returns focus. The trigger inherits its colour, so it reads on the dark
// reader HUD and on the light studio alike; the list is a calm-glass surface. 44 px touch targets,
// fits from 320 px, respects reduced motion. Renders nothing with fewer than two languages.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { dirOf, sameLanguage } from '../../../shared/comic/languages';
import { readerString } from './readerStrings';

/** What a reader surface needs to offer a language switch (also ImmersiveReader's `language`). */
export interface ReaderLanguageSlot {
  current: string;
  /** `percent` (0–100) marks a draft edition in the owner preview: "92% translated". */
  options: { code: string; label: string; native?: string; status?: 'ready'; percent?: number }[];
  onChange(code: string): void;
}

export type ReaderLanguagePickerProps = ReaderLanguageSlot & {
  /** The comic's own language (shows the "Original" tag). Default: the first option. */
  source?: string;
  /** Hide the endonym next to the globe (icon-only trigger for very tight bars). */
  compact?: boolean;
  className?: string;
};

const cx = (...p: Array<string | false | null | undefined>) => p.filter(Boolean).join(' ');

export const ReaderLanguagePicker: React.FC<ReaderLanguagePickerProps> = ({ current, options, onChange, source, compact, className }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** px from the trigger's left edge to the list's left edge (null = right-aligned fallback). */
  const [offset, setOffset] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const original = source ?? options[0]?.code;
  const currentIndex = Math.max(0, options.findIndex((o) => sameLanguage(o.code, current)));
  const currentOpt = options[currentIndex];
  const strings = useMemo(() => ({ language: readerString(current, 'language'), original: readerString(current, 'original'), choose: readerString(current, 'chooseLanguage') }), [current]);
  const percentLabel = (n: number) => readerString(current, 'translatedPercent', { n });

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    setActive(currentIndex);
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, currentIndex, close]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  if (options.length < 2) return null;

  /**
   * Open the list where it fits: it prefers to hang from the trigger's right edge, but is shifted so
   * it always stays ≥ 16 px inside the viewport — a picker near the LEFT edge of a 320 px screen
   * would otherwise push a right-aligned 288 px list off-screen.
   */
  const openList = () => {
    const r = rootRef.current?.getBoundingClientRect();
    const vw = typeof window !== 'undefined' ? window.innerWidth || document.documentElement.clientWidth : 0;
    if (r && vw > 0) {
      const listW = Math.min(288, vw - 32);
      const left = Math.min(Math.max(r.right - listW, 16), Math.max(16, vw - 16 - listW));
      setOffset(Math.round(left - r.left));
    } else setOffset(null);
    setOpen(true);
  };

  const pick = (i: number) => {
    const opt = options[i];
    if (!opt) return;
    close();
    if (!sameLanguage(opt.code, current)) onChange(opt.code);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(options.length - 1, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(active);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  };

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openList();
    }
  };

  const shown = currentOpt?.native || currentOpt?.label || current;
  return (
    <div ref={rootRef} className={cx('relative inline-flex min-w-0', className)} data-no-turn>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${strings.language}: ${currentOpt?.label || current}`}
        title={strings.choose}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onButtonKey}
        className="inline-flex min-h-[44px] min-w-[44px] max-w-[12rem] items-center justify-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium text-inherit transition-colors duration-150 hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/60 motion-reduce:transition-none"
      >
        <Globe className="h-[18px] w-[18px] shrink-0" aria-hidden />
        {!compact && (
          <span lang={currentOpt?.code} dir={dirOf(currentOpt?.code)} className="min-w-0 truncate">
            {shown}
          </span>
        )}
        <ChevronDown className={cx('h-3.5 w-3.5 shrink-0 opacity-70 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={strings.choose}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          style={offset === null ? undefined : { left: offset }}
          className={cx(offset === null && 'right-0', 'absolute top-full z-50 mt-1.5 max-h-[min(22rem,60vh)] w-[min(18rem,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-1.5 text-[var(--ds-ink)] shadow-[0_12px_40px_rgba(0,0,0,0.18)] backdrop-blur-xl focus:outline-none')}
        >
          {options.map((o, i) => {
            const selected = sameLanguage(o.code, current);
            const isOriginal = !!original && sameLanguage(o.code, original);
            return (
              <li
                key={o.code}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={selected}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(i)}
                className={cx(
                  'flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5',
                  i === active ? 'bg-[var(--ds-hover)]' : '',
                  selected && 'font-semibold'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span lang={o.code} dir={dirOf(o.code)} className="block break-words text-[15px] leading-snug">
                    {o.native || o.label}
                  </span>
                  {o.native && o.native !== o.label && <span className="block text-[11.5px] text-[var(--ds-muted)]">{o.label}</span>}
                  {o.status !== 'ready' && typeof o.percent === 'number' && o.percent < 100 && (
                    <span className="block text-[11.5px] tabular-nums text-[var(--ds-muted)]">{percentLabel(Math.max(0, Math.round(o.percent)))}</span>
                  )}
                </span>
                {isOriginal && (
                  <span className="shrink-0 rounded-full border border-[var(--ds-hairline)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--ds-muted)]">{strings.original}</span>
                )}
                <Check className={cx('h-4 w-4 shrink-0 text-[var(--ds-accent)]', !selected && 'invisible')} aria-hidden />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default ReaderLanguagePicker;
