// A platform library image with a procedural fallback (contract §13.3, assets.md §6; owner P1-LIBRARY).
//
// Three tiers, never blank: the published library image when there is one, else the caller's
// procedural art (PresetThumb, EmptyArt, …), which itself sits on the preset's CSS gradient.
// While the image loads the fallback stays visible underneath and the image fades in over it
// (no layout shift: the row's w/h are set, the box is the caller's). On error, or when the
// asset isn't published, only the fallback renders. Light-only art is gently dimmed in dark mode.

import React, { useEffect, useState } from 'react';
import { useComicLibrary } from './useComicLibrary';

export interface LibraryImageProps {
  /** Library id, e.g. "style.watercolor-storybook". */
  id: string;
  sizes?: string;
  /** Shown while loading, on error and when the asset is missing. */
  fallback: React.ReactNode;
  className?: string;
  alt?: string;
}

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export const LibraryImage: React.FC<LibraryImageProps> = ({ id, sizes, fallback, className, alt }) => {
  const library = useComicLibrary();
  const asset = library.get(id);
  const key = asset ? `${asset.id}@${asset.rev}` : '';
  const [state, setState] = useState<{ key: string; phase: 'loading' | 'loaded' | 'error' }>({ key, phase: 'loading' });
  useEffect(() => {
    setState((s) => (s.key === key ? s : { key, phase: 'loading' }));
  }, [key]);
  const phase = state.key === key ? state.phase : 'loading';

  if (!asset || phase === 'error') return <>{fallback}</>;

  const srcSet = [
    asset.thumbs[320] ? `${asset.thumbs[320]} 320w` : '',
    asset.thumbs[640] ? `${asset.thumbs[640]} 640w` : '',
    asset.w > 0 ? `${asset.url} ${asset.w}w` : ''
  ]
    .filter(Boolean)
    .join(', ');
  const loaded = phase === 'loaded';
  return (
    <span className="relative block h-full w-full" data-library-image={asset.id}>
      <span className={cx('block h-full w-full', loaded && 'invisible')} aria-hidden={loaded || undefined}>
        {fallback}
      </span>
      <img
        src={asset.thumbs[640] || asset.url}
        srcSet={srcSet || undefined}
        sizes={sizes || '(max-width: 640px) 50vw, 320px'}
        width={asset.w || undefined}
        height={asset.h || undefined}
        alt={alt ?? asset.alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onLoad={() => setState({ key, phase: 'loaded' })}
        onError={() => setState({ key, phase: 'error' })}
        className={cx(
          'absolute inset-0 h-full w-full',
          !/\bobject-/.test(className || '') && 'object-cover',
          className,
          asset.theme === 'light' && 'dark:brightness-90 dark:contrast-95',
          'motion-safe:transition-opacity motion-safe:duration-300',
          loaded ? 'opacity-100' : 'opacity-0'
        )}
      />
    </span>
  );
};

export default LibraryImage;
