// @vitest-environment node
/**
 * layoutFor(ff) holds every number of redesign plan §5.1–§5.3 (§5.4: "every number in §5 is a row in layoutFor's
 * unit test"). One row per viewport: the nine app-scene smoke sizes (tests/e2e/devices.ts APP_SCENE_MATRIX), the
 * plan's other phones (393×852, 412×915, a 640 px large phone), the Fold5 folded and unfolded, the book posture,
 * tabletop and 1920×1080 — sixteen in all. Each row checks the nav kind, the Director's placement and width, the
 * column counts and the inspector mode, plus the chrome and content numbers the plan spells.
 */
import { describe, expect, it } from 'vitest';
import { classifyViewport, segmentsFromRects, SINGLE_SEGMENT, type Segments } from '../comicstudio/mobile/formFactor';
import { CHROME, CONTAINER_MAX_PX, gutterFor, layoutFor, postureOf, studioContentHeight, type LayoutPosture } from './layout';

/** tests/e2e/devices.ts APP_SCENE_MATRIX, by size (that file imports Playwright, so it is mirrored here). */
const APP_SCENE_SIZES: ReadonlyArray<[string, number, number]> = [
  ['smoke-320x640', 320, 640],
  ['smoke-320x568', 320, 568],
  ['smoke-360x740', 360, 740],
  ['smoke-768x1024', 768, 1024],
  ['smoke-1024x768', 1024, 768],
  ['smoke-1280x800', 1280, 800],
  ['smoke-1440x900', 1440, 900],
  ['smoke-fold5-dual', 882, 1104],
  ['smoke-852x393', 852, 393]
];

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly;
const BOOK: Segments = segmentsFromRects([rect(0, 0, 441, 1104), rect(441, 0, 441, 1104)]);
const TABLETOP: Segments = segmentsFromRects([rect(0, 0, 882, 552), rect(0, 552, 882, 552)]);

const ff = (w: number, h: number, segments: Segments = SINGLE_SEGMENT) => ({ width: w, height: h, segments, layout: classifyViewport({ w, h, coarse: w < 768, segments }).layout });

interface Row {
  name: string;
  w: number;
  h: number;
  segments?: Segments;
  posture: LayoutPosture;
  headerPx: number;
  tabBarPx: number;
  gutterPx: number;
  appNav: 'tabbar' | 'rail' | 'header';
  studio: { nav: string; navPx: number; director: string; directorPx: number | null; pages: number; pagesCollapsed: number; content: { width: number; height: number } };
  library: { columns: number; compact: number; withInspector: number; view: 'list' | 'grid'; inspector: string; inspectorPx: number | null; scrim: boolean; selectionBar: 'top' | 'bottom' };
  discover: { columns: number; compact: number; shelfPx: number; filters: string; inspector: string };
}

const ROWS: Row[] = [
  {
    name: 'smoke-320x568',
    w: 320,
    h: 568,
    posture: 'phone',
    headerPx: 44,
    tabBarPx: 52,
    gutterPx: 16,
    appNav: 'tabbar',
    studio: { nav: 'tabbar', navPx: 52, director: 'place', directorPx: null, pages: 2, pagesCollapsed: 2, content: { width: 320, height: 472 } },
    library: { columns: 2, compact: 2, withInspector: 2, view: 'list', inspector: 'bottom-sheet', inspectorPx: null, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 2, compact: 2, shelfPx: 128, filters: 'sheet', inspector: 'none' }
  },
  {
    name: 'smoke-320x640',
    w: 320,
    h: 640,
    posture: 'phone',
    headerPx: 44,
    tabBarPx: 52,
    gutterPx: 16,
    appNav: 'tabbar',
    studio: { nav: 'tabbar', navPx: 52, director: 'place', directorPx: null, pages: 2, pagesCollapsed: 2, content: { width: 320, height: 544 } },
    library: { columns: 2, compact: 2, withInspector: 2, view: 'list', inspector: 'bottom-sheet', inspectorPx: null, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 2, compact: 2, shelfPx: 128, filters: 'sheet', inspector: 'none' }
  },
  {
    name: 'fold5-folded',
    w: 344,
    h: 882,
    posture: 'phone',
    headerPx: 44,
    tabBarPx: 52,
    gutterPx: 16,
    appNav: 'tabbar',
    studio: { nav: 'tabbar', navPx: 52, director: 'place', directorPx: null, pages: 2, pagesCollapsed: 2, content: { width: 344, height: 786 } },
    library: { columns: 2, compact: 2, withInspector: 2, view: 'list', inspector: 'bottom-sheet', inspectorPx: null, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 2, compact: 2, shelfPx: 128, filters: 'sheet', inspector: 'none' }
  },
  {
    name: 'smoke-360x740',
    w: 360,
    h: 740,
    posture: 'phone',
    headerPx: 44,
    tabBarPx: 52,
    gutterPx: 16,
    appNav: 'tabbar',
    studio: { nav: 'tabbar', navPx: 52, director: 'place', directorPx: null, pages: 2, pagesCollapsed: 2, content: { width: 360, height: 644 } },
    library: { columns: 2, compact: 2, withInspector: 2, view: 'grid', inspector: 'bottom-sheet', inspectorPx: null, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 2, compact: 2, shelfPx: 140, filters: 'sheet', inspector: 'none' }
  },
  {
    name: 'iphone-15 393x852',
    w: 393,
    h: 852,
    posture: 'phone',
    headerPx: 44,
    tabBarPx: 52,
    gutterPx: 16,
    appNav: 'tabbar',
    studio: { nav: 'tabbar', navPx: 52, director: 'place', directorPx: null, pages: 2, pagesCollapsed: 2, content: { width: 393, height: 756 } },
    library: { columns: 2, compact: 2, withInspector: 2, view: 'grid', inspector: 'bottom-sheet', inspectorPx: null, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 2, compact: 2, shelfPx: 140, filters: 'sheet', inspector: 'none' }
  },
  {
    name: 'pixel-8 412x915',
    w: 412,
    h: 915,
    posture: 'phone',
    headerPx: 44,
    tabBarPx: 52,
    gutterPx: 16,
    appNav: 'tabbar',
    studio: { nav: 'tabbar', navPx: 52, director: 'place', directorPx: null, pages: 2, pagesCollapsed: 2, content: { width: 412, height: 819 } },
    library: { columns: 2, compact: 2, withInspector: 2, view: 'grid', inspector: 'bottom-sheet', inspectorPx: null, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 2, compact: 2, shelfPx: 140, filters: 'sheet', inspector: 'none' }
  },
  {
    name: 'large phone 640x960',
    w: 640,
    h: 960,
    posture: 'phone-wide',
    headerPx: 44,
    tabBarPx: 52,
    gutterPx: 24,
    appNav: 'tabbar',
    studio: { nav: 'tabbar', navPx: 52, director: 'place', directorPx: null, pages: 3, pagesCollapsed: 3, content: { width: 640, height: 864 } },
    library: { columns: 3, compact: 3, withInspector: 3, view: 'grid', inspector: 'bottom-sheet', inspectorPx: null, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 3, compact: 3, shelfPx: 140, filters: 'sheet', inspector: 'none' }
  },
  {
    name: 'smoke-852x393',
    w: 852,
    h: 393,
    posture: 'phone-landscape',
    headerPx: 44,
    tabBarPx: 0,
    gutterPx: 24,
    appNav: 'rail',
    studio: { nav: 'rail', navPx: 72, director: 'place', directorPx: null, pages: 3, pagesCollapsed: 3, content: { width: 780, height: 349 } },
    library: { columns: 4, compact: 5, withInspector: 4, view: 'grid', inspector: 'side-sheet', inspectorPx: 360, scrim: true, selectionBar: 'top' },
    discover: { columns: 4, compact: 4, shelfPx: 140, filters: 'side-sheet', inspector: 'none' }
  },
  {
    name: 'smoke-768x1024',
    w: 768,
    h: 1024,
    posture: 'tablet',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 24,
    appNav: 'header',
    studio: { nav: 'navtrack', navPx: 48, director: 'dock', directorPx: null, pages: 3, pagesCollapsed: 3, content: { width: 768, height: 864 } },
    library: { columns: 3, compact: 4, withInspector: 3, view: 'grid', inspector: 'side-sheet', inspectorPx: 400, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 3, compact: 4, shelfPx: 160, filters: 'side-sheet', inspector: 'none' }
  },
  {
    name: 'fold5-unfolded 882x1104',
    w: 882,
    h: 1104,
    posture: 'tablet',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 24,
    appNav: 'header',
    studio: { nav: 'navtrack', navPx: 48, director: 'dock', directorPx: null, pages: 3, pagesCollapsed: 3, content: { width: 882, height: 944 } },
    library: { columns: 3, compact: 4, withInspector: 3, view: 'grid', inspector: 'side-sheet', inspectorPx: 400, scrim: true, selectionBar: 'bottom' },
    discover: { columns: 3, compact: 4, shelfPx: 160, filters: 'side-sheet', inspector: 'none' }
  },
  {
    name: 'smoke-1024x768',
    w: 1024,
    h: 768,
    posture: 'laptop',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 24,
    appNav: 'header',
    studio: { nav: 'rail', navPx: 72, director: 'pane', directorPx: 340, pages: 2, pagesCollapsed: 3, content: { width: 612, height: 712 } },
    library: { columns: 4, compact: 5, withInspector: 4, view: 'grid', inspector: 'side-sheet', inspectorPx: 400, scrim: true, selectionBar: 'top' },
    discover: { columns: 3, compact: 4, shelfPx: 192, filters: 'rail', inspector: 'none' }
  },
  {
    name: 'smoke-1280x800',
    w: 1280,
    h: 800,
    posture: 'desktop',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 32,
    appNav: 'header',
    studio: { nav: 'rail', navPx: 72, director: 'pane', directorPx: 380, pages: 3, pagesCollapsed: 4, content: { width: 828, height: 744 } },
    library: { columns: 5, compact: 6, withInspector: 4, view: 'grid', inspector: 'panel', inspectorPx: 360, scrim: false, selectionBar: 'top' },
    discover: { columns: 4, compact: 5, shelfPx: 192, filters: 'rail', inspector: 'none' }
  },
  {
    name: 'smoke-1440x900',
    w: 1440,
    h: 900,
    posture: 'wide',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 32,
    appNav: 'header',
    studio: { nav: 'sidebar', navPx: 240, director: 'pane', directorPx: 400, pages: 3, pagesCollapsed: 4, content: { width: 800, height: 844 } },
    library: { columns: 5, compact: 6, withInspector: 4, view: 'grid', inspector: 'panel', inspectorPx: 380, scrim: false, selectionBar: 'top' },
    discover: { columns: 5, compact: 6, shelfPx: 192, filters: 'rail', inspector: 'none' }
  },
  {
    name: 'desktop 1920x1080',
    w: 1920,
    h: 1080,
    posture: 'wide',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 32,
    appNav: 'header',
    studio: { nav: 'sidebar', navPx: 240, director: 'pane', directorPx: 400, pages: 5, pagesCollapsed: 6, content: { width: 1280, height: 1024 } },
    library: { columns: 5, compact: 6, withInspector: 4, view: 'grid', inspector: 'panel', inspectorPx: 380, scrim: false, selectionBar: 'top' },
    discover: { columns: 5, compact: 6, shelfPx: 192, filters: 'rail', inspector: 'none' }
  },
  {
    name: 'smoke-fold5-dual (book)',
    w: 882,
    h: 1104,
    segments: BOOK,
    posture: 'book',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 16,
    appNav: 'header',
    studio: { nav: 'navtrack', navPx: 48, director: 'segment', directorPx: null, pages: 2, pagesCollapsed: 2, content: { width: 441, height: 1000 } },
    library: { columns: 2, compact: 2, withInspector: 2, view: 'grid', inspector: 'segment', inspectorPx: null, scrim: false, selectionBar: 'bottom' },
    discover: { columns: 2, compact: 2, shelfPx: 140, filters: 'sheet', inspector: 'segment' }
  },
  {
    name: 'fold5 tabletop',
    w: 882,
    h: 1104,
    segments: TABLETOP,
    posture: 'tabletop',
    headerPx: 56,
    tabBarPx: 0,
    gutterPx: 24,
    appNav: 'header',
    studio: { nav: 'navtrack', navPx: 48, director: 'bottom', directorPx: null, pages: 3, pagesCollapsed: 3, content: { width: 882, height: 1000 } },
    library: { columns: 3, compact: 4, withInspector: 3, view: 'grid', inspector: 'segment', inspectorPx: null, scrim: false, selectionBar: 'bottom' },
    discover: { columns: 3, compact: 4, shelfPx: 160, filters: 'side-sheet', inspector: 'segment' }
  }
];

describe('layoutFor: the redesign layout table (§5.2–§5.3)', () => {
  it('covers every app-scene smoke viewport', () => {
    for (const [name, w, h] of APP_SCENE_SIZES) {
      const covered = ROWS.some((r) => r.w === w && r.h === h && (name.includes('dual') ? r.posture === 'book' : r.posture !== 'book' && r.posture !== 'tabletop'));
      expect(covered, name).toBe(true);
    }
    expect(ROWS.length).toBeGreaterThanOrEqual(13);
  });

  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, r) => {
    const t = layoutFor(ff(r.w, r.h, r.segments));
    expect(t.posture).toBe(r.posture);
    expect({ header: t.headerPx, tabBar: t.tabBarPx, gutter: t.gutterPx, appNav: t.appNav }).toEqual({ header: r.headerPx, tabBar: r.tabBarPx, gutter: r.gutterPx, appNav: r.appNav });
    expect({
      nav: t.studio.nav,
      navPx: t.studio.navPx,
      director: t.studio.director.placement,
      directorPx: t.studio.director.widthPx,
      pages: t.studio.pagesColumns,
      pagesCollapsed: t.studio.pagesColumnsCollapsed,
      content: t.studio.content
    }).toEqual(r.studio);
    expect({
      columns: t.library.columns.comfortable,
      compact: t.library.columns.compact,
      withInspector: t.library.columnsWithInspector,
      view: t.library.defaultView,
      inspector: t.library.inspector.mode,
      inspectorPx: t.library.inspector.widthPx,
      scrim: t.library.inspector.scrim,
      selectionBar: t.library.selectionBar
    }).toEqual(r.library);
    expect({ columns: t.discover.columns.comfortable, compact: t.discover.columns.compact, shelfPx: t.discover.shelfCardPx, filters: t.discover.filters, inspector: t.discover.inspector.mode }).toEqual(r.discover);
  });
});

describe('the other §5 numbers', () => {
  it('320×568 keeps 83 % for content, 75 % with the Approval bar and 69 % with the offline line too (§5.2)', () => {
    const t = layoutFor(ff(320, 568));
    expect(studioContentHeight(t)).toBe(472);
    expect(studioContentHeight(t, { approval: true })).toBe(428);
    expect(studioContentHeight(t, { approval: true, offline: true })).toBe(392);
    expect(Math.round((472 / 568) * 100)).toBe(83);
    expect(Math.round((392 / 568) * 100)).toBe(69);
  });

  it('Discover phone cards are 138 px at 320 (207 px covers) and 158 px at 360', () => {
    expect(layoutFor(ff(320, 568)).discover.cardPx).toBe(138);
    expect(Math.round(layoutFor(ff(320, 568)).discover.cardPx * 1.5)).toBe(207);
    expect(layoutFor(ff(360, 740)).discover.cardPx).toBe(158);
  });

  it('the Director pane: 340 → 380 → 400 px (320–520 resizable at 1440), a 44 px edge tab when collapsed; never an inspector in the studio', () => {
    const wide = layoutFor(ff(1440, 900)).studio.director;
    expect(wide).toMatchObject({ widthPx: 400, minPx: 320, maxPx: 520, collapsedPx: 44 });
    expect(layoutFor(ff(1024, 768)).studio.director.collapsedPx).toBe(CHROME.directorEdgeTabPx);
    expect(layoutFor(ff(1440, 900)).studio.textMaxPx).toBe(760);
    expect(layoutFor(ff(1280, 800)).studio.textMaxPx).toBeNull();
  });

  it('chrome tokens (§5.1): 44 / 56 px header, 52 px tab bar, 72 px rail, 240 px sidebar, 44 px Approval bar, 36 px offline line', () => {
    expect(CHROME).toMatchObject({ headerPhonePx: 44, headerPx: 56, tabBarPx: 52, railPx: 72, sidebarPx: 240, approvalBarPx: 44, offlineLinePx: 36 });
    expect(layoutFor(ff(640, 960)).studio.tabBarMaxPx).toBe(560);
    expect(layoutFor(ff(360, 740)).studio.tabBarMaxPx).toBeNull();
  });

  it('gutters are 16 / 24 / 32 px and the Library and Discover stop growing at 1360 px from 1280', () => {
    expect([gutterFor(320), gutterFor(599), gutterFor(600), gutterFor(1279), gutterFor(1280)]).toEqual([16, 16, 24, 24, 32]);
    expect(layoutFor(ff(1280, 800)).library.containerMaxPx).toBe(CONTAINER_MAX_PX);
    expect(layoutFor(ff(1024, 768)).discover.containerMaxPx).toBeNull();
    expect(layoutFor(ff(1440, 900)).discover.containerMaxPx).toBe(1360);
  });

  it('Discover: a 240 px filter rail from 1024, a ≤ 360 px header search from 768, and the Featured row / shelf / split', () => {
    expect(layoutFor(ff(1024, 768)).discover.filterRailPx).toBe(240);
    expect(layoutFor(ff(768, 1024)).discover.filterRailPx).toBeNull();
    expect(layoutFor(ff(768, 1024)).discover.searchMaxPx).toBe(360);
    expect(layoutFor(ff(360, 740)).discover.searchMaxPx).toBeNull();
    expect(layoutFor(ff(360, 740)).discover.featured).toBe('row');
    expect(layoutFor(ff(852, 393)).discover.featured).toBe('shelf');
    expect(layoutFor(ff(768, 1024)).discover.featured).toBe('split');
  });

  it('postures follow the form factor rule (dual-screen and stacked segments first, then the phone-landscape rail)', () => {
    expect(postureOf({ width: 882, height: 1104, layout: 'dual-screen' })).toBe('book');
    expect(postureOf({ width: 882, height: 1104, layout: 'split', segments: TABLETOP })).toBe('tabletop');
    expect(postureOf({ width: 1024, height: 400, layout: 'single-rail' })).toBe('phone-landscape');
    expect(postureOf({ width: 700, height: 900, layout: 'single' })).toBe('phone-wide');
    expect(layoutFor({ width: NaN, height: 0, layout: 'split' }).posture).toBe('laptop');
  });

  it('the bottom-sheet inspector opens at 60 % and drags to 92 %', () => {
    expect(layoutFor(ff(360, 740)).library.inspector.detents).toEqual([0.6, 0.92]);
  });
});
