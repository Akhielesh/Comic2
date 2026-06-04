import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, XCircle, Activity, Plug, Gauge, RefreshCw, Info } from 'lucide-react';
import type { SystemDashboard as Dash } from '../../apiTypes';
import { getSystemDashboard } from '../../services/chatApi';

const StatusDot: React.FC<{ status: 'ok' | 'degraded' | 'unavailable' }> = ({ status }) => {
  if (status === 'ok') return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
  if (status === 'degraded') return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  return <XCircle className="w-4 h-4 text-red-600" />;
};

const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <div>
    <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500 mb-1.5">{icon} {title}</div>
    {children}
  </div>
);

export const SystemDashboard: React.FC = () => {
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    getSystemDashboard()
      .then((d) => setData(d))
      .catch((e) => setError(e?.message?.includes('403') || e?.message?.includes('401') ? 'Admin access required to view system metrics.' : (e?.message || 'Failed to load.')))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-brand-blue" /></div>;
  if (error) return <div className="text-sm text-slate-500 text-center py-10 border-2 border-dashed border-slate-200 rounded-lg">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-400">
          v{data.version.appVersion} · {data.version.gitSha?.slice(0, 7)} · {new Date(data.generatedAt).toLocaleTimeString()}
        </span>
        <button onClick={load} className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-full px-2 py-0.5 hover:bg-brand-yellow"><RefreshCw className="w-3 h-3" /> Refresh</button>
      </div>

      <Section icon={<Activity className="w-3.5 h-3.5" />} title="Capabilities">
        <ul className="space-y-1">
          {data.capabilities.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5"><StatusDot status={c.status} /></span>
              <span className="min-w-0">
                <span className="font-bold">{c.label}</span>
                <span className="block text-[11px] text-slate-500">{c.detail}{c.envVar && c.status !== 'ok' ? ` · add ${c.envVar}` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={<Plug className="w-3.5 h-3.5" />} title="Live tool-API health">
        <div className="grid sm:grid-cols-2 gap-1.5">
          {data.toolHealth.map((t) => (
            <div key={t.id} className="flex items-center gap-2 border-2 border-black rounded-lg px-2.5 py-1.5 text-sm">
              {t.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <XCircle className="w-4 h-4 text-red-600 shrink-0" />}
              <span className="font-bold truncate flex-1">{t.label}</span>
              <span className="text-[11px] text-slate-500">{t.ok ? `${t.latencyMs}ms` : (t.error || `HTTP ${t.status}`)}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={<Gauge className="w-3.5 h-3.5" />} title="Dependencies & limits">
        <ul className="space-y-1.5">
          {data.dependencies.map((d) => (
            <li key={d.id} className="border-2 border-black rounded-lg px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm flex-1">{d.label}</span>
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${d.connected ? 'border-emerald-300 text-emerald-700' : 'border-slate-300 text-slate-500'}`}>
                  {d.connected ? 'connected' : 'not connected'}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">{d.freeTier}</div>
              {d.live ? (
                <div className="text-[11px] font-bold text-slate-700 mt-0.5">
                  {d.live.label}: {d.live.used ?? '—'}{d.live.limit ? ` / ${d.live.limit}` : ''} {d.live.detail || ''}
                </div>
              ) : d.envVar && !d.connected ? (
                <div className="text-[11px] text-amber-700 mt-0.5 flex items-center gap-1"><Info className="w-3 h-3" /> Add <span className="font-bold">{d.envVar}</span> for live usage.</div>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={<Gauge className="w-3.5 h-3.5" />} title="Rate limits">
        <div className="flex flex-wrap gap-2">
          {data.rateLimits.map((r) => (
            <span key={r.scope} className="text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-0.5">
              {r.scope}: {r.perWindow}/{Math.round(r.windowMs / 1000)}s
            </span>
          ))}
        </div>
      </Section>

      {data.recentNotices.length > 0 && (
        <Section icon={<AlertTriangle className="w-3.5 h-3.5" />} title={`Recent capability gaps (${data.recentNotices.length})`}>
          <ul className="space-y-1">
            {data.recentNotices.slice(0, 15).map((n, i) => (
              <li key={i} className="text-[11px] flex items-start gap-1.5">
                <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${n.level === 'error' ? 'bg-red-500' : 'bg-amber-500'}`} />
                <span><span className="font-bold">{n.tool || 'system'}</span>: {n.message}{n.at ? ` · ${new Date(n.at).toLocaleTimeString()}` : ''}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
};
