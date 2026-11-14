import React from 'react';
import type { CatalogModel } from '../../services/modelCatalog';
import type { ModelSpeed } from '../../services/modelSpeed';
import { MUTED } from '../chat/studioDesign';
import { modelKey, knownTokenPrice, modelPrice, formatLatency } from './workspaceData';

/** At most three compared models. Both axes start at zero; missing evidence has no mark. */
export function PricePerformance({ models, speeds }: { models: CatalogModel[]; speeds: Record<string, ModelSpeed> }) {
  const priceMax = Math.max(0.001, ...models.map((m) => knownTokenPrice(m, 'output') ?? 0));
  const timeMax = Math.max(1, ...models.map((m) => speeds[m.id]?.p50Ms ?? 0));
  return <figure className="border-y border-[var(--ds-hairline)] py-5">
    <figcaption className="mb-5 text-sm font-semibold">Price and observed response time</figcaption>
    <div className="grid gap-6 sm:grid-cols-2">{(['price', 'time'] as const).map((axis) => <div key={axis}><p className={`mb-4 text-xs ${MUTED}`}>{axis === 'price' ? 'Output price · USD per 1M tokens' : 'Typical full response · seconds'}</p><ol className="space-y-4">{models.map((model) => {
      const value = axis === 'price' ? knownTokenPrice(model, 'output') : speeds[model.id]?.p50Ms ?? null;
      const max = axis === 'price' ? priceMax : timeMax;
      return <li key={modelKey(model)}><div className="mb-2 flex items-start justify-between gap-4 text-xs"><span className="min-w-0 [overflow-wrap:anywhere]">{model.name}</span><span className="shrink-0 tabular-nums">{axis === 'price' ? modelPrice(model, 'output') : formatLatency(value)}</span></div><svg aria-hidden="true" viewBox="0 0 300 7" preserveAspectRatio="none" className="h-2 w-full"><rect width="300" height="7" fill="var(--ds-well)" />{value != null && <rect width={value / max * 300} height="7" fill={axis === 'price' ? 'var(--ds-chart-1)' : 'var(--ds-chart-2)'} />}</svg></li>;
    })}</ol></div>)}</div>
    <p className={`mt-5 text-xs leading-relaxed ${MUTED}`}>Bars start at zero. Response times come from different real Chat tasks and serving connections; they are not intelligence scores or a controlled speed test.</p>
  </figure>;
}
