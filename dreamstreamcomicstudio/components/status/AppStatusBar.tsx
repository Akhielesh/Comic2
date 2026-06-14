import React, { useState } from 'react';
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, Loader2, Trash2, X } from 'lucide-react';
import { useAppStatus } from '../../hooks/useAppStatus';
import { appStatus, type StatusLevel } from '../../services/appStatus';

// AppStatusBar — a small, always-available glass pill (bottom-right) that shows what the
// app is doing and what failed, so you don't have to open DevTools. Idle = a quiet check;
// working = a spinner + label; a warning/error = a coloured icon + the latest message and
// an unseen badge. Click to expand a scrollable log of recent activity.

const relTime = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

const LEVEL_DOT: Record<StatusLevel, string> = {
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500'
};

export const AppStatusBar: React.FC = () => {
  const { events, activeCount, activeLabel, worstUnseen, unseen } = useAppStatus();
  const [open, setOpen] = useState(false);

  const busy = activeCount > 0;
  // Stay out of the way until there's actually something to show (no idle pill on the
  // marketing/auth pages). Once any activity or event exists, the pill appears and sticks
  // around — giving a persistent entry point to the log — until it's cleared.
  if (!busy && events.length === 0) return null;

  const collapsedText = busy
    ? activeLabel || 'Working…'
    : worstUnseen && events[0]
      ? events[0].message
      : null;

  const StatusIcon = () => {
    if (busy) return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ds-accent)]" />;
    if (worstUnseen === 'error') return <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />;
    if (worstUnseen === 'warn') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />;
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  };

  const toggle = () =>
    setOpen((o) => {
      if (!o) appStatus.markSeen();
      return !o;
    });

  return (
    <div className="fixed bottom-3 right-3 z-[80] flex flex-col items-end gap-2 print:hidden">
      {open && (
        <div className="w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-xl backdrop-blur-xl">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--ds-hairline-soft)] px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-ink)]">
              <Activity className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden /> Activity
            </div>
            <div className="flex items-center gap-0.5">
              {events.length > 0 && (
                <button
                  type="button"
                  onClick={() => appStatus.clear()}
                  aria-label="Clear log"
                  className="rounded-lg p-1.5 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-lg p-1.5 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-[40vh] overflow-auto">
            {busy && activeLabel && (
              <div className="flex items-center gap-2 border-b border-[var(--ds-hairline-soft)] px-3.5 py-2 text-sm text-[var(--ds-ink)]">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ds-accent)]" />
                <span className="truncate">
                  {activeLabel}
                  {activeCount > 1 ? ` (+${activeCount - 1} more)` : ''}
                </span>
              </div>
            )}
            {events.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-[var(--ds-muted)]">
                {busy ? 'Working…' : 'No recent activity.'}
              </div>
            ) : (
              <ul className="divide-y divide-[var(--ds-hairline-soft)]">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${LEVEL_DOT[ev.level]}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm leading-snug text-[var(--ds-ink)]">
                        {ev.message}
                        {ev.count > 1 && <span className="ml-1 text-xs text-[var(--ds-muted)]">×{ev.count}</span>}
                      </p>
                      {ev.detail && <p className="mt-0.5 line-clamp-2 break-all text-xs text-[var(--ds-muted)]">{ev.detail}</p>}
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">{relTime(ev.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={toggle}
        aria-label={`App status${unseen > 0 ? `, ${unseen} new` : ''}`}
        className="flex items-center gap-2 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-1.5 shadow-lg backdrop-blur-xl transition-colors hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
      >
        <StatusIcon />
        {collapsedText && (
          <span className="max-w-[13rem] truncate text-xs font-medium text-[var(--ds-ink)]">{collapsedText}</span>
        )}
        {unseen > 0 && !open && (
          <span className="ml-0.5 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-4 text-white">
            {unseen > 9 ? '9+' : unseen}
          </span>
        )}
      </button>
    </div>
  );
};
