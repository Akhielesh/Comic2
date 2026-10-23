// "What this costs DreamStream (est.)" — the ONE place dollars appear in Stream Studio for users
// (ADR 0007 D4; costCopy.ts rule 3). Collapsed by default, labelled as OUR cost at list price,
// never as a charge: users are not charged.
import React from 'react';
import { listValueUsd, USAGE_KIND_LABEL, USAGE_KINDS, type UsageCounters, type UsageKind } from '@/shared/stream/usage';
import { approxUsd, COST } from '../costCopy';

export interface CostLine {
  kind: UsageKind;
  label: string;
  usd: number;
}

/** List value per feature (only the ones with any use), and the total. */
export function costLinesOf(byKind: Partial<Record<UsageKind, UsageCounters>>): { lines: CostLine[]; usd: number } {
  const lines: CostLine[] = [];
  for (const kind of USAGE_KINDS) {
    const c = byKind[kind];
    if (!c) continue;
    const v = listValueUsd(c, kind);
    if (v.lines.length) lines.push({ kind, label: USAGE_KIND_LABEL[kind], usd: v.usd });
  }
  return { lines, usd: lines.reduce((s, l) => s + l.usd, 0) };
}

export function CostExpander({ byKind, recap = false }: { byKind: Partial<Record<UsageKind, UsageCounters>>; recap?: boolean }) {
  const { lines, usd } = costLinesOf(byKind);
  return (
    <details className="usage-cost" data-cost="dreamstream">
      <summary>
        <span className="usage-cost-title">{COST.summary}</span>
        <span className="usage-cost-est">{recap ? COST.recapHeadline(approxUsd(usd)) : COST.headline(approxUsd(usd))}</span>
      </summary>
      <p>{COST.notCharged}</p>
      {lines.length > 0 && (
        <ul className="usage-cost-lines">
          {lines.map((l) => (
            <li key={l.kind}>
              <span>{l.label}</span>
              <span className="mono">{approxUsd(l.usd)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="usage-cost-foot">{COST.checked}</p>
    </details>
  );
}
