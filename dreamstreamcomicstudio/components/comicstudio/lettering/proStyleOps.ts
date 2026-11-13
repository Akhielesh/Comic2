// The Pro inspector's engine edits (PE-INSPECT; agent-editor plan §3 C1, C2, C7): align to the selection, panel or page
// and distribute (editor/align.ts), Copy / Paste style, saved styles (Save as style, rename, duplicate, use, delete
// folds back) and the Layers restack (zOrderEdit). Pure and tested, like styleOps.ts — split out of it because these read
// the B9 scene engine (editor/scene, align, transform): only the lazily loaded Pro modules (lettering/pro/*, the
// inspector and Layers panels) import this file, so none of it rides in the page editor's Easy-path chunk.
//
// Every edit is a B9 EditResult or plain K2a ops the inspector sends through studio.patch with a label (never
// editActionFor, never studio.act): free, undoable, and one undo entry per intent.

import { newId, type Balloon, type ComicDoc, type Line, type Page } from '../../../shared/comic/doc';
import { applyOp, type DocOp } from '../../../shared/comic/ops';
import { PRO_LETTER_LIMITS } from '../../../shared/comic/limits';
import { buildScene, editOf, NOTHING_TO_CHANGE, refuse, sameBox, sceneObject, zOrderEdit, type EditResult, type PageScene, type SceneObject, type SceneRef } from '../../../shared/comic/editor/scene';
import { alignBoxes, alignEdit, distributeEdit, type AlignMode, type DistributeAxis } from '../../../shared/comic/editor/align';
import { setBoxEdit } from '../../../shared/comic/editor/transform';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { safeAreaBox } from '../../../shared/comic/lettering/place';
import { DEFAULT_LETTERING, DEFAULT_SAFE_MARGIN, foldNamedStyle, foldRefusal, type LetteringStyleOpPatch, type LetterStylePatch, type NamedLetterStyle } from '../../../shared/comic/lettering/style';
import { balloonOp, findLineRef, linesOf, lineStyleOps, type AlignEdge } from './styleOps';

/** Where an align lines things up: the selection's bounds, the first balloon's panel, or the page (its safe area). */
export type AlignTo = 'selection' | 'panel' | 'page';

const ALIGN_MODE: Record<AlignEdge, AlignMode> = { left: 'left', center: 'centre', right: 'right', top: 'top', middle: 'middle', bottom: 'bottom' };
const ALIGN_PAGE_WORD: Record<AlignEdge, string> = {
  left: 'Align to the page’s left edge',
  center: 'Centre on the page',
  right: 'Align to the page’s right edge',
  top: 'Align to the top of the page',
  middle: 'Centre on the page, top to bottom',
  bottom: 'Align to the bottom of the page'
};

/** The page scene the inspector edits: exact outlines from the drawn plans. */
export const sceneFor = (doc: ComicDoc, page: Page, plans: readonly LetterPlan[]): PageScene => buildScene(doc, page, { plans });

const balloonRefs = (lineIds: readonly string[]): SceneRef[] => lineIds.map((id) => ({ kind: 'balloon', id }));

/**
 * Align the selected balloons (editor/align.ts): to the selection's bounds (two or more), to the panel the first one
 * sits in, or to the page. "The page" is its lettering safe area — the edge the placer and the safe-area warning use —
 * so a balloon aligned to the page never lands outside it. Locked balloons stay put.
 */
export function alignToEdit(doc: ComicDoc, page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], edge: AlignEdge, to: AlignTo, aspect: number): EditResult {
  const scene = sceneFor(doc, page, plans);
  const refs = balloonRefs(lineIds);
  if (to !== 'page') return alignEdit(doc, page, refs, ALIGN_MODE[edge], { relativeTo: to, scene });
  const objs = refs.map((r) => sceneObject(scene, r)).filter((o): o is SceneObject => !!o);
  if (!objs.length) return refuse('Pick a balloon to align.');
  if (objs.every((o) => o.locked)) return refuse('Everything you picked is locked.');
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const area = safeAreaBox(typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN, aspect);
  const boxes = alignBoxes(objs.map((o) => o.box), ALIGN_MODE[edge], area);
  const ops: DocOp[] = [];
  objs.forEach((o, i) => {
    if (o.locked || sameBox(o.box, boxes[i], 1e-4)) return;
    const r = setBoxEdit(doc, page, { kind: o.kind, id: o.id }, boxes[i], scene);
    if (r.ok) ops.push(...r.ops);
  });
  return ops.length ? editOf(doc, ops, ALIGN_PAGE_WORD[edge]) : refuse(NOTHING_TO_CHANGE);
}

/** Space three or more balloons evenly across (h) or down (v), the first and last staying put (editor/align.ts). */
export const distributeToEdit = (doc: ComicDoc, page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], axis: DistributeAxis): EditResult =>
  distributeEdit(doc, page, balloonRefs(lineIds), axis, { scene: sceneFor(doc, page, plans) });

// ── Copy style / Paste style (⌘⌥C / ⌘⌥V; C2) ─────────────────────────────────

/** What Copy style holds: the look a line adds on top of the comic's style for its kind, and its saved style. */
export interface StyleClip {
  /** The overrides to paste (its saved style's patch folded in when that link cannot be pasted). */
  patch?: LetterStylePatch;
  /** The saved style it uses (pasted only while Pro fields are writable). */
  styleId?: string;
  /** The line it came from (the label). */
  from: string;
}

const namedOf = (doc: Pick<ComicDoc, 'letterStyle'>, styleId: string | undefined): NamedLetterStyle | undefined => {
  const named = doc.letterStyle?.named;
  return styleId && named && Object.prototype.hasOwnProperty.call(named, styleId) ? named[styleId] : undefined;
};

/**
 * Copy a line's look: its speaker's patch under its own style (what makes it look the way it does beyond its kind),
 * plus the saved style it links to. With `linkable` false (Pro fields not writable), the saved style's patch is folded
 * into the copy instead of the link. Undefined for an unknown line.
 */
export function copyStyleOf(doc: ComicDoc, page: Page, lineId: string, linkable: boolean): StyleClip | undefined {
  const ref = findLineRef(page, lineId);
  if (!ref) return undefined;
  const { line } = ref;
  const speaker = line.speakerId ? doc.letterStyle?.speakers?.[line.speakerId] : undefined;
  const named = namedOf(doc, line.styleId);
  const patch = { ...(!linkable && named ? named.patch : {}), ...(speaker || {}), ...(line.style || {}) } as LetterStylePatch;
  return {
    ...(Object.keys(patch).length ? { patch } : {}),
    ...(linkable && named && line.styleId ? { styleId: line.styleId } : {}),
    from: line.id
  };
}

/**
 * Paste a copied look onto lines: each takes exactly the copied overrides (`line_style` replace, or a clear when there
 * are none), in one op for the lot. The patch passes `clean` first (the inspector strips the Pro fields while they are
 * not writable). With `linkable`, the saved-style link follows too (`line {styleId}`, null to unlink).
 */
export function pasteStyleOps(
  doc: ComicDoc,
  page: Page,
  lineIds: readonly string[],
  clip: StyleClip,
  opts: { linkable: boolean; clean?: (p: LetterStylePatch | undefined) => LetterStylePatch | undefined }
): DocOp[] {
  const lines = linesOf(page, lineIds).filter((l) => l.id !== clip.from);
  if (!lines.length) return [];
  const patch = opts.clean ? opts.clean(clip.patch) : clip.patch;
  const same = (l: Line) => JSON.stringify(l.style ?? null) === JSON.stringify(patch ?? null);
  const restyle = lines.filter((l) => !same(l)).map((l) => l.id);
  const ops: DocOp[] = restyle.length ? lineStyleOps(page.id, restyle, patch ?? null, patch ? 'replace' : undefined) : [];
  if (opts.linkable) {
    const want = clip.styleId && namedOf(doc, clip.styleId) ? clip.styleId : undefined;
    for (const l of lines) if ((l.styleId ?? undefined) !== want) ops.push(lineLinkOp(page, l.id, want ?? null));
  }
  return ops;
}

// ── Named styles (C7: Save as style, list, rename, duplicate, delete folds back) ──

const lineLinkOp = (page: Page, lineId: string, styleId: string | null): DocOp => {
  const ref = findLineRef(page, lineId)!;
  // null unlinks (the line op merges its patch; the wire type has no null, hence the cast).
  return { op: 'line', pageId: page.id, panelId: ref.panel.id, id: lineId, patch: { styleId } as unknown as Partial<Line> };
};

/** A `letter_style` op over saved styles: an entry upserts that style, null deletes it. */
export const namedStyleOp = (named: Record<string, NamedLetterStyle | null>): DocOp =>
  ({ op: 'letter_style', patch: { named } as unknown as LetteringStyleOpPatch }) as DocOp;

/** The saved styles in stored order, with how many live lines use each. */
export function namedStylesOf(doc: Pick<ComicDoc, 'letterStyle' | 'pages'>): { id: string; name: string; patch: LetterStylePatch; uses: number }[] {
  const named = doc.letterStyle?.named;
  if (!named) return [];
  const uses = new Map<string, number>();
  for (const p of doc.pages) for (const panel of p.panels) for (const l of panel.lines) if (l.styleId) uses.set(l.styleId, (uses.get(l.styleId) ?? 0) + 1);
  return Object.entries(named)
    .filter(([, v]) => !!v && typeof v.name === 'string')
    .map(([id, v]) => ({ id, name: v.name, patch: v.patch || {}, uses: uses.get(id) ?? 0 }));
}

/** A style name as it is stored: trimmed, one line, at most PRO_LETTER_LIMITS.namedNameChars. */
export const cleanStyleName = (name: string): string => name.replace(/\s+/g, ' ').trim().slice(0, PRO_LETTER_LIMITS.namedNameChars).trim();

/** A name nothing else is called ("Villain", "Villain 2", …). */
export const uniqueStyleName = (doc: Pick<ComicDoc, 'letterStyle' | 'pages'>, want: string, exceptId?: string): string => {
  const base = cleanStyleName(want) || 'Style';
  const taken = new Set(namedStylesOf(doc).filter((s) => s.id !== exceptId).map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const tail = ` ${n}`;
    const cand = `${base.slice(0, PRO_LETTER_LIMITS.namedNameChars - tail.length).trimEnd()}${tail}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return base;
};

/** The keys a speaker's patch decides (later in the cascade than a saved style, so they must stay on the line). */
const speakerKeys = (doc: ComicDoc, line: Line): Set<string> => {
  const sp = line.speakerId ? doc.letterStyle?.speakers?.[line.speakerId] : undefined;
  return new Set(Object.entries(sp || {}).filter(([, v]) => v !== undefined).map(([k]) => k));
};

/**
 * "Save as style…": the line's overrides (over any saved style it already uses) become a new saved style, and the line
 * links to it. Keys its speaker's patch also sets stay on the line, so the cascade (… → named → speakers → line) draws
 * it exactly as before. [] at the PRO_LETTER_LIMITS.namedStyles cap or for an unknown line.
 */
export function saveNamedStyleOps(doc: ComicDoc, page: Page, lineId: string, name: string, id = newId('st')): DocOp[] {
  const ref = findLineRef(page, lineId);
  if (!ref || namedStylesOf(doc).length >= PRO_LETTER_LIMITS.namedStyles) return [];
  const { line } = ref;
  const prior = namedOf(doc, line.styleId);
  const patch = { ...(prior?.patch || {}), ...(line.style || {}) } as LetterStylePatch;
  const ops: DocOp[] = [namedStyleOp({ [id]: { name: uniqueStyleName(doc, name), patch } }), lineLinkOp(page, lineId, id)];
  if (line.style) {
    const keep = speakerKeys(doc, line);
    const rest = Object.fromEntries(Object.entries(line.style).filter(([k]) => keep.has(k))) as LetterStylePatch;
    ops.push(...lineStyleOps(page.id, [lineId], Object.keys(rest).length ? rest : null, Object.keys(rest).length ? 'replace' : undefined));
  }
  return ops;
}

/** "Update from this balloon" (Adobe's redefine): the line's overrides join the saved style it uses; every line that
 *  uses it restyles (linked styles, C7). Speaker-decided keys stay on the line, as in Save. */
export function redefineNamedStyleOps(doc: ComicDoc, page: Page, lineId: string): DocOp[] {
  const ref = findLineRef(page, lineId);
  const styleId = ref?.line.styleId;
  const style = namedOf(doc, styleId);
  if (!ref || !styleId || !style || !ref.line.style) return [];
  const keep = speakerKeys(doc, ref.line);
  const rest = Object.fromEntries(Object.entries(ref.line.style).filter(([k]) => keep.has(k))) as LetterStylePatch;
  return [
    namedStyleOp({ [styleId]: { name: style.name, patch: { ...style.patch, ...ref.line.style } } }),
    ...lineStyleOps(page.id, [lineId], Object.keys(rest).length ? rest : null, Object.keys(rest).length ? 'replace' : undefined)
  ];
}

/** Rename a saved style (its look and its lines stay). */
export function renameNamedStyleOps(doc: ComicDoc, styleId: string, name: string): DocOp[] {
  const style = namedOf(doc, styleId);
  const next = cleanStyleName(name);
  if (!style || !next || next === style.name) return [];
  return [namedStyleOp({ [styleId]: { name: uniqueStyleName(doc, next, styleId), patch: style.patch } })];
}

/** Duplicate a saved style ("Villain copy"); no line uses the copy yet. [] at the cap. */
export function duplicateNamedStyleOps(doc: ComicDoc, styleId: string, id = newId('st')): DocOp[] {
  const style = namedOf(doc, styleId);
  if (!style || namedStylesOf(doc).length >= PRO_LETTER_LIMITS.namedStyles) return [];
  return [namedStyleOp({ [id]: { name: uniqueStyleName(doc, `${style.name} copy`), patch: { ...style.patch } } })];
}

/** Link the selected lines to a saved style, or unlink them (null). */
export function useNamedStyleOps(doc: ComicDoc, page: Page, lineIds: readonly string[], styleId: string | null): DocOp[] {
  if (styleId && !namedOf(doc, styleId)) return [];
  return linesOf(page, lineIds)
    .filter((l) => (l.styleId ?? null) !== styleId)
    .map((l) => lineLinkOp(page, l.id, styleId));
}

/**
 * The style a line keeps when its saved style is deleted: the saved patch folded into its own style, wherever nothing
 * later in the cascade (its own style, its speaker's patch) already decides the key — so it draws exactly as before
 * (C7: "deleting a style folds its patch back, so nothing changes visually").
 */
export function foldedStyleOf(doc: ComicDoc, line: Line, styleId: string): LetterStylePatch | undefined {
  const style = namedOf(doc, styleId);
  if (!style || line.styleId !== styleId) return line.style;
  const own = new Set(Object.entries(line.style || {}).filter(([, v]) => v !== undefined).map(([k]) => k));
  const sp = speakerKeys(doc, line);
  const add = Object.fromEntries(Object.entries(style.patch || {}).filter(([k, v]) => v !== undefined && !own.has(k) && !sp.has(k)));
  const out = { ...(line.style || {}), ...add };
  return Object.keys(out).length ? (out as LetterStylePatch) : undefined;
}

/**
 * Why a saved style cannot be deleted now (PE-LETTER foldRefusal: a balloon's folded style would be too big), as one calm
 * sentence, or undefined. Checked before the delete batch, so a refused delete sends nothing (PE-LETTER wave note 25).
 */
export function deleteNamedStyleRefusal(doc: ComicDoc, styleId: string): string | undefined {
  if (!namedOf(doc, styleId)) return undefined;
  return foldRefusal(foldNamedStyle(doc, styleId));
}

/**
 * Delete a saved style in ONE undo entry, folded by the shared rule (shared/comic/lettering/style.ts foldNamedStyle,
 * PE-LETTER wave note 14): every live line that uses it keeps its look (one `line_style` replace with its folded style),
 * is unlinked (`line {styleId: null}`), then the style goes (`letter_style {named: {id: null}}`). Nothing when the fold
 * is refused (deleteNamedStyleRefusal says why).
 */
export function deleteNamedStyleOps(doc: ComicDoc, styleId: string): DocOp[] {
  if (!namedOf(doc, styleId)) return [];
  const folded = foldNamedStyle(doc, styleId);
  if (foldRefusal(folded)) return [];
  const ops: DocOp[] = [];
  for (const f of folded) {
    const page = doc.pages.find((p) => p.id === f.pageId);
    if (!page) continue;
    const style = f.style ?? null;
    ops.push(...lineStyleOps(page.id, [f.lineId], style, style ? 'replace' : undefined));
    ops.push(lineLinkOp(page, f.lineId, null));
  }
  ops.push(namedStyleOp({ [styleId]: null }));
  return ops;
}

// ── Layers: restack within the lettering band (zOrderEdit) ───────────────────

/**
 * Restack a balloon so it draws just in front of `overId` (when it was behind it) or just behind it (when it was in
 * front): repeated zOrderEdit steps within the lettering band (never across bands, so lettering stays on top). The
 * result is one edit with the final z; a line the software placed (no stored balloon) gets its whole drawn balloon so
 * the restack never moves it.
 */
export function restackEdit(
  doc: ComicDoc,
  page: Page,
  plans: readonly LetterPlan[],
  lineId: string,
  overId: string,
  resolved: ReadonlyMap<string, Balloon>
): EditResult {
  if (lineId === overId) return refuse(NOTHING_TO_CHANGE);
  const ref: SceneRef = { kind: 'balloon', id: lineId };
  const order = (d: ComicDoc, p: Page) => sceneFor(d, p, plans).objects.filter((o) => o.kind === 'balloon').map((o) => o.id);
  const start = order(doc, page);
  if (!start.includes(lineId) || !start.includes(overId)) return refuse('That is not on this page.');
  const forward = start.indexOf(lineId) < start.indexOf(overId);
  let cur = doc;
  let curPage = page;
  let last: EditResult | undefined;
  for (let i = 0; i < start.length; i++) {
    const now = order(cur, curPage);
    const done = forward ? now.indexOf(lineId) > now.indexOf(overId) : now.indexOf(lineId) < now.indexOf(overId);
    if (done) break;
    const r = zOrderEdit(cur, curPage, ref, forward ? 'forward' : 'backward', sceneFor(cur, curPage, plans));
    if (!r.ok) return last?.ok ? last : r;
    last = r;
    cur = r.ops.reduce(applyOp, cur);
    curPage = cur.pages.find((p) => p.id === page.id) ?? curPage;
  }
  if (!last || !last.ok) return refuse(NOTHING_TO_CHANGE);
  const zOp = last.ops.find((o): o is Extract<DocOp, { op: 'balloon' }> => o.op === 'balloon');
  const z = zOp?.patch.z;
  if (typeof z !== 'number') return refuse(NOTHING_TO_CHANGE);
  return editOf(doc, [balloonOp(page, lineId, { z }, resolved)], last.label);
}
