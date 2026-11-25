// The own-key balance inside the studio's Spending sheet, for phone headers too narrow for the header pill
// (KeyBalanceSlot keyBalanceInHeader; docs/features/credit-safety.md MN-3). The same reading as the pill and Settings:
// "$12.40 left on your OpenRouter key", when it was read, and Check now. Opening the sheet reads it when the reading is
// missing or older than 15 minutes; Check now reads it at once. Nothing polls.
//
// Only for the comic's own-key owner with an OpenRouter key whose balance OpenRouter shares; where the header shows the
// pill this renders nothing (one home per control). Ink and muted only: no colour beside money.

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { keyBalanceView, useKeyBalance } from '../../../services/keyBalance';
import { cn } from '../../../lib/utils';
import { Button } from '../../ds';
import { INK, MUTED, OVERLINE } from '../../chat/studioDesign';
import { useFormFactor } from '../mobile/useFormFactor';
import type { StudioController } from '../types';
import { keyBalanceInHeader } from './KeyBalanceSlot';

export const KeyBalanceSheetLine: React.FC<{ studio: Pick<StudioController, 'caps'> }> = ({ studio }) => {
  const { user } = useAuth();
  const ff = useFormFactor();
  const ownKey = studio.caps?.byok === true;
  const here = ownKey && !keyBalanceInHeader(ff);
  const balance = useKeyBalance(user?.id, { enabled: here });
  const view = keyBalanceView(balance.report);
  if (!here || !user || !balance.scope || !view) return null;
  const checking = balance.state === 'checking';
  return (
    <section aria-label="Your OpenRouter balance" className="w-[min(20rem,calc(100vw-2rem))] border-t border-[var(--ds-hairline-soft)] p-4" data-key-balance-line="">
      <div className={OVERLINE}>Your OpenRouter key</div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="min-w-0" aria-live="polite" aria-busy={checking || undefined}>
          <p className={cn('text-[20px] font-semibold tracking-tight tabular-nums', INK)}>
            {view.amount} <span className={cn('text-[12.5px] font-normal tracking-normal', MUTED)}>left</span>
          </p>
          <p className={cn('mt-0.5 text-[11.5px]', MUTED)}>
            Read <time dateTime={new Date(balance.report!.checkedAt).toISOString()}>{view.age}</time>
            {view.stale ? ' · an older reading' : ''}
            {checking ? ' · reading again…' : ''}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" loading={checking} onClick={() => void balance.refresh()} className="shrink-0">
          {!checking && <RefreshCw aria-hidden className="size-3.5" />}
          Check now
        </Button>
      </div>
    </section>
  );
};

export default KeyBalanceSheetLine;
