// Undo — the single inverse implementation (contract §6). Pure.
//
// inverseOps(before, ops) returns ops that, applied after `ops` (on applyOps(before, ops)), restore
// `before` for every CLIENT-PATCHABLE op. Non-patchable ops (message, render, spend…) get no inverse.
// The inverse is computed op by op against the evolving doc and returned in reverse order.
//
// Equality is "wire equality" (R4): shallow-merge ops store `null` for cleared keys and every consumer
// treats null as unset, so an undone doc may carry `key: null` where the original had no key.
//
// Every inverse op is itself CLIENT-PATCHABLE (P2-AMEND), so an undo can always be sent as a `patch`.
// Server-only ops (render, message, plan_input_hash, …) have no inverse: a batch holding one is not undoable.

import {
  bookOf,
  findPage,
  letterStyleOf,
  readerOf,
  getRender,
  trashOf,
  type Balloon,
  type ComicDoc,
  type Line,
  type Page
} from './doc.js';
import { applyOp, CLIENT_PATCHABLE_OPS, type DocOp } from './ops.js';
import { refsOf } from './refs.js';
import { i18nOf } from './i18n.js';

type Rec = Record<string, unknown>;

/** Previous values of every patched key; keys absent before → null (R4). */
const prevValues = (prev: object | undefined, patch: object | null | undefined, skip: readonly string[] = []): Rec => {
  const out: Rec = {};
  const p = (prev || {}) as Rec;
  for (const k of Object.keys(patch || {})) {
    if (skip.includes(k)) continue;
    out[k] = p[k] === undefined ? null : p[k];
  }
  return out;
};
/** Full previous object + null for keys that exist now but did not before. */
const restoreFull = (prev: object | undefined, now: object | undefined): Rec => {
  const out: Rec = { ...((prev || {}) as Rec) };
  for (const k of Object.keys(now || {})) if (!(k in out)) out[k] = null;
  return out;
};

const findLine = (page: Page | undefined, panelId: string, lineId: string): { line: Line; index: number } | undefined => {
  const panel = page?.panels.find((p) => p.id === panelId);
  if (!panel) return undefined;
  const index = panel.lines.findIndex((l) => l.id === lineId);
  return index >= 0 ? { line: panel.lines[index], index } : undefined;
};

const pageCountFix = (before: ComicDoc, after: ComicDoc): DocOp[] =>
  before.format.pageCount !== after.format.pageCount ? [{ op: 'format', patch: { pageCount: before.format.pageCount } }] : [];

/** Inverse ops of ONE op, computed against the doc before it. null = no inverse (non-patchable / not undoable). */
const invertOne = (doc: ComicDoc, op: DocOp): DocOp[] | null => {
  if (!op || !CLIENT_PATCHABLE_OPS.has(op.op)) return null;
  const after = applyOp(doc, op);
  if (after === doc) return [];
  switch (op.op) {
    case 'brief':
      return [{ op: 'brief', patch: prevValues(doc.brief, op.patch) }];
    case 'format':
      return [{ op: 'format', patch: prevValues(doc.format, op.patch) }];
    case 'settings':
      return [{ op: 'settings', patch: prevValues(doc.settings, op.patch) }];
    case 'source':
      return [{ op: 'source', patch: prevValues(doc.source, op.patch) }];
    case 'style':
      return [{ op: 'style', patch: prevValues(doc.style, op.patch, ['options']) }];
    case 'cover':
      return [{ op: 'cover', patch: prevValues(doc.cover, op.patch, ['render']) }];
    case 'note_add':
      return [{ op: 'brief', patch: { notes: doc.brief.notes } }];
    case 'plan_status':
      return [{ op: 'plan_status', status: doc.planStatus }];
    case 'character': {
      const prev = doc.cast.find((c) => c.id === op.id);
      if (!prev) return [{ op: 'character_remove', id: op.id }];
      const patch = prevValues(prev, op.patch, ['sheet', 'id']);
      if (op.patch.look) patch.look = restoreFull(prev.look, after.cast.find((c) => c.id === op.id)?.look);
      return [{ op: 'character', id: op.id, patch }];
    }
    case 'place': {
      const prev = doc.places.find((p) => p.id === op.id);
      if (!prev) return [{ op: 'place_remove', id: op.id }];
      return [{ op: 'place', id: op.id, patch: prevValues(prev, op.patch, ['sheet', 'id']) }];
    }
    case 'character_remove': {
      const index = doc.cast.findIndex((c) => c.id === op.id);
      if (index < 0) return [];
      const restore: DocOp[] = [{ op: 'character', id: op.id, patch: doc.cast[index], index }];
      for (const page of doc.pages)
        for (const panel of page.panels)
          if (panel.castIds.includes(op.id)) restore.push({ op: 'panel', pageId: page.id, id: panel.id, patch: { castIds: panel.castIds } });
      return restore;
    }
    case 'place_remove': {
      const index = doc.places.findIndex((p) => p.id === op.id);
      if (index < 0) return [];
      const restore: DocOp[] = [{ op: 'place', id: op.id, patch: doc.places[index], index }];
      for (const page of doc.pages)
        for (const panel of page.panels)
          if (panel.placeId === op.id) restore.push({ op: 'panel', pageId: page.id, id: panel.id, patch: { placeId: op.id } });
      return restore;
    }
    case 'page': {
      const prev = findPage(doc, op.id);
      return prev ? [{ op: 'page', id: op.id, patch: prevValues(prev, op.patch, ['panels', 'render', 'balloons', 'id']) }] : [];
    }
    case 'panel': {
      const prev = findPage(doc, op.pageId)?.panels.find((p) => p.id === op.id);
      return prev ? [{ op: 'panel', pageId: op.pageId, id: op.id, patch: prevValues(prev, op.patch, ['lines', 'id']) }] : [];
    }
    case 'line': {
      const page = findPage(doc, op.pageId);
      const hit = findLine(page, op.panelId, op.id);
      if (op.patch === null) {
        if (!hit || !page) return [];
        const restore: DocOp[] = [
          { op: 'line', pageId: op.pageId, panelId: op.panelId, id: op.id, patch: hit.line, index: hit.index },
          { op: 'balloons', pageId: op.pageId, balloons: page.balloons }
        ];
        for (const [lang, e] of Object.entries(i18nOf(doc).editions)) {
          if (e.lines[op.id]) restore.push({ op: 'translation', lang, lineId: op.id, patch: e.lines[op.id] });
          if (e.balloons[op.id]) restore.push({ op: 'edition_balloon', lang, lineId: op.id, patch: e.balloons[op.id] });
        }
        return restore;
      }
      if (!hit) return [{ op: 'line', pageId: op.pageId, panelId: op.panelId, id: op.id, patch: null }];
      const restore: DocOp[] = [];
      const plain = prevValues(hit.line, op.patch, ['id', 'style']);
      if (Object.keys(plain).length) restore.push({ op: 'line', pageId: op.pageId, panelId: op.panelId, id: op.id, patch: plain as Partial<Line> });
      if ('style' in op.patch) restore.push({ op: 'line_style', pageId: op.pageId, lineIds: [op.id], mode: 'replace', patch: hit.line.style ?? null });
      return restore;
    }
    case 'line_move': {
      // Back to the panel it came from, at its old position (the panel minus the line is what it was).
      const from = findPage(doc, op.pageId)?.panels.find((p) => p.lines.some((l) => l.id === op.id));
      if (!from) return [];
      return [{ op: 'line_move', pageId: op.pageId, id: op.id, toPanelId: from.id, index: from.lines.findIndex((l) => l.id === op.id) }];
    }
    case 'line_style': {
      const page = findPage(doc, op.pageId);
      if (!page) return [];
      const ids = new Set(op.lineIds);
      const restore: DocOp[] = [];
      for (const panel of page.panels)
        for (const l of panel.lines)
          if (ids.has(l.id)) restore.push({ op: 'line_style', pageId: op.pageId, lineIds: [l.id], mode: 'replace', patch: l.style ?? null });
      return restore;
    }
    case 'letter_style': {
      const prev = letterStyleOf(doc);
      const restore: DocOp[] = [
        { op: 'letter_style', patch: null },
        {
          op: 'letter_style',
          patch: {
            presetId: prev.presetId,
            keepOverrides: true,
            auto: prev.auto ?? null,
            ...(prev.base ? { base: prev.base } : {}),
            ...(prev.kinds ? { kinds: prev.kinds } : {}),
            ...(prev.speakers ? { speakers: prev.speakers } : {}),
            safeMargin: prev.safeMargin ?? null
          }
        }
      ];
      if (prev.auto === undefined) restore.push({ op: 'letter_style', patch: { auto: null } });
      return restore;
    }
    case 'balloon':
    case 'balloons': {
      const page = findPage(doc, op.pageId);
      return page ? [{ op: 'balloons', pageId: op.pageId, balloons: page.balloons as Balloon[] }] : [];
    }
    case 'pages_reorder':
      return [{ op: 'pages_reorder', order: doc.pages.map((p) => p.id) }, ...pageCountFix(doc, after)];
    case 'page_insert':
      return [{ op: 'page_delete', id: op.id, deletedAt: 0, purge: true }, ...pageCountFix(doc, after)];
    case 'page_duplicate': {
      const copy = findPage(after, op.newId);
      const restore: DocOp[] = [];
      if (copy) {
        const ids = copy.panels.flatMap((p) => p.lines.map((l) => l.id));
        for (const [lang, e] of Object.entries(i18nOf(after).editions)) {
          for (const id of ids) {
            if (e.lines[id]) restore.push({ op: 'translation', lang, lineId: id, patch: null });
            if (e.balloons[id]) restore.push({ op: 'edition_balloon', lang, lineId: id, patch: null });
          }
        }
      }
      restore.push({ op: 'page_delete', id: op.newId, deletedAt: 0, purge: true });
      return [...restore, ...pageCountFix(doc, after)];
    }
    case 'page_delete': {
      const page = findPage(doc, op.id);
      if (!page) return [];
      const trashed = trashOf(after).some((t) => t.page.id === op.id);
      return trashed ? [{ op: 'page_restore', id: op.id, n: page.n }, ...pageCountFix(doc, after)] : null;
    }
    case 'page_restore': {
      const entry = trashOf(doc).find((t) => t.page.id === op.id);
      return entry ? [{ op: 'page_delete', id: op.id, deletedAt: entry.deletedAt }, ...pageCountFix(doc, after)] : [];
    }
    case 'book':
      return [{ op: 'book', patch: restoreFull(bookOf(doc), after.book) }];
    case 'reader':
      return [{ op: 'reader', patch: restoreFull(readerOf(doc), after.reader) }];
    case 'render_use': {
      const prev = getRender(doc, op.target)?.asset?.path;
      return prev ? [{ op: 'render_use', target: op.target, path: prev, at: op.at }] : null;
    }
    case 'version_star': {
      // Previous starred state of the first matching entry (every entry with one path shares one flag in practice).
      const all = [
        ...doc.pages.flatMap((p) => p.render.history),
        ...doc.cover.render.history,
        ...doc.cast.flatMap((c) => c.sheet.history),
        ...doc.places.flatMap((p) => p.sheet.history),
        ...doc.style.options.flatMap((o) => o.render.history),
        ...(doc.archive || [])
      ];
      const prev = all.find((v) => v.path === op.path);
      return [{ op: 'version_star', path: op.path, starred: !!prev?.starred }];
    }
    case 'ref_add': {
      return [{ op: 'ref_remove', owner: op.owner, path: op.ref.path }];
    }
    case 'ref_remove': {
      const refs = refsOf(doc, op.owner) || [];
      const index = refs.findIndex((r) => r.path === op.path);
      return index >= 0 ? [{ op: 'ref_add', owner: op.owner, ref: refs[index], index }] : [];
    }
    case 'ref_move': {
      const refs = refsOf(doc, op.owner) || [];
      const index = refs.findIndex((r) => r.path === op.path);
      return index >= 0 ? [{ op: 'ref_move', owner: op.owner, path: op.path, to: index }] : [];
    }
    case 'ref_patch': {
      const refs = refsOf(doc, op.owner) || [];
      const prev = refs.find((r) => r.path === op.path);
      if (!prev) return [];
      const newPath = typeof op.patch.path === 'string' && op.patch.path ? op.patch.path : op.path;
      const patch = prevValues(prev, op.patch);
      if ('path' in op.patch) patch.path = op.path;
      return [{ op: 'ref_patch', owner: op.owner, path: newPath, patch }];
    }
    case 'ref_transfer': {
      const refs = refsOf(doc, op.from) || [];
      const index = refs.findIndex((r) => r.path === op.path);
      return index >= 0 ? [{ op: 'ref_transfer', from: op.to, to: op.from, path: op.path, index }] : [];
    }
    case 'edition': {
      const prev = i18nOf(doc).editions[op.lang];
      if (!prev) return [{ op: 'edition', lang: op.lang, patch: null }];
      if (op.patch !== null) return [{ op: 'edition', lang: op.lang, patch: { register: prev.register } }];
      const restore: DocOp[] = [{ op: 'edition', lang: op.lang, patch: { register: prev.register } }];
      // Client-patchable per-line restores (contract §6; the batch 'translations' op is server-only).
      for (const [lineId, t] of Object.entries(prev.lines)) restore.push({ op: 'translation', lang: op.lang, lineId, patch: t });
      if (prev.cover?.title) restore.push({ op: 'edition_text', lang: op.lang, field: 'cover.title', value: prev.cover.title });
      if (prev.cover?.tagline) restore.push({ op: 'edition_text', lang: op.lang, field: 'cover.tagline', value: prev.cover.tagline });
      if (prev.brief?.title) restore.push({ op: 'edition_text', lang: op.lang, field: 'brief.title', value: prev.brief.title });
      if (prev.brief?.logline) restore.push({ op: 'edition_text', lang: op.lang, field: 'brief.logline', value: prev.brief.logline });
      for (const [lineId, b] of Object.entries(prev.balloons)) restore.push({ op: 'edition_balloon', lang: op.lang, lineId, patch: b });
      return restore;
    }
    case 'translation': {
      const prev = i18nOf(doc).editions[op.lang]?.lines[op.lineId];
      const now = i18nOf(after).editions[op.lang]?.lines[op.lineId];
      return [{ op: 'translation', lang: op.lang, lineId: op.lineId, patch: prev ? (restoreFull(prev, now) as never) : null }];
    }
    case 'edition_text': {
      const e = i18nOf(doc).editions[op.lang];
      const [group, key] = op.field.split('.') as ['cover' | 'brief', string];
      const prev = (e?.[group] as Record<string, never> | undefined)?.[key];
      return [{ op: 'edition_text', lang: op.lang, field: op.field, value: prev ?? null }];
    }
    case 'edition_balloon': {
      const prev = i18nOf(doc).editions[op.lang]?.balloons[op.lineId];
      const now = i18nOf(after).editions[op.lang]?.balloons[op.lineId];
      return [{ op: 'edition_balloon', lang: op.lang, lineId: op.lineId, patch: prev ? (restoreFull(prev, now) as never) : null }];
    }
    case 'glossary_term': {
      const prev = i18nOf(doc).glossary.find((t) => t.id === op.id);
      if (!prev) return [{ op: 'glossary_term', id: op.id, patch: null }];
      const now = i18nOf(after).glossary.find((t) => t.id === op.id);
      if (!now) {
        // Deleted: re-create (appended; glossary order is presentation-only).
        return [{ op: 'glossary_term', id: op.id, patch: prev }];
      }
      const patch = restoreFull(prev, now);
      patch.forms = restoreFull(prev.forms, now.forms);
      return [{ op: 'glossary_term', id: op.id, patch: patch as never }];
    }
    default:
      return null;
  }
};

/** Ops that, applied after `ops` (on applyOps(before, ops)), restore `before` for every CLIENT-PATCHABLE op.
 *  Non-patchable ops in `ops` (message, render, spend…) get no inverse and are ignored.
 *  Computed op by op against the evolving doc, returned in reverse order. Pure. */
export function inverseOps(before: ComicDoc, ops: DocOp[]): DocOp[] {
  let cur = before;
  const groups: DocOp[][] = [];
  for (const op of ops) {
    const inv = invertOne(cur, op);
    if (inv && inv.length) groups.push(inv);
    cur = applyOp(cur, op);
  }
  return groups.reverse().flat();
}

/** True when every patchable op in the batch can be undone exactly (render_use without a previous asset,
 *  purged page deletes and non-patchable ops cannot). */
export function isUndoable(before: ComicDoc, ops: DocOp[]): boolean {
  let cur = before;
  for (const op of ops) {
    if (!CLIENT_PATCHABLE_OPS.has(op.op)) return false;
    if (invertOne(cur, op) === null) return false;
    cur = applyOp(cur, op);
  }
  return true;
}

const LABELS: Partial<Record<DocOp['op'], [string, string?]>> = {
  brief: ['edit the story details'],
  note_add: ['add a note'],
  format: ['change the format'],
  settings: ['change settings'],
  source: ['edit the script'],
  style: ['change the style'],
  character: ['edit a character', 'edit {n} characters'],
  character_remove: ['remove a character', 'remove {n} characters'],
  place: ['edit a place', 'edit {n} places'],
  place_remove: ['remove a place', 'remove {n} places'],
  page: ['edit a page', 'edit {n} pages'],
  panel: ['edit a panel', 'edit {n} panels'],
  line: ['edit a line', 'edit {n} lines'],
  line_move: ['move a line to another panel', 'move {n} lines to other panels'],
  balloons: ['rearrange balloons'],
  balloon: ['move a balloon', 'move {n} balloons'],
  cover: ['edit the cover'],
  plan_status: ['change the plan status'],
  letter_style: ['change the lettering style'],
  pages_reorder: ['reorder pages'],
  page_insert: ['add a page', 'add {n} pages'],
  page_duplicate: ['duplicate a page', 'duplicate {n} pages'],
  page_delete: ['delete a page', 'delete {n} pages'],
  page_restore: ['restore a page', 'restore {n} pages'],
  book: ['change book pages'],
  reader: ['change reader options'],
  render_use: ['switch versions'],
  version_star: ['star a version'],
  ref_add: ['add a reference', 'add {n} references'],
  ref_patch: ['edit a reference', 'edit {n} references'],
  ref_move: ['reorder references'],
  ref_remove: ['remove a reference', 'remove {n} references'],
  ref_transfer: ['move a reference', 'move {n} references'],
  edition: ['change a language edition'],
  translation: ['edit a translation', 'edit {n} translations'],
  edition_text: ['edit a translated title'],
  edition_balloon: ['move a translated balloon', 'move {n} translated balloons'],
  glossary_term: ['edit the glossary']
};

/** Human label for an undo entry ("restyle 3 balloons", "move page 4"). */
export function describeOps(ops: DocOp[]): string {
  const relevant = ops.filter((o) => o && CLIENT_PATCHABLE_OPS.has(o.op));
  if (!relevant.length) return 'change';
  const kinds = [...new Set(relevant.map((o) => o.op))];
  if (kinds.length === 1 && kinds[0] === 'line_style') {
    const n = new Set(relevant.flatMap((o) => (o.op === 'line_style' ? o.lineIds : []))).size;
    return n === 1 ? 'restyle a balloon' : `restyle ${n} balloons`;
  }
  if (kinds.length === 1 && kinds[0] === 'page_delete' && relevant.length === 1) return 'delete a page';
  if (kinds.length === 1) {
    const [one, many] = LABELS[kinds[0]] || ['edit'];
    return relevant.length > 1 && many ? many.replace('{n}', String(relevant.length)) : one;
  }
  const [first] = LABELS[relevant[0].op] || ['edit'];
  return `${first} and ${relevant.length - 1} more ${relevant.length - 1 === 1 ? 'change' : 'changes'}`;
}
