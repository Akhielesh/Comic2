// Who's watching right now, and — for parents — the share link at a glance
// with one tap into the Invite sheet (add people, share a link, who has
// access). Guests can leave from here.
import React, { useState } from 'react';
import { shareSummary, type InviteTab } from '../../monitor/invite';
import { ROLE_INFO, type MonRole, type ShareInfo, type ViewerPresence } from '../../monitor/protocol';
import { Icon } from '../../ui/icons';
import { Btn } from '../../ui/primitives';

export function PeopleCard({
  me,
  guest,
  viewers,
  share,
  send,
  onInvite,
  onLeave,
}: {
  me: { sid: string; role: MonRole } | null;
  guest: boolean;
  viewers: ViewerPresence[];
  share: ShareInfo | null;
  send: (msg: Record<string, unknown>) => void;
  onInvite: (tab?: InviteTab) => void;
  onLeave: () => void;
}) {
  const isParent = me?.role === 'parent' && !guest;
  // Two-step yes/no in place: window.confirm is blocked in some in-app browsers (where guests often are).
  const [confirm, setConfirm] = useState<'leave' | 'end' | null>(null);
  const requests = share?.requests?.length ?? 0;

  return (
    <div className="card card-pad people-card" data-tour="mv-people">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="users" size={17} />
        <b style={{ flex: 1 }}>People</b>
        {guest && <span className="pill-guest">Guest</span>}
        {!guest && <Btn variant="subtle" size="sm" icon={isParent ? 'userPlus' : 'users'} onClick={() => onInvite()}>{isParent ? 'Invite' : 'Who has access'}</Btn>}
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
            <span className="faint">{v.dn} · {ROLE_INFO[v.role].label}{v.relay ? ' · via our server' : ''}</span>
          </div>
        ))}
      </div>

      {guest && (
        <div className="share-box">
          <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
            You joined with a share link. A parent can end your guest pass at any time.
          </p>
          {confirm === 'leave' ? (
            <div className="inline-confirm" role="group" aria-label="Leave this nursery">
              <span>Leave this nursery? You’ll need the link and passcode to come back.</span>
              <div className="row" style={{ gap: 8 }}>
                <Btn variant="danger" size="sm" onClick={onLeave}>Leave</Btn>
                <Btn variant="ghost" size="sm" onClick={() => setConfirm(null)} autoFocus>Cancel</Btn>
              </div>
            </div>
          ) : (
            <Btn variant="subtle" size="sm" icon="logout" onClick={() => setConfirm('leave')}>Leave this nursery</Btn>
          )}
        </div>
      )}

      {isParent && (
        <div className="share-box" data-tour="mv-share">
          <div className="pc-share">
            <Icon name="link" size={15} />
            <div className="pc-share-txt">
              <b>Share link</b>
              <small className="faint">{shareSummary(share)}</small>
              {requests > 0 && <small className="inv-watching">{requests} guest{requests === 1 ? ' has' : 's have'} an account — make {requests === 1 ? 'them a member' : 'them members'} in Invite.</small>}
            </div>
            <Btn variant="soft" size="sm" icon={share?.on ? 'sliders' : 'link'} onClick={() => onInvite('link')}>{share?.on ? 'Manage' : 'Share a link'}</Btn>
          </div>
        </div>
      )}

      {isParent && viewers.length > 1 && (
        confirm === 'end' ? (
          <div className="inline-confirm" role="group" aria-label="End other sessions">
            <span>Disconnect everyone else watching right now? Members can rejoin; guests can rejoin while their pass is valid.</span>
            <div className="row" style={{ gap: 8 }}>
              <Btn variant="danger" size="sm" onClick={() => { send({ t: 'end_all' }); setConfirm(null); }}>End other sessions</Btn>
              <Btn variant="ghost" size="sm" onClick={() => setConfirm(null)} autoFocus>Cancel</Btn>
            </div>
          </div>
        ) : (
          <Btn variant="danger" size="sm" icon="x" style={{ marginTop: 12 }} onClick={() => setConfirm('end')}>End other sessions</Btn>
        )
      )}
    </div>
  );
}
