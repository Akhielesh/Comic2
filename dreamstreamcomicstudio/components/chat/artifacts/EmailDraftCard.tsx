import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, Link2, Mail, PenSquare, Plus } from 'lucide-react';
import { emailComposeLinks, type EmailDraftArtifact } from '../../../apiTypes';
import type { FlaggedRecipient } from '../../../packages/platform-core/src/contract/email';
import { Surface, SurfaceSubtitle, SurfaceTitle, useCompact } from './kit';
import {
  CHIP,
  CHIP_VARIANT,
  CONTROL_BTN,
  FOCUS_RING,
  OVERLINE,
  PRESS,
  PRIMARY_BTN,
  RADIUS_CONTROL,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_INK,
  STATUS_SURFACE
} from '../studioDesign';

// An email the chat model drafted with `email_draft` (server: ai/tools/platformTools.ts; plan §7). Agents draft,
// people send: this card has no Send control and makes no call. It shows
//  • the recipients the review allowed (the addresses the person typed) and, apart, every address the model added on
//    its own, flagged "Suggested by AI — not added": such an address enters the compose links only when the person
//    taps Add;
//  • a preview of the rendered email in a `sandbox=""` srcdoc iframe under a CSP (no script, no network: data: images
//    and inline styles only); links inside the preview do not open;
//  • every link with its full address;
//  • Open in Gmail / Open in mail app (the person's own client, from the allowed recipients) and Copy text.
// No amount is shown: the draft is made of the chat turn's own output, already counted in this chat's usage (plan
// §5.5), so the usage line names no price, and governed people never see '$' here.

/** The preview's Content Security Policy (pw1-email note 3): nothing loads, only data: images and inline styles. */
export const EMAIL_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** A meta refresh would navigate the sandboxed frame (navigation is not a resource the CSP can block). */
const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi;

/**
 * The rendered email as a srcdoc: the CSP first in <head>, links aimed at a blocked new tab (they stay inert), and no
 * meta refresh. renderEmail never writes one; this holds even for a stored artifact someone edited.
 */
export const emailPreviewSrcDoc = (html: string): string => {
  const guard = `<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}"><base target="_blank">`;
  const source = (typeof html === 'string' ? html : '').replace(META_REFRESH, '');
  const head = /<head(?:\s[^>]*)?>/i.exec(source); // <head> or <head …>, never <header>
  if (head) return source.slice(0, head.index + head[0].length) + guard + source.slice(head.index + head[0].length);
  return `<!DOCTYPE html><html><head>${guard}</head><body>${source}</body></html>`;
};

/**
 * The preview iframe's attributes (also what the platform conformance kit checks): `sandbox=""` (no scripts, no
 * same-origin, no forms, no popups, no top navigation), a srcdoc (never a src), and no referrer.
 */
export const emailPreviewAttributes = (html = ''): { sandbox: string; srcDoc: string; title: string; referrerPolicy: 'no-referrer' } => ({
  sandbox: '',
  srcDoc: emailPreviewSrcDoc(html),
  title: 'Email preview',
  referrerPolicy: 'no-referrer'
});

const MODE_LABEL: Record<string, string> = { compose: 'New email', reply: 'Reply', 'reply-all': 'Reply all', forward: 'Forward' };
const FLAG_REASON: Record<string, string> = {
  'model-only': 'Suggested by AI — not added',
  pasted: 'From pasted text — not added'
};
const FIELD_LABEL = { to: 'To', cc: 'Cc', bcc: 'Bcc' } as const;

/** CHIP / STATUS_CHIP that may wrap: an address or a note can be longer than a 320 px card is wide. */
const WRAP_CHIP = CHIP.replace('whitespace-nowrap', 'whitespace-normal');
const WRAP_STATUS_CHIP = STATUS_CHIP.replace('whitespace-nowrap', 'whitespace-normal');

const ACTION = `inline-flex min-h-[44px] items-center justify-center gap-1.5 px-3 text-[13px] font-medium ${RADIUS_CONTROL} ${FOCUS_RING} ${PRESS}`;

type Field = 'to' | 'cc' | 'bcc';
interface Recipient {
  address: string;
  name?: string;
  field: Field;
  addedByYou?: boolean;
}

const key = (f: Pick<FlaggedRecipient, 'address' | 'field'>): string => `${f.field}:${f.address.toLowerCase()}`;

const OPENABLE = /^(https:\/\/|mailto:)/i;
/** The review lists only https: and mailto: links; anything else (an edited artifact) is shown as text, never linked. */
export const openableHref = (href: unknown): string | undefined => (typeof href === 'string' && OPENABLE.test(href) ? href : undefined);

export const EmailDraftCard: React.FC<{ data: EmailDraftArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [added, setAdded] = useState<string[]>([]);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const review = data.review || { prefill: { to: [], cc: [], bcc: [] }, flagged: [], links: [], warnings: [] };
  const doc = data.doc;
  const reply = doc?.mode === 'reply' || doc?.mode === 'reply-all';

  const recipients = useMemo<Recipient[]>(() => {
    const out: Recipient[] = [];
    for (const field of ['to', 'cc', 'bcc'] as Field[]) for (const r of review.prefill[field] || []) out.push({ address: r.address, name: r.name, field });
    for (const f of review.flagged || []) if (added.includes(key(f))) out.push({ address: f.address, field: f.field, addedByYou: true });
    return out;
  }, [review, added]);
  const flagged = (review.flagged || []).filter((f) => !added.includes(key(f)));

  // Only the allowed recipients and the ones the person tapped ever reach a link.
  const links = useMemo(
    () =>
      emailComposeLinks({
        to: recipients.filter((r) => r.field === 'to').map((r) => r.address),
        cc: recipients.filter((r) => r.field === 'cc').map((r) => r.address),
        bcc: recipients.filter((r) => r.field === 'bcc').map((r) => r.address),
        subject: doc?.subject || '',
        body: data.text || ''
      }),
    [recipients, doc?.subject, data.text]
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.text || '');
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied(null), 1600);
  };

  const subject = doc?.subject || '(no subject)';
  const mode = MODE_LABEL[doc?.mode || 'compose'] || 'Email';
  const usage = "Included in this chat's usage — no extra model call. Nothing is sent from here.";

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <a href={links.gmailUrl} target="_blank" rel="noopener noreferrer" className={`${ACTION} ${PRIMARY_BTN}`}>
        <ExternalLink className="h-4 w-4 shrink-0" aria-hidden /> Open in Gmail
      </a>
      <a href={links.mailto} className={`${ACTION} ${CONTROL_BTN} text-[var(--ds-ink)]`}>
        <Mail className="h-4 w-4 shrink-0" aria-hidden /> Open in mail app
      </a>
      <button type="button" onClick={copy} className={`${ACTION} ${CONTROL_BTN} text-[var(--ds-ink)]`}>
        {copied === 'ok' ? <Check className={`h-4 w-4 shrink-0 ${STATUS_INK.healthy}`} aria-hidden /> : <Copy className="h-4 w-4 shrink-0" aria-hidden />}
        {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy text'}
      </button>
    </div>
  );

  const header = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-well-strong)] text-[var(--ds-ink)]">
        <PenSquare className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <SurfaceTitle>Email draft</SurfaceTitle>
        <SurfaceSubtitle>{subject}</SurfaceSubtitle>
      </span>
    </span>
  );

  if (compact) {
    return (
      <Surface header={header} right={<span className={`${CHIP} ${CHIP_VARIANT.outline}`}>{mode}</span>}>
        <div className="space-y-2 border-t border-[var(--ds-hairline-soft)] px-3 py-2">
          <p className="text-[12px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
            {reply ? 'Your mail app picks the recipients.' : recipients.length ? recipients.map((r) => r.address).join(', ') : 'No recipients filled in yet.'}
            {flagged.length ? ` · ${flagged.length} suggested, not added` : ''}
          </p>
          {actions}
        </div>
      </Surface>
    );
  }

  return (
    <Surface header={header} right={<span className={`${CHIP} ${CHIP_VARIANT.outline}`}>{mode}</span>} footer={<p className="text-[11px] leading-4 text-[var(--ds-muted)]">{usage}</p>}>
      <div className="min-w-0 space-y-3 border-t border-[var(--ds-hairline-soft)] px-3 py-3">
        <section aria-label="Recipients" className="min-w-0 space-y-1.5">
          <h4 className={OVERLINE}>Recipients</h4>
          {reply ? (
            // The review's own 'reply-recipients' note says the same thing; say it once.
            (review.warnings || []).some((w) => w.code === 'reply-recipients') ? null : (
              <p className="text-[12px] leading-5 text-[var(--ds-muted)]">In a reply your mail app chooses the recipients, so none are filled in.</p>
            )
          ) : recipients.length === 0 ? (
            <p className="text-[12px] leading-5 text-[var(--ds-muted)]">None filled in. Add them in your mail app, or tap a suggestion below.</p>
          ) : null}
          {recipients.length > 0 && (
            <ul className="flex min-w-0 flex-wrap gap-1.5">
              {recipients.map((r) => (
                <li key={`${r.field}:${r.address}`} className={`${WRAP_CHIP} ${CHIP_VARIANT.filled}`}>
                  <span className="text-[var(--ds-muted)]">{FIELD_LABEL[r.field]}</span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{r.name ? `${r.name} <${r.address}>` : r.address}</span>
                  {r.addedByYou && <span className="text-[var(--ds-muted)]">· added by you</span>}
                </li>
              ))}
            </ul>
          )}
          {flagged.length > 0 && (
            <ul className="min-w-0 space-y-1.5" aria-label="Suggested addresses, not added">
              {flagged.map((f) => (
                <li key={key(f)} className={`flex min-w-0 items-center gap-2 border px-2.5 py-1 ${RADIUS_CONTROL} ${STATUS_SURFACE.attention}`}>
                  <AlertTriangle className={`h-4 w-4 shrink-0 ${STATUS_INK.attention}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-[var(--ds-ink)] [overflow-wrap:anywhere]">
                      {FIELD_LABEL[f.field]}: {f.address}
                    </span>
                    <span className={`block text-[11px] leading-4 ${STATUS_INK.attention}`}>{FLAG_REASON[f.reason] || 'Not added'}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setAdded((xs) => (xs.includes(key(f)) ? xs : [...xs, key(f)]))}
                    aria-label={`Add ${f.address}`}
                    className={`${ACTION} ${CONTROL_BTN} min-w-[44px] shrink-0 px-2.5 text-[var(--ds-ink)]`}
                  >
                    <Plus className="h-4 w-4" aria-hidden /> Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {review.warnings && review.warnings.length > 0 && (
          <ul className="min-w-0 space-y-1" aria-label="Review notes">
            {review.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className={`${WRAP_STATUS_CHIP} ${STATUS_CHIP_TONE.attention}`}>
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 [overflow-wrap:anywhere]">{w.message}</span>
              </li>
            ))}
          </ul>
        )}

        <section aria-label="Preview" className="min-w-0 space-y-1">
          <h4 className={OVERLINE}>Preview</h4>
          <iframe {...emailPreviewAttributes(data.html)} className={`block h-[360px] w-full border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] ${RADIUS_CONTROL}`} />
          <p className="text-[11px] leading-4 text-[var(--ds-muted)]">Links in the preview don't open. Each one is listed below with its full address.</p>
        </section>

        {review.links && review.links.length > 0 && (
          <section aria-label="Links" className="min-w-0 space-y-1">
            <h4 className={OVERLINE}>Links</h4>
            <ul className="min-w-0 space-y-1">
              {review.links.map((l, i) => (
                <li key={`${l.blockId}-${i}`} className="flex min-w-0 items-start gap-2 text-[12px] leading-5">
                  <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />
                  <span className="min-w-0">
                    <span className="text-[var(--ds-ink)]">{l.text || '(no text)'}</span>{' '}
                    {openableHref(l.href) ? (
                      <a href={openableHref(l.href)} target="_blank" rel="noopener noreferrer" className={`break-all text-[var(--ds-accent-text)] underline underline-offset-2 ${FOCUS_RING}`}>
                        {l.href}
                      </a>
                    ) : (
                      <span className="break-all text-[var(--ds-muted)]">{String(l.href)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(!links.bodyInGmail || !links.bodyInMailto) && (
          <p className={`text-[12px] leading-5 ${STATUS_INK.attention}`}>
            The text is too long to travel in {!links.bodyInGmail ? 'a Gmail link' : 'a mail-app link'}: tap Copy text and paste it into the message.
          </p>
        )}
        {actions}
      </div>
    </Surface>
  );
};
