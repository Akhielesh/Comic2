// ActivityFeed (Sprint 1): the live, synchronous record of what the AI is doing while it
// generates/refines an app. Phases stream in as muted steps; each file appears as a row that
// spins while writing and checks off (with its size) when done. On success it auto-collapses to
// a one-line summary ("✓ 6 files · view") the user can re-open — so a long build doesn't bury the
// composer. Driven by activityStore via the SSE generate stream.

import React from 'react';
import { Loader2, Check, FileCode2, ChevronRight, AlertTriangle, Sparkles } from 'lucide-react';
import { Reveal, useStudioTheme } from '../kit';
import { useStudioActivity, fileCount } from './activityStore';

/** Human file size for the per-file badge. */
const formatBytes = (n?: number): string => {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export const ActivityFeed: React.FC = () => {
  const t = useStudioTheme();
  const { status, collapsed, items, summary, setCollapsed } = useStudioActivity();

  if (status === 'idle' && items.length === 0) return null;

  const running = status === 'running';
  const files = fileCount(items);
  const headLabel =
    running ? `Building${files ? ` · ${files} file${files === 1 ? '' : 's'}` : '…'}`
    : summary || (status === 'error' ? 'Generation failed' : 'Done');

  const HeadIcon = running ? Loader2 : status === 'error' ? AlertTriangle : Sparkles;
  const headTone = running ? t.accent : status === 'error' ? 'text-rose-400' : 'text-emerald-400';

  return (
    <div className={`rounded-lg border ${t.edge} ${t.panel} overflow-hidden`} aria-label="AI activity">
      {/* Header — always visible; click to collapse/expand the detail. */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className={`flex w-full items-center gap-2 px-2.5 py-2 text-left ${t.hover} ${t.focusRing}`}
        aria-expanded={!collapsed}
      >
        <HeadIcon className={`h-3.5 w-3.5 shrink-0 ${headTone} ${running ? 'animate-spin' : ''}`} />
        <span className={`min-w-0 flex-1 truncate text-xs font-semibold ${t.text}`}>{headLabel}</span>
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 ${t.textFaint} transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
      </button>

      {/* Detail — the streamed phases + files. */}
      {!collapsed && (
        <div className={`max-h-56 overflow-auto border-t ${t.edge} px-2.5 py-2 space-y-1`}>
          {items.map((it) =>
            it.kind === 'phase' ? (
              <div key={it.id} className={`flex items-center gap-2 text-[11px] ${t.textDim}`}>
                <span className={`h-1 w-1 shrink-0 rounded-full ${t.accentBg}`} />
                <span className="min-w-0 truncate">{it.label}</span>
              </div>
            ) : (
              <Reveal key={it.id} distance={4}>
                <div className="flex items-center gap-2">
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
                  {it.state === 'written' && it.bytes ? (
                    <span className={`shrink-0 text-[10px] tabular-nums ${t.textFaint}`}>{formatBytes(it.bytes)}</span>
                  ) : null}
                </div>
              </Reveal>
            )
          )}
        </div>
      )}
    </div>
  );
};
