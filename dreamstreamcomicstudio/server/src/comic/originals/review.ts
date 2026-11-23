import type { ComicDoc } from '../../../../shared/comic/doc.js';
import {
  HARD_BLOCK,
  SAFETY_CATEGORIES,
  isContentRating,
  publishableText,
  ratingRank,
  type ContentRating,
  type SafetyStatus,
  type SafetyVerdict
} from '../../../../shared/comic/safety.js';
import type { getSupabaseAdmin } from '../../services/supabase.js';
import { gateWindows, type PublishGateResult } from '../safety/publishGate.js';
import { editionDigest, sha256, type OriginalBook } from './book.js';

type Verdict = Pick<SafetyVerdict, 'assessed' | 'categories'>;
const targetReport = (status: SafetyStatus | undefined, verdict?: Verdict) => ({
  status: status ?? 'unchecked',
  assessed: verdict?.assessed ?? null,
  categories: (verdict?.categories ?? []).filter((c) => SAFETY_CATEGORIES.includes(c))
});

/** Operator-facing codes only. No book text, provider answers, filenames or raw moderation notes. */
export function editorialReview(gate: PublishGateResult, judged: ComicDoc) {
  const report = {
    text: targetReport(gate.text.status, judged.safety?.text),
    cover: targetReport(gate.cover?.status, judged.cover.render.asset?.safety),
    pages: judged.pages.map((page) => targetReport(gate.pages[page.id]?.status, page.render.asset?.safety))
  };
  const targets = [report.text, report.cover, ...report.pages];
  const blocked = targets.some((v) => v.assessed === 'X' || v.status === 'blocked' || v.categories.some((c) => HARD_BLOCK.has(c)));
  const cleared =
    gate.status === 'cleared' &&
    gate.rating === judged.settings.rating &&
    report.pages.length === 15 &&
    targets.every((v) => v.status === 'pass' && isContentRating(v.assessed) && ratingRank(v.assessed) <= ratingRank(gate.rating));
  const status: PublishGateResult['status'] = blocked || gate.status === 'blocked' ? 'blocked' : cleared ? 'cleared' : 'needs_check';
  return { status, rating: gate.rating, checkedHash: gate.checkedHash, costUsd: gate.costUsd, report };
}
export type EditorialReview = ReturnType<typeof editorialReview>;

/**
 * This first-edition gate stored the complete decision fingerprint but not the per-target report.
 * Only the reviewed, unchanged edition whose original fingerprint exactly matches the witnesses
 * may start a fresh check. This receipt never grants publication.
 */
const tideRevision = {
  previousDigest: '81fac03b885770c225eb5f169f4243f55e5c9231312b66129ac2c3cfc1fcd9b0',
  previousHash: '395126b9733da1c781857d04',
  previousRating: 'G' as ContentRating,
  candidateDigest: 'd24c7230093e0f37d66d7b3cb680c0c7ab8ec9ddddfd7a816f4d3016de739803',
  rating: 'PG' as ContentRating
};

export function approvedRatingRevision(book: OriginalBook, doc: ComicDoc) {
  const pin = tideRevision;
  if (book.key !== 'tide' || book.digest !== pin.candidateDigest || book.metadata.rating !== pin.rating) return null;
  const previousDigest = editionDigest(book.key, { ...book.metadata, rating: pin.previousRating }, book.images);
  if (previousDigest !== pin.previousDigest) return null;
  const words = publishableText(doc);
  const textHash = sha256((gateWindows(words).length > 1 ? 'w2\n' : '') + pin.previousRating + '\n' + words).slice(0, 16);
  // The historical producer hashes the 15 actual page outcomes, cover, and word verdict in order.
  // Matching all of them proves the images were PG and the words passed G in that original run.
  const evidence = [
    pin.previousRating,
    ...doc.pages.map((page) => 'page:' + page.id + ':' + page.render.asset?.path + ':PG'),
    'cover::' + doc.cover.render.asset?.path + ':PG',
    'text:' + textHash + ':pass'
  ];
  return sha256(evidence.join('\n')).slice(0, 24) === pin.previousHash ? pin : null;
}

type Database = ReturnType<typeof getSupabaseAdmin>;
type ClaimParameters = { p_key: string; p_slug: string; p_digest: string; p_asset_key: string; p_token: string };
export async function claimReviewedEdition(
  db: Database,
  params: ClaimParameters,
  book: OriginalBook,
  doc: ComicDoc,
  review: () => Promise<EditorialReview>
) {
  const claim = await db.rpc('studio_claim_original', params);
  if (!claim.error || claim.error.code !== 'P0001' || claim.error.message !== 'This source differs from the registered edition')
    return claim;
  const revision = approvedRatingRevision(book, doc);
  if (!revision) return claim;
  const reserve = await db.rpc('studio_claim_original_revision', {
    p_key: book.key,
    p_prior_digest: revision.previousDigest,
    p_prior_gate: revision.previousHash,
    p_prior_rating: revision.previousRating,
    p_digest: book.digest,
    p_rating: revision.rating,
    p_token: params.p_token
  });
  if (reserve.error) throw new Error('Editorial rating revision is unavailable.');
  const verdict = await review();
  const recorded = await db.rpc('studio_finish_original_revision', {
    p_key: book.key,
    p_digest: book.digest,
    p_token: params.p_token,
    p_gate_hash: verdict.checkedHash,
    p_status: verdict.status,
    p_report: verdict.report,
    p_cost: verdict.costUsd
  });
  if (recorded.error) throw new Error('Editorial rating revision could not be recorded.');
  if (verdict.status !== 'cleared') throw new Error('The complete original did not clear the publication checks.');
  // The normal issuer resumes from the genuinely checked, leased edition; no public bytes exist before this.
  return db.rpc('studio_claim_original', params);
}
