// PreviewFrame (Sprint 1, S1.4): the live-preview surface — a device-size toggle
// (desktop/tablet/mobile), refresh, open-in-new-tab, and a "boot" reveal (shimmer → fade-in)
// while the container preview loads. Themed via the studio theme.

import React, { useState } from 'react';
import { Monitor, Tablet, Smartphone, RotateCw, ExternalLink } from 'lucide-react';
import { Skeleton, useStudioTheme } from '../kit';

type DeviceId = 'desktop' | 'tablet' | 'mobile';

const DEVICES: { id: DeviceId; label: string; icon: React.ComponentType<{ className?: string }>; width: number | null }[] = [
  { id: 'desktop', label: 'Desktop', icon: Monitor, width: null },
  { id: 'tablet', label: 'Tablet', icon: Tablet, width: 768 },
  { id: 'mobile', label: 'Mobile', icon: Smartphone, width: 390 },
];

export interface PreviewFrameProps {
  url: string;
}

export const PreviewFrame: React.FC<PreviewFrameProps> = ({ url }) => {
  const t = useStudioTheme();
  const [device, setDevice] = useState<DeviceId>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const refresh = () => { setLoaded(false); setReloadKey((k) => k + 1); };
  const width = DEVICES.find((d) => d.id === device)?.width ?? null;
  const framed = width !== null; // tablet/mobile get a device frame

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Toolbar */}
      <div className={`flex items-center gap-2 px-2 py-1.5 border-b ${t.edge} ${t.panelAlt}`}>
        <div role="radiogroup" aria-label="Preview device" className={`inline-flex items-center gap-0.5 rounded-full border ${t.edge} p-0.5`}>
          {DEVICES.map((d) => {
            const Icon = d.icon;
            const active = d.id === device;
            return (
              <button
                key={d.id}
                role="radio"
                aria-checked={active}
                onClick={() => setDevice(d.id)}
                title={d.label}
                className={`flex h-6 w-6 items-center justify-center rounded-full ${t.focusRing} ${
                  active ? `${t.accentBg} ${t.accentText}` : `${t.textDim} ${t.hover}`
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="sr-only">{d.label}</span>
              </button>
            );
          })}
        </div>

        <span className={`min-w-0 flex-1 truncate text-[11px] font-mono ${t.textFaint}`} title={url}>{url}</span>

        <button onClick={refresh} title="Reload preview" className={`rounded p-1 ${t.hover} ${t.textDim} ${t.focusRing}`}>
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in a new tab"
          className={`rounded p-1 ${t.hover} ${t.textDim} ${t.focusRing}`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Stage */}
      <div className={`relative min-h-0 flex-1 overflow-auto ${t.bg} flex items-stretch justify-center`}>
        <div
          className={`relative h-full ${framed ? 'my-3 self-start rounded-xl border-2 shadow-lg overflow-hidden' : 'w-full'} ${framed ? t.edgeStrong : ''}`}
          style={framed ? { width: `${width}px`, maxWidth: '100%' } : undefined}
        >
          <iframe
            key={reloadKey}
            title="Live preview"
            src={url}
            onLoad={() => setLoaded(true)}
            className={`h-full w-full bg-white transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
          {!loaded && (
            <div className="absolute inset-0 p-3 bg-white">
              <Skeleton className="h-6 w-1/3" />
              <div className="mt-3 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
