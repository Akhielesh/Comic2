// The Board — the "living comic". A structured, always-current view of the ComicDoc that
// fills in as the director works: Story · Cast · Style · Pages · Read. Each tab keeps its
// own scroll position; the page editor opens over everything when a page is focused (and the
// back gesture closes it first — mobile.md §3.10).
//
// Feature tabs (Media, Languages, …) come from the tab registry (features.ts, contract
// §13.2): they merge with the built-ins by `order` and show only while `visible(doc, caps)`.
//
// Small screens (mobile.md §3.1, visualqa P1-6/P1-7): the tab strip is a row of 44 px chips that
// scrolls sideways with snap, fades the clipped edge so it reads as "more", and keeps the active
// tab in view; inactive badges step aside below 380 px. The spend gate stays pinned above the
// scroller as ONE compact line in a narrow board (details on demand) so the content keeps ≥ 45 %
// of a phone screen. The book timeline docks at the foot (its own summary bar; collapsed below
// `lg`, remembered per device; hidden in Read, where the reader owns the whole pane).
//
// Feature tabs show only while their `visible(doc, caps)` holds (Media once the comic has an image,
// Languages once there is dialogue). A tab the user is ON stays listed and rendered even if its
// check flips (a card or the director can open Languages early): never a blank panel.
// Prices print through formatCostForUser — governed users see a share of their usage, never dollars.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, FileText, LayoutGrid, Palette, Users } from 'lucide-react';
import { getImageModel } from '../../../shared/comic/models';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import type { BoardTab, StudioController, StudioTab } from '../types';
import { BUILTIN_TAB_ORDER, registeredTabs, type BoardTabRegistration } from '../features';
import { ACCENT_SOFT_BG, HAIRLINE, RADIUS_PANEL } from '../../chat/studioDesign';
import { Skeleton } from '../../studio/kit/Shimmer';
import { CastTab } from './CastTab';
import { PageEditor } from './PageEditor';
import { PagesTab } from './PagesTab';
import { ReaderTab } from './ReaderTab';
import { StoryTab } from './StoryTab';
import { StyleTab } from './StyleTab';
import { pageProgress } from './boardModel';
import { useCostFormat } from './costFormat';
import { GhostButton, PrimaryButton, cx, useClickGuard, useElementSize } from './ui';
import { useFormFactor } from '../mobile/useFormFactor';
import { useBackLayer } from '../mobile/backStack';
import { BookTimeline } from '../timeline/BookTimeline';

/** Below this board width the spend gate collapses to one line (details on demand). */
export const GATE_COMPACT_BELOW_PX = 520;
/** …and below this board HEIGHT (a landscape phone: the full banner would cover the Pages grid). */
export const GATE_COMPACT_BELOW_H_PX = 480;
/** Below this window width only the active tab keeps its badge (so the strip fits a 360 phone better). */
export const TAB_BADGES_MIN_WIDTH = 380;

/** The built-in tabs (always present, in this order). */
export const BOARD_TABS: { id: BoardTab; label: string; icon: React.ReactNode }[] = [
  { id: 'story', label: 'Story', icon: <FileText className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'cast', label: 'Cast', icon: <Users className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'style', label: 'Style', icon: <Palette className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'pages', label: 'Pages', icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'read', label: 'Read', icon: <BookOpen className="h-3.5 w-3.5" aria-hidden /> }
];

interface ShownTab {
  id: StudioTab;
  label: string;
  icon: React.ReactNode;
  /** Set for registry tabs; built-ins render their own panel below. */
  registration?: BoardTabRegistration;
}

const isVisible = (reg: BoardTabRegistration, doc: ComicDoc, caps: StudioCaps): boolean => {
  if (!reg.visible) return true;
  try {
    return !!reg.visible(doc, caps);
  } catch {
    return false; // a feature's visibility check must never break the board
  }
};

/**
 * Built-in tabs plus the registered tabs visible for this doc, sorted by `order` (stable). The
 * `active` registered tab is always included, so the strip never loses the tab whose panel is shown.
 */
export const boardTabsFor = (doc: ComicDoc, caps: StudioCaps, active?: StudioTab): ShownTab[] => {
  const builtIns = BOARD_TABS.map((t, i) => ({ tab: t as ShownTab, order: BUILTIN_TAB_ORDER[t.id] ?? (i + 1) * 100, i }));
  const extra = registeredTabs()
    .filter((reg) => reg.id === active || isVisible(reg, doc, caps))
    .map((reg, i) => ({ tab: { id: reg.id, label: reg.label, icon: reg.icon, registration: reg }, order: reg.order, i: BOARD_TABS.length + i }));
  return [...builtIns, ...extra].sort((a, b) => a.order - b.order || a.i - b.i).map((x) => x.tab);
};

/** An open spend approval, mirrored on the board so a click here can be answered here. */
export const GateBanner: React.FC<{
  studio: StudioController;
  compact?: boolean;
  /** A short board (a landscape phone): the one-line banner drops its outer spacing (one 44 px row). */
  dense?: boolean;
}> = ({ studio, compact = false, dense = false }) => {
  const gate = studio.doc?.gate;
  const { busyKey, fire } = useClickGuard(4000);
  const [details, setDetails] = useState(false);
  const cost = useCostFormat(studio.caps);
  if (!gate || gate.status !== 'open') return null;
  const price = cost.quote(gate.estimateUsd);
  // People read the model's nickname ("Nano Banana 2.1"), not a long raw id (visualqa P0-1 / P1-6).
  const modelName = getImageModel((gate.model || '').trim())?.nickname || gate.model;
  const images = `${gate.imageCount} ${gate.imageCount === 1 ? 'image' : 'images'} on ${modelName}`;
  const overBudget = gate.reason === 'budget' ? ' · over your budget cap' : '';
  const buttons = (
    <div className="flex shrink-0 gap-2">
      <PrimaryButton size={compact ? 'xs' : 'sm'} busy={busyKey === 'approve'} onClick={() => fire('approve', () => studio.act({ type: 'approve_gate', gateId: gate.id }))}>
        Approve
      </PrimaryButton>
      <GhostButton size={compact ? 'xs' : 'sm'} disabled={busyKey === 'approve'} onClick={() => fire('decline', () => studio.act({ type: 'decline_gate', gateId: gate.id }))}>
        Not now
      </GhostButton>
    </div>
  );

  if (compact) {
    // One calm line (≤ 56 px) on phones and narrow panes: what, how much, Approve / Not now.
    return (
      <div
        role="region"
        aria-label="Waiting for your approval"
        data-gate-banner="compact"
        className={cx('mx-2 shrink-0 border border-[var(--ds-hairline)] px-2.5 text-[var(--ds-ink)]', RADIUS_PANEL, ACCENT_SOFT_BG, dense ? 'mt-1 py-0' : 'mt-2 py-1.5')}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setDetails((d) => !d)}
            aria-expanded={details}
            title={`${gate.title} · ${price} · ${images}${overBudget}`}
            className="flex min-h-[36px] min-w-0 flex-1 items-center gap-1 text-left text-[12.5px] leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-[44px]"
          >
            <span className="min-w-0 truncate font-semibold">{gate.title}</span>
            <span className="min-w-0 max-w-[45%] shrink-0 truncate tabular-nums text-[var(--ds-muted)]">· {price}</span>
            <ChevronDown className={cx('h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)] transition-transform motion-reduce:transition-none', details && 'rotate-180')} aria-hidden />
            <span className="sr-only">{details ? 'Hide details' : 'Show details'}</span>
          </button>
          {buttons}
        </div>
        {details && (
          <p className="pb-1 pt-0.5 text-[11.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
            {images}
            {overBudget}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Waiting for your approval"
      data-gate-banner="full"
      className={cx('mx-3 mt-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border border-[var(--ds-hairline)] px-3 py-2.5 sm:mx-4', RADIUS_PANEL, ACCENT_SOFT_BG)}
    >
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">
        <span className="font-semibold">{gate.title}</span>
        <span className="text-[var(--ds-muted)]">
          {' '}
          · {price} · {images}
          {overBudget}
        </span>
      </div>
      {buttons}
    </div>
  );
};

/** Sideways-scrolling rows: which edges are clipped (for the "there is more" fade). */
const useEdgeClip = (ref: React.RefObject<HTMLElement | null>, deps: React.DependencyList) => {
  const [clip, setClip] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    setClip((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);
  return { clip, measure };
};

const FADE_MASK = {
  both: '[mask-image:linear-gradient(to_right,transparent,black_20px,black_calc(100%-28px),transparent)]',
  end: '[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]',
  start: '[mask-image:linear-gradient(to_right,transparent,black_20px)]'
};

/** A feature surface docked in the board (the book timeline): a crash hides it, never the board. */
class DockBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[comicstudio] board dock failed to render', error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The board while the page editor is open over it (a full-screen modal): frozen. Every edit in the
 * editor — a balloon drop, a line of text — changes the doc, and without this the whole board behind
 * the modal (every page card, the tab strip, the gate, the book timeline) re-rendered inside the same
 * task as the drop: one 190–230 ms task on a mid phone (QA `editor-drop-long-task`). Nobody can see or
 * touch the board then (the modal covers it and traps focus); it catches up in one render the moment
 * the editor closes. Hooks inside it (store subscriptions) still update themselves.
 */
export const FrozenWhileEditing = React.memo<{ frozen: boolean; children: React.ReactNode }>(
  ({ children }) => <>{children}</>,
  // Skip only while frozen before AND after: opening renders once (unchanged), closing catches up.
  (prev, next) => prev.frozen && next.frozen
);
FrozenWhileEditing.displayName = 'FrozenWhileEditing';

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
  const ff = useFormFactor();
  const [rootRef, rootSize] = useElementSize<HTMLDivElement>();
  const tabRefs = useRef<Partial<Record<BoardTab, HTMLButtonElement | null>>>({});
  const stripRef = useRef<HTMLDivElement>(null);
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

  const caps = studio.caps || DEFAULT_CAPS;
  const tabs = useMemo(() => (doc ? boardTabsFor(doc, caps, tab) : []), [doc, caps, tab]);
  const tabKey = tabs.map((t) => t.id).join('|');
  const { clip, measure } = useEdgeClip(stripRef, [tabKey, ff.width]);

  // Keep the active tab in view when it changes (a card or the director can switch tabs).
  useEffect(() => {
    const el = tabRefs.current[tab];
    if (el && typeof el.scrollIntoView === 'function') {
      try {
        el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      } catch {
        /* old engines without options */
      }
    }
    measure();
  }, [tab, tabKey, measure]);

  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next].id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  // A focused page that no longer exists closes (the controller does this too; belt and braces).
  const focused = studio.focusedPageId && doc?.pages.some((p) => p.id === studio.focusedPageId) ? studio.focusedPageId : null;
  useEffect(() => {
    if (studio.focusedPageId && doc && !focused) studio.openPage(null);
  }, [studio, doc, focused]);
  // Android back / browser back closes the page editor before it leaves the studio.
  const { openPage } = studio;
  useBackLayer(!!focused, () => openPage(null), 'page-editor');

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

  const gateCompact =
    (rootSize.width > 0 ? rootSize.width < GATE_COMPACT_BELOW_PX : ff.widthClass === 'compact') ||
    (rootSize.height > 0 ? rootSize.height < GATE_COMPACT_BELOW_H_PX : ff.heightClass === 'compact');
  const hideInactiveBadges = ff.width < TAB_BADGES_MIN_WIDTH;
  // A landscape phone (~343 px tall, of which the shell keeps ~140): the board's own chrome — the tab row
  // and the one-line gate — loses its outer padding, so the panel under them is not a 35 px slit.
  const denseChrome = ff.heightClass === 'compact';
  const mask = clip.start && clip.end ? FADE_MASK.both : clip.end ? FADE_MASK.end : clip.start ? FADE_MASK.start : '';

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-col" data-board data-board-frozen={focused ? 'true' : undefined}>
      <FrozenWhileEditing frozen={!!focused}>
        <div className={cx('flex shrink-0 items-center gap-2 border-x-0 border-t-0 px-2 sm:px-4', denseChrome ? 'py-0.5' : 'py-1.5 sm:py-2', HAIRLINE)} data-board-tabs={denseChrome ? 'dense' : undefined}>
          <span className="hidden text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] md:inline">Board</span>
          <div
            ref={stripRef}
            role="tablist"
            aria-label="Board"
            onScroll={measure}
            data-tab-strip
            className={cx('-mx-1 flex min-w-0 flex-1 snap-x snap-proximity scroll-px-2 gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', mask)}
          >
            {tabs.map((t, i) => {
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
                    'inline-flex shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-1.5 text-[13px] font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 sm:px-2.5 coarse:min-h-[44px] coarse:px-3',
                    active ? 'bg-[#D97757]/10 text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                  )}
                >
                  {/* Below 600 px: labels only (the row scrolls, with a fade, when it still doesn't fit). */}
                  <span className="hidden medium:inline-flex">{t.icon}</span>
                  {t.label}
                  {b !== null && (!hideInactiveBadges || active) && <TabBadge active={active}>{b}</TabBadge>}
                </button>
              );
            })}
          </div>
        </div>
        <GateBanner studio={studio} compact={gateCompact} dense={denseChrome} />
        <div
          ref={scrollRef}
          onScroll={onScroll}
          id="board-panel"
          role="tabpanel"
          aria-labelledby={`board-tab-${tab}`}
          tabIndex={-1}
          data-board-scroll={tab === 'read' ? 'reader' : 'board'}
          className={cx(
            'min-h-0 flex-1 overscroll-contain focus:outline-none',
            // Read: the reader owns the ONLY scroller (visualqa P1-6) — no nested scrolling, and on a phone
            // the page art shows on first view. Its root fills this box instead of forcing a min height.
            tab === 'read' ? 'flex flex-col overflow-hidden [&>div]:min-h-0' : 'overflow-y-auto'
          )}
        >
          {tab === 'story' && <StoryTab studio={studio} doc={doc} />}
          {tab === 'cast' && <CastTab studio={studio} doc={doc} />}
          {tab === 'style' && <StyleTab studio={studio} doc={doc} />}
          {tab === 'pages' && <PagesTab studio={studio} doc={doc} />}
          {tab === 'read' && <ReaderTab studio={studio} doc={doc} />}
          {(() => {
            const reg = tabs.find((t) => t.id === tab)?.registration;
            return reg ? <reg.Component studio={studio} /> : null;
          })()}
        </div>
        {/* Timeline dock slot: the book timeline's own summary bar / strip (collapsed below lg; not in Read). */}
        <div data-board-dock className="min-w-0 shrink-0 empty:hidden">
          {tab !== 'read' && (
            <DockBoundary>
              <BookTimeline studio={studio} />
            </DockBoundary>
          )}
        </div>
      </FrozenWhileEditing>
      {focused && <PageEditor studio={studio} doc={doc} pageId={focused} />}
    </div>
  );
};

export default BoardPane;
