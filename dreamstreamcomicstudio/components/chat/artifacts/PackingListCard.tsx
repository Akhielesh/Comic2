import React, { useCallback, useState } from 'react';
import { Check, Luggage } from 'lucide-react';
import type { PackingListArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Expandable, RadialGauge, useCompact } from './kit';

// Interactive packing checklist — check-off state persisted locally.
//  • detailed — grouped rows with round check toggles (checked → green fill +
//    strike-through), a radial progress gauge in the header and an expandable
//    "Packing tips" section.
//  • compact — the gauge inline + "12 of 24 packed · 3 groups" and the next two
//    unpacked items muted.
// Progress is client-side only: localStorage `ds.packing.v1`, a JSON map of
// artifactId → array of checked "groupIdx:itemIdx" keys. No server round-trip.

const STORAGE_KEY = 'ds.packing.v1';
const DONE_COLOR = '#059669';

const loadChecked = (artifactId: string): Set<string> => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const map = JSON.parse(raw) as Record<string, unknown>;
    const entry = map?.[artifactId];
    if (Array.isArray(entry)) return new Set(entry.filter((v): v is string => typeof v === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
};

const saveChecked = (artifactId: string, checked: Set<string>) => {
  try {
    let map: Record<string, unknown> = {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
    }
    map[artifactId] = Array.from(checked);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable (private mode, SSR) — progress just won't persist.
  }
};

export const PackingListCard: React.FC<{ data: PackingListArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [checked, setChecked] = useState<Set<string>>(() => loadChecked(data.id));

  const toggle = useCallback(
    (key: string) => {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        saveChecked(data.id, next);
        return next;
      });
    },
    [data.id]
  );

  // Keys use ORIGINAL group indices so persisted state survives partial data.
  const groups = data.groups ?? [];
  const renderable = groups
    .map((g, gi) => ({ group: g, gi }))
    .filter(({ group }) => (group?.items?.length ?? 0) > 0);
  if (!renderable.length) return null;

  const total = renderable.reduce((n, { group }) => n + group.items.length, 0);
  // Count against the live items (not the raw set) so stale keys never inflate it.
  const done = renderable.reduce(
    (n, { group, gi }) => n + group.items.filter((_, ii) => checked.has(`${gi}:${ii}`)).length,
    0
  );
  const nextUp = renderable
    .flatMap(({ group, gi }) => group.items.map((item, ii) => ({ item, key: `${gi}:${ii}` })))
    .filter(({ key }) => !checked.has(key))
    .slice(0, 2)
    .map(({ item }) => item);

  const subtitle = [data.destination, data.context].filter(Boolean).join(' · ');
  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <Luggage className="h-4 w-4 shrink-0" style={{ color: DONE_COLOR }} />
      <div className="min-w-0">
        <SurfaceTitle>{data.title}</SurfaceTitle>
        {subtitle && <SurfaceSubtitle>{subtitle}</SurfaceSubtitle>}
      </div>
    </div>
  );
  const gauge = (
    <RadialGauge value={done} max={total || 1} display={`${done}`} unit={`of ${total}`} color={DONE_COLOR} size={48} />
  );

  // ── Compact: gauge + counts + the next unpacked items. ──────────────────────
  if (compact) {
    return (
      <Surface header={header}>
        <div className="flex items-center gap-3 px-3 pb-3 pt-0.5">
          {gauge}
          <div className="min-w-0">
            <p className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">
              {done} of {total} packed
              <span className="font-normal text-[var(--ds-muted)]">
                {' · '}
                {renderable.length} group{renderable.length === 1 ? '' : 's'}
              </span>
            </p>
            <p className="truncate text-[11px] text-[var(--ds-muted)]">
              {nextUp.length ? nextUp.join(' · ') : 'All packed — ready to go.'}
            </p>
          </div>
        </div>
      </Surface>
    );
  }

  // ── Detailed: grouped check-off rows + tips. ────────────────────────────────
  return (
    <Surface header={header} right={gauge}>
      <div className="space-y-2.5 px-3 pb-3 pt-0.5">
        {renderable.map(({ group, gi }) => (
          <div key={gi}>
            {group.name && (
              <p className="mb-0.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
                {group.name}
              </p>
            )}
            <ul>
              {group.items.map((item, ii) => {
                const key = `${gi}:${ii}`;
                const isChecked = checked.has(key);
                return (
                  <li key={key}>
                    <button
                      role="checkbox"
                      aria-checked={isChecked}
                      onClick={() => toggle(key)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors duration-200 hover:bg-[var(--ds-well)]"
                    >
                      <span
                        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                        style={
                          isChecked
                            ? { backgroundColor: DONE_COLOR, borderColor: DONE_COLOR }
                            : { borderColor: 'var(--ds-hairline)' }
                        }
                      >
                        {isChecked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-xs transition-colors duration-200 ${
                          isChecked
                            ? 'text-[var(--ds-muted)] line-through decoration-[var(--ds-hairline)]'
                            : 'text-[var(--ds-ink)]'
                        }`}
                      >
                        {item}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {(data.tips?.length ?? 0) > 0 && (
        <Expandable moreLabel="Packing tips" lessLabel="Packing tips">
          <ul className="space-y-1 px-3 py-2.5">
            {data.tips!.map((tip, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--ds-ink)] opacity-80">
                <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full" style={{ backgroundColor: DONE_COLOR }} />
                <span className="min-w-0">{tip}</span>
              </li>
            ))}
          </ul>
        </Expandable>
      )}
    </Surface>
  );
};
