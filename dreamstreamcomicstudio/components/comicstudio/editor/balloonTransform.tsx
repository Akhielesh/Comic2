// The Pro balloon transform kit (PE-SHELL; master plan §2.7 C-CANVAS, agent-editor plan §3 C8, C9): the rotate and
// height handles, the two-finger rotate and the B9 rotation engine behind them. LAZY: the page editor loads it only
// while the Pro view shows (editor/proLazy.ts) and hands it to the balloon layer through BalloonEditorExtrasContext.
//
// The balloon layer is in every reader's first load (ComicPageView → BalloonLayer), so the layer itself imports nothing
// from here but types: no B9 transform engine (transform.ts → scene.ts → undo.ts) and no shell table reach a reader
// (master plan §2.8). tests/e2e (PE-QA) can check `data-testid="rotate-handle"` is absent from the reader chunk.
//
// Every edit here is ONE `balloon` op on release ({rot} through rotateEdit, or {minH}): existing, server-accepted
// fields, never a Pro op or a Pro field (PRO_EDIT_OPS_PATCHABLE stays false and is not involved).

import React, { useEffect } from 'react';
import type { Balloon, ComicDoc, Page } from '../../../shared/comic/doc';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { EDITOR_LIMITS } from '../../../shared/comic/limits';
import { ROTATE_STEP, clampRot, normalizeDeg, rotateEdit, snapAngle } from '../../../shared/comic/editor/transform';
import { cn } from '../../../lib/utils';
import { INVERSE_SURFACE, RADIUS_PILL } from '../../chat/studioDesign';
import { outlineFractions } from '../lettering/styleOps';
import { PAGE_Z } from './kit/zLayers';

/** How far the rotate handle sits above the outline (screen px). */
const ROTATE_GAP_PX = 28;

/**
 * A rotation drag: the start rotation plus the pointer's turn around the centre since the press, snapped to 15°
 * detents (free with Alt), clamped to ±EDITOR_LIMITS.balloonRot. Angles are measured in physical units (`aspect` =
 * page width ÷ height), 0 = up, clockwise positive. Pure; tested.
 */
export const dragRotation = (start: number, centre: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }, aspect: number, free = false): number => {
  const angle = (p: { x: number; y: number }) => (Math.atan2((p.x - centre.x) * aspect, -(p.y - centre.y)) * 180) / Math.PI;
  const raw = normalizeDeg(start + angle(to) - angle(from));
  const deg = free ? Math.round(raw * 10) / 10 : snapAngle(raw);
  return clampRot(deg, EDITOR_LIMITS.balloonRot);
};

/** One press (R / Shift+R, the rotate slider's arrows): the next 15° detent from `rot`, clamped. Pure. */
export const turnStep = (rot: number, dir: 1 | -1): number => clampRot(snapAngle(rot + dir * ROTATE_STEP), EDITOR_LIMITS.balloonRot);

/** Two fingers: the start rotation turned by `delta` degrees, snapped to a detent and clamped. Pure. */
export const turnBy = (start: number, delta: number): number => clampRot(snapAngle(normalizeDeg(start + delta)), EDITOR_LIMITS.balloonRot);

/**
 * The balloon patch the B9 engine makes for a rotation (rotateEdit: ±45°, null clears, pinned), or null when it refuses
 * or nothing changes. `page` must already carry the balloon (a software-placed one is passed with its drawn box).
 */
export const rotatePatch = (doc: ComicDoc, page: Page, lineId: string, deg: number): Partial<Balloon> | null => {
  const res = rotateEdit(doc, page, { kind: 'balloon', id: lineId }, deg);
  if (!res.ok) return null;
  const op = res.ops.find((o) => o.op === 'balloon');
  return op && op.op === 'balloon' ? (op.patch as Partial<Balloon>) : null;
};

/** What the two-finger listener calls into (the balloon layer fills it on every render). */
export interface TwoFingerApi {
  /** The one selected, unlocked balloon (the only one two fingers can turn), or null. */
  selectedOne(): string | null;
  begin(id: string): { move(delta: number): void; end(commit: boolean): void } | null;
  /** Cancel the one-finger drag the first finger started. */
  cancelDrag(): void;
}

/**
 * Two fingers on the selected balloon rotate it (C9), with 15° detents, one op when the first finger lifts. The second
 * finger's pointerdown is taken in the WINDOW capture phase, before TouchCanvas's root capture listener (which would
 * start a pinch) and before the layer's (which would cancel the drag as a pinch). Two fingers anywhere else are left
 * alone: they still zoom. Renders nothing.
 */
export const TwoFingerRotate: React.FC<{ api: React.RefObject<TwoFingerApi | null> }> = ({ api }) => {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let first: { id: number; x: number; y: number; line: string } | null = null;
    let g: { a: number; b: number; pa: { x: number; y: number }; pb: { x: number; y: number }; a0: number; turn: { move(delta: number): void; end(commit: boolean): void } } | null = null;
    const angle = (pa: { x: number; y: number }, pb: { x: number; y: number }) => (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
    const lineAt = (t: EventTarget | null): string | null => {
      const el = t as Element | null;
      const hit = el && typeof el.closest === 'function' ? el.closest('[data-testid="balloon-hit"]') : null;
      return hit ? hit.getAttribute('data-line-id') : null;
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      const now = api.current;
      const sel = now?.selectedOne() ?? null;
      const line = lineAt(ev.target);
      if (!first) {
        first = sel && line === sel ? { id: ev.pointerId, x: ev.clientX, y: ev.clientY, line } : null;
        return;
      }
      if (g || !now || ev.pointerId === first.id || line !== first.line) return;
      const turn = now.begin(first.line);
      if (!turn) return;
      ev.stopPropagation();
      now.cancelDrag();
      const pa = { x: first.x, y: first.y };
      const pb = { x: ev.clientX, y: ev.clientY };
      g = { a: first.id, b: ev.pointerId, pa, pb, a0: angle(pa, pb), turn };
    };
    const onMove = (ev: PointerEvent) => {
      if (first && ev.pointerId === first.id) {
        first.x = ev.clientX;
        first.y = ev.clientY;
      }
      if (!g) return;
      if (ev.pointerId === g.a) g.pa = { x: ev.clientX, y: ev.clientY };
      else if (ev.pointerId === g.b) g.pb = { x: ev.clientX, y: ev.clientY };
      else return;
      g.turn.move(normalizeDeg(angle(g.pa, g.pb) - g.a0));
    };
    const end = (commit: boolean) => (ev: PointerEvent) => {
      if (first && ev.pointerId === first.id) first = null;
      if (!g || (ev.pointerId !== g.a && ev.pointerId !== g.b)) return;
      const done = g;
      g = null;
      done.turn.end(commit);
      // The lifted finger ends the gesture; the other one stays still until it lifts (no drag starts from it).
      first = null;
    };
    const up = end(true);
    const cancel = end(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
    };
  }, [api]);
  return null;
};

export interface TransformHandlesProps {
  plan: LetterPlan;
  H: number;
  coarse: boolean;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  /** The 44 px touch target (screen px). */
  hitPx: number;
  rot: number;
  turning: boolean;
  /** The natural outline height (page fraction): the height slider's least value. */
  minHeight: number;
  onDrag: (e: React.PointerEvent, mode: 'rotate' | 'height') => void;
  onKey: (e: React.KeyboardEvent, mode: 'rotate' | 'height') => void;
}

const HANDLE = 'pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-white bg-[var(--ds-accent)] shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] focus-visible:ring-offset-1';

/**
 * Pro: the rotate handle above the selected balloon and the height grip under it (master plan §2.7, C-CANVAS). Both are
 * sliders for the keyboard (arrows: 15° a press, or a height step), 44 px targets on touch, ringed in white like the
 * other handles, on the page's handle rung (PAGE_Z.handles); the turn shows its angle while it happens.
 */
export const TransformHandles: React.FC<TransformHandlesProps> = ({ plan, H, coarse, scale, pageWidth, pageHeight, hitPx, rot, turning, minHeight, onDrag, onKey }) => {
  const o = outlineFractions(plan, H);
  const s = Math.max(scale, 1e-6);
  const hit = hitPx / s;
  const dot = (coarse ? 18 : 12) / s;
  const cxPct = (o.x + o.w / 2) * 100;
  const gap = (coarse ? ROTATE_GAP_PX + 12 : ROTATE_GAP_PX) / s;
  const rotTop = Math.max(0, o.y * pageHeight - gap);
  const gripTop = Math.min(pageHeight, (o.y + o.h) * pageHeight + (coarse ? hitPx / 2 / s : 0));
  const heightPct = Math.round(o.h * 1000) / 10;
  return (
    <>
      <span
        role="slider"
        aria-label="Rotation"
        aria-valuenow={rot}
        aria-valuemin={-EDITOR_LIMITS.balloonRot}
        aria-valuemax={EDITOR_LIMITS.balloonRot}
        aria-valuetext={`${rot}°. Arrow keys turn it ${ROTATE_STEP}°.`}
        data-testid="rotate-handle"
        data-no-canvas-gesture
        tabIndex={0}
        onPointerDown={(e) => onDrag(e, 'rotate')}
        onKeyDown={(e) => onKey(e, 'rotate')}
        className={cn(HANDLE, 'cursor-grab border-2')}
        style={{ left: `${cxPct}%`, top: `${(rotTop / (pageHeight || 1)) * 100}%`, width: dot, height: dot, zIndex: PAGE_Z.handles }}
        title="Drag to rotate (15° steps; Alt for any angle)"
      >
        <span aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: hit, height: hit }} />
        {turning && (
          <span aria-live="polite" data-testid="rotate-readout" className={cn('pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums', RADIUS_PILL, INVERSE_SURFACE)}>
            {rot}°
          </span>
        )}
      </span>
      <span
        role="slider"
        aria-label="Balloon height"
        aria-orientation="vertical"
        aria-valuenow={heightPct}
        aria-valuemin={Math.round(minHeight * 1000) / 10}
        aria-valuemax={EDITOR_LIMITS.minHMax * 100}
        aria-valuetext={`${heightPct}% of the page height. Arrow keys change it; it never goes below the text.`}
        data-testid="height-handle"
        data-no-canvas-gesture
        tabIndex={0}
        onPointerDown={(e) => onDrag(e, 'height')}
        onKeyDown={(e) => onKey(e, 'height')}
        className={cn(HANDLE, 'cursor-ns-resize border')}
        style={{ left: `${cxPct}%`, top: `${(gripTop / (pageHeight || 1)) * 100}%`, width: (coarse ? 32 : 24) / s, height: (coarse ? 10 : 8) / s, zIndex: PAGE_Z.handles }}
        title="Drag to change the height"
      >
        <span aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: hit, height: hit }} />
      </span>
    </>
  );
};

/** What the balloon layer reads through BalloonEditorExtras.kit (one object, so the layer imports only its type). */
export interface BalloonTransformKit {
  /** The B9 detent (15°). */
  step: number;
  dragRotation: typeof dragRotation;
  turnStep: typeof turnStep;
  turnBy: typeof turnBy;
  rotatePatch: typeof rotatePatch;
  TransformHandles: React.FC<TransformHandlesProps>;
  TwoFingerRotate: React.FC<{ api: React.RefObject<TwoFingerApi | null> }>;
}

export const BALLOON_TRANSFORM_KIT: BalloonTransformKit = { step: ROTATE_STEP, dragRotation, turnStep, turnBy, rotatePatch, TransformHandles, TwoFingerRotate };
