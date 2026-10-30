// Comic History — compare (versions plan §5; package H0). Free: no AI, no pixel reads. Pure and shared, so the
// client and the server agree on what "changed" means.
//
// The semantic filter: QC reports, size variants and safety verdicts never count as a change (a re-checked verdict
// or a new 480w variant makes a new stored chunk, but the creator never sees "changed" for it). Art "changed"
// means the drawing itself (the current image) or its lettering geometry changed — not the older-versions list.

import { stableStringify } from '../hash.js';
import { i18nOf } from '../i18n.js';
import type { Balloon, ComicDoc, Line, Page, Panel, RenderState, TextTranslation } from '../doc.js';
import { manifestKeyHashes } from './sections.js';
import type { BookDiff, EditionDiff, EntityDiff, LineDiff, Manifest, ManifestDiff, PageDiff, PanelDiff, WordDiffPart } from './types.js';

// ── Manifests ────────────────────────────────────────────────────────────────

/** Keys added / removed / changed a → b, plus pages that moved — from the manifests alone (no body loads). */
export const diffManifests = (a: Manifest, b: Manifest): ManifestDiff => {
  const ha = manifestKeyHashes(a);
  const hb = manifestKeyHashes(b);
  const added = Object.keys(hb).filter((k) => !(k in ha)).sort();
  const removed = Object.keys(ha).filter((k) => !(k in hb)).sort();
  const changed = Object.keys(hb).filter((k) => k in ha && ha[k] !== hb[k]).sort();
  const orderA = (a.pages || []).map(([id]) => id);
  const orderB = (b.pages || []).map(([id]) => id);
  const common = orderA.filter((id) => orderB.includes(id));
  const commonB = orderB.filter((id) => orderA.includes(id));
  const moved = common.filter((id, i) => commonB[i] !== id);
  return { added, removed, changed, moved, same: !added.length && !removed.length && !changed.length && !moved.length };
};

// ── Words ────────────────────────────────────────────────────────────────────

/** Above this many token pairs the word diff gives up on alignment (whole delete + add). */
const MAX_LCS_CELLS = 250_000;

const tokens = (s: string): string[] => (typeof s === 'string' && s ? s.match(/\s+|[^\s]+/g) || [] : []);

/** Word-level diff (LCS over words and whitespace runs). Joining the 'same' + 'del' parts gives a; 'same' + 'add' gives b. */
export const diffWords = (a: string, b: string): WordDiffPart[] => {
  const x = tokens(a);
  const y = tokens(b);
  const out: WordDiffPart[] = [];
  const push = (op: WordDiffPart['op'], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  if (x.length * y.length > MAX_LCS_CELLS) {
    push('del', x.join(''));
    push('add', y.join(''));
    return out;
  }
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push('same', x[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', x[i]);
      i += 1;
    } else {
      push('add', y[j]);
      j += 1;
    }
  }
  while (i < n) push('del', x[i++]);
  while (j < m) push('add', y[j++]);
  return out;
};

/** One line a → b (null when equal in what a reader sees: text, kind, speaker). */
export const diffLines = (a: Line | undefined, b: Line | undefined): LineDiff | null => {
  if (!a && !b) return null;
  if (!a) return { lineId: b!.id, status: 'added', words: diffWords('', b!.text) };
  if (!b) return { lineId: a.id, status: 'removed', words: diffWords(a.text, '') };
  const out: LineDiff = { lineId: b.id, status: 'changed' };
  if (a.kind !== b.kind) out.kind = [a.kind, b.kind];
  if ((a.speakerId || undefined) !== (b.speakerId || undefined)) out.speaker = [a.speakerId, b.speakerId];
  if (a.text !== b.text) out.words = diffWords(a.text, b.text);
  return out.kind || out.speaker || out.words ? out : null;
};

// ── Semantic filter ──────────────────────────────────────────────────────────

const HIDDEN_KEYS = new Set(['qc', 'variants', 'safety']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isRenderState = (v: unknown): v is RenderState => isObj(v) && typeof v.status === 'string' && Array.isArray(v.history);

/** A value with QC, variants and safety removed at every depth; a render reduced to its current image. */
export const semanticValue = (value: unknown, depth = 0): unknown => {
  if (depth > 40) return value;
  if (Array.isArray(value)) return value.map((v) => semanticValue(v, depth + 1));
  if (!isObj(value)) return value;
  if (isRenderState(value)) return { image: value.asset?.path ?? null };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!HIDDEN_KEYS.has(k) && v !== undefined) out[k] = semanticValue(v, depth + 1);
  return out;
};
const sig = (v: unknown): string => stableStringify(semanticValue(v));

// ── Books ────────────────────────────────────────────────────────────────────

const PANEL_FIELDS = ['size', 'shot', 'angle', 'action', 'castIds', 'placeId', 'mood'] as const;

const pageText = (p: Page): unknown => {
  const { n: _n, render: _r, balloons: _b, ...text } = p;
  return text;
};
const artSig = (p: Page): string => sig({ image: p.render.asset?.path ?? null, balloons: semanticValue(p.balloons as Balloon[]) });

const diffPanels = (a: Panel[], b: Panel[]): PanelDiff[] => {
  const byA = new Map(a.map((p) => [p.id, p]));
  const byB = new Map(b.map((p) => [p.id, p]));
  const out: PanelDiff[] = [];
  const lineDiffs = (la: Line[], lb: Line[]): LineDiff[] => {
    const mA = new Map(la.map((l) => [l.id, l]));
    const mB = new Map(lb.map((l) => [l.id, l]));
    const ids = [...new Set([...la.map((l) => l.id), ...lb.map((l) => l.id)])];
    return ids.map((id) => diffLines(mA.get(id), mB.get(id))).filter((d): d is LineDiff => !!d);
  };
  for (const id of [...new Set([...a.map((p) => p.id), ...b.map((p) => p.id)])]) {
    const pa = byA.get(id);
    const pb = byB.get(id);
    if (!pa) out.push({ panelId: id, status: 'added', fields: [], lines: lineDiffs([], pb!.lines) });
    else if (!pb) out.push({ panelId: id, status: 'removed', fields: [], lines: lineDiffs(pa.lines, []) });
    else {
      const fields = PANEL_FIELDS.filter((f) => sig(pa[f]) !== sig(pb[f]));
      const lines = lineDiffs(pa.lines, pb.lines);
      const other = sig({ ...pa, lines: [], n: 0 }) !== sig({ ...pb, lines: [], n: 0 });
      if (fields.length || lines.length || other || pa.n !== pb.n) out.push({ panelId: id, status: 'changed', fields: [...fields], lines });
    }
  }
  return out;
};

function diffEntities<T extends { id: string; name?: string }>(a: T[], b: T[], artOf: (x: T) => string | null): EntityDiff[] {
  const byA = new Map(a.map((x) => [x.id, x]));
  const byB = new Map(b.map((x) => [x.id, x]));
  const out: EntityDiff[] = [];
  for (const id of [...new Set([...a.map((x) => x.id), ...b.map((x) => x.id)])]) {
    const xa = byA.get(id);
    const xb = byB.get(id);
    if (!xa) out.push({ id, status: 'added', name: xb!.name || '' });
    else if (!xb) out.push({ id, status: 'removed', name: xa.name || '' });
    else if (sig(xa) !== sig(xb)) {
      const art = artOf(xa) !== artOf(xb);
      out.push({ id, status: 'changed', name: xb.name || xa.name || '', ...(art ? { art: true } : {}) });
    }
  }
  return out;
}

const translationSig = (t: TextTranslation | undefined): string => (t ? stableStringify([t.text, t.status, t.sourceHash, t.issue ?? null]) : '');

const diffEditions = (a: ComicDoc, b: ComicDoc): EditionDiff[] => {
  const ea = i18nOf(a).editions;
  const eb = i18nOf(b).editions;
  const out: EditionDiff[] = [];
  for (const lang of [...new Set([...Object.keys(ea), ...Object.keys(eb)])].sort()) {
    const xa = ea[lang];
    const xb = eb[lang];
    if (!xa || !xb) {
      out.push({ lang, status: xa ? 'removed' : 'added', lineIds: Object.keys((xa || xb)!.lines).sort(), meta: false });
      continue;
    }
    const ids = [...new Set([...Object.keys(xa.lines), ...Object.keys(xb.lines)])].sort();
    const lineIds = ids.filter((id) => translationSig(xa.lines[id]) !== translationSig(xb.lines[id]));
    const balloons = sig(xa.balloons) !== sig(xb.balloons);
    const meta = sig([xa.register, xa.cover ?? null, xa.brief ?? null]) !== sig([xb.register, xb.cover ?? null, xb.brief ?? null]);
    if (lineIds.length || meta || balloons) out.push({ lang, status: 'changed', lineIds, meta: meta || balloons });
  }
  return out;
};

/** The image model most of the drawn pages and the cover were drawn with (undefined when nothing is drawn). */
export const drawnModelOf = (doc: ComicDoc): string | undefined => {
  const count = new Map<string, number>();
  for (const r of [...doc.pages.map((p) => p.render), doc.cover.render]) {
    const model = r.asset?.model || (r.asset ? r.model : undefined);
    if (model) count.set(model, (count.get(model) || 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [model, c] of count) if (c > n) [best, n] = [model, c];
  return best;
};

const META_FIELDS = ['brief', 'format', 'planStatus', 'letterStyle', 'book', 'reader'] as const;

/** What differs between book a and book b (both normalized docs), after the semantic filter. Pure. */
export const diffBooks = (a: ComicDoc, b: ComicDoc): BookDiff => {
  const pagesA = new Map(a.pages.map((p, i) => [p.id, { p, i }]));
  const pagesB = new Map(b.pages.map((p, i) => [p.id, { p, i }]));
  const orderA = a.pages.map((p) => p.id).filter((id) => pagesB.has(id));
  const orderB = b.pages.map((p) => p.id).filter((id) => pagesA.has(id));
  const pages: PageDiff[] = [];
  for (const id of [...new Set([...b.pages.map((p) => p.id), ...a.pages.map((p) => p.id)])]) {
    const xa = pagesA.get(id);
    const xb = pagesB.get(id);
    if (!xa) {
      pages.push({ pageId: id, status: 'added', toN: xb!.p.n, text: true, art: !!xb!.p.render.asset, panels: diffPanels([], xb!.p.panels) });
      continue;
    }
    if (!xb) {
      pages.push({ pageId: id, status: 'removed', fromN: xa.p.n, text: true, art: !!xa.p.render.asset, panels: diffPanels(xa.p.panels, []) });
      continue;
    }
    const text = sig(pageText(xa.p)) !== sig(pageText(xb.p));
    const art = artSig(xa.p) !== artSig(xb.p);
    const moved = orderA.indexOf(id) !== orderB.indexOf(id);
    if (!text && !art && !moved) continue;
    pages.push({
      pageId: id,
      status: text || art ? 'changed' : 'moved',
      fromN: xa.p.n,
      toN: xb.p.n,
      text,
      art,
      panels: text ? diffPanels(xa.p.panels, xb.p.panels) : []
    });
  }
  const cast = diffEntities(a.cast, b.cast, (c) => c.sheet.asset?.path ?? null);
  const places = diffEntities(a.places, b.places, (p) => p.sheet.asset?.path ?? null);
  const options = diffEntities(a.style.options, b.style.options, (o) => o.render.asset?.path ?? null);
  const { options: _oa, ...styleA } = a.style;
  const { options: _ob, ...styleB } = b.style;
  const style = sig(styleA) !== sig(styleB);
  const script = sig(a.source) !== sig(b.source);
  const coverText = (c: ComicDoc['cover']) => sig([c.title ?? null, c.tagline ?? null, c.direction ?? null, c.titleStyle ?? null]);
  const cover = {
    text: coverText(a.cover) !== coverText(b.cover),
    art: (a.cover.render.asset?.path ?? null) !== (b.cover.render.asset?.path ?? null) || (a.cover.lettering ?? 'in_art') !== (b.cover.lettering ?? 'in_art')
  };
  const meta = META_FIELDS.filter((k) => sig((a as unknown as Record<string, unknown>)[k]) !== sig((b as unknown as Record<string, unknown>)[k])).map(String);
  const editions = diffEditions(a, b);
  const glossary = sig(i18nOf(a).glossary) !== sig(i18nOf(b).glossary);
  const ma = drawnModelOf(a);
  const mb = drawnModelOf(b);
  const model = ma !== mb ? { ...(ma ? { a: ma } : {}), ...(mb ? { b: mb } : {}) } : undefined;
  const same =
    !pages.length && !cast.length && !places.length && !options.length && !style && !script && !cover.text && !cover.art && !meta.length && !editions.length && !glossary;
  return { pages, cast, places, options, style, script, cover, meta, editions, glossary, ...(model ? { model } : {}), same };
};

/** Pages whose text or art differs (the "3 pages changed since you published" count). */
export const changedPageCount = (diff: BookDiff): number => diff.pages.filter((p) => p.status !== 'moved').length;
