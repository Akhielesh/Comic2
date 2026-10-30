// Director tool group "safety" (contract §12.1/§12.2; safety.md §6). Owner: P1-SAFETY.
//
//   set_content_rating     FREE  {rating}  — the author's wish, never above the ceiling (kids audience, account age)
//   request_safety_review  FREE  {target, page?, character?, note?} — a second look on a different model
//                                 (platform-paid), then a human review
//
// Always offered (phase gate: always). The prompt block (§6.1) tells the director the rating's
// story rule, that action/horror/villains are welcome, how to adapt warmly, how to steer named
// IP to an original homage, and that it is never silent. Summary lines show the rating and any
// flagged renders so the director can offer the safer redraw by itself.

import { getRender, pageByNumber, resolveCharacter, targetLabel, type ComicDoc, type RenderTarget } from '../../../../shared/comic/doc.js';
import {
  CONTENT_RATINGS,
  PLATFORM_CEILING,
  RATING_LABEL,
  audienceCeiling,
  effectiveRating,
  isContentRating,
  minRating,
  ratingRank,
  safetyStatusOf,
  type ContentRating
} from '../../../../shared/comic/safety.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup } from '../extensions.js';
import { appealMessage, runAppeal } from '../safety/cases.js';
import { categoryWords, ceilingReasonText, contentPolicyBlock, type RatingReason } from '../safety/contentPolicy.js';
import type { DirectorTurn } from '../tools.js';
import type { StudioContext } from '../types.js';

/** The rating facts for one doc + account ceiling. */
export const ratingFacts = (doc: ComicDoc, accountCeiling: ContentRating = PLATFORM_CEILING) => {
  const eff = effectiveRating(doc, accountCeiling);
  const ceiling = minRating(audienceCeiling(doc), accountCeiling);
  const ceilingReason: RatingReason | undefined =
    ratingRank(accountCeiling) < ratingRank(audienceCeiling(doc)) ? 'account_age' : ratingRank(ceiling) < ratingRank(PLATFORM_CEILING) ? (audienceCeiling(doc) === 'G' ? 'little_kids' : 'kids_audience') : undefined;
  // At the ceiling, name why (a kids comic is G "because of the audience", not "by default").
  const reason: RatingReason | undefined = ceilingReason && eff.rating === ceiling ? ceilingReason : (eff.reason as RatingReason | undefined);
  return { rating: eff.rating, reason, ceiling, ceilingReason, chosen: doc.settings?.rating };
};

/** promptRules(doc) has no context: remember the account ceiling seen by tools() for this doc. */
const ceilingByDoc = new WeakMap<ComicDoc, ContentRating>();

const resolveTarget = (doc: ComicDoc, args: Record<string, unknown>): RenderTarget => {
  const kind = args.target;
  if (kind === 'cover') return { kind: 'cover' };
  if (kind === 'page') {
    const n = Number(args.page);
    if (!Number.isInteger(n) || n < 1) throw toolArgError('page must be a page number (1, 2, …) when target is "page".');
    const page = pageByNumber(doc, n);
    if (!page) throw toolArgError(`There is no page ${n} — the comic has ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}.`);
    return { kind: 'page', id: page.id };
  }
  if (kind === 'sheet') {
    const who = typeof args.character === 'string' ? args.character.trim() : '';
    if (!who) throw toolArgError('character is required when target is "sheet".');
    const c = resolveCharacter(doc, who);
    if (!c) throw toolArgError(`No cast member called "${who.slice(0, 40)}". Cast: ${doc.cast.map((x) => x.name).join(', ') || 'none yet'}.`);
    return { kind: 'sheet', id: c.id };
  }
  throw toolArgError('target must be "page", "cover" or "sheet".');
};

/** Renders the director should know about (blocked / over the rating), most recent first. */
export const flaggedLines = (doc: ComicDoc, rating: ContentRating): string[] => {
  const out: string[] = [];
  const targets: RenderTarget[] = [{ kind: 'cover' }, ...doc.pages.map((p) => ({ kind: 'page' as const, id: p.id })), ...doc.cast.map((c) => ({ kind: 'sheet' as const, id: c.id }))];
  for (const target of targets) {
    const asset = getRender(doc, target)?.asset;
    if (!asset) continue;
    const status = safetyStatusOf(asset.safety, rating);
    if (status === 'blocked') out.push(`${targetLabel(doc, target)} needs a safer redraw (${categoryWords(asset.safety?.categories || [])})`);
    else if (status === 'over_rating') out.push(`${targetLabel(doc, target)} came out ${asset.safety?.assessed} (comic is ${rating})`);
    if (out.length >= 4) break;
  }
  return out;
};

function setContentRating(ctx: StudioContext): DirectorTool {
  return defineTool(
    'set_content_rating',
    'free',
    "Set the comic's content rating (G, PG or PG-13). Kids audiences cap at PG (little kids: G). Use when the user asks for a gentler or more intense comic.",
    { type: 'object', properties: { rating: { type: 'string', enum: [...CONTENT_RATINGS] } }, required: ['rating'], additionalProperties: false },
    (args) => {
      const rating = args.rating;
      if (!isContentRating(rating)) throw toolArgError('rating must be "G", "PG" or "PG-13".');
      const doc = ctx.session.doc;
      const facts = ratingFacts(doc, ctx.caps?.ratingCeiling);
      if (ratingRank(rating) > ratingRank(facts.ceiling)) {
        const why =
          facts.ceilingReason === 'account_age'
            ? 'this account caps at ' + facts.ceiling
            : `the audience is ${doc.brief.audience ? `"${doc.brief.audience.slice(0, 60)}"` : 'kids'}, which caps at ${facts.ceiling}`;
        return `Kept at ${facts.rating} — ${why}.${facts.ceilingReason === 'account_age' ? '' : ' Change the audience to go higher.'}`;
      }
      if (doc.settings?.rating === rating && facts.rating === rating) return `The rating is already ${rating} (${RATING_LABEL[rating].blurb}).`;
      ctx.session.commit([{ op: 'settings', patch: { rating } }], { origin: 'director', label: `Rating ${rating}` });
      const after = ratingFacts(ctx.session.doc, ctx.caps?.ratingCeiling).rating;
      const flagged = flaggedLines(ctx.session.doc, after);
      return `Rating set to ${after} (${RATING_LABEL[after].blurb}).${flagged.length ? ` Still flagged: ${flagged.join('; ')}.` : ''}`;
    }
  );
}

function requestSafetyReview(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'request_safety_review',
    'free',
    'The user thinks a flagged page, cover or sheet is fine: run a free second look on a different model, then a human review. Never for unflagged art.',
    {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['page', 'cover', 'sheet'] },
        page: { type: 'integer', minimum: 1 },
        character: { type: 'string' },
        note: { type: 'string', maxLength: 300 }
      },
      required: ['target'],
      additionalProperties: false
    },
    async (args) => {
      const target = resolveTarget(ctx.session.doc, args);
      const note = typeof args.note === 'string' ? args.note.slice(0, 300) : undefined;
      const result = await runAppeal(ctx, target, note);
      if (result.nextSteps?.length) turn.nextSteps.push(...result.nextSteps.filter((s) => !turn.nextSteps.some((x) => x.label === s.label)));
      return result.message;
    }
  );
}

export const safetyToolGroup: ToolGroup = {
  id: 'safety',
  priority: 5,
  tools: (ctx, turn) => {
    ceilingByDoc.set(ctx.session.doc, ctx.caps?.ratingCeiling ?? PLATFORM_CEILING);
    return [setContentRating(ctx), requestSafetyReview(ctx, turn)];
  },
  promptRules: (doc) => {
    const facts = ratingFacts(doc, ceilingByDoc.get(doc) ?? PLATFORM_CEILING);
    return contentPolicyBlock(facts.rating, facts.reason, facts.ceiling);
  },
  summaryLines: (doc, turn) => {
    const facts = ratingFacts(doc, ceilingByDoc.get(doc) ?? PLATFORM_CEILING);
    const rating = turn?.rating && isContentRating(turn.rating) ? turn.rating : facts.rating;
    const capped = facts.chosen && isContentRating(facts.chosen) && ratingRank(facts.chosen) > ratingRank(rating);
    const reason = ceilingReasonText(facts.ceilingReason, facts.ceiling);
    const why = reason ? reason.charAt(0).toLowerCase() + reason.slice(1) : '';
    const lines = [`Rating: ${rating}${capped ? ` — you set ${facts.chosen}; ${why || 'capped'}` : why ? ` — ${why}` : ''}`];
    const flagged = flaggedLines(doc, rating);
    if (flagged.length) lines.push(`Safety: ${flagged.join('; ')}. Offer the safer redraw (safe: true) or a second look; never re-render it as is.`);
    return lines;
  },
  activity: {
    set_content_rating: 'Setting the rating',
    request_safety_review: 'Asking for a second look'
  }
};

/** Exposed for the action handler (UI "Check again" taps). */
export { appealMessage };
