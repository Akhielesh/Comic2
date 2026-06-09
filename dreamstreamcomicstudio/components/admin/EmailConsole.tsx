import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Eye, Send, Mail, Ticket, Copy, Check, AlertTriangle } from 'lucide-react';
import {
  listEmailTemplates,
  previewEmail,
  sendTestEmail,
  sendEmailBroadcast,
  adminInviteByEmail,
  getEmailUsage,
  getEmailLog,
  type EmailTemplateInfo,
  type EmailPreview,
  type EmailUsage,
  type EmailLogRow,
  type SendOutcome
} from '../../services/adminEmail';

const inputCls =
  'w-full rounded-lg border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue';
const labelCls = 'block text-xs font-bold uppercase tracking-wide text-slate-600 mb-1';
const btnCls =
  'inline-flex items-center justify-center gap-2 rounded-lg border-2 border-black px-4 py-2 text-sm font-bold shadow-comic transition-all hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60';

type Tab = 'compose' | 'invite' | 'log';

const statusTone = (s: string) =>
  s === 'sent'
    ? 'bg-green-100 text-green-700'
    : s === 'failed' || s === 'rate_limited'
      ? 'bg-red-100 text-red-700'
      : s === 'suppressed' || s === 'skipped'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-slate-200 text-slate-600';

export const EmailConsole: React.FC = () => {
  const [tab, setTab] = useState<Tab>('compose');
  const [configured, setConfigured] = useState(true);
  const [templates, setTemplates] = useState<EmailTemplateInfo[]>([]);
  const [usage, setUsage] = useState<EmailUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Compose state
  const composable = useMemo(() => templates.filter((t) => t.composable), [templates]);
  const [template, setTemplate] = useState('announcement');
  const [fields, setFields] = useState({ subject: '', heading: '', body: '', ctaLabel: '', ctaUrl: '', firstName: '' });
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [recipients, setRecipients] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Invite state
  const [inv, setInv] = useState({ email: '', inviterName: '', personalNote: '', maxUses: 1, expiresInDays: 30 });
  const [invResult, setInvResult] = useState<{ code: string; inviteUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Log state
  const [log, setLog] = useState<EmailLogRow[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  const params = useCallback(
    () => ({
      subject: fields.subject || undefined,
      heading: fields.heading || undefined,
      title: fields.heading || undefined, // product-update uses `title`; announcement uses `heading`
      body: fields.body || undefined,
      ctaLabel: fields.ctaLabel || undefined,
      ctaUrl: fields.ctaUrl || undefined,
      firstName: fields.firstName || undefined
    }),
    [fields]
  );

  const loadMeta = useCallback(async () => {
    setError(null);
    try {
      const [t, u] = await Promise.all([listEmailTemplates(), getEmailUsage()]);
      setTemplates(t.templates || []);
      setConfigured(t.configured);
      setUsage(u);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load email console');
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const refreshLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const res = await getEmailLog(50);
      setLog(res.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load log');
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'log') void refreshLog();
  }, [tab, refreshLog]);

  const doPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      setPreview(await previewEmail(template, params()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(null);
    }
  };

  const summarize = (outcomes: SendOutcome[]) => {
    const ok = outcomes.filter((o) => o.ok).length;
    const skipped = outcomes.filter((o) => !o.ok && o.skipped).map((o) => `${o.to}: ${o.skipped}`);
    const failed = outcomes.filter((o) => !o.ok && o.error).map((o) => `${o.to}: ${o.error}`);
    return [`${ok} sent`, ...(skipped.length ? [`skipped — ${skipped.join(', ')}`] : []), ...(failed.length ? [`failed — ${failed.join(', ')}`] : [])].join(' · ');
  };

  const doTest = async () => {
    setBusy('test');
    setResult(null);
    setError(null);
    try {
      const o = await sendTestEmail(template, params());
      setResult(o.ok ? `Test sent to ${o.to} ✓` : `Test ${o.skipped || o.error} (${o.to})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test send failed');
    } finally {
      setBusy(null);
    }
  };

  const doSend = async () => {
    if (!recipients.trim()) return;
    if (!window.confirm(`Send "${template}" to these recipients now?`)) return;
    setBusy('send');
    setResult(null);
    setError(null);
    try {
      const res = await sendEmailBroadcast(template, params(), recipients);
      setResult(summarize(res.results));
      if (tab !== 'log') void getEmailUsage().then(setUsage);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setBusy(null);
    }
  };

  const doInvite = async () => {
    if (!inv.email.trim()) return;
    setBusy('invite');
    setInvResult(null);
    setError(null);
    try {
      const r = await adminInviteByEmail(inv.email, {
        inviterName: inv.inviterName || undefined,
        personalNote: inv.personalNote || undefined,
        maxUses: inv.maxUses,
        expiresInDays: inv.expiresInDays
      });
      if (r.ok || r.code) setInvResult({ code: r.code, inviteUrl: r.inviteUrl });
      else setError(r.error || r.skipped || 'Invite failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invite failed');
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="p-4 space-y-4">
      {/* Usage / config banner */}
      {!configured ? (
        <div className="flex items-center gap-2 rounded-lg border-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle size={16} /> Email isn't configured yet (EMAIL_WORKER_URL / EMAIL_HMAC_SECRET unset). Composing works; sends are skipped. See docs/email/SETUP.md.
        </div>
      ) : (
        usage && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-black bg-slate-50 px-3 py-2 text-xs font-bold">
            <span>This month: {usage.month}/{usage.maxPerMonth} ({usage.monthPct}%)</span>
            <span>Today: {usage.day}/{usage.maxPerDay}</span>
            <span className={usage.freeTierRemaining > 0 ? 'text-green-700' : 'text-red-700'}>
              Free tier left: {usage.freeTierRemaining}
            </span>
            {usage.monthPct >= 80 && <span className="text-red-700">⚠ near monthly cap</span>}
          </div>
        )
      )}

      {error && <div className="rounded-lg border-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {/* Tabs */}
      <div className="flex gap-2">
        {([['compose', 'Compose', Mail], ['invite', 'Invite by email', Ticket], ['log', 'Activity log', RefreshCw]] as const).map(
          ([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`${btnCls} ${tab === id ? 'bg-brand-yellow' : 'bg-white'}`}
            >
              <Icon size={14} /> {label}
            </button>
          )
        )}
      </div>

      {tab === 'compose' && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Template</label>
              <select className={inputCls} value={template} onChange={(e) => setTemplate(e.target.value)}>
                {composable.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.kind})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Subject (optional override)</label>
              <input className={inputCls} value={fields.subject} onChange={(e) => setFields({ ...fields, subject: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Heading / Title</label>
              <input className={inputCls} value={fields.heading} onChange={(e) => setFields({ ...fields, heading: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Body</label>
              <textarea className={`${inputCls} min-h-[120px]`} value={fields.body} onChange={(e) => setFields({ ...fields, body: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Button label</label>
                <input className={inputCls} value={fields.ctaLabel} onChange={(e) => setFields({ ...fields, ctaLabel: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Button URL</label>
                <input className={inputCls} value={fields.ctaUrl} onChange={(e) => setFields({ ...fields, ctaUrl: e.target.value })} placeholder="https://…" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={`${btnCls} bg-white`} onClick={doPreview} disabled={busy === 'preview'}>
                {busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} Preview
              </button>
              <button className={`${btnCls} bg-brand-blue text-white`} onClick={doTest} disabled={busy === 'test'}>
                {busy === 'test' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test to me
              </button>
            </div>
            <div>
              <label className={labelCls}>Recipients (comma / newline separated, ≤100)</label>
              <textarea
                className={`${inputCls} min-h-[60px] font-mono text-xs`}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="a@example.com, b@example.com"
              />
              <button className={`${btnCls} bg-brand-yellow mt-2`} onClick={doSend} disabled={busy === 'send' || !recipients.trim()}>
                {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send to recipients
              </button>
            </div>
            {result && <div className="rounded-lg border-2 border-black bg-green-50 px-3 py-2 text-sm">{result}</div>}
          </div>

          {/* Live preview */}
          <div>
            <label className={labelCls}>Preview {preview ? `— ${preview.subject}` : ''}</label>
            <div className="rounded-lg border-2 border-black overflow-hidden bg-white" style={{ height: 520 }}>
              {preview ? (
                <iframe title="email preview" sandbox="" srcDoc={preview.html} className="w-full h-full" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">Click “Preview” to render</div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'invite' && (
        <div className="max-w-xl space-y-3">
          <div>
            <label className={labelCls}>Friend's email</label>
            <input className={inputCls} value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder="them@example.com" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Your name (optional)</label>
              <input className={inputCls} value={inv.inviterName} onChange={(e) => setInv({ ...inv, inviterName: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Max uses</label>
              <input type="number" min={1} className={inputCls} value={inv.maxUses} onChange={(e) => setInv({ ...inv, maxUses: Number(e.target.value) || 1 })} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Personal note (optional)</label>
            <textarea className={`${inputCls} min-h-[60px]`} value={inv.personalNote} onChange={(e) => setInv({ ...inv, personalNote: e.target.value })} />
          </div>
          <button className={`${btnCls} bg-brand-yellow`} onClick={doInvite} disabled={busy === 'invite' || !inv.email.trim()}>
            {busy === 'invite' ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} />} Create &amp; send invite
          </button>
          {invResult && (
            <div className="space-y-2 rounded-lg border-2 border-black bg-green-50 p-3 text-sm">
              <div>Invite <strong>{invResult.code}</strong> created &amp; emailed.</div>
              <div className="flex items-center gap-2">
                <input readOnly className={`${inputCls} font-mono text-xs`} value={invResult.inviteUrl} />
                <button className={`${btnCls} bg-white`} onClick={() => copy(invResult.inviteUrl)}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'log' && (
        <div className="space-y-2">
          <button className={`${btnCls} bg-white`} onClick={refreshLog} disabled={logLoading}>
            {logLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
          <div className="overflow-x-auto rounded-lg border-2 border-black">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 font-bold">
                <tr>
                  <th className="px-2 py-1">When</th>
                  <th className="px-2 py-1">To</th>
                  <th className="px-2 py-1">Template</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Opened</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r) => (
                  <tr key={r.id} className="border-t border-slate-200">
                    <td className="px-2 py-1 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-2 py-1 font-mono">{r.to_email}</td>
                    <td className="px-2 py-1">{r.template}</td>
                    <td className="px-2 py-1">
                      <span className={`rounded-full px-2 py-0.5 font-bold ${statusTone(r.status)}`}>{r.status}</span>
                      {r.error && <span className="ml-1 text-red-600" title={r.error}>!</span>}
                    </td>
                    <td className="px-2 py-1">{r.opened_at ? '✓' : '—'}</td>
                  </tr>
                ))}
                {!log.length && (
                  <tr>
                    <td colSpan={5} className="px-2 py-4 text-center text-slate-400">
                      No email activity yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
