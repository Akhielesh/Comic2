// Quality panel (composer chip "✦ Standard", header quality pill): Draft / Standard / Pro with the model each
// tier draws on, the per-page price (registry estimate, platform markup unless the user pays with their own key)
// and a speed hint. Governed users see the price as a share of their usage ("≈0.7% of your usage/page"), never
// dollars (P1-LIMITS).
//
// W-M (models.md §3): the image model is locked per comic once the first image is drawn.
//   - Before the lock each tier shows the model it would draw with (the pre-lock choice from the picker applies to
//     every tier); after it, every tier is the LOCKED model at that tier's resolution — a tier never changes the
//     model.
//   - A tier change after the lock asks once, in place (§3.6 E: "Draw new pages at {res}?"), because the book will
//     hold mixed sizes; before the lock it applies at once, as before.
//   - The footer carries the lock line (§3.6 A) with "Change…" / "Choose model…", which opens the model picker
//     (its confirm says consistency can be affected); this panel never changes the model itself.

import React, { useState } from 'react';
import { Check, Gauge } from 'lucide-react';
import type { ComicDoc, QualityTier } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, TIER_PRESETS, imagePriceUsd, resolveImageJob } from '../../../../shared/comic/models';
import { deriveLock, drawnTargets } from '../../../../shared/comic/modelLock';
import type { StudioCaps } from '../../../../shared/comic/capabilities';
import { ACCENT_SOFT_BG, RADIUS_CONTROL, TRANSITION } from '../../../chat/studioDesign';
import { useCostFormat } from '../cost';
import { cx } from '../ui';
import { LockLine } from '../../models/LockLine';
import { TierChangeConfirm } from '../../models/TierChangeConfirm';
import { STYLE_OPTIONS_LOCKED, STYLE_OPTIONS_UNLOCKED, sameModelTierLine } from '../../models/copy';

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
  const lock = deriveLock(doc);
  const override = doc.settings.imageModelOverride;
  const [pending, setPending] = useState<QualityTier | null>(null);
  const jobFor = (tier: QualityTier) => resolveImageJob('page', tier, lock ? undefined : override, lock);
  const pagePrice = (tier: QualityTier) => {
    const { spec, resolution } = jobFor(tier);
    return (imagePriceUsd(spec, resolution) + QC_USD_PER_PAGE) * (byok ? 1 : PLATFORM_MARKUP);
  };
  const apply = (tier: QualityTier) => {
    void patch([{ op: 'settings', patch: { quality: tier } }]);
    onDone?.();
  };

  if (pending && lock) {
    const next = jobFor(pending);
    return (
      <div className="p-2">
        <TierChangeConfirm
          tierLabel={TIER_PRESETS[pending].label}
          res={next.resolution}
          model={next.spec.nickname}
          drawnPages={drawnTargets(doc).pages.length}
          oldRes={jobFor(current).resolution}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            apply(pending);
          }}
        />
      </div>
    );
  }

  return (
    <div className="p-2">
      <div role="radiogroup" aria-label="Quality" className="space-y-1">
        {QUALITY_ORDER.map((tier) => {
          const preset = TIER_PRESETS[tier];
          const { spec, resolution } = jobFor(tier);
          const on = tier === current;
          return (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                if (on) {
                  onDone?.();
                  return;
                }
                // Locked: a tier is a resolution on the same model; ask once when the size really changes (§3.6 E).
                if (lock && jobFor(tier).resolution !== jobFor(current).resolution) {
                  setPending(tier);
                  return;
                }
                apply(tier);
              }}
              className={cx(
                'flex w-full items-start gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11',
                RADIUS_CONTROL,
                TRANSITION,
                on ? ACCENT_SOFT_BG : 'hover:bg-[var(--ds-hover)]'
              )}
            >
              <span
                className={cx(
                  'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                  on ? 'border-transparent bg-[var(--ds-accent)] text-[var(--ds-on-accent)]' : 'border-[var(--ds-hairline)]'
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
                    {cost.exact(pagePrice(tier))}
                    <span className="font-normal text-[var(--ds-muted)]">/page</span>
                  </span>
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--ds-muted)]">
                  {lock ? sameModelTierLine(resolution) : preset.blurb}
                </span>
                <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-[var(--ds-muted)]">
                  <Gauge className="h-3 w-3" aria-hidden />
                  {speedHint(spec.latencySec)}
                  {tier === 'pro' && !lock && <span className="ml-1">· letters pages in-art</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="px-3 pb-1 pt-2 text-[10.5px] leading-snug text-[var(--ds-muted)]">
        {byok
          ? 'Prices are what your own API key is charged.'
          : cost.governed
            ? 'Shown as a share of your DreamStream usage.'
            : 'Estimates include DreamStream’s platform fee.'}{' '}
        {lock ? STYLE_OPTIONS_LOCKED : STYLE_OPTIONS_UNLOCKED}
      </p>
      <LockLine doc={doc} onRequested={onDone} className="border-t border-[var(--ds-hairline-soft)] px-3 pt-1.5" />
    </div>
  );
};
