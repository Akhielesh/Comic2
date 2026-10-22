// PG-13 safety seams (contract §12.6). Wave-0 stub by P0-B; owned in wave 1 by P1-SAFETY,
// which replaces every function IN PLACE (same names, same signatures).
//
// Stub behaviour ("allow / unchecked", buildplan §10): the pre-filter is clear, turn input
// and uploads are allowed, renders get no verdict (URLs are published immediately), the
// publish gate answers `needs_check`, every user is active, the account ceiling is PG-13
// and nobody is cooling down. Nothing here spends money or touches the network.
//
// Who pays (wave 1): every standalone check is platform-paid via keys.platformStudioKeys()
// and recorded with billable_usd 0. Without a platform key the owner's private view fails
// open after 20 s; publishing answers 503 "Safety checks are unavailable right now".

import type { RequestHandler } from 'express';
import { newId, type AssetRef, type ComicDoc, type Msg, type RefAsset, type RefSubject, type RefLabel, type RenderTarget } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import {
  PLATFORM_CEILING,
  canServeToOwner,
  effectiveRating,
  type ContentRating,
  type SafetyCategory,
  type SafetyStatus,
  type SafetyVerdict
} from '../../../../shared/comic/safety.js';
import type { StudioContext } from '../types.js';

// ── Text ─────────────────────────────────────────────────────────────────────

export interface PrefilterResult {
  decision: 'clear' | 'ambiguous' | 'block';
  categories: SafetyCategory[];
  /** Named IP spotted (Shin-chan, LEGO, Marvel…) → the director makes an original homage. */
  ip: string[];
}

/** Free, synchronous word/phrase pre-filter (obscenity + IP list). */
export function prefilterText(_text: string, _rating: ContentRating): PrefilterResult {
  return { decision: 'clear', categories: [], ip: [] };
}

export interface ScreenResult {
  decision: 'allow' | 'adapt' | 'block';
  categories: SafetyCategory[];
  note?: string;
  strike: 0 | 1 | 3;
  blockedAttachmentPaths: string[];
}

/** Screen a user turn (text + attachments) before the director sees it. */
export async function screenTurnInput(
  _ctx: StudioContext,
  _input: { text: string; attachments: RefAsset[]; sourceText?: string; rating: ContentRating }
): Promise<ScreenResult> {
  return { decision: 'allow', categories: [], strike: 0, blockedAttachmentPaths: [] };
}

/** Deterministic reply for a hard block (no director call). */
export async function respondBlocked(ctx: StudioContext, _prepared: { userMsgId: string }, result: ScreenResult): Promise<void> {
  const msg: Msg = {
    id: newId('msg'),
    role: 'assistant',
    text: result.note || "I can't make that one. Let's pick a different idea and keep going.",
    at: Date.now()
  };
  ctx.session.commit([{ op: 'message', msg }]);
}

/** Screen the text inside client patch ops. Throws StudioError CONTENT_POLICY (422) or a 409 suggestion. */
export async function screenPatch(_ctx: StudioContext, _ops: DocOp[], _rating: ContentRating): Promise<void> {
  return;
}

// ── Images ───────────────────────────────────────────────────────────────────

/** Check an uploaded image preview (≤ 768 px); piggybacks a description for ref ranking. */
export async function screenUploadPreview(
  _ctx: StudioContext,
  _preview768: Buffer,
  _surface: 'upload' | 'attachment' | 'import'
): Promise<{
  decision: 'allow' | 'block' | 'unavailable';
  verdict?: SafetyVerdict;
  describe?: { subject: RefSubject; view?: RefLabel; caption: string; multipleSubjects: boolean };
}> {
  return { decision: 'allow' };
}

/** Standalone render check on the platform key (when QC did not fold one in). */
export async function checkRenderSafety(_ctx: StudioContext, _target: RenderTarget, _asset: AssetRef): Promise<SafetyVerdict | undefined> {
  return undefined;
}

/** vision.ts QC folds the safety block into its JSON; missing ⇒ undefined. */
export function verdictFromVision(_raw: unknown, _model?: string): SafetyVerdict | undefined {
  return undefined;
}

/**
 * Commit the verdict (asset_meta); blocked → quarantine + auto-restore the previous pass
 * version + notice/chips; over_rating → warn notice. Stub: nothing to do.
 */
export async function onRenderVerdict(
  _ctx: StudioContext,
  _target: RenderTarget,
  _asset: AssetRef,
  _verdict: SafetyVerdict | undefined
): Promise<void> {
  return;
}

/** May the owner see this asset? Only a `blocked` verdict hides it (never pending/unchecked). */
export function isServableToOwner(asset?: AssetRef): boolean {
  return canServeToOwner(asset);
}

// ── Publish gate ─────────────────────────────────────────────────────────────

export interface PublishGateResult {
  status: 'cleared' | 'needs_check' | 'blocked';
  rating: ContentRating;
  pages: Record<string, { status: SafetyStatus; reasons: string[] }>;
  cover: { status: SafetyStatus; reasons: string[] } | null;
  /** Includes published translations. */
  text: { status: SafetyStatus; reasons: string[] };
  checkedHash: string;
  /** Platform-paid. */
  costUsd: number;
}

/** Gate a publish (both visibilities). Stub: everything unchecked ⇒ `needs_check`. */
export async function runPublishGate(
  ctx: StudioContext,
  doc: ComicDoc,
  opts: { pageIds: string[]; includeCover: boolean; languages: string[] }
): Promise<PublishGateResult> {
  const unchecked = () => ({ status: 'unchecked' as SafetyStatus, reasons: [] as string[] });
  return {
    status: 'needs_check',
    rating: ctx.rating ?? effectiveRating(doc, ctx.caps?.ratingCeiling).rating,
    pages: Object.fromEntries((opts.pageIds || []).map((id) => [id, unchecked()])),
    cover: opts.includeCover ? unchecked() : null,
    text: unchecked(),
    checkedHash: '',
    costUsd: 0
  };
}

// ── Reports, accounts ────────────────────────────────────────────────────────

/** A reader's report on a published comic (always accepted; deduped into cases). */
export async function recordReport(_r: {
  slug: string;
  reason: string;
  note?: string;
  page?: number;
  reporterUserId?: string;
  ipHash: string;
}): Promise<void> {
  return;
}

/** user_moderation_status (60 s cache): suspended → 403; restricted → no spend/upload/publish. Stub: everyone active. */
export function requireActiveUser(): RequestHandler {
  return (_req, _res, next) => next();
}

/** Account-age ceiling from profile_private.dob (10-min LRU; the DOB never reaches the doc). */
export async function accountCeilingFor(_userId: string): Promise<ContentRating> {
  return PLATFORM_CEILING;
}

/** Strike cooldown, if one is active. */
export async function cooldownFor(_userId: string): Promise<{ until: number } | null> {
  return null;
}
