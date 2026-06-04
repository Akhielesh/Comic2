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
    <div className="relative rounded-lg overflow-hidden border-2 border-black" style={{ height }}>
      <Suspense fallback={<div className="w-full h-full flex items-center justify-center bg-slate-100"><Loader2 className="w-5 h-5 animate-spin text-brand-blue" /></div>}>
        <MapPanel data={data} />
      </Suspense>
      {openPanel && (
        <button
          onClick={() => openPanel({ type: 'map', data })}
          className="absolute top-1.5 right-1.5 z-[1000] border-2 border-black rounded bg-white/90 p-1 hover:bg-brand-yellow"
          title="Expand map"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
