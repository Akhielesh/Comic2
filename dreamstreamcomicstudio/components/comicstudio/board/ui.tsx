// Calm-studio building blocks for the board, editor and reader chrome. Everything composes
// from components/chat/studioDesign.ts tokens (--ds-* vars, the terracotta accent). Comic
// lettering fonts are never used here — only inside the comic content (balloons, SFX).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import type { RenderState } from '../../../shared/comic/doc';
import { ACCENT_BG, ACCENT_BG_HOVER, HAIRLINE, RADIUS_PANEL, SEGMENTED_ACTIVE, SHADOW_SOFT, TRANSITION } from '../../chat/studioDesign';
import { failureCaption, failureFacts, formatFailedAt } from '../conversation/cards/failure';
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

// Coarse pointers (mobile.md §2.4): sm/md grow to a real 44 px — tall AND wide, so an icon-only
// button (its label hidden on a phone) is never a 42 px target; xs keeps a compact look with a 44 px
// hit area (`tap-target`). Fine pointers keep today's sizes.
const sizeCls = (size: ButtonProps['size'] = 'md') =>
  size === 'xs'
    ? 'h-7 px-2.5 text-[11.5px] coarse:h-10 tap-target'
    : size === 'sm'
      ? 'h-8 px-3 text-[12px] coarse:h-11 coarse:min-w-[44px] coarse:px-3.5'
      : 'h-9 px-4 text-[13px] coarse:h-11 coarse:min-w-[44px]';

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
      // Touch: a REAL 44 px square for both sizes. Two small icon buttons side by side (a page card's
      // "Show the script" + "actions") used to share overlapping 44 px ::after zones and steal each
      // other's taps; a real box can't.
      size === 'sm' ? 'h-7 w-7 coarse:h-11 coarse:w-11' : 'h-8 w-8 coarse:h-11 coarse:w-11',
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

/**
 * Segmented control (radio group) with arrow-key support. With a MIXED value (a multi-selection whose
 * members disagree, so no option is checked) the first enabled option stays in the tab order, so the
 * control is never unreachable by keyboard (P1-LETTER-UI note: Pro Weight/Align/Case/Border).
 */
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
  // The one option in the tab order: the checked one, else (mixed / disabled value) the first enabled.
  const checkedIndex = options.findIndex((o) => o.value === value && !o.disabled);
  const tabStop = checkedIndex >= 0 ? checkedIndex : options.findIndex((o) => !o.disabled);
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex min-w-0 max-w-full rounded-xl bg-[var(--ds-segment-track)] p-0.5', className)}>
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
            tabIndex={i === tabStop ? 0 : -1}
            title={o.title ?? (typeof o.label === 'string' ? o.label : undefined)}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              `flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-[10px] font-medium ${TRANSITION} ${FOCUS_RING} disabled:opacity-40`,
              // Touch: every segment is a full 44×44 target, icon-only ones too (the header pane switcher).
              size === 'xs' ? 'px-2 py-1 text-[11px] coarse:min-h-[44px] coarse:min-w-[44px]' : 'px-2.5 py-1.5 text-[12px] coarse:min-h-[44px] coarse:min-w-[44px]',
              // Unselected segments read in ink at 80 %: muted on the well measured 4.39:1 (axe, under
              // AA 4.5:1); ink at 80 % over the well is ≥ 8:1 in both themes. The selected segment is the
              // segmented pill (studioDesign SEGMENTED_ACTIVE): the raised pill by default, ringed off the
              // track under the skin (the dark skin's raised step is the track's own colour).
              on ? SEGMENTED_ACTIVE : 'text-[var(--ds-ink)] opacity-80 hover:opacity-100'
            )}
          >
            {/* Text labels truncate inside their segment instead of overlapping a neighbour in a narrow row. */}
            {typeof o.label === 'string' ? <span className="min-w-0 truncate">{o.label}</span> : o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Inline editing ───────────────────────────────────────────────────────────

/** An explicit font-size utility (so the default size doesn't fight it). */
const HAS_TEXT_SIZE = /(^|\s)([a-z]+:)?text-(\[\d|xs\b|sm\b|base\b|lg\b|[2-9]?xl\b)/;

// coarse: every field is a real 44 px target on touch (P1-QA: Story/Style/Cast fields measured ~30 px).
const FIELD_BASE = `w-full rounded-lg border border-transparent bg-transparent px-2 py-1 coarse:min-h-[44px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] hover:border-[var(--ds-hairline)] focus:border-[#D97757]/50 focus:bg-[var(--ds-surface-strong)] focus:outline-none ${TRANSITION}`;

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
  /**
   * Multiline fields that are really one long value (comic title, names, taglines): Enter commits
   * (blurs) and Shift+Enter makes a newline, while the text still wraps instead of clipping.
   */
  submitOnEnter?: boolean;
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
  allowEmpty = true,
  submitOnEnter = false
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

  const autosize = React.useCallback(() => {
    const el = ref.current;
    if (!el || !multiline) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + 2}px`;
  }, [multiline]);
  useLayoutEffect(autosize, [draft, autosize]);

  // Re-measure when the field's WIDTH changes (split drag, the board appearing, a scrollbar) and once
  // web fonts land — otherwise wrapped text is silently cut at the bottom (visualqa P1-2).
  useEffect(() => {
    const el = ref.current;
    if (!el || !multiline) return;
    let frame = 0;
    let lastWidth = el.getBoundingClientRect().width;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        autosize();
      });
    };
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((records) => {
        const w = records[0]?.contentRect?.width ?? el.getBoundingClientRect().width;
        if (Math.abs(w - lastWidth) < 0.5) return; // height changes come from autosize itself: no loop
        lastWidth = w;
        schedule();
      });
      ro.observe(el);
    }
    let alive = true;
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts : undefined;
    fonts?.ready?.then(() => alive && autosize()).catch(() => undefined);
    return () => {
      alive = false;
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [multiline, autosize]);

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
      } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && (!multiline || e.metaKey || e.ctrlKey || (submitOnEnter && !e.shiftKey))) {
        e.preventDefault();
        ref.current?.blur();
      }
    },
    // The whole value on hover/long-press when it doesn't fit (single-line fields ellipsize).
    title: !multiline && draft ? draft : undefined,
    // Default value size sits just under body text on desktop (labels 11px, values 13.5px);
    // phones keep 16px so focusing a field never zooms the page.
    className: cx(
      FIELD_BASE,
      // 16 px on phones and every coarse pointer (no iOS focus zoom); 13.5 px on desktop.
      !mono && !HAS_TEXT_SIZE.test(inputClassName || '') && 'text-base sm:text-[13.5px] coarse:text-base',
      mono && 'font-mono text-[12px]',
      // Long single-line values end in an ellipsis instead of being clipped mid-letter (visualqa P1-1).
      !multiline && 'overflow-hidden text-ellipsis',
      inputClassName
    )
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
  /** A free re-check of the job (re-poll / resync) offered when a render is far past its usual time. */
  onRefresh?: () => void;
  /**
   * The render itself: a failure reads its sanitized `errorDetail` (exact time, provider facts) and
   * `attempts` for the calm "failed 16:52 · rate limited" caption. Without it, `error` + `since` are used.
   */
  render?: Pick<RenderState, 'error' | 'errorDetail' | 'attempts' | 'updatedAt'>;
  /** What the frame shows ("Page 6"): names the failure for screen readers. */
  label?: string;
}

/** Past this multiple of the model's usual time the clock stops and "Check again" is offered. */
export const STUCK_FACTOR = 10;
/** Without a typical time, a render counts as stuck after this long. */
export const STUCK_FALLBACK_MS = 15 * 60_000;

/** Is a render that started `elapsedMs` ago far past its usual time? */
export const isStuck = (elapsedMs: number, typicalSec?: number): boolean =>
  elapsedMs > (typicalSec && typicalSec > 0 ? typicalSec * 1000 * STUCK_FACTOR : STUCK_FALLBACK_MS);

// The studio shell registers its free re-check (studio.refresh: one GET, no AI) here, so EVERY stuck
// overlay can offer "Check again" without each frame threading the controller down. Outside a studio
// nothing is registered and the overlay just says it is taking long (no dead button).
const studioRefreshers = new Set<() => void>();

/** Register the open studio's refresh; returns the unregister function. */
export const registerStudioRefresh = (refresh: () => void): (() => void) => {
  studioRefreshers.add(refresh);
  return () => {
    studioRefreshers.delete(refresh);
  };
};

/** The registered studio refresh (the most recent), if a studio is open. */
export const studioRefresh = (): (() => void) | undefined => {
  let last: (() => void) | undefined;
  studioRefreshers.forEach((fn) => (last = fn));
  return last;
};

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
  compact,
  onRefresh,
  render,
  label
}) => {
  const busy = status === 'queued' || status === 'rendering';
  const now = useNow(busy);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = React.useId();
  if (busy) {
    const elapsed = since ? Math.max(0, now - since) : 0;
    const slow = status === 'rendering' && typicalSec && elapsed > typicalSec * 2500;
    // A clock that reads "378d" helps nobody: past 10× the usual time it stops and offers a free re-check.
    const stuck = !!since && isStuck(elapsed, typicalSec);
    const recheck = onRefresh ?? (stuck ? studioRefresh() : undefined);
    return (
      <div className={cx('absolute inset-0 z-[3] flex flex-col justify-end', overImage ? 'bg-black/25' : '')} aria-live="polite">
        {!overImage && <div className="studio-shimmer absolute inset-0" aria-hidden />}
        {/* Fade whatever sits under the pill (plan sketch, placeholder copy) so text never overlaps text. */}
        {!overImage && <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--ds-surface)] to-transparent" aria-hidden />}
        <div
          className={cx(
            'relative m-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 self-center rounded-full bg-[var(--ds-surface-strong)] px-2.5 py-1 text-center font-medium text-[var(--ds-ink)] shadow-sm',
            compact ? 'text-[10px]' : 'text-[11px]'
          )}
        >
          <span className={cx('h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]', status === 'rendering' && !stuck && 'animate-pulse')} aria-hidden />
          {status === 'queued' && !stuck ? (
            <span className="min-w-0 truncate">Queued{model ? ` · ${model}` : ''}</span>
          ) : stuck ? (
            <>
              <span className="min-w-0">{status === 'queued' ? 'Still queued' : 'Still drawing'} · much longer than usual</span>
              {recheck && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    recheck();
                  }}
                  // A real 44 px box on touch: the pill sits at the frame's edge, where a ::after zone
                  // would be clipped by the frame's overflow.
                  className={`tap-target rounded-full px-1.5 font-semibold text-[var(--ds-accent)] hover:underline coarse:min-h-[44px] coarse:px-2.5 ${FOCUS_RING}`}
                >
                  Check again
                </button>
              )}
            </>
          ) : (
            <span className="min-w-0">
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
    // CALM (reliability.md §3, the 2026-10-22 incident): a quiet card that says WHEN it failed and a
    // short reason ("failed 16:52 · rate limited"), so a stale failure from an earlier outage is
    // recognisable; the provider's exact words are one tap away (Details). Never a red wall of text,
    // never raw text over the plan sketch or the art; the card scrolls inside a small frame.
    const facts = failureFacts(render ?? { error, updatedAt: since });
    const caption = failureCaption(facts.error, facts.at, now);
    const when = formatFailedAt(facts.at, now);
    const hasDetails = !!(facts.error || facts.facts);
    return (
      <div
        role="group"
        aria-label={`${label ? `${label}: ` : ''}${caption}`}
        data-failed=""
        className={cx(
          'absolute inset-0 z-[3] flex flex-col items-center justify-[safe_center] overflow-y-auto overscroll-contain p-2 text-center',
          // Opaque over placeholders: the plan sketch / "Not drawn yet" copy never shows through (visualqa P2-2).
          overImage ? 'bg-black/40' : 'bg-[var(--ds-surface)]'
        )}
      >
        <div
          className={cx(
            'flex min-w-0 max-w-[94%] flex-col items-center rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] shadow-[0_2px_10px_rgba(0,0,0,0.10)]',
            compact ? 'gap-1 px-2.5 py-2' : 'gap-1.5 px-3.5 py-3'
          )}
        >
          <CircleAlert className={cx('shrink-0 text-amber-600 dark:text-amber-300', compact ? 'h-4 w-4' : 'h-5 w-5')} aria-hidden />
          <p className={cx('min-w-0 max-w-[28ch] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere] first-letter:uppercase', compact ? 'text-[11.5px]' : 'text-[12px]')}>
            {caption}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            {onRetry && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
                className={`tap-target inline-flex items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-1 text-[12px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] coarse:min-h-[44px] ${FOCUS_RING}`}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {retryLabel}
              </button>
            )}
            {hasDetails && (
              <button
                type="button"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={(e) => {
                  e.stopPropagation();
                  setDetailsOpen((v) => !v);
                }}
                className={`tap-target rounded-full px-1.5 py-0.5 text-[11.5px] font-medium text-[var(--ds-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--ds-ink)] coarse:min-h-[44px] ${FOCUS_RING}`}
              >
                {detailsOpen ? 'Hide details' : 'Details'}
              </button>
            )}
          </div>
          {detailsOpen && hasDetails && (
            <div
              id={detailsId}
              className="max-h-28 w-full min-w-0 overflow-y-auto overscroll-contain rounded-lg bg-[var(--ds-well)] px-2 py-1.5 text-left text-[11px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]"
            >
              {facts.error && <p className="whitespace-pre-wrap">{facts.error}</p>}
              {facts.facts && <p className="mt-0.5">{facts.facts}</p>}
              {when && (
                <p className="mt-0.5">
                  Failed at {when}
                  {facts.attempts && facts.attempts > 1 ? ` after ${facts.attempts} tries` : ''}.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (status === 'stale') {
    // Bottom-centre, like the drawing pill: the top of a page is where captions live.
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] flex justify-center p-2">
        <div
          className={cx(
            'pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full bg-[var(--ds-surface-strong)] py-1 pl-2 font-semibold text-[var(--ds-ink)] shadow-[0_2px_10px_rgba(0,0,0,0.18)]',
            onRerender ? 'pr-1' : 'pr-2.5',
            compact ? 'text-[10.5px]' : 'text-[11px]'
          )}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
          <span className="truncate">{staleLabel}</span>
          {onRerender && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRerender();
              }}
              className={`tap-target shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10.5px] font-semibold text-white hover:bg-amber-600 ${FOCUS_RING}`}
            >
              Re-render
            </button>
          )}
        </div>
      </div>
    );
  }
  return null;
};

/**
 * A labelled on/off switch row (role="switch"): the whole row is the 44 px target on touch, the
 * description wraps under the label, and the knob respects reduced motion.
 */
export const SwitchRow: React.FC<{
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  /** Extra controls at the end of the row (e.g. "Edit text"). */
  after?: React.ReactNode;
}> = ({ label, description, checked, onChange, disabled, className, after }) => {
  const id = React.useId();
  return (
    <div className={cx('flex min-w-0 items-center gap-2', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'group flex min-h-[36px] min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1 text-left hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-45 coarse:min-h-[44px]',
          FOCUS_RING
        )}
      >
        <span
          aria-hidden
          className={cx(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 motion-reduce:transition-none',
            checked ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-well-strong)]'
          )}
        >
          <span
            className={cx(
              'absolute h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none',
              checked ? 'translate-x-[18px]' : 'translate-x-0.5'
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span id={`${id}-l`} className="block text-[12.5px] font-medium leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">
            {label}
          </span>
          {description && (
            <span id={`${id}-d`} className="block text-[11px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
              {description}
            </span>
          )}
        </span>
      </button>
      {after}
    </div>
  );
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
          `inline-flex h-7 items-center rounded-lg px-2.5 text-[12px] font-semibold text-white coarse:h-10 ${FOCUS_RING}`,
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

/**
 * Sideways-scrolling rows (the board's tab strip, the reader's compact toolbar): which edges are
 * clipped, for the "there is more" fade. Re-measures on scroll (call `measure`), on a resize of the row
 * or of any of its items, and when `deps` change.
 */
export const useEdgeClip = (ref: React.RefObject<HTMLElement | null>, deps: React.DependencyList) => {
  const [clip, setClip] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    setClip((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);
  return { clip, measure };
};

/** The fade on a sideways-scrolling row's clipped edge(s) — "there is more this way". */
export const EDGE_FADE_MASK = {
  both: '[mask-image:linear-gradient(to_right,transparent,black_20px,black_calc(100%-28px),transparent)]',
  end: '[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]',
  start: '[mask-image:linear-gradient(to_right,transparent,black_20px)]'
};

export const edgeFadeMask = (clip: { start: boolean; end: boolean }): string =>
  clip.start && clip.end ? EDGE_FADE_MASK.both : clip.end ? EDGE_FADE_MASK.end : clip.start ? EDGE_FADE_MASK.start : '';

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
