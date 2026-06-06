// ActivityFeed (Sprint 1): the live, synchronous record of what the AI is doing while it
// generates/refines an app. Phases stream in as muted steps; each file appears as a row that
// spins while writing and checks off (with its size) when done. On success it auto-collapses to
// a one-line summary ("✓ 6 files · view") the user can re-open — so a long build doesn't bury the
// composer. Driven by activityStore via the SSE generate stream.

import React, { useEffect, useRef } from 'react';
import { Loader2, Check, FileCode2, ChevronRight, AlertTriangle, Sparkles, RotateCcw } from 'lucide-react';
import { Reveal, useStudioTheme } from '../kit';
import { useStudioActivity, fileCount, diffTotals } from './activityStore';

/** Human file size for the per-file badge. */
const formatBytes = (n?: number): string => {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/** Compact elapsed-time marker. */
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

export interface ActivityFeedProps {
  /** When provided, file rows become clickable and open that file in the editor. */
  onOpenFile?: (path: string) => void;
  /** When provided and the run failed, a Retry button re-runs the last generation. */
  onRetry?: () => void;
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({ onOpenFile, onRetry }) => {
  const t = useStudioTheme();
  const { status, collapsed, items, summary, startedAt, endedAt, setCollapsed } = useStudioActivity();
  const detailRef = useRef<HTMLDivElement>(null);
  const running = status === 'running';

  // Keep the newest activity in view while streaming.
  useEffect(() => {
    if (running && detailRef.current) detailRef.current.scrollTop = detailRef.current.scrollHeight;
  }, [items.length, running]);

  if (status === 'idle' && items.length === 0) return null;

  const files = fileCount(items);
  const totals = diffTotals(items);
  const elapsed = startedAt && endedAt ? endedAt - startedAt : null;
  const headLabel =
    running ? `Building${files ? ` · ${files} file${files === 1 ? '' : 's'}` : '…'}`
    : summary || (status === 'error' ? 'Generation failed' : 'Done');

  const HeadIcon = running ? Loader2 : status === 'error' ? AlertTriangle : Sparkles;
  const headTone = running ? t.accent : status === 'error' ? 'text-rose-400' : 'text-emerald-400';

  return (
    <div className={`rounded-lg border ${t.edge} ${t.panel} overflow-hidden`} aria-label="AI activity">
      {/* Header — toggle + (on failure) a Retry. Kept as a div so the buttons don't nest. */}
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className={`flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left ${t.hover} ${t.focusRing}`}
          aria-expanded={!collapsed}
        >
          <HeadIcon className={`h-3.5 w-3.5 shrink-0 ${headTone} ${running ? 'animate-spin' : ''}`} />
          <span className={`min-w-0 flex-1 truncate text-xs font-semibold ${t.text}`}>{headLabel}</span>
          {/* Aggregate diff marker (refines). */}
          {(totals.added || totals.removed) ? (
            <span className="shrink-0 text-[10px] font-semibold tabular-nums">
              {totals.added ? <span className="text-emerald-400">+{totals.added}</span> : null}
              {totals.added && totals.removed ? ' ' : null}
              {totals.removed ? <span className="text-rose-400">−{totals.removed}</span> : null}
            </span>
          ) : null}
          {elapsed != null && <span className={`shrink-0 text-[10px] tabular-nums ${t.textFaint}`}>{formatDuration(elapsed)}</span>}
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 ${t.textFaint} transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
        </button>
        {status === 'error' && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            title="Retry the last generation"
            className={`mr-2 shrink-0 inline-flex items-center gap-1 rounded-full border ${t.edgeStrong} px-2 py-0.5 text-[11px] font-semibold ${t.textDim} ${t.hover} ${t.focusRing}`}
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        )}
      </div>

      {/* Detail — the streamed phases + files. */}
      {!collapsed && (
        <div ref={detailRef} className={`max-h-56 overflow-auto border-t ${t.edge} px-2.5 py-2 space-y-1`}>
          {items.map((it) =>
            it.kind === 'phase' ? (
              <div key={it.id} className={`flex items-center gap-2 text-[11px] ${t.textDim}`}>
                <span className={`h-1 w-1 shrink-0 rounded-full ${t.accentBg}`} />
                <span className="min-w-0 truncate">{it.label}</span>
              </div>
            ) : (
              <Reveal key={it.id} distance={4}>
                {(() => {
                  const rowChildren = (
                    <>
                      <span className="shrink-0">
                        {it.state === 'written' ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Loader2 className={`h-3.5 w-3.5 animate-spin ${t.accent}`} />
                        )}
                      </span>
                      <FileCode2 className={`h-3 w-3 shrink-0 ${t.textFaint}`} />
                      <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${t.textDim}`} title={it.path}>
                        {it.path}
                      </span>
                      {it.change === 'new' && (
                        <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[9px] font-bold uppercase tracking-wide text-emerald-400">new</span>
                      )}
                      {/* Diff stat for an edited file (filled in when the edit resolves). */}
                      {(it.added || it.removed) ? (
                        <span className="shrink-0 text-[10px] font-semibold tabular-nums">
                          {it.added ? <span className="text-emerald-400">+{it.added}</span> : null}
                          {it.added && it.removed ? ' ' : null}
                          {it.removed ? <span className="text-rose-400">−{it.removed}</span> : null}
                        </span>
                      ) : it.state === 'written' && it.bytes ? (
                        <span className={`shrink-0 text-[10px] tabular-nums ${t.textFaint}`}>{formatBytes(it.bytes)}</span>
                      ) : null}
                    </>
                  );
                  // Clickable when written + a handler is provided: jump straight to the file in the editor.
                  return onOpenFile && it.path && it.state === 'written' ? (
                    <button
                      type="button"
                      onClick={() => onOpenFile(it.path!)}
                      title={`Open ${it.path} in the editor`}
                      className={`flex w-full items-center gap-2 rounded px-1 -mx-1 text-left ${t.hover} ${t.focusRing}`}
                    >
                      {rowChildren}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 px-1 -mx-1">{rowChildren}</div>
                  );
                })()}
              </Reveal>
            )
          )}
        </div>
      )}
    </div>
  );
};
