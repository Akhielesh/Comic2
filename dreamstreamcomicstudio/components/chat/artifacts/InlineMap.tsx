import React, { Suspense, lazy, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { MapArtifact } from '../../../apiTypes';
import { ExpandLightbox } from './kit/ExpandLightbox';

// Leaflet ships as its own chunk and only loads when a map actually renders.
const MapPanel = lazy(() => import('../MapPanel'));

/**
 * An interactive map rendered INLINE in the chat message (not behind a button).
 * Expand opens a full-screen lightbox right where the user is (same pattern as the
 * video player) — it no longer hijacks the persistent right side panel.
 * `radar` overlays live RainViewer precipitation tiles (weather card toggle).
 */
export const InlineMap: React.FC<{ data: MapArtifact; height?: number; radar?: boolean }> = ({ data, height = 220, radar }) => {
  const [expanded, setExpanded] = useState(false);
  if (!data?.markers?.length) return null;
  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--ds-hairline)] ring-1 ring-[var(--ds-hairline-soft)]" style={{ height }}>
      <Suspense fallback={<div className="flex h-full w-full items-center justify-center bg-[var(--ds-well)]"><Loader2 className="h-5 w-5 animate-spin text-[var(--ds-muted)]" /></div>}>
        <MapPanel data={data} radar={radar} onExpand={() => setExpanded(true)} />
      </Suspense>
      {expanded && (
        <ExpandLightbox title={data.title || 'Map'} onClose={() => setExpanded(false)}>
          <div className="h-[78vh] overflow-hidden rounded-xl border border-[var(--ds-hairline)]">
            <Suspense fallback={<div className="flex h-full w-full items-center justify-center bg-[var(--ds-well)]"><Loader2 className="h-5 w-5 animate-spin text-[var(--ds-muted)]" /></div>}>
              <MapPanel data={data} radar={radar} />
            </Suspense>
          </div>
        </ExpandLightbox>
      )}
    </div>
  );
};
