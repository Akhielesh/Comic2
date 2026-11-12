import React, { useEffect, useId, useRef, useState } from 'react';
import { Loader2, ArrowRight, Check, Mail } from 'lucide-react';
import { submitWaitlistEmail, WaitlistKind, type ProductInterest } from '../services/waitlist';
import {
  clearNewsletterLanding,
  interestKnownUnavailable,
  readNewsletterLanding,
  registerInterest,
  rememberInterestUnavailable,
  type NewsletterLanding
} from '../services/interest';
import { STUDIO_INTERESTS, sanitizeStudioInterests, type StudioInterestId } from '../services/studioInterests';
import { Turnstile, resetTurnstile } from './Turnstile';
import { turnstileEnabled } from '../services/clientConfig';
import { PRIVACY_EMAIL, SUPPORT_EMAIL } from './legal/legalFacts';
import { legalPath } from './legal/legalRoutes';

interface WaitlistFormProps {
  /**
   * 'updates' (default) = register interest in studios (email updates, double opt-in);
   * 'access' = request early access while sign-ups are invite-only.
   */
  kind?: WaitlistKind;
  /** Free-form tag stored with the row so we know which surface it came from. */
  source?: string;
  /** 'light' for pale backgrounds, 'dark' for the black footer band. */
  variant?: 'light' | 'dark';
  placeholder?: string;
  buttonLabel?: string;
  className?: string;
  onJoined?: (email: string) => void;
  /** Shown when the email already has an account ('account-exists') — takes the user to sign-in. */
  onSignIn?: () => void;
  /** Register-interest only: studios ticked when the form first shows (e.g. on a studio's own page). */
  defaultStudios?: readonly StudioInterestId[];
}

// Shared by both forms (the current marketing-site look; the Atlas restyle comes later).
const SUBMIT_CLASS =
  'flex shrink-0 items-center justify-center gap-2 rounded-lg border-2 border-black bg-brand-yellow px-5 py-3 font-comic text-sm font-bold uppercase tracking-wide text-black shadow-comic transition-all hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60';
const emailInputClass = (isDark: boolean) =>
  `w-full rounded-lg border-2 py-3 pl-9 pr-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue ${
    isDark ? 'border-zinc-700 bg-zinc-900 text-white placeholder:text-zinc-600' : 'border-black bg-white text-black placeholder:text-slate-400'
  }`;

/** Success / confirmation panel colours, per variant. */
const okTone = (isDark: boolean) =>
  isDark ? 'border-brand-yellow bg-brand-yellow/10 text-brand-yellow' : 'border-green-600 bg-green-50 text-green-700';
/** Inline error text colour, per variant. */
const errorInk = (isDark: boolean) => (isDark ? 'text-red-400' : 'text-red-600');

/**
 * The Privacy Policy's section on these emails (its canonical path, which works logged out).
 * Opened in a new tab so a half-filled form survives.
 */
const PRIVACY_HREF = `${legalPath('privacy')}#emails`;

export const WaitlistForm: React.FC<WaitlistFormProps> = (props) =>
  props.kind === 'access' ? <AccessRequestForm {...props} /> : <RegisterInterestForm {...props} />;

// ── Register interest (kind 'updates') ──────────────────────────────────────────

// No "already subscribed" phase on purpose: the backend gives every valid request the same answer
// (anyone can type anyone's address), so 'pending' is the only success.
type InterestPhase = 'idle' | 'loading' | 'pending' | 'error' | 'unavailable';

const LANDING_COPY: Record<NewsletterLanding, { tone: 'ok' | 'warn'; text: string }> = {
  confirmed: {
    tone: 'ok',
    text: 'You’re confirmed. We’ll send occasional updates, focused on the studios you picked. Every update has an unsubscribe link.'
  },
  invalid: {
    tone: 'warn',
    text: 'That confirmation link has expired or was already used. Register again below and we’ll send a fresh one.'
  },
  unsubscribed: {
    tone: 'ok',
    text: 'You’re unsubscribed. We won’t send you any more updates, and the studio picks for your updates have been removed.'
  },
  'unsub-invalid': {
    tone: 'warn',
    text: `That unsubscribe link didn’t work. Use the link in our most recent email, or write to ${PRIVACY_EMAIL}.`
  }
};

const RegisterInterestForm: React.FC<WaitlistFormProps> = ({
  source,
  variant = 'light',
  placeholder = 'you@example.com',
  buttonLabel = 'Register interest',
  className = '',
  onJoined,
  defaultStudios
}) => {
  const uid = useId();
  const ids = {
    legend: `${uid}-studios`,
    email: `${uid}-email`,
    consent: `${uid}-consent`,
    status: `${uid}-status`
  };
  const isDark = variant === 'dark';

  const [studios, setStudios] = useState<StudioInterestId[]>(() => sanitizeStudioInterests(defaultStudios ?? []));
  const [email, setEmail] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [phase, setPhase] = useState<InterestPhase>(() => (interestKnownUnavailable() ? 'unavailable' : 'idle'));
  const [message, setMessage] = useState<string | null>(null);
  const [studiosError, setStudiosError] = useState(false);
  // Only an invalid address marks the email field invalid (not a network or service error).
  const [emailError, setEmailError] = useState(false);
  // Arrived from a confirm / unsubscribe email link (?newsletter=…): say what happened, here.
  const [landing, setLanding] = useState<NewsletterLanding | null>(() => readNewsletterLanding());
  const landingRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  // Set by a submit, so only an answer to the visitor's own action moves focus (never page load).
  const focusResult = useRef(false);
  // Set by "Use a different email": the button that had focus unmounts, so focus goes to the field.
  const focusEmail = useRef(false);

  useEffect(() => {
    if (!landing) return;
    clearNewsletterLanding();
    const el = landingRef.current;
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus({ preventScroll: true });
    // Only on arrival: the effect must not re-run when the banner is dismissed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a submit, move focus to the outcome so screen-reader and keyboard users land on it.
  useEffect(() => {
    if (!focusResult.current || phase === 'loading') return;
    focusResult.current = false;
    if (phase === 'pending' || phase === 'unavailable') resultRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (!focusEmail.current || phase !== 'idle') return;
    focusEmail.current = false;
    emailRef.current?.focus();
  }, [phase]);

  const toggle = (id: StudioInterestId) => {
    setStudiosError(false);
    setStudios((prev) => sanitizeStudioInterests(prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase === 'loading') return;
    if (studios.length === 0) {
      setStudiosError(true);
      setEmailError(false);
      setPhase('error');
      setMessage('Pick at least one studio.');
      return;
    }
    if (turnstileEnabled() && !captchaToken) {
      setEmailError(false);
      setPhase('error');
      setMessage('Please complete the verification challenge.');
      return;
    }
    setPhase('loading');
    setMessage(null);
    setEmailError(false);
    focusResult.current = true;

    const result = await registerInterest({ email, studios, source, captchaToken: captchaToken || undefined });
    // Turnstile tokens are single-use: always start the next attempt with a fresh one.
    setCaptchaToken('');
    resetTurnstile();

    if (result.ok) {
      setPhase('pending');
      setMessage(result.message);
      onJoined?.(email.trim().toLowerCase());
      return;
    }
    if (result.code === 'interest_unavailable') {
      rememberInterestUnavailable();
      setPhase('unavailable');
      setMessage(result.message);
      return;
    }
    if (result.code === 'invalid_studios') setStudiosError(true);
    setEmailError(result.code === 'invalid_email');
    setPhase('error');
    setMessage(result.message);
  };

  const startOver = () => {
    focusEmail.current = true;
    setPhase('idle');
    setMessage(null);
    setEmailError(false);
    setEmail('');
  };

  const muted = isDark ? 'text-zinc-400' : 'text-slate-600';
  const faint = isDark ? 'text-zinc-500' : 'text-slate-400';
  const okPanel = okTone(isDark);
  const warnPanel = isDark ? 'border-zinc-600 bg-zinc-900 text-zinc-200' : 'border-slate-400 bg-slate-50 text-slate-800';
  const linkClass = 'underline underline-offset-2 hover:no-underline';

  const landingBanner = landing ? (
    <div
      ref={landingRef}
      tabIndex={-1}
      role="status"
      className={`mb-3 flex items-start gap-2 rounded-xl border-2 px-4 py-3 text-sm font-bold focus:outline-none ${
        LANDING_COPY[landing].tone === 'ok' ? okPanel : warnPanel
      }`}
    >
      {LANDING_COPY[landing].tone === 'ok' && <Check size={16} className="mt-0.5 shrink-0" aria-hidden />}
      <span className="flex-1">{LANDING_COPY[landing].text}</span>
      <button type="button" onClick={() => setLanding(null)} className={`shrink-0 text-xs ${linkClass}`}>
        Dismiss
      </button>
    </div>
  ) : null;

  if (phase === 'unavailable') {
    return (
      <div className={`w-full ${className}`}>
        {landingBanner}
        <div ref={resultRef} tabIndex={-1} role="status" className={`rounded-xl border-2 px-4 py-3 text-sm font-bold focus:outline-none ${warnPanel}`}>
          {/* Our own copy (not the server message, which spells out the address as text too). */}
          Registering interest isn’t available right now. Email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>
            {SUPPORT_EMAIL}
          </a>{' '}
          and we’ll add you by hand.
        </div>
      </div>
    );
  }

  if (phase === 'pending') {
    return (
      <div className={`w-full ${className}`}>
        {landingBanner}
        <div
          ref={resultRef}
          tabIndex={-1}
          role="status"
          className={`flex items-start gap-3 rounded-xl border-2 px-4 py-3 font-bold focus:outline-none ${okPanel}`}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-current">
            <Mail size={15} aria-hidden />
          </span>
          <span className="flex-1 text-sm">
            <span className="block">Check your inbox</span>
            <span className="mt-0.5 block font-medium">{message}</span>
            <button type="button" onClick={startOver} className={`mt-1 text-xs ${linkClass}`}>
              Wrong address? Use a different email
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full ${className}`}>
      {landingBanner}
      <form onSubmit={handleSubmit} aria-describedby={ids.consent} className="w-full text-left">
        <fieldset aria-describedby={studiosError ? ids.status : undefined}>
          <legend id={ids.legend} className={`text-xs font-bold ${muted}`}>
            Which studios do you want to hear about?
          </legend>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {STUDIO_INTERESTS.map(({ id, label, blurb }) => {
              const checked = studios.includes(id);
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border-2 px-3 py-2 text-left transition-colors focus-within:ring-2 focus-within:ring-slate-500 ${
                    checked
                      ? isDark
                        ? 'border-zinc-300 bg-zinc-800 text-white'
                        : 'border-slate-900 bg-slate-50 text-slate-900'
                      : isDark
                        ? 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
                        : 'border-slate-300 bg-white text-slate-700 hover:border-slate-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    name="studios"
                    value={id}
                    checked={checked}
                    onChange={() => toggle(id)}
                    aria-invalid={studiosError || undefined}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-slate-900"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold">{label}</span>
                    <span className={`block text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>{blurb}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <label htmlFor={ids.email} className="sr-only">
              Email address
            </label>
            <Mail size={16} aria-hidden className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${faint}`} />
            <input
              ref={emailRef}
              id={ids.email}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={320}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(false);
                if (phase === 'error') setPhase('idle');
              }}
              placeholder={placeholder}
              aria-invalid={(phase === 'error' && emailError) || undefined}
              aria-describedby={phase === 'error' ? ids.status : ids.consent}
              className={emailInputClass(isDark)}
            />
          </div>
          <button
            type="submit"
            disabled={phase === 'loading'}
            aria-busy={phase === 'loading' || undefined}
            className={SUBMIT_CLASS}
          >
            {phase === 'loading' ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden />
                <span className="sr-only">Sending…</span>
              </>
            ) : (
              <>
                {buttonLabel} <ArrowRight size={16} aria-hidden />
              </>
            )}
          </button>
        </div>

        <p id={ids.consent} className={`mt-2 text-xs leading-relaxed ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
          We’ll email you once to confirm your address. Once you confirm, we’ll send occasional DreamStream updates,
          focused on the studios you picked. Every update has an unsubscribe link, and we never sell your
          address. See our{' '}
          <a href={PRIVACY_HREF} target="_blank" rel="noopener noreferrer" className={linkClass}>
            Privacy Policy<span className="sr-only"> (opens in a new tab)</span>
          </a>
          .
        </p>

        {turnstileEnabled() && (
          <div className="mt-3">
            <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action="interest" />
          </div>
        )}

        <p id={ids.status} role="alert" className={`mt-2 text-xs font-bold ${errorInk(isDark)} ${phase === 'error' && message ? '' : 'sr-only'}`}>
          {phase === 'error' ? message : ''}
        </p>
      </form>
    </div>
  );
};

// ── Request access (kind 'access') ──────────────────────────────────────────────

const AccessRequestForm: React.FC<WaitlistFormProps> = ({
  kind = 'access',
  source,
  variant = 'light',
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
  // Optional intent: studio chips + free-form note — email alone still submits.
  const [interests, setInterests] = useState<ProductInterest[]>([]);
  const [feedback, setFeedback] = useState('');

  const isDark = variant === 'dark';

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
      <div
        role="status"
        className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 font-bold ${okTone(isDark)} ${className}`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-current">
          <Check size={16} aria-hidden />
        </span>
        <span className="text-sm">{message}</span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={`w-full ${className}`}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Mail
            size={16}
            aria-hidden
            className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${
              isDark ? 'text-zinc-500' : 'text-slate-400'
            }`}
          />
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status === 'error' || status === 'account-exists' || status === 'already-invited') setStatus('idle');
            }}
            placeholder={placeholder}
            aria-label="Email address"
            className={emailInputClass(isDark)}
          />
        </div>
        <button
          type="submit"
          disabled={status === 'loading'}
          className={SUBMIT_CLASS}
        >
          {status === 'loading' ? (
            <Loader2 size={16} className="animate-spin" aria-label="Sending" />
          ) : (
            <>
              {buttonLabel} <ArrowRight size={16} aria-hidden />
            </>
          )}
        </button>
      </div>

      {/* Optional intent — chips + note. Email alone still submits. */}
      <div className="mt-3">
        <p className={`text-xs font-bold ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
          What do you want first access to?{' '}
          <span className={`font-medium ${isDark ? 'text-zinc-600' : 'text-slate-400'}`}>(optional)</span>
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {STUDIO_INTERESTS.map(({ id, label }) => {
            const selected = interests.includes(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  setInterests((prev) => (selected ? prev.filter((p) => p !== id) : [...prev, id]))
                }
                className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition-colors ${
                  selected
                    ? isDark
                      ? 'border-zinc-300 bg-zinc-800 text-white'
                      : 'border-slate-900 bg-slate-100 text-slate-900'
                    : isDark
                      ? 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                      : 'border-slate-300 bg-white text-slate-500 hover:border-slate-500 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="Anything you'd want to see? (optional)"
        aria-label="Anything you'd want to see? (optional)"
        className={`mt-2 w-full resize-y rounded-lg border-2 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 ${
          isDark
            ? 'border-zinc-700 bg-zinc-900 text-white placeholder:text-zinc-600'
            : 'border-slate-900 bg-white text-black placeholder:text-slate-400'
        }`}
      />
      <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
        We’ll use your email to let you know about access, and we never sell it. See our{' '}
        <a href={PRIVACY_HREF} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:no-underline">
          Privacy Policy<span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </p>

      {turnstileEnabled() && (
        <div className="mt-3">
          <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action="waitlist" />
        </div>
      )}
      {status === 'error' && message && (
        <p role="alert" className={`mt-2 text-xs font-bold ${errorInk(isDark)}`}>{message}</p>
      )}
      {status === 'already-invited' && (
        <div
          role="status"
          className={`mt-2 rounded-lg border-2 px-3 py-2 text-xs font-bold ${okTone(isDark)}`}
        >
          {message || 'You already have access — follow the instructions in your invite email to set up your account.'}
        </div>
      )}
      {status === 'account-exists' && (
        <div
          role="status"
          className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg border-2 px-3 py-2 text-xs font-bold ${
            isDark ? 'border-brand-yellow bg-brand-yellow/10 text-brand-yellow' : 'border-brand-blue bg-brand-blue/5 text-brand-blue'
          }`}
        >
          <span>{message || 'You already have an account — sign in instead.'}</span>
          {onSignIn ? (
            <button type="button" onClick={onSignIn} className="underline hover:no-underline">
              Sign in
            </button>
          ) : (
            <a href="/" className="underline hover:no-underline">
              Sign in
            </a>
          )}
        </div>
      )}
    </form>
  );
};
