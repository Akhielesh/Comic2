import React, { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, LogIn } from 'lucide-react';

type AuthCallbackStatus = 'confirm' | 'verifying' | 'success' | 'error';

interface AuthCallbackPageProps {
  status: AuthCallbackStatus;
  message?: string;
  flowType?: 'magiclink' | 'recovery' | 'signup' | 'unknown';
  /** Confirm step: the account the link signs in to, when it is known before signing in. */
  email?: string | null;
  /** Confirm step: who is signed in on this browser right now, if anyone. */
  currentEmail?: string | null;
  /**
   * Confirm step, nobody signed in here (`currentEmail` null): another account's data is still
   * on this browser (a "Remember me"-off session that ended with the tab, say), and continuing
   * removes it here. Without this, a fresh tab could not warn about it at all.
   */
  otherAccountOnDevice?: boolean;
  onContinue: () => void;
  /** Confirm step: "Continue" — finish signing in with the link. */
  onConfirm?: () => void;
  /** Confirm step: "Not now" — drop the link, change nothing. */
  onDecline?: () => void;
}

const primaryBtn =
  'inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-[var(--ds-accent)] px-5 text-sm font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-2';
const secondaryBtn =
  'inline-flex min-h-[44px] w-full items-center justify-center rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-5 text-sm font-semibold text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-2';

export const AuthCallbackPage: React.FC<AuthCallbackPageProps> = ({
  status,
  message,
  flowType = 'unknown',
  email = null,
  currentEmail = null,
  otherAccountOnDevice = false,
  onContinue,
  onConfirm,
  onDecline
}) => {
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Each new status moves focus to its heading, so keyboard and screen-reader users land on
  // the question (or the result) instead of somewhere behind it.
  useEffect(() => {
    titleRef.current?.focus();
  }, [status]);

  const title =
    status === 'confirm'
      ? 'Finish signing in?'
      : status === 'verifying'
        ? 'Verifying Link'
        : status === 'success'
          ? flowType === 'recovery'
            ? 'Recovery Verified'
            : 'Authentication Complete'
          : 'Link Verification Failed';

  const description =
    message ||
    (status === 'verifying'
      ? 'Please wait while we verify your secure sign-in link.'
      : status === 'success'
        ? 'Your session is ready.'
        : 'This link is invalid or expired. Request a new one and try again.');

  // Someone is signed in here and the link may be for another account. Say "instead" only when
  // the link's account is KNOWN to differ: a token_hash link's account can't be known before it
  // is used, and claiming a switch for the person's own reset link would scare them off it.
  const knownOther = !!currentEmail && !!email && email.toLowerCase() !== currentEmail.toLowerCase();
  const maybeOther = !!currentEmail && !email;
  // Nobody is signed in on this tab, but the device still holds an account's data (whose email
  // this tab can't know): continuing hands the device to the link's account and removes it here.
  const otherData = !currentEmail && otherAccountOnDevice;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)] px-4 py-8 text-[var(--ds-ink)]">
      <section
        className="w-full max-w-md rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-6 text-center shadow-sm sm:p-8"
        aria-labelledby="auth-callback-title"
      >
        <div className="mb-4 flex justify-center" aria-hidden="true">
          {status === 'confirm' && <LogIn className="h-9 w-9 text-[var(--ds-accent)]" />}
          {status === 'verifying' && <Loader2 className="h-9 w-9 animate-spin text-[var(--ds-muted)]" />}
          {status === 'success' && <CheckCircle2 className="h-9 w-9 text-green-600" />}
          {status === 'error' && <AlertTriangle className="h-9 w-9 text-red-600" />}
        </div>

        <h1
          id="auth-callback-title"
          ref={titleRef}
          tabIndex={-1}
          className="mb-2 text-2xl font-semibold tracking-tight text-[var(--ds-ink)] focus:outline-none"
        >
          {title}
        </h1>

        {/* One region, always mounted: its text changes with the status and is announced. */}
        <p className="text-sm leading-relaxed text-[var(--ds-muted)]" aria-live="polite">
          {status === 'confirm' ? (
            <>
              This link signs this browser in to DreamStream
              {email ? (
                <>
                  {' '}as <span className="break-all font-semibold text-[var(--ds-ink)]">{email}</span>
                </>
              ) : null}
              . Continue only if you asked for it.
            </>
          ) : (
            description
          )}
        </p>

        {status === 'confirm' && (knownOther || maybeOther || otherData || flowType === 'signup') && (
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-[var(--ds-muted)]">
            {otherData && (
              <p>
                Another account’s data is on this browser. Continuing removes it here (that account gets it back from its
                cloud copy when it signs in).
              </p>
            )}
            {knownOther && (
              <p>
                You’re signed in as <span className="break-all font-semibold text-[var(--ds-ink)]">{currentEmail}</span>. Continuing
                signs you in with this link instead.
              </p>
            )}
            {maybeOther && (
              <p>
                You’re signed in as <span className="break-all font-semibold text-[var(--ds-ink)]">{currentEmail}</span>. If this link
                is for a different account, continuing switches this browser to it.
              </p>
            )}
            {flowType === 'signup' && <p>Continuing also confirms the account’s email.</p>}
          </div>
        )}

        {status === 'confirm' && (
          <div className="mt-6 flex flex-col gap-3">
            <button type="button" className={primaryBtn} onClick={onConfirm}>
              Continue
            </button>
            <button type="button" className={secondaryBtn} onClick={onDecline}>
              Not now
            </button>
          </div>
        )}

        {(status === 'success' || status === 'error') && (
          <div className="mt-6">
            <button type="button" className={primaryBtn} onClick={onContinue}>
              {status === 'success' ? 'Continue' : 'Back to Sign In'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
};
