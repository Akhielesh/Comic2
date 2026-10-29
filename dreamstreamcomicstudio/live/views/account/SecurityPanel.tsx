// Settings → Security (ADR 0006 WS-5): two-step sign-in (TOTP, TwoStep.tsx: fresh sign-in first,
// recovery codes, never a locked-out parent or a dark nursery camera), "Your devices" with
// one-tap sign-out, and the account's recent security history with a way out if something looks
// wrong. Every change that could hand someone access asks for the authenticator code first
// (StepUp) once two-step sign-in is on.
import { useCallback, useEffect, useState } from 'react';
import {
  failed,
  listMyDevices,
  listSecurityEvents,
  revokeMyDevice,
  signOutEverywhere,
  unconfirmedRevokes,
  signOutEverywhereMessage,
  type MyDevice,
  type SecurityEvent,
  type SecurityListError,
} from '../../account';
import { mainAppUrl } from '@/services/liveLink';
import { Icon } from '../../ui/icons';
import { Btn, type PushToast } from '../../ui/primitives';
import { ensureStepUp } from './StepUp';
import { TwoStepBlock } from './TwoStep';
import { describeDevice, describeEvent, platformIcon } from './securityWords';
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

/* ------------------------------------------------------------------- devices */

function DevicesBlock({ push }: { push: PushToast }) {
  const [list, setList] = useState<MyDevice[] | null>(null);
  const [error, setError] = useState<SecurityListError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Signed out of the account, but not every nursery has heard yet: keep a retry for these.
  const [pending, setPending] = useState<string[]>(() => unconfirmedRevokes());

  const load = useCallback(async () => {
    setPending(unconfirmedRevokes());
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

  const revoke = async (d: MyDevice, again = false) => {
    if (!again && !window.confirm(`Sign out “${d.name}”? It stops getting alerts and can’t open your nurseries until it’s set up again.`)) return;
    if (!(await ensureStepUp('Signing a device out'))) return;
    setBusy(d.id);
    let r = await revokeMyDevice(d.id);
    if (failed(r) && r.error === 'mfa_required' && (await ensureStepUp('Signing a device out'))) r = await revokeMyDevice(d.id);
    setBusy(null);
    if (failed(r)) {
      push(
        r.error === 'not_found'
          ? 'That device was already removed'
          : r.error === 'retry'
            ? `Couldn’t sign “${d.name}” out just now — nothing changed. Try again in a moment.`
            : LIST_COPY[r.error],
        { icon: 'alert', duration: 7000 },
      );
    } else if (r.confirmed) push(`${d.name} is signed out — its alerts and access stopped`, { icon: 'check' });
    else
      push(`${d.name} can’t sign in again, but not every nursery has heard yet, so it may still get alerts. Tap “Finish signing out” to try again.`, {
        icon: 'alert',
        duration: 9000,
      });
    void load();
  };

  const active = (list ?? []).filter((d) => !d.revoked_at);
  const gone = (list ?? []).filter((d) => d.revoked_at);
  return (
    <section className="sec-block" aria-labelledby="sec-devices">
      <div className="sec-block-head"><h3 id="sec-devices">Your devices</h3></div>
      <p className="sec-desc">Phones, browsers and watches added to your account. Signing one out stops its alerts and access — we tell you if any nursery couldn’t be reached.</p>
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
              {d.revoked_at && pending.includes(d.id) ? (
                <Btn variant="soft" size="sm" icon="refresh" disabled={busy != null} onClick={() => void revoke(d, true)}>
                  {busy === d.id ? 'Trying…' : 'Finish signing out'}
                </Btn>
              ) : d.revoked_at ? (
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
      <p className="sec-desc">New sign-ins, two-step sign-in changes, devices added or signed out, and accounts secured from a “Not you?” email.</p>
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
