// The Board — the "living comic". A structured, always-current view of the ComicDoc that
// fills in as the director works: Story · Cast · Style · Pages · Read. Each tab keeps its
// own scroll position; the page editor opens over everything when a page is focused.

import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { BookOpen, FileText, LayoutGrid, Palette, Users } from 'lucide-react';
import { formatUsd } from '../../../shared/comic/models';
import type { BoardTab, StudioController } from '../types';
import { HAIRLINE } from '../../chat/studioDesign';
import { Skeleton } from '../../studio/kit/Shimmer';
import { CastTab } from './CastTab';
import { PageEditor } from './PageEditor';
import { PagesTab } from './PagesTab';
import { ReaderTab } from './ReaderTab';
import { StoryTab } from './StoryTab';
import { StyleTab } from './StyleTab';
import { pageProgress } from './boardModel';
import { GhostButton, PrimaryButton, cx, useClickGuard } from './ui';

export const BOARD_TABS: { id: BoardTab; label: string; icon: React.ReactNode }[] = [
  { id: 'story', label: 'Story', icon: <FileText className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'cast', label: 'Cast', icon: <Users className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'style', label: 'Style', icon: <Palette className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'pages', label: 'Pages', icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'read', label: 'Read', icon: <BookOpen className="h-3.5 w-3.5" aria-hidden /> }
];

/** An open spend approval, mirrored on the board so a click here can be answered here. */
const GateBanner: React.FC<{ studio: StudioController }> = ({ studio }) => {
  const gate = studio.doc?.gate;
  const { busyKey, fire } = useClickGuard(4000);
  if (!gate || gate.status !== 'open') return null;
  return (
    <div
      role="region"
      aria-label="Waiting for your approval"
      className="mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-[#D97757]/35 bg-[#D97757]/10 px-3 py-2.5 sm:mx-4"
    >
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--ds-ink)]">
        <span className="font-semibold">{gate.title}</span>
        <span className="text-[var(--ds-muted)]">
          {' '}
          · ≈ {formatUsd(gate.estimateUsd)} · {gate.imageCount} {gate.imageCount === 1 ? 'image' : 'images'} on {gate.model}
          {gate.reason === 'budget' ? ' · over your budget cap' : ''}
        </span>
      </div>
      <div className="flex gap-2">
        <PrimaryButton size="sm" busy={busyKey === 'approve'} onClick={() => fire('approve', () => studio.act({ type: 'approve_gate', gateId: gate.id }))}>
          Approve
        </PrimaryButton>
        <GhostButton size="sm" disabled={busyKey === 'approve'} onClick={() => fire('decline', () => studio.act({ type: 'decline_gate', gateId: gate.id }))}>
          Not now
        </GhostButton>
      </div>
    </div>
  );
};

const TabBadge: React.FC<{ children: React.ReactNode; active: boolean }> = ({ children, active }) => (
  <span
    className={cx(
      'min-w-[1.25rem] rounded-full px-1.5 py-px text-center text-[10px] font-semibold tabular-nums leading-4',
      active ? 'bg-[#D97757]/15 text-[var(--ds-ink)]' : 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]'
    )}
  >
    {children}
  </span>
);

export const BoardPane: React.FC<{ studio: StudioController }> = ({ studio }) => {
  const { doc, tab, setTab } = studio;
  const tabRefs = useRef<Partial<Record<BoardTab, HTMLButtonElement | null>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTops = useRef<Partial<Record<BoardTab, number>>>({});
  const shownTab = useRef<BoardTab>(tab);

  // Remember each tab's scroll position; restore it when the tab comes back.
  const onScroll = useCallback(() => {
    if (scrollRef.current) scrollTops.current[shownTab.current] = scrollRef.current.scrollTop;
  }, []);
  useLayoutEffect(() => {
    shownTab.current = tab;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTops.current[tab] || 0;
  }, [tab]);

  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % BOARD_TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + BOARD_TABS.length) % BOARD_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = BOARD_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = BOARD_TABS[next].id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  // A focused page that no longer exists closes (the controller does this too; belt and braces).
  const focused = studio.focusedPageId && doc?.pages.some((p) => p.id === studio.focusedPageId) ? studio.focusedPageId : null;
  useEffect(() => {
    if (studio.focusedPageId && doc && !focused) studio.openPage(null);
  }, [studio, doc, focused]);

  if (!doc) {
    return (
      <div className="flex h-full min-h-0 flex-col" aria-busy={studio.loading || undefined}>
        {studio.loadError ? (
          <div role="alert" className="m-4 rounded-2xl border border-red-500/25 bg-red-500/[0.06] p-4 text-[13px] text-[var(--ds-ink)]">
            <p className="font-semibold">Couldn’t open this comic.</p>
            <p className="mt-1 text-[var(--ds-muted)]">{studio.loadError}</p>
            <GhostButton size="sm" className="mt-3" onClick={() => void studio.refresh()}>
              Try again
            </GhostButton>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            <Skeleton className="h-8 w-2/3" />
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="aspect-[2/3]" />
              <Skeleton className="aspect-[2/3]" />
            </div>
          </div>
        )}
      </div>
    );
  }

  const progress = pageProgress(doc);
  const badge = (id: BoardTab): React.ReactNode => {
    if (id === 'cast') return doc.cast.length ? doc.cast.length : null;
    if (id === 'pages') return progress.total ? `${progress.ready}/${progress.total}` : null;
    if (id === 'style') return doc.style.status === 'locked' ? '✓' : null;
    return null;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cx('flex shrink-0 items-center gap-2 border-x-0 border-t-0 px-3 py-2 sm:px-4', HAIRLINE)}>
        <span className="hidden text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] md:inline">Board</span>
        <div role="tablist" aria-label="Board" className="-mx-1 flex min-w-0 flex-1 gap-0.5 overflow-x-auto px-1 [scrollbar-width:none]">
          {BOARD_TABS.map((t, i) => {
            const active = t.id === tab;
            const b = badge(t.id);
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`board-tab-${t.id}`}
                aria-selected={active}
                aria-controls="board-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={cx(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-xl px-2 py-1.5 text-[13px] font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 sm:px-2.5',
                  active ? 'bg-[#D97757]/10 text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                )}
              >
                {/* Phones: labels only, so all five tabs fit without a hidden scroll. */}
                <span className="hidden sm:inline-flex">{t.icon}</span>
                {t.label}
                {b !== null && <TabBadge active={active}>{b}</TabBadge>}
              </button>
            );
          })}
        </div>
      </div>
      <GateBanner studio={studio} />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        id="board-panel"
        role="tabpanel"
        aria-labelledby={`board-tab-${tab}`}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus:outline-none"
      >
        {tab === 'story' && <StoryTab studio={studio} doc={doc} />}
        {tab === 'cast' && <CastTab studio={studio} doc={doc} />}
        {tab === 'style' && <StyleTab studio={studio} doc={doc} />}
        {tab === 'pages' && <PagesTab studio={studio} doc={doc} />}
        {tab === 'read' && <ReaderTab studio={studio} doc={doc} />}
      </div>
      {focused && <PageEditor studio={studio} doc={doc} pageId={focused} />}
    </div>
  );
};

export default BoardPane;
