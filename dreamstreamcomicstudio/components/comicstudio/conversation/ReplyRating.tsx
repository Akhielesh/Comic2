// Rate a reply (docs/features/reply-ratings.md): two quiet ink thumbs under a Director reply. Thumbs up is sent at once;
// thumbs down opens a short optional note first, which goes only when the person ticks "Share this note". Either way
// the row then reads "Thanks" with an Undo that really takes the rating back (POST /api/telemetry/feedback/withdraw:
// the person's own row for this reply is removed). Every request is a click: nothing waits on a timer.
//
// Keyboard and screen reader: the thumbs are toggle buttons (aria-pressed) in a named group; a rated thumb keeps focus
// (aria-disabled, never removed from under it); the note's field takes focus when it opens and Escape closes it; the
// status ("Thanks", "Couldn't send") is a polite live region. On a pointer that can hover, an older reply shows its
// thumbs on hover or focus; the latest reply, a rating in progress and every touch screen always show them.

import React, { useEffect, useId, useRef, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { FeedbackVoteValue } from '../../../apiTypes';
import type { Msg } from '../../../shared/comic/doc';
import { submitFeedback } from '../../../services/feedback';
import { cn } from '../../../lib/utils';
import { Button, Checkbox, Field, IconButton, Textarea } from '../../ds';
import { DENSITY, FOCUS_RING, MUTED, RADIUS_CONTROL } from '../../chat/studioDesign';
import { RATING_NOTE_MAX, replyRatingInput, withdrawReplyRating } from './replyRating';

/** Where the rating stands. `noting`: thumbs down chosen, the note is open, nothing sent yet. */
type Status = 'idle' | 'noting' | 'sending' | 'sent' | 'failed' | 'undoing' | 'undoFailed';

export interface ReplyRatingProps {
  msg: Pick<Msg, 'id' | 'cards' | 'nextSteps'>;
  /** The comic's id: the rating's correlation key (the chat's session id plays the same part). */
  comicId?: string | null;
  /** Always shown (the latest reply). Otherwise a hover-capable pointer sees it on hover or focus of the reply. */
  always?: boolean;
}

const STATUS_TEXT: Partial<Record<Status, string>> = {
  sending: 'Sending…',
  sent: 'Thanks',
  failed: 'Couldn’t send.',
  undoing: 'Undoing…',
  undoFailed: 'Couldn’t undo.'
};

const THUMB = 'size-3.5';
const LINK = cn('inline-flex min-h-6 items-center px-1.5 text-[12px] font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline', RADIUS_CONTROL, DENSITY.coarse, FOCUS_RING);

export const ReplyRating: React.FC<ReplyRatingProps> = ({ msg, comicId, always }) => {
  const [status, setStatus] = useState<Status>('idle');
  const [vote, setVote] = useState<FeedbackVoteValue | null>(null);
  const [note, setNote] = useState('');
  const [share, setShare] = useState(false);
  const upRef = useRef<HTMLButtonElement | null>(null);
  const downRef = useRef<HTMLButtonElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const mounted = useRef(true);
  // What an unmount reads: a thumbs-down whose note was still open is recorded once (as general chat does).
  const latest = useRef({ status, note, share, msg, comicId });
  latest.current = { status, note, share, msg, comicId };
  const noteId = `reply-note-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const { status: s, note: n, share: sh, msg: m, comicId: c } = latest.current;
      if (s === 'noting') void submitFeedback(replyRatingInput(m, c, 'dislike', { text: n, share: sh }));
    };
  }, []);

  useEffect(() => {
    if (status === 'noting') noteRef.current?.focus();
  }, [status]);

  const thumbOf = (v: FeedbackVoteValue) => (v === 'like' ? upRef : downRef);
  const focusThumb = (v: FeedbackVoteValue | null) => {
    if (v) requestAnimationFrame(() => thumbOf(v).current?.focus());
  };

  const send = async (v: FeedbackVoteValue, withNote?: { text: string; share: boolean }) => {
    setVote(v);
    setStatus('sending');
    const result = await submitFeedback(replyRatingInput(msg, comicId, v, withNote));
    if (!mounted.current) return;
    setStatus(result.persisted ? 'sent' : 'failed');
  };

  const undo = async () => {
    setStatus('undoing');
    const result = await withdrawReplyRating(msg.id);
    if (!mounted.current) return;
    if (!result.withdrawn) {
      setStatus('undoFailed');
      return;
    }
    const was = vote;
    setStatus('idle');
    setVote(null);
    setNote('');
    setShare(false);
    focusThumb(was);
  };

  const closeNote = () => {
    setStatus('idle');
    setVote(null);
    focusThumb('dislike');
  };

  const locked = status !== 'idle' && status !== 'noting';
  const onThumb = (v: FeedbackVoteValue) => {
    if (locked) return;
    if (v === 'dislike') {
      if (status === 'noting') closeNote();
      else {
        setVote('dislike');
        setStatus('noting');
      }
      return;
    }
    void send('like');
  };

  const retry = () => {
    if (status === 'undoFailed') void undo();
    else if (status === 'failed' && vote) void send(vote, vote === 'dislike' ? { text: note, share } : undefined);
  };

  const sendNote = () => {
    void send('dislike', { text: note, share });
    focusThumb('dislike');
  };

  const text = STATUS_TEXT[status];
  const quiet = !always && status === 'idle';
  return (
    <div
      data-reply-rating={status}
      className={cn(
        'flex min-w-0 max-w-md flex-col gap-2',
        quiet && 'transition-opacity duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none can-hover:opacity-0 can-hover:group-hover/reply:opacity-100 can-hover:group-focus-within/reply:opacity-100'
      )}
    >
      <div role="group" aria-label="Rate this reply" className="flex min-w-0 flex-wrap items-center gap-0.5">
        {(['like', 'dislike'] as const).map((v) => {
          const chosen = vote === v;
          const Icon = v === 'like' ? ThumbsUp : ThumbsDown;
          return (
            <IconButton
              key={v}
              ref={thumbOf(v)}
              size="sm"
              label={v === 'like' ? 'Good reply' : 'Could be better'}
              aria-pressed={chosen}
              aria-disabled={locked || undefined}
              onClick={() => onThumb(v)}
              // Rated: the chosen thumb stays full ink (the primitive dims aria-disabled controls); the other one dims.
              className={cn(chosen ? 'text-[var(--ds-ink)]' : MUTED, locked && 'hover:bg-transparent aria-disabled:cursor-default', locked && chosen && 'aria-disabled:opacity-100')}
            >
              <Icon className={THUMB} fill={chosen ? 'currentColor' : 'none'} />
            </IconButton>
          );
        })}
        <span role="status" className={cn('min-w-0 px-1 text-[12px]', MUTED)}>
          {text}
        </span>
        {status === 'sent' && (
          <button type="button" className={LINK} aria-label="Undo rating" onClick={() => void undo()}>
            Undo
          </button>
        )}
        {(status === 'failed' || status === 'undoFailed') && (
          <button type="button" className={LINK} onClick={retry}>
            Try again
          </button>
        )}
      </div>
      {status === 'noting' && (
        <div
          className="flex min-w-0 flex-col gap-2"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            closeNote();
          }}
        >
          <Field label="What could be better? (optional)" id={noteId}>
            <Textarea ref={noteRef} rows={2} maxLength={RATING_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Checkbox
            label="Share this note with DreamStream"
            description="Left unticked, only your thumbs-down is sent."
            checked={share}
            onCheckedChange={setShare}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={sendNote}>
              Send
            </Button>
            <Button size="sm" variant="ghost" onClick={closeNote}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
