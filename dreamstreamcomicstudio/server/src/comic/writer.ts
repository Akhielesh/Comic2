// Comic Studio (v4) planning intelligence: the page-script writer, source analysis and
// style directions. Every call is a strict-JSON completion on the WRITER text role (a
// strong model — never the client's chat model), validated and normalized server-side,
// with one repair round-trip that feeds the validation errors back to the model.
//
// The writer is where comics craft lives (spec §6.7): turn-hooks, establishing shots,
// shot variety, visible action, tight lettering budgets, faithful adaptation of the
// author's script. Its output is the page plan the user reviews BEFORE any image spend.

import {
  CAST_KINDS,
  emptyRender,
  newId,
  type Brief,
  type CastKind,
  type CastTier,
  type Character,
  type CharacterLook,
  type ComicDoc,
  type Line,
  type LineKind,
  type Page,
  type Panel,
  type PanelSize,
  type ShotType
} from '../../../shared/comic/doc.js';
import { needMeter, type NeedMeter } from '../../../shared/comic/density.js';
import { languageSpec, lineLengthRule } from '../../../shared/comic/languages.js';
import { letteringAspect } from '../../../shared/comic/lettering/layout.js';
import { resolveImageJob } from '../../../shared/comic/models.js';
import { quoteLockOf } from '../../../shared/comic/plan.js';
import { checkPagePlan, splashIssues, type LayoutChoice } from '../../../shared/comic/pagePlanCheck.js';
import {
  OFF_PANEL_SHOTS,
  PANEL_LIMITS,
  RECURRING,
  panelCountNote,
  panelCountRule,
  revisionPanelLimit,
  scaledLimit,
  textBudget,
  textUnitFor
} from '../../../shared/comic/panelRules.js';
import { ALWAYS_RULE, RATING_RULES, effectiveRating, isKidsAudience, isLittleKidsAudience, softenAction, type ContentRating } from '../../../shared/comic/safety.js';
import { STYLE_PRESETS, type StylePreset } from '../../../shared/comic/stylePresets.js';
import type { ChatMessage, MessagePart } from '../ai/providers/types.js';
import { extractBalancedJson } from '../ai/jsonCoerce.js';
import { effectiveLayout, harmonizePanelSizes, layoutPanelCount, parseLayout, synthesizeLayout } from './prompts.js';
import { prefilterText } from './safety/index.js';
import { StudioError, type LlmClient, type LlmResult, type TextRole } from './types.js';

// ── Limits ───────────────────────────────────────────────────────────────────

export const MAX_PANELS_PER_PAGE = PANEL_LIMITS.codeMax;
export const MAX_LINES_PER_PANEL = 4;
export const MAX_PAGES = 40;
/** Source text sent to the writer (head + tail kept when longer). */
export const WRITER_SOURCE_LIMIT = 60_000;
/** Source text sent to analyzeSource. */
export const ANALYSIS_SOURCE_LIMIT = 120_000;
const MIN_STYLE_SPEC_WORDS = 35;

const PANEL_SIZES: PanelSize[] = ['small', 'medium', 'large', 'wide', 'tall', 'splash'];
const SHOT_TYPES: ShotType[] = ['establishing', 'wide', 'full', 'medium', 'close_up', 'extreme_close_up', 'over_shoulder', 'insert', 'pov'];
const LINE_KINDS: LineKind[] = ['speech', 'thought', 'whisper', 'shout', 'caption', 'sfx'];
const SPOKEN_KINDS = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const CAST_TIERS: CastTier[] = ['lead', 'support', 'extra'];
const LOOK_FIELDS = ['summary', 'age', 'gender', 'build', 'face', 'hair', 'eyes', 'skin', 'outfit', 'palette', 'props', 'marks', 'species', 'markings'] as const;
const KIND_SCHEMA = { type: 'string', enum: CAST_KINDS } as const;

// ── Small helpers ────────────────────────────────────────────────────────────

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const wordCount = (text: string) => (clean(text).match(/\S+/g) || []).length;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

const addCost = (total: number | undefined, cost: number | undefined) =>
  typeof cost === 'number' && Number.isFinite(cost) ? (total || 0) + cost : total;

/** Keep the head and the tail of an over-long text (the ending matters for adaptation). */
export const truncateMiddle = (text: string, limit: number): { text: string; truncated: boolean; omitted: number } => {
  if (text.length <= limit) return { text, truncated: false, omitted: 0 };
  const head = Math.floor(limit * 0.8);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[… ${omitted.toLocaleString('en-US')} characters omitted here …]\n\n${text.slice(text.length - tail)}`,
    truncated: true,
    omitted
  };
};

/** JSON.stringify without empty strings/arrays/nulls — compact model context. */
const compactJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length) ? undefined : v));

const normalizeName = (name: string) =>
  clean(name)
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const languageName = (code?: string): string => {
  const tag = clean(code) || 'en';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;
  }
};

/** Parse model text that should be JSON (fences, prose around it, trailing commas). */
export const parseJsonText = (text: string): unknown => {
  const trimmed = (text || '').trim();
  if (!trimmed) return undefined;
  const attempts = [trimmed, trimmed.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()];
  const balanced = extractBalancedJson(attempts[1]);
  if (balanced) attempts.push(balanced, balanced.replace(/,(\s*[}\]])/g, '$1'));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* next */
    }
  }
  return undefined;
};

// ── Strict-JSON completion with one repair round-trip ────────────────────────

export interface StructuredCheck<T> {
  /** Usable (already normalized) value, or undefined when the output can't be used. */
  value?: T;
  /** Problems to send back to the model on the first attempt (empty = accept). */
  problems: string[];
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new StudioError('CANCELLED', 'Stopped.', { status: 499 });
};

const toStudioError = (err: unknown, signal: AbortSignal | undefined, failure: string): StudioError => {
  if (err instanceof StudioError) return err;
  if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') return new StudioError('CANCELLED', 'Stopped.', { status: 499 });
  return new StudioError('PROVIDER_ERROR', failure, { status: 502, retryable: true, cause: err });
};

/**
 * One strict-schema completion, validated by `validate`. When the first reply has
 * problems the model gets them back once ("repair"); the repaired reply is used if it is
 * usable, else the first usable one. Nothing usable after two replies → `fallback()` when
 * given (flagged `fellBack`), else PROVIDER_ERROR with the friendly `failure` message.
 * Transport errors keep their StudioError codes.
 */
export async function completeStructured<T>(args: {
  llm: LlmClient;
  role: TextRole;
  system: string;
  user: string | MessagePart[];
  schemaName: string;
  schema: Record<string, unknown>;
  validate: (json: unknown) => StructuredCheck<T>;
  failure: string;
  /** Value to use when no reply is usable (instead of throwing). */
  fallback?: () => T;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<{ value: T; costUsd?: number; model: string; attempts: number; fellBack?: boolean }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: args.system },
    { role: 'user', content: args.user }
  ];
  let costUsd: number | undefined;
  let model = '';
  let usable: T | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    throwIfAborted(args.signal);
    let result: LlmResult;
    try {
      result = await args.llm.complete({
        role: args.role,
        messages,
        jsonSchema: { name: args.schemaName, schema: args.schema, strict: true },
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        signal: args.signal
      });
    } catch (err) {
      // A failed repair call still leaves the first (usable) answer.
      if (usable !== undefined && !args.signal?.aborted) return { value: usable, costUsd, model, attempts: attempt - 1 };
      throw toStudioError(err, args.signal, args.failure);
    }
    costUsd = addCost(costUsd, result.costUsd);
    model = result.model || model;
    const json = result.json !== undefined && result.json !== null && typeof result.json === 'object' ? result.json : parseJsonText(result.text);
    const check: StructuredCheck<T> =
      json === undefined ? { problems: ['The reply was not valid JSON. Reply with one JSON object that matches the schema.'] } : args.validate(json);
    if (check.value !== undefined) usable = check.value;
    if (check.value !== undefined && !check.problems.length) return { value: check.value, costUsd, model, attempts: attempt };
    if (attempt === 2) break;
    const previous = clean(result.text) ? result.text : JSON.stringify(json ?? null);
    messages.push({ role: 'assistant', content: clip(previous, 40_000) });
    messages.push({
      role: 'user',
      content:
        `Your reply can't be used as-is:\n${check.problems.slice(0, 20).map((p) => `- ${p}`).join('\n')}\n` +
        'Fix these and reply with the complete corrected JSON object only (same schema, every key present).'
    });
  }
  if (usable !== undefined) return { value: usable, costUsd, model, attempts: 2 };
  if (args.fallback) return { value: args.fallback(), costUsd, model, attempts: 2, fellBack: true };
  throw new StudioError('PROVIDER_ERROR', args.failure, { status: 502, retryable: true });
}

// ── JSON schemas (strict: every key required, no extra keys) ─────────────────

const str = { type: 'string' } as const;
const strArray = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties
});

const LOOK_SCHEMA = obj(Object.fromEntries(LOOK_FIELDS.map((k) => [k, str])));

export const PAGE_PLAN_SCHEMA = obj({
  pages: {
    type: 'array',
    items: obj({
      n: { type: 'integer' },
      summary: str,
      layout: str,
      turnHook: str,
      panels: {
        type: 'array',
        items: obj({
          n: { type: 'integer' },
          size: { type: 'string', enum: PANEL_SIZES },
          shot: { type: 'string', enum: SHOT_TYPES },
          angle: str,
          action: str,
          castIds: strArray,
          placeId: str,
          mood: str,
          lines: {
            type: 'array',
            items: obj({ kind: { type: 'string', enum: LINE_KINDS }, speakerId: str, text: str })
          }
        })
      }
    })
  },
  newCast: {
    type: 'array',
    items: obj({ name: str, role: str, tier: { type: 'string', enum: CAST_TIERS }, kind: KIND_SCHEMA, count: { type: 'integer' }, look: LOOK_SCHEMA, personality: str, voice: str })
  }
});

// ── Writer prompt ────────────────────────────────────────────────────────────

/** How many named characters a page can hold on model (the character refs of the model that draws it: the lock, else tier + override). */
const characterSlots = (doc: ComicDoc): number => {
  const { spec } = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride, quoteLockOf(doc));
  return spec.refs.characters > 0 ? spec.refs.characters : 4;
};

const kindRules = (doc: ComicDoc): string[] => {
  const f = doc.format;
  const rules: string[] = [];
  switch (f.kind) {
    case 'manga':
      rules.push('Manga pacing: decompressed beats, reaction close-ups, speed-line action panels, dramatic page-turn reveals.');
      break;
    case 'webtoon':
      rules.push(
        `Webtoon: each "page" is one vertical-scroll segment of 2–${PANEL_LIMITS.webtoonMax} full-width panels stacked top to bottom (usually 3). layout is "Stacked vertically: N full-width panels." Use size "tall" for long vertical beats (falls, towers, reveals) and "wide" for short ones; one beat per panel; use vertical space between panels for timing.`
      );
      break;
    case 'strip':
      rules.push('Comic strip: each page is ONE strip of 3–4 panels in a single row (layout "Row 1: N equal panels."). The last panel lands the punchline or the beat.');
      break;
    case 'storybook':
      rules.push(
        `Storybook: 1–${PANEL_LIMITS.storybookMax} large panels per page (usually ${PANEL_LIMITS.storybookTypical}). The narration is read aloud, so carry the story in short caption lines (2 sentences max each); dialogue is optional and sparing.`
      );
      if (panelCountRule(f).clampedFrom !== undefined) {
        rules.push(`The format asks for ${panelCountRule(f).clampedFrom} panels per page, but a storybook page holds at most ${PANEL_LIMITS.storybookMax}: plan every page with exactly ${PANEL_LIMITS.storybookMax}.`);
      }
      break;
    default:
      break;
  }
  if (f.readingDirection === 'rtl') {
    rules.push(
      'Reading order is RIGHT-TO-LEFT: the first panel of a row is on the right. Write tall-panel rows as "Rows 2–3: one tall panel on the right beside two stacked panels on the left."'
    );
  }
  if (isKidsAudience(doc) || /\b(all ages|family)\b/i.test(clean(doc.brief.audience))) {
    rules.push(
      isLittleKidsAudience(doc)
        ? 'Audience is little children: very short, warm, simple sentences; repetition and sound words are welcome; gentle stakes that resolve on the same page.'
        : 'Audience includes children: gentle stakes, simple vivid words, nothing gory or frightening beyond what the brief asks for.'
    );
  }
  return rules;
};

/** CONTENT RATING section (safety.md §3.2): the effective rating's story rule + the Always line + adaptation notes. */
export const contentRatingSection = (doc: ComicDoc, rating?: ContentRating): string[] => {
  const effective = rating ?? effectiveRating(doc).rating;
  const lines = [
    '',
    `CONTENT RATING (${effective})`,
    `- ${RATING_RULES[effective].story}`,
    '- Action, adventure, horror, suspense, monsters, villains and peril are welcome — write them with energy, within the rating.',
    `- ${ALWAYS_RULE}`,
    '- Trademarked characters or brands become original homages: new names, distinct designs, same spirit.'
  ];
  const adapt = doc.safety?.source?.adaptNotes || [];
  if (adapt.length) {
    lines.push(
      `- ADAPTATION: the source has scenes beyond ${effective} (${adapt.slice(0, 6).map((n) => clean(n)).filter(Boolean).join('; ')}). Adapt them within the rating (cut away before impact, imply rather than show); keep the plot and meaning.`
    );
  }
  return lines;
};

/** "Write natural, everyday spoken Telugu…" — native register, not translationese (i18n.md §8.8). */
const languageRule = (doc: ComicDoc, language: string): string => {
  const code = clean(doc.format.language) || 'en';
  const native = code.toLowerCase().startsWith('en')
    ? `Write every line in ${language}.`
    : `Write every line in natural, everyday spoken ${language}${languageSpec(code)?.endonym ? ` (${languageSpec(code)!.endonym})` : ''} as people really talk — not a translation from English, not textbook register. Character names stay as given in CAST.`;
  return isKidsAudience(doc) && !code.toLowerCase().startsWith('en') ? `${native} For children: short, simple, warm words a parent would read aloud.` : native;
};

/** The panel-count line of the writer prompt (shared/comic/panelRules.ts is the one table). */
const panelsRule = (doc: ComicDoc): string => {
  const rule = panelCountRule(doc.format);
  if (rule.exact !== undefined) {
    if (rule.clampedFrom !== undefined) {
      return `Panels per page: exactly ${rule.exact} on every page — a storybook page holds at most ${PANEL_LIMITS.storybookMax} large panels (the format asks for ${rule.clampedFrom}).`;
    }
    return rule.exact === 1
      ? 'Panels per page: exactly 1 on every page — the author chose single-panel pages, so every page is one full-page panel.'
      : `Panels per page: exactly ${rule.exact} on every page (a splash page only if the author asks for one).`;
  }
  if (doc.format.kind === 'strip') return `Panels per page: ${rule.min}–${rule.max}.`;
  if (doc.format.kind === 'storybook') return `Panels per page: ${rule.min}–${rule.max} large panels (usually ${rule.typical}).`;
  if (doc.format.kind === 'webtoon') return `Panels per page: ${rule.min}–${rule.max} (usually ${rule.typical}).`;
  const fast = rule.fast!;
  const unit = textUnitFor(doc.format.language);
  return (
    `Panels per page: usually ${rule.typical} big panels (${rule.min}–${rule.max}) — fewer, larger panels give the art and the words room; let the dialogue and the beats decide. ` +
    `Use ${fast.panels} only for a fast, nearly silent sequence (${scaledLimit(fast.maxWords, unit)} ${unit.noun}s or fewer on the whole page). Never more than ${fast.panels}. When the story needs more moments, compress the smaller ones.`
  );
};

/** The splash line of PAGES, or none when the author fixed one panel per page (every page is single-panel by choice). */
const splashRule = (doc: ComicDoc): string[] =>
  panelCountRule(doc.format).exact === 1
    ? []
    : [`- At most 1 splash (one dominant panel) per ${PANEL_LIMITS.splashEvery} pages, never on two pages in a row, saved for the biggest moment.`];

/**
 * The word-budget lines of the writer prompt: what a panel holds by its size (density.ts wordBudget, the speech
 * oracle). Other scripts scale by the same per-balloon ratio lineLengthRule already uses (Japanese counts
 * characters, Dravidian languages fewer, longer words); the plan check itself measures every script with the
 * lettering engine.
 */
const budgetRules = (doc: ComicDoc): string[] => {
  // The same unit, ratio and rounding the page-plan check states (shared/comic/panelRules.ts textUnitFor).
  const tu = textUnitFor(doc.format.language);
  const k = tu.k;
  const unit = `${tu.noun}s`;
  const n = (area: number) => textBudget(area, 1, tu);
  const quiet = scaledLimit(PANEL_LIMITS.quietShotMaxWords, tu);
  return [
    `- Word budget by panel size (every balloon and caption in the panel together): a full-width row holds about ${n(0.451)} ${unit}, a half-width panel on a two-row page about ${n(0.221)}, a half-width panel on a three-row page about ${n(0.144)}, a third-width small panel about ${n(0.084)}. Each extra balloon costs about ${Math.max(1, Math.round(2 * k))} ${unit}.`,
    `- Small panels are silent or carry one line of ${quiet} ${unit} or fewer; conversations go in wide or medium panels.`,
    `- pov and insert shots carry at most ${PANEL_LIMITS.quietShotMaxLines} line of ${quiet} ${unit} or fewer.`
  ];
};

export const writerSystemPrompt = (doc: ComicDoc, rating?: ContentRating): string => {
  const slots = characterSlots(doc);
  const language = languageName(doc.format.language);
  const inArt = doc.format.lettering === 'in_art';
  const len = lineLengthRule(doc.format.language, inArt);
  const unit = len.unit === 'chars' ? 'characters' : 'words';
  return [
    'You are a veteran comics writer and editor who has scripted hundreds of published pages. You turn a brief — and the author\'s script, when there is one — into a page-by-page plan an artist can draw without asking a single question. You plan; you never draw.',
    '',
    'FAITHFULNESS',
    '- When a SOURCE is provided, adapt it faithfully: keep its events in order, its characters and the substance of its dialogue. Compress to fit the page count and trim long speeches to the limits below without changing their meaning. Never invent major plot beats, new major characters or a different ending, and never contradict the source.',
    '- If the source is already a comic script with PAGE/PANEL breaks, follow its breakdown as closely as the page count allows.',
    '- When the source is only notes or a short synopsis, expand it into a complete story that honors every stated beat, name and detail.',
    '- Without a source, build a complete story from the brief: a hook on page 1, escalation, a climax and a resolution (or the cliffhanger the brief asks for), paced across exactly the requested pages.',
    '- Brief notes and the author\'s instructions are binding.',
    '',
    'PAGES',
    '- Every page ends on a turn-hook: its last panel raises a question, reveals something or tightens tension so the reader turns the page. The final page lands the ending. Write it in turnHook (one sentence).',
    `- ${panelsRule(doc)}`,
    ...splashRule(doc),
    '- Open every scene (a new place or a jump in time) with an establishing panel in a full-width row.',
    '- summary: 1–2 sentences of what happens on the page.',
    '- layout: a row blueprint covering every panel in reading order, in exactly this vocabulary: "Row 1: one wide panel. Row 2: two equal panels. Row 3: three small panels." A tall panel spanning two rows: "Rows 2–3: one tall panel on the left beside two stacked panels on the right." A single-panel page: "One full-page splash panel."',
    '- Panel sizes must agree with the layout: wide or large = a full-width row, tall = spans two rows, small/medium = shares a row, splash = dominant.',
    '',
    'PANELS',
    '- One frozen moment per panel. Begin each action with the one thing the panel must show (one short sentence), then add who is where (left/right, foreground/background), doing what, with which expression and key props, plus light or weather when it matters. Present tense, concrete, at most 45 words; call characters by their CAST names. No inner thoughts, backstory, dialogue or "then" sequences — if it can\'t be drawn, it doesn\'t belong in action.',
    '- Open with an establishing (or wide) shot whenever the scene changes place or time.',
    '- A pov shot shows what a character sees, so that character is not in the frame; in pov, insert and establishing shots a speaker may be heard off-panel.',
    '- Vary the camera: never more than 2 panels in a row with the same shot type. Close-ups for emotion, inserts for important objects, wide shots for geography and action.',
    '- Keep the 180° rule within a scene: characters keep their screen sides (say "on the left"/"on the right") unless the action motivates a change.',
    '- angle: "" or one of eye level, low angle, high angle, bird\'s-eye view, worm\'s-eye view, dutch tilt.',
    '- mood: a few words of emotion and light ("tense, cold blue dusk").',
    '- castIds: every recurring character visible in the panel — people AND animals, creatures, robots, toys, vehicles and key props — nobody else will be drawn. Use ids from CAST. One-off unnamed background figures stay in the action text, never in castIds.',
    `- At most ${slots} recurring named characters on any one page: the artist can only keep ${slots} identities on model (a group like "Ducklings ×3" counts as one). Give human walk-ons and crowds no name.`,
    '- placeId: an id from PLACES, or "" when none fits.',
    '',
    'DIALOGUE & LETTERING',
    '- lines are in reading order. kind: speech | thought | whisper | shout | caption | sfx.',
    '- speakerId: the character id for speech/thought/whisper/shout, "" for caption and sfx. Every speaker must be in that panel\'s castIds, except an off-panel voice in a pov, insert or establishing shot (keep its speakerId, leave it out of castIds: it is heard, not drawn).',
    `- At most ${len.perLine} ${unit} per balloon, at most 3 balloons per panel, at most ${len.perPage} ${unit} of lettering per page.${inArt ? ' The artist letters these by hand, so keep lines short and plain.' : ''}`,
    ...budgetRules(doc),
    '- Natural, in-character lines (use each character\'s voice). Never put stage directions, panel descriptions or prompt text in a line.',
    '- Captions only when they earn their place: a time/place jump ("Old Mumbai. Monsoon season.") or narration voice-over. Never describe what the art already shows. Silent panels are good — use them for reactions, atmosphere and action.',
    '- sfx: short onomatopoeia ("KRAK!") only for sounds that matter.',
    `- ${languageRule(doc, language)}`,
    '',
    'NEW CHARACTERS',
    '- Prefer the existing cast. If the story needs a recurring character who is not in CAST — including animals, pets, sea creatures, toys, LEGO-style figures, vehicles, robots and key props (give unnamed ones a descriptive name such as "Ducklings" or "Frog") — add them to newCast with kind (person, animal, creature, robot, toy, vehicle, object), count (2–12 for a group drawn as one identity, else 1) and a complete drawable look (summary plus every look field; species and markings for non-humans; "" only where nothing is known), and refer to them by their exact name in castIds and speakerId. Tier: support if they recur or speak often, else extra. newCast is [] when no one new is needed.',
    ...(kindRules(doc).length ? ['', 'FORMAT NOTES', ...kindRules(doc).map((r) => `- ${r}`)] : []),
    ...contentRatingSection(doc, rating),
    '',
    'OUTPUT',
    'Reply with JSON only, matching the schema. Every key is required: use "" or [] when something does not apply. Page n = page number; panel n starts at 1 on each page.'
  ].join('\n');
};

const lookLine = (c: Character): string => {
  const l = c.look || ({ summary: '' } as CharacterLook);
  return [
    clean(l.summary),
    clean(l.species) && `species: ${clean(l.species)}`,
    clean(l.outfit) && `outfit: ${clean(l.outfit)}`,
    clean(l.marks) && `marks: ${clean(l.marks)}`,
    clean(l.markings) && `markings: ${clean(l.markings)}`
  ]
    .filter(Boolean)
    .join('; ');
};

const pageHeadline = (doc: ComicDoc, page: Page): string => {
  const names = [...new Set(page.panels.flatMap((p) => p.castIds))]
    .map((id) => doc.cast.find((c) => c.id === id)?.name)
    .filter(Boolean)
    .join(', ');
  return `Page ${page.n} (${page.panels.length} panels${names ? `; ${names}` : ''}): ${clean(page.summary) || '—'}${clean(page.turnHook) ? ` Hook: ${clean(page.turnHook)}` : ''}`;
};

const pageDetail = (doc: ComicDoc, page: Page): string => {
  const name = (id?: string) => (id ? doc.cast.find((c) => c.id === id)?.name || id : '');
  const lines = [pageHeadline(doc, page), `  layout: ${clean(page.layout) || '—'}`];
  for (const panel of page.panels) {
    lines.push(
      `  Panel ${panel.n} [${panel.size}, ${panel.shot}${panel.angle ? `, ${panel.angle}` : ''}] ${clean(panel.action)}` +
        ` | cast: ${panel.castIds.map(name).join(', ') || 'none'}${panel.placeId ? ` | place: ${panel.placeId}` : ''}${panel.mood ? ` | mood: ${panel.mood}` : ''}`
    );
    for (const l of panel.lines) lines.push(`    ${l.kind}${l.speakerId ? ` ${name(l.speakerId)}` : ''}: "${clean(l.text)}"`);
  }
  return lines.join('\n');
};

/** One page of a story outline (long plans are outlined first, then written in chunks). */
export interface OutlinePage {
  n: number;
  summary: string;
  turnHook: string;
  characters: string[];
  place: string;
}

export const writerUserMessage = (
  doc: ComicDoc,
  opts: {
    instructions?: string;
    targets?: Page[] | null;
    /** Binding outline of every page (chunked writing). */
    outline?: OutlinePage[];
    /** New characters the outline introduced (refer to them by name). */
    outlineCast?: { name: string; role?: string; look?: string }[];
    /** Replaces the default TASK line. */
    task?: string;
  }
): string => {
  const b = doc.brief;
  const f = doc.format;
  const targets = opts.targets || null;
  const parts: string[] = [];
  parts.push(
    `BRIEF\n${compactJson({
      title: clean(b.title),
      logline: clean(b.logline),
      premise: clean(b.premise),
      genre: clean(b.genre),
      tone: clean(b.tone),
      audience: clean(b.audience),
      setting: clean(b.setting),
      themes: b.themes,
      notes: b.notes
    })}`
  );
  parts.push(
    `FORMAT\n${compactJson({
      kind: f.kind,
      pageCount: clamp(f.pageCount || 1, 1, MAX_PAGES),
      panelsPerPage: f.panelsPerPage,
      readingDirection: f.readingDirection,
      lettering: f.lettering,
      language: `${languageName(f.language)} (${clean(f.language) || 'en'})`
    })}`
  );
  parts.push(
    `CAST (ids for castIds and speakerId)\n${
      doc.cast.length
        ? doc.cast
            .map((c) =>
              compactJson({
                id: c.id,
                name: clean(c.name),
                tier: c.tier,
                kind: c.kind && c.kind !== 'person' ? c.kind : '',
                count: c.count && c.count > 1 ? c.count : undefined,
                role: clean(c.role),
                look: lookLine(c),
                personality: clean(c.personality),
                voice: clean(c.voice)
              })
            )
            .join('\n')
        : opts.outlineCast?.length
          ? '(none yet)'
          : '(none yet — introduce the characters the story needs in newCast)'
    }`
  );
  if (opts.outlineCast?.length) {
    parts.push(
      `NEW CAST FROM THE OUTLINE (no ids yet — use their exact names in castIds and speakerId; do not repeat them in newCast)\n${opts.outlineCast
        .map((c) => compactJson({ name: clean(c.name), role: clean(c.role), look: clip(clean(c.look), 220) }))
        .join('\n')}`
    );
  }
  if (doc.places.length) {
    parts.push(`PLACES (ids for placeId)\n${doc.places.map((p) => compactJson({ id: p.id, name: clean(p.name), look: clip(clean(p.look), 200) })).join('\n')}`);
  }
  if (clean(doc.style.name) || clean(doc.style.spec)) parts.push(`STYLE: ${clean(doc.style.name) || clip(clean(doc.style.spec), 160)}`);

  const script = doc.source.script || '';
  if (clean(script)) {
    const { text, truncated, omitted } = truncateMiddle(script.trim(), WRITER_SOURCE_LIMIT);
    parts.push(
      `SOURCE (the author's material — adapt faithfully)${
        truncated ? ` [truncated: ${omitted.toLocaleString('en-US')} characters from the middle are omitted; keep the shown beginning and ending]` : ''
      }\n<<<\n${text}\n>>>`
    );
  }

  if (targets) {
    const fixed = doc.pages.filter((p) => !targets.some((t) => t.id === p.id));
    if (fixed.length) parts.push(`FIXED PAGES (context only — do not return them; keep continuity with them)\n${fixed.map((p) => pageHeadline(doc, p)).join('\n')}`);
    parts.push(`PAGES TO REWRITE (current version)\n${targets.map((p) => pageDetail(doc, p)).join('\n\n')}`);
    // PD-2: the storybook clamp is for new pages; a page planned before it may keep its own panel count.
    const keep = targets.filter((t) => revisionPanelLimit(f, t.panels.length) > (panelCountRule(f).exact ?? Infinity));
    if (keep.length) {
      parts.push(
        `PANEL COUNT FOR THESE PAGES (planned before storybook pages were limited to ${PANEL_LIMITS.storybookMax} panels): ${keep
          .map((t) => `page ${t.n} may keep up to ${revisionPanelLimit(f, t.panels.length)} (it has ${t.panels.length})`)
          .join('; ')}. Keep each page's panel count unless the author's instructions ask to change the panels; the ${PANEL_LIMITS.storybookMax}-panel rule is for new pages.`
      );
    }
  } else if (doc.pages.length) {
    parts.push(`PREVIOUS PLAN (headlines — revise per the instructions and keep what works)\n${doc.pages.map((p) => pageHeadline(doc, p)).join('\n')}`);
  }

  if (opts.outline?.length) {
    parts.push(
      `STORY OUTLINE (binding — the whole comic, page by page)\n${opts.outline
        .map(
          (o) =>
            `Page ${o.n}: ${clean(o.summary)}${clean(o.turnHook) ? ` Hook: ${clean(o.turnHook)}` : ''}` +
            `${o.characters.length ? ` [${o.characters.map(clean).join(', ')}]` : ''}${clean(o.place) ? ` @ ${clean(o.place)}` : ''}`
        )
        .join('\n')}`
    );
  }

  const instructions = clean(opts.instructions);
  if (instructions) parts.push(`AUTHOR'S INSTRUCTIONS (binding)\n${instructions}`);

  const pageCount = clamp(f.pageCount || 1, 1, MAX_PAGES);
  parts.push(
    opts.task
      ? `TASK: ${opts.task}`
      : targets
      ? `TASK: Rewrite only page${targets.length > 1 ? 's' : ''} ${targets.map((t) => t.n).join(', ')}, applying the author's instructions and keeping everything else that works. Return exactly ${targets.length} page${targets.length > 1 ? 's' : ''} in "pages", each with its original n (${targets.map((t) => t.n).join(', ')}).`
      : `TASK: Write the complete plan: exactly ${pageCount} page${pageCount > 1 ? 's' : ''}, n = 1 to ${pageCount}.`
  );
  return parts.join('\n\n');
};

// ── Plan normalization ───────────────────────────────────────────────────────

const GROUP_WORDS = new Set([
  'crowd', 'people', 'everyone', 'everybody', 'all', 'others', 'other', 'villagers', 'soldiers', 'guards', 'police', 'officers', 'students',
  'kids', 'children', 'passersby', 'pedestrians', 'shoppers', 'background', 'extras', 'narrator', 'narration', 'voice', 'off-panel',
  'offpanel', 'unknown', 'none', 'n/a', 'nobody', 'someone', 'somebody', 'group', 'team', 'family', 'audience', 'townsfolk', 'mob', 'army',
  'customers', 'onlookers', 'bystanders', 'figures', 'silhouettes', 'everyone else', 'both', 'them', 'they'
]);

const looksLikeName = (token: string): boolean => {
  const t = clean(token);
  if (t.length < 2 || t.length > 40 || !/\p{L}/u.test(t)) return false;
  if (/^[a-z]{1,4}_[a-z0-9]{3,}$/i.test(t)) return false; // an unknown id — never a name
  if (t.split(/\s+/).length > 4) return false;
  const key = normalizeName(t);
  if (!key || GROUP_WORDS.has(key)) return false;
  const last = key.split(/\s+/).pop() || '';
  return !GROUP_WORDS.has(last);
};

const castKindOf = (v: unknown): CastKind | undefined => (typeof v === 'string' && (CAST_KINDS as readonly string[]).includes(v) ? (v as CastKind) : undefined);
/** 2–12 = a group drawn as one identity; anything else = single. */
const groupCountOf = (v: unknown): number | undefined => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
  return n !== undefined && n >= 2 ? Math.min(12, n) : undefined;
};

const titleCase = (name: string) => clean(name).replace(/(^|\s)(\p{Ll})/gu, (_m, s: string, c: string) => s + c.toUpperCase());

const cleanLook = (raw: unknown): CharacterLook => {
  const src = isObject(raw) ? raw : {};
  const look: CharacterLook = { summary: clean(src.summary) };
  for (const key of LOOK_FIELDS) {
    if (key === 'summary') continue;
    const v = clean(src[key]);
    if (v) look[key] = v;
  }
  if (!look.summary) {
    // Derive (never invent) a summary from the stated fields.
    const who = [clean(look.age), clean(look.gender)].filter(Boolean).join(' ');
    const bits = [who, look.build, look.hair, look.outfit && `wearing ${look.outfit}`, look.marks].filter(Boolean);
    look.summary = bits.join(', ');
  }
  return look;
};

/** Resolves castIds / speakerIds (ids or names) to doc characters or new-cast drafts. */
class CastResolver {
  private readonly byId = new Map<string, string>();
  private readonly byName = new Map<string, string>();
  readonly drafts = new Map<string, Character & { auto: boolean }>();

  constructor(cast: Character[]) {
    for (const c of cast) {
      this.byId.set(c.id, c.id);
      const key = normalizeName(c.name);
      if (key && !this.byName.has(key)) this.byName.set(key, c.id);
    }
  }

  private all(): { id: string; name: string }[] {
    return [...this.byName.entries()].map(([name, id]) => ({ id, name }));
  }

  /**
   * Exact id, exact name, or an unambiguous short form: a first name for a full cast name
   * ("Maya" → "Maya Rao") or a full name for a one-word cast name ("Maya Rao" → "Maya").
   * Never maps one full name onto a different one ("Maya Smith" ≠ "Maya Rao").
   */
  find(token: string): string | undefined {
    const raw = clean(token);
    if (!raw) return undefined;
    const byId = this.byId.get(raw);
    if (byId) return byId;
    const key = normalizeName(raw);
    if (!key) return undefined;
    const exact = this.byName.get(key);
    if (exact) return exact;
    const words = key.split(/\s+/);
    const first = words[0];
    if (first.length < 3) return undefined;
    const matches =
      words.length === 1
        ? this.all().filter((c) => c.name.split(/\s+/)[0] === first)
        : this.all().filter((c) => c.name === first);
    const ids = [...new Set(matches.map((m) => m.id))];
    if (ids.length === 1) return ids[0];
    // Ambiguous with a newly drafted character: the established cast member wins.
    const established = ids.filter((id) => !this.drafts.has(id));
    return established.length === 1 ? established[0] : undefined;
  }

  /** A newCast entry from the model (ignored when it is an existing character). */
  addDraft(entry: Record<string, unknown>): void {
    const name = clean(entry.name);
    if (!looksLikeName(name) || this.find(name)) return;
    const tier = CAST_TIERS.includes(entry.tier as CastTier) ? (entry.tier as CastTier) : 'extra';
    const kind = castKindOf(entry.kind);
    const count = groupCountOf(entry.count);
    const draft: Character & { auto: boolean } = {
      id: newId('ch'),
      name: titleCase(name),
      tier,
      look: cleanLook(entry.look),
      refs: [],
      sheet: emptyRender(),
      auto: false,
      ...(kind && kind !== 'person' ? { kind } : {}),
      ...(count ? { count } : {}),
      ...(clean(entry.role) ? { role: clean(entry.role) } : {}),
      ...(clean(entry.personality) ? { personality: clean(entry.personality) } : {}),
      ...(clean(entry.voice) ? { voice: clean(entry.voice) } : {})
    };
    this.register(draft);
  }

  /**
   * Resolve, creating an "auto" extra for an unknown token that is clearly a character:
   * a speaker, or a name-like castIds entry that isn't lowercase prose ("the ledger").
   */
  resolve(token: string, create: boolean, opts: { speaker?: boolean } = {}): string | undefined {
    const found = this.find(token);
    if (found || !create || !looksLikeName(token)) return found;
    const bare = clean(token).replace(/^the\s+/i, '');
    if (!opts.speaker && /^\p{Ll}/u.test(bare)) return undefined;
    const draft: Character & { auto: boolean } = {
      id: newId('ch'),
      name: titleCase(token),
      tier: 'extra',
      look: { summary: '' },
      refs: [],
      sheet: emptyRender(),
      auto: true
    };
    this.register(draft);
    return draft.id;
  }

  private register(draft: Character & { auto: boolean }) {
    this.drafts.set(draft.id, draft);
    this.byId.set(draft.id, draft.id);
    this.byName.set(normalizeName(draft.name), draft.id);
  }
}

const normalizeShot = (value: unknown): ShotType => {
  const t = clean(value).toLowerCase().replace(/[\s-]+/g, '_');
  if ((SHOT_TYPES as string[]).includes(t)) return t as ShotType;
  if (/^(close|closeup|close_up_shot|cu)$/.test(t)) return 'close_up';
  if (/^(ecu|extreme_closeup|extreme_close)$/.test(t)) return 'extreme_close_up';
  if (/^(ots|over_the_shoulder|over_shoulder_shot)$/.test(t)) return 'over_shoulder';
  if (/^(point_of_view|pov_shot)$/.test(t)) return 'pov';
  if (/^(long|long_shot|wide_shot|extreme_wide)$/.test(t)) return 'wide';
  if (/^(establishing_shot)$/.test(t)) return 'establishing';
  if (/^(full_shot|full_body)$/.test(t)) return 'full';
  if (/^(detail|detail_shot|insert_shot)$/.test(t)) return 'insert';
  return 'medium';
};

const normalizeSize = (value: unknown): PanelSize => {
  const t = clean(value).toLowerCase();
  return (PANEL_SIZES as string[]).includes(t) ? (t as PanelSize) : t === 'full' || t === 'full_width' ? 'wide' : 'medium';
};

const normalizeKind = (value: unknown, hasSpeaker: boolean): LineKind => {
  const t = clean(value).toLowerCase();
  if ((LINE_KINDS as string[]).includes(t)) return t as LineKind;
  if (/^(narration|narrator|caption_box|voiceover|voice_over)$/.test(t)) return 'caption';
  if (/^(sound|sound_effect|sound effect|fx|onomatopoeia)$/.test(t)) return 'sfx';
  if (/^(yell|scream|shouting)$/.test(t)) return 'shout';
  if (/^(think|thinking)$/.test(t)) return 'thought';
  return hasSpeaker ? 'speech' : 'caption';
};

/** Strip wrapping quotes and a leading "NAME:" the model sometimes adds to dialogue. */
const cleanLineText = (value: unknown, speakerName?: string): string => {
  let text = clean(value);
  if (/^["“].*["”]$/.test(text) && text.length >= 2) text = text.slice(1, -1).trim();
  if (speakerName) {
    // "Maya Rao: …" or "MAYA (shouting): …" — the speaker's full or first name as a prefix.
    for (const name of [...new Set([clean(speakerName), clean(speakerName).split(' ')[0]])]) {
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = text.replace(new RegExp(`^${escaped}\\s*(\\([^)]*\\))?\\s*:\\s*`, 'i'), '');
      if (stripped !== text) {
        text = stripped;
        break;
      }
    }
  }
  return clean(text);
};

export const mentionSentence = (text: string, name: string): string => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, 'iu');
  const sentences = clean(text).match(/[^.!?]+[.!?]*/g) || [];
  const hit = sentences.find((s) => re.test(s));
  return hit ? clip(clean(hit), 200) : '';
};

interface PlanNormalizeContext {
  doc: ComicDoc;
  /** Revision targets (pageIds mode), or null for a full plan. */
  targets: Page[] | null;
  pageCount: number;
  /** Effective content rating (post-plan pre-filter). */
  rating?: ContentRating;
}

const safePrefilter = (text: string, rating: ContentRating) => {
  try {
    return prefilterText(text, rating);
  } catch {
    return { decision: 'clear' as const, categories: [], ip: [] };
  }
};

/** Free pre-filter over a plan's actions and lines: what goes past the rating (for one repair round). */
export const ratingProblems = (pages: Page[], rating: ContentRating): string[] => {
  const problems: string[] = [];
  for (const page of pages) {
    for (const panel of page.panels) {
      const texts = [panel.action, ...panel.lines.map((l) => l.text)];
      const hit = texts.map((t) => safePrefilter(t, rating)).find((r) => r.decision === 'block');
      if (hit) {
        problems.push(
          `Page ${page.n}, panel ${panel.n} goes past the ${rating} rating${hit.categories.length ? ` (${hit.categories.join(', ')})` : ''}: keep the creative goal but fit the rating — imply it, cut away before impact, or make it bloodless.`
        );
      }
      if (problems.length >= 4) return problems;
    }
  }
  return problems;
};

/** Post-plan pre-filter (safety.md §3.2): anything still past the rating is softened deterministically ($0). */
export const softenPlanPages = (pages: Page[], rating: ContentRating): Page[] =>
  pages.map((page) => {
    let changed = false;
    const panels = page.panels.map((panel) => {
      const actionBlocked = safePrefilter(panel.action, rating).decision === 'block';
      const lines = panel.lines.map((l) => {
        if (safePrefilter(l.text, rating).decision !== 'block') return l;
        changed = true;
        return { ...l, text: softenAction(l.text) || l.text };
      });
      if (!actionBlocked && lines.every((l, i) => l === panel.lines[i])) return panel;
      changed = true;
      return { ...panel, action: actionBlocked ? softenAction(panel.action) || panel.action : panel.action, lines };
    });
    return changed ? { ...page, panels } : page;
  });

interface NormalizedPlan {
  pages: Page[];
  newCast: Character[];
  /** Pages whose blueprint the validator re-chose so their words fit ($0), by page id. */
  layoutFixes: Map<string, LayoutFix>;
}

/** A blueprint re-chosen in code so a page's dialogue fits (named to the user, never silent). */
interface LayoutFix {
  layout: string;
  /** The 1-based panel that did not fit, and whether it now has a full-width row. */
  panel: number;
  fullWidth: boolean;
}

/**
 * The free plan-fit pass on one page (plan §4.1): when the page is overfull and a same-count, same-order
 * blueprint fits, apply it (sizes harmonized to it) and return the fix; the page's repair problems (count, an
 * overfull panel no blueprint can fit, a talkative pov/insert panel) come back for the single repair round.
 */
const fitPage = (doc: ComicDoc, page: Page, meter: NeedMeter, existingPanels?: number): { page: Page; fix?: LayoutFix; problems: string[] } => {
  const check = checkPagePlan(doc, page, { meter, existingPanels });
  const problems = check.issues.filter((i) => i.severity === 'repair').map((i) => i.text);
  const choice: LayoutChoice | undefined = check.layoutFix;
  if (!choice) return { page, problems };
  const parsed = parseLayout(choice.layout);
  if (!parsed) return { page, problems };
  const panels = harmonizePanelSizes(page.panels, parsed, doc.format.readingDirection === 'rtl');
  const fitted: Page = { ...page, panels, layout: choice.layout };
  fitted.layout = effectiveLayout(fitted, doc.format);
  const n = check.worstPanel ?? 1;
  const after = checkPagePlan(doc, fitted, { meter, fixLayout: false, existingPanels });
  if (after.state === 'overfull') return { page, problems: [...problems, ...after.issues.filter((i) => i.kind === 'overfull').map((i) => i.text)] };
  return { page: fitted, fix: { layout: fitted.layout, panel: n, fullWidth: (after.panels[n - 1]?.box.w ?? 0) >= 0.9 }, problems };
};

/** "Page 2's layout changed so the conversation fits: panel 6 now has a full-width row." */
const layoutFixNote = (page: Page, fix: LayoutFix): string =>
  `Page ${page.n}'s layout changed so the conversation fits: panel ${fix.panel} now has ${fix.fullWidth ? 'a full-width row' : 'more room'}.`;

/** Plan-wide meter for the fit check (one engine sizer per doc). */
const planMeter = (doc: ComicDoc): NeedMeter => needMeter(doc, { aspect: letteringAspect(doc, null) });

const reuseIds = (target: Page | undefined, panels: Panel[]): Panel[] => {
  if (!target) return panels;
  return panels.map((panel, i) => {
    const old = target.panels[i];
    if (!old) return panel;
    const unused = [...old.lines];
    const lines = panel.lines.map((l) => {
      const k = unused.findIndex((o) => o.kind === l.kind && clean(o.text).toLowerCase() === clean(l.text).toLowerCase());
      if (k < 0) return l;
      const [match] = unused.splice(k, 1);
      return { ...l, id: match.id };
    });
    return { ...panel, id: old.id, lines };
  });
};

/** Validate + normalize the writer's JSON into Pages (ids assigned, cast mapped, counts clamped). */
export const normalizePlan = (json: unknown, ctx: PlanNormalizeContext): StructuredCheck<NormalizedPlan> => {
  const problems: string[] = [];
  if (!isObject(json) || !Array.isArray(json.pages)) return { problems: ['The reply must be a JSON object with a "pages" array.'] };
  const { doc, targets } = ctx;
  const resolver = new CastResolver(doc.cast);
  for (const entry of asArray(json.newCast)) if (isObject(entry)) resolver.addDraft(entry);
  const placeIds = new Map<string, string>();
  for (const p of doc.places) {
    placeIds.set(p.id, p.id);
    placeIds.set(normalizeName(p.name), p.id);
  }
  const nameOf = (id?: string) => (id ? doc.cast.find((c) => c.id === id)?.name || resolver.drafts.get(id)?.name : undefined);

  const rawPages = json.pages.filter(isObject);
  const numbered = rawPages.every((p) => Number.isInteger(p.n)) && new Set(rawPages.map((p) => p.n)).size === rawPages.length;
  const ordered = numbered ? [...rawPages].sort((a, b) => (a.n as number) - (b.n as number)) : rawPages;

  // Revision: map each returned page to a target page (by n, else by order when counts match).
  const assignments = new Map<Record<string, unknown>, Page>();
  if (targets) {
    const byN = new Map(targets.map((t) => [t.n, t]));
    const used = new Set<string>();
    for (const raw of ordered) {
      const t = byN.get(raw.n as number);
      if (t && !used.has(t.id)) {
        assignments.set(raw, t);
        used.add(t.id);
      }
    }
    if (!assignments.size && ordered.length === targets.length) ordered.forEach((raw, i) => assignments.set(raw, targets[i]));
    const missing = targets.filter((t) => ![...assignments.values()].includes(t));
    if (missing.length) problems.push(`Return the rewritten page${missing.length > 1 ? 's' : ''} ${missing.map((t) => t.n).join(', ')} (with n set to the page number).`);
  }

  const speakingPanels = new Map<string, number>();
  const pages: Page[] = [];
  const meter = planMeter(doc);
  const layoutFixes = new Map<string, LayoutFix>();
  for (const raw of ordered) {
    const target = targets ? assignments.get(raw) : undefined;
    if (targets && !target) continue;
    const label = `Page ${target?.n ?? (Number.isInteger(raw.n) ? raw.n : pages.length + 1)}`;
    const rawPanels = asArray(raw.panels).filter(isObject);
    if (rawPanels.length > MAX_PANELS_PER_PAGE) problems.push(`${label} has ${rawPanels.length} panels; use at most ${MAX_PANELS_PER_PAGE}.`);
    const panels: Panel[] = [];
    for (const rp of rawPanels.slice(0, MAX_PANELS_PER_PAGE)) {
      const castIds: string[] = [];
      for (const token of asArray(rp.castIds)) {
        const id = typeof token === 'string' ? resolver.resolve(token, true) : undefined;
        if (id && !castIds.includes(id)) castIds.push(id);
      }
      const action = clean(rp.action);
      const shot = normalizeShot(rp.shot);
      const lines: Line[] = [];
      for (const rl of asArray(rp.lines).filter(isObject)) {
        const speakerToken = clean(rl.speakerId);
        let speakerId = speakerToken ? resolver.resolve(speakerToken, true, { speaker: true }) : undefined;
        const kind = normalizeKind(rl.kind, !!speakerId);
        if (!SPOKEN_KINDS.has(kind)) speakerId = undefined;
        else if (!speakerId && castIds.length === 1) speakerId = castIds[0];
        const text = cleanLineText(rl.text, nameOf(speakerId));
        if (!text) continue;
        // Speakers are visible — except a voice heard off-panel in a pov, insert or establishing shot (§3 C6).
        if (speakerId && !castIds.includes(speakerId) && !OFF_PANEL_SHOTS.has(shot)) castIds.push(speakerId);
        lines.push({ id: newId('ln'), kind, text, ...(speakerId ? { speakerId } : {}) });
      }
      if (!action && !lines.length) continue;
      if (!action) problems.push(`${label}, panel ${panels.length + 1} has no action.`);
      if (lines.length > MAX_LINES_PER_PANEL) problems.push(`${label}, panel ${panels.length + 1} has ${lines.length} lines; use at most 3 balloons.`);
      const keptLines = lines.slice(0, MAX_LINES_PER_PANEL);
      // Speaking panels count only where the speaker is drawn: an off-panel voice (pov/insert/establishing, not in
      // castIds) is heard, never drawn, so it never earns a model sheet by talking.
      for (const id of new Set(keptLines.map((l) => l.speakerId).filter((v): v is string => !!v && castIds.includes(v)))) {
        speakingPanels.set(id, (speakingPanels.get(id) || 0) + 1);
      }
      const placeToken = clean(rp.placeId);
      const placeId = placeToken ? placeIds.get(placeToken) || placeIds.get(normalizeName(placeToken)) : undefined;
      const angle = clean(rp.angle);
      const mood = clean(rp.mood);
      panels.push({
        id: newId('pn'),
        n: panels.length + 1,
        size: normalizeSize(rp.size),
        shot,
        ...(angle && !/^(none|n\/a|eye level|eye-level)$/i.test(angle) ? { angle } : {}),
        action,
        castIds,
        ...(placeId ? { placeId } : {}),
        ...(mood ? { mood } : {}),
        lines: keptLines
      });
    }
    if (!panels.length) {
      problems.push(`${label} has no panels.`);
      continue;
    }
    // The writer's blueprint is the page design: when it accounts for every panel, panel
    // sizes are aligned to it; otherwise a blueprint is synthesized from the sizes.
    const rawLayout = clean(raw.layout);
    const parsed = rawLayout ? parseLayout(rawLayout) : null;
    const blueprintFits =
      !!parsed && layoutPanelCount(parsed) === panels.length && (doc.format.kind !== 'webtoon' || parsed.mode === 'stack');
    const sized = blueprintFits ? harmonizePanelSizes(panels, parsed!, doc.format.readingDirection === 'rtl') : panels;
    const finalPanels = reuseIds(target, sized);
    const page: Page = {
      id: target?.id || newId('pg'),
      n: target?.n || pages.length + 1,
      summary: clean(raw.summary),
      layout: '',
      ...(clean(raw.turnHook) ? { turnHook: clean(raw.turnHook) } : {}),
      panels: finalPanels,
      render: emptyRender(),
      balloons: []
    };
    page.layout = effectiveLayout({ ...page, layout: rawLayout }, doc.format);
    // A revised page is checked against its own earlier count where the storybook clamp would cut it (PD-2).
    const fitted = fitPage(doc, page, meter, target?.panels.length);
    problems.push(...fitted.problems);
    if (fitted.fix) layoutFixes.set(fitted.page.id, fitted.fix);
    pages.push(fitted.page);
  }

  if (!pages.length) return { problems: problems.length ? problems : ['No usable pages were returned.'] };
  // Splash spacing across the book (a revision is checked against the pages it sits between).
  const returned = new Set(pages.map((p) => p.id));
  const book = targets ? [...doc.pages.filter((p) => !returned.has(p.id)), ...pages] : pages;
  problems.push(...splashIssues(doc, book).filter((s) => returned.has(s.pageId)).map((s) => s.issue.text));
  problems.push(...ratingProblems(pages, ctx.rating ?? effectiveRating(doc).rating));
  if (!targets && pages.length !== ctx.pageCount) {
    problems.push(`Return exactly ${ctx.pageCount} page${ctx.pageCount > 1 ? 's' : ''} (you returned ${pages.length}).`);
  }

  // New characters: keep only the ones actually used; promote frequent speakers and recurring extras
  // (on ≥ 2 pages and in ≥ 3 panels: they get a model sheet, so they stay on model from page to page).
  const used = new Set(pages.flatMap((p) => p.panels.flatMap((panel) => [...panel.castIds, ...panel.lines.map((l) => l.speakerId || '')])));
  const presence = new Map<string, { panels: number; pages: Set<string> }>();
  for (const page of pages) {
    for (const panel of page.panels) {
      for (const id of new Set(panel.castIds)) {
        const seen = presence.get(id) ?? { panels: 0, pages: new Set<string>() };
        seen.panels += 1;
        seen.pages.add(page.id);
        presence.set(id, seen);
      }
    }
  }
  const actions = pages.flatMap((p) => p.panels.map((panel) => panel.action));
  const newCast: Character[] = [];
  for (const draft of resolver.drafts.values()) {
    if (!used.has(draft.id)) continue;
    const { auto, ...character } = draft;
    const speaks = speakingPanels.get(draft.id) || 0;
    const seen = presence.get(draft.id);
    const recurring = !!seen && seen.panels >= RECURRING.minPanels && seen.pages.size >= RECURRING.minPages;
    if (character.tier === 'extra' && (speaks >= 3 || recurring)) character.tier = 'support';
    if (auto && !character.look.summary) {
      for (const action of actions) {
        const hit = mentionSentence(action, character.name);
        if (hit) {
          character.look = { summary: hit };
          break;
        }
      }
    }
    newCast.push(character);
  }
  return { value: { pages, newCast, layoutFixes }, problems };
};

/** Make a full plan exactly `target` pages long: split the densest pages, merge the sparsest neighbors. */
export const enforcePageCount = (pages: Page[], target: number, doc: ComicDoc): Page[] => {
  const out = pages.map((p) => ({ ...p, panels: [...p.panels] }));
  const relayout = (page: Page): Page => {
    const panels = page.panels.map((panel, i) => ({ ...panel, n: i + 1 }));
    return { ...page, panels, layout: synthesizeLayout(panels, doc.format) };
  };
  while (out.length < target) {
    let best = -1;
    out.forEach((p, i) => {
      if (p.panels.length >= 2 && (best < 0 || p.panels.length > out[best].panels.length)) best = i;
    });
    if (best < 0) break; // nothing left to split — never invent content
    const page = out[best];
    const cut = Math.ceil(page.panels.length / 2);
    const first = relayout({ ...page, panels: page.panels.slice(0, cut), turnHook: undefined });
    const second = relayout({ ...page, id: newId('pg'), panels: page.panels.slice(cut), summary: page.summary ? `${page.summary} (continued)` : '' });
    out.splice(best, 1, first, second);
  }
  while (out.length > target && out.length > 1) {
    let best = -1;
    for (let i = 0; i < out.length - 1; i += 1) {
      const size = out[i].panels.length + out[i + 1].panels.length;
      if (size <= MAX_PANELS_PER_PAGE && (best < 0 || size < out[best].panels.length + out[best + 1].panels.length)) best = i;
    }
    if (best >= 0) {
      const a = out[best];
      const b = out[best + 1];
      const merged = relayout({
        ...a,
        summary: [clean(a.summary), clean(b.summary)].filter(Boolean).join(' '),
        turnHook: b.turnHook,
        panels: [...a.panels, ...b.panels]
      });
      out.splice(best, 2, merged);
      continue;
    }
    // Nothing mergeable: drop the lightest middle page (keep the opening and the ending).
    const weight = (p: Page) => p.panels.length + p.panels.reduce((n, panel) => n + panel.lines.length, 0);
    let drop = out.length > 2 ? 1 : out.length - 1;
    for (let i = 1; i < out.length - 1; i += 1) if (weight(out[i]) < weight(out[drop])) drop = i;
    out.splice(drop, 1);
  }
  return out.map((p, i) => ({ ...p, n: i + 1 }));
};

// ── Long plans: outline first, then pages in chunks ──────────────────────────
//
// The writer role is a non-streaming strict-JSON call with a fixed timeout, so one call
// can only write about SINGLE_CALL_PAGES full pages reliably. Longer plans get a fast
// outline call (one entry per page) and then CHUNK_PAGES-page chunks written against that
// binding outline (a few in parallel). All chunk outputs are normalized together, so new
// characters are shared and de-duplicated across chunks.

export const SINGLE_CALL_PAGES = 6;
export const CHUNK_PAGES = 5;
const CHUNK_CONCURRENCY = 3;

const OUTLINE_SCHEMA = obj({
  pages: {
    type: 'array',
    items: obj({ n: { type: 'integer' }, summary: str, turnHook: str, characters: strArray, place: str })
  },
  newCast: (PAGE_PLAN_SCHEMA.properties as Record<string, unknown>).newCast
});

interface RawPlan {
  pages: Record<string, unknown>[];
  newCast: Record<string, unknown>[];
}

interface OutlineResult {
  pages: OutlinePage[];
  newCast: Record<string, unknown>[];
}

const normalizeOutline = (json: unknown, pageCount: number): StructuredCheck<OutlineResult> => {
  if (!isObject(json) || !Array.isArray(json.pages)) return { problems: ['The reply must be a JSON object with a "pages" array.'] };
  const pages = json.pages
    .filter(isObject)
    .map((p) => ({
      n: 0,
      summary: clean(p.summary),
      turnHook: clean(p.turnHook),
      characters: asArray(p.characters).map(clean).filter(Boolean),
      place: clean(p.place)
    }))
    .filter((p) => p.summary)
    .map((p, i) => ({ ...p, n: i + 1 }));
  if (!pages.length) return { problems: ['The outline has no pages with a summary.'] };
  const problems = pages.length === pageCount ? [] : [`The outline must have exactly ${pageCount} pages (you returned ${pages.length}).`];
  return { value: { pages, newCast: asArray(json.newCast).filter(isObject) }, problems };
};

/** Pad/trim an outline to exactly `count` entries (merging the tail, or noting continuation). */
const fitOutline = (outline: OutlinePage[], count: number): OutlinePage[] => {
  const out = outline.map((o) => ({ ...o, characters: [...o.characters] }));
  while (out.length > count) {
    const last = out.pop()!;
    const prev = out[out.length - 1];
    prev.summary = `${prev.summary} ${last.summary}`.trim();
    prev.turnHook = last.turnHook || prev.turnHook;
    prev.characters = [...new Set([...prev.characters, ...last.characters])];
  }
  // Stretch the densest beats rather than invent new ones.
  let i = 0;
  while (out.length < count && out.length) {
    const src = out[i % out.length];
    out.splice((i % out.length) + 1, 0, { ...src, summary: `${src.summary} (continued — let this beat breathe)`, characters: [...src.characters] });
    i += 2;
  }
  return out.map((o, k) => ({ ...o, n: k + 1 }));
};

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Map with a concurrency limit; rejects with the first error (after in-flight work settles). */
const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        if (failure === undefined) failure = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure;
  return results;
};

/** Raw pages of a reply in reading order (by n when the numbering is clean). */
const orderedRawPages = (json: Record<string, unknown>): Record<string, unknown>[] => {
  const raw = asArray(json.pages).filter(isObject);
  const numbered = raw.every((p) => Number.isInteger(p.n)) && new Set(raw.map((p) => p.n)).size === raw.length;
  return numbered ? [...raw].sort((a, b) => (a.n as number) - (b.n as number)) : raw;
};

/** For a revision chunk: give each returned page the n of the target it answers. */
const alignToTargets = (pages: Record<string, unknown>[], targets: Page[]): Record<string, unknown>[] => {
  const wanted = new Set(targets.map((t) => t.n));
  if (pages.some((p) => wanted.has(p.n as number))) return pages.filter((p) => wanted.has(p.n as number));
  return pages.length === targets.length ? pages.map((p, i) => ({ ...p, n: targets[i].n })) : [];
};

/**
 * Write (or rewrite) the page plan. Full plan: exactly format.pageCount pages with fresh
 * ids (long plans are outlined first, then written in chunks). With pageIds: only those
 * pages are rewritten (the rest are sent as fixed context) and returned with their
 * ORIGINAL ids and numbers; unchanged panels/lines keep their ids so overlay balloons
 * survive mergeRevisedPages().
 */
export async function writePagePlan(args: {
  doc: ComicDoc;
  llm: LlmClient;
  instructions?: string;
  pageIds?: string[];
  signal?: AbortSignal;
  /** Effective content rating (ctx.rating); default effectiveRating(doc). */
  rating?: ContentRating;
}): Promise<{
  pages: Page[];
  newCast: Character[];
  costUsd?: number;
  model: string;
  /** Plain notes for the plan card (present only when there is something to say): layouts the validator
   *  re-chose so the words fit, and the storybook panel clamp. */
  notes?: string[];
}> {
  const { doc } = args;
  const rating = args.rating ?? effectiveRating(doc).rating;
  const revising = Array.isArray(args.pageIds) && args.pageIds.length > 0;
  const targets = revising ? doc.pages.filter((p) => args.pageIds!.includes(p.id)).sort((a, b) => a.n - b.n) : null;
  if (revising && !targets!.length) throw new StudioError('BAD_REQUEST', 'Those pages are no longer in the plan.', { status: 400 });
  const pageCount = clamp(Math.round(doc.format.pageCount || 1), 1, MAX_PAGES);
  const system = writerSystemPrompt(doc, rating);
  const failure = "The writer couldn't produce a usable page plan this time. Please try again.";
  let costUsd: number | undefined;
  let model = '';
  const track = (r: { costUsd?: number; model: string }) => {
    costUsd = addCost(costUsd, r.costUsd);
    model = model || r.model;
  };

  let normalized: NormalizedPlan;
  const pagesToWrite = targets ? targets.length : pageCount;
  if (pagesToWrite <= SINGLE_CALL_PAGES) {
    const result = await completeStructured<NormalizedPlan>({
      llm: args.llm,
      role: 'writer',
      system,
      user: writerUserMessage(doc, { instructions: args.instructions, targets }),
      schemaName: 'comic_page_plan',
      schema: PAGE_PLAN_SCHEMA,
      validate: (json) => normalizePlan(json, { doc, targets, pageCount, rating }),
      failure,
      temperature: 0.7,
      maxTokens: 2_500 + pagesToWrite * 1_400,
      signal: args.signal
    });
    track(result);
    normalized = result.value;
  } else if (targets) {
    // Many pages to revise: rewrite them in chunks, each with everything else as context.
    const parts = await mapLimit(chunk(targets, CHUNK_PAGES), CHUNK_CONCURRENCY, async (group) => {
      const result = await completeStructured<RawPlan>({
        llm: args.llm,
        role: 'writer',
        system,
        user: writerUserMessage(doc, { instructions: args.instructions, targets: group }),
        schemaName: 'comic_page_plan',
        schema: PAGE_PLAN_SCHEMA,
        validate: (json) => {
          const check = normalizePlan(json, { doc, targets: group, pageCount, rating });
          if (!check.value || !isObject(json)) return { problems: check.problems };
          return { value: { pages: alignToTargets(orderedRawPages(json), group), newCast: asArray(json.newCast).filter(isObject) }, problems: check.problems };
        },
        failure,
        temperature: 0.7,
        maxTokens: 2_500 + group.length * 1_400,
        signal: args.signal
      });
      track(result);
      return result.value;
    });
    const combined = { pages: parts.flatMap((p) => p.pages), newCast: parts.flatMap((p) => p.newCast) };
    const check = normalizePlan(combined, { doc, targets, pageCount, rating });
    if (!check.value) throw new StudioError('PROVIDER_ERROR', failure, { status: 502, retryable: true });
    normalized = check.value;
  } else {
    // Long plan: a binding outline first, then the pages in parallel chunks.
    const outlineResult = await completeStructured<OutlineResult>({
      llm: args.llm,
      role: 'writer',
      system,
      user: writerUserMessage(doc, {
        instructions: args.instructions,
        task:
          `Step 1 of 2 — OUTLINE ONLY. Pace the whole story across exactly ${pageCount} pages and return one entry per page (n = 1 to ${pageCount}): ` +
          'summary = the page\'s beats in order (2–3 sentences), turnHook, characters = names of the named characters on the page, place = where it happens. ' +
          'Introduce any new named character in newCast with a full look. Panels and dialogue are written in step 2.'
      }),
      schemaName: 'comic_page_outline',
      schema: OUTLINE_SCHEMA,
      validate: (json) => normalizeOutline(json, pageCount),
      failure,
      temperature: 0.7,
      maxTokens: 2_000 + pageCount * 220,
      signal: args.signal
    });
    track(outlineResult);
    const outline = fitOutline(outlineResult.value.pages, pageCount);
    const outlineCast = outlineResult.value.newCast
      .filter((c) => clean(c.name))
      .map((c) => ({ name: clean(c.name), role: clean(c.role), look: isObject(c.look) ? clean(c.look.summary) : '' }));
    const groups = chunk(outline, CHUNK_PAGES);
    const parts = await mapLimit(groups, CHUNK_CONCURRENCY, async (group) => {
      const from = group[0].n;
      const to = group[group.length - 1].n;
      const result = await completeStructured<RawPlan>({
        llm: args.llm,
        role: 'writer',
        system,
        user: writerUserMessage(doc, {
          instructions: args.instructions,
          outline,
          outlineCast,
          task:
            `Step 2 of 2 — write pages ${from}–${to} in full (panels, layout, dialogue), following the outline for those pages exactly ` +
            `and keeping continuity with the pages around them. Return exactly ${group.length} page${group.length > 1 ? 's' : ''}, n = ${from} to ${to}.`
        }),
        schemaName: 'comic_page_plan',
        schema: PAGE_PLAN_SCHEMA,
        validate: (json) => {
          const check = normalizePlan(json, { doc, targets: null, pageCount: group.length, rating });
          if (!check.value || !isObject(json)) return { problems: check.problems };
          return { value: { pages: orderedRawPages(json), newCast: asArray(json.newCast).filter(isObject) }, problems: check.problems };
        },
        failure: `The writer couldn't produce pages ${from}–${to} this time. Please try again.`,
        temperature: 0.7,
        maxTokens: 2_500 + group.length * 1_400,
        signal: args.signal
      });
      track(result);
      return result.value;
    });
    const combined = {
      pages: parts.flatMap((p) => p.pages).map((p, i) => ({ ...p, n: i + 1 })),
      newCast: [...outlineResult.value.newCast, ...parts.flatMap((p) => p.newCast)]
    };
    const check = normalizePlan(combined, { doc, targets: null, pageCount, rating });
    if (!check.value) throw new StudioError('PROVIDER_ERROR', failure, { status: 502, retryable: true });
    normalized = check.value;
  }

  const softened = softenPlanPages(targets ? normalized.pages : enforcePageCount(normalized.pages, pageCount, doc), rating);
  // Pages that page-count enforcement re-made get the same free fit pass (never another writer call).
  const meter = planMeter(doc);
  const fixes = new Map(normalized.layoutFixes);
  const before = new Map((targets ?? []).map((t) => [t.id, t.panels.length]));
  const pages = softened.map((page) => {
    const prior = fixes.get(page.id);
    if (prior && prior.layout === page.layout) return page;
    fixes.delete(page.id);
    const fitted = fitPage(doc, page, meter, before.get(page.id));
    if (fitted.fix) fixes.set(page.id, fitted.fix);
    return fitted.page;
  });
  // The storybook clamp note is about new pages: only a full plan states it (revised pages keep their count).
  const countNote = revising ? undefined : panelCountNote(doc.format);
  const notes = [
    ...(countNote ? [countNote] : []),
    ...pages.filter((p) => fixes.has(p.id)).map((p) => layoutFixNote(p, fixes.get(p.id)!))
  ];
  // Drop new characters that page-count enforcement removed from every page.
  const stillUsed = new Set(pages.flatMap((p) => p.panels.flatMap((panel) => [...panel.castIds, ...panel.lines.map((l) => l.speakerId || '')])));
  return {
    pages,
    newCast: normalized.newCast.filter((c) => stillUsed.has(c.id)),
    ...(costUsd !== undefined ? { costUsd } : {}),
    model,
    ...(notes.length ? { notes } : {})
  };
}

/**
 * Replace revised pages by id. The old page's render state is kept (its specHash no longer
 * matches, so the job runner/UI shows it as stale instead of wiping it), and only balloons
 * whose lines still exist survive.
 */
export const mergeRevisedPages = (oldPages: Page[], revised: Page[]): Page[] => {
  const byId = new Map(revised.map((p) => [p.id, p]));
  return oldPages.map((old) => {
    const next = byId.get(old.id);
    if (!next) return old;
    const lineIds = new Set(next.panels.flatMap((p) => p.lines.map((l) => l.id)));
    return { ...next, n: old.n, render: old.render, balloons: old.balloons.filter((b) => lineIds.has(b.lineId)) };
  });
};

// ── Source analysis ──────────────────────────────────────────────────────────

export interface SourceAnalysis {
  brief: Partial<Brief>;
  cast: Array<{ name: string; role?: string; tier: CastTier; look: CharacterLook; personality?: string; voice?: string; kind?: CastKind; count?: number }>;
  places: Array<{ name: string; look: string }>;
  suggestedPageCount?: number;
  styleHint?: string;
  costUsd?: number;
  model: string;
}

const ANALYSIS_SCHEMA = obj({
  brief: obj({
    title: str,
    logline: str,
    premise: str,
    genre: str,
    tone: str,
    audience: str,
    setting: str,
    themes: strArray,
    notes: strArray
  }),
  cast: {
    type: 'array',
    items: obj({ name: str, role: str, tier: { type: 'string', enum: CAST_TIERS }, kind: KIND_SCHEMA, count: { type: 'integer' }, look: LOOK_SCHEMA, personality: str, voice: str })
  },
  places: { type: 'array', items: obj({ name: str, look: str }) },
  suggestedPageCount: { type: 'integer' },
  styleHint: str
});

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

/**
 * Length heuristic for a page count: a comic script's own PAGE breaks when it has them,
 * else ~1 page per 200 words of prose (150–250 by density), clamped 1–40.
 */
export const estimatePageCount = (text: string): number => {
  const pages = new Set<number>();
  const re = /^\s*(?:#+\s*)?page\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) pages.add(/^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()]);
  if (pages.size >= 1) return clamp(pages.size, 1, MAX_PAGES);
  const words = wordCount(text);
  // Dialogue-dense text reads faster per page than descriptive prose.
  const dialogueLines = (text.match(/^[A-Z][A-Za-z .'-]{1,30}:\s+\S/gm) || []).length;
  const perPage = dialogueLines > words / 60 ? 230 : 190;
  return clamp(Math.round(words / perPage) || 1, 1, MAX_PAGES);
};

const ANALYSIS_SYSTEM = [
  'You are a comics editor preparing an adaptation. Read the author\'s material — a script, a story or loose notes — and extract what the studio needs to start: the brief, the cast, the places, a page-count suggestion and a style hint.',
  '',
  'RULES',
  '- Extract; never invent. Use only what the text states or strongly implies ("the old fisherman" implies an elderly man). When the text gives nothing for a field, use "" (or [] for lists). Never make up eye colors, outfits, ages, names or plot.',
  '- title: the work\'s title if stated, else a short evocative working title (2–5 words) drawn from the text.',
  '- logline: one sentence (≤ 30 words): protagonist, goal, obstacle. premise: 2–4 sentences covering the setup and the central conflict.',
  '- genre, tone, audience ("children", "teens", "adults", "all ages" — only when implied; "children" for toddler or picture-book material), setting (time and place).',
  '- themes: up to 4 short phrases. notes: explicit wishes or constraints stated in the text ("ends on a cliffhanger", "no gore").',
  '- cast: every named character who appears or speaks, plus unnamed roles that recur ("the Captain") — including recurring animals, creatures, robots, toys, vehicles and key props (descriptive name like "Ducklings"; kind; count 2–12 for a group, else 1; kind "person" for people). tier: lead = the protagonist(s) (1–2), support = recurring characters with real scenes, extra = walk-ons. Most important first.',
  '- look: summary = one dense visual sentence an artist could draw from, built ONLY from stated or implied details ("" when the text describes nothing visual). Fill age, gender, build, face, hair, eyes, skin, outfit, palette (their colors), props and marks (scars, tattoos, signature items) only where stated or strongly implied, else "".',
  '- personality: 1 sentence from how they act. voice: how they talk (diction, rhythm, catchphrases), from their dialogue.',
  '- places: recurring or important locations, with a short visual description drawn from the text ("" when nothing is described).',
  '- suggestedPageCount: about 1 comic page per 150–250 words of prose (denser action → more pages), or one per page of a comic script; 1–40. A length heuristic is given — follow it unless the material clearly needs otherwise.',
  '- styleHint: a short art-direction hint only when the text asks for or strongly implies a look ("noir black and white", "manga", "watercolor picture book"), else "".',
  '',
  'Reply with JSON only, matching the schema; every key is required.'
].join('\n');

const normalizeAnalysis = (json: unknown): StructuredCheck<Omit<SourceAnalysis, 'costUsd' | 'model'>> => {
  if (!isObject(json)) return { problems: ['The reply must be a JSON object.'] };
  const problems: string[] = [];
  if (!isObject(json.brief)) problems.push('"brief" must be an object.');
  if (!Array.isArray(json.cast)) problems.push('"cast" must be an array.');
  const rawBrief = isObject(json.brief) ? json.brief : {};
  const brief: Partial<Brief> = {};
  for (const key of ['title', 'logline', 'premise', 'genre', 'tone', 'audience', 'setting'] as const) {
    const v = clean(rawBrief[key]);
    if (v) brief[key] = v;
  }
  const themes = asArray(rawBrief.themes).map(clean).filter(Boolean).slice(0, 6);
  if (themes.length) brief.themes = themes;
  const notes = asArray(rawBrief.notes).map(clean).filter(Boolean).slice(0, 12);
  if (notes.length) brief.notes = notes;

  const seen = new Set<string>();
  const cast: SourceAnalysis['cast'] = [];
  for (const raw of asArray(json.cast).filter(isObject)) {
    const name = clean(raw.name);
    const key = normalizeName(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    const kind = castKindOf(raw.kind);
    const count = groupCountOf(raw.count);
    cast.push({
      name,
      tier: CAST_TIERS.includes(raw.tier as CastTier) ? (raw.tier as CastTier) : 'support',
      look: cleanLook(raw.look),
      ...(kind && kind !== 'person' ? { kind } : {}),
      ...(count ? { count } : {}),
      ...(clean(raw.role) ? { role: clean(raw.role) } : {}),
      ...(clean(raw.personality) ? { personality: clean(raw.personality) } : {}),
      ...(clean(raw.voice) ? { voice: clean(raw.voice) } : {})
    });
  }
  if (cast.length && !cast.some((c) => c.tier === 'lead')) cast[0].tier = 'lead';

  const placeNames = new Set<string>();
  const places: SourceAnalysis['places'] = [];
  for (const raw of asArray(json.places).filter(isObject)) {
    const name = clean(raw.name);
    if (!name || placeNames.has(name.toLowerCase())) continue;
    placeNames.add(name.toLowerCase());
    places.push({ name, look: clean(raw.look) });
  }

  const count = typeof json.suggestedPageCount === 'number' && Number.isFinite(json.suggestedPageCount) ? Math.round(json.suggestedPageCount) : undefined;
  const styleHint = clean(json.styleHint);
  if (!Object.keys(brief).length && !cast.length) return { problems: problems.length ? problems : ['Nothing was extracted.'] };
  return {
    value: {
      brief,
      cast,
      places,
      ...(count && count > 0 ? { suggestedPageCount: clamp(count, 1, MAX_PAGES) } : {}),
      ...(styleHint ? { styleHint } : {})
    },
    problems
  };
};

/** Extract brief, cast (with drawable looks), places, a page count and a style hint from pasted material. */
export async function analyzeSource(args: { doc: ComicDoc; llm: LlmClient; text: string; signal?: AbortSignal }): Promise<SourceAnalysis> {
  const source = (args.text || '').trim();
  if (!source) throw new StudioError('BAD_REQUEST', 'Paste a script, story or notes first.', { status: 400 });
  const heuristic = estimatePageCount(source);
  const scriptPages = /^\s*(?:#+\s*)?page\s+(\d+|one|two|three)\b/im.test(source);
  const { text, truncated, omitted } = truncateMiddle(source, ANALYSIS_SOURCE_LIMIT);
  const known = args.doc.cast.map((c) => clean(c.name)).filter(Boolean);
  const user = [
    `LENGTH: ${wordCount(source).toLocaleString('en-US')} words${scriptPages ? ` — a comic script with ${heuristic} page break${heuristic > 1 ? 's' : ''}` : ''} (length heuristic: about ${heuristic} page${heuristic > 1 ? 's' : ''}).`,
    known.length ? `ALREADY IN THE CAST: ${known.join(', ')} — include them again if they appear, with any details the text adds.` : '',
    `TEXT${truncated ? ` [${omitted.toLocaleString('en-US')} characters omitted from the middle]` : ''}:\n<<<\n${text}\n>>>`
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await completeStructured({
    llm: args.llm,
    role: 'writer',
    system: ANALYSIS_SYSTEM,
    user,
    schemaName: 'comic_source_analysis',
    schema: ANALYSIS_SCHEMA,
    validate: normalizeAnalysis,
    failure: "I couldn't read that material into a brief this time. Please try again.",
    temperature: 0.2,
    maxTokens: 8_000,
    signal: args.signal
  });
  const value = result.value;
  // An explicit comic script's own page breaks beat any estimate.
  const suggestedPageCount = scriptPages ? heuristic : value.suggestedPageCount ?? heuristic;
  return {
    ...value,
    suggestedPageCount,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    model: result.model
  };
}

// ── Style directions ─────────────────────────────────────────────────────────

const STYLE_SCHEMA = obj({ options: { type: 'array', items: obj({ name: str, spec: str }) } });

const wordSet = (text: string) => new Set((clean(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []));
const similarity = (a: string, b: string): number => {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
};

/** Presets ranked by fit to the story (kind, genre/tone/audience tags, color mode). */
export const rankStylePresets = (doc: ComicDoc): StylePreset[] => {
  const story = [doc.brief.genre, doc.brief.tone, doc.brief.audience, doc.brief.premise, doc.brief.logline, ...(doc.brief.notes || [])]
    .map(clean)
    .join(' ')
    .toLowerCase();
  const score = (p: StylePreset) => {
    let s = 0;
    if (p.kind && p.kind === doc.format.kind) s += 3;
    for (const tag of p.bestFor) if (story.includes(tag.toLowerCase())) s += 2;
    if (doc.format.colorMode === 'bw') s += p.colorMode === 'bw' ? 3 : -4;
    else if (p.colorMode === 'bw') s -= 2;
    if (doc.format.colorMode === 'limited' && p.colorMode === 'limited') s += 2;
    return s;
  };
  return [...STYLE_PRESETS].sort((a, b) => score(b) - score(a));
};

const STYLE_ANGLES = [
  'faithful to the best tradition of this genre and format',
  'bold or unexpected, yet still right for this story',
  'minimal and graphic — strong shapes, restrained palette, lots of clarity',
  'painterly and atmospheric',
  'a retro print or vintage-medium take',
  'a contemporary indie or experimental take'
];

const styleSystemPrompt = (doc: ComicDoc, count: number): string => {
  const examples = rankStylePresets(doc).slice(0, 3);
  const color =
    doc.format.colorMode === 'bw'
      ? 'The comic is BLACK AND WHITE: every direction must be black and white (grey tones, hatching or screentone allowed — no color).'
      : doc.format.colorMode === 'limited'
        ? 'The comic uses a LIMITED palette: every direction names its 2–4 ink colors.'
        : 'The comic is in full color unless a direction is deliberately limited-palette.';
  return [
    `You are a comics art director. Propose ${count} distinct art direction${count > 1 ? 's' : ''} for this story.`,
    '',
    'Each spec is executable art direction a page-rendering model can follow: the medium and rendering technique; linework (weight, texture); color (palette and how it is applied) or the black-and-white treatment; shading and lighting; 1–2 influences described as visible traits (not just names); and what to avoid. 35–80 words each, concrete and drawable — never vague words like "beautiful", "stunning" or "comic style".',
    `Make them genuinely different from one another. Angles, in order: ${STYLE_ANGLES.slice(0, count).map((a, i) => `${i + 1}) ${a}`).join('; ')}.`,
    color,
    'Fit the story\'s genre, tone and audience (children\'s stories: friendly shapes, nothing gory).',
    'name: 2–4 words, evocative and specific.',
    '',
    'These presets show the level of concreteness expected. Do not copy them; write directions specific to this story:',
    ...examples.map((p) => `- ${p.name}: ${p.spec}`),
    '',
    'Reply with JSON only, matching the schema.'
  ].join('\n');
};

const styleUserMessage = (doc: ComicDoc): string => {
  const b = doc.brief;
  const lead = doc.cast.filter((c) => c.tier === 'lead').slice(0, 2);
  return [
    `STORY\n${compactJson({
      title: clean(b.title),
      logline: clean(b.logline),
      premise: clip(clean(b.premise), 600),
      genre: clean(b.genre),
      tone: clean(b.tone),
      audience: clean(b.audience),
      setting: clean(b.setting),
      notes: b.notes
    })}`,
    `FORMAT\n${compactJson({ kind: doc.format.kind, colorMode: doc.format.colorMode, readingDirection: doc.format.readingDirection })}`,
    lead.length ? `LEADS\n${lead.map((c) => `${clean(c.name)}: ${lookLine(c) || '(no look yet)'}`).join('\n')}` : '',
    clean(doc.style.spec) ? `THE AUTHOR'S STYLE WISHES SO FAR\n${clip(clean(doc.style.spec), 600)}` : '',
    doc.style.refs.length ? `The author uploaded ${doc.style.refs.length} style reference image${doc.style.refs.length > 1 ? 's' : ''} (not shown); keep one direction close to a classic, flexible look.` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
};

const normalizeStyleOptions = (json: unknown, count: number): StructuredCheck<{ name: string; spec: string }[]> => {
  if (!isObject(json) || !Array.isArray(json.options)) return { problems: ['The reply must be a JSON object with an "options" array.'] };
  const problems: string[] = [];
  const valid: { name: string; spec: string }[] = [];
  json.options.filter(isObject).forEach((raw, i) => {
    const name = clean(raw.name);
    const spec = clean(raw.spec);
    const label = `Option ${i + 1}${name ? ` ("${name}")` : ''}`;
    if (!name || !spec) {
      problems.push(`${label} needs both a name and a spec.`);
      return;
    }
    if (wordCount(spec) < MIN_STYLE_SPEC_WORDS) {
      problems.push(`${label} spec has ${wordCount(spec)} words; write at least ${MIN_STYLE_SPEC_WORDS} words of concrete art direction.`);
      return;
    }
    if (valid.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
      problems.push(`${label} repeats a name; every option needs its own name.`);
      return;
    }
    if (valid.some((v) => similarity(v.spec, spec) >= 0.5)) {
      problems.push(`${label} is too similar to another option; make each direction genuinely different.`);
      return;
    }
    const copied = STYLE_PRESETS.find((p) => similarity(p.spec, spec) >= 0.6);
    if (copied) {
      problems.push(`${label} copies the "${copied.name}" example; write a direction specific to this story.`);
      return;
    }
    valid.push({ name: clip(name, 48), spec });
  });
  if (valid.length < count) problems.push(`Return ${count} valid options (only ${valid.length} usable).`);
  return valid.length ? { value: valid.slice(0, count), problems } : { problems };
};

/**
 * N distinct, story-appropriate art directions ({name, spec}). Informed by the presets but
 * never copies of them; when the model returns fewer usable options than asked after the
 * repair round, the best-fitting presets fill the remaining slots.
 */
export async function proposeStyleDirections(args: {
  doc: ComicDoc;
  llm: LlmClient;
  count: number;
  signal?: AbortSignal;
}): Promise<{ options: { name: string; spec: string }[]; costUsd?: number; model: string }> {
  const count = clamp(Math.round(args.count || 3), 1, 6);
  const result = await completeStructured({
    llm: args.llm,
    role: 'writer',
    system: styleSystemPrompt(args.doc, count),
    user: styleUserMessage(args.doc),
    schemaName: 'comic_style_directions',
    schema: STYLE_SCHEMA,
    validate: (json) => normalizeStyleOptions(json, count),
    failure: "I couldn't come up with style directions this time. Please try again or pick a preset.",
    temperature: 0.9,
    maxTokens: 2_500,
    signal: args.signal
  });
  const options = [...result.value];
  for (const preset of rankStylePresets(args.doc)) {
    if (options.length >= count) break;
    if (options.some((o) => o.name.toLowerCase() === preset.name.toLowerCase() || similarity(o.spec, preset.spec) >= 0.5)) continue;
    options.push({ name: preset.name, spec: preset.spec });
  }
  return {
    options,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    model: result.model
  };
}
