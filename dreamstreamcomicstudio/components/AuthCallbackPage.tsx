/**
 * The page an emailed link lands on (sign-in link, password reset, sign-up confirmation), on the Atlas
 * design system: a status tile (the hue only backs the icon and the words), the page title in the display
 * face, one live region and full-width actions. The behaviour is unchanged: the confirm step asks before a
 * link signs this browser in and names what continuing does; each new status moves focus to its title.
 */
import React, { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, LogIn, type LucideIcon } from 'lucide-react';
import { Button } from './ds';
import { FONT_DISPLAY, OVERLINE, STATUS_INK, STATUS_SURFACE, type StatusState } from './chat/studioDesign';
import { cn } from '../lib/utils';

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

/** Each status as a status-vocabulary state and its icon (STATUS_SURFACE / STATUS_INK). */
const STATUS_MARK: Record<AuthCallbackStatus, { state: StatusState; icon: LucideIcon; spin?: boolean }> = {
  confirm: { state: 'active', icon: LogIn },
  verifying: { state: 'waiting', icon: Loader2, spin: true },
  success: { state: 'healthy', icon: CheckCircle2 },
  error: { state: 'error', icon: AlertTriangle }
};

const WIDE_BUTTON = 'h-11 w-full text-[15px]';

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
        ? 'Verifying your link'
        : status === 'success'
          ? flowType === 'recovery'
            ? 'Recovery verified'
            : 'You’re signed in'
          : 'This link didn’t work';

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

  const mark = STATUS_MARK[status];
  const Icon = mark.icon;

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] w-full justify-center bg-ds-canvas px-4 py-12 text-ds-ink sm:px-6 sm:py-20">
      <section className="flex w-full max-w-[26.25rem] flex-col" aria-labelledby="auth-callback-title">
        {/* Keyed by status: the tile scales in again when the status changes. */}
        <span key={status} aria-hidden="true" className="flex">
          <span
            className={cn(
              'ds-scale-in flex size-12 shrink-0 items-center justify-center rounded-[var(--ds-radius-feature)] border',
              STATUS_SURFACE[mark.state],
              STATUS_INK[mark.state]
            )}
          >
            <Icon className={cn('size-6', mark.spin && 'animate-spin motion-reduce:animate-none')} />
          </span>
        </span>

        <p className={cn(OVERLINE, 'm-0 mt-8')}>DreamStream Studio</p>
        <h1
          id="auth-callback-title"
          ref={titleRef}
          tabIndex={-1}
          className={cn(
            FONT_DISPLAY,
            'm-0 mt-3 text-balance text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] text-ds-ink [overflow-wrap:anywhere] focus:outline-none sm:text-[2.5rem]'
          )}
        >
          {title}
        </h1>

        {/* One region, always mounted: its text changes with the status and is announced. */}
        <p className="m-0 mt-4 text-pretty text-[15px] leading-7 text-ds-muted" aria-live="polite">
          {status === 'confirm' ? (
            <>
              This link signs this browser in to DreamStream
              {email ? (
                <>
                  {' '}as <span className="break-all font-medium text-ds-ink">{email}</span>
                </>
              ) : null}
              . Continue only if you asked for it.
            </>
          ) : (
            description
          )}
        </p>

        {status === 'confirm' && (knownOther || maybeOther || otherData || flowType === 'signup') && (
          <div className="mt-5 flex flex-col gap-3 rounded-[var(--ds-radius-feature)] border border-ds-hairline bg-ds-well px-4 py-3.5 text-sm leading-6 text-ds-muted">
            {otherData && (
              <p className="m-0">
                Another account’s data is on this browser. Continuing removes it here (that account gets it back from its
                cloud copy when it signs in).
              </p>
            )}
            {knownOther && (
              <p className="m-0">
                You’re signed in as <span className="break-all font-medium text-ds-ink">{currentEmail}</span>. Continuing
                signs you in with this link instead.
              </p>
            )}
            {maybeOther && (
              <p className="m-0">
                You’re signed in as <span className="break-all font-medium text-ds-ink">{currentEmail}</span>. If this link
                is for a different account, continuing switches this browser to it.
              </p>
            )}
            {flowType === 'signup' && <p className="m-0">Continuing also confirms the account’s email.</p>}
          </div>
        )}

        {status === 'confirm' && (
          <div className="mt-8 flex flex-col gap-3">
            <Button size="lg" className={WIDE_BUTTON} onClick={onConfirm}>
              Continue
            </Button>
            <Button variant="outline" size="lg" className={WIDE_BUTTON} onClick={onDecline}>
              Not now
            </Button>
          </div>
        )}

        {status === 'verifying' && (
          <div aria-hidden="true" className="mt-8 flex flex-col gap-3">
            <span className="ds-skeleton block h-11 w-full rounded-[var(--ds-radius-control)]" />
          </div>
        )}

        {(status === 'success' || status === 'error') && (
          <div className="mt-8">
            <Button size="lg" className={WIDE_BUTTON} onClick={onContinue}>
              {status === 'success' ? 'Continue' : 'Back to sign in'}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
};
