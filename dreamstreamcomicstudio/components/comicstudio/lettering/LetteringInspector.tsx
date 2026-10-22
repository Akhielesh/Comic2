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
import { fitWidthOps, fixSafeAreaOps, linesOf, moveLineToPanelOps, findLineRef } from './styleOps';
import type { LetteringPanelProps } from './panelTypes';
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
  onClose(): void;
}

const PANEL_W = 320;

export const LetteringInspector: React.FC<LetteringInspectorProps> = (props) => {
  const { doc, page, lineIds, plans, placements, H, apply, onEditText, mode, onModeChange, canPro, anchor, compact, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const lines = linesOf(page, lineIds);
  const view: StudioMode = canPro ? mode : 'easy';
  const anchorKey = anchor ? `${Math.round(anchor.left)},${Math.round(anchor.top)},${Math.round(anchor.right)},${Math.round(anchor.bottom)}` : '';

  useLayoutEffect(() => {
    if (compact || !anchor || typeof window === 'undefined') {
      setPos(null);
      return;
    }
    const el = ref.current;
    const size = { w: el?.offsetWidth || PANEL_W, h: el?.offsetHeight || 420 };
    const p = placeInspector(anchor, size, { w: window.innerWidth, h: window.innerHeight });
    setPos((cur) => (cur && cur.left === p.left && cur.top === p.top ? cur : { left: p.left, top: p.top }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, compact, view, lineIds.join('|')]);

  if (!lines.length) return null;
  const selPlans = plans.filter((p) => lineIds.includes(p.lineId));
  const outside = selPlans.filter((p) => p.outOfSafeArea && !p.locked);
  const overflow = selPlans.filter((p) => p.overflow);
  const crowded = lineIds.filter((id) => placements.crowded.has(id));
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
          className="tap-target grid h-7 w-7 place-items-center rounded-lg text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>
      <div className={cx('min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3', !compact && 'max-h-[min(70vh,560px)]')}>
        {(outside.length > 0 || overflow.length > 0 || crowded.length > 0) && (
          <ul className="space-y-1.5" aria-label="Lettering warnings">
            {outside.length > 0 && (
              <li className="flex items-center gap-2 rounded-lg bg-amber-500/[0.1] px-2 py-1.5 text-[11.5px] text-[var(--ds-ink)]">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                <span className="min-w-0 flex-1">Too close to the page edge (outside the safe area).</span>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-[var(--ds-accent)] hover:bg-[#D97757]/10"
                  onClick={() => apply(fixSafeAreaOps(doc, page, plans, H, placements.balloons, outside.map((p) => p.lineId)), { label: 'Move inside the safe area' })}
                >
                  Fix
                </button>
              </li>
            )}
            {overflow.length > 0 && (
              <li className="flex items-center gap-2 rounded-lg bg-amber-500/[0.1] px-2 py-1.5 text-[11.5px] text-[var(--ds-ink)]">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                <span className="min-w-0 flex-1">The text doesn’t fit — shorten it or widen the balloon.</span>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-[var(--ds-accent)] hover:bg-[#D97757]/10"
                  onClick={() => apply(fitWidthOps(doc, page, overflow.map((p) => p.lineId), placements.balloons), { label: 'Widen balloon' })}
                >
                  Widen
                </button>
              </li>
            )}
            {crowded.length > 0 && one && (
              <li className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/[0.1] px-2 py-1.5 text-[11.5px] text-[var(--ds-ink)]">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                <span className="min-w-0 flex-1">Crowded panel — this balloon overlaps another.</span>
                <button type="button" className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-[var(--ds-accent)] hover:bg-[#D97757]/10" onClick={() => onEditText(one.id)}>
                  Shorten
                </button>
                {nextPanelFor(one.id) && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-[var(--ds-accent)] hover:bg-[#D97757]/10"
                    onClick={() => apply(moveLineToPanelOps(page, one.id, nextPanelFor(one.id)!.id), { label: 'Move line to another panel' })}
                  >
                    Move to panel {nextPanelFor(one.id)!.n}
                  </button>
                )}
              </li>
            )}
          </ul>
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
        style={{ paddingBottom: 'var(--sa-bottom-eff, env(safe-area-inset-bottom, 0px))' }}
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
      style={pos ? { left: pos.left, top: pos.top } : { right: 16, top: 72 }}
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
