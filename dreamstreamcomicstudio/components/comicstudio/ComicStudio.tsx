// Comic Studio shell: header + conversation | board, on every form factor (mobile.md §3; contract §13.4).
//
// `ComicStudioShell({ studio, onBack })` renders a loaded (or loading) controller — the QA harness
// mounts it with a fixture controller — and `ComicStudio` wires it to `useStudio(projectId)`.
// One form factor (useFormFactor) decides the layout (mobile/shell/StudioLayout.tsx):
//   single       phones portrait (< 720 wide): one pane at a time + a bottom tab bar (Chat · Board · Read)
//   single-rail  phones landscape (< 480 tall): the same with a left navigation rail
//   split        tablets ≥ 720 and desktop: resizable conversation | board (+ Chat | Both | Board switcher)
//   dual-screen  foldables spanning two segments: chat and board each in their own segment
// Both panes stay mounted (the hidden one is `inert`), so scroll, drafts and tab scroll survive.
//
// The header carries back, the editable title, quality, the truthful spend chip (with a by-kind
// breakdown and BYOK note), Read and the ⋯ menu (settings, resync, install). On phones it keeps only
// Back · Title · Share · $ · ⋯ — everything else moves into ⋯, a thumb-reachable bottom sheet.
// Feature controls (Share, Easy/Pro, savings, a model-status pill) join through the header slot
// registry (features.ts, contract §13.2) interleaved by `order`; slots ordered ≥ 1000 render as a
// full-width calm banner strip under the header (mobile/headerSlots.ts).
// Keyboard-safe: the root follows the visible height (--app-h from useKeyboardInset), safe areas are
// tokens (--sa-*), and the back gesture closes the top layer (reader, sheets) before the studio.

import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Download,
  LayoutGrid,
  Lock,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  Sparkles,
  Wallet
} from 'lucide-react';
import type { ComicDoc, ConfirmPolicy, SpendKind } from '../../shared/comic/doc';
import type { DocOp } from '../../shared/comic/ops';
import { PLATFORM_MARKUP, TIER_PRESETS, getImageModel, resolveImageJob } from '../../shared/comic/models';
import { deriveLock } from '../../shared/comic/modelLock';
import type { StudioCaps } from '../../shared/comic/capabilities';
import { CountUp } from '../studio/kit/streamMotion';
import { Skeleton } from '../studio/kit/Shimmer';
import { CANVAS_BG, HAIRLINE, OVERLINE, RADIUS_CONTROL, TONE_CHIP, TRANSITION } from '../chat/studioDesign';
import { initTheme } from '../../services/theme';
import { COMIC_STUDIO_SKIN } from '../../services/productHost';
import { BoardPane } from './board/BoardPane';
import { registerStudioRefresh } from './board/ui';
import { SPEND_KIND_LABEL, pageProgress } from './board/boardModel';
import { ConversationPane } from './conversation/ConversationPane';
import { StudioComposer, type StudioComposerHandle } from './conversation/StudioComposer';
import { COMPOSE_EVENT } from './conversation/composerBus';
import { QualityPanel } from './conversation/panels/QualityPanel';
import { costFormat, useCostContext, useCostFormat, type CostDisplayContext, type CostFormat } from './conversation/cost';
import { amountInSentence, compactUsageShare } from '../../services/costDisplay';
import { LETTERING_OPTIONS } from './conversation/panels/FormatPanel';
import { GhostButton, PrimaryButton, Segmented, SectionLabel, cx, plural } from './conversation/ui';
import { renderingPageCount } from './studioReducer';
import { useStudio, type ComicStudioController } from './useStudio';
import type { BoardTab } from './types';
import { BUILTIN_HEADER_ORDER, registeredHeaderSlots, type HeaderSlotRegistration } from './features';
import { headerVariantFor, isPhoneLayout, showsPaneSwitcher, type FormFactor, type HeaderVariant } from './mobile/formFactor';
import { useFormFactor } from './mobile/useFormFactor';
import { useKeyboardInset } from './mobile/useKeyboardInset';
import { useThemeColor } from './mobile/useThemeColor';
import { useBackLayer } from './mobile/backStack';
import { HEADER_BANNER_MIN_ORDER } from './mobile/headerSlots';
import { ModeToggle } from './mobile/ModeToggle';
import { SavingsBreakdown, savedTotal } from './mobile/SavingsChip';
import { AdaptiveSheet } from './mobile/sheets/AdaptiveSheet';
import { StudioLayout, SPLIT_STORAGE_KEY } from './mobile/shell/StudioLayout';
import { phoneChromeVars } from './mobile/shell/phoneChrome';
import type { StudioNavItem } from './mobile/shell/MobileTabBar';
import { PaneSwitcher, readPaneMode, writePaneMode, type PaneMode } from './mobile/shell/PaneSwitcher';
import { CompactHeaderMenu, useInstallPrompt, type MenuRow } from './mobile/shell/CompactHeaderMenu';
import { useOpenSettingsRequests } from './openSettings';
import { INSIGHTS_KIND_ORDER } from '../../shared/comic/modelInsights';
import { recentLabel } from './insights/copy';
import { spendSummary } from './insights/insightsModel';
import { SpendByKindList } from './insights/OverviewTab';

export { SPLIT_STORAGE_KEY };

// The full-screen reader is a heavy engine (page flip, guided view): loaded the first time it opens.
const ImmersiveReader = React.lazy(() => import('./immersive/ImmersiveReader').then((m) => ({ default: m.ImmersiveReader })));

/** Below this width the phone header moves the spend chip into the ⋯ menu (the title keeps ≥ 100 px). */
export const SPEND_CHIP_MIN_WIDTH = 360;
/** The full-screen reader re-signs image URLs after an image error at most this often. */
export const READER_REFRESH_MS = 30_000;

// ── Header pieces ────────────────────────────────────────────────────────────

const TitleField: React.FC<{ title: string; onCommit: (title: string) => void }> = ({ title, onCommit }) => {
  const [draft, setDraft] = useState(title);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(title);
  }, [title]);
  const commit = () => {
    editing.current = false;
    const next = draft.trim().slice(0, 200);
    if (!next) {
      setDraft(title);
      return;
    }
    if (next !== title) onCommit(next);
  };
  return (
    <input
      value={draft}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          editing.current = false;
          setDraft(title);
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label="Comic title"
      title={draft}
      maxLength={200}
      spellCheck={false}
      enterKeyHint="done"
      // 16 px on touch so focusing the title never zooms the page (iOS); ellipsis when it doesn't fit.
      className={`min-w-0 max-w-[28rem] flex-1 truncate rounded-lg border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold tracking-tight text-[var(--ds-ink)] outline-none ${TRANSITION} hover:border-[var(--ds-hairline)] focus:border-[#D97757]/45 focus:bg-[var(--ds-surface-soft)] coarse:min-h-[44px] coarse:text-base`}
    />
  );
};

/** Spend kind names — one vocabulary for every Spending view (the board's, the breakdown card's, this sheet's). */
export const SPEND_KIND_LABELS: Record<SpendKind, string> = SPEND_KIND_LABEL;

/**
 * Every kind with spend, in display order (the shared insights order — Translate included) — a kind this build
 * doesn't know yet still shows (never a silent gap).
 */
export const spendKindsShown = (byKind: Partial<Record<string, number>>): string[] => {
  const positive = (k: string) => {
    const v = byKind[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  };
  const known = INSIGHTS_KIND_ORDER.filter(positive);
  const other = Object.keys(byKind).filter((k) => !(INSIGHTS_KIND_ORDER as readonly string[]).includes(k) && positive(k));
  return [...known, ...other];
};

/**
 * A share for a narrow spot (the header pill, a breakdown row): "≈4%" / "<0.1%" for governed users,
 * dollars for admins and own keys. Undefined when a governed user's share isn't known yet — the
 * spot shows no figure then, never dollars.
 */
export const shortSpend = (cost: CostFormat, usd: number): string | undefined => {
  const s = cost.exact(usd);
  if (!cost.governed) return s;
  return s === 'Free' ? '0%' : compactUsageShare(s);
};

/**
 * "Spent $0.42 on this comic" / "Spent ≈4% of your usage on this comic" / "Spent some of your usage on
 * this comic" while a governed user's share isn't known yet (governed users never read dollars).
 */
export const spentLabel = (cost: CostFormat, usd: number): string =>
  usd > 0 || !cost.governed ? `Spent ${spentAmount(cost, usd)} on this comic` : 'Spent none of your usage on this comic yet';

/** A spent total that reads inside a sentence: "$0.42", "≈4% of your usage", or "some of your usage". */
const spentAmount = (cost: CostFormat, usd: number): string => amountInSentence(cost.exact(usd), 'some of your usage');

export const SpendBreakdown: React.FC<{ doc: ComicDoc; cost?: CostFormat }> = ({ doc, cost: costProp }) => {
  // Hosts pass the studio's formatter; standalone (tests, galleries) it falls back to the shared
  // usage status — and, until that loads, usage terms (fail closed: never a dollar figure by default).
  const fallback = useCostFormat({ caps: null });
  const cost = costProp ?? fallback;
  // The shared spend summary (insights/insightsModel.ts over shared/comic/modelInsights.ts): the same kinds,
  // own-key split, estimates and failed attempts the cost card and the board's Story tab show.
  const summary = useMemo(() => spendSummary(doc), [doc]);
  const spend = doc.spend;
  const byokUsd = summary.byok.usd;
  const recent = summary.exact ? '' : ` ${recentLabel(summary.recentN ?? spend.entries.length)}`;
  const budget = typeof doc.settings.budgetUsd === 'number' && doc.settings.budgetUsd > 0 ? doc.settings.budgetUsd : null;
  const pct = budget ? Math.min(100, (spend.totalUsd / budget) * 100) : 0;
  const row = (usd: number) => shortSpend(cost, usd) ?? '—';
  return (
    <div className="w-[min(20rem,calc(100vw-2rem))] p-4">
      <div className={OVERLINE}>Spent on this comic</div>
      <div className={cx('mt-1 font-semibold tracking-tight tabular-nums text-[var(--ds-ink)]', cost.governed ? 'text-[20px]' : 'text-[24px]')}>
        {spend.totalUsd > 0 || !cost.governed ? amountInSentence(cost.exact(spend.totalUsd), 'Some of your usage') : 'Nothing yet'}
      </div>
      {cost.governed && <div className="mt-0.5 text-[11.5px] text-[var(--ds-muted)]">Shown as a share of your usage.</div>}
      {budget && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ds-well-strong)]">
            <div className={cx('h-full rounded-full', pct >= 90 ? 'bg-[var(--ds-warning)]' : 'bg-[var(--ds-accent)]')} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11.5px] text-[var(--ds-muted)]">
            {cost.governed ? `${Math.round(pct)}% of this comic's spending cap` : `${cost.exact(spend.totalUsd)} of your ${cost.exact(budget)} budget`}
          </div>
        </div>
      )}
      {summary.kinds.length ? (
        <SpendByKindList rows={summary.kinds} format={row} className="mt-3 space-y-1.5 border-t border-[var(--ds-hairline-soft)] pt-3" />
      ) : (
        <p className="mt-3 text-[12.5px] text-[var(--ds-muted)]">
          {cost.governed ? 'Nothing spent yet. Planning and chatting use very little; you approve every image spend.' : 'Nothing spent yet. Planning and chatting cost cents; you approve every image spend.'}
        </p>
      )}
      {summary.failed.count > 0 && (
        <p className="mt-2 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          Failed attempts: {summary.failed.count} · {summary.failed.usd > 0 ? amountInSentence(cost.exact(summary.failed.usd)) : 'nothing charged'}
        </p>
      )}
      {byokUsd > 0 && (
        <p className="mt-3 rounded-lg bg-[var(--ds-well)] px-2.5 py-2 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          {cost.governed
            ? `Some of this ran on your own API key — tracked here so you see it, but not taken from your usage.${recent}`
            : `${cost.exact(byokUsd)} of this was paid with your own API key — tracked here so you see the real cost, but not billed by DreamStream.${recent}`}
        </p>
      )}
      {summary.estimated > 0 && (
        <p className="mt-2 text-[11px] leading-snug text-[var(--ds-muted)]">Some amounts are list-price estimates where the provider didn’t report a cost.</p>
      )}
    </div>
  );
};

/** A feature surface (header slot, the reader layer); a crash inside it hides it, never the studio. */
class SlotBoundary extends React.Component<{ id: string; kind?: string; children: React.ReactNode; onError?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[comicstudio] ${this.props.kind || 'header slot'} "${this.props.id}" failed to render`, error);
    this.props.onError?.();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const HeaderSlots: React.FC<{ slots: readonly HeaderSlotRegistration[]; from: number; to: number; studio: ComicStudioController; compact: boolean }> = ({
  slots,
  from,
  to,
  studio,
  compact
}) => (
  <>
    {slots
      .filter((slot) => slot.order >= from && slot.order < to)
      .map((slot) => (
        <SlotBoundary key={slot.id} id={slot.id}>
          <slot.Component studio={studio} compact={compact} />
        </SlotBoundary>
      ))}
  </>
);

const QUALITY_DOT: Record<string, string> = { draft: 'bg-sky-500', standard: 'bg-emerald-500', pro: 'bg-[var(--ds-accent)]' };

// Fine pointers keep the calm 32 px pill; touch gets a real 44 px target (mobile.md §2.4).
const headerBtn = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[12.5px] font-medium text-[var(--ds-ink)] ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11 coarse:px-3.5 press`;
const headerIconBtn = `grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] ${TRANSITION} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11 coarse:w-11 press`;

type HeaderSheet = 'quality' | 'spend' | 'menu' | null;

export interface StudioHeaderProps {
  studio: ComicStudioController;
  doc: ComicDoc;
  ff: FormFactor;
  onBack: () => void;
  onRead: () => void;
  /** The Read entry is unavailable (nothing drawn yet) — say why instead of opening an empty reader. */
  readHint?: string;
  onOpenSettings: () => void;
  paneMode: PaneMode;
  onPaneMode: (mode: PaneMode) => void;
  /**
   * Phones on the Board: "Ask" in the header opens the Ask-the-Director sheet (while the director
   * replies it says so and opens the chat). It used to be a full-width pill pinned above the tab bar —
   * a third bottom bar that left the board under 45 % of an iPhone's height (P1-QA phone-content).
   */
  ask?: { busy: boolean; onAsk: () => void; onViewChat: () => void };
}

/**
 * The studio header. `variant` (from the form factor):
 *  - compact  phones: Back · Title · slots · $ · ⋯ (quality, spending, Read, Easy/Pro, settings in ⋯)
 *  - medium   split below 1024: icon-only quality/Read, Easy/Pro in ⋯, pane switcher
 *  - regular  1024+: today's desktop header (pane switcher on touch tablets)
 */
export const StudioHeader: React.FC<StudioHeaderProps> = ({ studio, doc, ff, onBack, onRead, readHint, onOpenSettings, paneMode, onPaneMode, ask }) => {
  const [open, setOpen] = useState<HeaderSheet>(null);
  const variant: HeaderVariant = headerVariantFor(ff);
  const compact = variant !== 'regular';
  const phone = variant === 'compact';
  const slots = registeredHeaderSlots();
  const rowSlots = slots.filter((s) => s.order < HEADER_BANNER_MIN_ORDER);
  const H = BUILTIN_HEADER_ORDER;
  const slotRange = (from: number, to: number) =>
    rowSlots.length ? <HeaderSlots slots={rowSlots} from={from} to={Math.min(to, HEADER_BANNER_MIN_ORDER)} studio={studio} compact={compact} /> : null;
  const qualityRef = useRef<HTMLDivElement>(null);
  const spendRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggle = (which: Exclude<HeaderSheet, null>) => setOpen((cur) => (cur === which ? null : which));
  const close = () => setOpen(null);
  const tier = doc.settings.quality;
  const tierLabel = TIER_PRESETS[tier]?.label || 'Standard';
  // models.md §4.1 L0: the quality chip reads "{Tier} · {Model}", with a lock glyph once the comic is locked.
  const lock = deriveLock(doc);
  const chipModel = lock ? (getImageModel(lock.modelId)?.nickname ?? lock.modelId) : resolveImageJob('page', tier, doc.settings.imageModelOverride).spec.nickname;
  const qualityText = `${tierLabel} · ${chipModel}`;
  const install = useInstallPrompt();
  const saved = savedTotal(doc);
  // Governed users never see dollars (P1-LIMITS): the pill, the menu row and the sheet speak in usage.
  const cost = useCostFormat(studio);
  const pillShare = shortSpend(cost, doc.spend.totalUsd);
  const showSpendChip = !phone || ff.width >= SPEND_CHIP_MIN_WIDTH;
  const showBack = ff.layout !== 'single-rail'; // the rail carries Back in phone landscape

  // Book-posture foldables: no control may straddle the hinge (mobile.md §3.6). Back + title end just
  // before it, a spacer covers it, and the rest of the header lives on the second screen.
  const headerRef = useRef<HTMLElement>(null);
  const hinge = ff.layout === 'dual-screen' && ff.segments.axis === 'horizontal' ? ff.segments.hinge : undefined;
  const [firstSegmentW, setFirstSegmentW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!hinge || !el) {
      setFirstSegmentW(null);
      return;
    }
    const r = el.getBoundingClientRect();
    let pad = 0;
    try {
      pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    } catch {
      /* no layout (tests) */
    }
    // −6: the header's flex gap sits between this group and the hinge spacer.
    setFirstSegmentW(Math.max(0, Math.round(hinge.start - (r.left + pad) - 6)));
  }, [hinge, ff.width]);
  const hingeW = hinge ? Math.max(0, hinge.end - hinge.start) : 0;

  const rows: MenuRow[] = [];
  if (phone) {
    rows.push({
      id: 'quality',
      label: 'Quality',
      icon: <Sparkles className="h-4 w-4" />,
      detail: qualityText,
      opensSheet: true,
      onSelect: () => setOpen('quality')
    });
    rows.push({
      id: 'spend',
      label: 'Spending',
      icon: <Wallet className="h-4 w-4" />,
      detail: cost.governed
        ? [pillShare ? `${pillShare} of your usage` : 'Your usage', saved > 0 ? 'some saved by software' : ''].filter(Boolean).join(' · ')
        : saved > 0
          ? `${cost.exact(doc.spend.totalUsd)} · saved ${cost.exact(saved)}`
          : cost.exact(doc.spend.totalUsd),
      opensSheet: true,
      onSelect: () => setOpen('spend')
    });
    rows.push({
      id: 'read',
      label: 'Read the comic',
      icon: <BookOpen className="h-4 w-4" />,
      hint: readHint,
      disabled: !!readHint,
      onSelect: onRead
    });
  }
  rows.push({ id: 'settings', label: 'Settings', icon: <Settings2 className="h-4 w-4" />, opensSheet: true, onSelect: onOpenSettings });
  rows.push({ id: 'resync', label: 'Resync', icon: <RefreshCw className="h-4 w-4" />, hint: 'Reload the latest saved state', onSelect: () => void studio.refresh() });
  if (install.canInstall) rows.push({ id: 'install', label: 'Install the app', icon: <Download className="h-4 w-4" />, hint: 'Open the studio from your home screen', onSelect: install.install });

  const spendSheet = (
    <div className="mx-auto w-fit max-w-full">
      <SpendBreakdown doc={doc} cost={cost} />
      {phone && saved > 0 && (
        <div className="border-t border-[var(--ds-hairline-soft)]">
          <SavingsBreakdown doc={doc} cost={cost} />
        </div>
      )}
    </div>
  );

  const lead = (
    <>
      {showBack && (
        <button type="button" onClick={onBack} aria-label="Back to your projects" title="Back" className={headerIconBtn}>
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <TitleField title={doc.brief.title || 'Untitled comic'} onCommit={(title) => void studio.patch([{ op: 'brief', patch: { title } }])} />
    </>
  );
  const switcher = showsPaneSwitcher(ff) ? <PaneSwitcher value={paneMode} onChange={onPaneMode} className="shrink-0" /> : null;
  const splitAtHinge = !!hinge && firstSegmentW !== null;

  return (
    <header
      ref={headerRef}
      className="flex shrink-0 items-center gap-1.5 border-b border-[var(--ds-hairline-soft)] px-2 sm:px-3"
      style={{ height: 'var(--header-h, 56px)', paddingTop: 'var(--sa-top, 0px)', boxSizing: 'content-box' }}
      data-header={variant}
    >
      {splitAtHinge ? (
        <>
          {/* First screen: Back · title · pane switcher. It may still shrink (never overflow the header)
              if the second screen's controls ever need more than their half. */}
          <div className="flex min-w-0 items-center gap-1.5" style={{ width: firstSegmentW ?? undefined, flexShrink: 1 }} data-header-segment="0">
            {lead}
            {switcher}
          </div>
          <div aria-hidden className="shrink-0" style={{ width: hingeW }} data-header-hinge />
        </>
      ) : (
        <>
          {lead}
          {switcher}
        </>
      )}

      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
        {slotRange(-Infinity, H.quality)}
        {!phone && (
          <div ref={qualityRef} className="relative">
            <button
              type="button"
              onClick={() => toggle('quality')}
              aria-haspopup="dialog"
              aria-expanded={open === 'quality'}
              aria-label={`Quality: ${qualityText}${lock ? ', locked for this comic' : ''}`}
              className={headerBtn}
              title="Quality"
            >
              <span className={cx('h-2 w-2 rounded-full', QUALITY_DOT[tier] || QUALITY_DOT.standard)} aria-hidden />
              {variant === 'regular' && <span className="min-w-0 max-w-[13rem] truncate">{qualityText}</span>}
              {variant === 'regular' && lock && <Lock className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" aria-hidden />}
              <ChevronDown className="h-3 w-3 text-[var(--ds-muted)]" aria-hidden />
            </button>
          </div>
        )}
        {slotRange(H.quality, H.spend)}

        {showSpendChip && (
          <div ref={spendRef} className="relative">
            <button
              type="button"
              onClick={() => toggle('spend')}
              aria-haspopup="dialog"
              aria-expanded={open === 'spend'}
              aria-label={spentLabel(cost, doc.spend.totalUsd)}
              title={cost.governed ? 'What this comic has used of your usage' : undefined}
              className={cx(headerBtn, 'tabular-nums', phone && 'px-2.5')}
            >
              {cost.governed ? (
                <>
                  <Wallet className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {pillShare && doc.spend.totalUsd > 0 && <span>{pillShare}</span>}
                </>
              ) : (
                <CountUp value={doc.spend.totalUsd} prefix="$" decimals={2} />
              )}
            </button>
          </div>
        )}
        {slotRange(H.spend, H.read)}

        {!phone && (
          <button type="button" onClick={onRead} className={headerBtn} aria-label="Read the comic" title={readHint || 'Read the comic'}>
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            {variant === 'regular' && <span>Read</span>}
          </button>
        )}
        {slotRange(H.read, H.more)}

        {ask && (
          <button
            type="button"
            onClick={ask.busy ? ask.onViewChat : ask.onAsk}
            aria-haspopup={ask.busy ? undefined : 'dialog'}
            title={ask.busy ? 'The director is replying — view the chat' : 'Ask the Director about this board'}
            className={cx(headerBtn, 'px-3')}
            data-ask
          >
            {ask.busy ? (
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--ds-accent)] motion-reduce:animate-none" aria-hidden />
            ) : (
              <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <span>{ask.busy ? 'Replying' : 'Ask'}</span>{' '}
            <span className="sr-only">{ask.busy ? '— view the chat' : 'the Director'}</span>
          </button>
        )}

        <div ref={menuRef} className="relative">
          <button type="button" onClick={() => toggle('menu')} aria-haspopup="menu" aria-expanded={open === 'menu'} aria-label="More" className={headerIconBtn}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
        {slotRange(H.more, HEADER_BANNER_MIN_ORDER)}
      </div>

      <AdaptiveSheet
        open={open === 'quality'}
        onClose={close}
        label="Quality"
        title="Quality"
        anchorRef={phone ? menuRef : qualityRef}
        placement="below"
        align="end"
        className="w-[min(25rem,calc(100vw-1.5rem))]"
      >
        <QualityPanel doc={doc} patch={studio.patch} byok={studio.byok} caps={studio.caps} onDone={close} />
      </AdaptiveSheet>
      <AdaptiveSheet open={open === 'spend'} onClose={close} label="Spending" title="Spending" anchorRef={showSpendChip ? spendRef : menuRef} placement="below" align="end">
        {spendSheet}
      </AdaptiveSheet>
      <CompactHeaderMenu
        open={open === 'menu'}
        onClose={close}
        anchorRef={menuRef}
        title={doc.brief.title || 'This comic'}
        rows={rows}
        top={compact ? <ModeToggle studio={studio} variant="menu" /> : undefined}
      />
    </header>
  );
};

/** Feature banners (slots ordered ≥ 1000, e.g. a model-status line) in one calm strip under the header. */
const HeaderBanners: React.FC<{ studio: ComicStudioController; compact: boolean }> = ({ studio, compact }) => {
  const banners = registeredHeaderSlots().filter((s) => s.order >= HEADER_BANNER_MIN_ORDER);
  if (!banners.length) return null;
  return (
    <div data-header-banners className="min-w-0 shrink-0 empty:hidden">
      <HeaderSlots slots={banners} from={HEADER_BANNER_MIN_ORDER} to={Infinity} studio={studio} compact={compact} />
    </div>
  );
};

// ── Settings ─────────────────────────────────────────────────────────────────

const CONFIRM_OPTIONS: { value: ConfirmPolicy; title: string; blurb: string }[] = [
  { value: 'always', title: 'Always ask', blurb: 'Confirm every image spend, however small.' },
  { value: 'big', title: 'Ask for big spends only', blurb: 'Small jobs run right away; bigger ones wait for you.' },
  { value: 'never', title: 'Never ask', blurb: 'Only your budget cap stops spending.' }
];

/** Money field with a local draft; commits a number (or null to clear) on blur/Enter. */
const UsdField: React.FC<{
  id: string;
  value: number | undefined | null;
  placeholder: string;
  onCommit: (value: number | null) => void;
  disabled?: boolean;
  allowEmpty?: boolean;
  label: string;
}> = ({ id, value, placeholder, onCommit, disabled, allowEmpty, label }) => {
  const shown = typeof value === 'number' && value > 0 ? String(value) : '';
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const raw = draft.trim().replace(/^\$/, '');
    if (!raw) {
      if (allowEmpty) {
        if (shown) onCommit(null);
      } else setDraft(shown);
      return;
    }
    const n = Math.round(Number(raw) * 100) / 100;
    if (!Number.isFinite(n) || n < 0) {
      setDraft(shown);
      return;
    }
    if (String(n) !== shown) onCommit(n);
    setDraft(n > 0 ? String(n) : '');
  };
  return (
    <span className="inline-flex items-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] pl-2 focus-within:border-[#D97757]/45">
      <span className="text-[13px] text-[var(--ds-muted)]">$</span>
      <input
        id={id}
        aria-label={label}
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 w-20 bg-transparent px-1.5 text-[13px] tabular-nums coarse:h-11 coarse:text-base text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] disabled:opacity-50"
      />
    </span>
  );
};

/**
 * A money setting in the viewer's terms. Admins / own key: the dollar field. Governed users: the same
 * amount as a share of their usage ("5 % of your usage"), converted with the known rate — or, while the
 * rate is unknown, a calm note instead of a dollar field (fail closed).
 */
const MoneySetting: React.FC<{
  id: string;
  label: string;
  value: number | undefined | null;
  usdPlaceholder: string;
  ctx: CostDisplayContext;
  allowEmpty?: boolean;
  onCommit: (usd: number | null) => void;
}> = ({ id, label, value, usdPlaceholder, ctx, allowEmpty, onCommit }) => {
  if (!ctx.governed) return <UsdField id={id} label={label} value={value} placeholder={usdPlaceholder} allowEmpty={allowEmpty} onCommit={onCommit} />;
  const per = ctx.pctPerUsd;
  if (!(typeof per === 'number' && per > 0)) {
    return <span className="text-[12px] text-[var(--ds-muted)]">Available once your usage has loaded.</span>;
  }
  // Settings hold charged amounts (markup included); usage counts provider cost.
  const toPct = (usd: number) => Math.round(((usd / PLATFORM_MARKUP) * per) * 10) / 10;
  const toUsd = (pctValue: number) => Math.round(((pctValue / per) * PLATFORM_MARKUP) * 10000) / 10000;
  return (
    <PctField
      id={id}
      label={label}
      value={typeof value === 'number' && value > 0 ? toPct(value) : null}
      placeholder={allowEmpty ? 'No cap' : '5'}
      allowEmpty={allowEmpty}
      onCommit={(v) => onCommit(v === null ? null : toUsd(v))}
    />
  );
};

/** Percent-of-usage field with a local draft; commits a number (or null to clear) on blur/Enter. */
const PctField: React.FC<{
  id: string;
  value: number | null;
  placeholder: string;
  onCommit: (value: number | null) => void;
  allowEmpty?: boolean;
  label: string;
}> = ({ id, value, placeholder, onCommit, allowEmpty, label }) => {
  const shown = typeof value === 'number' && value > 0 ? String(value) : '';
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const raw = draft.trim().replace(/%$/, '').trim();
    if (!raw) {
      if (allowEmpty) {
        if (shown) onCommit(null);
      } else setDraft(shown);
      return;
    }
    const n = Math.round(Number(raw) * 10) / 10;
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setDraft(shown);
      return;
    }
    if (String(n) !== shown) onCommit(n > 0 ? n : allowEmpty ? null : n);
    setDraft(n > 0 ? String(n) : '');
  };
  return (
    <span className="inline-flex items-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] pr-2 focus-within:border-[#D97757]/45">
      <input
        id={id}
        aria-label={`${label} (% of your usage)`}
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 w-16 bg-transparent px-2 text-right text-[13px] tabular-nums coarse:h-11 coarse:text-base text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)]"
      />
      <span className="text-[12px] text-[var(--ds-muted)]">% of your usage</span>
    </span>
  );
};

/** The Atlas small radius (4 px) — the radio's focus ring inside its bordered row. */
const RADIUS_SM = 'rounded-[var(--ds-radius-sm)]';

export const SettingsPanel: React.FC<{
  doc: ComicDoc;
  patch: (ops: DocOp[]) => Promise<void> | void;
  /** The viewer (caps.admin / caps.byok / caps.usage) — money settings follow their terms. */
  caps?: Pick<StudioCaps, 'byok' | 'admin' | 'usage'> | null;
  byok?: boolean;
}> = ({ doc, patch, caps, byok }) => {
  const settings = doc.settings;
  const ctx = useCostContext({ byok, caps });
  const cost = useMemo(() => costFormat(ctx), [ctx]);
  const setSettings = (p: Record<string, unknown>) => void patch([{ op: 'settings', patch: p as unknown as ComicDoc['settings'] }]);
  return (
    <div className="space-y-7">
      <section>
        <SectionLabel>Before spending</SectionLabel>
        <div role="radiogroup" aria-label="Confirm spending" className="space-y-1.5">
          {CONFIRM_OPTIONS.map((o) => {
            const on = settings.confirm === o.value;
            return (
              <div
                key={o.value}
                className={cx(
                  `${RADIUS_CONTROL} border px-3 py-1 ${TRANSITION}`,
                  on ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]'
                )}
              >
                {/* The whole row height is the radio (44 px on touch, the row's padding inside the target
                    instead of around it), with a visible keyboard focus ring. */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => !on && setSettings({ confirm: o.value })}
                  className={`flex min-h-10 w-full items-start gap-2.5 ${RADIUS_SM} py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11`}
                  data-confirm-option={o.value}
                >
                  <span
                    aria-hidden
                    className={cx('mt-0.5 h-4 w-4 shrink-0 rounded-full border', on ? 'border-[5px] border-[var(--ds-accent)]' : 'border-[var(--ds-hairline)]')}
                  />
                  <span>
                    <span className="block text-[13px] font-semibold text-[var(--ds-ink)]">{o.title}</span>
                    <span className="block text-[11.5px] text-[var(--ds-muted)]">{o.blurb}</span>
                  </span>
                </button>
                {o.value === 'big' && on && (
                  <label htmlFor="comicstudio-big-spend" className="ml-6 mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--ds-muted)]">
                    Ask when a job costs more than
                    <MoneySetting
                      id="comicstudio-big-spend"
                      label="Big spend threshold"
                      value={settings.bigSpendUsd}
                      usdPlaceholder="0.50"
                      ctx={ctx}
                      onCommit={(v) => v !== null && setSettings({ bigSpendUsd: v })}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionLabel htmlFor="comicstudio-budget">Budget cap for this comic</SectionLabel>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <MoneySetting
            id="comicstudio-budget"
            label="Budget cap"
            value={settings.budgetUsd}
            usdPlaceholder="No cap"
            ctx={ctx}
            allowEmpty
            onCommit={(v) => setSettings({ budgetUsd: v === null || v === 0 ? null : v })}
          />
          <span className="text-[12px] text-[var(--ds-muted)]">Spent so far: {doc.spend.totalUsd > 0 ? spentAmount(cost, doc.spend.totalUsd) : cost.governed ? 'nothing yet' : cost.exact(0)}</span>
        </div>
        <p className="mt-1.5 text-[11.5px] text-[var(--ds-muted)]">Nothing runs past this without your explicit OK. Leave empty for no cap.</p>
      </section>

      <section>
        <SectionLabel>Lettering</SectionLabel>
        <div role="radiogroup" aria-label="Lettering" className="grid gap-2">
          {LETTERING_OPTIONS.map((o) => {
            const on = doc.format.lettering === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => !on && void patch([{ op: 'format', patch: { lettering: o.value } }])}
                className={cx(
                  `${RADIUS_CONTROL} border px-3 py-2.5 text-left ${TRANSITION} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]`,
                  on ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
                )}
              >
                <span className="block text-[13px] font-semibold text-[var(--ds-ink)]">{o.title}</span>
                <span className="block text-[11.5px] text-[var(--ds-muted)]">{o.blurb}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <SectionLabel>Reading direction</SectionLabel>
        <Segmented
          label="Reading direction"
          value={doc.format.readingDirection}
          onChange={(readingDirection) => void patch([{ op: 'format', patch: { readingDirection } }])}
          options={[
            { value: 'ltr', label: 'Left → right' },
            { value: 'rtl', label: 'Right → left (manga)' }
          ]}
        />
      </section>
    </div>
  );
};

// ── Loading / fatal ──────────────────────────────────────────────────────────

/** `chrome`: the phone portrait header size (phoneChrome.ts), so the header doesn't jump when the comic arrives. */
const StudioSkeleton: React.FC<{ onBack: () => void; wide: boolean; chrome?: React.CSSProperties }> = ({ onBack, wide, chrome }) => (
  <div role="status" className={`flex h-full min-h-0 w-full flex-col ${CANVAS_BG}`} style={chrome} aria-busy="true" aria-label="Opening your comic">
    <header className="flex shrink-0 items-center gap-3 border-b border-[var(--ds-hairline-soft)] px-3" style={{ height: 'var(--header-h, 56px)', paddingTop: 'var(--sa-top, 0px)', boxSizing: 'content-box' }}>
      <button type="button" onClick={onBack} aria-label="Back to your projects" className={headerIconBtn}>
        <ArrowLeft className="h-4 w-4" />
      </button>
      <Skeleton className="h-4 w-44 max-w-[40%]" />
      <div className="ml-auto flex gap-2">
        <Skeleton pill className="h-8 w-24" />
        <Skeleton pill className="h-8 w-16" />
      </div>
    </header>
    {/* The page keeps its main landmark while the comic loads (P1-QA: no <main> during loading). */}
    <main id="studio-main" className="flex min-h-0 flex-1">
      <div className={cx('flex min-h-0 flex-col justify-end gap-4 p-6', wide ? 'w-2/5' : 'w-full')}>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="ml-auto h-10 w-3/5 rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
      {wide && (
        <div className="grid w-3/5 grid-cols-3 content-start gap-4 border-l border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] w-full rounded-xl" />
          ))}
        </div>
      )}
    </main>
  </div>
);

const FatalError: React.FC<{ message: string; onRetry: () => void; onBack: () => void; retrying: boolean }> = ({ message, onRetry, onBack, retrying }) => (
  <main id="studio-main" className={`grid h-full min-h-0 w-full place-items-center p-6 ${CANVAS_BG}`}>
    <div role="alert" className={`w-full max-w-md rounded-2xl ${HAIRLINE} bg-[var(--ds-surface)] p-6 text-center shadow-[0_8px_32px_rgba(0,0,0,0.08)]`}>
      <span className={`mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl ${TONE_CHIP.warning}`}>
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </span>
      <h2 className="text-[17px] font-semibold tracking-tight text-[var(--ds-ink)]">Couldn’t open this comic</h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--ds-muted)] [overflow-wrap:anywhere]">{message}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <PrimaryButton onClick={onRetry} busy={retrying}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
        </PrimaryButton>
        <GhostButton onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
        </GhostButton>
      </div>
    </div>
  </main>
);

// ── Shell ────────────────────────────────────────────────────────────────────

/** Nothing drawn yet → why Read is unavailable (undefined when it can open). */
export const readUnavailableReason = (doc: ComicDoc | null): string | undefined =>
  doc && pageProgress(doc).ready > 0 ? undefined : 'Read opens once a page is drawn';

/**
 * Keeps --app-h / --kb / html.kb-open in sync while the studio is open. Its own tiny component: the
 * keyboard animates over many frames, and the shell (header, both panes) must not re-render on each.
 */
const KeyboardInsetMount: React.FC = () => {
  useKeyboardInset();
  return null;
};

export const ComicStudioShell: React.FC<{ studio: ComicStudioController; onBack: () => void }> = ({ studio, onBack }) => {
  const ff = useFormFactor();
  useThemeColor();
  const phone = isPhoneLayout(ff.layout);
  const [view, setView] = useState<'chat' | 'board'>('chat');
  const [paneModeState, setPaneModeState] = useState<PaneMode>(() => readPaneMode(ff.widthClass));
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A "Raise the budget" chip (ClientAction open_settings) opens Comic settings at the budget cap.
  useOpenSettingsRequests(() => setSettingsOpen(true));
  const [readerOpen, setReaderOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const composerApi = useRef<StudioComposerHandle | null>(null);
  const askComposer = useRef<StudioComposerHandle | null>(null);
  const { doc } = studio;

  // The pane switcher remembers its choice per window class (an iPad portrait and landscape can differ).
  useEffect(() => setPaneModeState(readPaneMode(ff.widthClass)), [ff.widthClass]);
  const paneMode: PaneMode = showsPaneSwitcher(ff) ? paneModeState : 'both';
  const setPaneMode = useCallback(
    (mode: PaneMode) => {
      setPaneModeState(mode);
      writePaneMode(ff.widthClass, mode);
    },
    [ff.widthClass]
  );

  // Honor the user's light/dark preference even when the studio is opened directly.
  useEffect(() => {
    initTheme();
  }, []);

  // A render overlay stuck far past its usual time offers "Check again": a free reload of the comic.
  const refreshRef = useRef(studio.refresh);
  refreshRef.current = studio.refresh;
  useEffect(() => registerStudioRefresh(() => void refreshRef.current()), []);

  // Name the tab after the comic while it's open.
  const title = doc?.brief.title;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.title;
    document.title = title ? `${title} · Comic Studio` : 'Comic Studio';
    return () => {
      document.title = previous;
    };
  }, [title]);

  // Card clicks inside the conversation ("open page 3", "see the cast") reveal the board — on phones
  // by switching to it, on a collapsed split by showing both panes (this session only, not persisted).
  const { setTab, openPage } = studio;
  const showBoard = useCallback(() => {
    if (phone) setView('board');
    else if (paneMode === 'chat') setPaneModeState('both');
  }, [phone, paneMode]);
  const showChat = useCallback(() => {
    if (phone) setView('chat');
    else if (paneMode === 'board') setPaneModeState('both');
  }, [phone, paneMode]);
  const chatStudio = useMemo<ComicStudioController>(
    () => ({
      ...studio,
      setTab: (tab: BoardTab) => {
        setTab(tab);
        showBoard();
      },
      openPage: (pageId: string | null) => {
        openPage(pageId);
        if (pageId) showBoard();
      }
    }),
    [studio, setTab, openPage, showBoard]
  );

  // Anything that drives the composer (empty-state starters, board buttons, ⌘/Ctrl+K) while the chat
  // pane is hidden brings the chat back first, so the request is never silently swallowed.
  useEffect(() => {
    const onCompose = () => showChat();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') showChat();
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(COMPOSE_EVENT, onCompose);
      window.removeEventListener('keydown', onKey);
    };
  }, [showChat]);

  // Chat tab dot: a director reply landed while the phone showed the board.
  const assistantCount = doc ? doc.conversation.filter((m) => m.role === 'assistant').length : 0;
  const seenAssistant = useRef(assistantCount);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (!phone || view === 'chat') {
      seenAssistant.current = assistantCount;
      setUnread(false);
    } else if (assistantCount > seenAssistant.current) setUnread(true);
  }, [assistantCount, view, phone]);

  const readHint = readUnavailableReason(doc);
  const canRead = !readHint;
  // Phones read in the full-screen reader (a layer, not a pane); larger screens use the board's Read tab.
  const onRead = useCallback(() => {
    if (phone && canRead) {
      setReaderOpen(true);
      return;
    }
    setTab('read');
    showBoard();
  }, [phone, canRead, setTab, showBoard]);
  useBackLayer(readerOpen, () => setReaderOpen(false), 'reader');
  // A page image that fails (an expired signed URL) asks for fresh URLs — at most once per
  // READER_REFRESH_MS. A genuinely broken image must never become an error → refresh → reload →
  // error loop that hammers /api and keeps the sleeping backend awake.
  const lastReaderRefresh = useRef(0);
  const onReaderImageError = useCallback(() => {
    const now = Date.now();
    if (now - lastReaderRefresh.current < READER_REFRESH_MS) return;
    lastReaderRefresh.current = now;
    void refreshRef.current();
  }, []);
  const readerFailed = useCallback(() => {
    setReaderOpen(false);
    setTab('read');
    showBoard();
  }, [setTab, showBoard]);

  // "Ask the Director…": open the sheet and focus its composer inside the same tap, so iOS raises the keyboard.
  const openAsk = useCallback(() => {
    flushSync(() => setAskOpen(true));
    askComposer.current?.focus();
  }, []);

  const skipToComposer = () => {
    if (phone && view !== 'chat') flushSync(() => setView('chat'));
    else if (!phone && paneMode === 'board') flushSync(() => setPaneModeState('both'));
    composerApi.current?.focus();
  };

  if (!doc) {
    if (studio.loadError) {
      return <FatalError message={studio.loadError} onRetry={() => void studio.refresh()} onBack={onBack} retrying={studio.refreshing} />;
    }
    return <StudioSkeleton onBack={onBack} wide={!phone} chrome={phoneChromeVars(ff.layout)} />;
  }

  const pagesRendering = renderingPageCount(doc);
  const progress = pageProgress(doc);
  const gateOpen = doc.gate?.status === 'open';
  const tabBar = ff.layout === 'single';
  const boardHiddenFromChat = phone ? view !== 'board' : paneMode === 'chat';

  const navItems: StudioNavItem[] = [
    {
      id: 'chat',
      label: 'Chat',
      icon: <MessageSquare className="h-5 w-5" aria-hidden />,
      dot: gateOpen ? 'amber' : unread ? 'accent' : undefined,
      current: view === 'chat' && !readerOpen,
      onSelect: () => setView('chat')
    },
    {
      id: 'board',
      label: 'Board',
      icon: <LayoutGrid className="h-5 w-5" aria-hidden />,
      // Shown as words ("6 of 12"), so the spoken name starts with exactly what the tab shows.
      badge: progress.total ? `${progress.ready} of ${progress.total}` : undefined,
      badgeLabel: progress.total ? `${progress.ready} of ${plural(progress.total, 'page')} ready` : undefined,
      dot: pagesRendering > 0 ? 'pulse' : undefined,
      current: view === 'board' && !readerOpen,
      onSelect: () => setView('board')
    },
    {
      id: 'read',
      label: 'Read',
      icon: <BookOpen className="h-5 w-5" aria-hidden />,
      disabled: !canRead,
      disabledReason: readHint,
      current: readerOpen,
      onSelect: onRead
    }
  ];

  // The board is out of sight while pages draw: the activity line's status opens it (one status row;
  // it replaced the separate "N pages rendering · View" pill above the composer).
  const viewRenders =
    boardHiddenFromChat && pagesRendering > 0
      ? () => {
          setTab('pages');
          showBoard();
        }
      : undefined;

  const chat = (
    <ConversationPane studio={chatStudio} onViewActivity={viewRenders} insetBottom={!tabBar} composerApiRef={composerApi} className="min-w-0 flex-1" />
  );

  const board = (
    <section
      aria-label="Board"
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-[var(--ds-well)]"
      // Phones in landscape have no tab bar under the board: keep its bottom controls out of the
      // home-indicator inset (portrait: the tab bar pads itself; tablets: the timeline dock does).
      style={phone && !tabBar ? { paddingBottom: 'var(--sa-bottom-eff, 0px)' } : undefined}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <BoardPane studio={studio} />
      </div>
    </section>
  );

  return (
    <div
      className={`gesture-root relative flex min-h-0 w-full min-w-0 flex-col overflow-hidden font-sans ${CANVAS_BG} text-[var(--ds-ink)]`}
      style={{ height: 'var(--app-h, 100%)', maxHeight: '100%', paddingLeft: 'var(--sa-left, 0px)', paddingRight: 'var(--sa-right, 0px)', ...phoneChromeVars(ff.layout) }}
      data-layout={ff.layout}
      // Comic Studio renders in the Atlas design language wherever it is mounted (the comics host
      // sets the same attribute on <html>; on the apex this root is the skin's boundary).
      data-ds-skin={COMIC_STUDIO_SKIN}
    >
      <KeyboardInsetMount />
      <button
        type="button"
        onClick={skipToComposer}
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[90] focus:rounded-full focus:bg-[var(--ds-surface-strong)] focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-[var(--ds-ink)] focus:shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
      >
        Skip to composer
      </button>
      <StudioHeader
        studio={studio}
        doc={doc}
        ff={ff}
        onBack={onBack}
        onRead={onRead}
        readHint={readHint}
        onOpenSettings={() => setSettingsOpen(true)}
        paneMode={paneMode}
        onPaneMode={setPaneMode}
        ask={phone && view === 'board' && !readerOpen ? { busy: studio.messageBusy, onAsk: openAsk, onViewChat: () => setView('chat') } : undefined}
      />
      <HeaderBanners studio={studio} compact={headerVariantFor(ff) !== 'regular'} />

      <main id="studio-main" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StudioLayout ff={ff} chat={chat} board={board} view={view} paneMode={paneMode} navItems={navItems} onBack={onBack} />
      </main>

      <AdaptiveSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        label="Comic settings"
        title="Comic settings"
        presentation="side"
        panel
        modal
        detents={['full']}
        sideWidth={420}
      >
        <div className="px-5 py-5">
          <SettingsPanel doc={doc} patch={studio.patch} caps={studio.caps} byok={studio.byok} />
        </div>
      </AdaptiveSheet>

      {phone && (
        <AdaptiveSheet open={askOpen} onClose={() => setAskOpen(false)} label="Ask the Director" title="Ask the Director" presentation="bottom" detents={['content']}>
          <div className="px-3 pb-3">
            <StudioComposer
              studio={studio}
              variant="sheet"
              apiRef={askComposer}
              onSent={() => setAskOpen(false)}
              placeholder="Ask about this board — e.g. “make page 2 moodier”"
            />
          </div>
        </AdaptiveSheet>
      )}

      {readerOpen && (
        <SlotBoundary id="reader" kind="reader" onError={readerFailed}>
          <Suspense
            fallback={
              <div role="status" aria-label="Opening the reader" className="fixed inset-0 z-[80] grid place-items-center bg-[var(--ds-reader-room,#0e0d0c)] text-[13px] text-white/70">
                Opening the reader…
              </div>
            }
          >
            <ImmersiveReader doc={doc} urlFor={studio.urlFor} intro onExit={() => setReaderOpen(false)} onImageError={onReaderImageError} />
          </Suspense>
        </SlotBoundary>
      )}
    </div>
  );
};

export const ComicStudio: React.FC<{ projectId: string; onBack: () => void }> = ({ projectId, onBack }) => {
  const studio = useStudio(projectId);
  // A new project starts with a fresh shell (chat view, closed sheets, empty composer).
  return <ComicStudioShell key={projectId} studio={studio} onBack={onBack} />;
};

export default ComicStudio;
