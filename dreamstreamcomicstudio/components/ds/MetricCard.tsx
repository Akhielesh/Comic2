/**
 * MetricCard — Atlas WorkspacePrimitives MetricCard: a number with its name (OVERLINE), an optional
 * muted line of context and an optional icon tile. A description list underneath (the name is the term,
 * the number its value), so a screen reader hears "Pages drawn, 12". Tabular figures; a long value
 * breaks instead of widening the card.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { OVERLINE, RADIUS_CONTROL, RADIUS_PANEL, SHADOW_SOFT, TEXT_3XL } from './recipes';

export const METRIC_CARD = `min-w-0 ${RADIUS_PANEL} border border-[color:color-mix(in_srgb,var(--ds-hairline)_80%,transparent)] bg-[var(--ds-surface)] text-[var(--ds-ink)] ${SHADOW_SOFT}`;
export const METRIC_VALUE = `m-0 font-semibold tabular-nums tracking-[-0.04em] [overflow-wrap:anywhere] ${TEXT_3XL}`;
export const METRIC_ICON_TILE = `flex size-10 shrink-0 items-center justify-center ${RADIUS_CONTROL} border border-[color:color-mix(in_srgb,var(--ds-hairline)_80%,transparent)] bg-gradient-to-b from-[var(--ds-canvas)] to-[var(--ds-well)] text-[var(--ds-muted)] ${SHADOW_SOFT} dark:from-[var(--ds-hover)] dark:to-[var(--ds-raised)] [&_svg]:size-4`;

export interface MetricCardProps {
  title: React.ReactNode;
  value: React.ReactNode;
  /** One muted line of context ("of 24 planned", "since Monday"). */
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

export function MetricCard({ title, value, meta, icon, className }: MetricCardProps) {
  return (
    <div data-slot="metric-card" className={cn(METRIC_CARD, className)}>
      <div className="flex items-start justify-between gap-4 p-5">
        <dl className="m-0 flex min-w-0 flex-col gap-1.5">
          <dt className={OVERLINE}>{title}</dt>
          <dd className={METRIC_VALUE}>{value}</dd>
          {meta ? <dd className="m-0 text-[length:var(--ds-text-base)] text-[var(--ds-muted)]">{meta}</dd> : null}
        </dl>
        {icon ? (
          <div aria-hidden="true" className={METRIC_ICON_TILE}>
            {icon}
          </div>
        ) : null}
      </div>
    </div>
  );
}
