import React, { useState } from 'react';
import { Loader2, ArrowRight, Check, Mail } from 'lucide-react';
import { submitWaitlistEmail, WaitlistKind, type ProductInterest } from '../services/waitlist';
import { Turnstile, resetTurnstile } from './Turnstile';
import { turnstileEnabled } from '../services/clientConfig';

interface WaitlistFormProps {
  /** 'updates' = stay-in-the-loop, 'access' = request early access. */
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
  variant = 'light',
  placeholder = 'you@example.com',
  buttonLabel = 'Notify me',
  className = '',
  onJoined,
  onSignIn
}) => {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error' | 'account-exists'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState('');
  // Optional intent: product chips + free-form note — email alone still submits.
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
        className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 font-bold ${
          isDark
            ? 'border-brand-yellow bg-brand-yellow/10 text-brand-yellow'
            : 'border-green-500 bg-green-50 text-green-700'
        } ${className}`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-current">
          <Check size={16} />
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
            className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${
              isDark ? 'text-zinc-500' : 'text-slate-400'
            }`}
          />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status === 'error' || status === 'account-exists') setStatus('idle');
            }}
            placeholder={placeholder}
            aria-label="Email address"
            className={`w-full rounded-lg border-2 py-3 pl-9 pr-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue ${
              isDark
                ? 'border-zinc-700 bg-zinc-900 text-white placeholder:text-zinc-600'
                : 'border-black bg-white text-black placeholder:text-slate-400'
            }`}
          />
        </div>
        <button
          type="submit"
          disabled={status === 'loading'}
          className="flex shrink-0 items-center justify-center gap-2 rounded-lg border-2 border-black bg-brand-yellow px-5 py-3 font-comic text-sm font-bold uppercase tracking-wide text-black shadow-comic transition-all hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === 'loading' ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <>
              {buttonLabel} <ArrowRight size={16} />
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
          {PRODUCT_OPTIONS.map(({ id, label }) => {
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
                      ? 'border-brand-yellow bg-brand-yellow/10 text-brand-yellow'
                      : 'border-black bg-brand-yellow text-black'
                    : isDark
                      ? 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                      : 'border-slate-300 bg-white text-slate-500 hover:border-black hover:text-black'
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
        className={`mt-2 w-full resize-y rounded-lg border-2 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue ${
          isDark
            ? 'border-zinc-700 bg-zinc-900 text-white placeholder:text-zinc-600'
            : 'border-black bg-white text-black placeholder:text-slate-400'
        }`}
      />

      {turnstileEnabled() && (
        <div className="mt-3">
          <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action="waitlist" />
        </div>
      )}
      {status === 'error' && message && (
        <p className={`mt-2 text-xs font-bold ${isDark ? 'text-red-400' : 'text-red-600'}`}>{message}</p>
      )}
      {status === 'account-exists' && (
        <div
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
