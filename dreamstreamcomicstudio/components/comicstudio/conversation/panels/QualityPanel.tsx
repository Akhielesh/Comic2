// Quality panel (composer chip "✦ Standard", header quality pill): Draft / Standard / Pro
// with the model each tier draws on, the per-page price (registry estimate, platform
// markup unless the user pays with their own key) and a speed hint. Governed users see the
// price as a share of their usage ("≈0.7% of your usage/page"), never dollars (P1-LIMITS).
// (The image-model picker arrives with the W-M round; this panel stays tier-only.)

import React from 'react';
import { Check, Gauge } from 'lucide-react';
import type { ComicDoc, QualityTier } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { TIER_PRESETS, getImageModel, resolveImageJob, tierPagePrice } from '../../../../shared/comic/models';
import type { StudioCaps } from '../../../../shared/comic/capabilities';
import { useCostFormat } from '../cost';
import { cx } from '../ui';

export const QUALITY_ORDER: QualityTier[] = ['draft', 'standard', 'pro'];

const speedHint = (seconds: number) => (seconds <= 15 ? 'Fast' : seconds <= 25 ? `~${seconds}s per page` : `~${seconds}s per page · slower`);

export interface QualityPanelProps {
  doc: ComicDoc;
  patch: (ops: DocOp[]) => Promise<void> | void;
  byok?: boolean;
  onDone?: () => void;
  /** The user's caps (usage-terms prices for governed users; admins and own keys see dollars). */
  caps?: StudioCaps;
}

export const QualityPanel: React.FC<QualityPanelProps> = ({ doc, patch, byok = false, onDone, caps }) => {
  const current = doc.settings.quality;
  const cost = useCostFormat({ byok, caps });
  const override = getImageModel(doc.settings.imageModelOverride);

  return (
    <div className="p-2">
      <div role="radiogroup" aria-label="Quality" className="space-y-1">
        {QUALITY_ORDER.map((tier) => {
          const preset = TIER_PRESETS[tier];
          const { spec, resolution } = resolveImageJob('page', tier);
          const on = tier === current;
          return (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                if (!on) void patch([{ op: 'settings', patch: { quality: tier } }]);
                onDone?.();
              }}
              className={cx(
                'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40',
                on ? 'bg-[#D97757]/10' : 'hover:bg-[var(--ds-hover)]'
              )}
            >
              <span
                className={cx(
                  'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                  on ? 'border-transparent bg-[var(--ds-accent)] text-white' : 'border-[var(--ds-hairline)]'
                )}
                aria-hidden
              >
                {on && <Check className="h-2.5 w-2.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="min-w-0 text-[13px] font-semibold text-[var(--ds-ink)] [overflow-wrap:anywhere]">
                    {preset.label}
                    <span className="ml-1.5 font-normal text-[var(--ds-muted)]">
                      {spec.nickname} · {resolution}
                    </span>
                  </span>
                  <span className={cx('text-[12px] font-semibold tabular-nums text-[var(--ds-ink)]', cost.governed ? 'min-w-0 text-right' : 'shrink-0')}>
                    {cost.exact(tierPagePrice(tier, byok))}
                    <span className="font-normal text-[var(--ds-muted)]">/page</span>
                  </span>
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--ds-muted)]">{preset.blurb}</span>
                <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-[var(--ds-muted)]">
                  <Gauge className="h-3 w-3" aria-hidden />
                  {speedHint(spec.latencySec)}
                  {tier === 'pro' && <span className="ml-1">· letters pages in-art</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="px-3 pb-1.5 pt-2 text-[10.5px] leading-snug text-[var(--ds-muted)]">
        {byok
          ? 'Prices are what your own API key is charged.'
          : cost.governed
            ? 'Shown as a share of your DreamStream usage.'
            : 'Estimates include DreamStream’s platform fee.'}{' '}
        Style options always use a quick
        1K draft.
        {override && <> Advanced override: every image uses {override.nickname}.</>}
      </p>
    </div>
  );
};
