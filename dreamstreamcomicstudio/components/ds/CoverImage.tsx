/**
 * CoverImage — the only `<img>` for a comic's cover (redesign plan §4; PROGRAM3 §3.5 amendment "DS-R1";
 * styles.md §7.3 M1 and amendment A1). It replaces components/common/SmartImage for covers, which preloaded every
 * cover eagerly with `new Image()`, spun a legacy spinner and swapped a `<div>` for an `<img>` (a layout shift and
 * a pop). Here:
 *
 *   - the box is reserved before anything loads: the aspect (2:3 by default) and the comic's own tint (`artColor`,
 *     painted through ART_PLACEHOLDER / --ds-art; the neutral well when none is given), so nothing moves;
 *   - covers load lazily, except the first row (`priority`: eager, high fetch priority);
 *   - `srcSet` offers the 480 and 1080 px variants (server/src/comic/assets.ts VARIANT_WIDTHS) with the caller's
 *     `sizes`; under Save-Data only the 480 px one;
 *   - with `resolve` (sign-when-visible, as timeline/MediaBin does), the URLs are asked for only once the box comes
 *     near the viewport, and only once per picture: a 300-cover shelf signs what is seen. It stays a prop: once
 *     PF-4 lands (S3) it becomes a pure URL builder and nothing here changes;
 *   - a publication card (`publication`) shows only published art: a path outside `pub/<key>/` (a draft, a
 *     history version, someone's private upload) is refused and never becomes an `<img>`;
 *   - the picture is revealed through components/ds/useImageReveal (MO-1): it waits for `load` and `decode()`, then
 *     fades in (and settles from 102 % on fine pointers) on --ds-motion-enter, following LibraryImage's pattern.
 *     A cover the browser already holds swaps in with no entrance, and under reduced motion nothing animates;
 *   - a cover that fails to load shows the line-art EmptyArt in the same box, never a broken image.
 *
 * RevealImage and useNearViewport are exported for MediaTile, which follows the same rules for any art.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmptyArt, type EmptyArtVariant } from '../comicstudio/library/procedural/EmptyArt';
import { cn } from '../../lib/utils';
import { ART_PLACEHOLDER } from './recipes';
import { isCoarsePointer, motionEase, motionMs, playEntrance, revealTokenFallbacks, useImageReveal } from './useImageReveal';

/** The cover variants the server makes at save time. */
export const COVER_WIDTHS = [480, 1080] as const;
export type CoverWidth = (typeof COVER_WIDTHS)[number];

/** A published object path, `pub/<22-char base62 key>/<file>` (as components/comicstudio/export/publicDownload.ts). */
export const PUBLICATION_PATH_RE = /^pub\/[A-Za-z0-9]{22}\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const PUBLICATION_URL_PATH_RE = /\/pub\/[A-Za-z0-9]{22}\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const LOCAL_HTTP = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i;

/**
 * Whether a cover source may be shown on a publication card: a `pub/` path, or an https URL (plain http only on a
 * local dev server) whose path ends in one. Anything else (`u/<user>/…`, a data: URL, a relative path) is refused.
 */
export function isPublicationCoverSource(source: string | null | undefined): boolean {
  if (typeof source !== 'string' || !source || source.includes('..')) return false;
  if (PUBLICATION_PATH_RE.test(source)) return true;
  if (!/^https:\/\//i.test(source) && !LOCAL_HTTP.test(source)) return false;
  try {
    return PUBLICATION_URL_PATH_RE.test(new URL(source).pathname);
  } catch {
    return false;
  }
}

/** The key a picture is revealed under: its stored path, or its URL without the query (a re-signed URL is the same file). */
export const revealKeyOf = (path: string | null | undefined, url: string | null | undefined): string =>
  path || (url ? url.split(/[?#]/)[0] : '');

/** True once `ref`'s element has come within `rootMargin` of the viewport (and stays true); at once without IO. */
export function useNearViewport<T extends Element>(rootMargin = '300px', enabled = true): [React.RefCallback<T>, boolean] {
  const [near, setNear] = useState(!enabled);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (el: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el || near || !enabled) return;
      if (typeof IntersectionObserver === 'undefined') {
        setNear(true);
        return;
      }
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setNear(true);
            observer.current?.disconnect();
          }
        },
        { rootMargin }
      );
      observer.current.observe(el);
    },
    [rootMargin, near, enabled]
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, near || !enabled];
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface RevealImageProps {
  src: string;
  srcSet?: string;
  sizes?: string;
  alt: string;
  /** The picture's identity (stored path): a new key starts the reveal over. */
  revealKey: string;
  /** First row: eager, high fetch priority. Everything else is lazy. */
  priority?: boolean;
  fit?: 'cover' | 'contain';
  width?: number;
  height?: number;
  /** Shown in place of the picture once it fails to load. */
  fallback: React.ReactNode;
  className?: string;
}

/**
 * An `<img>` that is shown only once it has loaded and decoded, then plays the art entrance (LibraryImage's
 * pattern: opacity 0 → 1 on --ds-motion-enter with the enter curve, plus a 2 % settle on fine pointers; no
 * entrance for a cached picture or under reduced motion). On error it renders `fallback` instead.
 */
export function RevealImage({ src, srcSet, sizes, alt, revealKey, priority = false, fit = 'cover', width, height, fallback, className }: RevealImageProps) {
  const reveal = useImageReveal(revealKey);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const setImg = useCallback(
    (node: HTMLImageElement | null) => {
      imgRef.current = node;
      reveal.ref(node);
    },
    [reveal.ref]
  );
  const revealed = reveal.phase === 'revealed';

  useIsoLayoutEffect(() => {
    if (!revealed || reveal.fromCache || reveal.reduced) return;
    const img = imgRef.current;
    const animation = playEntrance(img, [{ opacity: 0, transform: isCoarsePointer() ? 'none' : 'scale(1.02)' }, { opacity: 1, transform: 'none' }], {
      duration: motionMs(img, '--ds-motion-enter', revealTokenFallbacks['--ds-motion-enter']),
      easing: motionEase(img, '--ds-ease-enter', revealTokenFallbacks['--ds-ease-enter']),
      fill: 'backwards'
    });
    return () => animation?.cancel();
    // fromCache and reduced are read once, when the picture is revealed: a later change never replays it.
  }, [revealed, revealKey]);

  if (reveal.phase === 'error') return <>{fallback}</>;
  return (
    <img
      key={revealKey}
      ref={setImg}
      src={src}
      srcSet={srcSet || undefined}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      draggable={false}
      data-reveal={reveal.phase}
      className={cn('absolute inset-0 h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover', reveal.shown ? 'opacity-100' : 'opacity-0', className)}
    />
  );
}

export interface CoverSources {
  w480?: string | null;
  w1080?: string | null;
  /** The original (no variants yet). */
  src?: string | null;
}

export interface CoverImageProps {
  /** The cover's stored path (`pub/<key>/cover.webp` on a publication): its identity and the publication check. */
  path?: string | null;
  /** URLs already in hand. */
  sources?: CoverSources | null;
  /** Sign-when-visible: a URL for a width, asked only once the box is near the viewport, once per picture. */
  resolve?: (width: CoverWidth) => string | null | undefined;
  /** A public card: only `pub/` art is shown. */
  publication?: boolean;
  /** The first row: load now (eager, high fetch priority). */
  priority?: boolean;
  /** Decorative by default: the card's heading names the comic. */
  alt?: string;
  sizes?: string;
  /** CSS aspect-ratio of the reserved box. */
  aspect?: string;
  /** The comic's own tint (any CSS colour) for the box while the cover arrives; the neutral well by default. */
  artColor?: string | null;
  /** The line-art drawing shown when there is no cover, it failed to load or it was refused. */
  emptyArt?: EmptyArtVariant;
  /** Save-Data / low memory: the 480 px variant only. */
  saveData?: boolean;
  fit?: 'cover' | 'contain';
  className?: string;
}

/** The reserved box: the comic's tint until the cover arrives; it clips the cover to the card's radius. */
export const COVER_BOX = `relative block w-full overflow-hidden ${ART_PLACEHOLDER}`;

/** Inline style for the reserved box: its aspect and, when given, the comic's tint as --ds-art. */
export function artBoxStyle(aspect: string, artColor?: string | null): React.CSSProperties {
  const style: React.CSSProperties & Record<string, string> = { aspectRatio: aspect };
  if (typeof artColor === 'string' && artColor.trim() && !/[;{}<>]/.test(artColor)) style['--ds-art'] = artColor.trim();
  return style;
}

export function CoverImage({
  path,
  sources,
  resolve,
  publication = false,
  priority = false,
  alt = '',
  sizes = '(max-width: 599px) 50vw, (max-width: 1279px) 25vw, 240px',
  aspect = '2 / 3',
  artColor,
  emptyArt = 'reader',
  saveData = false,
  fit = 'cover',
  className
}: CoverImageProps) {
  // A publication card never signs or shows art outside pub/ (a draft, a history version, a private upload).
  const pathRefused = publication && !!path && !isPublicationCoverSource(path);
  const hasResolver = !!resolve && !pathRefused;
  const [boxRef, near] = useNearViewport<HTMLSpanElement>('300px', !priority && hasResolver);
  // resolve is read through a ref: a new function identity on every parent render never re-signs a cover.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const widths: readonly CoverWidth[] = saveData ? [480] : COVER_WIDTHS;

  const resolved = useMemo<CoverSources | null>(() => {
    if (!hasResolver || !near) return null;
    const r = resolveRef.current;
    if (!r) return null;
    const out: CoverSources = {};
    for (const w of widths) {
      const url = r(w);
      if (typeof url === 'string' && url) out[w === 480 ? 'w480' : 'w1080'] = url;
    }
    return out;
    // Once per picture: the path (or, without one, the variant set) and whether it is near.
  }, [hasResolver, near, path, saveData]);

  const all = resolved ?? (pathRefused ? null : sources) ?? null;
  const w480 = all?.w480 || null;
  const w1080 = saveData ? null : all?.w1080 || null;
  const src = w480 || all?.src || w1080 || null;
  const urls = [w480, w1080, all?.src].filter((u): u is string => typeof u === 'string' && !!u);
  // URLs built by the caller's resolver from a checked pub/ path are trusted; URLs handed in are checked themselves.
  const urlsRefused = publication && (!path || !resolved) && urls.some((u) => !isPublicationCoverSource(u));
  const refused = pathRefused || urlsRefused;
  const srcSet = [w480 ? `${w480} 480w` : '', w1080 ? `${w1080} 1080w` : ''].filter(Boolean).join(', ');
  const empty = (
    <span aria-hidden="true" data-slot="cover-empty" className="absolute inset-0 flex items-center justify-center p-[12%] text-[var(--ds-muted)] [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-24">
      <EmptyArt variant={emptyArt} />
    </span>
  );
  const state = refused ? 'refused' : src ? 'image' : hasResolver && !near ? 'waiting' : 'empty';

  return (
    <span ref={boxRef} data-slot="cover-image" data-cover={state} className={cn(COVER_BOX, className)} style={artBoxStyle(aspect, artColor)}>
      {state === 'image' && src ? (
        <RevealImage
          src={src}
          srcSet={srcSet && (w480 || w1080) ? srcSet : undefined}
          sizes={sizes}
          alt={alt}
          revealKey={revealKeyOf(path, src)}
          priority={priority}
          fit={fit}
          fallback={empty}
        />
      ) : state === 'waiting' ? null : (
        empty
      )}
    </span>
  );
}
