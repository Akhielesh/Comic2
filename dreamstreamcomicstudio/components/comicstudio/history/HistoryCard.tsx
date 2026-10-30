// Comic History — the `history` conversation card (versions plan §3.3 "Card", §9; package H5).
//
// The card holds ids only ({view, versionId?, a?, b?, pageId?, scope?}) and renders by fetching from the owner API,
// so an old card in the conversation always shows the moment as it is stored — and never carries content of its own.
//   list      the latest moments · [Open History]
//   moment    one moment: what changed · [Open] (read, compare, restore from there)
//   compare   "3 pages changed" · [See changes]
//   confirm   "Restore page 3 from Tue 10:42?" — a piece: [Use then] at once (free, with Undo); the whole book:
//             [Restore…] opens the restore sheet (a whole-book restore always needs that tap)
//   undo_ai   "Undo the last AI change" · [Review and undo…]
// With Comic History off (caps.history false) it renders nothing.

import React, { useEffect, useState } from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { historyEnabled } from '../../../shared/comic/capabilities';
import { changedPageCount, type HistoryCard as HistoryCardData, type RestoreScope, type VersionRow } from '../../../shared/comic/history/index';
import type { CardProps } from '../extensions';
import { CardShell } from '../conversation/ui';
import { useCostFormat } from '../conversation/cost';
import { historyErrorText, useHistoryApi } from './historyApi';
import { changeGroupsOf, restorableId, restoredText, rowMetaText, viewerTimeZone, whenText } from './historyModel';
import { runHistoryAction, undoLastRestore } from './historyActions';
import { requestOpenHistory } from './openHistory';
import type { HistoryStudio } from './useHistory';
import { Note, PrimaryBtn, QuietBtn, RestoredToast } from './ui';

const scopeWords = (scope: RestoreScope | undefined, doc: HistoryStudio['doc']): string => {
  const n = (id: string) => doc?.pages.find((p) => p.id === id)?.n;
  switch (scope?.kind) {
    case 'page':
      return `page ${n(scope.pageId) ?? ''}${scope.part === 'text' ? ' (words only)' : scope.part === 'art' ? ' (art only)' : ''}`.replace('page  ', 'the page ');
    case 'panel':
      return 'that panel';
    case 'line':
      return 'that line';
    case 'character':
      return doc?.cast.find((c) => c.id === scope.id)?.name ?? 'that character';
    case 'place':
      return doc?.places.find((p) => p.id === scope.id)?.name ?? 'that place';
    case 'cover':
      return 'the cover';
    case 'script':
      return 'the script';
    case 'style':
      return 'the style';
    case 'language':
      return 'that edition';
    case 'keys':
      return 'those pieces';
    default:
      return 'the whole book';
  }
};

interface Loaded {
  row?: VersionRow;
  rows?: VersionRow[];
  lines?: string[];
  changed?: number;
  compareFrom?: string | null;
}

export const HistoryCardView: React.FC<CardProps<HistoryCardData> & { now?: number; tz?: string }> = ({ card, studio: base, now: nowProp, tz: tzProp }) => {
  const studio = base as HistoryStudio;
  const api = useHistoryApi();
  const cost = useCostFormat(studio);
  const projectId = studio.doc?.id;
  const enabled = historyEnabled(studio.caps);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone?: 'healthy' | 'attention'; undo?: () => void } | null>(null);
  const [sending, setSending] = useState(false);
  const now = nowProp ?? Date.now();
  const tz = tzProp ?? viewerTimeZone();
  const view = card?.view ?? 'list';
  const versionId = card?.versionId;
  const a = card?.a;
  const b = card?.b;

  useEffect(() => {
    if (!enabled || !projectId) return;
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    setError(null);
    const load = async (): Promise<Loaded> => {
      if (view === 'compare') {
        const res = await api.compare(projectId, a ?? versionId ?? 'published', b ?? 'now', { signal });
        return { changed: changedPageCount(res.diff), compareFrom: restorableId(res.a), ...(res.a.row ? { row: res.a.row } : {}) };
      }
      if ((view === 'moment' || view === 'confirm') && versionId) {
        const d = await api.detail(projectId, versionId, { signal });
        return { row: d.row, lines: (d.groups.length ? d.groups : changeGroupsOf(d.row.changes)).slice(0, 3).map((g) => `${g.title}${g.lines.length ? ` — ${g.lines.join(' · ')}` : ''}`) };
      }
      if (view === 'undo_ai') {
        const res = await api.list(projectId, { filter: 'ai', limit: 1 }, { signal });
        return { ...(res.rows[0] ? { row: res.rows[0] } : {}) };
      }
      const res = await api.list(projectId, { limit: 3 }, { signal });
      return { rows: res.rows };
    };
    load()
      .then((d) => !signal.aborted && setData(d))
      .catch((err) => !signal.aborted && setError(historyErrorText(err) || null));
    return () => ctrl.abort();
  }, [api, enabled, projectId, view, versionId, a, b]);

  if (!enabled || !studio.doc || !card) return null;
  const money = { governed: cost.governed, exact: cost.exact };
  const at = data?.row ? data.row.name || whenText(data.row.contentAt, now, tz) : '';
  const scope = card.scope;
  const partial = !!scope && scope.kind !== 'book';

  const useNow = async () => {
    if (!versionId || !scope || sending) return;
    setSending(true);
    const res = await runHistoryAction(studio, { type: 'history_restore', versionId, scope });
    setSending(false);
    if (!res.ok) {
      setToast({ message: res.error || 'Couldn’t bring that back. Nothing in your comic changed.', tone: 'attention' });
      return;
    }
    setToast({
      message: restoredText(scope, at || 'then', studio.doc),
      undo: () =>
        void undoLastRestore(studio, api, scope).then((u) =>
          setToast(u.ok ? { message: 'Undone — your book is back as it was.' } : { message: u.error || 'Couldn’t undo that. Nothing in your comic changed.', tone: 'attention' })
        )
    });
  };

  const title =
    view === 'compare'
      ? 'What changed'
      : view === 'confirm'
        ? `Restore ${scopeWords(scope, studio.doc)}${at ? ` from ${at}` : ''}?`
        : view === 'undo_ai'
          ? 'Undo the last AI change'
          : view === 'moment'
            ? data?.row?.name || data?.row?.label || 'A saved moment'
            : 'History';

  return (
    <CardShell title={title} icon={<HistoryIcon className="h-4 w-4" aria-hidden />} right="Free" aria-label={`History: ${title}`}>
      <div className="min-w-0 space-y-2" data-history-card={view}>
        {error && <Note tone="attention">{error}</Note>}
        {!data && !error && <p className="m-0 text-[13px] text-[var(--ds-muted)]">Loading…</p>}
        {data?.row && view !== 'compare' && <p className="m-0 text-[12.5px] tabular-nums text-[var(--ds-muted)] [overflow-wrap:anywhere]">{rowMetaText(data.row, money, tz)}</p>}
        {data?.lines && data.lines.length > 0 && (
          <ul className="m-0 list-disc space-y-0.5 pl-5 text-[13px] text-[var(--ds-ink)]">
            {data.lines.map((l) => (
              <li key={l} className="[overflow-wrap:anywhere]">
                {l}
              </li>
            ))}
          </ul>
        )}
        {data?.rows && (
          <ul className="m-0 list-none space-y-1 p-0">
            {data.rows.map((r) => (
              <li key={r.id} className="text-[13px] text-[var(--ds-ink)] [overflow-wrap:anywhere]">
                <span className="font-medium">{r.name || r.label}</span> <span className="text-[var(--ds-muted)]">· {rowMetaText(r, money, tz)}</span>
              </li>
            ))}
          </ul>
        )}
        {view === 'compare' && data && <p className="m-0 text-[13px] text-[var(--ds-ink)]">{data.changed ? `${data.changed} ${data.changed === 1 ? 'page' : 'pages'} changed` : 'No page changes'}</p>}
        {view === 'undo_ai' && data && !data.row && <p className="m-0 text-[13px] text-[var(--ds-muted)]">There’s no AI change to undo yet.</p>}
        {view === 'undo_ai' && data?.row && <p className="m-0 text-[13px] text-[var(--ds-ink)] [overflow-wrap:anywhere]">{data.row.label}</p>}
        {data && (
          <div className="flex min-w-0 flex-wrap gap-2 pt-1">
            {view === 'confirm' && partial && (
              <PrimaryBtn onClick={() => void useNow()} disabled={sending || !versionId}>
                {sending ? 'Bringing it back…' : 'Use then · Free'}
              </PrimaryBtn>
            )}
            {view === 'confirm' && !partial && versionId && <PrimaryBtn onClick={() => requestOpenHistory({ view: 'confirm', versionId })}>Restore… · Free</PrimaryBtn>}
            {view === 'undo_ai' && data.row && <PrimaryBtn onClick={() => requestOpenHistory({ view: 'undo_ai' })}>Review and undo… · Free</PrimaryBtn>}
            {view === 'compare' && <QuietBtn onClick={() => requestOpenHistory({ view: 'compare', ...(data.compareFrom ? { versionId: data.compareFrom } : {}), ...(card.pageId ? { pageId: card.pageId } : {}) })}>See changes</QuietBtn>}
            {(view === 'moment' || view === 'confirm') && versionId && <QuietBtn onClick={() => requestOpenHistory({ view: 'moment', versionId })}>Open</QuietBtn>}
            {view === 'list' && <QuietBtn onClick={() => requestOpenHistory({ view: 'list' })}>Open History</QuietBtn>}
          </div>
        )}
      </div>
      <RestoredToast message={toast?.message ?? null} tone={toast?.tone} onUndo={toast?.undo} onDismiss={() => setToast(null)} />
    </CardShell>
  );
};

export default HistoryCardView;
