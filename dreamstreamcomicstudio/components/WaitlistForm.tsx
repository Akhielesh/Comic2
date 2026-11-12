import React, { useState } from 'react';
import { AlertCircle, ArrowRight, Check, Mail } from 'lucide-react';
import { cn } from '../lib/utils';
import { DENSITY, FIELD_EMBEDDED, FIELD_GROUP, FOCUS_RING, RADIUS_CONTROL, RADIUS_PILL, STATUS_INK, STATUS_SURFACE } from './chat/studioDesign';
import { Button } from './ds/Button';
import { Textarea } from './ds/Input';
import { submitWaitlistEmail, WaitlistKind, type ProductInterest } from '../services/waitlist';
import { Turnstile, resetTurnstile } from './Turnstile';
import { turnstileEnabled } from '../services/clientConfig';

interface WaitlistFormProps {
  /** 'updates' = stay-in-the-loop, 'access' = request early access. */
  kind?: WaitlistKind;
  /** Free-form tag stored with the row so we know which surface it came from. */
  source?: string;
  /** Kept for its callers: the form reads the page tokens, so it suits light and dark pages alike. */
  variant?: 'light' | 'dark';
  placeholder?: string;
  buttonLabel?: string;
  className?: string;
  onJoined?: (email: string) => void;
  /** Shown when the email already has an account ('account-exists') — takes the user to sign-in. */
  onSignIn?: () => void;
}

/** Friendly labels for the optional "what do you want first access to?" chips. */
const PRODUCT_OPTIONS: { id: ProductInterest; label: string }[] = [
  { id: 'comic_studio', label: 'Comic Studio' },
  { id: 'chat_studio', label: 'Chat Studio' },
  { id: 'code_studio', label: 'Code Studio' },
  { id: 'stream_studio', label: 'Stream Studio' },
  { id: 'dashboards', label: 'Dashboards' },
];

export const WaitlistForm: React.FC<WaitlistFormProps> = ({
  kind = 'updates',
  source,
  placeholder = 'you@example.com',
  buttonLabel = 'Notify me',
  className = '',
  onJoined,
  onSignIn
}) => {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error' | 'account-exists' | 'already-invited'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState('');
  // Optional intent: product chips + free-form note — email alone still submits.
  const [interests, setInterests] = useState<ProductInterest[]>([]);
  const [feedback, setFeedback] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'loading') return;
    if (turnstileEnabled() && !captchaToken) {
      setStatus('error');
      setMessage('Please complete the verification challenge.');
      return;
    }
    setStatus('loading');
    setMessage(null);

    const result = await submitWaitlistEmail(email, kind, source ? { source } : {}, captchaToken || undefined, {
      productInterests: interests.length ? interests : undefined,
      feedback: feedback.trim() || undefined
    });
    if (result.ok) {
      setStatus('success');
      setMessage(result.message);
      onJoined?.(email.trim().toLowerCase());
    } else if (result.status === 'account-exists') {
      // Already a member: don't add them to the waitlist — point them at sign-in.
      setStatus('account-exists');
      setMessage(result.message);
      setCaptchaToken('');
      resetTurnstile();
    } else if (result.status === 'already-invited') {
      // Already invited: access was granted before — the backend re-sent the invite
      // email, so point them at its setup instructions instead of the waitlist.
      setStatus('already-invited');
      setMessage(result.message);
      setCaptchaToken('');
      resetTurnstile();
    } else {
      setStatus('error');
      setMessage(result.message);
      setCaptchaToken('');
      resetTurnstile();
    }
  };

  if (status === 'success') {
    return (
      <div role="status" className={cn('flex items-center gap-3 border px-4 py-3', RADIUS_CONTROL, STATUS_SURFACE.healthy, className)}>
        <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center border border-current', RADIUS_PILL, STATUS_INK.healthy)}>
          <Check className="size-4" />
        </span>
        <span className="text-[length:var(--ds-text-base)] font-medium">{message}</span>
      </div>
    );
  }

  // On the page tokens (DS fields, the ink submit, outline toggle chips, calm status callouts), in both themes: the
  // request-access step of the sign-in card is one click off the comics landing. The logic above is unchanged.
  // Running text (the legend, the callouts' words) inherits the surrounding ink rather than naming it, so the form
  // also reads inside the main site's fixed-white "Stay updated" card in dark mode; every field paints its own.
  return (
    <form onSubmit={handleSubmit} className={cn('w-full', className)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className={cn(FIELD_GROUP, DENSITY.coarse, 'h-10 min-w-0 flex-1 px-3')}>
          <Mail aria-hidden className="size-4 shrink-0 text-[var(--ds-muted)]" />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status === 'error' || status === 'account-exists' || status === 'already-invited') setStatus('idle');
            }}
            placeholder={placeholder}
            aria-label="Email address"
            autoComplete="email"
            className={cn(FIELD_EMBEDDED, 'h-full text-[length:var(--ds-text-base)] text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)]')}
          />
        </label>
        <Button type="submit" loading={status === 'loading'} className="h-10 shrink-0">
          {buttonLabel} <ArrowRight aria-hidden />
        </Button>
      </div>

      {/* Optional intent — chips + note. Email alone still submits. */}
      <fieldset className="mt-4 min-w-0">
        <legend className="text-[length:var(--ds-text-sm)] font-medium">
          What do you want first access to? <span className="font-normal opacity-70">(optional)</span>
        </legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PRODUCT_OPTIONS.map(({ id, label }) => {
            const selected = interests.includes(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => setInterests((prev) => (selected ? prev.filter((p) => p !== id) : [...prev, id]))}
                className={cn(
                  'inline-flex items-center gap-1 border px-3 py-1 text-[length:var(--ds-text-sm)] font-medium transition-colors duration-[var(--ds-motion-fast)]',
                  'border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)] aria-pressed:border-[var(--ds-ink)] aria-pressed:bg-[var(--ds-well)] aria-pressed:text-[var(--ds-ink)]',
                  RADIUS_PILL,
                  DENSITY.coarse,
                  FOCUS_RING
                )}
              >
                {selected ? <Check aria-hidden className="size-3.5" /> : null}
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>
      <Textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="Anything you'd want to see? (optional)"
        aria-label="Anything you'd want to see? (optional)"
        className="mt-3 resize-y"
      />

      {turnstileEnabled() && (
        <div className="mt-3">
          <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action="waitlist" />
        </div>
      )}
      {status === 'error' && message && (
        <p role="alert" className={cn('mt-3 flex items-start gap-2 border px-3 py-2 text-[length:var(--ds-text-sm)]', RADIUS_CONTROL, STATUS_SURFACE.error)}>
          <AlertCircle aria-hidden className={cn('mt-0.5 size-4 shrink-0', STATUS_INK.error)} />
          <span>{message}</span>
        </p>
      )}
      {status === 'already-invited' && (
        <p role="status" className={cn('mt-3 flex items-start gap-2 border px-3 py-2 text-[length:var(--ds-text-sm)]', RADIUS_CONTROL, STATUS_SURFACE.healthy)}>
          <Check aria-hidden className={cn('mt-0.5 size-4 shrink-0', STATUS_INK.healthy)} />
          <span>
            {message || 'You already have access — follow the instructions in your invite email to set up your account.'}
          </span>
        </p>
      )}
      {status === 'account-exists' && (
        <div role="status" className={cn('mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border px-3 py-2 text-[length:var(--ds-text-sm)]', RADIUS_CONTROL, STATUS_SURFACE.active)}>
          <span>{message || 'You already have an account — sign in instead.'}</span>
          {onSignIn ? (
            <button type="button" onClick={onSignIn} className={cn('font-medium underline underline-offset-2 hover:no-underline', RADIUS_CONTROL, DENSITY.coarse, FOCUS_RING)}>
              Sign in
            </button>
          ) : (
            <a href="/" className={cn('font-medium underline underline-offset-2 hover:no-underline', RADIUS_CONTROL, DENSITY.coarse, FOCUS_RING)}>
              Sign in
            </a>
          )}
        </div>
      )}
    </form>
  );
};
