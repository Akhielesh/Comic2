// DocOps — the only way a ComicDoc changes.
//
// The server applies an op batch, bumps `rev`, persists, and streams the same batch
// to the client (`ops` event), which applies it with the SAME pure function. Ops are
// small and intention-revealing, so the stream is cheap and the client never has to
// diff documents. `applyOps` is immutable: it returns a new doc and never mutates
// its input (React state safe).
//
// StudioAction — direct UI actions that bypass the LLM (button clicks: approve a
// spend, pick a style, render pages, edit a page, manual text edits).

import {
  MAX_CONVERSATION,
  MAX_RENDER_HISTORY,
  MAX_SPEND_ENTRIES,
  emptyRender,
  type AssetRef,
  type Balloon,
  type Box,
  type Brief,
  type Character,
  type ComicDoc,
  type Cover,
  type Format,
  type Gate,
  type Line,
  type Msg,
  type Page,
  type Panel,
  type Place,
  type RenderState,
  type RenderTarget,
  type Settings,
  type Source,
  type SpendEntry,
  type StyleBible,
  type StyleOption
} from './doc.js';

export type DocOp =
  | { op: 'brief'; patch: Partial<Brief> }
  | { op: 'note_add'; text: string }
  | { op: 'format'; patch: Partial<Format> }
  | { op: 'settings'; patch: Partial<Settings> }
  | { op: 'source'; patch: Partial<Source> }
  | { op: 'style'; patch: Partial<Omit<StyleBible, 'options'>> }
  /** Upsert a style option (creates it when the id is new). */
  | { op: 'style_option'; id: string; patch: Partial<StyleOption> }
  | { op: 'style_options_clear' }
  /** Upsert a character (creates it with defaults when the id is new). */
  | { op: 'character'; id: string; patch: Partial<Character> }
  | { op: 'character_remove'; id: string }
  | { op: 'place'; id: string; patch: Partial<Place> }
  | { op: 'place_remove'; id: string }
  /** Replace the whole page plan. */
  | { op: 'pages'; pages: Page[] }
  | { op: 'page'; id: string; patch: Partial<Omit<Page, 'panels' | 'render' | 'balloons'>> }
  | { op: 'page_panels'; id: string; panels: Panel[] }
  | { op: 'panel'; pageId: string; id: string; patch: Partial<Omit<Panel, 'lines'>> }
  /** Upsert (patch) or delete (patch: null) one line of dialogue. */
  | { op: 'line'; pageId: string; panelId: string; id: string; patch: Partial<Line> | null }
  | { op: 'balloons'; pageId: string; balloons: Balloon[] }
  | { op: 'balloon'; pageId: string; lineId: string; patch: Partial<Balloon> }
  /** Patch a render state. Setting `asset` pushes the previous asset into history. */
  | { op: 'render'; target: RenderTarget; patch: Partial<RenderState> }
  | { op: 'cover'; patch: Partial<Omit<Cover, 'render'>> }
  | { op: 'plan_status'; status: ComicDoc['planStatus'] }
  /** Append a message (or replace it when the id already exists). */
  | { op: 'message'; msg: Msg }
  | { op: 'message_patch'; id: string; patch: Partial<Msg> }
  | { op: 'spend'; entry: SpendEntry }
  | { op: 'gate'; gate: Gate | null }
  | { op: 'memory'; text: string };

/** Spend actions — the ones that may be gated. */
export type SpendAction =
  | { type: 'render_style_options'; directions?: { name: string; spec: string }[] }
  | { type: 'render_sheets'; characterIds?: string[]; force?: boolean }
  | { type: 'render_pages'; pageIds?: string[]; force?: boolean }
  | { type: 'edit_page'; pageId: string; instruction: string; region?: Box; panelN?: number }
  | { type: 'render_cover' };

export type StudioAction =
  | SpendAction
  | { type: 'approve_gate'; gateId: string }
  | { type: 'decline_gate'; gateId: string }
  | { type: 'pick_style'; optionId: string }
  | { type: 'plan_pages'; instructions?: string }
  | { type: 'approve_plan' }
  | { type: 'patch'; ops: DocOp[] }
  | { type: 'restore_render'; target: RenderTarget; path: string }
  | { type: 'relayout_balloons'; pageId: string }
  | { type: 'cancel' };

export const SPEND_ACTION_TYPES: ReadonlySet<string> = new Set([
  'render_style_options',
  'render_sheets',
  'render_pages',
  'edit_page',
  'render_cover'
]);

export const isSpendAction = (action: StudioAction): action is SpendAction => SPEND_ACTION_TYPES.has(action.type);

/** Ops a client is allowed to send in a `patch` action (pure content edits — no spend, no renders, no billing). */
export const CLIENT_PATCHABLE_OPS: ReadonlySet<DocOp['op']> = new Set<DocOp['op']>([
  'brief',
  'note_add',
  'format',
  'settings',
  'source',
  'style',
  'character',
  'character_remove',
  'place',
  'place_remove',
  'page',
  'panel',
  'line',
  'balloons',
  'balloon',
  'cover',
  'plan_status'
]);

// ── Pure application ─────────────────────────────────────────────────────────

const pushHistory = (prev: RenderState, nextAsset: AssetRef | undefined): AssetRef[] => {
  if (!prev.asset || !nextAsset || prev.asset.path === nextAsset.path) return prev.history;
  const history = [prev.asset, ...prev.history.filter((a) => a.path !== prev.asset!.path && a.path !== nextAsset.path)];
  return history.slice(0, MAX_RENDER_HISTORY);
};

const patchRender = (prev: RenderState | undefined, patch: Partial<RenderState>): RenderState => {
  const base = prev || emptyRender();
  const next: RenderState = { ...base, ...patch, history: patch.history || base.history };
  if (patch.asset !== undefined) next.history = pushHistory(base, patch.asset);
  return next;
};

const newCharacter = (id: string, patch: Partial<Character>): Character => ({
  id,
  name: patch.name || 'Unnamed',
  tier: patch.tier || 'support',
  look: { summary: '', ...(patch.look || {}) },
  refs: patch.refs || [],
  sheet: patch.sheet || emptyRender(),
  ...(patch.role ? { role: patch.role } : {}),
  ...(patch.personality ? { personality: patch.personality } : {}),
  ...(patch.voice ? { voice: patch.voice } : {})
});

const mapPage = (doc: ComicDoc, id: string, fn: (p: Page) => Page): Page[] =>
  doc.pages.map((p) => (p.id === id ? fn(p) : p));

const mapPanel = (page: Page, id: string, fn: (p: Panel) => Panel): Page => ({
  ...page,
  panels: page.panels.map((p) => (p.id === id ? fn(p) : p))
});

const applyRenderOp = (doc: ComicDoc, target: RenderTarget, patch: Partial<RenderState>): ComicDoc => {
  switch (target.kind) {
    case 'page':
      return { ...doc, pages: mapPage(doc, target.id, (p) => ({ ...p, render: patchRender(p.render, patch) })) };
    case 'cover':
      return { ...doc, cover: { ...doc.cover, render: patchRender(doc.cover.render, patch) } };
    case 'sheet':
      return {
        ...doc,
        cast: doc.cast.map((c) => (c.id === target.id ? { ...c, sheet: patchRender(c.sheet, patch) } : c))
      };
    case 'place':
      return {
        ...doc,
        places: doc.places.map((p) => (p.id === target.id ? { ...p, sheet: patchRender(p.sheet, patch) } : p))
      };
    case 'style_option':
      return {
        ...doc,
        style: {
          ...doc.style,
          options: doc.style.options.map((o) => (o.id === target.id ? { ...o, render: patchRender(o.render, patch) } : o))
        }
      };
    default:
      return doc;
  }
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export const applyOp = (doc: ComicDoc, op: DocOp): ComicDoc => {
  switch (op.op) {
    case 'brief':
      return { ...doc, brief: { ...doc.brief, ...op.patch, notes: op.patch.notes || doc.brief.notes } };
    case 'note_add': {
      const text = op.text.trim();
      if (!text || doc.brief.notes.includes(text)) return doc;
      return { ...doc, brief: { ...doc.brief, notes: [...doc.brief.notes, text].slice(-40) } };
    }
    case 'format':
      return { ...doc, format: { ...doc.format, ...op.patch } };
    case 'settings':
      return { ...doc, settings: { ...doc.settings, ...op.patch } };
    case 'source':
      return { ...doc, source: { ...doc.source, ...op.patch } };
    case 'style':
      return { ...doc, style: { ...doc.style, ...op.patch, options: doc.style.options } };
    case 'style_option': {
      const exists = doc.style.options.some((o) => o.id === op.id);
      const options = exists
        ? doc.style.options.map((o) =>
            o.id === op.id ? { ...o, ...op.patch, render: op.patch.render ? patchRender(o.render, op.patch.render) : o.render } : o
          )
        : [
            ...doc.style.options,
            { id: op.id, name: op.patch.name || 'Style', spec: op.patch.spec || '', render: op.patch.render || emptyRender() }
          ];
      return { ...doc, style: { ...doc.style, options } };
    }
    case 'style_options_clear':
      return { ...doc, style: { ...doc.style, options: [] } };
    case 'character': {
      const exists = doc.cast.some((c) => c.id === op.id);
      if (!exists) return { ...doc, cast: [...doc.cast, newCharacter(op.id, op.patch)] };
      return {
        ...doc,
        cast: doc.cast.map((c) =>
          c.id === op.id
            ? {
                ...c,
                ...op.patch,
                look: op.patch.look ? { ...c.look, ...op.patch.look } : c.look,
                sheet: op.patch.sheet ? patchRender(c.sheet, op.patch.sheet) : c.sheet
              }
            : c
        )
      };
    }
    case 'character_remove':
      return {
        ...doc,
        cast: doc.cast.filter((c) => c.id !== op.id),
        pages: doc.pages.map((p) => ({
          ...p,
          panels: p.panels.map((panel) => ({ ...panel, castIds: panel.castIds.filter((id) => id !== op.id) }))
        }))
      };
    case 'place': {
      const exists = doc.places.some((p) => p.id === op.id);
      if (!exists) {
        const place: Place = {
          id: op.id,
          name: op.patch.name || 'Place',
          look: op.patch.look || '',
          refs: op.patch.refs || [],
          sheet: op.patch.sheet || emptyRender()
        };
        return { ...doc, places: [...doc.places, place] };
      }
      return {
        ...doc,
        places: doc.places.map((p) =>
          p.id === op.id ? { ...p, ...op.patch, sheet: op.patch.sheet ? patchRender(p.sheet, op.patch.sheet) : p.sheet } : p
        )
      };
    }
    case 'place_remove':
      return {
        ...doc,
        places: doc.places.filter((p) => p.id !== op.id),
        pages: doc.pages.map((p) => ({
          ...p,
          panels: p.panels.map((panel) => (panel.placeId === op.id ? { ...panel, placeId: undefined } : panel))
        }))
      };
    case 'pages':
      return {
        ...doc,
        pages: op.pages
          .slice()
          .sort((a, b) => a.n - b.n)
          .map((p, i) => ({ ...p, n: i + 1 }))
      };
    case 'page':
      return { ...doc, pages: mapPage(doc, op.id, (p) => ({ ...p, ...op.patch })) };
    case 'page_panels':
      return {
        ...doc,
        pages: mapPage(doc, op.id, (p) => ({ ...p, panels: op.panels.map((panel, i) => ({ ...panel, n: i + 1 })) }))
      };
    case 'panel':
      return {
        ...doc,
        pages: mapPage(doc, op.pageId, (p) => mapPanel(p, op.id, (panel) => ({ ...panel, ...op.patch })))
      };
    case 'line':
      return {
        ...doc,
        pages: mapPage(doc, op.pageId, (p) => {
          const withLines = mapPanel(p, op.panelId, (panel) => {
            if (op.patch === null) return { ...panel, lines: panel.lines.filter((l) => l.id !== op.id) };
            const exists = panel.lines.some((l) => l.id === op.id);
            const lines = exists
              ? panel.lines.map((l) => (l.id === op.id ? { ...l, ...op.patch } : l))
              : [...panel.lines, { id: op.id, kind: 'speech', text: '', ...op.patch } as Line];
            return { ...panel, lines };
          });
          return op.patch === null
            ? { ...withLines, balloons: withLines.balloons.filter((b) => b.lineId !== op.id) }
            : withLines;
        })
      };
    case 'balloons':
      return { ...doc, pages: mapPage(doc, op.pageId, (p) => ({ ...p, balloons: op.balloons })) };
    case 'balloon':
      return {
        ...doc,
        pages: mapPage(doc, op.pageId, (p) => {
          const exists = p.balloons.some((b) => b.lineId === op.lineId);
          const balloons = exists
            ? p.balloons.map((b) => (b.lineId === op.lineId ? { ...b, ...op.patch } : b))
            : [...p.balloons, { lineId: op.lineId, x: 0.1, y: 0.1, w: 0.28, ...op.patch }];
          return { ...p, balloons };
        })
      };
    case 'render':
      return applyRenderOp(doc, op.target, op.patch);
    case 'cover':
      return { ...doc, cover: { ...doc.cover, ...op.patch, render: doc.cover.render } };
    case 'plan_status':
      return { ...doc, planStatus: op.status };
    case 'message': {
      const exists = doc.conversation.some((m) => m.id === op.msg.id);
      const conversation = exists
        ? doc.conversation.map((m) => (m.id === op.msg.id ? op.msg : m))
        : [...doc.conversation, op.msg];
      return { ...doc, conversation: conversation.slice(-MAX_CONVERSATION) };
    }
    case 'message_patch':
      return {
        ...doc,
        conversation: doc.conversation.map((m) => (m.id === op.id ? { ...m, ...op.patch } : m))
      };
    case 'spend': {
      const usd = Number.isFinite(op.entry.usd) ? Math.max(0, op.entry.usd) : 0;
      const byKind = { ...doc.spend.byKind, [op.entry.kind]: round4((doc.spend.byKind[op.entry.kind] || 0) + usd) };
      return {
        ...doc,
        spend: {
          totalUsd: round4(doc.spend.totalUsd + usd),
          byKind,
          entries: [{ ...op.entry, usd }, ...doc.spend.entries].slice(0, MAX_SPEND_ENTRIES)
        }
      };
    }
    case 'gate':
      return { ...doc, gate: op.gate };
    case 'memory':
      return { ...doc, memory: op.text };
    default:
      return doc;
  }
};

export const applyOps = (doc: ComicDoc, ops: DocOp[], now = Date.now()): ComicDoc => {
  if (!ops.length) return doc;
  const next = ops.reduce(applyOp, doc);
  return { ...next, updatedAt: now };
};
