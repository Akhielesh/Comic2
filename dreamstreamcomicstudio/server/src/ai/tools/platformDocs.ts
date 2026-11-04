// Who may use the shared-platform chat tools (email_draft, deck_create) on THIS request. Server-only.
//
// `platformDocsFor(req)` is the one place the rule is read on the server (plan §5.5 "binding on every agent path"):
//   1. the PLATFORM_DOCS kill switch (server env; anything but exactly 'on' turns every platform surface off),
//   2. the rollout stage, PLATFORM_DOCS_STAGE from shared/platform/flags.ts ('admins' in wave 1),
//   3. the signed-in user's role from hydrateAccessProfile(req) (a failed lookup counts as not admin),
// and, for a user who passes, whether their usage is governed (shares of usage, never dollars). An admin is never
// governed; anyone else is governed unless the usage status says otherwise, and an unreadable status counts as
// governed (fail closed: no '$').
//
// The answer is a frozen object this module ISSUES and remembers (a WeakSet). The tool builders accept only an issued,
// enabled answer, so a look-alike object (say a client's `clientContext.platformDocs`, copied by some future spread)
// never turns the tools on: JSON cannot forge membership of a WeakSet.
//
// The agent paths that do not see the request (runRecipe, the swarm orchestrator, the run_recipe and swarm tools)
// receive the request's `clientContext` object, untouched, from prepareChat. `bindPlatformScope(clientContext, …)`
// ties the request's platform scope (user id, access, governed, the addresses the user typed and those in what they
// pasted) to that very object, and `platformToolContext(clientContext)` reads it back for their ToolContext. Nothing
// is read from the object's own properties, and the binding exists only when the tools are enabled, so with
// PLATFORM_DOCS unset every agent path builds exactly the ToolContext it built before.
import type { Request } from 'express';
import { PLATFORM_DOCS_STAGE, platformDocsAllowed, platformKillSwitchOn, type PlatformStage } from '../../../../shared/platform/flags.js';
import { hydrateAccessProfile } from '../../middleware/requireAdmin.js';
import { getAllowanceStatus } from '../../services/platformAllowance.js';
import { logger } from '../../lib/logger.js';
import { addressesIn } from '../../../../packages/platform-core/src/email/index.js';

/** Why the platform tools are off for a request (or 'on'). */
export type PlatformDocsReason = 'on' | 'kill-switch' | 'stage' | 'signed-out' | 'lookup-failed';

/** The platform-docs answer for one request. Only `platformDocsFor` creates one (see `isPlatformDocsAccess`). */
export interface PlatformDocsAccess {
  readonly enabled: boolean;
  readonly reason: PlatformDocsReason;
  readonly stage: PlatformStage;
  readonly isAdmin: boolean;
  /** The user's usage is governed: shares of usage, never dollars. True unless known otherwise. */
  readonly governed: boolean;
  /** The signed-in user (absent when signed out). */
  readonly userId?: string;
}

const ISSUED = new WeakSet<object>();

const issue = (access: PlatformDocsAccess): PlatformDocsAccess => {
  const frozen = Object.freeze({ ...access });
  ISSUED.add(frozen);
  return frozen;
};

/** True only for an answer `platformDocsFor` issued (never for a copy, a JSON object or a client value). */
export const isPlatformDocsAccess = (value: unknown): value is PlatformDocsAccess =>
  typeof value === 'object' && value !== null && ISSUED.has(value);

/** The tools may be built: an issued answer that is enabled and names a user. */
export const platformDocsEnabled = (value: unknown): value is PlatformDocsAccess & { enabled: true; userId: string } =>
  isPlatformDocsAccess(value) && value.enabled === true && typeof value.userId === 'string' && value.userId.length > 0;

/** Test and wiring seams: every input `platformDocsFor` reads. Defaults are the real ones. */
export interface PlatformDocsDeps {
  /** The PLATFORM_DOCS value (default: process.env at call time). */
  killSwitch?: string | undefined;
  /** The stage (default: PLATFORM_DOCS_STAGE). */
  stage?: PlatformStage;
  /** Admin lookup (default: hydrateAccessProfile(req).isAdmin). */
  isAdmin?: (req: Request) => Promise<boolean>;
  /** Governed lookup for a non-admin (default: the usage status, cached 60 s; unreadable → governed). */
  governed?: (userId: string) => Promise<boolean>;
}

const defaultIsAdmin = async (req: Request): Promise<boolean> => (await hydrateAccessProfile(req)).isAdmin === true;

const defaultGoverned = async (userId: string): Promise<boolean> => {
  const status = await getAllowanceStatus(userId);
  // An unavailable status reports enabled:false; we cannot know, so the user stays governed (no '$').
  return status.enabled === false ? true : status.governed !== false;
};

/**
 * The platform-docs answer for this request (see the file comment). Never throws: a failed role lookup turns the
 * tools off ('lookup-failed'), a failed usage lookup keeps the user governed.
 */
export const platformDocsFor = async (req: Request, deps: PlatformDocsDeps = {}): Promise<PlatformDocsAccess> => {
  const stage = deps.stage ?? PLATFORM_DOCS_STAGE;
  const killSwitch = 'killSwitch' in deps ? deps.killSwitch : process.env.PLATFORM_DOCS;
  const userId = typeof req?.user?.id === 'string' && req.user.id ? req.user.id : undefined;
  const off = (reason: PlatformDocsReason, isAdmin = false): PlatformDocsAccess =>
    issue({ enabled: false, reason, stage, isAdmin, governed: true, ...(userId ? { userId } : {}) });

  if (!platformKillSwitchOn(killSwitch)) return off('kill-switch');
  if (!userId) return off('signed-out');
  let isAdmin: boolean;
  try {
    isAdmin = await (deps.isAdmin ?? defaultIsAdmin)(req);
  } catch (err) {
    logger.warn('platform_docs_admin_lookup_failed', { message: (err as Error)?.message });
    return off('lookup-failed');
  }
  if (!platformDocsAllowed({ killSwitch, isAdmin, stage })) return off('stage', isAdmin);
  let governed = !isAdmin;
  if (!isAdmin) {
    try {
      governed = await (deps.governed ?? defaultGoverned)(userId);
    } catch {
      governed = true;
    }
  }
  return issue({ enabled: true, reason: 'on', stage, isAdmin, governed, userId });
};

// ── The request's platform scope, carried by its clientContext object ─────────────────────────────────────────

/** What a platform tool needs from its request, whichever agent path runs it. */
export interface PlatformToolScope {
  readonly userId: string;
  readonly platformDocs: PlatformDocsAccess;
  readonly governed: boolean;
  /** Addresses in the user's OWN latest message (never attachments, thread bodies, pasted text or tool output). */
  readonly userTypedAddresses: readonly string[];
  /** Addresses inside text the user pasted into that message (a pasted-text chip): flagged, never trusted. */
  readonly pastedAddresses: readonly string[];
}

const SCOPES = new WeakMap<object, PlatformToolScope>();

// ── What the person typed vs what they pasted ────────────────────────────────────────────────────────────────
//
// The chat client folds every pasted-text chip (any paste of 1,200+ characters, and any text file attached to the
// turn) into the message it sends, AFTER the typed text, as
//     \n\n[Pasted text — <name>]\n"""\n<the pasted text>\n"""
// (components/chat/AIChatPlatform.tsx toRequestMessage). A pasted email thread is someone else's words: an address
// in it must be flagged, never trusted (plan §7, §9). So the typed part ends at the FIRST line that starts a pasted
// block, and everything from there on counts as pasted. Cutting at the header (rather than matching each block up to
// its closing quotes) fails closed: a paste that itself holds a `"""` line, or a file name with a `]` in it, cannot
// end the block early and turn the rest of the paste into "typed" text.

/** The line that opens a pasted-text block in a chat message (see above). */
export const PASTED_BLOCK_HEADER = /(?:^|\n)\[Pasted text — /;

/** Split a user message into what the person typed and what they pasted (see above). Pure; never throws. */
export const splitUserText = (text: string): { typed: string; pasted: string } => {
  const t = typeof text === 'string' ? text : '';
  const m = PASTED_BLOCK_HEADER.exec(t);
  if (!m) return { typed: t, pasted: '' };
  const start = m.index + (m[0].charCodeAt(0) === 0x0a ? 1 : 0); // the header line itself, not the newline before it
  return { typed: t.slice(0, start).trimEnd(), pasted: t.slice(start) };
};

/**
 * The addresses the person TYPED in their latest message, the only ones an email draft may pre-fill (core
 * `addressesIn`, linear, capped). Pass the user's message text only: never attachments, thread bodies or tool output.
 * Pasted-text blocks in it are left out (`splitUserText`).
 */
export const addressesTypedIn = (text: string): string[] => addressesIn(splitUserText(text).typed);

/**
 * The addresses inside the pasted-text blocks of the person's latest message, minus those they also typed: passed to
 * `reviewEmail` as `pasted`, so a draft naming one shows it flagged with reason 'pasted' and never pre-fills it.
 */
export const addressesPastedIn = (text: string): string[] => {
  const { typed, pasted } = splitUserText(text);
  if (!pasted) return [];
  const own = addressesIn(typed);
  return addressesIn(pasted).filter((a) => own.indexOf(a) === -1);
};

/**
 * Tie this request's platform scope to `carrier` (the request's clientContext object). A no-op unless `access` is an
 * issued, enabled answer; returns whether it bound. `pastedAddresses` (from `addressesPastedIn`) are flagged by the
 * email review even if they also show up among `userTypedAddresses`.
 */
export const bindPlatformScope = (
  carrier: object,
  access: PlatformDocsAccess,
  userTypedAddresses: readonly string[] = [],
  pastedAddresses: readonly string[] = []
): boolean => {
  if (typeof carrier !== 'object' || carrier === null || !platformDocsEnabled(access)) return false;
  SCOPES.set(
    carrier,
    Object.freeze({
      userId: access.userId,
      platformDocs: access,
      governed: access.governed !== false,
      userTypedAddresses: Object.freeze(userTypedAddresses.slice(0, 100)),
      pastedAddresses: Object.freeze(pastedAddresses.slice(0, 100))
    })
  );
  return true;
};

/** The scope bound to `carrier`, if any (never read from the carrier's own properties). */
export const platformScopeOf = (carrier: unknown): PlatformToolScope | undefined =>
  typeof carrier === 'object' && carrier !== null ? SCOPES.get(carrier) : undefined;

/**
 * The ToolContext fields an agent path adds for the platform tools: the user id, the access answer, governed status,
 * the user's typed addresses and the addresses in what they pasted. Empty (`{}`) when nothing is bound, so a disabled
 * request's ToolContext is unchanged.
 */
export const platformToolContext = (
  carrier: unknown
): { userId?: string; platformDocs?: PlatformDocsAccess; governed?: boolean; userTypedAddresses?: string[]; pastedAddresses?: string[] } => {
  const scope = platformScopeOf(carrier);
  if (!scope) return {};
  return {
    userId: scope.userId,
    platformDocs: scope.platformDocs,
    governed: scope.governed,
    userTypedAddresses: scope.userTypedAddresses.slice(),
    pastedAddresses: scope.pastedAddresses.slice()
  };
};
