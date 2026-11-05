// Dialogue understanding: the vocabulary (agent-editor plan §3 B1; K3 contract, FROZEN for wave 1).
//
// "Say anything freely": a sentence (or the director's dialogue_edit arguments) becomes DialogueIntent[]; each intent's
// LineRef resolves deterministically to 0, 1 or N lines; one line compiles to free DocOps, several ask "Which line?".
// Types only: the pipeline (grammar → resolve → compile, placement, speakers) lives in ./index.ts and its wave-1
// modules (B-RESOLVE).

import type { LineKind, NextStep, Pos9 } from '../doc.js';
import type { DocOp } from '../ops.js';
import type { LetterStylePatch, TailStyle } from '../lettering/style.js';

export type { Pos9 };

/** Which line(s) the creator means (B1). Every field narrows; none set = the selection, then the focus panel/page. */
export interface LineRef {
  /** this / that / these / it (with a selection). */
  selected?: boolean;
  page?: number | 'this';
  panel?: number | 'first' | 'last';
  /** Fuzzy: "Mira", "the robot", "her mom" (speakers.ts resolves it on a single candidate only). */
  speaker?: string;
  kind?: LineKind;
  textContains?: string;
  lineIds?: string[];
  /** "her second line", "the last bubble". */
  nth?: number | 'first' | 'last';
  which?: 'top' | 'bottom' | 'left' | 'right' | 'biggest';
}

/** Where a balloon goes (B1). `edge` is a full-width caption bar; `nudge` + `amount` are relative moves. */
export interface Placement {
  frame: 'panel' | 'page';
  cell?: Pos9;
  edge?: 'top' | 'bottom';
  /** A cast name or a cast kind word ("Mira", "the robot"). */
  near?: string;
  relation?: 'above' | 'below' | 'left' | 'right' | 'near' | 'between';
  /** The second character of "between them". */
  and?: string;
  nudge?: 'up' | 'down' | 'left' | 'right';
  amount?: 'bit' | 'lot';
}

/** Every dialogue act (B1), in the order of the union below. */
export const DIALOGUE_ACTS = [
  'set_kind', 'edit_text', 'set_speaker', 'add', 'delete', 'move', 'aim_tail', 'tail_style', 'reorder', 'swap', 'move_to_panel',
  'restyle', 'z', 'lock', 'unlock', 'link', 'unlink', 'emphasis'
] as const;
export type DialogueAct = (typeof DIALOGUE_ACTS)[number];

/** One understood dialogue edit (B1). `emphasis` is answered honestly until inline runs ship (C-TYPO, wave 3). */
export type DialogueIntent =
  | { act: 'set_kind'; target: LineRef; kind: LineKind }
  | { act: 'edit_text'; target: LineRef; text: string }
  | { act: 'set_speaker'; target: LineRef; speaker: string | 'off_panel' }
  | { act: 'add'; panel: LineRef; kind: LineKind; speaker?: string; text?: string; place?: Placement }
  | { act: 'delete'; target: LineRef }
  | { act: 'move'; target: LineRef; place: Placement }
  | { act: 'aim_tail'; target: LineRef; to: string | 'mouth' }
  | { act: 'tail_style'; target: LineRef; tail: TailStyle }
  | { act: 'reorder'; target: LineRef; to: 'first' | 'last' | { before: LineRef } | { after: LineRef } }
  | { act: 'swap'; a: LineRef; b: LineRef }
  | { act: 'move_to_panel'; target: LineRef; panel: number; page?: number }
  | { act: 'restyle'; target: LineRef; scope: 'line' | 'kind' | 'speaker' | 'comic'; style: LetterStylePatch }
  | { act: 'z' | 'lock' | 'unlock' | 'link' | 'unlink'; target: LineRef; dir?: 'front' | 'back'; other?: LineRef }
  | { act: 'emphasis'; target: LineRef; words: string[]; style: 'bold' | 'italic' };

/** What the deterministic grammar made of a sentence (B2 grammar.ts). The fast path runs only when `confident`. */
export interface GrammarResult {
  intents: DialogueIntent[];
  /** Every clause was understood and nothing is left over. */
  confident: boolean;
  /** Words the grammar could not place (the director reads them). */
  rest?: string;
}

/** Where the resolver looks: the creator's selection and view, and the pages touched in the last two turns. */
export interface ResolveContext {
  /** Selected balloons (StudioFocus.lineIds). */
  lineIds?: string[];
  pageId?: string;
  panelN?: number;
  /** Pages the last two turns changed (A2 recentCommits), the third widening step before the whole comic. */
  recentPageIds?: string[];
}

/** One line a LineRef can mean, with what the "Which line?" chip and the honest reply quote. */
export interface LineHit {
  lineId: string;
  pageId: string;
  panelId: string;
  pageN: number;
  panelN: number;
  kind: LineKind;
  speakerId?: string;
  text: string;
}

/**
 * The resolver's answer (B2 resolve.ts step 5–6): apply (`lines`: one, or every match of a plural), ask "Which line?"
 * (2–5 candidates), ask to tap the balloon (> 5), confirm a big plural edit (> 20 lines or > 3 pages), or say honestly
 * that nothing matched (`note`: the inventory, as tools/lettering.ts noMatch words it).
 */
export type Resolution =
  | { status: 'lines'; lines: LineHit[] }
  | { status: 'which'; candidates: LineHit[] }
  | { status: 'tap'; count: number; pageId?: string }
  | { status: 'confirm'; lines: LineHit[]; pages: number }
  | { status: 'none'; note: string };

/** A fuzzy speaker match (B2 speakers.ts): one cast id, the candidates to ask about, or none. */
export type SpeakerMatch = { status: 'one'; characterId: string } | { status: 'many'; characterIds: string[] } | { status: 'none' };

/** A computed balloon position (B2 placement.ts): the page-normalized box, and a sentence when it fell back. */
export interface PlacementResult {
  x: number;
  y: number;
  w?: number;
  /** "Placed by the staging: no head mark for Mira on this page" (never silent about a fallback). */
  note?: string;
}

/** An intent compiled against resolved lines (B2 compile.ts): free ops, the undo label, and follow-up chips (A4). */
export interface CompileResult {
  ops: DocOp[];
  label: string;
  followUps: NextStep[];
  /** What the reply must say (an honest refusal, a fallback, "bottom of panel 2; say 'of the page' for the page"). */
  note?: string;
}
