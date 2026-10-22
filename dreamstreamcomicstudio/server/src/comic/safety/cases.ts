// Reader reports, owner appeals (second opinion → human queue) and the moderator case flow
// (safety.md §3.4, §8). Owner: P1-SAFETY.
//
// Reports arrive by SLUG (never by project id) and are always accepted silently: the caller
// answers 202 before any of this runs, so an unknown slug and a real one are indistinguishable.
// Appeals and moderator decisions write verdicts through the live session, so the owner's
// open studio updates at once. Every moderator action is audited.

import {
  getRender,
  newId,
  renderTargetKey,
  targetLabel,
  type Card,
  type ComicDoc,
  type Msg,
  type NextStep,
  type RenderTarget
} from '../../../../shared/comic/doc.js';
import { SLUG_RE } from '../../../../shared/comic/publication.js';
import {
  PLATFORM_CEILING,
  ZERO_TOLERANCE,
  isContentRating,
  ratingRank,
  safetyStatusOf,
  type AssessedRating,
  type ContentRating,
  type SafetyCategory,
  type SafetyVerdict
} from '../../../../shared/comic/safety.js';
import { logger } from '../../lib/logger.js';
import { StudioError, type AssetStore, type StudioContext, type StudioSessionApi } from '../types.js';
import { SAFETY_CHECK_USD, SECOND_OPINION_TIMEOUT_MS, SECOND_OPINION_USD, checkImage } from './check.js';
import { categoryWords } from './contentPolicy.js';
import { CAPS, DAY, errorFacts, quarantineAsset, ratingOf, recordDecision, safetyDeps, takeSlot } from './deps.js';
import type { CaseTarget, SafetyCase } from './store.js';

// ── Reports ──────────────────────────────────────────────────────────────────

/** Reasons a reader may give (client chips + the share sheet's names). */
export const REPORT_REASONS = ['sexual', 'violent', 'hateful', 'self_harm', 'real_person', 'copyright', 'kids_unsafe', 'spam', 'other'] as const;
export type ReportReasonCode = (typeof REPORT_REASONS)[number];
const REASON_ALIASES: Record<string, ReportReasonCode> = {
  violence: 'violent',
  gore: 'violent',
  hate: 'hateful',
  harassment: 'hateful',
  ip: 'copyright',
  selfharm: 'self_harm'
};
export const normalizeReportReason = (raw: unknown): ReportReasonCode | null => {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[-\s]/g, '_') : '';
  if ((REPORT_REASONS as readonly string[]).includes(key)) return key as ReportReasonCode;
  return REASON_ALIASES[key.replace(/_/g, '')] || REASON_ALIASES[key] || null;
};
/** Reasons serious enough to re-check the reported page right away (platform key). */
const RECHECK_REASONS: ReadonlySet<ReportReasonCode> = new Set(['sexual', 'violent', 'hateful', 'self_harm', 'real_person', 'kids_unsafe']);

/** 3 distinct signed-in reporters (anonymous counts 0.5) within 24 h hold the comic for review. */
export const AUTO_HOLD_WEIGHT = 3;

export interface ReportInput {
  slug: string;
  reason: string;
  note?: string;
  page?: number;
  reporterUserId?: string;
  ipHash: string;
}

const cleanNote = (note: unknown): string | undefined => {
  if (typeof note !== 'string') return undefined;
  // Control characters out, whitespace folded, ≤ 300 (the DB checks it too). Rendered as text only.
  const t = note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return t || undefined;
};

/** Pause a comic while moderators look (publication suspends via the projects trigger). */
async function autoHold(projectId: string, ownerUserId: string, reason: string, metadata: Record<string, unknown>): Promise<void> {
  const deps = safetyDeps();
  const info = await deps.store.projectInfo(projectId).catch(() => null);
  if (info?.isForcedPrivate) return;
  await deps.store.forcePrivate(projectId, reason, null);
  await deps.store.moderationAction({ projectId, ownerUserId, action: 'auto_hold', reason, actedBy: null, metadata });
  await deps.store.notify({
    userId: ownerUserId,
    entityId: projectId,
    title: 'Your comic is paused for a review',
    message: 'Readers flagged your published comic, so it is hidden while a moderator takes a look. You will hear back here.',
    metadata: { action: 'auto_hold' }
  });
  await deps.audit({ action: 'comic.auto_hold', targetType: 'project', targetId: projectId, detail: { reason, ...metadata } });
}

/** A reader's report on a published comic (always accepted; deduped into cases). Never throws. */
export async function recordReportImpl(r: ReportInput): Promise<void> {
  const deps = safetyDeps();
  try {
    if (typeof r?.slug !== 'string' || !SLUG_RE.test(r.slug)) return;
    const reason = normalizeReportReason(r.reason);
    if (!reason) return;
    const pub = await deps.store.publicationBySlug(r.slug);
    if (!pub || pub.status !== 'live') return;
    const page = Number.isInteger(r.page) && (r.page as number) >= 1 && (r.page as number) <= 500 ? (r.page as number) : undefined;
    const snapPage = page && pub.snapshot?.pages ? pub.snapshot.pages[page - 1] : undefined;
    const path = snapPage?.render?.asset?.path;
    const target: CaseTarget = {
      publicationId: pub.publicationId,
      ...(page ? { page } : {}),
      ...(snapPage?.id ? { pageId: snapPage.id } : {}),
      ...(path ? { path } : {})
    };
    const reporterId = typeof r.reporterUserId === 'string' && r.reporterUserId ? r.reporterUserId : null;
    const opened = await deps.store.openCase({
      kind: 'report',
      projectId: pub.projectId,
      ownerUserId: pub.ownerUserId,
      reporterId,
      reporterFingerprint: reporterId ? null : r.ipHash || null,
      target,
      reason,
      note: cleanNote(r.note) ?? null
    });
    if (opened.deduped || !opened.id) return;

    // Re-check the reported page now (platform key, ≤ 20 per comic per day).
    const llm = deps.platformLlm();
    if (path && RECHECK_REASONS.has(reason) && llm && deps.classifierOn() && takeSlot(`report:${pub.projectId}`, CAPS.reportChecksPerProjectDay, DAY)) {
      const assets = await deps.assets();
      const dataUrl = await assets.previewDataUrl(path, 768).catch(() => assets.loadDataUrl(path).catch(() => ''));
      const check = dataUrl ? await checkImage(llm, { dataUrl, by: 'report', now: deps.now() }) : null;
      if (check) {
        const v = check.verdict;
        await deps.store.updateCase(opened.id, { status: 'open', target: { ...target, check: { ...(v.assessed ? { assessed: v.assessed } : {}), categories: v.categories || [], by: 'report' } } });
        await recordDecision({
          userId: pub.ownerUserId,
          projectId: pub.projectId,
          surface: 'report',
          layer: 'vision_check',
          decision: v.assessed === 'X' ? 'withhold' : 'allow',
          categories: v.categories || [],
          ...(v.assessed ? { assessed: v.assessed } : {}),
          severity: 0,
          model: check.model,
          costUsd: check.costUsd ?? SAFETY_CHECK_USD,
          operation: 'comic.safety.report_check'
        });
        if (v.assessed === 'X') {
          await autoHold(pub.projectId, pub.ownerUserId, 'auto: a reported page failed the safety check', { caseId: opened.id, categories: v.categories || [] });
          return;
        }
      }
    }

    // Enough distinct readers in 24 h → hold for review.
    const recent = await deps.store.reportsSince(pub.projectId, deps.now() - DAY);
    const seen = new Set<string>();
    let weight = 0;
    for (const rep of recent) {
      const key = rep.reporterId ? `u:${rep.reporterId}` : rep.fingerprint ? `a:${rep.fingerprint}` : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      weight += rep.reporterId ? 1 : 0.5;
    }
    if (weight >= AUTO_HOLD_WEIGHT) await autoHold(pub.projectId, pub.ownerUserId, 'auto: reader reports', { reporters: seen.size });
  } catch (err) {
    logger.warn('comic_report_failed', { ...errorFacts(err) });
  }
}

// ── Appeals ──────────────────────────────────────────────────────────────────

export interface AppealResult {
  status: 'cleared' | 'queued' | 'checked' | 'fine' | 'missing';
  message: string;
  rating?: AssessedRating;
  nextSteps?: NextStep[];
}

type AppealCtx = Pick<StudioContext, 'session' | 'userId' | 'projectId' | 'assets' | 'rating' | 'caps' | 'publishUrls' | 'signal'>;

const redrawSafer = (target: RenderTarget): NextStep | null => {
  if (target.kind === 'page') return { label: 'Redraw it safer', action: { type: 'render_pages', pageIds: [target.id], force: true, safe: true } };
  if (target.kind === 'cover') return { label: 'Redraw it safer', action: { type: 'render_cover', safe: true } };
  if (target.kind === 'sheet') return { label: 'Redraw the sheet', action: { type: 'render_sheets', characterIds: [target.id], force: true } };
  return null;
};

/** The steps offered with a flagged render. */
export const flaggedSteps = (target: RenderTarget, opts: { checkAgain?: boolean; changeRating?: ContentRating } = {}): NextStep[] => {
  const steps: NextStep[] = [];
  const redraw = redrawSafer(target);
  if (redraw) steps.push(redraw);
  if (opts.changeRating) steps.push({ label: `Set the rating to ${opts.changeRating}`, action: { type: 'patch', ops: [{ op: 'settings', patch: { rating: opts.changeRating } }] }, usd: 0 });
  if (opts.checkAgain !== false) steps.push({ label: 'This looks fine — check again', action: { type: 'safety_recheck', target }, usd: 0 });
  return steps;
};

/**
 * "This looks fine — check again": a free second look on a different model (platform key),
 * auto-clearing only when it rates the image within the comic's rating AND the first verdict
 * was not zero-tolerance; otherwise a human reviews it. 5 per day per owner.
 */
export async function runAppeal(ctx: AppealCtx, target: RenderTarget, note?: string): Promise<AppealResult> {
  const deps = safetyDeps();
  const doc = ctx.session.doc;
  const asset = getRender(doc, target)?.asset;
  const label = targetLabel(doc, target);
  if (!asset) return { status: 'missing', message: `There's no drawn image for ${label} to check yet.` };
  const rating = ratingOf(ctx, doc);
  const first = asset.safety;
  const status = safetyStatusOf(first, rating);
  if (status === 'pass') return { status: 'fine', message: `${label} already passed the check — nothing to review.` };

  const now = deps.now();
  const used = Math.max(await deps.store.appealsSince(ctx.userId, now - DAY).catch(() => 0), 0);
  if (used >= CAPS.appealsPerDay || !takeSlot(`appeal:${ctx.userId}`, CAPS.appealsPerDay, DAY)) {
    throw new StudioError('RATE_LIMIT', "You've asked for 5 second looks today — try again tomorrow, or redraw it safer now.", { status: 429 });
  }

  const llm = deps.platformLlm();
  const quarantinePath = first?.quarantined ? await deps.store.quarantineFor(asset.path).catch(() => null) : null;
  const source = quarantinePath || asset.path;
  const zeroTolerance = (first?.categories || []).some((c) => ZERO_TOLERANCE.has(c));
  const cleanNoteText = cleanNote(note);

  let second: Awaited<ReturnType<typeof checkImage>> = null;
  if (llm && deps.classifierOn() && !zeroTolerance) {
    const dataUrl = await ctx.assets.previewDataUrl(source, 768).catch(() => ctx.assets.loadDataUrl(source).catch(() => ''));
    if (dataUrl) {
      second = await checkImage(llm, {
        dataUrl,
        rating,
        by: 'second_opinion',
        role: 'writer',
        ...(cleanNoteText ? { note: cleanNoteText } : {}),
        timeoutMs: SECOND_OPINION_TIMEOUT_MS,
        now
      });
    }
  }
  const secondOk = !!second?.verdict.assessed && ratingRank(second.verdict.assessed) <= ratingRank(rating) && !zeroTolerance;
  const caseTarget: CaseTarget = {
    target,
    path: asset.path,
    ...(quarantinePath ? { quarantinePath } : {}),
    check: { ...(first?.assessed ? { assessed: first.assessed } : {}), categories: first?.categories || [], by: first?.by || 'qc' }
  };

  if (second && secondOk) {
    let restored = true;
    if (quarantinePath) {
      try {
        await ctx.assets.copyObject(quarantinePath, asset.path);
        await deps.store.forgetQuarantine(asset.path);
      } catch (err) {
        restored = false;
        logger.warn('comic_appeal_restore_failed', { projectId: ctx.projectId, ...errorFacts(err) });
      }
    }
    if (restored) {
      const verdict: SafetyVerdict = { ...second.verdict, by: 'second_opinion' };
      ctx.session.commit([{ op: 'asset_meta', path: asset.path, patch: { safety: verdict } }], { origin: 'job' });
      await deps.store.openCase({ kind: 'appeal', projectId: ctx.projectId, ownerUserId: ctx.userId, target: caseTarget, reason: 'second opinion cleared', note: cleanNoteText ?? null, status: 'auto_cleared' });
      await recordDecision({
        userId: ctx.userId,
        projectId: ctx.projectId,
        surface: 'appeal',
        layer: 'second_opinion',
        decision: 'restore',
        categories: second.verdict.categories || [],
        effective: rating,
        ...(second.verdict.assessed ? { assessed: second.verdict.assessed } : {}),
        severity: 0,
        model: second.model,
        costUsd: second.costUsd ?? SECOND_OPINION_USD,
        operation: 'comic.safety.second_opinion'
      });
      await ctx.publishUrls([asset.path]).catch(() => undefined);
      return { status: 'cleared', rating: second.verdict.assessed, message: `Second look: ${label} is fine (${second.verdict.assessed}) — it's back.` };
    }
  }

  // A human decides (usually within a day).
  await deps.store.openCase({
    kind: 'appeal',
    projectId: ctx.projectId,
    ownerUserId: ctx.userId,
    target: { ...caseTarget, ...(second ? { check: { ...caseTarget.check, assessed: second.verdict.assessed, categories: second.verdict.categories || [], by: 'second_opinion' } } : {}) },
    reason: second ? 'second opinion agreed' : 'second opinion unavailable',
    note: cleanNoteText ?? null
  });
  await deps.store.moderationAction({ projectId: ctx.projectId, ownerUserId: ctx.userId, action: 'appeal', reason: renderTargetKey(target), actedBy: ctx.userId, metadata: { source: 'owner_appeal' } });
  if (second) {
    await recordDecision({
      userId: ctx.userId,
      projectId: ctx.projectId,
      surface: 'appeal',
      layer: 'second_opinion',
      decision: 'withhold',
      categories: second.verdict.categories || [],
      effective: rating,
      ...(second.verdict.assessed ? { assessed: second.verdict.assessed } : {}),
      severity: 0,
      model: second.model,
      costUsd: second.costUsd ?? SECOND_OPINION_USD,
      operation: 'comic.safety.second_opinion'
    });
  }
  const ceiling = ctx.caps?.ratingCeiling ?? PLATFORM_CEILING;
  const assessed = second?.verdict.assessed;
  const canRaise = status === 'over_rating' && assessed && assessed !== 'X' && ratingRank(assessed) <= ratingRank(ceiling) ? (assessed as ContentRating) : undefined;
  const steps = flaggedSteps(target, { checkAgain: false, ...(canRaise ? { changeRating: canRaise } : {}) });
  const message = second
    ? `Second look agrees ${label} goes past ${rating}, so I've sent it to a human reviewer (usually within a day).${canRaise ? ` Or set the comic to ${canRaise}.` : ''}`
    : `I couldn't run a second look right now, so I've sent ${label} to a human reviewer (usually within a day).`;
  return { status: 'queued', message, ...(assessed ? { rating: assessed } : {}), nextSteps: steps };
}

/** Commit the appeal outcome as an assistant message (UI taps and the REST route). */
export const appealMessage = (session: StudioSessionApi, result: AppealResult): Msg => {
  const card: Card = { type: 'notice', id: newId('card'), tone: result.status === 'cleared' ? 'success' : result.status === 'queued' ? 'info' : 'info', text: result.message };
  const msg: Msg = { id: newId('msg'), role: 'assistant', text: result.message, at: Date.now(), cards: [card], ...(result.nextSteps?.length ? { nextSteps: result.nextSteps } : {}) };
  session.commit([{ op: 'message', msg }]);
  return msg;
};

// ── Moderator cases ──────────────────────────────────────────────────────────

export interface CaseView {
  id: string;
  kind: SafetyCase['kind'];
  status: SafetyCase['status'];
  projectId: string;
  projectName?: string;
  reason: string;
  note?: string;
  reporter: 'user' | 'anonymous' | 'owner' | 'system';
  target: { kind?: RenderTarget['kind']; page?: number; label?: string; hasAsset: boolean; check?: CaseTarget['check'] };
  resolution?: string;
  createdAt: number;
  resolvedAt?: number;
}

export const caseView = (c: SafetyCase, names: Record<string, string> = {}): CaseView => {
  const t = c.target || {};
  const label = t.target ? (t.target.kind === 'cover' ? 'Cover' : t.target.kind === 'page' ? 'Page' : t.target.kind) : t.page ? `Page ${t.page}` : undefined;
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    projectId: c.projectId,
    ...(names[c.projectId] ? { projectName: names[c.projectId] } : {}),
    reason: c.reason,
    ...(c.note ? { note: c.note } : {}),
    reporter: c.kind === 'report' ? (c.reporterId ? 'user' : 'anonymous') : c.kind === 'appeal' ? 'owner' : 'system',
    target: {
      ...(t.target ? { kind: t.target.kind } : t.page ? { kind: 'page' as const } : {}),
      ...(t.page ? { page: t.page } : {}),
      ...(label ? { label } : {}),
      hasAsset: !!(t.path || t.quarantinePath),
      ...(t.check ? { check: t.check } : {})
    },
    ...(c.resolution ? { resolution: c.resolution } : {}),
    createdAt: c.createdAt,
    ...(c.resolvedAt ? { resolvedAt: c.resolvedAt } : {})
  };
};

export const CASE_URL_TTL_SEC = 300;

/** A 5-minute signed URL for a case's image (quarantine first), audited. */
export async function caseAssetUrl(actorId: string, caseId: string): Promise<{ url: string; expiresAt: number } | null> {
  const deps = safetyDeps();
  const c = await deps.store.getCase(caseId);
  if (!c) return null;
  const path = c.target?.quarantinePath || (c.target?.path ? (await deps.store.quarantineFor(c.target.path).catch(() => null)) || c.target.path : null);
  if (!path) return null;
  const assets = await deps.assets();
  const urls = await assets.signUrls([path], { ttlSec: CASE_URL_TTL_SEC }).catch(() => ({}) as Record<string, string>);
  const url = urls[path];
  await deps.audit({ actorId, action: 'comic.safety.asset_view', targetType: 'comic_safety_case', targetId: caseId, detail: { projectId: c.projectId, quarantined: path.startsWith('q/') } });
  return url ? { url, expiresAt: deps.now() + CASE_URL_TTL_SEC * 1000 } : null;
}

export type ResolveAction = 'dismiss' | 'withhold' | 'restore' | 'force_private';
export const RESOLVE_ACTIONS: readonly ResolveAction[] = ['dismiss', 'withhold', 'restore', 'force_private'];

const OWNER_COPY: Record<ResolveAction, { title: string; message: string }> = {
  dismiss: { title: 'Review finished', message: 'A moderator reviewed the flag on your comic and found nothing to change.' },
  withhold: { title: 'An image was withheld', message: "A moderator withheld an image from your comic because it didn't fit the content rules. Redraw it safer from the studio." },
  restore: { title: 'Your image is back', message: 'A moderator reviewed your image and restored it.' },
  force_private: { title: 'Your comic is paused', message: "A moderator made your comic private because it didn't fit the content rules. You can ask for a review from the studio." }
};

async function liveVerdict(c: SafetyCase, verdict: SafetyVerdict, assets: AssetStore, opts: { restoreObject?: boolean } = {}): Promise<boolean> {
  const deps = safetyDeps();
  const path = c.target?.path;
  if (!path || !c.target?.target || !c.ownerUserId) return false;
  const session = await deps.liveSession(c.projectId, c.ownerUserId);
  if (!session) return false;
  if (opts.restoreObject) {
    const q = c.target.quarantinePath || (await deps.store.quarantineFor(path).catch(() => null));
    if (q) {
      try {
        await assets.copyObject(q, path);
        await deps.store.forgetQuarantine(path);
      } catch (err) {
        logger.warn('comic_case_restore_copy_failed', { projectId: c.projectId, ...errorFacts(err) });
        return false;
      }
    }
  }
  session.commit([{ op: 'asset_meta', path, patch: { safety: verdict } }], { origin: 'job' });
  await session.flush().catch(() => undefined);
  return true;
}

/** Remove a withheld page's public copies (pub/… object and its variants) from a live publication. */
async function removePublishedCopy(c: SafetyCase, assets: AssetStore): Promise<number> {
  const deps = safetyDeps();
  const pub = await deps.store.publicationByProject(c.projectId).catch(() => null);
  const snapshot = pub?.snapshot as ComicDoc | null | undefined;
  if (!snapshot?.pages) return 0;
  const page = c.target.pageId ? snapshot.pages.find((p) => p.id === c.target.pageId) : c.target.page ? snapshot.pages[c.target.page - 1] : undefined;
  const asset = page?.render?.asset;
  if (!asset?.path) return 0;
  const paths = [asset.path, ...(asset.variants || []).map((v) => v.path)].filter((p) => typeof p === 'string' && p.startsWith('pub/'));
  if (!paths.length) return 0;
  await assets.remove(paths).catch((err) => logger.warn('comic_case_pub_remove_failed', { projectId: c.projectId, ...errorFacts(err) }));
  return paths.length;
}

/**
 * Resolve a case: dismiss | withhold (X by admin + quarantine; a published copy is removed and
 * the comic paused) | restore (admin verdict, object moved back) | force_private. Audited,
 * logged in project_moderation_actions, and the owner is told.
 */
export async function resolveCase(
  actorId: string,
  caseId: string,
  body: { action: ResolveAction; assessed?: AssessedRating; reason: string }
): Promise<{ case: CaseView; effects: string[] }> {
  const deps = safetyDeps();
  const c = await deps.store.getCase(caseId);
  if (!c) throw new StudioError('NOT_FOUND', 'That case no longer exists.', { status: 404 });
  if (c.status !== 'open') throw new StudioError('BAD_REQUEST', 'That case is already closed.', { status: 409 });
  const reason = String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const info = await deps.store.projectInfo(c.projectId).catch(() => null);
  const ownerUserId = c.ownerUserId || info?.ownerUserId || null;
  const assets = await deps.assets();
  const effects: string[] = [];
  const now = deps.now();
  const categories: SafetyCategory[] = c.target?.check?.categories || [];
  let action: string | null = 'appeal_resolved';
  let status: SafetyCase['status'] = 'resolved';

  switch (body.action) {
    case 'dismiss':
      status = 'dismissed';
      action = c.kind === 'appeal' ? 'appeal_resolved' : null;
      effects.push('dismissed');
      break;
    case 'withhold': {
      action = 'withhold_page';
      if (c.target?.path && c.target.target) {
        const q = c.target.path.startsWith('pub/') ? null : await quarantineAsset(assets, { path: c.target.path, projectId: c.projectId, userId: ownerUserId, categories });
        const ok = await liveVerdict(c, { assessed: 'X', categories, by: 'admin', at: now, ...(q || c.target.quarantinePath ? { quarantined: true } : {}) }, assets);
        if (ok) effects.push('verdict_x');
        if (q) effects.push('quarantined');
      }
      const removed = await removePublishedCopy(c, assets);
      if (removed) {
        effects.push('public_copy_removed');
        if (!info?.isForcedPrivate) {
          await deps.store.forcePrivate(c.projectId, 'moderator: a published page was withheld', actorId);
          effects.push('paused');
        }
      }
      break;
    }
    case 'restore': {
      action = c.kind === 'appeal' ? 'appeal_resolved' : 'restore_page';
      const assessed: ContentRating = isContentRating(body.assessed) ? body.assessed : 'PG';
      const ok = await liveVerdict(c, { assessed, by: 'admin', at: now }, assets, { restoreObject: true });
      effects.push(ok ? 'restored' : 'verdict_not_written');
      break;
    }
    case 'force_private':
      action = 'force_private';
      await deps.store.forcePrivate(c.projectId, reason || 'moderator decision', actorId);
      effects.push('paused');
      break;
    default:
      throw new StudioError('BAD_REQUEST', 'Unknown action.', { status: 400 });
  }

  await deps.store.updateCase(c.id, { status, resolution: `${body.action}${reason ? `: ${reason}` : ''}`, resolvedBy: actorId });
  if (action) await deps.store.moderationAction({ projectId: c.projectId, ownerUserId, action, reason: reason || null, actedBy: actorId, metadata: { source: 'comic_safety_case', caseId: c.id, effects } });
  await deps.audit({ actorId, action: 'comic.safety.resolve', targetType: 'comic_safety_case', targetId: c.id, detail: { projectId: c.projectId, action: body.action, effects } });
  if (ownerUserId && !(body.action === 'dismiss' && c.kind === 'report')) {
    await deps.store.notify({ userId: ownerUserId, actorId, entityId: c.projectId, title: OWNER_COPY[body.action].title, message: OWNER_COPY[body.action].message, metadata: { action: body.action } });
  }
  await recordDecision({
    userId: ownerUserId,
    projectId: c.projectId,
    surface: c.kind === 'report' ? 'report' : 'appeal',
    layer: 'admin',
    decision: body.action === 'restore' || body.action === 'dismiss' ? 'restore' : 'withhold',
    categories,
    severity: 0
  });
  const updated = (await deps.store.getCase(c.id)) || { ...c, status };
  return { case: caseView(updated), effects };
}

export const describeCategories = categoryWords;
