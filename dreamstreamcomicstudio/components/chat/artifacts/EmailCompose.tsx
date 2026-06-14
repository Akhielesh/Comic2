import React, { useMemo, useState } from 'react';
import { PenSquare, ExternalLink, Copy, Check, Mail } from 'lucide-react';
import type { EmailComposeArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// Compose widget — the read-only Gmail connection means we DON'T send for the user;
// we draft the message (editable) and hand off via a one-click Gmail compose link
// (or mailto). The links recompute live as the user edits the fields.

const enc = (s: string): string => encodeURIComponent(s || '');

const gmailComposeUrl = (d: { to?: string; cc?: string; subject?: string; body?: string }): string => {
  const q = [`to=${enc(d.to || '')}`, d.cc ? `cc=${enc(d.cc)}` : '', `su=${enc(d.subject || '')}`, `body=${enc(d.body || '')}`]
    .filter(Boolean)
    .join('&');
  return `https://mail.google.com/mail/?view=cm&fs=1&${q}`;
};
const mailtoUrl = (d: { to?: string; cc?: string; subject?: string; body?: string }): string => {
  const q = [d.cc ? `cc=${enc(d.cc)}` : '', `subject=${enc(d.subject || '')}`, `body=${enc(d.body || '')}`].filter(Boolean).join('&');
  return `mailto:${enc(d.to || '')}?${q}`;
};

const fieldCls =
  'w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1.5 text-[13px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/40';

export const EmailCompose: React.FC<{ data: EmailComposeArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [to, setTo] = useState(data.to || '');
  const [cc, setCc] = useState(data.cc || '');
  const [subject, setSubject] = useState(data.subject || '');
  const [body, setBody] = useState(data.body || '');
  const [showCc, setShowCc] = useState(Boolean(data.cc));
  const [copied, setCopied] = useState(false);

  const gmailUrl = useMemo(() => gmailComposeUrl({ to, cc, subject, body }), [to, cc, subject, body]);
  const mailto = useMemo(() => mailtoUrl({ to, cc, subject, body }), [to, cc, subject, body]);

  const copy = () => {
    const text = `To: ${to}\n${cc ? `Cc: ${cc}\n` : ''}Subject: ${subject}\n\n${body}`;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  if (compact) {
    return (
      <Surface
        header={
          <span className="flex min-w-0 items-center gap-1.5">
            <PenSquare className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
            <SurfaceTitle>Email draft</SurfaceTitle>
          </span>
        }
        right={<SurfaceSubtitle>{to || 'no recipient'}</SurfaceSubtitle>}
      >
        <div className="border-t border-[var(--ds-hairline-soft)] px-3 py-2">
          <p className="truncate text-[12px] font-medium text-[var(--ds-ink)]">{subject || '(no subject)'}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ds-muted)]">{body || 'Empty body'}</p>
          <a
            href={gmailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)]"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open in Gmail
          </a>
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      header={
        <span className="flex min-w-0 items-center gap-1.5">
          <PenSquare className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" />
          <SurfaceTitle>New email</SurfaceTitle>
        </span>
      }
      right={data.account ? <SurfaceSubtitle>from {data.account}</SurfaceSubtitle> : undefined}
    >
      <div className="space-y-2 border-t border-[var(--ds-hairline-soft)] px-3 py-3">
        <div className="flex items-center gap-2">
          <label className="w-12 shrink-0 text-[11px] font-medium text-[var(--ds-muted)]">To</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" className={fieldCls} />
          {!showCc && (
            <button onClick={() => setShowCc(true)} className="shrink-0 text-[11px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">
              Cc
            </button>
          )}
        </div>
        {showCc && (
          <div className="flex items-center gap-2">
            <label className="w-12 shrink-0 text-[11px] font-medium text-[var(--ds-muted)]">Cc</label>
            <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="cc@example.com" className={fieldCls} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="w-12 shrink-0 text-[11px] font-medium text-[var(--ds-muted)]">Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className={fieldCls} />
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder="Write your message…"
          className={`${fieldCls} min-h-[160px] resize-y leading-relaxed`}
        />

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <a
            href={gmailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)]"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open in Gmail
          </a>
          <a
            href={mailto}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
          >
            <Mail className="h-3.5 w-3.5" /> Mail app
          </a>
          <button
            onClick={copy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-[10px] text-[var(--ds-faint)]">Read-only connection — opens in Gmail for you to review &amp; send.</p>
      </div>
    </Surface>
  );
};
