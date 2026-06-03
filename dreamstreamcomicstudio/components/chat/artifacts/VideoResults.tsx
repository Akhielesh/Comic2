import React from 'react';
import { PlayCircle, Video } from 'lucide-react';
import type { VideoResultsArtifact } from '../../../apiTypes';

// Responsive video grid — 1 col on phones, up to 3 on wide screens.
export const VideoResults: React.FC<{ data: VideoResultsArtifact }> = ({ data }) => {
  if (!data.results?.length) return null;
  return (
    <div className="my-2">
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500 mb-1.5">
        <Video className="w-3.5 h-3.5" /> Videos for “{data.query}”
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {data.results.map((v, i) => (
          <a
            key={`${v.url}-${i}`}
            href={v.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group border-2 border-black rounded-lg overflow-hidden bg-white shadow-comic hover:translate-y-[1px] hover:shadow-comic-hover transition-all"
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
            </div>
            <div className="p-2">
              <div className="text-[11px] font-bold leading-snug line-clamp-2">{v.title}</div>
              <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                {[v.publisher, v.views].filter(Boolean).join(' · ')}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
};
