// The studio header's breadcrumb (SH-C2): My comics › the comic › the board's area › the part you are on.
//
// - My comics leaves the studio. It shows from 1024 px; below, the panel's drawer starts with it and the header has no room.
// - The comic is its name field: click to rename, Enter or leaving it saves, Escape puts it back (as the header's title
//   always did). It sizes to its words, so the crumbs after it sit beside the name, and it is what shrinks first.
// - The area (Pages, Cast, …) shows while the board is on screen and goes back to the top of that area.
// - The part (Page 3, Maya, Cover) brings its card back into view with focus on it.
// The last crumb is the current page for screen readers. Truncation: the name shrinks first (to 4rem, 2.5rem on a phone),
// the area keeps its (short) word, the part clips with an ellipsis down to a 44 px target (its tooltip has every word);
// on phones only the deepest crumb follows the name. The breadcrumb clips rather than ever pushing the header's controls, so nothing scrolls sideways at 320 px.
// Ink only: muted words for the way back, ink for where you are.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, TRANSITION } from '../../chat/studioDesign';
import { breadcrumbCrumbs, type CrumbKey, type CrumbRoom } from './breadcrumbModel';

/** Where the breadcrumb goes past the comic: the board's area and the part you are on in it. */
export interface StudioTrail {
  area?: { label: string; onGo: () => void } | null;
  item?: { label: string; onGo: () => void } | null;
}

export interface StudioBreadcrumbProps extends StudioTrail {
  title: string;
  onRename: (title: string) => void;
  /** Leave the studio for My comics (omitted where the header has its own Back). */
  onMyComics?: () => void;
  /** The header's room: every crumb ('wide'), no My comics ('medium'), or only the deepest after the name ('narrow'). */
  room?: CrumbRoom;
}

/** The comic's name, editable in place; it sizes to its words (a hidden copy sets the width). */
export const TitleField: React.FC<{ title: string; onCommit: (title: string) => void; current?: boolean }> = ({ title, onCommit, current }) => {
  const [draft, setDraft] = useState(title);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(title);
  }, [title]);
  const commit = () => {
    editing.current = false;
    const next = draft.trim().slice(0, 200);
    if (!next) {
      setDraft(title);
      return;
    }
    if (next !== title) onCommit(next);
  };
  const type = 'border border-transparent px-2 py-1 text-[15px] font-semibold tracking-tight coarse:text-base';
  return (
    <span className="inline-grid min-w-0 max-w-full">
      <span aria-hidden className={cn('invisible col-start-1 row-start-1 min-w-0 overflow-hidden whitespace-pre', type)}>
        {`${draft || ' '} `}
      </span>
      <input
        value={draft}
        onFocus={() => (editing.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            editing.current = false;
            setDraft(title);
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label="Comic title"
        aria-current={current ? 'page' : undefined}
        title={draft}
        maxLength={200}
        spellCheck={false}
        enterKeyHint="done"
        // 16 px on touch so focusing the title never zooms the page (iOS); ellipsis when it doesn't fit.
        className={cn(
          'col-start-1 row-start-1 w-full min-w-0 truncate rounded-lg bg-transparent text-[var(--ds-ink)] outline-none hover:border-[var(--ds-hairline)] focus:border-[var(--ds-focus)] focus:bg-[var(--ds-surface-soft)] coarse:min-h-[44px]',
          type,
          TRANSITION
        )}
      />
    </span>
  );
};

const CRUMB = `inline-flex h-8 min-w-0 max-w-full items-center rounded-[var(--ds-radius-control)] px-1.5 text-[13px] hover:bg-[var(--ds-hover)] coarse:h-11 ${FOCUS_RING}`;
const separator = <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />;

export function StudioBreadcrumb({ title, onRename, onMyComics, area, item, room = 'wide' }: StudioBreadcrumbProps) {
  const crumbs = breadcrumbCrumbs({ myComics: !!onMyComics, room, area: area?.label, item: item?.label });
  const has = (key: CrumbKey) => crumbs.some((c) => c.key === key);
  const current = crumbs[crumbs.length - 1]?.key;
  const crumb = (key: Exclude<CrumbKey, 'title'>, label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      aria-current={current === key ? 'page' : undefined}
      title={label}
      data-crumb={key}
      // A part's name can be long: it clips, but never below a 44 px target.
      className={cn(CRUMB, key === 'item' && 'min-w-11', current === key ? 'font-medium text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]')}
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
  return (
    // Clipped sideways only (focus outlines keep their room above and below; the inset keeps the first one's).
    <nav aria-label="Breadcrumb" className="-ml-1 flex min-w-0 max-w-[28rem] flex-1 items-center overflow-x-clip pl-1" data-breadcrumb data-room={room}>
      <ol className="m-0 flex min-w-0 list-none items-center gap-0.5 p-0">
        {has('comics') && onMyComics && (
          <li className="flex shrink-0 items-center gap-0.5">
            {crumb('comics', 'My comics', onMyComics)}
            {separator}
          </li>
        )}
        <li className="flex min-w-[2.5rem] items-center sm:min-w-[4rem]">
          <TitleField title={title} onCommit={onRename} current={current === 'title'} />
        </li>
        {/* An area's name is short (a tab's): it keeps its words, and the comic's name gives way. */}
        {has('area') && area && (
          <li className="flex max-w-[10rem] shrink-0 items-center gap-0.5">
            {separator}
            {crumb('area', area.label, area.onGo)}
          </li>
        )}
        {has('item') && item && (
          <li className="flex max-w-[10rem] items-center gap-0.5">
            {separator}
            {crumb('item', item.label, item.onGo)}
          </li>
        )}
      </ol>
    </nav>
  );
}
