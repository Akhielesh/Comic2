// The Ramayana golden case (PROGRAM5 P5-GOLD): loads the de-identified fixture, compiles it with the real compiler and
// offers small string checks for the compiled prompts. Pure: reads two JSON files next to the other server fixtures,
// never calls a model, never touches the network or a database. Used by ramayana.golden.test.ts and by every later
// quality package that flips one of its pinned faults.
//
// The fixture holds TEXT only (brief, format, style words, cast, places, pages, plan). It carries no image paths: a
// render that was drawn keeps only `status: 'ready'`, and loadRamayanaCase() gives each one a synthetic in-memory
// asset so the compiler attaches the same references (and so writes the same "(Image n — …)" anchors) as on the
// day the comic was drawn. Nothing here is ever written back.
//
// Never move these JSON files into golden/: golden.test.ts allows 3 to 5 render scripts there and run.ts (the paid
// renderer) renders every .json it finds in that folder.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDoc, type ComicDoc, type Page, type RenderState } from '../../../../shared/comic/doc.js';
import { compileCover, compileEdit, compilePage, type CompiledRenderJob } from '../prompts.js';

const here = dirname(fileURLToPath(import.meta.url));
export const RAMAYANA_FIXTURE_PATH = join(here, '..', '__fixtures__', 'ramayana-setu.doc.json');
export const RAMAYANA_EXPECTED_PATH = join(here, '..', '__fixtures__', 'ramayana-setu.expected.json');

/** The case's one id (the user, owner and project ids of the original were all replaced by it). */
export const RAMAYANA_CASE_ID = 'rama-setu';
/** Every timestamp in the fixture. */
export const RAMAYANA_FIXTURE_TIME = 1700000000000;

/** What the case measured on the day it was drawn, and the reply shapes the page check got back (see the file). */
export interface RamayanaExpected {
  case: string;
  /** Page n → the page its drawing really continued from (PREVIOUS PAGE), as recorded in the case. */
  previousPageAsDrawn: Record<string, number>;
  today: {
    sereneSmileHits: number;
    sereneSmilePrompts: number;
    paletteWordsSaffronCobalt: string;
    stylePaletteWords: string;
    coverCast: string[];
    page3WaitsFor: number;
    /** A good page: the stored heads, which the page check must keep (never "drop every head" as a fix). */
    page3HeadsAfterCheck: { x: number; y: number }[];
    page4HeadsAfterCheck: { x: number; y: number }[];
    page9HeadsAfterCheck: { x: number; y: number }[];
    /** The stored keepOut of pages 4 and 9 ([]): the rebuilt replies reproduce it. */
    page4And9KeepOutAfterCheck: unknown[];
    /** The page-9 check's issues and score on the day: Rama's name on the bridge stones read as stray text. */
    page9Issues: string[];
    page9Score: number;
    editPromptHead: string;
  };
  /** Vision replies rebuilt from the stored marks (see replyShapesNote: one guess, not a capture). */
  replyShapes: Record<'page3' | 'page4' | 'page9', Record<string, unknown>>;
  replyShapesNote: string;
  /** $0 colour measurements of the drawn pages (numbers only), the baseline later colour work is judged against. */
  colourBaseline: Record<string, unknown>;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** The fixture file as stored (no synthetic assets). */
export const readRamayanaFixture = (): Record<string, unknown> & { id: string } => readJson(RAMAYANA_FIXTURE_PATH);
export const readRamayanaExpected = (): RamayanaExpected => readJson(RAMAYANA_EXPECTED_PATH);

const LONG_SIDE = 2528;
/** The 2K pixel size the case's images had, from their aspect ("2:3" → 1696 × 2528). */
const sizeFor = (aspect?: string): { w: number; h: number } => {
  const m = /^(\d+):(\d+)$/.exec(aspect || '');
  const [a, b] = m ? [Number(m[1]), Number(m[2])] : [2, 3];
  return a >= b ? { w: LONG_SIDE, h: Math.round((LONG_SIDE * b) / a) } : { w: Math.round((LONG_SIDE * a) / b), h: LONG_SIDE };
};

/** A synthetic, in-memory stand-in for a drawn image. Never a real path, never stored. */
const hydrate = (render: RenderState | undefined, key: string): void => {
  if (!render || (render.status !== 'ready' && render.status !== 'stale') || render.asset) return;
  render.asset = { path: `golden:${RAMAYANA_CASE_ID}:${key}`, ...sizeFor(render.aspect), source: 'generated' } as RenderState['asset'];
};

/**
 * The case as the compiler sees it: the fixture, normalized, with a synthetic asset on every render that was drawn.
 * A fresh copy on every call, so a test may change it freely.
 */
export const loadRamayanaCase = (): ComicDoc => {
  const doc = normalizeDoc(readRamayanaFixture() as Parameters<typeof normalizeDoc>[0]);
  for (const c of doc.cast) hydrate(c.sheet, `sheet:${c.id}`);
  for (const p of doc.places) hydrate(p.sheet, `place:${p.id}`);
  for (const p of doc.pages) hydrate(p.render, `page:${p.id}`);
  hydrate(doc.cover.render, 'cover');
  return doc;
};

export const pageByN = (doc: ComicDoc, n: number): Page => {
  const page = doc.pages.find((p) => p.n === n);
  if (!page) throw new Error(`The Ramayana case has no page ${n}.`);
  return page;
};

/** The page each page's drawing continued from on the day (null for page 1), from the expected file. */
export const previousPageAsDrawn = (doc: ComicDoc, page: Page, expected = readRamayanaExpected()): Page | undefined => {
  const n = expected.previousPageAsDrawn[String(page.n)];
  return typeof n === 'number' ? pageByN(doc, n) : undefined;
};

/** Every page compiled as the case's run compiled it (each with the previous page it really used). */
export const compileCasePages = (doc: ComicDoc, opts: Parameters<typeof compilePage>[2] = {}): { n: number; job: CompiledRenderJob }[] => {
  const expected = readRamayanaExpected();
  return doc.pages.map((page) => {
    const previousPage = previousPageAsDrawn(doc, page, expected);
    return { n: page.n, job: compilePage(doc, page, { ...opts, ...(previousPage ? { previousPage } : {}) }) };
  });
};

/**
 * The ways the golden compiles the case. Every "must survive" check runs once per variant, so a quality flag can never
 * pass the golden by deleting what the owner wrote. A package that adds a compiler flag adds its flag-on variant here
 * (for example `{ label: 'COMIC_STORY_FIXES on', opts: <the compile options with that flag on> }`).
 */
export const CASE_COMPILE_VARIANTS: readonly { label: string; opts: Parameters<typeof compilePage>[2] }[] = [
  { label: 'flags off', opts: {} },
  { label: 'COMIC_STORY_FIXES on', opts: { storyFixes: true } }
];

export const compileCaseCover = (doc: ComicDoc): CompiledRenderJob => compileCover(doc, {});

/** The page-9 edit note stored on page 9 (the owner's request in tidied words: a complaint, not an instruction), against page 9's take. */
export const compileCaseEdit = (doc: ComicDoc): CompiledRenderJob => {
  const page = pageByN(doc, 9);
  const instruction = page.render.note || '';
  return compileEdit(doc, page, { instruction, hasRegion: false });
};

// ── String checks ────────────────────────────────────────────────────────────

/** How many times `needle` occurs in `text` (case-insensitive, non-overlapping). */
export const countOf = (text: string, needle: string): number => {
  if (!needle) return 0;
  const hay = text.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) count += 1;
  return count;
};

/** Throws, naming what is missing, unless `text` contains every needle (case-insensitive). */
export const mustContain = (text: string, ...needles: string[]): void => {
  const missing = needles.filter((n) => countOf(text, n) === 0);
  if (missing.length) throw new Error(`Expected the prompt to contain ${missing.map((m) => JSON.stringify(m)).join(', ')}.`);
};

/** Throws, quoting the first hit in context, if `text` contains any needle (case-insensitive). */
export const mustNotContain = (text: string, ...needles: string[]): void => {
  for (const n of needles) {
    const at = text.toLowerCase().indexOf(n.toLowerCase());
    if (at >= 0) throw new Error(`Expected no ${JSON.stringify(n)}, found: …${text.slice(Math.max(0, at - 60), at + n.length + 60)}…`);
  }
};

/**
 * The inside of every identity anchor in a prompt: the text between "(Image n — " and its closing parenthesis
 * (nested parentheses kept), e.g. "black topknot hairpiece, ayodhya yellow dhoti, serene calm smile".
 */
export const insideAnchors = (prompt: string): string[] => {
  const out: string[] = [];
  const open = /\(Image \d+ — /g;
  for (let m = open.exec(prompt); m; m = open.exec(prompt)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < prompt.length && depth > 0; i++) {
      if (prompt[i] === '(') depth += 1;
      else if (prompt[i] === ')') depth -= 1;
    }
    out.push(prompt.slice(start, depth === 0 ? i - 1 : i));
  }
  return out;
};

/** The prompt with the inside of every identity anchor removed: what the page says outside the cast cards. */
export const outsideAnchors = (prompt: string): string => {
  let out = prompt;
  for (const inside of insideAnchors(prompt)) out = out.replace(inside, '');
  return out;
};

/** Each panel's block of a page prompt ("PANEL k of n" up to the next panel or the page's closing rules), by panel number. */
export const panelBlocks = (prompt: string): Map<number, string> => {
  const out = new Map<number, string>();
  const parts = prompt.split(/\nPANEL (\d+) of \d+/);
  for (let i = 1; i + 1 < parts.length; i += 2) out.set(Number(parts[i]), parts[i + 1].split(/\nLETTERING:/)[0]);
  return out;
};

/** "close_up" → "close-up": a shot as the compiler writes it. */
const shotWords = (shot: string): string => shot.replace(/_/g, '-');

/**
 * What the owner wrote for each panel that must reach that panel's block of the page prompt, OUTSIDE the identity anchors:
 * its mood, every sentence of its action (positions such as "at his left shoulder" live there), its shot and its angle.
 * Returns one line per miss ([] when everything arrived). A fix for the fixed smile that strips "serene" or "calm" from
 * the whole prompt loses the panel's feeling and shows up here.
 */
export const panelDirectionMisses = (page: Page, prompt: string): string[] => {
  const blocks = panelBlocks(prompt);
  const misses: string[] = [];
  for (const panel of page.panels) {
    const block = outsideAnchors(blocks.get(panel.n) || '').toLowerCase();
    const want: [string, string][] = [];
    if (panel.mood) want.push(['mood', panel.mood]);
    for (const sentence of panel.action.split(/(?<=[.!?])\s+/)) if (sentence.trim()) want.push(['action', sentence.replace(/[.!?]+$/, '')]);
    if (panel.shot) want.push(['shot', shotWords(panel.shot)]);
    if (panel.angle) want.push(['angle', panel.angle]);
    for (const [what, text] of want) if (!block.includes(text.toLowerCase())) misses.push(`page ${page.n} panel ${panel.n} ${what}: ${text}`);
  }
  return misses;
};

/** The "Who: …" lines of a page prompt, one per panel. */
export const whoLines = (prompt: string): string[] => prompt.split('\n').filter((l) => l.startsWith('Who: '));

/** Words that describe a passing feeling, not an identity: none may sit inside an identity anchor (research-case §9.2). */
export const EXPRESSION_WORDS = ['smile', 'grin', 'smirk', 'frown', 'scowl', 'serene', 'angry', 'determined', 'calm'] as const;

/** Each expression word found inside the prompt's identity anchors, with its anchor. */
export const expressionWordsInAnchors = (prompt: string): { word: string; anchor: string }[] =>
  insideAnchors(prompt).flatMap((anchor) =>
    EXPRESSION_WORDS.filter((w) => new RegExp(`\\b${w}`, 'i').test(anchor)).map((word) => ({ word, anchor }))
  );

// ── Privacy guard (the repository is public) ─────────────────────────────────

/** The only id spellings the fixture may hold (every id of the original was rewritten to one of these). */
export const ALLOWED_CASE_ID = /^(?:rama-setu|c_[a-z]+|pg_\d{2}|pn_\d{2}_\d|ln_\d{2}_\d_\d|pl_\d{2}|msg_brief_\d)$/;
/** Keys that are names of a preset, not ids of anything stored. */
const NOT_AN_ID = new Set(['presetId']);

/**
 * Everything in a fixture file that could identify the original comic or its owner, one line per leak ([] when clean):
 * addresses, links, storage paths and image files, uuids, hex runs of 8 or more (job, spec and storage hashes, the
 * original's ids such as "pg_" + hex), ISO dates, epoch times in seconds or milliseconds other than the one fixture
 * time, mixed letter-and-digit tokens of 10 or more in any value, and any id that is not one of the allowed spellings.
 */
export const privacyLeaks = (text: string): string[] => {
  const leaks: string[] = [];
  const lower = text.toLowerCase();
  for (const bad of ['@', 'http', 'u/', 'ref/', 'q/', 'supabase', 'www.', '.webp', '.png', '.jpg', '.jpeg', '.gif', '.avif', '.svg', '.bmp', '.heic'])
    if (lower.includes(bad)) leaks.push(`contains ${JSON.stringify(bad)}`);
  const noColours = text.replace(/#[0-9a-f]{6}\b/gi, '');
  const rules: [string, RegExp][] = [
    ['a uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
    // No word boundary before it: "_" is a word character, so "pg_743d90151f43" hides a hex run from \b.
    ['a hex run of 8 or more', /(?:^|[^0-9a-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}(?![0-9a-z])|_(?=[0-9a-z]*\d)[0-9a-z]{8,}/i],
    ['an ISO date', /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}|\b)/],
    ['an epoch time in seconds', /(?<!\d)1[6-9]\d{8}(?!\d)/],
    ['an epoch time in milliseconds', new RegExp(`(?<!\\d)(?!${RAMAYANA_FIXTURE_TIME}(?!\\d))1[6-9]\\d{11}(?!\\d)`)]
  ];
  for (const [what, re] of rules) {
    const m = re.exec(noColours);
    if (m) leaks.push(`${what}: ${m[0].trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [...leaks, 'not JSON'];
  }
  const walk = (v: unknown, key: string): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k));
    if (typeof v !== 'string') return;
    if ((key === 'id' || /Ids?$/.test(key)) && !NOT_AN_ID.has(key) && !ALLOWED_CASE_ID.test(v)) leaks.push(`an id not in the allowed spellings: ${key}=${v}`);
    const mixed = /\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{10,}\b/i.exec(v);
    if (mixed) leaks.push(`a mixed letter-and-digit token: ${mixed[0]}`);
  };
  walk(parsed, '');
  return leaks;
};
