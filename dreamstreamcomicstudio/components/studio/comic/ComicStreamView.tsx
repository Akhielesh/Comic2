// ComicStreamView — the centralized v3 Comic Studio surface (the "Agent Stream").
//
// One screen replaces the old 7-step wizard: a slim header, a left rail, a scrolling
// column of agent cards (newest last), and a floating prompt bar. It renders from
// ComicState via syncAgentRunWithState, so it always reflects the live build. All actions
// are optional callbacks the orchestrator wires up; with none passed it's a faithful,
// inert preview. Visual language: the calm dark-glass tokens (--ds-*), accent #D97757.

import React, { useState } from 'react';
import type { ComicState } from '../../../types';
import { syncAgentRunWithState } from '../../../services/comicAgentRun';
import { costContextFromAllowance, formatCostForUser, type CostDisplayContext } from '../../../services/costDisplay';
import { useUsageAllowance } from '../../usage/useUsageAllowance';
import { AgentThinking, StreamItem, StreamList } from '../kit';
import { CardForKind, type StreamCardHandlers } from './streamCards';

export interface ComicStreamViewProps {
  state: ComicState;
  projectTitle?: string;
  costUsd?: number;
  /** True while the prompt-bar script analysis is running. */
  analyzing?: boolean;
  /** When set, a spend confirmation is pending — render a gate card with the estimate. */
  pendingGate?: { estimateUsd: number } | null;
  /**
   * The run uses the user's OWN provider key (they pay the provider, their usage isn't touched),
   * so real prices are shown. Otherwise prices read as a share of the user's usage unless the
   * usage status positively says no limit applies (admins / exempt) — governed users never see
   * dollars (P1-LIMITS).
   */
  byok?: boolean;
  onBack?: () => void;
  onOpenSettings?: () => void;
  onSend?: (prompt: string) => void;
  onConfirmGate?: () => void;
  onCancelGate?: () => void;
  handlers?: StreamCardHandlers;
}

const RAIL = ['Project', 'Pages', 'Cast', 'Styles', 'Assets', 'Trash'];

const RailRow: React.FC<{ label: string; active?: boolean }> = ({ label, active }) => (
  <div className={`flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] ${active ? 'bg-[var(--ds-surface-soft)] font-semibold text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'}`}>
    <span className={`h-3.5 w-3.5 rounded ${active ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-muted)]/50'}`} />
    {label}
  </div>
);

const Chip: React.FC<{ children: React.ReactNode; onClick?: () => void; accent?: boolean; className?: string }> = ({ children, onClick, accent, className = '' }) => (
  <button type="button" onClick={onClick} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${accent ? 'bg-[#D97757]/10 text-[var(--ds-accent)]' : 'bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'} ${className}`}>
    {children}
  </button>
);

/**
 * How a price reads to THIS user: "$0.30" for admins / own-key runs, "≈4% of your usage" for
 * everyone on the included usage. Only mounted while a price is on screen, so the usage status
 * is read (once, cached) only then.
 */
const useCostContext = (byok: boolean): CostDisplayContext => costContextFromAllowance(useUsageAllowance(), { byok });

/** The run-confirm sentence: dollars for admins / own key, a usage share for everyone else. */
export const gateCostSentence = (usd: number, ctx: CostDisplayContext): React.ReactNode => {
  const label = formatCostForUser(usd, ctx);
  const strong = <span className="font-semibold text-[var(--ds-ink)]">{label}</span>;
  if (!ctx.governed) return <>This run is estimated at {strong}.</>;
  if (label === 'Free') return <>This run doesn’t use any of your usage.</>;
  // "uses a little of your usage" (the share isn't known yet) reads as its own phrase.
  if (/^uses /.test(label)) return <>This run {strong}.</>;
  return <>This run will use {strong}.</>;
};

const CostChip: React.FC<{ usd: number; byok: boolean }> = ({ usd, byok }) => {
  const ctx = useCostContext(byok);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[12px] text-[var(--ds-ink)]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" aria-hidden />
      <span className="truncate">This comic · {formatCostForUser(usd, ctx)}</span>
    </span>
  );
};

const RunGate: React.FC<{ estimateUsd: number; byok: boolean; onConfirm?: () => void; onCancel?: () => void }> = ({
  estimateUsd,
  byok,
  onConfirm,
  onCancel
}) => {
  const ctx = useCostContext(byok);
  return (
    <div className="rounded-2xl border border-[var(--ds-accent)] bg-[#D97757]/5 p-4 sm:p-5">
      <div className="mb-1 text-[15px] font-semibold text-[var(--ds-ink)]">Confirm before generating</div>
      <div className="mb-4 text-[13px] text-[var(--ds-muted)]">
        {gateCostSentence(estimateUsd, ctx)} Generation hasn’t spent anything yet.
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} className="min-h-11 rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)]">
          {ctx.governed ? 'Run it' : `Run · ${formatCostForUser(estimateUsd, ctx)}`}
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-4 py-2 text-[13px] font-semibold text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]">
          Not yet
        </button>
      </div>
    </div>
  );
};

export const ComicStreamView: React.FC<ComicStreamViewProps> = ({
  state,
  projectTitle = 'Untitled comic',
  costUsd,
  analyzing = false,
  pendingGate = null,
  byok = false,
  onBack,
  onOpenSettings,
  onSend,
  onConfirmGate,
  onCancelGate,
  handlers = {},
}) => {
  const [draft, setDraft] = useState('');
  const run = syncAgentRunWithState(state);
  const activeIndex = run.cards.findIndex((c) => c.kind === run.activeCard);
  // The "so far" stream: every card that has happened, plus the one in flight.
  const visible = run.cards.filter((c, i) => c.status !== 'pending' || i <= activeIndex);

  const send = () => {
    const text = draft.trim();
    if (!text || analyzing) return;
    onSend?.(text);
    setDraft('');
  };

  return (
    <div className="flex h-full w-full flex-col bg-[var(--ds-canvas)] text-[var(--ds-ink)]">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--ds-hairline)] px-3 sm:gap-3 sm:px-4">
        <button type="button" onClick={onBack} aria-label="Back" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-lg text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">‹</button>
        <span className="min-w-0 truncate text-[14px] font-semibold">{projectTitle}</span>
        <span className="hidden shrink-0 rounded-full bg-[var(--ds-surface-soft)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)] sm:inline">Draft</span>
        <div className="flex-1" />
        {typeof costUsd === 'number' && <CostChip usd={costUsd} byok={byok} />}
        <button type="button" onClick={onOpenSettings} aria-label="Agent settings" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)] sm:h-9 sm:w-9">⚙</button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <aside className="hidden w-52 shrink-0 flex-col border-r border-[var(--ds-hairline)] bg-[var(--ds-sidebar)] p-3 md:flex">
          <div className="mb-4 flex items-center gap-2 px-1 py-1">
            <span className="h-5 w-5 rounded-md bg-[var(--ds-accent)]" />
            <span className="text-[14px] font-bold">Comic Studio</span>
          </div>
          <nav className="space-y-1">
            {RAIL.map((r, i) => <RailRow key={r} label={r} active={i === 0} />)}
          </nav>
          <div className="mt-auto">
            <button type="button" className="flex w-full items-center gap-2 rounded-xl border border-[var(--ds-hairline)] px-3 py-2 text-[13px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]">
              <span className="h-3 w-3 rounded-sm bg-[var(--ds-accent)]" /> New comic
            </button>
          </div>
        </aside>

        {/* Stream */}
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          <StreamList className="mx-auto max-w-3xl space-y-4 px-3 pb-32 pt-6 sm:px-6 sm:pt-8">
            {visible.map((card) => {
              const content = <CardForKind state={state} card={card} handlers={handlers} />;
              if (!content) return null;
              return <StreamItem key={card.kind}>{content}</StreamItem>;
            })}
            {analyzing && (
              <StreamItem key="analyzing">
                <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-5">
                  <AgentThinking label="Reading your script & planning the comic…" />
                </div>
              </StreamItem>
            )}
            {pendingGate && (
              <StreamItem key="gate">
                <RunGate estimateUsd={pendingGate.estimateUsd} byok={byok} onConfirm={onConfirmGate} onCancel={onCancelGate} />
              </StreamItem>
            )}
          </StreamList>

          {/* Floating prompt bar */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3 sm:px-6 sm:pb-6">
            <div className="pointer-events-auto mx-auto flex max-w-3xl items-center gap-2 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-2 pl-3 shadow-[0_14px_36px_-10px_rgba(0,0,0,0.5)] backdrop-blur-md">
              <button type="button" aria-label="Attach" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">+</button>
              <Chip accent onClick={onOpenSettings}>Agent</Chip>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Make page 3 darker — or paste a new script…"
                className="min-w-0 flex-1 bg-transparent px-1 text-[14px] text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] focus:outline-none"
              />
              {/* Read-only summary chips: hidden on phones so the input keeps its room. */}
              <Chip className="hidden sm:inline-flex">3:4 ▾</Chip>
              <Chip className="hidden sm:inline-flex">{state.pageCount ? `${state.pageCount}p` : '12p'} ▾</Chip>
              <Chip className="hidden md:inline-flex">Model ▾</Chip>
              <button type="button" onClick={send} disabled={analyzing} aria-label="Send" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ds-accent)] text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:opacity-50">{analyzing ? '…' : '→'}</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

export default ComicStreamView;
