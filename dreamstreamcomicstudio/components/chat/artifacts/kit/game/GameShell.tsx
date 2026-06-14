import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { Surface } from '../Surface';
import { useCompact } from '../density';
import { isGameKey } from './useInput';
import type { GameAudio } from './useGameAudio';

// The shared chrome every game sits in — the game-world equivalent of WidgetFrame.
// It owns the three things the brief asked for and the chat's house style can't give
// a game for free:
//
//  1. SIZE. A real Compact / Medium / Large segmented control (persisted per game)
//     that caps the playfield width, so a game is a neat glance card or a roomy board
//     on demand — distinct from the frame's compact⇄detailed density (which here just
//     picks the starting size).
//  2. FULLSCREEN. A true Fullscreen-API toggle on the shell (with a fixed-overlay
//     fallback for browsers that block it), edge-to-edge over everything. The DOM is
//     never remounted, so the run in progress survives entering/leaving fullscreen.
//  3. A RESPONSIVE PLAYFIELD. It measures its area and hands the game exact pixel
//     dimensions for the current size/fullscreen, plus a focusable surface that
//     captures arrow/WASD/space so they drive the game instead of scrolling the page.
//
// All chrome is quiet macOS glass (Surface, --ds-* tokens) — never the legacy comic
// styles, per the widget house rules.

export type GameSize = 'compact' | 'medium' | 'large';

const SIZE_CAP: Record<GameSize, number> = { compact: 300, medium: 460, large: 640 };
const SIZE_LABEL: Record<GameSize, string> = { compact: 'S', medium: 'M', large: 'L' };
const MIN_FIELD = 220;
const SIZE_STORE = 'ds.game.size.v1';

const readSize = (key: string): GameSize | null => {
  try {
    const all = JSON.parse(localStorage.getItem(SIZE_STORE) ?? '{}') as Record<string, unknown>;
    const v = all[key];
    return v === 'compact' || v === 'medium' || v === 'large' ? v : null;
  } catch {
    return null;
  }
};

const writeSize = (key: string, size: GameSize) => {
  try {
    const all = JSON.parse(localStorage.getItem(SIZE_STORE) ?? '{}') as Record<string, unknown>;
    all[key] = size;
    localStorage.setItem(SIZE_STORE, JSON.stringify(all));
  } catch {
    /* private mode — size just won't persist */
  }
};

export interface GameDims {
  width: number;
  height: number;
  fullscreen: boolean;
}

interface GameShellProps {
  /** Game title for the header. */
  title: string;
  subtitle?: string;
  /** Stable key for persisting the size preference (the game id). */
  storageKey: string;
  /** Preferred playfield aspect ratio (width / height). Defaults to square. */
  aspect?: number;
  /** Status content (score, lives…) shown on the left of the status row. */
  status?: React.ReactNode;
  /** A short controls hint, shown muted under the field. */
  hint?: React.ReactNode;
  /** Forwarded keydown for game controls (arrows/WASD/space are pre-swallowed). */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Restart handler — renders a quiet restart button in the header when given. */
  onRestart?: () => void;
  /** Audio controller — renders a mute toggle in the header when given. */
  audio?: Pick<GameAudio, 'muted' | 'setMuted'>;
  /** Render the playfield for the resolved pixel dimensions. */
  children: (dims: GameDims) => React.ReactNode;
}

export const GameShell: React.FC<GameShellProps> = ({
  title, subtitle, storageKey, aspect = 1, status, hint, onKeyDown, onRestart, audio, children
}) => {
  const frameCompact = useCompact();
  const [size, setSize] = useState<GameSize>(() => readSize(storageKey) ?? (frameCompact ? 'compact' : 'medium'));
  const [apiFs, setApiFs] = useState(false);
  const [fallbackFs, setFallbackFs] = useState(false);
  const fullscreen = apiFs || fallbackFs;

  const containerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const pickSize = (s: GameSize) => {
    setSize(s);
    writeSize(storageKey, s);
  };

  // Measure the available area; the playfield fits inside it for the current cap.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setBox({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  // Resolve the playfield pixel box: fill the area in fullscreen, else cap by size.
  // Height is only bounded by the area when fullscreen gives it a real height.
  const capW = fullscreen ? box.w : Math.min(box.w, SIZE_CAP[size]);
  let fieldW = Math.max(MIN_FIELD, Math.floor(capW || MIN_FIELD));
  let fieldH = Math.round(fieldW / aspect);
  if (fullscreen && box.h > 0 && fieldH > box.h) {
    fieldH = Math.floor(box.h);
    fieldW = Math.round(fieldH * aspect);
  }

  // Keep apiFs in sync with the browser (Esc, F11, etc. all route through here).
  useEffect(() => {
    const onChange = () => setApiFs(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Esc leaves the fixed-overlay fallback (the real API handles its own Esc).
  useEffect(() => {
    if (!fallbackFs) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFallbackFs(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [fallbackFs]);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (fullscreen) {
      if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* ignore */ } }
      setFallbackFs(false);
      return;
    }
    if (el?.requestFullscreen) {
      try { await el.requestFullscreen(); return; } catch { /* fall through to overlay */ }
    }
    setFallbackFs(true);
  }, [fullscreen]);

  // Focus the playfield so keys land immediately on enter-fullscreen.
  useEffect(() => { if (fullscreen) fieldRef.current?.focus(); }, [fullscreen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isGameKey(e.key)) e.preventDefault();
    onKeyDown?.(e);
  };

  const ctrlBtn =
    'flex h-6 w-6 items-center justify-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] text-[var(--ds-muted)] shadow-[0_1px_3px_rgba(0,0,0,0.1)] backdrop-blur-sm transition-all duration-200 hover:text-[var(--ds-ink)]';

  const inner = (
    <div className={`flex min-h-0 flex-1 flex-col ${fullscreen ? 'p-3 sm:p-4' : ''}`}>
      {/* Header: title + size control + fullscreen */}
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-[var(--ds-ink)]">{title}</h3>
          {subtitle && <p className="truncate text-[11px] text-[var(--ds-muted)]">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onRestart && (
            <button onClick={onRestart} title="New game" aria-label="New game" className={ctrlBtn}>
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
          {audio && (
            <button
              onClick={() => audio.setMuted(!audio.muted)}
              title={audio.muted ? 'Unmute' : 'Mute'}
              aria-label={audio.muted ? 'Unmute sound' : 'Mute sound'}
              aria-pressed={audio.muted}
              className={ctrlBtn}
            >
              {audio.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
            </button>
          )}
          {!fullscreen && (
            <div className="inline-flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-0.5 text-[10px] font-semibold" role="group" aria-label="Game size">
              {(['compact', 'medium', 'large'] as GameSize[]).map((s) => (
                <button
                  key={s}
                  onClick={() => pickSize(s)}
                  aria-pressed={size === s}
                  title={`${s[0].toUpperCase()}${s.slice(1)} size`}
                  className={`h-5 w-5 rounded-md transition-all duration-200 ${
                    size === s ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                  }`}
                >
                  {SIZE_LABEL[s]}
                </button>
              ))}
            </div>
          )}
          <button onClick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen (Esc)' : 'Play fullscreen'} aria-label={fullscreen ? 'Exit fullscreen' : 'Play fullscreen'} className={ctrlBtn}>
            {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Playfield area — measured; the game draws into the resolved pixel box. */}
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center px-3">
        <div
          ref={fieldRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={(e) => e.currentTarget.focus()}
          className="relative outline-none"
          style={{ width: fieldW, height: fieldH, touchAction: 'none' }}
        >
          {children({ width: fieldW, height: fieldH, fullscreen })}
        </div>
      </div>

      {/* Status + hint row */}
      <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-2">
        <div className="min-w-0 text-xs text-[var(--ds-ink)]">{status}</div>
        {hint && <div className="shrink-0 truncate text-[11px] text-[var(--ds-faint)]">{hint}</div>}
      </div>
    </div>
  );

  // Fallback fullscreen (browsers without the element Fullscreen API — notably iOS
  // Safari): portal an edge-to-edge overlay to <body>. It can't live inside Surface
  // because Surface's `backdrop-filter` would make `position: fixed` resolve against
  // the card instead of the viewport. The real API path stays in-tree so the run
  // survives entering/leaving fullscreen.
  if (fallbackFs && typeof document !== 'undefined') {
    return createPortal(
      <div className="fixed inset-0 z-[90] flex h-[100dvh] w-screen flex-col bg-[var(--ds-canvas)]">{inner}</div>,
      document.body
    );
  }

  return (
    <Surface className="flex flex-col">
      <div ref={containerRef} className={apiFs ? 'flex h-full w-full flex-col bg-[var(--ds-canvas)]' : 'flex flex-col'}>
        {inner}
      </div>
    </Surface>
  );
};
