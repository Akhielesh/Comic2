// Dialogue understanding: an intent + its resolved lines → free DocOps (agent-editor plan §3 B2 compile.ts, B4 table).
// Pure and free: no model call, no I/O, no spend. Every op is an existing, undoable K2a/v5 doc op.
//
// Rules the compiler never bends:
// - Never invent a speaker: a new spoken line, or a caption turned into speech, asks "Who says it?" with cast chips.
// - Never re-assign a speaker when moving a line; a speaker who is not drawn in the destination panel asks first.
// - The creator's locks hold: a locked balloon is never moved, restyled or re-aimed (the editor's refusal words).
// - Never silent: a refusal, a fallback ("placed by the staging") or a partial result says so in `note`.
// `compileDialogue` runs the whole pipeline (resolve → compile, all or nothing) for the director and the fast path.

import { OFF_PANEL_SHOTS } from '../panelRules.js';
import { DOC_LIMITS } from '../limits.js';
import type { Balloon, ComicDoc, Line, LineKind, NextStep, OptionChoice, Page, Panel } from '../doc.js';
import { freshId, takenIds, zOrderEdit } from '../editor/scene.js';
import { lineOrderOps } from '../editor/readingOrder.js';
import { setBoxEdit } from '../editor/transform.js';
import { FONT_REGISTRY } from '../lettering/fonts.js';
import { NAMED_COLORS, normalizeColor, resolveLetterStyle, sanitizeLetterStylePatch, type LetterStyle, type LetterStylePatch } from '../lettering/style.js';
import { applyOps, type DocOp } from '../ops.js';
import { balloonPatchOp, lineGeo, pageGeo, placeLine, tailTip, type PlaceMiss } from './placement.js';
import { askForResolution, isPronounResolution, lineHits, resolveLineRef, type DialogueContext, type ResolutionAsk } from './resolve.js';
import { fontFromWords, parseDialogue } from './grammar.js';
import { castList, isSpeakerPronoun, matchSpeaker, noSuchSpeaker, pronounQuestion, speakerName } from './speakers.js';
import type { CompileResult, DialogueIntent, LineHit, LineRef, Placement, Resolution, ResolveContext } from './types.js';

// ── Extras the B1 union does not carry yet (amendments; the grammar sets them, the compiler reads them) ─────────────

/**
 * Optional extras on a `restyle` intent: `scaleBy` sizes text relative to each line's current size ("bigger" = ×1.2),
 * and `asKind` copies the target line's look onto every line of that kind ("same style as this one for every caption").
 */
export interface RestyleExtras {
  scaleBy?: number;
  asKind?: LineKind;
  /** A font name the studio does not have ("Comic Sans"): nothing changes until the creator picks one of the 3 nearest. */
  unknownFont?: string;
}

/**
 * Optional extra on an `add` intent: `orChange` = the creator said a panel NEEDS a line ("the second panel needs a
 * shout"), which may mean changing an existing line; an explicit "add a shout" asks only for the words.
 */
export interface AddExtras {
  orChange?: boolean;
}

/** Optional extra on a `reorder` intent: a 0-based position in the line's panel (dialogue_edit `index`), clamped to it. */
export interface ReorderExtras {
  atIndex?: number;
}

/** The question a compile result asks instead of changing anything (the deterministic question card). */
export interface CompileAsk {
  question: string;
  options?: OptionChoice[];
}

/**
 * CompileResult plus `ask` (amendment): set when nothing changed because the studio needs an answer first; and
 * `already`: nothing changed because it already is so ("It's already a whisper"), which a longer instruction may skip.
 * Any other empty result is a refusal, and stops the whole instruction (all or nothing).
 */
export type CompileOutcome = CompileResult & { ask?: CompileAsk; already?: boolean };

/** Compile-time options the pipeline passes (never part of an intent). */
export interface CompileOptions {
  /** move_to_panel: the creator already chose an off-panel voice for a speaker not drawn in the destination. */
  offPanelOk?: boolean;
  /** move_to_panel: the next step gives the line to someone else, so the old speaker's absence there doesn't matter. */
  speakerFollows?: boolean;
  /** Where the creator is (the "other" line of reorder / link resolves near the target first). */
  focus?: ResolveContext;
}

// ── Words ────────────────────────────────────────────────────────────────────

const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const KIND_A: Record<LineKind, string> = { speech: 'speech', thought: 'a thought balloon', whisper: 'a whisper', shout: 'a shout', caption: 'a caption', sfx: 'a sound effect' };
const KIND_NOUN: Record<LineKind, string> = { speech: 'speech balloon', thought: 'thought balloon', whisper: 'whisper', shout: 'shout', caption: 'caption', sfx: 'sound effect' };
const KIND_PLURAL: Record<LineKind, string> = { speech: 'speech balloons', thought: 'thought balloons', whisper: 'whispers', shout: 'shouts', caption: 'captions', sfx: 'sound effects' };
const WHO_VERB: Record<LineKind, string> = { speech: 'Who says it?', thought: "Who's thinking it?", whisper: "Who's whispering it?", shout: "Who's shouting it?", caption: 'Who says it?', sfx: 'Who says it?' };
const DO_VERB: Record<LineKind, string> = { speech: 'say', thought: 'think', whisper: 'whisper', shout: 'shout', caption: 'say', sfx: 'say' };
/** "a speech balloon", "a whisper" (a kind with its article, for reply sentences). */
const kindA = (kind: LineKind): string => (kind === 'speech' ? 'a speech balloon' : KIND_A[kind]);
/** "“Wait for me”" for one line, "3 balloons" for several. */
const whoWords = (lines: readonly { text: string }[], n: number, noun = 'balloon'): string => (n === 1 && lines.length ? quote(lines[0].text, 30) : plural(n, noun));

/** "a pov shot", "an establishing shot". */
const shotWords = (shot: string): string => {
  const w = shot.replace(/_/g, ' ');
  return `${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w} shot`;
};
const quote = (text: string, max = 40): string => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The plain sentence for an in-art comic, where balloons are painted into the drawing. */
export const IN_ART_REFUSAL =
  "This comic's text is painted into the artwork (in-art lettering), so balloon moves, tails and styles don't apply. Switching to overlay lettering makes every balloon editable for free; drawn pages would need redrawing without text (paid, quoted first).";

const inArt = (doc: ComicDoc): boolean => doc.format?.lettering === 'in_art';

/** "Page 2 is lettered in the art, so it is now out of date (redrawing it is paid)." for drawn in-art pages touched. */
const artNote = (doc: ComicDoc, pageIds: Iterable<string>): string | undefined => {
  if (!inArt(doc)) return undefined;
  const drawn = [...new Set(pageIds)].map((id) => doc.pages.find((p) => p.id === id)).filter((p): p is Page => !!p && p.render?.status === 'ready');
  if (!drawn.length) return undefined;
  const ns = drawn.map((p) => p.n).sort((a, b) => a - b);
  return `${ns.length === 1 ? `Page ${ns[0]} is` : `Pages ${ns.join(', ')} are`} lettered in the art, so ${ns.length === 1 ? 'it is' : 'they are'} now out of date (redrawing is paid and quoted first).`;
};

const join = (...parts: (string | undefined)[]): string | undefined => {
  const s = parts.filter((p): p is string => !!p && !!p.trim()).join(' ');
  return s || undefined;
};

// ── Lookups ──────────────────────────────────────────────────────────────────

interface Where {
  page: Page;
  panel: Panel;
  panelIndex: number;
  line: Line;
}
const whereOf = (doc: ComicDoc, lineId: string): Where | undefined => {
  for (const page of doc.pages) {
    for (let i = 0; i < page.panels.length; i++) {
      const line = page.panels[i].lines.find((l) => l.id === lineId);
      if (line) return { page, panel: page.panels[i], panelIndex: i, line };
    }
  }
  return undefined;
};

/** Up to `max` cast chips (the panel's cast first, then the rest of the cast). */
const castChips = (doc: ComicDoc, panel: Panel | undefined, max: number, say: (name: string) => string): NextStep[] => {
  const ids = [...new Set([...(panel?.castIds ?? []), ...doc.cast.map((c) => c.id)])];
  return ids
    .map((id) => speakerName(doc, id))
    .filter((n): n is string => !!n && !!n.trim())
    .slice(0, max)
    .map((name) => ({ label: name, say: say(name) }));
};

// ── Results ──────────────────────────────────────────────────────────────────

/** An applied result. Never silent: every compiler says what it did; the label is the last-resort sentence. */
const result = (ops: DocOp[], label: string, followUps: NextStep[] = [], note?: string): CompileOutcome => {
  const said = note?.trim() ? note : ops.length && label ? `${label}.` : undefined;
  return { ops, label: ops.length ? label : '', followUps: followUps.slice(0, 3), ...(said ? { note: said } : {}) };
};
const asking = (question: string, followUps: NextStep[] = [], options?: OptionChoice[], note?: string): CompileOutcome => ({
  ops: [],
  label: '',
  followUps: followUps.slice(0, DOC_LIMITS.nextSteps),
  note: join(note, question),
  ask: { question, ...(options?.length ? { options } : {}) }
});
const nothing = (note: string): CompileOutcome => ({ ops: [], label: '', followUps: [], note });
/** Nothing to change because it already is so (benign: a longer instruction carries on with its other parts). */
const alreadySo = (note: string): CompileOutcome => ({ ...nothing(note), already: true });

/** Follow-up chips after a kind change (plan §3 A4): another kind, another font, a move. */
const afterKind = (hit: LineHit | undefined, kind: LineKind): NextStep[] => {
  const q = hit ? quote(hit.text, 30) : 'it';
  const other: LineKind = kind === 'whisper' ? 'shout' : kind === 'shout' ? 'whisper' : kind === 'thought' ? 'speech' : 'whisper';
  const chips: NextStep[] = [];
  if (SPOKEN.has(kind)) chips.push({ label: other === 'speech' ? 'Make it speech' : `Make it ${KIND_A[other]}`, say: `Make ${q} ${other === 'speech' ? 'speech' : KIND_A[other]}` });
  chips.push({ label: 'Try another font', say: `Try another font for ${q}` });
  chips.push({ label: 'Move it', say: `Move ${q} to the top left` });
  return chips;
};
/** Follow-up chips after a move (plan §3 A4): a bit higher, lock it. */
const afterMove = (hit: LineHit | undefined): NextStep[] => {
  const q = hit ? quote(hit.text, 30) : 'it';
  return [
    { label: 'A bit higher', say: `Move ${q} up a bit` },
    { label: 'Lock it', say: `Lock ${q}` }
  ];
};

// ── Style words ──────────────────────────────────────────────────────────────

const COLOR_NAME = new Map<string, string>(NAMED_COLORS.map(([name]) => [normalizeColor(name) ?? '', name] as [string, string]).filter(([hex]) => !!hex));
const colorWords = (c: string): string => {
  if (c === 'none') return 'none';
  const base = c.length === 9 ? c.slice(0, 7) : c;
  const name = COLOR_NAME.get(base) ?? c;
  return c.length === 9 && parseInt(c.slice(7), 16) < 255 ? `${name}, see-through` : name;
};

/** "red text, cloud bubble" — what a style patch does, in plain words. */
export const describeStyle = (p: LetterStylePatch, scaleBy?: number): string => {
  const parts: string[] = [];
  if (p.font) parts.push(`${FONT_REGISTRY[p.font]?.label ?? p.font} font`);
  if (scaleBy) parts.push(scaleBy >= 1 ? 'bigger text' : 'smaller text');
  else if (p.sizeScale !== undefined) parts.push(`text size ×${p.sizeScale}`);
  if (p.weight !== undefined) parts.push(p.weight >= 700 ? 'bold' : 'regular weight');
  if (p.italic !== undefined) parts.push(p.italic ? 'italic' : 'not italic');
  if (p.textCase) parts.push(p.textCase === 'as_typed' ? 'mixed case' : p.textCase === 'upper' ? 'capitals' : p.textCase === 'lower' ? 'lower case' : 'title case');
  if (p.textColor) parts.push(`${colorWords(p.textColor)} text`);
  if (p.fill) parts.push(p.fill === 'none' ? 'no fill' : `${colorWords(p.fill)} fill`);
  if (p.border) parts.push(`${colorWords(p.border)} border`);
  if (p.borderStyle) parts.push(`${p.borderStyle} border`);
  if (p.shape) parts.push(p.shape === 'none' ? 'no bubble' : `${p.shape.replace('_', ' ')} bubble`);
  if (p.tail) parts.push(p.tail === 'none' ? 'no tail' : `${p.tail} tail`);
  return parts.join(', ') || 'a new look';
};

/** Keys a "same style as this one" copy carries (the look, not the line's size or tilt). */
const LOOK_KEYS: readonly (keyof LetterStyle)[] = ['font', 'weight', 'italic', 'textCase', 'textColor', 'textStroke', 'shadow', 'fill', 'border', 'borderWidth', 'borderStyle', 'shape', 'padding'];
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Per-act compilers ────────────────────────────────────────────────────────

function compileSetKind(doc: ComicDoc, kind: LineKind, lines: LineHit[]): CompileOutcome {
  const ops: DocOp[] = [];
  const needSpeaker: Where[] = [];
  const changed: Where[] = [];
  const unvoiced: Where[] = [];
  let already = 0;
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (!w) continue;
    if (w.line.kind === kind) {
      already++;
      continue;
    }
    if (SPOKEN.has(kind) && !w.line.speakerId) {
      needSpeaker.push(w);
      continue;
    }
    const patch: Partial<Line> = { kind };
    // A caption or sound effect has no speaker (the server's set_line rule).
    if (!SPOKEN.has(kind) && w.line.speakerId) {
      patch.speakerId = undefined;
      unvoiced.push(w);
    }
    ops.push({ op: 'line', pageId: w.page.id, panelId: w.panel.id, id: w.line.id, patch });
    changed.push(w);
  }
  if (needSpeaker.length) {
    // Never invent a speaker: ask, and change nothing until the answer comes.
    const w = needSpeaker[0];
    return asking(
      WHO_VERB[kind],
      castChips(doc, w.panel, 4, (name) => `Make ${quote(w.line.text, 30)} ${KIND_A[kind] === 'speech' ? 'speech' : KIND_A[kind]} by ${name}`),
      undefined,
      `${quote(w.line.text)} is ${KIND_A[w.line.kind]}, so it has no speaker yet.`
    );
  }
  if (!ops.length) return already ? alreadySo(`${lines.length === 1 ? "It's" : "They're"} already ${lines.length === 1 ? KIND_A[kind] : KIND_PLURAL[kind]}.`) : nothing('Nothing to change.');
  const label = ops.length === 1 ? `Make it ${KIND_A[kind]}` : `Make ${ops.length} lines ${KIND_PLURAL[kind]}`;
  const made = changed.length === 1 ? `Made ${quote(changed[0].line.text, 30)} ${kindA(kind)}.` : `Made ${plural(changed.length, 'line')} ${KIND_PLURAL[kind]}.`;
  // Never silent about a speaker the kind change takes away.
  const lost =
    unvoiced.length === 1
      ? `${KIND_PLURAL[kind][0].toUpperCase()}${KIND_PLURAL[kind].slice(1)} have no speaker, so it is no longer ${speakerName(doc, unvoiced[0].line.speakerId) ?? 'anyone'}'s line.`
      : unvoiced.length
        ? `${KIND_PLURAL[kind][0].toUpperCase()}${KIND_PLURAL[kind].slice(1)} have no speaker, so ${plural(unvoiced.length, 'line')} lost theirs.`
        : undefined;
  const note = join(made, lost, already ? `${plural(already, 'line')} already ${already === 1 ? 'was' : 'were'} ${KIND_A[kind]}.` : undefined, artNote(doc, lines.map((h) => h.pageId)));
  return result(ops, label, afterKind(lines.length === 1 ? lines[0] : undefined, kind), note);
}

function compileEditText(doc: ComicDoc, text: string, lines: LineHit[]): CompileOutcome {
  const next = (text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!next) return asking('What should it say?');
  const ops: DocOp[] = [];
  const was: string[] = [];
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (!w || w.line.text === next) continue;
    ops.push({ op: 'line', pageId: w.page.id, panelId: w.panel.id, id: w.line.id, patch: { text: next } });
    was.push(w.line.text);
  }
  if (!ops.length) return alreadySo('It already says that.');
  const said = ops.length === 1 ? `Changed ${quote(was[0], 30)} to ${quote(next, 60)}.` : `Changed the words of ${plural(ops.length, 'line')} to ${quote(next, 60)}.`;
  return result(ops, ops.length === 1 ? 'Change the words' : `Change the words of ${ops.length} lines`, [], join(said, artNote(doc, lines.map((h) => h.pageId))));
}

function compileSetSpeaker(doc: ComicDoc, speaker: string, lines: LineHit[]): CompileOutcome {
  const ops: DocOp[] = [];
  const notes: string[] = [];
  if (speaker === 'off_panel') {
    for (const hit of lines) {
      const w = whereOf(doc, hit.lineId);
      if (!w) continue;
      if (!w.line.speakerId) {
        notes.push(`${quote(w.line.text)} is ${KIND_A[w.line.kind]}, so it has no voice to move off-panel.`);
        continue;
      }
      if (inArt(doc)) {
        notes.push(IN_ART_REFUSAL);
        continue;
      }
      const tip = tailTip(doc, w.page.id, w.line.id, 'edge');
      if (tip.ok === false) {
        notes.push(tip.reason);
        continue;
      }
      const op = balloonPatchOp(pageGeo(doc, w.page), w.line.id, { tailX: tip.x, tailY: tip.y });
      if (op) {
        ops.push(op);
        notes.push(`${speakerName(doc, w.line.speakerId) ?? 'The voice'} now speaks from off-panel: the tail points at ${tip.who}.`);
      }
    }
    if (!ops.length) return nothing(notes.join(' ') || 'Nothing to change.');
    return result(ops, 'Make it an off-panel voice', [], notes.join(' '));
  }
  const m = matchSpeaker(doc, speaker, { pronounOf: lines.length === 1 ? lines[0].speakerId : undefined });
  if (m.status === 'none') return nothing(`${noSuchSpeaker(doc, speaker)} Nothing was changed.`);
  if (m.status === 'many') {
    const w = whereOf(doc, lines[0]?.lineId ?? '');
    return asking(
      `“${speaker.trim()}” could be ${castList(doc, m.characterIds)}. Which one?`,
      m.characterIds.map((id) => speakerName(doc, id)).filter((n): n is string => !!n).slice(0, 4).map((name) => ({ label: name, say: `Give ${w ? quote(w.line.text, 30) : 'it'} to ${name}` }))
    );
  }
  const id = m.characterId;
  const name = speakerName(doc, id) ?? 'them';
  let already = 0;
  const given: string[] = [];
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (!w) continue;
    if (w.line.speakerId === id) {
      already++;
      continue;
    }
    const patch: Partial<Line> = { speakerId: id };
    if (!SPOKEN.has(w.line.kind)) {
      patch.kind = 'speech';
      notes.push(`${quote(w.line.text)} was ${KIND_A[w.line.kind]}; it's a speech balloon now.`);
    }
    ops.push({ op: 'line', pageId: w.page.id, panelId: w.panel.id, id: w.line.id, patch });
    given.push(w.line.text);
    const drawnHere = (w.panel.castIds ?? []).includes(id) || (w.page.render?.qc?.heads ?? []).some((h) => h.panel === w.panel.n && h.characterId === id);
    if (!drawnHere) notes.push(`${name} isn't drawn in panel ${w.panel.n}, so the line reads as an off-panel voice${OFF_PANEL_SHOTS.has(w.panel.shot) ? ` (heard, not drawn: ${shotWords(w.panel.shot)})` : ''}.`);
    // A tail someone aimed at the old speaker follows the new one (or the panel edge for an off-panel voice).
    const stored = w.page.balloons.find((b) => b.lineId === w.line.id);
    if (!inArt(doc) && stored && typeof stored.tailX === 'number' && typeof stored.tailY === 'number' && !stored.locked) {
      const after = applyOps(doc, [ops[ops.length - 1]]);
      const tip = tailTip(after, w.page.id, w.line.id, drawnHere ? { characterId: id } : 'edge');
      const op = tip.ok ? balloonPatchOp(pageGeo(doc, w.page), w.line.id, { tailX: tip.x, tailY: tip.y }) : undefined;
      if (op) ops.push(op);
      if (tip.ok && tip.note) notes.push(tip.note);
    }
  }
  if (!ops.length) return alreadySo(`${lines.length === 1 ? 'It is' : 'They are'} already ${name}'s.`);
  const gave = given.length === 1 ? `Gave ${quote(given[0], 30)} to ${name}.` : `Gave ${plural(given.length, 'line')} to ${name}.`;
  return result(ops, `Give the line to ${name}`, [], join(gave, ...notes, already ? `${plural(already, 'line')} already ${already === 1 ? 'was' : 'were'} ${name}'s.` : undefined, artNote(doc, lines.map((h) => h.pageId))));
}

/** The panel an `add` goes to: numbers in the intent, else the panel of a resolved line. */
const addTarget = (doc: ComicDoc, ref: LineRef, lines: LineHit[]): { page: Page; panel: Panel } | { ask: string } => {
  const anchor = lines[0] ? whereOf(doc, lines[0].lineId) : undefined;
  let page: Page | undefined;
  if (typeof ref.page === 'number') {
    page = doc.pages.find((p) => p.n === ref.page);
    if (!page) return { ask: `There's no page ${ref.page}: the comic has ${plural(doc.pages.length, 'page')}. Which page?` };
  } else page = anchor?.page;
  if (!page) return { ask: ref.panel !== undefined ? `Which page is panel ${typeof ref.panel === 'number' ? ref.panel : `the ${ref.panel}`} on?` : 'Which page and panel should it go in?' };
  if (ref.panel === undefined) {
    if (anchor && anchor.page.id === page.id) return { page, panel: anchor.panel };
    return page.panels.length === 1 ? { page, panel: page.panels[0] } : { ask: `Which panel on page ${page.n}? It has panels 1–${page.panels.length}.` };
  }
  const n = ref.panel === 'first' ? 1 : ref.panel === 'last' ? page.panels.length : ref.panel;
  const panel = page.panels.find((p) => p.n === n);
  if (!panel) return { ask: `Page ${page.n} has ${page.panels.length === 1 ? 'one panel' : `panels 1–${page.panels.length}`}. Which one?` };
  return { page, panel };
};

function compileAdd(doc: ComicDoc, intent: Extract<DialogueIntent, { act: 'add' }>, lines: LineHit[]): CompileOutcome {
  const at = addTarget(doc, intent.panel ?? {}, lines);
  if ('ask' in at) return asking(at.ask);
  const { page, panel } = at;
  const kind = intent.kind;
  const text = (intent.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const where = `panel ${panel.n} on page ${page.n}`;
  let speakerId: string | undefined;
  if (SPOKEN.has(kind)) {
    if (intent.speaker) {
      const m = matchSpeaker(doc, intent.speaker);
      if (m.status === 'none' && isSpeakerPronoun(intent.speaker)) {
        return asking(pronounQuestion(intent.speaker), castChips(doc, panel, 4, (name) => `Add ${kindA(kind)} by ${name} in ${where}${text ? ` saying ${quote(text, 60)}` : ''}`));
      }
      if (m.status === 'none') return nothing(`${noSuchSpeaker(doc, intent.speaker)} Nothing was added.`);
      if (m.status === 'many') {
        return asking(
          `“${intent.speaker.trim()}” could be ${castList(doc, m.characterIds)}. Which one?`,
          m.characterIds.map((id) => speakerName(doc, id)).filter((n): n is string => !!n).slice(0, 4).map((name) => ({ label: name, say: `Add ${KIND_A[kind] === 'speech' ? 'a speech balloon' : KIND_A[kind]} by ${name} in ${where}${text ? ` saying ${quote(text, 60)}` : ''}` }))
        );
      }
      speakerId = m.characterId;
    }
  }
  if (!text) {
    if (speakerId) return asking(`What should ${speakerName(doc, speakerId)} ${DO_VERB[kind]}? Type the words.`);
    const addSay = `Add ${kindA(kind)} in ${where}`;
    const byChips = (max: number): NextStep[] =>
      SPOKEN.has(kind) ? castChips(doc, panel, max, (name) => `Add ${kindA(kind)} by ${name} in ${where}`).map((c) => ({ ...c, label: `New ${KIND_NOUN[kind]} by ${c.label}` })) : [];
    const candidates = panel.lines.filter((l) => l.kind !== kind && (SPOKEN.has(kind) ? !!l.speakerId : true) && l.text.trim());
    if ((intent as AddExtras).orChange && candidates.length) {
      // "the second panel needs a shout": change a line, or add a new one (custom words, and who says it).
      const lineChips: NextStep[] = candidates
        .slice(0, 3)
        .map((l) => ({ label: `Make ${quote(l.text, 22)} ${KIND_A[kind] === 'speech' ? 'speech' : KIND_A[kind]}`, say: `Make ${quote(l.text, 40)} ${KIND_A[kind] === 'speech' ? 'speech' : KIND_A[kind]}` }));
      return asking(`Change a line in panel ${panel.n} to ${KIND_A[kind]}, or add a new one?`, [...lineChips, { label: `New ${KIND_NOUN[kind]}…`, say: addSay }, ...byChips(2)]);
    }
    // An explicit add ("add a sound effect in panel 2", or the "New …" chip): only the words (and who) are missing.
    return asking(
      SPOKEN.has(kind)
        ? `What should the ${KIND_NOUN[kind]} in panel ${panel.n} say, and who ${DO_VERB[kind] === 'say' ? 'says' : `${DO_VERB[kind]}s`} it? Type the words, or pick who first.`
        : `What should the ${KIND_NOUN[kind]} in panel ${panel.n} say? Type the words.`,
      byChips(4)
    );
  }
  if (SPOKEN.has(kind) && !speakerId) {
    // Never invent a speaker for a new spoken line.
    return asking(
      WHO_VERB[kind],
      castChips(doc, panel, 4, (name) => `Add ${KIND_A[kind] === 'speech' ? 'a speech balloon' : KIND_A[kind]} by ${name} in ${where} saying ${quote(text, 60)}`)
    );
  }
  if (panel.lines.length >= DOC_LIMITS.linesPerPanel) {
    return nothing(`Panel ${panel.n} on page ${page.n} already has ${DOC_LIMITS.linesPerPanel} lines, the most a panel holds. Shorten or move one first.`);
  }
  const id = freshId('line', takenIds(doc));
  const patch: Partial<Line> = { kind, text, ...(speakerId ? { speakerId } : {}) };
  const ops: DocOp[] = [{ op: 'line', pageId: page.id, panelId: panel.id, id, patch, index: panel.lines.length }];
  const notes: string[] = [];
  if (speakerId && !(panel.castIds ?? []).includes(speakerId)) {
    notes.push(`${speakerName(doc, speakerId)} isn't drawn in panel ${panel.n}, so the line reads as an off-panel voice${OFF_PANEL_SHOTS.has(panel.shot) ? ` (heard, not drawn: ${shotWords(panel.shot)})` : ''}.`);
  }
  if (!inArt(doc)) {
    const preview = applyOps(doc, ops);
    const previewPage = preview.pages.find((p) => p.id === page.id)!;
    const geo = pageGeo(preview, previewPage);
    if (intent.place) {
      // A full-width bar is a rectangle, measured as drawn (same rule as compileMove).
      const newLine = previewPage.panels.flatMap((p) => p.lines).find((l) => l.id === id);
      const rect = intent.place.edge && newLine && resolveLetterStyle(preview, newLine).shape !== 'rect' ? lineStyleOps([{ pageId: page.id, lineId: id, patch: { shape: 'rect' } }]) : [];
      const shaped = rect.length ? applyOps(preview, rect) : preview;
      const placed = placeOps(shaped, shaped.pages.find((p) => p.id === page.id)!, id, intent.place);
      if (placed.ok) {
        ops.push(...rect, ...placed.ops);
        notes.push(`Placed at ${placed.where}.`, ...(placed.note ? [placed.note] : []));
      } else notes.push(`${placed.reason} The lettering placed it instead.`);
    } else {
      // Auto-placed where the lettering engine draws it (near its speaker, around faces), not pinned.
      const op = balloonPatchOp(geo, id, {});
      if (op && op.op === 'balloon' && Object.keys(op.patch).length) ops.push(op);
    }
  }
  const hitWords = `${quote(text)} in ${where}`;
  return result(ops, `Add ${KIND_A[kind] === 'speech' ? 'a speech balloon' : KIND_A[kind]}`, [{ label: 'Move it', say: `Move ${quote(text, 30)} to the top left` }], join(`Added ${KIND_A[kind] === 'speech' ? 'a speech balloon' : KIND_A[kind]}${speakerId ? ` by ${speakerName(doc, speakerId)}` : ''}: ${hitWords}.`, ...notes, artNote(doc, [page.id])));
}

function compileDelete(doc: ComicDoc, lines: LineHit[]): CompileOutcome {
  const ops: DocOp[] = [];
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (w) ops.push({ op: 'line', pageId: w.page.id, panelId: w.panel.id, id: w.line.id, patch: null });
  }
  if (!ops.length) return alreadySo('Those lines are already gone.');
  const words = lines.length === 1 ? `Deleted ${quote(lines[0].text)}.` : `Deleted ${plural(lines.length, 'line')}.`;
  return result(ops, ops.length === 1 ? 'Delete balloon' : `Delete ${ops.length} balloons`, [], join(words, 'Undo brings it back with its translations.', artNote(doc, lines.map((h) => h.pageId))));
}

/** A placement committed through the editor's setBoxEdit (locks, undo and the stored shape match the editor). */
function placeOps(doc: ComicDoc, page: Page, lineId: string, place: Placement, stackAfter?: { panelIndex: number; top: number; bottom: number; fromBottom: boolean }) {
  const out = placeLine(doc, page.id, lineId, place);
  if (out.ok === false) return { ...out, ok: false as const };
  const geo = pageGeo(doc, page);
  const g = lineGeo(geo, lineId);
  if (!g) return { ok: false as const, reason: 'That line has no balloon on this page.' };
  let y = out.y;
  // Several balloons sent to one spot stack in reading order, outline to outline, never on top of each other.
  if (stackAfter && (place.frame === 'page' || stackAfter.panelIndex === g.panelIndex)) {
    const by = g.box.y - g.text.y;
    y = stackAfter.fromBottom ? Math.min(y, stackAfter.top - 0.01 - (by + g.box.h)) : Math.max(y, stackAfter.bottom + 0.01 - by);
  }
  const w = out.w ?? g.text.w;
  const to = { x: g.box.x + (out.x - g.text.x), y: g.box.y + (y - g.text.y), w: g.box.w + (w - g.text.w), h: g.box.h };
  const edit = setBoxEdit(doc, page, { kind: 'balloon', id: lineId }, to, geo.scene);
  if (edit.ok === false) return { ok: false as const, reason: edit.reason, same: edit.reason === 'It already looks like that.' };
  return { ok: true as const, ops: edit.ops, where: out.where, note: out.note, panelIndex: g.panelIndex, top: to.y, bottom: to.y + to.h };
}

/** How a character-relative spot reads back in a chip ("above Mira's head", "next to Leo"). */
const relationSay = (relation: Placement['relation'], name: string): string =>
  relation === 'above' ? `above ${name}'s head` : relation === 'below' ? `below ${name}` : relation === 'left' ? `to the left of ${name}` : relation === 'right' ? `to the right of ${name}` : `next to ${name}`;

/**
 * The question for a spot that needs a character the panel can't give (plan B4 "asks"): which of several people, which
 * two for "between", or — when they aren't drawn there — move the line to their panel or pick someone who is.
 */
function placeAsk(doc: ComicDoc, w: Where, place: Placement, miss: PlaceMiss): CompileOutcome | undefined {
  const q = quote(w.line.text, 40);
  const names = (ids: readonly string[]) => ids.map((id) => speakerName(doc, id)).filter((n): n is string => !!n && !!n.trim());
  // "between Mira and Leo" where "Mira" is ambiguous: the chip keeps the name that did resolve.
  const otherName = (): string | undefined => {
    for (const n of [place.near, place.and]) {
      const m = n ? matchSpeaker(doc, n) : undefined;
      if (m?.status === 'one') return speakerName(doc, m.characterId);
    }
    return undefined;
  };
  if (miss.candidates?.length) {
    // "Mira" could be two people: one chip each, keeping the spot the creator asked for.
    return asking(
      miss.reason,
      names(miss.candidates).slice(0, 4).map((name) => {
        const and = place.relation === 'between' ? otherName() : undefined;
        return { label: name, say: `Put ${q} ${and ? `between ${name} and ${and}` : relationSay(place.relation, name)}` };
      })
    );
  }
  if (miss.pairs?.length) {
    // "between them" with three or more people: one chip per pair ("between Mira Patel and Leo").
    const ns = names(miss.pairs);
    const pairs: NextStep[] = [];
    for (let i = 0; i < ns.length && pairs.length < 4; i++) for (let j = i + 1; j < ns.length && pairs.length < 4; j++) pairs.push({ label: `${ns[i]} and ${ns[j]}`, say: `Put ${q} between ${ns[i]} and ${ns[j]}` });
    return asking(miss.reason, pairs);
  }
  if (miss.few) {
    const chips: NextStep[] = names(miss.few).slice(0, 2).map((name) => ({ label: `Above ${name}`, say: `Put ${q} above ${name}'s head` }));
    chips.push({ label: 'Top of the panel', say: `Move ${q} to the top` });
    return asking(miss.reason, chips);
  }
  if (miss.absent) {
    const who = speakerName(doc, miss.absent.characterId) ?? 'They';
    const chips: NextStep[] = miss.absent.elsewhere.slice(0, 2).map((n) => ({ label: `Move it to panel ${n}`, say: `Move ${q} to panel ${n}` }));
    for (const name of names(miss.absent.drawn).slice(0, 2)) chips.push({ label: `${place.relation === 'above' ? 'Above' : 'Next to'} ${name}`, say: `Put ${q} ${relationSay(place.relation === 'between' ? 'near' : place.relation, name)}` });
    chips.push({ label: 'Top of the panel', say: `Move ${q} to the top` });
    const where = miss.absent.elsewhere.length ? `Move the line to ${who}'s panel, or place it somewhere in panel ${miss.absent.panelN}?` : `Where in panel ${miss.absent.panelN} should it go?`;
    return asking(`${miss.reason} ${where}`, chips);
  }
  return undefined;
}

function compileMove(doc: ComicDoc, place: Placement, lines: LineHit[]): CompileOutcome {
  if (inArt(doc)) return nothing(IN_ART_REFUSAL);
  // "Caption across the top": a full-width bar is a rectangle (plan B4 line_style {shape:'rect'}). The shape is applied
  // first, so the bar is measured with the outline it will be drawn with.
  const bars = place.edge
    ? lines
        .map((h) => whereOf(doc, h.lineId))
        .filter((w): w is Where => !!w && !w.page.balloons.find((b) => b.lineId === w.line.id)?.locked && resolveLetterStyle(doc, w.line).shape !== 'rect')
        .map((w) => ({ pageId: w.page.id, lineId: w.line.id, patch: { shape: 'rect' } as LetterStylePatch }))
    : [];
  const base = bars.length ? applyOps(doc, lineStyleOps(bars)) : doc;
  const ops: DocOp[] = [];
  const placed = new Set<string>();
  const notes: string[] = [];
  const refused: string[] = [];
  let where = '';
  let ask: CompileOutcome | undefined;
  const stacks = new Map<string, { panelIndex: number; top: number; bottom: number; fromBottom: boolean }>();
  const fromBottom = !!(place.cell?.startsWith('bottom') || place.edge === 'bottom');
  for (const hit of lines) {
    const w = whereOf(base, hit.lineId);
    if (!w) continue;
    // One spot per region: a page-frame spot is shared by every panel's line, so they stack too.
    const key = place.frame === 'page' ? w.page.id : `${w.page.id}|${w.panel.id}`;
    const stackable = !place.nudge && lines.length > 1;
    const res = placeOps(base, w.page, w.line.id, place, stackable ? stacks.get(key) : undefined);
    if (res.ok === false) {
      if ('same' in res && res.same) notes.push(`${quote(w.line.text)} is already there.`);
      else if (!ask && lines.length === 1 && ('candidates' in res || 'absent' in res || 'pairs' in res || 'few' in res)) {
        ask = placeAsk(doc, w, place, res);
        if (!ask) refused.push(res.reason);
      } else refused.push(res.reason);
      continue;
    }
    ops.push(...res.ops);
    placed.add(w.line.id);
    where = res.where;
    if (res.note && !notes.includes(res.note)) notes.push(res.note);
    if (stackable) {
      const prev = stacks.get(key);
      stacks.set(key, { panelIndex: res.panelIndex, top: Math.min(prev?.top ?? res.top, res.top), bottom: Math.max(prev?.bottom ?? res.bottom, res.bottom), fromBottom });
    }
  }
  if (ask && !ops.length) return ask;
  if (!ops.length) return refused.length ? nothing(join(...[...new Set(refused)], ...notes) ?? 'Nothing to change.') : notes.length ? alreadySo(join(...notes)!) : nothing('Nothing to change.');
  const squared = bars.filter((b) => placed.has(b.lineId));
  if (squared.length) ops.unshift(...lineStyleOps(squared));
  const n = placed.size;
  const who = lines.length === 1 ? quote(lines[0].text) : plural(n, 'balloon');
  const hint = !place.nudge && !place.near && !place.relation && place.frame !== 'page' ? 'Say “of the page” to use the whole page.' : undefined;
  const barNote = squared.length ? (squared.length === 1 && n === 1 ? 'Its bubble is now a rectangle, so the bar runs edge to edge.' : `${plural(squared.length, 'bubble')} became rectangles, so the bars run edge to edge.`) : undefined;
  return result(
    ops,
    n === 1 ? 'Move balloon' : `Move ${n} balloons`,
    afterMove(lines.length === 1 ? lines[0] : undefined),
    join(`Moved ${who} ${place.nudge || place.near || place.relation ? where : `to ${where}`}. Pinned, so auto-layout won't move ${n === 1 ? 'it' : 'them'}.`, barNote, hint, ...notes, ...[...new Set(refused)])
  );
}

function compileAimTail(doc: ComicDoc, to: string, lines: LineHit[]): CompileOutcome {
  if (inArt(doc)) return nothing(IN_ART_REFUSAL);
  const ops: DocOp[] = [];
  const notes: string[] = [];
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (!w) continue;
    if (w.page.balloons.find((b) => b.lineId === w.line.id)?.locked) {
      notes.push('This balloon is locked. Unlock it to change it.');
      continue;
    }
    const target = /^(?:mouth|her mouth|his mouth|their mouth|the mouth)$/i.test(to.trim()) ? 'mouth' : { name: to };
    const tip = tailTip(doc, w.page.id, w.line.id, target);
    if (tip.ok === false) {
      const q = quote(w.line.text, 30);
      if (tip.candidates?.length) {
        return asking(tip.reason, tip.candidates.map((id) => speakerName(doc, id)).filter((n): n is string => !!n).slice(0, 4).map((name) => ({ label: name, say: `Point the tail of ${q} at ${name}` })));
      }
      if (tip.absent && lines.length === 1) {
        // The one they named isn't drawn here: aim at someone who is, or move the line to their panel.
        const who = speakerName(doc, tip.absent.characterId) ?? 'They';
        const chips: NextStep[] = tip.absent.drawn
          .map((id) => speakerName(doc, id))
          .filter((n): n is string => !!n && !!n.trim())
          .slice(0, 2)
          .map((name) => ({ label: `Point at ${name}`, say: `Point the tail of ${q} at ${name}` }));
        for (const n of tip.absent.elsewhere.slice(0, 2)) chips.push({ label: `Move it to panel ${n}`, say: `Move ${q} to panel ${n}` });
        if (w.line.speakerId && SPOKEN.has(w.line.kind)) chips.push({ label: 'Off-panel voice', say: `The voice of ${q} comes from off-panel` });
        return asking(`${tip.reason} Point the tail at someone in panel ${tip.absent.panelN}${tip.absent.elsewhere.length ? `, or move the line to ${who}'s panel` : ''}?`, chips);
      }
      notes.push(tip.reason);
      continue;
    }
    const op = balloonPatchOp(pageGeo(doc, w.page), w.line.id, { tailX: tip.x, tailY: tip.y });
    if (!op) continue;
    ops.push(op);
    notes.push(`Pointed the tail of ${quote(w.line.text, 30)} at ${tip.who}.`);
    if (tip.note) notes.push(tip.note);
    if (!SPOKEN.has(w.line.kind)) notes.push(`${KIND_A[w.line.kind][0].toUpperCase()}${KIND_A[w.line.kind].slice(1)} only shows a tail if its style has one.`);
  }
  if (!ops.length) return nothing(join(...new Set(notes)) ?? 'Nothing to change.');
  return result(ops, ops.length === 1 ? 'Aim the tail' : `Aim ${ops.length} tails`, [], join(...new Set(notes)));
}

/** line_style ops grouped per page and identical patch (≤ lineIdsPerOp ids each). */
const lineStyleOps = (entries: { pageId: string; lineId: string; patch: LetterStylePatch }[]): DocOp[] => {
  const groups = new Map<string, { pageId: string; ids: string[]; patch: LetterStylePatch }>();
  for (const e of entries) {
    const key = `${e.pageId}|${JSON.stringify(e.patch)}`;
    const g = groups.get(key) ?? { pageId: e.pageId, ids: [], patch: e.patch };
    g.ids.push(e.lineId);
    groups.set(key, g);
  }
  const ops: DocOp[] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += DOC_LIMITS.lineIdsPerOp) ops.push({ op: 'line_style', pageId: g.pageId, lineIds: g.ids.slice(i, i + DOC_LIMITS.lineIdsPerOp), patch: g.patch });
  }
  return ops;
};

function compileTailStyle(doc: ComicDoc, tail: LetterStyle['tail'], lines: LineHit[]): CompileOutcome {
  if (inArt(doc)) return nothing(IN_ART_REFUSAL);
  const entries: { pageId: string; lineId: string; patch: LetterStylePatch }[] = [];
  const touched: string[] = [];
  let locked = 0;
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (!w) continue;
    if (w.page.balloons.find((b) => b.lineId === w.line.id)?.locked) {
      locked++;
      continue;
    }
    if (resolveLetterStyle(doc, w.line).tail === tail) continue;
    entries.push({ pageId: w.page.id, lineId: w.line.id, patch: { tail } });
    touched.push(w.line.text);
  }
  const lockedNote = locked ? `${plural(locked, 'locked balloon')} stayed as ${locked === 1 ? 'it is' : 'they are'}.` : undefined;
  if (!entries.length) {
    const has = `${lines.length === 1 ? 'It already has' : 'They already have'} ${tail === 'none' ? 'no tail' : `a ${tail} tail`}.`;
    return locked ? nothing(join(lockedNote, locked < lines.length ? has : undefined)!) : alreadySo(has);
  }
  const who = whoWords(touched.map((text) => ({ text })), touched.length);
  const did = tail === 'none' ? `Removed the tail of ${who}.` : `Gave ${who} ${/^[aeiou]/.test(tail) ? 'an' : 'a'} ${tail} tail.`;
  return result(lineStyleOps(entries), tail === 'none' ? 'Remove the tail' : `${tail[0].toUpperCase()}${tail.slice(1)} tail`, [], join(did, lockedNote));
}

/** Ops that move `hit`'s line into `dest` at `index`, asking first when its speaker is not drawn there. */
function moveToPanelOps(doc: ComicDoc, w: Where, dest: Panel, index: number | undefined, opts: CompileOptions): { ops: DocOp[]; note?: string } | { ask: CompileOutcome } {
  const ops: DocOp[] = [{ op: 'line_move', pageId: w.page.id, id: w.line.id, toPanelId: dest.id, ...(index !== undefined ? { index } : {}) }];
  let note: string | undefined;
  const sp = w.line.speakerId;
  if (dest.id !== w.panel.id && sp && SPOKEN.has(w.line.kind) && !(dest.castIds ?? []).includes(sp) && !opts.speakerFollows) {
    const name = speakerName(doc, sp) ?? 'The speaker';
    if (OFF_PANEL_SHOTS.has(dest.shot)) note = `${name} speaks off-panel there (heard, not drawn: ${shotWords(dest.shot)}).`;
    else if (opts.offPanelOk) note = `${name} speaks off-panel in panel ${dest.n}.`;
    else {
      // Never re-assign a speaker when moving a line: ask how the line should work there (plan B4: add the speaker to
      // the panel / an off-panel voice / change the speaker).
      const q = quote(w.line.text, 40);
      const drawnThere = (dest.castIds ?? []).map((id) => speakerName(doc, id)).find((n): n is string => !!n && !!n.trim());
      return {
        ask: asking(`${name} isn't drawn in panel ${dest.n}. Move the line there as an off-panel voice, add ${name} to the panel, or give the line to someone drawn there?`, [
          { label: 'Off-panel voice', say: `Move ${q} to panel ${dest.n} as an off-panel voice` },
          { label: `Add ${name} to panel ${dest.n}`, say: `Add ${name} to panel ${dest.n} on page ${w.page.n}, then move ${q} there` },
          drawnThere ? { label: `Give it to ${drawnThere}`, say: `Move ${q} to panel ${dest.n} and give it to ${drawnThere}` } : { label: 'Change the speaker', say: `Who should say ${q} in panel ${dest.n}?` }
        ])
      };
    }
  }
  // A balloon stored for the old panel is placed fresh by the lettering in the new one (undo puts it back).
  if (dest.id !== w.panel.id && w.page.balloons.some((b) => b.lineId === w.line.id)) {
    const kept = w.page.balloons.filter((b) => b.lineId !== w.line.id);
    ops.push({ op: 'balloons', pageId: w.page.id, balloons: kept });
    note = join(note, `Its balloon is placed fresh in panel ${dest.n}.`);
  }
  return { ops, note };
}

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

function compileReorder(doc: ComicDoc, to: Extract<DialogueIntent, { act: 'reorder' }>['to'], lines: LineHit[], opts: CompileOptions, atIndex?: number): CompileOutcome {
  if (lines.length !== 1) return nothing(`Reordering moves one line at a time; that matched ${plural(lines.length, 'line')}.`);
  const w = whereOf(doc, lines[0].lineId);
  if (!w) return nothing('That line is not in the comic any more.');
  const ids = w.panel.lines.map((l) => l.id);
  const rest = ids.filter((id) => id !== w.line.id);
  // A 0-based position ("index 1" = second), clamped to the panel; its last slot is "last".
  if (typeof atIndex === 'number' && Number.isInteger(atIndex) && atIndex > 0 && atIndex < rest.length) {
    const want = [...rest.slice(0, atIndex), w.line.id, ...rest.slice(atIndex)];
    const nth = ORDINAL_WORDS[atIndex] ?? `number ${atIndex + 1}`;
    const ops = lineOrderOps(w.page, w.panel.id, want);
    if (!ops.length) return alreadySo(`${quote(w.line.text)} already comes ${nth} in panel ${w.panel.n}.`);
    return result(ops, 'Reorder lines', [], join(`${quote(w.line.text)} now comes ${nth} in panel ${w.panel.n}.`, artNote(doc, [w.page.id])));
  }
  if (to === 'first' || to === 'last') {
    const want = to === 'first' ? [w.line.id, ...rest] : [...rest, w.line.id];
    const ops = lineOrderOps(w.page, w.panel.id, want);
    if (!ops.length) return alreadySo(`${quote(w.line.text)} already comes ${to} in panel ${w.panel.n}.`);
    return result(ops, 'Reorder lines', [], join(`${quote(w.line.text)} now comes ${to} in panel ${w.panel.n}.`, artNote(doc, [w.page.id])));
  }
  const otherRef = 'before' in to ? to.before : to.after;
  const res = resolveLineRef(doc, otherRef, { pageId: w.page.id, panelN: w.panel.n, recentPageIds: opts.focus?.recentPageIds });
  if (res.status !== 'lines' || res.lines.length !== 1) return askFrom(doc, res.status === 'lines' ? { status: 'which', candidates: res.lines } : res);
  const other = whereOf(doc, res.lines[0].lineId);
  if (!other || other.line.id === w.line.id) return nothing('A line cannot go before or after itself.');
  if (other.page.id !== w.page.id) return nothing(`${quote(other.line.text)} is on page ${other.page.n}; a line moves between panels of one page only.`);
  const before = 'before' in to;
  if (other.panel.id === w.panel.id) {
    const at = rest.indexOf(other.line.id) + (before ? 0 : 1);
    const want = [...rest.slice(0, at), w.line.id, ...rest.slice(at)];
    const ops = lineOrderOps(w.page, w.panel.id, want);
    if (!ops.length) return alreadySo(`${quote(w.line.text)} already comes ${before ? 'before' : 'after'} ${quote(other.line.text)}.`);
    return result(ops, 'Reorder lines', [], join(`${quote(w.line.text)} now comes ${before ? 'before' : 'after'} ${quote(other.line.text)}.`, artNote(doc, [w.page.id])));
  }
  const index = other.panel.lines.findIndex((l) => l.id === other.line.id) + (before ? 0 : 1);
  const moved = moveToPanelOps(doc, w, other.panel, index, opts);
  if ('ask' in moved) return moved.ask;
  return result(moved.ops, 'Move line', [], join(`Moved ${quote(w.line.text)} to panel ${other.panel.n}, ${before ? 'before' : 'after'} ${quote(other.line.text)}.`, moved.note, artNote(doc, [w.page.id])));
}

function compileSwap(doc: ComicDoc, lines: LineHit[]): CompileOutcome {
  const ids = [...new Set(lines.map((h) => h.lineId))];
  if (ids.length !== 2) return nothing(`Swapping needs exactly two lines; that matched ${plural(ids.length, 'line')}. Select the two balloons, or name them.`);
  const a = whereOf(doc, ids[0]);
  const b = whereOf(doc, ids[1]);
  if (!a || !b) return nothing('Those lines are not in the comic any more.');
  if (a.page.id !== b.page.id) return nothing(`Those lines are on pages ${a.page.n} and ${b.page.n}; lines swap within one page only.`);
  if (a.panel.id === b.panel.id) {
    const want = a.panel.lines.map((l) => (l.id === a.line.id ? b.line.id : l.id === b.line.id ? a.line.id : l.id));
    return result(lineOrderOps(a.page, a.panel.id, want), 'Swap lines', [], join(`Swapped ${quote(a.line.text, 30)} and ${quote(b.line.text, 30)} in panel ${a.panel.n}.`, artNote(doc, [a.page.id])));
  }
  const ia = a.panel.lines.findIndex((l) => l.id === a.line.id);
  const ib = b.panel.lines.findIndex((l) => l.id === b.line.id);
  const ops: DocOp[] = [
    { op: 'line_move', pageId: a.page.id, id: a.line.id, toPanelId: b.panel.id, index: ib },
    { op: 'line_move', pageId: a.page.id, id: b.line.id, toPanelId: a.panel.id, index: ia }
  ];
  const notes: string[] = [];
  for (const [w, dest] of [[a, b.panel], [b, a.panel]] as const) {
    const sp = w.line.speakerId;
    if (sp && SPOKEN.has(w.line.kind) && !(dest.castIds ?? []).includes(sp)) notes.push(`${speakerName(doc, sp)} isn't drawn in panel ${dest.n}, so that line reads as an off-panel voice there.`);
  }
  const stored = a.page.balloons.filter((x) => x.lineId === a.line.id || x.lineId === b.line.id);
  if (stored.length) {
    ops.push({ op: 'balloons', pageId: a.page.id, balloons: a.page.balloons.filter((x) => !stored.includes(x)) });
    notes.push('Their balloons are placed fresh in their new panels.');
  }
  return result(ops, 'Swap lines', [], join(`Swapped ${quote(a.line.text, 30)} (now panel ${b.panel.n}) and ${quote(b.line.text, 30)} (now panel ${a.panel.n}).`, ...notes, artNote(doc, [a.page.id])));
}

function compileMoveToPanel(doc: ComicDoc, panelN: number, pageN: number | undefined, lines: LineHit[], opts: CompileOptions): CompileOutcome {
  const ops: DocOp[] = [];
  const notes: string[] = [];
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (!w) continue;
    if (pageN !== undefined && pageN !== w.page.n) return nothing(`${quote(w.line.text)} is on page ${w.page.n}; a line moves between panels of one page only.`);
    const dest = w.page.panels.find((p) => p.n === panelN);
    if (!dest) return nothing(`Page ${w.page.n} has ${w.page.panels.length === 1 ? 'one panel' : `panels 1–${w.page.panels.length}`}; there's no panel ${panelN}.`);
    if (dest.id === w.panel.id) {
      notes.push(`${quote(w.line.text)} is already in panel ${panelN}.`);
      continue;
    }
    if (dest.lines.length >= DOC_LIMITS.linesPerPanel) return nothing(`Panel ${panelN} already has ${DOC_LIMITS.linesPerPanel} lines, the most a panel holds.`);
    const moved = moveToPanelOps(doc, w, dest, undefined, opts);
    if ('ask' in moved) return moved.ask;
    ops.push(...moved.ops);
    notes.push(`Moved ${quote(w.line.text, 30)} to panel ${panelN}.`);
    if (moved.note) notes.push(moved.note);
  }
  if (!ops.length) return notes.length ? alreadySo(notes.join(' ')) : nothing('Nothing to change.');
  return result(ops, ops.length === 1 ? `Move line to panel ${panelN}` : `Move lines to panel ${panelN}`, [], join(...notes, artNote(doc, lines.map((h) => h.pageId))));
}

/** The kind / speaker a kind- or speaker-wide restyle applies to: named in the ref, else shared by every resolved line. */
const scopeKind = (ref: LineRef, lines: LineHit[], extras: RestyleExtras): LineKind | undefined => {
  if (extras.asKind) return extras.asKind;
  if (ref.kind) return ref.kind;
  const kinds = [...new Set(lines.map((h) => h.kind))];
  return kinds.length === 1 ? kinds[0] : undefined;
};

function compileRestyle(doc: ComicDoc, intent: Extract<DialogueIntent, { act: 'restyle' }>, lines: LineHit[]): CompileOutcome {
  if (inArt(doc)) return nothing(IN_ART_REFUSAL);
  const extras = intent as unknown as RestyleExtras;
  const scaleBy = typeof extras.scaleBy === 'number' && Number.isFinite(extras.scaleBy) && extras.scaleBy > 0 ? extras.scaleBy : undefined;
  let style: LetterStylePatch = { ...(sanitizeLetterStylePatch(intent.style) ?? {}) };
  const scope = extras.asKind ? 'kind' : intent.scope;
  const sizeTip = scaleBy && scaleBy > 1 ? 'Bigger text; say “wider bubble” for the box.' : undefined;
  // "Same style as this one for every caption": the look of exactly one line, minus what that kind already has.
  if (extras.asKind) {
    if (lines.length !== 1) return askFrom(doc, { status: 'which', candidates: lines });
    const w = whereOf(doc, lines[0].lineId);
    if (!w) return nothing('That line is not in the comic any more.');
    const from = resolveLetterStyle(doc, w.line);
    const now = resolveLetterStyle(doc, { id: '', kind: extras.asKind, text: '' });
    const copy: Record<string, unknown> = {};
    for (const k of LOOK_KEYS) if (!sameValue(from[k], now[k])) copy[k] = from[k];
    style = { ...(sanitizeLetterStylePatch(copy) ?? {}), ...style };
    if (!Object.keys(style).length) return alreadySo(`Every ${KIND_NOUN[extras.asKind]} already looks like ${quote(w.line.text, 30)}.`);
  }
  if (extras.unknownFont) return askFont(doc, intent, lines, style, scaleBy, extras.unknownFont);
  if (!Object.keys(style).length && !scaleBy) return nothing('That style has nothing I can change. Try a font, a colour, a bubble shape, bold or italic.');

  if (scope === 'line') {
    const entries: { pageId: string; lineId: string; patch: LetterStylePatch }[] = [];
    let locked = 0;
    for (const hit of lines) {
      const w = whereOf(doc, hit.lineId);
      if (!w) continue;
      if (w.page.balloons.find((b) => b.lineId === w.line.id)?.locked) {
        locked++;
        continue;
      }
      const patch: LetterStylePatch = { ...style };
      if (scaleBy) patch.sizeScale = r2(clamp(resolveLetterStyle(doc, w.line).sizeScale * scaleBy, 0.5, 3.5));
      entries.push({ pageId: w.page.id, lineId: w.line.id, patch });
    }
    const lockedNote = locked ? `${plural(locked, 'locked balloon')} stayed as ${locked === 1 ? 'it is' : 'they are'}.` : undefined;
    if (!entries.length) return nothing(lockedNote ?? 'Nothing to change.');
    const who = entries.length === 1 ? quote(lines[0].text, 30) : plural(entries.length, 'balloon');
    return result(lineStyleOps(entries), entries.length === 1 ? 'Restyle balloon' : `Restyle ${entries.length} balloons`, [], join(`Restyled ${who} (${describeStyle(style, scaleBy)}).`, sizeTip, lockedNote));
  }
  const sizeAt = (base: LetterStyle): LetterStylePatch => (scaleBy ? { ...style, sizeScale: r2(clamp(base.sizeScale * scaleBy, 0.5, 3.5)) } : style);
  if (scope === 'kind') {
    const kind = scopeKind(intent.target, lines, extras);
    if (!kind) return asking('Which kind of balloon: speech, thought, whisper, shout, caption or sound effect?');
    const patch = sizeAt(resolveLetterStyle(doc, { id: '', kind, text: '' }));
    const from = extras.asKind && lines.length === 1 ? ` to match ${quote(lines[0].text, 30)}` : '';
    return result([{ op: 'letter_style', patch: { kinds: { [kind]: patch } } }], `Restyle every ${KIND_NOUN[kind]}`, [], join(`Restyled every ${KIND_NOUN[kind]}${from} (${describeStyle(style, scaleBy)}).`, sizeTip));
  }
  if (scope === 'speaker') {
    let id: string | undefined;
    const theirs = [...new Set(lines.map((h) => h.speakerId).filter((x): x is string => !!x))];
    if (intent.target.speaker) {
      // "her lines": the pronoun means the speaker the resolver already found (the selection's).
      const m = matchSpeaker(doc, intent.target.speaker, { pronounOf: theirs.length === 1 ? theirs[0] : undefined });
      if (m.status === 'none' && isSpeakerPronoun(intent.target.speaker)) {
        const rest = styleSayWords(style, scaleBy);
        return asking(pronounQuestion(intent.target.speaker), castChips(doc, undefined, 4, (name) => `Make ${name}'s lines ${rest || 'look different'}`));
      }
      if (m.status === 'none') return nothing(`${noSuchSpeaker(doc, intent.target.speaker)} Nothing was changed.`);
      if (m.status === 'many') return asking(`“${intent.target.speaker.trim()}” could be ${castList(doc, m.characterIds)}. Which one?`);
      id = m.characterId;
    } else if (theirs.length === 1) id = theirs[0];
    if (!id) return asking('Whose lines?', castChips(doc, undefined, 4, (name) => `Restyle ${name}'s lines`));
    const patch = sizeAt(resolveLetterStyle(doc, { id: '', kind: 'speech', text: '', speakerId: id }));
    const name = speakerName(doc, id) ?? 'their';
    return result([{ op: 'letter_style', patch: { speakers: { [id]: patch } } }], `Restyle ${name}'s lines`, [], join(`Restyled every line ${name} says (${describeStyle(style, scaleBy)}).`, sizeTip));
  }
  const patch = sizeAt(resolveLetterStyle(doc, { id: '', kind: 'speech', text: '' }));
  return result([{ op: 'letter_style', patch: { base: patch } }], 'Restyle all lettering', [], join(`Restyled all the lettering (${describeStyle(style, scaleBy)}).`, sizeTip));
}

/** A style patch as words the grammar reads back ("bold italic red text"), for a chip that repeats the request. */
const styleSayWords = (p: LetterStylePatch, scaleBy?: number): string => {
  const w: string[] = [];
  if (scaleBy) w.push(scaleBy >= 1 ? 'bigger' : 'smaller');
  if (p.weight !== undefined) w.push(p.weight >= 700 ? 'bold' : 'not bold');
  if (p.italic !== undefined) w.push(p.italic ? 'italic' : 'not italic');
  if (p.textCase === 'upper') w.push('all caps');
  else if (p.textCase === 'lower') w.push('lower case');
  if (p.textColor && p.textColor !== 'none') w.push(`${colorWords(p.textColor).replace(/, see-through$/, '')} text`);
  if (p.fill && p.fill !== 'none') w.push(`with a ${colorWords(p.fill).replace(/, see-through$/, '')} box`);
  if (p.border && p.border !== 'none') w.push(`with a ${colorWords(p.border).replace(/, see-through$/, '')} border`);
  if (p.shape) w.push(p.shape === 'none' ? 'with no bubble' : `with a ${p.shape === 'rounded_rect' ? 'rounded' : p.shape === 'rect' ? 'rectangle' : p.shape} bubble`);
  return w.join(' ');
};

/** "Use a handwritten font for Leo" with a font the studio lacks: ask with the 3 nearest, and change nothing yet. */
function askFont(doc: ComicDoc, intent: Extract<DialogueIntent, { act: 'restyle' }>, lines: LineHit[], style: LetterStylePatch, scaleBy: number | undefined, unknown: string): CompileOutcome {
  const extras = intent as unknown as RestyleExtras;
  const scope = extras.asKind ? 'kind' : intent.scope;
  let forWords: string;
  let sayTarget: string;
  if (scope === 'speaker') {
    const m = intent.target.speaker ? matchSpeaker(doc, intent.target.speaker) : undefined;
    const ids = m?.status === 'one' ? [m.characterId] : [...new Set(lines.map((h) => h.speakerId).filter((x): x is string => !!x))];
    const name = ids.length === 1 ? speakerName(doc, ids[0]) : undefined;
    forWords = name ? `${name}'s lines` : 'their lines';
    sayTarget = name ? `${name}'s lines` : 'their lines';
  } else if (scope === 'kind') {
    const kind = scopeKind(intent.target, lines, extras);
    forWords = kind ? `every ${KIND_NOUN[kind]}` : 'those balloons';
    sayTarget = kind ? `all the ${KIND_PLURAL[kind]}` : 'them';
  } else if (scope === 'comic') {
    forWords = 'all the lettering';
    sayTarget = 'all the lettering';
  } else {
    forWords = lines.length === 1 ? quote(lines[0].text, 30) : plural(lines.length, 'balloon');
    sayTarget = lines.length === 1 ? quote(lines[0].text, 40) : 'them';
  }
  const { font: _drop, ...rest } = style;
  const restWords = styleSayWords(rest, scaleBy);
  const nearest = fontFromWords(unknown).nearest.slice(0, 3);
  const labels = nearest.map((id) => FONT_REGISTRY[id]?.label ?? id);
  const typed = unknown.trim().slice(0, 40);
  const shown = /\p{Lu}/u.test(typed) ? typed : typed.replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => `${sp}${c.toUpperCase()}`);
  const question = `I don't have a font called “${shown}”. Use ${labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels[0]} for ${forWords} instead?${
    restWords ? ` Nothing changed yet: the ${describeStyle(rest, scaleBy)} comes with the font you pick.` : ''
  }`;
  return asking(
    question,
    labels.map((label) => ({ label: `Use ${label}`, say: `Make ${sayTarget}${restWords ? ` ${restWords}` : ''} in the ${label} font` }))
  );
}

function compileZ(doc: ComicDoc, dir: 'front' | 'back', lines: LineHit[]): CompileOutcome {
  if (inArt(doc)) return nothing(IN_ART_REFUSAL);
  const ops: DocOp[] = [];
  const notes: string[] = [];
  const moved: string[] = [];
  for (const hit of lines) {
    let w = whereOf(doc, hit.lineId);
    if (!w) continue;
    const work = applyOps(doc, ops);
    w = whereOf(work, hit.lineId)!;
    const geo = pageGeo(work, w.page);
    const edit = zOrderEdit(work, w.page, { kind: 'balloon', id: w.line.id }, dir, geo.scene);
    if (edit.ok === false) {
      notes.push(edit.reason === 'It already looks like that.' ? `${quote(w.line.text, 30)} is already at the ${dir}.` : edit.reason);
      continue;
    }
    moved.push(w.line.text);
    for (const op of edit.ops) {
      // A software-placed line gets its complete drawn balloon with the new z (never a half balloon).
      if (op.op === 'balloon') {
        const full = balloonPatchOp(geo, op.lineId, op.patch);
        if (full) ops.push(full);
      } else ops.push(op);
    }
  }
  if (!ops.length) {
    const said = join(...new Set(notes)) ?? 'Nothing to change.';
    return notes.length && notes.every((n) => n.endsWith(`is already at the ${dir}.`)) ? alreadySo(said) : nothing(said);
  }
  const who = whoWords(moved.map((text) => ({ text })), moved.length);
  return result(ops, dir === 'front' ? 'Bring to front' : 'Send to back', [], join(dir === 'front' ? `Brought ${who} to the front.` : `Sent ${who} to the back.`, ...new Set(notes)));
}

function compileLock(doc: ComicDoc, lock: boolean, lines: LineHit[]): CompileOutcome {
  if (inArt(doc)) return nothing(IN_ART_REFUSAL);
  const ops: DocOp[] = [];
  let same = 0;
  for (const hit of lines) {
    const w = whereOf(doc, hit.lineId);
    if (!w) continue;
    const stored = w.page.balloons.find((b) => b.lineId === w.line.id);
    if (!!stored?.locked === lock) {
      same++;
      continue;
    }
    const op = balloonPatchOp(pageGeo(doc, w.page), w.line.id, lock ? { locked: true, pinned: true } : { locked: false });
    if (op) ops.push(op);
  }
  if (!ops.length) return same ? alreadySo(`${lines.length === 1 ? "It's" : "They're"} already ${lock ? 'locked' : 'unlocked'}.`) : nothing('Nothing to change.');
  const who = ops.length === 1 ? quote(lines[0].text, 30) : plural(ops.length, 'balloon');
  return result(
    ops,
    lock ? (ops.length === 1 ? 'Lock balloon' : `Lock ${ops.length} balloons`) : ops.length === 1 ? 'Unlock balloon' : `Unlock ${ops.length} balloons`,
    [],
    lock ? `Locked ${who}: auto-layout and drags won't move ${ops.length === 1 ? 'it' : 'them'}.` : `Unlocked ${who}; ${ops.length === 1 ? 'it stays' : 'they stay'} where ${ops.length === 1 ? 'it is' : 'they are'}.`
  );
}

/** The link / unlink member of the B1 union (it shares one shape with z, lock and unlock). */
type LinkIntent = { act: 'link' | 'unlink'; target: LineRef; other?: LineRef };

function compileLink(doc: ComicDoc, intent: LinkIntent, lines: LineHit[], opts: CompileOptions): CompileOutcome {
  if (inArt(doc)) return nothing(IN_ART_REFUSAL);
  let hits = [...lines];
  if (intent.act === 'link' && hits.length === 1 && intent.other) {
    const w = whereOf(doc, hits[0].lineId);
    const res = resolveLineRef(doc, intent.other, { pageId: w?.page.id, panelN: w?.panel.n, recentPageIds: opts.focus?.recentPageIds });
    if (res.status !== 'lines') return askFrom(doc, res);
    hits = [...hits, ...res.lines.filter((h) => h.lineId !== hits[0].lineId)];
  }
  const ws = hits.map((h) => whereOf(doc, h.lineId)).filter((w): w is Where => !!w);
  if (intent.act === 'unlink') {
    const page = ws[0]?.page;
    if (!page) return nothing('Those lines are not in the comic any more.');
    const ids = new Set(ws.filter((w) => w.page.id === page.id).map((w) => w.line.id));
    const touches = (b: Balloon) => !!b.linkTo && (ids.has(b.lineId) || ids.has(b.linkTo));
    const linked = page.balloons.filter(touches);
    if (!linked.length) return alreadySo(`None of those balloons are linked on page ${page.n}, so nothing changed.`);
    const balloons = page.balloons.map((b) => {
      if (!touches(b)) return b;
      const { linkTo: _drop, ...rest } = b;
      return rest;
    });
    return result([{ op: 'balloons', pageId: page.id, balloons }], 'Unlink balloons', [], `Unlinked ${plural(linked.length, 'balloon')} on page ${page.n}.`);
  }
  if (ws.length < 2) {
    const w = ws[0];
    const others = w ? w.panel.lines.filter((l) => l.id !== w.line.id && l.text.trim()) : [];
    return asking(
      'Link it to which balloon? Linked balloons are consecutive lines in one panel.',
      others.slice(0, 3).map((l) => ({ label: quote(l.text, 24), say: `Join ${quote(w!.line.text, 30)} and ${quote(l.text, 30)}` }))
    );
  }
  const panels = new Set(ws.map((w) => w.panel.id));
  if (panels.size > 1) return nothing(`Linked balloons must be in the same panel; these are in panels ${[...new Set(ws.map((w) => w.panel.n))].join(' and ')}.`);
  const page = ws[0].page;
  const geo = pageGeo(doc, page);
  const order = page.panels.flatMap((p) => p.lines.map((l) => l.id));
  const chain = ws.map((w) => w.line.id).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const ops: DocOp[] = [];
  for (let k = 1; k < chain.length; k++) {
    const stored = page.balloons.find((b) => b.lineId === chain[k]);
    if (stored?.linkTo === chain[k - 1]) continue;
    const op = balloonPatchOp(geo, chain[k], { linkTo: chain[k - 1] });
    if (op) ops.push(op);
  }
  // A chain member with no stored balloon gets its complete drawn balloon too, so the link has two ends.
  if (!page.balloons.some((b) => b.lineId === chain[0])) {
    const op = balloonPatchOp(geo, chain[0], {});
    if (op && op.op === 'balloon' && Object.keys(op.patch).length) ops.unshift(op);
  }
  if (!ops.length) return alreadySo('Those balloons are already linked.');
  return result(ops, 'Link balloons', [], `Linked ${plural(chain.length, 'balloon')} in panel ${ws[0].panel.n} on page ${page.n} with connector necks, in reading order.`);
}

const bare = (s: string): string => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function compileEmphasis(doc: ComicDoc, intent: Extract<DialogueIntent, { act: 'emphasis' }>, lines: LineHit[]): CompileOutcome {
  // "make 'Run!' bold" where the balloon says just "Run!": the whole balloon is the word, so style the balloon.
  if (lines.length === 1 && bare(lines[0].text) && bare(lines[0].text) === bare(intent.words.join(' '))) {
    return compileRestyle(doc, { act: 'restyle', target: intent.target, scope: 'line', style: intent.style === 'italic' ? { italic: true } : { weight: 700 } }, lines);
  }
  // Plan B4's copy: the whole balloon now, single words later (inline runs ship with C-TYPO).
  const q = lines.length === 1 ? quote(lines[0].text, 30) : 'it';
  const italic = intent.style === 'italic';
  return {
    ops: [],
    label: '',
    followUps: [{ label: italic ? 'Italicize the balloon' : 'Bold the balloon', say: `Make ${q} ${italic ? 'italic' : 'bold'}` }],
    note: italic ? "I can italicize the whole balloon now; single-word italics aren't available yet." : "I can bold the whole balloon now; single-word bold isn't available yet."
  };
}

/** A resolution that does not apply as is → the compile result that asks it. */
function askFrom(doc: ComicDoc, res: Resolution): CompileOutcome {
  const ask: ResolutionAsk | undefined = askForResolution(doc, res);
  if (!ask) return nothing('Nothing to change.');
  if (res.status === 'none' && !isPronounResolution(res)) return nothing(ask.question);
  return asking(ask.question, ask.followUps, ask.options);
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** One intent + its resolved lines → free DocOps, an undo label and follow-up chips, with options. */
export function compileWith(doc: ComicDoc, intent: DialogueIntent, lines: LineHit[], opts: CompileOptions = {}): CompileOutcome {
  if (!doc || !intent) return nothing('Nothing to change.');
  const hits = Array.isArray(lines) ? lines : [];
  const wide = intent.act === 'restyle' && intent.scope !== 'line' && !(intent as unknown as RestyleExtras).asKind;
  if (intent.act !== 'add' && !wide && !hits.length) return nothing('No line matched, so nothing was changed.');
  switch (intent.act) {
    case 'set_kind':
      return compileSetKind(doc, intent.kind, hits);
    case 'edit_text':
      return compileEditText(doc, intent.text, hits);
    case 'set_speaker':
      return compileSetSpeaker(doc, intent.speaker, hits);
    case 'add':
      return compileAdd(doc, intent, hits);
    case 'delete':
      return compileDelete(doc, hits);
    case 'move':
      return compileMove(doc, intent.place, hits);
    case 'aim_tail':
      return compileAimTail(doc, intent.to, hits);
    case 'tail_style':
      return compileTailStyle(doc, intent.tail, hits);
    case 'reorder':
      return compileReorder(doc, intent.to, hits, opts, (intent as unknown as ReorderExtras).atIndex);
    case 'swap':
      return compileSwap(doc, hits);
    case 'move_to_panel':
      return compileMoveToPanel(doc, intent.panel, intent.page, hits, opts);
    case 'restyle':
      return compileRestyle(doc, intent, hits);
    case 'z':
      return compileZ(doc, intent.dir === 'back' ? 'back' : 'front', hits);
    case 'lock':
    case 'unlock':
      return compileLock(doc, intent.act === 'lock', hits);
    case 'link':
    case 'unlink':
      return compileLink(doc, intent as LinkIntent, hits, opts);
    case 'emphasis':
      return compileEmphasis(doc, intent, hits);
    default:
      return nothing("That isn't a dialogue edit I know.");
  }
}

/**
 * One intent + its resolved lines → free DocOps, an undo label and follow-up chips (B2 compile.ts; the B4 table).
 * Never invents a speaker.
 */
export function compileIntent(doc: ComicDoc, intent: DialogueIntent, lines: LineHit[]): CompileResult {
  return compileWith(doc, intent, lines);
}

// ── The pipeline ─────────────────────────────────────────────────────────────

/** What a whole instruction (one or more intents) comes to: apply, ask, or nothing matched. All or nothing. */
export interface DialogueRun {
  status: 'apply' | 'ask' | 'none';
  ops: DocOp[];
  /** Undo label ("Make it a whisper · Move balloon"). */
  label: string;
  /** What the reply says (results, fallbacks, refusals, or the question). */
  note?: string;
  followUps: NextStep[];
  /** The question card when status is 'ask'. */
  ask?: CompileAsk;
  /** Each intent with the lines it resolved to (in order) and what the reply says about it. */
  steps: { intent: DialogueIntent; lines: LineHit[]; note?: string }[];
  /** The resolution that stopped the run (which / tap / confirm / none), when one did. */
  resolution?: Resolution;
}

const sameRef = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** "1 of those lines isn't in the comic any more, so it was left out." for explicit ids that name no lettered line. */
const droppedNote = (doc: ComicDoc, refs: (LineRef | undefined)[]): string | undefined => {
  const ids = [...new Set(refs.flatMap((r) => r?.lineIds ?? []))];
  if (!ids.length) return undefined;
  const live = new Set(lineHits(doc).map((h) => h.lineId));
  const missing = ids.filter((id) => !live.has(id));
  if (!missing.length || missing.length === ids.length) return undefined;
  const empty = missing.filter((id) => !!whereOf(doc, id));
  const gone = missing.length - empty.length;
  return join(
    gone ? `${gone} of those lines ${gone === 1 ? "isn't" : "aren't"} in the comic any more, so ${gone === 1 ? 'it was' : 'they were'} left out.` : undefined,
    empty.length ? `${empty.length} of those lines ${empty.length === 1 ? 'has' : 'have'} no words yet, so ${empty.length === 1 ? 'it was' : 'they were'} left out.` : undefined
  );
};

/** Consecutive `line` patches of one line become one op ("Mira should shout 'Run!'" → {kind, text}). */
export const mergeLineOps = (ops: DocOp[]): DocOp[] => {
  const out: DocOp[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (prev && prev.op === 'line' && op.op === 'line' && prev.id === op.id && prev.pageId === op.pageId && prev.panelId === op.panelId && prev.patch && op.patch && prev.index === undefined && op.index === undefined) {
      out[out.length - 1] = { ...prev, patch: { ...prev.patch, ...op.patch } };
      continue;
    }
    out.push(op);
  }
  return out;
};

/** The ref an intent targets (the panel of an `add`). */
const targetOf = (intent: DialogueIntent): LineRef | undefined =>
  intent.act === 'add' ? undefined : intent.act === 'swap' ? intent.a : (intent as { target?: LineRef }).target;

/**
 * Text understood → applied: each intent resolves (selection first, then the creator's view) and compiles against the doc
 * as the earlier intents left it. Any question or empty match stops the run with no ops at all, so an instruction is
 * applied whole or not at all. Free: no model call.
 */
export function compileDialogue(doc: ComicDoc, intents: readonly DialogueIntent[], ctx: DialogueContext = {}): DialogueRun {
  let work = doc;
  const ops: DocOp[] = [];
  const labels: string[] = [];
  const notes: string[] = [];
  let followUps: NextStep[] = [];
  const steps: DialogueRun['steps'] = [];
  const stop = (status: 'ask' | 'none', out: { note?: string; ask?: CompileAsk; followUps?: NextStep[]; resolution?: Resolution }): DialogueRun => ({
    status,
    ops: [],
    label: '',
    ...(out.note ? { note: out.note } : {}),
    followUps: out.followUps ?? [],
    ...(out.ask ? { ask: out.ask } : {}),
    steps,
    ...(out.resolution ? { resolution: out.resolution } : {})
  });
  if (!intents.length) return stop('none', { note: "I didn't find a dialogue edit in that." });
  let prev: { ref: LineRef | undefined; lines: LineHit[] } | undefined;
  for (let i = 0; i < intents.length; i++) {
    let intent = intents[i];
    let lines: LineHit[] = [];
    if (intent.act === 'add') {
      // The panel: numbers in the intent, else the creator's page and panel.
      const focusPage = ctx.pageId ? work.pages.find((p) => p.id === ctx.pageId) : undefined;
      const panelRef: LineRef = { ...(intent.panel ?? {}) };
      if (panelRef.page === 'this' || panelRef.page === undefined) {
        if (focusPage) panelRef.page = focusPage.n;
        else delete panelRef.page;
      }
      if (panelRef.panel === undefined && ctx.panelN !== undefined && focusPage && panelRef.page === focusPage.n) panelRef.panel = ctx.panelN;
      intent = { ...intent, panel: panelRef };
    } else if (intent.act === 'swap') {
      const ra = resolveLineRef(work, intent.a, ctx);
      if (ra.status !== 'lines' && !(ra.status === 'which' && sameRef(intent.a, intent.b) && ra.candidates.length === 2)) return stopFor(work, ra);
      const aLines = ra.status === 'lines' ? ra.lines : ra.status === 'which' ? ra.candidates : [];
      let bLines: LineHit[] = [];
      if (!sameRef(intent.a, intent.b)) {
        const rb = resolveLineRef(work, intent.b, ctx);
        if (rb.status !== 'lines') return stopFor(work, rb);
        bLines = rb.lines;
      }
      lines = [...aLines, ...bLines.filter((h) => !aLines.some((x) => x.lineId === h.lineId))];
    } else {
      const ref = targetOf(intent) ?? {};
      // A kind-, speaker- or comic-wide restyle is one op whatever lines exist today ("make all the shouts red").
      const wide = intent.act === 'restyle' && intent.scope !== 'line' && !(intent as unknown as RestyleExtras).asKind;
      if (prev && prev.lines.length && sameRef(prev.ref, ref)) lines = prev.lines;
      else {
        const res = resolveLineRef(work, ref, ctx);
        if (wide) lines = res.status === 'lines' || res.status === 'confirm' ? res.lines : res.status === 'which' ? res.candidates : [];
        else if (res.status !== 'lines') return stopFor(work, res);
        else lines = res.lines;
      }
    }
    const next = intents[i + 1];
    const offPanelOk =
      intent.act === 'move_to_panel' && !!next && next.act === 'set_speaker' && next.speaker === 'off_panel' && sameRef(next.target, intent.target);
    // "Move it to panel 3 and give it to Bolt": the next step names who says it there, so the move need not ask.
    const speakerFollows =
      intent.act === 'move_to_panel' && !!next && next.act === 'set_speaker' && next.speaker !== 'off_panel' && sameRef(next.target, intent.target);
    const out = compileWith(work, intent, lines, { offPanelOk, speakerFollows, focus: ctx });
    // Never silent about ids that no longer name a lettered line ("1 of those lines isn't in the comic any more").
    const stepNote = join(out.note, out.ask ? undefined : droppedNote(doc, intent.act === 'swap' ? [intent.a, intent.b] : [targetOf(intent)]));
    steps.push({ intent, lines, ...(stepNote ? { note: stepNote } : {}) });
    if (out.ask) return stop('ask', { note: out.note, ask: out.ask, followUps: out.followUps });
    if (!out.ops.length) {
      if (intents.length === 1) return stop('none', { note: stepNote ?? 'Nothing to change.', followUps: out.followUps });
      // A refusal ("there's no character called…", a lock, in-art lettering) stops the whole instruction: all or nothing.
      if (!out.already) {
        const said = stepNote ?? 'That part could not be done.';
        return stop('none', { note: /nothing (?:else )?was (?:changed|added)/i.test(said) ? said : `${said} So nothing was changed.`, followUps: out.followUps });
      }
      // Nothing to do for this part ("it's already a whisper"): say so and carry on with the rest.
      if (stepNote) notes.push(stepNote);
      prev = { ref: targetOf(intent), lines };
      continue;
    }
    ops.push(...out.ops);
    labels.push(out.label);
    if (stepNote) notes.push(stepNote);
    followUps = out.followUps;
    work = applyOps(work, out.ops);
    prev = { ref: targetOf(intent), lines };
  }
  if (!ops.length) return stop('none', { note: notes.join(' ') || 'Nothing to change.' });
  return {
    status: 'apply',
    ops: mergeLineOps(ops),
    label: [...new Set(labels)].join(' · '),
    ...(notes.length ? { note: notes.join(' ') } : {}),
    followUps,
    steps
  };

  function stopFor(d: ComicDoc, res: Resolution): DialogueRun {
    const ask = askForResolution(d, res);
    if (res.status === 'none' && !isPronounResolution(res)) return stop('none', { note: res.note, resolution: res });
    return stop('ask', { note: ask?.question, ask: ask ? { question: ask.question, ...(ask.options ? { options: ask.options } : {}) } : undefined, followUps: ask?.followUps, resolution: res });
  }
}

// ── The fast path (plan §3 B3, flag COMIC_DIALOGUE_FAST) ──────────────────────

/** Op kinds the dialogue engine emits: every one is a free overlay or script edit (no image, no model, no spend). */
export const FREE_DIALOGUE_OPS: ReadonlySet<DocOp['op']> = new Set<DocOp['op']>(['line', 'line_move', 'balloon', 'balloons', 'line_style', 'letter_style']);

/**
 * The free fast path's answer for a sentence, or undefined when the director should take it: the grammar is confident,
 * every intent resolves to exactly one line (an `add`, to one panel), the whole instruction applies, and every op is a
 * free dialogue op. No model call; the caller commits `ops` with origin 'director' and replies with `note` and Undo.
 */
export function dialogueFastPath(doc: ComicDoc, text: string, ctx: ResolveContext = {}): DialogueRun | undefined {
  const g = parseDialogue(text, { selected: !!ctx.lineIds?.length });
  if (!g.confident || !g.intents.length) return undefined;
  const run = compileDialogue(doc, g.intents, ctx);
  if (run.status !== 'apply' || !run.ops.length) return undefined;
  // A kind-, speaker- or comic-wide restyle changes every such line however few are selected: the director takes it.
  const wide = (i: DialogueIntent) => i.act === 'restyle' && (i.scope !== 'line' || !!(i as unknown as RestyleExtras).asKind);
  if (run.steps.some((s) => wide(s.intent))) return undefined;
  if (!run.steps.every((s) => (s.intent.act === 'add' ? s.lines.length === 0 : s.lines.length === 1))) return undefined;
  if (!run.ops.every((op) => FREE_DIALOGUE_OPS.has(op.op))) return undefined;
  return run;
}
