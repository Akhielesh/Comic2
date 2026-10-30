/**
 * FROZEN CONTRACT (platform contract v1, plan §5.2 and §7): EmailDoc v1, its ops, and what the email renderer and
 * the recipient/link review return. Types and caps only; the schema and ops live in `src/models/email/**`,
 * `renderEmail` / `emailToPlainText` / `reviewEmail` in `src/email/**`. Additive changes only.
 *
 * Agents draft; humans send. Nothing here can send: there is no send mode, op or field. An agent op can never change
 * recipients (`set_recipients` is accepted only with `actor: 'user'`), and a recipient a model invented is flagged by
 * the review and never pre-filled.
 */
import type { AssetRef, ListItem, OpActor, OpBase, OpResult, Run, SafeHref } from './schema.js';
import type { RichDoc } from './richdoc.js';
import type { DeckSpec } from './deck.js';

/** `compose` starts a new thread; in the reply modes the mail provider decides the recipients. */
export type EmailMode = 'compose' | 'reply' | 'reply-all' | 'forward';

/** One plain address (`s.email()`) and an optional display name. */
export interface EmailRecipient {
  address: string;
  name?: string;
}

export interface EmailDoc {
  v: 1;
  /** Revision: absent means 0; `applyEmailOps` bumps it (contract/schema.ts `OpBase`). */
  rev?: number;
  mode: EmailMode;
  subject: string;
  /** The inbox preview line. */
  preheader?: string;
  /** At most `EMAIL_LIMITS.recipients` each. */
  to: EmailRecipient[];
  cc?: EmailRecipient[];
  bcc?: EmailRecipient[];
  /** At most `EMAIL_LIMITS.blocks`. */
  blocks: EmailBlock[];
  /** Plain text, line breaks kept. */
  signature?: string;
  /** At most `EMAIL_LIMITS.attachments`. Specs only: the host renders them to files after a human click. */
  attachments?: AttachmentSpec[];
  /** A BrandKit id (`s.id()`); absent means the host's default brand. */
  brand?: string;
}

export type EmailBlock =
  | EmailHeading
  | EmailParagraph
  | EmailList
  | EmailButton
  | EmailQuote
  | EmailDivider
  | EmailImage
  | EmailColumns;

export type EmailBlockType = EmailBlock['type'];

/** What a column may hold: every block except another `columns`. */
export type EmailColumnBlock = EmailHeading | EmailParagraph | EmailList | EmailButton | EmailQuote | EmailDivider | EmailImage;

export interface EmailHeading {
  type: 'heading';
  id: string;
  level: 1 | 2 | 3;
  runs: Run[];
}

export interface EmailParagraph {
  type: 'paragraph';
  id: string;
  runs: Run[];
}

export interface EmailList {
  type: 'list';
  id: string;
  ordered: boolean;
  items: ListItem[];
}

/** A call-to-action link styled as a button; `href` is `https:` or `mailto:` only. */
export interface EmailButton {
  type: 'button';
  id: string;
  label: string;
  href: SafeHref;
}

/** Quoted text (a reply's context); `cite` names who wrote it. */
export interface EmailQuote {
  type: 'quote';
  id: string;
  runs: Run[];
  cite?: string;
}

export interface EmailDivider {
  type: 'divider';
  id: string;
}

export interface EmailImage {
  type: 'image';
  id: string;
  ref: AssetRef;
  alt: string;
  /** CSS pixels, `EMAIL_LIMITS.imageWidthMin`–`EMAIL_LIMITS.imageWidthMax`; absent means full width. */
  width?: number;
}

export interface EmailColumn {
  /** At most `EMAIL_LIMITS.blocksPerColumn`. */
  blocks: EmailColumnBlock[];
}

/** At most `EMAIL_LIMITS.columns` columns side by side (stacked on narrow screens). */
export interface EmailColumns {
  type: 'columns';
  id: string;
  columns: EmailColumn[];
}

// ── Attachments (specs, rendered by the host; wave 1 tools carry none) ────────────────────────────────────────

export type AttachmentKind = 'docx' | 'pdf' | 'pptx';

/** `docx` needs a `doc`, `pptx` a `deck`; `pdf` takes either. */
export type AttachmentSource = { type: 'doc'; doc: RichDoc } | { type: 'deck'; deck: DeckSpec };

export interface AttachmentSpec {
  id: string;
  /** The file name without its extension (the host adds it from `kind`). */
  name: string;
  kind: AttachmentKind;
  spec: AttachmentSource;
}

// ── Ops ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every email op may carry its actor; absent means `'agent'`. The host stamps it (contract/schema.ts `OpActor`). */
export interface EmailOpBase extends OpBase {
  actor?: OpActor;
}

export interface EmailSetSubjectOp extends EmailOpBase {
  op: 'set_subject';
  subject: string;
}

/** Insert `block` at `index` (absent appends). */
export interface EmailInsertBlockOp extends EmailOpBase {
  op: 'insert_block';
  index?: number;
  block: EmailBlock;
}

/** Replace block `blockId` with `block` (same id). */
export interface EmailUpdateBlockOp extends EmailOpBase {
  op: 'update_block';
  blockId: string;
  block: EmailBlock;
}

export interface EmailRemoveBlockOp extends EmailOpBase {
  op: 'remove_block';
  blockId: string;
}

export interface EmailAttachOp extends EmailOpBase {
  op: 'attach';
  attachment: AttachmentSpec;
}

export interface EmailDetachOp extends EmailOpBase {
  op: 'detach';
  attachmentId: string;
}

/** Only a person changes recipients: an op without `actor: 'user'` is refused. */
export interface EmailSetRecipientsOp extends OpBase {
  op: 'set_recipients';
  actor: 'user';
  to: EmailRecipient[];
  cc?: EmailRecipient[];
  bcc?: EmailRecipient[];
}

export type EmailOp =
  | EmailSetSubjectOp
  | EmailInsertBlockOp
  | EmailUpdateBlockOp
  | EmailRemoveBlockOp
  | EmailAttachOp
  | EmailDetachOp
  | EmailSetRecipientsOp;

export type EmailOpName = EmailOp['op'];

/** `applyEmailOps(doc, ops)`. */
export type EmailOpResult = OpResult<EmailDoc, EmailOp>;

// ── Render and review (src/email; plan §7) ──────────────────────────────────────────────────────────────────────

/**
 * `renderEmail(doc, brandKit)`: rendered inside the host with zero network calls. `html` escapes every string, has
 * no `<script>`, no `on*=` attribute and no `http:` resource; `text` is the plain-text alternative.
 */
export interface RenderedEmail {
  html: string;
  text: string;
}

/** What the host knows about who may receive a draft. */
export interface EmailReviewContext {
  mode: EmailMode;
  /** The thread's header addresses (From, To, Cc). */
  participants: EmailRecipient[];
  /** Addresses in the user's OWN instruction text only — never from attachments, thread bodies or tool outputs. */
  userTyped: string[];
  /** Addresses inside thread text the user pasted into the instruction: flagged, never trusted. */
  pasted?: string[];
}

/** `model-only`: the address is in neither `participants` nor `userTyped`. `pasted`: it came from pasted text. */
export type RecipientFlagReason = 'model-only' | 'pasted';

/** A recipient the draft names that is NOT pre-filled ("Suggested by AI — not added"). */
export interface FlaggedRecipient {
  address: string;
  name?: string;
  field: 'to' | 'cc' | 'bcc';
  reason: RecipientFlagReason;
}

/** The recipients a composer may fill in. Empty in the reply modes (the provider decides). */
export interface EmailPrefill {
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
}

/** Every link in the draft, with its full URL, so a person sees where each one goes. */
export interface ReviewedLink {
  href: SafeHref;
  /** The visible text: the run's text or the button's label. */
  text: string;
  blockId: string;
  source: 'run' | 'button';
}

export interface EmailWarning {
  /** Stable machine code (open set; the renderer documents its codes). */
  code: string;
  message: string;
  blockId?: string;
}

/** `reviewEmail(doc, ctx)`. */
export interface EmailReview {
  prefill: EmailPrefill;
  flagged: FlaggedRecipient[];
  links: ReviewedLink[];
  warnings: EmailWarning[];
}

// ── Caps ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const EMAIL_LIMITS = {
  subject: 250,
  preheader: 150,
  /** Per field: `to`, `cc` and `bcc` each. */
  recipients: 100,
  recipientName: 200,
  blocks: 80,
  /** Any free-text field (and the whole plain-text body, `emailToPlainText`), so a draft fits a 10,000-character composer. */
  field: 10000,
  runsPerBlock: 200,
  listItems: 100,
  columns: 2,
  blocksPerColumn: 20,
  buttonLabel: 100,
  cite: 200,
  imageWidthMin: 16,
  imageWidthMax: 600,
  attachments: 5,
  attachmentName: 200,
} as const;
