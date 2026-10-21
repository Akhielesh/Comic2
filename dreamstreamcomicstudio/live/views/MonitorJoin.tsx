// Joining a nursery with the share link + passcode — for family and sitters
// without an account. Says nothing about the nursery until the passcode is
// right; the room locks the link after repeated wrong guesses.
import React, { useEffect, useState } from 'react';
import { useAccount } from '../account';
import { getDevice } from '../monitor/client';
import { joinAsGuest, joinErrorText, loadGuest, type JoinError } from '../monitor/guest';
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

  // Already holding a pass for this nursery on this device: straight in.
  useEffect(() => {
    if (loadGuest(nid)) nav.monitorWatch(nid);
  }, [nid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (account.status === 'member' && account.name && !name) setName(account.name);
  }, [account.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = err?.reason === 'off' || err?.reason === 'expired' || err?.reason === 'bad_link' || err?.reason === 'full';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setErr({ reason: 'name' });
    setBusy(true);
    setErr(null);
    const r = await joinAsGuest(nid, { code, pass, name: name.trim(), dev: getDevice().id });
    setBusy(false);
    if (r.ok === false) {
      setErr(r);
      if (r.reason === 'wrong') setPass('');
      return;
    }
    push(`Welcome, ${r.pass.name} — you’re watching ${r.pass.nursery.baby || r.pass.nursery.name}`, { icon: 'heart' });
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
          <li><Icon name="info" size={13} />Not a medical device — it doesn’t monitor breathing or sleep position.</li>
        </ul>
      </form>
    </div>
  );
}
