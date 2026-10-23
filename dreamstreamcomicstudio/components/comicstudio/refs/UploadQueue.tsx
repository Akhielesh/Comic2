// Upload queue rows (refs.md §7.5). Owner: P1-REFS.
//
//   uploading       progress bar + % + Cancel
//   checking        "Checking…" (server encode + content check, ~1–3 s)
//   done            collapses into the grid
//   duplicate       "Already added" (dismissed after 1.5 s)
//   near_duplicate  "Looks the same as photo 3" · [Keep both] [Remove this]
//   over_cap        "MAYA can hold 12 photos — remove one to add more."
//   rejected        red row, no thumbnail, no retry · "What's allowed?"
//   failed          "Couldn't upload — check your connection" · [Retry]
// Every control is ≥ 44 px on touch; rows never overflow (names truncate).

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2, RotateCw, ShieldAlert, X } from 'lucide-react';
import { cx } from '../conversation/ui';
import type { UploadItem } from './useRefUpload';
import { isActiveUpload } from './useRefUpload';

export interface UploadQueueProps {
  items: readonly UploadItem[];
  onCancel(id: string): void;
  onRetry(id: string): void;
  onDismiss(id: string): void;
  /** near_duplicate: remove the photo that was just added. */
  onRemoveNew?(item: UploadItem): void;
  className?: string;
}

// Rows wrap: on a 320 px phone the actions drop under the text (basis-32) instead of squeezing it.
const ROW = 'flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2';
const BTN =
  'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1 rounded-full px-3 text-[12px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';
const QUIET = `${BTN} text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`;

/** Short-lived rows dismiss themselves once each (UI only; nothing here talks to the server). */
const useAutoDismiss = (items: readonly UploadItem[], onDismiss: (id: string) => void) => {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    for (const i of items) {
      if ((i.state !== 'duplicate' && i.state !== 'done') || timers.current.has(i.id)) continue;
      timers.current.set(
        i.id,
        setTimeout(() => {
          timers.current.delete(i.id);
          dismiss.current(i.id);
        }, i.state === 'duplicate' ? 1500 : 600)
      );
    }
  }, [items]);
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);
};

const Thumb: React.FC<{ item: UploadItem }> = ({ item }) =>
  item.previewUrl && item.state !== 'rejected' ? (
    <img src={item.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" draggable={false} />
  ) : (
    <span aria-hidden className="h-9 w-9 shrink-0 rounded-lg bg-[var(--ds-well)]" />
  );

export const UploadQueue: React.FC<UploadQueueProps> = ({ items, onCancel, onRetry, onDismiss, onRemoveNew, className }) => {
  useAutoDismiss(items, onDismiss);
  const [policyOpen, setPolicyOpen] = useState(false);
  const visible = items.filter((i) => i.state !== 'done');
  if (!visible.length) return null;
  const active = items.filter((i) => isActiveUpload(i.state));
  const total = items.filter((i) => i.state !== 'over_cap' && i.state !== 'rejected' && i.state !== 'duplicate').length;
  const doneCount = items.filter((i) => i.state === 'done' || i.state === 'near_duplicate').length;

  return (
    <div className={cx('min-w-0 space-y-2', className)}>
      {active.length > 0 && (
        <p className="text-[12px] text-[var(--ds-muted)]" aria-live="polite">
          Uploading {Math.min(total, doneCount + 1)} of {total}…
        </p>
      )}
      <ul className="min-w-0 space-y-1.5" aria-label="Uploads">
        {visible.map((item) => {
          const pct = Math.round((item.progress || 0) * 100);
          const rejected = item.state === 'rejected';
          const warn = item.state === 'over_cap' || item.state === 'failed';
          return (
            <li
              key={item.id}
              className={cx(
                ROW,
                rejected
                  ? 'border-red-300/60 bg-red-50/70 dark:border-red-400/30 dark:bg-red-950/30'
                  : warn
                    ? 'border-[#D97757]/35 bg-[#D97757]/[0.06]'
                    : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]'
              )}
              data-state={item.state}
            >
              {rejected ? <ShieldAlert className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden /> : <Thumb item={item} />}
              <div className="min-w-0 flex-1 basis-32">
                <p className="truncate text-[13px] font-medium text-[var(--ds-ink)]" title={item.name}>
                  {item.name}
                </p>
                {item.state === 'uploading' && (
                  <div className="mt-1 flex items-center gap-2">
                    <div
                      className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--ds-well)]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-label={`Uploading ${item.name}`}
                    >
                      <div className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">{pct}%</span>
                  </div>
                )}
                {(item.state === 'queued' || item.state === 'preparing' || item.state === 'checking') && (
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-[var(--ds-muted)]">
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
                    {item.state === 'checking' ? item.message || 'Checking…' : item.state === 'preparing' ? 'Getting it ready…' : 'Waiting…'}
                  </p>
                )}
                {item.state === 'duplicate' && (
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-[var(--ds-muted)]">
                    <Copy className="h-3 w-3 shrink-0" aria-hidden /> {item.message || 'Already added'}
                  </p>
                )}
                {item.state === 'near_duplicate' && (
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-[var(--ds-ink)]">
                    <Check className="h-3 w-3 shrink-0 text-[var(--ds-accent)]" aria-hidden /> {item.message}
                  </p>
                )}
                {(warn || rejected) && (
                  <p className={cx('mt-0.5 text-[12px] leading-snug', rejected ? 'text-red-700 dark:text-red-300' : 'text-[var(--ds-ink)]')} role="status">
                    {warn && <AlertTriangle className="mr-1 inline h-3 w-3 align-[-1px] text-[#D97757]" aria-hidden />}
                    {item.message}
                    {rejected && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="-my-[14px] inline-flex min-h-[44px] items-center py-[14px] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
                          onClick={() => setPolicyOpen((v) => !v)}
                          aria-expanded={policyOpen}
                        >
                          What's allowed?
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
              <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end">
                {isActiveUpload(item.state) && (
                  <button type="button" className={QUIET} onClick={() => onCancel(item.id)} aria-label={`Cancel ${item.name}`}>
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                )}
                {item.state === 'failed' && item.retryable && (
                  <button type="button" className={QUIET} onClick={() => onRetry(item.id)}>
                    <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
                  </button>
                )}
                {item.state === 'near_duplicate' && (
                  <>
                    <button type="button" className={QUIET} onClick={() => onDismiss(item.id)}>
                      Keep both
                    </button>
                    {onRemoveNew && (
                      <button type="button" className={QUIET} onClick={() => onRemoveNew(item)}>
                        Remove this
                      </button>
                    )}
                  </>
                )}
                {(rejected || warn) && (
                  <button type="button" className={QUIET} onClick={() => onDismiss(item.id)} aria-label={`Dismiss ${item.name}`}>
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {policyOpen && (
        <p className="rounded-xl bg-[var(--ds-well)] px-3 py-2 text-[12px] leading-snug text-[var(--ds-muted)]">
          DreamStream comics are PG-13 at most: action, adventure and spooky stories are fine; nudity, sexual content, graphic gore and hateful imagery are not.
          Only add photos you have the right to use.
        </p>
      )}
    </div>
  );
};

export default UploadQueue;
