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

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Download,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  Sparkles,
  Wallet
} from 'lucide-react';
import type { ComicDoc, ConfirmPolicy, SpendKind } from '../../shared/comic/doc';
import type { DocOp } from '../../shared/comic/ops';
import { TIER_PRESETS, formatUsd } from '../../shared/comic/models';
import { CountUp } from '../studio/kit/streamMotion';
import { Skeleton } from '../studio/kit/Shimmer';
import { CANVAS_BG, HAIRLINE, TRANSITION } from '../chat/studioDesign';
import { initTheme } from '../../services/theme';
import { BoardPane } from './board/BoardPane';
import { registerStudioRefresh } from './board/ui';
import { pageProgress } from './board/boardModel';
import { ConversationPane } from './conversation/ConversationPane';
import { StudioComposer, type StudioComposerHandle } from './conversation/StudioComposer';
import { COMPOSE_EVENT } from './conversation/composerBus';
import { QualityPanel } from './conversation/panels/QualityPanel';
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
import type { StudioNavItem } from './mobile/shell/MobileTabBar';
import { PaneSwitcher, readPaneMode, writePaneMode, type PaneMode } from './mobile/shell/PaneSwitcher';
import { CompactHeaderMenu, useInstallPrompt, type MenuRow } from './mobile/shell/CompactHeaderMenu';

export { SPLIT_STORAGE_KEY };

// The full-screen reader is a heavy engine (page flip, guided view): loaded the first time it opens.
const ImmersiveReader = React.lazy(() => import('./immersive/ImmersiveReader').then((m) => ({ default: m.ImmersiveReader })));

/** Below this width the phone header moves the spend chip into the ⋯ menu (the title keeps ≥ 100 px). */
export const SPEND_CHIP_MIN_WIDTH = 360;

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

export const SPEND_KIND_LABELS: Record<SpendKind, string> = {
  chat: 'Director',
  plan: 'Page planning',
  style: 'Style options',
  sheet: 'Character sheets',
  page: 'Pages',
  edit: 'Page edits',
  cover: 'Cover',
  qc: 'Quality checks',
  translate: 'Translations'
};

const SPEND_ORDER: SpendKind[] = ['page', 'edit', 'sheet', 'style', 'cover', 'translate', 'plan', 'chat', 'qc'];

/** Every kind with spend, in display order — a kind this build doesn't know yet still shows (never a silent gap). */
export const spendKindsShown = (byKind: Partial<Record<string, number>>): string[] => {
  const positive = (k: string) => {
    const v = byKind[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  };
  const known = SPEND_ORDER.filter(positive);
  const other = Object.keys(byKind).filter((k) => !(SPEND_ORDER as string[]).includes(k) && positive(k));
  return [...known, ...other];
};

export const SpendBreakdown: React.FC<{ doc: ComicDoc }> = ({ doc }) => {
  const spend = doc.spend;
  const byKind = spend.byKind as Partial<Record<string, number>>;
  const kinds = spendKindsShown(byKind);
  const byokUsd = spend.entries.filter((e) => e.byok).reduce((n, e) => n + (Number.isFinite(e.usd) ? e.usd : 0), 0);
  const anyEstimated = spend.entries.some((e) => e.estimated);
  const budget = typeof doc.settings.budgetUsd === 'number' && doc.settings.budgetUsd > 0 ? doc.settings.budgetUsd : null;
  const pct = budget ? Math.min(100, (spend.totalUsd / budget) * 100) : 0;
  return (
    <div className="w-[min(20rem,calc(100vw-2rem))] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Spent on this comic</div>
      <div className="mt-1 text-[24px] font-semibold tracking-tight tabular-nums text-[var(--ds-ink)]">{formatUsd(spend.totalUsd)}</div>
      {budget && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ds-well-strong)]">
            <div className={cx('h-full rounded-full', pct >= 90 ? 'bg-amber-500' : 'bg-[var(--ds-accent)]')} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11.5px] text-[var(--ds-muted)]">
            {formatUsd(spend.totalUsd)} of your {formatUsd(budget)} budget
          </div>
        </div>
      )}
      {kinds.length ? (
        <dl className="mt-3 space-y-1.5 border-t border-[var(--ds-hairline-soft)] pt-3">
          {kinds.map((k) => (
            <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
              <dt className="min-w-0 truncate text-[var(--ds-muted)]">{SPEND_KIND_LABELS[k as SpendKind] || k.replace(/_/g, ' ')}</dt>
              <dd className="shrink-0 font-medium tabular-nums text-[var(--ds-ink)]">{formatUsd(byKind[k] || 0)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-[12.5px] text-[var(--ds-muted)]">Nothing spent yet. Planning and chatting cost cents; you approve every image spend.</p>
      )}
      {byokUsd > 0 && (
        <p className="mt-3 rounded-lg bg-[var(--ds-well)] px-2.5 py-2 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          {formatUsd(byokUsd)} of this was paid with your own API key — tracked here so you see the real cost, but not billed by DreamStream.
        </p>
      )}
      {anyEstimated && (
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
}

/**
 * The studio header. `variant` (from the form factor):
 *  - compact  phones: Back · Title · slots · $ · ⋯ (quality, spending, Read, Easy/Pro, settings in ⋯)
 *  - medium   split below 1024: icon-only quality/Read, Easy/Pro in ⋯, pane switcher
 *  - regular  1024+: today's desktop header (pane switcher on touch tablets)
 */
export const StudioHeader: React.FC<StudioHeaderProps> = ({ studio, doc, ff, onBack, onRead, readHint, onOpenSettings, paneMode, onPaneMode }) => {
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
  const install = useInstallPrompt();
  const saved = savedTotal(doc);
  const showSpendChip = !phone || ff.width >= SPEND_CHIP_MIN_WIDTH;
  const showBack = ff.layout !== 'single-rail'; // the rail carries Back in phone landscape

  const rows: MenuRow[] = [];
  if (phone) {
    rows.push({
      id: 'quality',
      label: 'Quality',
      icon: <Sparkles className="h-4 w-4" />,
      detail: tierLabel,
      opensSheet: true,
      onSelect: () => setOpen('quality')
    });
    rows.push({
      id: 'spend',
      label: 'Spending',
      icon: <Wallet className="h-4 w-4" />,
      detail: saved > 0 ? `${formatUsd(doc.spend.totalUsd)} · saved ${formatUsd(saved)}` : formatUsd(doc.spend.totalUsd),
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
      <SpendBreakdown doc={doc} />
      {phone && saved > 0 && (
        <div className="border-t border-[var(--ds-hairline-soft)]">
          <SavingsBreakdown doc={doc} />
        </div>
      )}
    </div>
  );

  return (
    <header
      className="flex shrink-0 items-center gap-1.5 border-b border-[var(--ds-hairline-soft)] px-2 sm:px-3"
      style={{ height: 'var(--header-h, 56px)', paddingTop: 'var(--sa-top, 0px)', boxSizing: 'content-box' }}
      data-header={variant}
    >
      {showBack && (
        <button type="button" onClick={onBack} aria-label="Back to your projects" title="Back" className={headerIconBtn}>
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <TitleField title={doc.brief.title || 'Untitled comic'} onCommit={(title) => void studio.patch([{ op: 'brief', patch: { title } }])} />

      {showsPaneSwitcher(ff) && <PaneSwitcher value={paneMode} onChange={onPaneMode} className="shrink-0" />}

      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
        {slotRange(-Infinity, H.quality)}
        {!phone && (
          <div ref={qualityRef} className="relative">
            <button
              type="button"
              onClick={() => toggle('quality')}
              aria-haspopup="dialog"
              aria-expanded={open === 'quality'}
              aria-label={`Quality: ${tierLabel}`}
              className={headerBtn}
              title="Quality"
            >
              <span className={cx('h-2 w-2 rounded-full', QUALITY_DOT[tier] || QUALITY_DOT.standard)} aria-hidden />
              {variant === 'regular' && <span>{tierLabel}</span>}
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
              aria-label={`Spent ${formatUsd(doc.spend.totalUsd)} on this comic`}
              className={cx(headerBtn, 'tabular-nums', phone && 'px-2.5')}
            >
              <CountUp value={doc.spend.totalUsd} prefix="$" decimals={2} />
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
        <QualityPanel doc={doc} patch={studio.patch} byok={studio.byok} onDone={close} />
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

export const SettingsPanel: React.FC<{ doc: ComicDoc; patch: (ops: DocOp[]) => Promise<void> | void }> = ({ doc, patch }) => {
  const settings = doc.settings;
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
                  'rounded-xl border px-3 py-2.5 transition-colors',
                  on ? 'border-[#D97757]/45 bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]'
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => !on && setSettings({ confirm: o.value })}
                  className="flex w-full items-start gap-2.5 text-left focus-visible:outline-none"
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
                  <label htmlFor="comicstudio-big-spend" className="ml-6 mt-2 flex items-center gap-2 text-[12px] text-[var(--ds-muted)]">
                    Ask when a job costs more than
                    <UsdField
                      id="comicstudio-big-spend"
                      label="Big spend threshold"
                      value={settings.bigSpendUsd}
                      placeholder="0.50"
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
        <div className="flex items-center gap-3">
          <UsdField
            id="comicstudio-budget"
            label="Budget cap"
            value={settings.budgetUsd}
            placeholder="No cap"
            allowEmpty
            onCommit={(v) => setSettings({ budgetUsd: v === null || v === 0 ? null : v })}
          />
          <span className="text-[12px] text-[var(--ds-muted)]">Spent so far: {formatUsd(doc.spend.totalUsd)}</span>
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
                  'rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40',
                  on ? 'border-[#D97757]/45 bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
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

const StudioSkeleton: React.FC<{ onBack: () => void; wide: boolean }> = ({ onBack, wide }) => (
  <div role="status" className={`flex h-full min-h-0 w-full flex-col ${CANVAS_BG}`} aria-busy="true" aria-label="Opening your comic">
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
    <div className="flex min-h-0 flex-1">
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
    </div>
  </div>
);

const FatalError: React.FC<{ message: string; onRetry: () => void; onBack: () => void; retrying: boolean }> = ({ message, onRetry, onBack, retrying }) => (
  <div className={`grid h-full min-h-0 w-full place-items-center p-6 ${CANVAS_BG}`}>
    <div role="alert" className={`w-full max-w-md rounded-2xl ${HAIRLINE} bg-[var(--ds-surface)] p-6 text-center shadow-[0_8px_32px_rgba(0,0,0,0.08)]`}>
      <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-amber-500/10 text-amber-600">
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
  </div>
);

// ── Phone board: "Ask the Director…" ─────────────────────────────────────────

/** The composer collapsed to one 44 px pill at the foot of the phone Board (mobile.md §3.1). */
const AskDirectorPill: React.FC<{ busy: boolean; onAsk: () => void; onViewChat: () => void; insetBottom: boolean }> = ({ busy, onAsk, onViewChat, insetBottom }) => (
  <div
    // Hidden while the keyboard is up (editing a board field): the field gets the room.
    className="shrink-0 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-strong)] px-3 pt-1.5 backdrop-blur-xl [html.kb-open_&]:hidden"
    style={{ paddingBottom: insetBottom ? 'max(0.375rem, var(--sa-bottom-eff, 0px))' : '0.375rem' }}
    data-ask-pill
  >
    <button
      type="button"
      onClick={busy ? onViewChat : onAsk}
      className={`press mx-auto flex h-11 w-full max-w-xl items-center gap-2 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-4 text-left text-[14px] text-[var(--ds-muted)] ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40`}
    >
      {busy ? (
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--ds-accent)] motion-reduce:animate-none" aria-hidden />
      ) : (
        <Sparkles className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{busy ? 'The director is replying — view the chat' : 'Ask the Director…'}</span>
    </button>
  </div>
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
    return <StudioSkeleton onBack={onBack} wide={!phone} />;
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
      badge: progress.total ? `${progress.ready}/${progress.total}` : undefined,
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

  const renderingPill =
    boardHiddenFromChat && pagesRendering > 0 ? (
      <div className="mb-2 flex justify-center">
        <button
          type="button"
          onClick={() => {
            setTab('pages');
            showBoard();
          }}
          className="press inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-ink)] shadow-[0_2px_10px_rgba(0,0,0,0.08)] animate-scale-in coarse:min-h-[44px] coarse:px-4"
        >
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ds-accent)] motion-reduce:animate-none" aria-hidden />
          <span className="truncate">
            {plural(pagesRendering, 'page')} rendering · <span className="text-[var(--ds-accent)]">View</span>
          </span>
        </button>
      </div>
    ) : undefined;

  const chat = (
    <ConversationPane studio={chatStudio} aboveComposer={renderingPill} insetBottom={!tabBar} composerApiRef={composerApi} className="min-w-0 flex-1" />
  );

  const board = (
    <section aria-label="Board" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-[var(--ds-well)]">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <BoardPane studio={studio} />
      </div>
      {phone && <AskDirectorPill busy={studio.messageBusy} onAsk={openAsk} onViewChat={() => setView('chat')} insetBottom={!tabBar} />}
    </section>
  );

  return (
    <div
      className={`gesture-root relative flex min-h-0 w-full min-w-0 flex-col overflow-hidden font-sans ${CANVAS_BG} text-[var(--ds-ink)]`}
      style={{ height: 'var(--app-h, 100%)', maxHeight: '100%', paddingLeft: 'var(--sa-left, 0px)', paddingRight: 'var(--sa-right, 0px)' }}
      data-layout={ff.layout}
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
          <SettingsPanel doc={doc} patch={studio.patch} />
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
            <ImmersiveReader doc={doc} urlFor={studio.urlFor} intro onExit={() => setReaderOpen(false)} onImageError={() => void studio.refresh()} />
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
