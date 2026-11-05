// Client feature module: provider/model health (reliability.md §3–§4; owner M1-RELIABILITY). Registered in
// ../features.ts:
//   - card `model_outage`: the calm outage card with real options (OutageCard);
//   - header slot `model-status` at the banner tier (order 1000): one calm line under the studio header while
//     the comic's model is unsteady or paused (ModelStatusBanner; renders an empty live region otherwise). It
//     also runs armed "wait and retry" intents;
//   - admin section `provider-status`: live ModelHealth for every registry model + this server's breaker
//     events (code-split; the server re-checks requireAdmin).
// Nothing here polls while every model is ok (useModelStatus).
//
// Exports for other packages: ModelHealthDot (picker / insights rows), useModelStatus, QuietFailedState +
// isProviderPause (failed tiles), the status API and the option labels.

import React, { Suspense } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import type { FeatureModule } from '../extensions';
import { MODEL_STATUS_BANNER_ORDER, ModelStatusBanner } from './ModelStatusBanner';
import { OutageCard } from './OutageCard';

const LazyProviderStatus = React.lazy(() => import('./admin/ProviderStatusSection').then((m) => ({ default: m.ProviderStatusSection })));

/** Admin → Provider status (lazy: studio users never download it). */
export const ProviderStatusAdminSection: React.FC = () =>
  React.createElement(
    Suspense,
    {
      fallback: React.createElement(
        'div',
        { className: 'flex items-center gap-2 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 text-[13px] text-[var(--ds-muted)]' },
        React.createElement(Loader2, { className: 'h-4 w-4 motion-safe:animate-spin', 'aria-hidden': true }),
        'Loading provider status…'
      )
    },
    React.createElement(LazyProviderStatus)
  );

export const feature: FeatureModule = {
  cards: [{ type: 'model_outage', Component: OutageCard }],
  headerSlots: [{ id: 'model-status', order: MODEL_STATUS_BANNER_ORDER, Component: ModelStatusBanner }],
  adminSections: [{ id: 'provider-status', label: 'Provider status', icon: React.createElement(Activity, { size: 15 }), Component: ProviderStatusAdminSection }]
};

export { ModelHealthDot } from './ModelHealthDot';
export type { ModelHealthDotProps } from './ModelHealthDot';
export { ModelStatusBanner, MODEL_STATUS_BANNER_ORDER, watchedModelIds } from './ModelStatusBanner';
export { OutageCard } from './OutageCard';
export { QuietFailedState, isProviderPause, quietCaption } from './QuietFailedState';
export type { QuietFailedStateProps, FailedRenderLike } from './QuietFailedState';
export { useModelStatus, useAutoRetry, isBack, STATUS_POLL_MS, STATUS_POLL_MAX_MS } from './useModelStatus';
export type { ModelStatusView, ModelStatusOptions } from './useModelStatus';
export { fetchModelStatus, fetchProviderStatusReport, asModelHealth, MODEL_STATUS_PATH } from './statusApi';
export { optionText } from './OptionButtons';
export { bannerOptions, registrySwitchOptions, latestOutageCard } from './options';
