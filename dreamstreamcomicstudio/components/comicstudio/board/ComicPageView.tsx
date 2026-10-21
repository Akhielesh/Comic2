// One comic page, exactly as it reads: the art at its true aspect ratio (never cropped —
// object-contain inside an aspect box that adopts the image's real pixel ratio once it
// loads), overlay balloons on top when the comic is lettered as an overlay, and a plan
// sketch (estimated panel grid, panel numbers, first beat of each panel's action) when
// nothing is drawn yet. Status overlays and editor layers slot in via props/children.

import React, { useState } from 'react';
import type { Balloon, ComicDoc, Page } from '../../../shared/comic/doc';
import { ImageDevelop } from '../../studio/kit/streamMotion';
import { BalloonLayer } from './BalloonLayer';
import { pageAspectOf } from './balloonGeometry';
import { SHOT_LABEL, isFreshRender } from './boardModel';
import { panelBoxesFor } from './pageLayout';
import { cx, useElementSize } from './ui';

export interface ComicPageViewProps {
  doc: ComicDoc;
  page: Page;
  imageUrl?: string;
  editable?: boolean;
  onBalloonChange?: (lineId: string, patch: Partial<Balloon>) => void;
  className?: string;
  /** Status layer (shimmer, error, stale badge) drawn over the page. */
  overlay?: React.ReactNode;
  /** Extra layers inside the page box (e.g. the editor's mark-up layer). */
  children?: React.ReactNode;
  /** Hide the lettering (e.g. to compare against the clean art). */
  hideLettering?: boolean;
  selectedLineId?: string | null;
  onSelectLine?: (lineId: string | null) => void;
  /** Image loading hint (lazy by default; the editor loads eagerly). */
  loading?: 'lazy' | 'eager';
  onImageError?: () => void;
  /** Play the develop-in reveal when the render just landed (default true). */
  develop?: boolean;
  style?: React.CSSProperties;
  alt?: string;
  /** Called with the art's real width/height ratio once the image has loaded. */
  onAspectChange?: (aspect: number) => void;
}

/** Fallback page width for geometry before the box has been measured (and in tests). */
const FALLBACK_WIDTH = 600;

const clip = (text: string, max: number) => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The planned page as a sketch: panel boxes with numbers and the first beat of each action. */
export const PlanSketch: React.FC<{ doc: ComicDoc; page: Page; width: number }> = ({ doc, page, width }) => {
  const boxes = panelBoxesFor(doc, page);
  const fontPx = Math.max(9, Math.min(15, width * 0.024));
  if (!page.panels.length) {
    return (
      <div className="absolute inset-0 grid place-items-center p-4 text-center text-[12px] text-[var(--ds-muted)]">
        No panels planned for this page yet.
      </div>
    );
  }
  return (
    <div className="absolute inset-0" aria-label={`Page ${page.n} plan sketch`} role="img">
      {page.panels.map((panel, i) => {
        const box = boxes[i];
        if (!box) return null;
        const lines = panel.lines.filter((l) => l.text.trim()).length;
        return (
          <div
            key={panel.id}
            className="absolute overflow-hidden rounded-[3px] border border-dashed border-[var(--ds-faint)] bg-[var(--ds-well)]"
            style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
          >
            <div className="flex h-full flex-col gap-1 p-[6%]" style={{ fontSize: fontPx }}>
              <div className="flex items-center gap-1.5">
                <span
                  className="grid shrink-0 place-items-center rounded-full bg-[var(--ds-surface-strong)] font-semibold text-[var(--ds-ink)] shadow-sm"
                  style={{ width: fontPx * 1.7, height: fontPx * 1.7, fontSize: fontPx * 0.95 }}
                >
                  {panel.n}
                </span>
                <span className="truncate text-[0.85em] font-medium uppercase tracking-wide text-[var(--ds-muted)]">{SHOT_LABEL[panel.shot] || panel.shot}</span>
              </div>
              {width > 160 && panel.action && (
                <p className="line-clamp-4 leading-snug text-[var(--ds-ink)] opacity-80">{clip(panel.action, 140)}</p>
              )}
              {width > 220 && lines > 0 && (
                <p className="mt-auto text-[0.85em] text-[var(--ds-muted)]">
                  {lines} {lines === 1 ? 'line' : 'lines'}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const ComicPageView: React.FC<ComicPageViewProps> = ({
  doc,
  page,
  imageUrl,
  editable = false,
  onBalloonChange,
  className,
  overlay,
  children,
  hideLettering,
  selectedLineId,
  onSelectLine,
  loading = 'lazy',
  onImageError,
  develop = true,
  style,
  alt,
  onAspectChange
}) => {
  const [boxRef, size] = useElementSize<HTMLDivElement>();
  const [natural, setNatural] = useState<{ path: string; w: number; h: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const assetPath = page.render.asset?.path;
  // Adopt the real pixel ratio once the image is known (models snap to their nearest supported aspect).
  const naturalAspect = natural && natural.path === assetPath && natural.w > 0 && natural.h > 0 ? natural.w / natural.h : 0;
  const aspect = naturalAspect || pageAspectOf(doc, page);
  const width = size.width || FALLBACK_WIDTH;
  const height = size.height || width / aspect;
  const showImage = !!imageUrl && failed !== imageUrl;
  const waitingForUrl = !imageUrl && !!assetPath;
  const lettering = doc.format.lettering === 'overlay' && showImage && !hideLettering;

  const img = showImage ? (
    <img
      src={imageUrl}
      alt={alt || `Page ${page.n}${page.summary ? ` — ${page.summary}` : ''}`}
      loading={loading}
      decoding="async"
      draggable={false}
      className="absolute inset-0 h-full w-full select-none object-contain"
      onLoad={(e) => {
        const el = e.currentTarget;
        if (assetPath && el.naturalWidth > 0 && el.naturalHeight > 0) {
          setNatural({ path: assetPath, w: el.naturalWidth, h: el.naturalHeight });
          onAspectChange?.(el.naturalWidth / el.naturalHeight);
        }
      }}
      onError={() => {
        setFailed(imageUrl || null);
        onImageError?.();
      }}
    />
  ) : null;

  return (
    <div
      ref={boxRef}
      data-testid="comic-page"
      data-page-id={page.id}
      className={cx('relative w-full overflow-hidden bg-white', className)}
      style={{ aspectRatio: String(aspect), ...style }}
    >
      {showImage ? (
        // Keyed by asset: a new render remounts (and develops in when it just landed); the
        // wrapper never changes shape as time passes, so the image is never re-created.
        <div className="absolute inset-0">
          <ImageDevelop key={assetPath || imageUrl} active={develop && isFreshRender(page.render)} className="h-full w-full" rounded="rounded-none">
            {img}
          </ImageDevelop>
        </div>
      ) : waitingForUrl && failed === null ? (
        <div className="studio-shimmer absolute inset-0" aria-label="Loading page image" role="img" />
      ) : (
        <div className="absolute inset-0 bg-[var(--ds-surface-strong)]">
          <PlanSketch doc={doc} page={page} width={width} />
          {failed && (
            <p className="absolute inset-x-2 bottom-2 rounded-lg bg-[var(--ds-surface-strong)] px-2 py-1 text-center text-[11px] text-[var(--ds-muted)] shadow-sm">
              Couldn’t load this image — it will retry with a fresh link.
            </p>
          )}
        </div>
      )}
      {lettering && (
        <BalloonLayer
          doc={doc}
          page={page}
          pageWidth={width}
          pageHeight={height}
          editable={editable}
          onBalloonChange={onBalloonChange}
          selectedLineId={selectedLineId}
          onSelectLine={onSelectLine}
        />
      )}
      {children}
      {overlay}
    </div>
  );
};
