// Where the mic's floating boxes go (the settings, the recording bar, the error): next to the mic, lined up with
// the side it sits on, and always inside what the person can see. Pure placement plus one DOM reader.
//
// The boxes stay in the mic's own subtree (absolutely positioned against it) instead of a portal: inside a sheet
// they keep the sheet's focus trap and its outside-tap rule, and a tap on the bar never counts as "outside".
// So the visible area is the viewport (the visual viewport when the phone keyboard is up) cut down by every
// ancestor that clips its overflow (a scrolling sheet).

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BoxPlacement {
  /** Viewport coordinates of the box's top-left corner. */
  left: number;
  top: number;
  /** The box's width once it is fitted (never wider than the visible area less the gutters). */
  width: number;
  /** The most the box may grow to on its side. */
  maxHeight: number;
  side: 'top' | 'bottom';
}

/** Kept between a box and the edge of what is visible. */
export const VOICE_BOX_GUTTER = 8;
/** Between the mic and its box. */
export const VOICE_BOX_GAP = 8;

/**
 * Place a box of `size` by `anchor` inside `bounds`: above it unless there is clearly more room below (a mic in a
 * header pinned to the top of the screen), lined up with the anchor's start or end edge, then clamped so every
 * edge stays `gutter` inside the bounds.
 */
export const placeVoiceBox = (
  anchor: Rect,
  size: { width: number; height: number },
  bounds: Rect,
  align: 'start' | 'end',
  gap = VOICE_BOX_GAP,
  gutter = VOICE_BOX_GUTTER
): BoxPlacement => {
  const span = Math.max(0, bounds.right - bounds.left - gutter * 2);
  const width = Math.min(size.width, span);
  const wanted = align === 'start' ? anchor.left : anchor.right - width;
  const left = Math.max(bounds.left + gutter, Math.min(wanted, bounds.right - gutter - width));
  const roomAbove = anchor.top - gap - (bounds.top + gutter);
  const roomBelow = bounds.bottom - gutter - (anchor.bottom + gap);
  const side: 'top' | 'bottom' = size.height <= roomAbove || roomAbove >= roomBelow ? 'top' : 'bottom';
  const maxHeight = Math.max(0, side === 'top' ? roomAbove : roomBelow);
  const height = Math.min(size.height, maxHeight);
  const top = side === 'top' ? anchor.top - gap - height : anchor.bottom + gap;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight: Math.round(maxHeight), side };
};

const intersect = (a: Rect, b: Rect): Rect => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom)
});

/** The part of the page the person can see around `el`: the (visual) viewport cut by every clipping ancestor. */
export const visibleBoundsOf = (el: HTMLElement): Rect => {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  let bounds: Rect = vv
    ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // `display: contents` and the like clip nothing
    bounds = intersect(bounds, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return bounds;
};
