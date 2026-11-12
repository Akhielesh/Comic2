/**
 * SearchField — the one search box (redesign plan §4; the Library toolbar, Discover's header and browse page): a
 * pill (FIELD_GROUP) with a search icon, a `type="search"` input and a Clear button once there is text. It
 * replaces the Library and Discover copies.
 *
 *   - the label is real (visually hidden by default) and the placeholder only hints;
 *   - `/` focuses it from anywhere on the page (`shortcut`), unless the person is already typing in a field;
 *   - Esc clears it while it holds text, else blurs; Clear puts focus back in the field;
 *   - input is capped at `maxLength` (60: Discover's server-side search accepts at most 60 characters);
 *   - `resultText` ("12 comics") is tied to the field as its description, so the count is read with it.
 *
 * It does not debounce or fetch: the screen decides when a query runs (Discover's listing is edge-cached).
 */
import React, { useEffect, useId, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { FIELD_EMBEDDED, FIELD_GROUP } from '../chat/studioDesign';
import { cn } from '../../lib/utils';
import { IconButton } from './IconButton';
import { DENSITY } from './recipes';

export const SEARCH_MAX_LENGTH = 60;

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name ("Search your comics"). */
  label: string;
  placeholder?: string;
  /** Enter (the screen may run the query now). */
  onSubmit?: (value: string) => void;
  /** Focus with `/` from anywhere on the page. */
  shortcut?: boolean;
  /** The current result count in words, read as the field's description. */
  resultText?: string;
  maxLength?: number;
  /** Show the label above the field instead of hiding it. */
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

const isTypingTarget = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

export function SearchField({ value, onChange, label, placeholder, onSubmit, shortcut = false, resultText, maxLength = SEARCH_MAX_LENGTH, showLabel = false, disabled = false, className }: SearchFieldProps) {
  const id = useId();
  const descId = `${id}-results`;
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut, disabled]);

  const clear = () => {
    onChange('');
    input.current?.focus();
  };

  return (
    <div data-slot="search-field" className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className={showLabel ? 'text-[13px] font-medium leading-5 text-[var(--ds-ink)]' : 'sr-only'}>
        {label}
      </label>
      <div className={cn(FIELD_GROUP, 'h-9 px-3 coarse:h-11', disabled && 'opacity-50')}>
        <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--ds-muted)]" />
        <input
          ref={input}
          id={id}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={resultText ? descId : undefined}
          aria-keyshortcuts={shortcut ? '/' : undefined}
          onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit?.(value);
            else if (e.key === 'Escape') {
              if (value) {
                e.preventDefault();
                e.stopPropagation();
                onChange('');
              } else (e.target as HTMLInputElement).blur();
            }
          }}
          className={cn(FIELD_EMBEDDED, 'h-full min-w-0 text-[length:var(--ds-text-base)] text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] [&::-webkit-search-cancel-button]:hidden')}
        />
        {value && !disabled ? (
          <IconButton label="Clear search" size="sm" onClick={clear} className={cn('-mr-1.5', DENSITY.coarseSquare)}>
            <X />
          </IconButton>
        ) : shortcut ? (
          <kbd aria-hidden="true" className="hidden rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] px-1.5 text-[11px] leading-5 text-[var(--ds-muted)] can-hover:inline">
            /
          </kbd>
        ) : null}
      </div>
      {resultText ? (
        <span id={descId} className="sr-only">
          {resultText}
        </span>
      ) : null}
    </div>
  );
}
