// Comic History — "Restore the whole book to Tue 10:42?" (versions plan §8 "Restore sheet", §6; package H5).
//
// Says exactly what happens before anything does: your book right now is saved first; how many pages change; the
// pages added since go to Deleted (never lost); the cover; every edition you have is kept (and how many lines will
// need updating); the image model stays as it is (and a calm notice when the restored art was drawn with another
// model). The list is computed with the shared engine — the same restore the server commits. "Free — no AI."
// [Restore] sends one history_restore (scope book, baseRev = the live revision, so a book that changed meanwhile is
// refused with nothing changed); then the panel shows the Undo toast.

import React, { useMemo, useState } from 'react';
import type { RestoreScope } from '../../../shared/comic/history/types';
import { HISTORY_COPY, restorePreview, whenText } from './historyModel';
import { useVersionBook, type HistoryStudio } from './useHistory';
import { HistorySheet, Note, PrimaryBtn, QuietBtn } from './ui';
import { STATUS_INK } from '../../chat/studioDesign';

export interface RestoreSheetProps {
  studio: HistoryStudio;
  /** null = closed. */
  versionId: string | null;
  now: number;
  tz: string;
  onClose(): void;
  /** Sends the restore; resolves false (with a calm sentence) when the server refused it. */
  onRestore(versionId: string, scope: RestoreScope, at: string, baseRev?: number): Promise<{ ok: boolean; error?: string }>;
}

export const RestoreSheet: React.FC<RestoreSheetProps> = ({ studio, versionId, now, tz, onClose, onRestore }) => {
  const { book, loading, error } = useVersionBook(studio, versionId);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const live = studio.doc;
  const preview = useMemo(() => (book && live && versionId ? restorePreview(live, book.doc, versionId, now) : null), [book, live, versionId, now]);
  const at = book?.row ? book.row.name || whenText(book.row.contentAt, now, tz) : 'this moment';
  const busy = studio.busy ? 'The director is working — restore when it’s done.' : live && live.pages.some((p) => studio.isRendering({ kind: 'page', id: p.id })) ? 'A page is still drawing — restore when it’s done.' : null;
  const restore = async () => {
    if (!versionId || !live || sending) return;
    setSending(true);
    setRefusal(null);
    const out = await onRestore(versionId, { kind: 'book' }, at, live.rev);
    setSending(false);
    if (!out.ok) setRefusal(out.error || 'Your comic changed while you were looking. Review the changes again.');
    else onClose();
  };
  return (
    <HistorySheet open={!!versionId} onClose={onClose} label="Restore the whole book" detents={['content', 'full']}>
      <div className="min-w-0 space-y-3 px-4 pb-4 pt-1" data-restore-sheet>
        <h3 className="m-0 text-[16px] font-semibold leading-6 text-[var(--ds-ink)] [overflow-wrap:anywhere]">Restore the whole book to {at}?</h3>
        <p className="m-0 text-[13.5px] leading-5 text-[var(--ds-muted)]">{HISTORY_COPY.saveFirst}</p>
        {loading && !book && <p className="m-0 text-[13px] text-[var(--ds-muted)]">Checking what would change…</p>}
        {error && <Note tone="attention">{error}</Note>}
        {preview && (
          <ul className="m-0 list-disc space-y-1 pl-5 text-[13.5px] leading-5 text-[var(--ds-ink)]" aria-label="What happens" data-restore-list>
            {preview.lines.map((l) => (
              <li key={l} className="[overflow-wrap:anywhere]">
                {l}
              </li>
            ))}
          </ul>
        )}
        {preview?.modelNotice && <p className="m-0 text-[13px] leading-5 text-[var(--ds-muted)]">{preview.modelNotice}</p>}
        <p className="m-0 text-[12.5px] text-[var(--ds-muted)]">If an image is held back by safety checks, it stays out and we’ll say so.</p>
        {busy && <p className={`m-0 text-[13px] ${STATUS_INK.attention}`}>{busy}</p>}
        {refusal && (
          <p role="alert" className={`m-0 text-[13px] ${STATUS_INK.attention}`}>
            {refusal}
          </p>
        )}
        <p className="m-0 text-[13px] font-medium text-[var(--ds-ink)]">{HISTORY_COPY.free}</p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <PrimaryBtn onClick={() => void restore()} disabled={!preview || sending || !!busy} className="flex-1">
            {sending ? 'Restoring…' : 'Restore'}
          </PrimaryBtn>
          <QuietBtn onClick={onClose} className="flex-1">
            Cancel
          </QuietBtn>
        </div>
      </div>
    </HistorySheet>
  );
};

export default RestoreSheet;
