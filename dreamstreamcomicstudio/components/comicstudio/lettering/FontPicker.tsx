// Font picker (lettering.md §7.4): every self-hosted lettering face, each name shown in its own face
// (loaded lazily when the list opens), with its licence badge and role. Faces that do not cover the
// comic's script say so honestly ("Telugu uses Noto Sans Telugu"). Easy view: six friendly chips.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { FONT_REGISTRY, fontCoversLanguage, fontFamilyStack, resolveLetteringFont } from '../../../shared/comic/lettering/fonts';
import type { FontId, LatinFontId } from '../../../shared/comic/lettering/style';
import { languageSpec } from '../../../shared/comic/languages';
import { ensureFonts } from './fontLoader';
import { cx } from '../board/ui';

const ROLE: Record<LatinFontId, string> = {
  'comic-neue': 'Classic dialogue',
  bangers: 'Sound effects, shouts',
  'patrick-hand': 'Handwritten',
  kalam: 'Handwritten · Hindi',
  'shantell-sans': 'Manga, webtoon',
  andika: 'Early readers',
  atkinson: 'Most legible',
  'luckiest-guy': 'Kids titles, SFX',
  'permanent-marker': 'Marker, indie',
  'special-elite': 'Typewriter captions',
  ultra: 'Retro display',
  'dela-gothic-one': 'Manga SFX'
};
export const LATIN_FONTS: LatinFontId[] = [
  'comic-neue', 'andika', 'atkinson', 'patrick-hand', 'kalam', 'shantell-sans',
  'bangers', 'luckiest-guy', 'permanent-marker', 'special-elite', 'ultra', 'dela-gothic-one'
];
/** The Easy view's friendly six. */
export const EASY_FONTS: LatinFontId[] = ['comic-neue', 'andika', 'patrick-hand', 'shantell-sans', 'atkinson', 'bangers'];

const labelOf = (id: FontId) => FONT_REGISTRY[id]?.label ?? id;

export interface FontPickerProps {
  value: FontId | undefined;
  onChange(id: FontId): void;
  /** The lettering language (script coverage notes). */
  lang: string;
  /** Easy chips instead of the full list. */
  simple?: boolean;
  label?: string;
}

export const FontPicker: React.FC<FontPickerProps> = ({ value, onChange, lang, simple, label = 'Font' }) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const spec = languageSpec(lang);
  // Script faces the comic's language can use (non-Latin languages only).
  const options: FontId[] = useMemo(() => {
    const extra = spec && spec.script !== 'Latn' ? [...new Set([spec.fonts.dialogue, spec.fonts.legible, spec.fonts.sfx])].filter((f) => !LATIN_FONTS.includes(f as LatinFontId)) : [];
    return [...extra, ...LATIN_FONTS];
  }, [spec]);
  const shown = simple ? EASY_FONTS : options;

  // Load the faces for the previews when the list is visible (free; files are cached).
  useEffect(() => {
    if (simple || open) void ensureFonts(shown, { weights: [400, 700] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, simple]);
  useEffect(() => {
    if (!open) return;
    const i = Math.max(0, options.indexOf(value as FontId));
    setActive(i);
    listRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const note = (f: FontId): string | undefined => {
    if (!spec || spec.script === 'Latn' || fontCoversLanguage(f, lang)) return undefined;
    const used = resolveLetteringFont(f, 'speech', lang);
    return `${spec.english} text uses ${labelOf(used.fontId)}`;
  };

  if (simple) {
    return (
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {EASY_FONTS.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={value === f}
            title={`${labelOf(f)} — ${ROLE[f as LatinFontId]}${note(f) ? ` (${note(f)})` : ''}`}
            onClick={() => onChange(f)}
            className={cx(
              'tap-target rounded-full border px-2.5 py-1 text-[13px] leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50',
              value === f ? 'border-[#D97757]/60 bg-[#D97757]/10 text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]'
            )}
            style={{ fontFamily: fontFamilyStack(f) }}
          >
            {labelOf(f)}
          </button>
        ))}
      </div>
    );
  }

  const choose = (f: FontId) => {
    onChange(f);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="relative min-w-0">
      <span id={`${id}-label`} className="mb-1 block text-[11.5px] font-medium text-[var(--ds-muted)]">
        {label}
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2.5 text-left text-[14px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
      >
        <span id={`${id}-value`} className="min-w-0 flex-1 truncate" style={{ fontFamily: value ? fontFamilyStack(value) : undefined }}>
          {value ? labelOf(value) : 'Mixed'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={`${id}-label`}
          aria-activedescendant={`${id}-opt-${active}`}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(options.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              choose(options[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised,var(--ds-surface-strong))] p-1 shadow-[0_12px_40px_rgba(0,0,0,0.22)] focus:outline-none"
        >
          {options.map((f, i) => {
            const meta = FONT_REGISTRY[f];
            const n = note(f);
            return (
              <li
                key={f}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={value === f}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(f)}
                className={cx('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5', i === active ? 'bg-[var(--ds-hover)]' : '')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] leading-tight text-[var(--ds-ink)]" style={{ fontFamily: fontFamilyStack(f) }}>
                    {labelOf(f)}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--ds-muted)]">
                    {(ROLE as Record<string, string>)[f] ?? 'Script face'}
                    {n ? ` · ${n}` : ''}
                  </span>
                </span>
                <span className="shrink-0 rounded-full border border-[var(--ds-hairline)] px-1.5 py-px text-[9.5px] font-medium tabular-nums text-[var(--ds-muted)]" title="Font licence">
                  {meta.license === 'Apache-2.0' ? 'Apache' : 'OFL'}
                </span>
                {value === f && <Check className="h-3.5 w-3.5 shrink-0 text-[#D97757]" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default FontPicker;
