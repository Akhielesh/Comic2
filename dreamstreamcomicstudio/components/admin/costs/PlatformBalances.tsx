import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getPlatformBalances, refreshPlatformBalance, type PlatformBalanceHistory } from '../../../services/adminProviderBalances';
import { PROVIDER_BALANCE_CAPABILITIES, type BalanceProvider, type ProviderBalanceReport } from '../../../shared/providerBalances';
import { providerShortLabel } from '../../../shared/providers';
import { DENSITY, FOCUS_RING } from '../../chat/studioDesign';
import { ProviderReading } from '../../usage/ProviderReading';

const SOURCES = (Object.keys(PROVIDER_BALANCE_CAPABILITIES) as BalanceProvider[])
  .filter(provider => PROVIDER_BALANCE_CAPABILITIES[provider] !== 'dashboard');
const control = `rounded-lg border border-[var(--ds-hairline)] px-3 py-1.5 text-sm font-medium ${DENSITY.coarse} ${FOCUS_RING}`;
interface Check { report?: ProviderBalanceReport; notice?: string; }

function Readings({ ownerId }: { ownerId: string }) {
  const [provider, setProvider] = useState<BalanceProvider>('openrouter');
  const [history, setHistory] = useState<PlatformBalanceHistory | null>(null);
  const [checks, setChecks] = useState<Partial<Record<BalanceProvider, Check>>>({});
  const [pending, setPending] = useState<BalanceProvider | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (followUp: boolean) => {
      try {
        const response = await getPlatformBalances(ownerId, controller.signal);
        if (controller.signal.aborted) return;
        setHistory({ ...response, balancesRefreshing: response.balancesRefreshing && !followUp });
        if (response.balancesRefreshing && !followUp) timer = setTimeout(() => void load(true), 12_000);
      } catch {
        if (!controller.signal.aborted) setHistory(prev => ({ available: false, balanceReports: prev?.balanceReports ?? [] }));
      }
    };
    void load(false);
    return () => { controller.abort(); clearTimeout(timer); request.current?.abort(); };
  }, [ownerId]);

  const check = checks[provider];
  const saved = history?.balanceReports.find(item => item.provider === provider);
  const current = check?.report?.status === 'missing' ? undefined
    : check?.report?.status === 'reported' && (!saved || check.report.checkedAt >= saved.checkedAt) ? check.report : saved;

  const refresh = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(provider);
    try {
      const { report, saved: persisted } = await refreshPlatformBalance(ownerId, provider, controller.signal);
      if (controller.signal.aborted) return;
      const notice = report.status === 'missing' ? 'No platform credential configured for this provider.'
        : report.status === 'unsupported' ? 'This provider offers no platform balance reading here.'
        : report.status === 'unavailable' ? 'This provider did not return a current reading.'
        : persisted ? undefined : 'This reading could not be saved to history.';
      setChecks(prev => ({ ...prev, [provider]: {
        report: report.status === 'unavailable' ? prev[provider]?.report : report,
        notice
      } }));
    } catch {
      if (!controller.signal.aborted) setChecks(prev => ({ ...prev, [provider]: { ...prev[provider], notice: 'Could not refresh this platform reading.' } }));
    } finally {
      if (!controller.signal.aborted) { request.current = null; setPending(null); }
    }
  };

  return (
    <div className="space-y-3 border-t border-[var(--ds-hairline)] p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs font-medium">Platform provider
          <select className={control} value={provider} onChange={e => setProvider(e.target.value as BalanceProvider)}>
            {SOURCES.map(source => <option key={source} value={source}>{providerShortLabel(source)}</option>)}
          </select>
        </label>
        <button className={control} type="button" disabled={pending !== null} onClick={refresh}>
          {pending === provider ? 'Checking provider…' : 'Check provider'}
        </button>
      </div>
      <div aria-live="polite" aria-busy={pending === provider} className="space-y-2 text-xs text-[var(--ds-muted)]">
        {!history && !check && <p>Loading saved readings…</p>}
        {history?.balancesRefreshing && <p>Refreshing saved readings…</p>}
        {history && !history.available && <p>Saved readings could not be loaded.</p>}
        {check?.notice && <p>{check.notice}</p>}
        {current && <ProviderReading report={current} />}
        {!current && history?.available && !check?.notice && <p>No saved platform reading for {providerShortLabel(provider)}.</p>}
      </div>
    </div>
  );
}

export function PlatformBalances() {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
      <h2>
        <button type="button" aria-expanded={expanded} aria-controls="platform-provider-readings"
          className={`flex w-full items-center justify-between gap-3 rounded-2xl p-3 text-left text-sm font-semibold ${DENSITY.coarse} ${FOCUS_RING}`}
          onClick={() => setExpanded(open => !open)}>
          Platform provider balances and quotas
          <ChevronDown aria-hidden className={`h-4 w-4 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </h2>
      <div id="platform-provider-readings" hidden={!expanded}>
        {expanded && user && <Readings key={user.id} ownerId={user.id} />}
      </div>
    </section>
  );
}
