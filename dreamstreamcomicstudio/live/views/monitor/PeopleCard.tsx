// Who's watching, plus guest access for parents: a share link + a passcode
// they set, the guests who joined with it, and one-tap removal.
import React, { useEffect, useRef, useState } from 'react';
import { passcodeProblem, shareLink, suggestPasscode } from '../../monitor/guest';
import { ROLE_INFO, type MonRole, type ShareInfo, type ViewerPresence } from '../../monitor/protocol';
import { Icon } from '../../ui/icons';
import { Btn, Segmented, cx, type PushToast } from '../../ui/primitives';

const DAYS: { value: string; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '0', label: 'Until I turn it off' },
];

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const until = (t: number) => {
  const d = Math.round((t - Date.now()) / 3_600_000);
  return d < 1 ? 'within the hour' : d < 48 ? `in ${d} h` : `in ${Math.round(d / 24)} days`;
};

export function PeopleCard({
  nid,
  me,
  guest,
  viewers,
  share,
  shareErr,
  baby,
  nurseryName,
  send,
  push,
  onLeave,
}: {
  nid: string;
  me: { sid: string; role: MonRole } | null;
  guest: boolean;
  viewers: ViewerPresence[];
  share: ShareInfo | null;
  shareErr: string | null;
  baby: string;
  nurseryName: string;
  send: (msg: Record<string, unknown>) => void;
  push: PushToast;
  onLeave: () => void;
}) {
  const isParent = me?.role === 'parent' && !guest;
  const [making, setMaking] = useState(false);
  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [role, setRole] = useState<'viewer' | 'caregiver'>('viewer');
  const [days, setDays] = useState('7');
  /** The passcode just set — shown once so the parent can pass it on; the room keeps only a hash. */
  const [justSet, setJustSet] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);

  // The room confirmed a new link: now show the passcode that goes with it.
  const createdAt = share?.created_at ?? null;
  useEffect(() => {
    if (createdAt && pendingRef.current) {
      setJustSet(pendingRef.current);
      pendingRef.current = null;
    }
  }, [createdAt]);
  // The room refused the passcode: back to the form with it still filled in.
  useEffect(() => {
    if (shareErr && pendingRef.current) {
      setPass(pendingRef.current);
      pendingRef.current = null;
      setMaking(true);
    }
  }, [shareErr]);

  const problem = pass ? passcodeProblem(pass, [baby, nurseryName]) : null;
  const link = share?.on && share.code ? shareLink(nid, share.code) : null;

  const create = () => {
    if (!pass || problem) return;
    pendingRef.current = pass;
    send({ t: 'share_set', pass, role, days: Number(days) || null });
    setJustSet(null);
    setMaking(false);
    setPass('');
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      push(`${what} copied`, { icon: 'check', duration: 1800 });
    } catch {
      push(`Couldn’t copy — select it and copy by hand`, { icon: 'alert' });
    }
  };
  const shareNative = async () => {
    if (!link) return;
    const text = `Watch ${baby} on our baby monitor. I’ll send you the passcode separately.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${nurseryName} · baby monitor`, text, url: link });
        return;
      } catch { /* cancelled */ }
    }
    void copy(link, 'Link');
  };

  return (
    <div className="card card-pad people-card" data-tour="mv-people">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="users" size={17} />
        <b style={{ flex: 1 }}>People</b>
        {guest && <span className="pill-guest">Guest</span>}
      </div>

      <div className="mv-sect-title" style={{ marginTop: 12 }}>Watching now</div>
      <div className="watch-list">
        {viewers.map((v) => (
          <div key={v.sid} className="watch-row">
            <span className="watch-name">
              {v.label || v.name}
              {v.sid === me?.sid ? ' (you)' : ''}
              {v.guest && <span className="pill-guest sm">Guest</span>}
            </span>
            <span className="faint">{v.dn} · {ROLE_INFO[v.role].label}{v.relay ? ' · low-bandwidth' : ''}</span>
          </div>
        ))}
      </div>

      {guest && (
        <div className="share-box">
          <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
            You joined with a share link. A parent can end your guest pass at any time.
          </p>
          <Btn variant="subtle" size="sm" icon="logout" onClick={onLeave}>Leave this nursery</Btn>
        </div>
      )}

      {isParent && (
        <div className="share-box" data-tour="mv-share">
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon name="link" size={15} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>Share with a link</b>
              <small className="faint" style={{ display: 'block' }}>
                For family or a sitter without an account. They need the link <i>and</i> a passcode you choose — 5 wrong tries lock it, 20 turn it off.
              </small>
            </div>
          </div>

          {share?.locked_until && (
            <div className="banner warn" style={{ marginTop: 10 }}>
              <Icon name="alert" size={15} />
              <span>Someone entered the wrong passcode 5 times — the link is locked {until(share.locked_until)}. If that wasn’t a guest you invited, turn the link off.</span>
            </div>
          )}

          {link && !making && (
            <>
              <div className="share-link">
                <code title={link}>{link.replace(/^https?:\/\//, '')}</code>
                <Btn variant="soft" size="sm" icon="copy" onClick={() => void copy(link, 'Link')}>Copy</Btn>
                <Btn variant="soft" size="sm" icon="share" onClick={() => void shareNative()}>Send</Btn>
              </div>
              <small className="faint" style={{ display: 'block', marginTop: 6 }}>
                {share!.role === 'caregiver' ? 'Guests can watch, talk, soothe and answer alerts' : 'Guests can watch and listen'}
                {' · '}
                {share!.expires_at ? `expires ${until(share!.expires_at)}` : 'until you turn it off'}
              </small>
              {justSet && (
                <div className="banner info" style={{ marginTop: 10 }}>
                  <Icon name="lock" size={15} />
                  <span style={{ flex: 1 }}>
                    Passcode: <b className="mono">{justSet}</b> — tell them by phone or in a different app from the link. You won’t see it again.
                  </span>
                  <Btn variant="subtle" size="sm" onClick={() => void copy(justSet, 'Passcode')}>Copy</Btn>
                </div>
              )}
              {share!.guests.length > 0 && (
                <div className="guest-list">
                  {share!.guests.map((g) => (
                    <div key={g.id} className="guest-row">
                      <Icon name="user" size={14} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <b>{g.name}</b>
                        <small className="faint">{g.role === 'caregiver' ? 'Watch & help' : 'Watch & listen'} · joined {ago(g.created_at)} · last seen {ago(g.last_seen)}</small>
                      </div>
                      <button className="linkish danger" onClick={() => window.confirm(`Remove ${g.name}? Their guest pass ends right away.`) && send({ t: 'guest_remove', id: g.id })}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <Btn variant="subtle" size="sm" icon="refresh" onClick={() => { setMaking(true); setJustSet(null); }}>New link &amp; passcode</Btn>
                <Btn variant="danger" size="sm" icon="x" onClick={() => {
                  if (window.confirm('Turn the share link off? Everyone who joined with it is signed out.')) {
                    send({ t: 'share_off' });
                    setJustSet(null);
                  }
                }}>Turn off</Btn>
              </div>
            </>
          )}

          {!link && !making && (
            <Btn variant="soft" size="sm" icon="link" style={{ marginTop: 10 }} onClick={() => setMaking(true)}>Create a share link</Btn>
          )}

          {making && (
            <div className="share-form">
              {link && <p className="faint" style={{ margin: '0 0 8px', fontSize: 12.5 }}>A new link replaces the old one, and everyone who joined with the old link is signed out.</p>}
              <label className="share-field">
                <span>Passcode</span>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    type={show ? 'text' : 'password'}
                    value={pass}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="At least 8 characters"
                    onChange={(e) => setPass(e.target.value)}
                  />
                  <button type="button" className="iconbtn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide passcode' : 'Show passcode'}>
                    <Icon name={show ? 'eyeOff' : 'eye'} size={16} />
                  </button>
                </div>
                <small className={cx('faint', problem && 'share-problem')}>
                  {problem ?? (pass ? 'Good — share it separately from the link.' : 'Tip: a few words with a number is strong and easy to say out loud.')}
                </small>
                <button type="button" className="linkish" onClick={() => { setPass(suggestPasscode()); setShow(true); }}>Suggest one</button>
              </label>
              <div className="share-field">
                <span>Guests can</span>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="What guests can do">
                  <button type="button" role="radio" aria-checked={role === 'viewer'} className={cx('cam-chip', role === 'viewer' && 'sel')} onClick={() => setRole('viewer')}>
                    <Icon name="eye" size={13} />Watch &amp; listen
                  </button>
                  <button type="button" role="radio" aria-checked={role === 'caregiver'} className={cx('cam-chip', role === 'caregiver' && 'sel')} onClick={() => setRole('caregiver')}>
                    <Icon name="heart" size={13} />Also talk, soothe &amp; answer alerts
                  </button>
                </div>
              </div>
              <div className="share-field">
                <span>Link works for</span>
                <Segmented label="Link works for" options={DAYS} value={days} onChange={setDays} />
              </div>
              {shareErr && <div className="banner warn"><Icon name="alert" size={15} />{shareErr}</div>}
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <Btn variant="solid" size="sm" icon="link" disabled={!pass || !!problem} onClick={create}>Create link</Btn>
                <Btn variant="ghost" size="sm" onClick={() => { setMaking(false); setPass(''); }}>Cancel</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      {isParent && viewers.length > 1 && (
        <Btn variant="danger" size="sm" icon="x" style={{ marginTop: 12 }} onClick={() => {
          if (window.confirm('Disconnect everyone else watching right now? Members can rejoin; guests can rejoin while their pass is valid.')) send({ t: 'end_all' });
        }}>End other sessions</Btn>
      )}
    </div>
  );
}
