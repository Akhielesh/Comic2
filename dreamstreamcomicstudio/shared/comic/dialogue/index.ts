// Dialogue understanding: the pipeline (agent-editor plan §3 B2). STUBS with final names and signatures (K3 contract):
// wave 1 B-RESOLVE replaces each body in place (or re-exports it from grammar.ts / resolve.ts / speakers.ts /
// placement.ts / compile.ts). Pure and free: no model call, no I/O. Until then every stub answers "not understood",
// so callers fall back to the director exactly as today.

import type { ComicDoc, Pos9 } from '../doc.js';
import type {
  CompileResult,
  DialogueIntent,
  GrammarResult,
  LineHit,
  LineRef,
  Placement,
  PlacementResult,
  Resolution,
  ResolveContext,
  SpeakerMatch
} from './types.js';

export * from './types.js';

/** What every stub says when it is asked (honest: the dialogue engine is not built yet). */
export const DIALOGUE_NOT_READY = "Dialogue understanding isn't available yet.";

/**
 * Sentence → intents (B2 grammar.ts): splits run-ons on "and / then / also", drops fillers, maps kind, look, position
 * and ordinal words. `selected`: the creator has balloons selected (deixis resolves to them).
 * STUB: understands nothing ({ intents: [], confident: false }).
 */
export function parseDialogue(text: string, opts: { selected?: boolean } = {}): GrammarResult {
  void text;
  void opts;
  return { intents: [], confident: false };
}

/**
 * LineRef → lines (B2 resolve.ts): selection wins; quoted text, speaker, kind, ordinal and `which` narrow; scope widens
 * only when empty (focus panel → focus page → recent pages → whole comic); plurals apply to every match.
 * STUB: { status: 'none' } with DIALOGUE_NOT_READY.
 */
export function resolveLineRef(doc: ComicDoc, ref: LineRef, ctx: ResolveContext = {}): Resolution {
  void doc;
  void ref;
  void ctx;
  return { status: 'none', note: DIALOGUE_NOT_READY };
}

/**
 * Name / kind word / pronoun → cast id (B2 speakers.ts): exact id, exact name, unique first or last name, unique 3+ letter
 * prefix, cast kind word ("the robot"), pronoun → the selected line's speaker. Resolves only on ONE candidate.
 * STUB: { status: 'none' }.
 */
export function matchSpeaker(doc: ComicDoc, name: string, ctx: { pronounOf?: string } = {}): SpeakerMatch {
  void doc;
  void name;
  void ctx;
  return { status: 'none' };
}

/**
 * Where a balloon goes (B2 placement.ts): the panel box or the page safe area, a full-width edge bar, beside a head or
 * mouth mark (falling back to the staging, with a note), between two heads, or a nudge (0.02 "a bit", 0.08 "a lot").
 * STUB: null (no position computed).
 */
export function placementFor(doc: ComicDoc, pageId: string, lineId: string, place: Placement): PlacementResult | null {
  void doc;
  void pageId;
  void lineId;
  void place;
  return null;
}

/** The box of one of the nine cells of a page-normalized frame (B2 placement.ts helper). STUB: null. */
export function cellBox(frame: { x: number; y: number; w: number; h: number }, cell: Pos9): { x: number; y: number } | null {
  void frame;
  void cell;
  return null;
}

/**
 * One intent + its resolved lines → free DocOps, an undo label and follow-up chips (B2 compile.ts; the B4 table).
 * Never invents a speaker. STUB: no ops, with DIALOGUE_NOT_READY as the note.
 */
export function compileIntent(doc: ComicDoc, intent: DialogueIntent, lines: LineHit[]): CompileResult {
  void doc;
  void intent;
  void lines;
  return { ops: [], label: '', followUps: [], note: DIALOGUE_NOT_READY };
}
