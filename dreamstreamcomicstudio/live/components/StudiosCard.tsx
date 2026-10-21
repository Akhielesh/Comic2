// "Your studios" — one account, every DreamStream studio: what you can use now and
// the one step to unlock the rest. The same answer the main app shows
// (GET /api/account/studios), so the two can never disagree.
import React, { useEffect, useState } from 'react';
import { fetchAccountAccess, type AccountAccess, type StudioAccess } from '@/services/studioAccessApi';
import { useAccount } from '../account';
import { Icon } from '../ui/icons';
import { cx } from '../ui/primitives';

const ICON: Record<StudioAccess['id'], string> = {
  comic_studio: 'book',
  chat_studio: 'chat',
  stream_studio: 'broadcast',
  baby_monitor: 'baby',
  code_studio: 'monitor',
};
const BADGE: Record<StudioAccess['status'], { text: string; icon: string }> = {
  open: { text: 'Yours', icon: 'check' },
  needs_code: { text: 'One step', icon: 'lock' },
  locked: { text: 'Locked', icon: 'lock' },
  retiring: { text: 'Retiring', icon: 'clock' },
};

/** Shared by the Settings card and the account menu. */
export function useAccountAccess(): AccountAccess | null | undefined {
  const account = useAccount();
  const [data, setData] = useState<AccountAccess | null | undefined>(undefined);
  useEffect(() => {
    if (account.status !== 'member' && account.status !== 'needs_code') {
      setData(null);
      return;
    }
    let alive = true;
    void fetchAccountAccess().then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [account.status, account.userId]);
  return data;
}

/** Opens a studio — Stream Studio routes stay in this app, the rest open the main app. */
function go(href: string): void {
  if (href.startsWith('/live#')) {
    location.hash = href.slice('/live'.length);
    return;
  }
  location.assign(href);
}

export function StudiosCard({ compact }: { compact?: boolean }) {
  const data = useAccountAccess();
  if (data === undefined) return <div className="skeleton" style={{ height: compact ? 44 : 180 }} aria-label="Loading your studios" />;
  if (data === null) return compact ? null : <p className="faint" style={{ fontSize: 13 }}>Couldn’t load your studios right now.</p>;
  if (compact) {
    return (
      <div className="studio-chips" aria-label="Your studios">
        {data.studios.map((s) => (
          <button key={s.id} className={cx('studio-chip', `st-${s.status}`)} onClick={() => go(s.action?.href ?? s.href)} title={`${s.label} — ${s.detail}`}>
            <Icon name={ICON[s.id]} size={14} />
            <span>{s.label.replace(' & family calls', '')}</span>
            <i aria-label={BADGE[s.status].text} />
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="studios-card" data-tour="your-studios">
      <div className="studios-head">
        <b>Your studios</b>
        <span className="faint">One DreamStream account{data.account.plan && data.account.plan !== 'free' ? ` · ${data.account.plan} plan` : ''}{data.account.admin ? ' · admin' : ''}</span>
      </div>
      <div className="studios-list">
        {data.studios.map((s) => (
          <div key={s.id} className={cx('studio-row', `st-${s.status}`)}>
            <span className="studio-ic"><Icon name={ICON[s.id]} size={18} /></span>
            <span className="studio-txt">
              <b>{s.label}</b>
              <small>{s.status === 'open' ? s.tagline : s.detail}</small>
              {s.status === 'open' && s.detail && <small className="studio-detail">{s.detail}</small>}
            </span>
            <span className={cx('studio-badge', `st-${s.status}`)}><Icon name={BADGE[s.status].icon} size={12} />{BADGE[s.status].text}</span>
            {s.status === 'open' || s.status === 'retiring' ? (
              <button className="studio-go" onClick={() => go(s.action?.href ?? s.href)} aria-label={`Open ${s.label}`}><Icon name="arrowRight" size={16} /></button>
            ) : s.action ? (
              <button className="studio-act" onClick={() => go(s.action!.href)}>{s.action.label}</button>
            ) : null}
          </div>
        ))}
      </div>
      {data.confined && <p className="faint studios-note">An admin set which studios this account can use.</p>}
    </div>
  );
}
