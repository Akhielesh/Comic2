// Pure board view-model helpers: what state a page/sheet is in, what a click would draw
// and what it would cost, labels. Kept free of React so the decisions are unit-tested.
// Targeting comes from the ONE shared core (shared/comic/plan.ts), the same functions the
// server's gate uses, so the board can never quote a page the server would not draw.

import {
  findCharacter,
  findPlace,
  isPageStale,
  type AspectRatio,
  type Character,
  type ComicDoc,
  type ComicKind,
  type LineKind,
  type Page,
  type PanelSize,
  type RenderState,
  type ShotType,
  type SpendKind,
  type StyleBible
} from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import {
  estimateJobs,
  getImageModel,
  resolveImageJob,
  type ImageJobKind,
  type ImageModelSpec,
  type SpendEstimate
} from '../../../shared/comic/models';
import { missingSheetsFor, pageTargets } from '../../../shared/comic/plan';
import type { StylePreset } from '../../../shared/comic/stylePresets';

// ── Render states ────────────────────────────────────────────────────────────

export type VisualStatus = 'planned' | 'queued' | 'rendering' | 'ready' | 'stale' | 'failed' | 'empty';

export const isBusy = (render?: RenderState | null) => render?.status === 'queued' || render?.status === 'rendering';

/** What a page card shows: its render state, with "drawn from an older script" surfaced as stale. */
export const pageVisualStatus = (doc: ComicDoc, page: Page): VisualStatus => {
  switch (page.render.status) {
    case 'queued':
      return 'queued';
    case 'rendering':
      return 'rendering';
    case 'failed':
      return 'failed';
    case 'stale':
      return 'stale';
    case 'ready':
      return isPageStale(doc, page) ? 'stale' : 'ready';
    default:
      return page.panels.length ? 'planned' : 'empty';
  }
};

/** Sheet (character/place) state; `none` reads as planned. */
export const sheetVisualStatus = (render: RenderState): VisualStatus => {
  switch (render.status) {
    case 'queued':
    case 'rendering':
    case 'failed':
    case 'stale':
    case 'ready':
      return render.status;
    default:
      return 'planned';
  }
};

export const hasImage = (render?: RenderState | null) => !!render?.asset?.path;

/** Renders that landed this recently "develop" in; older ones show statically. */
export const DEVELOP_WINDOW_MS = 15_000;
export const isFreshRender = (render?: RenderState | null, now = Date.now()) =>
  !!render && render.status === 'ready' && !!render.updatedAt && now - render.updatedAt < DEVELOP_WINDOW_MS;

// ── Spend targeting (shared/comic/plan.ts — the server's own pageTargets / missingSheetsFor) ──

/** Pages "render all" would draw now: planned, failed or out of date — never ones already drawing. */
export const pagesToDraw = (doc: ComicDoc): Page[] => pageTargets(doc);

/** Forced redraw of specific pages (Render selected / Re-render): everything chosen that isn't already drawing. */
export const pagesForIds = (doc: ComicDoc, ids: Iterable<string>): Page[] => {
  const pageIds = [...new Set(ids)];
  // An empty selection draws nothing (pageTargets treats "no ids" as the whole book).
  return pageIds.length ? pageTargets(doc, { pageIds, force: true }) : [];
};

/** Lead/support cast on these pages with no usable sheet yet (the server draws those first, billed too). */
export const sheetsNeededFor = (doc: ComicDoc, pages: Page[]): Character[] => missingSheetsFor(doc, pages);

/** Whether image spend is on the user's own key: the most recent image spend says so. */
export const byokFromDoc = (doc: ComicDoc): boolean => {
  const IMAGE_KINDS = new Set<SpendKind>(['style', 'sheet', 'page', 'edit', 'cover']);
  return doc.spend.entries.find((e) => IMAGE_KINDS.has(e.kind))?.byok ?? false;
};

export interface DrawPlan {
  pages: Page[];
  sheets: Character[];
  estimate: SpendEstimate;
}

export const estimateDraw = (doc: ComicDoc, pages: Page[], byok: boolean): DrawPlan => {
  const sheets = sheetsNeededFor(doc, pages);
  const estimate = estimateJobs(
    [
      { kind: 'page', count: pages.length, label: 'pages' },
      { kind: 'sheet', count: sheets.length, label: 'character sheets' }
    ],
    doc.settings.quality,
    { override: doc.settings.imageModelOverride, byok }
  );
  return { pages, sheets, estimate };
};

/** Estimate for one image job of a kind (edit, cover, a sheet, style options). */
export const estimateOne = (doc: ComicDoc, kind: ImageJobKind, byok: boolean, count = 1): SpendEstimate =>
  estimateJobs([{ kind, count, label: kind }], doc.settings.quality, { override: doc.settings.imageModelOverride, byok });

// ── Models ───────────────────────────────────────────────────────────────────

/** The registry model a job of this kind runs on right now (tier + override). */
export const jobModel = (doc: ComicDoc, kind: ImageJobKind): ImageModelSpec =>
  resolveImageJob(kind, doc.settings.quality, doc.settings.imageModelOverride).spec;

/** Friendly model name for a render: what drew it, else what will. */
export const renderModelNickname = (doc: ComicDoc, render: RenderState | undefined, kind: ImageJobKind): string =>
  getImageModel(render?.model)?.nickname || jobModel(doc, kind).nickname;

// ── Labels ───────────────────────────────────────────────────────────────────

export const SHOT_LABEL: Record<ShotType, string> = {
  establishing: 'Establishing',
  wide: 'Wide',
  full: 'Full shot',
  medium: 'Medium',
  close_up: 'Close-up',
  extreme_close_up: 'Extreme close-up',
  over_shoulder: 'Over the shoulder',
  insert: 'Insert',
  pov: 'POV'
};

export const SIZE_LABEL: Record<PanelSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  wide: 'Wide',
  tall: 'Tall',
  splash: 'Splash'
};

export const LINE_KIND_LABEL: Record<LineKind, string> = {
  speech: 'Speech',
  thought: 'Thought',
  whisper: 'Whisper',
  shout: 'Shout',
  caption: 'Caption',
  sfx: 'Sound effect'
};

export const LINE_KINDS: LineKind[] = ['speech', 'thought', 'whisper', 'shout', 'caption', 'sfx'];

export const KIND_LABEL: Record<ComicKind, string> = {
  comic: 'Comic',
  manga: 'Manga',
  webtoon: 'Webtoon',
  strip: 'Strip',
  storybook: 'Storybook'
};

export const SPEND_KIND_LABEL: Record<SpendKind, string> = {
  chat: 'Director',
  plan: 'Page plans',
  style: 'Style boards',
  sheet: 'Character sheets',
  page: 'Pages',
  edit: 'Page edits',
  cover: 'Cover',
  qc: 'Quality checks',
  translate: 'Translations'
};

export const cssAspect = (ratio: AspectRatio | string): string => String(ratio || '2:3').replace(':', ' / ');

export const castName = (doc: ComicDoc, id?: string): string => findCharacter(doc, id)?.name || 'Unknown';
export const placeName = (doc: ComicDoc, id?: string): string | undefined => findPlace(doc, id)?.name;

/** "MAYA" style initials for an avatar placeholder. */
export const initials = (name: string): string => {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/** Stable soft hue for a name (avatar tint). */
export const nameHue = (name: string): number => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
};

export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;

/** "12s" / "1m 05s". */
export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(s / 3600);
  return h < 48 ? `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(h / 24)}d`;
};

/** Money with enough precision for tiny per-call costs. */
export const formatSpend = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
};

/** Pages drawn and current (not stale) / total — the Pages tab badge. */
export const pageProgress = (doc: ComicDoc): { ready: number; total: number } => ({
  ready: doc.pages.filter((p) => pageVisualStatus(doc, p) === 'ready').length,
  total: doc.pages.length
});

// ── Style presets ────────────────────────────────────────────────────────────

/** Ops that make a preset the (drafted) style; a locked board from another look is dropped. */
export const presetOps = (doc: ComicDoc, preset: StylePreset): DocOp[] => {
  const patch: Partial<Omit<StyleBible, 'options'>> & { board?: null } = {
    status: 'drafted',
    presetId: preset.id,
    name: preset.name,
    spec: preset.spec,
    palette: preset.palette,
    linework: preset.linework,
    avoid: preset.avoid
  };
  // null clears it on the server (undefined would not survive JSON).
  if (doc.style.board) patch.board = null;
  const ops: DocOp[] = [{ op: 'style', patch: patch as Partial<Omit<StyleBible, 'options'>> }];
  const colorMode = preset.colorMode || 'color';
  if (doc.format.colorMode !== colorMode) ops.push({ op: 'format', patch: { colorMode } });
  return ops;
};

/**
 * `null` clears an optional field on the server (its sanitizers map null → unset; an
 * `undefined` key would vanish in JSON and leave the old value). Typed as undefined so it
 * fits the Partial<> patch shapes.
 */
export const CLEAR = null as unknown as undefined;
