// Comic History — "Undo the last AI change" (versions plan §6.4, §8; package H5).
//
// Reverts only what the AI's latest run changed, and works after a reload (plan_pages, revisions, translation runs
// and render runs included). Before anything happens the sheet shows the three-way plan (shared planUndoLastAi over
// the moment before the AI, the AI's result and now — after the semantic filter, so a size variant or a safety
// re-check never reads as your edit): pieces you changed since are asked first ("You've changed page 3 since."
// [Keep mine] [Take the earlier one]). The AI's newer drawings stay in each page's versions. Free — no AI. The server
// re-plans when it runs (history_undo_ai {decisions}) and refuses nothing silently.

import React, { useEffect, useMemo, useState } from 'react';
import type { UndoAiDecision, VersionRow } from '../../../shared/comic/history/types';
import { SEGMENTED_ACTIVE, SEGMENTED_ITEM, SEGMENTED_TRACK, STATUS_INK } from '../../chat/studioDesign';
import { HISTORY_COPY, undoAiPreview, whenText } from './historyModel';
import { useVersionBook, type HistoryStudio } from './useHistory';
import { cx, HistorySheet, PrimaryBtn, QuietBtn } from './ui';

export interface UndoAiSheetProps {
  studio: HistoryStudio;
  open: boolean;
  /** Newest first: the latest `ai` row is the change to undo. */
  rows: readonly VersionRow[];
  loadingRows?: boolean;
  now: number;
  tz: string;
  onClose(): void;
  onUndo(decisions: Record<string, UndoAiDecision>): Promise<{ ok: boolean; error?: string }>;
}

export const UndoAiSheet: React.FC<UndoAiSheetProps> = ({ studio, open, rows, loadingRows, now, tz, onClose, onUndo }) => {
  const R = open ? rows.find((r) => r.kind === 'ai') ?? null : null;
  const P = R?.parentId ?? null;
  const after = useVersionBook(studio, R?.id ?? null);
  const before = useVersionBook(studio, P);
  const [decisions, setDecisions] = useState<Record<string, UndoAiDecision>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setDecisions({});
    setError(null);
  }, [open]);
  const live = studio.doc;
  const preview = useMemo(() => (after.book && before.book && live ? undoAiPreview(before.book.doc, after.book.doc, live) : null), [after.book, before.book, live]);
  const decided = (keys: string[]) => keys.every((k) => decisions[k]);
  const allDecided = !preview || preview.conflicts.every((c) => decided(c.keys));
  const nothing = !!preview && !preview.plan.changed.length;
  const setGroup = (keys: string[], d: UndoAiDecision) => setDecisions((cur) => ({ ...cur, ...Object.fromEntries(keys.map((k) => [k, d])) }));
  const run = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    const out = await onUndo(decisions);
    setSending(false);
    if (out.ok) onClose();
    else setError(out.error || "Couldn't undo the AI change. Nothing in your comic changed.");
  };
  const busy = studio.busy ? 'The director is working — undo when it’s done.' : null;
  const fallback = !!R && !preview && !!(after.error || before.error || !P);

  return (
    <HistorySheet open={open} onClose={onClose} label="Undo the last AI change" detents={['content', 'full']}>
      <div className="min-w-0 space-y-3 px-4 pb-4 pt-1" data-undo-ai-sheet>
        {!R && <p className="m-0 text-[13.5px] text-[var(--ds-muted)]">{loadingRows ? 'Looking for the last AI change…' : 'There’s no AI change to undo yet.'}</p>}
        {R && (
          <>
            <p className="m-0 text-[14px] leading-5 text-[var(--ds-ink)] [overflow-wrap:anywhere]">
              <span className="font-semibold">{R.label || 'The last AI change'}</span> <span className="text-[var(--ds-muted)]">· {whenText(R.contentAt, now, tz)}</span>
            </p>
            <p className="m-0 text-[13.5px] leading-5 text-[var(--ds-muted)]">
              {fallback
                ? 'Restore what you had just before it (free). Your edits since then are checked first.'
                : `This brings back what you had just before it${preview?.revertText ? ` on ${preview.revertText}` : ''}, and keeps your later edits. The AI’s drawings stay in each page’s versions.`}
            </p>
            {(after.loading || before.loading) && !preview && !fallback && <p className="m-0 text-[13px] text-[var(--ds-muted)]">Checking what you changed since…</p>}
            {nothing && <p className="m-0 text-[13px] text-[var(--ds-muted)]">Nothing the AI changed is left to undo.</p>}
            {preview?.conflicts.map((c) => (
              <fieldset key={c.key} className="m-0 min-w-0 space-y-2 border-0 p-0" data-undo-conflict={c.pageId ?? c.key}>
                <legend className="text-[13.5px] font-medium text-[var(--ds-ink)]">{c.title} Undo the AI’s change here too?</legend>
                <div role="radiogroup" aria-label={c.title} className={cx(SEGMENTED_TRACK, 'w-full')}>
                  {(
                    [
                      ['mine', 'Keep mine'],
                      ['earlier', 'Take the earlier one']
                    ] as const
                  ).map(([d, label]) => {
                    const on = c.keys.every((k) => decisions[k] === d);
                    return (
                      <button key={d} type="button" role="radio" aria-checked={on} onClick={() => setGroup(c.keys, d)} className={cx(SEGMENTED_ITEM, 'min-h-11', on && SEGMENTED_ACTIVE)}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </>
        )}
        {busy && <p className={`m-0 text-[13px] ${STATUS_INK.attention}`}>{busy}</p>}
        {error && (
          <p role="alert" className={`m-0 text-[13px] ${STATUS_INK.attention}`}>
            {error}
          </p>
        )}
        <p className="m-0 text-[13px] font-medium text-[var(--ds-ink)]">{HISTORY_COPY.free}</p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <PrimaryBtn onClick={() => void run()} disabled={!R || nothing || !allDecided || sending || !!busy || (!preview && !fallback)} className="flex-1">
            {sending ? 'Undoing…' : 'Undo the AI change'}
          </PrimaryBtn>
          <QuietBtn onClick={onClose} className="flex-1">
            Cancel
          </QuietBtn>
        </div>
      </div>
    </HistorySheet>
  );
};

export default UndoAiSheet;
