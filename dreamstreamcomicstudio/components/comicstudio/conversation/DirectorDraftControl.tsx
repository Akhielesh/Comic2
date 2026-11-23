import React, { useId, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Feather } from 'lucide-react';
import { DIRECTOR_DRAFT_IDEA_LIMIT, isPageStale } from '../../../shared/comic/doc';
import { FOCUS_RING } from '../../chat/studioDesign';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import type { ComicStudioController } from '../useStudio';
import { GhostButton, PrimaryButton } from './ui';

interface Props {
  studio: ComicStudioController;
  readComposerDraft: () => string;
}

export function DirectorDraftControl({ studio, readComposerDraft }: Props) {
  const [open, setOpen] = useState(false);
  const [idea, setIdea] = useState<string | null>(null);
  const [request, setRequest] = useState<'start' | 'takeover' | null>(null);
  const [problem, setProblem] = useState('');
  const active = useRef(new Set<'start' | 'takeover'>());
  const anchor = useRef<HTMLButtonElement>(null);
  const field = useId();
  const doc = studio.doc;
  if (!doc) return null;

  const draft = doc.directorDraft;
  const status = draft?.status;
  const directorLed = !!status && status !== 'hands_on';
  const planning = status === 'planning';
  const hasPages = doc.pages.length > 0;
  const openGate = doc.gate?.status === 'open';
  const readyPages = doc.pages.filter(p => p.render.asset && p.render.status === 'ready' && !isPageStale(doc, p)).length;
  const readable = directorLed && hasPages && readyPages === doc.pages.length;
  const drawing = directorLed && doc.pages.some(p => p.render.status === 'queued' || p.render.status === 'rendering');
  const plans = [...doc.pages].sort((a, b) => a.n - b.n);
  const reviewable = hasPages && (status === 'review' || status === 'interrupted');
  const canStart = !hasPages && !openGate && !studio.renderingTotal && !planning && status !== 'review';
  const mode = directorLed ? 'Director-led' : 'Hands-on';
  const statusText = planning ? 'Planning pages' : status === 'ready' ? 'Brief saved' : status === 'interrupted' ? 'Draft paused'
    : status === 'review' ? openGate ? 'Drawing approval pending' : hasPages ? 'Plan ready' : 'Plan changed' : '';
  const value = idea ?? draft?.idea ?? doc.source.script ?? doc.brief.premise ?? doc.brief.logline ?? '';
  const openControl = () => {
    if (!open && idea === null && !directorLed) setIdea(readComposerDraft().trim() || value);
    setOpen(!open);
  };
  const review = () => { setOpen(false); studio.setTab('pages'); };
  const run = async (kind: 'start' | 'takeover') => {
    if (active.current.has(kind)) return;
    active.current.add(kind);
    setRequest(kind);
    setProblem('');
    try {
      const result = await studio.act(kind === 'start'
        ? { type: 'start_director_draft', idea: value.trim(), expectedRev: doc.rev }
        : { type: 'take_over_director_draft' });
      if (result && !result.ok && !result.aborted) {
        setProblem(result.error || 'The comic may have changed. Check the latest saved version and try again.');
        await studio.refresh();
      } else if (!result || result.ok) {
        setIdea(null);
        setOpen(false);
      }
    } catch {
      setProblem('The request could not be confirmed. Check the saved draft before trying again.');
    } finally {
      active.current.delete(kind);
      setRequest(current => current === kind ? null : current);
    }
  };

  return (
    <div className="shrink-0 border-b border-[var(--ds-hairline-soft)] bg-[var(--ds-canvas)]">
      <div className="mx-auto flex min-h-10 w-full max-w-3xl flex-wrap items-center justify-between gap-x-2 px-3 sm:px-5">
        <button type="button" ref={anchor} aria-haspopup="dialog" aria-expanded={open}
          onClick={openControl}
          className={`flex min-h-10 items-center gap-2 rounded-md px-1.5 text-[13px] text-[var(--ds-ink)] coarse:min-h-[44px] ${FOCUS_RING}`}>
          <Feather size={15} aria-hidden /><span><span className="text-[var(--ds-muted)]">Drafting · </span>{mode}</span><ChevronDown size={13} aria-hidden />
        </button>
        {readable
          ? <PrimaryButton onClick={() => studio.runClientAction({ type: 'open_reader', immersive: true })}><BookOpen size={16} aria-hidden />Read comic</PrimaryButton>
          : drawing ? <span role="status" className="text-xs text-[var(--ds-muted)]">Drawing your comic · {readyPages} of {plans.length} pages ready</span>
          : reviewable
          ? <button type="button" onClick={review} className={`flex min-h-10 items-center gap-1.5 rounded-md px-1 text-[13px] font-medium text-[var(--ds-ink)] coarse:min-h-[44px] ${FOCUS_RING}`}><BookOpen size={15} aria-hidden />Review page plan</button>
          : statusText && <span role="status" className="text-xs text-[var(--ds-muted)]">{statusText}</span>}
      </div>
      {directorLed && hasPages && <details className="mx-auto w-full max-w-3xl px-4 pb-2 text-sm text-[var(--ds-ink)]">
        <summary className="cursor-pointer py-1" aria-label="See the Director’s choices">{doc.brief.title || 'Your comic'} · {plans.length} {plans.length === 1 ? 'page' : 'pages'}{doc.style.name ? ` · ${doc.style.name}` : ''}</summary>
        {doc.cast.length > 0 && <p className="py-1">Cast · {doc.cast.map(person => person.name).join(', ')}</p>}
        <ol className="list-decimal space-y-1 ps-5">{plans.map(p => <li key={p.id}>{p.summary || `Page ${p.n}`} · {p.panels.length} {p.panels.length === 1 ? 'panel' : 'panels'}</li>)}</ol>
      </details>}
      <AdaptiveSheet open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Drafting mode" title="Drafting mode" placement="below" align="start" className="w-[min(25rem,calc(100vw-24px))]">
        <div className="space-y-3 p-4 text-[14px] leading-relaxed text-[var(--ds-ink)]">
          <h3 className="text-base font-semibold">{planning ? 'The Director is planning' : directorLed ? 'Your Director draft' : 'Draft with the Director'}</h3>
          {canStart ? <>
            <p className="text-[var(--ds-muted)]">The Director turns your idea into a page plan using a text model. This uses model allowance. Approve one estimate for the pages, character sheets and cover. Then the Director draws your comic.</p>
            <label htmlFor={field} className="block font-medium">Idea for the Director</label>
            <textarea id={field} value={value} rows={3} onChange={e => setIdea(e.target.value)}
              className={`block w-full resize-y rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3 text-base ${FOCUS_RING}`}
              aria-describedby={value.trim().length > DIRECTOR_DRAFT_IDEA_LIMIT ? field + '-limit' : undefined} />
            {value.trim().length > DIRECTOR_DRAFT_IDEA_LIMIT && <p id={field + '-limit'}>Shorten the idea to {DIRECTOR_DRAFT_IDEA_LIMIT.toLocaleString('en-US')} characters to start a plan.</p>}
            <PrimaryButton busy={request === 'start'} disabled={!value.trim() || value.trim().length > DIRECTOR_DRAFT_IDEA_LIMIT || !!request || studio.busy || studio.messageBusy}
              onClick={() => void run('start')}>Draft page plan</PrimaryButton>
          </> : planning ? <>
            <p role="status" className="text-[var(--ds-muted)]">{studio.activity[studio.activity.length - 1]?.label || 'Preparing the story and page plan for your review.'}</p>
            <p className="text-[var(--ds-muted)]">Taking over keeps the work saved so far. A model call already in progress may still use allowance.</p>
            <GhostButton onClick={() => void studio.refresh()} disabled={studio.refreshing}>Check progress</GhostButton>
            {draft?.idea && <p className="max-h-24 overflow-y-auto whitespace-pre-wrap border-s-2 border-[var(--ds-hairline)] ps-3">{draft.idea}</p>}
          </> : hasPages ? <>
            <p className="text-[var(--ds-muted)]">{openGate ? 'Review your saved plan and the drawing estimate before you approve drawing.' : 'Your pages are on the board. Review the panels or ask the Director for a specific change.'}</p>
            <GhostButton onClick={review}>Open page plan</GhostButton>
          </> : <p className="text-[var(--ds-muted)]">{openGate ? 'Resolve the current approval in the conversation before starting a new draft.' : studio.renderingTotal ? 'Finish the current render before starting a new draft.' : 'The saved draft no longer has pages. Switch to hands-on to start again.'}</p>}
          {directorLed && <GhostButton disabled={request === 'takeover'} busy={request === 'takeover'} onClick={() => void run('takeover')}>Switch to hands-on</GhostButton>}
          {problem && <p role="alert" className="text-[var(--ds-ink)]">{problem}</p>}
        </div>
      </AdaptiveSheet>
    </div>
  );
}
