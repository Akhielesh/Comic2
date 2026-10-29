// The lettering inspector (lettering.md §7.1–7.2): a floating panel beside the selected balloon(s) that
// flips and clamps to stay inside the viewport (never off-screen, never over the selection when there is
// room), and a bottom sheet on narrow screens. Easy and Pro are VIEWS of the same capability: Pro is gated
// only by `caps.proEditor` (true for everyone now); Easy can do everything too, and everything is also
// reachable by talking to the director. Honest warnings with one-click free fixes: outside the safe
// area, text that doesn't fit, a crowded panel.

import React, { useLayoutEffect, useRef, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { StudioMode } from '../../../shared/comic/capabilities';
import { EasyLetteringPanel } from './EasyLetteringPanel';
import { ProLetteringPanel } from './ProLetteringPanel';
import { balloonOp, fixSafeAreaOps, linesOf, moveLineToPanelOps, findLineRef, pinKeepingSizeOps, widenOps } from './styleOps';
import type { LetteringPanelProps } from './panelTypes';
import type { CrowdedReason } from '../../../shared/comic/lettering/layout';
import { RADIUS_CONTROL, TONE_SURFACE, TONE_TEXT } from '../../chat/studioDesign';
import { Segmented, cx } from '../board/ui';
import { LINE_KIND_LABEL, castName } from '../board/boardModel';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a floating panel of `size` goes next to `anchor` inside `viewport` (pure; tested): right of the
 * selection, else left, else below, else above, else clamped into the viewport's bottom-right.
 */
export function placeInspector(
  anchor: Rect,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  gap = 12,
  margin = 8
): { left: number; top: number; side: 'right' | 'left' | 'below' | 'above' | 'inside' } {
  const clampN = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
  const topBeside = clampN(anchor.top, margin, viewport.h - size.h - margin);
  if (anchor.right + gap + size.w <= viewport.w - margin) return { left: anchor.right + gap, top: topBeside, side: 'right' };
  if (anchor.left - gap - size.w >= margin) return { left: anchor.left - gap - size.w, top: topBeside, side: 'left' };
  const leftAligned = clampN(anchor.left, margin, viewport.w - size.w - margin);
  if (anchor.bottom + gap + size.h <= viewport.h - margin) return { left: leftAligned, top: anchor.bottom + gap, side: 'below' };
  if (anchor.top - gap - size.h >= margin) return { left: leftAligned, top: anchor.top - gap - size.h, side: 'above' };
  return { left: clampN(viewport.w - size.w - margin, margin, viewport.w), top: clampN(viewport.h - size.h - margin, margin, viewport.h), side: 'inside' };
}

export interface LetteringInspectorProps extends Omit<LetteringPanelProps, 'lines'> {
  lineIds: string[];
  mode: StudioMode;
  onModeChange(mode: StudioMode): void;
  /** caps.proEditor — the only permission behind the Pro view. */
  canPro: boolean;
  /** Selection bounds in viewport px (the floating anchor). */
  anchor: Rect | null;
  /** Narrow screens: a bottom sheet instead of a floating panel. */
  compact: boolean;
  /** Bottom sheet only: its height cap in px (the page editor keeps the page above it usable); it scrolls. */
  maxHeight?: number;
  /**
   * Floating only: the area (viewport px) the panel must stay inside — on a dual-screen device the editor
   * passes the tools segment, so the panel never straddles the hinge or leaves the editor's grid.
   */
  bounds?: Rect | null;
  onClose(): void;
}

/** A placed panel clamped into `bounds` (8 px margin); unchanged without bounds. Pure; tested. */
export function clampIntoBounds(p: { left: number; top: number }, size: { w: number; h: number }, bounds: Rect | null | undefined, margin = 8): { left: number; top: number } {
  if (!bounds) return p;
  const clampN = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
  return { left: clampN(p.left, bounds.left + margin, bounds.right - size.w - margin), top: clampN(p.top, bounds.top + margin, bounds.bottom - size.h - margin) };
}

const PANEL_W = 320;
/** The warnings' one-tap free fixes: compact on a mouse, real 44 px boxes on touch (they sit side by side). */
const WARN_BTN = `inline-flex shrink-0 items-center justify-center ${RADIUS_CONTROL} px-1.5 py-0.5 font-semibold text-[var(--ds-accent)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11 coarse:min-w-11 coarse:px-3`;

/** A warning row: the warning tone (a word and an icon, never colour alone). */
const WARN_ROW = `flex items-center gap-2 border ${RADIUS_CONTROL} ${TONE_SURFACE.warning} px-2 py-1.5 text-[11.5px] text-[var(--ds-ink)]`;

/**
 * What the crowded warning says, by the plan's reason — never "overlaps" for a balloon the editor moved
 * precisely so that it no longer does (honest states).
 */
export const CROWDED_COPY: Record<CrowdedReason, string> = {
  overlap: 'Crowded panel — this balloon overlaps another.',
  order: 'This panel has more words than room, so this balloon is read out of order. Shorten the text, or give the panel more room.',
  outside: 'No room in its panel — the editor moved it beside the panel so nothing overlaps.',
  moved: 'No room where it was — the editor moved it so nothing overlaps.'
};

/** The visible explanation of a dense page's smaller lettering (the chip on the page says the same). */
export const densityNote = (scale: number): string =>
  `Dense page — lettered at ${Math.round(scale * 100)}% of its size so every line fits without overlapping. Shorten the text to letter it bigger; Keep here keeps this size.`;

export const LetteringInspector: React.FC<LetteringInspectorProps> = (props) => {
  const { doc, page, lineIds, plans, placements, H, apply, onEditText, mode, onModeChange, canPro, anchor, compact, maxHeight, bounds, onClose } = props;
  const boundsKey = bounds ? `${Math.round(bounds.left)},${Math.round(bounds.top)},${Math.round(bounds.right)},${Math.round(bounds.bottom)}` : '';
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const lines = linesOf(page, lineIds);
  const view: StudioMode = canPro ? mode : 'easy';
  const anchorKey = anchor ? `${Math.round(anchor.left)},${Math.round(anchor.top)},${Math.round(anchor.right)},${Math.round(anchor.bottom)}` : '';

  // Re-place whenever the anchor, the view or the panel's own size changes (a taller Pro tab must not
  // push the panel past the bottom of the viewport). setPos bails out when nothing moved.
  const [sizeTick, setSizeTick] = useState(0);
  useLayoutEffect(() => {
    if (compact || !anchor || typeof window === 'undefined') {
      setPos((cur) => (cur === null ? cur : null));
      return;
    }
    const el = ref.current;
    const size = { w: el?.offsetWidth || PANEL_W, h: el?.offsetHeight || 420 };
    const p = clampIntoBounds(placeInspector(anchor, size, { w: window.innerWidth, h: window.innerHeight }), size, bounds);
    setPos((cur) => (cur && cur.left === p.left && cur.top === p.top ? cur : { left: p.left, top: p.top }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, boundsKey, compact, view, lineIds.join('|'), sizeTick]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (compact || !el || typeof ResizeObserver === 'undefined') return;
    let last = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (Math.abs(h - last) < 1) return;
      last = h;
      setSizeTick((t) => t + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact, lines.length > 0]);

  if (!lines.length) return null;
  const selPlans = plans.filter((p) => lineIds.includes(p.lineId));
  const outside = selPlans.filter((p) => p.outOfSafeArea && !p.locked);
  const overflow = selPlans.filter((p) => p.overflow);
  // The drawn plan is the truth (the editor's own placement may flag a line the drawn page fits fine).
  const crowded = lineIds.filter((id) => {
    const plan = selPlans.find((p) => p.lineId === id);
    return plan ? !!plan.crowded : placements.crowded.has(id);
  });
  const crowdedWhy: CrowdedReason = ((): CrowdedReason => {
    const id = crowded[0];
    const plan = id ? selPlans.find((p) => p.lineId === id) : undefined;
    return plan?.crowdedReason ?? (id ? placements.reasons?.get(id) : undefined) ?? 'moved';
  })();
  const dense = selPlans.find((p) => typeof p.densityScale === 'number' && p.densityScale < 1);
  const one = lines.length === 1 ? lines[0] : undefined;
  const title = one ? `${LINE_KIND_LABEL[one.kind]}${one.speakerId ? ` · ${castName(doc, one.speakerId)}` : ''}` : `${lines.length} balloons`;
  const nextPanelFor = (id: string) => {
    const ref2 = findLineRef(page, id);
    if (!ref2) return undefined;
    const i = page.panels.findIndex((p) => p.id === ref2.panel.id);
    return page.panels[i + 1] ?? page.panels[i - 1];
  };

  const body = (
    <>
      <header className="flex items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--ds-ink)]">{title}</h3>
        {canPro && (
          <Segmented<StudioMode>
            label="Editor view"
            size="xs"
            value={view}
            onChange={onModeChange}
            options={[
              { value: 'easy', label: 'Easy', title: 'Big friendly controls' },
              { value: 'pro', label: 'Pro', title: 'Every typography and bubble control' }
            ]}
          />
        )}
        <button
          type="button"
          aria-label="Close the lettering panel"
          onClick={onClose}
          className={`grid h-7 w-7 place-items-center ${RADIUS_CONTROL} text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:h-11 coarse:w-11`}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>
      <div className={cx('min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3', !compact && 'max-h-[min(70vh,560px)]')}>
        {(outside.length > 0 || overflow.length > 0 || crowded.length > 0) && (
          <ul className="space-y-1.5" aria-label="Lettering warnings">
            {outside.length > 0 && (
              <li className={WARN_ROW}>
                <TriangleAlert className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.warning}`} aria-hidden />
                <span className="min-w-0 flex-1">Too close to the page edge (outside the safe area).</span>
                <button
                  type="button"
                  className={WARN_BTN}
                  onClick={() => apply(fixSafeAreaOps(doc, page, plans, H, placements.balloons, outside.map((p) => p.lineId)), { label: 'Move inside the safe area' })}
                >
                  Fix
                </button>
              </li>
            )}
            {overflow.length > 0 && (
              <li className={WARN_ROW}>
                <TriangleAlert className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.warning}`} aria-hidden />
                <span className="min-w-0 flex-1">The text doesn’t fit — shorten it or widen the balloon.</span>
                <button
                  type="button"
                  className={WARN_BTN}
                  onClick={() => apply(widenOps(doc, page, plans, overflow.map((p) => p.lineId), placements.balloons), { label: 'Widen balloon' })}
                >
                  Widen
                </button>
              </li>
            )}
            {crowded.length > 0 && one && (
              <li className={`${WARN_ROW} flex-wrap`}>
                <TriangleAlert className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.warning}`} aria-hidden />
                <span className="min-w-0 flex-1" data-testid="crowded-reason" data-reason={crowdedWhy}>
                  {CROWDED_COPY[crowdedWhy]}
                </span>
                <button type="button" className={WARN_BTN} onClick={() => onEditText(one.id)}>
                  Shorten
                </button>
                <button
                  type="button"
                  title={crowdedWhy === 'overlap' ? 'Keep this balloon where it is (it may overlap); the editor stops moving it' : 'Keep this balloon where it is drawn, at this size; the editor stops moving it'}
                  className={WARN_BTN}
                  onClick={() => apply(pinKeepingSizeOps([balloonOp(page, one.id, { pinned: true }, placements.balloons)], page, plans, [one.id], props.editionLang), { label: 'Keep balloon here' })}
                >
                  Keep here
                </button>
                {nextPanelFor(one.id) && (
                  <button
                    type="button"
                    className={WARN_BTN}
                    onClick={() => apply(moveLineToPanelOps(page, one.id, nextPanelFor(one.id)!.id), { label: 'Move line to another panel' })}
                  >
                    Move to panel {nextPanelFor(one.id)!.n}
                  </button>
                )}
              </li>
            )}
          </ul>
        )}
        {dense && (
          <p data-testid="density-note" role="note" className={`${RADIUS_CONTROL} bg-[var(--ds-well)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--ds-ink)]`}>
            {densityNote(dense.densityScale!)}
          </p>
        )}
        {one && !one.text.trim() && (
          <p data-testid="empty-line-note" role="status" className={`${RADIUS_CONTROL} bg-[var(--ds-well)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--ds-ink)]`}>
            This line is empty, so no balloon is drawn. Type it in the script (Page tools), or Delete it below.
          </p>
        )}
        {view === 'pro' ? <ProLetteringPanel {...props} lines={lines} /> : <EasyLetteringPanel {...props} lines={lines} />}
      </div>
      <p className="border-t border-[var(--ds-hairline)] px-3 py-1.5 text-[10.5px] text-[var(--ds-muted)]">Free — done by the editor, no AI cost.</p>
    </>
  );

  if (compact) {
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label="Lettering"
        data-testid="lettering-inspector"
        data-presentation="sheet"
        className="fixed inset-x-0 bottom-0 z-[85] flex max-h-[62vh] flex-col rounded-t-2xl border-t border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[0_-12px_40px_rgba(0,0,0,0.25)]"
        style={{
          paddingBottom: 'var(--sa-bottom-eff, env(safe-area-inset-bottom, 0px))',
          ...(typeof maxHeight === 'number' && Number.isFinite(maxHeight) && maxHeight > 0 ? { maxHeight: `min(62vh, ${Math.round(maxHeight)}px)` } : {})
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <span aria-hidden className="mx-auto mt-1.5 h-1 w-9 rounded-full bg-[var(--ds-well-strong)]" />
        {body}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Lettering"
      data-testid="lettering-inspector"
      data-presentation="floating"
      className="fixed z-[85] flex w-[320px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[0_18px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl"
      style={{
        ...(pos ? { left: pos.left, top: pos.top } : { right: 16, top: 72 }),
        // Inside its bounds (a dual-screen segment) the whole panel fits: its body scrolls instead.
        ...(bounds ? { maxHeight: Math.max(160, Math.round(bounds.bottom - bounds.top - 16)) } : {})
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {body}
    </div>
  );
};

export default LetteringInspector;
