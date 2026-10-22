// Comic Studio (v4) shell: header + conversation | board.
//
// Desktop (≥1024px): a resizable split — conversation ~40% | board ~60% (persisted under
// 'comicstudio.split'). Narrow screens: one column with a sticky Chat | Board switch; the
// composer stays docked in both views, and a small "3 pages rendering · View" pill points
// at the board instead of yanking the user there.
//
// The header carries the project-level controls: back, the editable title, quality,
// the truthful spend chip (with a by-kind breakdown and BYOK note), Read, and Settings
// (confirm policy, budget cap, lettering, reading direction). Feature controls (Share,
// Easy/Pro, savings) join through the header slot registry (features.ts, contract §13.2),
// interleaved with the built-ins by `order`.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Image as ImageIcon,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Settings2
} from 'lucide-react';
import type { ComicDoc, ConfirmPolicy, SpendKind } from '../../shared/comic/doc';
import type { DocOp } from '../../shared/comic/ops';
import { TIER_PRESETS, formatUsd } from '../../shared/comic/models';
import { applyGutterDelta } from '../studio/kit/ResizableSplit';
import { useIsWide } from '../studio/kit/useMediaQuery';
import { CountUp } from '../studio/kit/streamMotion';
import { Skeleton } from '../studio/kit/Shimmer';
import { CANVAS_BG, HAIRLINE, MENU_ITEM, TRANSITION } from '../chat/studioDesign';
import { initTheme } from '../../services/theme';
import { BoardPane } from './board/BoardPane';
import { ConversationPane } from './conversation/ConversationPane';
import { PopSheet, SlideOver } from './conversation/PopSheet';
import { QualityPanel } from './conversation/panels/QualityPanel';
import { LETTERING_OPTIONS } from './conversation/panels/FormatPanel';
import { GhostButton, PrimaryButton, Segmented, SectionLabel, cx, plural } from './conversation/ui';
import { renderingPageCount } from './studioReducer';
import { useStudio, type ComicStudioController } from './useStudio';
import type { BoardTab } from './types';
import { BUILTIN_HEADER_ORDER, registeredHeaderSlots, type HeaderSlotRegistration } from './features';

export const SPLIT_STORAGE_KEY = 'comicstudio.split';
const DEFAULT_SPLIT = [40, 60];
const MIN_PANE_PX = 360;

// ── Split view ───────────────────────────────────────────────────────────────

const readSplit = (): number[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SPLIT_STORAGE_KEY) || 'null');
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((x) => typeof x === 'number' && x > 0)) return parsed;
  } catch {
    /* fall through */
  }
  return DEFAULT_SPLIT.slice();
};

/** Two-pane horizontal split in calm-studio chrome; the gutter is draggable and keyboard-adjustable. */
const SplitView: React.FC<{ left: React.ReactNode; right: React.ReactNode }> = ({ left, right }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(readSplit);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      /* not persisted */
    }
  }, [sizes]);

  const minFrac = (sum: number) => {
    const width = containerRef.current?.getBoundingClientRect().width || 0;
    return width > 0 ? Math.min(sum * 0.45, (MIN_PANE_PX / width) * sum) : sum * 0.25;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const start = sizes.slice();
    const sum = start[0] + start[1];
    const startX = e.clientX;
    const min = minFrac(sum);
    const onMove = (ev: PointerEvent) => setSizes(applyGutterDelta(start, 0, ((ev.clientX - startX) / rect.width) * sum, min));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const sum = sizes[0] + sizes[1];
    const step = sum * 0.03;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSizes((s) => applyGutterDelta(s, 0, e.key === 'ArrowLeft' ? -step : step, minFrac(sum)));
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault();
      setSizes(DEFAULT_SPLIT.slice());
    }
  };

  const leftPct = Math.round((sizes[0] / (sizes[0] + sizes[1])) * 100);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full">
      <div className="flex min-h-0 min-w-0" style={{ flexGrow: sizes[0], flexShrink: 1, flexBasis: 0 }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize conversation and board"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={leftPct}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setSizes(DEFAULT_SPLIT.slice())}
        className="group relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center focus-visible:outline-none"
      >
        <span className="w-px bg-[var(--ds-hairline)] transition-colors group-hover:bg-[#D97757]/50 group-focus-visible:bg-[var(--ds-accent)]" />
      </div>
      <div className="flex min-h-0 min-w-0" style={{ flexGrow: sizes[1], flexShrink: 1, flexBasis: 0 }}>
        {right}
      </div>
    </div>
  );
};

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
        if (e.key === 'Enter') {
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
      maxLength={200}
      spellCheck={false}
      className={`min-w-0 max-w-[28rem] flex-1 truncate rounded-lg border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold tracking-tight text-[var(--ds-ink)] outline-none ${TRANSITION} hover:border-[var(--ds-hairline)] focus:border-[#D97757]/45 focus:bg-[var(--ds-surface-soft)]`}
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

const SPEND_ORDER: SpendKind[] = ['page', 'edit', 'sheet', 'style', 'cover', 'plan', 'chat', 'qc'];

export const SpendBreakdown: React.FC<{ doc: ComicDoc }> = ({ doc }) => {
  const spend = doc.spend;
  const kinds = SPEND_ORDER.filter((k) => (spend.byKind[k] || 0) > 0);
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
            <div key={k} className="flex items-center justify-between text-[13px]">
              <dt className="text-[var(--ds-muted)]">{SPEND_KIND_LABELS[k]}</dt>
              <dd className="font-medium tabular-nums text-[var(--ds-ink)]">{formatUsd(spend.byKind[k] || 0)}</dd>
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

/** A feature header control; a crash inside it hides the control, never the studio. */
class HeaderSlotBoundary extends React.Component<{ id: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[comicstudio] header slot "${this.props.id}" failed to render`, error);
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
        <HeaderSlotBoundary key={slot.id} id={slot.id}>
          <slot.Component studio={studio} compact={compact} />
        </HeaderSlotBoundary>
      ))}
  </>
);

const QUALITY_DOT: Record<string, string> = { draft: 'bg-sky-500', standard: 'bg-emerald-500', pro: 'bg-[var(--ds-accent)]' };

const headerBtn = `inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[12.5px] font-medium text-[var(--ds-ink)] ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40`;

const StudioHeader: React.FC<{
  studio: ComicStudioController;
  doc: ComicDoc;
  onBack: () => void;
  onRead: () => void;
  onOpenSettings: () => void;
  /** Narrow header (single-column studio): slots render their compact form. */
  compact?: boolean;
}> = ({ studio, doc, onBack, onRead, onOpenSettings, compact = false }) => {
  const [open, setOpen] = useState<'quality' | 'spend' | 'menu' | null>(null);
  const slots = registeredHeaderSlots();
  const H = BUILTIN_HEADER_ORDER;
  const slotRange = (from: number, to: number) =>
    slots.length ? <HeaderSlots slots={slots} from={from} to={to} studio={studio} compact={compact} /> : null;
  const qualityRef = useRef<HTMLDivElement>(null);
  const spendRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggle = (which: 'quality' | 'spend' | 'menu') => setOpen((cur) => (cur === which ? null : which));
  const close = () => setOpen(null);
  const tier = doc.settings.quality;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--ds-hairline-soft)] px-2 sm:px-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to your projects"
        title="Back"
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] ${TRANSITION} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <TitleField title={doc.brief.title || 'Untitled comic'} onCommit={(title) => void studio.patch([{ op: 'brief', patch: { title } }])} />

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {slotRange(-Infinity, H.quality)}
        <div ref={qualityRef} className="relative">
          <button type="button" onClick={() => toggle('quality')} aria-haspopup="dialog" aria-expanded={open === 'quality'} className={headerBtn} title="Quality">
            <span className={cx('h-2 w-2 rounded-full', QUALITY_DOT[tier] || QUALITY_DOT.standard)} aria-hidden />
            <span className="hidden sm:inline">{TIER_PRESETS[tier]?.label || 'Standard'}</span>
            <ChevronDown className="h-3 w-3 text-[var(--ds-muted)]" aria-hidden />
          </button>
          <PopSheet open={open === 'quality'} onClose={close} label="Quality" anchorRef={qualityRef} placement="below" align="end" className="w-[min(25rem,calc(100vw-1.5rem))]">
            <QualityPanel doc={doc} patch={studio.patch} byok={studio.byok} onDone={close} />
          </PopSheet>
        </div>
        {slotRange(H.quality, H.spend)}

        <div ref={spendRef} className="relative">
          <button
            type="button"
            onClick={() => toggle('spend')}
            aria-haspopup="dialog"
            aria-expanded={open === 'spend'}
            aria-label={`Spent ${formatUsd(doc.spend.totalUsd)} on this comic`}
            className={cx(headerBtn, 'tabular-nums')}
          >
            <CountUp value={doc.spend.totalUsd} prefix="$" decimals={2} />
          </button>
          <PopSheet open={open === 'spend'} onClose={close} label="Spending" anchorRef={spendRef} placement="below" align="end">
            <SpendBreakdown doc={doc} />
          </PopSheet>
        </div>
        {slotRange(H.spend, H.read)}

        <button type="button" onClick={onRead} className={headerBtn} aria-label="Read the comic">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">Read</span>
        </button>
        {slotRange(H.read, H.more)}

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => toggle('menu')}
            aria-haspopup="menu"
            aria-expanded={open === 'menu'}
            aria-label="More"
            className={`grid h-8 w-8 place-items-center rounded-full text-[var(--ds-muted)] ${TRANSITION} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <PopSheet open={open === 'menu'} onClose={close} label="More" anchorRef={menuRef} placement="below" align="end" className="w-52 py-1">
            <div role="menu">
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  onOpenSettings();
                }}
              >
                <Settings2 className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden /> Settings
              </button>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  void studio.refresh();
                }}
              >
                <RefreshCw className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden /> Resync
              </button>
            </div>
          </PopSheet>
        </div>
        {slotRange(H.more, Infinity)}
      </div>
    </header>
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
        className="h-8 w-20 bg-transparent px-1.5 text-[13px] tabular-nums text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] disabled:opacity-50"
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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--ds-hairline-soft)] px-3">
      <button type="button" onClick={onBack} aria-label="Back to your projects" className="grid h-9 w-9 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">
        <ArrowLeft className="h-4 w-4" />
      </button>
      <Skeleton className="h-4 w-44" />
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
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--ds-muted)]">{message}</p>
      <div className="mt-5 flex justify-center gap-2">
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

// ── Shell ────────────────────────────────────────────────────────────────────

export const ComicStudio: React.FC<{ projectId: string; onBack: () => void }> = ({ projectId, onBack }) => {
  const studio = useStudio(projectId);
  const wide = useIsWide();
  const [mobileView, setMobileView] = useState<'chat' | 'board'>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { doc } = studio;

  useEffect(() => {
    setMobileView('chat');
    setSettingsOpen(false);
  }, [projectId]);

  // Honor the user's light/dark preference even when the studio is opened directly.
  useEffect(() => {
    initTheme();
  }, []);

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

  // Card clicks inside the conversation ("open page 3", "see the cast") should reveal the
  // board on narrow screens; automatic tab follows from server ops should not.
  const { setTab, openPage } = studio;
  const showBoard = useCallback(() => {
    if (!wide) setMobileView('board');
  }, [wide]);
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

  const onRead = useCallback(() => {
    setTab('read');
    showBoard();
  }, [setTab, showBoard]);

  if (!doc) {
    if (studio.loadError) {
      return <FatalError message={studio.loadError} onRetry={() => void studio.refresh()} onBack={onBack} retrying={studio.refreshing} />;
    }
    return <StudioSkeleton onBack={onBack} wide={wide} />;
  }

  const pagesRendering = renderingPageCount(doc);
  const board = (
    <div className="h-full min-h-0 w-full overflow-hidden bg-[var(--ds-well)]">
      <BoardPane studio={studio} />
    </div>
  );

  return (
    <div className={`flex h-full min-h-0 w-full flex-col font-sans ${CANVAS_BG} text-[var(--ds-ink)]`}>
      <StudioHeader studio={studio} doc={doc} onBack={onBack} onRead={onRead} onOpenSettings={() => setSettingsOpen(true)} compact={!wide} />

      {wide ? (
        <div className="min-h-0 flex-1">
          <SplitView left={<ConversationPane studio={chatStudio} />} right={board} />
        </div>
      ) : (
        <>
          <div className="sticky top-0 z-20 shrink-0 border-b border-[var(--ds-hairline-soft)] px-3 py-2">
            <Segmented<'chat' | 'board'>
              label="View"
              value={mobileView}
              onChange={setMobileView}
              className="mx-auto max-w-xs"
              options={[
                {
                  value: 'chat',
                  label: (
                    <>
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Chat
                    </>
                  )
                },
                {
                  value: 'board',
                  label: (
                    <>
                      <ImageIcon className="h-3.5 w-3.5" aria-hidden /> Board
                      {pagesRendering > 0 && <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ds-accent)]" aria-hidden />}
                    </>
                  )
                }
              ]}
            />
          </div>
          <div className="min-h-0 flex-1">
            <ConversationPane
              studio={chatStudio}
              replaceList={mobileView === 'board' ? board : undefined}
              aboveComposer={
                mobileView === 'chat' && pagesRendering > 0 ? (
                  <div className="mb-2 flex justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        setTab('pages');
                        setMobileView('board');
                      }}
                      className="inline-flex items-center gap-2 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-ink)] shadow-[0_2px_10px_rgba(0,0,0,0.08)] animate-scale-in"
                    >
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ds-accent)]" aria-hidden />
                      {plural(pagesRendering, 'page')} rendering · <span className="text-[var(--ds-accent)]">View</span>
                    </button>
                  </div>
                ) : undefined
              }
            />
          </div>
        </>
      )}

      <SlideOver open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Comic settings">
        <SettingsPanel doc={doc} patch={studio.patch} />
      </SlideOver>
    </div>
  );
};

export default ComicStudio;
