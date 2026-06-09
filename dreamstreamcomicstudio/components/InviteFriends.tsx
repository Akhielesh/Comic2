import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Copy, Check, Send, Gift } from 'lucide-react';
import { getReferral, sendReferral, type ReferralInfo } from '../services/invites';

const inputCls =
  'w-full rounded-lg border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue';
const btnCls =
  'inline-flex items-center justify-center gap-2 rounded-lg border-2 border-black px-4 py-2 text-sm font-bold shadow-comic transition-all hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60';

/** Lets any signed-in user share their personal referral link or email it to friends. */
export const InviteFriends: React.FC = () => {
  const [ref, setRef] = useState<ReferralInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [emails, setEmails] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRef(await getReferral());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your invite link');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async () => {
    if (!ref) return;
    try {
      await navigator.clipboard.writeText(ref.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  const handleSend = async () => {
    if (!emails.trim()) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const res = await sendReferral(emails, note || undefined);
      const failed = res.results.filter((r) => !r.ok);
      setMsg(`Sent ${res.sent} invite${res.sent === 1 ? '' : 's'}${failed.length ? ` · ${failed.length} skipped` : ''} 🎉`);
      setEmails('');
      setNote('');
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send invites');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <p className="text-sm text-slate-600 flex items-center gap-2">
        <Gift size={16} className="text-brand-blue" /> Share DreamStream with friends — they skip the waitlist when they use your link.
      </p>

      {error && <div className="rounded-lg border-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div>
        <label className="block text-xs font-bold uppercase tracking-wide text-slate-600 mb-1">Your invite link</label>
        <div className="flex items-center gap-2">
          <input readOnly className={`${inputCls} font-mono text-xs`} value={loading ? 'Loading…' : ref?.url || ''} />
          <button className={`${btnCls} bg-brand-yellow`} onClick={copy} disabled={!ref}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {ref && (
          <div className="mt-1 text-xs text-slate-500">
            Used {ref.used} of {ref.max}.
          </div>
        )}
      </div>

      <div className="border-t-2 border-dashed border-slate-300 pt-3 space-y-2">
        <label className="block text-xs font-bold uppercase tracking-wide text-slate-600">Or email them directly (up to 10)</label>
        <textarea
          className={`${inputCls} min-h-[60px] font-mono text-xs`}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="friend@example.com, another@example.com"
        />
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a short personal note (optional)" maxLength={240} />
        <button className={`${btnCls} bg-brand-blue text-white`} onClick={handleSend} disabled={busy || !emails.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send invites
        </button>
        {msg && <div className="rounded-lg border-2 border-black bg-green-50 px-3 py-2 text-sm">{msg}</div>}
      </div>
    </div>
  );
};
