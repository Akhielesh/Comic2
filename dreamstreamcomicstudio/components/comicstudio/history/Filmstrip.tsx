// Comic History — the filmstrip of the book at the selected moment (versions plan §8 panel 3; package H5).
//
// Cover plus pages, 56×84 on phones and 72×108 from md, with scroll-snap and "Changed" / "New" marks (a word and an
// icon, never colour alone). A frame opens that page's compare. Reduced motion: frames jump into view (no smooth
// scroll).

import React, { useEffect, useRef } from 'react';
import { Pencil, Plus } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { VersionRow } from '../../../shared/comic/history/types';
import { FOCUS_RING, RADIUS_CONTROL } from '../../chat/studioDesign';
import { filmFrames } from './historyModel';
import { cx, Mark } from './ui';

export interface FilmstripProps {
  row: VersionRow;
  live?: ComicDoc | null;
  urlFor(path: string): string | undefined;
  onOpenPage?(pageId: string): void;
  reducedMotion?: boolean;
}

export const Filmstrip: React.FC<FilmstripProps> = ({ row, live, urlFor, onOpenPage, reducedMotion }) => {
  const frames = filmFrames(row, live);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // Bring the first changed frame into view when the moment changes.
    const el = listRef.current?.querySelector<HTMLElement>('[data-mark]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [row.id, reducedMotion]);
  if (!frames.length) return <p className="m-0 px-4 py-2 text-[12px] text-[var(--ds-muted)]">No drawings at this moment yet.</p>;
  return (
    <ul
      ref={listRef}
      aria-label={`The book at ${row.name || row.label}`}
      className="m-0 flex min-w-0 snap-x snap-mandatory list-none gap-2 overflow-x-auto overscroll-x-contain px-4 py-2"
      data-history-filmstrip
    >
      {frames.map((f) => {
        const url = f.path ? urlFor(f.path) : undefined;
        const body = (
          <>
            <span className={cx('relative block h-[84px] w-14 overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)] md:h-[108px] md:w-[72px]', RADIUS_CONTROL)}>
              {url ? <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} loading="lazy" /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
            </span>
            <span className="block w-14 truncate text-center text-[11px] text-[var(--ds-muted)] md:w-[72px]">{f.label}</span>
            {f.mark && (
              <span data-mark={f.mark} className="block">
                <Mark tone="active" icon={f.mark === 'new' ? <Plus className="h-3 w-3" aria-hidden /> : <Pencil className="h-3 w-3" aria-hidden />}>
                  {f.mark === 'new' ? 'New' : 'Changed'}
                </Mark>
              </span>
            )}
          </>
        );
        return (
          <li key={f.key} className="flex shrink-0 snap-start flex-col items-center gap-1">
            {f.pageId && onOpenPage ? (
              <button type="button" onClick={() => onOpenPage(f.pageId!)} aria-label={`${f.label}${f.mark ? `, ${f.mark === 'new' ? 'new' : 'changed'}` : ''}: compare with now`} className={cx('flex min-h-11 flex-col items-center gap-1', RADIUS_CONTROL, FOCUS_RING)}>
                {body}
              </button>
            ) : (
              <span className="flex flex-col items-center gap-1">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export default Filmstrip;
