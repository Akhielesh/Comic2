/**
 * `reviewEmail(doc, ctx)` → `{prefill, flagged, links, warnings}` (plan §7): what a composer may fill in, and what a
 * person must look at, before a draft goes anywhere. Agents draft; humans send; nothing here can send.
 *
 * Recipients:
 * - Trusted addresses are the thread's header participants and the addresses the user typed in their OWN
 *   instruction (`ctx.userTyped`). An address that also appears in text the user pasted (`ctx.pasted`) is not
 *   trusted on that basis; a header participant stays trusted.
 * - A trusted recipient is pre-filled (with the participant's own display name, never one the model wrote). Any other
 *   recipient is `flagged` ("Suggested by AI — not added") and never pre-filled.
 * - In the reply modes the mail provider decides the recipients: the prefill is empty, and an untrusted address the
 *   draft names is still flagged.
 *
 * Links: every `https:`/`mailto:` link (run or button, columns included) is listed with its full URL, in document
 * order, exactly as `renderEmail` writes it. A dropped (unsafe) link, a link whose text names another site, and a
 * `mailto:` link to an untrusted address are warnings. (A `mailto:` link's recipients are its path alone: `check()`
 * allows only `subject` and `body` in its query.)
 */
import {
  EMAIL_LIMITS,
  type EmailDoc,
  type EmailPrefill,
  type EmailRecipient,
  type EmailReview,
  type EmailReviewContext,
  type EmailWarning,
  type FlaggedRecipient,
  type ReviewedLink,
} from '../contract/email.js';
import { check, isSafeHref } from '../schema/check.js';
import { s } from '../schema/s.js';
import { emailToPlainText } from './plainText.js';
import { readDoc, type ReadBlock, type ReadRun } from './read.js';

/** Every warning `reviewEmail` can give, with what it means. Codes are stable. */
export const EMAIL_WARNING_CODES = {
  'reply-recipients': 'In a reply your mail app chooses the recipients, so the draft fills in none of its own.',
  'invalid-recipient': 'A recipient is not one plain email address, so it was left out.',
  'duplicate-recipient': 'A recipient appears more than once; only the first is used.',
  'mode-mismatch': 'The draft names a different mode (compose, reply, reply-all, forward) than the one the person chose; the choice is used.',
  'unsafe-link': 'A link that was not https: or mailto: was removed; its text stays.',
  'link-text-mismatch': 'A link shows one address but goes to another.',
  'mailto-untrusted': 'A link starts a new email to an address that is not in the thread and that you did not type.',
  'body-too-long': `The text is longer than ${EMAIL_LIMITS.field} characters, so a composer may cut it.`,
  'attachments-separate': 'Attachments are prepared separately by the app; they are not part of this text.',
} as const;

export type EmailWarningCode = keyof typeof EMAIL_WARNING_CODES;

const EMAIL = s.email();
const isAddress = (v: unknown): v is string => typeof v === 'string' && check(EMAIL, v).ok === true;
const norm = (v: string): string => v.trim().toLowerCase();

const short = (v: string, max = 80): string => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

/** The recipients a safe `mailto:` href addresses (its path; the query can carry only subject and body). */
export const mailtoRecipients = (href: string): string[] => {
  if (typeof href !== 'string' || href.lastIndexOf('mailto:', 0) !== 0 || !isSafeHref(href)) return [];
  const path = href.slice('mailto:'.length).split('?')[0];
  return path ? path.split(',').filter((a) => a !== '') : [];
};

/** Text longer than this is not scanned for addresses (an instruction is at most a few thousand characters). */
const ADDRESS_SCAN_MAX = 100000;

/**
 * The plain email addresses in a piece of text (lower-cased, de-duplicated, in order, at most
 * `EMAIL_LIMITS.recipients`). For a host deriving `ctx.userTyped` from the user's OWN instruction only. Linear: the
 * text is split on spaces and punctuation that never occurs in an address, and each piece is checked whole.
 */
export const addressesIn = (text: string): string[] => {
  const out: string[] = [];
  if (typeof text !== 'string') return out;
  for (const piece of text.slice(0, ADDRESS_SCAN_MAX).split(/[\s,;:<>()"'`\[\]{}|\\/!?*&=^~#$]+/)) {
    if (piece.indexOf('@') === -1) continue;
    const a = norm(piece.replace(/^[.]+|[.]+$/g, ''));
    if (isAddress(a) && out.indexOf(a) === -1) out.push(a);
    if (out.length >= EMAIL_LIMITS.recipients) break;
  }
  return out;
};

/** `https://www.Example.com/x` / `www.example.com/x` / `example.com` → `example.com`; `undefined` when it names no site. */
const siteOf = (v: string): string | undefined => {
  const t = v.trim().toLowerCase();
  if (t.length > 300 || /\s/.test(t)) return undefined; // a site name is one short word
  const m = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*)(?::\d+)?(?:[/?#]\S*)?$/.exec(t);
  if (!m) return undefined;
  if (!/^https?:\/\//.test(t) && !/^www\./.test(t) && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/.test(t)) return undefined;
  return m[1].replace(/^www\./, '');
};

type Field = 'to' | 'cc' | 'bcc';
const FIELDS: readonly Field[] = ['to', 'cc', 'bcc'];

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 1000) : []);

/** Review a draft against what the host knows (see the module comment). Pure; never throws. */
export const reviewEmail = (doc: EmailDoc, ctx: EmailReviewContext): EmailReview => {
  const d = readDoc(doc);
  const c = (typeof ctx === 'object' && ctx !== null ? ctx : {}) as Partial<EmailReviewContext>;
  // The HOST's mode decides (the person chose it); a draft that claims another mode never widens the prefill.
  const isReply = (m: unknown): boolean => m === 'reply' || m === 'reply-all';
  const reply = isReply(c.mode) || isReply(d.mode);

  const participantName: { [address: string]: string | undefined } = {};
  const participants: string[] = [];
  for (const p of list(c.participants)) {
    const addr = p && typeof p === 'object' ? (p as EmailRecipient).address : undefined;
    if (!isAddress(typeof addr === 'string' ? addr.trim() : addr)) continue;
    const a = norm(addr as string);
    if (participants.indexOf(a) !== -1) continue;
    participants.push(a);
    const name = (p as EmailRecipient).name;
    participantName[a] = typeof name === 'string' && name.trim() && name.length <= EMAIL_LIMITS.recipientName && !/[\r\n]/.test(name) ? name.trim() : undefined;
  }
  const typed = list(c.userTyped).filter((a): a is string => typeof a === 'string' && isAddress(a.trim())).map(norm);
  const pasted = list(c.pasted).filter((a): a is string => typeof a === 'string').map(norm);
  const isPasted = (a: string): boolean => pasted.indexOf(a) !== -1;
  const trusted = (a: string): boolean => participants.indexOf(a) !== -1 || (typed.indexOf(a) !== -1 && !isPasted(a));

  const prefill: EmailPrefill = { to: [], cc: [], bcc: [] };
  const flagged: FlaggedRecipient[] = [];
  const warnings: EmailWarning[] = [];
  const warn = (code: EmailWarningCode, message: string, blockId?: string): void => {
    const w: EmailWarning = { code, message };
    if (blockId) w.blockId = blockId;
    warnings.push(w);
  };

  const seen: string[] = [];
  let named = 0;
  for (const field of FIELDS) {
    for (const r of d[field]) {
      named++;
      if (!isAddress(r.address)) {
        warn('invalid-recipient', `"${short(r.address)}" in ${field} is not one plain email address, so it was left out.`);
        continue;
      }
      const a = norm(r.address);
      if (seen.indexOf(a) !== -1) {
        warn('duplicate-recipient', `${a} is listed more than once; only the first is used.`);
        continue;
      }
      seen.push(a);
      if (trusted(a)) {
        if (!reply) {
          const entry: EmailRecipient = { address: r.address };
          const name = participantName[a];
          if (name) entry.name = name;
          prefill[field].push(entry);
        }
      } else {
        const f: FlaggedRecipient = { address: r.address, field, reason: isPasted(a) ? 'pasted' : 'model-only' };
        if (r.name) f.name = r.name;
        flagged.push(f);
      }
    }
  }
  if (reply && named > 0) warn('reply-recipients', EMAIL_WARNING_CODES['reply-recipients']);
  if (c.mode !== undefined && c.mode !== d.mode) warn('mode-mismatch', `The draft was written as "${d.mode}" but you chose "${String(c.mode).slice(0, 20)}"; your choice is used.`);

  const links: ReviewedLink[] = [];
  const addLink = (href: string, text: string, blockId: string, source: 'run' | 'button'): void => {
    links.push({ href, text, blockId, source });
    const site = siteOf(text);
    if (site !== undefined && href.lastIndexOf('https://', 0) === 0 && siteOf(href) !== site) {
      warn('link-text-mismatch', `"${short(text.trim())}" goes to ${short(href, 200)}.`, blockId);
    }
    const textAddress = text.trim().replace(/^mailto:/i, '');
    if (href.lastIndexOf('mailto:', 0) === 0) {
      const to = mailtoRecipients(href).map(norm);
      if (isAddress(textAddress) && to.indexOf(norm(textAddress)) === -1) warn('link-text-mismatch', `"${short(text.trim())}" starts an email to ${to.join(', ')}.`, blockId);
      for (const a of to) if (!trusted(a)) warn('mailto-untrusted', `"${short(text.trim() || href)}" starts a new email to ${a}, an address you did not give.`, blockId);
    } else if (isAddress(textAddress)) {
      warn('link-text-mismatch', `"${short(text.trim())}" looks like an email address but opens ${short(href, 200)}.`, blockId);
    }
  };
  const runs = (rs: readonly ReadRun[], blockId: string): void => {
    for (const r of rs) {
      if (r.href) addLink(r.href, r.text, blockId, 'run');
      else if (r.droppedLink) warn('unsafe-link', `A link on "${short(r.text.trim())}" was not https: or mailto:, so it was removed.`, blockId);
    }
  };
  const walk = (blocks: readonly ReadBlock[]): void => {
    for (const b of blocks) {
      switch (b.type) {
        case 'heading':
        case 'paragraph':
        case 'quote':
          runs(b.runs, b.id);
          break;
        case 'list':
          for (const it of b.items) runs(it.runs, b.id);
          break;
        case 'button':
          if (b.href) addLink(b.href, b.label, b.id, 'button');
          else warn('unsafe-link', `The button "${short(b.label)}" had a link that was not https: or mailto:, so it was removed.`, b.id);
          break;
        case 'columns':
          for (const col of b.columns) walk(col);
          break;
        default:
          break;
      }
    }
  };
  walk(d.blocks);

  if (emailToPlainText(doc).length > EMAIL_LIMITS.field) warn('body-too-long', EMAIL_WARNING_CODES['body-too-long']);
  if (d.attachments > 0) warn('attachments-separate', EMAIL_WARNING_CODES['attachments-separate']);
  return { prefill, flagged, links, warnings };
};
