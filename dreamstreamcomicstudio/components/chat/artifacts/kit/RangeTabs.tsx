import React from 'react';

// A compact segmented control — the timeline selector for finance/data ranges.
// Renders only the options it's given, so callers hide ranges that have no data.

interface RangeTabsProps<T extends string> {
  options: readonly T[];
  value: T;
  accent?: string;
  onChange: (value: T) => void;
}

export function RangeTabs<T extends string>({ options, value, accent = '#3B82F6', onChange }: RangeTabsProps<T>) {
  return (
    <div className="inline-flex rounded-lg border-2 border-black/10 bg-slate-50 p-0.5 text-[11px] font-bold">
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            aria-pressed={active}
            className={`rounded-md px-2 py-0.5 transition-colors ${active ? 'text-white' : 'text-slate-500 hover:text-slate-800'}`}
            style={active ? { backgroundColor: accent } : undefined}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
