import React, { useState } from 'react';
import { ZoomIn, ZoomOut, Maximize, Download, ExternalLink } from 'lucide-react';

export interface MediaPanelData {
  kind: 'image' | 'pdf' | 'video';
  url: string;
  title?: string;
  /** Original page URL (for "open original") when `url` is an embed/player URL. */
  sourceUrl?: string;
}

// Side-panel viewer for images (zoom/pan), PDFs (native iframe) and embeddable video.
export const MediaPanel: React.FC<{ data: MediaPanelData }> = ({ data }) => {
  const [zoom, setZoom] = useState(1);

  if (data.kind === 'pdf') {
    return (
      <div className="w-full h-full flex flex-col">
        <iframe title={data.title || 'PDF'} src={data.url} className="flex-1 w-full border-0 bg-[var(--ds-raised)]" />
      </div>
    );
  }

  if (data.kind === 'video') {
    return (
      <div className="w-full h-full flex flex-col bg-black">
        <div className="flex items-center gap-1 px-2 py-1 border-b-2 border-black bg-[var(--ds-raised)]">
          {data.title && <span className="text-[11px] font-bold text-slate-600 truncate mr-auto">{data.title}</span>}
          <a
            href={data.sourceUrl || data.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`p-1.5 border border-[var(--ds-hairline)] rounded-lg bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] transition-colors duration-200 ${data.title ? '' : 'ml-auto'}`}
            title="Open original"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
        <iframe
          title={data.title || 'Video'}
          src={data.url}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          className="flex-1 w-full border-0"
        />
      </div>
    );
  }

  // image
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-1 px-2 py-1 border-b-2 border-black bg-[var(--ds-raised)]">
        <button onClick={() => setZoom((z) => Math.min(5, z + 0.25))} className="p-1.5 border border-[var(--ds-hairline)] rounded-lg bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] transition-colors duration-200" title="Zoom in"><ZoomIn className="w-3.5 h-3.5" /></button>
        <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} className="p-1.5 border border-[var(--ds-hairline)] rounded-lg bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] transition-colors duration-200" title="Zoom out"><ZoomOut className="w-3.5 h-3.5" /></button>
        <button onClick={() => setZoom(1)} className="p-1.5 border border-[var(--ds-hairline)] rounded-lg bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] transition-colors duration-200" title="Reset"><Maximize className="w-3.5 h-3.5" /></button>
        <span className="text-[11px] font-bold text-slate-500 ml-1">{Math.round(zoom * 100)}%</span>
        <a href={data.url} target="_blank" rel="noopener noreferrer" className="ml-auto p-1.5 border border-[var(--ds-hairline)] rounded-lg bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] transition-colors duration-200" title="Open original"><ExternalLink className="w-3.5 h-3.5" /></a>
        <a href={data.url} download className="p-1.5 border border-[var(--ds-hairline)] rounded-lg bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] transition-colors duration-200" title="Download"><Download className="w-3.5 h-3.5" /></a>
      </div>
      <div className="flex-1 overflow-auto bg-slate-200 flex items-center justify-center p-2">
        <img
          src={data.url}
          alt={data.title || 'image'}
          style={{ transform: `scale(${zoom})` }}
          className="max-w-full max-h-full object-contain transition-transform origin-center"
        />
      </div>
    </div>
  );
};
