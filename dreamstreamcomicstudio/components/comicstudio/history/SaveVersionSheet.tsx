// Comic History — "Save version" (versions plan §8 "Save version", §4.4; package H5).
//
// Names the book as it is now ("Draft 3", prefilled), with an optional note (≤ 280). Named versions are kept forever.
// Free. The sheet keeps Save above the on-screen keyboard (useKeyboardInset: the bottom sheet sits on --kb).

import React, { useEffect, useId, useState } from 'react';
import { HISTORY_LIMITS } from '../../../shared/comic/limits';
import { FIELD } from '../../chat/studioDesign';
import { useKeyboardInset } from '../mobile/useKeyboardInset';
import { HISTORY_COPY } from './historyModel';
import { cx, HistorySheet, PrimaryBtn, QuietBtn } from './ui';

export interface SaveVersionSheetProps {
  open: boolean;
  /** "Draft 3". */
  suggestedName: string;
  onClose(): void;
  onSave(name: string, note: string): Promise<{ ok: boolean; error?: string }>;
}

export const SaveVersionSheet: React.FC<SaveVersionSheetProps> = ({ open, suggestedName, onClose, onSave }) => {
  useKeyboardInset();
  const nameId = useId();
  const noteId = useId();
  const [name, setName] = useState(suggestedName);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(suggestedName);
    setNote('');
    setError(null);
  }, [open, suggestedName]);
  const clean = name.trim().slice(0, HISTORY_LIMITS.nameChars);
  const save = async () => {
    if (!clean || sending) return;
    setSending(true);
    setError(null);
    const out = await onSave(clean, note.trim().slice(0, HISTORY_LIMITS.noteChars));
    setSending(false);
    if (out.ok) onClose();
    else setError(out.error || "Couldn't save this version. Nothing in your comic changed.");
  };
  return (
    <HistorySheet open={open} onClose={onClose} label="Save version" detents={['content', 'full']}>
      <form
        className="min-w-0 space-y-3 px-4 pb-4 pt-1"
        data-save-sheet
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="min-w-0">
          <label htmlFor={nameId} className="mb-1 block text-[13px] font-medium text-[var(--ds-ink)]">
            Name
          </label>
          <input id={nameId} value={name} maxLength={HISTORY_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} className={cx(FIELD, 'block min-h-11 w-full px-3 text-[14px]')} autoComplete="off" />
        </div>
        <div className="min-w-0">
          <label htmlFor={noteId} className="mb-1 block text-[13px] font-medium text-[var(--ds-ink)]">
            Note <span className="font-normal text-[var(--ds-muted)]">(optional)</span>
          </label>
          <textarea
            id={noteId}
            value={note}
            maxLength={HISTORY_LIMITS.noteChars}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            className={cx(FIELD, 'block min-h-11 w-full resize-none px-3 py-2 text-[14px]')}
            aria-describedby={`${noteId}-count`}
          />
          <p id={`${noteId}-count`} className="m-0 mt-1 text-right text-[11.5px] tabular-nums text-[var(--ds-muted)]">
            {note.length} / {HISTORY_LIMITS.noteChars}
          </p>
        </div>
        <p className="m-0 text-[13px] text-[var(--ds-muted)]">{HISTORY_COPY.namedForever} Free.</p>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[var(--ds-warning-text)]">
            {error}
          </p>
        )}
        <div className="flex min-w-0 flex-wrap gap-2">
          <PrimaryBtn type="submit" disabled={!clean || sending} className="flex-1">
            {sending ? 'Saving…' : 'Save version'}
          </PrimaryBtn>
          <QuietBtn onClick={onClose} className="flex-1">
            Cancel
          </QuietBtn>
        </div>
      </form>
    </HistorySheet>
  );
};

export default SaveVersionSheet;
