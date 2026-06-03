import React from 'react';
import { Map as MapIcon, ArrowRight } from 'lucide-react';
import type { MapArtifact } from '../../../apiTypes';
import { useChatPanel } from '../panelContext';

/** Inline card that opens the full interactive map in the side panel. */
export const MapArtifactCard: React.FC<{ data: MapArtifact }> = ({ data }) => {
  const openPanel = useChatPanel();
  const places = data.markers.map((m) => m.label).join(', ');
  return (
    <button
      onClick={() => openPanel?.({ type: 'map', data })}
      className="my-2 w-full flex items-center gap-3 border-2 border-black rounded-lg p-2.5 bg-white shadow-comic hover:bg-sky-50 hover:translate-y-[1px] text-left"
    >
      <span className="w-9 h-9 shrink-0 rounded-lg border-2 border-black bg-sky-100 flex items-center justify-center">
        <MapIcon className="w-4 h-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold truncate">{data.title || `Map · ${data.markers.length} place${data.markers.length === 1 ? '' : 's'}`}</span>
        <span className="block text-[11px] text-slate-500 truncate">{places}</span>
      </span>
      <span className="shrink-0 flex items-center gap-1 text-[11px] font-bold text-brand-blue">Open map <ArrowRight className="w-3.5 h-3.5" /></span>
    </button>
  );
};
