import React from 'react';

// A macOS-style segmented control — the timeline selector for finance/data ranges.
// Renders only the options it's given, so callers hide ranges that have no data.
// The active segment is a raised white pill on a recessed track, like AppKit.

interface RangeTabsProps<T extends string> {
  options: readonly T[];
  value: T;
  accent?: string;
  onChange: (value: T) => void;
}

export function RangeTabs<T extends string>({ options, value, accent = '#3B82F6', onChange }: RangeTabsProps<T>) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5 text-[11px] font-semibold">
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            aria-pressed={active}
            className={`rounded-md px-2 py-0.5 transition-all duration-200 ${
              active ? 'bg-[var(--ds-raised)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
            }`}
            style={active ? { color: accent } : undefined}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
