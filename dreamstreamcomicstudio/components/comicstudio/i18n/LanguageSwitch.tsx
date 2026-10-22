// Edition switch for the page editor and the Reader tab (i18n.md §10.2): `EN · తెలుగు · हिन्दी`.
// Owner: P1-I18N. A radiogroup (arrow keys move and select), scrolls horizontally inside itself
// when there are many languages (never the page), 44 px touch targets on coarse pointers.

import React, { useRef } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { editionReadiness, i18nOf } from '../../../shared/comic/i18n';
import { dirOf, languageSpec, sameLanguage } from '../../../shared/comic/languages';

export interface LanguageSwitchOption {
  code: string;
  /** Short visible label (the endonym; the source shows its code in capitals when Latin). */
  label: string;
  /** Accessible / tooltip name ("Telugu — draft"). */
  title: string;
  draft?: boolean;
}

/** The source first, then every edition (drafts included, marked). */
export function languageSwitchOptions(doc: ComicDoc): LanguageSwitchOption[] {
  const source = doc.format.language;
  const s = languageSpec(source);
  const out: LanguageSwitchOption[] = [{ code: source, label: s && s.script === 'Latn' ? source.toUpperCase() : s?.endonym || source, title: `${s?.english || source} (original)` }];
  for (const code of Object.keys(i18nOf(doc).editions)) {
    if (sameLanguage(code, source)) continue;
    const spec = languageSpec(code);
    if (!spec) continue;
    const draft = !editionReadiness(doc, code).publishable;
    out.push({ code, label: spec.endonym, title: `${spec.english}${draft ? ' — draft' : ''}`, draft });
  }
  return out;
}

export interface LanguageSwitchProps {
  options: LanguageSwitchOption[];
  value: string;
  onChange(code: string): void;
  /** Accessible group name. */
  label?: string;
  className?: string;
}

const cx = (...p: Array<string | false | null | undefined>) => p.filter(Boolean).join(' ');

export const LanguageSwitch: React.FC<LanguageSwitchProps> = ({ options, value, onChange, label = 'Edition language', className }) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (options.length < 2) return null;
  const index = Math.max(0, options.findIndex((o) => sameLanguage(o.code, value)));
  const move = (to: number) => {
    const i = (to + options.length) % options.length;
    onChange(options[i].code);
    refs.current[i]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        'flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-0.5 [scrollbar-width:none]',
        className
      )}
    >
      {options.map((o, i) => {
        const on = i === index;
        return (
          <button
            key={o.code}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.code)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(i + 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(i - 1);
              }
            }}
            className={cx(
              'relative inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-[10px] px-2.5 text-[12.5px] font-medium transition-colors duration-150 coarse:h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 motion-reduce:transition-none',
              on ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-sm' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
            )}
          >
            <span lang={o.code} dir={dirOf(o.code)}>
              {o.label}
            </span>
            {o.draft && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#D97757]/70" />}
            <span className="sr-only">{o.draft ? ' (draft)' : ''}</span>
          </button>
        );
      })}
    </div>
  );
};

export default LanguageSwitch;
