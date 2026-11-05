/**
 * The DreamStream studio mark family: names and geometry.
 *
 * One tile, one cut, one point. Every mark is a 64-unit tile (corner radius 16) drawn in
 * currentColor, with a single weight-7 stroke and one point of radius 3.6 cut out of it through a
 * mask. This is the construction of the Atlas mark (components/AtlasLogo.tsx in Atlas), so one
 * drawing is correct on white, on black and on inverted panels without colour variants.
 *
 *   dreamstream  The house mark: a D, the point in its counter (letter plus point, like the Atlas A).
 *   comic        "Grin": the D tipped onto its back laughs; the point is its eye.
 *   stream       "On air": the point is the live source, the D's bowl mirrored around it.
 *   atlas        Atlas Studio's open A, the point "you are here" (identical to AtlasLogo.tsx), so the
 *                studio switcher can show every studio.
 *
 * The numbers must equal the committed source SVGs public/icons/{dreamstream,comics,stream}-mark.svg,
 * from which scripts/gen-icons.mjs renders every app icon and favicon.
 * tests/config/appIcons.test.ts fails if the two drift. docs/design has the construction and usage.
 */
export type Studio = 'dreamstream' | 'comic' | 'stream' | 'atlas';

export interface StudioMarkSpec {
  /** The product's full name: the accessible name of a mark that stands alone. */
  readonly name: string;
  /** The wordmark's first word, set as "<first> Studio". */
  readonly first: string;
  /** Centre line of the single weight-7 cut, in the 64-unit viewBox. */
  readonly cut: string;
  /** Centre of the point (radius 3.6). */
  readonly point: readonly [x: number, y: number];
  /** What the drawing is, in one line (docs, the studio switcher's descriptions). */
  readonly idea: string;
}

/** The viewBox side, the tile's corner radius, the cut's weight and the point's radius: shared by every mark. */
export const MARK_VIEWBOX = 64;
export const MARK_TILE_RADIUS = 16;
export const MARK_STROKE = 7;
export const MARK_POINT_RADIUS = 3.6;

export const STUDIO_MARKS: Readonly<Record<Studio, StudioMarkSpec>> = {
  dreamstream: {
    name: 'DreamStream Studio',
    first: 'DreamStream',
    cut: 'M21 16 L31 16 A16 16 0 0 1 31 48 L21 48 Z',
    point: [33, 32],
    idea: 'D for the house, the point in its counter',
  },
  comic: {
    name: 'Comic Studio',
    first: 'Comic',
    cut: 'M16 27.5 L48 27.5 A16 16 0 0 1 16 27.5 Z',
    point: [24, 15.9],
    idea: 'Grin: the D tipped onto its back laughs; the point is its eye',
  },
  stream: {
    name: 'Stream Studio',
    first: 'Stream',
    cut: 'M40.99 18.16 A16.5 16.5 0 0 1 40.99 45.84 M23.01 45.84 A16.5 16.5 0 0 1 23.01 18.16',
    point: [32, 32],
    idea: "On air: the point is live, the D's bowl mirrored around it",
  },
  atlas: {
    name: 'Atlas Studio',
    first: 'Atlas',
    cut: 'M16 50 L32 14 L48 50',
    point: [32, 40],
    idea: 'The open A; the point is "you are here"',
  },
};

/** Every studio, in switcher order: the DreamStream house first, then its studios, then Atlas. */
export const STUDIOS: readonly Studio[] = ['dreamstream', 'comic', 'stream', 'atlas'];

export const isStudio = (value: unknown): value is Studio =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(STUDIO_MARKS, value);
