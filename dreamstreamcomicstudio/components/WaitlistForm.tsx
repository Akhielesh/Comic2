import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Plus } from 'lucide-react';
import { cn } from '../lib/utils';
import { RADIUS_CONTROL, RADIUS_PILL, STATUS_INK, STATUS_SURFACE } from './chat/studioDesign';
import { Button } from './ds/Button';
import { Checkbox } from './ds/Checkbox';
import { FIELD_LABEL, Field } from './ds/Field';
import { FILTER_CHIP, FILTER_CHIP_ON } from './ds/FilterChips';
import { Input, Textarea } from './ds/Input';
import { Select } from './ds/Select';
import {
  INTEREST_COUNT_FROM,
  INTEREST_HEARD,
  INTEREST_HEARD_QUESTION,
  INTEREST_LIMITS,
  INTEREST_MAKES,
  INTEREST_MAKES_QUESTION,
  INTEREST_OTHER_LABEL,
  INTEREST_UPDATES,
  checkWaitlistEmail,
  submitWaitlistEmail,
  type InterestHeard,
  type InterestMake,
  type WaitlistKind
} from '../services/waitlist';
import { UPDATES_CARD } from '../shared/interest';
import { Turnstile, resetTurnstile } from './Turnstile';
import { turnstileEnabled } from '../services/clientConfig';

interface WaitlistFormProps {
  /** 'updates' = the main site's list (the email alone), 'access' = register interest (with the optional questions). */
  kind?: WaitlistKind;
  /** Free-form tag stored with the row so we know which surface it came from. */
  source?: string;
  /** Kept for its callers: the form reads the page tokens, so it suits light and dark pages alike. */
  variant?: 'light' | 'dark';
  placeholder?: string;
  buttonLabel?: string;
  className?: string;
  onJoined?: (email: string) => void;
  /** Kept for its callers. The answer never depends on the address, so the form has no sign-in branch of its own. */
  onSignIn?: () => void;
}

const formatCount = (n: number) => n.toLocaleString('en');

const OPTIONAL = <span className="font-normal text-[var(--ds-muted)]">(optional)</span>;

/** A quick pick: the kit's filter chip shape (32 px, 44 px under a coarse pointer); the native box inside is hidden. */
const PICK = cn(
  FILTER_CHIP,
  'gap-1.5 select-none transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)]',
  'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--ds-focus)]'
);
/** Not picked: ink words on the page, a control border, the hover tint. */
const PICK_OFF = 'border-[var(--ds-control-border)] bg-[var(--ds-canvas)] text-[var(--ds-ink)] hover:border-[var(--ds-control-border-hover)] hover:bg-[var(--ds-hover)]';

/**
 * Quick picks under one question: native checkboxes (a fieldset, so a screen reader hears the question and each
 * pick's state) drawn as chips that wrap. A pick shows its state in shape as well as fill: a plus while it is off,
 * a tick and the ink chip once it is on.
 */
function QuickPicks<T extends string>({
  legend,
  options,
  picked,
  onToggle,
  name
}: {
  legend: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  picked: readonly T[];
  onToggle: (id: T, on: boolean) => void;
  name: string;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
      <legend className={cn(FIELD_LABEL, 'mb-2 p-0')}>
        {legend} {OPTIONAL}
      </legend>
      <div className="flex min-w-0 flex-wrap gap-2">
        {options.map(({ id, label }) => {
          const on = picked.includes(id);
          return (
            <label key={id} data-state={on ? 'on' : 'off'} className={cn(PICK, on ? FILTER_CHIP_ON : PICK_OFF)}>
              <input type="checkbox" name={name} value={id} checked={on} onChange={(e) => onToggle(id, e.target.checked)} className="sr-only" />
              {on ? (
                <Check aria-hidden data-mark="on" strokeWidth={2.5} className="size-3.5 shrink-0" />
              ) : (
                <Plus aria-hidden data-mark="add" strokeWidth={2.5} className="size-3.5 shrink-0 text-[var(--ds-muted)]" />
              )}
              <span>{label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Register interest (kind 'access'): the email, then a few optional questions a visitor can answer without knowing the
 * product (first name; what they would like to make, as quick picks with "Anything else?"; how they heard about us),
 * one unticked box to be kept updated, and one plain line that sign-up is not open yet. Kind 'updates' is the email
 * alone. Built from the ds primitives on the page tokens, so it reads in light and dark; no comic chrome. The
 * thank-you promises no email (a ticked box adds that nothing is sent yet). A bad address is shown at its field
 * (noValidate: the form checks it, not the browser's bubbles); other errors are one alert. On an error everything
 * typed stays, so trying again is one press.
 */
export const WaitlistForm: React.FC<WaitlistFormProps> = ({
  kind = 'updates',
  source,
  placeholder = 'you@example.com',
  buttonLabel,
  className = '',
  onJoined
}) => {
  const askQuestions = kind === 'access';
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [makes, setMakes] = useState<InterestMake[]>([]);
  const [comment, setComment] = useState('');
  const [heardFrom, setHeardFrom] = useState<InterestHeard | ''>('');
  const [keepUpdated, setKeepUpdated] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState('');
  /** A problem with the address itself, shown at the field (the alert under the form is for everything else). */
  const [emailError, setEmailError] = useState<string | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Move focus to the thank-you so keyboard and screen-reader users land on the outcome.
  useEffect(() => {
    if (status === 'success') doneRef.current?.focus();
  }, [status]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'loading') return;
    // The address first, at its field: marked invalid, described, and focused, so the problem is where the person is.
    const problem = checkWaitlistEmail(email);
    if (problem) {
      setEmailError(problem);
      setStatus('idle');
      setMessage(null);
      emailRef.current?.focus();
      return;
    }
    if (turnstileEnabled() && !captchaToken) {
      setStatus('error');
      setMessage('Please complete the verification check first.');
      return;
    }
    setStatus('loading');
    setMessage(null);

    const answers = askQuestions
      ? {
          ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
          ...(makes.length ? { makes } : {}),
          ...(heardFrom ? { heardFrom } : {}),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          keepUpdated
        }
      : {};
    const result = await submitWaitlistEmail(email, kind, source ? { source } : {}, captchaToken || undefined, answers);
    if (result.ok) {
      setStatus('success');
      setMessage(result.message);
      onJoined?.(email.trim().toLowerCase());
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
        ref={doneRef}
        tabIndex={-1}
        role="status"
        className={cn('flex items-start gap-3 border px-4 py-3 outline-none', RADIUS_CONTROL, STATUS_SURFACE.healthy, className)}
      >
        <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center border border-current', RADIUS_PILL, STATUS_INK.healthy)}>
          <Check className="size-4" />
        </span>
        <span className="min-w-0 self-center text-[length:var(--ds-text-base)] font-medium [overflow-wrap:anywhere]">{message}</span>
      </div>
    );
  }

  const clearError = () => {
    if (status === 'error') setStatus('idle');
  };
  const toggleMake = (id: InterestMake, on: boolean) =>
    setMakes((prev) => (on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((v) => v !== id)));
  const label = buttonLabel ?? (askQuestions ? 'Register interest' : UPDATES_CARD.button);

  const emailInput = (
    <Input
      ref={emailRef}
      type="email"
      value={email}
      onChange={(e) => {
        setEmail(e.target.value);
        setEmailError(null);
        clearError();
      }}
      placeholder={placeholder}
      autoComplete="email"
      maxLength={320}
    />
  );
  const submit = (
    <Button type="submit" loading={status === 'loading'} className="w-full shrink-0 sm:w-auto">
      {label} <ArrowRight aria-hidden />
    </Button>
  );
  const check = turnstileEnabled() ? (
    <div>
      <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action="waitlist" />
    </div>
  ) : null;
  // Running words in the alert inherit the surrounding ink, so it also reads inside a page's own fixed card.
  const alert =
    status === 'error' && message ? (
      <p role="alert" className={cn('m-0 flex items-start gap-2 border px-3 py-2 text-[length:var(--ds-text-sm)]', RADIUS_CONTROL, STATUS_SURFACE.error)}>
        <AlertCircle aria-hidden className={cn('mt-0.5 size-4 shrink-0', STATUS_INK.error)} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{message}</span>
      </p>
    ) : null;

  if (!askQuestions) {
    // The list (kind 'updates'): one field and the button, side by side from sm. The label is for assistive tech only, as
    // before, so the form also suits a page's own fixed card.
    return (
      <form noValidate onSubmit={handleSubmit} className={cn('flex w-full min-w-0 flex-col gap-3', className)}>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
          <Field label="Email address" hideLabel required error={emailError ?? undefined} className="flex-1">
            {emailInput}
          </Field>
          {submit}
        </div>
        {check}
        {alert}
      </form>
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit} className={cn('flex w-full min-w-0 flex-col gap-5', className)}>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field label="Email address" required error={emailError ?? undefined}>
          {emailInput}
        </Field>
        <Field label={<>First name {OPTIONAL}</>}>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" maxLength={INTEREST_LIMITS.firstNameMax} />
        </Field>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <QuickPicks legend={INTEREST_MAKES_QUESTION} name="makes" options={INTEREST_MAKES} picked={makes} onToggle={toggleMake} />
        <Field
          label={<>{INTEREST_OTHER_LABEL} {OPTIONAL}</>}
          description={
            comment.length >= INTEREST_COUNT_FROM
              ? `${formatCount(comment.length)} of ${formatCount(INTEREST_LIMITS.commentMax)} characters`
              : `Up to ${formatCount(INTEREST_LIMITS.commentMax)} characters.`
          }
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={INTEREST_LIMITS.commentMax}
            rows={2}
            placeholder="An idea, a format, a question"
            className="resize-y"
          />
        </Field>
      </div>

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field label={<>{INTEREST_HEARD_QUESTION} {OPTIONAL}</>}>
          <Select
            value={heardFrom}
            onChange={(e) => setHeardFrom(e.target.value as InterestHeard | '')}
            placeholder="Choose one"
            options={INTEREST_HEARD.map((h) => ({ value: h.id, label: h.label }))}
          />
        </Field>
      </div>

      <Checkbox name="keepUpdated" label={INTEREST_UPDATES.label} description={INTEREST_UPDATES.hint} checked={keepUpdated} onCheckedChange={setKeepUpdated} />

      <p className="m-0 text-pretty text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]">
        Sign-up is not open yet. Your answers shape what we build next.
      </p>
      {check}
      {alert}
      <div>{submit}</div>
    </form>
  );
};
