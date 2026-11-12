import React, { useEffect, useId, useRef, useState } from 'react';
import { Megaphone, X, Check } from 'lucide-react';
import { submitFeedback, FEEDBACK_CATEGORIES, type FeedbackSentiment } from '../../services/feedback';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, OVERLAY, OVERLINE, RISE_IN, SCRIM, SHADOW_SOFT, STATUS_INK, Z } from '../chat/studioDesign';
import { Button } from '../ds/Button';
import { IconButton } from '../ds/IconButton';
import { Select } from '../ds/Select';
import { Textarea } from '../ds/Input';

// A deliberately low-profile launcher — a slim pill, NOT the big floating chat
// circle that was removed — so platform feedback is always one tap away without
// re-cluttering the corner. Opens a small panel: how it felt (sentiment), what
// about (category), and a free-text note.
const SENTIMENTS: { value: FeedbackSentiment; emoji: string; label: string }[] = [
  { value: 'frustrated', emoji: '😖', label: 'Frustrated' },
  { value: 'negative', emoji: '🙁', label: 'Unhappy' },
  { value: 'neutral', emoji: '😐', label: 'Okay' },
  { value: 'positive', emoji: '🙂', label: 'Happy' }
];

/** The launcher: a quiet raised pill in the corner, above the bottom safe area, 44 px under a coarse pointer. */
export const FEEDBACK_LAUNCHER = `fixed bottom-[calc(1rem+var(--sa-bottom-eff,0px))] right-4 flex items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-raised)] py-1.5 pl-2.5 pr-3 text-xs font-medium text-[var(--ds-ink)] ${SHADOW_SOFT} transition-colors duration-[var(--ds-motion-fast,120ms)] hover:bg-[var(--ds-hover)] motion-reduce:transition-none ${DENSITY.coarse}`;
/** A sentiment choice: an outlined tile; the chosen one takes the ink edge and the soft accent. */
export const SENTIMENT_TILE = `flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-[var(--ds-radius-control,0.75rem)] border py-2 transition-colors duration-[var(--ds-motion-fast,120ms)] motion-reduce:transition-none ${DENSITY.coarse}`;
export const SENTIMENT_TILE_ON = 'border-[var(--ds-ink)] bg-[var(--ds-accent-soft)]';
export const SENTIMENT_TILE_OFF = 'border-[var(--ds-hairline)] hover:border-[var(--ds-control-border-hover)]';

/**
 * The global "Send feedback" pill and its panel (Atlas: the overlay surface over the scrim, a plain title,
 * the DS fields and the ink primary). Escape, the close button or a click on the scrim closes it.
 */
export const FeedbackWidget: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [sentiment, setSentiment] = useState<FeedbackSentiment | null>(null);
  const [category, setCategory] = useState('');
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const titleId = useId();
  const moodId = useId();
  const topicId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  const reset = () => {
    setSentiment(null);
    setCategory('');
    setComment('');
    setStatus('idle');
  };

  const close = () => {
    setOpen(false);
    // Reset shortly after the close animation so a reopened panel is clean.
    setTimeout(reset, 200);
  };

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSubmit = Boolean(sentiment || category || comment.trim());

  const handleSubmit = async () => {
    if (!canSubmit || status === 'sending') return;
    setStatus('sending');
    await submitFeedback({
      targetType: 'platform',
      sentiment: sentiment ?? undefined,
      category: category || undefined,
      comment: comment.trim() || undefined,
      source: 'client',
      metadata: { widget: 'global_feedback' }
    });
    setStatus('sent');
    setTimeout(close, 1400);
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-slot="feedback-launcher"
          className={`${cn(FEEDBACK_LAUNCHER, Z.chrome)} ${FOCUS_RING}`}
          aria-label="Send feedback"
        >
          <Megaphone aria-hidden="true" className="size-4" />
          Feedback
        </button>
      )}

      {open && (
        <div className={cn('fixed inset-0 flex items-end justify-center p-4 sm:items-center', SCRIM, Z.scrim)} onClick={close}>
          <div
            role="dialog"
            aria-labelledby={titleId}
            data-slot="feedback-panel"
            className={cn('w-full max-w-sm overflow-hidden', OVERLAY, RISE_IN)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] py-2 pl-4 pr-2">
              <div className="flex items-center gap-2">
                <Megaphone aria-hidden="true" className="size-4 text-[var(--ds-muted)]" />
                <h2 id={titleId} className="m-0 text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)]">
                  Send feedback
                </h2>
              </div>
              <IconButton ref={closeRef} label="Close" title={null} onClick={close}>
                <X />
              </IconButton>
            </div>

            {status === 'sent' ? (
              <div role="status" className="space-y-2 p-6 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)]">
                  <Check aria-hidden="true" className={cn('size-6', STATUS_INK.healthy)} />
                </div>
                <p className="m-0 font-semibold text-[var(--ds-ink)]">Thanks — we hear you.</p>
                <p className="m-0 text-xs text-[var(--ds-muted)]">Every note helps us improve the platform.</p>
              </div>
            ) : (
              <div className="space-y-4 p-4">
                <div role="group" aria-labelledby={moodId}>
                  <p id={moodId} className={cn('m-0 mb-1.5', OVERLINE)}>How&apos;s it going?</p>
                  <div className="flex items-center gap-2">
                    {SENTIMENTS.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => setSentiment(s.value)}
                        className={`${cn(SENTIMENT_TILE, sentiment === s.value ? SENTIMENT_TILE_ON : SENTIMENT_TILE_OFF)} ${FOCUS_RING}`}
                        aria-pressed={sentiment === s.value}
                        title={s.label}
                      >
                        <span aria-hidden="true" className="text-xl leading-none">{s.emoji}</span>
                        <span className="text-[11px] font-medium text-[var(--ds-muted)]">{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p id={topicId} className={cn('m-0 mb-1.5', OVERLINE)}>What&apos;s it about?</p>
                  <Select
                    aria-labelledby={topicId}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="Choose a category…"
                    options={FEEDBACK_CATEGORIES.map((c) => ({ value: c, label: c }))}
                  />
                </div>

                <Textarea
                  aria-label="Tell us more"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Tell us more — what worked, what didn't, what you wish it did…"
                  rows={4}
                />

                <Button className="w-full" onClick={() => void handleSubmit()} disabled={!canSubmit} loading={status === 'sending'}>
                  {status === 'sending' ? 'Sending…' : 'Send feedback'}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
