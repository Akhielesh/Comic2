import React, { useRef, useState, useEffect } from 'react';
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import { submitFeedback } from '../../services/feedback';
import type { FeedbackTargetType, FeedbackVoteValue, TelemetrySource } from '../../apiTypes';
import { cn } from '../../lib/utils';
import { Button } from '../ds';
import { DENSITY, FIELD, FOCUS_RING, MUTED, RADIUS_CONTROL, TONE_TEXT } from '../chat/studioDesign';

interface FeedbackButtonsProps {
  /** What is being rated (a chat response, an error, a crash, …). */
  targetType: FeedbackTargetType;
  /** Id of the rated thing (message id, error id) so votes can be tied to it. */
  targetId?: string;
  source: TelemetrySource;
  surface?: string;
  /** Correlation key — the chat/session id this rating belongs to, so feedback can
   *  be grouped with the rest of that conversation's events. */
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Tighter styling for dense action rows (e.g. under a chat message). */
  compact?: boolean;
  className?: string;
}

/**
 * Reusable like/dislike control that writes EXACTLY ONE feedback record per opinion.
 *
 * - A "like" is a committed signal, so it submits on click.
 * - A "dislike" opens an optional "what went wrong?" box and submits a SINGLE row
 *   when the user confirms (Send / Skip) — the comment is part of that same row, not
 *   a second one. A safety submit on blur/unmount guarantees an abandoned dislike is
 *   still recorded once (a `submitted` guard makes every path idempotent).
 */
export const FeedbackButtons: React.FC<FeedbackButtonsProps> = ({
  targetType,
  targetId,
  source,
  surface,
  sessionId,
  metadata,
  compact,
  className
}) => {
  const [vote, setVote] = useState<FeedbackVoteValue | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);

  // One submission per mounted control, no matter how many paths fire.
  const submittedRef = useRef(false);
  // Keep the latest typed reason reachable from the unmount cleanup.
  const reasonRef = useRef('');
  reasonRef.current = reason;

  const submitOnce = (finalVote: FeedbackVoteValue, comment?: string) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    void submitFeedback({
      targetType,
      targetId,
      source,
      surface,
      sessionId,
      vote: finalVote,
      comment: comment && comment.trim() ? comment.trim() : undefined,
      metadata
    });
    setDone(true);
  };

  // Safety net: if a dislike was started but never confirmed, record it once on unmount.
  useEffect(() => {
    return () => {
      if (vote === 'dislike' && !submittedRef.current) {
        submitOnce('dislike', reasonRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vote]);

  const handleLike = () => {
    setVote('like');
    submitOnce('like');
  };

  const handleDislike = () => {
    setVote('dislike');
    setReasonOpen(true); // No submit yet — wait for Send/Skip so it's a single record.
  };

  const handleSend = () => {
    setReasonOpen(false);
    submitOnce('dislike', reason);
  };

  const handleSkip = () => {
    setReasonOpen(false);
    submitOnce('dislike');
  };

  const iconSize = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';
  // A 24 px target on a fine pointer (the dense row under a message), 44 × 44 under a coarse one.
  const btn = (active: boolean, activeClass: string) =>
    cn(
      'inline-flex min-h-6 min-w-6 items-center justify-center gap-0.5 font-medium transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:bg-[var(--ds-hover)]',
      RADIUS_CONTROL,
      DENSITY.coarseSquare,
      FOCUS_RING,
      active ? activeClass : `${MUTED} hover:text-[var(--ds-ink)]`
    );

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className={`flex items-center gap-2 ${compact ? 'text-[11px]' : 'text-xs'}`}>
        <span className={MUTED}>{done ? 'Thanks!' : 'Helpful?'}</span>
        <button
          type="button"
          onClick={handleLike}
          className={btn(vote === 'like', TONE_TEXT.success)}
          aria-pressed={vote === 'like'}
          title="This was helpful"
        >
          <ThumbsUp className={iconSize} />
        </button>
        <button
          type="button"
          onClick={handleDislike}
          className={btn(vote === 'dislike', TONE_TEXT.danger)}
          aria-pressed={vote === 'dislike'}
          title="This wasn't helpful"
        >
          <ThumbsDown className={iconSize} />
        </button>
        {done && (
          <span className={cn('flex items-center gap-0.5 font-medium', TONE_TEXT.success)}>
            <Check className={iconSize} /> Sent
          </span>
        )}
      </div>

      {reasonOpen && (
        <div className="flex items-start gap-1.5">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => { if (vote === 'dislike' && !submittedRef.current) handleSend(); }}
            placeholder="What went wrong? (optional)"
            rows={2}
            autoFocus
            className={cn(FIELD, 'min-w-0 flex-1 resize-none px-2 py-1 text-[length:var(--ds-text-sm)]')}
          />
          <div className="flex flex-col gap-1">
            <Button type="button" size="sm" onClick={handleSend}>
              Send
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={handleSkip} className={MUTED}>
              Skip
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
