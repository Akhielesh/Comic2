import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, GripHorizontal, X } from 'lucide-react';
import { getFloatingVideo, onFloatingVideoChanged, setFloatingVideo } from '../../services/floatingVideo';
import { toVideoEmbed } from './videoEmbed';

// Always-on-top draggable mini-player (YouTube-style PiP inside the app). Mounted
// once at the studio root; it follows the user across chat/dashboards/settings.
// Pointer-event dragging on the title bar; the iframe itself stays interactive.
export const FloatingVideoDock: React.FC = () => {
  const [video, setVideo] = useState(getFloatingVideo());
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => onFloatingVideoChanged(() => setVideo(getFloatingVideo())), []);
  useEffect(() => {
    if (!video) setPos(null); // re-dock to the default corner next time
  }, [video]);

  if (!video || typeof document === 'undefined') return null;
  const embed = toVideoEmbed(video.url);
  if (!embed) return null;

  const W = 336;
  const style: React.CSSProperties = pos
    ? { left: Math.max(8, pos.x), top: Math.max(8, pos.y), right: 'auto', bottom: 'auto' }
    : { right: 16, bottom: 16 };

  const onPointerDown = (e: React.PointerEvent) => {
    const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = { dx: e.clientX - host.left, dy: e.clientY - host.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos({
      x: Math.min(window.innerWidth - W - 8, e.clientX - drag.current.dx),
      y: Math.min(window.innerHeight - 80, e.clientY - drag.current.dy)
    });
  };
  const onPointerUp = () => { drag.current = null; };

  return createPortal(
    <div
      className="fixed z-[70] overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] shadow-2xl animate-scale-in"
      style={{ width: W, ...style }}
      role="complementary"
      aria-label={`Mini player: ${video.title}`}
    >
      <div
        className="flex cursor-grab items-center gap-1.5 border-b border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)] px-2 py-1 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to move"
      >
        <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--ds-ink)]">{video.title}</span>
        <a
          href={video.url}
          target="_blank"
          rel="noopener noreferrer"
          onPointerDown={(e) => e.stopPropagation()}
          className="rounded p-1 text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)]"
          title="Open original"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setFloatingVideo(null)}
          className="rounded p-1 text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)]"
          title="Close mini player"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="aspect-video bg-black">
        <iframe
          src={embed.embedUrl}
          title={video.title}
          className="h-full w-full"
          allow="accelerated-encoding; autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    </div>,
    document.body
  );
};
