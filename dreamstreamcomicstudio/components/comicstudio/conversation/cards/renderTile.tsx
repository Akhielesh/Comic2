// One render target as a thumbnail with honest status (queued / drawing / ready / out of
// date / failed + retry). Shared by the renders, style-choice and cast cards so every
// image in the conversation reads the same way.
//
// Failed tiles are CALM (reliability.md §3, the 2026-10-22 outage): a quiet surface, a small
// icon and Retry inside the frame, and one caption line under it that says when and why
// ("failed 16:52 · rate limited") so a stale failure is recognisable. The provider's exact
// words are one tap away ("Details") — never a red wall of text sliced by a small tile
// (visualqa P1-5: the body is safe-centred, and landscape tiles keep only icon + Retry).

import React, { useId, useState } from 'react';
import { AlertTriangle, CircleAlert, RotateCcw } from 'lucide-react';
import {
  findCharacter,
  findPage,
  findPlace,
  isPageStale,
  type ComicDoc,
  type RenderState,
  type RenderTarget
} from '../../../../shared/comic/doc';
import type { SpendAction } from '../../../../shared/comic/ops';
import { ImageDevelop } from '../../../studio/kit/streamMotion';
import { cx } from '../ui';
import { failureCaption, failureReason, formatFailedAt } from './failure';

/** Renders that finished this recently "develop" in; older ones show statically. */
const DEVELOP_WINDOW_MS = 15_000;

export interface TargetMeta {
  label: string;
  /** CSS aspect ratio "w / h". */
  aspect: string;
  /** Spend action that redraws this target. */
  retry?: SpendAction;
  stale: boolean;
}

const cssAspect = (ratio: string) => ratio.replace(':', ' / ');

export const describeTarget = (doc: ComicDoc, target: RenderTarget): TargetMeta | null => {
  switch (target.kind) {
    case 'page': {
      const page = findPage(doc, target.id);
      if (!page) return null;
      return {
        label: `Page ${page.n}`,
        aspect: cssAspect(doc.format.pageAspect),
        retry: { type: 'render_pages', pageIds: [page.id], force: true },
        stale: page.render.status === 'stale' || isPageStale(doc, page)
      };
    }
    case 'cover':
      return { label: 'Cover', aspect: cssAspect(doc.format.pageAspect), retry: { type: 'render_cover' }, stale: false };
    case 'sheet': {
      const c = findCharacter(doc, target.id);
      if (!c) return null;
      return { label: c.name, aspect: '3 / 2', retry: { type: 'render_sheets', characterIds: [c.id], force: true }, stale: false };
    }
    case 'place': {
      const p = findPlace(doc, target.id);
      if (!p) return null;
      return { label: p.name, aspect: '3 / 2', retry: { type: 'render_sheets', characterIds: [p.id], force: true }, stale: false };
    }
    case 'style_option': {
      const o = doc.style.options.find((x) => x.id === target.id);
      if (!o) return null;
      return {
        label: o.name,
        aspect: '4 / 5',
        retry: { type: 'render_style_options', directions: [{ name: o.name, spec: o.spec }] },
        stale: false
      };
    }
    default:
      return null;
  }
};

export const isFreshRender = (render?: RenderState, now = Date.now()) =>
  !!render?.updatedAt && now - render.updatedAt < DEVELOP_WINDOW_MS;

/** "4 / 5" or "4:5" → 0.8 (w/h); NaN-safe (unknown ⇒ portrait). */
export const aspectValue = (aspect: string): number => {
  const [w, h] = aspect.split(/[/:]/).map((s) => Number(s.trim()));
  return w > 0 && h > 0 ? w / h : 0.75;
};

export interface RenderThumbProps {
  render: RenderState | undefined;
  label: string;
  aspect: string;
  url?: string;
  stale?: boolean;
  onOpen?: () => void;
  onRetry?: () => void;
  retryBusy?: boolean;
  selected?: boolean;
  className?: string;
  /** Extra overlay (e.g. a lock badge). */
  badge?: React.ReactNode;
  /** Icon + Retry only inside a failed frame (small tiles). Default: landscape tiles. */
  compact?: boolean;
  /** Clock for the failure caption (tests). */
  now?: number;
}

/** The image (or its status placeholder) for one render target. */
export const RenderThumb: React.FC<RenderThumbProps> = ({
  render,
  label,
  aspect,
  url,
  stale,
  onOpen,
  onRetry,
  retryBusy,
  selected,
  className,
  badge,
  compact,
  now
}) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const status = render?.status || 'none';
  const hasImage = !!render?.asset?.path && (status === 'ready' || status === 'stale' || ((status === 'queued' || status === 'rendering') && !!url));
  const busy = status === 'queued' || status === 'rendering';
  const failed = status === 'failed';
  const iconOnly = compact ?? aspectValue(aspect) >= 1;
  const frame = cx(
    'relative w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]',
    selected && 'ring-2 ring-[var(--ds-accent)] ring-offset-1 ring-offset-[var(--ds-surface)]'
  );

  const failedAt = failed ? render?.updatedAt : undefined;
  const caption = failed ? failureCaption(render?.error, failedAt, now) : '';
  const reason = failed ? failureReason(render?.error) : '';
  const spokenFailure = failed
    ? `${label}: ${caption}.${render?.error ? ` ${render.error}` : ''}`
    : undefined;

  let body: React.ReactNode;
  if (failed) {
    body = (
      <div
        title={render?.error || caption}
        data-failed=""
        className="flex h-full w-full flex-col items-center justify-[safe_center] gap-1 bg-[var(--ds-surface-soft)] p-1.5 text-center"
      >
        <span className="sr-only">{spokenFailure}</span>
        <CircleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
        {!iconOnly && (
          <span aria-hidden className="line-clamp-2 text-[10.5px] font-medium leading-snug text-[var(--ds-muted)] first-letter:uppercase">
            {reason}
          </span>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            disabled={retryBusy}
            aria-label={`Retry ${label}`}
            className="tap-target inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-50"
          >
            <RotateCcw className={cx('h-3 w-3', retryBusy && 'animate-spin motion-reduce:animate-none')} aria-hidden /> Retry
          </button>
        )}
      </div>
    );
  } else if (hasImage && url) {
    body = <ImageDevelop src={url} alt={label} active={isFreshRender(render)} className="h-full w-full" rounded="rounded-none" />;
  } else if (busy || (hasImage && !url)) {
    body = <div className="studio-shimmer h-full w-full" aria-hidden />;
  } else {
    body = <div className="grid h-full w-full place-items-center p-1 text-center text-[10.5px] text-[var(--ds-muted)]">Not drawn yet</div>;
  }

  const content = (
    <>
      <div className={frame} style={{ aspectRatio: aspect }}>
        {body}
        {busy && (
          <span className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-center gap-1 rounded-full bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10px] font-medium text-[var(--ds-ink)] shadow-sm">
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]', status === 'rendering' && 'animate-pulse')} aria-hidden />
            <span className="min-w-0 truncate">{status === 'queued' ? 'Queued' : 'Drawing…'}</span>
          </span>
        )}
        {!busy && stale && hasImage && (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[9.5px] font-semibold text-white">Out of date</span>
        )}
        {!busy && status === 'ready' && render?.error && (
          <span
            className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-amber-500/90 text-white"
            title={render.error}
            aria-label={render.error}
          >
            <AlertTriangle className="h-3 w-3" />
          </span>
        )}
        {badge}
      </div>
      <span className="mt-1 block truncate text-[11px] font-medium text-[var(--ds-ink)]" title={label}>
        {label}
      </span>
      {failed && (
        <span className="flex min-w-0 items-baseline gap-1 text-[10.5px] leading-snug text-[var(--ds-muted)]">
          <span className="min-w-0 truncate" title={caption} aria-hidden>
            {caption}
          </span>
          {render?.error && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDetailsOpen((v) => !v);
              }}
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              className="tap-target shrink-0 font-medium text-[var(--ds-ink)] underline decoration-dotted underline-offset-2 hover:text-[var(--ds-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
            >
              {detailsOpen ? 'Hide' : 'Details'}
            </button>
          )}
        </span>
      )}
      {failed && detailsOpen && render?.error && (
        <span
          id={detailsId}
          className="mt-1 block whitespace-pre-wrap rounded-lg bg-[var(--ds-well)] px-2 py-1.5 text-[10.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]"
        >
          {render.error}
          {formatFailedAt(failedAt, now) && (
            <span className="mt-0.5 block text-[var(--ds-muted)]">
              Failed at {formatFailedAt(failedAt, now)}
              {typeof render.attempts === 'number' && render.attempts > 1 ? ` after ${render.attempts} tries` : ''}.
            </span>
          )}
        </span>
      )}
    </>
  );

  return onOpen && hasImage && url ? (
    <button type="button" onClick={onOpen} className={cx('block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40', className)} aria-label={`Open ${label}`}>
      {content}
    </button>
  ) : (
    <div className={cx('w-full min-w-0', className)}>{content}</div>
  );
};
