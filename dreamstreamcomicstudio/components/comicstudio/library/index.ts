// Client feature module: platform asset library and procedural art (cards: style_presets; admin
// section: library). Owner: P1-LIBRARY. Registered through ../features.ts (contract §13.2).
//
// The admin console is code-split: studio users never download it, and admins load it the first
// time they open Admin → Library. The server re-checks requireAdmin on every library call.

import React, { Suspense } from 'react';
import { Images, Loader2 } from 'lucide-react';
import type { FeatureModule } from '../extensions';
import { StylePresetsCard } from './StylePresetsCard';

const LazyLibraryConsole = React.lazy(() => import('./admin/LibraryConsole').then((m) => ({ default: m.LibraryConsole })));

/** Admin → Library section (lazy). */
export const LibraryAdminSection: React.FC = () =>
  React.createElement(
    Suspense,
    {
      fallback: React.createElement(
        'div',
        { className: 'flex items-center gap-2 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 text-[13px] text-[var(--ds-muted)]' },
        React.createElement(Loader2, { className: 'h-4 w-4 animate-spin', 'aria-hidden': true }),
        'Loading the library console…'
      )
    },
    React.createElement(LazyLibraryConsole)
  );

export const feature: FeatureModule = {
  cards: [{ type: 'style_presets', Component: StylePresetsCard }],
  adminSections: [{ id: 'library', label: 'Library', icon: React.createElement(Images, { size: 15 }), Component: LibraryAdminSection }]
};

export { StylePresetsCard, STYLE_PRESETS_FREE_NOTE } from './StylePresetsCard';
export { LibraryImage } from './LibraryImage';
export type { LibraryImageProps } from './LibraryImage';
export { useComicLibrary, loadComicLibrary, libraryApi, sanitizeIndex } from './useComicLibrary';
export type { ComicLibrary } from './useComicLibrary';
export { PresetThumb } from './procedural/PresetThumb';
export { LayoutGlyph } from './procedural/LayoutGlyph';
export { BubblePreview } from './procedural/BubblePreview';
export { EmptyArt } from './procedural/EmptyArt';
export type { EmptyArtVariant } from './procedural/EmptyArt';
export * as textures from './procedural/textures';
