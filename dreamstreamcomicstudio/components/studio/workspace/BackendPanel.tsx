// BackendPanel — "connect a real backend to this app".
//
// Lets the user wire their OWN Supabase project (URL + anon key) so the generated app gets a
// persistent database/auth they control. On connect it drops a `.env.local` + a typed
// `supabaseClient.ts` into the workspace (so the app — and future AI refines — can use it) and
// remembers the connection per project. No provisioning/billing, no infra dependency.

import React, { useEffect, useState } from 'react';
import { Database, Check, Plug, X, ChevronDown, ChevronRight } from 'lucide-react';
import { useStudioTheme } from '../kit';
import { getBackend, setBackend, isValidSupabaseUrl, supabaseScaffold, type StudioBackend } from '../../../services/studioBackend';

export interface BackendPanelProps {
  projectId?: string | null;
  /** Inject the scaffold files into the workspace + react to a new connection. */
  onConnect: (files: { path: string; content: string }[], conn: StudioBackend) => void;
}

export const BackendPanel: React.FC<BackendPanelProps> = ({ projectId, onConnect }) => {
  const t = useStudioTheme();
  const [conn, setConn] = useState<StudioBackend | null>(() => getBackend(projectId));
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setConn(getBackend(projectId)); }, [projectId]);

  const connect = () => {
    if (!isValidSupabaseUrl(url)) { setError('Enter your Supabase project URL (https://xxxx.supabase.co).'); return; }
    if (anonKey.trim().length < 20) { setError('Paste your project anon (public) key.'); return; }
    const next: StudioBackend = { provider: 'supabase', url: url.trim().replace(/\/$/, ''), anonKey: anonKey.trim() };
    setBackend(projectId, next);
    setConn(next);
    setOpen(false);
    setError(null);
    onConnect(supabaseScaffold(next.url, next.anonKey), next);
  };

  const disconnect = () => { setBackend(projectId, null); setConn(null); setUrl(''); setAnonKey(''); };

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className={`rounded-lg border ${t.edge} ${t.panel} overflow-hidden`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 px-3 py-2 ${t.panelAlt} ${t.hover} ${t.focusRing}`}
        aria-expanded={open}
      >
        <Database className={`w-3.5 h-3.5 ${conn ? 'text-emerald-500' : t.accent}`} />
        <span className={`text-[11px] font-bold uppercase tracking-wide ${t.textDim}`}>Backend</span>
        {conn ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-500">
            <Check className="w-3 h-3" /> Supabase connected
          </span>
        ) : (
          <span className={`text-[10px] ${t.textFaint}`}>connect a database</span>
        )}
        <Chevron className={`ml-auto w-4 h-4 ${t.textFaint}`} />
      </button>

      {open && (
        <div className="p-3 space-y-2">
          {conn ? (
            <div className="space-y-2">
              <p className={`text-[11px] ${t.textDim}`}>
                Connected to <span className="font-mono">{conn.url.replace('https://', '')}</span>. Your app reads it from
                <span className="font-mono"> .env.local</span> via <span className="font-mono">lib/supabaseClient.ts</span> — refine with “save/load data from my Supabase backend”.
              </p>
              <button
                onClick={disconnect}
                className={`inline-flex items-center gap-1.5 rounded-full border ${t.edge} px-2.5 py-1 text-[11px] font-semibold ${t.textDim} ${t.hover} ${t.focusRing}`}
              >
                <X className="w-3.5 h-3.5" /> Disconnect
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className={`text-[11px] ${t.textFaint}`}>
                Bring your own Supabase project (free tier works). Paste its URL + anon key — we’ll wire it into the app.
              </p>
              <input
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(null); }}
                placeholder="https://your-project.supabase.co"
                aria-label="Supabase project URL"
                aria-invalid={!!error}
                autoComplete="off"
                spellCheck={false}
                className={`w-full rounded-lg border ${t.edge} ${t.panelAlt} ${t.text} text-xs px-2.5 py-2 ${t.focusRing}`}
              />
              <input
                value={anonKey}
                onChange={(e) => { setAnonKey(e.target.value); setError(null); }}
                placeholder="anon public key"
                type="password"
                aria-label="Supabase anon (public) key"
                aria-invalid={!!error}
                autoComplete="off"
                className={`w-full rounded-lg border ${t.edge} ${t.panelAlt} ${t.text} text-xs px-2.5 py-2 ${t.focusRing}`}
              />
              {error && <p className="text-[11px] font-medium text-rose-500">{error}</p>}
              <button
                onClick={connect}
                className={`inline-flex items-center gap-1.5 rounded-full ${t.accentBg} ${t.accentText} px-3 py-1.5 text-[11px] font-bold ${t.accentBgHover} ${t.focusRing}`}
              >
                <Plug className="w-3.5 h-3.5" /> Connect Supabase
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
