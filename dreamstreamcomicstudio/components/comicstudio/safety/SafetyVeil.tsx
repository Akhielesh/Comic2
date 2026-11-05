// Safety veil around an image (contract §13.3; safety.md §10; owner P1-SAFETY).
//
//   pass / unchecked → the children, untouched
//   pending          → the children with a quiet "Checking…" pill (the URL arrives after the verdict)
//   over_rating      → the children blurred (CSS only, no image swap) + "Rated PG-13 — your comic is PG"
//                      with Show / Redraw safer / Change rating (only the actions the caller offers)
//   blocked          → a neutral tile. The children are NEVER rendered, so a blocked image never
//                      becomes an <img> (no URL is signed for it either). Redraw safer / Check again.
// Respects reduced motion; every button is a 44 px target.

import React, { useEffect, useState } from 'react';
import type { AssetRef } from '../../../shared/comic/doc';
import { safetyStatusOf, type ContentRating } from '../../../shared/comic/safety';

export interface SafetyVeilProps {
  asset?: AssetRef;
  rating: ContentRating;
  children: React.ReactNode;
  onRedrawSafer?(): void;
  /**
   * What "Redraw safer" costs, already formatted for this user (formatCostForUser: "≈ $0.07", "≈2% of
   * your usage", "Free"). Shown on the button so a paid redraw is never a surprise.
   */
  redrawPrice?: string;
  onChangeRating?(): void;
  onCheckAgain?(): void;
}

const BUTTON =
  'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-3 text-[12px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';
const PRIMARY = `${BUTTON} bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]`;
const QUIET = `${BUTTON} border border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`;

const Actions: React.FC<{ items: { label: string; onClick?: () => void; primary?: boolean }[] }> = ({ items }) => {
  const shown = items.filter((i) => i.onClick);
  if (!shown.length) return null;
  return (
    <div className="mt-2 flex max-w-full flex-wrap items-center justify-center gap-1.5">
      {shown.map((i) => (
        <button
          key={i.label}
          type="button"
          className={i.primary ? PRIMARY : QUIET}
          onClick={(e) => {
            e.stopPropagation();
            i.onClick?.();
          }}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
};

export const SafetyVeil: React.FC<SafetyVeilProps> = ({ asset, rating, children, onRedrawSafer, onChangeRating, onCheckAgain, redrawPrice }) => {
  const status = safetyStatusOf(asset?.safety, rating);
  const redrawLabel = redrawPrice?.trim() ? `Redraw safer · ${redrawPrice.trim()}` : 'Redraw safer';
  const [shown, setShown] = useState(false);
  // A different image (or a new verdict) is veiled again.
  useEffect(() => setShown(false), [asset?.path, asset?.safety?.assessed]);

  if (status === 'blocked') {
    return (
      <div
        role="img"
        aria-label="Image withheld"
        data-safety="blocked"
        className="grid h-full min-h-[4rem] w-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center overflow-hidden rounded-[inherit] bg-[var(--ds-well-strong)] px-3 py-3 text-center"
      >
        <div className="max-h-full min-w-0 max-w-full overflow-y-auto overscroll-contain">
          <p className="break-words text-[12px] leading-snug text-[var(--ds-muted)]">This take didn&apos;t fit the content rules.</p>
          <Actions
            items={[
              { label: redrawLabel, onClick: onRedrawSafer, primary: true },
              { label: 'Check again', onClick: onCheckAgain }
            ]}
          />
        </div>
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className="relative h-full w-full" data-safety="pending">
        {children}
        <span
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-2 top-2 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)] shadow-sm"
        >
          Checking…
        </span>
      </div>
    );
  }

  if (status === 'over_rating' && !shown) {
    const assessed = asset?.safety?.assessed;
    return (
      <div className="relative h-full w-full overflow-hidden rounded-[inherit]" data-safety="over_rating">
        {/* `inert` as well as aria-hidden: anything interactive inside the blurred art (the editor's
            balloon buttons, a card's pointer shortcut) must not take keyboard focus or clicks while it
            is veiled — focus would land on something the reader can't see. */}
        <div aria-hidden="true" inert data-safety-blurred className="h-full w-full [filter:blur(18px)] motion-safe:transition-[filter]">
          {children}
        </div>
        <div className="absolute inset-0 grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center p-2 text-center sm:p-3">
          {/* Small thumbnails: the note scrolls instead of clipping its buttons. */}
          <div className="max-h-full min-w-0 max-w-full overflow-y-auto overscroll-contain rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-3 py-2 shadow-sm">
            <p className="break-words text-[12px] font-medium leading-snug text-[var(--ds-ink)]">
              Rated {assessed} — your comic is {rating}
            </p>
            <Actions
              items={[
                { label: 'Show', onClick: () => setShown(true) },
                { label: redrawLabel, onClick: onRedrawSafer, primary: true },
                { label: 'Change rating', onClick: onChangeRating }
              ]}
            />
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export default SafetyVeil;
