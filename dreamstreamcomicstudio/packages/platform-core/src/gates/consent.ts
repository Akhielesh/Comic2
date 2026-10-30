/**
 * Consent (plan §5.6, §7): agents draft; humans approve every write that leaves the platform.
 *
 * - A tool or flow that reaches an `external-write` stops and returns a `DraftAction`: what would be written, where,
 *   and the hash of the exact payload. Nothing is written.
 * - Only a host route handling a person's click creates the `ConsentRecord` (`recordConsent`), for that action and
 *   that payload hash.
 * - `executeExternalWrite` runs the host's writer only with a matching, fresh record from the same user, for the
 *   very payload that was approved. A changed payload, another user's click, a stale or missing record: refused.
 *
 * There is no send: the kinds are a provider draft, a save to the user's drive, or a publish the user asked for.
 */
import { ID_PATTERN } from '../contract/schema.js';
import { inputHash, isInputHash } from '../audit/inputHash.js';

export const DRAFT_ACTION_KINDS = ['provider-draft', 'drive-save', 'publish'] as const;
export type DraftActionKind = (typeof DRAFT_ACTION_KINDS)[number];

export interface DraftAction {
  id: string;
  kind: DraftActionKind;
  /** One line a person reads before approving ("Save this draft to Gmail"). */
  summary: string;
  /** `inputHash(payload)`: the approval covers exactly this payload. */
  payloadHash: string;
  /** Where it would go, as a short host-defined id (`gmail`, `drive`), never a URL. */
  target: string;
  /** Unix ms. */
  createdAt: number;
}

/** Where the person approved it: a card in chat, the composer, a settings page… (host-defined, short). */
export type ConsentSurface = string;

export interface ConsentRecord {
  draftActionId: string;
  userId: string;
  /** Unix ms of the click. */
  at: number;
  surface: ConsentSurface;
  payloadHash: string;
}

/** A consent older than this no longer authorises the write (the person approves again). */
export const CONSENT_TTL_MS = 15 * 60 * 1000;

export const CONSENT_LIMITS = { summary: 200, target: 64, surface: 64, userId: 128 } as const;

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

const ID = new RegExp(ID_PATTERN);
const SHORT = /^[a-z0-9][a-z0-9._:-]*$/i;

const isMs = (v: unknown): v is number => typeof v === 'number' && isFinite(v) && v >= 0;

/** A draft action for `payload`. Throws `ConsentError` on a malformed field (a programming error). */
export const createDraftAction = (input: { id: string; kind: DraftActionKind; summary: string; target: string; payload: unknown; now: number }): DraftAction => {
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw new ConsentError('draft action id must match ID_PATTERN');
  if (DRAFT_ACTION_KINDS.indexOf(input.kind) === -1) throw new ConsentError('draft action kind must be provider-draft, drive-save or publish');
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > CONSENT_LIMITS.summary || /[\r\n]/.test(input.summary)) {
    throw new ConsentError(`draft action summary must be one line of at most ${CONSENT_LIMITS.summary} characters`);
  }
  if (typeof input.target !== 'string' || input.target.length > CONSENT_LIMITS.target || !SHORT.test(input.target)) {
    throw new ConsentError('draft action target must be a short id, never a URL');
  }
  if (!isMs(input.now)) throw new ConsentError('draft action needs the time');
  return { id: input.id, kind: input.kind, summary: input.summary, payloadHash: inputHash(input.payload), target: input.target, createdAt: input.now };
};

/**
 * The record a host route writes when a signed-in person clicks Approve on `action`. `payloadHash` is the hash the
 * person's screen showed (the client echoes it back); it must equal the action's, so a payload swapped after display
 * cannot be approved. Throws `ConsentError` otherwise. Never call this from an agent or tool path.
 */
export const recordConsent = (action: DraftAction, input: { userId: string; at: number; surface: ConsentSurface; payloadHash: string }): ConsentRecord => {
  if (!action || typeof action.id !== 'string') throw new ConsentError('consent needs the draft action');
  if (typeof input.userId !== 'string' || !input.userId || input.userId.length > CONSENT_LIMITS.userId) throw new ConsentError('consent needs the signed-in user');
  if (typeof input.surface !== 'string' || input.surface.length > CONSENT_LIMITS.surface || !SHORT.test(input.surface)) throw new ConsentError('consent surface must be a short id');
  if (!isMs(input.at) || input.at < action.createdAt) throw new ConsentError('consent cannot come before its draft action');
  if (!isInputHash(input.payloadHash) || input.payloadHash !== action.payloadHash) throw new ConsentError('the approved payload is not the drafted one');
  return { draftActionId: action.id, userId: input.userId, at: input.at, surface: input.surface, payloadHash: action.payloadHash };
};

export type ExternalWriteRefusal = 'no-consent' | 'wrong-action' | 'wrong-user' | 'payload-changed' | 'consent-expired';

export type ExternalWriteResult<R> =
  | { ok: true; result: R }
  | { ok: false; code: 'forbidden' | 'conflict'; reason: ExternalWriteRefusal; message: string }
  | { ok: false; code: 'engine-failed'; reason: 'write-failed'; message: string };

/**
 * Run `write(payload)` only with a matching consent: the same action, the same user, the same payload hash (the
 * payload is re-hashed here), and a click within `CONSENT_TTL_MS`. Never throws: the writer's own failure comes back
 * as `engine-failed`. Making a repeated click idempotent (keyed by `action.id`) stays the host route's job.
 */
export const executeExternalWrite = async <P, R>(
  input: { action: DraftAction; consent: ConsentRecord | null | undefined; payload: P; userId: string; now: number },
  write: (payload: P) => Promise<R>,
): Promise<ExternalWriteResult<R>> => {
  const { action, consent } = input;
  const refuse = (code: 'forbidden' | 'conflict', reason: ExternalWriteRefusal, message: string): ExternalWriteResult<R> => ({ ok: false, code, reason, message });
  if (!consent || typeof consent !== 'object') return refuse('forbidden', 'no-consent', 'Nothing leaves without your approval.');
  if (!action || consent.draftActionId !== action.id) return refuse('forbidden', 'wrong-action', 'That approval was for a different draft.');
  if (typeof input.userId !== 'string' || !input.userId || consent.userId !== input.userId) return refuse('forbidden', 'wrong-user', 'Only the person who approved it can do this.');
  let hash: string;
  try {
    hash = inputHash(input.payload);
  } catch {
    return refuse('conflict', 'payload-changed', 'The draft could not be checked against your approval.');
  }
  if (hash !== action.payloadHash || consent.payloadHash !== action.payloadHash) return refuse('conflict', 'payload-changed', 'The draft changed after you approved it. Review it again.');
  if (!isMs(input.now) || !isMs(consent.at) || consent.at < action.createdAt || input.now - consent.at > CONSENT_TTL_MS || input.now < consent.at) {
    return refuse('forbidden', 'consent-expired', 'That approval has expired. Approve it again.');
  }
  try {
    return { ok: true, result: await write(input.payload) };
  } catch (error) {
    return { ok: false, code: 'engine-failed', reason: 'write-failed', message: error instanceof Error && error.message ? error.message.slice(0, 200) : 'The write failed.' };
  }
};
