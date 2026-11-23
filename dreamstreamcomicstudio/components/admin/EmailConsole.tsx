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
import { PRODUCT_IDS, PRODUCT_LABELS, type ProductId } from '../../services/productAccess';
import { cn } from '../../lib/utils';
import { Button, IconButton } from '../ds';
import { DENSITY, FIELD, MUTED, OVERLINE, STATUS_CHIP, STATUS_CHIP_TONE, STATUS_INK, STATUS_SURFACE, TONE_TEXT, type StatusState } from '../chat/studioDesign';

// Textareas keep their own minimum height; only single-line controls take the touch floor.
const fieldBase = cn(FIELD, 'w-full px-3 py-2 text-sm');
const inputCls = cn(fieldBase, DENSITY.coarse);
const labelCls = cn(OVERLINE, 'mb-1 block');

type Tab = 'compose' | 'invite' | 'log';

// One status vocabulary for the delivery log (always beside the word).
const statusTone = (s: string): StatusState =>
  s === 'sent' ? 'healthy' : s === 'failed' || s === 'rate_limited' ? 'error' : s === 'suppressed' || s === 'skipped' ? 'attention' : 'waiting';

const statusLabel: Record<string, string> = {
  sent: 'Provider accepted', queued: 'Queued', failed: 'Failed', suppressed: 'Suppressed', skipped: 'Skipped', rate_limited: 'Rate limited'
};

function ReceiptTime({ timestamp }: { timestamp?: string | null }) {
  if (timestamp === undefined) return <>Unavailable</>;
  return timestamp ? <time dateTime={timestamp}>{new Date(timestamp).toLocaleString()}</time> : <>No record</>;
}

function activityTotals(rows: EmailLogRow[]) {
  const accepted = rows.filter(row => row.status === 'sent').length;
  const imageRequests = rows.filter(row => row.opened_at).length;
  const acknowledgements = rows.some(row => row.acknowledged_at === undefined)
    ? 'Acknowledgement data unavailable'
    : `${rows.filter(row => row.acknowledged_at).length} acknowledged via link`;
  return `Showing ${rows.length} logged requests · ${accepted} provider accepted · ${imageRequests} with an image request · ${acknowledgements}`;
}

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
  const campaignBlocked = template === 'product-update' && !usage?.broadcast?.configured;
  const [recipients, setRecipients] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Invite state
  const [inv, setInv] = useState({ email: '', inviterName: '', personalNote: '', maxUses: 1, expiresInDays: 30 });
  // Studios the invite unlocks. All selected (default) = full account; a subset confines
  // the redeemed account to those studios and the email marks the rest "coming soon".
  const [invProducts, setInvProducts] = useState<ProductId[]>([...PRODUCT_IDS]);
  const [invResult, setInvResult] = useState<Awaited<ReturnType<typeof adminInviteByEmail>> | null>(null);
  const [copied, setCopied] = useState(false);

  const toggleInvProduct = (product: ProductId) =>
    setInvProducts((prev) => (prev.includes(product) ? prev.filter((p) => p !== product) : [...prev, product]));

  // Log state
  const [log, setLog] = useState<EmailLogRow[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
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
    setLogError(null);
    try {
      const res = await getEmailLog(50);
      setLog(res.items || []);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : 'Failed to load activity');
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
    return [`${ok} accepted by provider`, ...(skipped.length ? [`skipped — ${skipped.join(', ')}`] : []), ...(failed.length ? [`failed — ${failed.join(', ')}`] : [])].join(' · ');
  };

  const doTest = async () => {
    setBusy('test');
    setResult(null);
    setError(null);
    try {
      const o = await sendTestEmail(template, params());
      setResult(o.ok ? `Provider accepted the test for ${o.to}` : `Test ${o.skipped || o.error} (${o.to})`);
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
    if (invProducts.length === 0) {
      setError('Pick at least one studio for the invite.');
      return;
    }
    setBusy('invite');
    setInvResult(null);
    setError(null);
    try {
      const r = await adminInviteByEmail(inv.email, {
        inviterName: inv.inviterName || undefined,
        personalNote: inv.personalNote || undefined,
        maxUses: inv.maxUses,
        expiresInDays: inv.expiresInDays,
        products: invProducts
      });
      if (r.ok || r.code) setInvResult(r);
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
        <div className={cn('flex items-center gap-2 rounded-[var(--ds-radius-control)] border px-3 py-2 text-sm', STATUS_SURFACE.attention, 'text-[var(--ds-ink)]')}>
          <AlertTriangle size={16} className={cn('shrink-0', STATUS_INK.attention)} aria-hidden /> Transactional email needs EMAIL_WORKER_URL and EMAIL_HMAC_SECRET. Preview is available.
        </div>
      ) : (
        usage && (
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-xs font-medium tabular-nums">
            <span>This month: {usage.month}/{usage.maxPerMonth} ({usage.monthPct}%)</span>
            <span>Today: {usage.day}/{usage.maxPerDay}</span>
            {usage.maxPerMonth > 0 && <span>Monthly allowance remaining: {Math.max(0, usage.maxPerMonth - usage.month)}</span>}
            {usage.monthPct >= 80 && <span className={TONE_TEXT.danger}>⚠ near monthly cap</span>}
          </div>
        )
      )}

      {template === 'product-update' && tab === 'compose' && (
        <p className={cn('text-sm', MUTED)} role="status">
          {!usage?.broadcast?.enabled ? 'Product-update delivery is off.' : usage.broadcast.configured
            ? 'Postmark Broadcast is configured. Each send checks the stream, confirmed subscription and suppression status.'
            : `Product-update configuration needs ${usage.broadcast.missing.join(', ')}.`}
        </p>
      )}

      {error && <div className={cn('rounded-[var(--ds-radius-control)] border px-3 py-2 text-sm [overflow-wrap:anywhere]', STATUS_SURFACE.error, STATUS_INK.error)}>{error}</div>}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1">
        {([['compose', 'Compose', Mail], ['invite', 'Invite by email', Ticket], ['log', 'Activity log', RefreshCw]] as const).map(
          ([id, label, Icon]) => (
            <Button
              key={id}
              variant="ghost"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={tab === id ? 'bg-[var(--ds-active)] text-[var(--ds-ink)]' : MUTED}
            >
              <Icon size={14} aria-hidden /> {label}
            </Button>
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
              <textarea className={cn(fieldBase, 'min-h-[120px]')} value={fields.body} onChange={(e) => setFields({ ...fields, body: e.target.value })} />
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
              <Button variant="outline" onClick={doPreview} disabled={busy === 'preview'}>
                {busy === 'preview' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Eye size={14} />} Preview
              </Button>
              <Button variant="outline" onClick={doTest} disabled={busy === 'test' || campaignBlocked}>
                {busy === 'test' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Send size={14} />} Send test to me
              </Button>
            </div>
            <div>
              <label className={labelCls}>Recipients (comma / newline separated, ≤100)</label>
              <textarea
                className={cn(fieldBase, 'min-h-[60px] text-sm')}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="a@example.com, b@example.com"
              />
              <Button className="mt-2" onClick={doSend} disabled={busy === 'send' || !recipients.trim() || campaignBlocked}>
                {busy === 'send' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Send size={14} />} Send to recipients
              </Button>
            </div>
            {result && <div className={cn('rounded-[var(--ds-radius-control)] border px-3 py-2 text-sm text-[var(--ds-ink)] [overflow-wrap:anywhere]', STATUS_SURFACE.healthy)}>{result}</div>}
          </div>

          {/* Live preview */}
          <div>
            <label className={labelCls}>Preview {preview ? `— ${preview.subject}` : ''}</label>
            <div className="overflow-hidden rounded-[var(--ds-radius-panel)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)]" style={{ height: 520 }}>
              {preview ? (
                <iframe title="email preview" sandbox="" srcDoc={preview.html} className="w-full h-full" />
              ) : (
                <div className={cn('flex h-full items-center justify-center text-sm', MUTED)}>Click “Preview” to render</div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'invite' && (
        <div className="max-w-xl space-y-3">
          <div>
            <label className={labelCls} htmlFor="email-invite-recipient">Friend's email</label>
            <input id="email-invite-recipient" className={inputCls} value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder="them@example.com" />
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
            <textarea className={cn(fieldBase, 'min-h-[60px]')} value={inv.personalNote} onChange={(e) => setInv({ ...inv, personalNote: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Studios this invite unlocks</label>
            <div className="flex flex-wrap gap-2">
              {PRODUCT_IDS.map((product) => {
                const on = invProducts.includes(product);
                return (
                  <label
                    key={product}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-[var(--ds-radius-control)] border px-2.5 py-1.5 text-xs font-medium transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]',
                      DENSITY.coarse,
                      on ? 'border-[var(--ds-control-border)] bg-[var(--ds-active)] text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'
                    )}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleInvProduct(product)} className="h-3.5 w-3.5 accent-[var(--ds-accent)]" />
                    {PRODUCT_LABELS[product]}
                  </label>
                );
              })}
            </div>
            <p className={cn('mt-1 text-[11px]', MUTED)}>
              {invProducts.length === PRODUCT_IDS.length
                ? 'All studios — full account access; the email features everything.'
                : invProducts.length === 0
                  ? 'Pick at least one studio.'
                  : `On redeem the account gets exactly ${invProducts.map((p) => PRODUCT_LABELS[p]).join(' + ')}; the email features ${invProducts.length === 1 ? 'it' : 'them'} and marks the rest "coming soon".`}
            </p>
          </div>
          <Button onClick={doInvite} disabled={busy === 'invite' || !inv.email.trim() || invProducts.length === 0}>
            {busy === 'invite' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Ticket size={14} />} Create &amp; send invite
          </Button>
          {invResult && (
            <div className={cn('space-y-2 rounded-[var(--ds-radius-panel)] border p-3 text-sm text-[var(--ds-ink)]', invResult.ok ? STATUS_SURFACE.healthy : STATUS_SURFACE.attention)} role="status">
              <div>Invite <strong>{invResult.code}</strong> created. {invResult.ok ? 'Email accepted by provider.' : `Email delivery was not confirmed (${invResult.skipped || invResult.error || 'unknown result'}).`}</div>
              {invResult.products && (
                <div className={cn('text-xs', MUTED)}>
                  {invResult.confined
                    ? `Unlocks only: ${invResult.products.map((p) => PRODUCT_LABELS[p as ProductId] ?? p).join(', ')} (account is confined to these on redeem).`
                    : 'Unlocks the full account (all studios).'}
                </div>
              )}
              <div className="flex items-center gap-2">
                <input readOnly className={cn(inputCls, 'min-w-0 font-mono text-xs')} value={invResult.inviteUrl} />
                <IconButton variant="outline" size="lg" label="Copy invite link" onClick={() => copy(invResult.inviteUrl)}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'log' && (
        <div className="space-y-2">
          <Button variant="outline" onClick={refreshLog} disabled={logLoading}>
            {logLoading ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <RefreshCw size={14} />} Refresh
          </Button>
          <p className={cn('text-sm', MUTED)}>
            Provider acceptance records the handoff to the sending service. Inbox delivery is unverified.
            Mail apps can load tracking images automatically. Acknowledgement records a submitted confirmation from the email link.
          </p>
          {logError && <p role="alert" className={cn('text-sm', TONE_TEXT.danger)}>{logError}</p>}
          <p role="status" className="text-sm">
            {logLoading ? 'Loading email activity…' : log?.length
              ? activityTotals(log)
              : log && !logError ? 'No email activity yet.' : ''}
          </p>
          {Boolean(log?.length) && (
            <div role="region" aria-label="Message activity details" tabIndex={0} className="overflow-x-auto rounded-[var(--ds-radius-panel)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Recent email requests and the first recorded receipt events. Times are local.</caption>
                <thead className="bg-[var(--ds-well)] font-semibold text-[var(--ds-muted)]">
                  <tr>
                    {['Requested', 'To', 'Template', 'Send status', 'First image request', 'Acknowledged via link'].map(label => (
                      <th key={label} scope="col" className="px-2 py-2">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {log?.map((r) => (
                    <tr key={r.id} className="border-t border-[var(--ds-hairline-soft)]">
                      <td className="px-2 py-2 whitespace-nowrap"><ReceiptTime timestamp={r.created_at} /></td>
                      <td className="px-2 py-2 font-mono">{r.to_email}</td>
                      <td className="px-2 py-2">{r.template}</td>
                      <td className="px-2 py-2">
                        <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE[statusTone(r.status)])}>{statusLabel[r.status] || r.status}</span>
                        {r.error && <details className="mt-1"><summary className="cursor-pointer">Details</summary>{r.error}</details>}
                      </td>
                      <td className="px-2 py-2"><ReceiptTime timestamp={r.opened_at} /></td>
                      <td className="px-2 py-2"><ReceiptTime timestamp={r.acknowledged_at} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
