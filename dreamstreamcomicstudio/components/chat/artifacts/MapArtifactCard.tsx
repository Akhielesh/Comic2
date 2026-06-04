import React from 'react';
import { Map as MapIcon } from 'lucide-react';
import type { MapArtifact } from '../../../apiTypes';
import { InlineMap } from './InlineMap';

/** Renders an interactive map inline in the chat (expandable to the side panel). */
export const MapArtifactCard: React.FC<{ data: MapArtifact }> = ({ data }) => {
  const places = data.markers.map((m) => m.label).join(', ');
  return (
    <div className="my-2">
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500 mb-1.5">
        <MapIcon className="w-3.5 h-3.5" />
        <span className="truncate">{data.title || `${data.markers.length} place${data.markers.length === 1 ? '' : 's'}`}</span>
      </div>
      <InlineMap data={data} height={240} />
      {places && <div className="text-[11px] text-slate-500 mt-1 truncate">{places}</div>}
    </div>
  );
};
