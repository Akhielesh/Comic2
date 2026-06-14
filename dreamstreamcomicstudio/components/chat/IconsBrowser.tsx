import React, { useMemo, useState } from 'react';
import { Search, X, Check, Copy } from 'lucide-react';
import { DOMAIN_ICONS, WeatherIcon, type DomainIconDef } from './artifacts/kit';
import { TRANSITION } from './studioDesign';

// Icons browser — the searchable showcase of the app's custom house icon suite
// (DomainIcons + the WeatherIcon set), surfaced as a section of the admin Gallery.
// Every mark is `currentColor`, so the grid previews them on the canvas ink and a
// click copies the icon's name. Pure presentational; no data dependencies.

const CATEGORIES = ['All', 'Travel', 'Finance', 'News', 'Planning', 'Places', 'Tech', 'Health', 'Science', 'Sports', 'Media', 'Tools', 'Education', 'Food', 'Transit', 'Crypto', 'Nature', 'Commerce', 'Weather'];

// The weather set folded into the same browsable shape as the domain icons.
const WEATHER_ENTRIES: { name: string; code: number; isDay?: boolean; keywords: string[] }[] = [
  { name: 'Clear day', code: 0, isDay: true, keywords: ['sun', 'sunny', 'clear'] },
  { name: 'Clear night', code: 0, isDay: false, keywords: ['moon', 'night', 'clear'] },
  { name: 'Partly cloudy', code: 2, isDay: true, keywords: ['sun', 'cloud', 'partly'] },
  { name: 'Cloudy', code: 3, isDay: true, keywords: ['overcast', 'cloud'] },
  { name: 'Fog', code: 45, isDay: true, keywords: ['mist', 'haze', 'fog'] },
  { name: 'Drizzle', code: 53, isDay: true, keywords: ['light rain', 'drizzle'] },
  { name: 'Rain', code: 63, isDay: true, keywords: ['rain', 'shower', 'wet'] },
  { name: 'Snow', code: 73, isDay: true, keywords: ['snow', 'flurry', 'cold'] },
  { name: 'Sleet', code: 85, isDay: true, keywords: ['sleet', 'mix'] },
  { name: 'Thunderstorm', code: 95, isDay: true, keywords: ['storm', 'thunder', 'lightning'] }
];

interface Entry {
  key: string;
  name: string;
  category: string;
  keywords: string[];
  render: (size: number) => React.ReactNode;
}

const ENTRIES: Entry[] = [
  ...DOMAIN_ICONS.map((d: DomainIconDef) => ({
    key: `${d.category}-${d.name}`,
    name: d.name,
    category: d.category,
    keywords: d.keywords,
    render: (size: number) => <d.Icon size={size} />
  })),
  ...WEATHER_ENTRIES.map((w) => ({
    key: `Weather-${w.name}`,
    name: w.name,
    category: 'Weather',
    keywords: w.keywords,
    render: (size: number) => <WeatherIcon code={w.code} isDay={w.isDay} size={size} still />
  }))
];

export const IconsBrowser: React.FC = () => {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('All');
  const [copied, setCopied] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ENTRIES.filter((e) => {
      if (cat !== 'All' && e.category !== cat) return false;
      if (!q) return true;
      return [e.name, e.category, ...e.keywords].join(' ').toLowerCase().includes(q);
    });
  }, [query, cat]);

  const copy = (name: string) => {
    void navigator.clipboard?.writeText(name);
    setCopied(name);
    window.setTimeout(() => setCopied((c) => (c === name ? null : c)), 1400);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Controls */}
      <div className="flex flex-col gap-2 border-b border-[var(--ds-hairline)] px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--ds-muted)]">{filtered.length} of {ENTRIES.length} icons</span>
          <div className="relative ml-auto w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons…"
              className="w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] py-1.5 pl-8 pr-7 text-[13px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] focus:border-[#D97757]/40"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--ds-muted)] hover:text-[var(--ds-ink)]" aria-label="Clear search">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${TRANSITION} ${
                cat === c ? 'border-transparent bg-[var(--ds-accent)] text-white' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-[var(--ds-muted)]">No icons match “{query}”.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {filtered.map((e) => (
              <button
                key={e.key}
                onClick={() => copy(e.name)}
                title={`${e.name} · ${e.category} — click to copy name`}
                className={`group/icon flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-2 text-[var(--ds-ink)] ${TRANSITION} hover:border-[#D97757]/40 hover:bg-[var(--ds-hover)]`}
              >
                <span className="relative text-[var(--ds-ink)] transition-colors duration-200 group-hover/icon:text-[var(--ds-accent)]">
                  {e.render(30)}
                  <span className="pointer-events-none absolute -right-2 -top-2 text-emerald-600 opacity-0 transition-opacity duration-200" style={{ opacity: copied === e.name ? 1 : 0 }}>
                    <Check className="h-3.5 w-3.5" />
                  </span>
                </span>
                <span className="flex items-center gap-0.5 truncate text-[9.5px] font-medium text-[var(--ds-muted)]">
                  {copied === e.name ? 'Copied' : e.name}
                  {copied !== e.name && <Copy className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover/icon:opacity-60" />}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default IconsBrowser;
