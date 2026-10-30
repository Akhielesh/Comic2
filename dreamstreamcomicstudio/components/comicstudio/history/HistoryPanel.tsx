// Comic History — the History panel (versions plan §8; package H5).
//
// HistoryBrowser is the whole History experience; HistoryPanel hosts it in a sheet (a BottomSheet on phones that
// snaps at 60 % / 100 %, a 400 px right drawer elsewhere) and the History tab hosts it inline.
//
//   list      "Saved automatically · Looking back and restoring are free" · [Save version] · the filmstrip of the
//             selected moment and its scrubber · the moments by day with filter chips · "Earlier (images only)" for
//             older comics · "Classic snapshots" for classic imports · the retention sentence
//   moment    what changed, [Read this version] [Compare with now] [Restore…], More (name, undo this AI change)
//   compare   the book / page compare with "Use then" on every piece
//   reader    the moment's book in the real reader, read-only
//   sheets    Restore (whole book) · Save version · Undo the last AI change
//
// Every view above the list and every sheet is a layer on the shared back stack, so Android back (and the browser's
// back) closes the topmost first: a sheet, then the views one by one, then the panel. Nothing here spends: every
// action is a free history_* StudioAction through the studio controller, and reading is a free owner-route read.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookmarkPlus } from 'lucide-react';
import { historyEnabled } from '../../../shared/comic/capabilities';
import type { CompareRef, RestoreScope, UndoAiDecision } from '../../../shared/comic/history/types';
import { useBackLayer } from '../mobile/backStack';
import { useCostFormat } from '../conversation/cost';
import { BookCompare } from './BookCompare';
import { runHistoryAction, undoLastRestore, type ActResult } from './historyActions';
import { ClassicSnapshots } from './ClassicSnapshots';
import { EarlierImages } from './EarlierImages';
import { Filmstrip } from './Filmstrip';
import { useHistoryApi, type HistoryFilter } from './historyApi';
import { classicSourceOf, HISTORY_COPY, nextDraftName, pageById, pageScope, restoredText, startRowOf, viewerTimeZone, type MoneyWords, type RestoreFollowUp } from './historyModel';
import { MomentDetail } from './MomentDetail';
import { MomentList } from './MomentList';
import type { OpenHistoryRequest } from './openHistory';
import { RestoreSheet } from './RestoreSheet';
import { SaveVersionSheet } from './SaveVersionSheet';
import { Scrubber } from './Scrubber';
import { UndoAiSheet } from './UndoAiSheet';
import { useHistory, useLatestAiRow, type HistoryStudio } from './useHistory';
import { HistorySheet, IconBtn, Note, QuietBtn, RestoredToast, useHistoryReducedMotion, useIsPhone, type ToastAction } from './ui';
import { redrawPrice } from '../timeline/bookModel';
import { VersionReader } from './VersionReader';

/** A request to open History at a view (each request gets a fresh seq, so the same request twice still applies). */
export interface HistoryOpenRequest extends OpenHistoryRequest {
  seq: number;
}

type View = { kind: 'moment'; versionId: string } | { kind: 'compare'; a: CompareRef; b?: CompareRef; pageId?: string | null } | { kind: 'reader'; versionId: string };
type Sheet = null | { kind: 'restore'; versionId: string } | { kind: 'save' } | { kind: 'undo_ai' };
interface Toast {
  message: string;
  tone?: 'healthy' | 'attention';
  undo?: () => void;
  actions?: ToastAction[];
}

/** One view above the list: one entry on the back stack while it is shown. */
const ViewLayer: React.FC<{ depth: number; onBack(): void; children: React.ReactNode }> = ({ depth, onBack, children }) => {
  useBackLayer(true, onBack, `history:view:${depth}`);
  return <>{children}</>;
};

export interface HistoryBrowserProps {
  studio: HistoryStudio;
  open: boolean;
  request?: HistoryOpenRequest | null;
  /** Inline (the History tab): shows its own heading. */
  inline?: boolean;
  /** Test / scene clock and zone (default: now, the viewer's zone). */
  now?: number;
  tz?: string;
}

export const HistoryBrowser: React.FC<HistoryBrowserProps> = ({ studio, open, request, inline, now: nowProp, tz: tzProp }) => {
  const api = useHistoryApi();
  const phone = useIsPhone();
  const reducedMotion = useHistoryReducedMotion();
  const tz = useMemo(() => tzProp ?? viewerTimeZone(), [tzProp]);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [pageFilterId, setPageFilterId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stack, setStack] = useState<View[]>([]);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const list = useHistory(studio, { open, filter, pageId: pageFilterId });
  // Bumped after every action that changed the comic or its History: the open compare and the latest-AI lookup read
  // again (the list reloads too), so what came back stops showing as changed and a new moment shows at once.
  const [refresh, setRefresh] = useState(0);
  const liveRowId = studio.lastHistoryVersion?.id ?? '';
  const latestAi = useLatestAiRow(studio, open, `${refresh}:${liveRowId}`);
  // The clock the day groups and "Tue 10:42" read: taken when the moments arrive (stable between renders, so the
  // restore preview is not recomputed on every keystroke).
  const now = useMemo(() => nowProp ?? Date.now(), [nowProp, open, list.rows]);
  const cost = useCostFormat(studio);
  const money: MoneyWords = useMemo(() => ({ governed: cost.governed, exact: cost.exact }), [cost]);
  const costRef = useRef(cost);
  costRef.current = cost;
  const studioRef = useRef(studio);
  studioRef.current = studio;
  const doc = studio.doc;

  // A request (the header button, a card, a link, a typed "show history"): the list first, then — on the next
  // render, after the sheet's own back-stack entry — the view it asks for.
  const seq = request?.seq;
  const [pending, setPending] = useState<HistoryOpenRequest | null>(null);
  useEffect(() => {
    if (!open || !request) return;
    setStack([]);
    setSheet(null);
    if (request.pageId && request.view !== 'compare') {
      setPageFilterId(request.pageId);
      setFilter('page');
    } else if (!request.view || request.view === 'list') {
      setFilter('all');
    }
    if (request.versionId) setSelectedId(request.versionId);
    setPending(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seq]);
  useEffect(() => {
    if (!pending) return;
    setPending(null);
    const { view, versionId, pageId } = pending;
    if (view === 'moment' && versionId) setStack([{ kind: 'moment', versionId }]);
    else if (view === 'compare' && versionId) setStack([{ kind: 'compare', a: versionId, b: 'now', pageId: pageId ?? null }]);
    else if (view === 'confirm' && versionId) {
      setStack([{ kind: 'moment', versionId }]);
      setSheet({ kind: 'restore', versionId });
    } else if (view === 'undo_ai') setSheet({ kind: 'undo_ai' });
  }, [pending]);
  useEffect(() => {
    if (!open) {
      setStack([]);
      setSheet(null);
    }
  }, [open]);

  const push = useCallback((v: View) => setStack((s) => [...s, v]), []);
  const popTo = useCallback((depth: number) => setStack((s) => s.slice(0, depth)), []);
  const rows = list.rows;
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const focusedPageId = request?.pageId ?? studio.focusedPageId ?? null;
  const focusedPage = pageById(doc, pageFilterId ?? focusedPageId);
  const pageLabel = focusedPage ? `Page ${focusedPage.n}` : null;
  const start = startRowOf(rows);
  const classic = classicSourceOf(rows);
  const onlyStart = rows.length <= 1 && rows.every((r) => r.kind === 'start');
  // When History started (the shared Earlier derivation's `before`): the start row's createdAt once it is loaded; with
  // every moment loaded and no start row, the oldest moment's (History began no later). Unknown while older moments
  // are still unloaded — "Earlier (images only)" waits rather than listing drawings made after History started.
  const startedAt: number | null | undefined = start ? start.createdAt : list.hasMore ? undefined : rows[rows.length - 1]?.createdAt ?? null;

  // ── Actions (all free) ──────────────────────────────────────────────────────

  const reloadList = list.reload;
  /** Something changed: read the list, the open compare and the latest AI run again. */
  const changed = useCallback(() => {
    reloadList();
    setRefresh((n) => n + 1);
  }, [reloadList]);

  const undoRestore = useCallback(
    async (scope: RestoreScope, beforeVersionId?: string) => {
      const res = await undoLastRestore(studioRef.current, api, scope, beforeVersionId);
      if (res.ok) changed();
      setToast(res.ok ? { message: 'Undone — your book is back as it was.' } : { message: res.error || 'Couldn’t undo that. Nothing in your comic changed.', tone: 'attention' });
    },
    [api, changed]
  );

  const restore = useCallback(
    async (versionId: string, scope: RestoreScope, at: string, baseRev?: number, followUp?: RestoreFollowUp): Promise<ActResult> => {
      const res = await runHistoryAction(studioRef.current, { type: 'history_restore', versionId, scope, ...(baseRev !== undefined ? { baseRev } : {}) });
      if (res.ok) {
        changed();
        const undo = () => void undoRestore(scope, res.beforeVersionId);
        const message = restoredText(scope, at, studioRef.current.doc);
        if (followUp?.kind === 'panel_drawing') {
          // §6.3 Panel: the drawing still shows the newer panel — the earlier drawing (free) or a quoted redraw.
          const doc = studioRef.current.doc;
          const n = doc?.pages.find((p) => p.id === followUp.pageId)?.n ?? followUp.pageN;
          // Own-key comics: the full controller carries byok (caps.byok otherwise).
          const st = studioRef.current as HistoryStudio & { byok?: boolean };
          const usd = doc ? redrawPrice(doc, 'page', !!(st.byok || st.caps?.byok)) : 0;
          setToast({
            message: `${message}. ${HISTORY_COPY.panelDrawing}`,
            undo,
            actions: [
              { label: 'Use the earlier drawing too · Free', primary: true, onClick: () => void restore(versionId, pageScope(followUp.pageId, 'art', studioRef.current.doc), at) },
              usd > 0
                ? {
                    label: `Redraw ${n ? `page ${n}` : 'the page'} · ${costRef.current.approx(usd)}`,
                    onClick: () => {
                      setToast(null);
                      // The normal quoted redraw, as the timeline sends it (the confirm policy applies as everywhere
                      // else); only on this tap, never automatic.
                      void studioRef.current.act({ type: 'render_pages', pageIds: [followUp.pageId], force: true, quotedUsd: usd });
                    }
                  }
                : {
                    // No price known here: never call a paid redraw "Free" — open the page, where Redraw shows its quote.
                    label: `Redraw ${n ? `page ${n}` : 'the page'}…`,
                    onClick: () => {
                      setToast(null);
                      studioRef.current.openPage(followUp.pageId);
                    }
                  }
            ]
          });
        } else {
          setToast({ message, undo });
        }
        if (scope.kind === 'book') setStack([]);
      } else if (scope.kind !== 'book') {
        setToast({ message: res.error || 'Couldn’t bring that back. Nothing in your comic changed.', tone: 'attention' });
      }
      return res;
    },
    [undoRestore, changed]
  );

  const useThen = useCallback((versionId: string, scope: RestoreScope, at: string, followUp?: RestoreFollowUp) => void restore(versionId, scope, at, undefined, followUp), [restore]);

  const save = useCallback(
    async (name: string, note: string): Promise<ActResult> => {
      const res = await runHistoryAction(studioRef.current, { type: 'history_save', name, ...(note ? { note } : {}) });
      if (res.ok) {
        changed();
        setToast({ message: `Saved “${name}”. Named versions are kept forever.` });
      }
      return res;
    },
    [changed]
  );

  const undoAi = useCallback(
    async (decisions: Record<string, UndoAiDecision>): Promise<ActResult> => {
      const res = await runHistoryAction(studioRef.current, { type: 'history_undo_ai', ...(Object.keys(decisions).length ? { decisions } : {}) });
      if (res.ok) {
        changed();
        setToast({ message: 'Undid the last AI change. Its drawings stay in each page’s versions.' });
      }
      return res;
    },
    [changed]
  );

  if (!doc) return null;
  const top = stack[stack.length - 1];

  const backBar = (depth: number, title: string) => (
    <div className="flex min-w-0 items-center gap-1 px-2 pt-1">
      <IconBtn label="Back" onClick={() => popTo(depth)}>
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </IconBtn>
      <p className="m-0 min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ds-muted)]">{title}</p>
    </div>
  );

  const listView = (
    <div className="min-w-0" data-history-view="list" hidden={!!top}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pb-1 pt-1">
        {inline && <h2 className="m-0 w-full text-[16px] font-semibold text-[var(--ds-ink)] ds-font-display">{HISTORY_COPY.title}</h2>}
        <p className="m-0 min-w-0 flex-1 text-[12.5px] leading-5 text-[var(--ds-muted)]">{HISTORY_COPY.subline}</p>
        <QuietBtn onClick={() => setSheet({ kind: 'save' })}>
          <BookmarkPlus className="h-4 w-4" aria-hidden />
          Save version
        </QuietBtn>
      </div>
      {list.error && <Note tone="attention" action={<QuietBtn onClick={list.reload}>Try again</QuietBtn>}>{list.error}</Note>}
      {list.loading && !rows.length && !list.error && <Note>Loading History…</Note>}
      {list.loaded && !list.loading && !list.error && filter === 'all' && onlyStart && (
        <p className="m-0 px-4 py-2 text-[13.5px] leading-5 text-[var(--ds-ink)]" data-history-empty>
          {HISTORY_COPY.empty}
        </p>
      )}
      {selected && rows.length > 0 && (
        <div className="min-w-0">
          <Filmstrip row={selected} live={doc} urlFor={(p) => list.urlFor(p, { width: 160 })} reducedMotion={reducedMotion} onOpenPage={(pageId) => push({ kind: 'compare', a: selected.id, b: 'now', pageId })} />
          <Scrubber rows={rows} selectedId={selected.id} onSelect={setSelectedId} now={now} tz={tz} reducedMotion={reducedMotion} />
        </div>
      )}
      {(rows.length > 0 || filter !== 'all') && (
        <MomentList
          rows={rows}
          selectedId={selected?.id ?? null}
          money={money}
          now={now}
          tz={tz}
          urlFor={(p) => list.urlFor(p, { width: 160 })}
          onOpen={(row) => {
            setSelectedId(row.id);
            push({ kind: 'moment', versionId: row.id });
          }}
          onFocusRow={(row) => setSelectedId(row.id)}
          filter={filter}
          onFilter={(f) => {
            setFilter(f);
            if (f === 'page') setPageFilterId(focusedPage?.id ?? null);
          }}
          pageLabel={pageLabel}
          hasMore={list.hasMore}
          loadingMore={list.loadingMore}
          onLoadMore={list.loadMore}
        />
      )}
      {filter === 'all' && list.loaded && !list.error && startedAt !== undefined && <EarlierImages studio={studio} startedAt={startedAt} now={now} tz={tz} />}
      {classic && <ClassicSnapshots studio={studio} classicProjectId={classic} now={now} tz={tz} />}
      <p className="m-0 border-t border-[var(--ds-hairline)] px-4 py-3 text-[12px] leading-5 text-[var(--ds-muted)]" data-history-retention>
        {HISTORY_COPY.retention}
      </p>
    </div>
  );

  const viewOf = (v: View, depth: number) => {
    if (v.kind === 'moment') {
      return (
        <>
          {backBar(depth - 1, 'Moments')}
          <MomentDetail
            studio={studio}
            versionId={v.versionId}
            rows={rows}
            newestId={filter === 'all' ? rows[0]?.id ?? null : null}
            latestAiId={latestAi.row?.id ?? null}
            money={money}
            tz={tz}
            onRead={(id) => push({ kind: 'reader', versionId: id })}
            onCompare={(id, pageId) => push({ kind: 'compare', a: id, b: 'now', pageId: pageId ?? null })}
            onRestore={(id) => setSheet({ kind: 'restore', versionId: id })}
            onUndoAi={() => setSheet({ kind: 'undo_ai' })}
            onName={() => setSheet({ kind: 'save' })}
          />
        </>
      );
    }
    if (v.kind === 'compare') {
      return (
        <>
          {backBar(depth - 1, 'Compare')}
          <BookCompare
            studio={studio}
            a={v.a}
            b={v.b}
            initialPageId={v.pageId}
            now={now}
            tz={tz}
            phone={phone}
            reducedMotion={reducedMotion}
            onUseThen={useThen}
            onRestoreBook={(id) => setSheet({ kind: 'restore', versionId: id })}
            refreshKey={refresh}
          />
        </>
      );
    }
    return (
      <>
        {backBar(depth - 1, 'Read a version')}
        <VersionReader studio={studio} versionId={v.versionId} now={now} tz={tz} onCompare={(id) => push({ kind: 'compare', a: id, b: 'now' })} onRestore={(id) => setSheet({ kind: 'restore', versionId: id })} onBack={() => popTo(0)} />
      </>
    );
  };

  return (
    <div className="min-w-0" data-history-browser>
      {listView}
      {stack.map((v, i) => (
        <ViewLayer key={`${i}:${v.kind}`} depth={i + 1} onBack={() => popTo(i)}>
          <div className="min-w-0" data-history-view={v.kind} hidden={i !== stack.length - 1}>
            {viewOf(v, i + 1)}
          </div>
        </ViewLayer>
      ))}
      <RestoreSheet studio={studio} versionId={sheet?.kind === 'restore' ? sheet.versionId : null} now={now} tz={tz} onClose={() => setSheet(null)} onRestore={restore} />
      <SaveVersionSheet open={sheet?.kind === 'save'} suggestedName={nextDraftName(rows)} onClose={() => setSheet(null)} onSave={save} />
      <UndoAiSheet studio={studio} open={sheet?.kind === 'undo_ai'} refresh={`${refresh}:${liveRowId}`} now={now} tz={tz} onClose={() => setSheet(null)} onUndo={undoAi} />
      <RestoredToast message={toast?.message ?? null} tone={toast?.tone} onUndo={toast?.undo} actions={toast?.actions} onDismiss={() => setToast(null)} />
    </div>
  );
};

export interface HistoryPanelProps {
  studio: HistoryStudio;
  open: boolean;
  onClose(): void;
  request?: HistoryOpenRequest | null;
  now?: number;
  tz?: string;
}

/** The History panel: a sheet on phones, a right drawer elsewhere. Renders nothing while Comic History is off. */
export const HistoryPanel: React.FC<HistoryPanelProps> = ({ studio, open, onClose, request, now, tz }) => {
  if (!historyEnabled(studio.caps) || !studio.doc) return null;
  return (
    <HistorySheet open={open} onClose={onClose} label={HISTORY_COPY.title}>
      <HistoryBrowser studio={studio} open={open} request={request} now={now} tz={tz} />
    </HistorySheet>
  );
};

export default HistoryPanel;
