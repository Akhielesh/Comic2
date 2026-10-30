// Client glue over shared/comic/book.ts for the timeline, the version stack and the media bin
// (timeline.md §4.1–§4.3). Pure and dependency-free (no React): clip view-models, version lists
// (v1 = oldest — the same numbering as the director's list_versions/use_version), the media index,
// filters, and the op builders the UI and its undo toast share.
//
// Every number shown is REAL recorded data: spend comes from the ledger (spendByTarget), version
// cost/model/QC from what the render recorded, prices from the model registry. Unknown stays unknown
// ("not recorded"), never estimated into a fact.

import { aspectMismatch, bookSequence, continuityHint, versionList as sharedVersionList, type BookSlot, type BookSlotKind } from '../../../shared/comic/book';
import {
  archiveOf,
  bookOf,
  findPage,
  getRender,
  isPageStale,
  newId,
  renderTargetKey,
  specHashFor,
  targetLabel,
  trashOf,
  type ArchivedVersion,
  type AspectRatio,
  type AssetRef,
  type BookSettings,
  type ComicDoc,
  type Page,
  type RefAsset,
  type RenderState,
  type RenderTarget,
  type RenderVersion,
  type VersionOrigin
} from '../../../shared/comic/doc';
import { applyOp, assetPartOf, type DocOp } from '../../../shared/comic/ops';
import { aspectFromSize, aspectMatches, aspectRatioOf, getImageModel, IMAGE_MODELS } from '../../../shared/comic/models';
import { spendByTarget, unitPrice } from '../../../shared/comic/plan';
import { describeOps, inverseOps, isUndoable } from '../../../shared/comic/undo';
import { canServeToOwner } from '../../../shared/comic/safety';
import { DOC_LIMITS, MAX_ARCHIVE } from '../../../shared/comic/limits';
import { isPanelSourceArchive, PANEL_SOURCE_ARCHIVE_WORDS } from '../../../shared/comic/history/index';
import { amountInSentence } from '../../../services/costDisplay';

// ── Small helpers ────────────────────────────────────────────────────────────

export const isBusyRender = (r?: RenderState | null): boolean => !!r && (r.status === 'queued' || r.status === 'rendering');
export const sortedPages = (doc: ComicDoc): Page[] => [...doc.pages].sort((a, b) => a.n - b.n);
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Friendly model name for a stored model id (registry id or provider route id); unknown ids pass through. */
export const modelName = (id?: string): string | undefined => {
  if (!id) return undefined;
  const spec = getImageModel(id) ?? IMAGE_MODELS.find((m) => Object.values(m.routes).includes(id));
  return spec?.nickname ?? id;
};

/** The comic's page aspect as a number (w/h). */
export const pageRatio = (doc: ComicDoc): number => aspectRatioOf(doc.format.pageAspect);

/** w/h of an asset, else the book's page shape. */
export const assetRatio = (doc: ComicDoc, asset?: { w?: number; h?: number } | null): number =>
  asset?.w && asset?.h && asset.w > 0 && asset.h > 0 ? asset.w / asset.h : pageRatio(doc);

// ── Versions (v1 = oldest) ───────────────────────────────────────────────────

export interface VersionItem {
  /** v-number: 1 = oldest (creation time, then path) — stable across swaps. */
  n: number;
  path: string;
  /** The plain image (what render_use / ref_add / downloads take). */
  asset: AssetRef;
  current: boolean;
  archived: boolean;
  starred: boolean;
  at: number;
  model?: string;
  modelLabel?: string;
  costUsd?: number;
  qcScore?: number;
  qcIssues?: string[];
  origin?: VersionOrigin;
  note?: string;
  resolution?: string;
  /** Shape of the image itself (from its pixels). */
  shape?: AspectRatio;
  /** Not the book's page shape (pages and cover only). */
  mismatch: boolean;
  /** Drawn for an older script/style than the current one (honest "out of date"). */
  stale: boolean;
  /** Blocked or quarantined by the content check: never shown, never usable. */
  blocked: boolean;
  balloonCount?: number;
}

type AnyVersion = RenderVersion | ArchivedVersion;

/**
 * Every version of a target — current, history, its archived versions — numbered v1 = oldest. A page's frame picture
 * or overlay that a restore archived under the page (shared/comic/history isPanelSourceArchive) is not a version of
 * the page's drawing: the shared list already leaves it out before numbering, so v1..vN count drawings only, and the
 * media bin lists it under its page by its own label (collectMedia).
 */
export function versionList(doc: ComicDoc, target: RenderTarget): VersionItem[] {
  const want = specHashFor(doc, target);
  const shaped = target.kind === 'page' || target.kind === 'cover';
  // The ONE numbering (shared/comic/book versionList, P2-AMEND): the same v-numbers the director's
  // list_versions / use_version use — this view only adds what the UI shows about each version. Never renumber here.
  return sharedVersionList(doc, target).map(({ n, version, current, archived }) => {
    const v: AnyVersion = version;
    const rv = v as RenderVersion & Partial<ArchivedVersion>;
    const item: VersionItem = {
      n,
      path: v.path,
      asset: assetPartOf(v),
      current,
      archived,
      starred: !!rv.starred,
      at: v.at || 0,
      mismatch: shaped && !!v.w && !!v.h && !aspectMatches(doc.format.pageAspect, v.w, v.h),
      stale: !!rv.specHash && want !== undefined && rv.specHash !== want,
      blocked: !canServeToOwner(v)
    };
    if (v.model) {
      item.model = v.model;
      item.modelLabel = modelName(v.model);
    }
    if (typeof rv.costUsd === 'number') item.costUsd = rv.costUsd;
    if (typeof rv.qc?.score === 'number') {
      item.qcScore = rv.qc.score;
      item.qcIssues = rv.qc.issues;
    }
    if (rv.origin) item.origin = rv.origin;
    if (rv.note) item.note = rv.note;
    if (rv.resolution) item.resolution = rv.resolution;
    if (v.w && v.h) item.shape = aspectFromSize(v.w, v.h);
    if (rv.balloons) item.balloonCount = rv.balloons.length;
    return item;
  });
}

export const versionCount = (doc: ComicDoc, target: RenderTarget): number => versionList(doc, target).length;

/**
 * How a pure helper prints money when its caller passed no formatter: governed-unknown usage terms
 * ("uses a little of your usage" — the same words services/costDisplay formatCostForUser uses). Never dollars by default — UI callers pass the viewer's formatter
 * (conversation/cost useCostFormat(studio).exact): admins / own key read "$0.06", governed users
 * "≈2% of your usage" (P1-LIMITS: governed users never see dollars).
 */
export const failClosedMoney = (usd: number): string => (Number.isFinite(usd) && usd > 0 ? 'uses a little of your usage' : 'Free');

/** "Free — fitted by software" / "$0.06" (or "≈2% of your usage") / "not recorded". */
export const versionCostLabel = (v: Pick<VersionItem, 'costUsd' | 'origin'>, money: (usd: number) => string = failClosedMoney): string => {
  if (typeof v.costUsd === 'number') return v.costUsd > 0 ? money(v.costUsd) : v.origin === 'derived' ? 'Free — done by software' : 'Free';
  if (v.origin === 'adopted' || v.origin === 'upload') return 'No AI cost';
  return 'Not recorded';
};

export const ORIGIN_LABEL: Record<VersionOrigin, string> = {
  render: 'Drawn',
  edit: 'Edited',
  derived: 'Fitted by software',
  adopted: 'Picked from media',
  upload: 'Uploaded',
  reused: 'Reused (free)',
  variation: 'Variation'
};

/**
 * Drawn pages (and the cover) that a version swap would make out of date — a character-sheet version
 * changes every page drawn from that sheet. Pure simulation of the same op the server commits.
 */
export function staleImpact(doc: ComicDoc, target: RenderTarget, path: string): { pages: number[]; cover: boolean } {
  const after = applyOp(doc, { op: 'render_use', target, path, at: 0 });
  const pages: number[] = [];
  for (const p of sortedPages(after)) {
    const prev = findPage(doc, p.id);
    if (prev && !isPageStale(doc, prev) && isPageStale(after, p)) pages.push(p.n);
  }
  const coverWas = !!doc.cover.render.specHash && doc.cover.render.status === 'ready' && doc.cover.render.specHash !== specHashFor(doc, { kind: 'cover' });
  const coverNow = !!after.cover.render.specHash && after.cover.render.status === 'ready' && after.cover.render.specHash !== specHashFor(after, { kind: 'cover' });
  return { pages, cover: target.kind !== 'cover' && !coverWas && coverNow };
}

// ── Clips (the filmstrip) ────────────────────────────────────────────────────

export interface ClipVM {
  key: string;
  kind: BookSlotKind;
  label: string;
  page?: Page;
  target?: RenderTarget;
  asset?: AssetRef;
  status: BookSlot['status'];
  plate: boolean;
  drawn: boolean;
  busy: boolean;
  versions: number;
  /** Real money recorded against this image (ledger), else its versions' recorded costs (each paid image counted once per book). */
  spentUsd: number;
  savedUsd: number;
  mismatch: { want: AspectRatio; got: AspectRatio } | null;
  /** The previous page's art changed since this page was drawn (info, never stale). */
  continuity: boolean;
  /** w/h for the thumbnail box (aspect-true). */
  ratio: number;
  qcScore?: number;
  blocked: boolean;
}

/**
 * Per-clip money, each paid image counted ONCE across the book. A clip with ledger entries shows the
 * ledger (the real charges, BYOK included). A clip without them (older docs, entries past the ledger
 * cap) falls back to the costs its versions recorded — but never for an image another clip already
 * accounts for: a duplicated page shares its source's art and shows no spend of its own, so the clip
 * badges never add up to more than was actually spent.
 */
export function clipSpend(doc: ComicDoc, targets: RenderTarget[]): Map<string, { usd: number; saved: number }> {
  const ledger = spendByTarget(doc);
  const out = new Map<string, { usd: number; saved: number }>();
  const claimed = new Set<string>();
  const lists = targets.map((t) => ({ key: renderTargetKey(t), versions: versionList(doc, t) }));
  for (const { key, versions } of lists) {
    const hit = ledger.get(key);
    if (!hit || (hit.usd <= 0 && hit.savedUsd <= 0)) continue;
    out.set(key, { usd: hit.usd, saved: hit.savedUsd });
    for (const v of versions) claimed.add(v.path);
  }
  for (const { key, versions } of lists) {
    if (out.has(key)) continue;
    let usd = 0;
    for (const v of versions) {
      if (claimed.has(v.path)) continue;
      claimed.add(v.path);
      if (typeof v.costUsd === 'number' && v.costUsd > 0) usd += v.costUsd;
    }
    out.set(key, { usd: round4(usd), saved: ledger.get(key)?.savedUsd ?? 0 });
  }
  return out;
}

/** The studio book order as filmstrip clips: cover → [title] → pages → [end] → [back cover]. */
export function bookClips(doc: ComicDoc): ClipVM[] {
  const slots = bookSequence(doc, { audience: 'studio' });
  const targetOf = (slot: BookSlot): RenderTarget | undefined =>
    slot.kind === 'cover' ? { kind: 'cover' } : slot.kind === 'page' && slot.page ? { kind: 'page', id: slot.page.id } : undefined;
  const money = clipSpend(doc, slots.map(targetOf).filter((t): t is RenderTarget => !!t));
  return slots.map((slot) => {
    const target = targetOf(slot);
    const render = target ? getRender(doc, target) : undefined;
    const spend = (target && money.get(renderTargetKey(target))) || { usd: 0, saved: 0 };
    const asset = slot.asset;
    return {
      key: slot.key,
      kind: slot.kind,
      label: slot.label,
      page: slot.page,
      target,
      asset,
      status: slot.status,
      plate: !!slot.plate,
      drawn: slot.drawn,
      busy: isBusyRender(render),
      versions: target ? versionCount(doc, target) : 0,
      spentUsd: spend.usd,
      savedUsd: spend.saved,
      mismatch: target && slot.drawn ? aspectMismatch(doc, asset) : null,
      continuity: slot.page ? continuityHint(doc, slot.page) : false,
      ratio: slot.plate ? pageRatio(doc) : assetRatio(doc, asset),
      ...(typeof render?.qc?.score === 'number' ? { qcScore: render.qc.score } : {}),
      blocked: !!asset && !canServeToOwner(asset)
    };
  });
}

export type PlateKind = 'title' | 'end' | 'back_cover';
export interface GhostPlate { kind: PlateKind; label: string; patch: Partial<BookSettings> }

/** Disabled software pages, offered as "+ Title page" chips (free toggles). */
export function ghostPlates(doc: ComicDoc): GhostPlate[] {
  if (!doc.pages.length) return [];
  const b = bookOf(doc);
  const out: GhostPlate[] = [];
  if (!b.titlePage) out.push({ kind: 'title', label: 'Title page', patch: { titlePage: true } });
  if (!b.endPage) out.push({ kind: 'end', label: '“The End”', patch: { endPage: true } });
  if (b.backCover === 'none') out.push({ kind: 'back_cover', label: 'Back cover', patch: { backCover: 'auto' } });
  return out;
}

export const plateOffPatch = (kind: PlateKind): Partial<BookSettings> =>
  kind === 'title' ? { titlePage: false } : kind === 'end' ? { endPage: false } : { backCover: 'none' };

export const STATUS_TEXT: Record<BookSlot['status'], string> = {
  planned: 'Planned',
  empty: 'Empty',
  queued: 'Queued',
  rendering: 'Drawing',
  ready: 'Ready',
  stale: 'Out of date',
  failed: 'Failed',
  custom: 'Custom art'
};

/** "Book · Cover ✓ · 3 pages · 7 versions · $0.55 spent · $0.06 saved by software". Real totals only; `money` prints for the viewer. */
export function dockSummary(doc: ComicDoc, money: (usd: number) => string = failClosedMoney): string {
  const clips = bookClips(doc);
  const pages = clips.filter((c) => c.kind === 'page');
  const drawn = pages.filter((c) => c.drawn).length;
  const cover = clips.find((c) => c.kind === 'cover');
  const versions = clips.reduce((n, c) => n + c.versions, 0);
  const parts = ['Book'];
  parts.push(cover?.drawn ? 'Cover ✓' : 'No cover yet');
  parts.push(pages.length ? `${drawn}/${pages.length} ${pages.length === 1 ? 'page' : 'pages'} drawn` : 'no pages yet');
  if (versions) parts.push(plural(versions, 'version'));
  // Inside a phrase, the unknown-share wording reads as a noun ("some of your usage spent").
  if (doc.spend.totalUsd > 0) parts.push(`${amountInSentence(money(doc.spend.totalUsd), 'some of your usage')} spent`);
  if ((doc.spend.savedUsd ?? 0) > 0) parts.push(`${amountInSentence(money(doc.spend.savedUsd ?? 0))} saved by software`);
  return parts.join(' · ');
}

/** What the next paid step on a clip would cost right now (registry price, BYOK-aware). */
export const redrawPrice = (doc: ComicDoc, kind: 'page' | 'cover', byok: boolean): number => unitPrice(doc, kind, { byok }).usd;

// ── Op builders (the UI, keyboard and the undo toast share them) ─────────────

export function moveOps(doc: ComicDoc, pageId: string, toIndex: number): DocOp[] {
  const ids = sortedPages(doc).map((p) => p.id);
  const from = ids.indexOf(pageId);
  if (from < 0) return [];
  const to = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (to === from) return [];
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, pageId);
  return [{ op: 'pages_reorder', order: next }];
}

export const insertOps = (after: number, id = newId('pg')): DocOp[] => [{ op: 'page_insert', id, after }];
export const duplicateOps = (pageId: string, newPageId = newId('pg')): DocOp[] => [{ op: 'page_duplicate', id: pageId, newId: newPageId }];
export const deleteOps = (pageId: string, now = Date.now()): DocOp[] => [{ op: 'page_delete', id: pageId, deletedAt: now }];
export const renderUseOps = (target: RenderTarget, path: string, opts: { adopt?: boolean; now?: number } = {}): DocOp[] => [
  { op: 'render_use', target, path, at: opts.now ?? Date.now(), ...(opts.adopt ? { adopt: true } : {}) }
];

/** Page-cap pre-check (the server enforces it too): a free plan holds up to DOC_LIMITS.pages pages. */
export const canAddPage = (doc: ComicDoc, maxPages: number = DOC_LIMITS.pages): boolean => doc.pages.length < Math.min(DOC_LIMITS.pages, maxPages);

export interface UndoPlan {
  label: string;
  /** Ops that undo `ops` when applied after them; null when the batch cannot be undone exactly. */
  inverse: DocOp[] | null;
}

/** Undo plan for a batch the user is about to commit (computed BEFORE apply, from the doc they saw). */
export function undoPlan(before: ComicDoc, ops: DocOp[]): UndoPlan {
  return { label: describeOps(ops), inverse: isUndoable(before, ops) ? inverseOps(before, ops) : null };
}

// ── Media bin ────────────────────────────────────────────────────────────────

export type MediaRole = 'page' | 'cover' | 'sheet' | 'place' | 'style_option' | 'style_board' | 'ref' | 'attachment' | 'inbox' | 'deleted_page';
export type MediaGroup = 'pages' | 'cover' | 'characters' | 'places' | 'style' | 'uploads';

export interface MediaItem {
  path: string;
  asset: AssetRef;
  w?: number;
  h?: number;
  at: number;
  model?: string;
  modelLabel?: string;
  source: AssetRef['source'];
  role: MediaRole;
  group: MediaGroup;
  owner: { key: string; label: string; order: number; target?: RenderTarget };
  current: boolean;
  versionN?: number;
  versionLabel?: string;
  costUsd?: number;
  qcScore?: number;
  origin?: VersionOrigin;
  note?: string;
  archived: boolean;
  starred: boolean;
  /** Can be starred (an earlier version or an archived one). */
  canStar: boolean;
  blocked: boolean;
  stale: boolean;
  /** Labels of everything that uses this exact image. */
  usedBy: string[];
  /** Deleted pages: the trash entry's page id (Restore). */
  deletedPageId?: string;
  deletedFromN?: number;
  /**
   * A page's frame picture or overlay a restore archived under the page (isPanelSourceArchive): what it was. It is
   * not a version of the page's drawing — never page or cover art; listed under its page by its own label.
   */
  panelSource?: PanelSourceWhat;
}

/** What a panel-source archive entry was ('panel picture' | 'overlay'). */
export type PanelSourceWhat = (typeof PANEL_SOURCE_ARCHIVE_WORDS)[keyof typeof PANEL_SOURCE_ARCHIVE_WORDS];

/** A panel picture or overlay archive entry records no time (at 0): its tile says so instead of a date. */
export const DATE_NOT_RECORDED = 'date not recorded';

/** "Page 3 overlay" → 'overlay' (null for anything that is not a panel-source archive entry). */
export const panelSourceWhat = (a: ArchivedVersion): PanelSourceWhat | null => {
  if (!isPanelSourceArchive(a)) return null;
  return a.label.endsWith(PANEL_SOURCE_ARCHIVE_WORDS.frame) ? PANEL_SOURCE_ARCHIVE_WORDS.frame : PANEL_SOURCE_ARCHIVE_WORDS.layer;
};

/** The entry's own label with its (unrecorded) date: "Page 3 overlay · date not recorded". */
export const panelSourceLabel = (a: Pick<ArchivedVersion, 'label'>): string => `${a.label} · ${DATE_NOT_RECORDED}`;

export type MediaFilter = 'all' | 'pages' | 'cover' | 'characters' | 'places' | 'style' | 'uploads' | 'archived' | 'deleted';
export const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pages', label: 'Pages' },
  { id: 'cover', label: 'Cover' },
  { id: 'characters', label: 'Characters' },
  { id: 'places', label: 'Places' },
  { id: 'style', label: 'Style' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'archived', label: 'Archived' },
  { id: 'deleted', label: 'Deleted' }
];

/**
 * Every image in the project, one item per path, in book order: cover, pages, sheets, places, style,
 * references, chat uploads, deleted pages, then archived versions whose owner is gone.
 */
export function collectMedia(doc: ComicDoc): MediaItem[] {
  const byPath = new Map<string, MediaItem>();
  const order: MediaItem[] = [];
  let ownerOrder = 0;
  const add = (base: Omit<MediaItem, 'usedBy' | 'path' | 'asset' | 'w' | 'h' | 'at' | 'source' | 'model' | 'modelLabel' | 'blocked'> & { asset: AssetRef }, usedLabel: string) => {
    const a = base.asset;
    if (!a?.path) return;
    const existing = byPath.get(a.path);
    if (existing) {
      if (!existing.usedBy.includes(usedLabel)) existing.usedBy.push(usedLabel);
      return;
    }
    const item: MediaItem = {
      ...base,
      asset: assetPartOf(a),
      path: a.path,
      w: a.w,
      h: a.h,
      at: a.at || 0,
      source: a.source,
      ...(a.model ? { model: a.model, modelLabel: modelName(a.model) } : {}),
      blocked: !canServeToOwner(a),
      usedBy: [usedLabel]
    };
    byPath.set(a.path, item);
    order.push(item);
  };
  const addVersions = (target: RenderTarget, role: MediaRole, group: MediaGroup, label: string) => {
    const owner = { key: renderTargetKey(target), label, order: ownerOrder++, target };
    for (const v of [...versionList(doc, target)].reverse()) {
      add(
        {
          role,
          group,
          owner,
          current: v.current,
          versionN: v.n,
          versionLabel: `v${v.n}${v.current ? ' · current' : ''}`,
          ...(typeof v.costUsd === 'number' ? { costUsd: v.costUsd } : {}),
          ...(typeof v.qcScore === 'number' ? { qcScore: v.qcScore } : {}),
          ...(v.origin ? { origin: v.origin } : {}),
          ...(v.note ? { note: v.note } : {}),
          archived: v.archived,
          starred: v.starred,
          canStar: !v.current,
          stale: v.stale,
          asset: v.asset
        },
        v.current ? label : `${label} (earlier version)`
      );
    }
    if (target.kind === 'page') addPanelSources(owner.key, owner, role);
  };
  // A page's frame picture or overlay a restore archived under it ('page:<id>', isPanelSourceArchive): listed under its
  // page by its own label ("Page 3 overlay · date not recorded"), never as a version of the page's drawing.
  const addPanelSources = (key: string, owner: MediaItem['owner'], role: MediaRole) => {
    for (const a of archiveOf(doc)) {
      const what = a.targetKey === key ? panelSourceWhat(a) : null;
      if (!what) continue;
      add(
        { role, group: 'pages', owner, current: false, versionLabel: panelSourceLabel(a), panelSource: what, archived: true, starred: !!a.starred, canStar: true, stale: false, asset: a },
        `${a.label} (archived)`
      );
    }
  };
  const addRefs = (refs: RefAsset[] | undefined, group: MediaGroup, label: string) => {
    if (!refs?.length) return;
    const owner = { key: `refs:${label}`, label, order: ownerOrder++ };
    for (const r of refs) add({ role: 'ref', group, owner, current: true, archived: false, starred: false, canStar: false, stale: false, asset: r }, label);
  };

  addVersions({ kind: 'cover' }, 'cover', 'cover', 'Cover');
  for (const p of sortedPages(doc)) addVersions({ kind: 'page', id: p.id }, 'page', 'pages', `Page ${p.n}`);
  for (const c of doc.cast) {
    addVersions({ kind: 'sheet', id: c.id }, 'sheet', 'characters', targetLabel(doc, { kind: 'sheet', id: c.id }));
    addRefs(c.refs, 'characters', `${c.name.toUpperCase()} references`);
  }
  for (const p of doc.places) {
    addVersions({ kind: 'place', id: p.id }, 'place', 'places', `${p.name.toUpperCase()} (place)`);
    addRefs(p.refs, 'places', `${p.name.toUpperCase()} references`);
  }
  for (const o of doc.style.options) addVersions({ kind: 'style_option', id: o.id }, 'style_option', 'style', `Style option “${o.name}”`);
  if (doc.style.board) {
    add(
      { role: 'style_board', group: 'style', owner: { key: 'style_board', label: 'Style board', order: ownerOrder++ }, current: true, archived: false, starred: false, canStar: false, stale: false, asset: doc.style.board },
      'Style board'
    );
  }
  addRefs(doc.style.refs, 'style', 'Style references');
  const chat = { key: 'chat', label: 'Chat uploads', order: ownerOrder++ };
  for (const m of doc.conversation) for (const a of m.attachments || []) add({ role: 'attachment', group: 'uploads', owner: chat, current: true, archived: false, starred: false, canStar: false, stale: false, asset: a }, 'Chat uploads');
  const inbox = { key: 'inbox', label: 'Waiting to be used', order: ownerOrder++ };
  for (const r of doc.refInbox || []) add({ role: 'inbox', group: 'uploads', owner: inbox, current: true, archived: false, starred: false, canStar: false, stale: false, asset: r }, 'Uploads waiting to be used');
  for (const t of trashOf(doc)) {
    const label = `Deleted page ${t.fromN}`;
    const owner = { key: `trash:${t.page.id}`, label, order: ownerOrder++ };
    const r = t.page.render;
    const versions: { a: AssetRef; current: boolean }[] = [...(r.asset ? [{ a: r.asset, current: true }] : []), ...r.history.map((a) => ({ a, current: false }))];
    for (const { a, current } of versions) {
      add(
        { role: 'deleted_page', group: 'pages', owner, current, archived: false, starred: false, canStar: false, stale: false, asset: a, deletedPageId: t.page.id, deletedFromN: t.fromN },
        label
      );
    }
    addPanelSources(renderTargetKey({ kind: 'page', id: t.page.id }), owner, 'deleted_page');
  }
  // Archived versions whose owner no longer exists (purged pages, removed characters).
  for (const a of archiveOf(doc)) {
    if (byPath.has(a.path)) continue;
    const what = panelSourceWhat(a);
    if (what) {
      // A purged page's frame picture or overlay: under that page's own group, by its label.
      const pageLabel = a.label.slice(0, -(what.length + 1));
      add(
        {
          role: 'deleted_page',
          group: 'pages',
          owner: { key: `archive:${a.targetKey}`, label: pageLabel, order: ownerOrder++ },
          current: false,
          versionLabel: panelSourceLabel(a),
          panelSource: what,
          archived: true,
          starred: !!a.starred,
          canStar: true,
          stale: false,
          asset: a
        },
        `${a.label} (archived)`
      );
      continue;
    }
    const kind = a.targetKey.split(':')[0];
    const role: MediaRole = kind === 'cover' ? 'cover' : kind === 'sheet' ? 'sheet' : kind === 'place' ? 'place' : kind === 'style_option' ? 'style_option' : 'deleted_page';
    const group: MediaGroup = role === 'sheet' ? 'characters' : role === 'place' ? 'places' : role === 'style_option' ? 'style' : role === 'cover' ? 'cover' : 'pages';
    add(
      {
        role,
        group,
        owner: { key: `archive:${a.targetKey}`, label: a.label, order: ownerOrder++ },
        current: false,
        archived: true,
        starred: !!a.starred,
        canStar: true,
        stale: false,
        ...(typeof a.costUsd === 'number' ? { costUsd: a.costUsd } : {}),
        ...(a.origin ? { origin: a.origin } : {}),
        asset: a
      },
      `${a.label} (archived)`
    );
  }
  return order;
}

export function filterMedia(items: MediaItem[], filter: MediaFilter, query = ''): MediaItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (q && !it.owner.label.toLowerCase().includes(q) && !it.usedBy.some((u) => u.toLowerCase().includes(q))) return false;
    switch (filter) {
      case 'all':
        return true;
      case 'pages':
        return it.group === 'pages' && it.role !== 'deleted_page';
      case 'cover':
        return it.group === 'cover';
      case 'characters':
      case 'places':
      case 'style':
        return it.group === filter;
      case 'uploads':
        return it.source === 'upload' || it.role === 'ref' || it.role === 'attachment' || it.role === 'inbox';
      case 'archived':
        return it.archived;
      case 'deleted':
        return it.role === 'deleted_page';
      default:
        return true;
    }
  });
}

export const mediaCounts = (items: MediaItem[]): Record<MediaFilter, number> =>
  Object.fromEntries(MEDIA_FILTERS.map((f) => [f.id, filterMedia(items, f.id).length])) as Record<MediaFilter, number>;

export type MediaSort = 'book' | 'newest';
export interface MediaGroupView { key: string; label: string; items: MediaItem[] }

/** Groups by owner in book order (default) or one "Newest first" group. */
export function groupMedia(items: MediaItem[], sort: MediaSort): MediaGroupView[] {
  if (sort === 'newest') return items.length ? [{ key: 'newest', label: 'Newest first', items: [...items].sort((a, b) => b.at - a.at) }] : [];
  const groups = new Map<string, MediaGroupView & { order: number }>();
  for (const it of items) {
    const g = groups.get(it.owner.key) ?? { key: it.owner.key, label: it.owner.label, items: [], order: it.owner.order };
    g.items.push(it);
    groups.set(it.owner.key, g);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map(({ key, label, items: list }) => ({ key, label, items: list }));
}

export const archiveUsage = (doc: ComicDoc): { used: number; cap: number } => ({ used: archiveOf(doc).length, cap: MAX_ARCHIVE });

/** Anything to show in Media (the tab hides until the first image exists). Cheap: stops at the first image. */
export const hasMedia = (doc: ComicDoc): boolean => {
  const has = (r?: RenderState) => !!r && (!!r.asset?.path || r.history.length > 0);
  return (
    has(doc.cover.render) ||
    doc.pages.some((p) => has(p.render)) ||
    doc.cast.some((c) => has(c.sheet) || c.refs.length > 0) ||
    doc.places.some((p) => has(p.sheet) || p.refs.length > 0) ||
    doc.style.options.some((o) => has(o.render)) ||
    !!doc.style.board ||
    doc.style.refs.length > 0 ||
    archiveOf(doc).length > 0 ||
    trashOf(doc).some((t) => has(t.page.render)) ||
    (doc.refInbox || []).length > 0 ||
    doc.conversation.some((m) => !!m.attachments?.length)
  );
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';

const EXT_BY_MIME: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/avif': 'avif' };
const KNOWN_EXT = new Set(['webp', 'png', 'jpg', 'jpeg', 'gif', 'avif']);

/** The real file type: the downloaded bytes' MIME type, else the stored path's extension, else webp. */
export const downloadExt = (mime?: string, path?: string): string => {
  const fromMime = mime ? EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] : undefined;
  if (fromMime) return fromMime;
  const m = path ? /\.([a-z0-9]{2,5})$/i.exec(path) : null;
  const ext = m?.[1].toLowerCase();
  return ext && KNOWN_EXT.has(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : 'webp';
};

/** Safe download name: "<title>-<owner>-v<n>.<ext>" (no path separators, no control characters; ext from the real type). */
export const downloadName = (doc: ComicDoc, item: Pick<MediaItem, 'owner' | 'versionN'> & { path?: string }, mime?: string): string =>
  `${slug(doc.brief.title || 'comic')}-${slug(item.owner.label)}${item.versionN ? `-v${item.versionN}` : ''}.${downloadExt(mime, item.path)}`;

/** Whether a media image may become page/cover art without the explicit "adopt" confirmation. */
export const isArtRole = (role: MediaRole): boolean => role === 'page' || role === 'cover' || role === 'deleted_page';

export const mismatchText = (doc: ComicDoc, w?: number, h?: number): string | null =>
  w && h && !aspectMatches(doc.format.pageAspect, w, h) ? `${aspectFromSize(w, h)}, not ${doc.format.pageAspect}` : null;
