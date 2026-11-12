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
  letterStyleOf,
  renderTargetKey,
  targetLabel,
  totalPanels,
  type Card,
  type Character,
  type ComicDoc,
  type NextStep,
  type RenderTarget
} from '../../../shared/comic/doc.js';
import type { StudioFocus } from '../../../shared/comic/events.js';
import { parseDialogue, resolveLineRef, whichLineChoices } from '../../../shared/comic/dialogue/index.js';
import type { LineRef } from '../../../shared/comic/dialogue/types.js';
import { LANGUAGES } from '../../../shared/comic/languages.js';
import { LETTERING_PRESETS, type LetteringPresetId } from '../../../shared/comic/lettering/style.js';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import { formatUsd, type ImageJobKind } from '../../../shared/comic/models.js';
import { coverNeedsDraw, estimateDocJobs, pageTargets } from '../../../shared/comic/plan.js';
import { letteringPresetName, ownLooks, pinnedBalloons, pinnedLabel } from './decided.js';
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

/**
 * The four contradiction gaps (agent-editor plan §3 A3.2; behind COMIC_CONFLICT_GUARD): the request would override
 * something the creator already settled. Each tells the director to ask ONE Keep / Change question, quoting the earlier
 * decision, and never to override silently.
 */
export type ContradictionGap = 'contradiction_pages' | 'contradiction_style' | 'contradiction_pinned' | 'contradiction_note';
/** A dialogue request that matches several lines (plan §3 A3.2, Track B): dialogue_edit asks "Which line?". */
export type DialogueGap = 'dialogue_target';
export type MaterialGap = 'attachments_purpose' | 'vague_group' | 'page_count' | 'spend_intent' | ContradictionGap | DialogueGap;

/** What the OPEN QUESTIONS line may consider beyond the four classic gaps. */
export interface GapOptions {
  /** The contradiction gaps (caps.liveAgent.conflicts, conflictGuardOn); off = exactly the classic gaps. */
  contradictions?: boolean;
  /** What the creator has selected (a pinned balloon they ask to move). */
  focus?: StudioFocus;
}

/** One contradiction, with the director-facing words that quote the earlier decision. */
export interface Contradiction {
  gap: ContradictionGap;
  text: string;
}

const VAGUE_GROUP_RE =
  /\b(?:other|some|more|lots of|many|few|several|different|cute|little|baby|forest|farm|sea|ocean|jungle|wild|pet)?\s*(animals|creatures|critters|pets|beasts|friends|toys|vehicles|robots|monsters|sea creatures|bugs|insects|birds)\b/i;
const PAGE_COUNT_RE = /\b(\d{1,2}|one|single|two|three|four|five|six|seven|eight|nine|ten|twelve)[- ]?(?:page|pager|pg)s?\b|\bone[- ]shot\b|\bsingle page\b|\bpage count\b/i;
const PURPOSE_RE =
  /\b(this|these|that|those|here)(?:'s| is| are)\b|\b(?:is|are|it'?s|that'?s) (?:me|my|our|him|her|them|the)\b|\bme\b|\bmy (?:son|daughter|kid|baby|child|dog|cat|pet|friend|mom|dad|family)\b|\b(style|reference|ref|look like|inspired|place|location|background|setting)\b|\bas (?:the )?[A-Z]/i;

// ── Contradictions (agent-editor plan §3 A3.2) ──
//
// Every reader below needs POSITIVE context. A gap costs the creator a Keep / Change question, so a number, an audience
// word, a language name or a preset name only counts when the sentence clearly SETS it ("make it 4 pages", "for teens",
// "write it in Hindi", "switch the lettering to manga"). Everyday edits that merely mention one ("redo 2 pages", "the
// kids look for the dog", "she shouts in English", "keep the dialogue minimal") stay silent. A miss behaves exactly as
// before the gaps existed; a false question is the failure to avoid (the flag's rollout criterion).

const NUMBER_WORDS: Record<string, number> = {
  one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20
};
const NUMBER_WORD = '(?:\\d{1,2}|one|single|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)';
/** A number + "page(s)": "4 pages", "a 6-page comic", "one page". Group 1 the number, group 2 the joiner. */
const COUNT_RE = new RegExp(`\\b(${NUMBER_WORD})(-| )(?:page|pager)s?\\b`, 'gi');
/** "page count to 4", "number of pages: 6", "pages: 6" (a note; not "pages: 2 and 3 are dark"), the number in group 1 or 2. */
const COUNT_NAMED_RE = new RegExp(`\\b(?:page count|number of pages)\\s*(?:is|of|to|at|:|=)?\\s*(${NUMBER_WORD})\\b(?!\\s*(?:panels?|words?|lines?)\\b)|\\bpages\\s*[:=]\\s*(${NUMBER_WORD})\\b(?=\\s*(?:$|[.,;)]))`, 'i');
/** Words just before a number that SET the length, whatever follows: "make it 4 pages", "cut it down to 3 pages". */
const COUNT_SET_BEFORE_RE =
  /(?:\bmake (?:it|this|the (?:comic|book|story|whole thing))|\bturn (?:it|this|the (?:comic|book|story)) into|\b(?:cut|trim|shorten|reduce|bring|take) (?:it |this |the (?:comic|book|story) )?(?:down |back )?to|\b(?:expand|extend|stretch|grow|increase|bump|lengthen) (?:it |this |the (?:comic|book|story) )?(?:up )?to|\bchange (?:it|this|the page count|the length|the comic|the story) to|\bkeep (?:it|this|the (?:comic|book|story)) (?:at|to)|\b(?:go|going|come) (?:down |up |back )?to|\bfrom \w+ to|\b(?:should|must|will|would|could|can|to) (?:only |just )?be)(?: (?:only|just|exactly))?(?: a| an)?\s*$/i;
/** Weaker words before a number: they set the length only when the count ends its clause ("I want 4 pages."). */
const COUNT_ASK_BEFORE_RE =
  /(?:\b(?:it|this|that|everything|(?:the )?(?:comic|story|book|whole thing)) (?:in|into|on|as|across|over)|\b(?:should|must|could|would|will|to|let'?s|can|it|comic|story|book) (?:only )?(?:have|has)|\b(?:want|need|prefer|would like|'d like)(?: it(?: to be)?)?(?: only| just)?|\blet'?s (?:do|go with|go for|try|say)|\b(?:go|going) (?:with|for)|\bhow about|\bmaybe)(?: a| an)?\s*$/i;
/** A clause that is only the count, after optional filler ("4 pages please", "ok, 6 pages", "actually just 2 pages"). */
const COUNT_CLAUSE_START_RE = /^\s*(?:(?:ok(?:ay)?|yes|yeah|yep|sure|so|actually|then|and|hmm+|um+|well)[,!]?\s+)*(?:a |an |just |only |exactly )?$/i;
/** What may follow a count that ends its clause. */
const COUNT_ENDS_CLAUSE_RE =
  /^\s*(?:$|[.,!?;:)–—]|(?:please|thanks|thank you|or (?:so|less|fewer|more)|max(?:imum)?|at most|tops|instead(?! of)|total|in total|long|is (?:enough|plenty|fine|good|better|best)|would be (?:better|great|good|best|fine)|(?:comic|story|book|version|one-shot)s?)\b)/i;
/** After a hyphenated count: a format noun or the end of the clause ("a 6-page comic"; not "the 2-page spread"). */
const COUNT_FORMAT_AFTER_RE =
  /^\s*(?:$|[.,!?;:)–—]|(?:comic|story|book|version|zine|strip|webtoon|manga|short|one-shot|graphic novel|pitch|issue|chapter|thing|piece)s?\b)/i;
/** After any count: it names a length ("4 pages long", "6 pages in total"). */
const COUNT_LENGTH_AFTER_RE = /^\s*(?:long\b|(?:in )?total\b(?=\s*(?:$|[.,!?;:)]|please\b)))/i;

const countOf = (raw: string): number | undefined => {
  const w = raw.toLowerCase();
  const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
  return n && n >= 1 && n <= DOC_LIMITS.pages ? n : undefined;
};

/**
 * The page count a sentence SETS ("make it 4 pages", "a one-shot", "an 8-page comic", "I want 6 pages.", "6 pages
 * please"), or undefined. A number that names pages to work on ("redo 2 pages", "make 2 pages brighter", "my 4 pages
 * look great", "the first 2 pages") is not a count: only positive context counts, never a list of exceptions.
 */
export function requestedPageCount(text: string): number | undefined {
  const t = clean(text);
  if (/\bone[- ]shot\b/i.test(t)) return 1;
  let found: number | undefined;
  for (const m of t.matchAll(COUNT_RE)) {
    const at = m.index ?? 0;
    const head = t.slice(0, at);
    const before = head.slice(-48);
    const after = t.slice(at + m[0].length);
    const clauseStart = COUNT_CLAUSE_START_RE.test(head.split(/[,;:(.!?—–]/).pop() ?? '');
    const sets =
      (m[2] === '-' && COUNT_FORMAT_AFTER_RE.test(after)) ||
      COUNT_LENGTH_AFTER_RE.test(after) ||
      COUNT_SET_BEFORE_RE.test(before) ||
      ((clauseStart || COUNT_ASK_BEFORE_RE.test(before)) && COUNT_ENDS_CLAUSE_RE.test(after));
    if (!sets) continue;
    found = countOf(m[1]) ?? found;
  }
  if (found !== undefined) return found;
  const named = COUNT_NAMED_RE.exec(t);
  return named ? countOf(named[1] ?? named[2]) : undefined;
}

/** The words a creator uses for each lettering preset (its id and the distinctive part of its name). */
const PRESET_ALIASES: Record<LetteringPresetId, string[]> = {
  classic: ['classic'],
  manga: ['manga'],
  storybook: ['storybook', 'story book'],
  noir: ['noir'],
  webtoon: ['webtoon'],
  retro_pulp: ['retro pulp', 'pulp'],
  // "minimal" is everyday speech ("keep the dialogue minimal"): only "minimal preset" / "minimal lettering style".
  minimal: [],
  handwritten: ['handwritten', 'hand-written', 'hand written']
};
/** The lettering nouns a preset switch names ("the manga lettering", "noir fonts", "the webtoon preset"). */
const LETTER_NOUN = '(?:lettering(?: style| preset)?|letters|fonts?|preset)';
/** A verb that switches something ("switch", "use", "go with", "make it"). */
const SWITCH_VERB = '(?:switch|swap|change|use|using|go with|try|make it|make the (?:lettering|letters|fonts?|text)|set the (?:lettering|letters|fonts?|preset)|pick|choose|apply|give it|prefer|move to)';
/** One word with no punctuation around it, so a comma ends the reach ("set in a noir city, use big fonts" is no ask). */
const W = "\\s+[\\w'’-]+";
const presetAsk = (alias: string): RegExp[] => {
  const w = alias.replace(/[-\s]+/g, '[-\\s]?');
  return [
    // A switch verb within six words before the alias, and a lettering noun within four words of it (either side).
    new RegExp(`\\b${SWITCH_VERB}\\b(?:${W}){0,5}?\\s+${w}\\b(?=(?:${W}){0,3}?\\s+${LETTER_NOUN}\\b)`, 'i'),
    new RegExp(`\\b${SWITCH_VERB}\\b(?:${W}){0,5}?\\s+${LETTER_NOUN}\\b(?:${W}){0,3}?\\s+${w}\\b`, 'i'),
    // The whole message is the ask: "handwritten fonts please", "manga lettering!".
    new RegExp(`^(?:(?:a|the|some)\\s+)?${w}\\s+${LETTER_NOUN}(?:\\s+(?:please|instead|now|for (?:the |this )?(?:comic|book|story)))?\\s*[.!]?$`, 'i')
  ];
};
const PRESET_ASKS = (Object.keys(PRESET_ALIASES) as LetteringPresetId[]).map((id) => ({ id, res: PRESET_ALIASES[id].flatMap(presetAsk) }));
const MINIMAL_ASK_RE = /\bminimal(?:ist)?\s+(?:preset|lettering (?:style|preset))\b|\b(?:preset|lettering (?:style|preset))\s*(?::|to|is)?\s*(?:the\s+)?minimal(?:ist)?\b/i;

/** The lettering preset a sentence asks to switch to ("use the manga lettering", "switch the fonts to noir"), or undefined. */
export function requestedLetteringPreset(text: string): LetteringPresetId | undefined {
  const t = clean(text);
  if (!t) return undefined;
  for (const { id, res } of PRESET_ASKS) {
    if (!Object.prototype.hasOwnProperty.call(LETTERING_PRESETS, id)) continue;
    if (res.some((re) => re.test(t))) return id;
  }
  if (Object.prototype.hasOwnProperty.call(LETTERING_PRESETS, 'minimal') && MINIMAL_ASK_RE.test(t)) return 'minimal';
  return undefined;
}

/** A place on the page, never an adjective ("the top left", "the corner"; not "the top line", "the left balloon"). */
const PLACE =
  '(?:the\\s+)?(?:very\\s+|far\\s+)?(?:top|bottom|left|right|corner|middle|cent(?:er|re)|side|edge|upper|lower)\\b(?!\\s+(?:line|balloon|bubble|panel|one|row|text|caption|speech|part|word)s?\\b)';
/** A request to move or re-place a balloon ("move it to the top", "put it in the corner", "nudge it", "a bit lower"). */
const MOVE_RE = new RegExp(
  [
    '\\b(?:move|moving|reposition|drag|nudge|arrange|rearrange|re-?arrange|re-?layout|lay (?:it |them )?out|re-?letter|auto[- ]?(?:place|layout))\\b',
    '\\bspread (?:(?:them|it|the (?:balloons|bubbles|lines))\\s+)?out\\b',
    '\\btidy (?:up )?(?:the )?(?:balloons|bubbles|lettering|layout)\\b',
    '\\b(?:redo|re-?do|change|new|auto) (?:the )?(?:balloon |bubble )?layout\\b',
    // put / place / position / shift / slide only with a place after them ("put more emotion in this line" is no move).
    `\\b(?:put|place|position|shift|slide)\\b(?=[^.?!]{0,40}\\b(?:(?:to|at|in|into|on|onto|near|next to|above|below|under|over|toward|towards)\\s+${PLACE}|(?:to|into)\\s+(?:panel \\d+|the other panel)\\b))`,
    '\\b(?:shift|slide)\\s+(?:(?:it|this|that|them|the (?:balloon|bubble|caption|text|line)s?)\\s+)?(?:up|down|left|right|higher|lower|over|aside|closer|away)\\b',
    `\\b(?:to|at|in|into) the\\s+(?:very\\s+|far\\s+)?(?:top|bottom|left|right|corner|middle|cent(?:er|re))\\b(?!\\s+(?:line|balloon|bubble|panel|one|row|text|caption|speech|part|word)s?\\b)`,
    '\\b(?:higher|lower|further (?:up|down|left|right))\\b(?=\\s*(?:up|down)?\\s*(?:on the page|in the panel)?\\s*(?:$|[.,!?;)]|please\\b))'
  ].join('|'),
  'i'
);
/** A page-wide re-place ("rearrange the balloons on page 1", "re-letter page 2"): a real move verb, never "put". */
const PAGE_MOVE_RE = /\b(?:move|moving|rearrange|re-?arrange|re-?letter|re-?layout|arrange|tidy|spread|auto[- ]?(?:place|layout)|reposition|shuffle|lay (?:it |them )?out)\b/i;
const PAGE_REF_RE = /\bpages? (\d{1,3})\b/gi;
const ALL_BALLOONS_RE = /\b(?:all|every|the) (?:balloons|bubbles|lettering|dialogue|lines)\b|\bre-?letter\b|\bre-?layout\b|\brearrange\b/i;

const AUDIENCE: { bucket: string; re: RegExp }[] = [
  { bucket: 'all ages', re: /\b(?:all ages|everyone|whole family|families|family[- ]friendly|rated g|g[- ]rated)\b/i },
  { bucket: 'kids', re: /\b(?:kids?|children|child|toddlers?|preschool(?:ers)?|little ones|babies|ages? (?:[1-9]|1[0-2])\s*(?:[-–to]+\s*(?:[1-9]|1[0-2]))?\b(?!\s*\+))/i },
  { bucket: 'teens', re: /\b(?:teens?|teenagers?|young adults?|ya|ages? 1[3-7]\b|pg-13)\b/i },
  { bucket: 'adults', re: /\b(?:adults?|grown[- ]ups?|mature|ages? (?:18|21)\+?|rated r|r[- ]rated)\b/i }
];
const AUDIENCE_NOUN =
  '(?:kids?|children|toddlers?|preschoolers?|little ones|babies|teens?|teenagers?|young adults?|adults?|grown[- ]ups?|mature readers|everyone|all ages|families|the whole family)';
/** "For" + an audience that ends its phrase ("for kids", "for my kids 2–6", "suitable for teens"; not "look for the dog"). */
const AUDIENCE_FOR_RE = new RegExp(
  `\\b(?:for|aimed at|suited to|meant for|made for)\\s+(?:my |our |young |little |older |small )?(${AUDIENCE_NOUN}|ages? \\d{1,2}(?:\\s*(?:\\+|[-–]|to)\\s*\\d{0,2})?)(?=\\s*(?:$|[.,!?;:)]|\\d|please\\b|only\\b|aged?\\b|ages?\\b|under\\b|over\\b|who\\b|that\\b|to (?:read|enjoy)\\b|instead\\b|and (?:up|older)\\b|rather\\b|now\\b))`,
  'i'
);
/** An audience-shaped book ("a teen comic", "a kids story", "children's book", "the family version"). */
const AUDIENCE_BOOK_RE = /\b(kids?|kid'?s|children'?s|teen|teenage|young adult|ya|adult|grown[- ]up|family|all[- ]ages|mature)\s+(?:comic|book|story|strip|audience|version|edition|readers|readership)s?\b/i;
/** "the audience is teens", "audience: adults". */
const AUDIENCE_IS_RE = /\baudience(?:\s+(?:is|should be|of|are)|\s*:)\s+([^.,;!?]{1,40})/i;
/** "ages 8–12", "age 13+", "for ages 6" (a range, a plus or "for"; a bare "age 8" or "ages 8 and 10" is a character's). */
const AUDIENCE_AGES_RE = /\bfor\s+ages?\s+(\d{1,2})\b|\bages?\s+(\d{1,2})\s*(?:\+|[-–]\s*\d{1,2}\b|to\s+\d{1,2}\b)/i;
/** A rating ("rated PG-13", "rated T", "R-rated", "family-friendly", "all ages"). */
const AUDIENCE_RATING_RE = /\brated\s+(g|pg-13|r|e|everyone|t|teen|m|mature)\b|\b(pg-13|g[- ]rated|r[- ]rated|family[- ]friendly|all[- ]ages)\b/i;
const RATING_BUCKET: Record<string, string> = { g: 'all ages', e: 'all ages', everyone: 'all ages', 'pg-13': 'teens', t: 'teens', teen: 'teens', r: 'adults', m: 'adults', mature: 'adults' };

const bucketOf = (phrase: string): string | undefined => AUDIENCE.find(({ re }) => re.test(phrase))?.bucket;
const ageBucket = (n: number): string => (n <= 12 ? 'kids' : n <= 17 ? 'teens' : 'adults');

/**
 * The audience a sentence SETS ("for kids 2–6", "a teen comic", "rated PG-13", "the audience is adults"), as a bucket,
 * or undefined ("the kids look for the dog" sets nothing). A brief note is already a fact ("kids 2–6", "audience:
 * teens"), so `note` reads the bare audience word.
 */
export function statedAudience(text: string, note = false): string | undefined {
  const t = clean(text);
  if (!t) return undefined;
  if (note) return bucketOf(t);
  const rating = AUDIENCE_RATING_RE.exec(t);
  if (rating) {
    const r = (rating[1] ?? rating[2]).toLowerCase().replace(/\s+/g, '-');
    const bucket = RATING_BUCKET[r] ?? bucketOf(r.replace(/-/g, ' '));
    if (bucket) return bucket;
  }
  const ages = AUDIENCE_AGES_RE.exec(t);
  if (ages) return ageBucket(Number(ages[1] ?? ages[2]));
  for (const re of [AUDIENCE_FOR_RE, AUDIENCE_BOOK_RE, AUDIENCE_IS_RE]) {
    const m = re.exec(t);
    const bucket = m ? bucketOf(m[1]) ?? bucketOf(m[0]) : undefined;
    if (bucket) return bucket;
  }
  return undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Per language: the bare name (a note) and the phrases that SET the comic's language (a request). */
const LANGUAGE_READERS = LANGUAGES.map((l) => {
  const name = escapeRe(l.english);
  return {
    english: l.english,
    bare: new RegExp(`\\b${name}\\b`, 'i'),
    asks: [
      new RegExp(`\\b(?:write|make|redo|turn|change|switch|do|put|keep|have)\\s+(?:it|this|everything|the (?:whole )?(?:comic|book|story|dialogue|text|lines|words|script|speech))\\s+(?:in|into|to)\\s+${name}\\b`, 'i'),
      new RegExp(`\\b${name}\\s+(?:language|comic|book|version|only)\\b`, 'i'),
      new RegExp(`\\blanguage(?:\\s+(?:is|to|should be)|\\s*:)?\\s+${name}\\b`, 'i')
    ]
  };
});

/**
 * The language a sentence SETS for the comic ("write it in Hindi", "a Telugu comic", "language: Tamil"), or
 * undefined ("the sign says hello in Hindi" and "she shouts in English" set nothing). A brief note (`note`) is a fact,
 * so the bare name counts there ("Telugu dialogue").
 */
export function statedLanguage(text: string, note = false): string | undefined {
  const t = clean(text);
  if (!t || /\btranslat/i.test(t)) return undefined; // a translation is another edition, never the comic's own language
  for (const l of LANGUAGE_READERS) {
    if (note ? l.bare.test(t) : l.asks.some((re) => re.test(t))) return l.english;
  }
  return undefined;
}

/** The slot values a sentence states: page count, audience, language. */
const slotsOf = (text: string, note = false) => ({ pages: requestedPageCount(text), audience: statedAudience(text, note), language: statedLanguage(text, note) });

/**
 * The contradictions in a request, most important first (plan §3 A3.2). Deterministic, free, no model call:
 * - contradiction_pinned: the target is a balloon the creator pinned or locked;
 * - contradiction_pages: a new page count while the plan is approved or pages are drawn;
 * - contradiction_style: a lettering preset switch while the comic has its own kind, speaker or line looks;
 * - contradiction_note: a page count, audience or language that differs from an earlier brief note.
 */
export function contradictionsOf(doc: ComicDoc, userText: string, focus?: StudioFocus): Contradiction[] {
  const text = clean(userText);
  if (!text) return [];
  const out: Contradiction[] = [];

  // Pinned or locked balloons the request would move.
  if (MOVE_RE.test(text)) {
    const selected = new Set((focus?.lineIds || []).filter((id) => typeof id === 'string'));
    const pageNs = new Set([...text.matchAll(PAGE_REF_RE)].map((m) => Number(m[1])));
    // A page-wide re-place needs a real move verb and the page's balloons as its object ("rearrange the balloons on
    // page 1"); "put the dialogue in Hindi" moves nothing.
    const pageWide = PAGE_MOVE_RE.test(text) && ALL_BALLOONS_RE.test(text);
    const wholePages = new Set(pageWide ? doc.pages.filter((p) => pageNs.has(p.n) || (focus?.pageId === p.id && !selected.size)).map((p) => p.id) : []);
    const hit = pinnedBalloons(doc).filter((p) => selected.has(p.line.id) || wholePages.has(p.page.id));
    if (hit.length) {
      const locked = hit.some((p) => p.locked);
      const shown = hit.slice(0, 3).map(pinnedLabel).join('; ');
      out.push({
        gap: 'contradiction_pinned',
        text: `the user asked to move ${hit.length === 1 ? 'a balloon' : `${hit.length} balloons`} they ${locked ? 'pinned or locked' : 'pinned'} by hand (${shown}${hit.length > 3 ? '; …' : ''}) — ask_user once: "Keep ${hit.length === 1 ? 'it' : 'them'} where ${hit.length === 1 ? 'it is' : 'they are'}" / "Move ${hit.length === 1 ? 'it' : 'them'}" before moving; until then leave pinned balloons where they are. Never move them silently.`
      });
    }
  }

  // A new page count against an approved plan or drawn pages.
  const asked = requestedPageCount(text);
  const drawn = doc.pages.filter((p) => p.render.status === 'ready').length;
  const current = doc.pages.length || doc.format.pageCount;
  if (asked !== undefined && asked !== current && (doc.planStatus === 'approved' || drawn > 0)) {
    const what = doc.planStatus === 'approved' ? `the approved plan has ${plural(current, 'page')}` : `the comic has ${plural(current, 'page')}`;
    out.push({
      gap: 'contradiction_pages',
      text: `the user asked for ${plural(asked, 'page')}, but ${what}${drawn ? ` (${drawn} drawn)` : ''} — ask_user once: "Keep ${plural(current, 'page')}" / "Change to ${plural(asked, 'page')}", saying what changes (the plan is rewritten${drawn ? '; drawn pages may need redrawing, which costs' : ''}). Never change it silently.`
    });
  }

  // A lettering preset switch over the comic's own looks.
  const preset = requestedLetteringPreset(text);
  const ls = letterStyleOf(doc);
  if (preset && preset !== ls.presetId) {
    const looks = ownLooks(doc);
    // Only the looks a switch DROPS (the base and kind looks); speaker, line and saved-style looks stay on top of any
    // preset, so a comic with only those switches without a question.
    if (looks.base || looks.kinds.length) {
      const dropped = [...(looks.base ? ['the base look'] : []), ...looks.kinds];
      out.push({
        gap: 'contradiction_style',
        text: `the user asked for the ${letteringPresetName(preset)} lettering, but the comic has its own looks for ${joinList(dropped.slice(0, 5))} on top of ${letteringPresetName(ls.presetId)} — ask_user once: "Keep my looks" (stay on ${letteringPresetName(ls.presetId)}) / "Switch to ${letteringPresetName(preset)}" (drops the base and kind looks; speaker and line looks stay on top), naming those looks. Never drop them silently.`
      });
    }
  }

  // The same slot as an earlier brief note, with a different value.
  const now = slotsOf(text);
  const notes = doc.brief.notes.map((n) => clean(n)).filter(Boolean);
  const slotWords: Record<keyof typeof now, string> = { pages: 'the page count', audience: 'the audience', language: 'the language' };
  for (const slot of ['pages', 'audience', 'language'] as const) {
    const value = now[slot];
    if (value === undefined) continue;
    // The latest earlier note that states this slot.
    for (let i = notes.length - 1; i >= 0; i -= 1) {
      const before = slotsOf(notes[i], true)[slot];
      if (before === undefined) continue;
      if (before !== value) {
        const said = slot === 'pages' ? plural(value as number, 'page') : String(value);
        const was = slot === 'pages' ? plural(before as number, 'page') : String(before);
        out.push({
          gap: 'contradiction_note',
          text: `the user now says ${slotWords[slot]} is ${said}, but an earlier note says “${clip(notes[i], 120)}” (${was}) — ask_user once: "Keep ${was}" / "Change to ${said}", quoting that note. Never override it silently.`
        });
      }
      break;
    }
    if (out.some((c) => c.gap === 'contradiction_note')) break;
  }
  return out;
}

// ── The dialogue_target gap (plan §3 A3.2; B-RESOLVE wave note 5, built in wave 2 B-TOOL) ──

/** The dialogue_target gap: the lines a dialogue request could mean, and the director-facing words. */
export interface DialogueTargetGap {
  gap: DialogueGap;
  text: string;
  /** The "Which line?" choices the resolver would offer (≤ 5, each with its balloon picture). */
  choices: ReturnType<typeof whichLineChoices>;
}

/** Longer messages are scripts or stories, never one dialogue edit (and the grammar's cost stays bounded). */
const DIALOGUE_GAP_MAX_CHARS = 600;

/**
 * A request about dialogue that matches 2–5 lines ("make Maya's line a whisper" when Maya has three): the same
 * deterministic grammar and resolver dialogue_edit uses (shared/comic/dialogue), so the gap and the tool agree. Only a
 * sentence the grammar reads as a dialogue edit counts, and only when its target resolves to "which" (several
 * candidates); one match, none, "tap the balloon" (> 5) or a plural ("all", "these") never asks. Free; no model call.
 */
export function dialogueTargetGap(doc: ComicDoc, userText: string, focus?: StudioFocus): DialogueTargetGap | undefined {
  const text = clean(userText);
  if (!text || text.length > DIALOGUE_GAP_MAX_CHARS || !doc.pages?.length) return undefined;
  let intents: ReturnType<typeof parseDialogue>['intents'];
  try {
    intents = parseDialogue(text, { selected: !!focus?.lineIds?.length }).intents;
  } catch {
    return undefined;
  }
  const ctx = {
    ...(focus?.lineIds?.length ? { lineIds: focus.lineIds } : {}),
    ...(focus?.pageId ? { pageId: focus.pageId } : {}),
    ...(typeof focus?.panelN === 'number' ? { panelN: focus.panelN } : {})
  };
  for (const intent of intents) {
    if (intent.act === 'add') continue;
    const ref: LineRef | undefined = intent.act === 'swap' ? intent.a : (intent as { target?: LineRef }).target;
    if (!ref) continue;
    const res = resolveLineRef(doc, ref, ctx);
    if (res.status !== 'which') continue;
    const choices = whichLineChoices(doc, res.candidates);
    if (choices.length < 2) continue;
    return {
      gap: 'dialogue_target',
      choices,
      text: `the request could mean ${choices.length} lines (${choices.map((c) => c.label).join('; ')}) — call dialogue_edit with the user's words and let it ask "Which line?" (it shows each balloon); never change all of them unless the user said all / every / both.`
    };
  }
  return undefined;
}

/** Open questions, highest priority first (only the first is surfaced per turn). Contradictions lead when enabled. */
export function materialGaps(doc: ComicDoc, userText: string, opts: GapOptions = {}): MaterialGap[] {
  const text = clean(userText);
  const gaps: MaterialGap[] = opts.contradictions ? contradictionsOf(doc, userText, opts.focus).map((c) => c.gap) : [];
  // Behind the same flag as the contradictions (COMIC_CONFLICT_GUARD): the plan's A3.2 list carries it with them.
  if (opts.contradictions && dialogueTargetGap(doc, userText, opts.focus)) gaps.push('dialogue_target');
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

const GAP_TEXT: Record<Exclude<MaterialGap, ContradictionGap | DialogueGap>, string> = {
  attachments_purpose: 'the user attached images without saying what they are — ask who/what they show (a character, the style to follow, or a place) unless it is obvious.',
  vague_group: 'the user mentioned a vague group (e.g. "other animals") — pick 2–3 that fit, cast them (kind, count), name them in your reply; do not ask open-ended.',
  page_count: 'no page count yet — propose one (default first) in an ask_user, or pick a sensible one and say so.',
  spend_intent: 'the user gave feedback on drawn art — ask which fix they want (free options first, paid ones with prices) before spending anything.'
};

/**
 * The OPEN QUESTIONS line for the doc summary ('' when nothing is open). With `opts.contradictions` (the conflict
 * guard's flag) a contradiction comes first, in words that quote the earlier decision.
 */
export const openQuestionsLine = (doc: ComicDoc, userText: string, opts: GapOptions = {}): string => {
  if (opts.contradictions) {
    const first = contradictionsOf(doc, userText, opts.focus)[0];
    if (first) return `OPEN QUESTIONS: ${first.text}`;
    const which = dialogueTargetGap(doc, userText, opts.focus);
    if (which) return `OPEN QUESTIONS: ${which.text}`;
  }
  const first = materialGaps(doc, userText)[0];
  return first ? `OPEN QUESTIONS: ${GAP_TEXT[first as Exclude<MaterialGap, ContradictionGap | DialogueGap>]}` : '';
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

/** Registry quote for a chip, on the comic's locked model when it has one (the same price the gate re-quotes). */
const estimateOf = (doc: ComicDoc, kind: ImageJobKind, count: number, byok: boolean): number => estimateDocJobs(doc, [{ kind, count }], { byok }).usd;

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
