// "gate" card: a spend waiting for the user's OK — what, on which model, and how much —
// with Approve (showing the amount) and Not now. Renders the live gate, so it flips to
// approved/declined (or "replaced") as soon as the doc says so.

import React from 'react';
import { CheckCircle2, CircleSlash, Coins, TriangleAlert } from 'lucide-react';
import type { Card } from '../../../../shared/comic/doc';
import { formatUsd } from '../../../../shared/comic/models';
import { CountUp } from '../../../studio/kit/streamMotion';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton, PrimaryButton, plural } from '../ui';
import { useAction } from './useAction';

type GateCardData = Extract<Card, { type: 'gate' }>;

export const GateCard: React.FC<{ card: GateCardData; studio: ComicStudioController }> = ({ card, studio }) => {
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
    >
      <div className="flex items-end justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-snug text-[var(--ds-ink)]">{gate.summary}</p>
        <div className="shrink-0 text-right">
          <div className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--ds-ink)]">
            ≈ <CountUp value={gate.estimateUsd} prefix="$" decimals={2} />
          </div>
          <div className="mt-1 text-[11px] text-[var(--ds-muted)]">
            {plural(gate.imageCount, 'image')} · {gate.model}
          </div>
        </div>
      </div>

      {open ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          <PrimaryButton
            busy={isPending('approve')}
            disabled={deciding}
            onClick={() => void run('approve', { type: 'approve_gate', gateId: gate.id })}
          >
            Approve · {formatUsd(gate.estimateUsd)}
          </PrimaryButton>
          <GhostButton busy={isPending('decline')} disabled={deciding} onClick={() => void run('decline', { type: 'decline_gate', gateId: gate.id })}>
            Not now
          </GhostButton>
        </div>
      ) : gate.status === 'approved' ? (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> Approved — drawing now.
        </p>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-[var(--ds-muted)]">
          <CircleSlash className="h-4 w-4" aria-hidden /> Not now — nothing was spent.
        </p>
      )}
    </CardShell>
  );
};
