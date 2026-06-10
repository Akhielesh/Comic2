import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw } from 'lucide-react';
import type { ChatArtifact, LiveMonitorArtifact } from '../../../apiTypes';
import { LiveDataContext, relativeTime, useCompact } from './kit';

// Live monitor — the /loop skill's widget. Wraps ONE refresh-whitelisted tool call
// (stock, weather, news, crypto, sentiment…) and re-runs it on an interval while
// the card is on screen, so the embedded widget stays fresh with no model round-trip.
//
//  • The embedded card renders through the shared registry (injected as a prop by
//    ChatArtifacts to avoid an import cycle) and INHERITS this card's density —
//    a compact monitor shows the wrapped card's glance layout automatically.
//  • The monitor provides its own LiveDataContext, so the wrapped card's controls
//    (news topic chips, etc.) refresh through the loop; arg patches stick for
//    subsequent ticks.
//  • Ticks are skipped while the tab is hidden or a refresh is already in flight;
//    the pause button stops the loop without losing the last snapshot.

interface LiveMonitorCardProps {
  data: LiveMonitorArtifact;
  /** Renders the wrapped artifact via the shared renderer registry. */
  renderEmbedded: (artifact: ChatArtifact) => React.ReactNode;
}

const cadenceLabel = (sec: number): string => (sec % 60 === 0 ? `${sec / 60} min` : `${sec}s`);

const remainingLabel = (ms: number): string => {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

export const LiveMonitorCard: React.FC<LiveMonitorCardProps> = ({ data, renderEmbedded }) => {
  const compact = useCompact();
  const intervalMs = Math.max(30, Math.min(3600, data.intervalSec || 300)) * 1000;
  const [artifact, setArtifact] = useState<ChatArtifact | undefined>(data.artifact);
  const [asOf, setAsOf] = useState<string | undefined>(data.asOf);
  const [refreshing, setRefreshing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Arg patches from the embedded card (e.g. a news topic chip) persist across ticks.
  const argsRef = useRef<Record<string, unknown>>(data.args ?? {});
  const nextAtRef = useRef<number>(Date.now() + intervalMs);
  const refreshingRef = useRef(false);

  const refresh = useCallback(
    async (argsPatch?: Record<string, unknown>) => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshing(true);
      try {
        if (argsPatch) argsRef.current = { ...argsRef.current, ...argsPatch };
        const { refreshArtifact } = await import('../../../services/chatApi');
        const result = await refreshArtifact(data.tool, argsRef.current);
        const next = (artifact && result.artifacts.find((a) => a.type === artifact.type)) ?? result.artifacts[0];
        if (next) {
          setArtifact(next);
          setAsOf(result.asOf);
        }
      } catch {
        /* keep showing the last good snapshot */
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
        nextAtRef.current = Date.now() + intervalMs;
      }
    },
    [data.tool, intervalMs, artifact]
  );

  // One 1s heartbeat drives both the countdown readout and the due-time firing.
  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (paused || refreshingRef.current) return;
      if (t >= nextAtRef.current) {
        // Don't burn upstream rate limits for a tab nobody is looking at.
        if (typeof document !== 'undefined' && document.hidden) return;
        void refresh();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [paused, refresh]);

  const togglePause = () => {
    setPaused((p) => {
      if (p) nextAtRef.current = Date.now() + intervalMs; // resume restarts the clock
      return !p;
    });
  };

  const label = data.label || `${data.tool} monitor`;
  const live = !paused;

  return (
    <div>
      {/* Monitor strip — quiet chrome above the embedded widget. */}
      <div className="mt-2 -mb-1 flex items-center justify-between gap-2 px-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-[var(--ds-muted)]">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-[#059669] motion-safe:animate-pulse' : 'bg-[var(--ds-hairline)]'}`}
          />
          <span className="truncate text-[var(--ds-ink)]">{label}</span>
          <span className="shrink-0 rounded-full bg-[var(--ds-well-strong)] px-1.5 py-px text-[10px]">
            every {cadenceLabel(data.intervalSec || 300)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-[var(--ds-muted)]">
          {refreshing ? (
            <RefreshCw className="h-3 w-3 animate-spin" />
          ) : paused ? (
            'paused'
          ) : (
            `next in ${remainingLabel(nextAtRef.current - now)}`
          )}
          {!compact && asOf && <span>· updated {relativeTime(asOf)}</span>}
          <button
            onClick={togglePause}
            title={paused ? 'Resume the loop' : 'Pause the loop'}
            aria-label={paused ? 'Resume monitor' : 'Pause monitor'}
            className="flex h-5 w-5 items-center justify-center rounded-md border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
          >
            {paused ? <Play className="h-2.5 w-2.5" /> : <Pause className="h-2.5 w-2.5" />}
          </button>
        </span>
      </div>

      {/* The wrapped widget, fed by the loop. Inherits this card's density. */}
      <LiveDataContext.Provider value={{ canRefresh: true, refreshing, asOf, refresh }}>
        {artifact ? (
          <div className={`transition-opacity duration-200 ${refreshing ? 'opacity-60' : ''}`}>{renderEmbedded(artifact)}</div>
        ) : (
          <div className="my-2 animate-pulse rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 text-[11px] text-[var(--ds-muted)]">
            Waiting for the first snapshot…
          </div>
        )}
      </LiveDataContext.Provider>
    </div>
  );
};
