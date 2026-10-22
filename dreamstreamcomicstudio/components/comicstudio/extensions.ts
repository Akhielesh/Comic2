// Client extension registries (contract §13.2; created by P0-C, FROZEN after wave 0).
//
// Feature packages never edit the hotspot files (CardRenderer, BoardPane, ComicStudio,
// AdminConsole). Instead each feature folder exports one `FeatureModule` from its
// `index.ts`, and `features.ts` folds every module into the registries those hotspots read:
//   - cards:          conversation cards by `Card['type']` (built-in types always win)
//   - tabs:           extra board tabs (media, languages), merged with the built-ins by `order`
//   - headerSlots:    studio header controls (share, mode, savings), merged by `order`
//   - adminSections:  admin console sections (admin-only; the server re-checks requireAdmin)
// An empty module (`{}`) contributes nothing, so wave 0 renders exactly as before.

import type React from 'react';
import type { Card, ComicDoc, Msg, StudioTab } from '../../shared/comic/doc';
import type { StudioCaps } from '../../shared/comic/capabilities';
import type { StudioController } from './types';

export interface CardProps<C extends Card = Card> {
  card: C;
  message: Msg;
  studio: StudioController;
}

export interface CardRegistration {
  type: Card['type'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: React.ComponentType<CardProps<any>>;
}

export interface BoardTabRegistration {
  id: StudioTab;
  label: string;
  icon: React.ReactNode;
  order: number;
  Component: React.ComponentType<{ studio: StudioController }>;
  /** Hidden until relevant (media: any asset exists; languages: an edition exists or the user opened it). */
  visible?(doc: ComicDoc, caps: StudioCaps): boolean;
}

export interface HeaderSlotRegistration {
  id: 'share' | 'mode' | 'savings' | string;
  order: number;
  Component: React.ComponentType<{ studio: StudioController; compact: boolean }>;
}

export interface AdminSectionRegistration {
  id: string;
  label: string;
  icon: React.ReactNode;
  Component: React.ComponentType;
}

export interface FeatureModule {
  cards?: CardRegistration[];
  tabs?: BoardTabRegistration[];
  headerSlots?: HeaderSlotRegistration[];
  adminSections?: AdminSectionRegistration[];
}
