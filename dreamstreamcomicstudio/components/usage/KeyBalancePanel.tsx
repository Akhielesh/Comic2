// Settings → API keys: what the person's own OpenRouter key has left (docs/features/credit-safety.md MN-3), shown
// first, right under "DreamStream usage left".
//
// The figure is the key's real spending capacity as OpenRouter reports it: the smaller of the key's own limit left and
// the account's credits. When it was read is always beside it. "Check now" reads it again; opening Settings reads it
// when the last reading is missing or older than 15 minutes. Nothing polls (the backend sleeps).
//
// Owner-only: the read uses the signed-in owner's bearer and their own key (services/keyBalance.ts). The studio header
// shows the same reading. Ink and muted only, no colour beside money; a governed person's usage stays in percent above.

import React from 'react';
import { ExternalLink, RefreshCw, Wallet } from 'lucide-react';
import { formatUsd } from '../../shared/comic/models';
import { getProviderDef } from '../../shared/providers';
import { keyBalanceView, useKeyBalance } from '../../services/keyBalance';
import { cn } from '../../lib/utils';
import { Button } from '../ds';
import { FOCUS_RING, INK, MUTED, SECTION_CARD, TEXT_2XL } from '../chat/studioDesign';

const FUNDS_URL = getProviderDef('openrouter')?.fundsUrl ?? 'https://openrouter.ai/settings/credits';

export function KeyBalancePanel({ ownerId }: { ownerId: string }) {
  const balance = useKeyBalance(ownerId);
  if (!balance.scope) return null;
  const report = balance.report;
  const view = keyBalanceView(report);
  const checking = balance.state === 'checking';
  const quota = report?.keyQuotaUsd;
  const credits = report?.accountBalances?.find((b) => b.currency === 'USD')?.remaining;
  const facts = [
    typeof quota?.limit === 'number' ? `Key limit ${formatUsd(quota.limit)}` : '',
    typeof quota?.usage === 'number' && quota.usage > 0 ? `${formatUsd(quota.usage)} used on this key` : '',
    typeof credits === 'number' ? `Account credits ${formatUsd(credits)}` : ''
  ].filter(Boolean);
  const note = checking && !report
    ? 'Reading your balance from OpenRouter…'
    : report && !view
      ? 'OpenRouter shares what a key has left only when the key has a credit limit. Set one on this key in OpenRouter to see it here, or check your credits there.'
      : !report && (balance.state === 'unavailable' || balance.state === 'missing' || balance.state === 'unsupported')
        ? 'Couldn’t read the balance just now. Check again in a moment, or see it on OpenRouter.'
        : '';

  return (
    <section aria-label="Your OpenRouter balance" className={`${SECTION_CARD} p-4`} data-key-balance-panel="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className={cn('flex min-w-0 items-center gap-2 text-sm font-semibold', INK)}>
          <Wallet aria-hidden className={cn('size-4 shrink-0', MUTED)} />
          Your OpenRouter balance
        </h4>
        <Button type="button" size="sm" variant="outline" loading={checking} onClick={() => void balance.refresh()}>
          {!checking && <RefreshCw aria-hidden className="size-3.5" />}
          Check now
        </Button>
      </div>
      {view ? (
        // A live region without the status role: Settings' own status lines (key checks, sync) stay the page's statuses.
        <div className="mt-3" aria-live="polite" aria-busy={checking || undefined}>
          <p className={cn('flex flex-wrap items-baseline gap-x-2', INK)}>
            <span className={cn(TEXT_2XL, 'font-semibold tabular-nums tracking-tight')}>{view.amount}</span>
            <span className={cn('text-xs', MUTED)}>left on your OpenRouter key</span>
          </p>
          <p className={cn('mt-0.5 text-xs', MUTED)}>
            Read <time dateTime={new Date(report!.checkedAt).toISOString()}>{view.age}</time>
            {view.stale ? ' · an older reading' : ''}
            {checking ? ' · reading again…' : ''}
          </p>
        </div>
      ) : (
        note && <p aria-live="polite" className={cn('mt-2 text-xs', MUTED)}>{note}</p>
      )}
      {facts.length > 0 && <p className={cn('mt-2 text-xs tabular-nums', MUTED)}>{facts.join(' · ')}</p>}
      <p className={cn('mt-2 text-xs', MUTED)}>
        Comic Studio checks this before a paid step starts and stops a drawing run if the key runs out, so nothing more is charged.{' '}
        <a href={FUNDS_URL} target="_blank" rel="noreferrer" className={cn('inline-flex items-center gap-1 font-semibold underline underline-offset-2', INK, FOCUS_RING)}>
          Add funds
          <ExternalLink aria-hidden className="size-3" />
          <span className="sr-only">(opens OpenRouter in a new tab)</span>
        </a>
      </p>
    </section>
  );
}

export default KeyBalancePanel;
