// Comic Studio header slot: "usage left" (P1-LIMITS). The same meter as everywhere else, presented
// with the studio's AdaptiveSheet (popover on desktop, bottom sheet on phones). It refreshes once
// shortly after the comic's spend changes (a render landed) — never on a timer.
//
// Hidden for admins / exempt accounts (no limit), while the meter is unavailable, and when this
// comic renders on the user's own key (their key never uses the included usage).

import React, { useRef, useState } from 'react';
import type { StudioController } from '../types';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { UsageDetails, UsageMeterPill } from '../../usage/UsageMeter';
import { useUsageAllowance } from '../../usage/useUsageAllowance';
import { showsUsageMeter } from '../../../services/usageAllowance';

/** Between the spend chip (200) / savings (210) and Read (300) — see features.ts BUILTIN_HEADER_ORDER. */
export const USAGE_SLOT_ORDER = 220;

export const UsageSlot: React.FC<{ studio: Pick<StudioController, 'doc' | 'caps'>; compact: boolean }> = ({ studio, compact }) => {
  const status = useUsageAllowance({ refreshKey: studio.doc?.spend?.totalUsd ?? 0 });
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  if (studio.caps?.byok || !showsUsageMeter(status)) return null;
  return (
    <span ref={anchorRef} className="relative inline-flex shrink-0">
      <UsageMeterPill status={status} compact={compact} open={open} onClick={() => setOpen((o) => !o)} />
      <AdaptiveSheet open={open} onClose={() => setOpen(false)} label="Usage left" title="Usage left" anchorRef={anchorRef} placement="below" align="end">
        <UsageDetails status={status} />
      </AdaptiveSheet>
    </span>
  );
};

export default UsageSlot;
