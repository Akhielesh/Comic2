import React from 'react';
import { PlayCircle, Video, ExternalLink } from 'lucide-react';
import type { VideoResultsArtifact, VideoResult } from '../../../apiTypes';
import { useChatPanel } from '../panelContext';
import { toVideoEmbed } from '../videoEmbed';

// Responsive video grid — 1 col on phones, up to 3 on wide screens. Clicking a
// playable video (YouTube/Vimeo) opens it inline in the side panel; everything
// else opens the original in a new tab. A small ↗ always opens the original.
export const VideoResults: React.FC<{ data: VideoResultsArtifact }> = ({ data }) => {
  const openPanel = useChatPanel();

  const play = (v: VideoResult) => {
    const embed = toVideoEmbed(v.url);
    if (embed && openPanel) {
      openPanel({ type: 'media', data: { kind: 'video', url: embed.embedUrl, title: v.title, sourceUrl: v.url } });
    } else {
      window.open(v.url, '_blank', 'noopener,noreferrer');
    }
  };

  if (!data.results?.length) return null;
  return (
    <div className="my-2">
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500 mb-1.5">
        <Video className="w-3.5 h-3.5" /> Videos for “{data.query}”
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {data.results.map((v, i) => {
          const playable = Boolean(toVideoEmbed(v.url));
          return (
            <div
              key={`${v.url}-${i}`}
              role="button"
              tabIndex={0}
              onClick={() => play(v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  play(v);
                }
              }}
              className="group relative border-2 border-black rounded-lg overflow-hidden bg-white shadow-comic hover:translate-y-[1px] hover:shadow-comic-hover transition-all cursor-pointer"
            >
              <div className="relative aspect-video bg-slate-200">
                {v.thumbnail ? (
                  <img src={v.thumbnail} alt={v.title} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-400"><Video className="w-6 h-6" /></div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
                  <PlayCircle className="w-9 h-9 text-white drop-shadow opacity-90 group-hover:scale-110 transition-transform" />
                </div>
                {v.duration && (
                  <span className="absolute bottom-1 right-1 text-[10px] font-bold bg-black/80 text-white px-1.5 py-0.5 rounded">{v.duration}</span>
                )}
                {playable && (
                  <span className="absolute top-1 left-1 text-[9px] font-extrabold uppercase tracking-wide bg-red-600 text-white px-1.5 py-0.5 rounded">Play here</span>
                )}
                <a
                  href={v.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white hover-reveal hover:bg-black/80"
                  title="Open original"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="p-2">
                <div className="text-[11px] font-bold leading-snug line-clamp-2">{v.title}</div>
                <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                  {[v.publisher, v.views].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
