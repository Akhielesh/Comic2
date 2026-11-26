import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CheckCheck, ChevronRight, ListTodo, RefreshCw } from 'lucide-react';
import type { FinishedKind, FinishedWork, WorkAttention } from '../../../shared/comic/workspaceActivity';
import { loadComicActivity, type ComicActivityRow } from '../../../services/comicWorkspaceActivity';
import { requestTaskTarget, taskDestination, WORK_CHANGED_EVENT } from './workspaceTaskTarget';

const attentionLabel: Record<WorkAttention, string> = {
  approval: 'Review drawing estimate', question: 'Answer the Director', credit: 'Top up or switch key', plan: 'Review page plan',
  style: 'Choose a look', interrupted: 'Resume interrupted draft', render_failed: 'Review drawing issue'
};
function finishedLabel(work: FinishedWork) {
  switch (work.kind) {
    case 'pages': return work.count === 1 ? '1 page drawn' : `${work.count} pages drawn`;
    case 'plan': return 'Page plan ready';
    case 'cover': return 'Cover drawn';
    case 'sheets': return 'Reference art ready';
    case 'looks': return 'Style samples ready';
    case 'translation': return 'Translation updated';
    case 'published': return 'Comic published';
    case 'reply': return 'Director replied';
  }
}

const clearedKey = (owner: string, projectId: string, kind: FinishedKind) => `dreamstream.comic-work.${owner}.${projectId}.${kind}`;
const workVersion = (work: FinishedWork) => `${work.at}:${work.count ?? 0}`;
const clock = (at: number) => {
  const checked = new Date(at);
  const time = checked.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return checked.toDateString() === new Date().toDateString() ? time : checked.toLocaleDateString() + ' ' + time;
};

export function ComicTaskActivity({ accountId, disabled, onOpen }: { accountId: string; disabled?: boolean; onOpen: (id: string) => void }) {
  // The parent also keys the panel by account, including while a previous owner's request is still in flight.
  const id = useId();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Awaited<ReturnType<typeof loadComicActivity>> | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed' | 'offline'>('loading');
  const [checked, setChecked] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [, redraw] = useState(0);
  const memory = useRef(new Map<string, string>());
  const lastAttempt = useRef(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let current = true;
    if (navigator.onLine === false) { setStatus('offline'); return; }
    lastAttempt.current = Date.now();
    setStatus('loading');
    const timeout = window.setTimeout(() => { ctrl.abort(); if (current) setStatus('failed'); }, 12_000);
    void loadComicActivity(accountId, offset, ctrl.signal).then((result) => {
      if (!current || ctrl.signal.aborted) return;
      setPage(result);
      setStatus('ready');
      setChecked(Date.now());
    }).catch(() => { if (current) setStatus(navigator.onLine === false ? 'offline' : 'failed'); })
      .finally(() => window.clearTimeout(timeout));
    return () => { current = false; ctrl.abort(); window.clearTimeout(timeout); };
  }, [accountId, offset, nonce]);

  useEffect(() => {
    let delayed: number | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const checkVisible = () => { if (visible() && Date.now() - lastAttempt.current > 2000) refresh(); };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.accountId !== accountId || !visible()) return;
      window.clearTimeout(delayed);
      delayed = window.setTimeout(refresh, 700);
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key?.startsWith(`dreamstream.comic-work.${accountId}.`) || !event.key) {
        memory.current.clear();
        redraw((n) => n + 1);
      }
    };
    window.addEventListener('storage', storageChanged);
    document.addEventListener('visibilitychange', checkVisible);
    window.addEventListener('focus', checkVisible);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    // An expanded feed also notices completions from another device while this tab stays in front.
    const timer = open ? window.setInterval(checkVisible, page?.rows.some((row) => row.working) ? 15_000 : 60_000) : undefined;
    return () => {
      window.removeEventListener('storage', storageChanged);
      document.removeEventListener('visibilitychange', checkVisible);
      window.removeEventListener('focus', checkVisible);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
      window.removeEventListener(WORK_CHANGED_EVENT, changed);
      window.clearTimeout(delayed);
      window.clearInterval(timer);
    };
  }, [accountId, open, page, refresh]);

  const rows = page?.rows ?? [];
  const waiting = rows.filter((row) => row.attention);
  const working = rows.filter((row) => row.working);
  const finished = rows.flatMap((row) => row.finished.map((work) => ({ row, work }))).filter(({ row, work }) => {
    const key = clearedKey(accountId, row.id, work.kind);
    let value = memory.current.get(key);
    try { value ??= localStorage.getItem(key) ?? undefined; } catch { /* Private window. */ }
    if (!value) return true;
    const [at, count] = value.split(':').map(Number);
    return work.at > at || (work.at === at && (work.count ?? 0) > count);
  }).sort((a, b) => b.work.at - a.work.at);
  const clearFinished = () => {
    for (const { row, work } of finished) {
      const key = clearedKey(accountId, row.id, work.kind);
      memory.current.set(key, workVersion(work));
      try { localStorage.setItem(key, workVersion(work)); } catch { /* Keep this view's choice. */ }
    }
    redraw((n) => n + 1);
  };
  const projectLink = (row: ComicActivityRow, kind: WorkAttention | FinishedKind, label: string) => {
    const destination = taskDestination(kind);
    const href = '/?' + new URLSearchParams({ view: 'studio', id: row.id, task: destination }).toString();
    return <a key={row.id + '-' + kind} href={href} aria-label={row.title + ' · ' + label} aria-disabled={disabled || undefined} className="comic-task-link" onClick={(event) => {
      if (disabled) { event.preventDefault(); return; }
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      requestTaskTarget(accountId, row.id, destination);
      onOpen(row.id);
    }}><span>{row.title}</span><small>{label}</small></a>;
  };
  const switchPage = (next: number) => { setPage(null); setChecked(0); setShowAll(false); setOffset(next); };
  return <section className="comic-task-activity" aria-label="AI activity">
    <button type="button" className="comic-task-toggle" aria-expanded={open} aria-controls={id} onClick={() => { if (!open && Date.now() - lastAttempt.current > 15_000) refresh(); setOpen(!open); }}>
      <ListTodo aria-hidden /><span>AI activity</span>{waiting.length > 0 && <small>{waiting.length} to review</small>}
      {!waiting.length && finished.length > 0 && <small>{finished.length} ready</small>}<ChevronRight aria-hidden className={open ? 'is-open' : ''} />
    </button>
    {open && <div id={id} className="comic-task-body">
      <div className="comic-task-sync"><span role="status">{status === 'loading' ? 'Checking activity…' : status === 'offline' ? 'Offline' : status === 'failed' ? 'Couldn’t refresh' : 'Checked'}{status !== 'loading' && checked > 0 && <small>{status === 'ready' ? clock(checked) : 'Last checked ' + clock(checked)}</small>}</span>
        <button type="button" disabled={status === 'loading' || status === 'offline'} aria-label="Refresh AI activity" onClick={refresh}><RefreshCw aria-hidden /></button>
      </div>
      {waiting.length > 0 && <><h3>Needs you</h3>{waiting.map((row) => projectLink(row, row.attention!, attentionLabel[row.attention!]))}</>}
      {working.length > 0 && <><h3>In progress</h3>{working.map((row) => projectLink(row, 'reply', row.updatedAt && Date.now() - row.updatedAt > 15 * 60_000 ? 'Check stalled progress' : 'Last reported in progress'))}</>}
      {finished.length > 0 && <><h3>Finished</h3>{(showAll ? finished : finished.slice(0, 4)).map(({ row, work }) => projectLink(row, work.kind, finishedLabel(work)))}
        {finished.length > 4 && <button className="comic-task-secondary" type="button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer results' : `Show all ${finished.length} results`}</button>}
        <button type="button" className="comic-task-secondary" onClick={clearFinished}><CheckCheck aria-hidden />Clear finished here</button></>}
      {page && !finished.length && !waiting.length && !working.length && <p>No recent tasks in these comics.</p>}
      {offset > 0 && <button type="button" className="comic-task-secondary" onClick={() => switchPage(0)}>Back to recent comics</button>}
      {page?.hasMore && <button type="button" className="comic-task-secondary" disabled={status === 'offline' || status === 'loading'} onClick={() => switchPage(page.next)}>Check older comics</button>}
    </div>}
  </section>;
}
