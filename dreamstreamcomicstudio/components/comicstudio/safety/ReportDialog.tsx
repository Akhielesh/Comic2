// Reader report (safety.md §3.4, sharing.md §8; owner P1-SAFETY). Reason chips, the current page
// (optional), a short note and Turnstile, then POST /api/comic/public/s/:slug/report. The server
// always answers 202, so the thank-you is the same whatever happens next. Hidden for the owner
// (the reader chrome decides; P2-READER-PUBLIC mounts it).

import React, { useEffect, useId, useState } from 'react';
import { Turnstile, resetTurnstile } from '../../Turnstile';
import { turnstileEnabled } from '../../../services/clientConfig';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { StudioApiError, reportPublicComic, type ReportReason } from '../studioApi';

export const REPORT_REASON_OPTIONS: { value: ReportReason; label: string }[] = [
  { value: 'sexual', label: 'Sexual content or nudity' },
  { value: 'violent', label: 'Graphic violence or gore' },
  { value: 'hateful', label: 'Hate or harassment' },
  { value: 'self_harm', label: 'Self-harm' },
  { value: 'real_person', label: 'Shows a real person badly' },
  { value: 'copyright', label: "Copies someone else's work" },
  { value: 'other', label: 'Something else' }
];
export const REPORT_NOTE_MAX = 300;

export interface ReportBody {
  reason: ReportReason;
  pageN?: number;
  note?: string;
  turnstileToken?: string;
}

export interface ReportDialogProps {
  slug: string;
  open: boolean;
  onClose(): void;
  /** The page the reader is on (1-based); offered as "About page N". */
  page?: number;
  /** Override the network call (tests, previews). */
  submit?(slug: string, body: ReportBody): Promise<void>;
  /** Positioning anchor for the popover presentation. */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

const errorText = (err: unknown): string => {
  if (err instanceof StudioApiError) {
    if (err.kind === 'rate_limit' || err.status === 429) return "You've sent a few reports already — please try again in a little while.";
    if (err.kind === 'bad_request' && /check/i.test(err.message)) return 'Please complete the quick check and send it again.';
    if (err.kind === 'bad_request') return err.message || "That report couldn't be sent.";
  }
  return "Couldn't send the report — check your connection and try again.";
};

export const ReportDialog: React.FC<ReportDialogProps> = ({ slug, open, onClose, page, submit, anchorRef }) => {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [aboutPage, setAboutPage] = useState(true);
  const [note, setNote] = useState('');
  const [token, setToken] = useState<string | undefined>();
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const legendId = useId();
  const noteId = useId();
  const counterId = useId();

  useEffect(() => {
    if (!open) return;
    setReason(null);
    setAboutPage(true);
    setNote('');
    setToken(undefined);
    setState('idle');
    setError(null);
  }, [open]);

  const needsToken = turnstileEnabled();
  const canSend = !!reason && state !== 'sending' && (!needsToken || !!token);

  const send = async () => {
    if (!reason || !canSend) return;
    setState('sending');
    setError(null);
    const body: ReportBody = {
      reason,
      ...(page && aboutPage ? { pageN: page } : {}),
      ...(note.trim() ? { note: note.trim().slice(0, REPORT_NOTE_MAX) } : {}),
      ...(token ? { turnstileToken: token } : {})
    };
    try {
      await (submit || reportPublicComic)(slug, body);
      setState('sent');
    } catch (err) {
      setState('idle');
      setError(errorText(err));
      setToken(undefined);
      resetTurnstile();
    }
  };

  return (
    <AdaptiveSheet open={open} onClose={onClose} label="Report this comic" title="Report this comic" presentation="auto" modal anchorRef={anchorRef}>
      <div className="max-h-[80vh] w-full min-w-0 max-w-md overflow-y-auto p-4 text-[var(--ds-ink)]">
        {state === 'sent' ? (
          <div role="status" aria-live="polite" className="py-4 text-center">
            <p className="text-[15px] font-semibold">Thanks — we&apos;ll take a look.</p>
            <p className="mt-1 text-[13px] text-[var(--ds-muted)]">Reports are private. The creator isn&apos;t told who sent them.</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--ds-accent)] px-5 text-[14px] font-medium text-white hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
            >
              Done
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <h2 className="text-[15px] font-semibold">Report this comic</h2>
            <p className="mt-0.5 text-[13px] text-[var(--ds-muted)]">What&apos;s wrong with it?</p>
            <fieldset className="mt-3 min-w-0" aria-labelledby={legendId}>
              <legend id={legendId} className="sr-only">
                Reason
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {REPORT_REASON_OPTIONS.map((o) => {
                  const checked = reason === o.value;
                  return (
                    <label
                      key={o.value}
                      className={[
                        'inline-flex min-h-[44px] max-w-full cursor-pointer items-center rounded-full border px-3 text-[13px] transition-colors motion-reduce:transition-none',
                        'focus-within:ring-2 focus-within:ring-[#D97757]/45',
                        checked ? 'border-[#D97757] bg-[#D97757]/10 text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]'
                      ].join(' ')}
                    >
                      <input type="radio" name="report-reason" value={o.value} checked={checked} onChange={() => setReason(o.value)} className="sr-only" />
                      <span className="break-words">{o.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {page ? (
              <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-2 text-[13px]">
                <input type="checkbox" checked={aboutPage} onChange={(e) => setAboutPage(e.target.checked)} className="h-4 w-4 accent-[#D97757]" />
                About page {page}
              </label>
            ) : null}

            <label htmlFor={noteId} className="mt-3 block text-[13px] font-medium">
              Anything else? <span className="font-normal text-[var(--ds-muted)]">(optional)</span>
            </label>
            <textarea
              id={noteId}
              value={note}
              maxLength={REPORT_NOTE_MAX}
              aria-describedby={counterId}
              onChange={(e) => setNote(e.target.value.slice(0, REPORT_NOTE_MAX))}
              rows={3}
              className="mt-1 block w-full min-w-0 resize-none rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-[14px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
              placeholder="A few words help us find it faster"
            />
            <div id={counterId} className="mt-0.5 text-right text-[11px] tabular-nums text-[var(--ds-muted)]">
              {note.length}/{REPORT_NOTE_MAX}
            </div>

            {needsToken && (
              <div className="mt-2 max-w-full overflow-hidden">
                <Turnstile action="comic_report" onToken={setToken} onExpire={() => setToken(undefined)} />
              </div>
            )}

            {error && (
              <p role="alert" className="mt-2 break-words text-[13px] text-[var(--ds-ink)]">
                {error}
              </p>
            )}

            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[var(--ds-hairline)] px-4 text-[14px] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSend}
                className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--ds-accent)] px-5 text-[14px] font-medium text-white hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
              >
                {state === 'sending' ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </AdaptiveSheet>
  );
};

export default ReportDialog;
