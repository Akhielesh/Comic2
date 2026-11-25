import React, { useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import type { AccountProviderUsageReport } from '../../shared/accountProviderUsage';
import { getProviderDef } from '../../shared/providers';
import { PROVIDER_BALANCE_CAPABILITIES, type ProviderBalanceReport } from '../../shared/providerBalances';
import { fetchAccountProviderUsage, checkPersonalProviderBalance } from '../../services/accountProviderUsage';
import { seedKeyBalance } from '../../services/keyBalance';
import { ALL_PROVIDERS, PROVIDER_META, type ApiKeyProvider } from '../../services/apiKeys';
import { Button } from '../ds';
import { FOCUS_RING, INK, MUTED, RADIUS_CONTROL, SECTION_CARD } from '../chat/studioDesign';

import { ProviderReading, money, number, timestamp } from './ProviderReading';

function providerLabel(provider: string) {
  if ((ALL_PROVIDERS as readonly string[]).includes(provider)) return PROVIDER_META[provider as ApiKeyProvider].label;
  return provider === 'other' ? 'Other providers' : provider.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
}

export function useProviderActivity(ownerId: string | undefined, accountKeySet: string) {
  const [snapshot, setSnapshot] = useState<{ ownerId: string; keySet: string; report: AccountProviderUsageReport } | null>(null);
  const current = snapshot?.ownerId === ownerId ? snapshot : null;
  const report = !current ? null : current.keySet === accountKeySet ? current.report : { ...current.report, balanceReports: [] };
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!ownerId) return;
    const controller = new AbortController();
    setStatus('loading');
    let followup: ReturnType<typeof setTimeout> | undefined;
    const load = async (firstRead: boolean) => {
      try {
        const next = await fetchAccountProviderUsage(ownerId, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot({ ownerId, keySet: accountKeySet, report: next });
        setStatus('ready');
        if (firstRead && next.balancesRefreshing) followup = setTimeout(() => { void load(false); }, 12_000);
      } catch {
        if (!controller.signal.aborted) setStatus('unavailable');
      }
    };
    void load(true);
    return () => { controller.abort(); clearTimeout(followup); };
  }, [ownerId, accountKeySet, generation]);
  return { report, status, refresh: () => setGeneration(value => value + 1) };
}

type ActivityState = ReturnType<typeof useProviderActivity>;

export function ProviderActivityPanel({ report, status, refresh }: ActivityState) {
  const models = report?.sources.models === 'available';
  const connectors = report?.sources.connectors === 'available';
  const rows = report?.providers ?? [];
  const [expanded, setExpanded] = useState(false);
  const month = report ? new Date(report.from).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }) : '';
  return (
    <section aria-label="Your provider activity" className={`${SECTION_CARD} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className={`flex items-center gap-2 text-sm font-semibold ${INK}`}><Activity aria-hidden className="size-4" />Your provider activity</h4>
        <Button type="button" size="sm" variant="ghost" loading={status === 'loading'} onClick={refresh} aria-label="Refresh recorded activity">
          <RefreshCw aria-hidden className="size-3.5" />Refresh
        </Button>
      </div>
      <p className={`mt-1 text-xs ${MUTED}`}>Model requests and connector activity DreamStream recorded for your account.</p>
      {report && <p className={`mt-3 text-xs font-semibold ${INK}`}>{month} (UTC) <span className={`font-normal ${MUTED}`}>· Updated {timestamp(report.generatedAt)}</span></p>}
      {status === 'unavailable' && <p className={`mt-2 text-xs ${MUTED}`}>{report ? 'Refresh unavailable. Showing your last activity report.' : 'Your activity is temporarily unavailable. Refresh to try again.'}</p>}
      {status === 'loading' && !report && <p className={`mt-2 text-xs ${MUTED}`}>Loading recorded activity…</p>}
      {report && (!models || !connectors) && (
        <p className={`mt-2 text-xs ${MUTED}`}>{[!models && 'Model activity', !connectors && 'Connector activity'].filter(Boolean).join(' and ')} unavailable for this report.</p>
      )}
      {report?.sources.balances === 'unavailable' && <p className={`mt-2 text-xs ${MUTED}`}>Saved provider readings are temporarily unavailable.</p>}
      {report && rows.length === 0 && models && connectors && <p className={`mt-2 text-xs ${MUTED}`}>No activity recorded this month.</p>}
      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-[var(--ds-hairline)]">
          {(expanded ? rows : rows.slice(0, 4)).map(row => (
            <li key={row.provider} className="py-2.5 text-xs">
              <p className={`font-semibold ${INK}`}>{providerLabel(row.provider)}</p>
              {models && row.modelRequests > 0 && (
                <p className={`mt-0.5 tabular-nums ${MUTED}`}>{number.format(row.modelRequests)} model requests · {number.format(row.byokRequests)} on your keys · {number.format(row.platformRequests)} on DreamStream
                  {row.reportedByokUsd != null && ` · Provider-reported cost on your keys ${money(row.reportedByokUsd, 'USD')}`}
                  {row.estimatedByokUsd != null && ` · Estimated cost on your keys ${money(row.estimatedByokUsd, 'USD')}`}
                  {row.unpricedByokRequests > 0 && ` · Cost unavailable for ${number.format(row.unpricedByokRequests)} personal request${row.unpricedByokRequests === 1 ? '' : 's'}`}
                </p>
              )}
              {connectors && (row.connectorCalls + row.connectorErrors + row.connectorBlocked > 0) && (
                <p className={`mt-0.5 tabular-nums ${MUTED}`}>{number.format(row.connectorCalls)} connector calls sent ({number.format(row.connectorErrors)} failed) · {number.format(row.connectorBlocked)} blocked before sending</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 4 && <Button type="button" size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Show fewer providers' : `Show all ${rows.length} providers`}
      </Button>}
    </section>
  );
}

interface PersonalBalanceProps {
  ownerId: string;
  provider: ApiKeyProvider;
  hasKey: boolean;
  enabled: boolean;
  scope: object;
  saved?: ProviderBalanceReport;
  onSaved: () => void;
}

export function PersonalProviderBalance({ ownerId, provider, hasKey, enabled, scope, saved, onSaved }: PersonalBalanceProps) {
  const [result, setResult] = useState<{ scope: object; reading?: ProviderBalanceReport; notice?: string; busy?: boolean }>();
  const view = result?.scope === scope ? result : undefined;
  const reading = view?.reading;
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [scope]);
  const capability = PROVIDER_BALANCE_CAPABILITIES[provider];
  const dashboardOnly = capability === 'dashboard';
  const current = reading && (!saved || reading.checkedAt >= saved.checkedAt) ? reading : saved;
  const check = async () => {
    if (request.current || !hasKey || !enabled || dashboardOnly) return;
    const controller = new AbortController();
    request.current = controller;
    setResult({ scope, reading, busy: true });
    const setNotice = (notice: string) => setResult({ scope, reading, notice });
    try {
      const { report, saved: persisted } = await checkPersonalProviderBalance(ownerId, provider, controller.signal);
      if (controller.signal.aborted) return;
      if (report.status === 'reported') {
        // The studio header and the balance panel show the same reading.
        seedKeyBalance(report);
        setResult({ scope, reading: report, notice: persisted ? undefined : 'The provider responded. This reading could not be saved to your account.' });
        if (persisted) onSaved();
      } else {
        setNotice(report.status === 'missing' ? 'No active personal key was available. Check your key below.'
          : report.status === 'unsupported' ? 'This key does not expose a reading. Check your plan in the provider dashboard.'
          : 'Couldn’t refresh the provider reading. You can retry or check your provider dashboard.');
      }
    } catch {
      if (!controller.signal.aborted) setNotice('Couldn’t refresh the provider reading. You can retry or check your provider dashboard.');
    } finally {
      if (request.current === controller) request.current = null;
    }
  };
  return (
    <section aria-label="Provider balance and limits" className={`space-y-2 bg-[var(--ds-well)] p-3 ${RADIUS_CONTROL}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className={`text-xs font-semibold ${INK}`}>Provider balance and limits</h5>
        {!dashboardOnly && hasKey && enabled && (
          <Button type="button" size="sm" variant="outline" loading={view?.busy} onClick={() => void check()}><RefreshCw aria-hidden className="size-3.5" />Check provider</Button>
        )}
      </div>
      <p className={`text-xs ${MUTED}`}>{dashboardOnly
        ? 'This provider shares billing and limits through its dashboard.'
        : !hasKey ? 'Add a personal API key below to check the limits your provider reports.'
        : !enabled ? 'Enable this provider to request a fresh reading.'
        : capability === 'plan_quota' ? 'A check saves the available plan limits for your personal key. Some plans share limits only in the provider dashboard.'
        : 'A check saves the account balance or key limit your provider shares. Each reading reflects the personal key used for that check.'}</p>
      {current?.status === 'reported' && hasKey && <div className="space-y-1">
        {current === saved && <p className={`text-xs ${MUTED}`}>Last saved reading for your account key</p>}
        <ProviderReading report={current} />
      </div>}
      {view?.notice && <p role="status" className={`text-xs ${MUTED}`}>{view.notice}</p>}
      {dashboardOnly && <a href={getProviderDef(provider)?.fundsUrl ?? PROVIDER_META[provider].keysUrl} target="_blank" rel="noreferrer" className={`inline-block text-xs font-semibold underline underline-offset-2 ${INK} ${FOCUS_RING}`}>Open provider dashboard</a>}
    </section>
  );
}
