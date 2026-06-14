// Agent Stream cards — the structured "messages" of the v3 Comic Studio.
//
// Each card renders one phase of the build from ComicState (+ the synced agentRun card),
// using the kit's motion primitives. Purely presentational: all actions are optional
// callbacks the orchestrator wires up, so these render safely on their own.

import React from 'react';
import type { ComicAgentCard, ComicState } from '../../../types';
import { castTierLabel, resolveCastTier } from '../../../services/castTiers';
import {
  AgentThinking,
  CountUp,
  ImageDevelop,
  PanelGrid,
  PanelPop,
  SelectPop,
} from '../kit';

export interface StreamCardHandlers {
  onApprovePlan?: () => void;
  onAdjust?: () => void;
  onSelectStyle?: (id: string) => void;
  onMoreStyles?: () => void;
  onEditEntity?: (id: string) => void;
  onSelectCover?: () => void;
  onEditPage?: (pageNumber: number) => void;
  onRetryPanel?: (panelId: string) => void;
  onRead?: () => void;
  onExport?: (target: 'comic' | 'book' | 'html') => void;
  onPublish?: () => void;
}

const TIER_TINTS: Record<string, string> = { lead: '#2A2030', support: '#202A30', extra: '#1E1E22' };

// ---- shared shell ---------------------------------------------------------------------

const Surface: React.FC<{ title: string; right?: React.ReactNode; children?: React.ReactNode }> = ({ title, right, children }) => (
  <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.18)]">
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="text-[15px] font-semibold text-[var(--ds-ink)]">{title}</span>
      {right}
    </div>
    {children}
  </div>
);

const Pill: React.FC<{ children: React.ReactNode; accent?: boolean }> = ({ children, accent }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] ${accent ? 'bg-[#D97757]/10 text-[var(--ds-accent)]' : 'bg-[var(--ds-surface-soft)] text-[var(--ds-muted)]'}`}>
    {children}
  </span>
);

const PrimaryBtn: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <button type="button" onClick={onClick} className="rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)]">
    {children}
  </button>
);

const GhostBtn: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <button type="button" onClick={onClick} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-4 py-2 text-[13px] font-semibold text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]">
    {children}
  </button>
);

// ---- cards ----------------------------------------------------------------------------

const PlanCard: React.FC<{ state: ComicState; card: ComicAgentCard; h: StreamCardHandlers }> = ({ state, card, h }) => {
  const scenes = state.scenes || [];
  const pages = state.pageCount || Math.max(1, Math.ceil((scenes.length || 1) / 2));
  const panelTotal = Math.max(scenes.length * 3, state.panels?.length || 0);
  const done = card.status === 'done';
  if (scenes.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" />
        Paste or type your story in the bar below — I’ll plan the comic before anything spends.
      </div>
    );
  }
  return (
    <Surface title="Plan" right={<Pill accent>Estimate · <CountUp value={Math.max(0.05, panelTotal * 0.025)} prefix="$" /></Pill>}>
      <div className="space-y-1.5">
        {scenes.slice(0, 6).map((s, i) => (
          <div key={s.id ?? i} className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 truncate">
              <span className="rounded-md bg-[var(--ds-surface-soft)] px-2 py-0.5 text-[12px] text-[var(--ds-ink)]">Beat {i + 1}</span>
              <span className="truncate text-[var(--ds-muted)]">{s.synopsis || s.setting || `Scene ${i + 1}`}</span>
            </span>
            <span className="shrink-0 text-[12px] text-[var(--ds-muted)]">~3 panels</span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[12px] text-[var(--ds-muted)]">{pages} page{pages === 1 ? '' : 's'} · ~{panelTotal} panels · beat-based plan</div>
      {!done && (
        <div className="mt-4 flex gap-2">
          <PrimaryBtn onClick={h.onApprovePlan}>Approve plan</PrimaryBtn>
          <GhostBtn onClick={h.onAdjust}>Adjust</GhostBtn>
        </div>
      )}
    </Surface>
  );
};

const StyleCard: React.FC<{ state: ComicState; card: ComicAgentCard; h: StreamCardHandlers }> = ({ state, card, h }) => {
  const variants = state.styleVariants || [];
  return (
    <Surface title="Style" right={<span className="text-[12px] text-[var(--ds-muted)]">{state.selectedStyleId ? 'style locked' : 'tap a board to lock'}</span>}>
      {variants.length === 0 ? (
        <AgentThinking label="Generating style boards…" />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {variants.slice(0, 4).map((v) => (
            <SelectPop key={v.id} selected={state.selectedStyleId === (v.styleId || v.id)} onClick={() => h.onSelectStyle?.(v.styleId || v.id)} ariaLabel={v.prompt?.slice(0, 40)}>
              <ImageDevelop src={v.imageUrl} active={false} className="h-28 w-full">
                <div className="h-28 w-full bg-[var(--ds-well)]" />
              </ImageDevelop>
            </SelectPop>
          ))}
        </div>
      )}
      {variants.length > 0 && <div className="mt-3"><GhostBtn onClick={h.onMoreStyles}>More options</GhostBtn></div>}
    </Surface>
  );
};

const CastCard: React.FC<{ state: ComicState; h: StreamCardHandlers }> = ({ state, h }) => {
  const chars = state.characters || [];
  const entities = [
    ...chars.map((c, i) => {
      const tier = resolveCastTier(c, i);
      return { id: c.id, name: c.name, tier, imageUrl: c.imageUrl, ready: !!c.imageUrl || (c.referenceImageIds?.length || 0) > 0 };
    }),
    ...(state.locations || []).map((l) => ({ id: l.id, name: l.name, tier: 'extra' as const, imageUrl: l.imageUrl, ready: !!l.imageUrl })),
  ].slice(0, 8);
  return (
    <Surface title="Cast" right={<span className="text-[12px] text-[var(--ds-muted)]">{entities.filter((e) => e.ready).length} of {entities.length} sheets ready</span>}>
      {entities.length === 0 ? (
        <AgentThinking label="Extracting characters & continuity…" />
      ) : (
        <div className="flex flex-wrap gap-4">
          {entities.map((e) => (
            <button key={e.id} type="button" onClick={() => h.onEditEntity?.(e.id)} className="flex w-20 flex-col items-center gap-1.5 text-center">
              <ImageDevelop src={e.imageUrl} active={e.ready} className="h-16 w-16" rounded="rounded-2xl">
                <div className="h-16 w-16 rounded-2xl" style={{ background: TIER_TINTS[e.tier] }} />
              </ImageDevelop>
              <span className="w-full truncate text-[12px] font-semibold text-[var(--ds-ink)]">{e.name}</span>
              <Pill accent={e.tier === 'lead'}>{e.ready ? castTierLabel(e.tier) : 'queued'}</Pill>
            </button>
          ))}
        </div>
      )}
    </Surface>
  );
};

const CoverCard: React.FC<{ state: ComicState; h: StreamCardHandlers }> = ({ state, h }) => (
  <Surface title="Cover" right={<span className="text-[12px] text-[var(--ds-muted)]">{state.coverImageUrl ? 'cover ready' : ''}</span>}>
    {state.coverImageUrl ? (
      <SelectPop selected onClick={h.onSelectCover} ariaLabel="Cover">
        <ImageDevelop src={state.coverImageUrl} className="aspect-[3/4] w-40" rounded="rounded-xl" />
      </SelectPop>
    ) : (
      <AgentThinking label="Designing a cover direction…" />
    )}
  </Surface>
);

const BuildCard: React.FC<{ state: ComicState; card: ComicAgentCard; h: StreamCardHandlers }> = ({ state, card, h }) => {
  const panels = state.panels || [];
  const rendered = panels.filter((p) => p.imageUrl).length;
  const total = state.generationStatus?.totalPanels || panels.length || 0;
  const pct = Math.round(Math.min(100, Math.max(card.progress ?? (total ? (rendered / total) * 100 : 0), 0)));
  return (
    <Surface title={card.status === 'done' ? 'Pages' : 'Building'} right={<span className="text-[12px] text-[var(--ds-muted)]">{rendered} of {total || '…'} panels</span>}>
      {card.status !== 'done' && (
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-well)]">
          <div className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {panels.length === 0 ? (
        <AgentThinking label="Rendering pages…" />
      ) : (
        <PanelGrid className="grid grid-cols-4 gap-2">
          {panels.slice(0, 12).map((p) => (
            <PanelPop key={p.id}>
              {p.imageUrl ? (
                <ImageDevelop src={p.imageUrl} className="aspect-square w-full" />
              ) : p.failureReason ? (
                <button type="button" onClick={() => h.onRetryPanel?.(p.id)} className="grid aspect-square w-full place-items-center rounded-xl border border-red-500/40 bg-red-500/5 text-[11px] text-red-300">retry</button>
              ) : (
                <div className="studio-shimmer aspect-square w-full rounded-xl" />
              )}
            </PanelPop>
          ))}
        </PanelGrid>
      )}
    </Surface>
  );
};

const ExportCard: React.FC<{ state: ComicState; h: StreamCardHandlers }> = ({ state, h }) => {
  const out = state.exportedOutputs || {};
  return (
    <Surface title="Done" right={state.publishedAt ? <Pill accent>published</Pill> : undefined}>
      <div className="mb-3 flex flex-wrap gap-2">
        {(['comic', 'book', 'html'] as const).map((t) => (
          <Pill key={t} accent={!!out[t]}>{t}{out[t] ? ' ✓' : ''}</Pill>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <PrimaryBtn onClick={h.onRead}>Read</PrimaryBtn>
        <GhostBtn onClick={() => h.onExport?.('html')}>Export</GhostBtn>
        <GhostBtn onClick={h.onPublish}>Publish</GhostBtn>
      </div>
    </Surface>
  );
};

/** Render the right card for a given agent-card kind. Returns null for the prompt-only note. */
export const CardForKind: React.FC<{ state: ComicState; card: ComicAgentCard; handlers: StreamCardHandlers }> = ({ state, card, handlers }) => {
  switch (card.kind) {
    case 'prompt': return <PlanCard state={state} card={card} h={handlers} />;
    case 'style': return <StyleCard state={state} card={card} h={handlers} />;
    case 'cast': return <CastCard state={state} h={handlers} />;
    case 'cover': return <CoverCard state={state} h={handlers} />;
    case 'layout': return null; // layout is folded into the prompt-bar chips, not a stream card
    case 'build': return <BuildCard state={state} card={card} h={handlers} />;
    case 'export': return <ExportCard state={state} h={handlers} />;
    default: return null;
  }
};
