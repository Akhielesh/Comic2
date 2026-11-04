// The shared platform's wave-1 chat tools (plan §5.5, §7, §12 W1.9): `email_draft` and `deck_create`.
//
// Both are TEXT tools: the chat model writes the document as the tool's arguments, inside a model turn the chat
// route already metered (reserveChat), so neither makes a model call, a network call, a connector call or a paid
// call of its own. They draft; nothing sends. The email card opens a draft in the person's own mail client only
// when they tap, and only with the recipients the review allowed.
//
// How a call runs:
//   - The tools exist only for a request whose `platformDocsFor(req)` answer is enabled (ai/tools/platformDocs.ts):
//     the PLATFORM_DOCS kill switch, the rollout stage and the person's role. `buildPlatformChatTool` returns
//     undefined otherwise, so resolveTools leaves them out (registry.ts).
//   - Each call is bound through platform-core's `bindTools(CHAT_PRODUCT, …)`: parse, delete any model `actor`,
//     `check()` the capped model-facing schema (no images, no AssetRef, no attachments), the per-turn cap, the gate,
//     the content-free audit event. The handler then builds the document as `{v: 1, ...input}`, validates it with the
//     model's own `checkEmailDoc` / `checkDeckSpec` (never a bare `check`), renders and reviews it, and hands the card
//     its artifact. The model gets back a short summary, never the document.
//   - Money (lead decision L3): wave-1 tools reserve nothing. `bindTools` gets `refusingMeter`, which answers
//     `{ok:false, code:'unavailable'}` from reserve and claim and never throws; a text tool never calls it (tested).
//     The ledger-backed MeterPort is W3.2's.
//   - No op is applied here: the revise tools (email_revise, deck_revise) are wave 3. When they land, model ops go
//     through `stampAgentEmailOp` and `apply*Ops(doc, ops, {seenOpIds})` with the host's op log.
import { randomUUID } from 'node:crypto';
import type { ChatTool, ToolContext, ToolExecResult } from './types.js';
import { emailComposeLinks, type ChatArtifact, type DeckDraftArtifact, type EmailDraftArtifact } from '../../../../apiTypes.js';
import { CHAT_PRODUCT } from '../../../../packages/platform-core/src/products.js';
import { bindTools, getPlatformTool, type BoundTool, type ToolCallOutcome, type ToolHandler } from '../../../../packages/platform-core/src/tools/index.js';
import { dreamstreamAuditSink, type AuditPort, type MeterPort, type PlatformAuditEvent } from '../../../../packages/platform-core/src/gates/index.js';
import type { CheckError } from '../../../../packages/platform-core/src/contract/schema.js';
import type { EmailDoc, EmailReview, EmailReviewContext } from '../../../../packages/platform-core/src/contract/email.js';
import { checkEmailDoc } from '../../../../packages/platform-core/src/models/email/index.js';
import { checkDeckSpec, deckOverlaps } from '../../../../packages/platform-core/src/models/deck/index.js';
import { renderEmail, reviewEmail } from '../../../../packages/platform-core/src/email/index.js';
import { brandKitById } from '../../../../packages/platform-core/src/brand/index.js';
import { platformDocsEnabled } from './platformDocs.js';
import { recordAudit } from '../../observability/auditLog.js';
import { logger } from '../../lib/logger.js';

/** The platform tools a chat agent can get in this wave. */
export const PLATFORM_CHAT_TOOL_NAMES = ['email_draft', 'deck_create'] as const;
export type PlatformChatToolName = (typeof PLATFORM_CHAT_TOOL_NAMES)[number];

export const isPlatformChatToolName = (name: unknown): name is PlatformChatToolName =>
  typeof name === 'string' && (PLATFORM_CHAT_TOOL_NAMES as readonly string[]).includes(name);

// ── Ports ───────────────────────────────────────────────────────────────────────────────────────────────────────

const LEDGER_OFF = 'Platform tools reserve nothing in this release, so the usage ledger is not connected to them.';

/**
 * The wave-1 MeterPort (lead decision L3): it refuses everything and never throws. `bindTools` only calls a meter for
 * a tool that reserves (an engine job, a paid call, a quota or spend gate); email_draft and deck_create are text
 * tools inside the already-metered chat turn, so with this meter a metered tool could never run unmetered: it fails
 * closed for a governed user.
 */
export const refusingMeter = (governed: boolean): MeterPort => ({
  governed,
  reserve: async () => ({ ok: false, code: 'unavailable', message: LEDGER_OFF }),
  claim: async () => 'unavailable',
  settle: async () => ({ ok: false, code: 'unavailable', message: LEDGER_OFF }),
  release: async () => ({ ok: false, code: 'unavailable', message: LEDGER_OFF })
});

/** What one platform event says in a log line or an audit row: ids and codes only, never content. */
const eventFields = (event: PlatformAuditEvent): Record<string, unknown> => ({
  eventId: event.id,
  product: event.product,
  tool: event.tool,
  capability: event.capability,
  decision: event.decision,
  outcome: event.outcome,
  errorCode: event.errorCode,
  inputHash: event.inputHash,
  opIds: event.opIds.length,
  actor: event.actor.kind
});

/**
 * DreamStream's AuditPort, routed by core's `dreamstreamAuditSink`: security guards → `audit_log`
 * (platform.guard.blocked), a hold the ledger could not close → a `stranded: true` log line, everything else → one
 * structured log line. Never throws into the caller (recordAudit is best-effort).
 */
export const dreamstreamAuditPort = (deps: { record?: typeof recordAudit } = {}): AuditPort => ({
  record(event) {
    try {
      const sink = dreamstreamAuditSink(event);
      if (sink.sink === 'audit_log') {
        return (deps.record ?? recordAudit)({
          actorId: event.actor.id ?? null,
          action: sink.action,
          targetType: 'platform_tool',
          targetId: event.tool,
          detail: eventFields(event)
        });
      }
      if (sink.sink === 'log' && sink.stranded) logger.warn('platform_audit', { ...eventFields(event), stranded: true });
      else logger.info('platform_audit', eventFields(event));
    } catch {
      // auditing never breaks a tool call
    }
    return undefined;
  }
});

// ── Building the documents ──────────────────────────────────────────────────────────────────────────────────────

/** reviewEmail exactly as this host calls it: the person's mode is the draft's own (chat has no separate picker). */
export const reviewEmailDraft = (doc: EmailDoc, ctx: EmailReviewContext): EmailReview => reviewEmail(doc, ctx);

export type DraftBuild<A, O> = { ok: true; artifact: A; output: O } | { ok: false; errors: CheckError[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const OUTPUT_CODE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `email_draft`'s document: `{v: 1, ...input}` checked by `checkEmailDoc` (the model's refinements: the body bound,
 * repeated ids…), rendered (`renderEmail`, the doc's own brand kit) and reviewed (`reviewEmail`: only the addresses
 * the person typed are trusted, and one inside text they pasted is flagged 'pasted' even if it was also extracted as
 * typed; chat has no thread participants). The compose links carry `review.prefill` ONLY.
 */
export const buildEmailDraft = (
  input: unknown,
  opts: { draftId: string; governed: boolean; userTypedAddresses?: readonly string[]; pastedAddresses?: readonly string[] }
): DraftBuild<EmailDraftArtifact, { draftId: string; blocks: number; recipients: number; flagged: number; links: number; warnings: string[] }> => {
  const raw: Record<string, unknown> = { ...(isRecord(input) ? input : {}), v: 1 };
  if (Array.isArray(raw.attachments) && raw.attachments.length === 0) delete raw.attachments;
  const checked = checkEmailDoc(raw);
  if (checked.ok === false) return { ok: false, errors: checked.errors };
  const doc = checked.value;
  const rendered = renderEmail(doc, brandKitById(doc.brand));
  const review = reviewEmailDraft(doc, {
    mode: doc.mode,
    participants: [],
    userTyped: (opts.userTypedAddresses || []).slice(),
    pasted: (opts.pastedAddresses || []).slice()
  });
  const links = emailComposeLinks({
    to: review.prefill.to.map((r) => r.address),
    cc: review.prefill.cc.map((r) => r.address),
    bcc: review.prefill.bcc.map((r) => r.address),
    subject: doc.subject,
    body: rendered.text
  });
  const artifact: EmailDraftArtifact = {
    draftId: opts.draftId,
    doc,
    html: rendered.html,
    text: rendered.text,
    review,
    gmailUrl: links.gmailUrl,
    mailto: links.mailto,
    governed: opts.governed
  };
  const output = {
    draftId: opts.draftId,
    blocks: doc.blocks.length,
    recipients: review.prefill.to.length + review.prefill.cc.length + review.prefill.bcc.length,
    flagged: review.flagged.length,
    links: review.links.length,
    warnings: review.warnings
      .map((w) => w.code)
      .filter((c) => typeof c === 'string' && c.length <= 64 && OUTPUT_CODE.test(c))
      .slice(0, 20)
  };
  return { ok: true, artifact, output };
};

/** `deck_create`'s document: `{v: 1, ...input}` checked by `checkDeckSpec`, then `deckOverlaps` for the export gate. */
export const buildDeckDraft = (
  input: unknown,
  opts: { draftId: string; governed: boolean }
): DraftBuild<DeckDraftArtifact, { draftId: string; slides: number; overlaps: number }> => {
  const checked = checkDeckSpec({ ...(isRecord(input) ? input : {}), v: 1 });
  if (checked.ok === false) return { ok: false, errors: checked.errors };
  const deck = checked.value;
  const overlaps = deckOverlaps(deck).map((o) => ({ slideId: o.slideId, pairs: o.pairs }));
  return {
    ok: true,
    artifact: { draftId: opts.draftId, deck, overlaps, governed: opts.governed },
    output: { draftId: opts.draftId, slides: deck.slides.length, overlaps: overlaps.reduce((n, o) => n + o.pairs.length, 0) }
  };
};

// ── Outcomes → what the model reads and what the card shows ───────────────────────────────────────────────────

interface CallState {
  artifact?: ChatArtifact;
  invalid?: CheckError[];
  summary?: string;
}

const ERRORS_SHOWN = 12;

const errorLines = (errors: readonly CheckError[]): string =>
  errors
    .slice(0, ERRORS_SHOWN)
    .map((e) => `- ${e.path || '(arguments)'}: ${e.code}${e.message ? ` (${e.message})` : ''}`)
    .join('\n') + (errors.length > ERRORS_SHOWN ? `\n- …and ${errors.length - ERRORS_SHOWN} more` : '');

const invalidResult = (name: PlatformChatToolName, errors: readonly CheckError[]): ToolExecResult => ({
  content: `${name} did not run: its arguments did not pass the checks, so nothing was drafted. Fix these and call ${name} again:\n${errorLines(errors)}`
});

const list = (xs: readonly string[]): string => (xs.length ? xs.join(', ') : 'none');

const emailSummary = (a: EmailDraftArtifact): string => {
  const filled = [...a.review.prefill.to, ...a.review.prefill.cc, ...a.review.prefill.bcc].map((r) => r.address);
  const flagged = a.review.flagged.map((f) => f.address);
  const reply = a.doc.mode === 'reply' || a.doc.mode === 'reply-all';
  return [
    `Drafted the email "${a.doc.subject}" as a card the person reviews. Nothing was sent: they open it in their own mail app if they choose to.`,
    reply ? 'Recipients: none filled in, because in a reply their mail app chooses the recipients.' : `Recipients filled in for them to confirm: ${list(filled)}.`,
    flagged.length ? `Shown as suggestions only, NOT filled in (the person did not type them): ${list(flagged)}. Tell the person they can tap to add them.` : '',
    `Links, each shown with its full address: ${a.review.links.length}.`,
    a.review.warnings.length ? `Review notes: ${a.review.warnings.map((w) => w.code).join(', ')}.` : '',
    'Do not repeat the email text in your reply; point the person to the card.'
  ]
    .filter(Boolean)
    .join('\n');
};

const deckSummary = (a: DeckDraftArtifact): string => {
  const pairs = a.overlaps.flatMap((o) => o.pairs.map((p) => `slide ${o.slideId}: ${p.a} and ${p.b}`));
  return [
    `Created the deck "${a.deck.title}" (${a.deck.slides.length} slide${a.deck.slides.length === 1 ? '' : 's'}, ${a.deck.size}) as a card: the person can preview it and download it as a PowerPoint file (.pptx).`,
    pairs.length
      ? `${pairs.length} pair${pairs.length === 1 ? '' : 's'} of content elements overlap, so the download is refused until they are fixed: ${pairs.slice(0, 10).join('; ')}${pairs.length > 10 ? '; …' : ''}. Call deck_create again with rects that do not overlap.`
      : 'No content elements overlap.',
    'Do not repeat the slide text in your reply; point the person to the card.'
  ].join('\n');
};

/**
 * Map a bound call's outcome to the chat loop's result. `ok` carries the card; `invalid` (and a document the model
 * checks refused inside the handler) is error text and NO artifact; a refusal, an approval request or a failure is
 * text plus a notice. A hold the ledger could not close (`settleFailed`) is logged as stranded for reconciliation.
 */
export const platformOutcomeToResult = (name: PlatformChatToolName, outcome: ToolCallOutcome, call: CallState, meta: { userId?: string } = {}): ToolExecResult => {
  if ((outcome.status === 'ok' || outcome.status === 'failed') && outcome.settleFailed) {
    logger.warn('platform_hold_stranded', { stranded: true, tool: name, userId: meta.userId, status: outcome.status, inputHash: outcome.status === 'ok' ? outcome.inputHash : undefined });
  }
  switch (outcome.status) {
    case 'ok':
      if (!call.artifact) return { content: `${name} finished without a draft to show. Try again.`, notice: { level: 'error', message: 'The draft could not be shown.' } };
      return { content: call.summary || `${name} finished.`, artifacts: [call.artifact] };
    case 'invalid':
      return invalidResult(name, outcome.errors);
    case 'needs-approval':
      return {
        content: `${name} needs the person's approval before it can run, so nothing was drafted yet.`,
        notice: { level: 'info', message: 'This draft needs your approval first.' }
      };
    case 'refused':
      return { content: `${name} was not run: ${outcome.message}`, notice: { level: 'warn', message: outcome.message } };
    case 'failed':
    default:
      if (call.invalid) return invalidResult(name, call.invalid);
      return {
        content: `${name} failed and nothing was drafted: ${outcome.status === 'failed' ? outcome.message : 'unknown error'}`,
        notice: { level: 'error', message: 'The draft could not be made. Try again.' }
      };
  }
};

// ── The chat tools ──────────────────────────────────────────────────────────────────────────────────────────────

/** Seams for tests: the ports `bindTools` receives. Defaults are the real ones. */
export interface PlatformToolDeps {
  meter?: MeterPort;
  audit?: AuditPort;
  now?: () => number;
  newId?: () => string;
}

/** A model may send `attachments: []` out of habit; wave 1 has none, and an empty list is not a list (W1.2). */
const normalizeArgs = (raw: unknown): unknown => {
  let args = raw;
  if (typeof raw === 'string') {
    try {
      args = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return raw; // bindTools reports the JSON error to the model
    }
  }
  if (isRecord(args) && Array.isArray(args.attachments) && args.attachments.length === 0) {
    const { attachments: _drop, ...rest } = args;
    return rest;
  }
  return args;
};

interface HandlerOpts {
  governed: boolean;
  userTypedAddresses: readonly string[];
  pastedAddresses: readonly string[];
  draftId: () => string;
}

const handlerFor = (name: PlatformChatToolName, call: CallState, opts: HandlerOpts): ToolHandler => async (input) => {
  if (name === 'email_draft') {
    const built = buildEmailDraft(input, {
      draftId: opts.draftId(),
      governed: opts.governed,
      userTypedAddresses: opts.userTypedAddresses,
      pastedAddresses: opts.pastedAddresses
    });
    if (built.ok === false) {
      call.invalid = built.errors;
      throw new Error('The email did not pass the document checks.');
    }
    call.artifact = { type: 'email_draft', data: built.artifact };
    call.summary = emailSummary(built.artifact);
    return built.output;
  }
  const built = buildDeckDraft(input, { draftId: opts.draftId(), governed: opts.governed });
  if (built.ok === false) {
    call.invalid = built.errors;
    throw new Error('The deck did not pass the document checks.');
  }
  call.artifact = { type: 'deck_draft', data: built.artifact };
  call.summary = deckSummary(built.artifact);
  return built.output;
};

/**
 * `email_draft` or `deck_create` for this request, or undefined: the name is not a platform chat tool, or the
 * request's `ctx.platformDocs` is not an enabled answer issued by `platformDocsFor(req)` (a client-supplied or
 * copied value never counts), or the ToolContext names another user than the answer.
 */
export const buildPlatformChatTool = (name: string, ctx?: ToolContext, deps: PlatformToolDeps = {}): ChatTool | undefined => {
  if (!isPlatformChatToolName(name) || !ctx) return undefined;
  const access = ctx.platformDocs;
  if (!platformDocsEnabled(access)) return undefined;
  if (ctx.userId !== undefined && ctx.userId !== access.userId) return undefined;
  const userId = access.userId;
  const governed = access.governed !== false || ctx.governed === true; // either source saying governed wins
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string').slice(0, 100) : []);
  const userTypedAddresses = strings(ctx.userTypedAddresses);
  const pastedAddresses = strings(ctx.pastedAddresses);
  const ports = {
    policy: CHAT_PRODUCT.policy,
    meter: deps.meter ?? refusingMeter(governed),
    audit: deps.audit ?? dreamstreamAuditPort(),
    now: deps.now ?? Date.now,
    newId: deps.newId ?? (() => `pe-${randomUUID()}`)
  };
  const draftId = deps.newId ? deps.newId : () => `draft-${randomUUID()}`;
  const bind = (call: CallState): BoundTool | undefined => {
    try {
      return bindTools(CHAT_PRODUCT, { ...ports, handlers: { [name]: handlerFor(name, call, { governed, userTypedAddresses, pastedAddresses, draftId }) } })[0];
    } catch (err) {
      logger.warn('platform_tool_bind_failed', { tool: name, message: (err as Error)?.message });
      return undefined;
    }
  };
  const probe = bind({});
  if (!probe || probe.name !== name || !getPlatformTool(name)) return undefined;
  // The per-turn cap (maxPerTurn: email_draft 3, deck_create 2). runChat runs all the tool calls of one model
  // response at once (Promise.all), so each call reserves its slot BEFORE it awaits, and gives it back only if no
  // draft was made: parallel calls see 0, 1, 2… and the ones past the cap are refused.
  let callsThisTurn = 0;
  return {
    name,
    description: probe.spec.description,
    parameters: probe.spec.parameters as unknown as Record<string, unknown>,
    execute: async (args, signal) => {
      const call: CallState = {};
      const bound = bind(call);
      if (!bound) return { content: `${name} is not available right now.`, notice: { level: 'error', message: 'This tool is not available right now.' } };
      const slot = callsThisTurn++;
      let outcome: ToolCallOutcome;
      try {
        outcome = await bound.run(normalizeArgs(args), { userId, callsThisTurn: slot, turnSpendUsd: 0, ...(signal ? { signal } : {}) });
      } catch (err) {
        callsThisTurn -= 1;
        throw err;
      }
      if (outcome.status !== 'ok') callsThisTurn -= 1;
      return platformOutcomeToResult(name, outcome, call, { userId });
    }
  };
};
