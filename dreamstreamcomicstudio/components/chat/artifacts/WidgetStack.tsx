import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ChatArtifact, WidgetStackArtifact } from '../../../apiTypes';
import { LiveDataContext, relativeTime, useCompact } from './kit';

// Smart stack — an Apple-watch-style rotating stack of live widgets. The server
// snapshots 2–4 refreshable tool calls; this card cycles between them.
//
//  • Auto-rotates every `intervalSec` (default 8s); pauses while hovered or when
//    the tab is hidden; under prefers-reduced-motion it never auto-rotates —
//    the dots/arrows still work manually.
//  • Each embedded card gets its own LiveDataContext wired to its origin, so the
//    visible card can refresh through /api/chat/tool-refresh without touching
//    its siblings; refreshed snapshots replace the stack entry in place.
//  • Embedded cards render through the shared registry (injected as a prop by
//    ChatArtifacts to avoid an import cycle) and inherit this card's density.

interface WidgetStackProps {
  data: WidgetStackArtifact;
  /** Renders an embedded artifact via the shared renderer registry. */
  renderEmbedded: (artifact: ChatArtifact) => React.ReactNode;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/** One stack entry: provides its own live-refresh context around the embedded card. */
const StackItem: React.FC<{
  artifact: ChatArtifact;
  onReplace: (next: ChatArtifact, asOf?: string) => void;
  renderEmbedded: (artifact: ChatArtifact) => React.ReactNode;
}> = ({ artifact, onReplace, renderEmbedded }) => {
  const [refreshing, setRefreshing] = useState(false);
  const [asOf, setAsOf] = useState<string | undefined>(undefined);
  const origin = artifact.origin;

  const refresh = useCallback(
    async (argsPatch?: Record<string, unknown>) => {
      if (!origin) return;
      setRefreshing(true);
      try {
        const { refreshArtifact } = await import('../../../services/chatApi');
        const result = await refreshArtifact(origin.tool, { ...origin.args, ...(argsPatch ?? {}) });
        const next = result.artifacts.find((a) => a.type === artifact.type) ?? result.artifacts[0];
        if (next) {
          setAsOf(result.asOf);
          onReplace(next, result.asOf);
        }
      } catch {
        /* keep showing the last good snapshot */
      } finally {
        setRefreshing(false);
      }
    },
    [origin, artifact.type, onReplace]
  );

  return (
    <LiveDataContext.Provider value={{ canRefresh: !!origin, refreshing, asOf, refresh }}>
      <div className={`transition-opacity duration-200 ${refreshing ? 'opacity-60' : ''}`}>{renderEmbedded(artifact)}</div>
    </LiveDataContext.Provider>
  );
};

export const WidgetStack: React.FC<WidgetStackProps> = ({ data, renderEmbedded }) => {
  const compact = useCompact();
  const [items, setItems] = useState<ChatArtifact[]>(data.items ?? []);
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [asOf, setAsOf] = useState<string | undefined>(undefined);
  const reduced = useRef(prefersReducedMotion());
  const intervalSec = Math.max(4, Math.min(60, data.intervalSec || 8));

  // Auto-rotation heartbeat — skipped while hovered, hidden, or reduced-motion.
  useEffect(() => {
    if (reduced.current || items.length < 2) return;
    const timer = setInterval(() => {
      if (hovered || (typeof document !== 'undefined' && document.hidden)) return;
      setActive((i) => (i + 1) % items.length);
    }, intervalSec * 1000);
    return () => clearInterval(timer);
  }, [hovered, items.length, intervalSec]);

  if (!items.length) return null;
  const safeActive = Math.min(active, items.length - 1);
  const current = items[safeActive];

  const replaceAt = (index: number) => (next: ChatArtifact, stamp?: string) => {
    setItems((prev) => prev.map((a, i) => (i === index ? { ...next, origin: a.origin ?? next.origin } : a)));
    if (stamp) setAsOf(stamp);
  };

  const step = (dir: -1 | 1) => setActive((i) => (i + dir + items.length) % items.length);

  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {/* Stack strip: label, dots, arrows. Quiet chrome above the rotating card. */}
      <div className="mt-2 -mb-1 flex items-center justify-between gap-2 px-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-[var(--ds-muted)]">
          <span className="truncate text-[var(--ds-ink)]">{data.label ?? 'Smart stack'}</span>
          <span className="shrink-0 rounded-full bg-[var(--ds-well-strong)] px-1.5 py-px text-[10px] tabular-nums">
            {safeActive + 1}/{items.length}
          </span>
          {!compact && asOf && <span className="shrink-0 text-[10px]">· updated {relativeTime(asOf)}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {items.map((_, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              aria-label={`Show card ${i + 1}`}
              aria-current={i === safeActive}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                i === safeActive ? 'w-4 bg-[var(--ds-accent)]' : 'w-1.5 bg-[var(--ds-hairline)] hover:bg-[var(--ds-muted)]'
              }`}
            />
          ))}
          <span className="ml-1 flex items-center gap-0.5">
            <button
              onClick={() => step(-1)}
              aria-label="Previous card"
              className="flex h-5 w-5 items-center justify-center rounded-md border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              onClick={() => step(1)}
              aria-label="Next card"
              className="flex h-5 w-5 items-center justify-center rounded-md border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </span>
        </span>
      </div>

      {/* The active card, crossfaded on rotation. Inherits this widget's density. */}
      <div key={safeActive} className="animate-fade-in">
        <StackItem artifact={current} onReplace={replaceAt(safeActive)} renderEmbedded={renderEmbedded} />
      </div>
    </div>
  );
};
