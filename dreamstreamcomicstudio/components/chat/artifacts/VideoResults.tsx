import React from 'react';
import { PlayCircle, Video, ExternalLink } from 'lucide-react';
import type { VideoResultsArtifact, VideoResult } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';
import { useChatPanel } from '../panelContext';
import { toVideoEmbed } from '../videoEmbed';

// Video results in two densities:
//  • compact — a 2-up row of small thumbnails: the glance version.
//  • detailed — the responsive grid (1 col on phones, up to 3 wide). Clicking a
//    playable video (YouTube/Vimeo) opens it inline in the side panel; everything
//    else opens the original in a new tab. A small ↗ always opens the original.
export const VideoResults: React.FC<{ data: VideoResultsArtifact }> = ({ data }) => {
  const compact = useCompact();
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

  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Video className="h-4 w-4 shrink-0 text-[#6e6a60]" />
      <SurfaceTitle>Videos · “{data.query}”</SurfaceTitle>
    </span>
  );

  // ── Compact: a 2-up row of small thumbnails. ────────────────────────────────
  if (compact) {
    return (
      <Surface header={header} right={<SurfaceSubtitle>{data.results.length} videos</SurfaceSubtitle>}>
        <div className="grid grid-cols-2 gap-2 px-3 pb-3 pt-1">
          {data.results.slice(0, 2).map((v, i) => (
            <button
              key={`${v.url}-${i}`}
              onClick={() => play(v)}
              className="group min-w-0 text-left"
              title={v.title}
            >
              <div className="relative aspect-video overflow-hidden rounded-lg bg-black/[0.06] ring-1 ring-black/5">
                {v.thumbnail ? (
                  <img src={v.thumbnail} alt={v.title} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[#6e6a60]/50"><Video className="h-5 w-5" /></div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-200 group-hover:bg-black/20">
                  <PlayCircle className="h-7 w-7 text-white opacity-90 drop-shadow" />
                </div>
                {v.duration && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-semibold text-white">{v.duration}</span>
                )}
              </div>
              <div className="mt-1 truncate text-[11px] font-medium text-[#1a1915]">{v.title}</div>
            </button>
          ))}
        </div>
      </Surface>
    );
  }

  // ── Detailed: the full grid. ────────────────────────────────────────────────
  return (
    <Surface header={header} right={<SurfaceSubtitle>{data.results.length} videos</SurfaceSubtitle>}>
      <div className="grid grid-cols-1 gap-2 px-3 pb-3 pt-1 sm:grid-cols-2 lg:grid-cols-3">
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
              className="group min-w-0 cursor-pointer overflow-hidden rounded-xl border border-black/10 bg-white transition-colors duration-200 hover:bg-black/[0.02]"
            >
              <div className="relative aspect-video bg-black/[0.06]">
                {v.thumbnail ? (
                  <img src={v.thumbnail} alt={v.title} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[#6e6a60]/50"><Video className="h-6 w-6" /></div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-200 group-hover:bg-black/20">
                  <PlayCircle className="h-9 w-9 text-white opacity-90 drop-shadow transition-transform duration-200 group-hover:scale-110" />
                </div>
                {v.duration && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{v.duration}</span>
                )}
                {playable && (
                  <span className="absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">Play here</span>
                )}
                <a
                  href={v.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-1 top-1 rounded-lg bg-black/60 p-1 text-white opacity-0 transition-opacity duration-200 hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
                  title="Open original"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div className="p-2">
                <div className="text-[11px] font-medium leading-snug text-[#1a1915] line-clamp-2">{v.title}</div>
                <div className="mt-0.5 truncate text-[10px] text-[#6e6a60]">
                  {[v.publisher, v.views].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Surface>
  );
};
