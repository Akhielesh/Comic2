import React from 'react';
import { sfxStyleIds, sfxStyleOf, sfxStyleSupports, type DrawnSfxEffect } from '../../../shared/comic/lettering/sfxCatalog';
import type { AnySfxEffect } from '../../../shared/comic/lettering/style';
import { cx } from '../board/ui';

interface SfxStylePickerProps {
  value: AnySfxEffect | undefined;
  languages: readonly string[];
  onPick(effect: DrawnSfxEffect): void;
  pro?: boolean;
}

export function SfxStylePicker({ value, languages, onPick, pro }: SfxStylePickerProps) {
  const id = React.useId();
  const baseIds = sfxStyleIds();
  const choices = pro ? sfxStyleIds(true).slice(baseIds.length) : baseIds;
  const disabled = (effect: DrawnSfxEffect) => languages.some((lang) => !sfxStyleSupports(effect, lang));
  const hasScriptNote = choices.some(disabled);
  const label = pro ? 'Pro sound effect style' : 'Sound effect style';
  return (
    <div className="space-y-1">
      <div role="radiogroup" aria-label={label} aria-describedby={hasScriptNote ? id : undefined} className="grid grid-cols-3 gap-1" data-testid={pro ? 'pro-sfx' : undefined}>
        {choices.map((effect) => {
          const info = sfxStyleOf(effect);
          return (
            <label key={effect} className="relative min-w-0" title={info.description}>
              <input
                type="radio"
                name={id}
                className="peer sr-only"
                checked={effect === value}
                disabled={disabled(effect)}
                onChange={() => onPick(effect)}
              />
              <span className={cx(
                'flex min-h-8 cursor-pointer items-center justify-center rounded-lg border px-1.5 py-1 text-center text-[12px] text-[var(--ds-ink)] coarse:min-h-11',
                'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ds-ring)] peer-disabled:cursor-default peer-disabled:opacity-40',
                effect === value ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] hover:bg-[var(--ds-hover)]'
              )}>
                {info.label}
              </span>
            </label>
          );
        })}
      </div>
      {hasScriptNote && <p id={id} className="text-[11px] leading-snug text-[var(--ds-muted)]">Some effects are unavailable because they would separate joined letters.</p>}
    </div>
  );
}
