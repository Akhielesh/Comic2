import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, GripHorizontal, X } from 'lucide-react';
import { getFloatingVideo, onFloatingVideoChanged, setFloatingVideo } from '../../services/floatingVideo';
import { toVideoEmbed } from './videoEmbed';

// Always-on-top draggable mini-player (YouTube-style PiP inside the app). Mounted
// once at the studio root; it follows the user across chat/dashboards/settings.
// Pointer-event dragging on the title bar; a corner grip resizes it (persisted);
// the iframe itself stays interactive except while a resize is in flight.
const DOCK_WIDTH_STORE = 'ds.videoDock.width.v1';
const DOCK_MIN_W = 240;
const DOCK_MAX_W = 720;

const storedDockWidth = (): number => {
  try {
    const v = Number(window.localStorage.getItem(DOCK_WIDTH_STORE));
    if (Number.isFinite(v) && v >= DOCK_MIN_W && v <= DOCK_MAX_W) return v;
  } catch {
    /* private mode */
  }
  return 336;
};

export const FloatingVideoDock: React.FC = () => {
  const [video, setVideo] = useState(getFloatingVideo());
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [width, setWidth] = useState<number>(() => (typeof window === 'undefined' ? 336 : storedDockWidth()));
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resize = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => onFloatingVideoChanged(() => setVideo(getFloatingVideo())), []);
  useEffect(() => {
    if (!video) setPos(null); // re-dock to the default corner next time
  }, [video]);

  if (!video || typeof document === 'undefined') return null;
  const embed = toVideoEmbed(video.url);
  if (!embed) return null;

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
      x: Math.min(window.innerWidth - width - 8, e.clientX - drag.current.dx),
      y: Math.min(window.innerHeight - 80, e.clientY - drag.current.dy)
    });
  };
  const onPointerUp = () => { drag.current = null; };

  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resize.current = { startX: e.clientX, startW: width };
    setResizing(true);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resize.current) return;
    const maxW = Math.min(DOCK_MAX_W, window.innerWidth - 16);
    setWidth(Math.min(maxW, Math.max(DOCK_MIN_W, resize.current.startW + (e.clientX - resize.current.startX))));
  };
  const onResizeUp = () => {
    if (!resize.current) return;
    resize.current = null;
    setResizing(false);
    setWidth((w) => {
      try {
        window.localStorage.setItem(DOCK_WIDTH_STORE, String(w));
      } catch {
        /* private mode — size just doesn't persist */
      }
      return w;
    });
  };
  const resetWidth = () => {
    setWidth(336);
    try {
      window.localStorage.removeItem(DOCK_WIDTH_STORE);
    } catch {
      /* ignore */
    }
  };

  return createPortal(
    <div
      className="fixed z-[70] overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] shadow-2xl animate-scale-in"
      style={{ width, ...style }}
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
          // The iframe swallows pointer events — disable them mid-resize so the
          // corner grip keeps receiving moves.
          className={`h-full w-full ${resizing ? 'pointer-events-none' : ''}`}
          allow="accelerated-encoding; autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
      {/* Corner resize grip — drag to size the player; double-click resets. */}
      <div
        role="separator"
        aria-label="Resize mini player (drag; double-click to reset)"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={resetWidth}
        className={`absolute bottom-0 right-0 z-10 h-5 w-5 cursor-nwse-resize touch-none ${resizing ? 'opacity-100' : 'opacity-60 hover:opacity-100'}`}
        title="Drag to resize"
      >
        <svg viewBox="0 0 20 20" className="h-full w-full text-[var(--ds-muted)]" aria-hidden="true">
          <path d="M17 11v2a4 4 0 0 1-4 4h-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M17 5v2a10 10 0 0 1-10 10H5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
        </svg>
      </div>
    </div>,
    document.body
  );
};
