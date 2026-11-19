import React, { useState } from 'react';
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, Loader2, Trash2, X } from 'lucide-react';
import { useAppStatus } from '../../hooks/useAppStatus';
import { appStatus, type StatusLevel } from '../../services/appStatus';
import { cn } from '../../lib/utils';
import { IconButton } from '../ds';
import { DENSITY, FOCUS_RING, OVERLAY, RADIUS_ROUND, STATUS_DOT, STATUS_INK, WRAP_TEXT, Z } from '../chat/studioDesign';

// AppStatusBar — a small, always-available pill (bottom-right) that shows what the
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

// The one status vocabulary: info is plain activity (ink), success healthy, warn attention, error error.
const LEVEL_DOT: Record<StatusLevel, string> = {
  info: STATUS_DOT.active,
  success: STATUS_DOT.healthy,
  warn: STATUS_DOT.attention,
  error: STATUS_DOT.error
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
    if (busy) return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ds-ink)] motion-reduce:animate-none" />;
    if (worstUnseen === 'error') return <AlertCircle className={cn('h-4 w-4 shrink-0', STATUS_INK.error)} />;
    if (worstUnseen === 'warn') return <AlertTriangle className={cn('h-4 w-4 shrink-0', STATUS_INK.attention)} />;
    return <CheckCircle2 className={cn('h-4 w-4 shrink-0', STATUS_INK.healthy)} />;
  };

  const toggle = () =>
    setOpen((o) => {
      if (!o) appStatus.markSeen();
      return !o;
    });

  return (
    // The 80 step it always sat on (Z.reader): above the page and its chrome, below sheets, dialogs and toasts.
    <div className={cn('fixed bottom-3 right-3 flex flex-col items-end gap-2 print:hidden', Z.reader)}>
      {open && (
        <div className={cn(OVERLAY, 'w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-hidden')}>
          <div className="flex items-center justify-between gap-2 border-b border-[var(--ds-hairline-soft)] px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-ink)]">
              <Activity className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden /> Activity
            </div>
            <div className="flex items-center gap-0.5">
              {events.length > 0 && (
                <IconButton label="Clear log" title={null} size="sm" onClick={() => appStatus.clear()} className="text-[var(--ds-muted)]">
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              )}
              <IconButton label="Close" title={null} size="sm" onClick={() => setOpen(false)} className="text-[var(--ds-muted)]">
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>

          <div className="max-h-[40vh] overflow-auto">
            {busy && activeLabel && (
              <div className="flex items-center gap-2 border-b border-[var(--ds-hairline-soft)] px-3.5 py-2 text-sm text-[var(--ds-ink)]">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ds-ink)] motion-reduce:animate-none" />
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
                      <p className={cn('text-sm leading-snug text-[var(--ds-ink)]', WRAP_TEXT)}>
                        {ev.message}
                        {ev.count > 1 && <span className="ml-1 text-xs text-[var(--ds-muted)]">×{ev.count}</span>}
                      </p>
                      {ev.detail && <p className="mt-0.5 line-clamp-2 text-xs [overflow-wrap:anywhere] text-[var(--ds-muted)]">{ev.detail}</p>}
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
        className={cn(
          'flex min-h-9 items-center gap-2 border border-[var(--ds-overlay-edge)] bg-[var(--ds-raised)] px-3 py-1.5 shadow-[shadow:var(--ds-shadow-overlay)] transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] hover:bg-[var(--ds-hover)]',
          RADIUS_ROUND,
          DENSITY.coarse,
          FOCUS_RING
        )}
      >
        <StatusIcon />
        {collapsedText && (
          <span className="max-w-[13rem] truncate text-xs font-medium text-[var(--ds-ink)]">{collapsedText}</span>
        )}
        {unseen > 0 && !open && (
          <span className="ml-0.5 rounded-full bg-[var(--ds-danger)] px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-[var(--ds-on-danger)]">
            {unseen > 9 ? '9+' : unseen}
          </span>
        )}
      </button>
    </div>
  );
};
