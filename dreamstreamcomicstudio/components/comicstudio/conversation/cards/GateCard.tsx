// "gate" card: a spend waiting for the user's OK — why it stopped, what (with the page
// breakdown when pages are involved, decisions-final #3), on which model, and how much —
// with Approve (showing the amount) and Not now. Renders the live gate, so it flips to
// approved/declined (or "replaced") as soon as the doc says so.
//
// Layout (visualqa P0-1): the summary and the price block WRAP instead of squeezing each
// other — real model ids are long unbroken tokens (OpenRouter slugs, 60+ characters), so
// the model line is truncated with the full id in its title and the registry nickname shown.

import React from 'react';
import { CheckCircle2, CircleSlash, Coins, TriangleAlert } from 'lucide-react';
import type { Card, ComicDoc, Gate, Msg } from '../../../../shared/comic/doc';
import { formatUsd, getImageModel } from '../../../../shared/comic/models';
import { CountUp } from '../../../studio/kit/streamMotion';
import { registeredCard } from '../../features';
import type { CardProps } from '../../extensions';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton, PrimaryButton, plural } from '../ui';
import { useAction } from './useAction';

type GateCardData = Extract<Card, { type: 'gate' }>;

/** Model shown to people: the registry nickname when the id is known, else the raw id. */
export const gateModelName = (model: string | undefined): string => {
  const raw = (model || '').trim();
  if (!raw) return '';
  return getImageModel(raw)?.nickname || raw;
};

/** One honest sentence: why the studio stopped to ask (contract §4.6 Gate.reason). */
export const gateReasonCopy = (gate: Gate, doc: ComicDoc): string => {
  switch (gate.reason) {
    case 'budget': {
      const cap = doc.settings.budgetUsd;
      const spent = doc.spend.totalUsd;
      return typeof cap === 'number' && cap > 0
        ? `This would take you past your ${formatUsd(cap)} budget (${formatUsd(spent)} spent so far). Approve to go over it just this once, or raise the budget in Settings.`
        : 'This would take you past your budget. Approve to go over it just this once, or raise the budget in Settings.';
    }
    case 'first_render':
      return 'Your first pages cost real money, so here is exactly what I would draw. Nothing is spent until you approve.';
    case 'plan_review':
      return 'The page plan is new — have a look at it first. Nothing is drawn until you approve.';
    case 'redraw':
      return 'These are already drawn. Redrawing replaces them — the current versions stay in history, so you can switch back for free.';
    case 'no_intent':
      return 'You didn’t ask me to draw yet, so I’m quoting it first. Nothing is spent unless you approve.';
    case 'policy':
    default: {
      const s = doc.settings;
      if (s.confirm === 'always') return 'You asked me to check before every spend.';
      // Only claim the threshold when this spend really is over it. A smaller "policy" gate is a
      // re-quote (the price moved since a button showed it, or a chip carried no price) or a turn
      // whose spends add up — say what is true instead of blaming a setting.
      if (s.confirm !== 'never' && Number.isFinite(s.bigSpendUsd) && gate.estimateUsd > s.bigSpendUsd)
        return `You asked me to check before spends over ${formatUsd(s.bigSpendUsd)}.`;
      return 'Here’s the up-to-date price first — nothing is spent until you approve.';
    }
  }
};

/** The page breakdown a gate is quoting (render_pages only), or null. */
export const gateBreakdownCard = (gate: Gate, cardId: string): Extract<Card, { type: 'breakdown' }> | null => {
  const action = gate.action;
  if (action.type !== 'render_pages') return null;
  const pageIds = Array.isArray(action.pageIds) ? action.pageIds.filter((id): id is string => typeof id === 'string' && !!id) : [];
  return {
    type: 'breakdown',
    id: `${cardId}__breakdown`,
    gateId: gate.id,
    ...(pageIds.length ? { pageIds } : {}),
    ...(action.includeCover ? { cover: true } : {}),
    view: 'plan'
  };
};

type EmbeddedCard = React.ComponentType<CardProps<Card> & { compact?: boolean }>;

/** The message already shows this gate's breakdown as its own card (v5 servers put it above the gate). */
export const messageHasGateBreakdown = (message: Msg | undefined, gateId: string): boolean =>
  !!message?.cards?.some((c) => c && c.type === 'breakdown' && (c as { gateId?: unknown }).gateId === gateId);

/** "drawing now" / "translating now" — what an approved gate is doing. */
export const approvedCopy = (gate: Gate): string =>
  gate.action.type === 'translate' ? 'Approved — translating now.' : gate.action.type === 'edit_page' ? 'Approved — editing now.' : 'Approved — drawing now.';

export const GateCard: React.FC<{ card: GateCardData; studio: ComicStudioController; message?: Msg }> = ({ card, studio, message }) => {
  const doc = studio.doc;
  const { run, isPending } = useAction(studio.act);
  if (!doc) return null;
  const gate = doc.gate && doc.gate.id === card.gateId ? doc.gate : null;

  if (!gate) {
    return (
      <CardShell aria-label="Spend approval">
        <p className="flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
          <CircleSlash className="h-4 w-4 shrink-0" aria-hidden /> This approval was replaced by a newer one.
        </p>
      </CardShell>
    );
  }

  const open = gate.status === 'open';
  const deciding = isPending('approve') || isPending('decline');
  const overBudget = gate.reason === 'budget';
  const modelName = gateModelName(gate.model);
  // Embed the breakdown only when the message doesn't already carry it (older conversations had
  // the gate alone; v5 servers emit a sibling breakdown card above the gate — never show it twice).
  const breakdown = open && !messageHasGateBreakdown(message, gate.id) ? gateBreakdownCard(gate, card.id) : null;
  // The breakdown card lives in its own feature (P1-BOOKMODEL); embed it through the registry.
  const Breakdown = breakdown ? (registeredCard('breakdown')?.Component as EmbeddedCard | undefined) : undefined;
  const msg: Msg = message || { id: `gate_${card.id}`, role: 'assistant', text: '', at: 0, cards: [card] };

  return (
    <CardShell
      title={gate.title || 'Approve this spend?'}
      icon={<Coins className="h-4 w-4" />}
      right={
        overBudget ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            <TriangleAlert className="h-3 w-3" aria-hidden /> Over budget
          </span>
        ) : undefined
      }
      aria-label="Spend approval"
      className="min-w-0 max-w-full"
    >
      {open && <p className="mb-2.5 text-[12.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{gateReasonCopy(gate, doc)}</p>}

      {/* Wraps: the price block drops under the summary when space is short, never squeezing it. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-[14rem] text-[13px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{gate.summary}</p>
        <div className="min-w-0 max-w-full shrink-0 text-right">
          <div className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--ds-ink)]">
            ≈ <CountUp value={gate.estimateUsd} prefix="$" decimals={2} />
          </div>
          <div className="mt-1 max-w-[16rem] truncate text-[11px] text-[var(--ds-muted)]" title={gate.model || undefined} data-testid="gate-model">
            {[gate.imageCount > 0 ? plural(gate.imageCount, 'image') : '', modelName].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      {breakdown && Breakdown && (
        <div className="mt-3 min-w-0">
          <Breakdown card={breakdown} message={msg} studio={studio} compact />
        </div>
      )}

      {open ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          <PrimaryButton
            className="tap-target"
            busy={isPending('approve')}
            disabled={deciding}
            onClick={() => void run('approve', { type: 'approve_gate', gateId: gate.id })}
          >
            Approve · {formatUsd(gate.estimateUsd)}
          </PrimaryButton>
          <GhostButton className="tap-target" busy={isPending('decline')} disabled={deciding} onClick={() => void run('decline', { type: 'decline_gate', gateId: gate.id })}>
            Not now
          </GhostButton>
        </div>
      ) : gate.status === 'approved' ? (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> {approvedCopy(gate)}
        </p>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-[var(--ds-muted)]">
          <CircleSlash className="h-4 w-4 shrink-0" aria-hidden /> Not now — nothing was spent.
        </p>
      )}
    </CardShell>
  );
};
