import React, { useEffect, useMemo, useState } from 'react';
import { Heart, Navigation, Trash2 } from 'lucide-react';
import { listShortlist, onShortlistChanged, removeShortlisted, type ShortlistItem } from '../../../services/shortlist';
import { PLACE_KIND_ICONS, PLACE_KIND_LABELS, type PlaceKind } from './placeKinds';
import { ExpandLightbox } from './kit/ExpandLightbox';

// The shortlist's home: every place the user hearted — restaurants, hotels, sights —
// gathered in ONE place, grouped by category, each with directions and remove. Opened
// from the "Shortlist (N)" chip on any places card.

export const ShortlistPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [items, setItems] = useState<ShortlistItem[]>(() => listShortlist());
  useEffect(() => onShortlistChanged(() => setItems(listShortlist())), []);

  const groups = useMemo(() => {
    const byKind = new Map<string, ShortlistItem[]>();
    for (const item of items) {
      const list = byKind.get(item.kind) ?? [];
      list.push(item);
      byKind.set(item.kind, list);
    }
    // Stable, meaningful order: stay → food → sights → the rest.
    const order: PlaceKind[] = ['hotel', 'food', 'cafe', 'bar', 'sight', 'park', 'activity', 'shop', 'transit', 'flight', 'other'];
    return order.filter((k) => byKind.has(k)).map((k) => ({ kind: k, items: byKind.get(k)! }));
  }, [items]);

  return (
    <ExpandLightbox title={`Shortlist · ${items.length} saved`} onClose={onClose}>
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-14 text-center">
          <Heart className="h-7 w-7 text-[var(--ds-faint)]" />
          <p className="text-sm font-medium text-[var(--ds-ink)]">Nothing shortlisted yet</p>
          <p className="max-w-sm text-xs text-[var(--ds-muted)]">
            Tap the heart on any restaurant, hotel or sight in a places list to collect your trip picks here.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(({ kind, items: groupItems }) => {
            const KindIcon = PLACE_KIND_ICONS[kind as PlaceKind] ?? Heart;
            return (
              <section key={kind}>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
                  <KindIcon className="h-3.5 w-3.5 text-[var(--ds-accent)]" />
                  {PLACE_KIND_LABELS[kind as PlaceKind] ?? kind}
                  <span className="font-normal normal-case">· {groupItems.length}</span>
                </h3>
                <ul className="divide-y divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
                  {groupItems.map((item) => (
                    <li key={item.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-[var(--ds-ink)]">{item.name}</p>
                        <p className="truncate text-[11px] text-[var(--ds-muted)]">
                          {[item.address, item.source].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      {typeof item.lat === 'number' && typeof item.lng === 'number' && (
                        <a
                          href={`https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Directions"
                          className="shrink-0 rounded-lg p-1.5 text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                        >
                          <Navigation className="h-4 w-4" />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => removeShortlisted(item.id)}
                        title="Remove from shortlist"
                        className="shrink-0 rounded-lg p-1.5 text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </ExpandLightbox>
  );
};
