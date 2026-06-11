import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PlayCircle, Video, ExternalLink, X } from 'lucide-react';
import type { VideoResultsArtifact, VideoResult } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';
import { toVideoEmbed, toVideoPreview } from '../videoEmbed';

// Video results in two densities:
//  • compact — a 2-up row of small thumbnails.
//  • detailed — the responsive grid (1 col on phones, up to 3 wide).
//
// Interaction (replaces the old "open in the side panel" behaviour, which hijacked the
// whole layout and blocked the rest of the chat):
//  • HOVER a playable video for ~1.2s → a silent, looping preview plays in-place.
//  • CLICK → a dismissible in-app lightbox plays it full-size with sound, over a scrim.
//    Escape or a backdrop click closes it; nothing about the chat layout is taken over.
//  • The ↗ always opens the original; non-embeddable results open in a new tab.

// ── In-app lightbox player — a focused overlay, not a persistent panel ─────────
const VideoLightbox: React.FC<{ video: VideoResult; onClose: () => void }> = ({ video, onClose }) => {
  const embed = toVideoEmbed(video.url);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Lock background scroll while the lightbox is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Portal to <body> so the overlay escapes any transformed/overflow-clipped ancestor
  // (e.g. a card inside the gallery modal) and is always a true full-viewport lightbox.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={video.title}
    >
      <div
        className="relative w-full max-w-4xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-semibold text-white">{video.title}</p>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={video.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open original"
              className="rounded-lg p-1.5 text-white/80 transition-colors duration-200 hover:bg-white/15 hover:text-white"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="rounded-lg p-1.5 text-white/80 transition-colors duration-200 hover:bg-white/15 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/10">
          {embed ? (
            <iframe
              src={embed.embedUrl}
              title={video.title}
              className="h-full w-full"
              allow="accelerated-encoding; autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/80">
              <Video className="h-8 w-8" />
              <a href={video.url} target="_blank" rel="noopener noreferrer" className="text-sm underline">
                Open this video
              </a>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

// ── One thumbnail with a delayed silent hover-preview ─────────────────────────
const VideoThumb: React.FC<{
  video: VideoResult;
  size: 'sm' | 'lg';
  onPlay: () => void;
}> = ({ video, size, onPlay }) => {
  const preview = toVideoPreview(video.url);
  const playable = Boolean(preview);
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startHover = useCallback(() => {
    if (!playable) return;
    // Only kick in once the cursor has rested ~1.2s, so a passing mouse doesn't
    // fire a wall of iframes.
    timer.current = setTimeout(() => setPreviewing(true), 1200);
  }, [playable]);
  const endHover = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPreviewing(false);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const playIconSize = size === 'lg' ? 'h-9 w-9' : 'h-7 w-7';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay();
        }
      }}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      className="group block w-full cursor-pointer text-left"
      title={video.title}
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-[var(--ds-well-strong)] ring-1 ring-[var(--ds-hairline-soft)]">
        {video.thumbnail ? (
          <img src={video.thumbnail} alt={video.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[var(--ds-muted)] opacity-60">
            <Video className={size === 'lg' ? 'h-6 w-6' : 'h-5 w-5'} />
          </div>
        )}

        {/* Silent looping preview, faded in once the hover dwell completes. */}
        {previewing && preview && (
          <iframe
            src={preview.embedUrl}
            title={`${video.title} preview`}
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full animate-fade-in"
            allow="autoplay; encrypted-media"
          />
        )}

        {/* Play affordance + hover scrim (hidden while previewing). */}
        {!previewing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-200 group-hover:bg-black/20">
            <PlayCircle className={`${playIconSize} text-white opacity-90 drop-shadow transition-transform duration-200 group-hover:scale-110`} />
          </div>
        )}

        {video.duration && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{video.duration}</span>
        )}
        {playable && !previewing && (
          <span className="absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">
            Play here
          </span>
        )}
        <a
          href={video.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1 top-1 rounded-lg bg-black/60 p-1 text-white opacity-0 transition-opacity duration-200 hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
          title="Open original"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
};

export const VideoResults: React.FC<{ data: VideoResultsArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [lightbox, setLightbox] = useState<VideoResult | null>(null);

  const open = (v: VideoResult) => {
    // Embeddable → in-app lightbox; everything else opens the original.
    if (toVideoEmbed(v.url)) setLightbox(v);
    else window.open(v.url, '_blank', 'noopener,noreferrer');
  };

  if (!data.results?.length) return null;

  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Video className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
      <SurfaceTitle>Videos · “{data.query}”</SurfaceTitle>
    </span>
  );

  const lightboxEl = lightbox && <VideoLightbox video={lightbox} onClose={() => setLightbox(null)} />;

  // ── Compact: a 2-up row of small thumbnails. ────────────────────────────────
  if (compact) {
    return (
      <Surface header={header} right={<SurfaceSubtitle>{data.results.length} videos</SurfaceSubtitle>}>
        <div className="grid grid-cols-2 gap-2 px-3 pb-3 pt-1">
          {data.results.slice(0, 2).map((v, i) => (
            <div key={`${v.url}-${i}`} className="min-w-0">
              <VideoThumb video={v} size="sm" onPlay={() => open(v)} />
              <div className="mt-1 truncate text-[11px] font-medium text-[var(--ds-ink)]">{v.title}</div>
            </div>
          ))}
        </div>
        {lightboxEl}
      </Surface>
    );
  }

  // ── Detailed: the full grid. ────────────────────────────────────────────────
  return (
    <Surface header={header} right={<SurfaceSubtitle>{data.results.length} videos</SurfaceSubtitle>}>
      <div className="grid grid-cols-1 gap-2 px-3 pb-3 pt-1 sm:grid-cols-2 lg:grid-cols-3">
        {data.results.map((v, i) => (
          <div key={`${v.url}-${i}`} className="min-w-0 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] transition-colors duration-200 hover:bg-[var(--ds-hover)]">
            <VideoThumb video={v} size="lg" onPlay={() => open(v)} />
            <div className="p-2">
              <div className="text-[11px] font-medium leading-snug text-[var(--ds-ink)] line-clamp-2">{v.title}</div>
              <div className="mt-0.5 truncate text-[10px] text-[var(--ds-muted)]">
                {[v.publisher, v.views].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        ))}
      </div>
      {lightboxEl}
    </Surface>
  );
};
