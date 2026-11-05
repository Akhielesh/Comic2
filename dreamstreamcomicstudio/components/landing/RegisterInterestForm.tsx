/**
 * "Register interest" on the Atlas primitives (components/ds): the studio picks, an email, the consent text,
 * and every outcome the backend can give (POST /api/interest through services/interest.ts, the studios from
 * services/studioInterests.ts). Its behaviour is WaitlistForm's register-interest form, on purpose, so the
 * two can merge into this one later:
 *   - double opt-in: the only success is "check your inbox" (the backend answers every valid request the
 *     same way, so the page never says whether an address was already registered);
 *   - nothing is sent without a studio, or without the bot check when it is switched on;
 *   - a 503 interest_unavailable hides the form for the session and offers the address to write to;
 *   - arriving from a confirm or unsubscribe link (?newsletter=…) says what happened, here, once;
 *   - focus follows the visitor's own action only (never page load, except that arrival message).
 * Loaded lazily by RegisterInterestSection (this file pulls in the primitives and the bot check).
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Mail } from 'lucide-react';
import { Button } from '../ds/Button';
import { CHECKBOX_BOX, CHECKBOX_CHECK, CHECKBOX_CONTROL, CHECKBOX_INPUT } from '../ds/Checkbox';
import { Field } from '../ds/Field';
import { Input } from '../ds/Input';
import { FOCUS_RING, TONE_SURFACE, TONE_TEXT } from '../chat/studioDesign';
import {
  clearNewsletterLanding,
  interestKnownUnavailable,
  readNewsletterLanding,
  registerInterest,
  rememberInterestUnavailable,
  type NewsletterLanding
} from '../../services/interest';
import { STUDIO_INTERESTS, sanitizeStudioInterests, type StudioInterestId } from '../../services/studioInterests';
import { mainAppUrl } from '../../services/liveLink';
import { turnstileEnabled } from '../../services/clientConfig';
import { Turnstile, resetTurnstile } from '../Turnstile';
import { CONTACT_EMAIL } from './content';

export interface RegisterInterestFormProps {
  /** Which surface the form sits on (stored with the registration). */
  source?: string;
  /** Studios ticked when the form first shows. */
  defaultStudios?: readonly StudioInterestId[];
  onJoined?: (email: string) => void;
}

type Phase = 'idle' | 'loading' | 'pending' | 'error' | 'unavailable';

const LANDING: Record<NewsletterLanding, { ok: boolean; text: string }> = {
  confirmed: {
    ok: true,
    text: 'You’re confirmed. We’ll send occasional updates, focused on the studios you picked. Every email has a one-click unsubscribe.'
  },
  invalid: {
    ok: false,
    text: 'That confirmation link has expired or was already used. Register again below and we’ll send a fresh one.'
  },
  unsubscribed: {
    ok: true,
    text: 'You’re unsubscribed. We won’t send you any more updates, and your studio picks have been removed.'
  },
  'unsub-invalid': {
    ok: false,
    text: `That unsubscribe link didn’t work. Use the link in our most recent email, or write to ${CONTACT_EMAIL}.`
  }
};

/** The privacy policy: a view that works signed out, in a new tab so a half-filled form survives. */
const PRIVACY_HREF = '/?view=privacy';

const LINK = `font-medium text-ds-ink underline underline-offset-2 hover:no-underline ${FOCUS_RING}`;
const PANEL = 'flex items-start gap-3 rounded-[var(--ds-radius-panel)] border p-4 text-sm leading-6 text-ds-ink focus:outline-none';
/** A studio pick: the whole card is the checkbox's label (the native input inside, drawn with the ds Checkbox recipe). */
const STUDIO_CARD =
  'flex cursor-pointer items-start gap-3 rounded-[var(--ds-radius-panel)] border border-ds-hairline bg-ds-canvas px-3.5 py-3 transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] hover:border-ds-ink/25 has-[:checked]:border-ds-ink has-[:checked]:bg-ds-surface medium:[&:last-child:nth-child(odd)]:col-span-2';

export function RegisterInterestForm({ source = 'home-register-interest', defaultStudios, onJoined }: RegisterInterestFormProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const ids = { email: `${uid}-email`, consent: `${uid}-consent`, status: `${uid}-status`, legend: `${uid}-legend` };

  const [studios, setStudios] = useState<StudioInterestId[]>(() => sanitizeStudioInterests(defaultStudios ?? []));
  const [email, setEmail] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [phase, setPhase] = useState<Phase>(() => (interestKnownUnavailable() ? 'unavailable' : 'idle'));
  const [message, setMessage] = useState<string | null>(null);
  const [studiosError, setStudiosError] = useState(false);
  const [emailError, setEmailError] = useState(false);
  const [landing, setLanding] = useState<NewsletterLanding | null>(() => readNewsletterLanding());

  const landingRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const focusResult = useRef(false);
  const focusEmail = useRef(false);

  // Arrived from a confirm / unsubscribe link: say what happened, here, once (and drop the parameter).
  useEffect(() => {
    if (!landing) return;
    clearNewsletterLanding();
    const el = landingRef.current;
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus({ preventScroll: true });
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const toggle = (id: StudioInterestId, on: boolean) => {
    setStudiosError(false);
    if (phase === 'error') setPhase('idle');
    setStudios((prev) => sanitizeStudioInterests(on ? [...prev, id] : prev.filter((s) => s !== id)));
  };

  const fail = (text: string) => {
    setPhase('error');
    setMessage(text);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (phase === 'loading') return;
    if (studios.length === 0) {
      setStudiosError(true);
      setEmailError(false);
      fail('Pick at least one studio.');
      return;
    }
    if (turnstileEnabled() && !captchaToken) {
      setEmailError(false);
      fail('Please complete the verification challenge.');
      return;
    }
    setPhase('loading');
    setMessage(null);
    setEmailError(false);
    focusResult.current = true;

    const result = await registerInterest({ email, studios, source, captchaToken: captchaToken || undefined });
    // Bot-check tokens are single use: the next attempt starts with a fresh one.
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
    fail(result.message);
  };

  const startOver = () => {
    focusEmail.current = true;
    setPhase('idle');
    setMessage(null);
    setEmailError(false);
    setEmail('');
  };

  const landingBanner = landing ? (
    <div
      ref={landingRef}
      tabIndex={-1}
      role="status"
      className={`mb-5 ${PANEL} ${LANDING[landing].ok ? TONE_SURFACE.success : TONE_SURFACE.warning}`}
    >
      {LANDING[landing].ok ? (
        <Check aria-hidden="true" className={`mt-1 size-4 shrink-0 ${TONE_TEXT.success}`} />
      ) : (
        <AlertCircle aria-hidden="true" className={`mt-1 size-4 shrink-0 ${TONE_TEXT.warning}`} />
      )}
      <span className="min-w-0 flex-1">
        {LANDING[landing].text}
        <button type="button" onClick={() => setLanding(null)} className={`mt-1 block text-xs ${LINK}`}>
          Dismiss
        </button>
      </span>
    </div>
  ) : null;

  if (phase === 'unavailable') {
    return (
      <div>
        {landingBanner}
        <div ref={resultRef} tabIndex={-1} role="status" className={`${PANEL} ${TONE_SURFACE.neutral}`}>
          <Mail aria-hidden="true" className="mt-1 size-4 shrink-0 text-ds-muted" />
          <span className="min-w-0">
            Registering interest isn’t available right now. Email{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className={LINK}>
              {CONTACT_EMAIL}
            </a>{' '}
            and we’ll add you by hand.
          </span>
        </div>
      </div>
    );
  }

  if (phase === 'pending') {
    return (
      <div>
        {landingBanner}
        <div ref={resultRef} tabIndex={-1} role="status" className="ds-scale-in flex items-start gap-3 text-sm leading-6 text-ds-ink focus:outline-none">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ds-accent-fill text-ds-on-accent">
            <Mail aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold">Check your inbox</span>
            <span className="mt-0.5 block text-ds-muted">{message}</span>
            <button type="button" onClick={startOver} className={`mt-2 text-sm ${LINK}`}>
              Wrong address? Use a different email
            </button>
          </span>
        </div>
      </div>
    );
  }

  const describedByEmail = phase === 'error' && message ? `${ids.status} ${ids.consent}` : ids.consent;

  return (
    <div>
      {landingBanner}
      <form onSubmit={handleSubmit} aria-describedby={ids.consent} className="flex flex-col gap-5">
        <fieldset aria-describedby={studiosError ? ids.status : undefined} className="min-w-0">
          <legend id={ids.legend} className="text-sm font-medium text-ds-ink">
            Which studios do you want to hear about?
          </legend>
          <div className="mt-3 grid gap-2 medium:grid-cols-2">
            {STUDIO_INTERESTS.map(({ id, label, blurb }) => (
              <label key={id} className={STUDIO_CARD}>
                <span className={`${CHECKBOX_CONTROL} mt-0.5`}>
                  <input
                    type="checkbox"
                    name="studios"
                    value={id}
                    checked={studios.includes(id)}
                    onChange={(e) => toggle(id, e.target.checked)}
                    aria-labelledby={`${uid}-${id}`}
                    aria-describedby={`${uid}-${id}-blurb`}
                    aria-invalid={studiosError || undefined}
                    className={CHECKBOX_INPUT}
                  />
                  <span aria-hidden="true" className={CHECKBOX_BOX} />
                  <Check aria-hidden="true" strokeWidth={3} className={CHECKBOX_CHECK} />
                </span>
                <span className="min-w-0">
                  <span id={`${uid}-${id}`} className="block text-sm font-medium leading-5 text-ds-ink">
                    {label}
                  </span>
                  <span id={`${uid}-${id}-blurb`} className="mt-0.5 block text-[13px] leading-5 text-ds-muted">
                    {blurb}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Email address">
          <Input
            ref={emailRef}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            maxLength={320}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(false);
              if (phase === 'error') setPhase('idle');
            }}
            aria-invalid={(phase === 'error' && emailError) || undefined}
            aria-describedby={describedByEmail}
            enterKeyHint="send"
          />
        </Field>

        {turnstileEnabled() ? (
          <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action="interest" />
        ) : null}

        <div className="flex flex-col gap-3">
          <Button type="submit" size="lg" loading={phase === 'loading'} className="h-11 w-full rounded-full text-[15px] medium:w-auto medium:self-start medium:px-7">
            {phase === 'loading' ? 'Sending…' : 'Register interest'}
            {phase === 'loading' ? null : <ArrowRight aria-hidden="true" />}
          </Button>
          <p id={ids.status} role="alert" className={phase === 'error' && message ? `flex items-start gap-1.5 text-sm font-medium ${TONE_TEXT.danger}` : 'sr-only'}>
            {phase === 'error' && message ? (
              <>
                <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">{message}</span>
              </>
            ) : null}
          </p>
        </div>

        <p id={ids.consent} className="text-[13px] leading-5 text-ds-muted">
          We’ll email you once to confirm your address. Once you confirm, we’ll send occasional DreamStream updates,
          focused on the studios you picked. Every email has a one-click unsubscribe, and we never sell your address.
          See our{' '}
          <a href={mainAppUrl(PRIVACY_HREF)} target="_blank" rel="noopener noreferrer" className={LINK}>
            Privacy Policy<span className="sr-only"> (opens in a new tab)</span>
          </a>
          .
        </p>
      </form>
    </div>
  );
}
