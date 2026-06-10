import React from 'react';
import { Map as MapIcon } from 'lucide-react';
import type { MapArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';
import { InlineMap } from './InlineMap';

/**
 * Renders an interactive map inline in the chat (expandable to the side panel).
 *  • compact — a short fixed-height map (~140px) with the marker count.
 *  • detailed — the full-height map plus the list of plotted places.
 */
export const MapArtifactCard: React.FC<{ data: MapArtifact }> = ({ data }) => {
  const compact = useCompact();
  const count = data.markers.length;
  const countLabel = `${count} place${count === 1 ? '' : 's'}`;
  const places = data.markers.map((m) => m.label).join(', ');

  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      <MapIcon className="h-4 w-4 shrink-0 text-[#6e6a60]" />
      <SurfaceTitle>{data.title || countLabel}</SurfaceTitle>
    </span>
  );

  if (compact) {
    return (
      <Surface header={header} right={<SurfaceSubtitle>{countLabel}</SurfaceSubtitle>}>
        <div className="px-3 pb-3 pt-1">
          <InlineMap data={data} height={140} />
        </div>
      </Surface>
    );
  }

  return (
    <Surface header={header} right={<SurfaceSubtitle>{countLabel}</SurfaceSubtitle>}>
      <div className="px-3 pb-3 pt-1">
        <InlineMap data={data} height={240} />
        {places && <div className="mt-1.5 truncate text-[11px] text-[#6e6a60]">{places}</div>}
      </div>
    </Surface>
  );
};
