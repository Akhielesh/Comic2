import React, { useState } from 'react';
import { Plus, Minus, LocateFixed, Frame, Maximize2, Loader2 } from 'lucide-react';

// A calm-studio glass control cluster overlaid on a Leaflet map — our answer to
// mapcn's <MapControls>, but in the app's frosted-glass language and pushed a step
// further: a real "show my location" button (with an async spinner), a "recenter"
// that re-frames the whole route/markers, and an expand-to-fullscreen hook.
//
// Purely presentational + dependency-free (no Leaflet import): the parent owns the
// map instance and supplies the handlers, so this same cluster drops onto every map
// surface (general map, directions, …) and stays out of the eager bundle's way.
//
// Compass is intentionally absent: the raster basemap never rotates (north is always
// up), so a compass would be a no-op — we don't ship controls that lie.

export type MapControlsPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

interface MapControlsProps {
  position?: MapControlsPosition;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  /** Re-frame the map to all markers / the whole route. */
  onRecenter?: () => void;
  /** Geolocate the user; may be async (the button shows a spinner while it runs). */
  onLocate?: () => void | Promise<void>;
  /** Expand the map (e.g. into a fullscreen lightbox). */
  onFullscreen?: () => void;
}

const POS: Record<MapControlsPosition, string> = {
  'top-right': 'right-1.5 top-1.5 items-end',
  'top-left': 'left-1.5 top-1.5 items-start',
  'bottom-right': 'bottom-7 right-1.5 items-end',
  'bottom-left': 'bottom-7 left-1.5 items-start'
};

const SHELL =
  'pointer-events-auto overflow-hidden rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[0_1px_3px_rgba(0,0,0,0.12)] backdrop-blur-sm';
const BTN =
  'grid size-7 place-items-center text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]/40 disabled:cursor-default disabled:opacity-60';

export const MapControls: React.FC<MapControlsProps> = ({
  position = 'top-right',
  onZoomIn,
  onZoomOut,
  onRecenter,
  onLocate,
  onFullscreen
}) => {
  const [locating, setLocating] = useState(false);

  const handleLocate = async (): Promise<void> => {
    if (!onLocate || locating) return;
    setLocating(true);
    try {
      await onLocate();
    } finally {
      setLocating(false);
    }
  };

  const hasZoom = onZoomIn || onZoomOut;

  // The wrapper ignores pointer events so map drag/pan still works in the gaps
  // between buttons; each control re-enables them via `pointer-events-auto`.
  return (
    <div className={`pointer-events-none absolute z-[1000] flex flex-col gap-1.5 ${POS[position]}`}>
      {hasZoom && (
        <div className={`flex flex-col ${SHELL}`}>
          <button type="button" className={BTN} onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">
            <Plus className="size-4" />
          </button>
          <div className="h-px bg-[var(--ds-hairline-soft)]" />
          <button type="button" className={BTN} onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">
            <Minus className="size-4" />
          </button>
        </div>
      )}

      {onLocate && (
        <button
          type="button"
          onClick={handleLocate}
          disabled={locating}
          aria-busy={locating}
          title="Show my location"
          aria-label="Show my location"
          className={`${SHELL} ${BTN}`}
        >
          {locating ? <Loader2 className="size-4 animate-spin" /> : <LocateFixed className="size-4" />}
        </button>
      )}

      {onRecenter && (
        <button
          type="button"
          onClick={onRecenter}
          title="Recenter"
          aria-label="Recenter map"
          className={`${SHELL} ${BTN}`}
        >
          <Frame className="size-4" />
        </button>
      )}

      {onFullscreen && (
        <button
          type="button"
          onClick={onFullscreen}
          title="Expand map"
          aria-label="Expand map"
          className={`${SHELL} ${BTN}`}
        >
          <Maximize2 className="size-3.5" />
        </button>
      )}
    </div>
  );
};
