// Page breakdown card: the book at a glance in the chat (contract §13.3; softwarefirst.md §2.6;
// decisions-final #3). Owner: P1-BOOKMODEL.
//
//   ┌ Your book ─────────────────────────────── [Plan | Status | Cost] ┐
//   │ 3 pages · 9 panels · ≈$0.21 to draw (≈2% of your usage, governed) │
//   │ [cover] [p1 ▦] [p2 ▦] [p3 ▦]  ← filmstrip (scroll-snap, ←/→)     │
//   │ Page 2 · summary · panels (shot, cast, 💬, ▭) · warnings · acts │
//   │ [Approve & render all · ≈$0.21]                                 │
//   └─────────────────────────────────────────────────────────────────┘
//
// LIVE like every card: it re-reads `studio.doc`; the payload only scopes it (pageIds, cover,
// view, gateId). Legacy `{type:'plan'}` payloads render through the same component with defaults,
// so old conversations upgrade visually without a migration.
//
// Money is honest: quotes come from shared/comic/plan.ts (the server gate's own targeting and
// registry estimate), spent amounts from the doc's ledger. A drawn, current page is never quoted
// as "to draw". Inside a gate (`gateId`) every spend button is hidden — the gate owns approval.
// Every amount is printed for THIS user (conversation/cost.ts useCostFormat): governed users read a
// share of their usage ("≈2% of your usage") and never a dollar figure — also before their usage
// status has loaded; admins and comics on the user's own key read dollars.
// Easy shows the filmstrip and ONE primary action (details one tap away); Pro adds the view
// switcher, expanded details, word counts and QC.
// The Cost view is ../insights/CostInsights (models.md §4.1: the cost card, its Overview · Pages · Models ·
// Trends tabs — inline for Pro, "More details" for Easy — and the lock line).
//
// Plan fit (plan §4.1, §6; decision PD-1). Every wireframe panel carries a fit dot (green fits, amber tight, red
// too full — shapes differ too), and each panel row says it in words ("Fits (18 of 32 words)"). A page "Render all"
// would draw with a panel too full for its words is HELD BACK: its tile is outlined in red, it is left out of the
// quote and of the run (the server's gate does the same, jobs.ts planCheckGate), and its detail row lists the free
// fixes first — "Use the layout that fits" (shared ops.layoutFixOps: the blueprint plus panel sizes that agree with
// it, never a bare page.layout patch; offered only when it really fits once applied), the page editor, split or
// shorten with the director — then "Draw anyway". Outside a gate, Draw anyway adds the page to this card's
// `drawOverfull` and re-quotes; the primary action then sends `render_pages { drawOverfull }`. Inside an open
// "Render all" gate it extends that run: `render_pages { drawOverfull: [...gate's, page] }`, quoted as a whole.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  Coins,
  Image as ImageIcon,
  LayoutTemplate,
  MessageCircle,
  MessageSquare,
  Pencil,
  PanelsTopLeft,
  RectangleHorizontal,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  Zap
} from 'lucide-react';
import {
  findCharacter,
  type Card,
  type Character,
  type ComicDoc,
  type Page,
  type QualityTier
} from '../../../shared/comic/doc';
import {
  LOW_QC_SCORE,
  coverNeedsDraw,
  quoteRenderPages,
  summarizeBook,
  unitPrice,
  type BookSummary,
  type PanelSummary,
  type PageSummary
} from '../../../shared/comic/plan';
import { applyOps, layoutFixOps, type DocOp, type StudioAction } from '../../../shared/comic/ops';
import { checkPagePlan } from '../../../shared/comic/pagePlanCheck';
import { panelWords, textUnitFor, unitCount, type TextUnit } from '../../../shared/comic/panelRules';
import { aspectMismatch, continuityHint } from '../../../shared/comic/book';
import { effectiveRating, safetyStatusOf, type ContentRating, type SafetyVerdict } from '../../../shared/comic/safety';
import { ACCENT_SOFT_BG, TONE_CHIP, TONE_FILL, TONE_SURFACE, TONE_TEXT } from '../../chat/studioDesign';
import {
  SHOT_LABEL,
  SIZE_LABEL,
  byokFromDoc,
  cssAspect,
  initials,
  nameHue,
  plural
} from '../board/boardModel';
import { composeInStudio } from '../conversation/composerBus';
import { CardShell, ChipButton, GhostButton, PrimaryButton, Segmented, cx } from '../conversation/ui';
import { useAction } from '../conversation/cards/useAction';
import { useCostFormat, type CostFormat } from '../conversation/cost';
import { amountInSentence, compactUsageShare } from '../../../services/costDisplay';
import type { CardProps } from '../extensions';
import { FIT_DOT_COLOR, PageWireframe, fitDotOf, type FitDot } from './PageWireframe';
import { CostInsights } from '../insights/CostInsights';

export type BreakdownCardData = Extract<Card, { type: 'breakdown' }>;
/** The pre-v5 plan card payload; rendered by this component with defaults. */
export type LegacyPlanCardData = Extract<Card, { type: 'plan' }>;

export type BreakdownCardProps = CardProps<BreakdownCardData | LegacyPlanCardData> & { compact?: boolean };

export type BreakdownView = 'plan' | 'status' | 'cost';

/** localStorage key (contract §13.5): { [cardId]: view }, capped. */
export const BREAKDOWN_VIEW_KEY = 'comicstudio.breakdown.view';
const MAX_STORED_VIEWS = 60;
const TILE_W = 132;
const TILE_W_COMPACT = 96;
const MAX_AVATARS = 3;

const VIEWS: BreakdownView[] = ['plan', 'status', 'cost'];
const isView = (v: unknown): v is BreakdownView => typeof v === 'string' && (VIEWS as string[]).includes(v);

export const readStoredView = (cardId: string): BreakdownView | undefined => {
  try {
    const raw = window.localStorage.getItem(BREAKDOWN_VIEW_KEY);
    if (!raw) return undefined;
    const map = JSON.parse(raw) as unknown;
    const v = map && typeof map === 'object' ? (map as Record<string, unknown>)[cardId] : undefined;
    return isView(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

export const storeView = (cardId: string, view: BreakdownView): void => {
  try {
    const raw = window.localStorage.getItem(BREAKDOWN_VIEW_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const map: Record<string, BreakdownView> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (k !== cardId && isView(v)) map[k] = v;
    }
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - (MAX_STORED_VIEWS - 1)))) delete map[k];
    map[cardId] = view;
    window.localStorage.setItem(BREAKDOWN_VIEW_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota: the view just isn't remembered */
  }
};

const prefersReducedMotion = (): boolean => {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

interface CardSpec { pageIds?: string[]; cover?: boolean; view?: BreakdownView; gateId?: string }
const specOf = (card: BreakdownCardData | LegacyPlanCardData): CardSpec =>
  card.type === 'breakdown'
    ? {
        pageIds: Array.isArray(card.pageIds) ? card.pageIds.filter((id): id is string => typeof id === 'string') : undefined,
        cover: typeof card.cover === 'boolean' ? card.cover : undefined,
        view: isView(card.view) ? card.view : undefined,
        gateId: typeof card.gateId === 'string' && card.gateId ? card.gateId : undefined
      }
    : {};

type Status = PageSummary['status'];
const STATUS_LABEL: Record<Status, string> = {
  planned: 'Not drawn',
  queued: 'Queued',
  rendering: 'Drawing',
  ready: 'Drawn',
  stale: 'Out of date',
  failed: 'Failed',
  custom: 'Your art'
};
const STATUS_DOT: Record<Status, string> = {
  planned: 'bg-[var(--ds-hairline)]',
  queued: 'bg-[var(--ds-muted)]',
  rendering: 'bg-[var(--ds-accent)] motion-safe:animate-pulse',
  ready: TONE_FILL.success,
  stale: TONE_FILL.warning,
  failed: TONE_FILL.danger,
  custom: TONE_FILL.success
};

const StatusPill: React.FC<{ status: Status; className?: string }> = ({ status, className }) => (
  <span className={cx('inline-flex min-w-0 items-center gap-1 text-[11px] text-[var(--ds-muted)]', className)}>
    <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />
    <span className="truncate">{STATUS_LABEL[status]}</span>
  </span>
);

/** A held-back page's status word (the hue always comes with the word). */
const HeldPill: React.FC<{ className?: string }> = ({ className }) => (
  <span className={cx('inline-flex min-w-0 items-center gap-1 text-[11px] font-medium', TONE_TEXT.danger, className)}>
    <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_FILL.danger)} aria-hidden />
    <span className="truncate">Held back</span>
  </span>
);

const isDrawnStatus = (s: Status) => s === 'ready' || s === 'custom';
const isBusyStatus = (s: Status) => s === 'queued' || s === 'rendering';

/** Focus ring for every control here (Atlas --ds-ring: ≥ 3:1 on paper, glass and wells). */
const RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';

// ── Plan fit (plan §4.1, §6) ─────────────────────────────────────────────────

/**
 * A paid amount in THIS user's terms: a share of the usage for governed users (never dollars), dollars "on your
 * key" for comics drawn on the user's own key, plain dollars for admins.
 */
export const paidAmount = (cost: CostFormat, usd: number, byok: boolean): string =>
  !cost.governed && byok ? `${cost.badge(usd)} on your key` : cost.badge(usd);

/** "Fits (18 of 32 words)" · "Tight — 30 of 32 words" · "Too full — 29 words, fits about 11" (plan §6 exact copy). */
export const fitWords = (dot: FitDot, words: number, budget: number, unit: Pick<TextUnit, 'noun'>): string => {
  const u = unit as TextUnit;
  if (dot === 'overfull') return `Too full — ${unitCount(words, u)}, fits about ${budget}`;
  if (dot === 'tight') return `Tight — ${words} of ${unitCount(budget, u)}`;
  return `Fits (${words} of ${unitCount(budget, u)})`;
};

/**
 * The free "Use the layout that fits" fix for a held-back page (K1 contract, the server's heldBackLayoutFixOps):
 * the shared `layoutFixOps` — the blueprint PLUS panel sizes that agree with it; a bare `page.layout` patch would
 * leave a 'wide' panel in a shared row and the prompt would draw the old, overfull layout. Null (no chip) when it
 * gives no ops, or when the page is still overfull once they are applied.
 */
export const layoutFitFix = (doc: ComicDoc, page: Page, layout: string | undefined): DocOp[] | null => {
  if (!layout) return null;
  const ops = layoutFixOps(doc, page, layout);
  if (!ops.length) return null;
  const fitted = applyOps(doc, ops);
  const after = fitted.pages.find((p) => p.id === page.id);
  if (!after) return null;
  return checkPagePlan(fitted, after, { fixLayout: false }).state === 'overfull' ? null : ops;
};

type RenderPagesAction = Extract<StudioAction, { type: 'render_pages' }>;

/** The open "Render all" (render_pages with no pageIds and no force) the card's gate is waiting on, else null. */
export const gateRenderAll = (doc: ComicDoc, gateId: string | undefined): RenderPagesAction | null => {
  const gate = gateId && doc.gate && doc.gate.id === gateId && doc.gate.status === 'open' ? doc.gate : null;
  const action = gate?.action;
  if (!action || action.type !== 'render_pages' || action.force) return null;
  return Array.isArray(action.pageIds) && action.pageIds.length ? null : action;
};

/**
 * Pages a gate's run draws whatever their fit (the server's gate applies to "Render all" only): its drawOverfull,
 * or — for an explicit page draw or a forced redraw — every page it names.
 */
const gateDrawsAnyway = (doc: ComicDoc, gateId: string): string[] => {
  const action = doc.gate && doc.gate.id === gateId ? doc.gate.action : null;
  if (!action || action.type !== 'render_pages') return [];
  if (Array.isArray(action.pageIds) && action.pageIds.length) return action.pageIds.filter((id): id is string => typeof id === 'string');
  if (action.force) return doc.pages.map((p) => p.id);
  return Array.isArray(action.drawOverfull) ? action.drawOverfull.filter((id): id is string => typeof id === 'string') : [];
};

/** "6", "3 and 6", "2, 3 and 6". */
const listNumbers = (ns: number[]): string => (ns.length <= 1 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

/** Panels (1-based) of a summary that are too full for their words. */
const overfullPanels = (s: Pick<PageSummary, 'panels'>): number[] => s.panels.filter((p) => p.fitState === 'overfull').map((p) => p.n);

/** What the selected page's detail row can do about its plan fit (computed by the card, which owns the run). */
interface PageFitActions {
  /** Left out of this card's run and quote: overfull and not drawn anyway. */
  heldBack: boolean;
  /** Outside a gate: the user chose "Draw anyway" for this overfull page (it is in the run and the quote). */
  anyway: boolean;
  /** The free "Use the layout that fits" ops, when they really fit (layoutFitFix). */
  layoutFix: DocOp[] | null;
  fixPending: boolean;
  onLayoutFix?(): void;
  /** Outside a gate: what adding this page to the run adds to its quote. */
  anywayUsd?: number;
  onAnyway?(on: boolean): void;
  /** Inside an open "Render all" gate: that run extended with this page, quoted as a whole. */
  gateAnyway?: { usd: number; pending: boolean; run(): void };
}

/**
 * A share for a narrow cell: "≈2%" / "<0.1%" for governed users (the panel says "of your usage"
 * once), the dollar string otherwise. Undefined when a governed user's share isn't known yet — a
 * narrow cell then shows nothing rather than a vague phrase (and never dollars).
 */
export const shortCost = (cost: CostFormat, usd: number, kind: 'spent' | 'quote'): string | undefined => {
  if (!cost.governed) return kind === 'quote' ? cost.badge(usd) : cost.exact(usd);
  return compactUsageShare(cost.exact(usd));
};

/** Spent (drawn) or to-draw cost of a tile, printed for this user; undefined when there is no real number. */
const tileCost = (
  s: { status: Status; spentUsd?: number; costUsd?: number; quoteUsd?: number },
  cost: CostFormat
): { text?: string; spoken: string } | undefined => {
  const spent = s.spentUsd ?? s.costUsd;
  if (isDrawnStatus(s.status) && typeof spent === 'number' && spent > 0) {
    return { text: shortCost(cost, spent, 'spent'), spoken: `${amountInSentence(cost.governed ? cost.spoken(spent) : cost.exact(spent))} spent` };
  }
  if (typeof s.quoteUsd === 'number' && s.quoteUsd > 0) return { text: shortCost(cost, s.quoteUsd, 'quote'), spoken: `${amountInSentence(cost.spoken(s.quoteUsd))} to draw` };
  return undefined;
};

const TIER_LABEL: Record<QualityTier, string> = { draft: 'Draft', standard: 'Standard', pro: 'Pro' };

/** What a screen reader hears after the tile's visible label: ", about $0.07 to draw, not drawn, 2 panels". */
const tileSpoken = (t: { status: Status; summary?: PageSummary; cost?: { spoken: string }; extra: string[] }): string =>
  `, ${[t.cost?.spoken, STATUS_LABEL[t.status].toLowerCase(), t.summary ? plural(t.summary.panels.length, 'panel') : '', ...t.extra].filter(Boolean).join(', ')}`;

// ── Avatars ──────────────────────────────────────────────────────────────────

/** Art the safety check holds (blocked, or above this comic's rating) is never shown as an image here. */
const isHeld = (asset: { safety?: SafetyVerdict } | undefined, rating: ContentRating): boolean => {
  const s = safetyStatusOf(asset?.safety, rating);
  return s === 'blocked' || s === 'over_rating';
};

const CastAvatar: React.FC<{ character: Character; rating: ContentRating; urlFor: BreakdownCardProps['studio']['urlFor'] }> = ({ character, rating, urlFor }) => {
  const [failed, setFailed] = useState(false);
  const sheet = character.sheet.status === 'ready' ? character.sheet.asset : undefined;
  const src = sheet && !failed && !isHeld(sheet, rating) ? urlFor(sheet, { width: 48 }) : undefined;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        title={character.name}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-5 w-5 shrink-0 rounded-full object-cover ring-2 ring-[var(--ds-surface-soft)]"
      />
    );
  }
  const hue = nameHue(character.name);
  return (
    <span
      title={character.name}
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[8.5px] font-semibold text-white ring-2 ring-[var(--ds-surface-soft)]"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 55%), hsl(${(hue + 40) % 360} 55% 42%))` }}
    >
      {initials(character.name)}
    </span>
  );
};

// ── Tiles ────────────────────────────────────────────────────────────────────

interface Tile {
  key: string; // 'cover' | page id
  kind: 'cover' | 'page';
  label: string;
  status: Status;
  page?: Page;
  summary?: PageSummary;
  /** Extra words for screen readers after the visible ones (panel count, flags). */
  extra: string[];
  cost?: { text?: string; spoken: string };
  flag?: string;
  /** Overfull and left out of "Render all" and its quote until fixed or drawn anyway (PD-1). */
  heldBack?: boolean;
}

const Thumb: React.FC<{
  tile: Tile;
  doc: ComicDoc;
  book: BookSummary;
  showArt: boolean;
  width: number;
  urlFor: BreakdownCardProps['studio']['urlFor'];
}> = ({ tile, doc, book, showArt, width, urlFor }) => {
  const [failed, setFailed] = useState<string | null>(null);
  const asset = tile.kind === 'cover' ? doc.cover.render.asset : tile.page?.render.asset;
  const safety = tile.kind === 'cover' ? book.cover.safety : tile.summary?.safety;
  const held = safety === 'blocked' || safety === 'over_rating';
  const src = showArt && asset && !held ? urlFor(asset, { width }) : undefined;
  const art = src && failed !== src;
  return (
    <div
      data-held-back={tile.heldBack ? 'true' : undefined}
      className={cx(
        'relative w-full overflow-hidden rounded-lg border bg-[var(--ds-raised)]',
        tile.heldBack ? 'border-[var(--ds-danger)] ring-1 ring-[var(--ds-danger)]' : 'border-[var(--ds-hairline)]'
      )}
      style={{ aspectRatio: cssAspect(doc.format.pageAspect) }}
    >
      {art ? (
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src!)} className="h-full w-full object-cover" />
      ) : tile.kind === 'cover' ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[var(--ds-well)] p-2 text-center" aria-hidden>
          <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Cover</span>
          <span className="line-clamp-3 break-words text-[12px] font-semibold leading-tight text-[var(--ds-ink)]">{book.cover.title || 'Untitled'}</span>
        </div>
      ) : (
        <PageWireframe panels={tile.summary?.panels ?? []} aspect={doc.format.pageAspect} detail={width >= TILE_W} />
      )}
      {held ? (
        <span className="absolute inset-x-1 bottom-1 inline-flex items-center justify-center gap-1 rounded-md bg-[var(--ds-surface-strong)] px-1 py-0.5 text-[9.5px] text-[var(--ds-ink)]" aria-hidden>
          <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">{safety === 'blocked' ? 'Held for review' : 'Above rating'}</span>
        </span>
      ) : tile.heldBack ? (
        <span
          className={cx('absolute inset-x-1 bottom-1 inline-flex min-w-0 items-center justify-center gap-1 rounded-md bg-[var(--ds-surface-strong)] px-1 py-0.5 text-[9.5px] font-medium', TONE_TEXT.danger)}
          aria-hidden
        >
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden /> <span className="min-w-0 truncate">Too full</span>
        </span>
      ) : null}
      {tile.flag && (
        <span className={cx('absolute left-1 top-1 h-2 w-2 rounded-full ring-2 ring-[var(--ds-surface)]', TONE_FILL.warning)} title={tile.flag} aria-hidden />
      )}
      {isBusyStatus(tile.status) && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden>
          <span className="rounded-full bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10px] font-medium text-[var(--ds-ink)] shadow-sm">
            {tile.status === 'queued' ? 'Queued' : 'Drawing…'}
          </span>
        </span>
      )}
    </div>
  );
};

// ── The card ─────────────────────────────────────────────────────────────────

export const BreakdownCard: React.FC<BreakdownCardProps> = ({ card, studio, compact }) => {
  const doc = studio.doc;
  const spec = useMemo(() => specOf(card), [card]);
  const pro = studio.mode === 'pro';
  const inGate = !!spec.gateId;
  const byok = typeof (studio as { byok?: unknown }).byok === 'boolean' ? !!(studio as { byok?: boolean }).byok : doc ? byokFromDoc(doc) : false;
  const { run, isPending, anyPending } = useAction(studio.act);
  // Prices in the viewer's terms (governed users never see dollars, even before their status loads).
  const cost = useCostFormat({ byok, caps: studio.caps });

  const [wholeBook, setWholeBook] = useState(false);
  const pageKey = doc ? doc.pages.map((p) => `${p.id}:${p.n}`).join(',') : '';
  const scope = useMemo(() => {
    if (!doc || wholeBook || !spec.pageIds?.length) return { ids: undefined as string[] | undefined, gone: false };
    const ids = spec.pageIds.filter((id) => doc.pages.some((p) => p.id === id));
    return ids.length ? { ids, gone: false } : { ids: undefined, gone: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, wholeBook, spec.pageIds]);

  // "Draw anyway" (plan §4.1, PD-1): overfull pages this card will draw although they are too full. Outside a gate
  // it is the user's choice here (sent as render_pages.drawOverfull with the primary action); inside a gate it is
  // what that gate's run already draws regardless of fit (its drawOverfull, or the pages an explicit draw names).
  const [chosenAnyway, setChosenAnyway] = useState<string[]>([]);
  const gateAnywayKey = doc && spec.gateId ? gateDrawsAnyway(doc, spec.gateId).join(',') : '';
  const drawAnyway = useMemo(() => {
    if (!doc) return [] as string[];
    const ids = spec.gateId ? gateAnywayKey.split(',').filter(Boolean) : chosenAnyway;
    return ids.filter((id) => doc.pages.some((p) => p.id === id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, spec.gateId, gateAnywayKey, chosenAnyway]);
  const setAnyway = useCallback((pageId: string, on: boolean) => {
    setChosenAnyway((prev) => (on ? (prev.includes(pageId) ? prev : [...prev, pageId]) : prev.filter((id) => id !== pageId)));
  }, []);

  const rating = doc ? effectiveRating(doc).rating : 'PG-13';
  const book = useMemo(
    () => (doc ? summarizeBook(doc, { pageIds: scope.ids, byok, rating, drawOverfull: drawAnyway }) : null),
    [doc, scope.ids, byok, rating, drawAnyway]
  );
  const tier = doc?.settings.quality ?? 'standard';
  const override = doc?.settings.imageModelOverride;
  // The quote leaves held-back pages out, exactly like the server's "Render all" gate (and, for a subset, the
  // explicit page list the primary action sends is this quote's pageIds — held-back pages are not in it).
  const quote = useMemo(
    () => (doc ? quoteRenderPages(doc, { pageIds: scope.ids, byok, tier, modelOverride: override, holdBack: { drawOverfull: drawAnyway } }) : null),
    [doc, scope.ids, byok, tier, override, drawAnyway]
  );

  const anyDrawn = !!doc?.pages.some((p) => p.render.status === 'ready' && !!p.render.asset);
  const [view, setViewState] = useState<BreakdownView>(() => readStoredView(card.id) ?? spec.view ?? (anyDrawn ? 'status' : 'plan'));
  const setView = useCallback(
    (v: BreakdownView) => {
      setViewState(v);
      storeView(card.id, v);
    },
    [card.id]
  );
  const showCover = !scope.ids && !!doc && (spec.cover ?? (doc.pages.length > 1 || doc.cover.render.status !== 'none'));

  const tiles: Tile[] = useMemo(() => {
    if (!doc || !book) return [];
    const out: Tile[] = [];
    if (showCover) {
      const c = book.cover;
      const rc = doc.cover.render.costUsd;
      const tc = tileCost({ status: c.status, spentUsd: c.spentUsd, costUsd: typeof rc === 'number' ? rc : undefined, quoteUsd: c.quoteUsd }, cost);
      const held = c.safety === 'blocked' ? 'held for review' : c.safety === 'over_rating' ? 'above rating' : '';
      out.push({
        key: 'cover',
        kind: 'cover',
        label: 'Cover',
        status: c.status,
        cost: tc,
        extra: [held].filter(Boolean)
      });
    }
    for (const s of book.pages) {
      const page = doc.pages.find((p) => p.id === s.id);
      if (!page) continue;
      const heldBack = !!s.planFit?.heldBack;
      // A held-back page is not in the price: its tile shows no "to draw" amount.
      const tc = heldBack ? undefined : tileCost(s, cost);
      const flags: string[] = [];
      if (s.aspectOk === false) flags.push(`Not ${doc.format.pageAspect}`);
      if (typeof s.qcScore === 'number' && s.qcScore < LOW_QC_SCORE) flags.push('Quality check flagged it');
      const held = s.safety === 'blocked' ? 'held for review' : s.safety === 'over_rating' ? 'above rating' : '';
      const over = overfullPanels(s);
      const fit = over.length ? `${heldBack ? 'held back: ' : ''}${over.length === 1 ? 'panel' : 'panels'} ${listNumbers(over)} too full` : '';
      out.push({
        key: s.id,
        kind: 'page',
        label: `Page ${s.n}`,
        status: s.status,
        page,
        summary: s,
        cost: tc,
        flag: flags.length ? flags.join(' · ') : undefined,
        extra: [held, fit, ...flags].filter(Boolean),
        ...(heldBack ? { heldBack: true } : {})
      });
    }
    return out;
  }, [doc, book, showCover, cost]);

  // A held-back page opens first: its free fixes are the next thing to do (else the first page, as before).
  const firstPageKey = tiles.find((t) => t.heldBack)?.key ?? tiles.find((t) => t.kind === 'page')?.key ?? tiles[0]?.key ?? '';
  const [selectedKey, setSelectedKey] = useState<string>('');
  const selected = tiles.find((t) => t.key === selectedKey) ?? tiles.find((t) => t.key === firstPageKey);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(pro && !compact);
  useEffect(() => {
    setDetailsOpen(pro && !compact);
  }, [pro, compact]);

  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusKey = useRef<string | null>(null);
  useEffect(() => {
    const key = focusKey.current;
    if (!key) return;
    focusKey.current = null;
    const el = tileRefs.current.get(key);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });

  const select = (key: string, focus = false) => {
    if (focus) focusKey.current = key;
    setSelectedKey(key);
  };

  const onStripKeyDown = (e: React.KeyboardEvent) => {
    if (!tiles.length) return;
    const i = Math.max(0, tiles.findIndex((t) => t.key === selected?.key));
    let next = i;
    if (e.key === 'ArrowRight') next = Math.min(tiles.length - 1, i + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tiles.length - 1;
    else return;
    e.preventDefault();
    select(tiles[next].key, true);
  };

  if (!doc || !book || !quote) return null;

  const title = 'Your book';
  const icon = <LayoutTemplate className="h-4 w-4" />;
  const tileW = compact ? TILE_W_COMPACT : TILE_W;

  if (!doc.pages.length) {
    return (
      <CardShell title={title} icon={icon} aria-label="Page breakdown" className="min-w-0 max-w-full">
        <p className="text-[13px] text-[var(--ds-muted)]">There are no pages yet. Tell me about the story and I’ll plan them — you’ll see every page here before anything is drawn.</p>
        {!inGate && (
          <div className="mt-3">
            <GhostButton size="sm" className="tap-target" busy={isPending('plan')} onClick={() => void run('plan', { type: 'plan_pages' })}>
              Plan the pages
            </GhostButton>
          </div>
        )}
      </CardShell>
    );
  }

  const panelTotal = book.pages.reduce((n, p) => n + p.panels.length, 0);
  const drawing = book.pages.filter((p) => isBusyStatus(p.status)).length;
  const allDrawn = book.pages.length > 0 && book.pages.every((p) => isDrawnStatus(p.status));
  const approved = doc.planStatus === 'approved';
  const subset = !!scope.ids;
  const showArt = view !== 'plan';
  const coverNeeds = !subset && coverNeedsDraw(doc);
  const coverBusy = doc.cover.render.status === 'queued' || doc.cover.render.status === 'rendering';
  const starting = isPending('approve') || isPending('draw') || isPending('approve-only');
  // Held back from this card's run and quote (overfull, not drawn anyway), in page order.
  const heldBackPages = book.pages.filter((p) => p.planFit?.heldBack);
  // The run the primary action starts carries the pages drawn anyway (only "Render all" is gated on the server;
  // a subset sends the quote's own page list, which already includes them and leaves held-back pages out).
  // Only pages still too full need it (one fixed meanwhile is simply drawn).
  const anywayInRun = drawAnyway.filter((id) => {
    if (!quote.pageIds.includes(id)) return false;
    const s = book.pages.find((p) => p.id === id);
    return !s || overfullPanels(s).length > 0;
  });
  const renderAllAction = (): StudioAction => ({ type: 'render_pages', ...(anywayInRun.length ? { drawOverfull: anywayInRun } : {}), quotedUsd: quote.usd });
  const gateRun = inGate ? gateRenderAll(doc, spec.gateId) : null;

  // ── Header meta (wraps; never widens the chat) ──
  const metaQuote = quote.nothing ? (
    heldBackPages.length ? null : <span>{allDrawn ? 'all drawn' : drawing ? `${drawing} drawing` : 'nothing to draw'}</span>
  ) : pro || view === 'cost' ? (
    <span>{amountInSentence(cost.badge(quote.usd))} to draw</span>
  ) : (
    // A real 44 px target on touch (not a 16 px inline link whose ::after hit area overlapped the
    // rows around it — P1-QA breakdown-inline-links). Its name is its visible words, then the hint.
    <button
      type="button"
      onClick={() => setView('cost')}
      title="Show the cost breakdown"
      className={cx('inline-flex items-center rounded underline decoration-dotted underline-offset-2 hover:text-[var(--ds-ink)] coarse:min-h-11 coarse:px-1', RING)}
    >
      {amountInSentence(cost.badge(quote.usd))} to draw
      <span className="sr-only">. Show the cost breakdown</span>
    </button>
  );
  const meta = (
    <div className="-mt-1 mb-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] tabular-nums text-[var(--ds-muted)]">
      <span>
        {plural(book.pages.length, 'page')}
        {subset ? ` of ${doc.pages.length}` : ''} · {plural(panelTotal, 'panel')}
      </span>
      {metaQuote && (
        <>
          <span aria-hidden>·</span>
          {metaQuote}
        </>
      )}
      {heldBackPages.length > 0 && (
        <>
          <span aria-hidden>·</span>
          <span className={cx('inline-flex items-center gap-1 font-medium', TONE_TEXT.danger)} data-testid="breakdown-held-back">
            <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
            {plural(heldBackPages.length, 'page')} held back
          </span>
        </>
      )}
      {approved && !subset && (
        <>
          <span aria-hidden>·</span>
          <span>approved</span>
        </>
      )}
    </div>
  );

  // ── View controls: Pro gets Plan / Status / Cost; Easy gets an Art ⇄ Layout toggle once art exists ──
  const controls = pro ? (
    <Segmented<BreakdownView>
      label="Breakdown view"
      value={view}
      onChange={setView}
      className="mb-2"
      options={[
        { value: 'plan', label: <><PanelsTopLeft className="h-3.5 w-3.5" aria-hidden /> Plan</>, title: 'Panel layouts' },
        { value: 'status', label: <><ImageIcon className="h-3.5 w-3.5" aria-hidden /> Status</>, title: 'Drawn art' },
        { value: 'cost', label: <><Coins className="h-3.5 w-3.5" aria-hidden /> Cost</>, title: 'What was spent and what is left' }
      ]}
    />
  ) : anyDrawn || view === 'cost' ? (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {anyDrawn && (
        <button
          type="button"
          aria-pressed={showArt}
          onClick={() => setView(showArt ? 'plan' : 'status')}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 text-[11.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:h-11 coarse:px-3.5"
        >
          {showArt ? <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden /> : <ImageIcon className="h-3.5 w-3.5" aria-hidden />}
          {showArt ? 'Show layouts' : 'Show art'}
        </button>
      )}
      {view === 'cost' && (
        <button
          type="button"
          onClick={() => setView(anyDrawn ? 'status' : 'plan')}
          className="inline-flex h-7 items-center rounded-full px-2 text-[11.5px] text-[var(--ds-muted)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:h-11 coarse:px-3"
        >
          Hide costs
        </button>
      )}
    </div>
  ) : null;

  // ── Filmstrip ──
  const strip = (
    <div className="min-w-0">
      <ul
        role="list"
        aria-label="Pages in this book. Use the left and right arrow keys to move between them."
        onKeyDown={onStripKeyDown}
        className="-mx-1 flex min-w-0 snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-1 pb-2 pt-0.5 [scrollbar-width:thin]"
      >
        {tiles.map((t) => {
          const on = t.key === selected?.key;
          return (
            // `relative`: each tile is the containing block of its `sr-only` (position:absolute) name text.
            // Without it that text is placed against the page, not the scrolling strip, so the strip
            // does not clip it and the last tile's text widens the whole document (P2-GATE
            // breakdown-strip-sronly-overflow).
            <li key={t.key} className="relative shrink-0 snap-start" style={{ width: tileW }}>
              <button
                type="button"
                ref={(el) => {
                  if (el) tileRefs.current.set(t.key, el);
                  else tileRefs.current.delete(t.key);
                }}
                tabIndex={on ? 0 : -1}
                aria-current={on ? 'true' : undefined}
                // No aria-label: the name IS the visible label row ("Page 2", the cost, the status), with
                // spoken words added after it — it always starts with what is on screen (WCAG 2.5.3, P1-QA
                // breakdown-tile-names). The thumbnail's own text (wireframe numbers, overlays) is hidden.
                title={t.cost?.text && cost.governed ? `${t.label}: ${t.cost.spoken}` : undefined}
                onClick={() => select(t.key)}
                className={cx(
                  'block w-full rounded-xl p-1 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]',
                  on ? `${ACCENT_SOFT_BG} ring-1 ring-[var(--ds-ring)]` : 'hover:bg-[var(--ds-hover)]'
                )}
              >
                <Thumb tile={t} doc={doc} book={book} showArt={showArt} width={tileW} urlFor={studio.urlFor} />
                <span className="mt-1 flex min-w-0 items-baseline justify-between gap-1 px-0.5">
                  <span className="min-w-0 truncate text-[11.5px] font-medium text-[var(--ds-ink)]">{t.label}</span>
                  {t.cost?.text && (
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]" aria-hidden>
                      {t.cost.text}
                    </span>
                  )}
                  <span className="sr-only">{tileSpoken(t)}</span>
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1 px-0.5" aria-hidden>
                  {t.heldBack ? <HeldPill /> : <StatusPill status={t.status} />}
                  {t.summary && !compact && <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">· {plural(t.summary.panels.length, 'panel')}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  // ── Plan fit of one page: the free fixes and "Draw anyway" (plan §4.1, §4.4, PD-1) ──
  const planFitFor = (page: Page, s: PageSummary): PageFitActions => {
    const heldBack = !!s.planFit?.heldBack;
    const anyway = !inGate && chosenAnyway.includes(page.id) && overfullPanels(s).length > 0 && quote.pageIds.includes(page.id);
    const layoutFix = heldBack ? layoutFitFix(doc, page, s.planFit?.layoutFix) : null;
    // Keep this page selected while it stops being held back (else the detail would jump to another page).
    const keep = () => setSelectedKey(page.id);
    const out: PageFitActions = { heldBack, anyway, layoutFix, fixPending: isPending(`fit:${page.id}`) };
    if (layoutFix) {
      out.onLayoutFix = () => {
        keep();
        void run(`fit:${page.id}`, { type: 'patch', ops: layoutFix });
      };
    }
    if (!inGate && (heldBack || anyway)) {
      if (heldBack) {
        // What the run costs more with this page in it (the same holdBack quote the primary action uses).
        const withIt = quoteRenderPages(doc, { pageIds: scope.ids, byok, tier, modelOverride: override, holdBack: { drawOverfull: [...drawAnyway, page.id] } });
        out.anywayUsd = Math.max(0, Math.round((withIt.usd - quote.usd) * 10000) / 10000);
      }
      out.onAnyway = (on) => {
        keep();
        setAnyway(page.id, on);
      };
    }
    if (heldBack && gateRun) {
      // Next to an open "Render all" gate, Draw anyway EXTENDS that run (K1: the server's chip does the same) — a
      // single-page draw would retire the gate and drop the other pages' approval. Quoted as a whole.
      const next = [...new Set([...(gateRun.drawOverfull ?? []), page.id])].filter((id) => doc.pages.some((p) => p.id === id));
      const usd = quoteRenderPages(doc, { byok, tier, modelOverride: override, includeCover: !!gateRun.includeCover, holdBack: { drawOverfull: next } }).usd;
      const action: StudioAction = {
        type: 'render_pages',
        drawOverfull: next,
        ...(gateRun.includeCover ? { includeCover: true } : {}),
        ...(gateRun.safe ? { safe: true } : {}),
        quotedUsd: usd
      };
      out.gateAnyway = { usd, pending: isPending(`anyway:${page.id}`), run: () => void run(`anyway:${page.id}`, action) };
    }
    return out;
  };

  // ── Detail row for the selected tile ──
  const detail = selected ? (
    selected.kind === 'cover' ? (
      <CoverDetail
        doc={doc}
        book={book}
        byok={byok}
        inGate={inGate}
        open={detailsOpen}
        pro={pro}
        onToggle={() => setDetailsOpen((v) => !v)}
        cost={cost}
        busy={coverBusy}
        pending={isPending('cover-one')}
        disabled={anyPending}
        onDraw={(usd) => void run('cover-one', { type: 'render_cover', quotedUsd: usd })}
      />
    ) : selected.summary && selected.page ? (
      <PageDetail
        doc={doc}
        page={selected.page}
        s={selected.summary}
        byok={byok}
        inGate={inGate}
        open={detailsOpen}
        pro={pro}
        rating={rating}
        urlFor={studio.urlFor}
        cost={cost}
        unit={textUnitFor(doc.format.language)}
        fit={planFitFor(selected.page, selected.summary)}
        onToggle={() => setDetailsOpen((v) => !v)}
        pending={isPending(`page:${selected.page.id}`)}
        disabled={anyPending}
        onDraw={(force, usd) =>
          void run(`page:${selected.page!.id}`, { type: 'render_pages', pageIds: [selected.page!.id], ...(force ? { force: true } : {}), quotedUsd: usd })
        }
        onEdit={() => studio.openPage(selected.page!.id)}
        onBoard={() => studio.setTab('pages')}
      />
    ) : null
  ) : null;

  // ── Footer: one primary action ──
  let primary: React.ReactNode = null;
  if (!inGate) {
    if (!quote.nothing) {
      const drawLabel = `${plural(quote.pageIds.length, 'page')}${quote.sheetIds.length ? ` + ${plural(quote.sheetIds.length, 'sheet')}` : ''}`;
      primary =
        !approved && !subset ? (
          <PrimaryButton
            size="sm"
            className="tap-target"
            busy={isPending('approve')}
            disabled={starting}
            onClick={() => void run('approve', { type: 'approve_plan' }, renderAllAction())}
          >
            {/* decisions-final #3: the kept button's words. */}
            Approve &amp; render all · {cost.badge(quote.usd)}
          </PrimaryButton>
        ) : (
          <PrimaryButton
            size="sm"
            className="tap-target"
            busy={isPending('draw')}
            disabled={starting}
            onClick={() => {
              // A subset draws exactly the quote's pages (held-back ones are not in it). Never an empty list:
              // the server reads `pageIds: []` as "all".
              if (!subset) void run('draw', renderAllAction());
              else if (quote.pageIds.length) void run('draw', { type: 'render_pages', pageIds: quote.pageIds, quotedUsd: quote.usd });
            }}
          >
            Draw {drawLabel} · {cost.badge(quote.usd)}
          </PrimaryButton>
        );
    } else if (allDrawn && coverNeeds && !coverBusy && book.cover.quoteUsd) {
      const usd = book.cover.quoteUsd;
      primary = (
        <PrimaryButton size="sm" className="tap-target" busy={isPending('cover')} disabled={anyPending} onClick={() => void run('cover', { type: 'render_cover', quotedUsd: usd })}>
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> {book.cover.status === 'stale' ? 'Redraw the cover' : book.cover.status === 'failed' ? 'Try the cover again' : 'Make the cover'} · {cost.badge(usd)}
        </PrimaryButton>
      );
    } else if (allDrawn) {
      primary = (
        <PrimaryButton size="sm" className="tap-target" onClick={() => studio.runClientAction({ type: 'open_reader' })}>
          <BookOpen className="h-3.5 w-3.5" aria-hidden /> Read it
        </PrimaryButton>
      );
    }
  }

  const noPanels = book.pages.filter((p) => !p.panels.length).map((p) => p.n);
  const heldNs = heldBackPages.map((p) => p.n);
  const heldNote = !heldNs.length
    ? ''
    : heldNs.length === 1
      ? `Page ${heldNs[0]} is held back — a panel has more words than it can hold, so it isn’t in this price. Fix it free, or draw it anyway.`
      : `Pages ${listNumbers(heldNs)} are held back — panels with more words than they can hold, so they aren’t in this price. Fix them free, or draw them anyway.`;
  const baseNote = inGate
    ? null
    : quote.nothing && !allDrawn && drawing === 0 && noPanels.length
      ? `${noPanels.length === 1 ? `Page ${noPanels[0]} has` : `Pages ${noPanels.join(', ')} have`} no panels yet — add panels (free) before ${noPanels.length === 1 ? 'it' : 'they'} can be drawn.`
      : drawing > 0
      ? `Drawing ${plural(drawing, 'page')} — they appear here as they finish.`
      : allDrawn
        ? coverNeeds && !coverBusy
          ? book.cover.status === 'stale'
            ? 'Every page is drawn. The cover is out of date — the title, style or cast changed since it was drawn.'
            : 'Every page is drawn. The cover is the last step.'
          : 'Every page is drawn. Ask for changes any time — only what you change is redrawn.'
        : !quote.nothing
          ? `${approved ? '' : 'Nothing is drawn until you approve. '}${quote.model} · ${plural(quote.imageCount, 'image')}${byok ? ' · your own key' : ''}.`
          : null;
  const note = inGate ? null : [heldNote, baseNote].filter(Boolean).join(' ') || null;
  // "Want more moments? Add a page" (plan §4.1): the page count stays the user's choice; the price is one more page.
  const moments = !inGate && !subset && !allDrawn && book.moments && book.moments.addPageUsd > 0 ? book.moments : null;
  const lastPageN = doc.pages.reduce((n, p) => Math.max(n, p.n), 0);

  return (
    <CardShell title={title} icon={icon} aria-label="Page breakdown" className="min-w-0 max-w-full">
      {meta}
      {controls}
      {scope.gone && (
        <p className="mb-2 text-[12px] text-[var(--ds-muted)]">The pages this card showed are no longer in the book — here is the whole book.</p>
      )}
      {strip}
      {view === 'cost' && (
        <CostInsights
          doc={doc}
          book={book}
          quote={quote}
          byok={byok}
          pro={pro}
          cost={cost}
          coverLine={
            isDrawnStatus(book.cover.status)
              ? book.cover.spentUsd
                ? cost.exact(book.cover.spentUsd)
                : 'Drawn'
              : book.cover.quoteUsd
                ? cost.badge(book.cover.quoteUsd)
                : STATUS_LABEL[book.cover.status]
          }
          runClientAction={studio.runClientAction}
        />
      )}
      {detail}
      {(primary || (!inGate && pro)) && (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {primary}
          {!inGate && pro && !approved && !quote.nothing && !subset && (
            <GhostButton size="sm" className="tap-target" busy={isPending('approve-only')} disabled={starting} onClick={() => void run('approve-only', { type: 'approve_plan' })}>
              Approve only
            </GhostButton>
          )}
          {!inGate && pro && (
            <GhostButton size="sm" className="tap-target" onClick={() => studio.setTab('pages')}>
              Open in board
            </GhostButton>
          )}
        </div>
      )}
      {note && <p className={cx('mt-2 break-words text-[11.5px] text-[var(--ds-muted)]', (drawing > 0 || heldNs.length > 0) && 'text-[var(--ds-ink)]')}>{note}</p>}
      {moments && (
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 text-[11.5px] text-[var(--ds-muted)]" data-testid="breakdown-moments">
          <span>Want more moments?</span>{' '}
          <button
            type="button"
            title="Tell the director what happens on it — planning is free, nothing is drawn until you approve"
            onClick={() => composeInStudio({ text: `Add a page after page ${lastPageN}: `, focus: true })}
            className={cx('inline-flex items-center rounded font-medium text-[var(--ds-ink)] underline decoration-dotted underline-offset-2 hover:text-[var(--ds-accent)] coarse:min-h-11 coarse:px-1', RING)}
          >
            Add a page
          </button>{' '}
          <span className="min-w-0 [overflow-wrap:anywhere]">· {amountInSentence(cost.badge(moments.addPageUsd))} to draw it</span>
        </p>
      )}
      {scope.ids && !inGate && (
        <button
          type="button"
          onClick={() => setWholeBook(true)}
          className="mt-1.5 inline-flex items-center rounded text-[12px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11 coarse:px-1"
        >
          Show the whole book
        </button>
      )}
    </CardShell>
  );
};

// ── Detail rows ──────────────────────────────────────────────────────────────

/** "A", "A and B", "A, B and C". */
const listNames = (names: string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const Chip: React.FC<{ children: React.ReactNode; icon?: React.ReactNode }> = ({ children, icon }) => (
  <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-[var(--ds-accent-soft)] px-2 py-1 text-[11.5px] leading-snug text-[var(--ds-ink)]">
    {icon && <span className="mt-px shrink-0 text-[var(--ds-accent)]">{icon}</span>}
    <span className="min-w-0 break-words">{children}</span>
  </span>
);

const DetailToggle: React.FC<{ open: boolean; onToggle(): void; controls: string }> = ({ open, onToggle, controls }) => (
  <button
    type="button"
    aria-expanded={open}
    aria-controls={controls}
    onClick={onToggle}
    className="inline-flex items-center gap-1 rounded text-[12px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11 coarse:px-1"
  >
    <ChevronDown className={cx('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
    {open ? 'Fewer details' : 'Panels & actions'}
  </button>
);

const PageDetail: React.FC<{
  doc: ComicDoc;
  page: Page;
  s: PageSummary;
  byok: boolean;
  inGate: boolean;
  open: boolean;
  pro: boolean;
  rating: ContentRating;
  urlFor: BreakdownCardProps['studio']['urlFor'];
  cost: CostFormat;
  /** What budgets count in this book: words, or characters for Japanese and Chinese. */
  unit: TextUnit;
  fit: PageFitActions;
  onToggle(): void;
  pending: boolean;
  disabled: boolean;
  onDraw(force: boolean, usd: number): void;
  onEdit(): void;
  onBoard(): void;
}> = ({ doc, page, s, byok, inGate, open, pro, rating, urlFor, cost, unit, fit, onToggle, pending, disabled, onDraw, onEdit, onBoard }) => {
  const id = `bd-${useId().replace(/:/g, '')}`;
  const tier = doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const busy = isBusyStatus(s.status);
  // The gate's own quotes (shared/comic/plan.ts): "draw" only when the server would draw it, and a
  // forced new take only for a drawn, current page. Both include any missing lead/support sheet.
  // A held-back page offers its free fixes and "Draw anyway" instead (the held-back panel below).
  const drawQ = quoteRenderPages(doc, { pageIds: [page.id], byok, tier, modelOverride: override });
  const q = drawQ.nothing || fit.heldBack ? null : drawQ;
  const redo = !q && !fit.heldBack && !busy && page.render.status === 'ready' && page.panels.length > 0
    ? quoteRenderPages(doc, { pageIds: [page.id], force: true, byok, tier, modelOverride: override })
    : null;
  const redrawUsd = redo && !redo.nothing ? redo.usd : undefined;
  const sheetQ = q ?? redo;
  const mismatch = page.render.status === 'ready' ? aspectMismatch(doc, page.render.asset) : null;
  const lowQc = typeof s.qcScore === 'number' && s.qcScore < LOW_QC_SCORE;
  const neighbors = pro && page.render.status === 'ready' && continuityHint(doc, page);
  const missing = s.missingRefCastIds.map((cid) => findCharacter(doc, cid)).filter((c): c is Character => !!c);
  const spent = s.spentUsd ?? s.costUsd;
  return (
    <section aria-label={`Page ${s.n} details`} className="mt-2 min-w-0 rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)] p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--ds-ink)]">
          Page {s.n}
          {s.chapterTitle ? <span className="font-normal text-[var(--ds-muted)]"> · {s.chapterTitle}</span> : null}
        </h4>
        {fit.heldBack ? <HeldPill className="shrink-0" /> : <StatusPill status={s.status} className="shrink-0" />}
      </div>
      <p className="mt-1 line-clamp-2 break-words text-[13px] leading-snug text-[var(--ds-ink)]">{s.summary || 'No summary yet.'}</p>
      {pro && s.turnHook && <p className="mt-1 break-words text-[11.5px] text-[var(--ds-muted)]">Page turn: {s.turnHook}</p>}

      {fit.heldBack && (
        <HeldBackFixes doc={doc} page={page} s={s} unit={unit} fit={fit} cost={cost} byok={byok} disabled={disabled} onEdit={onEdit} />
      )}
      {!fit.heldBack && fit.anyway && fit.onAnyway && (
        <div
          role="group"
          aria-label={`Page ${s.n} is drawn as is`}
          className={cx('mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2 text-[12px] text-[var(--ds-ink)]', TONE_SURFACE.warning)}
        >
          <TriangleAlert className={cx('h-3.5 w-3.5 shrink-0', TONE_TEXT.warning)} aria-hidden />
          <span className="min-w-0 flex-1 basis-[12rem] [overflow-wrap:anywhere]">
            Page {s.n} will be drawn as is, although {overfullPanels(s).length === 1 ? 'panel' : 'panels'} {listNumbers(overfullPanels(s))}{' '}
            {overfullPanels(s).length === 1 ? 'is' : 'are'} too full.
          </span>
          <ChipButton className="min-w-0 shrink-0" onClick={() => fit.onAnyway!(false)} disabled={disabled}>
            Hold it back
          </ChipButton>
        </div>
      )}

      {(missing.length > 0 || mismatch || lowQc || neighbors || s.status === 'stale' || s.safety === 'blocked') && (
        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
          {missing.length > 0 && (
            <>
              <Chip icon={<TriangleAlert className="h-3 w-3" aria-hidden />}>
                {listNames(missing.map((c) => c.name.toUpperCase()))} {missing.length === 1 ? 'has' : 'have'} no reference — may vary between pages
              </Chip>
              {/* Its own control beside the chip: a real 44 px target on touch (an inline 16 px link inside
                  the chip overlapped the rows around it — P1-QA breakdown-inline-links). */}
              <button
                type="button"
                onClick={() => composeInStudio({ text: `This is ${missing[0].name.toUpperCase()}: `, pickFiles: true, focus: true })}
                className="inline-flex items-center rounded-lg px-1.5 py-1 text-[11.5px] font-medium text-[var(--ds-accent)] underline decoration-dotted underline-offset-2 hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11 coarse:px-2.5"
              >
                Add a photo (free)
              </button>
            </>
          )}
          {s.status === 'stale' && <Chip icon={<RotateCcw className="h-3 w-3" aria-hidden />}>The script changed since this was drawn</Chip>}
          {mismatch && (
            <Chip icon={<RectangleHorizontal className="h-3 w-3" aria-hidden />}>
              Came back {mismatch.got}, the book is {mismatch.want} — fitting it is free in the board
            </Chip>
          )}
          {lowQc && (
            <Chip icon={<TriangleAlert className="h-3 w-3" aria-hidden />}>
              Quality check flagged it{pro && page.render.qc?.issues?.[0] ? `: ${page.render.qc.issues[0]}` : ''}
            </Chip>
          )}
          {neighbors && <Chip>The page before changed since this was drawn</Chip>}
          {s.safety === 'blocked' && <Chip icon={<ShieldAlert className="h-3 w-3" aria-hidden />}>Held for a safety review</Chip>}
        </div>
      )}

      {open && (
        <div id={id}>
          <ol className="mt-2 divide-y divide-[var(--ds-hairline-soft)]" aria-label={`Panels on page ${s.n}`}>
            {s.panels.map((p, i) => {
              const cast = p.castIds.map((cid) => findCharacter(doc, cid)).filter((c): c is Character => !!c);
              const dot = fitDotOf(p.fitState);
              return (
                <li key={p.n} className="min-w-0 py-1.5 text-[12px]" data-fit={dot}>
                  <div className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 text-right font-semibold tabular-nums text-[var(--ds-muted)]">{p.n}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--ds-ink)]">
                    {SHOT_LABEL[p.shot] ?? p.shot}
                    <span className="text-[var(--ds-muted)]"> · {SIZE_LABEL[p.size] ?? p.size}</span>
                  </span>
                  {cast.length > 0 && (
                    <span className="flex shrink-0 items-center -space-x-1.5">
                      <span className="sr-only">Cast: {cast.map((c) => c.name).join(', ')}.</span>
                      {cast.slice(0, MAX_AVATARS).map((c) => (
                        <CastAvatar key={c.id} character={c} rating={rating} urlFor={urlFor} />
                      ))}
                      {cast.length > MAX_AVATARS && (
                        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--ds-well-strong)] px-1 text-[9px] font-semibold text-[var(--ds-ink)] ring-2 ring-[var(--ds-surface-soft)]" aria-hidden>
                          +{cast.length - MAX_AVATARS}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums text-[11px] text-[var(--ds-muted)]">
                    {p.speech > 0 && (
                      <span className="inline-flex items-center gap-0.5" title={plural(p.speech, 'balloon')}>
                        <MessageCircle className="h-3 w-3" aria-hidden />
                        {p.speech}
                        <span className="sr-only"> {p.speech === 1 ? 'balloon' : 'balloons'}</span>
                      </span>
                    )}
                    {p.captions > 0 && (
                      <span className="inline-flex items-center gap-0.5" title={plural(p.captions, 'caption')}>
                        <MessageSquare className="h-3 w-3" aria-hidden />
                        {p.captions}
                        <span className="sr-only"> {p.captions === 1 ? 'caption' : 'captions'}</span>
                      </span>
                    )}
                    {p.sfx > 0 && (
                      <span className="inline-flex items-center gap-0.5" title={plural(p.sfx, 'sound effect')}>
                        <Zap className="h-3 w-3" aria-hidden />
                        {p.sfx}
                        <span className="sr-only"> sound {p.sfx === 1 ? 'effect' : 'effects'}</span>
                      </span>
                    )}
                    {pro && p.words > 0 && !dot && <span title={plural(p.words, 'word')}>{p.words}w</span>}
                  </span>
                  </div>
                  {dot && typeof p.budget === 'number' && (
                    // The fit in words beside its dot (hue never alone): "Fits (18 of 32 words)".
                    <div className={cx('mt-0.5 flex min-w-0 items-center gap-1.5 pl-6 text-[11px]', dot === 'fits' ? 'text-[var(--ds-muted)]' : TONE_TEXT[dot === 'tight' ? 'warning' : 'danger'])}>
                      <FitGlyph dot={dot} />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{fitWords(dot, panelWords(page.panels[i] ?? { lines: [] }, unit), p.budget, unit)}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {pro && (s.model || typeof s.qcScore === 'number' || (typeof spent === 'number' && spent > 0)) && (
            <p className="mt-1.5 break-words text-[11px] tabular-nums text-[var(--ds-muted)]">
              {[
                s.model ? `Drawn with ${s.model}` : '',
                typeof spent === 'number' && spent > 0 ? `${amountInSentence(cost.exact(spent))} spent on this page` : '',
                typeof s.qcScore === 'number' ? `QC ${Math.round(s.qcScore * 100)}/100` : ''
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">
            {!inGate && q && !q.nothing && (
              <GhostButton size="sm" className="tap-target" busy={pending} disabled={disabled} onClick={() => onDraw(false, q.usd)}>
                Draw this page · {cost.badge(q.usd)}
              </GhostButton>
            )}
            {!inGate && redrawUsd !== undefined && (
              <GhostButton size="sm" className="tap-target" busy={pending} disabled={disabled} onClick={() => onDraw(true, redrawUsd)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> New take · {cost.badge(redrawUsd)}
              </GhostButton>
            )}
            {!inGate && busy && (
              <GhostButton size="sm" className="tap-target" disabled>
                Drawing…
              </GhostButton>
            )}
            <GhostButton size="sm" className="tap-target" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
            </GhostButton>
            <GhostButton size="sm" className="tap-target" onClick={onBoard}>
              Open in board
            </GhostButton>
            <GhostButton size="sm" className="tap-target" onClick={() => composeInStudio({ text: `Change page ${s.n}: `, focus: true })}>
              Ask AI to change…
            </GhostButton>
          </div>
          {sheetQ && sheetQ.sheetIds.length > 0 && !inGate && (
            <p className="mt-1.5 break-words text-[11px] text-[var(--ds-muted)]">
              Includes {plural(sheetQ.sheetIds.length, 'character sheet')} ({sheetQ.sheetIds.map((cid) => findCharacter(doc, cid)?.name).filter(Boolean).join(', ')}) so the cast stays consistent.
            </p>
          )}
        </div>
      )}
      {!pro || !open ? (
        <div className="mt-2">
          <DetailToggle open={open} onToggle={onToggle} controls={id} />
        </div>
      ) : null}
    </section>
  );
};

/** The fit dot as a small inline mark, the same shape as on the wireframe (a filled dot, a ring, a diamond). */
const FitGlyph: React.FC<{ dot: FitDot }> = ({ dot }) => (
  <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden focusable="false" data-fit-dot={dot}>
    {dot === 'fits' ? (
      <circle cx={5} cy={5} r={4} style={{ fill: FIT_DOT_COLOR.fits }} />
    ) : dot === 'tight' ? (
      <circle cx={5} cy={5} r={3.2} style={{ fill: 'none', stroke: FIT_DOT_COLOR.tight, strokeWidth: 2 }} />
    ) : (
      <rect x={1.6} y={1.6} width={6.8} height={6.8} transform="rotate(45 5 5)" style={{ fill: FIT_DOT_COLOR.overfull }} />
    )}
  </svg>
);

/** "Free" beside a fix done by the editor in software (decision #6: no AI cost). */
const FreeBadge: React.FC = () => (
  <span className={cx('shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold', TONE_CHIP.success)} title="Free — done by the editor, no AI cost">
    Free
  </span>
);

/** A paid amount beside a choice that spends ("≈$0.07", "≈1% of your usage", "≈$0.07 on your key"). */
const PriceBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="min-w-0 rounded-full bg-[var(--ds-well-strong)] px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-[var(--ds-muted)] [overflow-wrap:anywhere]">
    {children}
  </span>
);

/**
 * A held-back page (PD-1): what is wrong in one sentence, the worst panel's fit in words, then the fixes — free
 * first (the layout that fits, the page editor; split or shorten with the director, which only prefills the
 * composer), then "Draw anyway". Never a refusal: every choice is the user's.
 */
const HeldBackFixes: React.FC<{
  doc: ComicDoc;
  page: Page;
  s: PageSummary;
  unit: TextUnit;
  fit: PageFitActions;
  cost: CostFormat;
  byok: boolean;
  disabled: boolean;
  onEdit(): void;
}> = ({ page, s, unit, fit, cost, byok, disabled, onEdit }) => {
  const over = overfullPanels(s);
  const worstN = s.planFit?.panel ?? over[0];
  const wi = s.panels.findIndex((p) => p.n === worstN);
  const worst: PanelSummary | undefined = s.panels[wi];
  const words = worst ? panelWords(page.panels[wi] ?? { lines: [] }, unit) : 0;
  const subject =
    over.length > 1 ? `panels ${listNumbers(over)} have more words than they can hold` : `panel ${worstN ?? over[0] ?? 1} has more words than it can hold`;
  const lead = s.status === 'stale' ? `Page ${s.n} isn’t redrawn yet` : `Page ${s.n} isn’t drawn yet`;
  const budget = worst?.budget;
  return (
    <div role="group" aria-label={`Page ${s.n} is held back`} className={cx('mt-2 min-w-0 rounded-xl border px-3 py-2.5', TONE_SURFACE.danger)}>
      <p className="flex min-w-0 items-start gap-2 text-[12.5px] leading-snug text-[var(--ds-ink)]">
        <TriangleAlert className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', TONE_TEXT.danger)} aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {lead}: {subject}. Fix it free, or draw it anyway.
        </span>
      </p>
      {worst && typeof budget === 'number' && (
        <p className={cx('mt-1 flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-[11.5px]', TONE_TEXT.danger)}>
          <FitGlyph dot="overfull" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Panel {worst.n}: {fitWords('overfull', words, budget, unit)}
          </span>
        </p>
      )}
      <div className="mt-2 flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Fixes">
        {fit.onLayoutFix && (
          <ChipButton
            className="min-w-0"
            disabled={disabled || fit.fixPending}
            aria-busy={fit.fixPending || undefined}
            title="Re-arranges this page's panels so every panel's words fit. Free — done by the editor, no AI cost."
            onClick={fit.onLayoutFix}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">Use the layout that fits</span>
            <FreeBadge />
          </ChipButton>
        )}
        <ChipButton className="min-w-0" title="Open the page editor: move a line to another panel, make it a caption, or cut words." onClick={onEdit}>
          <span className="min-w-0 [overflow-wrap:anywhere]">Move or cut a line</span>
          <FreeBadge />
        </ChipButton>
        <ChipButton
          className="min-w-0"
          title="Ask the director to split it — nothing is drawn until you approve."
          onClick={() => composeInStudio({ text: `Split page ${s.n} into two pages so panel ${worstN ?? 1} has room for its words.`, focus: true })}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">Split the page…</span>
        </ChipButton>
        <ChipButton
          className="min-w-0"
          title="Ask the director to shorten it — nothing is drawn until you approve."
          onClick={() =>
            composeInStudio({
              text: `Shorten the words in panel ${worstN ?? 1} on page ${s.n}${typeof budget === 'number' ? ` to about ${unitCount(budget, unit)}` : ''}.`,
              focus: true
            })
          }
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">Shorten it…</span>
        </ChipButton>
        {fit.onAnyway && (
          <ChipButton
            className="min-w-0"
            selected={false}
            disabled={disabled}
            title="Draws this page as it is, with the rest — the drawing’s price goes up by this much. Nothing is drawn until you approve."
            onClick={() => fit.onAnyway!(true)}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">Draw anyway</span>
            {typeof fit.anywayUsd === 'number' && fit.anywayUsd > 0 && <PriceBadge>adds {amountInSentence(paidAmount(cost, fit.anywayUsd, byok))}</PriceBadge>}
          </ChipButton>
        )}
        {fit.gateAnyway && (
          <ChipButton
            className="min-w-0"
            disabled={disabled || fit.gateAnyway.pending}
            aria-busy={fit.gateAnyway.pending || undefined}
            title="Approves the drawing waiting above with this page in it, priced as a whole. Tapping is your OK; the price is re-checked before anything is drawn."
            onClick={fit.gateAnyway.run}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">Draw page {s.n} anyway (with the rest)</span>
            <PriceBadge>{paidAmount(cost, fit.gateAnyway.usd, byok)}</PriceBadge>
          </ChipButton>
        )}
      </div>
    </div>
  );
};

const CoverDetail: React.FC<{
  doc: ComicDoc;
  book: BookSummary;
  byok: boolean;
  inGate: boolean;
  open: boolean;
  pro: boolean;
  busy: boolean;
  pending: boolean;
  disabled: boolean;
  cost: CostFormat;
  onToggle(): void;
  onDraw(usd: number): void;
}> = ({ doc, book, byok, inGate, open, pro, busy, pending, disabled, cost, onToggle, onDraw }) => {
  const id = `bd-${useId().replace(/:/g, '')}`;
  const c = book.cover;
  const usd = c.quoteUsd ?? unitPrice(doc, 'cover', { byok }).usd;
  const drawn = isDrawnStatus(c.status);
  return (
    <section aria-label="Cover details" className="mt-2 min-w-0 rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)] p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--ds-ink)]">Cover</h4>
        <StatusPill status={c.status} className="shrink-0" />
      </div>
      <p className="mt-1 line-clamp-2 break-words text-[13px] leading-snug text-[var(--ds-ink)]">{c.title || 'Untitled'}</p>
      {c.status === 'stale' && (
        <p className="mt-1 break-words text-[11.5px] text-[var(--ds-ink)]">The title, style or cast changed since this cover was drawn.</p>
      )}
      <p className="mt-0.5 text-[11.5px] text-[var(--ds-muted)]">
        {c.lettering === 'overlay' ? 'Title as editable text — changing it later is free.' : 'Title painted into the art.'}
        {pro && c.model ? ` Drawn with ${c.model}.` : ''}
        {pro && c.spentUsd ? ` ${amountInSentence(cost.exact(c.spentUsd))} spent.` : ''}
      </p>
      {open && (
        <div id={id} className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {!inGate && !busy && (
            <GhostButton size="sm" className="tap-target" busy={pending} disabled={disabled} onClick={() => onDraw(usd)}>
              <Sparkles className="h-3.5 w-3.5" aria-hidden /> {drawn ? 'New cover' : c.status === 'stale' ? 'Redraw the cover' : c.status === 'failed' ? 'Try the cover again' : 'Make the cover'} · {cost.badge(usd)}
            </GhostButton>
          )}
          {!inGate && busy && (
            <GhostButton size="sm" className="tap-target" disabled>
              Drawing…
            </GhostButton>
          )}
          <GhostButton size="sm" className="tap-target" onClick={() => composeInStudio({ text: 'Change the cover: ', focus: true })}>
            Ask AI to change…
          </GhostButton>
        </div>
      )}
      {!pro || !open ? (
        <div className="mt-2">
          <DetailToggle open={open} onToggle={onToggle} controls={id} />
        </div>
      ) : null}
    </section>
  );
};

export default BreakdownCard;
