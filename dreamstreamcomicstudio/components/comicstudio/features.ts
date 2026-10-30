// Feature registry (contract §13.2; created by P0-C; wave 2: P2-AMEND registered `usage`; W-M registered
// `models`, `insights` and `reliability`).
//
// Imports the client feature indexes (the ten wave-0 folders plus `usage`, P1-LIMITS' "usage left"
// meter at header order 220, plus the three W-M folders) and folds their `FeatureModule`s into the
// registries the hotspot files read (CardRenderer, BoardPane, ComicStudio header, AdminConsole). A feature
// package fills its own `<feature>/index.ts`; a NEW feature folder is added here once, at the end (lowest
// precedence).
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
import { feature as usage } from './usage/index';
import { feature as models } from './models/index';
import { feature as insights } from './insights/index';
import { feature as reliability } from './reliability/index';
// --- history (versions plan §8; H0 stub, H5 fills it) ---
import { feature as history } from './history/index';
// --- Ship 2/3 (pro plan §10; K2b stubs: C7 editor, C4 confidence, C5 consistency, C3 save, C6 guide fill them) ---
import { feature as editor } from './editor/index';
import { feature as confidence } from './confidence/index';
import { feature as consistency } from './consistency/index';
import { feature as save } from './save/index';
import { feature as guide } from './guide/index';

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
 * first; ≥ 900 comes after the More menu). Registered today: share 10, mode/savings (mobile),
 * usage 220 (after the spend chip and savings, before Read).
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
  [
    breakdown, lettering, timeline, refs, share, safety, i18n, immersive, library, mobile, usage, models, insights, reliability,
    // Comic History (versions plan §8), last = lowest precedence. Listed once it registers something (H5): the H0 stub
    // registers nothing, so the registries — and this list — are exactly what they were without it.
    ...(hasRegistrations(history) ? [history] : []),
    // The pro editor and its companions (pro plan §10 Waves 3), after History. Each is listed once it registers
    // something: the K2b stubs register nothing, so the registries are exactly what they were without them.
    ...[editor, confidence, consistency, save, guide].filter(hasRegistrations)
  ].map((m) => m || {});

/** A feature module that contributes at least one registration. */
function hasRegistrations(mod: FeatureModule | undefined): boolean {
  return !!mod && [mod.cards, mod.tabs, mod.headerSlots, mod.adminSections].some((list) => Array.isArray(list) && list.length > 0);
}

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
