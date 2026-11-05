// Pro Edit effects: procedural overlays (speed lines, bursts, emanata, atmosphere, borders; later tones and paper).
// Master plan §2.3 "Effect", §2.6. PE-0 contract; dependency-free.
//
// An effect is a page layer `{kind: 'effect', fx: {gen, v, seed, params}}`: a generator id and version, a seed and its
// parameters. Nothing is stored but these numbers, so an effect costs a few hundred bytes and no file. `gen@v` must be
// registered (fx/registry.ts) for a client to write it (server sanitizer, PE-SERVER); old versions stay registered so a
// stored effect always draws the same. A stored effect whose generator this build does not have is kept and draws
// nothing (inert), so a newer build's effect survives a rollback.

/** A generator parameter's value as stored. */
export type FxParamValue = number | string | boolean;

/** The stored effect of a layer. */
export interface LayerFx {
  /** Generator id ('speed-lines', 'burst', …): lower-case words joined by '-'. */
  gen: string;
  /** Generator version (an integer ≥ 1). A generator's output for one version never changes. */
  v: number;
  /** int32 seed: the same seed gives byte-identical drawing. */
  seed: number;
  /** Checked against the generator's schema by the server sanitizer; the generator clamps again when drawing. */
  params: Record<string, FxParamValue>;
}

/** One parameter of a generator: its kind, range or choices, and the value it takes when absent. */
export type FxParamSpec =
  | { kind: 'number'; min: number; max: number; default: number; step?: number; int?: true; label?: string }
  | { kind: 'enum'; values: readonly string[]; default: string; label?: string }
  /** '#RRGGBB'. */
  | { kind: 'color'; default: string; label?: string }
  | { kind: 'bool'; default: boolean; label?: string };

/** The groups the Effects picker shows (§2.6). */
export type FxGroup = 'lines' | 'bursts' | 'emanata' | 'atmosphere' | 'borders' | 'tones' | 'paper';
export const FX_GROUPS: readonly FxGroup[] = ['lines', 'bursts', 'emanata', 'atmosphere', 'borders', 'tones', 'paper'];

/** A registered generator version (fx/registry.ts). */
export interface FxGenerator {
  gen: string;
  v: number;
  /** Plain words for labels: "Speed lines" ("Added speed lines"). */
  name: string;
  group: FxGroup;
  params: Readonly<Record<string, FxParamSpec>>;
}

/** What a generator draws, in the layer's own 0..1 box: paths, circles and rects only (SVG and canvas draw the same). */
export type FxNode =
  | { tag: 'path'; d: string; fill?: string; stroke?: string; strokeW?: number; opacity?: number }
  | { tag: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; strokeW?: number; opacity?: number }
  | { tag: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; strokeW?: number; opacity?: number };

/** Where an effect is drawn: its layer box size in page units, so lines keep their weight on any aspect. */
export interface FxDrawContext {
  /** Layer box width ÷ height as shown. */
  aspect: number;
}

/** Generator ids as stored: lower-case words joined by '-'. */
export const FX_GEN_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** Parameter names as stored. */
export const FX_PARAM_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/;
