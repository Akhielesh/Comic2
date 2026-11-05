// Feature actions "library" (contract §12.1): use_preset (P1-LIBRARY, wave 1); library_save,
// library_use and import_classic_cast stay honest "not yet" answers until wave 3.
//
// use_preset { presetId, withBoard? } — FREE, software only. Makes a curated preset the comic's
// (drafted) style exactly like the composer's preset grid does, keeps any "never do this" the
// user added, clears a board drawn in another look, aligns the colour mode, and marks the
// `style_presets` card that offered it as picked. Nothing is drawn and nothing is spent.
// withBoard attaches the library's published preview/anchor as the style board only when the
// COMIC_LIBRARY_PRESET_BOARD flag is on (off until a golden-set A/B shows no content bleed).

import { newId, type AssetRef, type Card, type ComicDoc, type Msg, type StyleBible } from '../../../../shared/comic/doc.js';
import type { DocOp, StudioAction } from '../../../../shared/comic/ops.js';
import { LIBRARY_MANIFEST_VERSION, styleAnchorId, stylePreviewId } from '../../../../shared/comic/library.js';
import { STYLE_PRESETS, getStylePreset, type StylePreset } from '../../../../shared/comic/stylePresets.js';
import { COMIC_LIBRARY_PRESET_BOARD } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';
import type { RunActionOptions, StartedAction } from '../jobs.js';
import type { StudioContext } from '../types.js';

type UsePresetAction = Extract<StudioAction, { type: 'use_preset' }>;

/** The "saved by software" line (decisions-final #6). */
export const FREE_NOTE = 'Free — done by the editor, no AI cost.';

/** Source of a published library image usable as a style board (flag-gated; injectable for tests). */
export type PresetBoardLookup = (presetId: string) => Promise<AssetRef | null>;

let boardLookup: PresetBoardLookup = async (presetId) => {
  // Lazy import: the library runner pulls in storage/image clients the action path rarely needs.
  const { createSupabaseLibraryRepo } = await import('../library/repo.js');
  const repo = createSupabaseLibraryRepo();
  for (const id of [styleAnchorId(presetId), stylePreviewId(presetId)]) {
    const row = await repo.getAsset(LIBRARY_MANIFEST_VERSION, id);
    const p = row?.published;
    if (p?.path) return { path: p.path, w: p.w, h: p.h, source: 'library', libraryId: id, at: Date.now() } as AssetRef;
  }
  return null;
};

/** Test hook: replace the board lookup (returns the previous one). */
export const __setPresetBoardLookup = (fn: PresetBoardLookup): PresetBoardLookup => {
  const prev = boardLookup;
  boardLookup = fn;
  return prev;
};

/** Avoid list: the new preset's, plus anything the user added that didn't come from the old preset. */
export const mergedAvoid = (doc: ComicDoc, preset: StylePreset): string[] => {
  const previous = getStylePreset(doc.style.presetId);
  const fromOld = new Set((previous?.avoid || []).map((a) => a.toLowerCase()));
  const own = (doc.style.avoid || []).filter((a) => !fromOld.has(a.toLowerCase()));
  const seen = new Set<string>();
  return [...preset.avoid, ...own].filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);
};

/** The ops that make `preset` the drafted style (same effect as the composer's preset grid). */
export function presetStyleOps(doc: ComicDoc, preset: StylePreset, board?: AssetRef | null): DocOp[] {
  const patch: Partial<Omit<StyleBible, 'options'>> & { board?: AssetRef | null } = {
    status: 'drafted',
    presetId: preset.id,
    name: preset.name,
    spec: preset.spec,
    palette: [...preset.palette],
    linework: preset.linework,
    avoid: mergedAvoid(doc, preset)
  };
  if (board) patch.board = board;
  // null (not undefined) so the clear survives JSON to the client.
  else if (doc.style.board) patch.board = null;
  const ops: DocOp[] = [{ op: 'style', patch: patch as Partial<Omit<StyleBible, 'options'>> }];
  const colorMode = preset.colorMode || 'color';
  if (doc.format.colorMode !== colorMode) ops.push({ op: 'format', patch: { colorMode } });
  return ops;
}

/** Mark the newest style_presets card that offered this preset as picked (message_patch). */
export function pickCardOps(doc: ComicDoc, presetId: string): DocOp[] {
  for (let i = doc.conversation.length - 1; i >= 0; i -= 1) {
    const m = doc.conversation[i];
    const idx = (m.cards || []).findIndex((c) => c.type === 'style_presets' && c.presetIds.includes(presetId));
    if (idx < 0) continue;
    const card = m.cards![idx] as Extract<Card, { type: 'style_presets' }>;
    if (card.picked === presetId) return [];
    const cards = m.cards!.map((c, j) => (j === idx ? { ...card, picked: presetId } : c));
    return [{ op: 'message_patch', id: m.id, patch: { cards } }];
  }
  return [];
}

const drawnPages = (doc: ComicDoc) => doc.pages.filter((p) => p.render.status === 'ready' && !!p.render.asset).length;

export async function runUsePreset(ctx: StudioContext, action: UsePresetAction, opts: RunActionOptions): Promise<StartedAction> {
  const doc = ctx.session.doc;
  const say = (text: string, tone: 'success' | 'info' | 'warn') => {
    if (opts?.collectCard) {
      if (tone !== 'success') opts.collectCard({ type: 'notice', id: newId('card'), tone, text });
      return;
    }
    const card: Card = { type: 'notice', id: newId('card'), tone, text };
    const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), cards: tone === 'success' ? [] : [card] };
    ctx.session.commit([{ op: 'message', msg }], { origin: opts?.origin ?? 'user' });
  };

  const preset = typeof action.presetId === 'string' ? getStylePreset(action.presetId) : undefined;
  if (!preset) {
    const message = `There's no “${String(action.presetId ?? '').slice(0, 40)}” style. The presets are: ${STYLE_PRESETS.map((p) => p.name).join(', ')}.`;
    say(message, 'warn');
    return { outcome: { status: 'blocked', message, code: 'BAD_REQUEST' }, done: Promise.resolve() };
  }

  const already = doc.style.presetId === preset.id && doc.style.spec === preset.spec && doc.style.status !== 'empty';
  const cardOps = pickCardOps(doc, preset.id);
  if (already && !action.withBoard) {
    if (cardOps.length) ctx.session.commit(cardOps, { origin: opts?.origin ?? (opts?.collectCard ? 'director' : 'user') });
    const message = `“${preset.name}” is already this comic's style. ${FREE_NOTE}`;
    return { outcome: { status: 'done', message }, done: Promise.resolve() };
  }

  let board: AssetRef | null = null;
  let boardNote = '';
  if (action.withBoard) {
    if (!COMIC_LIBRARY_PRESET_BOARD) boardNote = ' The preview image is shown for comparison only; your pages follow the written style.';
    else {
      try {
        board = await boardLookup(preset.id);
        if (!board) boardNote = " There's no published preview for it yet, so the written style leads.";
      } catch (err) {
        logger.warn('comic_use_preset_board_lookup_failed', { message: (err as Error)?.message });
        boardNote = " The preview couldn't be loaded, so the written style leads.";
      }
    }
  }

  const drawn = drawnPages(doc);
  const ops = [...(already ? [] : presetStyleOps(doc, preset, board)), ...(already && board ? [{ op: 'style', patch: { board } } as DocOp] : []), ...cardOps];
  ctx.session.commit(ops, { origin: opts?.origin ?? (opts?.collectCard ? 'director' : 'user'), label: `Style: ${preset.name}` });
  const stale = !already && drawn ? ` ${drawn} drawn page${drawn === 1 ? '' : 's'} will show as out of date until redrawn in the new look.` : '';
  const message = `Style set to “${preset.name}”. ${FREE_NOTE}${stale}${boardNote}`;
  say(message, stale ? 'info' : 'success');
  return { outcome: { status: 'done', message }, done: Promise.resolve() };
}

export const LIBRARY_ACTIONS: ActionHandler[] = [
  { type: 'use_preset', spend: false, run: (ctx, action, opts) => runUsePreset(ctx, action as UsePresetAction, opts) } as ActionHandler,
  notAvailableAction<Extract<StudioAction, { type: 'library_save' }>>('library_save', false, "Saving to your library isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'library_use' }>>('library_use', false, "Your library isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'import_classic_cast' }>>('import_classic_cast', false, "Importing a classic comic's cast isn't available yet.")
];
