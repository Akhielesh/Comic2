// Agent Stream cards — the structured "messages" of the v3 Comic Studio.
//
// Each card renders one phase of the build from ComicState (+ the synced agentRun card),
// using the kit's motion primitives. Purely presentational: all actions are optional
// callbacks the orchestrator wires up, so these render safely on their own.

import React from 'react';
import type { ComicAgentCard, ComicState } from '../../../types';
import { castTierLabel, resolveCastTier } from '../../../services/castTiers';
import { planBeats } from '../../../services/beatPlanner';
import {
  AgentThinking,
  CountUp,
  ImageDevelop,
  PanelGrid,
  PanelPop,
  SelectPop,
} from '../kit';
import { cn } from '../../../lib/utils';
import { Button, Progress } from '../../ds';
import {
  CHIP,
  CHIP_VARIANT,
  FOCUS_RING,
  HAIRLINE,
  INK,
  MUTED,
  RADIUS_CONTROL,
  RADIUS_FEATURE,
  RADIUS_PANEL,
  RADIUS_ROUND,
  SHADOW_SOFT,
  STATUS_INK,
  STATUS_SURFACE
} from '../../chat/studioDesign';

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

/**
 * The placeholder behind a cast sheet that is not drawn yet: one step per tier that keeps its order in every
 * skin and theme (well-strong, then well, then the canvas with a hairline for extras).
 */
const TIER_TINTS: Record<string, string> = {
  lead: 'bg-[var(--ds-well-strong)]',
  support: 'bg-[var(--ds-well)]',
  extra: 'border border-[var(--ds-hairline)] bg-[var(--ds-canvas)]'
};
/** The small radius (4 px under the skin); ComicStreamView uses it too. */
export const RADIUS_SM = 'rounded-[var(--ds-radius-sm)]';

// ---- shared shell ---------------------------------------------------------------------

const Surface: React.FC<{ title: string; right?: React.ReactNode; children?: React.ReactNode }> = ({ title, right, children }) => (
  <div className={cn('bg-[var(--ds-surface)] p-5', HAIRLINE, SHADOW_SOFT, RADIUS_PANEL)}>
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="min-w-0 text-[15px] font-semibold text-[var(--ds-ink)]">{title}</span>
      {right}
    </div>
    {children}
  </div>
);

const Pill: React.FC<{ children: React.ReactNode; accent?: boolean }> = ({ children, accent }) => (
  <span className={cn(CHIP, 'gap-1.5 px-2.5 py-1 text-[12px]', accent ? CHIP_VARIANT.filled : CHIP_VARIANT.outline)}>
    {children}
  </span>
);

const PrimaryBtn: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <Button type="button" onClick={onClick}>
    {children}
  </Button>
);

const GhostBtn: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <Button type="button" variant="outline" onClick={onClick}>
    {children}
  </Button>
);

// ---- cards ----------------------------------------------------------------------------

const PlanCard: React.FC<{ state: ComicState; card: ComicAgentCard; h: StreamCardHandlers }> = ({ state, card, h }) => {
  const scenes = state.scenes || [];
  const plan = planBeats(scenes, state.pageCount || 0, 3);
  const pages = plan.pages;
  const panelTotal = Math.max(plan.totalPanels, state.panels?.length || 0);
  const done = card.status === 'done';
  if (scenes.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 bg-[var(--ds-ink)]', RADIUS_ROUND)} />
        Paste or type your story in the bar below — I’ll plan the comic before anything spends.
      </div>
    );
  }
  return (
    <Surface title="Plan" right={<Pill>Estimate · <CountUp value={Math.max(0.05, panelTotal * 0.025)} prefix="$" /></Pill>}>
      <div className="space-y-1.5">
        {plan.beats.slice(0, 6).map((b, i) => (
          <div key={b.id} className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 truncate">
              <span className={cn('shrink-0 bg-[var(--ds-surface-soft)] px-2 py-0.5 text-[12px]', RADIUS_SM, INK)}>Beat {i + 1}</span>
              <span className="truncate text-[var(--ds-muted)]">{b.synopsis}</span>
            </span>
            <span className="shrink-0 text-[12px] text-[var(--ds-muted)]">{b.panelCount} panel{b.panelCount === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[12px] text-[var(--ds-muted)]">{pages} page{pages === 1 ? '' : 's'} · ~{panelTotal} panels · beat-based plan</div>
      {!done && (
        <div className="mt-4 flex flex-wrap gap-2">
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
            <SelectPop key={v.id} selected={state.selectedStyleId === (v.styleId || v.id)} onClick={() => h.onSelectStyle?.(v.styleId || v.id)} ariaLabel={v.prompt?.slice(0, 40)} rounded={RADIUS_PANEL}>
              <ImageDevelop src={v.imageUrl} active={false} className="h-28 w-full" rounded={RADIUS_PANEL}>
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
            <button key={e.id} type="button" onClick={() => h.onEditEntity?.(e.id)} className={cn('flex w-20 flex-col items-center gap-1.5 text-center', RADIUS_CONTROL, FOCUS_RING)}>
              <ImageDevelop src={e.imageUrl} active={e.ready} className="h-16 w-16" rounded={RADIUS_FEATURE}>
                <div className={cn('h-16 w-16', RADIUS_FEATURE, TIER_TINTS[e.tier])} />
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
      <SelectPop selected onClick={h.onSelectCover} ariaLabel="Cover" rounded={RADIUS_PANEL}>
        <ImageDevelop src={state.coverImageUrl} className="aspect-[3/4] w-40" rounded={RADIUS_PANEL} />
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
        <Progress className="mb-3" size="sm" label="Building pages" value={pct} valueText={`${rendered} of ${total || '…'} panels`} tone="making" />
      )}
      {panels.length === 0 ? (
        <AgentThinking label="Rendering pages…" />
      ) : (
        <PanelGrid className="grid grid-cols-4 gap-2">
          {panels.slice(0, 12).map((p) => (
            <PanelPop key={p.id}>
              {p.imageUrl ? (
                <ImageDevelop src={p.imageUrl} className="aspect-square w-full" rounded={RADIUS_PANEL} />
              ) : p.failureReason ? (
                <button type="button" onClick={() => h.onRetryPanel?.(p.id)} className={cn('grid aspect-square w-full place-items-center border text-[11px] font-medium', RADIUS_PANEL, STATUS_SURFACE.error, STATUS_INK.error, FOCUS_RING)}>retry</button>
              ) : (
                <div className={cn('studio-shimmer aspect-square w-full', RADIUS_PANEL)} />
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
