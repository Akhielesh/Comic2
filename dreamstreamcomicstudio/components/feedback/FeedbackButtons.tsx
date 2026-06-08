import React, { useState } from 'react';
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import { submitFeedback } from '../../services/feedback';
import type { FeedbackTargetType, FeedbackVoteValue, TelemetrySource } from '../../apiTypes';

interface FeedbackButtonsProps {
  /** What is being rated (a chat response, an error, a crash, …). */
  targetType: FeedbackTargetType;
  /** Id of the rated thing (message id, error id) so votes can be tied to it. */
  targetId?: string;
  source: TelemetrySource;
  surface?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Tighter styling for dense action rows (e.g. under a chat message). */
  compact?: boolean;
  className?: string;
}

/**
 * Reusable like/dislike control. The vote is recorded the instant it's clicked
 * (so a signal is captured "no matter what"), and a dislike reveals an optional
 * "what went wrong?" box whose text is sent as a follow-up. Used under chat
 * responses, on error states, and in the crash screen.
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
  const [sentReason, setSentReason] = useState(false);

  const base = { targetType, targetId, source, surface, sessionId, metadata };

  const handleVote = (next: FeedbackVoteValue) => {
    setVote(next);
    void submitFeedback({ ...base, vote: next });
    setReasonOpen(next === 'dislike');
  };

  const handleSendReason = () => {
    const comment = reason.trim();
    if (comment) {
      void submitFeedback({ ...base, vote: 'dislike', comment, metadata: { ...metadata, detail: true } });
    }
    setSentReason(true);
    setReasonOpen(false);
  };

  const iconSize = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const btn = (active: boolean, activeClass: string) =>
    `flex items-center gap-0.5 font-bold transition-colors ${
      active ? activeClass : 'text-slate-400 hover:text-black'
    }`;

  return (
    <div className={`flex flex-col gap-1 ${className || ''}`}>
      <div className={`flex items-center gap-2 ${compact ? 'text-[11px]' : 'text-xs'}`}>
        <span className="text-slate-400">{vote ? 'Thanks!' : 'Helpful?'}</span>
        <button
          type="button"
          onClick={() => handleVote('like')}
          className={btn(vote === 'like', 'text-green-600')}
          aria-pressed={vote === 'like'}
          title="This was helpful"
        >
          <ThumbsUp className={iconSize} />
        </button>
        <button
          type="button"
          onClick={() => handleVote('dislike')}
          className={btn(vote === 'dislike', 'text-brand-red')}
          aria-pressed={vote === 'dislike'}
          title="This wasn't helpful"
        >
          <ThumbsDown className={iconSize} />
        </button>
        {sentReason && (
          <span className="flex items-center gap-0.5 text-green-600 font-bold">
            <Check className={iconSize} /> Sent
          </span>
        )}
      </div>

      {reasonOpen && (
        <div className="flex items-start gap-1.5">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What went wrong? (optional)"
            rows={2}
            className="flex-1 text-[11px] border-2 border-black rounded-md px-2 py-1 bg-white focus:outline-none resize-none"
          />
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={handleSendReason}
              className="text-[11px] font-bold border-2 border-black rounded-md px-2 py-0.5 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors"
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => setReasonOpen(false)}
              className="text-[10px] font-bold text-slate-400 hover:text-black"
            >
              Skip
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
