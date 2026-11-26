// "Your comics" in the side panel (SH-C1): every comic once, grouped Needs you, In progress, Finished and Recent, each
// with its stage (the five marks) and one status line. It replaces the old AI activity feed, whose groups now live in
// this list instead of beside it. Opening a row goes where its news is (the estimate, the pages, the conversation),
// through the same task target the feed used; nothing here starts work or shows a price.

import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, CheckCheck, FileText, RefreshCw } from 'lucide-react';
import type { Project } from '../../../types';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT, FOCUS_RING, MUTED, OVERLINE } from '../../chat/studioDesign';
import { requestTaskTarget } from '../home/workspaceTaskTarget';
import { comicRowName, FINISHED_SHOWN, panelComics, type PanelComic, type PanelCurrentComic } from './panelModel';
import { usePanelActivity, type PanelActivity } from './usePanelActivity';
import { StageMarks } from './StageMarks';
import { PANEL_ROW, PANEL_ROW_CURRENT, PANEL_ROW_INK } from './panelStyles';

export interface PanelComicsProps {
  projects: readonly Project[];
  /** App's project list has loaded: it is the list (panelModel.ts). */
  projectsLoaded?: boolean;
  accountId?: string;
  disabled?: boolean;
  /** The comic you are in (its row looks current and reads its live stage and news). */
  current?: PanelCurrentComic;
  onOpenStudio(id: string): void;
  onOpenProject(id: string): void;
  /** The full list (My comics), offered when Recent leaves comics out; absent on My comics itself. */
  onAllComics?(): void;
}

const clock = (at: number) => {
  const checked = new Date(at);
  const time = checked.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return checked.toDateString() === new Date().toDateString() ? time : `${checked.toLocaleDateString()} ${time}`;
};

const SMALL_ACTION = `inline-flex min-h-11 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-3 text-xs ${MUTED} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] ${FOCUS_RING} disabled:cursor-default disabled:opacity-50`;

/** Without an account (a preview, the QA scenes) the list is the project list alone; with one, its activity too. */
export function PanelComics(props: PanelComicsProps) {
  return props.accountId ? <AccountComics key={props.accountId} {...props} accountId={props.accountId} /> : <ComicList {...props} activity={null} />;
}

function AccountComics(props: PanelComicsProps & { accountId: string }) {
  const activity = usePanelActivity(props.accountId);
  return <ComicList {...props} activity={activity} />;
}

function ComicList({ projects, projectsLoaded, accountId, disabled, current, onOpenStudio, onOpenProject, onAllComics, activity }: PanelComicsProps & { activity: PanelActivity | null }) {
  const labelId = useId();
  const groupId = useId();
  const [showAll, setShowAll] = useState(false);
  // Said to screen readers after a choice that removes the control in use ("Finished cleared").
  const [note, setNote] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const rows = activity?.rows ?? null;
  // A small list, read again on each render: the viewer's cleared choices and the clock move it too.
  const { groups, hiddenRecent, empty } = panelComics({ projects, projectsLoaded, rows: activity ? rows : [], now: Date.now(), isCleared: activity?.isCleared, current });
  const status = activity?.status;
  // A background load (after a run settles, on coming back to the tab) is quiet: the Refresh icon turns, and the
  // list neither announces it nor moves. Only a load the person asked for, or the first one, says so.
  const statusWords =
    status === 'loading' ? (activity?.background ? '' : 'Checking your comics…')
    : status === 'offline' ? (activity?.checked ? `Offline · Last checked ${clock(activity.checked)}` : 'Offline')
    : status === 'failed' ? (activity?.checked ? `Couldn’t refresh · Last checked ${clock(activity.checked)}` : 'Couldn’t refresh')
    : '';
  useEffect(() => {
    if (status === 'loading') setNote('');
  }, [status]);

  const open = (comic: PanelComic) => (event: React.MouseEvent) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    // A modified click opens the link in a new tab, as any link does.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (comic.task && accountId) requestTaskTarget(accountId, comic.id, comic.task);
    onOpenStudio(comic.id);
  };

  const row = (comic: PanelComic) => {
    const here = current?.id === comic.id;
    const body = (
      <>
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className={cn('flex-1 font-medium text-[var(--ds-ink)]', CLIP_TEXT)}>{comic.title}</span>
          {comic.stage && <StageMarks steps={comic.stage.steps} />}
        </span>
        {comic.status && <span className={cn('w-full text-xs leading-4 tabular-nums', MUTED, CLIP_TEXT)}>{comic.status}</span>}
      </>
    );
    // The comic you are in looks current; "Where you are" above is the one current-page mark for screen readers.
    const className = cn(PANEL_ROW, 'flex-col items-start justify-center gap-0.5 py-1.5', here ? PANEL_ROW_CURRENT : PANEL_ROW_INK, 'font-normal');
    if (!comic.studio) {
      return (
        <button type="button" disabled={disabled} onClick={() => onOpenProject(comic.id)} aria-label={comicRowName(comic)} title={comic.title} className={className}>
          {body}
        </button>
      );
    }
    const params: Record<string, string> = { view: 'studio', id: comic.id };
    if (comic.task) params.task = comic.task;
    return (
      <a
        href={`/?${new URLSearchParams(params).toString()}`}
        aria-label={comicRowName(comic)}
        data-panel-current={here || undefined}
        aria-disabled={disabled || undefined}
        title={comic.title}
        onClick={open(comic)}
        className={className}
        data-panel-comic-row={comic.group}
      >
        {body}
      </a>
    );
  };

  const finished = groups.find((g) => g.group === 'finished')?.comics ?? [];
  const clearFinished = () => {
    activity?.clear(finished.flatMap((comic) => comic.fresh.map((work) => ({ id: comic.id, work }))));
    // The Finished group (and this button) goes: keep the place at the top of Your comics, and say what happened.
    const refreshButton = refreshRef.current;
    if (refreshButton && !refreshButton.disabled) refreshButton.focus();
    else listRef.current?.focus();
    setNote('Finished cleared');
  };

  return (
    <div ref={listRef} tabIndex={-1} role="group" aria-labelledby={labelId} data-panel-comics className="flex min-w-0 flex-col gap-1 outline-none">
      <div className="flex items-center justify-between gap-2 pl-3 pt-4">
        <p id={labelId} className={cn('m-0', OVERLINE)}>
          Your comics
        </p>
        {activity && (
          <button
            ref={refreshRef}
            type="button"
            onClick={activity.refresh}
            disabled={status === 'offline'}
            aria-label="Refresh your comics"
            title={status === 'loading' ? 'Checking your comics…' : activity.checked ? `Checked ${clock(activity.checked)}` : 'Refresh'}
            className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-[var(--ds-radius-control)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50', MUTED, FOCUS_RING)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', status === 'loading' && 'animate-spin motion-reduce:animate-none')} aria-hidden />
          </button>
        )}
      </div>
      {activity && (
        <p role="status" className={cn('m-0 px-3 text-xs leading-4', MUTED, !statusWords && 'sr-only')}>
          {statusWords}
          {note && <span className="sr-only">{statusWords ? ` · ${note}` : note}</span>}
        </p>
      )}
      {groups.map(({ group, label, comics }) => {
        const shown = group === 'finished' && !showAll ? comics.slice(0, FINISHED_SHOWN) : comics;
        const id = `${groupId}-${group}`;
        return (
          <div key={group} className="flex flex-col gap-0.5" data-panel-group={group}>
            <div className="flex min-h-8 items-center justify-between gap-2 pl-3">
              <p id={id} className="m-0 text-xs font-semibold text-[var(--ds-ink)]">
                {label}
              </p>
              {group === 'finished' && activity && (
                <button type="button" onClick={clearFinished} className={SMALL_ACTION}>
                  <CheckCheck className="h-3.5 w-3.5" aria-hidden />
                  Clear finished
                </button>
              )}
            </div>
            <ul aria-labelledby={id} className="m-0 flex list-none flex-col gap-0.5 p-0">
              {shown.map((comic) => (
                <li key={comic.id} className="min-w-0">
                  {row(comic)}
                </li>
              ))}
            </ul>
            {group === 'finished' && comics.length > FINISHED_SHOWN && (
              <button type="button" onClick={() => setShowAll(!showAll)} aria-expanded={showAll} className={SMALL_ACTION}>
                {showAll ? 'Show fewer' : `Show all ${comics.length} finished`}
              </button>
            )}
          </div>
        );
      })}
      {empty && <p className={cn('m-0 px-3 py-2 text-xs leading-5', MUTED)}>Your comics will appear here.</p>}
      {onAllComics && hiddenRecent > 0 && (
        <button type="button" disabled={disabled} onClick={onAllComics} className={cn(PANEL_ROW, PANEL_ROW_INK)}>
          <FileText className="h-4 w-4 shrink-0" aria-hidden />
          <span className={cn('flex-1 text-left', CLIP_TEXT)}>All comics · {hiddenRecent} more</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
      )}
    </div>
  );
}
