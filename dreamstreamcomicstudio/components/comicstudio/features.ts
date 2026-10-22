// Feature registry (contract §13.2; created by P0-C, FROZEN after wave 0).
//
// Imports exactly the ten client feature indexes and folds their `FeatureModule`s into the
// registries the hotspot files read (CardRenderer, BoardPane, ComicStudio header,
// AdminConsole). A wave-1 package fills its own `<feature>/index.ts`; nothing here changes.
//
// The registries are built lazily on first read (not at import time), so a feature module
// that imports a hotspot file — directly or through a component — never sees a
// half-initialized registry through an import cycle.
//
// Rules:
//   - Built-ins win: a registration that reuses a built-in card type / tab id is ignored.
//   - First registration wins for a duplicate id (feature order below = precedence).
//   - Tabs, header slots and admin sections are sorted by `order` (stable; ties keep
//     feature order). Admin sections have no order: they keep feature order.

import type { Card, StudioTab } from '../../shared/comic/doc';
import type {
  AdminSectionRegistration,
  BoardTabRegistration,
  CardRegistration,
  FeatureModule,
  HeaderSlotRegistration
} from './extensions';
import { feature as breakdown } from './breakdown/index';
import { feature as lettering } from './lettering/index';
import { feature as timeline } from './timeline/index';
import { feature as refs } from './refs/index';
import { feature as share } from './share/index';
import { feature as safety } from './safety/index';
import { feature as i18n } from './i18n/index';
import { feature as immersive } from './immersive/index';
import { feature as library } from './library/index';
import { feature as mobile } from './mobile/index';

export type {
  AdminSectionRegistration,
  BoardTabRegistration,
  CardProps,
  CardRegistration,
  FeatureModule,
  HeaderSlotRegistration
} from './extensions';

/** Card types CardRenderer renders itself (the original seven plus `recap`). */
export const BUILTIN_CARD_TYPES: ReadonlySet<Card['type']> = new Set<Card['type']>([
  'options',
  'style_choice',
  'cast',
  'plan',
  'gate',
  'renders',
  'notice',
  'recap'
]);

/** Board tabs BoardPane renders itself, with their merge positions for registered tabs. */
export const BUILTIN_TAB_ORDER: Readonly<Partial<Record<StudioTab, number>>> = {
  story: 100,
  cast: 200,
  style: 300,
  pages: 400,
  read: 900
};

/**
 * Merge positions of the built-in header controls. A slot with `order` o renders after every
 * built-in whose position is ≤ o (e.g. 250 sits between the spend chip and Read; < 100 comes
 * first; ≥ 900 comes after the More menu).
 */
export const BUILTIN_HEADER_ORDER = { quality: 100, spend: 200, read: 300, more: 900 } as const;

interface Registries {
  cards: ReadonlyMap<Card['type'], CardRegistration>;
  tabs: readonly BoardTabRegistration[];
  headerSlots: readonly HeaderSlotRegistration[];
  adminSections: readonly AdminSectionRegistration[];
}

let cache: Registries | null = null;

/** Every feature module, in precedence order. */
export const featureModules = (): readonly FeatureModule[] =>
  [breakdown, lettering, timeline, refs, share, safety, i18n, immersive, library, mobile].map((m) => m || {});

const byOrder = <T extends { order: number }>(list: T[]): T[] =>
  list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.order - b.item.order) || (a.i - b.i))
    .map((x) => x.item);

const warnDuplicate = (kind: string, id: string) => {
  if (import.meta.env?.DEV) console.warn(`[comicstudio] ignored duplicate ${kind} registration "${id}"`);
};

const build = (): Registries => {
  const cards = new Map<Card['type'], CardRegistration>();
  const tabs: BoardTabRegistration[] = [];
  const tabIds = new Set<string>(Object.keys(BUILTIN_TAB_ORDER));
  const headerSlots: HeaderSlotRegistration[] = [];
  const slotIds = new Set<string>();
  const adminSections: AdminSectionRegistration[] = [];
  const sectionIds = new Set<string>();

  for (const mod of featureModules()) {
    for (const reg of mod.cards || []) {
      if (!reg || typeof reg.type !== 'string' || !reg.Component) continue;
      if (BUILTIN_CARD_TYPES.has(reg.type) || cards.has(reg.type)) {
        warnDuplicate('card', reg.type);
        continue;
      }
      cards.set(reg.type, reg);
    }
    for (const reg of mod.tabs || []) {
      if (!reg || typeof reg.id !== 'string' || !reg.Component) continue;
      if (tabIds.has(reg.id)) {
        warnDuplicate('tab', reg.id);
        continue;
      }
      tabIds.add(reg.id);
      tabs.push(reg);
    }
    for (const reg of mod.headerSlots || []) {
      if (!reg || typeof reg.id !== 'string' || !reg.Component) continue;
      if (slotIds.has(reg.id)) {
        warnDuplicate('header slot', reg.id);
        continue;
      }
      slotIds.add(reg.id);
      headerSlots.push(reg);
    }
    for (const reg of mod.adminSections || []) {
      if (!reg || typeof reg.id !== 'string' || !reg.Component) continue;
      if (sectionIds.has(reg.id)) {
        warnDuplicate('admin section', reg.id);
        continue;
      }
      sectionIds.add(reg.id);
      adminSections.push(reg);
    }
  }

  return { cards, tabs: byOrder(tabs), headerSlots: byOrder(headerSlots), adminSections };
};

const registries = (): Registries => (cache ??= build());

/** The registered (non-built-in) card for a type, if any. */
export const registeredCard = (type: Card['type'] | string): CardRegistration | undefined =>
  registries().cards.get(type as Card['type']);

/** Registered card types (for diagnostics and tests). */
export const registeredCardTypes = (): Card['type'][] => [...registries().cards.keys()];

/** Registered board tabs, sorted by `order` (visibility is decided by the caller with doc + caps). */
export const registeredTabs = (): readonly BoardTabRegistration[] => registries().tabs;

/** Registered header slots, sorted by `order`. */
export const registeredHeaderSlots = (): readonly HeaderSlotRegistration[] => registries().headerSlots;

/** Registered admin console sections (admin-only), in feature order. */
export const registeredAdminSections = (): readonly AdminSectionRegistration[] => registries().adminSections;

/** Test hook: forget the built registries so the next read rebuilds from the (mocked) modules. */
export const resetFeatureRegistries = (): void => {
  cache = null;
};
