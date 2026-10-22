// Overlay lettering: every line of a page drawn as a vector balloon over the clean art.
//
// Drawing: the shared engine plans every line (planLettering → LetterPlan: wrapped lines, glyph
// positions, outline and tail paths in page units) and LetteringSvg draws the plans as ONE SVG over
// the art — the same plans the print view and the exporter draw, so the board, print and PNG agree by
// construction. Heights are computed, not measured; a thumbnail is the same drawing as a full page.
// The drawn position already keeps every outline ≥ 0.8 % inside the page (render-time fit), so stored
// balloons that hug or cross the edge are never clipped; stored values stay untouched until edited.
//
// Editing (page editor) happens in an HTML hit layer above the SVG: one focusable button per balloon at
// its OUTLINE bounds, in reading order (Tab cycles), with the existing aria text.
//   - Drag to move (outline clamped to the safe area, snap guides; Alt/Option = no snap, bleed allowed
//     to the page margin), drag the round handle to aim the tail, drag the side grip to resize.
//   - Shift-click adds to the selection; dragging a selected balloon moves the whole selection.
//   - Arrows nudge (Shift = bigger steps, Alt = move the tail), Delete removes the line, ⌘/Ctrl+D
//     duplicates, [ ] change stacking (Shift = to back/front), L locks, Enter/double-click edits text.
//   - Touch: a tap selects without moving; a selected balloon drags past a 10 px slop; an unselected one
//     drags only after a 220 ms hold ("lift"); travel is measured against the layer's on-screen rect, so
//     it is right under any zoom. pointercancel reverts (never commits).
// Every finished change sends the FULL balloon when the line had none stored yet (a software-placed
// balloon), so a first drag never jumps to a default width or loses its tail; changes are pinned so an
// automatic re-layout never moves them again.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Balloon, Box, ComicDoc, LineKind, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import type { PatchOptions } from '../types';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { resolveTailStyle } from '../../../shared/comic/lettering/shapes';
import { safeAreaBox } from '../../../shared/comic/lettering/place';
import { LETTERING_PRESETS, DEFAULT_LETTERING, DEFAULT_SAFE_MARGIN } from '../../../shared/comic/lettering/style';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { planLettering, type LetterPlan } from '../../../shared/comic/lettering/layout';
import { LetteringSvg } from '../lettering/LetteringSvg';
import { BalloonTextEditor } from '../lettering/BalloonTextEditor';
import { SnapGuides, computeSnap, snapTargets, type SnapGuide } from '../lettering/SnapGuides';
import { useLetterPlans } from '../lettering/useLetterPlans';
import { nextSelection } from '../lettering/useLetteringSelection';
import { planText } from '../lettering/svgMarkup';
import { deleteLinesOps, duplicateLineOps, findLineRef, lockOps, outlineFractions, textEditOps, zOrderOps } from '../lettering/styleOps';
import { useZoom } from '../mobile/touch/TouchCanvas';
import { LETTERING, pageAspectOf } from './balloonGeometry';
import { LINE_KIND_LABEL, castName } from './boardModel';
import { cx } from './ui';

export interface BalloonLayerProps {
  doc: ComicDoc;
  page: Page;
  /** Rendered page box size in CSS px. */
  pageWidth: number;
  pageHeight: number;
  /** Page aspect (w/h) the plans use; default pageWidth/pageHeight, else the doc's. */
  aspect?: number;
  editable?: boolean;
  /** A finished move/resize/tail change. `lang` is set when editing a translated edition's geometry. */
  onBalloonChange?: (lineId: string, patch: Partial<Balloon>, opts?: { lang?: string }) => void;
  /** Batched edits (multi-move, delete, duplicate, z-order, lock, inline text) — one undo entry each. */
  onOps?: (ops: DocOp[], opts?: PatchOptions) => void;
  /** Controlled single selection (legacy). */
  selectedLineId?: string | null;
  onSelectLine?: (lineId: string | null) => void;
  /** Controlled multi-selection (primary first). */
  selectedLineIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;
  /** aria-hidden on the lettering (the reader supplies its own ordered transcript). */
  ariaHidden?: boolean;
  /** Balloons not in the set render at opacity 0 (guided reading). Undefined = all visible. */
  visibleLineIds?: ReadonlySet<string>;
  /** Editing a translated edition: geometry changes are reported with `{ lang }`. */
  editionLang?: string;
  /** Show the subtle "not translated yet" marker on fallback-language lines. */
  markUntranslated?: boolean;
  /** Inline text editor (controlled). */
  editingLineId?: string | null;
  onEditingChange?: (lineId: string | null) => void;
  /** Add mode: the next click on the page adds a line of this kind there. */
  addKind?: LineKind | null;
  onAddAt?: (kind: LineKind, point: { x: number; y: number }) => void;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const clamp01 = (n: number) => clamp(n, 0, 1);
/** @deprecated The SVG renderer scales with the page; kept for importers of the old constant. */
export const LETTERING_MAX_BOOST = 1.15;
/** @deprecated The SVG renderer scales with the page; kept for importers of the old constant. */
export const LETTERING_LAYOUT_MIN_W = LETTERING.minFontPx / (LETTERING.fontScale * LETTERING_MAX_BOOST);
const NUDGE = 0.005;
const NUDGE_BIG = 0.02;
/** Manual placement never puts an outline closer than this to the page edge (contract §10.1). */
const PAGE_MARGIN = 0.008;
/** Pointer travel (px) before a press becomes a drag, by pointer type (mobile.md §5.3). */
export const dragSlopPx = (t: string) => (t === 'touch' ? 10 : t === 'pen' ? 2 : 3);
const LIFT_MS = 220;
const SNAP_PX = 6;
const NEAREST_TAP_PX = 22;
const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);

type DragMode = 'move' | 'tail' | 'width';

/** Clamp an outline-relative box move so the outline stays inside [m, 1-m] (centred if too big). */
const clampAxis = (start: number, size: number, lo: number, hi: number): number =>
  size > hi - lo ? lo + (hi - lo - size) / 2 : clamp(start, lo, hi - size);

/** The tail tip a plan draws (absolute page fractions), or null when it has none. */
export const planTip = (plan: LetterPlan, H: number, balloon?: Balloon): { x: number; y: number } | null => {
  const tail = resolveTailStyle(plan.style.tail, plan.kind, plan.style.shape);
  if (tail === 'none' || plan.style.shape === 'none') return null;
  if (balloon && typeof balloon.tailX === 'number' && typeof balloon.tailY === 'number') return { x: clamp01(balloon.tailX), y: clamp01(balloon.tailY) };
  if (!SPOKEN.has(plan.kind)) return null;
  return { x: clamp01((plan.x + plan.w * 0.42) / 1000), y: clamp01((plan.y + plan.h + 0.04 * H) / H) };
};

/** Pointer travel → page fractions against the layer's on-screen rect (zoom-proof). */
const travel = (rect: { width: number; height: number }, fallbackW: number, fallbackH: number) => ({
  w: rect.width > 0 ? rect.width : fallbackW || 1,
  h: rect.height > 0 ? rect.height : fallbackH || 1
});

interface DragState {
  mode: DragMode;
  ids: string[];
  origin: { x: number; y: number };
  /** On-screen layer size (px) at drag start. */
  rect: { w: number; h: number };
  moved: boolean;
  alt: boolean;
}

/** All balloons of a page over its art (overlay lettering). */
export const BalloonLayer: React.FC<BalloonLayerProps> = ({
  doc,
  page,
  pageWidth,
  pageHeight,
  aspect: aspectProp,
  editable = false,
  onBalloonChange,
  onOps,
  selectedLineId,
  onSelectLine,
  selectedLineIds,
  onSelectionChange,
  ariaHidden,
  visibleLineIds,
  editionLang,
  markUntranslated,
  editingLineId,
  onEditingChange,
  addKind,
  onAddAt
}) => {
  const aspect = aspectProp && aspectProp > 0 ? aspectProp : pageWidth > 0 && pageHeight > 0 ? pageWidth / pageHeight : pageAspectOf(doc, page);
  // Live drafts while dragging (full balloons), drawn by re-planning the page with them applied.
  const [drafts, setDrafts] = useState<Map<string, Balloon> | null>(null);
  const draftPage = useMemo(() => {
    if (!drafts || !drafts.size) return page;
    const balloons = page.balloons.filter((b) => !drafts.has(b.lineId)).concat([...drafts.values()]);
    return { ...page, balloons };
  }, [page, drafts]);
  const base = useLetterPlans(doc, page, aspect);
  const { H } = base;
  // Drafts re-plan only the page being dragged (fits of the other lines hit the engine's memo).
  const plans = useMemo(
    () => (draftPage === page ? base.plans : planLettering(doc, draftPage, aspect, base.measure)),
    [draftPage, page, base.plans, base.measure, doc, aspect]
  );
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [lifted, setLifted] = useState<string | null>(null);
  const zoom = useZoom();
  const layerRef = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  // ── Selection (controlled multi, controlled single, or local) ─────────────
  const [localSel, setLocalSel] = useState<string[]>([]);
  const selection: string[] = selectedLineIds
    ? [...selectedLineIds]
    : selectedLineId !== undefined
      ? selectedLineId
        ? [selectedLineId]
        : []
      : localSel;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const select = (id: string | null, additive = false) => {
    const next = nextSelection(selectionRef.current, id, additive);
    setLocalSel(next);
    onSelectionChange?.(next);
    onSelectLine?.(next[0] ?? null);
  };
  const selectedSet = useMemo(() => new Set(selection), [selection.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const lang = editionLang ? { lang: editionLang } : undefined;
  const planById = useMemo(() => new Map(plans.map((p) => [p.lineId, p])), [plans]);
  const basePlanById = useMemo(() => new Map(base.plans.map((p) => [p.lineId, p])), [base.plans]);
  // Hit layer order = reading order (Tab cycles like a reader reads), not z order.
  const readingOrder = useMemo(() => page.panels.flatMap((p) => p.lines.map((l) => l.id)).filter((id) => planById.has(id)), [page.panels, planById]);

  const labels = useMemo(() => {
    const m = new Map<string, string>();
    for (const panel of page.panels)
      for (const line of panel.lines) {
        const speaker = line.speakerId ? castName(doc, line.speakerId) : '';
        m.set(line.id, `${LINE_KIND_LABEL[line.kind]}${speaker ? ` — ${speaker}` : ''}: ${line.text}`);
      }
    return m;
  }, [doc, page.panels]);
  const labelFor = useMemo(() => (p: LetterPlan) => labels.get(p.lineId) ?? `${LINE_KIND_LABEL[p.kind]}: ${planText(p)}`, [labels]);

  if (!plans.length || pageWidth <= 0) return null;

  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const safe = safeAreaBox(typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN, aspect);
  const boxes = panelBoxesFor(doc, page);

  /** Full balloon (stored or software-placed) behind a line. */
  const resolvedOf = (id: string): Balloon | undefined => base.placements.balloons.get(id);
  const isStored = (id: string) => page.balloons.some((b) => b.lineId === id && Number.isFinite(b.x) && Number.isFinite(b.y) && b.w > 0);

  /** The patch to send for a balloon change: full balloon for software-placed lines. */
  const fullPatch = (id: string, patch: Partial<Balloon>): Partial<Balloon> => {
    const plan = basePlanById.get(id);
    const out: Partial<Balloon> = { ...patch };
    if (!isStored(id)) {
      const r = resolvedOf(id);
      const merged: Partial<Balloon> = { ...(r || {}), ...(plan ? { w: r4(plan.w / 1000) } : {}), ...patch };
      delete (merged as { lineId?: string }).lineId;
      return merged;
    }
    // The drawn width can differ from the stored one (an unpinned balloon grows to fit its text):
    // pinning it must keep the size the user sees.
    const stored = page.balloons.find((b) => b.lineId === id);
    if (plan && stored && out.w === undefined && Math.abs(plan.w / 1000 - stored.w) > 1e-4) out.w = r4(plan.w / 1000);
    return out;
  };

  const commitMany = (changes: { id: string; patch: Partial<Balloon> }[], label: string) => {
    if (!changes.length) return;
    if (changes.length > 1 && onOps && !editionLang) {
      onOps(
        changes.map((c) => ({ op: 'balloon', pageId: page.id, lineId: c.id, patch: fullPatch(c.id, c.patch) }) as DocOp),
        { label, coalesce: `move:${page.id}` }
      );
      return;
    }
    for (const c of changes) {
      if (!onBalloonChange) continue;
      if (lang) onBalloonChange(c.id, fullPatch(c.id, c.patch), lang);
      else onBalloonChange(c.id, fullPatch(c.id, c.patch));
    }
  };

  /** Allowed move of a plan's outline: [lo, hi] for dx and dy (page fractions). */
  const moveRange = (plan: LetterPlan, alt: boolean) => {
    const o = outlineFractions(plan, H);
    const area = alt ? { x: PAGE_MARGIN, y: PAGE_MARGIN * aspect, w: 1 - 2 * PAGE_MARGIN, h: 1 - 2 * PAGE_MARGIN * aspect } : safe;
    const fx = clampAxis(o.x, o.w, area.x, area.x + area.w);
    const fy = clampAxis(o.y, o.h, area.y, area.y + area.h);
    const lox = o.w > area.w ? fx - o.x : area.x - o.x;
    const hix = o.w > area.w ? fx - o.x : area.x + area.w - o.w - o.x;
    const loy = o.h > area.h ? fy - o.y : area.y - o.y;
    const hiy = o.h > area.h ? fy - o.y : area.y + area.h - o.h - o.y;
    return { lox: Math.min(lox, 0, hix), hix: Math.max(hix, 0, lox), loy: Math.min(loy, 0, hiy), hiy: Math.max(hiy, 0, loy) };
  };

  // ── Drag ──────────────────────────────────────────────────────────────────
  const beginDrag = (e: React.PointerEvent, plan: LetterPlan, mode: DragMode) => {
    if (!editable || (!onBalloonChange && !onOps)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    const id = plan.lineId;
    const additive = e.shiftKey && mode === 'move';
    const wasSelected = selectionRef.current.includes(id);
    const touch = e.pointerType === 'touch';
    if (mode === 'move' && additive) {
      e.preventDefault();
      select(id, true);
      return;
    }
    if (!touch) e.preventDefault();
    if (!wasSelected && !touch) select(id);
    cleanup.current?.();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events / unsupported */
    }
    const rect = layerRef.current?.getBoundingClientRect() ?? { width: 0, height: 0 };
    const t = travel(rect, pageWidth, pageHeight);
    const group = mode === 'move' && wasSelected && selectionRef.current.length > 1 ? selectionRef.current.filter((x) => planById.has(x)) : [id];
    const ids = group.filter((x) => !basePlanById.get(x)?.locked);
    const st: DragState = { mode, ids, origin: { x: e.clientX, y: e.clientY }, rect: t, moved: false, alt: false };
    const slop = dragSlopPx(e.pointerType || 'mouse');
    // Touch on an unselected balloon: a hold lifts it; a quick move pans/scrolls instead.
    let armed = !touch || wasSelected || mode !== 'move';
    let liftTimer: ReturnType<typeof setTimeout> | null = null;
    if (!armed) {
      liftTimer = setTimeout(() => {
        armed = true;
        setLifted(id);
        select(id);
        try {
          navigator.vibrate?.(10);
        } catch {
          /* no haptics */
        }
      }, LIFT_MS);
    }
    const startPlans = ids.map((x) => basePlanById.get(x)!).filter(Boolean);
    const others: Box[] = base.plans.filter((p) => !ids.includes(p.lineId)).map((p) => outlineFractions(p, H));
    const targets = snapTargets({ panels: boxes, others, safe });
    let latest: Map<string, Balloon> | null = null;

    const move = (ev: PointerEvent) => {
      const dxPx = ev.clientX - st.origin.x;
      const dyPx = ev.clientY - st.origin.y;
      if (!st.moved && Math.hypot(dxPx, dyPx) < slop) return;
      if (!armed) {
        // Moved before the lift: this was a pan/scroll, not a drag.
        stop();
        return;
      }
      if (!ids.length) return;
      st.moved = true;
      st.alt = ev.altKey;
      let dx = dxPx / st.rect.w;
      let dy = dyPx / st.rect.h;
      const next = new Map<string, Balloon>();
      if (mode === 'move') {
        // Snap the primary outline (no snapping with Alt), then clamp the whole group.
        const primary = basePlanById.get(id) ?? startPlans[0];
        if (!st.alt && primary) {
          const o = outlineFractions(primary, H);
          const s = computeSnap({ ...o, x: o.x + dx, y: o.y + dy }, targets, { x: SNAP_PX / st.rect.w, y: SNAP_PX / st.rect.h });
          dx += s.dx;
          dy += s.dy;
          setGuides(s.guides);
        } else setGuides([]);
        let lox = -Infinity;
        let hix = Infinity;
        let loy = -Infinity;
        let hiy = Infinity;
        for (const p of startPlans) {
          const r = moveRange(p, st.alt);
          lox = Math.max(lox, r.lox);
          hix = Math.min(hix, r.hix);
          loy = Math.max(loy, r.loy);
          hiy = Math.min(hiy, r.hiy);
        }
        dx = clamp(dx, Math.min(lox, hix), Math.max(lox, hix));
        dy = clamp(dy, Math.min(loy, hiy), Math.max(loy, hiy));
        for (const p of startPlans) {
          const r = resolvedOf(p.lineId);
          next.set(p.lineId, { ...(r || { lineId: p.lineId }), lineId: p.lineId, x: r4(p.x / 1000 + dx), y: r4(p.y / H + dy), w: r4(p.w / 1000), pinned: true });
        }
      } else if (mode === 'tail') {
        const p = startPlans[0];
        const tip = p ? planTip(p, H, resolvedOf(p.lineId)) : null;
        if (!p || !tip) return;
        const r = resolvedOf(p.lineId);
        next.set(p.lineId, { ...(r || { lineId: p.lineId }), lineId: p.lineId, x: r4(p.x / 1000), y: r4(p.y / H), w: r4(p.w / 1000), tailX: r4(clamp01(tip.x + dx)), tailY: r4(clamp01(tip.y + dy)), pinned: true });
      } else {
        const p = startPlans[0];
        if (!p) return;
        const r = resolvedOf(p.lineId);
        const x0 = p.x / 1000;
        next.set(p.lineId, { ...(r || { lineId: p.lineId }), lineId: p.lineId, x: r4(x0), y: r4(p.y / H), w: r4(clamp(p.w / 1000 + dx, 0.06, Math.max(0.06, 1 - PAGE_MARGIN - x0))), pinned: true });
      }
      latest = next;
      setDrafts(next);
    };
    const finish = (commit: boolean) => {
      const wasMoved = st.moved;
      const result = latest;
      stop();
      if (!commit) return;
      if (!wasMoved) {
        // A tap/click: select (touch selects on tap without moving); a plain click inside a
        // multi-selection narrows it to that balloon.
        if (mode === 'move' && (touch || selectionRef.current.length > 1)) select(id);
        return;
      }
      if (!result) return;
      const changes: { id: string; patch: Partial<Balloon> }[] = [];
      for (const [lineId, b] of result) {
        const before = basePlanById.get(lineId);
        if (!before) continue;
        if (mode === 'move') changes.push({ id: lineId, patch: { x: b.x, y: b.y, pinned: true } });
        else if (mode === 'tail') changes.push({ id: lineId, patch: { tailX: b.tailX, tailY: b.tailY, pinned: true } });
        else changes.push({ id: lineId, patch: { w: b.w, pinned: true } });
      }
      commitMany(changes, mode === 'move' ? (changes.length > 1 ? 'Move balloons' : 'Move balloon') : mode === 'tail' ? 'Aim tail' : 'Resize balloon');
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const stop = () => {
      if (liftTimer) clearTimeout(liftTimer);
      cleanup.current?.();
      setDrafts(null);
      setGuides([]);
      setLifted(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      cleanup.current = null;
    };
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent, plan: LetterPlan) => {
    if (!editable) return;
    const id = plan.lineId;
    const mod = e.metaKey || e.ctrlKey;
    const ids = selectionRef.current.includes(id) ? selectionRef.current : [id];
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      handled();
      select(null);
      (e.currentTarget as HTMLElement).blur();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'F2') && !mod && onEditingChange) {
      handled();
      onEditingChange(id);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && onOps && !editionLang) {
      handled();
      onOps(deleteLinesOps(page, ids), { label: ids.length > 1 ? 'Delete balloons' : 'Delete balloon' });
      select(null);
      return;
    }
    if (mod && (e.key === 'd' || e.key === 'D') && onOps && !editionLang) {
      handled();
      onOps(duplicateLineOps(page, id, base.placements.balloons), { label: 'Duplicate balloon' });
      return;
    }
    if ((e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') && onOps && !editionLang) {
      handled();
      const front = e.key === ']' || e.key === '}';
      const far = e.shiftKey || e.key === '{' || e.key === '}';
      onOps(zOrderOps(page, ids, front ? (far ? 'front' : 'forward') : far ? 'back' : 'backward', base.plans, base.placements.balloons), { label: front ? 'Bring forward' : 'Send backward' });
      return;
    }
    if ((e.key === 'l' || e.key === 'L') && !mod && onOps && !editionLang) {
      handled();
      const locked = !basePlanById.get(id)?.locked;
      onOps(lockOps(page, ids, locked, base.placements.balloons), { label: locked ? 'Lock balloon' : 'Unlock balloon' });
      return;
    }
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dir[e.key];
    if (!d || mod) return;
    handled();
    const step = e.shiftKey ? NUDGE_BIG : NUDGE;
    if (e.altKey) {
      const tip = planTip(plan, H, resolvedOf(id));
      if (!tip || plan.locked) return;
      commitMany([{ id, patch: { tailX: r4(clamp01(tip.x + d[0] * step)), tailY: r4(clamp01(tip.y + d[1] * step)), pinned: true } }], 'Aim tail');
      return;
    }
    const movers = ids.map((x) => basePlanById.get(x)).filter((p): p is LetterPlan => !!p && !p.locked);
    if (!movers.length) return;
    let dx = d[0] * step;
    let dy = d[1] * step;
    for (const p of movers) {
      const r = moveRange(p, false);
      dx = clamp(dx, Math.min(r.lox, r.hix), Math.max(r.lox, r.hix));
      dy = clamp(dy, Math.min(r.loy, r.hiy), Math.max(r.loy, r.hiy));
    }
    commitMany(
      movers.map((p) => ({ id: p.lineId, patch: { x: r4(p.x / 1000 + dx), y: r4(p.y / H + dy), pinned: true } })),
      movers.length > 1 ? 'Move balloons' : 'Move balloon'
    );
  };

  // ── Background taps: nearest balloon within 22 px, else clear ─────────────
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    const rect = layerRef.current?.getBoundingClientRect();
    const t = travel(rect ?? { width: 0, height: 0 }, pageWidth, pageHeight);
    if (addKind && onAddAt && rect) {
      e.preventDefault();
      onAddAt(addKind, { x: clamp01((e.clientX - rect.left) / t.w), y: clamp01((e.clientY - rect.top) / t.h) });
      return;
    }
    if (rect) {
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let best: { id: string; d: number } | null = null;
      for (const p of base.plans) {
        const o = outlineFractions(p, H);
        const ox = Math.max(o.x * t.w - px, 0, px - (o.x + o.w) * t.w);
        const oy = Math.max(o.y * t.h - py, 0, py - (o.y + o.h) * t.h);
        const dist = Math.hypot(ox, oy);
        if (dist <= NEAREST_TAP_PX && (!best || dist < best.d)) best = { id: p.lineId, d: dist };
      }
      if (best) {
        select(best.id, e.shiftKey);
        return;
      }
    }
    select(null);
  };

  const primary = selection[0];
  const primaryPlan = primary ? planById.get(primary) : undefined;
  const coarse = isCoarsePointer();
  const zs = zoom.scale > 0 ? zoom.scale : 1;
  const editingPlan = editingLineId ? planById.get(editingLineId) : undefined;
  const editingLine = editingLineId ? findLineRef(page, editingLineId)?.line : undefined;
  const presetName = LETTERING_PRESETS[ls.presetId]?.name ?? 'Classic comic';

  return (
    <div
      ref={layerRef}
      className={cx('absolute inset-0 z-[2]', editable ? (addKind ? 'cursor-crosshair' : '') : 'pointer-events-none')}
      {...(editable ? { role: 'group', 'aria-label': `Lettering for page ${page.n}` } : ariaHidden ? { 'aria-hidden': true } : {})}
      onPointerDown={editable ? onBackgroundPointerDown : undefined}
      data-testid="balloon-layer"
    >
      <LetteringSvg
        plans={plans}
        aspect={aspect}
        widthPx={pageWidth}
        ariaHidden={ariaHidden || editable}
        visibleLineIds={visibleLineIds}
        selectedLineIds={editable ? selectedSet : undefined}
        docLang={doc.format?.language}
        markFallbackLang={markUntranslated}
        labelFor={labelFor}
        className={cx('pointer-events-none absolute inset-0 h-full w-full select-none', visibleLineIds && '[&_.ds-lettering-balloon]:transition-opacity [&_.ds-lettering-balloon]:duration-300 motion-reduce:[&_.ds-lettering-balloon]:transition-none')}
      />
      {editable &&
        readingOrder.map((id) => {
          const p = planById.get(id)!;
          const o = outlineFractions(p, H);
          const sel = selectedSet.has(id);
          const style = p.style;
          const fontLabel = FONT_REGISTRY[p.fontId]?.label ?? p.fontId;
          const describe = `${presetName}; ${fontLabel}; ${style.shape.replace('_', ' ')} balloon${p.locked ? '; locked' : ''}${p.outOfSafeArea ? '; outside the safe area' : ''}${p.overflow ? '; text does not fit' : ''}`;
          return (
            <div
              key={id}
              data-testid="balloon-hit"
              data-line-id={id}
              data-kind={p.kind}
              data-fallback={base.placements.fallback.has(id) || undefined}
              data-crowded={base.placements.crowded.has(id) || undefined}
              data-locked={p.locked || undefined}
              lang={p.lang}
              dir={p.dir}
              className={cx(
                'absolute select-none rounded-[30%] focus:outline-none',
                addKind ? 'pointer-events-none' : 'pointer-events-auto',
                p.locked ? 'cursor-not-allowed' : 'cursor-move',
                // A selected balloon owns its touches (drag at once); unselected ones let the page pan/scroll.
                sel && 'touch-none outline-dashed outline-2 outline-offset-2 outline-[#D97757]',
                'focus-visible:outline-dashed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D97757]',
                lifted === id && 'scale-[1.04] shadow-[0_10px_30px_rgba(0,0,0,0.35)] motion-reduce:scale-100'
              )}
              style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%`, zIndex: sel ? 5 : 1 }}
              role="button"
              tabIndex={0}
              aria-roledescription="movable balloon"
              aria-label={`${labels.get(id) ?? planText(p)}. ${p.locked ? 'Locked.' : `Drag or use the arrow keys to move${planTip(p, H, resolvedOf(id)) ? '; Alt+arrows move the tail' : ''}. Enter edits the text.`}`}
              aria-describedby={`bd-${page.id}-${id}`}
              aria-pressed={sel}
              onPointerDown={(e) => beginDrag(e, p, 'move')}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onEditingChange?.(id);
              }}
              onContextMenu={(e) => {
                // Long-press/right-click selects (the inspector holds the actions).
                e.preventDefault();
                if (!sel) select(id);
              }}
              onKeyDown={(e) => onKeyDown(e, p)}
              onFocus={() => {
                if (!selectionRef.current.includes(id)) select(id);
              }}
            >
              <span id={`bd-${page.id}-${id}`} className="sr-only">
                {describe}
              </span>
            </div>
          );
        })}
      {editable && primaryPlan && selection.length === 1 && !editingPlan && !primaryPlan.locked && (
        <Handles plan={primaryPlan} H={H} tip={planTip(primaryPlan, H, resolvedOf(primaryPlan.lineId))} coarse={coarse} scale={zs} onDrag={(e, mode) => beginDrag(e, primaryPlan, mode)} />
      )}
      {editable && <SnapGuides guides={guides} />}
      {editable && editingPlan && editingLine && onOps && (
        <BalloonTextEditor
          key={editingPlan.lineId}
          plan={editingPlan}
          H={H}
          pageWidthPx={pageWidth}
          text={editingLine.text}
          onCommit={(text) => {
            const ops = textEditOps(page, editingPlan.lineId, text);
            if (ops.length) onOps(ops, { label: 'Edit balloon text' });
            onEditingChange?.(null);
          }}
          onCancel={() => onEditingChange?.(null)}
        />
      )}
    </div>
  );
};

const isCoarsePointer = (): boolean => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

/** Tail + width handles for the primary selection (44 px hit areas on touch; slider roles for AT). */
const Handles: React.FC<{
  plan: LetterPlan;
  H: number;
  tip: { x: number; y: number } | null;
  coarse: boolean;
  scale: number;
  onDrag: (e: React.PointerEvent, mode: DragMode) => void;
}> = ({ plan, H, tip, coarse, scale, onDrag }) => {
  const dot = (coarse ? 20 : 14) / scale;
  const grip = { w: (coarse ? 10 : 8) / scale, h: (coarse ? 32 : 24) / scale };
  const hit = 44 / scale;
  const right = (plan.x + plan.w) / 1000;
  const midY = (plan.y + plan.h / 2) / H;
  return (
    <>
      {tip && (
        <span
          role="slider"
          aria-label="Tail direction"
          aria-valuetext={`Tail tip at ${Math.round(tip.x * 100)}% across, ${Math.round(tip.y * 100)}% down`}
          aria-valuenow={Math.round(tip.x * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid="tail-handle"
          onPointerDown={(e) => onDrag(e, 'tail')}
          className="pointer-events-auto absolute z-[6] -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-white bg-[var(--ds-accent)] shadow"
          style={{ left: `${tip.x * 100}%`, top: `${tip.y * 100}%`, width: dot, height: dot }}
          title="Drag to aim the tail"
        >
          <span aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: hit, height: hit }} />
        </span>
      )}
      <span
        role="slider"
        aria-label="Balloon width"
        aria-valuetext={`${Math.round((plan.w / 1000) * 100)}% of the page width`}
        aria-valuenow={Math.round((plan.w / 1000) * 100)}
        aria-valuemin={6}
        aria-valuemax={95}
        data-testid="width-handle"
        onPointerDown={(e) => onDrag(e, 'width')}
        className="pointer-events-auto absolute z-[6] -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-[var(--ds-accent)] shadow"
        style={{ left: `calc(${right * 100}% + ${2 / scale}px)`, top: `${midY * 100}%`, width: grip.w, height: grip.h }}
        title="Drag to resize"
      >
        <span aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: hit, height: hit }} />
      </span>
    </>
  );
};
