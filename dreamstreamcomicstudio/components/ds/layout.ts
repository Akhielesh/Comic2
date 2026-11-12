/**
 * layoutFor(ff): the redesign's layout numbers in one pure table (redesign plan §2 "Layout numbers", §5.1–§5.4).
 * Every screen of the Studio, the Library and Discover reads its chrome, navigation, Director placement, column
 * counts and inspector mode from here, so a size is decided once and tested once (components/ds/layout.test.ts
 * holds every number of §5.2–§5.3). No `auto-fill` grid anywhere: columns are explicit, so a layout test can
 * say how many cards a row holds at 360 px.
 *
 * The input is the studio's form factor (components/comicstudio/mobile/formFactor.ts: width, height, layout and
 * segments); nothing here reads the DOM. Postures, first match wins:
 *   book            two side-by-side segments (`dual-screen`, the Fold's book posture)
 *   tabletop        two stacked segments (the Fold half-open on a table)
 *   phone-landscape `single-rail` (a phone on its side: under 480 px tall)
 *   phone           `single`, under 600 px wide
 *   phone-wide      `single`, 600–719 px (large phones, small tablets in portrait)
 *   tablet          720–1023 px
 *   laptop          1024–1279 px
 *   desktop         1280–1439 px
 *   wide            1440 px and up
 *
 * Numbers marked "derived" in the comments are not spelled in the plan; they follow the same rule as the
 * numbers that are (one Pages tile per 256 px of content, compact Library cards = comfortable + 1).
 */
import type React from 'react';
import type { FormFactor, Segments, StudioLayout } from '../comicstudio/mobile/formFactor';

export type LayoutPosture = 'phone' | 'phone-wide' | 'phone-landscape' | 'tablet' | 'laptop' | 'desktop' | 'wide' | 'book' | 'tabletop';

/** App navigation outside the studio (Library, Discover): the tab bar on phones, the rail on its side, else the header. */
export type AppNavKind = 'tabbar' | 'rail' | 'header';
/** Studio places navigation: TabBar, NavRail, a NavTrack under the header, or the 240 px Sidebar. */
export type StudioNavKind = 'tabbar' | 'rail' | 'navtrack' | 'sidebar';
/**
 * Where the Director lives: a place of its own on phones, a 56 px dock that opens a sheet on tablets, a pane on the
 * right from 1024, segment 0 in book posture, the bottom segment on a tabletop.
 */
export type DirectorPlacement = 'place' | 'dock' | 'pane' | 'segment' | 'bottom';
/** How the Library / Discover inspector opens. `none`: no inspector (Discover opens the comic instead). */
export type InspectorMode = 'bottom-sheet' | 'side-sheet' | 'panel' | 'segment' | 'none';

/** Chrome sizes (§5.1). */
export const CHROME = {
  headerPhonePx: 44,
  headerPx: 56,
  tabBarPx: 52,
  railPx: 72,
  navTrackPx: 48,
  sidebarPx: 240,
  approvalBarPx: 44,
  offlineLinePx: 36,
  directorDockPx: 56,
  directorEdgeTabPx: 44
} as const;

/** One Pages tile per this many px of content (reproduces every Pages count in §5.2). */
export const PAGES_TILE_PX = 256;
/** The Library and Discover container stops growing here (≥ 1280). */
export const CONTAINER_MAX_PX = 1360;
/** Text sub-views (Brief, Outline) are centred at this width on wide screens. */
export const TEXT_MAX_PX = 760;
/** The space between grid cards. */
export const GRID_GAP_PX = 12;

export interface DirectorLayout {
  placement: DirectorPlacement;
  /** The pane's width (null where the Director is not a pane). */
  widthPx: number | null;
  /** Resizable range of the pane (≥ 1440 only). */
  minPx: number | null;
  maxPx: number | null;
  /** Collapsed to its edge tab (pane only). */
  collapsedPx: number | null;
}

export interface InspectorLayout {
  mode: InspectorMode;
  widthPx: number | null;
  /** A side sheet dims what it covers (SCRIM, no blur); a persistent panel never does. */
  scrim: boolean;
  /** Bottom sheet detents, as fractions of the viewport height. */
  detents: readonly number[] | null;
}

export interface StudioLayoutTable {
  nav: StudioNavKind;
  navPx: number;
  director: DirectorLayout;
  /** Pages grid columns with the Director as laid out; `pagesColumnsCollapsed` with its pane collapsed. */
  pagesColumns: number;
  pagesColumnsCollapsed: number;
  /** The place's content box after chrome (the Director pane, the nav, the header, the tab bar). */
  content: { width: number; height: number };
  /** Text sub-views are centred at this width (wide screens), else null. */
  textMaxPx: number | null;
  /** The tab bar's maximum width (centred), on large phones. */
  tabBarMaxPx: number | null;
}

export interface LibraryLayoutTable {
  columns: { comfortable: number; compact: number };
  /** Columns while the persistent inspector panel is open (sheets cover the grid and leave it as it is). */
  columnsWithInspector: number;
  defaultView: 'list' | 'grid';
  listRowPx: 72;
  inspector: InspectorLayout;
  containerMaxPx: number | null;
  /** The SelectionBar sits at the top from 1024 (and beside a rail), at the bottom with the safe area below. */
  selectionBar: 'top' | 'bottom';
}

export interface DiscoverLayoutTable {
  columns: { comfortable: number; compact: number };
  /** A grid card's width in px (phones; the cover is 1.5× as tall). */
  cardPx: number;
  shelfCardPx: number;
  /** Filters: a bottom sheet on phones, chips + a side sheet on tablets, a 240 px rail from 1024. */
  filters: 'sheet' | 'side-sheet' | 'rail';
  filterRailPx: number | null;
  searchMaxPx: number | null;
  /** The Featured comic: a row on phones, a shelf on a phone on its side, cover-left split from 720. */
  featured: 'row' | 'shelf' | 'split';
  inspector: InspectorLayout;
  containerMaxPx: number | null;
}

export interface LayoutTable {
  posture: LayoutPosture;
  width: number;
  height: number;
  /** The width the content is laid out in: one segment in book posture, the window otherwise. */
  segmentWidth: number;
  headerPx: number;
  tabBarPx: number;
  gutterPx: number;
  appNav: AppNavKind;
  studio: StudioLayoutTable;
  library: LibraryLayoutTable;
  discover: DiscoverLayoutTable;
}

export type LayoutInput = Pick<FormFactor, 'width' | 'height' | 'layout'> & { segments?: Segments };

const NO_INSPECTOR: InspectorLayout = { mode: 'none', widthPx: null, scrim: false, detents: null };
const BOTTOM_SHEET: InspectorLayout = { mode: 'bottom-sheet', widthPx: null, scrim: true, detents: [0.6, 0.92] };
const sideSheet = (widthPx: number, scrim: boolean): InspectorLayout => ({ mode: 'side-sheet', widthPx, scrim, detents: null });
const panel = (widthPx: number): InspectorLayout => ({ mode: 'panel', widthPx, scrim: false, detents: null });
const SEGMENT: InspectorLayout = { mode: 'segment', widthPx: null, scrim: false, detents: null };

export function postureOf(input: { width: number; height: number; layout: StudioLayout; segments?: Segments }): LayoutPosture {
  const seg = input.segments;
  if (input.layout === 'dual-screen' || (seg?.count === 2 && seg.axis === 'horizontal')) return 'book';
  if (seg?.count === 2 && seg.axis === 'vertical') return 'tabletop';
  if (input.layout === 'single-rail') return 'phone-landscape';
  const w = input.width;
  if (input.layout === 'single' || w < 720) return w < 600 ? 'phone' : 'phone-wide';
  if (w < 1024) return 'tablet';
  if (w < 1280) return 'laptop';
  if (w < 1440) return 'desktop';
  return 'wide';
}

/** The gutter (§5.1): 16 px under 600, 24 px from 600 to 1279, 32 px from 1280, measured on the content's own width. */
export const gutterFor = (width: number): number => (width < 600 ? 16 : width < 1280 ? 24 : 32);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const pagesColumnsFor = (contentWidth: number) => clamp(Math.floor(contentWidth / PAGES_TILE_PX), 2, 6);

function directorFor(posture: LayoutPosture): DirectorLayout {
  const none = { widthPx: null, minPx: null, maxPx: null, collapsedPx: null };
  switch (posture) {
    case 'phone':
    case 'phone-wide':
    case 'phone-landscape':
      return { placement: 'place', ...none };
    case 'tablet':
      return { placement: 'dock', ...none };
    case 'laptop':
      return { placement: 'pane', widthPx: 340, minPx: null, maxPx: null, collapsedPx: CHROME.directorEdgeTabPx };
    case 'desktop':
      return { placement: 'pane', widthPx: 380, minPx: null, maxPx: null, collapsedPx: CHROME.directorEdgeTabPx };
    case 'wide':
      return { placement: 'pane', widthPx: 400, minPx: 320, maxPx: 520, collapsedPx: CHROME.directorEdgeTabPx };
    case 'book':
      return { placement: 'segment', ...none };
    case 'tabletop':
      return { placement: 'bottom', ...none };
  }
}

const STUDIO_NAV: Record<LayoutPosture, StudioNavKind> = {
  phone: 'tabbar',
  'phone-wide': 'tabbar',
  'phone-landscape': 'rail',
  tablet: 'navtrack',
  laptop: 'rail',
  desktop: 'rail',
  wide: 'sidebar',
  book: 'navtrack',
  tabletop: 'navtrack'
};

const NAV_PX: Record<StudioNavKind, number> = { tabbar: CHROME.tabBarPx, rail: CHROME.railPx, navtrack: CHROME.navTrackPx, sidebar: CHROME.sidebarPx };

function studioFor(posture: LayoutPosture, width: number, height: number, segmentWidth: number, headerPx: number, tabBarPx: number): StudioLayoutTable {
  const nav = STUDIO_NAV[posture];
  const navPx = NAV_PX[nav];
  const director = directorFor(posture);
  const sideNav = nav === 'rail' || nav === 'sidebar' ? navPx : 0;
  let contentWidth: number;
  let contentHeight: number;
  if (posture === 'phone' || posture === 'phone-wide') {
    contentWidth = width;
    contentHeight = height - headerPx - tabBarPx;
  } else if (posture === 'book') {
    // Segment 1 holds the place under its NavTrack; segment 0 is the Director.
    contentWidth = segmentWidth;
    contentHeight = height - headerPx - navPx;
  } else if (posture === 'tablet' || posture === 'tabletop') {
    contentWidth = width;
    contentHeight = height - headerPx - navPx - (posture === 'tablet' ? CHROME.directorDockPx : 0);
  } else {
    contentWidth = width - sideNav - (director.widthPx ?? 0);
    contentHeight = height - headerPx;
  }
  const collapsedWidth = director.placement === 'pane' ? width - sideNav - (director.collapsedPx ?? 0) : contentWidth;
  const phoneColumns = posture === 'phone' ? 2 : posture === 'phone-wide' ? 3 : null;
  const pagesColumns = phoneColumns ?? pagesColumnsFor(contentWidth);
  return {
    nav,
    navPx,
    director,
    pagesColumns,
    pagesColumnsCollapsed: phoneColumns ?? pagesColumnsFor(collapsedWidth),
    content: { width: Math.max(0, contentWidth), height: Math.max(0, contentHeight) },
    textMaxPx: posture === 'wide' ? TEXT_MAX_PX : null,
    tabBarMaxPx: posture === 'phone-wide' ? 560 : null
  };
}

const LIBRARY_COLUMNS: Record<LayoutPosture, number> = {
  phone: 2,
  'phone-wide': 3,
  'phone-landscape': 4,
  tablet: 3,
  laptop: 4,
  desktop: 5,
  wide: 5,
  book: 2,
  tabletop: 3
};

function libraryFor(posture: LayoutPosture, width: number): LibraryLayoutTable {
  const comfortable = LIBRARY_COLUMNS[posture];
  const phone = posture === 'phone' || posture === 'phone-wide' || posture === 'book';
  const inspector: InspectorLayout =
    posture === 'phone' || posture === 'phone-wide'
      ? BOTTOM_SHEET
      : posture === 'phone-landscape'
        ? sideSheet(360, true)
        : posture === 'tablet' || posture === 'laptop'
          ? sideSheet(400, true)
          : posture === 'desktop'
            ? panel(360)
            : posture === 'wide'
              ? panel(380)
              : SEGMENT;
  return {
    columns: { comfortable, compact: phone ? comfortable : comfortable + 1 },
    columnsWithInspector: inspector.mode === 'panel' ? comfortable - 1 : comfortable,
    defaultView: posture === 'phone' && width < 360 ? 'list' : 'grid',
    listRowPx: 72,
    inspector,
    containerMaxPx: width >= 1280 ? CONTAINER_MAX_PX : null,
    selectionBar: width >= 1024 || posture === 'phone-landscape' ? 'top' : 'bottom'
  };
}

const DISCOVER_COLUMNS: Record<LayoutPosture, { comfortable: number; compact: number }> = {
  phone: { comfortable: 2, compact: 2 },
  'phone-wide': { comfortable: 3, compact: 3 },
  'phone-landscape': { comfortable: 4, compact: 4 },
  tablet: { comfortable: 3, compact: 4 },
  laptop: { comfortable: 3, compact: 4 },
  desktop: { comfortable: 4, compact: 5 },
  wide: { comfortable: 5, compact: 6 },
  book: { comfortable: 2, compact: 2 },
  tabletop: { comfortable: 3, compact: 4 }
};

function discoverFor(posture: LayoutPosture, width: number, segmentWidth: number, gutterPx: number): DiscoverLayoutTable {
  const columns = DISCOVER_COLUMNS[posture];
  const phone = posture === 'phone' || posture === 'phone-wide';
  const cardPx = Math.floor((segmentWidth - 2 * gutterPx - GRID_GAP_PX * (columns.comfortable - 1)) / columns.comfortable);
  const filters = phone || posture === 'book' ? 'sheet' : posture === 'tablet' || posture === 'tabletop' || posture === 'phone-landscape' ? 'side-sheet' : 'rail';
  return {
    columns,
    cardPx,
    // 128 px at 320 (~2.3 visible), 140 px from 360 on phones, 192 px with arrows from 1024; 160 on tablets (derived).
    shelfCardPx: posture === 'phone' ? (width < 360 ? 128 : 140) : posture === 'phone-wide' || posture === 'phone-landscape' || posture === 'book' ? 140 : posture === 'tablet' || posture === 'tabletop' ? 160 : 192,
    filters,
    filterRailPx: filters === 'rail' ? 240 : null,
    searchMaxPx: width >= 768 && !phone && posture !== 'book' ? 360 : null,
    featured: phone || posture === 'book' ? 'row' : posture === 'phone-landscape' ? 'shelf' : 'split',
    inspector: posture === 'book' || posture === 'tabletop' ? SEGMENT : NO_INSPECTOR,
    containerMaxPx: width >= 1280 ? CONTAINER_MAX_PX : null
  };
}

/** The whole layout table for a window. */
export function layoutFor(ff: LayoutInput): LayoutTable {
  const width = Number.isFinite(ff.width) && ff.width > 0 ? ff.width : 1024;
  const height = Number.isFinite(ff.height) && ff.height > 0 ? ff.height : 768;
  const posture = postureOf({ width, height, layout: ff.layout, segments: ff.segments });
  const seg = ff.segments;
  const segmentWidth =
    posture === 'book'
      ? seg?.rects?.length === 2
        ? Math.round(Math.min(seg.rects[0].width, seg.rects[1].width))
        : Math.floor(width / 2)
      : width;
  const phoneChrome = posture === 'phone' || posture === 'phone-wide' || posture === 'phone-landscape';
  const headerPx = phoneChrome ? CHROME.headerPhonePx : CHROME.headerPx;
  const tabBarPx = posture === 'phone' || posture === 'phone-wide' ? CHROME.tabBarPx : 0;
  const gutterPx = gutterFor(segmentWidth);
  const appNav: AppNavKind = posture === 'phone' || posture === 'phone-wide' ? 'tabbar' : posture === 'phone-landscape' ? 'rail' : 'header';
  return {
    posture,
    width,
    height,
    segmentWidth,
    headerPx,
    tabBarPx,
    gutterPx,
    appNav,
    studio: studioFor(posture, width, height, segmentWidth, headerPx, tabBarPx),
    library: libraryFor(posture, width),
    discover: discoverFor(posture, width, segmentWidth, gutterPx)
  };
}

/**
 * The studio's content height with the optional lines on: the Approval bar (44 px) while a gate waits and the
 * offline line (36 px) while offline. At 320×568: 472 → 428 → 392 px (83 %, 75 %, 69 %).
 */
export function studioContentHeight(table: LayoutTable, lines: { approval?: boolean; offline?: boolean } = {}): number {
  return Math.max(0, table.studio.content.height - (lines.approval ? CHROME.approvalBarPx : 0) - (lines.offline ? CHROME.offlineLinePx : 0));
}

/** The CSS custom property a grid reads its column count from (CardGrid sets it inline). */
export const columnsStyle = (columns: number): React.CSSProperties => ({ '--cols': String(clamp(Math.round(columns) || 1, 1, 12)) }) as React.CSSProperties;
