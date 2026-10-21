// Calm-studio building blocks for the board, editor and reader chrome. Everything composes
// from components/chat/studioDesign.ts tokens (--ds-* vars, the terracotta accent). Comic
// lettering fonts are never used here — only inside the comic content (balloons, SFX).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { ACCENT_BG, ACCENT_BG_HOVER, HAIRLINE, RADIUS_PANEL, SHADOW_SOFT, TRANSITION } from '../../chat/studioDesign';
import { formatElapsed, type VisualStatus } from './boardModel';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';

// ── Surfaces ─────────────────────────────────────────────────────────────────

export const Surface: React.FC<React.HTMLAttributes<HTMLElement> & { as?: 'section' | 'div' | 'article' }> = ({
  as = 'section',
  className,
  children,
  ...rest
}) => {
  const Tag = as;
  return (
    <Tag {...rest} className={cx(`${RADIUS_PANEL} ${HAIRLINE} ${SHADOW_SOFT} bg-[var(--ds-surface)]`, className)}>
      {children}
    </Tag>
  );
};

export const SectionTitle: React.FC<{ children: React.ReactNode; right?: React.ReactNode; icon?: React.ReactNode; className?: string; id?: string }> = ({
  children,
  right,
  icon,
  className,
  id
}) => (
  <div className={cx('mb-2 flex items-center justify-between gap-3', className)}>
    <h3 id={id} className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
      {icon && <span className="shrink-0" aria-hidden>{icon}</span>}
      <span className="truncate">{children}</span>
    </h3>
    {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
  </div>
);

// ── Buttons ──────────────────────────────────────────────────────────────────

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; size?: 'xs' | 'sm' | 'md' };

const sizeCls = (size: ButtonProps['size'] = 'md') =>
  size === 'xs' ? 'h-7 px-2.5 text-[11.5px]' : size === 'sm' ? 'h-8 px-3 text-[12px]' : 'h-9 px-4 text-[13px]';

export const PrimaryButton: React.FC<ButtonProps> = ({ busy, size, className, children, disabled, type, ...rest }) => (
  <button
    type={type || 'button'}
    {...rest}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={cx(
      `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl font-semibold text-white ${ACCENT_BG} ${ACCENT_BG_HOVER} ${TRANSITION} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-45`,
      sizeCls(size),
      className
    )}
  >
    {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />}
    {children}
  </button>
);

export const GhostButton: React.FC<ButtonProps & { tone?: 'default' | 'danger' }> = ({ busy, size, tone, className, children, disabled, type, ...rest }) => (
  <button
    type={type || 'button'}
    {...rest}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={cx(
      `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl ${HAIRLINE} bg-[var(--ds-surface-soft)] font-medium hover:bg-[var(--ds-hover)] ${TRANSITION} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-45`,
      tone === 'danger' ? 'text-red-600 dark:text-red-300' : 'text-[var(--ds-ink)]',
      sizeCls(size),
      className
    )}
  >
    {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />}
    {children}
  </button>
);

export const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }> = ({
  label,
  size = 'md',
  className,
  children,
  type,
  ...rest
}) => (
  <button
    type={type || 'button'}
    aria-label={label}
    title={label}
    {...rest}
    className={cx(
      `inline-flex shrink-0 items-center justify-center rounded-xl text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] ${TRANSITION} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`,
      size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
      className
    )}
  >
    {children}
  </button>
);

/** Small pill (format summary, tags). Not interactive unless given onClick. */
export const Chip: React.FC<{ children: React.ReactNode; className?: string; title?: string; tone?: 'default' | 'accent' }> = ({
  children,
  className,
  title,
  tone = 'default'
}) => (
  <span
    title={title}
    className={cx(
      'inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] leading-none',
      tone === 'accent'
        ? 'border-[#D97757]/35 bg-[#D97757]/10 text-[var(--ds-ink)]'
        : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
      className
    )}
  >
    {children}
  </span>
);

/** Segmented control (radio group) with arrow-key support. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'sm',
  className
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: React.KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    const at = enabled.indexOf(index);
    const next = enabled[(at + delta + enabled.length) % enabled.length];
    if (next === undefined) return;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex rounded-xl bg-[var(--ds-well-strong)] p-0.5', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              `flex min-w-0 flex-1 items-center justify-center gap-1 rounded-[10px] font-medium ${TRANSITION} ${FOCUS_RING} disabled:opacity-40`,
              size === 'xs' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[12px]',
              on ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Inline editing ───────────────────────────────────────────────────────────

const FIELD_BASE = `w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] hover:border-[var(--ds-hairline)] focus:border-[#D97757]/50 focus:bg-[var(--ds-surface-strong)] focus:outline-none ${TRANSITION}`;

export interface InlineFieldProps {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  /** Show the label above the field (otherwise it is screen-reader only). */
  showLabel?: boolean;
  placeholder?: string;
  multiline?: boolean;
  /** Minimum visible rows for multiline fields. */
  rows?: number;
  className?: string;
  inputClassName?: string;
  maxLength?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Monospace text (scripts). */
  mono?: boolean;
  id?: string;
  /** When false, clearing the field reverts it instead of committing an empty value (names, titles). */
  allowEmpty?: boolean;
}

/**
 * Text that edits in place. Commits on blur (or Enter on single-line fields) only when the
 * text actually changed; Escape reverts. While focused it ignores incoming value changes so
 * a live stream never yanks text out from under the user.
 */
export const InlineField: React.FC<InlineFieldProps> = ({
  value,
  onCommit,
  label,
  showLabel,
  placeholder,
  multiline,
  rows = 2,
  className,
  inputClassName,
  maxLength,
  disabled,
  autoFocus,
  mono,
  id,
  allowEmpty = true
}) => {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const autoId = React.useId();
  const fieldId = id || autoId;

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const autosize = () => {
    const el = ref.current;
    if (!el || !multiline) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(autosize, [draft, multiline]);

  const commit = () => {
    focused.current = false;
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    const next = draft.trim();
    if (!next && !allowEmpty) setDraft(value);
    else if (next !== value.trim()) onCommit(next);
    else if (draft !== value) setDraft(value);
  };

  const common = {
    id: fieldId,
    value: draft,
    placeholder,
    maxLength,
    disabled,
    autoFocus,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelled.current = true;
        setDraft(value);
        ref.current?.blur();
      } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ref.current?.blur();
      }
    },
    className: cx(FIELD_BASE, mono && 'font-mono text-[12px]', inputClassName)
  };

  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={fieldId} className={showLabel ? 'mb-0.5 block px-2 text-[11px] font-medium text-[var(--ds-muted)]' : 'sr-only'}>
        {label}
      </label>
      {multiline ? (
        <textarea ref={ref} rows={rows} {...common} className={cx(common.className, 'resize-none leading-relaxed')} />
      ) : (
        <input ref={ref} type="text" {...common} />
      )}
    </div>
  );
};

// ── Status ───────────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<VisualStatus, string> = {
  planned: 'Planned',
  queued: 'Queued',
  rendering: 'Drawing',
  ready: 'Drawn',
  stale: 'Out of date',
  failed: 'Failed',
  empty: 'Empty'
};

export const StatusChip: React.FC<{ status: VisualStatus; className?: string; label?: string }> = ({ status, className, label }) => {
  const tone =
    status === 'ready'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : status === 'stale'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : status === 'failed'
          ? 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300'
          : status === 'rendering' || status === 'queued'
            ? 'border-[#D97757]/30 bg-[#D97757]/10 text-[var(--ds-ink)]'
            : 'border-[var(--ds-hairline)] bg-[var(--ds-well)] text-[var(--ds-muted)]';
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold', tone, className)}>
      {(status === 'rendering' || status === 'queued') && (
        <span className={cx('h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]', status === 'rendering' && 'animate-pulse')} aria-hidden />
      )}
      {label || STATUS_TEXT[status]}
    </span>
  );
};

/** Ticking clock for elapsed-time labels; only ticks while `active`. */
export const useNow = (active: boolean, intervalMs = 1000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
};

export interface RenderOverlayProps {
  status: VisualStatus;
  /** When the current status began (render.updatedAt). */
  since?: number;
  model?: string;
  /** Typical seconds for this model (progress hint). */
  typicalSec?: number;
  error?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Text for the stale badge. */
  staleLabel?: string;
  onRerender?: () => void;
  /** There is an older image under the overlay (dim it instead of shimmering the whole frame). */
  overImage?: boolean;
  compact?: boolean;
}

/**
 * The status layer over any render frame: shimmer + elapsed + model while drawing, error
 * + Retry when failed, an amber "out of date" badge when stale. Sits inside a `relative` box.
 */
export const RenderOverlay: React.FC<RenderOverlayProps> = ({
  status,
  since,
  model,
  typicalSec,
  error,
  onRetry,
  retryLabel = 'Retry',
  staleLabel = 'Out of date',
  onRerender,
  overImage,
  compact
}) => {
  const busy = status === 'queued' || status === 'rendering';
  const now = useNow(busy);
  if (busy) {
    const elapsed = since ? now - since : 0;
    const slow = status === 'rendering' && typicalSec && elapsed > typicalSec * 2500;
    return (
      <div className={cx('absolute inset-0 z-[3] flex flex-col justify-end', overImage ? 'bg-black/25' : '')} aria-live="polite">
        {!overImage && <div className="studio-shimmer absolute inset-0" aria-hidden />}
        <div className={cx('relative m-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full bg-[var(--ds-surface-strong)] px-2.5 py-1 text-center font-medium text-[var(--ds-ink)] shadow-sm', compact ? 'text-[10px]' : 'text-[11px]')}>
          <span className={cx('h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]', status === 'rendering' && 'animate-pulse')} aria-hidden />
          {status === 'queued' ? (
            <span>Queued{model ? ` · ${model}` : ''}</span>
          ) : (
            <span>
              Drawing{since ? ` · ${formatElapsed(elapsed)}` : '…'}
              {model ? ` · ${model}` : ''}
              {!compact && typicalSec && !slow ? <span className="text-[var(--ds-muted)]"> (usually ~{typicalSec}s)</span> : null}
              {slow ? <span className="text-[var(--ds-muted)]"> · taking longer than usual</span> : null}
            </span>
          )}
        </div>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div
        role="alert"
        className={cx(
          'absolute inset-0 z-[3] flex flex-col items-center justify-center gap-2 p-3 text-center',
          overImage ? 'bg-black/55 text-white' : 'bg-red-500/[0.06]'
        )}
      >
        <TriangleAlert className={cx('h-5 w-5', overImage ? 'text-amber-300' : 'text-red-500')} aria-hidden />
        <p className={cx('line-clamp-4 max-w-[28ch] text-[12px] leading-snug', overImage ? 'text-white' : 'text-red-700 dark:text-red-300')}>
          {error || 'This couldn’t be drawn.'}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            className={`inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-[var(--ds-surface-strong)] px-3 py-1 text-[12px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${FOCUS_RING}`}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {retryLabel}
          </button>
        )}
      </div>
    );
  }
  if (status === 'stale') {
    return (
      <div className="absolute left-2 top-2 z-[3] flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-amber-500/95 px-2 py-0.5 text-[10.5px] font-semibold text-white shadow-sm">{staleLabel}</span>
        {onRerender && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRerender();
            }}
            className={`rounded-full bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--ds-ink)] shadow-sm hover:bg-[var(--ds-hover)] ${FOCUS_RING}`}
          >
            Re-render
          </button>
        )}
      </div>
    );
  }
  return null;
};

/** Inline confirmation strip (destructive or costly actions). */
export const ConfirmStrip: React.FC<{
  message: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel?: string;
  tone?: 'danger' | 'accent';
}> = ({ message, confirmLabel, onConfirm, onCancel, cancelLabel = 'Cancel', tone = 'danger' }) => (
  <div
    role="alertdialog"
    aria-label={typeof message === 'string' ? message : confirmLabel}
    className={cx(
      'rounded-xl border p-2.5 text-[12px] text-[var(--ds-ink)]',
      tone === 'danger' ? 'border-red-500/25 bg-red-500/[0.06]' : 'border-[#D97757]/35 bg-[#D97757]/10'
    )}
  >
    <p className="leading-snug">{message}</p>
    <div className="mt-2 flex gap-2">
      <button
        type="button"
        onClick={onConfirm}
        className={cx(
          `inline-flex h-7 items-center rounded-lg px-2.5 text-[12px] font-semibold text-white ${FOCUS_RING}`,
          tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : `${ACCENT_BG} ${ACCENT_BG_HOVER}`
        )}
      >
        {confirmLabel}
      </button>
      <GhostButton size="xs" onClick={onCancel}>
        {cancelLabel}
      </GhostButton>
    </div>
  </div>
);

/** Quiet "nothing here yet" block with a hint of what will appear. */
export const EmptyHint: React.FC<{ icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }> = ({
  icon,
  title,
  children,
  action,
  className
}) => (
  <div className={cx('flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--ds-hairline)] px-6 py-10 text-center', className)}>
    {icon && <div className="mb-3 text-[var(--ds-faint)]" aria-hidden>{icon}</div>}
    <p className="text-[14px] font-semibold text-[var(--ds-ink)]">{title}</p>
    {children && <div className="mt-1 max-w-sm text-[13px] leading-relaxed text-[var(--ds-muted)]">{children}</div>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

/**
 * Keep keyboard focus inside a dialog (Tab / Shift+Tab wrap). Pair with useDialogA11y for
 * Escape + focus restore.
 */
export const useFocusTrap = (ref: React.RefObject<HTMLElement | null>, active: boolean) => {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !root.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeEl === last || !root.contains(activeEl))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    if (!root.contains(document.activeElement)) root.focus();
    return () => root.removeEventListener('keydown', onKey);
  }, [ref, active]);
};

/** Element size via ResizeObserver (falls back to one measurement where unavailable, e.g. jsdom). */
export const useElementSize = <T extends HTMLElement>(): [React.RefCallback<T>, { width: number; height: number }] => {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = React.useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5 ? prev : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, size];
};

/** Fire-and-forget an action, keeping a short "just clicked" flag for the control. */
export const useClickGuard = (ms = 1500) => {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const fire = React.useCallback(
    (key: string, run: () => unknown) => {
      setBusyKey(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setBusyKey(null), ms);
      try {
        const out = run();
        if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch(() => undefined);
      } catch {
        /* the controller surfaces errors itself */
      }
    },
    [ms]
  );
  return { busyKey, fire };
};
