// The director never goes silent (contract §12.2 "always-speaks", director.md §3.1–§3.4).
//
// Pure, $0 helpers that turn what a director turn ACTUALLY did into plain user-facing words:
//  - composeTurnReply: the reply when the model said nothing (tool calls only, ask_user only…),
//  - reconcileReply: keeps a model reply honest about renders that already failed this turn
//    (production bug 2026-10-22: "I've kicked off 3 style tests" 7 s after all three had failed),
//  - recapLine: "a 1-page storybook for kids 2–6 — The Baby with three Ducklings, a Frog and a Bunny",
//  - materialGaps: the one open question worth asking (feeds OPEN QUESTIONS in the doc summary),
//  - drawIntentOf + DRAW_RE / REDRAW_RE / SKIP_REVIEW_RE: never spend on a question or complaint,
//  - detectNamedIp: trademarked names the director should turn into an original homage,
//  - next-step chips for the $0 "nothing to draw" outcome and for retrying failed renders.
// Nothing here calls a model, touches storage or reads the clock except through its inputs.

import {
  DEFAULT_FORMAT,
  castKindOf,
  castNoun,
  getRender,
  isPageStale,
  isTargetStale,
  renderTargetKey,
  targetLabel,
  totalPanels,
  type Card,
  type Character,
  type ComicDoc,
  type NextStep,
  type RenderTarget
} from '../../../shared/comic/doc.js';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import { estimateJobs, formatUsd, type ImageJobKind } from '../../../shared/comic/models.js';
import { coverNeedsDraw, pageTargets } from '../../../shared/comic/plan.js';
import type { DirectorTurn } from './tools.js';

// ── Text helpers ─────────────────────────────────────────────────────────────

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const words = (s: string) => (s.match(/\S+/g) || []).length;

/** "a, b and c". */
export const joinList = (items: string[]): string => {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

/** Sentences (split after . ! ? — never inside "$0.07" or "v1.2"). */
export const sentencesOf = (text: string): string[] =>
  clean(text)
    .split(/(?<=[.!?]["”')]*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Keep whole sentences up to `max` words (never cuts mid-sentence unless one sentence is longer). */
export const limitWords = (text: string, max = 60): string => {
  const sentences = sentencesOf(text);
  const out: string[] = [];
  let n = 0;
  for (const s of sentences) {
    const w = words(s);
    if (out.length && n + w > max) break;
    out.push(s.trim());
    n += w;
  }
  const joined = out.join(' ').trim();
  return words(joined) > max + 20 ? `${joined.split(/\s+/).slice(0, max).join(' ')}…` : joined;
};

// ── Intent regexes (deterministic spend guards, director.md §3.4) ───────────

/** The user asked for drawing (or picked an option whose reply asks for it). */
export const DRAW_RE =
  /\b(draw|drawing|render|re-?draw|generate|re-?generate|paint|illustrate|go ahead|do it|go for it|make (?:the|a|it|them|my|our|all|every|another|one)|create (?:the|a|it|them)|start drawing|yes,? (?:draw|go|please|do it)|try again|another (?:take|version|one)|new (?:version|take)|finish it)\b/i;
/** The user asked for another take of something already drawn. */
export const REDRAW_RE =
  /\b(re-?draw|redo|re-?do|again|another (?:take|version|one|try|go)|new (?:take|version|drawing)|different (?:take|version)|re-?render|re-?generate|regenerate|start over|from scratch)\b/i;
/** The user wants to skip reviewing a plan written this turn. */
export const SKIP_REVIEW_RE = /\b(just|straight|skip|right away|immediately)\b.*\b(draw|render|generate|paint)|\b(draw|render|generate) (?:it |them |everything |all )?(?:all )?(?:now|right now|immediately|straight away)\b|\bno need to (?:show|review)\b/i;
const NEGATED_DRAW_RE = /\b(?:don'?t|do not|dont|never|no need to|not yet|without|before you|stop)\b[^.?!]{0,24}\b(?:draw|render|generate|paint|spend)/i;
const PRICE_QUESTION_RE = /\b(how much|what would it cost|cost(?:s)?\b|price|pricing|quote|estimate)\b/i;
/** Complaints / feedback about drawn art (never a reason to spend by itself). */
export const COMPLAINT_RE =
  /\b(bad|wrong|ugly|weird|awful|terrible|off|creepy|blurry|messy|broken|not right|isn'?t right|doesn'?t (?:look|match|represent|resemble)|does not (?:look|match|represent|resemble)|don'?t like|do not like|hate|not like (?:her|him|them|my|the)|looks? (?:off|strange|odd|wrong|bad))\b/i;

export type DrawIntent = 'explicit' | 'redraw' | 'none';

/** "make <the lettering / the words / the story> <different>" — edits the FREE tools do. */
const FREE_EDIT_MAKE_RE =
  /\bmake (?:all |every |each )?(?:the |my |our |his |her |their )?(?:text|fonts?|letters?|lettering|balloons?|bubbles?|captions?|shouts?|whispers?|thoughts?|sfx|sound effects?|dialogue|dialog|lines?|words?|title|speech|story|script|plot|ending|tone)\b|\bmake (?:it|this|that|them|him|her) (?:a (?:bit|little) )?(?:funnier|sillier|shorter|longer|scarier|spookier|sadder|happier|cuter|darker|lighter|calmer|simpler|clearer|bigger|smaller|bolder|louder|quieter|rhyme)\b/i;
/** A real draw verb next to it keeps the request a draw ("make the text bigger and redraw page 2"). */
const EXPLICIT_DRAW_VERB_RE = /\b(draw|drawing|render|re-?draw|generate|re-?generate|paint|illustrate)\b/i;

/** 'redraw' = another take asked for; 'explicit' = asked to draw; 'none' = a question, feedback or chat. */
export function drawIntentOf(text: string): DrawIntent {
  const t = clean(text);
  if (!t) return 'none';
  if (NEGATED_DRAW_RE.test(t)) return 'none';
  if (PRICE_QUESTION_RE.test(t)) return 'none';
  const asks = DRAW_RE.test(t);
  if (REDRAW_RE.test(t) && (asks || /\b(page|cover|sheet|panel|it|them|this|that)\b/i.test(t))) {
    // "the cover is bad" is feedback; "the cover is bad, redo it" asks for a new take.
    return 'redraw';
  }
  if (!asks) return 'none';
  // "make the shouts red", "make the text bigger", "make it funnier": free lettering/script edits that only
  // share the word "make" with a draw request (golden set, P2-SERVER) — never a reason to spend without asking.
  if (FREE_EDIT_MAKE_RE.test(t) && !EXPLICIT_DRAW_VERB_RE.test(t)) return 'none';
  // A complaint that happens to contain "make" ("make it look less weird?") without a clear verb stays explicit:
  // the gate (one tap) is the safety net for anything ambiguous, never a silent spend.
  return 'explicit';
}

/** A short, whole-message yes ("yes", "ok go", "sure, go ahead!", "yes please"). Thanks/acknowledgements are not a yes. */
const AFFIRM_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'ya', 'yea', 'sure', 'ok', 'okay', 'k', 'go', 'ahead', 'for', 'it', 'do', 'lets', 'sounds', 'looks', 'good', 'great', 'perfect', 'absolutely', 'definitely', 'of', 'course', 'alright', 'please', 'fine', 'cool', 'awesome', 'right', 'away', 'now']);
const STRONG_AFFIRM = /\b(yes|yeah|yep|yup|ya|yea|sure|ok|okay|go|perfect|absolutely|definitely|course|alright|great|awesome|cool|fine)\b/;
const isAffirmation = (text: string): boolean => {
  const t = clean(text).toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const tokens = t ? t.split(' ') : [];
  return tokens.length > 0 && tokens.length <= 6 && tokens.every((w) => AFFIRM_WORDS.has(w)) && STRONG_AFFIRM.test(t);
};
/** The studio's own question offered a drawing ("Ready to draw?", "Shall I make the cover (≈ $0.07)?"). */
const DRAW_QUESTION_RE =
  /\b(draw|drawing|render|re-?draw|paint|illustrate|generate|start drawing|make (?:the |a |your )?(?:cover|pages?|sheets?|model sheets?|style tests?|style options?)|new take|another take|try (?:it )?again)\b/i;

/**
 * drawIntentOf, plus the conversation: a bare "yes" / "ok go" answering the studio's own offer to
 * draw is a request to draw (it still goes through every gate and threshold). Never while an
 * approval card is open — that "yes" belongs to the Approve button.
 */
export function drawIntentInContext(doc: ComicDoc, userText: string): DrawIntent {
  const own = drawIntentOf(userText);
  if (own === 'redraw' || !isAffirmation(userText) || doc.gate?.status === 'open') return own;
  const conv = doc.conversation;
  let i = conv.length - 1;
  while (i >= 0 && conv[i].role === 'user') i -= 1;
  const prev = i >= 0 ? conv[i] : undefined;
  if (!prev || prev.role !== 'assistant') return own;
  const questions = [
    ...sentencesOf(prev.text || '').filter((q) => /\?["”')]*$/.test(q)),
    ...(prev.cards || []).flatMap((c) => (c.type === 'options' ? [c.question] : []))
  ];
  const offer = questions.find((q) => DRAW_QUESTION_RE.test(q) && !NEGATED_DRAW_RE.test(q));
  if (!offer) return own;
  return REDRAW_RE.test(offer) ? 'redraw' : 'explicit';
}

// ── Named IP (decisions-final #5) ────────────────────────────────────────────

const IP_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:crayon )?shin[- ]?chan\b/i, 'Shin-chan'],
  [/\bdoraemon\b/i, 'Doraemon'],
  [/\bbaahubali\b|\bbahubali\b/i, 'Baahubali'],
  [/\blego\b/i, 'LEGO'],
  [/\bdisney\b/i, 'Disney'],
  [/\bpixar\b/i, 'Pixar'],
  // Ordinary words that are also brands only count when written as the brand (or with brand context):
  // "they marvel at the sky", "the villain's minions", "a snoopy neighbour" are not IP.
  [/\bMarvel\b(?!\s+at\b)|\bMARVEL\b|\bmarvel (?:comics?|universe|superheroe?s?|heroes|movies?|films?|characters?|style|mcu)\b/, 'Marvel'],
  [/\bAvengers\b|\bavengers (?:assemble|team|tower|movie|style)\b/, 'the Avengers'],
  [/\bspider[- ]?man\b/i, 'Spider-Man'],
  [/\biron[- ]?man\b/i, 'Iron Man'],
  [/\bbatman\b/i, 'Batman'],
  [/\bsuperman\b/i, 'Superman'],
  [/\bpok[eé]mon\b|\bpikachu\b/i, 'Pokémon'],
  [/\bnaruto\b/i, 'Naruto'],
  [/\bone piece\b|\bluffy\b/i, 'One Piece'],
  [/\bdragon ball\b|\bgoku\b/i, 'Dragon Ball'],
  [/\bMickey(?: Mouse)?\b(?<!take the Mickey)(?<!taking the Mickey)|\b[Mm]ickey [Mm]ouse\b/, 'Mickey Mouse'],
  [/\bfrozen\b.*\belsa\b|\belsa\b.*\bfrozen\b/i, 'Frozen'],
  [/\bharry potter\b|\bhogwarts\b/i, 'Harry Potter'],
  [/\bpeppa pig\b/i, 'Peppa Pig'],
  [/\bpaw patrol\b/i, 'Paw Patrol'],
  [/\bBluey\b(?!-)|\bBLUEY\b/, 'Bluey'],
  [/\bminecraft\b/i, 'Minecraft'],
  [/\bsuper mario\b|\bmario\b(?= (?:and|&) luigi|\s+bros)/i, 'Mario'],
  [/\bsonic the hedgehog\b/i, 'Sonic'],
  [/\bBarbie\b|\bBARBIE\b|\bbarbie (?:doll|dreamhouse|movie|style)s?\b/, 'Barbie'],
  [/\bhello kitty\b/i, 'Hello Kitty'],
  [/\bchhota bheem\b|\bchota bheem\b/i, 'Chhota Bheem'],
  [/\bmotu patlu\b/i, 'Motu Patlu'],
  [/\bstar wars\b|\bdarth vader\b|\byoda\b/i, 'Star Wars'],
  [/\bTransformers\b|\b[Oo]ptimus [Pp]rime\b|\b[Aa]utobots?\b|\b[Dd]ecepticons?\b/, 'Transformers'],
  [/\bspongebob\b/i, 'SpongeBob'],
  [/\btom and jerry\b/i, 'Tom and Jerry'],
  [/\bscooby[- ]?doo\b/i, 'Scooby-Doo'],
  [/\bGarfield\b(?= the cat|\s+(?:and|&) (?:odie|Odie)|\s+(?:style|comic|lasagna))|\bgarfield (?:the cat|comics?|cartoon)\b/i, 'Garfield'],
  [/\bSnoopy\b|\bsnoopy (?:and|&) (?:[Ww]oodstock|[Cc]harlie [Bb]rown)\b|\b[Pp]eanuts gang\b/, 'Snoopy'],
  [/\bshrek\b/i, 'Shrek'],
  [/\bMinions?\b|\bminions? from despicable me\b|\bdespicable me\b/, 'the Minions'],
  [/\btotoro\b|\bghibli\b/i, 'Studio Ghibli'],
  [/\bwinnie the pooh\b/i, 'Winnie the Pooh'],
  [/\bpower rangers?\b/i, 'Power Rangers'],
  [/\bteenage mutant ninja turtles\b|\btmnt\b/i, 'Teenage Mutant Ninja Turtles'],
  [/\bhot wheels\b/i, 'Hot Wheels'],
  [/\bthomas the tank engine\b/i, 'Thomas the Tank Engine']
];

/** Trademarked names in the text (deduped, in table order). Free; a fallback to the safety prefilter's `ip`. */
export function detectNamedIp(text: string): string[] {
  const t = clean(text);
  if (!t) return [];
  const out: string[] = [];
  for (const [re, name] of IP_NAMES) if (re.test(t) && !out.includes(name)) out.push(name);
  return out;
}

/** The note appended to the user's turn so the model steers to an original homage (said once per name). */
export const ipNoteFor = (names: string[]): string =>
  `IP NOTE: ${joinList(names)} ${names.length === 1 ? 'is' : 'are'} trademarked — make an original homage (new name, distinct design, same spirit), say so warmly in one line, and keep going. Never refuse.`;

// ── Recap ────────────────────────────────────────────────────────────────────

const KIND_WORD: Record<string, string> = { comic: 'comic', manga: 'manga', webtoon: 'webtoon', strip: 'comic strip', storybook: 'storybook' };
const DEFAULT_TITLE_RE = /^untitled comic$/i;

/** "a Frog" / "three Ducklings" / "The Baby" — how a cast member reads in a sentence. */
const castPhrase = (c: Character): string => {
  const noun = castNoun(c);
  if (noun !== c.name.trim()) return noun; // a group: "three Ducklings"
  if (/^(the|a|an)\s/i.test(noun) || castKindOf(c) === 'person') return noun;
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
};

/** One line of what the studio understood (director.md §3.2). Empty when nothing is known yet. */
export function recapLine(doc: ComicDoc): string {
  const b = doc.brief;
  const f = doc.format;
  const known = !!(clean(b.premise) || clean(b.logline) || clean(b.audience) || clean(b.setting) || doc.cast.length || (clean(b.title) && !DEFAULT_TITLE_RE.test(clean(b.title))));
  if (!known) return '';
  const parts: string[] = [];
  const title = clean(b.title);
  const audience = clean(b.audience);
  // Only state a page count the user (or a plan) actually set — never the untouched default.
  const pages = doc.pages.length || (f.pageCount !== DEFAULT_FORMAT.pageCount ? f.pageCount : 0);
  const genre = clean(b.genre).toLowerCase();
  const kindWord = KIND_WORD[f.kind] || 'comic';
  const genreWord = genre && genre.split(/\s+/).length <= 3 && !kindWord.includes(genre) ? `${clip(genre, 30)} ` : '';
  let head = `${pages ? `a ${pages}-page` : /^[aeiou]/i.test(genreWord || kindWord) ? 'an' : 'a'} ${genreWord}${kindWord}`;
  if (audience) head += /^for\b/i.test(audience) ? ` ${clip(audience, 40)}` : ` for ${clip(audience, 40)}`;
  if (title && !DEFAULT_TITLE_RE.test(title)) head = `“${clip(title, 50)}”, ${head}`;
  parts.push(head);
  const setting = clean(b.setting);
  if (setting) parts.push(`set ${/^(in|at|on|by|near|under|inside|across)\b/i.test(setting) ? '' : 'at '}${clip(setting, 60)}`);
  let line = parts.join(', ');
  if (doc.cast.length) {
    const leads = doc.cast.filter((c) => c.tier === 'lead');
    const rest = doc.cast.filter((c) => c.tier !== 'lead');
    const shown = (leads.length ? leads : rest.slice(0, 1)).slice(0, 2);
    const others = doc.cast.filter((c) => !shown.includes(c)).slice(0, 4);
    const more = doc.cast.length - shown.length - others.length;
    const cast = joinList(shown.map(castPhrase)) + (others.length ? ` with ${joinList([...others.map(castPhrase), ...(more > 0 ? [`${more} more`] : [])])}` : '');
    line += ` — ${cast}`;
  }
  const style = clean(doc.style.name);
  if (style && doc.style.status !== 'empty') line += `, in ${style}`;
  return clip(line, 240);
}

// ── Material gaps (director.md §3.3) ─────────────────────────────────────────

export type MaterialGap = 'attachments_purpose' | 'vague_group' | 'page_count' | 'spend_intent';

const VAGUE_GROUP_RE =
  /\b(?:other|some|more|lots of|many|few|several|different|cute|little|baby|forest|farm|sea|ocean|jungle|wild|pet)?\s*(animals|creatures|critters|pets|beasts|friends|toys|vehicles|robots|monsters|sea creatures|bugs|insects|birds)\b/i;
const PAGE_COUNT_RE = /\b(\d{1,2}|one|single|two|three|four|five|six|seven|eight|nine|ten|twelve)[- ]?(?:page|pager|pg)s?\b|\bone[- ]shot\b|\bsingle page\b|\bpage count\b/i;
const PURPOSE_RE =
  /\b(this|these|that|those|here)(?:'s| is| are)\b|\b(?:is|are|it'?s|that'?s) (?:me|my|our|him|her|them|the)\b|\bme\b|\bmy (?:son|daughter|kid|baby|child|dog|cat|pet|friend|mom|dad|family)\b|\b(style|reference|ref|look like|inspired|place|location|background|setting)\b|\bas (?:the )?[A-Z]/i;

/** Open questions, highest priority first (only the first is surfaced per turn). */
export function materialGaps(doc: ComicDoc, userText: string): MaterialGap[] {
  const text = clean(userText);
  const gaps: MaterialGap[] = [];
  const lastUser = [...doc.conversation].reverse().find((m) => m.role === 'user');
  const attached = lastUser?.attachments?.map((a) => a.path) || [];
  if (attached.length) {
    const used = new Set<string>([
      ...doc.style.refs.map((r) => r.path),
      ...doc.cast.flatMap((c) => c.refs.map((r) => r.path)),
      ...doc.places.flatMap((p) => p.refs.map((r) => r.path))
    ]);
    if (attached.some((p) => !used.has(p)) && !PURPOSE_RE.test(text)) gaps.push('attachments_purpose');
  }
  const premise = `${text} ${clean(doc.brief.premise)}`;
  if (VAGUE_GROUP_RE.test(premise) && !doc.cast.some((c) => castKindOf(c) !== 'person')) gaps.push('vague_group');
  const story = !!(clean(doc.brief.premise) || clean(doc.brief.logline) || doc.cast.length || clean(doc.source.script));
  const stated = PAGE_COUNT_RE.test(text) || doc.brief.notes.some((n) => PAGE_COUNT_RE.test(n)) || PAGE_COUNT_RE.test(clean(doc.brief.premise));
  if (doc.planStatus === 'none' && !doc.pages.length && story && !stated && doc.format.pageCount === DEFAULT_FORMAT.pageCount && doc.format.kind !== 'strip') gaps.push('page_count');
  const drawn = doc.pages.some((p) => p.render.status === 'ready') || doc.cover.render.status === 'ready' || doc.cast.some((c) => c.sheet.status === 'ready');
  if (drawn && COMPLAINT_RE.test(text) && drawIntentOf(text) === 'none') gaps.push('spend_intent');
  return gaps;
}

const GAP_TEXT: Record<MaterialGap, string> = {
  attachments_purpose: 'the user attached images without saying what they are — ask who/what they show (a character, the style to follow, or a place) unless it is obvious.',
  vague_group: 'the user mentioned a vague group (e.g. "other animals") — pick 2–3 that fit, cast them (kind, count), name them in your reply; do not ask open-ended.',
  page_count: 'no page count yet — propose one (default first) in an ask_user, or pick a sensible one and say so.',
  spend_intent: 'the user gave feedback on drawn art — ask which fix they want (free options first, paid ones with prices) before spending anything.'
};

/** The OPEN QUESTIONS line for the doc summary ('' when nothing is open). */
export const openQuestionsLine = (doc: ComicDoc, userText: string): string => {
  const first = materialGaps(doc, userText)[0];
  return first ? `OPEN QUESTIONS: ${GAP_TEXT[first]}` : '';
};

// ── Run outcomes (honest replies about renders this turn started) ────────────

export interface RunOutcome {
  /** Targets this turn queued (deduped, still present in the doc). */
  targets: RenderTarget[];
  ready: RenderTarget[];
  failed: RenderTarget[];
  busy: RenderTarget[];
  /** First failure reason (user-safe StudioError text recorded on the render). */
  reason?: string;
}

const isBusy = (status?: string) => status === 'queued' || status === 'rendering';

/** Re-read the doc for every target this turn queued (DirectorTurn.runs). */
export function runOutcome(after: ComicDoc, turn: Pick<DirectorTurn, 'runs' | 'startedAt' | 'bgErrors'>): RunOutcome {
  const seen = new Set<string>();
  const out: RunOutcome = { targets: [], ready: [], failed: [], busy: [] };
  const since = turn.startedAt ?? 0;
  for (const t of turn.runs || []) {
    const key = renderTargetKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = getRender(after, t);
    if (!r) continue;
    out.targets.push(t);
    if (isBusy(r.status)) out.busy.push(t);
    else if (r.status === 'ready' && !(r.error && (r.updatedAt ?? 0) >= since)) out.ready.push(t);
    else {
      // Failed, or put back un-drawn (a stopped or skipped job restores 'none'/'stale'): nothing new was drawn.
      out.failed.push(t);
      if (!out.reason && r.error && (r.status === 'failed' || (r.updatedAt ?? 0) >= since)) out.reason = clean(r.error).replace(/[.!\s]+$/, '');
    }
  }
  if (!out.reason && turn.bgErrors?.length) out.reason = clean(turn.bgErrors[0]).replace(/[.!\s]+$/, '');
  return out;
}

/** "3 style tests" / "page 2" / "the cover" / "2 character sheets". */
export function describeTargets(doc: ComicDoc, targets: RenderTarget[]): string {
  const by = (kind: RenderTarget['kind']) => targets.filter((t) => t.kind === kind);
  const parts: string[] = [];
  const styles = by('style_option').length;
  if (styles) parts.push(styles === 1 ? 'the style test' : `${styles} style tests`);
  const pages = by('page');
  if (pages.length === 1) parts.push(targetLabel(doc, pages[0]).toLowerCase());
  else if (pages.length) parts.push(plural(pages.length, 'page'));
  const sheets = by('sheet').length + by('place').length;
  if (sheets) parts.push(plural(sheets, 'sheet'));
  if (by('cover').length) parts.push('the cover');
  return joinList(parts) || 'the drawing';
}

/** A sentence that claims work is under way ("I've kicked off…", "on its way", "drawing now"). */
const PROGRESS_CLAIM_RE =
  /\b(kick(?:ed|ing)? off|start(?:ed|ing)?|on (?:its|their|the) way|(?:are|is|now) (?:drawing|rendering|generating|cooking|being drawn)|drawing (?:them|it|now|your)|will (?:appear|land|show up)|coming (?:right )?up|in (?:the )?(?:works|progress)|appear on the board|working on (?:it|them|the))/i;

/** A reply that already admits the work failed. */
const FAILURE_ACK_RE = /\b(failed|didn'?t (?:work|come through|go through|finish)|couldn'?t (?:draw|finish|make|render)|went wrong|hit a (?:snag|problem)|not drawn)\b/i;

/** The honest line for a run that already settled badly; '' when there is nothing to correct. */
export function runFailureLine(doc: ComicDoc, run: RunOutcome): string {
  if (!run.failed.length || run.busy.length) return '';
  const failedWhat = describeTargets(doc, run.failed);
  const why = run.reason ? ` — ${run.reason.charAt(0).toLowerCase()}${run.reason.slice(1)}` : '';
  if (!run.ready.length) return `${cap(failedWhat)} didn't come through${why}. Nothing new was drawn — tap Try again or ask me to retry.`;
  return `${cap(describeTargets(doc, run.ready))} ${run.ready.length === 1 ? 'is' : 'are'} ready, but ${failedWhat} didn't come through${why}. Tap Try again for the rest.`;
}

/** Background work this turn started produced no target and posted an error (e.g. no style directions). */
const backgroundFailureLine = (turn: Pick<DirectorTurn, 'bgErrors' | 'runs' | 'outcome'>): string => {
  if (turn.runs?.length || !turn.bgErrors?.length || turn.outcome !== 'started') return '';
  return `That didn't go through — ${clean(turn.bgErrors[0]).replace(/[.!\s]+$/, '')}. Nothing new was drawn.`;
};

/**
 * Keep the model's own reply, but never let it claim progress on renders that already failed
 * by the time it is committed. Sentences claiming work is under way are dropped and the honest
 * outcome is said first.
 */
export function reconcileReply(text: string, i: { after: ComicDoc; turn: DirectorTurn }): string {
  const run = runOutcome(i.after, i.turn);
  const line = runFailureLine(i.after, run) || backgroundFailureLine(i.turn);
  if (!line) return text;
  const sentences = sentencesOf(text);
  // The model already said it honestly (and claims nothing is under way): keep its own words.
  if (FAILURE_ACK_RE.test(text) && !sentences.some((s) => PROGRESS_CLAIM_RE.test(s))) return text;
  const kept = sentences.filter((s) => !PROGRESS_CLAIM_RE.test(s));
  return [line, ...kept].join(' ').trim();
}

// ── Next steps ───────────────────────────────────────────────────────────────

const estimateOf = (doc: ComicDoc, kind: ImageJobKind, count: number, byok: boolean): number =>
  estimateJobs([{ kind, count }], doc.settings.quality, { override: doc.settings.imageModelOverride, byok }).usd;

/** Chips for the $0 "everything is drawn" outcome (Read it · cover · add a page · new take · share). */
export function nothingNextSteps(doc: ComicDoc, byok = false): NextStep[] {
  const steps: NextStep[] = [{ label: 'Read it', client: { type: 'open_reader' } }];
  if (coverNeedsDraw(doc)) {
    const usd = estimateOf(doc, 'cover', 1, byok);
    steps.push({ label: 'Make the cover', action: { type: 'render_cover', quotedUsd: usd }, usd });
  }
  const last = [...doc.pages].sort((a, b) => b.n - a.n)[0];
  if (last) {
    steps.push({ label: 'Add a page', say: `Add a page after page ${last.n}`, usd: 0 });
    const focus = doc.pages.length === 1 ? last : undefined;
    if (focus) steps.push({ label: `New take of page ${focus.n}`, say: `Draw a new take of page ${focus.n}`, usd: estimateOf(doc, 'page', 1, byok) });
  }
  steps.push({ label: 'Share it', client: { type: 'open_share' } });
  return steps.slice(0, DOC_LIMITS.nextSteps);
}

/** "Try again" chips for failed targets: a tap is the user's confirmation; quotedUsd re-gates a grown price. */
export function retryNextSteps(doc: ComicDoc, failed: RenderTarget[], byok = false): NextStep[] {
  const steps: NextStep[] = [];
  const styles = doc.style.options.filter((o) => failed.some((t) => t.kind === 'style_option' && t.id === o.id) && o.name && o.spec);
  if (styles.length) {
    const usd = estimateOf(doc, 'style_option', styles.length, byok);
    steps.push({ label: 'Try again', action: { type: 'render_style_options', directions: styles.map((o) => ({ name: o.name, spec: o.spec })), quotedUsd: usd }, usd });
  }
  const pageIds = failed.filter((t) => t.kind === 'page').map((t) => (t as { id: string }).id);
  if (pageIds.length) {
    const usd = estimateOf(doc, 'page', pageIds.length, byok);
    steps.push({ label: pageIds.length === 1 ? 'Try the page again' : 'Try the pages again', action: { type: 'render_pages', pageIds, quotedUsd: usd }, usd });
  }
  const sheetIds = failed.filter((t) => t.kind === 'sheet' || t.kind === 'place').map((t) => (t as { id: string }).id);
  if (sheetIds.length) {
    const usd = estimateOf(doc, 'sheet', sheetIds.length, byok);
    steps.push({ label: 'Try the sheets again', action: { type: 'render_sheets', characterIds: sheetIds, quotedUsd: usd }, usd });
  }
  if (failed.some((t) => t.kind === 'cover')) {
    const usd = estimateOf(doc, 'cover', 1, byok);
    steps.push({ label: 'Try the cover again', action: { type: 'render_cover', quotedUsd: usd }, usd });
  }
  return steps;
}

/** The single most useful next step for a "Done." reply, by phase. */
export function phaseHint(doc: ComicDoc): string {
  if (!clean(doc.brief.premise) && !clean(doc.brief.logline) && !doc.cast.length && !clean(doc.source.script)) return 'Tell me about your story — who is in it and what happens?';
  if (doc.style.status === 'empty') return 'Next: pick a style?';
  if (!doc.pages.length) return 'Next: plan the pages?';
  if (pageTargets(doc).length) return 'Next: draw the pages?';
  if (coverNeedsDraw(doc)) return 'Want the cover next?';
  return 'Read it, or tell me what to change.';
}

/**
 * "Everything is already drawn and up to date — 6 pages and the cover." only when the cover is
 * current too; otherwise "All 6 pages are already drawn and up to date … The cover isn't drawn yet."
 * ('' when some page still needs drawing). Shared by the composer and the $0 intent router.
 */
export function drawnBookLine(doc: ComicDoc, opts: { offerCover?: boolean } = {}): string {
  const drawn = doc.pages.filter((p) => p.render.status === 'ready' && !isPageStale(doc, p)).length;
  if (!drawn || drawn < doc.pages.length || pageTargets(doc).length) return '';
  const cover = doc.cover.render;
  if (cover.status === 'ready' && !isTargetStale(doc, { kind: 'cover' })) {
    return `Everything is already drawn and up to date — ${plural(drawn, 'page')} and the cover. Nothing was spent.`;
  }
  const pages = drawn === 1 ? 'The page is' : `All ${drawn} pages are`;
  const coverState = isBusy(cover.status) ? 'The cover is drawing now' : cover.status === 'ready' ? 'The cover is out of date' : 'The cover isn’t drawn yet';
  return `${pages} already drawn and up to date — nothing was spent. ${coverState}${opts.offerCover && !isBusy(cover.status) ? ' — want it?' : '.'}`;
}

/** The honest $0 line for a `nothing` outcome: only claims what is really drawn and current. */
export function nothingLine(doc: ComicDoc, turn: Pick<DirectorTurn, 'log'>): string {
  if (doc.pages.some((p) => isBusy(p.render.status))) return "It's already drawing — nothing new to start, and nothing was spent.";
  const askedCover = turn.log.some((l) => l.tool === 'render_cover') && !turn.log.some((l) => l.tool === 'render_pages');
  const coverDone = doc.cover.render.status === 'ready' && !isTargetStale(doc, { kind: 'cover' });
  if (askedCover && coverDone) return 'The cover is already drawn and up to date — nothing was spent.';
  if (askedCover && isBusy(doc.cover.render.status)) return 'The cover is already drawing — nothing new to start, and nothing was spent.';
  return drawnBookLine(doc) || 'Nothing new needed drawing — nothing was spent.';
}

// ── Composer ─────────────────────────────────────────────────────────────────

export interface ComposeInput {
  before: ComicDoc;
  after: ComicDoc;
  turn: DirectorTurn;
  userText: string;
}

const BRIEF_KEYS = ['title', 'audience', 'genre', 'tone', 'setting', 'premise', 'logline'] as const;

/** How many understanding fields this turn changed (brief, format kind/pages, cast). */
export function understandingChanges(before: ComicDoc, after: ComicDoc): number {
  let n = 0;
  for (const k of BRIEF_KEYS) if (clean(before.brief[k]) !== clean(after.brief[k])) n += 1;
  if (before.format.kind !== after.format.kind) n += 1;
  if (before.format.pageCount !== after.format.pageCount) n += 1;
  const ids = new Set(before.cast.map((c) => c.id));
  n += after.cast.filter((c) => !ids.has(c.id)).length;
  return n;
}

/** User turns so far (the current one included). */
export const userTurnCount = (doc: ComicDoc): number => doc.conversation.filter((m) => m.role === 'user').length;

/** Whether this turn earns a recap (first 3 user turns with something learned, or ≥ 2 changes). */
export const wantsRecap = (before: ComicDoc, after: ComicDoc): boolean => {
  const changes = understandingChanges(before, after);
  return changes >= 2 || (changes >= 1 && userTurnCount(after) <= 3);
};

const firstErrorLine = (turn: DirectorTurn): string => {
  const err = turn.log.find((l) => !l.ok)?.result || '';
  const msg = clean(err.replace(/^(Error|Refused):\s*/i, ''));
  // Model-facing hints ("Pass the page number", "call plan_pages") are not for the user.
  if (!msg || /\b(pass|call|use) (?:the |at least |page |a |an )?\w*_?\w*\b|\bargument|\btool\b|\bjson\b/i.test(msg)) return '';
  return clip(msg, 160);
};

// The job runner words prices in the user's terms (P2-SERVER costText.ts): "≈ $0.12" for admins and
// own-key users, "≈2% of your usage" for governed users — both forms are read here.
const PRICE = String.raw`(?:≈ ?<?\$[\d.]+|~?<?\$[\d.]+|[≈<][\d.]+% of your usage|a little of your usage)`;
const STARTED_RE = new RegExp(String.raw`^Started drawing (.+?) \((${PRICE})`);
const GATED_RE = new RegExp(String.raw`(?:approve|approval)\D*?(${PRICE})\s*\(([^)]+?)(?: on [^)]+)?\)`, 'i');
/** "≈ $0.12" / "$0.12" / "~$0.12" → "≈ $0.12"; usage words stay as they are. */
const approxPrice = (p: string): string => (/\$/.test(p) ? `≈ ${p.replace(/^[≈~]\s?/, '')}` : p);

/**
 * One to three plain sentences built from what the turn changed (≤ 60 words). Never claims a
 * drawing is done, never empty. Used only when the model said nothing (or for deterministic turns).
 */
export function composeTurnReply(i: ComposeInput): string {
  const { before, after, turn } = i;
  // Each clause has a drop priority for the word budget: 0 = never dropped (money, failures,
  // the IP homage, errors — honesty beats brevity), higher numbers are dropped first.
  const clauses: Array<{ text: string; drop: number }> = [];
  const add = (text: string, drop = 0) => clauses.push({ text, drop });
  const run = runOutcome(after, turn);
  const failure = runFailureLine(after, run) || backgroundFailureLine(turn);

  // 1) What was understood (early turns) — the recap the owner asked for.
  const recap = recapLine(after);
  const changes = understandingChanges(before, after);
  const early = userTurnCount(after) <= 3;
  const recapped = !!recap && ((early && changes >= 1) || changes >= 2);
  if (recapped) add(`Got it — ${recap}.`, 2);

  // 2) IP homage, said once (never dropped: doc.safety.ipNoted marks it as said).
  if (turn.ipNames?.length) {
    const fresh = after.cast.filter((c) => !before.cast.some((b) => b.id === c.id));
    add(
      `${joinList(turn.ipNames)} ${turn.ipNames.length === 1 ? 'is' : 'are'} trademarked, so I'm making an original homage${fresh.length ? ` — ${joinList(fresh.slice(0, 3).map((c) => c.name))}` : ''} with the same spirit.`
    );
  }

  // 3) Style and cast changes not already covered by the recap.
  if (!recapped && clean(before.style.name) !== clean(after.style.name) && clean(after.style.name)) add(`Style: ${clean(after.style.name)}.`, 3);
  const added = after.cast.filter((c) => !before.cast.some((b) => b.id === c.id));
  if (!recapped && added.length) add(`Cast: ${joinList(added.slice(0, 5).map((c) => castNoun(c)))}${added.length > 5 ? ` and ${added.length - 5} more` : ''}.`, 3);
  else if (recapped && added.some((c) => castKindOf(c) !== 'person') && /\b(other|some|few|several|animals|creatures|friends|critters)\b/i.test(i.userText)) {
    add('I picked those companions — change them any time.', 3);
  }

  // 4) The plan.
  const planned = turn.plannedThisTurn && after.pages.length;
  if (planned) {
    const p1 = [...after.pages].sort((a, b) => a.n - b.n)[0];
    add(`Here's the plan — ${plural(after.pages.length, 'page')}, ${plural(totalPanels(after), 'panel')}${p1?.summary ? `: ${clip(clean(p1.summary), 90)}` : ''}.`, 1);
  }

  // 5) Money: failed runs, started runs, gates, nothing to draw.
  if (failure) add(failure);
  else {
    const started = turn.log.map((l) => STARTED_RE.exec(l.result)).find(Boolean);
    if (started) add(`Drawing ${started[1]} now (${approxPrice(started[2])}) — it appears on the board as it finishes.`);
    const gate = after.gate?.status === 'open' && before.gate?.id !== after.gate.id ? after.gate : null;
    if (gate) add(`That's ≈ ${formatUsd(gate.estimateUsd)} for ${clean(gate.title).replace(/^Draw |\?$/g, '') || 'the drawing'} — tap Approve when you're ready.`);
    else if (!started) {
      const gatedLog = turn.log.map((l) => GATED_RE.exec(l.result)).find(Boolean);
      if (gatedLog) add(`That's ${approxPrice(gatedLog[1])} for ${gatedLog[2]} — tap Approve when you're ready.`);
    }
    if (turn.outcome === 'nothing' && !started) add(nothingLine(after, turn));
  }

  // 6) Small free edits.
  if (!clauses.length && turn.captured.length) add(`Done — ${joinList(turn.captured.slice(0, 4))}.`);

  // 7) Errors only.
  if (!clauses.length && turn.log.length && turn.log.every((l) => !l.ok)) {
    const err = firstErrorLine(turn);
    add(err ? `I couldn't do that: ${err}` : "I couldn't do that one — could you say it another way?");
  }

  // 8) Fit the budget by dropping the least important clauses first (never the money/failure lines).
  const question = clean(turn.question);
  const budget = question ? 48 : 60;
  const kept = [...clauses];
  const total = () => kept.reduce((n, c) => n + words(c.text), 0);
  while (total() > budget) {
    const worst = kept.reduce((w, c, idx) => (c.drop > 0 && (w < 0 || c.drop >= kept[w].drop) ? idx : w), -1);
    if (worst < 0 || kept.length === 1) break;
    kept.splice(worst, 1);
  }
  let body = kept.map((c) => c.text).join(' ').trim();
  if (question) body = body ? `${body} ${/[?]$/.test(question) ? question : `${question}?`}` : question;
  if (!body) body = turn.log.length ? `Done. ${phaseHint(after)}` : phaseHint(after);
  return body.trim();
}

/** Deterministic redirect when the provider refused the director turn (safety.md §3.5; no strike). */
export const REFUSAL_REPLY = "That one tripped the AI's filter — I can try a toned-down version that keeps the idea.";
export const refusalCard = (id: string, optId: (n: number) => string): Card => ({
  type: 'options',
  id,
  question: 'How should we go on?',
  choices: [
    { id: optId(1), label: 'Try a gentler version', reply: 'Try a gentler version of that, keeping the idea.' },
    { id: optId(2), label: 'Something else', reply: "Let's do something else." }
  ],
  allowCustom: true
});
