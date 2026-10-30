// Comic History — one moment in the list (versions plan §8 panel 4; package H5).
//
// A row ≥ 64 px, fully tappable: who made it (Sparkles = AI, User = you, Wand2 = the editor, no AI cost), a two-line
// label, a meta line ("10:42 · pages 3–4 · uses a little of your usage" / "Free" / "$0.07 · on your key" — governed
// viewers never read dollars), a 40×60 thumbnail, and chips for a name (Star), Published (Globe) and — in Original's
// list — "From a version you removed" (Layers; a removed line's rows keep their line, H1).

import React from 'react';
import { Globe, Layers, Star } from 'lucide-react';
import type { VersionRow } from '../../../shared/comic/history/types';
import { FOCUS_RING, HOVER_ROW, RADIUS_CONTROL } from '../../chat/studioDesign';
import { ACTOR_INFO, HISTORY_COPY, rowMetaText, type MoneyWords } from './historyModel';
import { ActorGlyph, cx, Mark } from './ui';

export interface MomentRowProps {
  row: VersionRow;
  selected?: boolean;
  /** A row of a version the creator removed (Original's list carries them): said in plain words. */
  removed?: boolean;
  money: MoneyWords;
  tz: string;
  urlFor(path: string): string | undefined;
  onOpen(row: VersionRow): void;
  onFocusRow?(row: VersionRow): void;
}

export const MomentRow: React.FC<MomentRowProps> = ({ row, selected, removed, money, tz, urlFor, onOpen, onFocusRow }) => {
  const actor = ACTOR_INFO[row.actor] ?? ACTOR_INFO.system;
  const thumb = row.thumbs.find((t) => t.key !== 'cover') ?? row.thumbs[0];
  const url = thumb ? urlFor(thumb.path) : undefined;
  const meta = rowMetaText(row, money, tz);
  const title = row.name || row.label || 'A saved moment';
  return (
    <button
      type="button"
      data-moment={row.id}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${title}. ${actor.words}. ${meta}${removed ? `. ${HISTORY_COPY.removedLine}` : ''}`}
      data-moment-removed={removed ? '' : undefined}
      onClick={() => onOpen(row)}
      onFocus={() => onFocusRow?.(row)}
      className={cx(
        'flex min-h-16 w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left [content-visibility:auto] [contain-intrinsic-size:auto_72px]',
        HOVER_ROW,
        FOCUS_RING,
        selected && 'bg-[var(--ds-accent-soft)]'
      )}
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] text-[var(--ds-ink)]" title={actor.words}>
        <ActorGlyph icon={actor.icon} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[14px] font-medium leading-5 text-[var(--ds-ink)] [overflow-wrap:anywhere]">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-4 tabular-nums text-[var(--ds-muted)] [overflow-wrap:anywhere]">{meta}</span>
        {(!!row.name || row.kind === 'publish' || row.publishedRev !== undefined || removed) && (
          <span className="mt-1 flex min-w-0 flex-wrap gap-1">
            {removed && <Mark icon={<Layers className="h-3 w-3" aria-hidden />}>{HISTORY_COPY.removedLine}</Mark>}
            {row.name && <Mark icon={<Star className="h-3 w-3" aria-hidden />}>{row.name}</Mark>}
            {(row.kind === 'publish' || row.publishedRev !== undefined) && <Mark icon={<Globe className="h-3 w-3" aria-hidden />}>Published</Mark>}
          </span>
        )}
      </span>
      <span className={cx('relative h-[60px] w-10 shrink-0 overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)]', RADIUS_CONTROL)} aria-hidden>
        {url && <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} loading="lazy" />}
      </span>
    </button>
  );
};

export default MomentRow;
