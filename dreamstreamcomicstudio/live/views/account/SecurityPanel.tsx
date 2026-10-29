// Settings → Security (ADR 0006 WS-5): two-step sign-in (TOTP) with a QR code and honest
// recovery guidance, "Your devices" with one-tap sign-out, and the account's recent security
// history with a way out if something looks wrong. Every change that could hand someone access
// asks for the authenticator code first (StepUp) once two-step sign-in is on.
import { useCallback, useEffect, useState } from 'react';
import {
  cancelTotpEnrollment,
  enrollTotp,
  failed,
  listMyDevices,
  listSecurityEvents,
  mfaStatus,
  revokeMyDevice,
  signOutEverywhere,
  signOutEverywhereMessage,
  unenrollTotp,
  verifyTotp,
  type MfaState,
  type MyDevice,
  type SecurityEvent,
  type SecurityListError,
  type TotpEnrollment,
} from '../../account';
import { mainAppUrl } from '@/services/liveLink';
import { Icon } from '../../ui/icons';
import { Btn, type PushToast } from '../../ui/primitives';
import { ensureStepUp } from './StepUp';
import { describeDevice, describeEvent, formatWhen, groupKey, platformIcon } from './securityWords';
import './account.css';

/** The main site's account page: change password (and the main app's own sign-out everywhere). */
export const PASSWORD_URL = '/?view=settings&tab=security';

/**
 * Said before "Sign out everywhere" — including the one thing a parent must not be surprised by:
 * a phone running as the nursery camera on this account stops too.
 */
export const SIGN_OUT_EVERYWHERE_CONFIRM =
  'Sign out everywhere?\n\nEvery phone, tablet and computer signed in to your account has to sign in again — including a phone running as a nursery camera, which stops watching until someone signs in on it. Open monitors and calls disconnect.\n\nUse this if you think someone else has your password.';

/** Confirm, sign out everywhere, and say exactly what happened. False when cancelled. */
export async function confirmAndSignOutEverywhere(push: PushToast): Promise<boolean> {
  if (!window.confirm(SIGN_OUT_EVERYWHERE_CONFIRM)) return false;
  const r = await signOutEverywhere();
  push(signOutEverywhereMessage(r), { icon: r.global ? 'check' : 'alert', duration: 7000 });
  return true;
}

const LIST_COPY: Record<SecurityListError, string> = {
  setup: 'Not switched on yet — this appears with the next security update on our server.',
  mfa_required: 'Confirm it’s you with your authenticator code to see this.',
  session_revoked: 'This session was signed out. Sign in again to see this.',
  offline: 'Can’t reach the server — check your connection.',
  failed: 'Couldn’t load this right now.',
};

export function SecurityPanel({ push, onSignOutEverywhere }: { push: PushToast; onSignOutEverywhere: () => void }) {
  return (
    <div className="sec-panel">
      <TwoStepBlock push={push} />
      <DevicesBlock push={push} />
      <ActivityBlock onSignOutEverywhere={onSignOutEverywhere} />
    </div>
  );
}

/* ------------------------------------------------------------ two-step sign-in */

function TwoStepBlock({ push }: { push: PushToast }) {
  const [st, setSt] = useState<MfaState | null>(null);
  const [setup, setSetup] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [justOn, setJustOn] = useState(false);

  const load = useCallback(async () => {
    setSt(await mfaStatus());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    setErr(null);
    setJustOn(false);
    // A second authenticator is a change to how the account is protected: the code first.
    if (st?.on && !(await ensureStepUp('Adding an authenticator'))) return;
    setBusy(true);
    let r = await enrollTotp();
    if (failed(r) && r.code === 'step_up' && (await ensureStepUp('Adding an authenticator'))) r = await enrollTotp();
    setBusy(false);
    if (!failed(r)) {
      setSetup(r);
      setCode('');
    } else if (r.code === 'disabled') setDisabled(true);
    else setErr(r.error);
  };

  const confirm = async () => {
    if (!setup || busy) return;
    setBusy(true);
    setErr(null);
    const r = await verifyTotp(setup.factorId, code);
    setBusy(false);
    if (failed(r)) {
      setErr(r.error);
      return;
    }
    setSetup(null);
    setJustOn(true);
    push('Two-step sign-in is on', { icon: 'check' });
    void load();
  };

  const cancel = async () => {
    const id = setup?.factorId;
    setSetup(null);
    setErr(null);
    if (id) await cancelTotpEnrollment(id);
  };

  const remove = async (factorId: string, last: boolean) => {
    const sure = window.confirm(
      last
        ? 'Turn off two-step sign-in? Signing in — and adding people, share links, exports and devices — will need only your password again.'
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
    setJustOn(false);
    push(last ? 'Two-step sign-in is off' : 'Authenticator removed', { icon: 'check' });
    void load();
  };

  const copyKey = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      push('Setup key copied — keep it somewhere safe', { icon: 'check' });
    } catch {
      push('Couldn’t copy — select the key and copy it by hand', { icon: 'alert' });
    }
  };

  const on = !!st?.on;
  return (
    <section className="sec-block" aria-labelledby="sec-2step">
      <div className="sec-block-head">
        <h3 id="sec-2step">Two-step sign-in</h3>
        {st && st.ok && <span className={on ? 'pill pill-ok' : 'pill pill-neutral'}>{on ? 'On' : 'Off'}</span>}
      </div>
      <p className="sec-desc">
        After your password, signing in asks for a 6-digit code from an authenticator app on your phone. So does anything that
        changes who can see your nursery — adding people, share links, exports, approving devices. A stolen password alone isn’t enough.
      </p>

      {!st ? (
        <div className="skeleton" style={{ height: 40 }} aria-label="Checking two-step sign-in" />
      ) : !st.ok ? (
        <div className="sec-actions">
          <span className="sec-empty">Couldn’t check right now.</span>
          <Btn variant="soft" size="sm" icon="refresh" onClick={() => void load()}>Retry</Btn>
        </div>
      ) : disabled ? (
        <div className="banner info"><Icon name="info" size={15} /><span>Two-step sign-in isn’t switched on for DreamStream accounts yet. Nothing has changed on your account.</span></div>
      ) : setup ? (
        <div className="sec-setup">
          <img className="sec-qr" src={setup.qr} alt="QR code to add DreamStream to your authenticator app" width={168} height={168} />
          <div>
            <ol className="sec-steps">
              <li>Open an authenticator app — Google Authenticator, Microsoft Authenticator, 1Password, Authy or similar — and scan this code.</li>
              <li>
                Can’t scan it? Add it by hand with this setup key:{' '}
                <span className="sec-key">
                  <code aria-label="Setup key">{groupKey(setup.secret)}</code>
                  <Btn variant="subtle" size="sm" icon="copy" onClick={() => void copyKey()}>Copy</Btn>
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
                    {busy ? 'Checking…' : 'Turn on'}
                  </Btn>
                  <Btn type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>Cancel</Btn>
                </form>
              </li>
            </ol>
            <div className="banner warn sec-keep">
              <Icon name="lock" size={15} />
              <span>
                Save the setup key in your password manager now — we can’t show it again. It’s how you get your codes back on a new
                phone. There are no backup codes: lose the phone and the key, and you’ll need to email support to get back in.
              </span>
            </div>
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
          </ul>
          {justOn && (
            <div className="banner info sec-keep" role="status">
              <Icon name="check" size={15} />
              <span>From now on, signing in on a new device asks for the code. Keep your setup key safe — or add a second authenticator, so losing one phone doesn’t lock you out.</span>
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

/* ------------------------------------------------------------------- devices */

function DevicesBlock({ push }: { push: PushToast }) {
  const [list, setList] = useState<MyDevice[] | null>(null);
  const [error, setError] = useState<SecurityListError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await listMyDevices();
    if (failed(r)) {
      setList([]);
      setError(r.error);
    } else {
      setList(r.devices);
      setError(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (d: MyDevice) => {
    if (!window.confirm(`Sign out “${d.name}”? It stops getting alerts and can’t open your nurseries until it’s set up again.`)) return;
    if (!(await ensureStepUp('Signing a device out'))) return;
    setBusy(d.id);
    let r = await revokeMyDevice(d.id);
    if (failed(r) && r.error === 'mfa_required' && (await ensureStepUp('Signing a device out'))) r = await revokeMyDevice(d.id);
    setBusy(null);
    if (failed(r)) push(r.error === 'not_found' ? 'That device was already removed' : LIST_COPY[r.error], { icon: 'alert' });
    else push(`${d.name} is signed out`, { icon: 'check' });
    void load();
  };

  const active = (list ?? []).filter((d) => !d.revoked_at);
  const gone = (list ?? []).filter((d) => d.revoked_at);
  return (
    <section className="sec-block" aria-labelledby="sec-devices">
      <div className="sec-block-head"><h3 id="sec-devices">Your devices</h3></div>
      <p className="sec-desc">Phones, browsers and watches added to your account. Signing one out stops its alerts and access straight away.</p>
      {list === null ? (
        <div className="skeleton" style={{ height: 40 }} aria-label="Loading your devices" />
      ) : error ? (
        <div className="sec-actions">
          <span className="sec-empty">{LIST_COPY[error]}</span>
          {error === 'mfa_required' && (
            <Btn variant="soft" size="sm" icon="shield" onClick={() => void ensureStepUp('Seeing your devices').then((ok) => ok && load())}>Confirm it’s you</Btn>
          )}
        </div>
      ) : active.length + gone.length === 0 ? (
        <p className="sec-empty">None yet. When you add a phone or pair a watch, it shows up here.</p>
      ) : (
        <ul className="sec-list" aria-label="Your devices">
          {[...active, ...gone].map((d) => (
            <li className="sec-item" key={d.id}>
              <span className="sec-item-icon"><Icon name={platformIcon(d.platform)} size={16} /></span>
              <span className="sec-item-text">
                <b>{d.name}</b>
                <small>{describeDevice(d)}</small>
              </span>
              {d.revoked_at ? (
                <span className="pill pill-neutral">Signed out</span>
              ) : (
                <Btn variant="subtle" size="sm" icon="logout" disabled={busy != null} onClick={() => void revoke(d)}>
                  {busy === d.id ? 'Signing out…' : 'Sign out'}
                </Btn>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------- recent activity */

function ActivityBlock({ onSignOutEverywhere }: { onSignOutEverywhere: () => void }) {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<SecurityListError | null>(null);

  const load = useCallback(async () => {
    const r = await listSecurityEvents(20);
    if (failed(r)) {
      setEvents([]);
      setError(r.error);
    } else {
      setEvents(r.events);
      setError(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="sec-block" aria-labelledby="sec-activity">
      <div className="sec-block-head">
        <h3 id="sec-activity">Recent security activity</h3>
        <Btn variant="subtle" size="sm" icon="refresh" onClick={() => void load()} aria-label="Refresh security activity">Refresh</Btn>
      </div>
      <p className="sec-desc">New sign-ins, devices added or signed out, and accounts secured from a “Not you?” email.</p>
      {events === null ? (
        <div className="skeleton" style={{ height: 40 }} aria-label="Loading security activity" />
      ) : error ? (
        <div className="sec-actions">
          <span className="sec-empty">{LIST_COPY[error]}</span>
          {error === 'mfa_required' && (
            <Btn variant="soft" size="sm" icon="shield" onClick={() => void ensureStepUp('Seeing your security activity').then((ok) => ok && load())}>Confirm it’s you</Btn>
          )}
        </div>
      ) : events.length === 0 ? (
        <p className="sec-empty">Nothing yet — new sign-ins show up here.</p>
      ) : (
        <ul className="sec-list" aria-label="Recent security activity">
          {events.map((e) => {
            const w = describeEvent(e);
            return (
              <li className="sec-item" key={e.id}>
                <span className={w.warn ? 'sec-item-icon warn' : 'sec-item-icon'}><Icon name={w.icon} size={16} /></span>
                <span className="sec-item-text">
                  <b>{w.title}</b>
                  <small>{w.detail}</small>
                </span>
                {e.kind === 'sign_in' && e.this_session ? (
                  <span className="pill pill-info">This device</span>
                ) : e.kind === 'sign_in' && e.active ? (
                  <span className="pill pill-neutral">Still signed in</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="banner warn" style={{ marginTop: 12 }}>
        <Icon name="alert" size={15} />
        <span>
          Something you don’t recognise? Sign out everywhere, then change your password.
          <span className="sec-actions" style={{ marginTop: 8 }}>
            <Btn variant="solid" size="sm" icon="logout" onClick={onSignOutEverywhere}>Sign out everywhere</Btn>
            <a className="btn btn-ghost btn-sm" href={mainAppUrl(PASSWORD_URL)} target="_blank" rel="noopener noreferrer">
              <Icon name="lock" size={15} />
              <span>Change password</span>
            </a>
          </span>
        </span>
      </div>
    </section>
  );
}
