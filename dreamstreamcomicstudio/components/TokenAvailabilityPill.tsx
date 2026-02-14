import React, { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import type { BillingSummaryResponse } from '../shared/types/billing';
import { useAuth } from '../contexts/AuthContext';
import { BILLING_SUMMARY_REFRESH_EVENT, getBillingSummary } from '../services/billing';

interface TokenAvailabilityPillProps {
  className?: string;
}

const formatCt = (value: number) => Math.max(0, Math.floor(value)).toLocaleString();

export const TokenAvailabilityPill: React.FC<TokenAvailabilityPillProps> = ({ className = '' }) => {
  const { user } = useAuth();
  const [summary, setSummary] = useState<BillingSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const hasLoaded = useRef(false);

  useEffect(() => {
    if (!user) {
      setSummary(null);
      hasLoaded.current = false;
      return;
    }

    let alive = true;
    hasLoaded.current = false;

    const loadSummary = async () => {
      if (!alive || inFlight.current) return;
      inFlight.current = true;
      setLoading((prev) => prev || !hasLoaded.current);
      try {
        const next = await getBillingSummary();
        if (!alive) return;
        setSummary(next);
      } catch {
        // Keep the previous value to avoid noisy UI flicker.
      } finally {
        hasLoaded.current = true;
        inFlight.current = false;
        if (alive) {
          setLoading(false);
        }
      }
    };

    void loadSummary();
    const poll = window.setInterval(() => {
      void loadSummary();
    }, 10_000);

    const onRefresh = () => {
      void loadSummary();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadSummary();
      }
    };

    window.addEventListener(BILLING_SUMMARY_REFRESH_EVENT, onRefresh);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      window.clearInterval(poll);
      window.removeEventListener(BILLING_SUMMARY_REFRESH_EVENT, onRefresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user]);

  if (!user) return null;

  const availableCt = summary?.wallet.availableCt ?? 0;
  const includedCt = summary?.wallet.includedMonthlyCt ?? 0;
  const dailyLimitEnabled = summary?.effectivePlan.dailyLimitEnabled === true;
  const dailyRemaining = summary?.usage.dailyRemainingCt ?? 0;

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border-2 border-black bg-white px-3 py-1 text-[11px] font-bold text-slate-900 shadow-sm ${className}`}>
      <Zap size={13} className="text-brand-yellow fill-brand-yellow" />
      <span>{loading && !summary ? 'Loading CT...' : `${formatCt(availableCt)} CT`}</span>
      {!!summary && (
        <span className="hidden md:inline text-slate-500">
          / {formatCt(includedCt)} monthly{dailyLimitEnabled ? ` · ${formatCt(dailyRemaining)} today` : ''}
        </span>
      )}
    </div>
  );
};
