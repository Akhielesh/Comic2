// A platform library image with a procedural fallback (contract §13.3, assets.md §6; owner P1-LIBRARY).
//
// Three tiers, never blank: the published library image when there is one, else the caller's
// procedural art (PresetThumb, EmptyArt, …), which itself sits on the preset's CSS gradient.
// While the image loads and decodes the fallback stays visible underneath; only once the picture is
// decoded (components/ds/useImageReveal) does it fade in over it (opacity, plus a 2 % settle on fine
// pointers; none under reduced motion, none for a picture the browser already holds), and when that
// entrance has finished the fallback is unmounted, freeing its SVG filters (styles.md §7.3 M12). No
// layout shift: the row's w/h are set, the box is the caller's (and it keeps its size once the
// fallback is gone). On error, or when the asset isn't published, only the fallback renders.
// Light-only art is gently dimmed in dark mode.

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  isCoarsePointer,
  motionEase,
  motionMs,
  playEntrance,
  revealTokenFallbacks,
  useImageReveal
} from '../../ds/useImageReveal';
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
  const reveal = useImageReveal(key, { enabled: !!asset });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const setImg = useCallback(
    (node: HTMLImageElement | null) => {
      imgRef.current = node;
      reveal.ref(node);
    },
    [reveal.ref]
  );
  // The key whose entrance has finished: from then on the fallback is out of the DOM.
  const [settledKey, setSettledKey] = useState('');
  const revealed = !!asset && reveal.phase === 'revealed';

  useLayoutEffect(() => {
    if (!revealed) return;
    const img = imgRef.current;
    const settle = () => setSettledKey(key);
    if (reveal.fromCache || reveal.reduced) {
      settle();
      return;
    }
    const animation = playEntrance(img, [{ opacity: 0, transform: isCoarsePointer() ? 'none' : 'scale(1.02)' }, { opacity: 1, transform: 'none' }], {
      duration: motionMs(img, '--ds-motion-enter', revealTokenFallbacks['--ds-motion-enter']),
      easing: motionEase(img, '--ds-ease-enter', revealTokenFallbacks['--ds-ease-enter']),
      fill: 'backwards'
    });
    if (!animation) {
      settle();
      return;
    }
    let live = true;
    const done = () => {
      if (live) settle();
    };
    animation.finished.then(done, done);
    return () => {
      live = false;
      animation.cancel();
    };
    // fromCache and reduced are read once, when the picture is revealed: a later change never replays it.
  }, [revealed, key]);

  if (!asset || reveal.phase === 'error') return <>{fallback}</>;

  const srcSet = [
    asset.thumbs[320] ? `${asset.thumbs[320]} 320w` : '',
    asset.thumbs[640] ? `${asset.thumbs[640]} 640w` : '',
    asset.w > 0 ? `${asset.url} ${asset.w}w` : ''
  ]
    .filter(Boolean)
    .join(', ');
  const settled = revealed && settledKey === key;
  return (
    <span className="relative block h-full w-full" data-library-image={asset.id} data-reveal={reveal.phase}>
      {/* The image carries the alt text, so the fallback underneath is decoration (never read twice). */}
      {!settled && (
        <span className="block h-full w-full" aria-hidden="true">
          {fallback}
        </span>
      )}
      <img
        ref={setImg}
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
        className={cx(
          'absolute inset-0 h-full w-full',
          !/\bobject-/.test(className || '') && 'object-cover',
          className,
          asset.theme === 'light' && 'dark:brightness-90 dark:contrast-95',
          reveal.shown ? 'opacity-100' : 'opacity-0'
        )}
      />
    </span>
  );
};

export default LibraryImage;
