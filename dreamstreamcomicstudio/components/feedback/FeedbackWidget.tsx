import React, { useState } from 'react';
import { Megaphone, X, Check, Loader2 } from 'lucide-react';
import { submitFeedback, FEEDBACK_CATEGORIES, type FeedbackSentiment } from '../../services/feedback';

// A deliberately low-profile launcher — a slim pill, NOT the big floating chat
// circle that was removed — so platform feedback is always one tap away without
// re-cluttering the corner. Opens a small modal: how it felt (sentiment), what
// about (category), and a free-text note.
const SENTIMENTS: { value: FeedbackSentiment; emoji: string; label: string }[] = [
  { value: 'frustrated', emoji: '😖', label: 'Frustrated' },
  { value: 'negative', emoji: '🙁', label: 'Unhappy' },
  { value: 'neutral', emoji: '😐', label: 'Okay' },
  { value: 'positive', emoji: '🙂', label: 'Happy' }
];

export const FeedbackWidget: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [sentiment, setSentiment] = useState<FeedbackSentiment | null>(null);
  const [category, setCategory] = useState('');
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

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
          className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 bg-white text-black border-2 border-black rounded-full pl-2.5 pr-3 py-1.5 text-xs font-bold shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] hover:shadow-none hover:translate-x-[1px] hover:translate-y-[1px] transition-all"
          aria-label="Send feedback"
        >
          <Megaphone className="w-4 h-4" />
          Feedback
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4" onClick={close}>
          <div
            className="w-full max-w-sm bg-white border-4 border-black rounded-2xl shadow-[8px_8px_0px_0px_rgba(0,0,0,0.45)] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-black text-white px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Megaphone className="w-4 h-4" />
                <span className="font-display text-lg leading-none">Send feedback</span>
              </div>
              <button type="button" onClick={close} className="text-white hover:text-brand-red" aria-label="Close">
                <X size={20} />
              </button>
            </div>

            {status === 'sent' ? (
              <div className="p-6 text-center space-y-2">
                <div className="w-12 h-12 mx-auto bg-green-100 rounded-full flex items-center justify-center">
                  <Check className="w-6 h-6 text-green-600" />
                </div>
                <p className="font-bold">Thanks — we hear you.</p>
                <p className="text-xs text-slate-500">Every note helps us improve the platform.</p>
              </div>
            ) : (
              <div className="p-4 space-y-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">How's it going?</p>
                  <div className="flex items-center gap-2">
                    {SENTIMENTS.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => setSentiment(s.value)}
                        className={`flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg border-2 transition-colors ${
                          sentiment === s.value ? 'border-black bg-brand-yellow' : 'border-slate-200 hover:border-black'
                        }`}
                        aria-pressed={sentiment === s.value}
                        title={s.label}
                      >
                        <span className="text-xl leading-none">{s.emoji}</span>
                        <span className="text-[9px] font-bold uppercase text-slate-500">{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">What's it about?</p>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full border-2 border-black rounded-md px-2 py-2 text-sm bg-white focus:outline-none"
                  >
                    <option value="">Choose a category…</option>
                    {FEEDBACK_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Tell us more — what worked, what didn't, what you wish it did…"
                    rows={4}
                    className="w-full border-2 border-black rounded-md px-3 py-2 text-sm bg-slate-50 focus:bg-white focus:outline-none resize-none"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit || status === 'sending'}
                  className="w-full flex items-center justify-center gap-2 border-2 border-black rounded-md py-2 text-sm font-bold bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-40 disabled:hover:bg-brand-yellow disabled:hover:text-black"
                >
                  {status === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {status === 'sending' ? 'Sending…' : 'Send feedback'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
