// "Your studios" on the DreamStream account page — the same per-studio access
// Stream Studio shows (GET /api/account/studios): what's yours now, and the one
// step to unlock the rest.
import React, { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Clock, Lock, MessageSquare, Monitor, Radio, Baby } from 'lucide-react';
import { fetchAccountAccess, type AccountAccess, type StudioAccess } from '../../services/studioAccessApi';

const ICON: Record<StudioAccess['id'], React.ComponentType<{ size?: number }>> = {
  comic_studio: BookOpen,
  chat_studio: MessageSquare,
  stream_studio: Radio,
  baby_monitor: Baby,
  code_studio: Monitor,
};

const BADGE: Record<StudioAccess['status'], { text: string; cls: string; Icon: React.ComponentType<{ size?: number }> }> = {
  open: { text: 'Yours', cls: 'bg-emerald-50 text-emerald-700 border-emerald-300', Icon: Check },
  needs_code: { text: 'One step', cls: 'bg-amber-50 text-amber-800 border-amber-300', Icon: Lock },
  locked: { text: 'Locked', cls: 'bg-slate-100 text-slate-600 border-slate-300', Icon: Lock },
  retiring: { text: 'Retiring', cls: 'bg-slate-100 text-slate-500 border-slate-300', Icon: Clock },
};

export const StudiosAccess: React.FC = () => {
  const [data, setData] = useState<AccountAccess | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void fetchAccountAccess().then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="border-2 border-black rounded-xl bg-white" data-testid="studios-access">
      <div className="px-4 py-3 border-b-2 border-black flex items-baseline gap-3 flex-wrap">
        <span className="font-display text-lg">Your studios</span>
        <span className="text-xs text-slate-500">One account for every DreamStream studio</span>
      </div>
      {data === undefined ? (
        <div className="p-4 text-sm text-slate-500">Loading…</div>
      ) : data === null ? (
        <div className="p-4 text-sm text-slate-500">Couldn’t load your studios right now.</div>
      ) : (
        <ul className="divide-y divide-slate-200">
          {data.studios.map((s) => {
            const I = ICON[s.id];
            const b = BADGE[s.status];
            const href = s.status === 'open' || s.status === 'retiring' ? s.href : s.action?.href;
            return (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <span className={`w-10 h-10 rounded-xl grid place-items-center border-2 ${s.status === 'open' ? 'border-black bg-brand-yellow' : 'border-slate-300 bg-slate-50 text-slate-500'}`}>
                  <I size={18} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-bold">{s.label}</span>
                  <span className="block text-xs text-slate-600">{s.status === 'open' ? `${s.tagline} · ${s.detail}` : s.detail}</span>
                </span>
                <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border ${b.cls}`}>
                  <b.Icon size={11} />{b.text}
                </span>
                {href && (
                  <a href={href} className="inline-flex items-center gap-1 text-sm font-bold underline-offset-2 hover:underline" aria-label={s.status === 'open' ? `Open ${s.label}` : s.action?.label}>
                    {s.status === 'open' || s.status === 'retiring' ? <ArrowRight size={16} /> : s.action?.label}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data?.confined && <div className="px-4 pb-3 text-xs text-slate-500">An admin set which studios this account can use.</div>}
    </div>
  );
};
