// Overlay lettering: every line of a page drawn as a vector balloon over the clean art.
//
// Balloons are page-normalized (x, y = top-left, w = fraction of the page width; height
// follows the text). Each one is an HTML text block (selectable, crisp at any zoom, read
// by screen readers) over an SVG outline built from balloonGeometry — the same geometry
// the print view and PNG exporter use. Text is sized from the rendered page width, so a
// thumbnail and a full-screen page letter identically: on small pages the layer is laid out
// at a reading width and scaled down as a whole — a faithful miniature of the printed page
// instead of oversized text that breaks words and spills over the art.
//
// Editable mode (page editor): drag a balloon to move it, drag the round handle to aim the
// tail, drag the right-edge grip to resize, or focus it and use the arrow keys (Shift =
// bigger steps, Alt = move the tail). Every finished change calls onBalloonChange with
// `pinned: true`, so an automatic re-layout never moves it again.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Balloon, ComicDoc, Page } from '../../../shared/comic/doc';
import {
  LETTERING,
  balloonFontPx,
  balloonPaddingPx,
  balloonShape,
  clamp,
  clamp01,
  dashArray,
  estimateBalloonHeight,
  hashSeed,
  hasTail,
  letteringText,
  pageAspectOf,
  resolveBalloons,
  sfxFontPx,
  sfxStyle,
  strokePx,
  tailTipOf,
  type ResolvedBalloon
} from './balloonGeometry';
import { LINE_KIND_LABEL, castName } from './boardModel';
import { cx } from './ui';

export interface BalloonLayerProps {
  doc: ComicDoc;
  page: Page;
  /** Rendered page box size in CSS px. */
  pageWidth: number;
  pageHeight: number;
  editable?: boolean;
  onBalloonChange?: (lineId: string, patch: Partial<Balloon>) => void;
  /** Controlled selection (optional). */
  selectedLineId?: string | null;
  onSelectLine?: (lineId: string | null) => void;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
/**
 * Below its proportional size, lettering may grow by at most this much (readability on a
 * reading-size page) — the balloons' height follows the text, so a small boost still fits.
 * Beyond it (thumbnails, phones) the whole layer is scaled instead.
 */
export const LETTERING_MAX_BOOST = 1.15;
/** Page width (px) below which the lettering layer is laid out larger and scaled down. */
export const LETTERING_LAYOUT_MIN_W = LETTERING.minFontPx / (LETTERING.fontScale * LETTERING_MAX_BOOST);
const NUDGE = 0.005;
const NUDGE_BIG = 0.02;
/** Pointer travel (px) before a press becomes a drag. */
const DRAG_SLOP = 3;

type DragMode = 'move' | 'tail' | 'width';

interface BalloonItemProps {
  item: ResolvedBalloon;
  doc: ComicDoc;
  pageW: number;
  pageH: number;
  aspect: number;
  /** Rendered size / layout size (< 1 when the layer is scaled down). */
  scale: number;
  editable: boolean;
  selected: boolean;
  onSelect: (lineId: string | null) => void;
  onChange?: (lineId: string, patch: Partial<Balloon>) => void;
}

const BalloonItem: React.FC<BalloonItemProps> = ({ item, doc, pageW, pageH, aspect, scale, editable, selected, onSelect, onChange }) => {
  const { line } = item;
  const kind = line.kind;
  const [draft, setDraft] = useState<Partial<Balloon> | null>(null);
  const b: Balloon = draft ? { ...item.balloon, ...draft } : item.balloon;
  const text = letteringText(line.text, doc.format.language);
  const widthPx = Math.max(1, b.w * pageW);
  const fontPx = kind === 'sfx' ? sfxFontPx(text, widthPx, pageW) : balloonFontPx(pageW, kind);
  const pad = balloonPaddingPx(pageW);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);

  // Height follows the text: measure it (fonts can load late — keep observing).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) setMeasured((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, widthPx, fontPx]);

  const heightPx = measured || Math.max(fontPx * LETTERING.lineHeight, estimateBalloonHeight(line.text, b.w, aspect) * pageH);
  const heightFrac = pageH > 0 ? heightPx / pageH : 0;
  const tip = tailTipOf(b, kind, heightFrac);
  const tipLocal = tip ? { x: (tip.tailX - b.x) * pageW, y: (tip.tailY - b.y) * pageH } : null;
  const shape = useMemo(
    () => balloonShape(kind, widthPx, heightPx, { tip: tipLocal, seed: hashSeed(line.id), inset: pad }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, widthPx, heightPx, tipLocal?.x, tipLocal?.y, line.id, pad.x, pad.y]
  );
  const stroke = strokePx(pageW);
  const dash = shape.dashed ? dashArray(stroke) : undefined;

  // ── Drag ──────────────────────────────────────────────────────────────────
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const startDrag = (e: React.PointerEvent, mode: DragMode) => {
    if (!editable || !onChange) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(line.id);
    cleanup.current?.();
    const origin = { x: e.clientX, y: e.clientY };
    const start = { ...b, ...(tip ? tip : {}) };
    let moved = false;
    let latest: Partial<Balloon> | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_SLOP) return;
      moved = true;
      // Pointer travel is in screen px; the layout may be scaled down.
      const dx = (ev.clientX - origin.x) / (pageW * scale || 1);
      const dy = (ev.clientY - origin.y) / (pageH * scale || 1);
      if (mode === 'move') latest = { x: r4(clamp(start.x + dx, 0, 1 - start.w)), y: r4(clamp(start.y + dy, 0, Math.max(0, 1 - heightFrac))) };
      else if (mode === 'tail') latest = { tailX: r4(clamp01((start.tailX ?? start.x) + dx)), tailY: r4(clamp01((start.tailY ?? start.y) + dy)) };
      else latest = { w: r4(clamp(start.w + dx, 0.06, 1 - start.x)) };
      setDraft(latest);
    };
    const up = () => {
      cleanup.current?.();
      setDraft(null);
      if (moved && latest) onChange(line.id, { ...latest, pinned: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cleanup.current = null;
    };
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editable || !onChange) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onSelect(null);
      (e.currentTarget as HTMLElement).blur();
      return;
    }
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dir[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? NUDGE_BIG : NUDGE;
    if (e.altKey && tip) {
      onChange(line.id, { tailX: r4(clamp01(tip.tailX + d[0] * step)), tailY: r4(clamp01(tip.tailY + d[1] * step)), pinned: true });
    } else {
      onChange(line.id, {
        x: r4(clamp(b.x + d[0] * step, 0, 1 - b.w)),
        y: r4(clamp(b.y + d[1] * step, 0, Math.max(0, 1 - heightFrac))),
        pinned: true
      });
    }
  };

  const speaker = line.speakerId ? castName(doc, line.speakerId) : '';
  const label = `${LINE_KIND_LABEL[kind]}${speaker ? ` — ${speaker}` : ''}: ${line.text}`;
  const sfx = kind === 'sfx' ? sfxStyle(line.id) : null;

  const bodyStyle: React.CSSProperties =
    kind === 'sfx'
      ? {
          fontSize: fontPx,
          lineHeight: 1,
          color: sfx!.color,
          transform: `rotate(${sfx!.rotate}deg)`,
          WebkitTextStroke: `${Math.max(1, fontPx * 0.06)}px ${LETTERING.ink}`,
          paintOrder: 'stroke fill',
          textShadow: `${Math.max(1, fontPx * 0.05)}px ${Math.max(1, fontPx * 0.05)}px 0 ${LETTERING.ink}`,
          letterSpacing: '0.02em'
        }
      : ({
          fontSize: fontPx,
          lineHeight: LETTERING.lineHeight,
          padding: `${pad.y}px ${pad.x}px`,
          color: LETTERING.ink,
          textWrap: 'balance',
          fontStyle: kind === 'whisper' ? 'italic' : undefined
        } as React.CSSProperties);

  return (
    <div
      data-testid="balloon"
      data-line-id={line.id}
      data-kind={kind}
      data-fallback={item.fallback || undefined}
      className={cx(
        'absolute select-none',
        editable ? 'pointer-events-auto cursor-move touch-none rounded-[40%] focus:outline-none' : 'pointer-events-none',
        editable && selected && 'outline-dashed outline-2 outline-offset-4 outline-[#D97757]',
        editable && 'focus-visible:outline-dashed focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#D97757]'
      )}
      style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, zIndex: selected ? 5 : 1 }}
      {...(editable
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-roledescription': 'movable balloon',
            'aria-label': `${label}. Drag or use the arrow keys to move${hasTail(kind) ? '; Alt+arrows move the tail' : ''}.`,
            'aria-pressed': selected,
            onPointerDown: (e: React.PointerEvent) => startDrag(e, 'move'),
            onKeyDown,
            onFocus: () => onSelect(line.id)
          }
        : {})}
    >
      {kind !== 'sfx' && (
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={widthPx} height={heightPx} aria-hidden focusable="false">
          {shape.tail && <path d={shape.tail} fill={shape.fill} stroke={shape.stroke} strokeWidth={stroke * 2} strokeLinejoin="round" strokeDasharray={dash} />}
          {shape.bubbles.map((c, i) => (
            <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill={shape.fill} stroke={shape.stroke} strokeWidth={stroke} />
          ))}
          {shape.body && <path d={shape.body} fill={shape.fill} stroke={shape.stroke} strokeWidth={stroke} strokeLinejoin="round" strokeDasharray={dash} />}
          {shape.tail && <path d={shape.tail} fill={shape.fill} stroke="none" />}
        </svg>
      )}
      <div
        ref={bodyRef}
        className={cx(
          'relative break-words text-center',
          kind === 'sfx' ? 'font-display tracking-wide' : 'font-comic font-bold'
        )}
        style={bodyStyle}
      >
        {text}
      </div>
      {editable && selected && tipLocal && (
        <span
          role="presentation"
          data-testid="tail-handle"
          onPointerDown={(e) => startDrag(e, 'tail')}
          className="absolute z-[6] -translate-x-1/2 -translate-y-1/2 cursor-crosshair touch-none rounded-full border-2 border-white bg-[var(--ds-accent)] shadow"
          style={{ left: tipLocal.x, top: tipLocal.y, width: 14 / scale, height: 14 / scale }}
          title="Drag to aim the tail"
        />
      )}
      {editable && selected && (
        <span
          role="presentation"
          data-testid="width-handle"
          onPointerDown={(e) => startDrag(e, 'width')}
          className="absolute top-1/2 z-[6] -translate-y-1/2 cursor-ew-resize touch-none rounded-full border border-white bg-[var(--ds-accent)] shadow"
          style={{ right: -8 / scale, width: 8 / scale, height: 24 / scale }}
          title="Drag to resize"
        />
      )}
    </div>
  );
};

/** All balloons of a page over its art (overlay lettering). */
export const BalloonLayer: React.FC<BalloonLayerProps> = ({
  doc,
  page,
  pageWidth,
  pageHeight,
  editable = false,
  onBalloonChange,
  selectedLineId,
  onSelectLine
}) => {
  const items = useMemo(() => resolveBalloons(doc, page), [doc, page]);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selected = selectedLineId !== undefined ? selectedLineId : localSelected;
  const select = (id: string | null) => {
    setLocalSelected(id);
    onSelectLine?.(id);
  };
  const aspect = pageAspectOf(doc, page);
  if (!items.length || pageWidth <= 0) return null;
  // Small pages (thumbnails, phones) are lettered at the proportional size and scaled down,
  // so the miniature matches the full page, the print and the export exactly.
  const scale = pageWidth < LETTERING_LAYOUT_MIN_W ? pageWidth / LETTERING_LAYOUT_MIN_W : 1;
  const layoutW = pageWidth / scale;
  const layoutH = (pageHeight || pageWidth / aspect) / scale;
  return (
    <div
      className={cx('absolute inset-0 z-[2]', editable ? '' : 'pointer-events-none')}
      style={{ ['--page-w' as string]: `${pageWidth}px` } as React.CSSProperties}
      role="group"
      aria-label={`Lettering for page ${page.n}`}
      onPointerDown={editable ? (e) => {
        if (e.target === e.currentTarget) select(null);
      } : undefined}
    >
      <div
        className="pointer-events-none absolute left-0 top-0"
        style={
          scale === 1
            ? { width: '100%', height: '100%' }
            : { width: layoutW, height: layoutH, transform: `scale(${scale})`, transformOrigin: '0 0' }
        }
      >
        {items.map((item) => (
          <BalloonItem
            key={item.line.id}
            item={item}
            doc={doc}
            pageW={layoutW}
            pageH={layoutH}
            aspect={aspect}
            scale={scale}
            editable={editable}
            selected={selected === item.line.id}
            onSelect={select}
            onChange={onBalloonChange}
          />
        ))}
      </div>
    </div>
  );
};
