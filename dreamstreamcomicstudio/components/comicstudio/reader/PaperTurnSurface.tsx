import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { TurnEngine } from '../immersive/leafEngine';
import { type Vec } from '../immersive/flipGeometry';
import './paperTurnSurface.css';

export type PaperTurnDirection = -1 | 1;
export interface PaperTurnHandle {
  turn(direction: PaperTurnDirection): void;
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
  /** Actual sheet inside a larger reading mat. */
  paperElement?: () => HTMLElement | null;
}

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
const prefersStill = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
  const zoomed = () =>
    (typeof isZoomed === 'function' ? isZoomed() : isZoomed) ||
    (typeof window !== 'undefined' && (window.visualViewport?.scale ?? 1) > 1.01);

  function cancel() {
    gesture.current = null;
    active.current = null;
    engine.current?.destroy();
    engine.current = null;
    setTurn(null);
  }
  function finish(t: Turn, commit: boolean) {
    if (active.current !== t) return;
    cancel();
    if (commit && latest.current.pageKey === t.key && latest.current.canTurn(t.dir)) latest.current.onTurn(t.dir);
  }
  function begin(dir: PaperTurnDirection, drag?: Gesture) {
    if (active.current || !canTurn(dir)) return;
    const stage = root.current?.getBoundingClientRect();
    const box = paperElement?.()?.getBoundingClientRect() ?? stage;
    if (
      !enabled ||
      prefersStill() ||
      zoomed() ||
      !box ||
      box.width < 2 ||
      box.height < 2 ||
      (window.CSS?.supports && !window.CSS.supports('clip-path', 'polygon(0 0,100% 0,0 100%)'))
    ) {
      if (!drag) onTurn(dir);
      return;
    }
    const t: Turn = {
      key: pageKey,
      dir,
      width: box.width,
      height: box.height,
      left: box.left,
      top: box.top,
      offset: { x: box.left - (stage?.left ?? box.left), y: box.top - (stage?.top ?? box.top) },
      mirrored: rtl !== dir < 0,
      spread,
      drag
    };
    active.current = t;
    setTurn(t);
  }
  useImperativeHandle(ref, () => ({ turn: (dir) => begin(dir), cancel }));
  useLayoutEffect(() => {
    cancel();
    pointers.current.clear();
    return () => {
      active.current = null;
      engine.current?.destroy();
      engine.current = null;
    };
  }, [pageKey, rtl, spread, enabled]);

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
    if (!turn || active.current !== turn || !current.current || !back.current) return;
    const t = turn;
    let stopped = false;
    let deadline: number | undefined;
    const width = t.spread ? t.width / 2 : t.width;
    const start = () => {
      if (stopped || active.current !== t || engine.current) return;
      if (deadline !== undefined) window.clearTimeout(deadline);
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
    if (!enabled || active.current || zoomed() || onControl(target)) return;
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
      begin(direction, g);
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
  const W = turn ? (turn.spread ? turn.width / 2 : turn.width) : 0;
  const frontX = turn?.spread && !turn.mirrored ? W : 0;
  const backX = turn?.mirrored ? frontX + W : frontX - W;
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
      data-turning={turn ? 'true' : undefined}
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
      {turn && (
        <>
          <div
            ref={adjacent}
            inert
            aria-hidden
            className="paper-turn-preview"
            style={{ left: turn.offset.x, top: turn.offset.y, width: turn.width, height: turn.height }}
          >
            {renderAdjacent(turn.dir)}
          </div>
          <div
            inert
            aria-hidden
            className="paper-turn-cast-clip"
            style={{ left: turn.offset.x + frontX, top: turn.offset.y, width: W, height: turn.height }}
          >
            <div ref={cast} className="paper-turn-cast" />
          </div>
          <div
            ref={back}
            inert
            aria-hidden
            className="paper-turn-back"
            style={{ left: turn.offset.x + backX, top: turn.offset.y, width: W, height: turn.height }}
          >
            {turn.spread && (
              <div className="paper-turn-verso" style={{ left: -backX, width: turn.width }}>
                {renderAdjacent(turn.dir)}
              </div>
            )}
            <div ref={curl} className="paper-turn-curl" />
          </div>
        </>
      )}
    </div>
  );
});
