// StudioLayout (mobile.md §3.0): the studio's body per form factor — ONE place that decides.
//
//   single       phones portrait (< 720 wide)   one pane at a time + bottom MobileTabBar
//   single-rail  phones landscape (< 480 tall)  one pane at a time + left NavigationRail
//   split        tablets ≥ 720, desktop         resizable conversation | board (pane switcher collapses)
//   dual-screen  foldable spanning (book)       chat in segment 0, board in segment 1, gap = hinge
//   (split with vertical segments — tabletop posture — puts the board on top, chat + composer below)
//
// Both panes STAY MOUNTED: the hidden one gets `hidden` + `inert` instead of unmounting, so chat
// scroll, the composer draft and the board's tab scroll survive every switch (and images in the
// hidden pane are released by the image budget).

import React, { useEffect, useRef, useState } from 'react';
import { applyGutterDelta } from '../../../studio/kit/ResizableSplit';
import { defaultSplitFor, minPanePx, type FormFactor } from '../formFactor';
import { isDoubleTap, type Tap } from '../touch/gestureMath';
import { DualScreen } from './DualScreen';
import { MobileTabBar, type StudioNavItem } from './MobileTabBar';
import { NavigationRail } from './NavigationRail';
import type { PaneMode } from './PaneSwitcher';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export const SPLIT_STORAGE_KEY = 'comicstudio.split';

// ── Split view ───────────────────────────────────────────────────────────────

export const readSplit = (fallback: number[]): number[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SPLIT_STORAGE_KEY) || 'null');
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) return parsed;
  } catch {
    /* fall through */
  }
  return fallback.slice();
};

/** Two-pane horizontal split; the gutter drags (mouse, touch, pen), takes arrow keys and resets on double tap. */
export const SplitView: React.FC<{ left: React.ReactNode; right: React.ReactNode; ff: FormFactor; mode?: PaneMode }> = ({ left, right, ff, mode = 'both' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const defaults = defaultSplitFor(ff);
  const [sizes, setSizes] = useState<number[]>(() => readSplit(defaults));
  const lastTap = useRef<Tap | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      /* not persisted */
    }
  }, [sizes]);

  const minFrac = (sum: number) => {
    const width = containerRef.current?.getBoundingClientRect().width || 0;
    return width > 0 ? Math.min(sum * 0.45, (minPanePx(width) / width) * sum) : sum * 0.25;
  };

  const reset = () => setSizes(defaults.slice());

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const start = sizes.slice();
    const sum = start[0] + start[1];
    const startX = e.clientX;
    const min = minFrac(sum);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      setSizes(applyGutterDelta(start, 0, ((ev.clientX - startX) / rect.width) * sum, min));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!moved && ev.type === 'pointerup') {
        const tap = { t: Date.now(), x: ev.clientX, y: ev.clientY };
        if (isDoubleTap(lastTap.current, tap)) {
          lastTap.current = null;
          reset();
        } else lastTap.current = tap;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const sum = sizes[0] + sizes[1];
    const step = sum * 0.03;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSizes((s) => applyGutterDelta(s, 0, e.key === 'ArrowLeft' ? -step : step, minFrac(sum)));
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault();
      reset();
    }
  };

  const leftPct = Math.round((sizes[0] / (sizes[0] + sizes[1])) * 100);
  const both = mode === 'both';
  const hideLeft = mode === 'board';
  const hideRight = mode === 'chat';

  return (
    <div ref={containerRef} data-layout-split className="flex h-full min-h-0 w-full min-w-0">
      <div
        hidden={hideLeft}
        inert={hideLeft || undefined}
        data-pane="chat"
        className={cx(hideLeft ? 'hidden' : 'flex', 'min-h-0 min-w-0')}
        style={both ? { flexGrow: sizes[0], flexShrink: 1, flexBasis: 0 } : { flex: '1 1 0%' }}
      >
        {left}
      </div>
      {both && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation and board"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={leftPct}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          onDoubleClick={reset}
          data-hit-exempt={ff.coarse ? undefined : 'gutter: 8 px on fine pointers by design'}
          className={cx(
            'group relative z-10 flex shrink-0 cursor-col-resize touch-none items-stretch justify-center focus-visible:outline-none',
            // Touch: a 24 px hit strip over a 1 px line (takes ~2 px of layout), with a visible grabber.
            ff.coarse ? '-mx-[11px] w-6' : 'w-2'
          )}
        >
          <span className="w-px bg-[var(--ds-hairline)] transition-colors group-hover:bg-[#D97757]/50 group-focus-visible:bg-[var(--ds-accent)]" />
          {ff.coarse && (
            <span aria-hidden className="absolute left-1/2 top-1/2 h-9 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--ds-muted)] opacity-50" />
          )}
        </div>
      )}
      <div
        hidden={hideRight}
        inert={hideRight || undefined}
        data-pane="board"
        className={cx(hideRight ? 'hidden' : 'flex', 'min-h-0 min-w-0')}
        style={both ? { flexGrow: sizes[1], flexShrink: 1, flexBasis: 0 } : { flex: '1 1 0%' }}
      >
        {right}
      </div>
    </div>
  );
};

// ── Layout ───────────────────────────────────────────────────────────────────

export interface StudioLayoutProps {
  ff: FormFactor;
  chat: React.ReactNode;
  board: React.ReactNode;
  /** Phones: the visible pane. */
  view: 'chat' | 'board';
  /** Split / dual: Chat | Both | Board. */
  paneMode?: PaneMode;
  /** Phone navigation (tab bar / rail). */
  navItems: StudioNavItem[];
  onBack: () => void;
}

const PhonePane: React.FC<{ id: 'chat' | 'board'; hidden: boolean; children: React.ReactNode }> = ({ id, hidden, children }) => (
  <div hidden={hidden} inert={hidden || undefined} data-pane={id} className={cx(hidden ? 'hidden' : 'flex', 'absolute inset-0 min-h-0 min-w-0')}>
    {children}
  </div>
);

export const StudioLayout: React.FC<StudioLayoutProps> = ({ ff, chat, board, view, paneMode = 'both', navItems, onBack }) => {
  const { layout, segments } = ff;

  if (layout === 'single' || layout === 'single-rail') {
    const panes = (
      <div className="relative min-h-0 min-w-0 flex-1">
        <PhonePane id="chat" hidden={view !== 'chat'}>
          {chat}
        </PhonePane>
        <PhonePane id="board" hidden={view !== 'board'}>
          {board}
        </PhonePane>
      </div>
    );
    if (layout === 'single-rail') {
      return (
        <div data-layout="single-rail" className="flex min-h-0 w-full min-w-0 flex-1">
          <NavigationRail items={navItems} onBack={onBack} />
          {panes}
        </div>
      );
    }
    return (
      <div data-layout="single" className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        {panes}
        <MobileTabBar items={navItems} />
      </div>
    );
  }

  if (layout === 'dual-screen' || (segments.count === 2 && segments.axis === 'vertical')) {
    const vertical = segments.axis === 'vertical';
    // Book posture: chat | board. Tabletop: board on top, chat + composer below (like a laptop).
    const show: 'both' | 'first' | 'second' =
      paneMode === 'both' ? 'both' : (paneMode === 'chat') === !vertical ? 'first' : 'second';
    return (
      <div data-layout={vertical ? 'tabletop' : 'dual-screen'} className="flex min-h-0 w-full min-w-0 flex-1">
        <DualScreen
          segments={segments}
          first={vertical ? <div data-pane="board" className="flex h-full min-h-0 w-full min-w-0">{board}</div> : <div data-pane="chat" className="flex h-full min-h-0 w-full min-w-0">{chat}</div>}
          second={vertical ? <div data-pane="chat" className="flex h-full min-h-0 w-full min-w-0">{chat}</div> : <div data-pane="board" className="flex h-full min-h-0 w-full min-w-0">{board}</div>}
          show={show}
        />
      </div>
    );
  }

  return (
    <div data-layout="split" className="flex min-h-0 w-full min-w-0 flex-1">
      <SplitView left={chat} right={board} ff={ff} mode={paneMode} />
    </div>
  );
};

export default StudioLayout;
