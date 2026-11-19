import React, { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, Loader2, Copy, Check, Send, Gift } from 'lucide-react';
import { getReferral, sendReferral, type ReferralInfo } from '../services/invites';
import { cn } from '../lib/utils';
import { Button, FIELD_LABEL, Input, Textarea } from './ds';
import { MUTED, OVERLINE, RADIUS_CONTROL, STATUS_CHIP, STATUS_CHIP_TONE, STATUS_INK, STATUS_SURFACE, WRAP_TEXT } from './chat/studioDesign';

const NOTE = cn('flex items-start gap-2 border px-3 py-2 text-[length:var(--ds-text-base)]', RADIUS_CONTROL);

/** Lets any signed-in user share their personal referral link or email it to friends. */
export const InviteFriends: React.FC = () => {
  const [ref, setRef] = useState<ReferralInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [emails, setEmails] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const linkId = `${ids}-link`;
  const copyWhyId = `${ids}-copy-why`;
  const emailsId = `${ids}-emails`;

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
    setDetails([]);
    setError(null);
    try {
      const res = await sendReferral(emails, note || undefined);
      const alreadyMembers = res.results.filter((r) => r.status === 'already-member');
      const failed = res.results.filter((r) => !r.ok && r.status !== 'already-member');
      const parts = [`Sent ${res.sent} invite${res.sent === 1 ? '' : 's'}`];
      if (alreadyMembers.length) parts.push(`${alreadyMembers.length} already a member`);
      if (failed.length) parts.push(`${failed.length} skipped`);
      setMsg(`${parts.join(' · ')}${res.sent > 0 ? ' 🎉' : ''}`);
      setDetails([
        ...alreadyMembers.map((r) => `${r.to} — already a member, no invite needed`),
        ...failed.map((r) => `${r.to} — not sent${r.error ? ` (${r.error})` : ''}`)
      ]);
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
      <p className={cn('flex items-center gap-2 text-[length:var(--ds-text-base)]', MUTED)}>
        <Gift size={16} className="shrink-0 text-[var(--ds-ink)]" aria-hidden="true" /> Share DreamStream with friends — they skip the waitlist when they use your link.
      </p>

      {error && (
        <div className={cn(NOTE, STATUS_SURFACE.error, STATUS_INK.error)}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className={WRAP_TEXT}>{error}</span>
        </div>
      )}

      <div>
        <label htmlFor={linkId} className={cn('mb-1.5 block', FIELD_LABEL)}>Your invite link</label>
        <div className="flex items-center gap-2">
          <Input id={linkId} readOnly className="min-w-0 font-mono md:text-[length:var(--ds-text-sm)]" value={loading ? 'Loading…' : ref?.url || ''} />
          <Button variant="outline" className="h-10" onClick={copy} disabled={!ref} aria-describedby={ref ? undefined : copyWhyId}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {/* A disabled Copy says why: the link is still loading, or it could not be loaded. */}
        {!ref && (
          <div id={copyWhyId} className={cn('mt-1 text-[length:var(--ds-text-sm)]', MUTED)}>
            {loading ? 'No link to copy yet: it is still loading.' : 'No link to copy: your invite link could not be loaded.'}
          </div>
        )}
        {ref && (
          <div className={cn('mt-1 text-[length:var(--ds-text-sm)] tabular-nums', MUTED)}>
            Used {ref.used} of {ref.max}.
          </div>
        )}
      </div>

      {/* What happened to the invites you sent: invited or joined, nothing more. */}
      {ref && ((ref.invited?.length ?? 0) > 0 || (ref.joinedViaLink ?? 0) > 0) && (
        <div className="border-t border-[var(--ds-hairline)] pt-3">
          <div className={cn('mb-1.5', OVERLINE)}>Your invites</div>
          <div className={cn('max-h-44 divide-y divide-[var(--ds-hairline)] overflow-y-auto border border-[var(--ds-hairline)] bg-[var(--ds-canvas)]', RADIUS_CONTROL)}>
            {(ref.invited ?? []).map((inv) => (
              <div key={inv.email} className="flex items-center gap-2 px-3 py-1.5 text-[length:var(--ds-text-sm)] text-[var(--ds-ink)]">
                <span className="min-w-0 flex-1 truncate font-mono">{inv.email}</span>
                {inv.joined ? (
                  <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE.healthy, 'shrink-0')}>
                    Joined{inv.joinedAt ? ` ${new Date(inv.joinedAt).toLocaleDateString()}` : ''}
                  </span>
                ) : (
                  <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE.waiting, 'shrink-0')} title={`Invited ${new Date(inv.lastSentAt).toLocaleDateString()}${inv.sendCount > 1 ? ` · sent ${inv.sendCount}×` : ''}`}>
                    Invited
                  </span>
                )}
              </div>
            ))}
            {(ref.joinedViaLink ?? 0) > 0 && (
              <div className={cn('px-3 py-1.5 text-[length:var(--ds-text-sm)]', MUTED)}>
                +{ref.joinedViaLink} joined via your link
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-[var(--ds-hairline)] pt-3">
        <label htmlFor={emailsId} className={cn('block', FIELD_LABEL)}>Or email them directly (up to 10)</label>
        <Textarea
          id={emailsId}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="Email addresses, separated by commas"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="A short personal note (optional)"
          placeholder="Personal note (optional)"
          maxLength={240}
        />
        <Button onClick={handleSend} disabled={busy || !emails.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Send size={14} />} Send invites
        </Button>
        {msg && (
          <div className={cn(NOTE, 'flex-col gap-0', STATUS_SURFACE.healthy, 'text-[var(--ds-ink)]')}>
            <div className="flex items-center gap-2"><Check size={16} className={cn('shrink-0', STATUS_INK.healthy)} aria-hidden="true" /><span className={WRAP_TEXT}>{msg}</span></div>
            {details.length > 0 && (
              <ul className={cn('mt-1 space-y-0.5 font-mono text-[length:var(--ds-text-sm)]', MUTED, WRAP_TEXT)}>
                {details.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
