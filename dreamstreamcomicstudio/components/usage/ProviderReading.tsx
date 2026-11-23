import React from 'react';
import type { ProviderBalanceReport } from '../../shared/providerBalances';
import { INK, MUTED } from '../chat/studioDesign';

export const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
export const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 4 }).format(amount);
export const timestamp = (value: number | string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A reading always describes the provider's original observation time, including after a failed refresh. */
export function ProviderReading({ report }: { report: ProviderBalanceReport }) {
  const quota = report.keyQuotaUsd;
  const previous = Date.now() - report.checkedAt >= 15 * 60_000;
  const fields: Array<[string, string]> = [];
  for (const { currency, remaining } of report.accountBalances ?? []) fields.push([`Account balance (${currency})`, money(remaining, currency)]);
  if (quota?.remaining != null) fields.push(['Key budget remaining', money(quota.remaining, 'USD')]);
  if (quota?.limit != null) fields.push(['Key spending limit', money(quota.limit, 'USD')]);
  if (quota?.usage != null) fields.push(['Lifetime key usage', money(quota.usage, 'USD')]);
  for (const window of report.planQuotas ?? []) fields.push([window.label, `${number.format(window.remainingPercent)}% remaining`]);
  return (
    <div>
      <p className={`text-xs ${MUTED}`}>
        {previous ? 'Previous provider reading' : 'Provider reading'} · <time dateTime={new Date(report.checkedAt).toISOString()}>{timestamp(report.checkedAt)}</time>
      </p>
      <dl className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-x-3 gap-y-2">
        {fields.map(([name, value], index) => (
          <div key={`${name}-${index}`}><dt className={`text-[11px] ${MUTED}`}>{name}</dt><dd className={`text-sm font-semibold tabular-nums ${INK}`}>{value}</dd></div>
        ))}
      </dl>
    </div>
  );
}
