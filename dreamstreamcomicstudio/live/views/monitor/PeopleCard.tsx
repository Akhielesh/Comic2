// Who's watching right now, and — for parents — the share link at a glance
// with one tap into the Invite sheet (add people, share a link, who has
// access). Guests can leave from here.
//
// After a guest is removed the room may change the link and its passcode
// (ADR 0006: `share_rotated`), so the removed person's copy stops working:
// parents see the new link once here, with one tap to pass it on. Admin
// actions ask for the second sign-in step first when the session owes it.
import React, { useState } from 'react';
import { ensureStepUp } from '../../monitor/client';
import { shareLink } from '../../monitor/guest';
import { linkMessage, shareOrCopy, shareSummary, type InviteTab } from '../../monitor/invite';
import { ROLE_INFO, type MonRole, type ShareInfo, type ViewerPresence } from '../../monitor/protocol';
import { PATH_TIP, VIEWER_VIA_SERVER } from '../../costCopy';
import { Icon } from '../../ui/icons';
import { Btn } from '../../ui/primitives';

/** The share link the room changed after a guest was removed (`share_rotated`), shown to parents once. */
export interface RotatedLink {
  code: string;
  /** The new passcode, when it changed too — shown here once, never stored. */
  pass: string | null;
  /** Who was removed. */
  removed: string | null;
}

/** "1234 5678" — a passcode read aloud or typed from another screen. */
const spaced = (pass: string) => (/^\d{8}$/.test(pass) ? `${pass.slice(0, 4)} ${pass.slice(4)}` : pass);

export function PeopleCard({
  me,
  guest,
  viewers,
  share,
  send,
  onInvite,
  onLeave,
  nid,
  nursery,
  rotated,
  onRotatedDone,
  say,
}: {
  me: { sid: string; role: MonRole } | null;
  guest: boolean;
  viewers: ViewerPresence[];
  share: ShareInfo | null;
  send: (msg: Record<string, unknown>) => void;
  onInvite: (tab?: InviteTab) => void;
  onLeave: () => void;
  /** For the new link after a guest was removed. */
  nid?: string;
  nursery?: { name: string; baby: string };
  rotated?: RotatedLink | null;
  onRotatedDone?: () => void;
  /** A short confirmation (toast). */
  say?: (text: string) => void;
}) {
  const isParent = me?.role === 'parent' && !guest;
  // Two-step yes/no in place: window.confirm is blocked in some in-app browsers (where guests often are).
  const [confirm, setConfirm] = useState<'leave' | 'end' | null>(null);
  const requests = share?.requests?.length ?? 0;
  const newUrl = rotated && nid ? shareLink(nid, rotated.code) : null;

  /** Parents: managing people and links asks for the second sign-in step first, when it's owed. */
  const invite = async (tab?: InviteTab) => {
    if (isParent && !(await ensureStepUp('Managing who can watch the nursery'))) return;
    onInvite(tab);
  };
  const endOthers = async () => {
    setConfirm(null);
    if (!(await ensureStepUp('Disconnecting everyone else watching'))) return;
    send({ t: 'end_all' });
  };
  const shareNew = async () => {
    if (!newUrl) return;
    const r = await shareOrCopy(linkMessage(newUrl, nursery?.baby || 'the baby', nursery?.name || 'Nursery'), newUrl);
    if (r === 'copied') say?.('New link copied — send the passcode separately');
    else if (r === 'failed') say?.('Couldn’t share it here — copy it from Invite → Share link');
  };

  return (
    <div className="card card-pad people-card" data-tour="mv-people">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="users" size={17} />
        <b style={{ flex: 1 }}>People</b>
        {guest && <span className="pill-guest">Guest</span>}
        {!guest && <Btn variant="subtle" size="sm" icon={isParent ? 'userPlus' : 'users'} onClick={() => void invite()}>{isParent ? 'Invite' : 'Who has access'}</Btn>}
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
            <span className="faint" title={v.relay ? PATH_TIP.server : undefined}>{v.dn} · {ROLE_INFO[v.role].label}{v.relay ? VIEWER_VIA_SERVER : ''}</span>
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

      {isParent && rotated && newUrl && (
        <div className="share-box pc-rotated" role="status" aria-live="polite">
          <div className="pc-share">
            <Icon name="lock" size={15} />
            <div className="pc-share-txt">
              <b>Link {rotated.pass ? 'and passcode ' : ''}changed</b>
              <small className="faint">
                {rotated.removed ? `${rotated.removed} can’t` : 'The person you removed can’t'} use the old one any more. Guests still watching were moved over; anyone else you shared it with needs the new link{rotated.pass ? ' and passcode' : ''}.
              </small>
              {rotated.pass && (
                <small>
                  New passcode: <b className="tabular-nums">{spaced(rotated.pass)}</b> — shown once here. Send it separately from the link.
                </small>
              )}
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn variant="solid" size="sm" icon="share" onClick={() => void shareNew()}>Share the new link</Btn>
            <Btn variant="ghost" size="sm" onClick={() => onRotatedDone?.()}>Done</Btn>
          </div>
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
            <Btn variant="soft" size="sm" icon={share?.on ? 'sliders' : 'link'} onClick={() => void invite('link')}>{share?.on ? 'Manage' : 'Share a link'}</Btn>
          </div>
        </div>
      )}

      {isParent && viewers.length > 1 && (
        confirm === 'end' ? (
          <div className="inline-confirm" role="group" aria-label="End other sessions">
            <span>Disconnect everyone else watching right now? Members can rejoin; guests can rejoin while their pass is valid.</span>
            <div className="row" style={{ gap: 8 }}>
              <Btn variant="danger" size="sm" onClick={() => void endOthers()}>End other sessions</Btn>
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
