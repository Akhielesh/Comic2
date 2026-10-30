// Comic History — which book sections an op touches, and who made the change (versions plan §4.1–§4.2; H0).
//
// touchedKeys(op, doc?) is the recorder's synchronous bookkeeping in commit(): the actor per section key. Pure and
// cheap (no hashing). Without `doc` the answer is the op's own keys; with the doc it also resolves keys that depend
// on where something lives (the page a translated line is on, the pages a removed character was drawn in).
// Forward-only records (messages, spend, gate, memory, safety, publication, QC/variants, the model lock, settings)
// touch no section and never trigger a capture by themselves.

import type { AssetRef, ComicDoc, RenderTarget } from '../doc.js';
import type { DocOp } from '../ops.js';
import type { OpsOrigin } from '../events.js';
import { ARCHIVE_BLOCK, SECTION_KEYS as K } from './sections.js';
import type { HistoryActor, RestoreSet } from './types.js';

/** Ops that never trigger a capture by themselves (§4.2). */
export const CAPTURE_NEUTRAL_OPS: ReadonlySet<string> = new Set([
  'message', 'message_patch', 'spend', 'gate', 'memory', 'safety', 'asset_meta', 'publication', 'settings'
]);

const targetKey = (t: RenderTarget | undefined): string[] => {
  if (!t || typeof t !== 'object') return [];
  switch (t.kind) {
    case 'page':
      return [K.art(t.id)];
    case 'cover':
      return [K.cover];
    case 'sheet':
      return [K.char(t.id)];
    case 'place':
      return [K.places];
    case 'style_option':
      return [K.option(t.id)];
    default:
      return [];
  }
};

const pageOfLine = (doc: ComicDoc | undefined, lineId: string): string | undefined =>
  doc?.pages.find((p) => p.panels.some((panel) => panel.lines.some((l) => l.id === lineId)))?.id;

const editionLineKeys = (doc: ComicDoc | undefined, lang: string, lineIds: string[]): string[] => {
  const out = new Set<string>();
  for (const id of lineIds) {
    const pageId = pageOfLine(doc, id);
    out.add(pageId ? K.editionPage(lang, pageId) : K.edition(lang));
  }
  return [...out];
};

/** Ship 2: the per-language page keys of every edition holding a balloon override for a line of `pageId`. */
const editionPageKeys = (doc: ComicDoc | undefined, pageId: string): string[] => {
  const page = doc?.pages.find((p) => p.id === pageId);
  if (!page) return [];
  const ids = new Set(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
  return Object.entries(doc?.i18n?.editions || {})
    .filter(([, e]) => Object.keys(e.balloons || {}).some((id) => ids.has(id)) || Object.keys(e.lines || {}).some((id) => ids.has(id)))
    .map(([lang]) => K.editionPage(lang, pageId));
};

/** Keys of every archive block that may change when the archive grows (the newest block, and one more). */
const archiveTail = (doc: ComicDoc | undefined): string[] => {
  const n = doc?.archive?.length ?? 0;
  const last = Math.floor(n / ARCHIVE_BLOCK);
  return [K.archive(Math.max(0, last - 1)), K.archive(last)].filter((k, i, a) => a.indexOf(k) === i);
};

const ownerKey = (owner: unknown): string[] => {
  const o = owner as { kind?: string; id?: string } | undefined;
  if (!o || typeof o !== 'object') return [];
  if (o.kind === 'character' && typeof o.id === 'string') return [K.char(o.id)];
  if (o.kind === 'place') return [K.places];
  if (o.kind === 'style') return [K.style];
  return []; // the composer inbox is never in history
};

/** The section keys a restore set can touch (generous: the recorder only needs an over-approximation). */
export const restoreSetKeys = (set: RestoreSet, doc?: ComicDoc): string[] => {
  const out = new Set<string>();
  if (!set || typeof set !== 'object') return [];
  if (set.brief || set.format || set.planStatus || set.letterStyle || set.book || set.reader || 'planInputHash' in set) out.add(K.meta);
  if (set.source) out.add(K.source);
  if (set.style) out.add(K.style);
  if (set.cover) out.add(K.cover);
  if (set.places || set.placesById) out.add(K.places);
  if (set.glossary) out.add(K.glossary);
  const pageIds = new Set<string>([
    ...(set.pages || []).map((p) => p?.id),
    ...(set.pages ? (doc?.pages || []).map((p) => p.id) : []),
    ...(set.pagesById || []).map((x) => x?.page?.id),
    ...(set.pagesRemove || []),
    ...(set.panels || []).map((x) => x?.pageId),
    ...(set.lines || []).map((x) => x?.pageId)
  ].filter((id): id is string => typeof id === 'string' && !!id));
  for (const id of pageIds) {
    out.add(K.page(id));
    out.add(K.art(id));
  }
  if (set.pages || set.pagesRemove || set.trashAdd || set.pagesById) {
    out.add(K.meta);
    for (const id of pageIds) out.add(K.trash(id));
    for (const t of set.trashAdd || []) if (t?.page?.id) out.add(K.trash(t.page.id));
  }
  for (const c of [...(set.cast || []), ...(set.castById || []).map((x) => x?.character)]) if (c?.id) out.add(K.char(c.id));
  for (const o of [...(set.options || []), ...(set.optionsById || []).map((x) => x?.option)]) if (o?.id) out.add(K.option(o.id));
  for (const [lang, m] of Object.entries(set.editions || {})) {
    out.add(K.edition(lang));
    for (const k of editionLineKeys(doc, lang, Object.keys(m?.lines || {}))) out.add(k);
  }
  if (set.archiveAdd || set.archive || set.pages || set.pagesById || set.cast || set.castById || set.cover) for (const k of archiveTail(doc)) out.add(k);
  return [...out].sort();
};

/** The section keys `op` touches (sorted; [] for forward-only records and unknown ops). Pure. */
export const touchedKeys = (op: DocOp, doc?: ComicDoc): string[] => {
  if (!op || typeof op !== 'object') return [];
  const keys = ((): string[] => {
    switch (op.op) {
      case 'brief':
      case 'note_add':
      case 'format':
      case 'plan_status':
      case 'letter_style':
      case 'book':
      case 'reader':
      case 'plan_input_hash':
        return [K.meta];
      case 'source':
        return [K.source];
      case 'style':
        return [K.style];
      case 'style_option':
        return [K.option(op.id), ...(op.patch?.render?.asset ? archiveTail(doc) : [])];
      case 'style_options_clear':
        return (doc?.style.options || []).map((o) => K.option(o.id));
      case 'character':
        return [K.char(op.id), ...(op.patch?.sheet?.asset ? archiveTail(doc) : [])];
      case 'character_remove':
        return [K.char(op.id), ...(doc?.pages || []).filter((p) => p.panels.some((x) => x.castIds.includes(op.id))).map((p) => K.page(p.id))];
      case 'place':
        return [K.places];
      case 'place_remove':
        return [K.places, ...(doc?.pages || []).filter((p) => p.panels.some((x) => x.placeId === op.id)).map((p) => K.page(p.id))];
      case 'pages': {
        const ids = new Set([...(op.pages || []).map((p) => p?.id), ...(doc?.pages || []).map((p) => p.id)]);
        return [...ids].filter((id): id is string => !!id).flatMap((id) => [K.page(id), K.art(id)]);
      }
      case 'page':
      case 'page_panels':
      case 'line_style':
        return [K.page('pageId' in op ? op.pageId : op.id)];
      case 'panel':
      case 'line_move':
        return [K.page(op.pageId)];
      case 'line': {
        if (op.patch !== null) return [K.page(op.pageId)];
        const langs = Object.keys(doc?.i18n?.editions || {}).filter((l) => {
          const e = doc!.i18n!.editions[l];
          return op.id in e.lines || op.id in e.balloons;
        });
        return [K.page(op.pageId), K.art(op.pageId), ...langs.map((l) => K.editionPage(l, op.pageId))];
      }
      case 'balloons':
      case 'balloon':
        return [K.art(op.pageId)];
      case 'render':
      case 'render_use':
        return [...targetKey(op.target), ...archiveTail(doc)];
      case 'cover':
        return [K.cover];
      case 'pages_reorder':
        return []; // only the manifest's page order changes
      case 'page_insert':
        return [K.page(op.id), K.art(op.id), K.meta];
      case 'page_duplicate':
        return [K.page(op.newId), K.art(op.newId), K.meta, ...Object.keys(doc?.i18n?.editions || {}).map((l) => K.editionPage(l, op.newId))];
      case 'page_delete':
        return [K.page(op.id), K.art(op.id), K.trash(op.id), K.meta, ...archiveTail(doc)];
      case 'page_restore':
        return [K.page(op.id), K.art(op.id), K.trash(op.id), K.meta];
      case 'version_star': {
        if (!doc) return [];
        const hit = (a?: AssetRef) => a?.path === op.path;
        const out: string[] = [];
        doc.pages.forEach((p) => p.render.history.some(hit) && out.push(K.art(p.id)));
        doc.cast.forEach((c) => c.sheet.history.some(hit) && out.push(K.char(c.id)));
        if (doc.places.some((p) => p.sheet.history.some(hit))) out.push(K.places);
        doc.style.options.forEach((o) => o.render.history.some(hit) && out.push(K.option(o.id)));
        if (doc.cover.render.history.some(hit)) out.push(K.cover);
        if ((doc.archive || []).some(hit)) out.push(...archiveTail(doc), ...Array.from({ length: Math.ceil((doc.archive || []).length / ARCHIVE_BLOCK) }, (_, i) => K.archive(i)));
        return out;
      }
      case 'ref_add':
      case 'ref_patch':
      case 'ref_move':
      case 'ref_remove':
        return ownerKey(op.owner);
      case 'ref_transfer':
        return [...ownerKey(op.from), ...ownerKey(op.to)];
      case 'edition': {
        if (op.patch !== null) return [K.edition(op.lang)];
        const pages = (doc?.pages || []).map((p) => K.editionPage(op.lang, p.id));
        return [K.edition(op.lang), ...pages];
      }
      case 'translation':
      case 'edition_balloon':
        return editionLineKeys(doc, op.lang, [op.lineId]);
      case 'translations':
        return editionLineKeys(doc, op.lang, Object.keys(op.lines || {}));
      case 'edition_text':
        return [K.edition(op.lang)];
      case 'glossary_term':
        return [K.glossary];
      case 'history_restore':
        return restoreSetKeys(op.set, doc);
      // --- Ship 2 (K2a; pro plan §5.6): frames, overlays and continuity are page-text fields (by exclusion); cuts and
      //     findings live on the drawing (art); scenes and consistency are book (meta) keys. A frame move (or new cuts)
      //     carries the panel's balloons (art), clipped overlays (page) and translated overrides (edp) along; a
      //     structural edit may re-stamp the drawing (art). ---
      case 'page_frames':
        return [K.page(op.pageId), K.art(op.pageId), ...editionPageKeys(doc, op.pageId)];
      case 'panels_order':
      case 'panel_add':
        return [K.page(op.pageId), K.art(op.pageId)];
      case 'panel_remove':
        return [K.page(op.pageId), K.art(op.pageId), ...editionPageKeys(doc, op.pageId)];
      case 'layer':
      case 'continuity':
        return [K.page(op.pageId)];
      case 'page_cuts':
        // New cuts can move the page's lettering (clipped overlays, balloons, translated overrides) like a frame move.
        return op.moveBalloons === false ? [K.art(op.pageId)] : [K.page(op.pageId), K.art(op.pageId), ...editionPageKeys(doc, op.pageId)];
      case 'finding':
        return [K.art(op.pageId)];
      case 'scene':
      case 'consistency':
        return [K.meta];
      default:
        return []; // forward-only records and ops this build does not know
    }
  })();
  return [...new Set(keys)].sort();
};

// --- Ship 2 (K2a; pro plan §5.6): who made a panels change ---
/** Free software actions: their batches are the editor's ("no AI cost"). */
export const EDITOR_ACTIONS: ReadonlySet<string> = new Set(['panelize_page', 'flatten_page', 'rebind_panels', 'apply_finding']);
/** Paid actions: their batches are the AI's. */
export const AI_ACTIONS: ReadonlySet<string> = new Set(['fix_panel', 'enrich_pages']);
/** Panel ops the server writes as free software when no action names the batch. */
const EDITOR_JOB_OPS: ReadonlySet<string> = new Set(['page_frames', 'page_cuts', 'panels_order', 'panel_add', 'panel_remove', 'layer', 'finding', 'continuity']);

/** Render origins that are AI drawings (a `derived` image is the editor's free fit). */
const AI_RENDER_ORIGINS = new Set(['render', 'edit', 'variation']);
/** Job ops that are AI work by themselves (§4.2). */
const AI_JOB_OPS = new Set(['pages', 'page_panels', 'translations', 'style_option', 'style_options_clear', 'image_model']);

/**
 * Who made this change (§4.2), or null when the op touches no section (forward-only records). user → you;
 * director content ops → ai; job renders that set an AI image, and job pages/panels/translations/style options/
 * model switches → ai; a derived image (fit_render) and balloon re-fits (relayout_balloons) → editor ("no AI cost").
 * Ship 2: `action` (the StudioAction type that produced the batch, when the recorder knows it) puts panelize_page,
 * flatten_page, rebind_panels and apply_finding batches on the editor and fix_panel / enrich_pages on the AI; server
 * panel ops without one are the editor's.
 */
export const opActor = (op: DocOp, origin: OpsOrigin | undefined, doc?: ComicDoc, action?: string): HistoryActor | null => {
  if (!op || typeof op !== 'object') return null;
  // A model switch is an AI change (a before_ai moment) although the lock itself is not a section (§4.2).
  if (op.op === 'image_model') return 'ai';
  if (CAPTURE_NEUTRAL_OPS.has(op.op)) return null;
  if (!touchedKeys(op, doc).length && op.op !== 'pages_reorder') return null;
  // Ship 2: the action that produced the batch decides first (panelize/flatten/rebind/apply a fix → editor; a panel
  // fix or "Add detail" → ai), whoever clicked it.
  if (typeof action === 'string' && EDITOR_ACTIONS.has(action)) return 'editor';
  if (typeof action === 'string' && AI_ACTIONS.has(action)) return 'ai';
  if (origin === 'user') return 'you';
  if (origin === 'director') return 'ai';
  if (op.op === 'render' || op.op === 'style_option' || op.op === 'character') {
    const patch = (op as { patch?: { render?: { origin?: string }; sheet?: { origin?: string }; origin?: string } }).patch;
    const origin2 = patch?.origin ?? patch?.render?.origin ?? patch?.sheet?.origin;
    if (origin2 === 'derived') return 'editor';
    if (origin2 && AI_RENDER_ORIGINS.has(origin2)) return 'ai';
    if (op.op === 'style_option') return 'ai';
  }
  if (AI_JOB_OPS.has(op.op)) return 'ai';
  if (op.op === 'balloons' || op.op === 'balloon') return 'editor';
  if (origin === 'job' && EDITOR_JOB_OPS.has(op.op)) return 'editor';
  if (op.op === 'history_restore') return 'you';
  return origin === 'job' ? 'system' : 'you';
};
