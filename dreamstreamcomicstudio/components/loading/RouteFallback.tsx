/**
 * RouteFallback — what a top-level view shows while its code arrives (App's route Suspense). Shaped like
 * the destination, as Atlas's PageBodySkeleton is, so the page settles into place instead of jumping:
 *
 *   library   a page title and a grid of cover cards  (your comics, the comic library, a profile, models)
 *   article   an overline, a title and paragraphs     (privacy, terms, How it works, Learn)
 *   settings  a section list and a form card           (settings)
 *   studio    the studio's mark and its name           (full-bleed studios and readers: ContentLoader)
 *
 * It renders in the content area, under the site header, which stays put. It fades in after a beat, so a
 * cached view never flashes it; the skeleton blocks are hidden from assistive tech and the region says
 * what is loading in words. The wake hint appears when the server is cold.
 */
import React from 'react';
import { cn } from '../../lib/utils';
// Direct imports, not the components/ds barrel: this module is in the first-paint bundle.
import { SECTION_CARD } from '../ds/recipes';
import { Skeleton } from '../ds/Skeleton';
import type { Studio } from '../brand/studios';
import { ContentLoader, DEFER_IN, FILL_BELOW_HEADER } from './AppLoader';
import { WakeHint } from './WakeHint';

export type RouteShape = 'library' | 'article' | 'settings' | 'studio';

export interface RouteLoading {
  shape: RouteShape;
  /** Said aloud (and shown, for the studio shape). */
  label: string;
  /** The studio shape's mark. */
  studio?: Studio;
  /** The studio shape on a view without the site header fills the screen. */
  fill?: 'content' | 'viewport';
}

/** Per view (App's AppView names). Anything unlisted gets DEFAULT_ROUTE_LOADING. */
export const ROUTE_LOADING: Readonly<Record<string, RouteLoading>> = {
  dashboard: { shape: 'library', label: 'Loading your comics…' },
  gallery: { shape: 'library', label: 'Loading the comic library…' },
  profile: { shape: 'library', label: 'Loading this profile…' },
  models: { shape: 'library', label: 'Loading the model library…' },
  privacy: { shape: 'article', label: 'Loading the privacy policy…' },
  terms: { shape: 'article', label: 'Loading the terms of service…' },
  'how-it-works': { shape: 'article', label: 'Loading How it works…' },
  learn: { shape: 'article', label: 'Loading Learn…' },
  settings: { shape: 'settings', label: 'Loading your settings…' },
  chat: { shape: 'studio', label: 'Opening Chat Studio…', studio: 'dreamstream', fill: 'viewport' },
  comicstudio: { shape: 'studio', label: 'Opening your comic…', studio: 'comic', fill: 'viewport' },
  editor: { shape: 'studio', label: 'Opening your comic…', studio: 'comic', fill: 'viewport' },
  pagestudio: { shape: 'studio', label: 'Opening your comic…', studio: 'comic', fill: 'viewport' },
  reader: { shape: 'studio', label: 'Opening the comic…', studio: 'comic', fill: 'viewport' },
  shared: { shape: 'studio', label: 'Opening the comic…', studio: 'comic', fill: 'viewport' },
  // The home view is only lazy on the comics host (its own front page).
  home: { shape: 'studio', label: 'Loading Comic Studio…', studio: 'comic' }
};

export const DEFAULT_ROUTE_LOADING: RouteLoading = { shape: 'studio', label: 'Loading…', studio: 'dreamstream' };

export const routeLoadingFor = (view: string): RouteLoading =>
  Object.prototype.hasOwnProperty.call(ROUTE_LOADING, view) ? ROUTE_LOADING[view] : DEFAULT_ROUTE_LOADING;

function SkeletonFrame({ shape, label, className, children }: { shape: RouteShape; label: string; className: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-slot="route-fallback" data-shape={shape} className={cn('w-full bg-ds-canvas', FILL_BELOW_HEADER, DEFER_IN)}>
      <span className="sr-only">{label}</span>
      <div className={className}>
        <WakeHint className="mb-6" />
        {children}
      </div>
    </div>
  );
}

/** The page title block every shaped skeleton opens with: an overline, then the title. */
function TitleBlock({ wide = false }: { wide?: boolean }) {
  return (
    <div className="min-w-0 flex-1 space-y-3">
      <Skeleton shape="text" className="h-3 w-24" />
      <Skeleton className={wide ? 'h-9 w-4/5 max-w-lg' : 'h-8 w-3/4 max-w-xs'} />
    </div>
  );
}

const LIBRARY_CARDS = 8;

function LibrarySkeleton({ label }: { label: string }) {
  return (
    <SkeletonFrame shape="library" label={label} className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex items-end justify-between gap-4">
        <TitleBlock />
        <Skeleton className="h-9 w-28 shrink-0" />
      </div>
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
        {Array.from({ length: LIBRARY_CARDS }, (_, i) => (
          // Two rows at every width: 4 cards on a phone, 6 on a tablet, 8 on a desktop.
          <div key={i} className={i >= 6 ? 'hidden lg:block' : i >= 4 ? 'hidden sm:block' : undefined}>
            <Skeleton className="aspect-[3/4] w-full rounded-[var(--ds-radius-feature)]" />
            <Skeleton shape="text" className="mt-3 w-3/4" />
            <Skeleton shape="text" className="mt-2 h-3 w-1/2" />
          </div>
        ))}
      </div>
    </SkeletonFrame>
  );
}

const ARTICLE_LINES = ['w-full', 'w-11/12', 'w-full', 'w-2/3'];

function ArticleSkeleton({ label }: { label: string }) {
  return (
    <SkeletonFrame shape="article" label={label} className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <TitleBlock wide />
      <div className="mt-6 space-y-3">
        <Skeleton shape="text" className="w-full" />
        <Skeleton shape="text" className="w-5/6" />
      </div>
      {[0, 1].map((section) => (
        <div key={section} className="mt-10 space-y-3">
          <Skeleton className="mb-5 h-6 w-1/2 max-w-xs" />
          {ARTICLE_LINES.map((width, i) => (
            <Skeleton key={i} shape="text" className={width} />
          ))}
        </div>
      ))}
    </SkeletonFrame>
  );
}

function SettingsSkeleton({ label }: { label: string }) {
  return (
    <SkeletonFrame shape="settings" label={label} className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <TitleBlock />
      <div className="mt-8 grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        {/* Phones: the sections are a row of tabs; wider: a list beside the panel. */}
        <div className="flex gap-2 overflow-hidden md:hidden">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-24 shrink-0" />
          ))}
        </div>
        <div className="hidden space-y-2 md:block">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
        <div className={cn(SECTION_CARD, 'p-5 sm:p-6')}>
          <Skeleton className="h-6 w-40" />
          <Skeleton shape="text" className="mt-3 w-2/3" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="mt-6 space-y-2">
              <Skeleton shape="text" className="h-3 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <div className="mt-8 flex justify-end border-t border-ds-hairline pt-5">
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
      </div>
    </SkeletonFrame>
  );
}

export function RouteFallback({ view }: { view: string }) {
  const route = routeLoadingFor(view);
  switch (route.shape) {
    case 'library':
      return <LibrarySkeleton label={route.label} />;
    case 'article':
      return <ArticleSkeleton label={route.label} />;
    case 'settings':
      return <SettingsSkeleton label={route.label} />;
    default:
      return <ContentLoader label={route.label} studio={route.studio} fill={route.fill} />;
  }
}
