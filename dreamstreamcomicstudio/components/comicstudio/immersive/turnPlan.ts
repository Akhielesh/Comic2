// Which page plays which part in a turn, and how each layer is stacked (pure; reader.md §3.3–§3.6).
//
// Every page in the mount window is ONE persistent element at its slot; a turn only changes roles:
//   static  — stays flat and visible (the facing page that isn't turning)
//   under   — revealed beneath the turning leaf (the target page on the leaf's side)
//   front   — the turning leaf's visible face (clipped to its static part each frame)
//   back    — the face that lands on the other side (transformed + clipped each frame); in single-page
//             layouts the back is paper (or the inside cover for the board), drawn as an extra layer
//   incoming / outgoing — slide and fade transitions
// Nothing remounts when a turn starts or ends, so lettering never re-measures mid-flip.

import type { ReaderItem } from '../reader/readerModel';
import type { BookGeometry, BookView, ReaderLayout, SlotContent, SlotSide } from './readerLayout';

export type TurnKind = 'paper' | 'board' | 'riffle' | 'slide' | 'fade';
export type TurnStyle = 'paper' | 'slide' | 'fade';
export type LayerRole = 'static' | 'hidden' | 'front' | 'back' | 'under' | 'incoming' | 'outgoing';

export const contentKey = (c: SlotContent): string => (c.kind === 'item' ? `i${c.index}` : c.kind === 'endpaper' ? `ep-${c.side}` : c.kind);

export interface TurnPlan {
  kind: TurnKind;
  dir: 1 | -1;
  from: number;
  to: number;
  /** Side of the spine the leaf starts on ('center' in single-page layouts). */
  leafSide: SlotSide;
  /** The leaf lies left of its spine (RTL forward, LTR backward in spreads; RTL single pages). */
  mirrored: boolean;
  /** forward: the leaf lifts away from flat (progress 0 → 1); reverse: a turned leaf comes back (1 → 0). */
  mode: 'forward' | 'reverse';
  frontKey?: string;
  /** Persistent element that lands on the other side (spreads). Absent → an extra layer (`backExtra`). */
  backKey?: string;
  backExtra?: 'paper' | 'endpaper';
  /** For the paper back's show-through: the front's content. */
  frontContent?: SlotContent;
  staticKeys: string[];
  underKeys: string[];
  incomingKeys: string[];
  outgoingKeys: string[];
  riffle?: number;
}

const slotOn = (geom: BookGeometry, side: SlotSide): SlotContent => geom.slots.find((s) => s.side === side)?.content ?? { kind: 'blank' };
const keyOf = (c: SlotContent): string | undefined => (c.kind === 'blank' ? undefined : contentKey(c));
const keysOf = (geom: BookGeometry): string[] => geom.slots.map((s) => keyOf(s.content)).filter((k): k is string => !!k);
const isCover = (c: SlotContent, items: ReaderItem[]) => c.kind === 'item' && items[c.index]?.kind === 'cover';
const isInsideCover = (c: SlotContent) => c.kind === 'endpaper' && c.side === 'front';

export interface PlanInput {
  layout: ReaderLayout;
  rtl: boolean;
  style: TurnStyle;
  /** Low-power devices and dual-screen hinges slide instead of folding. */
  lowPower: boolean;
  items: ReaderItem[];
  from: number;
  to: number;
  geomFrom: BookGeometry;
  geomTo: BookGeometry;
  riffle?: number;
}

export const planTurn = (p: PlanInput): TurnPlan => {
  const dir: 1 | -1 = p.to > p.from ? 1 : -1;
  const base = { dir, from: p.from, to: p.to, staticKeys: [] as string[], underKeys: [] as string[], incomingKeys: [] as string[], outgoingKeys: [] as string[] };
  const simple = p.style !== 'paper' || p.lowPower || p.layout === 'strip' || p.geomFrom.gap > 2;
  if (simple) {
    const kind: TurnKind = p.style === 'fade' && !p.lowPower ? 'fade' : 'slide';
    return {
      ...base,
      kind,
      leafSide: 'center',
      mirrored: p.rtl,
      mode: dir > 0 ? 'forward' : 'reverse',
      incomingKeys: keysOf(p.geomTo),
      outgoingKeys: keysOf(p.geomFrom)
    };
  }
  if (p.layout !== 'spread') {
    const a = slotOn(p.geomFrom, 'center');
    const b = slotOn(p.geomTo, 'center');
    const forward = dir > 0;
    const leaf = forward ? a : b;
    const board = isCover(leaf, p.items);
    const riffle = p.riffle && p.riffle > 2 && !board ? p.riffle : undefined;
    return {
      ...base,
      kind: board ? 'board' : riffle ? 'riffle' : 'paper',
      leafSide: 'center',
      mirrored: p.rtl,
      mode: forward ? 'forward' : 'reverse',
      frontKey: keyOf(leaf),
      backExtra: board ? 'endpaper' : 'paper',
      frontContent: leaf,
      underKeys: [keyOf(forward ? b : a)].filter((k): k is string => !!k),
      ...(riffle ? { riffle } : {})
    };
  }
  // Spread: the leaf starts on the reading-forward side for a forward turn, the other side going back.
  const forwardSide: SlotSide = p.rtl ? 'left' : 'right';
  const leafSide: SlotSide = dir > 0 ? forwardSide : forwardSide === 'right' ? 'left' : 'right';
  const otherSide: SlotSide = leafSide === 'right' ? 'left' : 'right';
  const front = slotOn(p.geomFrom, leafSide);
  const stat = slotOn(p.geomFrom, otherSide);
  const under = slotOn(p.geomTo, leafSide);
  const back = slotOn(p.geomTo, otherSide);
  const board = isCover(front, p.items) || isCover(back, p.items) || (isInsideCover(front) && dir < 0);
  const riffle = p.riffle && p.riffle > 2 && !board ? p.riffle : undefined;
  return {
    ...base,
    kind: board ? 'board' : riffle ? 'riffle' : 'paper',
    leafSide,
    mirrored: leafSide === 'left',
    mode: 'forward',
    frontKey: keyOf(front),
    backKey: keyOf(back),
    ...(keyOf(back) ? {} : { backExtra: 'paper' as const }),
    frontContent: front,
    staticKeys: [keyOf(stat)].filter((k): k is string => !!k),
    underKeys: [keyOf(under)].filter((k): k is string => !!k),
    ...(riffle ? { riffle } : {})
  };
};

/** Stacking for a layer: hidden layers don't paint; the turning parts sit above the flat ones. */
export const LAYER_Z: Record<LayerRole, number> = { hidden: 0, static: 1, under: 1, outgoing: 1, incoming: 3, front: 3, back: 6 };

/** Role of a mounted layer key for the current motion (null plan = idle: the current view is static). */
export const roleOf = (key: string, currentKeys: string[], plan: TurnPlan | null): LayerRole => {
  if (!plan) return currentKeys.includes(key) ? 'static' : 'hidden';
  if (plan.kind === 'slide' || plan.kind === 'fade') {
    // Going back with a slide, the current page slides away on top of the previous one.
    if (plan.incomingKeys.includes(key)) return plan.dir < 0 && plan.kind === 'slide' ? 'under' : 'incoming';
    if (plan.outgoingKeys.includes(key)) return plan.dir < 0 && plan.kind === 'slide' ? 'front' : 'outgoing';
    return 'hidden';
  }
  if (key === plan.frontKey) return 'front';
  if (key === plan.backKey) return 'back';
  if (plan.underKeys.includes(key)) return 'under';
  if (plan.staticKeys.includes(key)) return 'static';
  return 'hidden';
};

/** Keys to keep mounted: views current ±1 plus a running turn's target (images decode, lettering measures). */
export const mountWindow = (views: BookView[], view: number, extraViews: number[] = []): number[] => {
  const set = new Set<number>();
  for (const v of [view - 1, view, view + 1, ...extraViews]) if (v >= 0 && v < views.length) set.add(v);
  return [...set].sort((a, b) => a - b);
};
