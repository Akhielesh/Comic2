import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw, Plus, Copy, Check, Ban, Ticket } from 'lucide-react';
import { generateInvites, listInvites, revokeInvite, type InviteRecord } from '../../services/invites';

const statusTone = (s: string) =>
  s === 'active' ? 'bg-green-100 text-green-700'
    : s === 'redeemed' ? 'bg-slate-200 text-slate-600'
      : 'bg-red-100 text-red-700';

export const InviteManager: React.FC = () => {
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [count, setCount] = useState(10);
  const [label, setLabel] = useState('BYOK testers');
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInDays, setExpiresInDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listInvites();
      setInvites(res.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load invites');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      await generateInvites({ count, label: label || undefined, maxUses, expiresInDays: expiresInDays || undefined });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate invites');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setBusy(true);
    try { await revokeInvite(id); await load(); } catch { /* surfaced on reload */ } finally { setBusy(false); }
  };

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(code); setTimeout(() => setCopied(null), 1500); } catch { /* noop */ }
  };

  const copyAllActive = async () => {
    const codes = invites.filter((i) => i.status === 'active').map((i) => i.code).join('\n');
    if (codes) { await navigator.clipboard.writeText(codes); setCopied('ALL'); setTimeout(() => setCopied(null), 1500); }
  };

  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-slate-500">
        Generate invite codes and share them with testers out-of-band (email/DM). A signed-in user redeems a code in
        Settings; redemptions are tracked here. BYOK already works for any signed-in user.
      </p>

      <div className="border-2 border-black rounded-xl bg-slate-50 p-3 flex flex-wrap items-end gap-3">
        <label className="text-xs font-bold">How many
          <input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))}
            className="block mt-1 w-20 border-2 border-black rounded-md px-2 py-1 bg-white" />
        </label>
        <label className="text-xs font-bold">Label
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            className="block mt-1 w-40 border-2 border-black rounded-md px-2 py-1 bg-white" />
        </label>
        <label className="text-xs font-bold">Uses each
          <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}
            className="block mt-1 w-20 border-2 border-black rounded-md px-2 py-1 bg-white" />
        </label>
        <label className="text-xs font-bold">Expires (days)
          <input type="number" min={0} value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}
            className="block mt-1 w-24 border-2 border-black rounded-md px-2 py-1 bg-white" />
        </label>
        <button onClick={() => void handleGenerate()} disabled={busy}
          className="flex items-center gap-1 text-sm font-bold border-2 border-black rounded-md px-3 py-1.5 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Generate
        </button>
      </div>

      {error && <div className="border-2 border-red-400 bg-red-50 text-red-700 rounded-lg px-3 py-2 text-xs font-bold">{error}</div>}

      <div className="flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-500 flex items-center gap-1">
          <Ticket className="w-3.5 h-3.5" /> Invites ({invites.length})
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void copyAllActive()} className="text-xs font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100 flex items-center gap-1">
            {copied === 'ALL' ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />} Copy active
          </button>
          <button onClick={() => void load()} className="text-xs font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100 flex items-center gap-1">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
          </button>
        </div>
      </div>

      <div className="border-2 border-black rounded-xl bg-white divide-y-2 divide-slate-100 max-h-96 overflow-y-auto">
        {invites.length === 0 && !loading && <div className="p-3 text-xs text-slate-400">No invites yet — generate a batch above.</div>}
        {invites.map((i) => (
          <div key={i.id} className="p-2.5 text-xs">
            <div className="flex items-center gap-2">
              <code className="font-mono font-bold">{i.code}</code>
              <button onClick={() => void copy(i.code)} title="Copy code" className="text-slate-400 hover:text-black">
                {copied === i.code ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <span className={`px-1.5 py-0.5 rounded font-bold ${statusTone(i.status)}`}>{i.status}</span>
              <span className="text-slate-500 tabular-nums">{i.use_count}/{i.max_uses} used</span>
              {i.label && <span className="text-slate-400 truncate">{i.label}</span>}
              <span className="ml-auto text-slate-300 tabular-nums">{new Date(i.created_at).toLocaleDateString()}</span>
              {i.status !== 'revoked' && (
                <button onClick={() => void handleRevoke(i.id)} disabled={busy} title="Revoke" className="text-slate-400 hover:text-brand-red disabled:opacity-40">
                  <Ban className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {/* Delivery + redemption timeline: sent to whom/when → who joined when. */}
            {((i.recipients?.length ?? 0) > 0 || (i.redeemedBy?.length ?? 0) > 0) && (
              <div className="mt-1.5 ml-1 space-y-0.5 border-l-2 border-slate-100 pl-2">
                {(i.recipients ?? []).map((r) => {
                  const joined = (i.redeemedBy ?? []).find((d) => d.email && d.email.toLowerCase() === r.email.toLowerCase());
                  return (
                    <div key={r.email} className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                      <span className="font-mono">{r.email}</span>
                      <span>
                        sent {new Date(r.last_sent_at).toLocaleDateString()}
                        {r.send_count > 1 ? ` (${r.send_count}×)` : ''} via {r.kind}
                      </span>
                      {joined ? (
                        <span className="font-bold text-green-700">joined {new Date(joined.redeemed_at).toLocaleDateString()}</span>
                      ) : (
                        <span className="text-slate-400">not joined yet</span>
                      )}
                    </div>
                  );
                })}
                {(i.redeemedBy ?? [])
                  .filter((d) => !d.email || !(i.recipients ?? []).some((r) => r.email.toLowerCase() === d.email!.toLowerCase()))
                  .map((d, idx) => (
                    <div key={`${d.user_id || d.email || idx}`} className="text-[11px] text-slate-500">
                      <span className="font-mono">{d.email || d.user_id || 'unknown user'}</span>{' '}
                      <span className="font-bold text-green-700">joined {new Date(d.redeemed_at).toLocaleDateString()}</span>{' '}
                      <span className="text-slate-400">via code/link</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
