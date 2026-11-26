import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PageTurnStyle } from '../../../shared/comic/doc';
import { durationFor, TurnEngine } from '../immersive/leafEngine';
import { type Vec } from '../immersive/flipGeometry';
import { FLIP_DECODE_MS, FLIP_NEXT, FLIP_SWIPE_PX, flipClass, playFlip } from './pageFlip';
import './paperTurnSurface.css';

// The inline readers' page-turn stage (Classic ComicReader, ComicReaderView, the landing sample). One component for every
// page-turn style (`turnStyle`):
//   flip   the new page swings in from the spine (pageFlip.ts: index.css's classes, no per-frame JS). A turn first
//          mounts the incoming page in a hidden layer and waits (≤ FLIP_DECODE_MS) until its pictures have decoded,
//          so a slow phone never swings in a blank page; then the host commits and the new page swings in.
//   paper  the drag-to-fold paper turn (TurnEngine); the only style that follows the finger.
//   slide, fade  the TurnEngine's slide and crossfade, on the incoming page over (or under) the current one.
// Buttons, keys, taps and the host's jumps (Home / End) call the handle; a horizontal swipe turns every style (paper
// follows it). A pinch or a zoomed page never turns. Reduced motion (the OS setting or `reducedMotion`, the reader's
// own) lands every turn at once.

export type PaperTurnDirection = -1 | 1;
export interface PaperTurnHandle {
  turn(direction: PaperTurnDirection): void;
  /**
   * Go to a page that is not adjacent (Home, End): `commit` moves the host there. The flip waits for `preview` (the
   * target page) to decode, then swings it in; the other styles change at once.
   */
  jump(direction: PaperTurnDirection, commit: () => void, preview?: React.ReactNode): void;
  cancel(): void;
}
export interface PaperTurnProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onTurn'> {
  pageKey: string | number;
  rtl?: boolean;
  spread?: boolean;
  enabled?: boolean;
  isZoomed?: boolean | (() => boolean);
  canTurn(direction: PaperTurnDirection): boolean;
  onTurn(direction: PaperTurnDirection): void;
  renderAdjacent(direction: PaperTurnDirection): React.ReactNode;
  elementRef?: React.Ref<HTMLDivElement>;
  /** Actual sheet inside a larger reading mat (the flip swings it; the paper folds it). */
  paperElement?: () => HTMLElement | null;
  /** How the page turns (default 'paper'). */
  turnStyle?: PageTurnStyle;
  /** The reader's own Reduce motion: every turn lands at once (the OS setting always counts as well). */
  reducedMotion?: boolean;
  /** Flip: the swing's transform-origin (a spread swings as a pair around its spine); default the page's spine edge. */
  flipOrigin?: string;
  /**
   * Flip, a page taller than its window (fit to width): the swing's vertical pivot in px from the page's top, the middle
   * of what shows. The spine edge stays the class's (left going forward, right going back). `flipOrigin` wins.
   */
  flipOriginY?: number;
}

/** A committed flip swings in only if the host shows the new page within this long (a refused commit never swings later). */
const FLIP_COMMIT_WINDOW_MS = 1500;

interface Gesture {
  id: number;
  down: Vec;
  last: Vec;
  accepted: boolean;
  previousX: number;
  previousAt: number;
  velocity: number;
}
interface Turn {
  key: PaperTurnProps['pageKey'];
  kind: 'paper' | 'slide' | 'fade';
  dir: PaperTurnDirection;
  width: number;
  height: number;
  left: number;
  top: number;
  offset: Vec;
  mirrored: boolean;
  spread: boolean;
  drag?: Gesture;
  released?: 'commit' | 'cancel';
}
const point = (e: { clientX: number; clientY: number }): Vec => ({ x: e.clientX, y: e.clientY });
/** A flip waiting for its incoming page to decode. */
interface FlipWait {
  key: PaperTurnProps['pageKey'];
  dir: PaperTurnDirection;
  node: React.ReactNode;
  commit(): void;
}
const osStill = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const onControl = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    'button,a[href],input,textarea,select,[contenteditable="true"],[role="button"],[data-no-page-turn]'
  );
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const leafPoint = (t: Turn, p: Vec): Vec => ({
  x: t.mirrored ? t.left + t.width - p.x : p.x - t.left,
  y: p.y - t.top
});

/** Watch pictures already being loaded by the host. No additional fetch or retained image cache. */
function whenPagePaints(element: HTMLElement, ready: () => void): () => void {
  const loaded = new WeakMap<Element, string>();
  const decoding = new WeakMap<HTMLImageElement, string>();
  let watching = true;
  function check() {
    if (!watching || element.querySelector('[data-reader-art-loading]')) return;
    for (const image of element.querySelectorAll('img,svg image')) {
      if (image instanceof HTMLImageElement) {
        const src = image.currentSrc || image.src;
        if (!src) continue;
        if (!image.complete) return;
        if (image.naturalWidth && image.decode && loaded.get(image) !== src) {
          if (decoding.get(image) !== src) {
            decoding.set(image, src);
            const done = () => {
              loaded.set(image, src);
              check();
            };
            image.decode().then(done, done);
          }
          return;
        }
      } else {
        const src = image.getAttribute('href') || image.getAttribute('xlink:href');
        if (src && !src.startsWith('#') && loaded.get(image) !== src) return;
      }
    }
    stop();
    ready();
  }
  function settled(event: Event) {
    const node = event.target;
    if (node instanceof SVGElement)
      loaded.set(node, node.getAttribute('href') || node.getAttribute('xlink:href') || '');
    check();
  }
  const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(check) : undefined;
  observer?.observe(element, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-reader-art-loading', 'src', 'srcset', 'href']
  });
  element.addEventListener('load', settled, true);
  element.addEventListener('error', settled, true);
  function stop() {
    watching = false;
    observer?.disconnect();
    element.removeEventListener('load', settled, true);
    element.removeEventListener('error', settled, true);
  }
  check();
  return stop;
}

/** Inline paper stage. The host owns ordering, authorization, reading position and the accessible active face. */
export const PaperTurnSurface = forwardRef<PaperTurnHandle, PaperTurnProps>(function PaperTurnSurface(props, ref) {
  const {
    pageKey,
    rtl = false,
    spread = false,
    enabled = true,
    isZoomed,
    canTurn,
    onTurn,
    renderAdjacent,
    elementRef,
    paperElement,
    turnStyle = 'paper',
    reducedMotion = false,
    flipOrigin,
    flipOriginY,
    children,
    className,
    style,
    ...html
  } = props;
  const latest = useRef(props);
  latest.current = props;
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLDivElement>(null);
  const adjacent = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const curl = useRef<HTMLDivElement>(null);
  const cast = useRef<HTMLDivElement>(null);
  const engine = useRef<TurnEngine | null>(null);
  const active = useRef<Turn | null>(null);
  const [turn, setTurn] = useState<Turn | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Set<number>());
  const suppressClickUntil = useRef(0);
  const pointerTouchAt = useRef(-Infinity);
  const decode = useRef<HTMLDivElement>(null);
  const waiting = useRef<FlipWait | null>(null);
  const [wait, setWait] = useState<FlipWait | null>(null);
  /** A committed flip that swings in once the host shows the new page (its pageKey changes). */
  const pendingFlip = useRef<{ dir: PaperTurnDirection; from: PaperTurnProps['pageKey']; at: number } | null>(null);
  const stopFlip = useRef<(() => void) | null>(null);
  const zoomed = () =>
    (typeof isZoomed === 'function' ? isZoomed() : isZoomed) ||
    (typeof window !== 'undefined' && (window.visualViewport?.scale ?? 1) > 1.01);
  const prefersStill = () => latest.current.reducedMotion === true || osStill();
  /** The stage has a box on screen (a hidden or unmeasured stage turns at once: nobody would see a swing). */
  const laidOut = () => {
    const box = root.current?.getBoundingClientRect();
    return !!box && box.width >= 2 && box.height >= 2;
  };

  function cancel() {
    gesture.current = null;
    active.current = null;
    engine.current?.destroy();
    engine.current = null;
    setTurn(null);
    if (waiting.current) {
      waiting.current = null;
      setWait(null);
    }
    stopFlip.current?.();
    stopFlip.current = null;
  }
  /** Flip: mount the incoming page hidden, then (once it has decoded) commit and swing it in. */
  function flipTo(dir: PaperTurnDirection, commit: () => void, node: React.ReactNode) {
    const w: FlipWait = { key: latest.current.pageKey, dir, node, commit };
    waiting.current = w;
    setWait(w);
  }
  function finish(t: Turn, commit: boolean) {
    if (active.current !== t) return;
    cancel();
    if (commit && latest.current.pageKey === t.key && latest.current.canTurn(t.dir)) latest.current.onTurn(t.dir);
  }
  function begin(dir: PaperTurnDirection, drag?: Gesture) {
    if (active.current || waiting.current || !canTurn(dir)) return;
    // Only the paper follows a finger; every other style turns on the swipe's release.
    if (drag && turnStyle !== 'paper') return;
    if (turnStyle === 'flip') {
      if (!enabled || prefersStill() || zoomed() || !laidOut()) onTurn(dir);
      else flipTo(dir, () => latest.current.onTurn(dir), renderAdjacent(dir));
      return;
    }
    const stage = root.current?.getBoundingClientRect();
    const box = (turnStyle === 'paper' ? paperElement?.()?.getBoundingClientRect() : undefined) ?? stage;
    if (
      !enabled ||
      prefersStill() ||
      zoomed() ||
      !box ||
      box.width < 2 ||
      box.height < 2 ||
      (turnStyle === 'paper' && window.CSS?.supports && !window.CSS.supports('clip-path', 'polygon(0 0,100% 0,0 100%)'))
    ) {
      if (!drag) onTurn(dir);
      return;
    }
    const t: Turn = {
      key: pageKey,
      kind: turnStyle,
      dir,
      width: box.width,
      height: box.height,
      left: box.left,
      top: box.top,
      offset: { x: box.left - (stage?.left ?? box.left), y: box.top - (stage?.top ?? box.top) },
      mirrored: turnStyle === 'paper' ? rtl !== dir < 0 : rtl,
      spread,
      drag
    };
    active.current = t;
    setTurn(t);
  }
  function jump(dir: PaperTurnDirection, commit: () => void, preview?: React.ReactNode) {
    cancel();
    if (turnStyle === 'flip' && enabled && !prefersStill() && !zoomed() && laidOut()) flipTo(dir, commit, preview ?? null);
    else commit();
  }
  useImperativeHandle(ref, () => ({ turn: (dir) => begin(dir), jump, cancel }));
  useLayoutEffect(() => {
    cancel();
    pointers.current.clear();
    return () => {
      active.current = null;
      engine.current?.destroy();
      engine.current = null;
    };
  }, [pageKey, rtl, spread, enabled, turnStyle]);
  useLayoutEffect(() => () => stopFlip.current?.(), []);

  // Flip, step 1: the incoming page waits, hidden, until its pictures have decoded (or FLIP_DECODE_MS), then commits.
  useLayoutEffect(() => {
    const w = wait;
    if (!w || waiting.current !== w) return;
    let over = false;
    let stop: (() => void) | undefined;
    const go = () => {
      if (over || waiting.current !== w) return;
      over = true;
      window.clearTimeout(deadline);
      stop?.();
      waiting.current = null;
      setWait(null);
      // The host moved on meanwhile (another page, a mode change): nothing to commit.
      if (latest.current.pageKey !== w.key) return;
      pendingFlip.current = { dir: w.dir, from: w.key, at: performance.now() };
      w.commit();
    };
    const deadline = window.setTimeout(go, FLIP_DECODE_MS);
    if (decode.current) stop = whenPagePaints(decode.current, go);
    else go();
    return () => {
      over = true;
      window.clearTimeout(deadline);
      stop?.();
    };
  }, [wait]);

  // Flip, step 2: the host shows the new page (a new pageKey): it swings in from the spine.
  useLayoutEffect(() => {
    const p = pendingFlip.current;
    if (!p) return;
    pendingFlip.current = null;
    // A commit the host refused leaves the page where it was: no swing on a later, unrelated change.
    if (p.from === pageKey || performance.now() - p.at > FLIP_COMMIT_WINDOW_MS) return;
    const el = latest.current.paperElement?.() ?? current.current;
    if (!el || prefersStill()) return;
    stopFlip.current?.();
    const cls = flipClass(p.dir, rtl);
    const { flipOrigin: origin, flipOriginY: originY } = latest.current;
    stopFlip.current = playFlip(el, cls, {
      origin: origin ?? (originY === undefined ? undefined : `${cls === FLIP_NEXT ? 'left' : 'right'} ${originY}px`),
      done: () => {
        stopFlip.current = null;
      }
    });
  }, [pageKey]);

  useLayoutEffect(() => {
    const onResize = () => {
      if (active.current) cancel();
    };
    const onHidden = () => {
      if (document.hidden && active.current) cancel();
    };
    const onMotion = (event: MediaQueryListEvent) => {
      const t = active.current;
      if (event.matches && t) finish(t, !t.drag || t.released === 'commit');
    };
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener?.('change', onMotion);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      media?.removeEventListener?.('change', onMotion);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []);

  useLayoutEffect(() => {
    if (!turn || active.current !== turn || !current.current || (turn.kind === 'paper' && !back.current)) return;
    const t = turn;
    let stopped = false;
    let deadline: number | undefined;
    const width = t.spread && t.kind === 'paper' ? t.width / 2 : t.width;
    const start = () => {
      if (stopped || active.current !== t || engine.current) return;
      if (deadline !== undefined) window.clearTimeout(deadline);
      if (t.kind !== 'paper') {
        // Slide and fade: the incoming page (the preview) over, or under, the current one.
        const runner = new TurnEngine(
          {
            W: width,
            H: t.height,
            bookW: t.width,
            spineX: 0,
            durationMs: durationFor(t.kind, t.spread, false),
            plan: {
              kind: t.kind,
              dir: t.dir,
              from: 0,
              to: t.dir,
              leafSide: 'center',
              mirrored: t.mirrored,
              mode: t.dir > 0 ? 'forward' : 'reverse',
              staticKeys: [],
              underKeys: [],
              incomingKeys: [],
              outgoingKeys: []
            }
          },
          { incoming: [{ root: adjacent.current }], outgoing: [{ root: current.current }] },
          { onDone: (outcome) => finish(t, outcome === 'commit') }
        );
        engine.current = runner;
        runner.startAuto();
        return;
      }
      const runner = new TurnEngine(
        {
          W: width,
          H: t.height,
          bookW: t.width,
          spineX: t.spread ? width : t.mirrored ? width : 0,
          wholeSpreadFront: t.spread,
          frontOffset: !t.spread && (t.offset.x || t.offset.y) ? t.offset : undefined,
          durationMs: t.spread ? 480 : 390,
          plan: {
            kind: 'paper',
            dir: t.dir,
            from: 0,
            to: t.dir,
            leafSide: t.spread ? (t.mirrored ? 'left' : 'right') : 'center',
            mirrored: t.mirrored,
            mode: 'forward',
            staticKeys: [],
            underKeys: [],
            incomingKeys: [],
            outgoingKeys: []
          }
        },
        {
          front: { root: current.current },
          back: { root: back.current, curl: curl.current },
          cast: cast.current,
          incoming: [],
          outgoing: []
        },
        { onDone: (outcome) => finish(t, outcome === 'commit') }
      );
      engine.current = runner;
      if (t.drag && !t.released) {
        runner.startDrag(leafPoint(t, t.drag.down), t.drag.down.y - t.top);
        runner.dragTo(leafPoint(t, t.drag.last));
      } else runner.startAuto();
    };
    // Keep the actual current page visible if a new private/public image still needs network/decoding.
    // A broken image must still be able to open the host's ordinary 'unavailable' state.
    deadline = window.setTimeout(() => finish(t, t.released === 'commit' || !t.drag), 1800);
    const stopWatching = adjacent.current ? whenPagePaints(adjacent.current, start) : undefined;
    if (!adjacent.current) start();
    return () => {
      stopped = true;
      window.clearTimeout(deadline);
      stopWatching?.();
      engine.current?.destroy();
      engine.current = null;
    };
  }, [turn]);

  function down(id: number, p: Vec, target: EventTarget | null) {
    pointers.current.add(id);
    if (pointers.current.size > 1) {
      cancel();
      return;
    }
    if (!enabled || active.current || waiting.current || zoomed() || onControl(target)) return;
    gesture.current = {
      id,
      down: p,
      last: p,
      accepted: false,
      previousX: p.x,
      previousAt: performance.now(),
      velocity: 0
    };
  }
  function move(id: number, p: Vec) {
    const g = gesture.current;
    if (!g || g.id !== id) return;
    if (zoomed()) {
      cancel();
      return;
    }
    const dx = p.x - g.down.x,
      dy = p.y - g.down.y;
    const time = performance.now();
    if (time > g.previousAt && p.x !== g.previousX) {
      g.velocity = (p.x - g.previousX) / Math.max(8, time - g.previousAt);
      g.previousX = p.x;
      g.previousAt = time;
    }
    g.last = p;
    if (!g.accepted) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      if (Math.abs(dx) < 9 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      const direction = dx < 0 !== rtl ? 1 : -1;
      if (!canTurn(direction)) {
        gesture.current = null;
        return;
      }
      g.accepted = true;
      // Paper lifts the leaf now and follows the finger; the other styles turn when the swipe is released.
      if (turnStyle === 'paper') begin(direction, g);
    }
    const t = active.current;
    if (t) engine.current?.dragTo(leafPoint(t, p));
  }
  function up(id: number, p: Vec, aborted = false) {
    pointers.current.delete(id);
    const g = gesture.current;
    if (!g || g.id !== id) return;
    if (!aborted) move(id, p);
    if (gesture.current !== g) return;
    gesture.current = null;
    if (!g.accepted) return;
    suppressClickUntil.current = performance.now() + 350;
    const dx = p.x - g.down.x,
      dy = p.y - g.down.y;
    if (turnStyle !== 'paper') {
      // A swipe: at least FLIP_SWIPE_PX, mostly horizontal, one finger, never while zoomed (the Classic reader's rule).
      if (aborted || zoomed() || Math.abs(dx) < FLIP_SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      begin(dx < 0 !== rtl ? 1 : -1);
      return;
    }
    const t = active.current;
    const dir = t?.dir ?? (dx < 0 !== rtl ? 1 : -1);
    const distance = dx * (rtl ? dir : -dir);
    const width = (t?.width ?? root.current?.clientWidth ?? 0) / (t?.spread ? 2 : 1);
    const threshold = clamp(width * 0.2, 45, 115);
    const velocity = performance.now() - g.previousAt < 95 ? g.velocity * (rtl ? dir : -dir) : 0;
    const commit =
      !aborted &&
      !zoomed() &&
      Math.abs(dx) > Math.abs(dy) * 1.15 &&
      (distance >= threshold || (distance >= 38 && velocity >= 0.6));
    if (t) {
      t.released = commit ? 'commit' : 'cancel';
      if (engine.current) engine.current.release(t.released);
      else if (!commit) finish(t, false);
    } else if (commit && canTurn(dir)) onTurn(dir);
  }
  const isFallbackTouch = () => performance.now() - pointerTouchAt.current > 700;
  const pinch = () => {
    cancel();
    gesture.current = null;
  };
  const paperTurn = turn?.kind === 'paper' ? turn : null;
  const W = paperTurn ? (paperTurn.spread ? paperTurn.width / 2 : paperTurn.width) : 0;
  const frontX = paperTurn?.spread && !paperTurn.mirrored ? W : 0;
  const backX = paperTurn?.mirrored ? frontX + W : frontX - W;
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      if (typeof elementRef === 'function') elementRef(el);
      else if (elementRef) elementRef.current = el;
    },
    [elementRef]
  );
  return (
    <div
      {...html}
      ref={setRoot}
      data-paper-turn-surface=""
      data-turn-style={turnStyle}
      data-turning={turn ? 'true' : undefined}
      data-turn-kind={turn?.kind}
      data-turn-dir={turn ? turn.dir : undefined}
      data-rtl={rtl ? '' : undefined}
      data-spread={spread ? '' : undefined}
      aria-busy={wait ? true : undefined}
      className={['paper-turn-surface', className].filter(Boolean).join(' ')}
      style={{ touchAction: enabled && !zoomed() ? 'pan-y pinch-zoom' : undefined, ...style }}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') pointerTouchAt.current = performance.now();
        if (e.button === 0) down(e.pointerId, point(e), e.target);
        html.onPointerDown?.(e);
      }}
      onPointerMove={(e) => {
        move(e.pointerId, point(e));
        if (gesture.current?.accepted && !e.currentTarget.hasPointerCapture?.(e.pointerId))
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* already released */
          }
        html.onPointerMove?.(e);
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'touch') pointerTouchAt.current = performance.now();
        up(e.pointerId, point(e));
        html.onPointerUp?.(e);
      }}
      onPointerCancel={(e) => {
        up(e.pointerId, point(e), true);
        html.onPointerCancel?.(e);
      }}
      onLostPointerCapture={(e) => {
        if (e.target === e.currentTarget) up(e.pointerId, point(e), true);
        html.onLostPointerCapture?.(e);
      }}
      onTouchStart={(e) => {
        if (isFallbackTouch()) {
          if (e.touches.length !== 1) pinch();
          else {
            const p = e.touches[0];
            down(p.identifier, point(p), e.target);
          }
        }
        html.onTouchStart?.(e);
      }}
      onTouchMove={(e) => {
        if (isFallbackTouch() && e.touches.length === 1) {
          const p = e.touches[0];
          move(p.identifier, point(p));
        }
        html.onTouchMove?.(e);
      }}
      onTouchEnd={(e) => {
        if (isFallbackTouch() && e.touches.length === 0) {
          const p = e.changedTouches[0];
          if (p) up(p.identifier, point(p));
          pointers.current.clear();
        }
        html.onTouchEnd?.(e);
      }}
      onTouchCancel={(e) => {
        if (isFallbackTouch()) {
          pinch();
          pointers.current.clear();
        }
        html.onTouchCancel?.(e);
      }}
      onClickCapture={(e) => {
        if (performance.now() < suppressClickUntil.current) {
          e.preventDefault();
          e.stopPropagation();
        } else html.onClickCapture?.(e);
      }}
      onDragStart={(e) => {
        if (e.target instanceof HTMLImageElement) e.preventDefault();
        html.onDragStart?.(e);
      }}
    >
      <div className="paper-turn-face" ref={current}>
        {children}
      </div>
      {wait && (
        // The incoming page of a flip, decoding out of sight (never read out, never focusable).
        <div ref={decode} inert aria-hidden data-decode="" className="paper-turn-preview">
          {wait.node}
        </div>
      )}
      {turn && turn.kind !== 'paper' && (
        <div
          ref={adjacent}
          inert
          aria-hidden
          className="paper-turn-preview"
          style={{ left: turn.offset.x, top: turn.offset.y, width: turn.width, height: turn.height }}
        >
          {renderAdjacent(turn.dir)}
        </div>
      )}
      {paperTurn && (
        <>
          <div
            ref={adjacent}
            inert
            aria-hidden
            className="paper-turn-preview"
            style={{ left: paperTurn.offset.x, top: paperTurn.offset.y, width: paperTurn.width, height: paperTurn.height }}
          >
            {renderAdjacent(paperTurn.dir)}
          </div>
          <div
            inert
            aria-hidden
            className="paper-turn-cast-clip"
            style={{ left: paperTurn.offset.x + frontX, top: paperTurn.offset.y, width: W, height: paperTurn.height }}
          >
            <div ref={cast} className="paper-turn-cast" />
          </div>
          <div
            ref={back}
            inert
            aria-hidden
            className="paper-turn-back"
            style={{ left: paperTurn.offset.x + backX, top: paperTurn.offset.y, width: W, height: paperTurn.height }}
          >
            {paperTurn.spread && (
              <div className="paper-turn-verso" style={{ left: -backX, width: paperTurn.width }}>
                {renderAdjacent(paperTurn.dir)}
              </div>
            )}
            <div ref={curl} className="paper-turn-curl" />
          </div>
        </>
      )}
    </div>
  );
});
