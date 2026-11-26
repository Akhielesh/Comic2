// Rate a reply (docs/features/reply-ratings.md): two quiet ink thumbs under a Director reply. Thumbs up is sent at once;
// thumbs down opens a short optional note first, which goes only when the person ticks "Share this note". Either way
// the row then reads "Thanks" with an Undo that really takes the rating back (POST /api/telemetry/feedback/withdraw:
// the person's own row for this reply is removed). Every request is a click: nothing waits on a timer. Where the rating
// stands lives in page memory (replyRatingMemory.ts), so the row mounted again shows the same state and never re-sends.
//
// Keyboard and screen reader: the thumbs are toggle buttons (aria-pressed) in a named group; a rated thumb keeps focus
// (aria-disabled, never removed from under it); Undo and Try again are one button that stays put while its request
// runs and fails (aria-disabled while busy), so focus never falls to the page; the note's field takes focus when it
// opens and Escape closes it; the status ("Thanks", "Couldn't send") is a polite live region. On a pointer that can
// hover, an older reply shows its thumbs on hover or focus; the latest reply, a rating in progress and every touch
// screen always show them.

import React, { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { FeedbackVoteValue } from '../../../apiTypes';
import type { Msg } from '../../../shared/comic/doc';
import { cn } from '../../../lib/utils';
import { Button, Checkbox, Field, IconButton, Textarea } from '../../ds';
import { DENSITY, FOCUS_RING, MUTED, RADIUS_CONTROL } from '../../chat/studioDesign';
import { RATING_NOTE_MAX } from './replyRating';
import { getRating, patchRating, ratingKey, sendRating, showRating, subscribeRatings, undoRating, type RatingStatus, type RatingSubject } from './replyRatingMemory';

export interface ReplyRatingProps {
  msg: Pick<Msg, 'id' | 'cards' | 'nextSteps'>;
  /** The comic's id: the rating's correlation key (the chat's session id plays the same part). */
  comicId?: string | null;
  /** Always shown (the latest reply). Otherwise a hover-capable pointer sees it on hover or focus of the reply. */
  always?: boolean;
}

const STATUS_TEXT: Partial<Record<RatingStatus, string>> = {
  sending: 'Sending…',
  resending: 'Sending…',
  sent: 'Thanks',
  failed: 'Couldn’t send.',
  undoing: 'Undoing…',
  undoFailed: 'Couldn’t undo.'
};

/** The one follow-up button: what pressing it does now, and whether its request is still running. */
const ACTION: Partial<Record<RatingStatus, { label: string; name?: string; busy?: boolean }>> = {
  sent: { label: 'Undo', name: 'Undo rating' },
  undoing: { label: 'Undo', name: 'Undo rating', busy: true },
  failed: { label: 'Try again' },
  undoFailed: { label: 'Try again' },
  resending: { label: 'Try again', busy: true }
};

const THUMB = 'size-3.5';
const LINK = cn(
  'inline-flex min-h-6 items-center px-1.5 text-[12px] font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:no-underline',
  RADIUS_CONTROL,
  DENSITY.coarse,
  FOCUS_RING
);

export const ReplyRating: React.FC<ReplyRatingProps> = ({ msg, comicId, always }) => {
  const key = ratingKey(comicId, msg.id);
  const { status, vote, note, share } = useSyncExternalStore(
    subscribeRatings,
    () => getRating(key),
    () => getRating(key)
  );
  const upRef = useRef<HTMLButtonElement | null>(null);
  const downRef = useRef<HTMLButtonElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const mounted = useRef(true);
  // What the rating sends, read when the person leaves with the note open (the row may be gone by then).
  const subject = useRef<RatingSubject>({ msg, comicId });
  subject.current = { msg, comicId };
  const noteId = `reply-note-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    mounted.current = true;
    const leave = showRating(key, () => subject.current);
    return () => {
      mounted.current = false;
      leave();
    };
  }, [key]);

  // The note takes focus when the person opens it here (a row mounted again with its note open never steals focus).
  const opened = useRef(status);
  useEffect(() => {
    if (status === 'noting' && opened.current !== 'noting') noteRef.current?.focus();
    opened.current = status;
  }, [status]);

  const thumbOf = (v: FeedbackVoteValue) => (v === 'like' ? upRef : downRef);
  const focusThumb = (v: FeedbackVoteValue | null) => {
    if (v) requestAnimationFrame(() => thumbOf(v).current?.focus());
  };

  const undo = async () => {
    const was = vote;
    const settled = await undoRating(key, msg.id);
    if (settled === 'idle' && mounted.current) focusThumb(was);
  };

  const closeNote = () => {
    patchRating(key, { status: 'idle' });
    focusThumb('dislike');
  };

  const locked = status !== 'idle' && status !== 'noting';
  const onThumb = (v: FeedbackVoteValue) => {
    if (locked) return;
    if (v === 'dislike') {
      if (status === 'noting') closeNote();
      else patchRating(key, { status: 'noting', vote: 'dislike' });
      return;
    }
    void sendRating(key, subject.current, 'like');
  };

  const action = ACTION[status];
  const onAction = () => {
    if (!action || action.busy) return;
    if (status === 'sent' || status === 'undoFailed') void undo();
    else if (status === 'failed' && vote) void sendRating(key, subject.current, vote, vote === 'dislike' ? { text: note, share } : undefined);
  };

  const sendNote = () => {
    void sendRating(key, subject.current, 'dislike', { text: note, share });
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
        {action && (
          <button type="button" className={LINK} aria-label={action.name} aria-disabled={action.busy || undefined} onClick={onAction}>
            {action.label}
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
            <Textarea ref={noteRef} rows={2} maxLength={RATING_NOTE_MAX} value={note} onChange={(e) => patchRating(key, { note: e.target.value })} />
          </Field>
          <Checkbox
            label="Share this note with DreamStream"
            description="Left unticked, only your thumbs-down is sent."
            checked={share}
            onCheckedChange={(next) => patchRating(key, { share: next })}
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
