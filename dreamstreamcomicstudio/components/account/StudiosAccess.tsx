// "Your studios" on the DreamStream account page — the same per-studio access
// Stream Studio shows (GET /api/account/studios): what's yours now, and the one
// step to unlock the rest.
import React, { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Lock, MessageSquare, Radio, Baby } from 'lucide-react';
import { fetchAccountAccess, onAccountAccessChange, type AccountAccess, type StudioAccess } from '../../services/studioAccessApi';
import { followLiveLink } from '../../services/liveLink';
import { isStreamUrl } from '../../shared/streamHost';
import { cn } from '../../lib/utils';
import {
  DENSITY,
  FOCUS_RING,
  MUTED,
  RADIUS_CONTROL,
  SECTION_CARD,
  SECTION_ICON_TILE,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  type StatusState
} from '../chat/studioDesign';

const ICON: Record<StudioAccess['id'], React.ComponentType<{ size?: number }>> = {
  comic_studio: BookOpen,
  chat_studio: MessageSquare,
  stream_studio: Radio,
  baby_monitor: Baby,
};

// The one status vocabulary (studioDesign STATUS_*): the word and the icon always say it, the hue only repeats it.
const BADGE: Record<StudioAccess['status'], { text: string; state: StatusState; Icon: React.ComponentType<{ size?: number }> }> = {
  open: { text: 'Yours', state: 'healthy', Icon: Check },
  needs_code: { text: 'One step', state: 'attention', Icon: Lock },
  locked: { text: 'Locked', state: 'waiting', Icon: Lock },
};

export const StudiosAccess: React.FC = () => {
  const [data, setData] = useState<AccountAccess | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () => void fetchAccountAccess().then((d) => alive && setData(d));
    load();
    // Re-read when the account changes (e.g. the name was just saved above).
    const off = onAccountAccessChange(load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <div className={SECTION_CARD} data-testid="studios-access">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--ds-hairline)] px-4 py-3">
        <span className="text-[length:var(--ds-text-lg)] font-semibold leading-6 text-[var(--ds-ink)]">Your studios</span>
        <span className={cn('text-[length:var(--ds-text-sm)]', MUTED)}>One account for every DreamStream studio</span>
      </div>
      {data === undefined ? (
        <div className={cn('p-4 text-[length:var(--ds-text-base)]', MUTED)}>Loading…</div>
      ) : data === null ? (
        <div className={cn('p-4 text-[length:var(--ds-text-base)]', MUTED)}>Couldn’t load your studios right now.</div>
      ) : (
        <ul className="divide-y divide-[var(--ds-hairline)]">
          {data.studios.map((s) => {
            const I = ICON[s.id];
            const b = BADGE[s.status];
            const href = s.status === 'open' ? s.href : s.action?.href;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span className={cn(SECTION_ICON_TILE, 'size-10', s.status === 'open' ? '' : MUTED)} aria-hidden="true">
                  <I size={18} />
                </span>
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block font-semibold text-[var(--ds-ink)]">{s.label}</span>
                  <span className={cn('block text-[length:var(--ds-text-sm)] [overflow-wrap:anywhere]', MUTED)}>{s.status === 'open' ? `${s.tagline} · ${s.detail}` : s.detail}</span>
                </span>
                <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE[b.state])}>
                  <b.Icon size={11} />{b.text}
                </span>
                {href && (
                  <a
                    href={href}
                    // Stream Studio on its own host: arrive there signed in (one-time handoff link).
                    onClick={isStreamUrl(href) ? (e) => followLiveLink(e, href) : undefined}
                    className={cn('inline-flex min-h-8 min-w-8 items-center justify-center gap-1 px-1.5 text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline', RADIUS_CONTROL, DENSITY.coarseSquare, FOCUS_RING)} aria-label={s.status === 'open' ? `Open ${s.label}` : s.action?.label}>
                    {s.status === 'open' ? <ArrowRight size={16} /> : s.action?.label}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data?.confined && <div className={cn('px-4 pb-3 text-[length:var(--ds-text-sm)]', MUTED)}>An admin set which studios this account can use.</div>}
    </div>
  );
};
