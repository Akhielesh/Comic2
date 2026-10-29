// Settings → Security → Two-step sign-in (ADR 0006 WS-5). Built so that a parent can never be
// locked out of their own account, or lose their nursery camera, because of it:
//   * Before turning it on: what changes, said plainly — devices already signed in (a nursery
//     camera included) stay signed in and keep watching; only new sign-ins and admin actions ask
//     for the code — with the devices signed in right now listed.
//   * Turning it on needs the password typed again (a fresh sign-in): someone holding only a
//     stolen session can't switch it on and shut the parent out. The server checks this too.
//   * Ten recovery codes, shown once, that must be saved before it's done: a lost phone has a
//     way back (StepUp → "Use a recovery code").
//   * "Not you?" in the email that announces it switches it off again (live_secure_account).
import { useCallback, useEffect, useState } from 'react';
import {
  cancelTotpEnrollment,
  confirmPassword,
  enrollTotp,
  failed,
  listSecurityEvents,
  mfaStatus,
  openAuth,
  regenerateRecoveryCodes,
  signInIsFresh,
  unenrollTotp,
  useAccount,
  verifyTotp,
  type MfaState,
  type SecurityEvent,
  type TotpEnrollment,
} from '../../account';
import { Icon } from '../../ui/icons';
import { Btn, type PushToast } from '../../ui/primitives';
import { ensureStepUp } from './StepUp';
import { describeBrowser, formatWhen, groupKey } from './securityWords';
import './account.css';

type Stage =
  | { kind: 'idle' }
  | { kind: 'intro' }
  | { kind: 'password' }
  | { kind: 'setup'; enrol: TotpEnrollment }
  | { kind: 'codes'; codes: string[]; fresh: boolean };

/** What the parent is told before turning it on — the camera line above all. */
export const TURN_ON_EXPLAINED = [
  'Devices already signed in stay signed in and keep working — including a phone running as a nursery camera. Only a new sign-in asks for the code.',
  'Adding people, share links, exports and devices will ask for the code, on every device.',
  'You’ll get 10 recovery codes. If you ever lose your phone, one of them gets you back in.',
];

/** Supabase holds an authenticator that was never switched on here (live__mfa_tidy removes it after an hour). */
export const STRAY_AUTHENTICATOR =
  'An authenticator that was never finished is still attached to your account, so a new one can’t be added yet. It’s removed automatically within an hour — try again then. If you didn’t start setting one up, someone else may have your password: change it and use “Sign out everywhere” below.';

export function TwoStepBlock({ push }: { push: PushToast }) {
  const account = useAccount();
  const [st, setSt] = useState<MfaState | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [signedIn, setSignedIn] = useState<SecurityEvent[] | null>(null);

  const load = useCallback(async () => {
    setSt(await mfaStatus());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const enrol = async () => {
    setBusy(true);
    let r = await enrollTotp();
    if (failed(r) && r.code === 'step_up' && !st?.on) {
      // Supabase wants a code, yet two-step sign-in is off here: an authenticator was added to the
      // account but never switched on (a set-up left half-way, or one added from a stolen session).
      // There is no code to give for it, so say what's going on instead of asking for one.
      setBusy(false);
      setStage({ kind: 'idle' });
      setErr(STRAY_AUTHENTICATOR);
      return;
    }
    if (failed(r) && r.code === 'step_up' && (await ensureStepUp('Adding an authenticator'))) r = await enrollTotp();
    setBusy(false);
    if (!failed(r)) {
      setStage({ kind: 'setup', enrol: r });
      setCode('');
    } else if (r.code === 'disabled') {
      setDisabled(true);
      setStage({ kind: 'idle' });
    } else setErr(r.error);
  };

  const start = async () => {
    setErr(null);
    if (st?.on) {
      // Another authenticator: a change to how the account is protected — the code first.
      if (!(await ensureStepUp('Adding an authenticator'))) return;
      await enrol();
      return;
    }
    setStage({ kind: 'intro' });
    setSignedIn(null);
    const ev = await listSecurityEvents(50);
    setSignedIn(failed(ev) ? [] : ev.events.filter((e) => e.kind === 'sign_in' && e.active));
  };

  // Past the explanation: a fresh sign-in first (the server insists on one too).
  const proceed = async () => {
    setErr(null);
    if (await signInIsFresh()) await enrol();
    else {
      setPassword('');
      setStage({ kind: 'password' });
    }
  };

  const submitPassword = async () => {
    if (busy || !password) return;
    setBusy(true);
    setErr(null);
    const r = await confirmPassword(password);
    setBusy(false);
    setPassword('');
    if (failed(r)) {
      setErr(r.error);
      return;
    }
    await enrol();
  };

  const confirm = async () => {
    if (stage.kind !== 'setup' || busy) return;
    setBusy(true);
    setErr(null);
    const r = await verifyTotp(stage.enrol.factorId, code);
    setBusy(false);
    if (failed(r)) {
      setErr(r.error);
      if (r.code === 'disabled') {
        setDisabled(true);
        setStage({ kind: 'idle' });
      } else if (r.code === 'reauth' || r.code === 'signed_out' || r.code === 'failed' || r.code === 'offline') {
        // The authenticator was taken off again: start over from the top.
        if (r.code !== 'offline') setStage({ kind: 'idle' });
      }
      void load();
      return;
    }
    void load();
    if (r.codes.length) {
      setSaved(false);
      setStage({ kind: 'codes', codes: r.codes, fresh: true });
    } else {
      setStage({ kind: 'idle' });
      push(r.first ? 'Two-step sign-in is on' : 'Authenticator added', { icon: 'check' });
    }
  };

  const cancel = async () => {
    const id = stage.kind === 'setup' ? stage.enrol.factorId : null;
    setStage({ kind: 'idle' });
    setErr(null);
    setPassword('');
    if (id) await cancelTotpEnrollment(id);
  };

  const remove = async (factorId: string, last: boolean) => {
    const sure = window.confirm(
      last
        ? 'Turn off two-step sign-in? Signing in — and adding people, share links, exports and devices — will need only your password again. Your recovery codes stop working.'
        : 'Remove this authenticator? It stops giving codes for your account; your other one keeps working.',
    );
    if (!sure) return;
    if (!(await ensureStepUp(last ? 'Turning off two-step sign-in' : 'Removing an authenticator'))) return;
    setBusy(true);
    let r = await unenrollTotp(factorId);
    if (failed(r) && r.code === 'step_up' && (await ensureStepUp('Removing an authenticator'))) r = await unenrollTotp(factorId);
    setBusy(false);
    if (failed(r)) {
      setErr(r.error);
      return;
    }
    push(last ? 'Two-step sign-in is off' : 'Authenticator removed', { icon: 'check' });
    void load();
  };

  const newCodes = async () => {
    if (!window.confirm('Make new recovery codes? The ones you saved before stop working.')) return;
    if (!(await ensureStepUp('Making new recovery codes'))) return;
    setBusy(true);
    setErr(null);
    let r = await regenerateRecoveryCodes();
    if (failed(r) && r.code === 'step_up' && (await ensureStepUp('Making new recovery codes'))) r = await regenerateRecoveryCodes();
    setBusy(false);
    if (failed(r)) {
      setErr(r.error);
      return;
    }
    setSaved(false);
    setStage({ kind: 'codes', codes: r.codes, fresh: false });
    void load();
  };

  const copyKey = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      push('Setup key copied — keep it somewhere safe', { icon: 'check' });
    } catch {
      push('Couldn’t copy — select the key and copy it by hand', { icon: 'alert' });
    }
  };

  const on = !!st?.on;
  const unavailable = disabled || (!!st && st.ok && !st.available);
  return (
    <section className="sec-block" aria-labelledby="sec-2step">
      <div className="sec-block-head">
        <h3 id="sec-2step">Two-step sign-in</h3>
        {st && st.ok && <span className={on ? 'pill pill-ok' : 'pill pill-neutral'}>{on ? 'On' : 'Off'}</span>}
      </div>
      <p className="sec-desc">
        After your password, signing in on a new device asks for a 6-digit code from an authenticator app on your phone. So does
        anything that changes who can see your nursery — adding people, share links, exports, approving devices. A stolen password
        alone isn’t enough.
      </p>

      {!st ? (
        <div className="skeleton" style={{ height: 40 }} aria-label="Checking two-step sign-in" />
      ) : stage.kind === 'codes' ? (
        <RecoveryCodes
          codes={stage.codes}
          fresh={stage.fresh}
          email={account.email}
          saved={saved}
          onSaved={setSaved}
          push={push}
          onDone={() => {
            setStage({ kind: 'idle' });
            push(stage.fresh ? 'Two-step sign-in is on' : 'New recovery codes saved', { icon: 'check' });
          }}
        />
      ) : !st.ok ? (
        <div className="sec-actions">
          <span className="sec-empty">{st.error === 'mfa_required' ? 'Confirm it’s you with your authenticator code to see this.' : 'Couldn’t check right now.'}</span>
          {st.error === 'mfa_required' ? (
            <Btn variant="soft" size="sm" icon="shield" onClick={() => void ensureStepUp('Seeing two-step sign-in').then((ok) => ok && load())}>Confirm it’s you</Btn>
          ) : (
            <Btn variant="soft" size="sm" icon="refresh" onClick={() => void load()}>Retry</Btn>
          )}
        </div>
      ) : unavailable && !on ? (
        <div className="banner info"><Icon name="info" size={15} /><span>Two-step sign-in isn’t switched on for DreamStream accounts yet. Nothing has changed on your account.</span></div>
      ) : stage.kind === 'intro' ? (
        <div className="sec-setup sec-setup-wide" role="group" aria-label="Before you turn on two-step sign-in">
          <div>
            <b className="sec-setup-title">Before you turn it on</b>
            <ul className="sec-points">
              {TURN_ON_EXPLAINED.map((t) => <li key={t}>{t}</li>)}
            </ul>
            <div className="sec-signed-in" aria-live="polite">
              <small>Signed in to your account right now — these stay signed in:</small>
              {signedIn === null ? (
                <div className="skeleton" style={{ height: 24 }} aria-label="Loading devices signed in" />
              ) : signedIn.length === 0 ? (
                <small className="sec-empty">This device{account.email ? ` (${account.email})` : ''}.</small>
              ) : (
                <ul className="sec-list" aria-label="Signed in right now">
                  {signedIn.map((e) => (
                    <li className="sec-item" key={e.id}>
                      <span className="sec-item-icon"><Icon name="monitor" size={14} /></span>
                      <span className="sec-item-text">
                        <b>{describeBrowser(e.ua)}{e.this_session ? ' — this device' : ''}</b>
                        <small>Signed in {formatWhen(e.at)}{e.ip ? ` · near ${e.ip}` : ''}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="banner warn sec-keep">
              <Icon name="alert" size={15} />
              <span>
                Think someone else has your password? Change it and use <b>Sign out everywhere</b> (below) as well — that signs out every
                device, including a nursery camera, which then needs signing in again.
              </span>
            </div>
            <div className="sec-actions" style={{ marginTop: 12 }}>
              <Btn variant="solid" size="sm" icon="shield" disabled={busy} onClick={() => void proceed()}>{busy ? 'One moment…' : 'Continue'}</Btn>
              <Btn variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>Not now</Btn>
            </div>
          </div>
        </div>
      ) : stage.kind === 'password' ? (
        <form
          className="sec-setup sec-setup-wide"
          aria-label="Confirm your password"
          onSubmit={(e) => {
            e.preventDefault();
            void submitPassword();
          }}
        >
          <div>
            <b className="sec-setup-title">Confirm it’s you</b>
            <p className="sec-desc" style={{ margin: '4px 0 10px' }}>
              Type your password{account.email ? <> for <b style={{ overflowWrap: 'anywhere' }}>{account.email}</b></> : null}. This signs this
              device in again — you may get a “new sign-in” email for it; that’s you.
            </p>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              aria-label="Your password"
              value={password}
              disabled={busy}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="sec-actions" style={{ marginTop: 10 }}>
              <Btn type="submit" variant="solid" size="sm" disabled={busy || !password}>{busy ? 'Checking…' : 'Continue'}</Btn>
              <Btn type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>Cancel</Btn>
            </div>
            <p className="sec-desc" style={{ marginTop: 10 }}>
              Don’t know your password? Use{' '}
              <button type="button" className="linkish" disabled={busy} onClick={() => openAuth('reset')}>Forgot password</button>{' '}
              — we email you a link to choose one. Sign in here with it, then come back to turn this on.
            </p>
          </div>
        </form>
      ) : stage.kind === 'setup' ? (
        <div className="sec-setup">
          <img className="sec-qr" src={stage.enrol.qr} alt="QR code to add DreamStream to your authenticator app" width={168} height={168} />
          <div>
            <ol className="sec-steps">
              <li>Open an authenticator app — Google Authenticator, Microsoft Authenticator, 1Password, Authy or similar — and scan this code.</li>
              <li>
                Can’t scan it? Add it by hand with this setup key:{' '}
                <span className="sec-key">
                  <code aria-label="Setup key">{groupKey(stage.enrol.secret)}</code>
                  <Btn variant="subtle" size="sm" icon="copy" onClick={() => void copyKey(stage.enrol.secret)}>Copy</Btn>
                </span>
              </li>
              <li>
                Type the 6-digit code the app shows:
                <form
                  className="sec-verify"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void confirm();
                  }}
                >
                  <input
                    className="input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    aria-label="6-digit code from your authenticator app"
                    placeholder="123456"
                    maxLength={7}
                    value={code}
                    disabled={busy}
                    onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
                  />
                  <Btn type="submit" variant="solid" size="sm" disabled={busy || code.replace(/\D/g, '').length !== 6}>
                    {busy ? 'Checking…' : on ? 'Add' : 'Turn on'}
                  </Btn>
                  <Btn type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>Cancel</Btn>
                </form>
              </li>
            </ol>
            <p className="sec-desc" style={{ marginTop: 10 }}>
              Next you’ll get recovery codes — your way back in if you lose this phone. Saving the setup key in a password manager works
              too: it puts the codes on a new phone.
            </p>
          </div>
        </div>
      ) : on ? (
        <>
          <ul className="sec-list" aria-label="Your authenticators">
            {st.factors.map((f) => (
              <li className="sec-item" key={f.id}>
                <span className="sec-item-icon"><Icon name="phone" size={16} /></span>
                <span className="sec-item-text">
                  <b>{f.name}</b>
                  <small>Added {formatWhen(f.createdAt)}</small>
                </span>
                <Btn variant="subtle" size="sm" disabled={busy} onClick={() => void remove(f.id, st.factors.length === 1)}>
                  {st.factors.length === 1 ? 'Turn off' : 'Remove'}
                </Btn>
              </li>
            ))}
            <li className="sec-item">
              <span className={st.codesLeft != null && st.codesLeft <= 2 ? 'sec-item-icon warn' : 'sec-item-icon'}><Icon name="lock" size={16} /></span>
              <span className="sec-item-text">
                <b>Recovery codes</b>
                <small>
                  {st.codesLeft == null
                    ? 'Your way back in if you lose your phone.'
                    : st.codesLeft === 0
                      ? 'None left — make new ones now, or a lost phone could lock you out.'
                      : `${st.codesLeft} left — each works once if you lose your phone.`}
                </small>
              </span>
              <Btn variant="subtle" size="sm" disabled={busy} onClick={() => void newCodes()}>Get new codes</Btn>
            </li>
          </ul>
          {st.grace && (
            <div className="banner info sec-keep" role="status">
              <Icon name="info" size={15} />
              <span>
                This device was signed in before two-step sign-in was turned on, so it keeps working without the code until you sign out
                here. Adding people, share links, exports and devices still ask for it.
              </span>
            </div>
          )}
          <div className="sec-actions" style={{ marginTop: 10 }}>
            <Btn variant="soft" size="sm" icon="plus" disabled={busy} onClick={() => void start()}>Add another authenticator</Btn>
          </div>
        </>
      ) : (
        <div className="sec-actions">
          <Btn variant="solid" size="sm" icon="shield" disabled={busy} onClick={() => void start()}>
            {busy ? 'One moment…' : 'Turn on two-step sign-in'}
          </Btn>
        </div>
      )}
      {err && (
        <div className="banner err" role="alert" style={{ marginTop: 10 }}>
          <Icon name="alert" size={15} />
          <span>{err}</span>
        </div>
      )}
    </section>
  );
}

/** The recovery codes, once: copy, download, and a tick that they're saved before it's done. */
export function RecoveryCodes({
  codes,
  fresh,
  email,
  saved,
  onSaved,
  onDone,
  push,
}: {
  codes: string[];
  fresh: boolean;
  email?: string;
  saved: boolean;
  onSaved: (v: boolean) => void;
  onDone: () => void;
  push: PushToast;
}) {
  const text = [
    'DreamStream — two-step sign-in recovery codes',
    email ? `Account: ${email}` : '',
    `Made: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Each code works once. Use one if you lose the phone with your authenticator app:',
    'it switches two-step sign-in off so you can get back in, then set it up again.',
    '',
    ...codes,
  ]
    .filter((l, i) => l !== '' || i > 2)
    .join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      push('Recovery codes copied — paste them somewhere safe', { icon: 'check' });
    } catch {
      push('Couldn’t copy — select the codes and copy them by hand', { icon: 'alert' });
    }
  };
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dreamstream-recovery-codes.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      push('Couldn’t download — copy the codes instead', { icon: 'alert' });
    }
  };
  return (
    <div className="sec-setup sec-setup-wide" role="group" aria-labelledby="sec-codes-title">
      <div>
        <b id="sec-codes-title" className="sec-setup-title">{fresh ? 'Two-step sign-in is on — save your recovery codes' : 'Your new recovery codes'}</b>
        <p className="sec-desc" style={{ margin: '4px 0 10px' }}>
          Lose the phone with your authenticator app, and one of these gets you back in: it switches two-step sign-in off so you can set
          it up again on your new phone. Each works once. Keep them somewhere safe — a password manager, or printed at home. We can’t
          show them again{fresh ? '' : ', and the old ones have stopped working'}.
        </p>
        <ol className="sec-codes" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}><code>{c}</code></li>
          ))}
        </ol>
        <div className="sec-actions" style={{ marginTop: 10 }}>
          <Btn variant="soft" size="sm" icon="copy" onClick={() => void copy()}>Copy</Btn>
          <Btn variant="soft" size="sm" icon="download" onClick={download}>Download</Btn>
        </div>
        <label className="sec-saved">
          <input type="checkbox" checked={saved} onChange={(e) => onSaved(e.target.checked)} />
          <span>I’ve saved these codes somewhere safe</span>
        </label>
        <div className="sec-actions" style={{ marginTop: 10 }}>
          <Btn variant="solid" size="sm" icon="check" disabled={!saved} onClick={onDone}>Done</Btn>
        </div>
      </div>
    </div>
  );
}
