// Comic Director tools (v4): the only way the director changes the comic.
//
// Each tool validates its arguments defensively, turns them into DocOps (or a job-runner
// action), and returns a SHORT string the model can act on ("Saved MAYA (lead). Cast:
// MAYA, ARJUN."). Tools never throw: bad arguments come back as an "Error: …" sentence
// the model can correct on the next round. Spend tools go through the job runner's gate
// — when the user must approve, the result says so with the estimate. See
// docs/features/comic-studio-v4.md §6.8.

import {
  newId,
  pageByNumber,
  resolveCharacter,
  type AssetRef,
  type Card,
  type Character,
  type CharacterLook,
  type ComicDoc,
  type Line,
  type LineKind,
  type Msg,
  type OptionChoice,
  type Page,
  type Place,
  type StyleBible
} from '../../../shared/comic/doc.js';
import type { DocOp, SpendAction } from '../../../shared/comic/ops.js';
import { formatUsd } from '../../../shared/comic/models.js';
import { STYLE_PRESETS, getStylePreset } from '../../../shared/comic/stylePresets.js';
import type { ToolSpec } from '../ai/providers/types.js';
import { logger } from '../lib/logger.js';
import {
  ASPECT_RATIOS,
  COLOR_MODES,
  COMIC_KINDS,
  CONFIRM_POLICIES,
  LETTERING_MODES,
  LINE_KINDS,
  QUALITY_TIERS,
  billedLlm,
  newTextSpendTracker,
  planPages,
  recordTextSpend,
  sanitizeFormatPatch,
  sanitizeLook,
  sanitizeSettingsPatch,
  startAction,
  type ActionOutcome
} from './jobs.js';
import { StudioError, type StudioContext } from './types.js';
import { analyzeSource } from './writer.js';

export interface DirectorTool {
  spec: ToolSpec;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** Per-turn state shared between the director loop and its tools. */
export interface DirectorTurn {
  /** Cards for the assistant message being written this turn (options, gates, plan, notices). */
  cards: Card[];
  /** ask_user ran: the director ends its turn after this round. */
  askedUser: boolean;
  question?: string;
  /** Images attached to the user's message this turn (tools refer to them 1-based). */
  attachments: AssetRef[];
  /** The user's message text this turn (save_source can store it verbatim). */
  userText: string;
}

/** Source material shorter than this is stored without a (paid) writer analysis. */
export const ANALYZE_SOURCE_MIN_CHARS = 1500;
const MAX_REFS_PER_ENTITY = 4;
const MAX_SOURCE_CHARS = 200_000;
const SPOKEN = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const LOOK_KEYS = ['summary', 'age', 'gender', 'build', 'face', 'hair', 'eyes', 'skin', 'outfit', 'palette', 'props', 'marks'] as const;

const latestUserMessage = (doc: ComicDoc): Msg | undefined => [...doc.conversation].reverse().find((m) => m.role === 'user');

export const createDirectorTurn = (init: Partial<DirectorTurn> = {}): DirectorTurn => ({
  cards: [],
  askedUser: false,
  attachments: [],
  userText: '',
  ...init
});

// ── Arg helpers ──────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : undefined;
};
const intList = (v: unknown): number[] =>
  (Array.isArray(v) ? v : typeof v === 'number' || typeof v === 'string' ? [v] : []).map(int).filter((n): n is number => n !== undefined);
const strList = (v: unknown, maxItems = 20, max = 300): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((x) => text(x, max)).filter(Boolean).slice(0, maxItems);
const upper = (name?: string) => (name || '').trim().toUpperCase() || 'UNNAMED';
const castList = (doc: ComicDoc) => (doc.cast.length ? doc.cast.map((c) => upper(c.name)).join(', ') : '(none)');
const placeList = (doc: ComicDoc) => (doc.places.length ? doc.places.map((p) => upper(p.name)).join(', ') : '(none)');

class ToolArgError extends Error {}
const argError = (message: string) => new ToolArgError(message);

const errorText = (err: unknown): string => {
  if (err instanceof ToolArgError) return `Error: ${err.message}`;
  if (err instanceof StudioError) return `Error: ${err.userMessage}`;
  logger.warn('comic_tool_unexpected_error', { message: (err as Error)?.message });
  return 'Error: that did not work. Try again with simpler arguments.';
};

const outcomeText = (outcome: ActionOutcome): string => outcome.message;

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {})
});
const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const N = (description: string) => ({ type: 'number', description });
const I = (description: string) => ({ type: 'integer', description });
const B = (description: string) => ({ type: 'boolean', description });
const A = (items: Record<string, unknown>, description: string) => ({ type: 'array', items, description });

const lookSchema = {
  type: 'object',
  description: 'Visual description. Fill every field the user gave; summary is one dense, drawable sentence.',
  properties: Object.fromEntries(
    LOOK_KEYS.map((k) => [
      k,
      {
        type: 'string',
        description:
          k === 'summary'
            ? 'One dense visual sentence an artist could draw from.'
            : k === 'marks'
              ? 'Distinguishing marks that must never drift (scar over left eye, red scarf).'
              : k
      }
    ])
  )
};

const define = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<string> | string
): DirectorTool => ({
  spec: { type: 'function', function: { name, description, parameters } },
  async execute(args) {
    try {
      return await run(isObject(args) ? args : {});
    } catch (err) {
      return errorText(err);
    }
  }
});

// ── Resolution helpers ───────────────────────────────────────────────────────

const findCharacterArg = (doc: ComicDoc, args: Record<string, unknown>): Character | undefined => {
  const id = text(args.id, 80);
  const name = text(args.name, 80);
  return (id && doc.cast.find((c) => c.id === id)) || (name ? resolveCharacter(doc, name) : undefined);
};

const findPlaceArg = (doc: ComicDoc, args: Record<string, unknown>): Place | undefined => {
  const id = text(args.id, 80);
  const name = text(args.name, 80).toLowerCase();
  return (id && doc.places.find((p) => p.id === id)) || (name ? doc.places.find((p) => p.name.trim().toLowerCase() === name) : undefined);
};

const pagesByNumbers = (doc: ComicDoc, numbers: number[]): Page[] => {
  const missing = numbers.filter((n) => !pageByNumber(doc, n));
  if (missing.length) {
    throw argError(`No page ${missing.join(', ')} — the plan has ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}.`);
  }
  return [...new Set(numbers)].map((n) => pageByNumber(doc, n)!).sort((a, b) => a.n - b.n);
};

const attachmentRefs = (turn: DirectorTurn, raw: unknown): AssetRef[] => {
  const numbers = intList(raw);
  if (!numbers.length) return [];
  const out: AssetRef[] = [];
  for (const n of numbers) {
    const ref = turn.attachments[n - 1];
    if (!ref) {
      throw argError(
        turn.attachments.length
          ? `There are only ${turn.attachments.length} image(s) attached to this message (use 1–${turn.attachments.length}).`
          : 'No images are attached to this message.'
      );
    }
    out.push(ref);
  }
  return out;
};

const mergeRefs = (existing: AssetRef[], added: AssetRef[]): AssetRef[] => {
  const seen = new Set<string>();
  return [...existing, ...added].filter((a) => a?.path && !seen.has(a.path) && seen.add(a.path)).slice(-MAX_REFS_PER_ENTITY);
};

const summaryFromLook = (look: Partial<CharacterLook>): string =>
  [
    [look.age, look.gender, look.build].filter(Boolean).join(' '),
    look.hair ? `${look.hair} hair` : '',
    look.outfit,
    look.marks
  ]
    .map((s) => text(s, 200))
    .filter(Boolean)
    .join(', ');

const lookChanged = (before: CharacterLook, patch: Partial<CharacterLook>) =>
  Object.entries(patch).some(([k, v]) => (before as unknown as Record<string, unknown>)[k] !== v);

// ── Source analysis ──────────────────────────────────────────────────────────

async function storeAndAnalyzeSource(ctx: StudioContext, turn: DirectorTurn, args: Record<string, unknown>): Promise<string> {
  const doc = ctx.session.doc;
  let script = typeof args.text === 'string' ? args.text.trim() : '';
  if (!script && args.useMessage === true) script = turn.userText.trim();
  const fromStore = !script;
  if (fromStore) script = (doc.source.script || '').trim();
  if (!script) throw argError('No source text: pass text, set useMessage:true to save the user’s message, or ask the user to paste their script.');
  script = script.slice(0, MAX_SOURCE_CHARS);
  if (!fromStore) ctx.session.commit([{ op: 'source', patch: { script, updatedAt: Date.now() } }]);

  const words = (script.match(/\S+/g) || []).length;
  const analyze = args.analyze === true || (args.analyze !== false && script.length >= ANALYZE_SOURCE_MIN_CHARS);
  if (!analyze) return `Saved the source (${words.toLocaleString('en-US')} words).`;

  const tracker = newTextSpendTracker();
  let analysis: Awaited<ReturnType<typeof analyzeSource>>;
  try {
    analysis = await analyzeSource({
      doc: ctx.session.doc,
      llm: billedLlm(ctx, { stage: 'plan', operation: 'comic.text.writer', tracker }),
      text: script,
      signal: ctx.session.abort.signal
    });
  } finally {
    recordTextSpend(ctx, tracker, 'plan', 'Read the script');
  }

  const current = ctx.session.doc;
  const ops: DocOp[] = [];
  const briefPatch: Record<string, unknown> = {};
  const filled: string[] = [];
  const b = analysis.brief || {};
  for (const key of ['title', 'logline', 'premise', 'genre', 'tone', 'audience', 'setting'] as const) {
    const value = text(b[key], key === 'premise' ? 4000 : 600);
    if (!value) continue;
    const existing = text(current.brief[key]);
    const isDefaultTitle = key === 'title' && (!existing || /^untitled comic$/i.test(existing));
    if (!existing || isDefaultTitle) {
      briefPatch[key] = value;
      filled.push(key);
    }
  }
  if (Array.isArray(b.themes) && b.themes.length && !current.brief.themes?.length) briefPatch.themes = strList(b.themes, 8, 120);
  if (Object.keys(briefPatch).length) ops.push({ op: 'brief', patch: briefPatch });
  for (const note of strList(b.notes, 12, 400)) ops.push({ op: 'note_add', text: note });

  const castNames: string[] = [];
  for (const c of analysis.cast || []) {
    const name = text(c.name, 80);
    if (!name) continue;
    const existing = resolveCharacter(current, name);
    const look = sanitizeLook(c.look) || {};
    if (existing) {
      const lookFill = Object.fromEntries(
        Object.entries(look).filter(([k, v]) => v && !text((existing.look as unknown as Record<string, unknown>)[k]))
      );
      const patch: Partial<Character> = {};
      if (Object.keys(lookFill).length) patch.look = lookFill as unknown as CharacterLook;
      if (!existing.role && c.role) patch.role = text(c.role, 200);
      if (!existing.personality && c.personality) patch.personality = text(c.personality, 1000);
      if (!existing.voice && c.voice) patch.voice = text(c.voice, 600);
      if (Object.keys(patch).length) ops.push({ op: 'character', id: existing.id, patch });
      castNames.push(`${upper(existing.name)} (${existing.tier})`);
      continue;
    }
    const tier = c.tier === 'lead' || c.tier === 'support' || c.tier === 'extra' ? c.tier : 'support';
    ops.push({
      op: 'character',
      id: newId('c'),
      patch: {
        name,
        tier,
        look: { summary: look.summary || summaryFromLook(look), ...look } as CharacterLook,
        ...(c.role ? { role: text(c.role, 200) } : {}),
        ...(c.personality ? { personality: text(c.personality, 1000) } : {}),
        ...(c.voice ? { voice: text(c.voice, 600) } : {})
      }
    });
    castNames.push(`${upper(name)} (${tier})`);
  }

  const placeNames: string[] = [];
  for (const p of analysis.places || []) {
    const name = text(p.name, 80);
    if (!name) continue;
    const existing = current.places.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    const look = text(p.look, 1500);
    if (existing) {
      if (!existing.look && look) ops.push({ op: 'place', id: existing.id, patch: { look } });
    } else {
      ops.push({ op: 'place', id: newId('pl'), patch: { name, look } });
    }
    placeNames.push(upper(name));
  }

  let pagesNote = '';
  if (analysis.suggestedPageCount && current.planStatus === 'none' && analysis.suggestedPageCount !== current.format.pageCount) {
    ops.push({ op: 'format', patch: { pageCount: analysis.suggestedPageCount } });
    pagesNote = `; page count set to ${analysis.suggestedPageCount}`;
  } else if (analysis.suggestedPageCount) {
    pagesNote = `; suggested ${analysis.suggestedPageCount} pages`;
  }
  if (ops.length) ctx.session.commit(ops);

  const after = ctx.session.doc;
  return [
    `Saved and read the source (${words.toLocaleString('en-US')} words).`,
    filled.length ? `Brief: ${filled.map((k) => (k === 'title' ? `title “${after.brief.title}”` : k)).join(', ')}.` : 'Brief already set (kept).',
    castNames.length ? `Cast: ${castNames.slice(0, 12).join(', ')}${castNames.length > 12 ? ` +${castNames.length - 12}` : ''}.` : '',
    placeNames.length ? `Places: ${placeNames.slice(0, 10).join(', ')}.` : '',
    pagesNote ? `Format${pagesNote}.` : '',
    analysis.styleHint ? `Style hint from the text: ${text(analysis.styleHint, 300)}` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

// ── Spend helpers ────────────────────────────────────────────────────────────

async function spend(ctx: StudioContext, turn: DirectorTurn, action: SpendAction): Promise<string> {
  const started = await startAction(ctx, action, { confirmed: false, collectCard: (card) => turn.cards.push(card) });
  // Renders continue after the turn; the stream stays open until they settle.
  void ctx.track(started.done);
  return outcomeText(started.outcome);
}

// ── Tool set ─────────────────────────────────────────────────────────────────

export function buildDirectorTools(ctx: StudioContext, turn?: DirectorTurn): DirectorTool[] {
  const state =
    turn ||
    createDirectorTurn({
      attachments: latestUserMessage(ctx.session.doc)?.attachments || [],
      userText: latestUserMessage(ctx.session.doc)?.text || ''
    });
  const doc = () => ctx.session.doc;
  const commit = (ops: DocOp[]) => ctx.session.commit(ops);

  return [
    define(
      'update_brief',
      'Save story facts the user stated. Only include fields that change.',
      schema({
        title: S('Comic title.'),
        logline: S('One-sentence pitch.'),
        premise: S('What the story is about (a short paragraph).'),
        genre: S('Genre, e.g. noir mystery.'),
        tone: S('Tone, e.g. funny, tense, cozy.'),
        audience: S('Who it is for, e.g. kids 6–9.'),
        setting: S('Where and when it takes place.'),
        themes: A({ type: 'string' }, 'Themes.')
      }),
      (args) => {
        const patch: Record<string, unknown> = {};
        for (const key of ['title', 'logline', 'premise', 'genre', 'tone', 'audience', 'setting'] as const) {
          const v = text(args[key], key === 'premise' ? 4000 : key === 'setting' ? 1000 : 600);
          if (v) patch[key] = key === 'title' ? v.slice(0, 200) : v;
        }
        if (args.themes !== undefined) patch.themes = strList(args.themes, 12, 120);
        if (!Object.keys(patch).length) throw argError('Pass at least one brief field.');
        commit([{ op: 'brief', patch }]);
        return `Brief updated: ${Object.keys(patch).join(', ')}.`;
      }
    ),

    define(
      'add_notes',
      "Record the user's decisions or wishes that don't fit a brief field (e.g. 'no gore', 'ends on a cliffhanger').",
      schema({ notes: A({ type: 'string' }, 'Short notes, one idea each.') }, ['notes']),
      (args) => {
        const notes = strList(args.notes, 12, 500);
        if (!notes.length) throw argError('Pass notes as a list of short strings.');
        commit(notes.map((n): DocOp => ({ op: 'note_add', text: n })));
        return `Noted (${doc().brief.notes.length} notes total).`;
      }
    ),

    define(
      'set_format',
      'Set the format: kind, page count (1–40), page aspect, panels per page, reading direction, lettering, color mode, dialogue language.',
      schema({
        kind: S('Comic kind.', { enum: COMIC_KINDS }),
        pageCount: I('Number of pages, 1–40.'),
        pageAspect: S('Page aspect ratio (2:3 is a standard comic page).', { enum: ASPECT_RATIOS }),
        panelsPerPage: S('"auto" (writer varies 3–6) or a number like "4".'),
        readingDirection: S('ltr, or rtl for manga.', { enum: ['ltr', 'rtl'] }),
        lettering: S('overlay = editable balloons added on top (default); in_art = the model letters the page (best on Pro).', { enum: LETTERING_MODES }),
        colorMode: S('color, bw (black and white) or limited palette.', { enum: COLOR_MODES }),
        language: S('BCP-47 language for dialogue, e.g. en, es, ja.')
      }),
      (args) => {
        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== '') raw[k] = v;
        if (typeof raw.pageCount === 'string') raw.pageCount = int(raw.pageCount);
        if (raw.panelsPerPage !== undefined && raw.panelsPerPage !== 'auto') raw.panelsPerPage = int(raw.panelsPerPage);
        let patch;
        try {
          patch = sanitizeFormatPatch(raw);
        } catch (err) {
          throw argError(err instanceof StudioError ? err.userMessage : 'Invalid format.');
        }
        if (!Object.keys(patch).length) throw argError('Pass at least one format field.');
        commit([{ op: 'format', patch }]);
        const f = doc().format;
        return `Format: ${f.kind}, ${f.pageCount} pages, ${f.pageAspect}, panels ${f.panelsPerPage}, ${f.readingDirection}, ${f.lettering} lettering, ${f.colorMode}, ${f.language}.`;
      }
    ),

    define(
      'save_source',
      "Store the user's script/story/notes as the source. text = the material; or useMessage:true to store the user's current message as-is (best for long pastes); or no text to re-read the stored source. Long material is analyzed: brief, cast and places get filled in. Returns what was extracted.",
      schema({
        text: S('The source material (omit when useMessage is true).'),
        useMessage: B("Store the user's current message text as the source."),
        analyze: B('Force (true) or skip (false) the analysis. Default: analyze when long.')
      }),
      (args) => storeAndAnalyzeSource(ctx, state, args)
    ),

    define(
      'upsert_character',
      'Create or update a character (matched by id or name). Fill every look field the user gave. attachmentRefs = numbers of images attached to this message that show this character (1 = first).',
      schema(
        {
          id: S('Existing character id (from the doc summary).'),
          name: S('Character name (matches an existing one case-insensitively, else creates).'),
          newName: S('Rename to this.'),
          tier: S('lead/support get a model sheet; extra = background, text only.', { enum: ['lead', 'support', 'extra'] }),
          role: S('Role in the story.'),
          look: lookSchema,
          personality: S('Personality.'),
          voice: S('How they talk.'),
          attachmentRefs: A({ type: 'integer' }, 'Attached image numbers to use as this character’s reference.')
        },
        ['name']
      ),
      (args) => {
        const d = doc();
        const existing = findCharacterArg(d, args);
        const name = text(args.name, 80);
        const newName = text(args.newName, 80);
        if (!existing && !name) throw argError('Pass the character name.');
        const finalName = newName || existing?.name || name;
        const clash = d.cast.find((c) => c.id !== existing?.id && c.name.trim().toLowerCase() === finalName.toLowerCase());
        if (clash) throw argError(`There is already a character named ${upper(clash.name)} (id ${clash.id}).`);
        const look = sanitizeLook(args.look) || {};
        for (const k of Object.keys(look)) if (!look[k]) delete look[k];
        const refs = attachmentRefs(state, args.attachmentRefs);
        const tier = args.tier === 'lead' || args.tier === 'support' || args.tier === 'extra' ? args.tier : undefined;
        const patch: Partial<Character> = {};
        if (!existing || newName) patch.name = finalName;
        if (tier) patch.tier = tier;
        for (const key of ['role', 'personality', 'voice'] as const) {
          const v = text(args[key], key === 'role' ? 200 : 1000);
          if (v) patch[key] = v;
        }
        const ops: DocOp[] = [];
        let note = '';
        if (existing) {
          if (Object.keys(look).length) patch.look = look as unknown as CharacterLook;
          if (refs.length) patch.refs = mergeRefs(existing.refs, refs);
          if (!Object.keys(patch).length) throw argError(`Nothing to change for ${upper(existing.name)}.`);
          ops.push({ op: 'character', id: existing.id, patch });
          const changedLook = patch.look && lookChanged(existing.look, patch.look);
          if ((changedLook || refs.length) && existing.sheet.status === 'ready') {
            ops.push({ op: 'render', target: { kind: 'sheet', id: existing.id }, patch: { status: 'stale' } });
            note = ` ${upper(finalName)}'s sheet is now out of date (redrawn with the next pages, or call render_character_sheets).`;
          }
        } else {
          patch.tier = tier || (d.cast.some((c) => c.tier === 'lead') ? 'support' : 'lead');
          patch.look = { ...look, summary: look.summary || summaryFromLook(look) } as CharacterLook;
          if (refs.length) patch.refs = mergeRefs([], refs);
          ops.push({ op: 'character', id: newId('c'), patch });
        }
        commit(ops);
        const saved = resolveCharacter(doc(), finalName);
        const missing = saved && !saved.look.summary ? ' No look yet — ask for or propose one.' : '';
        return `Saved ${upper(finalName)} (${saved?.tier || patch.tier})${refs.length ? ` with ${refs.length} reference image${refs.length > 1 ? 's' : ''}` : ''}. Cast: ${castList(doc())}.${note}${missing}`;
      }
    ),

    define(
      'remove_character',
      'Remove a character from the cast (and from every panel).',
      schema({ id: S('Character id.'), name: S('Character name.') }),
      (args) => {
        const c = findCharacterArg(doc(), args);
        if (!c) throw argError(`No such character. Cast: ${castList(doc())}.`);
        commit([{ op: 'character_remove', id: c.id }]);
        return `Removed ${upper(c.name)}. Cast: ${castList(doc())}.`;
      }
    ),

    define(
      'upsert_place',
      'Create or update a recurring location (matched by id or name). attachmentRefs = attached image numbers showing it.',
      schema(
        {
          id: S('Existing place id.'),
          name: S('Place name.'),
          newName: S('Rename to this.'),
          look: S('What it looks like: architecture, props, light, palette.'),
          attachmentRefs: A({ type: 'integer' }, 'Attached image numbers to use as reference.')
        },
        ['name']
      ),
      (args) => {
        const d = doc();
        const existing = findPlaceArg(d, args);
        const name = text(args.name, 80);
        const newName = text(args.newName, 80);
        if (!existing && !name) throw argError('Pass the place name.');
        const finalName = newName || existing?.name || name;
        const look = text(args.look, 1500);
        const refs = attachmentRefs(state, args.attachmentRefs);
        const patch: Partial<Place> = {};
        if (!existing || newName) patch.name = finalName;
        if (look) patch.look = look;
        if (refs.length) patch.refs = mergeRefs(existing?.refs || [], refs);
        if (existing && !Object.keys(patch).length) throw argError(`Nothing to change for ${upper(existing.name)}.`);
        const ops: DocOp[] = [{ op: 'place', id: existing?.id || newId('pl'), patch }];
        if (existing && (look || refs.length) && existing.sheet.status === 'ready') {
          ops.push({ op: 'render', target: { kind: 'place', id: existing.id }, patch: { status: 'stale' } });
        }
        commit(ops);
        return `Saved place ${upper(finalName)}. Places: ${placeList(doc())}.`;
      }
    ),

    define(
      'remove_place',
      'Remove a location.',
      schema({ id: S('Place id.'), name: S('Place name.') }),
      (args) => {
        const p = findPlaceArg(doc(), args);
        if (!p) throw argError(`No such place. Places: ${placeList(doc())}.`);
        commit([{ op: 'place_remove', id: p.id }]);
        return `Removed ${upper(p.name)}. Places: ${placeList(doc())}.`;
      }
    ),

    define(
      'set_style',
      `Set the art style: presetId (one of: ${STYLE_PRESETS.map((p) => p.id).join(', ')}), OR a custom name + spec (medium, linework, color, shading, influences as visible traits). lock:true locks the style. attachmentRefs adds attached images as style references.`,
      schema({
        presetId: S('Preset id.', { enum: STYLE_PRESETS.map((p) => p.id) }),
        name: S('Custom style name (2–4 words).'),
        spec: S('Custom style spec: concrete, drawable art direction (35–80 words).'),
        palette: A({ type: 'string' }, 'Palette colors (hex or names).'),
        linework: S('Linework description.'),
        avoid: A({ type: 'string' }, 'Things the art must never do.'),
        lock: B('Lock this style for every render.'),
        attachmentRefs: A({ type: 'integer' }, 'Attached image numbers to use as style references.')
      }),
      (args) => {
        const d = doc();
        const refs = attachmentRefs(state, args.attachmentRefs);
        const patch: Partial<Omit<StyleBible, 'options'>> = {};
        const ops: DocOp[] = [];
        const presetId = text(args.presetId, 60);
        let label = '';
        if (presetId) {
          const preset = getStylePreset(presetId);
          if (!preset) throw argError(`Unknown preset. Use one of: ${STYLE_PRESETS.map((p) => p.id).join(', ')}.`);
          Object.assign(patch, {
            name: preset.name,
            spec: preset.spec,
            palette: [...preset.palette],
            linework: preset.linework,
            avoid: [...preset.avoid],
            presetId: preset.id
          });
          if (preset.colorMode && preset.colorMode !== d.format.colorMode) ops.push({ op: 'format', patch: { colorMode: preset.colorMode } });
          label = preset.name;
        } else if (text(args.spec)) {
          const spec = text(args.spec, 2000);
          patch.spec = spec;
          patch.name = text(args.name, 80) || 'Custom style';
          patch.presetId = undefined;
          if (args.palette !== undefined) patch.palette = strList(args.palette, 8, 40);
          if (args.linework !== undefined) patch.linework = text(args.linework, 300);
          label = patch.name;
        } else if (text(args.name)) {
          throw argError('A custom style needs a spec (medium, linework, color, shading).');
        }
        if (args.avoid !== undefined) patch.avoid = strList(args.avoid, 12, 120);
        if (refs.length) patch.refs = mergeRefs(d.style.refs, refs);
        const specChanged = patch.spec !== undefined && patch.spec !== d.style.spec;
        // A new look invalidates the old board (it was drawn in the previous style).
        if (specChanged) patch.board = undefined;
        if (args.lock === true) {
          if (!patch.spec && !d.style.spec) throw argError('There is no style to lock yet — pick a preset or describe one.');
          patch.status = 'locked';
        } else if (patch.spec || patch.refs || patch.avoid) {
          patch.status = specChanged || d.style.status === 'empty' ? 'drafted' : d.style.status;
        }
        if (!Object.keys(patch).length) throw argError('Pass presetId, or name + spec, or lock:true.');
        ops.unshift({ op: 'style', patch });
        commit(ops);
        const s = doc().style;
        const short = !presetId && patch.spec && (patch.spec.match(/\S+/g) || []).length < 15 ? ' The spec is short — a fuller description (medium, linework, color, shading) draws more consistently.' : '';
        return `Style: ${s.name || label || 'custom'} (${s.status})${refs.length ? `, ${s.refs.length} style reference image(s)` : ''}${ops.some((o) => o.op === 'format') ? `; color mode set to ${doc().format.colorMode}` : ''}.${short}`;
      }
    ),

    define(
      'propose_styles',
      'Draw 3 cheap style-test images (or the given 2–4 directions) so the user can tap one to lock. Spends a little money; may need approval.',
      schema({
        directions: A(
          { type: 'object', properties: { name: S('2–4 word name.'), spec: S('Concrete art direction, 35–80 words.') }, required: ['name', 'spec'] },
          'Optional directions you wrote; omit to have the art director propose them.'
        )
      }),
      (args) => {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .filter(isObject)
          .map((d) => ({ name: text(d.name, 60), spec: text(d.spec, 1500) }))
          .filter((d) => d.name && d.spec)
          .slice(0, 4);
        return spend(ctx, state, { type: 'render_style_options', ...(directions.length ? { directions } : {}) });
      }
    ),

    define(
      'render_character_sheets',
      'Draw model sheets (turnaround + expressions) for lead/support characters that lack one, or for the named characters/places (force:true redraws). Spends money; may need approval.',
      schema({
        names: A({ type: 'string' }, 'Character (or place) names; omit for every lead/support missing a sheet.'),
        force: B('Redraw even if a sheet exists.')
      }),
      (args) => {
        const d = doc();
        const names = strList(args.names, 20, 80);
        const ids: string[] = [];
        const unknown: string[] = [];
        for (const n of names) {
          const c = resolveCharacter(d, n);
          const p = d.places.find((x) => x.name.trim().toLowerCase() === n.toLowerCase());
          if (c) ids.push(c.id);
          else if (p) ids.push(p.id);
          else unknown.push(n);
        }
        if (unknown.length) throw argError(`Unknown: ${unknown.join(', ')}. Cast: ${castList(d)}. Places: ${placeList(d)}.`);
        if (!d.cast.length && !ids.length) throw argError('There is no cast yet — add characters first.');
        return spend(ctx, state, { type: 'render_sheets', ...(ids.length ? { characterIds: ids } : {}), ...(args.force === true ? { force: true } : {}) });
      }
    ),

    define(
      'plan_pages',
      'Write the page-by-page script (layout, panels, shots, cast, dialogue) for the whole comic from the doc. No image spend. Replaces the current plan (drawn pages are kept and marked out of date).',
      schema({ instructions: S('Extra direction for the writer (pacing, what to emphasize).') }),
      async (args) => {
        const d = doc();
        const hasStory = !!(d.brief.premise || d.brief.logline || d.source.script || d.cast.length || d.brief.notes.length);
        if (!hasStory) throw argError('Nothing to plan yet — capture the story (brief, cast or source) first.');
        const outcome = await planPages(ctx, { instructions: text(args.instructions, 4000) }, { collectCard: (c) => state.cards.push(c) });
        return `${outcome.message} The user can review and edit the plan on the board before any page is drawn.`;
      }
    ),

    define(
      'revise_pages',
      'Rewrite specific pages of the plan following instructions (e.g. "make page 2 a splash", "Maya should be angrier"). Drawn pages become out of date, never wiped.',
      schema({ pages: A({ type: 'integer' }, 'Page numbers to rewrite.'), instructions: S('What to change.') }, ['pages', 'instructions']),
      async (args) => {
        const d = doc();
        if (!d.pages.length) throw argError('There is no plan yet — call plan_pages first.');
        const instructions = text(args.instructions, 4000);
        if (!instructions) throw argError('Say what to change.');
        const pages = pagesByNumbers(d, intList(args.pages));
        if (!pages.length) throw argError('Pass the page numbers to rewrite.');
        const outcome = await planPages(ctx, { instructions, pageIds: pages.map((p) => p.id) }, { collectCard: (c) => state.cards.push(c) });
        return outcome.message;
      }
    ),

    define(
      'read_pages',
      'Read the full script of planned pages (panels, cast, dialogue with line kinds) before editing them.',
      schema({ pages: A({ type: 'integer' }, 'Page numbers.') }, ['pages']),
      (args) => {
        const d = doc();
        const pages = pagesByNumbers(d, intList(args.pages).slice(0, 6));
        if (!pages.length) throw argError('Pass page numbers.');
        const name = (id?: string) => upper(d.cast.find((c) => c.id === id)?.name || id);
        return pages
          .map((p) =>
            [
              `PAGE ${p.n}: ${p.summary}${p.layout ? ` | Layout: ${p.layout}` : ''}`,
              ...p.panels.map(
                (panel) =>
                  `  Panel ${panel.n} (${panel.size}, ${panel.shot}): ${panel.action}${panel.castIds.length ? ` | Cast: ${panel.castIds.map(name).join(', ')}` : ''}` +
                  panel.lines.map((l) => `\n    ${l.kind}${l.speakerId ? ` ${name(l.speakerId)}` : ''}: "${l.text}"`).join('')
              )
            ].join('\n')
          )
          .join('\n')
          .slice(0, 12_000);
      }
    ),

    define(
      'edit_panel_text',
      "Replace ALL dialogue/captions of one panel with the given lines (exact text). Use [] to make it silent.",
      schema(
        {
          page: I('Page number.'),
          panel: I('Panel number.'),
          lines: A(
            {
              type: 'object',
              properties: {
                kind: S('Line kind.', { enum: LINE_KINDS }),
                speaker: S('Speaker name (speech/thought/whisper/shout).'),
                text: S('Exact text, ≤ 25 words.')
              },
              required: ['kind', 'text']
            },
            'The panel’s new lines in reading order (≤ 3 balloons).'
          )
        },
        ['page', 'panel', 'lines']
      ),
      (args) => {
        const d = doc();
        const page = pagesByNumbers(d, intList(args.page).slice(0, 1))[0];
        if (!page) throw argError('Pass the page number.');
        const panel = page.panels.find((p) => p.n === int(args.panel));
        if (!panel) throw argError(`Page ${page.n} has panels 1–${page.panels.length}.`);
        if (!Array.isArray(args.lines)) throw argError('Pass lines as a list (empty for a silent panel).');
        const lines: Line[] = [];
        const addCast = new Set<string>();
        for (const raw of args.lines.slice(0, 6)) {
          if (!isObject(raw)) continue;
          const kind = LINE_KINDS.includes(raw.kind as LineKind) ? (raw.kind as LineKind) : 'speech';
          const lineText = typeof raw.text === 'string' ? raw.text.trim().slice(0, 600) : '';
          if (!lineText) continue;
          const line: Line = { id: newId('l'), kind, text: lineText };
          if (SPOKEN.has(kind)) {
            const speaker = resolveCharacter(d, text(raw.speaker, 80));
            if (!speaker) throw argError(`Unknown speaker "${text(raw.speaker, 80)}". Cast: ${castList(d)}.`);
            line.speakerId = speaker.id;
            if (!panel.castIds.includes(speaker.id)) addCast.add(speaker.id);
          }
          lines.push(line);
        }
        const ops: DocOp[] = [
          ...panel.lines.map((l): DocOp => ({ op: 'line', pageId: page.id, panelId: panel.id, id: l.id, patch: null })),
          ...lines.map((l): DocOp => ({ op: 'line', pageId: page.id, panelId: panel.id, id: l.id, patch: l }))
        ];
        if (addCast.size) ops.push({ op: 'panel', pageId: page.id, id: panel.id, patch: { castIds: [...panel.castIds, ...addCast] } });
        commit(ops);
        const long = lines.filter((l) => (l.text.match(/\S+/g) || []).length > 25).length;
        return `Page ${page.n} panel ${panel.n} now has ${lines.length} line${lines.length === 1 ? '' : 's'}.${addCast.size ? ' Added the speaker to the panel.' : ''}${long ? ' Some lines exceed 25 words — consider trimming.' : ''}${page.render.status === 'ready' && d.format.lettering === 'in_art' ? ' The page is lettered in the art, so it is now out of date.' : ''}`;
      }
    ),

    define(
      'render_pages',
      'Draw pages from the plan: by default every undrawn or out-of-date page; with page numbers, those pages are (re)drawn. Draws missing character sheets first. Spends money; may need approval. Only after the user saw the plan.',
      schema({ pages: A({ type: 'integer' }, 'Page numbers to (re)draw; omit for all that need it.') }),
      (args) => {
        const d = doc();
        if (d.planStatus === 'none' || !d.pages.length) {
          return 'Refused: there is no page plan yet. Call plan_pages first and let the user review the plan before drawing.';
        }
        const numbers = intList(args.pages);
        const pages = numbers.length ? pagesByNumbers(d, numbers) : [];
        return spend(ctx, state, {
          type: 'render_pages',
          ...(pages.length ? { pageIds: pages.map((p) => p.id), force: true } : {})
        });
      }
    ),

    define(
      'edit_page',
      'Change part of a DRAWN page with an instruction (e.g. "make it night", "Maya smiles"), optionally limited to one panel. Everything else is kept. Spends money; may need approval.',
      schema({ page: I('Page number.'), instruction: S('What to change, concretely.'), panel: I('Panel number (optional).') }, ['page', 'instruction']),
      (args) => {
        const d = doc();
        const page = pagesByNumbers(d, intList(args.page).slice(0, 1))[0];
        if (!page) throw argError('Pass the page number.');
        if (page.render.status !== 'ready' || !page.render.asset) {
          throw argError(`Page ${page.n} isn't drawn yet — render it first (or revise its script with revise_pages).`);
        }
        const instruction = text(args.instruction, 2000);
        if (!instruction) throw argError('Say what to change.');
        const panelN = int(args.panel);
        if (panelN !== undefined && !page.panels.some((p) => p.n === panelN)) throw argError(`Page ${page.n} has panels 1–${page.panels.length}.`);
        return spend(ctx, state, { type: 'edit_page', pageId: page.id, instruction, ...(panelN !== undefined ? { panelN } : {}) });
      }
    ),

    define(
      'render_cover',
      'Draw the cover. Optional title/tagline/direction override what is shown. Spends money; may need approval.',
      schema({ title: S('Cover title (defaults to the comic title).'), tagline: S('Short tagline.'), direction: S('Cover composition idea.') }),
      (args) => {
        const patch: Record<string, string> = {};
        const title = text(args.title, 200);
        const tagline = text(args.tagline, 300);
        const direction = text(args.direction, 1500);
        if (title) patch.title = title;
        if (tagline) patch.tagline = tagline;
        if (direction) patch.direction = direction;
        if (Object.keys(patch).length) commit([{ op: 'cover', patch }]);
        return spend(ctx, state, { type: 'render_cover' });
      }
    ),

    define(
      'set_settings',
      'Change quality tier (draft/standard/pro), spend confirmation (always/big/never), the "big spend" threshold, or the project budget cap in USD (0 clears it).',
      schema({
        quality: S('Quality tier.', { enum: QUALITY_TIERS }),
        confirm: S('always = confirm every spend; big = only above the threshold; never = only the budget stops spend.', { enum: CONFIRM_POLICIES }),
        bigSpendUsd: N('Threshold for "big" spends (USD).'),
        budgetUsd: N('Project budget cap in USD; 0 clears it.')
      }),
      (args) => {
        const raw: Record<string, unknown> = {};
        for (const key of ['quality', 'confirm', 'bigSpendUsd', 'budgetUsd'] as const) if (args[key] !== undefined && args[key] !== null && args[key] !== '') raw[key] = args[key];
        for (const key of ['bigSpendUsd', 'budgetUsd'] as const) if (typeof raw[key] === 'string') raw[key] = Number(raw[key]);
        let patch;
        try {
          patch = sanitizeSettingsPatch(raw);
        } catch (err) {
          throw argError(err instanceof StudioError ? err.userMessage : 'Invalid settings.');
        }
        if (!Object.keys(patch).length && !('budgetUsd' in raw)) throw argError('Pass at least one setting.');
        commit([{ op: 'settings', patch: 'budgetUsd' in raw && !('budgetUsd' in patch) ? { ...patch, budgetUsd: undefined } : patch }]);
        const s = doc().settings;
        return `Settings: ${s.quality} quality; confirm ${s.confirm}${s.confirm === 'big' ? ` (above ${formatUsd(s.bigSpendUsd)})` : ''}; budget ${s.budgetUsd ? formatUsd(s.budgetUsd) : 'none'}.`;
      }
    ),

    define(
      'ask_user',
      'Ask the user ONE question with 2–5 tappable options (propose a sensible default first). End your turn right after calling this.',
      schema(
        {
          question: S('The question, short.'),
          options: A(
            {
              type: 'object',
              properties: {
                label: S('Chip label, ≤ 5 words.'),
                description: S('Optional one-line detail.'),
                reply: S('Message sent when tapped (defaults to the label).')
              },
              required: ['label']
            },
            '2–5 options.'
          ),
          allowCustom: B('Let the user type their own answer (default true).'),
          multi: B('Allow picking several.')
        },
        ['question', 'options']
      ),
      (args) => {
        const question = text(args.question, 300);
        if (!question) throw argError('Pass the question.');
        const seen = new Set<string>();
        const choices: OptionChoice[] = (Array.isArray(args.options) ? args.options : [])
          .map((o) => (typeof o === 'string' ? { label: o } : o))
          .filter(isObject)
          .map((o) => ({ label: text(o.label, 60), description: text(o.description, 160), reply: text(o.reply, 600) }))
          .filter((o) => o.label && !seen.has(o.label.toLowerCase()) && seen.add(o.label.toLowerCase()))
          .slice(0, 5)
          .map((o) => ({
            id: newId('opt'),
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
            ...(o.reply ? { reply: o.reply } : {})
          }));
        if (choices.length < 2) throw argError('Give 2–5 distinct options.');
        if (state.askedUser) throw argError('You already asked a question this turn — end your turn now.');
        state.cards.push({
          type: 'options',
          id: newId('card'),
          question,
          choices,
          allowCustom: args.allowCustom !== false,
          ...(args.multi === true ? { multi: true } : {})
        });
        state.askedUser = true;
        state.question = question;
        return 'Asked — the question and options are shown to the user. End your turn now with at most one short sentence.';
      }
    )
  ];
}

/** Exposed for tests and the director: the tool names in the order offered. */
export const directorToolNames = (tools: DirectorTool[]) => tools.map((t) => t.spec.function.name);

