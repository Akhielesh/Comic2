// Joining a nursery with the share link + passcode — for family and sitters
// without an account. Says nothing about the nursery until the passcode is
// right; the room locks the link after repeated wrong guesses. Someone who is
// already a member (signed in) goes straight to watching with their account;
// anyone else signed in is shown to the parents as "has an account".
import React, { useEffect, useMemo, useState } from 'react';
import { accessToken, useAccount } from '../account';
import { checkBrowser } from '../monitor/camera';
import { getDevice, listNurseries } from '../monitor/client';
import { clearGuest, joinAsGuest, joinErrorText, loadGuest, type JoinError } from '../monitor/guest';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Btn, type PushToast } from '../ui/primitives';

export function MonitorJoin({ nid, code, nav, push }: { nid: string; code: string; nav: Nav; push: PushToast }) {
  const account = useAccount();
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ reason: JoinError; retryAt?: number | null; left?: number | null } | null>(null);
  const browser = useMemo(() => (typeof navigator !== 'undefined' ? checkBrowser() : null), []);

  // Already holding a pass for this nursery on this device: straight in.
  useEffect(() => {
    if (loadGuest(nid)) nav.monitorWatch(nid);
  }, [nid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Already a member? No guest pass needed — watch with your own account.
  useEffect(() => {
    if (account.status !== 'member') return;
    if (account.name && !name) setName(account.name);
    let alive = true;
    void listNurseries().then((r) => {
      const n = r.ok ? r.nurseries?.find((x) => x.id === nid) : null;
      if (!alive || !n) return;
      clearGuest(nid);
      push(`You’re already in ${n.name} — watching with your account`, { icon: 'heart' });
      nav.monitorWatch(nid);
    });
    return () => {
      alive = false;
    };
  }, [account.status, nid]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = err?.reason === 'off' || err?.reason === 'expired' || err?.reason === 'bad_link' || err?.reason === 'full';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setErr({ reason: 'name' });
    setBusy(true);
    setErr(null);
    // Signed in: the room asks Supabase who we are (members skip the guest pass).
    const token = account.status === 'member' ? await accessToken() : null;
    const r = await joinAsGuest(nid, { code, pass, name: name.trim(), dev: getDevice().id }, token);
    setBusy(false);
    if (r.ok === false) {
      if (r.reason === 'member') {
        clearGuest(nid);
        push(joinErrorText(r), { icon: 'heart' });
        nav.monitorWatch(nid);
        return;
      }
      setErr(r);
      if (r.reason === 'wrong') setPass('');
      return;
    }
    push(
      r.account
        ? `Welcome, ${r.pass.name} — a parent can now make you a member, so you can watch with your account`
        : `Welcome, ${r.pass.name} — you’re watching ${r.pass.nursery.baby || r.pass.nursery.name}`,
      { icon: 'heart', duration: r.account ? 5000 : 2600 },
    );
    nav.monitorWatch(nid);
  };

  return (
    <div className="join-page fade-in">
      <form className="card card-pad join-card" onSubmit={submit}>
        <div className="mh-icon" style={{ margin: '0 auto' }}><Icon name="baby" size={30} /></div>
        <h1 className="page-title" style={{ textAlign: 'center', margin: '12px 0 4px' }}>You’re invited to a baby monitor</h1>
        <p className="faint" style={{ textAlign: 'center', margin: '0 0 18px', lineHeight: 1.5 }}>
          Enter the passcode the parent gave you. Video goes straight from the nursery camera to this device — it’s never recorded.
        </p>

        {browser?.inApp && (
          <div className="banner info join-inapp" role="note">
            <Icon name="globe" size={15} />
            <span>
              You’re in {browser.inApp}’s built-in browser. It works here, but your guest pass stays inside {browser.inApp} — to keep watching from {browser.ios ? 'Safari' : 'Chrome'}, open this link there instead (⋯ menu → Open in browser).
            </span>
          </div>
        )}

        <label className="field">
          <span>Your name</span>
          <input
            className="input"
            value={name}
            maxLength={30}
            autoComplete="name"
            placeholder="e.g. Grandma Jo"
            onChange={(e) => setName(e.target.value)}
            disabled={blocked}
          />
          <small className="faint">The family sees who’s watching.</small>
        </label>

        <label className="field">
          <span>Passcode</span>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              type={show ? 'text' : 'password'}
              value={pass}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setPass(e.target.value)}
              disabled={blocked}
              aria-describedby={err ? 'join-err' : undefined}
            />
            <button type="button" className="iconbtn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide passcode' : 'Show passcode'}>
              <Icon name={show ? 'eyeOff' : 'eye'} size={16} />
            </button>
          </div>
        </label>

        {err && (
          <div id="join-err" className={`banner ${err.reason === 'wrong' || err.reason === 'name' ? 'warn' : 'err'}`} role="alert" style={{ marginTop: 4 }}>
            <Icon name="alert" size={15} />
            <span>{joinErrorText(err)}</span>
          </div>
        )}

        <Btn type="submit" variant="solid" size="lg" icon="eye" disabled={busy || blocked || !pass} style={{ width: '100%', marginTop: 14 }}>
          {busy ? 'Checking…' : 'Join and watch'}
        </Btn>

        <ul className="join-notes faint">
          <li><Icon name="lock" size={13} />Only use a link someone you trust sent you. Never share the passcode in the same message as the link.</li>
          <li><Icon name="shield" size={13} />Parents see everyone who joins and can remove you at any time.</li>
          {account.status === 'member' && <li><Icon name="user" size={13} />You’re signed in, so the parents can make you a member — then you watch with your account, no passcode.</li>}
          <li><Icon name="info" size={13} />Not a medical device — it doesn’t monitor breathing or sleep position.</li>
        </ul>
      </form>
    </div>
  );
}
