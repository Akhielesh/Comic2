// The book on the reading-room desk (reader.md §3.4, §4, §5): single pages, spreads and strips, the
// pointer / wheel / pinch pipeline, the Leaf turn engine, and the Guided View camera.
//
// Every page in the mount window (views current ±1, plus a running turn's target) is one persistent
// element at its slot. A turn only changes roles (static / under / front / back) and lets the engine
// write transforms and clip-paths per frame — nothing remounts, so the lettering never re-measures
// mid-flip and no image ever flashes white.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { ReaderItem } from '../reader/readerModel';
import { decideRelease } from './flipPhysics';
import { bookToLeaf, leafFrame, type Vec } from './flipGeometry';
import { cameraDuration, cameraFor, spotlightRect, stopAtPoint, IDENTITY_CAMERA, type Camera, type GuidedStop } from './guidedModel';
import { durationFor, recordTurnPerf, TurnEngine, type EngineEls, type LeafPart } from './leafEngine';
import { emptyLeafRefs, PageLeaf, type LeafExtraRefs } from './PageLeaf';
import { playPageTurn } from './paperSound';
import { bookGeometry, letterbox, type BookGeometry, type BookView, type LayoutDecision } from './readerLayout';
import { isDoubleTap, tapCommand, WheelAccumulator, type ReaderCommand } from './readerInput';
import type { ReaderEvent, ReaderState } from './readerMachine';
import { gutterFor, ReaderSlot, type SlotImage, type SlotRefs } from './ReaderSlot';
import { contentKey, LAYER_Z, mountWindow, planTurn, roleOf, type TurnPlan, type TurnStyle } from './turnPlan';
import { Spotlight, useCameraAnimator } from './GuidedCamera';
import { useCachedImage, pickVariant } from './pageImageCache';
import type { WidthClass } from '../mobile/formFactor';

export interface BookStageProps {
  doc: ComicDoc;
  items: ReaderItem[];
  views: BookView[];
  state: ReaderState;
  dispatch(e: ReaderEvent): void;
  /** Room size inside the safe areas. */
  size: { w: number; h: number };
  decision: LayoutDecision;
  widthClass: WidthClass;
  /** The book's trim (page box aspect, w/h). */
  trim: number;
  aspectOf(itemIndex: number): number;
  rtl: boolean;
  turnStyle: TurnStyle;
  lowPower: boolean;
  paper: boolean;
  img: Omit<SlotImage, 'original'>;
  dedication?: string;
  endCard: React.ReactNode;
  hinge?: { start: number; end: number };
  stopsOf(view: number): GuidedStop[];
  balloonPop: boolean;
  sound: boolean;
  /** Mouse peel teaser on page corners (fine pointers, motion allowed). */
  peel: boolean;
  onCommand(cmd: ReaderCommand): void;
  /** Double-tap on a page: where (view + page-normalized point). */
  onDoubleTap(view: number, point: { x: number; y: number }): void;
  onFrames(deltas: number[], kind: string): void;
  onImageError?(): void;
  onExpired?(): void;
  /** Extra mount (views to keep warm), e.g. the resume target. */
  warmViews?: number[];
  /** A riffle/goto target palette etc. — the stage reports which items are on screen. */
  onVisibleItems?(items: number[]): void;
}

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [data-no-turn]';
const DRAG_SLOP = 6;

interface DragInfo {
  pointerId: number;
  dir: 1 | -1;
  startClient: Vec;
  latestClient: Vec;
  grabY: number;
  frameMirrored: boolean;
  peek?: boolean;
}

export const BookStage: React.FC<BookStageProps> = (props) => {
  const { doc, items, views, state, dispatch, size, decision, widthClass, trim, aspectOf, rtl, turnStyle, lowPower, paper, img, dedication, endCard, hinge, stopsOf, balloonPop, sound } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef(new Map<string, SlotRefs>());
  const leafRefs = useRef<LeafExtraRefs>(emptyLeafRefs());
  const engine = useRef<TurnEngine | null>(null);
  const engineMotion = useRef<unknown>(null);
  const drag = useRef<DragInfo | null>(null);
  const down = useRef<{ id: number; x: number; y: number; t: number; type: string; lx: number; ly: number } | null>(null);
  const pointers = useRef(new Map<number, Vec>());
  const pinch = useRef<{ d0: number; s0: number; mid: Vec; cam0: Camera } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheel = useRef(new WheelAccumulator());
  const camera = useCameraAnimator(wrapperRef, spotRef);
  const [layoutScale, setLayoutScale] = useState(1);
  const [cameraIdle, setCameraIdle] = useState(true);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const layout = state.layout;
  const motion = state.motion;
  const reduced = state.reduced;
  const fit = decision.fit;

  // ── Geometry ──────────────────────────────────────────────────────────────
  const geomAt = useCallback(
    (v: number, scale = 1): BookGeometry =>
      bookGeometry({
        view: views[v] ?? views[0] ?? { slots: [{ kind: 'blank' }], items: [], key: 'blank' },
        stage: size,
        layout: layout === 'spread' ? 'spread' : 'single',
        rtl,
        aspectOf,
        pageAspect: trim,
        fit,
        widthClass,
        hinge: decision.perSegment ? hinge : undefined,
        scale
      }),
    [views, size, layout, rtl, aspectOf, trim, fit, widthClass, decision.perSegment, hinge]
  );
  const geom1 = useMemo(() => geomAt(state.view, 1), [geomAt, state.view]);
  const geomL = useMemo(() => geomAt(state.view, layoutScale), [geomAt, state.view, layoutScale]);

  // ── Turn plan ─────────────────────────────────────────────────────────────
  const plan: TurnPlan | null = useMemo(() => {
    if (motion.kind === 'idle') return null;
    const from = state.view;
    const to = motion.to;
    if (to === from || !views[to]) return null;
    return planTurn({
      layout: layout === 'spread' ? 'spread' : layout === 'strip' ? 'strip' : 'single',
      rtl,
      // Reduced motion: a drag (the only turn that still animates; taps and keys land at once) is a
      // crossfade whose opacity follows the finger — never a fold or a slide.
      style: reduced ? 'fade' : turnStyle,
      lowPower: reduced ? false : lowPower,
      items,
      from,
      to,
      geomFrom: geomAt(from),
      geomTo: geomAt(to),
      riffle: motion.kind === 'turn' ? motion.riffle : undefined
    });
  }, [motion, state.view, views, layout, rtl, turnStyle, lowPower, reduced, items, geomAt]);

  // ── Layers (mount window) ─────────────────────────────────────────────────
  const mounted = useMemo(() => {
    const extra = plan ? [plan.to] : [];
    const vs = mountWindow(views, state.view, [...extra, ...(props.warmViews || [])]);
    const out = new Map<string, { view: number; slotIdx: number }>();
    for (const v of vs) {
      geomAt(v).slots.forEach((s, i) => {
        if (s.content.kind === 'blank') return;
        const key = contentKey(s.content);
        // The current view's placement wins; a target's otherwise.
        if (!out.has(key) || v === state.view || (plan && v === plan.to && out.get(key)!.view !== state.view)) out.set(key, { view: v, slotIdx: i });
      });
    }
    return out;
  }, [views, state.view, plan, props.warmViews, geomAt]);

  const currentKeys = useMemo(() => geom1.slots.filter((s) => s.content.kind !== 'blank').map((s) => contentKey(s.content)), [geom1]);

  useEffect(() => {
    props.onVisibleItems?.(views[state.view]?.items ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view, views]);

  // ── Guided camera ─────────────────────────────────────────────────────────
  const pageRect1 = useMemo(() => ({ x: geom1.book.x, y: geom1.book.y, w: geom1.page.w, h: geom1.page.h }), [geom1]);
  const guidedOn = state.guided.on;
  const stops = useMemo(() => (guidedOn ? stopsOf(state.view) : []), [guidedOn, stopsOf, state.view]);
  const stop = stops[Math.min(stops.length - 1, Math.max(0, state.guided.stop))];
  const spotFor = useCallback(
    (cam: Camera) => (guidedOn && stop && stop.panelIndex >= 0 && motion.kind === 'idle' ? spotlightRect(stop.box, pageRect1, cam) : null),
    [guidedOn, stop, pageRect1, motion.kind]
  );

  const settleCrisp = useCallback(
    (cam: Camera) => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        const L = cam.s > 1.05 ? Math.round(cam.s * 1000) / 1000 : 1;
        setLayoutScale(L);
        setCameraIdle(true);
      }, 120);
    },
    []
  );

  // Camera follows the guided stop (or returns to the whole book).
  useEffect(() => {
    if (state.zoom && !guidedOn) return; // free zoom drives the camera itself
    const busy = motion.kind !== 'idle';
    const target = guidedOn && stop && !busy ? cameraFor(stop, pageRect1, size.w, size.h) : IDENTITY_CAMERA(size.w, size.h);
    const from = camera.current.current;
    const same = Math.abs(from.s - target.s) < 1e-3 && Math.abs(from.tx - target.tx) < 0.5 && Math.abs(from.ty - target.ty) < 0.5;
    if (same) {
      camera.set(target, spotFor(target));
      if (layoutScale !== (target.s > 1.05 ? Math.round(target.s * 1000) / 1000 : 1)) settleCrisp(target);
      return;
    }
    setCameraIdle(false);
    // Reduced motion: the camera cuts (no glide) behind a 140 ms fade (reader.md §8).
    const wrap = wrapperRef.current;
    if (reduced && wrap && typeof wrap.animate === 'function') wrap.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
    const zoomOutForTurn = busy && guidedOn;
    camera.move({
      to: target,
      durationMs: reduced ? 0 : zoomOutForTurn ? 300 : cameraDuration(from, target, size.w, size.h),
      ease: Math.abs(Math.log(target.s / Math.max(1e-6, from.s))) > 0.05 ? 'camera' : 'paper',
      spotFor,
      onDone: () => settleCrisp(target)
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedOn, stop, pageRect1.x, pageRect1.y, pageRect1.w, pageRect1.h, size.w, size.h, motion.kind, reduced]);

  // Keep the wrapper transform right after a re-layout at a new scale.
  useLayoutEffect(() => {
    camera.setLayoutScale(layoutScale);
  }, [layoutScale, camera]);

  // Free zoom: the machine's zoom (null = reset).
  useEffect(() => {
    if (guidedOn) return;
    if (!state.zoom) {
      if (camera.current.current.s !== 1 || camera.current.current.tx !== 0 || camera.current.current.ty !== 0) {
        camera.move({ to: IDENTITY_CAMERA(size.w, size.h), durationMs: reduced ? 0 : 260, onDone: () => settleCrisp(IDENTITY_CAMERA(size.w, size.h)) });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.zoom, guidedOn]);

  // ── Engine lifecycle ──────────────────────────────────────────────────────
  const ready = layoutScale === 1 && cameraIdle;
  useLayoutEffect(() => {
    if (!plan || motion.kind === 'idle') {
      if (engine.current) {
        engine.current.destroy();
        engine.current = null;
      }
      engineMotion.current = null;
      return;
    }
    // A cancel of a running auto turn, or a drag release: steer the existing engine.
    if (engine.current && engineMotion.current && motion.kind === 'settle') {
      const prev = engineMotion.current as ReaderState['motion'];
      if (prev.kind === 'turn' && motion.outcome === 'cancel') engine.current.springBack();
      engineMotion.current = motion;
      return;
    }
    if (engine.current && engineMotion.current === motion) return;
    if (!ready) return; // guided: zoom out first, the camera effect brings us back here
    if (engine.current) {
      engine.current.destroy();
      engine.current = null;
    }
    const W = geom1.page.w;
    const H = geom1.page.h;
    const part = (key?: string): LeafPart | undefined => {
      if (!key) return undefined;
      const r = slotRefs.current.get(key);
      return r ? { root: r.root, curl: r.curl, shade: r.shade } : undefined;
    };
    const fromG = geomAt(plan.from);
    const leafRect = plan.leafSide === 'center' ? fromG.slots[0] : fromG.slots.find((s) => s.side === plan.leafSide);
    const spineX = plan.leafSide === 'center' ? (rtl ? (leafRect?.x ?? 0) + W : leafRect?.x ?? 0) : geom1.spineX;
    const els: EngineEls = {
      front: part(plan.frontKey),
      back: plan.backKey ? part(plan.backKey) : leafRefs.current.back,
      castBox: leafRefs.current.castBox,
      cast: leafRefs.current.cast,
      shadow: leafRefs.current.shadow,
      book: bookRef.current,
      incoming: plan.incomingKeys.map((k) => part(k)).filter((p): p is LeafPart => !!p),
      outgoing: plan.outgoingKeys.map((k) => part(k)).filter((p): p is LeafPart => !!p)
    };
    if (plan.kind === 'riffle' && plan.riffle) {
      const n = plan.riffle;
      els.leaves = Array.from({ length: n }, (_, i) => {
        const realFront = plan.mode === 'forward' ? i === 0 : i === n - 1;
        return {
          front: realFront ? els.front ?? { root: null } : leafRefs.current.riffleFronts[i] ?? { root: null },
          back: i === n - 1 ? els.back ?? { root: null } : leafRefs.current.riffleBacks[i] ?? { root: null }
        };
      });
    }
    const slotX = new Map<HTMLElement, number>();
    for (const k of [...plan.incomingKeys, ...plan.outgoingKeys]) {
      const r = slotRefs.current.get(k)?.root;
      const m = mounted.get(k);
      if (r && m) slotX.set(r, geomAt(m.view).slots[m.slotIdx]?.x ?? 0);
    }
    const chained = motion.kind === 'turn' && !!motion.chained;
    const eng = new TurnEngine(
      {
        plan,
        W,
        H,
        spineX,
        bookW: geom1.book.w,
        slotX,
        durationMs: durationFor(plan.kind, layout === 'spread', chained),
        grabY: motion.kind === 'drag' ? motion.grab.y : undefined
      },
      els,
      {
        onDone: (outcome) => {
          if (sound && !reduced) playPageTurn(outcome === 'cancel' ? 'soft' : plan.kind === 'board' ? 'heavy' : 'turn');
          dispatch({ type: 'TURN_DONE' });
        },
        onFrames: (deltas, kind) => {
          recordTurnPerf(kind, deltas);
          props.onFrames(deltas, kind);
        }
      }
    );
    engine.current = eng;
    engineMotion.current = motion;
    if (motion.kind === 'turn') eng.startAuto();
    else if (motion.kind === 'drag') {
      const d = drag.current;
      const frame = leafFrame(spineX, 0, W, H, plan.mirrored);
      const toLeaf = (c: Vec) => bookToLeaf(frame, clientToBook(c));
      if (d?.peek) eng.peekAt(peekPoint(W, H, d.grabY));
      else if (d) {
        eng.startDrag(toLeaf(d.startClient), d.grabY);
        eng.dragTo(toLeaf(d.latestClient));
      } else eng.startDrag({ x: W, y: motion.grab.y }, motion.grab.y);
    } else if (motion.kind === 'settle') {
      // Settle without a running engine (e.g. a remount): finish immediately.
      dispatch({ type: 'TURN_DONE' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, motion, ready]);

  useEffect(
    () => () => {
      engine.current?.destroy();
      if (tapTimer.current) clearTimeout(tapTimer.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    []
  );

  // ── Bump and reduced-motion crossfade ─────────────────────────────────────
  useEffect(() => {
    const el = bookRef.current;
    if (!state.bump || !el || reduced || typeof el.animate !== 'function') return;
    const forwardSign = rtl ? 1 : -1;
    const dx = 6 * forwardSign * state.bump.dir;
    el.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 280, easing: 'cubic-bezier(0.2,0.7,0.2,1)' });
  }, [state.bump, reduced, rtl]);

  useEffect(() => {
    const el = bookRef.current;
    if (!state.fade || !el || typeof el.animate !== 'function') return;
    el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  }, [state.fade]);

  // ── Pointer pipeline ──────────────────────────────────────────────────────
  const clientToBook = (c: Vec): Vec => {
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    const cam = camera.current.current;
    // fit: 'width' (phone landscape) scrolls the stage vertically.
    const sx = (c.x - (rect?.left ?? 0) + (stage?.scrollLeft ?? 0) - cam.tx) / cam.s;
    const sy = (c.y - (rect?.top ?? 0) + (stage?.scrollTop ?? 0) - cam.ty) / cam.s;
    return { x: sx - geom1.book.x, y: sy - geom1.book.y };
  };

  const peekPoint = (W: number, H: number, grabY: number): Vec => ({ x: W - 40, y: grabY + (grabY > H / 2 ? -30 : 30) });

  const grabYFor = (bookPt: Vec): number => {
    const H = geom1.page.h;
    const y = Math.min(0.96 * H, Math.max(0.04 * H, bookPt.y));
    if (y < 0.18 * H) return 0.04 * H;
    if (y > 0.82 * H) return 0.96 * H;
    return y;
  };

  const canTurn = () => state.phase !== 'intro' && motion.kind === 'idle' && !(state.zoom && state.zoom.s > 1.05) && layout !== 'scroll';

  const startDrag = (pointerId: number, dir: 1 | -1, start: Vec, latest: Vec, peek = false) => {
    const bookPt = clientToBook(start);
    const grabY = peek ? (bookPt.y > geom1.page.h / 2 ? 0.96 * geom1.page.h : 0.04 * geom1.page.h) : grabYFor(bookPt);
    drag.current = { pointerId, dir, startClient: start, latestClient: latest, grabY, frameMirrored: false, peek };
    dispatch({ type: 'DRAG_START', dir, grab: { x: geom1.page.w, y: grabY } });
  };

  const endDrag = (cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const eng = engine.current;
    if (!eng || motion.kind !== 'drag') {
      dispatch({ type: 'DRAG_END', outcome: 'cancel' });
      return;
    }
    const outcome = cancelled ? 'cancel' : decideRelease(eng.turnProgress(), eng.releaseVelocity());
    dispatch({ type: 'DRAG_END', outcome });
    eng.release(outcome);
  };

  const stageFraction = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect && rect.width ? (clientX - rect.left) / rect.width : 0.5;
  };

  /** Which corner zone (if any) the mouse is over: the forward page's outer corners (and the backward page's in spreads). */
  const peelZone = (c: Vec): 1 | -1 | 0 => {
    const p = clientToBook(c);
    const W = geom1.page.w;
    const H = geom1.page.h;
    const nearY = p.y < 56 || p.y > H - 56;
    if (!nearY || p.y < 0 || p.y > H) return 0;
    const bookW = geom1.book.w;
    const forwardEdgeRight = !rtl;
    const nearRight = p.x > bookW - 56 && p.x <= bookW;
    const nearLeft = p.x < 56 && p.x >= 0;
    if (forwardEdgeRight ? nearRight : nearLeft) return 1;
    if (layout === 'spread' && (forwardEdgeRight ? nearLeft : nearRight)) return -1;
    void W;
    return 0;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest?.(INTERACTIVE)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && !guidedOn && layout !== 'scroll') {
      // Two fingers: any leaf springs back, pinch zoom takes over.
      if (drag.current) endDrag(true);
      const [a, b] = [...pointers.current.values()];
      const rect = stageRef.current?.getBoundingClientRect();
      pinch.current = {
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        s0: camera.current.current.s,
        mid: { x: (a.x + b.x) / 2 - (rect?.left ?? 0), y: (a.y + b.y) / 2 - (rect?.top ?? 0) },
        cam0: camera.current.current
      };
      down.current = null;
      return;
    }
    if (drag.current?.peek) {
      // The peeled corner becomes a real drag.
      drag.current = { ...drag.current, peek: false, pointerId: e.pointerId, startClient: { x: e.clientX, y: e.clientY }, latestClient: { x: e.clientX, y: e.clientY } };
      engine.current?.continueDrag(bookToLeafFor(drag.current.dir, { x: e.clientX, y: e.clientY }));
      try {
        stageRef.current?.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture unsupported */
      }
      down.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType, lx: e.clientX, ly: e.clientY };
      return;
    }
    down.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType, lx: e.clientX, ly: e.clientY };
  };

  const bookToLeafFor = (dir: 1 | -1, c: Vec): Vec => {
    const p = plan ?? null;
    const W = geom1.page.w;
    const H = geom1.page.h;
    const mirrored = p ? p.mirrored : layout === 'spread' ? (dir > 0 ? rtl : !rtl) : rtl;
    const slot = layout === 'spread' ? geom1.slots.find((s) => s.side === (mirrored ? 'left' : 'right')) : geom1.slots[0];
    const spineX = layout === 'spread' ? geom1.spineX : rtl ? (slot?.x ?? 0) + W : slot?.x ?? 0;
    return bookToLeaf(leafFrame(spineX, 0, W, H, mirrored), clientToBook(c));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Pinch zoom (free zoom, not in Guided View).
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const s = Math.min(4, Math.max(1, (pinch.current.s0 * d) / pinch.current.d0));
      const { mid, cam0 } = pinch.current;
      // Keep the pinch midpoint under the fingers.
      const wx = (mid.x - cam0.tx) / cam0.s;
      const wy = (mid.y - cam0.ty) / cam0.s;
      const cam = { s, tx: mid.x - wx * s, ty: mid.y - wy * s, rect: { x: 0, y: 0, w: size.w / s, h: size.h / s } };
      camera.set(clampCamera(cam));
      return;
    }
    const d = drag.current;
    if (d && !d.peek && e.pointerId === d.pointerId) {
      d.latestClient = { x: e.clientX, y: e.clientY };
      if (engine.current && motion.kind === 'drag') engine.current.dragTo(bookToLeafFor(d.dir, d.latestClient));
      return;
    }
    // Mouse hover: peel teaser on the outer corners.
    if (e.pointerType === 'mouse' && !e.buttons && props.peel && !reduced) {
      const zone = canTurn() || drag.current?.peek ? peelZone({ x: e.clientX, y: e.clientY }) : 0;
      if (zone && !drag.current && canTurn()) {
        const to = state.view + zone;
        if (to >= 0 && to < views.length) startDrag(e.pointerId, zone as 1 | -1, { x: e.clientX, y: e.clientY }, { x: e.clientX, y: e.clientY }, true);
      } else if (!zone && drag.current?.peek) {
        drag.current = null;
        dispatch({ type: 'DRAG_END', outcome: 'cancel' });
        engine.current?.release('cancel');
      }
      return;
    }
    const dn = down.current;
    if (!dn || dn.id !== e.pointerId) return;
    const dx = e.clientX - dn.x;
    const dy = e.clientY - dn.y;
    // Zoomed: one finger pans.
    if (state.zoom && state.zoom.s > 1.05 && !guidedOn) {
      const cam = camera.current.current;
      const next = clampCamera({ ...cam, tx: cam.tx + (e.clientX - dn.lx), ty: cam.ty + (e.clientY - dn.ly) });
      dn.lx = e.clientX;
      dn.ly = e.clientY;
      camera.set(next);
      return;
    }
    if (Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (Math.abs(dy) > 1.4 * Math.abs(dx) || !canTurn() || guidedOn) {
      // Vertical intent (or not turnable): not a tap any more, not a turn.
      if (guidedOn && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        down.current = null;
        props.onCommand({ type: 'step', delta: (rtl ? dx > 0 : dx < 0) ? 1 : -1 });
        return;
      }
      if (Math.abs(dy) > 1.4 * Math.abs(dx)) down.current = null;
      return;
    }
    // Horizontal: lift the leaf. Moving toward the backward edge turns forward.
    const dir: 1 | -1 = (rtl ? dx > 0 : dx < 0) ? 1 : -1;
    const to = state.view + dir;
    down.current = null;
    if (to < 0 || to >= views.length) {
      dispatch({ type: 'DRAG_START', dir, grab: { x: 0, y: 0 } }); // bumps
      return;
    }
    try {
      stageRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture unsupported */
    }
    startDrag(e.pointerId, dir, { x: dn.x, y: dn.y }, { x: e.clientX, y: e.clientY });
  };

  const clampCamera = (cam: Camera): Camera => {
    const s = cam.s;
    // Keep some of the book on screen.
    const minTx = size.w - (geom1.book.x + geom1.book.w) * s - size.w * 0.25;
    const maxTx = -geom1.book.x * s + size.w * 0.25;
    const minTy = size.h - (geom1.book.y + geom1.book.h) * s - size.h * 0.25;
    const maxTy = -geom1.book.y * s + size.h * 0.25;
    return { ...cam, tx: Math.min(maxTx, Math.max(minTx, cam.tx)), ty: Math.min(maxTy, Math.max(minTy, cam.ty)) };
  };

  const finishPinch = () => {
    const cam = camera.current.current;
    pinch.current = null;
    if (cam.s <= 1.05) {
      dispatch({ type: 'ZOOM', zoom: null });
      camera.move({ to: IDENTITY_CAMERA(size.w, size.h), durationMs: reduced ? 0 : 220, onDone: () => settleCrisp(IDENTITY_CAMERA(size.w, size.h)) });
    } else {
      dispatch({ type: 'ZOOM', zoom: { s: cam.s, x: cam.tx, y: cam.ty } });
      settleCrisp(cam);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) finishPinch();
      return;
    }
    const d = drag.current;
    if (d && !d.peek && e.pointerId === d.pointerId) {
      // A drag that barely moved from a peel is a click on the corner: complete the turn.
      const moved = Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y);
      if (moved < DRAG_SLOP && engine.current && motion.kind === 'drag') {
        drag.current = null;
        dispatch({ type: 'DRAG_END', outcome: 'commit' });
        engine.current.release('commit');
        down.current = null;
        return;
      }
      endDrag(false);
      down.current = null;
      return;
    }
    const dn = down.current;
    down.current = null;
    if (!dn || dn.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - dn.x, e.clientY - dn.y) >= DRAG_SLOP || performance.now() - dn.t > 600) return;
    // A tap: double-tap first, then outer zones turn, the middle toggles the HUD (after a beat).
    const tap = { t: performance.now(), x: e.clientX, y: e.clientY };
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = null;
      if (state.zoom && !guidedOn) {
        dispatch({ type: 'ZOOM', zoom: null });
        return;
      }
      const p = clientToBook({ x: e.clientX, y: e.clientY });
      const slot = geom1.slots.find((s) => p.x >= s.x && p.x <= s.x + s.w) ?? geom1.slots[0];
      const box = letterbox(slot.w, slot.h, slot.contentAspect);
      const point = { x: (p.x - slot.x - box.x) / Math.max(1, box.w), y: (p.y - slot.y - box.y) / Math.max(1, box.h) };
      const viewForTap = slot.content.kind === 'item' ? views.findIndex((v) => v.items.includes((slot.content as { index: number }).index)) : state.view;
      props.onDoubleTap(viewForTap >= 0 ? viewForTap : state.view, point);
      return;
    }
    lastTap.current = tap;
    const cmd = tapCommand(stageFraction(e.clientX), rtl);
    if (cmd.type === 'hud') {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = setTimeout(() => {
        tapTimer.current = null;
        props.onCommand(cmd);
      }, 250);
      return;
    }
    if (state.zoom && state.zoom.s > 1.05 && !guidedOn) return;
    props.onCommand(cmd);
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current && pointers.current.size < 2) finishPinch();
    if (drag.current && drag.current.pointerId === e.pointerId) endDrag(true);
    down.current = null;
  };

  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && drag.current?.peek) {
      drag.current = null;
      dispatch({ type: 'DRAG_END', outcome: 'cancel' });
      engine.current?.release('cancel');
    }
  };

  // Wheel: steps; Ctrl/⌘ + wheel zooms at the cursor (not in Guided View).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (guidedOn || layout === 'scroll') return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const cam = camera.current.current;
        const s = Math.min(4, Math.max(1, cam.s * Math.exp(-e.deltaY * 0.01)));
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const wx = (mx - cam.tx) / cam.s;
        const wy = (my - cam.ty) / cam.s;
        const next = clampCamera({ s, tx: mx - wx * s, ty: my - wy * s, rect: { x: 0, y: 0, w: size.w / s, h: size.h / s } });
        camera.set(next);
        if (s <= 1.02) {
          dispatch({ type: 'ZOOM', zoom: null });
          settleCrisp(IDENTITY_CAMERA(size.w, size.h));
        } else {
          dispatch({ type: 'ZOOM', zoom: { s, x: next.tx, y: next.ty } });
          settleCrisp(next);
        }
        return;
      }
      if (layout === 'scroll') return;
      // Page wider than tall on screen (fit: width): vertical wheel scrolls the page natively.
      if (fit === 'width' && Math.abs(e.deltaY) > Math.abs(e.deltaX)) return;
      e.preventDefault();
      if (state.zoom && state.zoom.s > 1.05) return;
      const cmd = wheel.current.push(e.deltaX, e.deltaY, performance.now(), rtl);
      if (cmd) props.onCommand(cmd);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedOn, layout, rtl, state.zoom, size.w, size.h, geom1, fit]);

  // fit: 'width' — a new page starts at its top.
  useEffect(() => {
    if (fit === 'width' && stageRef.current) stageRef.current.scrollTop = 0;
  }, [state.view, fit]);

  // ── Render ────────────────────────────────────────────────────────────────
  const imgFull: SlotImage = useMemo(() => ({ ...img, original: layoutScale > 1.6 }), [img, layoutScale]);
  const visibleLines = useMemo(() => {
    if (!guidedOn || !balloonPop || !stop || stop.panelIndex < 0) return undefined;
    const item = items[stop.itemIndex];
    const page = item?.page;
    if (!page) return undefined;
    // Balloons of this panel and every earlier stop stay visible.
    const shown = new Set<string>();
    for (const st of stops.slice(0, state.guided.stop + 1)) for (const id of st.lineIds) shown.add(id);
    return { itemIndex: stop.itemIndex, ids: shown as ReadonlySet<string> };
  }, [guidedOn, balloonPop, stop, stops, state.guided.stop, items]);

  const W = geomL.page.w;
  const H = geomL.page.h;
  const L = layoutScale;
  const bookX = geom1.book.x * L;
  const bookY = geom1.book.y * L;
  const viewsBefore = state.view;
  const viewsAfter = Math.max(0, views.length - 1 - state.view);
  const leftCount = rtl ? viewsAfter : viewsBefore;
  const rightCount = rtl ? viewsBefore : viewsAfter;
  const edge = (n: number) => Math.min(6, 0.6 * n);
  const front = plan?.frontKey ? mounted.get(plan.frontKey) : undefined;
  const frontSlot = front ? geomAt(front.view, L).slots[front.slotIdx] : undefined;
  const backSlotX = (() => {
    if (!plan) return 0;
    if (plan.backKey) {
      const m = mounted.get(plan.backKey);
      return m ? geomAt(m.view, L).slots[m.slotIdx]?.x ?? 0 : 0;
    }
    // Single page: the back lands beside the page, across its spine.
    const fx = frontSlot?.x ?? geomL.slots[0]?.x ?? 0;
    return plan.mirrored ? fx + W : fx - W;
  })();
  const frontX = frontSlot?.x ?? (plan?.leafSide === 'left' ? 0 : W + geomL.gap);
  const showThrough = useSlotShowThrough(plan, items, img, W);

  return (
    <div
      ref={stageRef}
      data-testid="book-stage"
      className={fit === 'width' ? 'absolute inset-0 select-none overflow-y-auto overflow-x-hidden' : 'absolute inset-0 select-none overflow-hidden'}
      style={{ touchAction: fit === 'width' ? 'pan-y' : 'none', overscrollBehavior: 'contain', cursor: drag.current && !drag.current.peek ? 'grabbing' : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      <div ref={wrapperRef} className="absolute left-0 top-0" style={{ transformOrigin: '0 0', width: size.w, height: size.h }}>
        {/* Page-block edges: the stack thickness follows reading progress. */}
        {layout !== 'strip' && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                left: bookX - edge(leftCount) * L,
                top: bookY + 2 * L,
                width: edge(leftCount) * L,
                height: H - 4 * L,
                background: 'repeating-linear-gradient(to right, var(--ds-reader-edge) 0, var(--ds-reader-edge) 1px, var(--ds-reader-edge-line) 1px, var(--ds-reader-edge-line) 2px)',
                transition: reduced ? undefined : 'width 300ms ease, left 300ms ease',
                borderRadius: '2px 0 0 2px',
                opacity: layout === 'spread' && geom1.slots[0]?.content.kind === 'blank' ? 0 : 1
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                left: bookX + geomL.book.w,
                top: bookY + 2 * L,
                width: edge(rightCount) * L,
                height: H - 4 * L,
                background: 'repeating-linear-gradient(to right, var(--ds-reader-edge-line) 0, var(--ds-reader-edge-line) 1px, var(--ds-reader-edge) 1px, var(--ds-reader-edge) 2px)',
                transition: reduced ? undefined : 'width 300ms ease',
                borderRadius: '0 2px 2px 0',
                opacity: layout === 'spread' && geom1.slots[1]?.content.kind === 'blank' ? 0 : 1
              }}
            />
          </>
        )}
        {/* Soft bed shadows under each side that has a page. */}
        {geomL.slots.map((s) =>
          s.content.kind === 'blank' ? null : (
            <div
              key={`bed-${s.side}`}
              aria-hidden
              className="pointer-events-none absolute"
              style={{ left: bookX + s.x, top: bookY + s.y, width: s.w, height: s.h, boxShadow: '0 28px 60px -18px rgba(0,0,0,0.65), 0 10px 24px -10px rgba(0,0,0,0.5)', transition: reduced ? undefined : 'opacity 300ms ease' }}
            />
          )
        )}
        <div
          ref={bookRef}
          role="region"
          aria-roledescription="book"
          aria-label={doc.brief.title || 'Comic'}
          data-testid="reader-book"
          data-layout={layout}
          className="absolute"
          style={{ left: bookX, top: bookY, width: geomL.book.w, height: H }}
        >
          {[...mounted.entries()].map(([key, m]) => {
            const g = geomAt(m.view, L);
            const s = g.slots[m.slotIdx];
            if (!s) return null;
            const role = roleOf(key, currentKeys, plan);
            const visible = role !== 'hidden';
            const isCurrent = currentKeys.includes(key);
            const itemIndex = s.content.kind === 'item' ? s.content.index : -1;
            const label = itemIndex >= 0 ? items[itemIndex]?.label ?? 'Page' : s.content.kind === 'end' ? 'The End' : 'Inside cover';
            const pageCount = items.filter((i) => i.kind === 'page').length;
            return (
              <ReaderSlot
                key={key}
                ref={(r) => {
                  if (r) slotRefs.current.set(key, r);
                  else slotRefs.current.delete(key);
                }}
                slotKey={key}
                doc={doc}
                content={s.content}
                items={items}
                x={s.x}
                y={s.y}
                width={s.w}
                height={s.h}
                side={s.side}
                contentAspect={s.contentAspect}
                z={LAYER_Z[role]}
                visible={visible}
                gutter={layout === 'strip' ? undefined : gutterFor(s.side, layout === 'spread', rtl)}
                interactive={s.content.kind === 'end' && role === 'static' && !plan}
                ariaLabel={itemIndex >= 0 && items[itemIndex]?.kind === 'page' && pageCount ? `${label} of ${pageCount}` : label}
                img={imgFull}
                prio={isCurrent ? 'now' : 'next'}
                paper={paper}
                letteringAriaHidden
                visibleLineIds={visibleLines && visibleLines.itemIndex === itemIndex ? visibleLines.ids : undefined}
                onImageError={props.onImageError}
                onExpired={props.onExpired}
                dedication={dedication}
                endCard={s.content.kind === 'end' ? endCard : undefined}
              />
            );
          })}
          {plan && plan.kind !== 'slide' && plan.kind !== 'fade' && (
            <PageLeaf
              key={`${plan.from}-${plan.to}-${plan.kind}`}
              refs={leafRefs}
              W={W}
              H={H}
              frontX={frontX}
              backX={backSlotX}
              backExtra={plan.backKey ? undefined : plan.backExtra}
              showThroughSrc={showThrough.src}
              showThroughBox={showThrough.box}
              paperTexture={paper}
              dedication={dedication}
              riffle={plan.kind === 'riffle' ? plan.riffle : undefined}
              mode={plan.mode}
              board={plan.kind === 'board'}
            />
          )}
        </div>
      </div>
      <Spotlight ref={spotRef} reduced={reduced} />
    </div>
  );
};

/** The front page's decoded image for the paper back's show-through (single-page turns). */
function useSlotShowThrough(plan: TurnPlan | null, items: ReaderItem[], img: Omit<SlotImage, 'original'>, W: number) {
  const c = plan?.backExtra === 'paper' ? plan.frontContent : undefined;
  const item = c && c.kind === 'item' ? items[c.index] : undefined;
  const pick = item ? pickVariant(item.asset, W, { dpr: img.dpr, saveData: img.saveData }) : undefined;
  const cached = useCachedImage(pick?.path, undefined, 'next');
  const orig = useCachedImage(item?.asset.path, undefined, 'next');
  const src = cached.src || orig.src;
  return { src, box: undefined as { x: number; y: number; w: number; h: number } | undefined };
}

export default BookStage;
