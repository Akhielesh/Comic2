import React, { Suspense, lazy } from 'react';
import { Maximize2, Loader2 } from 'lucide-react';
import type { MapArtifact } from '../../../apiTypes';
import { useChatPanel } from '../panelContext';

// Leaflet ships as its own chunk and only loads when a map actually renders.
const MapPanel = lazy(() => import('../MapPanel'));

/**
 * An interactive OpenStreetMap rendered INLINE in the chat message (not behind a
 * button). The expand control still opens the full-height side panel.
 */
export const InlineMap: React.FC<{ data: MapArtifact; height?: number }> = ({ data, height = 220 }) => {
  const openPanel = useChatPanel();
  if (!data?.markers?.length) return null;
  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--ds-hairline)] ring-1 ring-[var(--ds-hairline-soft)]" style={{ height }}>
      <Suspense fallback={<div className="flex h-full w-full items-center justify-center bg-[var(--ds-well)]"><Loader2 className="h-5 w-5 animate-spin text-[var(--ds-muted)]" /></div>}>
        <MapPanel data={data} />
      </Suspense>
      {openPanel && (
        <button
          onClick={() => openPanel({ type: 'map', data })}
          className="absolute right-1.5 top-1.5 z-[1000] rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-1 text-[var(--ds-muted)] shadow-[0_1px_3px_rgba(0,0,0,0.1)] backdrop-blur-sm transition-colors duration-200 hover:bg-[var(--ds-raised)] hover:text-[var(--ds-ink)]"
          title="Expand map"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};
