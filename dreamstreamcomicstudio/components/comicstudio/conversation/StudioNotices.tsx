// The calm messages docked above the composer (P2-CONVERSATION):
//
//  - StudioErrorBanner: the last stream error, tailored by its server code (contract §7) — a
//    short safety break reads as a pause ("reading and editing still work"), a content-rules
//    refusal offers a reword hint, a limit says what's full. Never a red wall of text; Resync
//    only where a resync can help.
//  - StudioNoticeToast: studio.notice — "Undid: move a balloon · Redo", "Nothing to undo yet",
//    "That image is still drawing — undo it once the drawing finishes". Dismissible, and it
//    fades on its own after a few seconds (a UI timer only — nothing here calls the server).
//  - SavedByEditorNote: after a turn or job in which software did the work, one subtle line:
//    "Free — done by the editor, no AI cost" (decisions-final #6), with the amount it saved in
//    the user's terms (dollars for admins / own key, a share of usage for everyone else).

import React, { useEffect, useRef, useState } from 'react';
import { CircleCheck, Coffee, Info, PenLine, RefreshCw, Redo2, ShieldCheck, Undo2, X } from 'lucide-react';
import type { ComicStudioController } from '../useStudio';
import { useCostFormat } from './cost';
import { cx } from './ui';

/** How long a notice / savings line stays before fading on its own. */
export const NOTICE_MS = 6000;
export const SAVED_NOTE_MS = 8000;

export type ErrorTone = 'pause' | 'care' | 'info' | 'problem';

export interface ErrorPresentation {
  tone: ErrorTone;
  /** A short lead-in shown before the server's message (optional). */
  title?: string;
  /** One helpful next step under the message (optional). */
  hint?: string;
  /** Offer "Resync" (reload the comic) — only when the state may really be out of date. */
  resync: boolean;
}

/** Tailor the error banner to the server's code (unknown codes fall back to a calm problem line). */
export const errorPresentation = (code: string | null | undefined): ErrorPresentation => {
  switch ((code || '').toUpperCase()) {
    case 'COOLDOWN':
      return { tone: 'pause', title: 'A short break', hint: 'New drawings and uploads pause for a moment. Reading and editing still work.', resync: false };
    case 'CONTENT_POLICY':
    case 'SAFETY_BLOCKED':
      return {
        tone: 'care',
        hint: 'Try rewording it — action, adventure and spooky stories are all fine; comics stay PG-13 at most.',
        resync: false
      };
    case 'LIMIT':
    case 'FORBIDDEN':
    case 'NOT_READY':
    case 'LANG_INCOMPLETE':
      return { tone: 'info', resync: false };
    case 'BUSY':
    case 'RATE_LIMIT':
      return { tone: 'info', hint: 'Give it a moment, then try again.', resync: false };
    case 'CONFLICT':
      return { tone: 'problem', resync: true };
    default:
      return { tone: 'problem', resync: true };
  }
};

const TONE_CLS: Record<ErrorTone, string> = {
  pause: 'border-sky-500/25 bg-sky-500/[0.07]',
  care: 'border-[#D97757]/30 bg-[#D97757]/[0.07]',
  info: 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]',
  problem: 'border-amber-500/30 bg-amber-500/[0.08]'
};

const TONE_ICON: Record<ErrorTone, React.ReactNode> = {
  pause: <Coffee className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden />,
  care: <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />,
  info: <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />,
  problem: <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
};

const SMALL_BTN =
  'inline-flex min-h-[28px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-[44px] coarse:px-3';
const CLOSE_BTN =
  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11 coarse:w-11';

export const StudioErrorBanner: React.FC<{ studio: Pick<ComicStudioController, 'error' | 'errorCode' | 'clearError' | 'refresh'>; className?: string }> = ({
  studio,
  className
}) => {
  if (!studio.error) return null;
  const p = errorPresentation(studio.errorCode);
  return (
    <div role="alert" data-tone={p.tone} className={cx('flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px] text-[var(--ds-ink)]', TONE_CLS[p.tone], className)}>
      {TONE_ICON[p.tone]}
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p>
          {p.title && <span className="font-semibold">{p.title}: </span>}
          {studio.error}
        </p>
        {p.hint && (
          <p className="mt-0.5 flex items-start gap-1 text-[11.5px] text-[var(--ds-muted)]">
            {p.tone === 'care' && <PenLine className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
            {p.hint}
          </p>
        )}
      </div>
      {p.resync && (
        <button
          type="button"
          onClick={() => {
            studio.clearError();
            void studio.refresh();
          }}
          className={SMALL_BTN}
          title="Reload the latest state of this comic"
        >
          <RefreshCw className="h-3 w-3" aria-hidden /> Resync
        </button>
      )}
      <button type="button" onClick={studio.clearError} aria-label="Dismiss" className={CLOSE_BTN}>
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
};

/** Fire `onExpire` once `ms` after `key` last changed (UI only). */
const useExpire = (key: string | null, ms: number, onExpire: () => void) => {
  const cb = useRef(onExpire);
  cb.current = onExpire;
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => cb.current(), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
};

export const StudioNoticeToast: React.FC<{ studio: Pick<ComicStudioController, 'notice' | 'clearNotice' | 'undo' | 'redo'>; className?: string }> = ({ studio, className }) => {
  const notice = studio.notice || null;
  const [hovered, setHovered] = useState(false);
  // Pauses while the pointer rests on it (time to reach Undo); a new notice restarts the clock.
  useExpire(notice && !hovered ? notice.id : null, NOTICE_MS, () => studio.clearNotice?.());
  if (!notice) return null;
  const follow = notice.action;
  return (
    <div
      role="status"
      aria-live="polite"
      data-notice={notice.kind}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] py-1 pl-3 pr-1 text-[12.5px] text-[var(--ds-ink)] shadow-[0_4px_16px_rgba(0,0,0,0.08)] animate-fade-in motion-reduce:animate-none',
        className
      )}
    >
      {notice.kind === 'undo' ? (
        <Undo2 className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />
      ) : notice.kind === 'redo' ? (
        <Redo2 className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />
      ) : (
        <Info className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />
      )}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice.text}</span>
      {follow && (
        <button
          type="button"
          className={SMALL_BTN}
          onClick={() => {
            studio.clearNotice?.();
            if (follow === 'redo') studio.redo();
            else studio.undo();
          }}
        >
          {follow === 'redo' ? <Redo2 className="h-3 w-3" aria-hidden /> : <Undo2 className="h-3 w-3" aria-hidden />}
          {follow === 'redo' ? 'Redo' : 'Undo'}
        </button>
      )}
      <button type="button" onClick={() => studio.clearNotice?.()} aria-label="Dismiss" className={CLOSE_BTN}>
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
};

/**
 * "Free — done by the editor, no AI cost": shown once after a turn/job that saved something,
 * hidden while the studio is busy again, after a few seconds, or when dismissed.
 */
export const SavedByEditorNote: React.FC<{
  studio: Pick<ComicStudioController, 'lastSavedUsd' | 'busy' | 'byok' | 'caps'>;
  className?: string;
}> = ({ studio, className }) => {
  const cost = useCostFormat(studio);
  const saved = typeof studio.lastSavedUsd === 'number' && Number.isFinite(studio.lastSavedUsd) && studio.lastSavedUsd > 0 ? studio.lastSavedUsd : 0;
  // Each finished turn/job reports a fresh value; key on it so the same amount twice still shows.
  const [shownFor, setShownFor] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const seq = useRef(0);
  const last = useRef<number | null | undefined>(studio.lastSavedUsd);
  useEffect(() => {
    if (Object.is(last.current, studio.lastSavedUsd)) return;
    last.current = studio.lastSavedUsd;
    if (saved > 0) {
      seq.current += 1;
      setShownFor(seq.current);
    }
  }, [studio.lastSavedUsd, saved]);
  const visible = shownFor !== null && dismissed !== shownFor && !studio.busy && saved > 0;
  useExpire(visible ? `saved_${shownFor}` : null, SAVED_NOTE_MS, () => setDismissed(shownFor));
  if (!visible) return null;
  const amount = cost.saved(saved);
  return (
    <div
      role="status"
      className={cx(
        'flex min-w-0 items-center gap-1.5 px-1 text-[11.5px] text-emerald-700 animate-fade-in motion-reduce:animate-none dark:text-emerald-300',
        className
      )}
    >
      <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title="Free — done by the editor, no AI cost">
        Free — done by the editor, no AI cost{amount !== 'No AI cost' ? ` · ${amount.replace(/^Saved /, 'saved ')}` : ''}
      </span>
      <button type="button" onClick={() => setDismissed(shownFor)} aria-label="Dismiss" className={CLOSE_BTN}>
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
};
