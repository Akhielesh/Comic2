// "Up next" (agent-editor plan §3 A1): the notes the creator wrote while the director works.
//
// Docked under the live activity line. Each note can be edited inline, moved up or down (dragged with a mouse),
// removed, and the first one sent now ("Send now": into the running turn with steering on, otherwise Stop the
// director, then send it — D2). The header says, in words, what the queue is waiting for: the director finishing this
// step, an unanswered question or an open spend gate ("or Send anyway"), Stop ("Send now" · "Clear"), a reload
// ("Send" · "Clear"), a plan_pages run, or another tab or device holding the turn ("Try again"). Never silent.
//
// On a phone it is one chip, "Up next · 2", that opens a bottom sheet with the same controls. Renders nothing while
// the queue is off (the controller has no `queue`) or empty.

import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Pencil, Send, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, MUTED, OVERLINE, PRESS, RADIUS_CONTROL, RADIUS_PANEL, RADIUS_PILL, STATUS_DOT, STATUS_INK, TRANSITION, type StatusState } from '../../chat/studioDesign';
import { holdLine, noteFocusLabel, type QueueHold, type QueuedNote } from '../messageQueue';
import type { ComicStudioController } from '../useStudio';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { isPhoneLayout } from '../mobile/formFactor';
import { useFormFactor } from '../mobile/useFormFactor';

export interface QueuedMessagesProps {
  studio: ComicStudioController;
  className?: string;
  /** 'auto' (default): a chip and a sheet on phones, the list elsewhere. 'inline': always the list (the phone ask sheet). */
  variant?: 'auto' | 'inline' | 'chip';
}

/** The tone of the dot beside the queue's line (always paired with its words). */
const holdState = (hold: QueueHold | null, working: boolean): StatusState => {
  if (hold === 'elsewhere' || hold === 'gate' || hold === 'question') return 'attention';
  if (hold === 'stopped' || hold === 'restored') return 'waiting';
  return working ? 'active' : 'waiting';
};

const ACTION_LABEL = { send_anyway: 'Send anyway', retry: 'Try again' } as const;

/** Small text buttons: 32 px with a mouse, 44 px on touch. */
const TEXT_BTN = cn(
  'inline-flex min-h-8 shrink-0 items-center justify-center gap-1 px-2.5 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-50 coarse:min-h-11 coarse:px-3',
  RADIUS_CONTROL,
  TRANSITION,
  FOCUS_RING,
  PRESS
);
const OUTLINE_BTN = cn(TEXT_BTN, 'border border-[var(--ds-control-border)]');
/** Icon buttons: 32 px with a mouse, 44 px on touch. */
const ICON_BTN = cn(
  'inline-grid h-8 w-8 shrink-0 place-items-center text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:cursor-not-allowed disabled:opacity-40 coarse:h-11 coarse:w-11',
  RADIUS_CONTROL,
  TRANSITION,
  FOCUS_RING
);

interface RowProps {
  note: QueuedNote;
  index: number;
  count: number;
  studio: ComicStudioController;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (id: string) => void;
  onDropAt: (index: number) => void;
  onDragEnd: () => void;
}

const QueuedRow: React.FC<RowProps> = ({ note, index, count, studio, draggable, dragging, onDragStart, onDropAt, onDragEnd }) => {
  const { coarse } = useFormFactor();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  const editRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  const n = index + 1;
  const focus = noteFocusLabel(studio.doc, note.focus);
  const photos = note.inboxPaths?.length ?? 0;
  const meta = [focus, photos ? `${photos} ${photos === 1 ? 'photo' : 'photos'}` : null].filter(Boolean).join(' · ');
  const stopping = studio.queueSendingNow === note.id;

  const save = () => {
    const text = draft.trim();
    if (!text) return;
    if (text !== note.text) studio.editQueued?.(note.id, text);
    setEditing(false);
  };
  const cancelEdit = () => {
    setDraft(note.text);
    setEditing(false);
  };
  const sendNow = async () => {
    if (!studio.sendNow || sending) return;
    setSending(true);
    try {
      await studio.sendNow(note.id);
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  return (
    <li
      className={cn('min-w-0 px-1.5 py-1.5', RADIUS_CONTROL, dragging && 'opacity-50')}
      draggable={draggable && !editing}
      onDragStart={(e) => {
        e.dataTransfer?.setData('text/plain', note.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        onDragStart(note.id);
      }}
      onDragOver={(e) => {
        if (draggable) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropAt(index);
      }}
      onDragEnd={onDragEnd}
      data-queued-note={note.id}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn('w-5 shrink-0 pt-px text-right text-[12px] tabular-nums', MUTED)} aria-hidden>
          {n}.
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="min-w-0">
              <textarea
                ref={editRef}
                value={draft}
                rows={2}
                aria-label={`Edit note ${n}`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey || !coarse)) {
                    // As in the composer: Enter saves with a mouse; on touch it is a newline and ⌘/Ctrl+Enter saves.
                    e.preventDefault();
                    save();
                  }
                }}
                className={cn(
                  'block w-full resize-y border border-[var(--ds-control-border)] bg-[var(--ds-canvas)] px-2 py-1.5 text-base leading-snug text-[var(--ds-ink)] sm:text-[13px]',
                  RADIUS_CONTROL,
                  FOCUS_RING
                )}
              />
              <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
                <button type="button" onClick={cancelEdit} className={TEXT_BTN}>
                  Cancel
                </button>
                <button type="button" onClick={save} disabled={!draft.trim()} className={OUTLINE_BTN}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <p className="line-clamp-3 min-w-0 whitespace-pre-line text-[13px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]" title={note.text}>
              {note.text || (photos ? 'Photos' : '')}
            </p>
          )}
          {meta && !editing && <p className={cn('mt-0.5 min-w-0 truncate text-[11.5px]', MUTED)}>{meta}</p>}
        </div>
      </div>
      {!editing && (
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center justify-end gap-0.5 pl-7">
          {index === 0 && studio.sendNow && (
            <button
              type="button"
              onClick={() => void sendNow()}
              disabled={sending || stopping}
              aria-busy={sending || stopping || undefined}
              title={studio.turnLocked ? 'Send this note now — the director stops its current step first' : 'Send this note now'}
              className={cn(OUTLINE_BTN, 'mr-auto')}
            >
              {sending || stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
              {stopping ? (studio.messageBusy ? 'Stopping, then sending…' : 'Sending next…') : 'Send now'}
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)} aria-label={`Edit note ${n}`} title="Edit" className={ICON_BTN}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button type="button" onClick={() => studio.moveQueued?.(note.id, -1)} disabled={index === 0} aria-label={`Move note ${n} up`} title="Move up" className={ICON_BTN}>
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => studio.moveQueued?.(note.id, 1)}
            disabled={index === count - 1}
            aria-label={`Move note ${n} down`}
            title="Move down"
            className={ICON_BTN}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button type="button" onClick={() => studio.removeQueued?.(note.id)} aria-label={`Remove note ${n}`} title="Remove" className={ICON_BTN}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
    </li>
  );
};

/** The list with its header line: shared by the docked block and the phone sheet. */
const QueuedList: React.FC<{ studio: ComicStudioController; notes: QueuedNote[]; showTitle: boolean }> = ({ studio, notes, showTitle }) => {
  const ff = useFormFactor();
  const [dragId, setDragId] = useState<string | null>(null);
  const hold = studio.queueHold ?? null;
  const line = holdLine(hold, notes.length, { retriesLeft: studio.queueRetriesLeft !== false });
  const working = !!studio.turnLocked;
  const tone = holdState(hold, working);
  const actionLabel = line.action === 'send' ? (hold === 'stopped' ? 'Send now' : 'Send') : line.action ? ACTION_LABEL[line.action] : null;

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {showTitle && <h3 className={cn(OVERLINE, 'shrink-0')}>Up next · {notes.length}</h3>}
        <p role="status" aria-live="polite" className={cn('flex min-w-0 flex-1 basis-[12rem] items-center gap-1.5 text-[12px]', STATUS_INK[tone])}>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[tone])} aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
        </p>
        {(actionLabel || line.clear) && (
          <span className="flex shrink-0 flex-wrap items-center gap-1">
            {actionLabel && (
              <button type="button" onClick={() => studio.releaseQueue?.()} className={OUTLINE_BTN}>
                {actionLabel}
              </button>
            )}
            {line.clear && (
              <button type="button" onClick={() => studio.clearQueue?.()} aria-label="Clear Up next" className={TEXT_BTN}>
                Clear
              </button>
            )}
          </span>
        )}
      </div>
      <ol className="mt-1 min-w-0 space-y-0.5" aria-label="Queued notes">
        {notes.map((note, i) => (
          <QueuedRow
            key={note.id}
            note={note}
            index={i}
            count={notes.length}
            studio={studio}
            draggable={!ff.coarse && notes.length > 1}
            dragging={dragId === note.id}
            onDragStart={setDragId}
            onDropAt={(index) => {
              if (dragId && studio.moveQueuedTo) studio.moveQueuedTo(dragId, index);
              setDragId(null);
            }}
            onDragEnd={() => setDragId(null)}
          />
        ))}
      </ol>
    </div>
  );
};

export const QueuedMessages: React.FC<QueuedMessagesProps> = ({ studio, className, variant = 'auto' }) => {
  const ff = useFormFactor();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const notes = studio.queue;
  const count = notes?.length ?? 0;
  // The sheet closes itself once there is nothing left in it.
  useEffect(() => {
    if (!count) setOpen(false);
  }, [count]);
  if (!notes || !count) return null;

  const mode = variant === 'auto' ? (isPhoneLayout(ff.layout) ? 'chip' : 'inline') : variant;
  if (mode === 'chip') {
    const hold = studio.queueHold ?? null;
    const tone = holdState(hold, !!studio.turnLocked);
    const line = holdLine(hold, count, { retriesLeft: studio.queueRetriesLeft !== false });
    return (
      <div className={cn('min-w-0', className)}>
        <button
          ref={chipRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'inline-flex min-h-8 max-w-full items-center gap-1.5 border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[12px] hover:bg-[var(--ds-hover)] coarse:min-h-11',
            RADIUS_PILL,
            TRANSITION,
            FOCUS_RING
          )}
        >
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[tone])} aria-hidden />
          <span className="shrink-0 font-semibold text-[var(--ds-ink)]">Up next · {count}</span>
          <span className={cn('min-w-0 truncate', STATUS_INK[tone])}>{line.text}</span>
        </button>
        <AdaptiveSheet open={open} onClose={() => setOpen(false)} label="Up next" title={`Up next · ${count}`} presentation="bottom" detents={['content']} anchorRef={chipRef}>
          <div className="px-3 pb-3">
            <QueuedList studio={studio} notes={notes} showTitle={false} />
          </div>
        </AdaptiveSheet>
      </div>
    );
  }

  return (
    <section
      aria-label={`Up next, ${count} ${count === 1 ? 'note' : 'notes'}`}
      className={cn('min-w-0 border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-2', RADIUS_PANEL, className)}
      data-up-next
    >
      <div className="max-h-[min(40vh,320px)] overflow-y-auto overscroll-contain">
        <QueuedList studio={studio} notes={notes} showTitle />
      </div>
    </section>
  );
};
