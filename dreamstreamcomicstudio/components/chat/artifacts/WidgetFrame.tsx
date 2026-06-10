import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { DensityProvider, type WidgetDensity } from './kit';

// Universal widget chrome: wraps every artifact card with the two capabilities the
// component system promises —
//
//  1. TWO VERSIONS PER WIDGET. A `compact` glance mode and a `detailed` expansive
//     mode, toggled by the pill that floats over the card on hover/touch. Cards with
//     a bespoke compact layout read the mode via `useDensity()`; cards without one
//     are clamped to a short, scrim-faded preview so compact mode still works
//     everywhere. The AI can pre-pick a mode by putting `density: 'compact'` in the
//     artifact data; the user's last choice per widget type wins after that.
//
//  2. RESIZE. A bottom drag handle adjusts the widget's height (the natural axis in
//     a chat column — width is owned by the responsive grid). Drag to resize,
//     double-click the handle to snap back to auto. Sizes persist per widget type.
//
// All chrome is quiet macOS glass: it appears on hover (always available via touch
// on mobile because the controls are part of the layout flow's overlay).

const DENSITY_STORE = 'ds.widget.density.v1';
const HEIGHT_STORE = 'ds.widget.height.v1';

const readStore = (key: string): Record<string, unknown> => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeStore = (key: string, type: string, value: unknown) => {
  try {
    const all = readStore(key);
    if (value === undefined) delete all[type];
    else all[type] = value;
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* storage unavailable (private mode) — sizes just don't persist */
  }
};

interface WidgetFrameProps {
  /** Artifact type — keys the persisted density/size preferences. */
  type: string;
  /** AI-provided density hint from the artifact data (`data.density`). */
  densityHint?: WidgetDensity;
  /** True when the card implements a real compact layout via useDensity(). */
  densityAware: boolean;
  /** Controlled density (used by the gallery's global toggle); hides the toggle. */
  forcedDensity?: WidgetDensity;
  children: React.ReactNode;
}

/** Height (px) of the clamped preview for cards without a bespoke compact layout. */
const CLAMP_HEIGHT = 210;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 1400;

export const WidgetFrame: React.FC<WidgetFrameProps> = ({ type, densityHint, densityAware, forcedDensity, children }) => {
  const [ownDensity, setDensity] = useState<WidgetDensity>(() => {
    const saved = readStore(DENSITY_STORE)[type];
    if (saved === 'compact' || saved === 'detailed') return saved;
    return densityHint === 'compact' ? 'compact' : 'detailed';
  });
  // User-dragged height in px; null = natural (auto) height.
  const [height, setHeight] = useState<number | null>(() => {
    const saved = readStore(HEIGHT_STORE)[type];
    return typeof saved === 'number' && saved >= MIN_HEIGHT ? saved : null;
  });
  const [dragging, setDragging] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startY: number; startH: number } | null>(null);
  const density = forcedDensity ?? ownDensity;

  const toggleDensity = () => {
    const next: WidgetDensity = density === 'compact' ? 'detailed' : 'compact';
    setDensity(next);
    writeStore(DENSITY_STORE, type, next);
    // Mode switches reset any manual height so the new layout sizes naturally.
    setHeight(null);
    writeStore(HEIGHT_STORE, type, undefined);
  };

  const onHandleDown = (e: React.PointerEvent) => {
    const el = bodyRef.current;
    if (!el) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startY: e.clientY, startH: height ?? el.getBoundingClientRect().height };
    setDragging(true);
  };

  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragState.current) return;
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragState.current.startH + (e.clientY - dragState.current.startY)));
    setHeight(next);
  };

  const onHandleUp = () => {
    if (!dragState.current) return;
    dragState.current = null;
    setDragging(false);
    setHeight((h) => {
      writeStore(HEIGHT_STORE, type, h ?? undefined);
      return h;
    });
  };

  const resetHeight = useCallback(() => {
    setHeight(null);
    writeStore(HEIGHT_STORE, type, undefined);
  }, [type]);

  // Escape cancels an in-flight drag (macOS behavior).
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dragState.current = null;
        setDragging(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);

  // Compact fallback for cards without their own compact layout: clamp + fade.
  const clamped = density === 'compact' && !densityAware;
  const fixedHeight = height != null && density === 'detailed';

  return (
    <div className="group/widget relative">
      {/* Density toggle — floats over the card's top-right corner. */}
      {!forcedDensity && <button
        onClick={toggleDensity}
        title={density === 'compact' ? 'Expand: full detail' : 'Collapse: glance view'}
        aria-label={density === 'compact' ? 'Show detailed view' : 'Show compact view'}
        className="absolute right-2 top-3 z-20 flex h-6 w-6 items-center justify-center rounded-lg border border-black/10 bg-white/90 text-[#6e6a60] opacity-0 shadow-[0_1px_3px_rgba(0,0,0,0.1)] backdrop-blur-sm transition-all duration-200 hover:text-[#1a1915] focus-visible:opacity-100 group-hover/widget:opacity-100 group-focus-within/widget:opacity-100 [@media(pointer:coarse)]:opacity-70"
      >
        {density === 'compact' ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
      </button>}

      <div
        ref={bodyRef}
        className={`relative ${clamped || fixedHeight ? 'overflow-hidden' : ''} ${dragging ? 'select-none' : ''}`}
        style={
          clamped
            ? { maxHeight: CLAMP_HEIGHT }
            : fixedHeight
              ? { height: height!, overflowY: 'auto' }
              : undefined
        }
      >
        <DensityProvider value={density}>{children}</DensityProvider>
        {clamped && (
          <button
            onClick={toggleDensity}
            className="absolute inset-x-0 bottom-0 z-10 flex h-16 items-end justify-center bg-gradient-to-t from-[#FAF9F5] via-[#FAF9F5]/80 to-transparent pb-1.5 text-[11px] font-semibold text-[#6e6a60] transition-colors hover:text-[#1a1915]"
          >
            Show more
          </button>
        )}
      </div>

      {/* Resize handle — detailed mode only (compact is fixed-small by design). */}
      {density === 'detailed' && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize widget (drag; double-click to reset)"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onDoubleClick={resetHeight}
          className={`mx-auto -mt-1 mb-0.5 flex h-3.5 w-16 cursor-ns-resize touch-none items-center justify-center opacity-0 transition-opacity duration-200 group-hover/widget:opacity-100 [@media(pointer:coarse)]:opacity-60 ${dragging ? 'opacity-100' : ''}`}
        >
          <div className={`h-1 w-9 rounded-full transition-colors ${dragging ? 'bg-black/30' : 'bg-black/15'}`} />
        </div>
      )}
    </div>
  );
};
