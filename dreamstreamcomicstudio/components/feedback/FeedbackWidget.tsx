import React, { useEffect, useId, useRef, useState } from 'react';
import { Megaphone, X, Check } from 'lucide-react';
import { FEEDBACK_CATEGORIES, type FeedbackSentiment } from '../../apiTypes';
import {
  feedbackReportHelp,
  prepareReportScreenshot,
  sendFeedbackReport,
  type PreparedScreenshot
} from '../../services/feedbackReports';
import { REPORT_LIMITS, type ReportKind } from '../../shared/feedbackReports';
import { cn } from '../../lib/utils';
import {
  DENSITY,
  DIALOG_TITLE_FROM_SM,
  FOCUS_RING,
  OVERLAY,
  OVERLINE,
  SCALE_IN,
  SCRIM,
  SHADOW_SOFT,
  STATUS_INK,
  WRAP_TEXT,
  Z
} from '../chat/studioDesign';
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
/** The panel's entrance: the quick overlay scale-in (styles/ds-motion.css), still under reduced motion. */
export const FEEDBACK_PANEL_ENTER = SCALE_IN;

/**
 * The global "Send feedback" pill and its panel (Atlas: the overlay surface over the scrim, a plain title,
 * the DS fields and the ink primary). Escape, the close button or a click on the scrim closes it, and focus
 * goes back to the pill, so a keyboard or screen-reader user keeps their place.
 */
export const FeedbackWidget: React.FC<{ showLauncher?: boolean; surface?: string; ownerId?: string }> = ({
  showLauncher = true,
  surface,
  ownerId
}) => {
  const [kind, setKind] = useState<ReportKind>('feedback');
  const [images, setImages] = useState<PreparedScreenshot[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [includeArea, setIncludeArea] = useState(false);
  const [failure, setFailure] = useState('');
  const [receipt, setReceipt] = useState('');
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const preparingRef = useRef(false);
  const attempt = useRef<{ input: string; id: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
    },
    []
  );
  const [open, setOpen] = useState(false);
  const [sentiment, setSentiment] = useState<FeedbackSentiment | null>(null);
  const [category, setCategory] = useState('');
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const titleId = useId();
  const moodId = useId();
  const topicId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (status === 'sent') receiptRef.current?.focus();
  }, [status]);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const reset = () => {
    setSentiment(null);
    setCategory('');
    setComment('');
    setStatus('idle');
    setImages([]);
    setPreparing(false);
    preparingRef.current = false;
    setIncludeArea(false);
    setFailure('');
    setReceipt('');
    attempt.current = null;
  };

  // Every delayed step goes through `later`, so leaving the page cancels it: a timer that fires after the widget is
  // gone must not touch its state.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== id);
      fn();
    }, ms);
    timers.current.push(id);
  };
  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];
    },
    []
  );

  const close = () => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    setOpen(false);
    // Reset shortly after the close animation so a reopened panel is clean.
    later(reset, 200);
  };

  const launch = (newKind: ReportKind, trigger?: HTMLElement, editorialContext?: string) => {
    if (request.current) return;
    generation.current++;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    reset();
    setKind(newKind);
    if (editorialContext) setComment(editorialContext.slice(0, 240));
    returnFocus.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setOpen(true);
  };
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      launch(detail?.kind === 'bug' ? 'bug' : 'feedback', undefined,
        typeof detail?.editorialContext === 'string' ? detail.editorialContext : undefined);
    };
    window.addEventListener('dreamstream:open-feedback-report', handler);
    return () => window.removeEventListener('dreamstream:open-feedback-report', handler);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab' && panelRef.current) {
        const controls = panelRef.current.querySelectorAll<HTMLElement>(
          'button:enabled,input:enabled,textarea:enabled,select:enabled,a[href]'
        );
        const target = e.shiftKey ? controls[0] : controls[controls.length - 1];
        if (
          target &&
          (document.activeElement === target ||
            !Array.from(controls).includes(document.activeElement as HTMLElement))
        ) {
          e.preventDefault();
          (e.shiftKey ? controls[controls.length - 1] : controls[0]).focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The pill remounts when the panel closes: hand focus back to it (never on the first render).
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (returnFocus.current?.isConnected && returnFocus.current !== document.body) returnFocus.current.focus();
    else launcherRef.current?.focus();
  }, [open]);

  const canSubmit =
    kind === 'bug' ? Boolean(comment.trim()) : Boolean(sentiment || category || comment.trim() || images.length);

  const addFiles = async (list: File[]) => {
    if (preparingRef.current || request.current || !list.length) return;
    if (list.length + images.length > REPORT_LIMITS.images) {
      setFailure('Attach up to 10 screenshots. Remove one before adding more.');
      return;
    }
    const token = generation.current;
    preparingRef.current = true;
    setPreparing(true);
    setFailure('');
    const accepted: PreparedScreenshot[] = [];
    const errors: string[] = [];
    for (const file of list) {
      if (generation.current !== token) return;
      try {
        accepted.push(await prepareReportScreenshot(file));
      } catch (error) {
        errors.push(file.name + ': ' + feedbackReportHelp(error, 'Choose another image.'));
      }
    }
    if (generation.current !== token) return;
    setImages((previous) => [...previous, ...accepted]);
    setFailure(errors.join(' '));
    preparingRef.current = false;
    setPreparing(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit || preparingRef.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus('sending');
    setFailure('');
    const data = {
      kind,
      comment: comment.trim(),
      category: kind === 'bug' ? 'Bug or error' : category || undefined,
      sentiment: kind === 'feedback' ? (sentiment ?? undefined) : undefined,
      surface: includeArea ? surface : undefined,
      images: images.map((img) => img.image)
    };
    const content = JSON.stringify(data);
    try {
      if (attempt.current?.input !== content) attempt.current = { input: content, id: crypto.randomUUID() };
      const result = await sendFeedbackReport(
        { ...data, submissionId: attempt.current.id },
        ownerId,
        controller.signal
      );
      if (controller.signal.aborted) return;
      setReceipt(result.id);
      setStatus('sent');
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(feedbackReportHelp(error, 'Your report could not be saved. Please retry.'));
        setStatus('idle');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  return (
    <>
      {showLauncher && !open && (
        <button
          ref={launcherRef}
          type="button"
          onClick={(e) => launch('feedback', e.currentTarget)}
          data-slot="feedback-launcher"
          className={`${cn(FEEDBACK_LAUNCHER, Z.chrome)} ${FOCUS_RING}`}
          aria-label="Send feedback"
        >
          <Megaphone aria-hidden="true" className="size-4" />
          Feedback
        </button>
      )}

      {open && (
        <div
          className={cn('fixed inset-0 flex items-end justify-center p-4 sm:items-center', SCRIM, Z.scrim)}
          onClick={close}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-slot="feedback-panel"
            className={cn(
              'w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto',
              OVERLAY,
              FEEDBACK_PANEL_ENTER
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] py-2 pl-4 pr-2">
              <div className="flex items-center gap-2">
                <Megaphone aria-hidden="true" className="size-4 text-[var(--ds-muted)]" />
                <h2
                  id={titleId}
                  className={cn('m-0 text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)]', DIALOG_TITLE_FROM_SM)}
                >
                  {kind === 'bug' ? 'Report a bug' : 'Send feedback'}
                </h2>
              </div>
              <IconButton ref={closeRef} label="Close" title={null} onClick={close}>
                <X />
              </IconButton>
            </div>

            {status === 'sent' ? (
              <div ref={receiptRef} tabIndex={-1} role="status" className="space-y-2 p-6 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)]">
                  <Check aria-hidden="true" className={cn('size-6', STATUS_INK.healthy)} />
                </div>
                <p className="m-0 font-semibold text-[var(--ds-ink)]">Thanks — we hear you.</p>
                <p className="m-0 text-xs text-[var(--ds-muted)]">
                  Report ID <code className="select-all break-all">{receipt}</code>
                </p>
              </div>
            ) : (
              <fieldset disabled={status === 'sending'} className="m-0 min-w-0 space-y-4 border-0 p-4">
                <div className="flex gap-2" role="group" aria-label="Report type">
                  <Button
                    size="sm"
                    variant={kind === 'feedback' ? 'default' : 'ghost'}
                    aria-pressed={kind === 'feedback'}
                    onClick={() => setKind('feedback')}
                  >
                    Feedback
                  </Button>
                  <Button
                    size="sm"
                    variant={kind === 'bug' ? 'default' : 'ghost'}
                    aria-pressed={kind === 'bug'}
                    onClick={() => setKind('bug')}
                  >
                    Report a bug
                  </Button>
                </div>
                {kind === 'feedback' && (
                  <>
                    <div role="group" aria-labelledby={moodId}>
                      <p id={moodId} className={cn('m-0 mb-1.5', OVERLINE)}>
                        How&apos;s it going?
                      </p>
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
                            <span aria-hidden="true" className="text-xl leading-none">
                              {s.emoji}
                            </span>
                            <span className="text-[11px] font-medium text-[var(--ds-muted)]">{s.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p id={topicId} className={cn('m-0 mb-1.5', OVERLINE)}>
                        What&apos;s it about?
                      </p>
                      <Select
                        aria-labelledby={topicId}
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        placeholder="Choose a category…"
                        options={FEEDBACK_CATEGORIES.map((c) => ({ value: c, label: c }))}
                      />
                    </div>
                  </>
                )}
                <Textarea
                  maxLength={REPORT_LIMITS.comment}
                  aria-label={kind === 'bug' ? 'What happened?' : 'Tell us more'}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={
                    kind === 'bug'
                      ? 'What did you try, what happened, and what did you expect?'
                      : 'Tell us what worked or what you would change.'
                  }
                  rows={4}
                />

                {surface && (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={includeArea}
                      onChange={(e) => setIncludeArea(e.target.checked)}
                    />
                    Include current area ({surface})
                  </label>
                )}
                <label className="block space-y-1 text-sm font-medium">
                  Screenshots ({images.length}/10)
                  <input
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp"
                    disabled={preparing || images.length >= REPORT_LIMITS.images}
                    onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = '';
                      void addFiles(files);
                    }}
                    className="block w-full text-xs"
                  />
                </label>
                <p className="text-xs text-[var(--ds-muted)]">
                  Only attach screenshots you want support staff to see. Crop out personal information and API
                  keys.
                </p>
                {images.length > 0 && (
                  <ul className="grid grid-cols-2 gap-2">
                    {images.map((img, index) => (
                      <li key={index} className="min-w-0 border border-[var(--ds-hairline)] rounded p-1">
                        <img
                          className="h-16 w-full object-contain"
                          src={'data:' + img.mime + ';base64,' + img.image}
                          alt={'Screenshot ' + (index + 1)}
                        />
                        <button
                          type="button"
                          onClick={() => setImages((v) => v.filter((_, i) => i !== index))}
                          aria-label={'Remove screenshot ' + (index + 1)}
                          className="w-full truncate text-xs"
                        >
                          Remove {img.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {preparing && (
                  <p role="status" className="text-sm">
                    Preparing screenshots…
                  </p>
                )}
                {failure && (
                  <p role="alert" className={cn(WRAP_TEXT, 'text-sm')}>
                    {failure}
                  </p>
                )}
                <Button
                  className="w-full"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit || preparing}
                  loading={status === 'sending'}
                >
                  {status === 'sending' ? 'Sending…' : kind === 'bug' ? 'Send bug report' : 'Send feedback'}
                </Button>
              </fieldset>
            )}
          </div>
        </div>
      )}
    </>
  );
};
