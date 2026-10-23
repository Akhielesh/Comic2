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

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  Coins,
  Image as ImageIcon,
  LayoutTemplate,
  Lock,
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
import { MAX_SPEND_ENTRIES } from '../../../shared/comic/limits';
import { getImageModel } from '../../../shared/comic/models';
import {
  LOW_QC_SCORE,
  coverNeedsDraw,
  quoteRenderPages,
  summarizeBook,
  unitPrice,
  type BookSummary,
  type PageSummary
} from '../../../shared/comic/plan';
import { aspectMismatch, continuityHint } from '../../../shared/comic/book';
import { effectiveRating, safetyStatusOf, type ContentRating, type SafetyVerdict } from '../../../shared/comic/safety';
import {
  SHOT_LABEL,
  SIZE_LABEL,
  SPEND_KIND_LABEL,
  byokFromDoc,
  cssAspect,
  initials,
  nameHue,
  plural
} from '../board/boardModel';
import { composeInStudio } from '../conversation/composerBus';
import { CardShell, GhostButton, PrimaryButton, Segmented, cx } from '../conversation/ui';
import { useAction } from '../conversation/cards/useAction';
import { useCostFormat, type CostFormat } from '../conversation/cost';
import { amountInSentence, compactUsageShare } from '../../../services/costDisplay';
import type { CardProps } from '../extensions';
import { PageWireframe } from './PageWireframe';

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
  ready: 'bg-emerald-500',
  stale: 'bg-amber-500',
  failed: 'bg-red-500',
  custom: 'bg-emerald-500'
};

const StatusPill: React.FC<{ status: Status; className?: string }> = ({ status, className }) => (
  <span className={cx('inline-flex min-w-0 items-center gap-1 text-[11px] text-[var(--ds-muted)]', className)}>
    <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />
    <span className="truncate">{STATUS_LABEL[status]}</span>
  </span>
);

const isDrawnStatus = (s: Status) => s === 'ready' || s === 'custom';
const isBusyStatus = (s: Status) => s === 'queued' || s === 'rendering';

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
      className="relative w-full overflow-hidden rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-raised)]"
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
      {held && (
        <span className="absolute inset-x-1 bottom-1 inline-flex items-center justify-center gap-1 rounded-md bg-[var(--ds-surface-strong)] px-1 py-0.5 text-[9.5px] text-[var(--ds-ink)]" aria-hidden>
          <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">{safety === 'blocked' ? 'Held for review' : 'Above rating'}</span>
        </span>
      )}
      {tile.flag && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-[var(--ds-surface)]" title={tile.flag} aria-hidden />
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

// ── Cost panel (view === 'cost'): real numbers only ──────────────────────────

/** "3 pages $0.21" / "1 character sheet ≈1% of your usage" from an estimate line. */
const lineText = (l: { label: string; count: number; usd: number }, cost: CostFormat) =>
  `${l.count} ${l.count === 1 ? l.label.replace(/s$/, '') : l.label} ${amountInSentence(cost.exact(l.usd))}`;

const CostRow: React.FC<{ label: React.ReactNode; value: React.ReactNode; note?: React.ReactNode }> = ({ label, value, note }) => (
  <div className="flex min-w-0 items-baseline justify-between gap-3 py-1">
    <span className="min-w-0">
      <span className="block text-[12px] text-[var(--ds-ink)]">{label}</span>
      {note && <span className="block break-words text-[11px] text-[var(--ds-muted)]">{note}</span>}
    </span>
    <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-[var(--ds-ink)]">{value}</span>
  </div>
);

const CostPanel: React.FC<{ doc: ComicDoc; book: BookSummary; quote: ReturnType<typeof quoteRenderPages>; byok: boolean; pro: boolean; cost: CostFormat }> = ({
  doc,
  book,
  quote,
  byok,
  pro,
  cost
}) => {
  /** A narrow cell (bars, per-model rows): "$0.12" or "≈1%"; "—" when a governed share isn't known yet. */
  const cell = (usd: number) => shortCost(cost, usd, 'spent') ?? '—';
  const kinds = Object.entries(doc.spend.byKind || {})
    .filter(([, usd]) => typeof usd === 'number' && usd > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number)) as [keyof typeof SPEND_KIND_LABEL, number][];
  const maxKind = kinds.length ? kinds[0][1] : 0;
  const byModel = useMemo(() => {
    const m = new Map<string, { usd: number; count: number }>();
    for (const e of doc.spend.entries) {
      if (!e.model || !(e.usd > 0)) continue;
      const name = getImageModel(e.model)?.nickname || e.model;
      const cur = m.get(name) ?? { usd: 0, count: 0 };
      cur.usd += e.usd;
      cur.count += 1;
      m.set(name, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 4);
  }, [doc.spend.entries]);
  const capped = doc.spend.entries.length >= MAX_SPEND_ENTRIES;
  const pricing = book.pricing;
  const coverSpent = book.cover.spentUsd;
  const coverLine =
    isDrawnStatus(book.cover.status) ? (coverSpent ? cost.exact(coverSpent) : 'Drawn') : book.cover.quoteUsd ? cost.badge(book.cover.quoteUsd) : STATUS_LABEL[book.cover.status];
  return (
    <section aria-label="Cost breakdown" className="mt-3 min-w-0 rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)] px-3 py-2">
      <div className="divide-y divide-[var(--ds-hairline-soft)]">
        <CostRow
          label="Spent on this comic"
          value={doc.spend.totalUsd > 0 ? amountInSentence(cost.exact(doc.spend.totalUsd), 'Some of your usage') : 'Nothing yet'}
          note={byok ? 'Images on your own key — tracked so you see the real cost.' : cost.governed ? 'Shown as a share of your usage.' : undefined}
        />
        {book.totals.savedUsd > 0 && (
          <CostRow label="Saved by software" value={cost.exact(book.totals.savedUsd)} note="Free — done by the editor, no AI cost." />
        )}
        <CostRow
          label="To draw now"
          value={quote.nothing ? 'Nothing' : cost.badge(quote.usd)}
          note={quote.nothing ? 'Every page here is drawn and up to date.' : quote.lines.map((l) => lineText(l, cost)).join(' · ')}
        />
        <CostRow label="Cover" value={coverLine} />
        {pricing && (
          <CostRow
            label={
              <span className="inline-flex items-center gap-1">
                Next pages draw on {pricing.model}
                {pricing.locked && (
                  <Lock className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" role="img" aria-label="Your chosen model for this comic" />
                )}
              </span>
            }
            value={`${shortCost(cost, pricing.pageUsd, 'quote') ?? 'a little'}/page`}
            note={`${pricing.locked ? 'Your pick for this comic' : `${TIER_LABEL[pricing.tier] ?? pricing.tier} quality`} · a page ${cost.badge(pricing.pageUsd)} · cover ${cost.badge(pricing.coverUsd)} · prices from the model price list${pricing.byok ? ', no markup on your key' : ''}`}
          />
        )}
      </div>
      {kinds.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Where it went{cost.governed ? ' · share of your usage' : ''}</div>
          <ul className="space-y-1">
            {kinds.map(([kind, usd]) => (
              <li key={kind} className="flex min-w-0 items-center gap-2 text-[11.5px]">
                <span className="w-24 shrink-0 truncate text-[var(--ds-muted)]">{SPEND_KIND_LABEL[kind] ?? kind}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--ds-well)]" aria-hidden>
                  <span className="block h-full rounded-full bg-[#D97757]/60" style={{ width: `${Math.max(4, Math.round((usd / (maxKind || 1)) * 100))}%` }} />
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums text-[var(--ds-ink)]">{cell(usd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pro && byModel.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">By model{capped ? ' (recent)' : ''}</div>
          <ul className="space-y-0.5">
            {byModel.map(([name, v]) => (
              <li key={name} className="flex min-w-0 items-baseline justify-between gap-2 text-[11.5px]">
                <span className="min-w-0 truncate text-[var(--ds-ink)]">{name}</span>
                <span className="shrink-0 tabular-nums text-[var(--ds-muted)]">
                  {plural(v.count, 'call')} · {cell(v.usd)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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

  const rating = doc ? effectiveRating(doc).rating : 'PG-13';
  const book = useMemo(() => (doc ? summarizeBook(doc, { pageIds: scope.ids, byok, rating }) : null), [doc, scope.ids, byok, rating]);
  const tier = doc?.settings.quality ?? 'standard';
  const override = doc?.settings.imageModelOverride;
  const quote = useMemo(
    () => (doc ? quoteRenderPages(doc, { pageIds: scope.ids, byok, tier, modelOverride: override }) : null),
    [doc, scope.ids, byok, tier, override]
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
      const tc = tileCost(s, cost);
      const flags: string[] = [];
      if (s.aspectOk === false) flags.push(`Not ${doc.format.pageAspect}`);
      if (typeof s.qcScore === 'number' && s.qcScore < LOW_QC_SCORE) flags.push('Quality check flagged it');
      const held = s.safety === 'blocked' ? 'held for review' : s.safety === 'over_rating' ? 'above rating' : '';
      out.push({
        key: s.id,
        kind: 'page',
        label: `Page ${s.n}`,
        status: s.status,
        page,
        summary: s,
        cost: tc,
        flag: flags.length ? flags.join(' · ') : undefined,
        extra: [held, ...flags].filter(Boolean)
      });
    }
    return out;
  }, [doc, book, showCover, cost]);

  const firstPageKey = tiles.find((t) => t.kind === 'page')?.key ?? tiles[0]?.key ?? '';
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

  // ── Header meta (wraps; never widens the chat) ──
  const meta = (
    <div className="-mt-1 mb-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] tabular-nums text-[var(--ds-muted)]">
      <span>
        {plural(book.pages.length, 'page')}
        {subset ? ` of ${doc.pages.length}` : ''} · {plural(panelTotal, 'panel')}
      </span>
      <span aria-hidden>·</span>
      {quote.nothing ? (
        <span>{allDrawn ? 'all drawn' : drawing ? `${drawing} drawing` : 'nothing to draw'}</span>
      ) : pro || view === 'cost' ? (
        <span>{amountInSentence(cost.badge(quote.usd))} to draw</span>
      ) : (
        // A real 44 px target on touch (not a 16 px inline link whose ::after hit area overlapped the
        // rows around it — P1-QA breakdown-inline-links). Its name is its visible words, then the hint.
        <button
          type="button"
          onClick={() => setView('cost')}
          title="Show the cost breakdown"
          className="inline-flex items-center rounded underline decoration-dotted underline-offset-2 hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-11 coarse:px-1"
        >
          {amountInSentence(cost.badge(quote.usd))} to draw
          <span className="sr-only">. Show the cost breakdown</span>
        </button>
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
          className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 text-[11.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11 coarse:px-3.5"
        >
          {showArt ? <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden /> : <ImageIcon className="h-3.5 w-3.5" aria-hidden />}
          {showArt ? 'Show layouts' : 'Show art'}
        </button>
      )}
      {view === 'cost' && (
        <button
          type="button"
          onClick={() => setView(anyDrawn ? 'status' : 'plan')}
          className="inline-flex h-7 items-center rounded-full px-2 text-[11.5px] text-[var(--ds-muted)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11 coarse:px-3"
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
            <li key={t.key} className="shrink-0 snap-start" style={{ width: tileW }}>
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
                  'block w-full rounded-xl p-1 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50',
                  on ? 'bg-[#D97757]/10 ring-1 ring-[#D97757]/40' : 'hover:bg-[var(--ds-hover)]'
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
                  <StatusPill status={t.status} />
                  {t.summary && !compact && <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">· {plural(t.summary.panels.length, 'panel')}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

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
            onClick={() => void run('approve', { type: 'approve_plan' }, { type: 'render_pages', quotedUsd: quote.usd })}
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
            onClick={() => void run('draw', { type: 'render_pages', ...(subset ? { pageIds: quote.pageIds } : {}), quotedUsd: quote.usd })}
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
  const note = inGate
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

  return (
    <CardShell title={title} icon={icon} aria-label="Page breakdown" className="min-w-0 max-w-full">
      {meta}
      {controls}
      {scope.gone && (
        <p className="mb-2 text-[12px] text-[var(--ds-muted)]">The pages this card showed are no longer in the book — here is the whole book.</p>
      )}
      {strip}
      {view === 'cost' && <CostPanel doc={doc} book={book} quote={quote} byok={byok} pro={pro} cost={cost} />}
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
      {note && <p className={cx('mt-2 break-words text-[11.5px] text-[var(--ds-muted)]', drawing > 0 && 'text-[var(--ds-ink)]')}>{note}</p>}
      {scope.ids && !inGate && (
        <button
          type="button"
          onClick={() => setWholeBook(true)}
          className="mt-1.5 inline-flex items-center rounded text-[12px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-11 coarse:px-1"
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
  <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-[#D97757]/10 px-2 py-1 text-[11.5px] leading-snug text-[var(--ds-ink)]">
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
    className="inline-flex items-center gap-1 rounded text-[12px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-11 coarse:px-1"
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
  onToggle(): void;
  pending: boolean;
  disabled: boolean;
  onDraw(force: boolean, usd: number): void;
  onEdit(): void;
  onBoard(): void;
}> = ({ doc, page, s, byok, inGate, open, pro, rating, urlFor, cost, onToggle, pending, disabled, onDraw, onEdit, onBoard }) => {
  const id = `bd-${useId().replace(/:/g, '')}`;
  const tier = doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const busy = isBusyStatus(s.status);
  // The gate's own quotes (shared/comic/plan.ts): "draw" only when the server would draw it, and a
  // forced new take only for a drawn, current page. Both include any missing lead/support sheet.
  const drawQ = quoteRenderPages(doc, { pageIds: [page.id], byok, tier, modelOverride: override });
  const q = drawQ.nothing ? null : drawQ;
  const redo = !q && !busy && page.render.status === 'ready' && page.panels.length > 0
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
        <StatusPill status={s.status} className="shrink-0" />
      </div>
      <p className="mt-1 line-clamp-2 break-words text-[13px] leading-snug text-[var(--ds-ink)]">{s.summary || 'No summary yet.'}</p>
      {pro && s.turnHook && <p className="mt-1 break-words text-[11.5px] text-[var(--ds-muted)]">Page turn: {s.turnHook}</p>}

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
                className="inline-flex items-center rounded-lg px-1.5 py-1 text-[11.5px] font-medium text-[var(--ds-accent)] underline decoration-dotted underline-offset-2 hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-11 coarse:px-2.5"
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
            {s.panels.map((p) => {
              const cast = p.castIds.map((cid) => findCharacter(doc, cid)).filter((c): c is Character => !!c);
              return (
                <li key={p.n} className="flex min-w-0 items-center gap-2 py-1.5 text-[12px]">
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
                    {pro && p.words > 0 && <span title={plural(p.words, 'word')}>{p.words}w</span>}
                  </span>
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
