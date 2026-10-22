// One render target as a thumbnail with honest status (queued / drawing / ready / out of
// date / failed + retry). Shared by the renders, style-choice and cast cards so every
// image in the conversation reads the same way.

import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
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
  badge
}) => {
  const status = render?.status || 'none';
  const hasImage = !!render?.asset?.path && (status === 'ready' || status === 'stale' || ((status === 'queued' || status === 'rendering') && !!url));
  const busy = status === 'queued' || status === 'rendering';
  const frame = cx(
    'relative w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]',
    selected && 'ring-2 ring-[var(--ds-accent)] ring-offset-1 ring-offset-[var(--ds-surface)]'
  );

  let body: React.ReactNode;
  if (status === 'failed') {
    body = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-red-500/[0.06] p-2 text-center">
        <AlertTriangle className="h-4 w-4 text-red-500" aria-hidden />
        <span className="line-clamp-3 text-[10.5px] leading-snug text-red-700 dark:text-red-300">{render?.error || 'Couldn’t draw this.'}</span>
        {onRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            disabled={retryBusy}
            className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" aria-hidden /> Retry
          </button>
        )}
      </div>
    );
  } else if (hasImage && url) {
    body = <ImageDevelop src={url} alt={label} active={isFreshRender(render)} className="h-full w-full" rounded="rounded-none" />;
  } else if (busy || (hasImage && !url)) {
    body = <div className="studio-shimmer h-full w-full" aria-hidden />;
  } else {
    body = <div className="grid h-full w-full place-items-center text-[10.5px] text-[var(--ds-muted)]">Not drawn yet</div>;
  }

  const content = (
    <>
      <div className={frame} style={{ aspectRatio: aspect }}>
        {body}
        {busy && (
          <span className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-center gap-1 rounded-full bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10px] font-medium text-[var(--ds-ink)] shadow-sm">
            <span className={cx('h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]', status === 'rendering' && 'animate-pulse')} aria-hidden />
            {status === 'queued' ? 'Queued' : 'Drawing…'}
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
      <span className="mt-1 block truncate text-[11px] font-medium text-[var(--ds-ink)]">{label}</span>
    </>
  );

  return onOpen && hasImage && url ? (
    <button type="button" onClick={onOpen} className={cx('block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 rounded-xl', className)} aria-label={`Open ${label}`}>
      {content}
    </button>
  ) : (
    <div className={cx('w-full', className)}>{content}</div>
  );
};
