// Sign in / create account / unlock — right inside Stream Studio.
// New accounts need the welcome code; it's verified on the server only.
import React, { useEffect, useRef, useState } from 'react';
import {
  createAccount,
  openAuth,
  redeemWelcomeCode,
  registerAuthOpener,
  resendConfirmation,
  sendPasswordReset,
  signIn,
  useAccount,
  type AuthMode,
} from '../account';
import { Icon } from '../ui/icons';
import { Btn, cx, type PushToast } from '../ui/primitives';

const maxDob = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 8);
  return d.toISOString().slice(0, 10);
})();

export function AuthSheetHost({ push }: { push: PushToast }) {
  const [open, setOpen] = useState<{ mode: AuthMode; reason?: string } | null>(null);
  const account = useAccount();

  useEffect(() => {
    registerAuthOpener((mode, reason) => setOpen({ mode, reason }));
    return () => registerAuthOpener(null);
  }, []);

  // Signed in but locked: offer the code step automatically once.
  useEffect(() => {
    if (open && account.status === 'member') setOpen(null);
    if (open?.mode !== 'code' && open && account.status === 'needs_code') setOpen({ mode: 'code', reason: open.reason });
  }, [account.status, open]);

  if (!open) return null;
  return <AuthSheet mode={open.mode} reason={open.reason} onMode={(m) => setOpen({ ...open, mode: m })} onClose={() => setOpen(null)} push={push} suggestedName={account.suggestedName} />;
}

function AuthSheet({
  mode,
  reason,
  onMode,
  onClose,
  push,
  suggestedName,
}: {
  mode: AuthMode;
  reason?: string;
  onMode: (m: AuthMode) => void;
  onClose: () => void;
  push: PushToast;
  suggestedName?: string;
}) {
  const [name, setName] = useState(suggestedName || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Waiting for the email link: credentials stay in memory only, so the sheet
  // can sign in by itself once the address is confirmed — wherever the link opened.
  const [awaiting, setAwaiting] = useState<{ email: string; password: string; fresh: boolean } | null>(null);

  useEffect(() => {
    setErr(null);
    setNotice(null);
    setAwaiting(null);
  }, [mode]);

  if (awaiting) {
    return (
      <ConfirmEmail
        {...awaiting}
        onClose={onClose}
        onBack={() => {
          setAwaiting(null);
          onMode(awaiting.fresh ? 'create' : 'signin');
        }}
        push={push}
      />
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        const r = await signIn(email, password);
        if (r.unconfirmed) setAwaiting({ email: email.trim(), password, fresh: false });
        else if (!r.ok) setErr(r.error || 'Could not sign in.');
        else push('Signed in', { icon: 'check' });
      } else if (mode === 'create') {
        if (!agree) {
          setErr('Please accept the Terms and Privacy Policy.');
          return;
        }
        if (!dob) {
          setErr('Add your date of birth (you must be 8 or older).');
          return;
        }
        const r = await createAccount({ name, email, password, dob, code });
        if (!r.ok) setErr(r.error || 'Could not create the account.');
        else if (r.confirmEmail) setAwaiting({ email: email.trim(), password, fresh: true });
        else push('Welcome to Stream Studio!', { icon: 'sparkles' });
      } else if (mode === 'code') {
        const r = await redeemWelcomeCode(code, name);
        if (!r.ok) setErr(r.error || 'That code did not work.');
        else push('Unlocked — welcome to Stream Studio!', { icon: 'sparkles' });
      } else if (mode === 'reset') {
        const r = await sendPasswordReset(email);
        if (!r.ok) setErr(r.error || 'Could not send the email.');
        else setNotice('If that email has an account, a reset link is on its way.');
      }
    } finally {
      setBusy(false);
    }
  };

  const title = { signin: 'Sign in', create: 'Create your account', code: 'Enter your welcome code', reset: 'Reset your password' }[mode];
  const sub = {
    signin: 'Pick up where you left off — events, recordings and your baby monitor follow your account.',
    create: 'New accounts need a welcome code. Viewers never need an account — just a name.',
    code: 'Your account is signed in. Enter the welcome code you were given to unlock hosting and the baby monitor.',
    reset: 'We’ll email you a secure link.',
  }[mode];

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-labelledby="auth-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet auth-sheet fade-in" onSubmit={submit} noValidate>
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name={mode === 'code' ? 'lock' : 'user'} size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="auth-title" className="sheet-title serif">{title}</h2>
            <div className="sheet-sub">{reason && mode !== 'code' ? reason : sub}</div>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>

        {notice && <div className="banner info" style={{ marginBottom: 12 }}><Icon name="info" size={15} />{notice}</div>}
        {err && <div className="banner err" role="alert" style={{ marginBottom: 12 }}><Icon name="alert" size={15} />{err}</div>}

        <div className="auth-fields">
          {(mode === 'create' || mode === 'code') && (
            <label className="field">
              <span className="field-label">Your name <span className="field-hint">how family &amp; viewers find you</span></span>
              <input className="input" autoComplete="name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" required />
            </label>
          )}
          {mode !== 'code' && (
            <label className="field">
              <span className="field-label">Email</span>
              <input className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
            </label>
          )}
          {(mode === 'signin' || mode === 'create') && (
            <label className="field">
              <span className="field-label">Password {mode === 'create' && <span className="field-hint">8+ characters</span>}</span>
              <input className="input" type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} value={password} minLength={mode === 'create' ? 8 : undefined} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          )}
          {mode === 'create' && (
            <label className="field">
              <span className="field-label">Date of birth <span className="field-hint">8+ to join</span></span>
              <input className="input" type="date" max={maxDob} value={dob} onChange={(e) => setDob(e.target.value)} required />
            </label>
          )}
          {(mode === 'create' || mode === 'code') && (
            <label className="field">
              <span className="field-label">Welcome code <span className="field-hint">case-sensitive</span></span>
              <div className="code-row">
                <input
                  className="input mono"
                  type={showCode ? 'text' : 'password'}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={code}
                  maxLength={64}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Enter exactly as given"
                  required
                />
                <button type="button" className="iconbtn" onClick={() => setShowCode((v) => !v)} aria-label={showCode ? 'Hide code' : 'Show code'}>
                  <Icon name="eye" size={16} />
                </button>
              </div>
            </label>
          )}
          {mode === 'create' && (
            <label className="auth-agree">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>I agree to the <a href="/?view=terms" target="_blank" rel="noopener">Terms</a> and <a href="/?view=privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span>
            </label>
          )}
        </div>

        <Btn variant="solid" size="lg" type="submit" disabled={busy} className="auth-submit">
          {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : mode === 'create' ? 'Create account' : mode === 'code' ? 'Unlock Stream Studio' : 'Send reset link'}
        </Btn>

        <div className="auth-switch">
          {mode === 'signin' && (
            <>
              <button type="button" className="linkish" onClick={() => onMode('reset')}>Forgot password?</button>
              <span>New here? <button type="button" className="linkish" onClick={() => onMode('create')}>Create an account</button></span>
            </>
          )}
          {mode === 'create' && <span>Already have an account? <button type="button" className="linkish" onClick={() => onMode('signin')}>Sign in</button></span>}
          {mode === 'reset' && <button type="button" className="linkish" onClick={() => onMode('signin')}>Back to sign in</button>}
          {mode === 'code' && <span className="faint">Don’t have a code? Ask the person who invited you.</span>}
        </div>

        <div className="auth-secure">
          <Icon name="shield" size={13} />
          Codes are checked on our server only, never stored on your device, and repeated wrong guesses are locked out.
        </div>
      </form>
    </div>
  );
}

const POLL_MS = 20_000;
const POLL_FOR_MS = 15 * 60_000;
const RESEND_COOLDOWN_S = 60;

/**
 * "Check your email" — keeps trying to sign in quietly (every 20 s while the
 * page is visible, and right away when the user comes back to it), so tapping
 * the link on any device or browser is enough. Stops after 15 minutes.
 */
function ConfirmEmail({
  email,
  password,
  fresh,
  onClose,
  onBack,
  push,
}: {
  email: string;
  password: string;
  fresh: boolean;
  onClose: () => void;
  onBack: () => void;
  push: PushToast;
}) {
  const [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(fresh ? RESEND_COOLDOWN_S : 0);
  const busy = useRef(false);
  const lastTry = useRef(0);

  const attempt = async (byHand: boolean) => {
    if (busy.current) return;
    if (!byHand && Date.now() - lastTry.current < 8000) return;
    busy.current = true;
    lastTry.current = Date.now();
    setChecking(true);
    try {
      const r = await signIn(email, password);
      if (r.ok) push(fresh ? 'Email confirmed — welcome to Stream Studio!' : 'Signed in', { icon: 'sparkles' });
      else if (byHand) setErr(r.unconfirmed ? 'Not confirmed yet — tap the button in the email first.' : r.error || 'Could not sign in.');
      else if (!r.unconfirmed) setErr(r.error || 'Could not sign in.');
    } finally {
      busy.current = false;
      setChecking(false);
    }
  };

  // Sign in by ourselves as soon as the address is confirmed.
  useEffect(() => {
    const started = Date.now();
    const tick = () => {
      if (Date.now() - started > POLL_FOR_MS) {
        setStale(true);
        return;
      }
      if (document.visibilityState === 'visible') void attempt(false);
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, password]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  const resend = async () => {
    setErr(null);
    const r = await resendConfirmation(email);
    if (r.ok) {
      setSent('Sent a fresh link — the newest email is the one that works.');
      setCooldown(RESEND_COOLDOWN_S);
    } else setErr(r.error || 'Could not send the email.');
  };

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet auth-sheet sheet-swap">
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name="mail" size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="confirm-title" className="sheet-title serif">Check your email</h2>
            <div className="sheet-sub">We sent a confirmation link to <b className="confirm-email">{email}</b>.</div>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>

        {sent && <div className="banner info" style={{ marginBottom: 12 }}><Icon name="send" size={15} />{sent}</div>}
        {err && <div className="banner err" role="alert" style={{ marginBottom: 12 }}><Icon name="alert" size={15} />{err}</div>}

        <ol className="confirm-steps">
          <li>Open the email from <b>DreamStream</b> — check Spam or Promotions if it isn’t in your inbox.</li>
          <li>Tap <b>Confirm your email</b>. It’s fine if it opens in a different browser.</li>
          <li>Come back here — you’ll be signed in automatically{fresh ? ' and your welcome code is already applied' : ''}.</li>
        </ol>

        <div className="confirm-wait" aria-live="polite">
          <span className={cx('pill-dot', !stale && 'pulse')} />
          {stale ? 'Stopped checking — tap below once you’ve confirmed.' : checking ? 'Checking…' : 'Waiting for you to confirm…'}
        </div>

        <Btn variant="solid" size="lg" className="auth-submit" disabled={checking} onClick={() => void attempt(true)}>
          {checking ? 'Checking…' : 'I’ve confirmed — continue'}
        </Btn>

        <div className="auth-switch">
          <button type="button" className="linkish" disabled={cooldown > 0} onClick={() => void resend()}>
            {cooldown > 0 ? `Resend email in ${cooldown}s` : 'Resend email'}
          </button>
          <button type="button" className="linkish" onClick={onBack}>{fresh ? 'Use a different email' : 'Back to sign in'}</button>
        </div>
      </div>
    </div>
  );
}

/** Convenience for "sign in to continue" call sites. */
export const requireSignIn = (reason: string) => openAuth('signin', reason);
