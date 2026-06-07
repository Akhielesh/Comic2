// LogsConsole (Sprint 1, S1.5): the console/logs panel — severity-coloured, monospace,
// auto-scrolling, with a clear button + autoscroll toggle. Reads the studio logs store.

import React, { useEffect, useRef, useState } from 'react';
import { Terminal, Trash2, ArrowDownToLine, Copy, Check, ChevronDown } from 'lucide-react';
import { useStudioLogs, type LogLevel } from './logsStore';
import { useStudioTheme } from '../kit';

export interface LogsConsoleProps {
  /** When provided, a collapse button appears in the header (used by the right-side preview dock). */
  onCollapse?: () => void;
}

const LEVEL_TEXT: Record<LogLevel, string> = {
  system: 'text-slate-400',
  info: 'text-sky-400',
  warn: 'text-amber-500',
  error: 'text-rose-500',
  success: 'text-emerald-500',
};

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const LogsConsole: React.FC<LogsConsoleProps> = ({ onCollapse }) => {
  const t = useStudioTheme();
  const entries = useStudioLogs((s) => s.entries);
  const clear = useStudioLogs((s) => s.clear);
  const [autoscroll, setAutoscroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Copy the FULL console (all entries, timestamped) so it can be pasted/analyzed elsewhere.
  const copyAll = () => {
    const text = entries.map((e) => `${fmtTime(e.ts)} [${e.level}] ${e.text}`).join('\n');
    try {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable */ }
  };

  useEffect(() => {
    if (!autoscroll) return;
    try { bottomRef.current?.scrollIntoView({ block: 'end' }); } catch { /* jsdom: no scrollIntoView */ }
  }, [entries, autoscroll]);

  return (
    <section className={`flex h-full min-h-0 w-full flex-col ${t.editorBg}`}>
      <header className={`flex items-center gap-2 px-3 py-1.5 border-b ${t.edge} ${t.panelAlt}`}>
        <Terminal className={`w-3.5 h-3.5 ${t.accent}`} />
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${t.textDim}`}>Console · Logs</span>
        <span className={`text-[10px] ${t.textFaint}`}>{entries.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setAutoscroll((v) => !v)}
            title={autoscroll ? 'Auto-scroll on' : 'Auto-scroll off'}
            aria-pressed={autoscroll}
            className={`rounded p-1 ${t.hover} ${autoscroll ? t.accent : t.textFaint}`}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={copyAll}
            disabled={!entries.length}
            title="Copy all logs"
            className={`rounded p-1 ${t.hover} ${copied ? t.accent : t.textFaint} disabled:opacity-40`}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={clear}
            title="Clear console"
            className={`rounded p-1 ${t.hover} ${t.textFaint}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              title="Collapse console"
              aria-label="Collapse console"
              className={`rounded p-1 ${t.hover} ${t.textFaint}`}
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {entries.length === 0 ? (
          <p className={`${t.textFaint}`}>No output yet. Run the app to see install, dev-server and runtime logs.</p>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className={`${t.textFaint} shrink-0 tabular-nums`}>{fmtTime(e.ts)}</span>
              <span className={`${LEVEL_TEXT[e.level]} break-words`}>{e.text}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </section>
  );
};
