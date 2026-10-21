// A rendered image (sheet, style board, cover) at its true aspect: object-contain inside
// an aspect box, developing in when the render just landed, with a placeholder and a
// status layer slot.

import React, { useState } from 'react';
import type { RenderState } from '../../../shared/comic/doc';
import { ImageDevelop } from '../../studio/kit/streamMotion';
import { isFreshRender } from './boardModel';
import { cx } from './ui';

export interface ImageFrameProps {
  url?: string;
  /** Width / height, or a CSS aspect-ratio string ("3 / 2"). */
  aspect: number | string;
  alt: string;
  render?: RenderState;
  /** Shown when there is no image to display. */
  placeholder?: React.ReactNode;
  overlay?: React.ReactNode;
  className?: string;
  /** Background behind letterboxed images. */
  tone?: 'paper' | 'well';
  onClick?: () => void;
  clickLabel?: string;
}

export const ImageFrame: React.FC<ImageFrameProps> = ({ url, aspect, alt, render, placeholder, overlay, className, tone = 'well', onClick, clickLabel }) => {
  const [broken, setBroken] = useState<string | null>(null);
  const showImage = !!url && broken !== url;
  const waiting = !url && !!render?.asset?.path;
  const img = showImage ? (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className="absolute inset-0 h-full w-full object-contain"
      onError={() => setBroken(url || null)}
    />
  ) : null;
  const body = showImage ? (
    <div className="absolute inset-0">
      <ImageDevelop key={render?.asset?.path || url} active={isFreshRender(render)} className="h-full w-full" rounded="rounded-none">
        {img}
      </ImageDevelop>
    </div>
  ) : waiting ? (
    <div className="studio-shimmer absolute inset-0" role="img" aria-label={`Loading ${alt}`} />
  ) : (
    <div className="absolute inset-0">{placeholder}</div>
  );
  const frame = cx(
    'relative w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)]',
    tone === 'paper' ? 'bg-white' : 'bg-[var(--ds-well)]',
    className
  );
  const style = { aspectRatio: typeof aspect === 'number' ? String(aspect) : aspect };
  if (onClick && showImage) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={clickLabel || alt}
        className={cx(frame, 'block text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45')}
        style={style}
      >
        {body}
        {overlay}
      </button>
    );
  }
  return (
    <div className={frame} style={style}>
      {body}
      {overlay}
    </div>
  );
};

/** Version thumbnails (current first, then history); click restores one. */
export const VersionStrip: React.FC<{
  render: RenderState;
  urlFor: (path: string) => string | undefined;
  onRestore: (path: string) => void;
  aspect: number | string;
  label?: string;
  disabled?: boolean;
  className?: string;
}> = ({ render, urlFor, onRestore, aspect, label = 'Versions', disabled, className }) => {
  const versions = [...(render.asset ? [render.asset] : []), ...render.history.filter((a) => a.path !== render.asset?.path)];
  if (versions.length < 2) return null;
  return (
    <div className={className}>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</p>
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {versions.map((a, i) => {
          const current = i === 0;
          const u = urlFor(a.path);
          return (
            <li key={a.path} className="shrink-0">
              <button
                type="button"
                disabled={disabled || current}
                onClick={() => onRestore(a.path)}
                aria-label={current ? 'Current version' : `Restore version ${i}`}
                title={current ? 'Current version' : 'Restore this version'}
                className={cx(
                  'relative block w-16 overflow-hidden rounded-lg border bg-[var(--ds-well)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45',
                  current ? 'border-[var(--ds-accent)] ring-1 ring-[var(--ds-accent)]' : 'border-[var(--ds-hairline)] hover:border-[#D97757]/50 disabled:opacity-50'
                )}
                style={{ aspectRatio: typeof aspect === 'number' ? String(aspect) : aspect }}
              >
                {u ? <img src={u} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain" /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
                {current && <span className="absolute inset-x-0 bottom-0 bg-[var(--ds-accent)] py-px text-center text-[9px] font-semibold text-white">Current</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
