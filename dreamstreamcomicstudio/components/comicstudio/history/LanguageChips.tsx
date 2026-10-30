// Comic History — the language chips over a compare (versions plan §5 "Languages"; package H5).
//
// The source language plus every edition either side has; the compare below them shows that language (localizeDoc
// for the lettered page, the translations for the word diff) with each line's status in words: "AI translation",
// "Reviewed", "You edited", "Needs update". "Use then" on an edition brings that whole edition back (scope language)
// — e.g. "the AI re-translation overwrote my edits".

import React from 'react';
import { Languages } from 'lucide-react';
import { ChipBtn, QuietBtn } from './ui';

export interface LanguageChip {
  lang: string;
  label: string;
  source: boolean;
}

export interface LanguageChipsProps {
  chips: readonly LanguageChip[];
  selected: string;
  onSelect(lang: string): void;
  /** Offered when the selected edition differs between then and now. */
  onUseThen?(lang: string): void;
  useThenDisabled?: boolean;
}

export const LanguageChips: React.FC<LanguageChipsProps> = ({ chips, selected, onSelect, onUseThen, useThenDisabled }) => {
  if (chips.length < 2) return null;
  const current = chips.find((c) => c.lang === selected);
  return (
    <div className="min-w-0" data-history-languages>
      <div role="group" aria-label="Language" className="flex min-w-0 gap-2 overflow-x-auto px-4 py-2">
        {chips.map((c) => (
          <ChipBtn key={c.lang} selected={c.lang === selected} onClick={() => onSelect(c.lang)}>
            {c.source ? <Languages className="h-3.5 w-3.5" aria-hidden /> : null}
            <span className="min-w-0 truncate">{c.label}</span>
            {c.source ? <span className="sr-only"> (source)</span> : null}
          </ChipBtn>
        ))}
      </div>
      {current && !current.source && onUseThen && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pb-2 text-[12.5px] text-[var(--ds-muted)]">
          <span className="min-w-0 flex-1">Bring back the whole {current.label} edition as it was then. Free.</span>
          <QuietBtn onClick={() => onUseThen(current.lang)} disabled={useThenDisabled} aria-label={`Use then: the ${current.label} edition (free)`}>
            Use then
          </QuietBtn>
        </div>
      )}
    </div>
  );
};

export default LanguageChips;
