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
import { AgentThinking, StreamItem, StreamList } from '../kit';
import { CardForKind, type StreamCardHandlers } from './streamCards';

export interface ComicStreamViewProps {
  state: ComicState;
  projectTitle?: string;
  costUsd?: number;
  /** True while the prompt-bar script analysis is running. */
  analyzing?: boolean;
  onBack?: () => void;
  onOpenSettings?: () => void;
  onSend?: (prompt: string) => void;
  handlers?: StreamCardHandlers;
}

const RAIL = ['Project', 'Pages', 'Cast', 'Styles', 'Assets', 'Trash'];

const RailRow: React.FC<{ label: string; active?: boolean }> = ({ label, active }) => (
  <div className={`flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] ${active ? 'bg-[var(--ds-surface-soft)] font-semibold text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'}`}>
    <span className={`h-3.5 w-3.5 rounded ${active ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-muted)]/50'}`} />
    {label}
  </div>
);

const Chip: React.FC<{ children: React.ReactNode; onClick?: () => void; accent?: boolean }> = ({ children, onClick, accent }) => (
  <button type="button" onClick={onClick} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${accent ? 'bg-[#D97757]/10 text-[var(--ds-accent)]' : 'bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'}`}>
    {children}
  </button>
);

export const ComicStreamView: React.FC<ComicStreamViewProps> = ({
  state,
  projectTitle = 'Untitled comic',
  costUsd,
  analyzing = false,
  onBack,
  onOpenSettings,
  onSend,
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
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--ds-hairline)] px-4">
        <button type="button" onClick={onBack} aria-label="Back" className="rounded-lg px-1.5 text-lg text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">‹</button>
        <span className="text-[14px] font-semibold">{projectTitle}</span>
        <span className="rounded-full bg-[var(--ds-surface-soft)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)]">Draft</span>
        <div className="flex-1" />
        {typeof costUsd === 'number' && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[12px] text-[var(--ds-ink)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]" />
            This comic · ${costUsd.toFixed(2)}
          </span>
        )}
        <button type="button" onClick={onOpenSettings} aria-label="Agent settings" className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">⚙</button>
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
          <StreamList className="mx-auto max-w-3xl space-y-4 px-6 pb-32 pt-8">
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
          </StreamList>

          {/* Floating prompt bar */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-6">
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
              <Chip>3:4 ▾</Chip>
              <Chip>{state.pageCount ? `${state.pageCount}p` : '12p'} ▾</Chip>
              <Chip>Model ▾</Chip>
              <button type="button" onClick={send} disabled={analyzing} aria-label="Send" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ds-accent)] text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:opacity-50">{analyzing ? '…' : '→'}</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

export default ComicStreamView;
