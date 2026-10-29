// Step-up: the code from the account's authenticator app, asked for
//   * at sign-in, when two-step sign-in is on (the account is `needs_mfa` until it's given), and
//   * before admin actions — creating share links, adding people, export, approving a device,
//     revoking one, changing two-step sign-in itself — when this session hasn't given it yet.
// ADR 0006 D6.2: once someone has an authenticator, every member RPC and room socket refuses an
// aal1 token (`mfa_required`, close code 4003); a phished password alone can't act.
//
// For other screens (WS-6: PeopleCard, the Invite sheet, export, the 4003 close):
//   if (!(await ensureStepUp('Adding someone to the nursery'))) return;   // cancelled
// It resolves true at once when no code is needed (no authenticator, or the session is aal2).
// One sheet serves every caller: asks that arrive while it's open share its answer.
// Any of the account's authenticators works (each is tried — the person needn't know which), and
// a lost phone has a way back: "Use a recovery code" switches two-step sign-in off so they can
// get in and set it up again (account.ts recoverWithCode).
import { useEffect, useRef, useState } from 'react';
import { failed, recoverWithCode, registerSecondStepOpener, signOutThisDevice, stepUp, stepUpNeeded, useAccount } from '../../account';
import { Icon } from '../../ui/icons';
import { Btn, type PushToast } from '../../ui/primitives';
import './account.css';

type Mode = 'action' | 'signin';
interface Ask {
  mode: Mode;
  reason?: string;
}

let opener: ((ask: Ask) => void) | null = null;
let waiting: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;

function settle(ok: boolean): void {
  const w = waiting;
  waiting = null;
  w?.resolve(ok);
}

/** Show the sheet (or join the one already showing). False when there's no sheet to show it in. */
export function askForCode(reason?: string, mode: Mode = 'action'): Promise<boolean> {
  if (waiting) return waiting.promise;
  if (!opener) return Promise.resolve(false);
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  waiting = { promise, resolve };
  opener({ mode, reason });
  return promise;
}

/**
 * Before an admin action: true when it may go ahead (no code needed, or the code was just given),
 * false when the person cancelled. Never throws.
 */
export async function ensureStepUp(reason?: string): Promise<boolean> {
  let needed = false;
  try {
    needed = await stepUpNeeded();
  } catch {
    needed = false; // can't tell: the server still refuses an aal1 token, and the caller shows that
  }
  if (!needed) return true;
  return askForCode(reason, 'action');
}

const TARGET = { minHeight: 44 } as const;

/** Mounted once (LiveApp). Opens itself when a sign-in still owes the code. */
export function StepUpHost({ push }: { push: PushToast }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const account = useAccount();
  const prompted = useRef(false);

  useEffect(() => {
    opener = (a) => setAsk(a);
    registerSecondStepOpener(() => void askForCode(undefined, 'signin'));
    return () => {
      opener = null;
      registerSecondStepOpener(null);
      settle(false);
    };
  }, []);

  // Password given, code still owed: ask once by itself (every "Sign in" button asks again).
  useEffect(() => {
    if (account.status === 'needs_mfa' && !prompted.current) {
      prompted.current = true;
      void askForCode(undefined, 'signin');
    }
    if (account.status !== 'needs_mfa') prompted.current = false;
    // Signed in fully (another tab gave the code) or signed out: a sign-in ask is moot.
    if (ask?.mode === 'signin' && account.status !== 'needs_mfa' && account.status !== 'loading') {
      setAsk(null);
      settle(account.status === 'member' || account.status === 'needs_code');
    }
  }, [account.status, ask]);

  if (!ask) return null;
  return (
    <StepUpSheet
      mode={ask.mode}
      reason={ask.reason}
      email={account.email}
      onDone={(ok) => {
        setAsk(null);
        settle(ok);
      }}
      onSignOut={async () => {
        setAsk(null);
        settle(false);
        await signOutThisDevice();
        push('Signed out on this device', { icon: 'check' });
      }}
      onRecovered={() => {
        setAsk(null);
        settle(true);
        push('You’re back in. Two-step sign-in is off — set it up again with your new phone.', { icon: 'shield', duration: 10000 });
        try {
          location.hash = '#/settings?s=security';
        } catch { /* no navigation (tests) */ }
      }}
    />
  );
}

export function StepUpSheet({
  mode,
  reason,
  email,
  onDone,
  onSignOut,
  onRecovered,
}: {
  mode: Mode;
  reason?: string;
  email?: string;
  onDone: (ok: boolean) => void;
  onSignOut: () => void;
  /** A recovery code was accepted: two-step sign-in is off and the person is in. */
  onRecovered?: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [rcode, setRcode] = useState('');
  const tried = useRef('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onDone(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onDone]);

  const redeemRecovery = async () => {
    if (busy || rcode.replace(/[^A-Za-z0-9]/g, '').length < 12) return;
    setBusy(true);
    setErr(null);
    const r = await recoverWithCode(rcode);
    setBusy(false);
    if (failed(r)) {
      setErr(r.error);
      return;
    }
    if (onRecovered) onRecovered();
    else onDone(true);
  };

  const digits = code.replace(/\D/g, '');
  const submit = async () => {
    if (busy || digits.length !== 6) return;
    tried.current = digits;
    setBusy(true);
    setErr(null);
    const r = await stepUp(digits);
    setBusy(false);
    if (!failed(r)) {
      onDone(true);
      return;
    }
    setErr(r.error);
    setCode('');
  };

  // Six digits typed (or pasted): go — no extra tap. A rejected code isn't resent by itself.
  useEffect(() => {
    if (digits.length === 6 && digits !== tried.current && !busy) void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  const signin = mode === 'signin';
  return (
    <div className="sheet-scrim stepup-scrim" role="dialog" aria-modal="true" aria-labelledby="stepup-title" aria-describedby="stepup-sub">
      <div className="sheet auth-sheet fade-in">
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name="shield" size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="stepup-title" className="sheet-title serif">{signin ? 'Two-step sign-in' : 'Confirm it’s you'}</h2>
            <div id="stepup-sub" className="sheet-sub">
              {signin ? (
                <>Type the 6-digit code from your authenticator app to finish signing in{email ? <> as <b style={{ overflowWrap: 'anywhere' }}>{email}</b></> : null}.</>
              ) : (
                <>{reason ? `${reason} needs` : 'This needs'} the 6-digit code from your authenticator app — so a password alone can’t change who sees your nursery.</>
              )}
            </div>
          </div>
        </div>
        {recovery ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void redeemRecovery();
            }}
          >
            <label className="stepup-label" htmlFor="stepup-recovery">Recovery code</label>
            <input
              id="stepup-recovery"
              className="input stepup-code stepup-recovery"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={20}
              placeholder="abcd-efgh-jkmn"
              autoFocus
              value={rcode}
              disabled={busy}
              aria-invalid={!!err}
              aria-describedby={err ? 'stepup-err' : 'stepup-recovery-help'}
              onChange={(e) => setRcode(e.target.value.slice(0, 20))}
            />
            <p id="stepup-recovery-help" className="stepup-help">
              One of the 10 codes you saved when you turned on two-step sign-in. It switches two-step sign-in <b>off</b> so you can get
              back in — then set it up again with your new phone. We’ll email you that it was used.
            </p>
            {err && (
              <div id="stepup-err" className="banner err stepup-err" role="alert">
                <Icon name="alert" size={15} />
                <span>{err}</span>
              </div>
            )}
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              <Btn type="submit" variant="solid" size="lg" className="auth-submit" style={TARGET} disabled={busy || rcode.replace(/[^A-Za-z0-9]/g, '').length < 12}>
                {busy ? 'Checking…' : 'Use recovery code'}
              </Btn>
              <Btn
                type="button"
                variant="ghost"
                size="lg"
                className="auth-submit"
                style={TARGET}
                disabled={busy}
                onClick={() => {
                  setRecovery(false);
                  setErr(null);
                }}
              >
                Back to the 6-digit code
              </Btn>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="stepup-label" htmlFor="stepup-code">Code</label>
            <input
              id="stepup-code"
              className="input stepup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              placeholder="123 456"
              autoFocus
              value={code}
              disabled={busy}
              aria-invalid={!!err}
              aria-describedby={err ? 'stepup-err' : undefined}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
            />
            <p className="stepup-help">Any of your authenticator apps works, if you set up more than one.</p>
            {err && (
              <div id="stepup-err" className="banner err stepup-err" role="alert">
                <Icon name="alert" size={15} />
                <span>{err}</span>
              </div>
            )}
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              <Btn type="submit" variant="solid" size="lg" className="auth-submit" style={TARGET} disabled={busy || digits.length !== 6}>
                {busy ? 'Checking…' : signin ? 'Sign in' : 'Confirm'}
              </Btn>
              {signin ? (
                <Btn type="button" variant="ghost" size="lg" className="auth-submit" style={TARGET} disabled={busy} onClick={onSignOut}>
                  Sign out instead
                </Btn>
              ) : (
                <Btn type="button" variant="ghost" size="lg" className="auth-submit" style={TARGET} disabled={busy} onClick={() => onDone(false)}>
                  Cancel
                </Btn>
              )}
            </div>
          </form>
        )}
        {!recovery && (
          <div className="auth-switch">
            <button type="button" className="linkish" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
              Lost your phone?
            </button>
          </div>
        )}
        {help && !recovery && (
          <div className="stepup-help">
            <p style={{ margin: '0 0 8px' }}>
              Use one of the <b>recovery codes</b> you saved when you turned on two-step sign-in. It switches two-step sign-in off so you
              can get back in; then set it up again with your new phone. (If you saved the setup key in a password manager, adding it
              to an authenticator app on your new phone works too.)
            </p>
            <Btn
              type="button"
              variant="soft"
              size="sm"
              icon="lock"
              onClick={() => {
                setRecovery(true);
                setErr(null);
              }}
            >
              Use a recovery code
            </Btn>
            <p style={{ margin: '8px 0 0' }}>
              No codes and no setup key? Email <a href="mailto:support@dreamstreamstudio.ai">support@dreamstreamstudio.ai</a> from your
              account’s address and we’ll help you back in. A new password alone won’t switch two-step sign-in off — that’s the point of it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
