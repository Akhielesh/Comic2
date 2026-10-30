// Content safety — PG-13 platform ceiling (contract §9.1).
//
// BINDING rule: effective rating = min(user choice ?? defaultRating, audience ceiling, account-age ceiling).
// Kids → PG, little kids → G. Everything here is pure and $0; the classifiers live server-side.

import type { ComicDoc } from './doc.js';
import { i18nOf } from './i18n.js';

export type ContentRating = 'G' | 'PG' | 'PG-13';
export type AssessedRating = ContentRating | 'X';
export const CONTENT_RATINGS: readonly ContentRating[] = ['G', 'PG', 'PG-13'];
export const PLATFORM_CEILING: ContentRating = 'PG-13';

export type SafetyCategory =
  | 'sexual' | 'minor_sexual' | 'nudity' | 'graphic_gore' | 'self_harm' | 'hate' | 'harassment' | 'real_person' | 'dangerous'
  | 'violence' | 'scary' | 'language' | 'romance' | 'substances' | 'weapons'
  | 'ip_parody';
export const SAFETY_CATEGORIES: readonly SafetyCategory[] = [
  'sexual', 'minor_sexual', 'nudity', 'graphic_gore', 'self_harm', 'hate', 'harassment', 'real_person', 'dangerous',
  'violence', 'scary', 'language', 'romance', 'substances', 'weapons',
  'ip_parody'
];
export const HARD_BLOCK: ReadonlySet<SafetyCategory> = new Set<SafetyCategory>([
  'sexual', 'minor_sexual', 'nudity', 'graphic_gore', 'self_harm', 'hate', 'harassment', 'real_person', 'dangerous'
]);
export const ZERO_TOLERANCE: ReadonlySet<SafetyCategory> = new Set<SafetyCategory>(['minor_sexual']);

export interface SafetyVerdict {
  /** Assessed rating of THIS image/text. Absent while pending or unchecked. */
  assessed?: AssessedRating;
  categories?: SafetyCategory[];
  /** ≤ 2 neutral, non-graphic phrases for the owner. */
  notes?: string[];
  /** Check in flight; the owner sees "Checking…". */
  pending?: true;
  /** Object lives in the private bucket's quarantine lane; never signed or served. */
  quarantined?: true;
  by?: 'qc' | 'check' | 'upload' | 'provider' | 'second_opinion' | 'admin' | 'report';
  model?: string;
  at: number;
}
export type SafetyStatus = 'unchecked' | 'pending' | 'pass' | 'over_rating' | 'blocked';

const RANK: Record<AssessedRating, number> = { G: 0, PG: 1, 'PG-13': 2, X: 3 };
export const isContentRating = (v: unknown): v is ContentRating => v === 'G' || v === 'PG' || v === 'PG-13';
export const ratingRank = (r: AssessedRating): number => RANK[r] ?? 3;
/** Lowest defined rating; PG-13 when none is given. */
export const minRating = (...rs: (ContentRating | undefined)[]): ContentRating =>
  rs.reduce<ContentRating>((lo, r) => (r && isContentRating(r) && RANK[r] < RANK[lo] ? r : lo), PLATFORM_CEILING);

export const safetyStatusOf = (v: SafetyVerdict | undefined, effective: ContentRating): SafetyStatus => {
  if (v?.quarantined || v?.assessed === 'X') return 'blocked';
  if (!v) return 'unchecked';
  if (v.pending && !v.assessed) return 'pending';
  if (!v.assessed) return 'unchecked';
  return ratingRank(v.assessed) > ratingRank(effective) ? 'over_rating' : 'pass';
};
export const canServeToOwner = (a?: { safety?: SafetyVerdict }): boolean => safetyStatusOf(a?.safety, PLATFORM_CEILING) !== 'blocked';
export const canServeToPublic = (a: { safety?: SafetyVerdict } | undefined, rating: ContentRating): boolean =>
  safetyStatusOf(a?.safety, rating) === 'pass';

// ── Audience ─────────────────────────────────────────────────────────────────

type AudienceDoc = Pick<ComicDoc, 'brief' | 'format'>;

const KIDS_WORDS = /\b(kids?|child|children|childrens|toddlers?|preschool(?:ers)?|young readers|little ones)\b|बच्चे|बच्चों|పిల్లల/i;
const LITTLE_WORDS = /\b(toddlers?|preschool(?:ers)?|babies|baby|little kids|little ones|nursery)\b/i;
/** "ages 2–6", "age 5", "kids 3-7", "for 8 to 12", "6 year olds". Returns the max age mentioned in an age context. */
const maxAgeMentioned = (text: string): number | undefined => {
  let max: number | undefined;
  const bump = (n: number) => {
    if (Number.isFinite(n) && n <= 99) max = max === undefined ? n : Math.max(max, n);
  };
  const range = /\b(?:ages?|aged|kids?|children|readers|for)\s*(\d{1,2})\s*(?:\+|(?:[-–—]|\s+to\s+)\s*(\d{1,2}))?/gi;
  for (let m = range.exec(text); m; m = range.exec(text)) bump(Number(m[2] ?? m[1]));
  const years = /\b(\d{1,2})\s*(?:[-–—]\s*(\d{1,2})\s*)?(?:-|\s)?(?:years?|yrs?)[-\s]?olds?\b/gi;
  for (let m = years.exec(text); m; m = years.exec(text)) bump(Number(m[2] ?? m[1]));
  return max;
};
const hasPlus = (text: string) => /\b\d{1,2}\s*\+/.test(text);

const audienceText = (doc: AudienceDoc) => [doc.brief.audience || '', ...(doc.brief.notes || [])].join(' \n ');

/** kid(s), child(ren), toddler, preschool, young readers, ages N(–M) with max < 13, format.kind==='storybook',
 *  बच्चे/बच्चों (hi), పిల్లల (te); applied to brief.audience, brief.notes, brief.premise. */
export const isKidsAudience = (doc: AudienceDoc): boolean => {
  if (doc.format.kind === 'storybook') return true;
  const text = `${audienceText(doc)} \n ${doc.brief.premise || ''}`;
  if (KIDS_WORDS.test(text) && !/\b(teens?|adults?|grown-?ups?)\b/i.test(doc.brief.audience || '')) return true;
  const audience = audienceText(doc);
  const max = maxAgeMentioned(audience);
  return max !== undefined && max < 13 && !hasPlus(audience);
};

/** toddler|preschool|baby|little kids|ages? [0-6]|2[–-][4-6] … ("kids 2–6" → true). Audience + notes only. */
export const isLittleKidsAudience = (doc: AudienceDoc): boolean => {
  const text = audienceText(doc);
  if (LITTLE_WORDS.test(text)) return true;
  const max = maxAgeMentioned(text);
  return max !== undefined && max <= 6 && !hasPlus(text);
};

export const audienceCeiling = (doc: AudienceDoc): ContentRating =>
  isLittleKidsAudience(doc) ? 'G' : isKidsAudience(doc) ? 'PG' : PLATFORM_CEILING;

const FAMILY_RE = /\b(all ages|family|families|everyone|general audiences?)\b/i;
export const defaultRating = (doc: AudienceDoc): ContentRating => {
  if (isKidsAudience(doc) || isLittleKidsAudience(doc)) return audienceCeiling(doc);
  return FAMILY_RE.test(audienceText(doc)) ? 'PG' : PLATFORM_CEILING;
};

/** BINDING: effective = min(user choice ?? defaultRating, audience ceiling, account-age ceiling). */
export const effectiveRating = (
  doc: Pick<ComicDoc, 'brief' | 'format' | 'settings'>,
  accountCeiling: ContentRating = 'PG-13'
): { rating: ContentRating; reason?: 'little_kids' | 'kids_audience' | 'account_age' | 'chosen' | 'default' } => {
  const chosen = doc.settings?.rating && isContentRating(doc.settings.rating) ? doc.settings.rating : undefined;
  const wish = chosen ?? defaultRating(doc);
  const audience = audienceCeiling(doc);
  const account = isContentRating(accountCeiling) ? accountCeiling : PLATFORM_CEILING;
  const rating = minRating(wish, audience, account);
  if (ratingRank(rating) < ratingRank(wish)) {
    if (rating === audience) return { rating, reason: isLittleKidsAudience(doc) ? 'little_kids' : 'kids_audience' };
    return { rating, reason: 'account_age' };
  }
  return { rating, reason: chosen ? 'chosen' : 'default' };
};

// ── Rules & copy ─────────────────────────────────────────────────────────────

export const RATING_LABEL: Record<ContentRating, { short: string; blurb: string }> = {
  G: { short: 'G', blurb: 'Everyone — gentle peril, no weapons used on anyone' },
  PG: { short: 'PG', blurb: 'All ages — bloodless action, short spooky moments' },
  'PG-13': { short: 'PG-13', blurb: 'Teens+ — intense action and horror, no gore or sexual content' }
};

/** safety.md §2.2 table verbatim: story rule (writer/director), art rule (compilers), avoid[] (Never: line). */
export const RATING_RULES: Record<ContentRating, { story: string; art: string; avoid: string[] }> = {
  G: {
    story:
      'Conflict is solved by cleverness, kindness or teamwork. Peril is brief and mild and resolves on the same page. No weapons used against anyone. No insults beyond "silly". No scary imagery beyond "a little spooky".',
    art: 'Soft, friendly shapes. No weapons aimed at anyone. No blood or injury. Villains look goofy rather than menacing. Bright, safe settings.',
    avoid: ['weapons aimed at anyone', 'blood or injury', 'menacing villains', 'scary imagery']
  },
  PG: {
    story:
      'Action, fantasy battles and spooky moments are fine. Violence is bloodless and slapstick or heroic. Nobody is shown seriously hurt. Scares are short and resolved. Mild language only. Romance stops at a kiss.',
    art: 'Bloodless impacts (motion lines, dust and "POW" energy instead of wounds). Defeated foes are knocked out, never wounded. Creepy is OK; grotesque is not. Modest clothing.',
    avoid: ['blood or wounds', 'grotesque imagery', 'immodest clothing']
  },
  'PG-13': {
    story:
      'Intense action, horror and suspense are fine. Injuries can be implied, or shown with minimal blood and never lingered on. Deaths happen off-panel or non-graphically. Moderate language, with no slurs and no f-word. Romance stops at a kiss.',
    art: 'Dramatic violence with minimal blood: no exposed wounds, no gore, no dismemberment. Horror relies on shadow, silhouette and reaction shots rather than viscera. Modest clothing and no sexualized poses.',
    avoid: ['exposed wounds', 'gore', 'dismemberment', 'sexualized poses']
  }
};
/** The "Always" row (story side); the art side is ALWAYS_ART_AVOID. */
export const ALWAYS_RULE =
  'Never: sexual content or nudity, sexualizing anyone (never anything involving minors), graphic gore or torture, glorified self-harm, hate or harassment, sexual or defamatory content about real people, real-world instructions for weapons, drugs or harm.';
export const ALWAYS_ART_AVOID: readonly string[] = [
  'nudity', 'sexualized poses or outfits', 'gore or exposed wounds', 'slurs or hate symbols', 'real-world brand logos', 'likeness of real celebrities'
];

/** One-notch-stricter "safe take" (deterministic, $0). */
export const SAFE_TAKE_LINE =
  'SAFE TAKE: draw this one notch gentler than the rating allows — bloodless impacts, no weapons pointed at anyone, tension shown through expressions and reactions instead of injuries.';
export const saferRating = (r: ContentRating): ContentRating => (r === 'PG-13' ? 'PG' : 'G');

const SOFTEN: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:blood(?:y|ied|stained|-soaked)?|gore|gory|guts)\b\s*/gi, ''],
  [/\bstab(?:s|bed|bing)?\b/gi, 'lunges at'],
  [/\bdecapitat\w*\b/gi, 'defeats'],
  [/\b(?:naked|nude)\b/gi, 'in plain clothes'],
  [/\bcorpses?\b/gi, 'fallen figure']
];
/** blood|bloody|gore|guts → removed; stabs → lunges at; decapitate* → defeats; naked|nude → in plain clothes; corpse → fallen figure. */
export const softenAction = (text: string): string => {
  let out = typeof text === 'string' ? text : '';
  for (const [re, to] of SOFTEN) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
};

/** Every publishable word for the text hash/check: title, logline, cover title/tagline, cast names, every line,
 *  chapter titles, book blurb + credits, End-card credits + dedication, the style name, plus the given published
 *  languages' translations. Stable order. */
export const publishableText = (doc: ComicDoc, langs?: string[]): string => {
  const parts: string[] = [doc.brief.title || '', doc.brief.logline || '', doc.cover.title || '', doc.cover.tagline || ''];
  for (const c of doc.cast) parts.push(c.name || '');
  const lines = doc.pages.flatMap((p) => p.panels.flatMap((panel) => panel.lines));
  for (const l of lines) parts.push(l.text || '');
  // Every other author text the public snapshot publishes (P2-AMEND, from P1-PUBLISH): chapter titles, the
  // back-cover blurb, book credits, the End-card credits and dedication, and the style name. Appended after the
  // lines, so docs without them keep their exact text (and their cached text-check hash).
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  for (const p of doc.pages) parts.push(str(p.chapterTitle));
  parts.push(str(doc.book?.blurb));
  for (const c of Array.isArray(doc.book?.credits) ? doc.book!.credits : []) parts.push(str(c));
  parts.push(str(doc.reader?.credits), str(doc.reader?.dedication), str(doc.style?.name));
  const editions = i18nOf(doc).editions;
  for (const lang of [...(langs || [])].sort()) {
    const e = editions[lang];
    if (!e) continue;
    parts.push(e.cover?.title?.text || '', e.cover?.tagline?.text || '', e.brief?.title?.text || '', e.brief?.logline?.text || '');
    for (const l of lines) parts.push(e.lines[l.id]?.text || '');
  }
  return parts.map((p) => p.trim()).filter(Boolean).join('\n');
};
