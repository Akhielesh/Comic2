// Vertical reader (reader.md §4.1): webtoons — and any comic when the reader picks Scroll — as one
// smooth column. Pages decode through the shared cache only as they approach the viewport; offscreen
// pages skip layout and paint (content-visibility) with their real aspect reserved, so long comics
// stay cheap. The HUD hides on scroll down and returns on scroll up; Guided View scrolls each panel's
// centre into view. The End card closes the column.

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { ReaderItem } from '../reader/readerModel';
import type { GuidedStop } from './guidedModel';
import { letterbox } from './readerLayout';
import { SlotContentView, type SlotImage } from './ReaderSlot';

export interface WebtoonStageHandle {
  /** Scroll by a fraction of the viewport (keys). */
  scrollByViewport(amount: number): void;
  toTop(): void;
  toBottom(): void;
  /** Bring an item (and optionally a panel box) into view. */
  scrollToItem(itemIndex: number, box?: { y: number; h: number }): void;
}

export interface WebtoonStageProps {
  doc: ComicDoc;
  items: ReaderItem[];
  size: { w: number; h: number };
  aspectOf(itemIndex: number): number;
  trim: number;
  img: Omit<SlotImage, 'original'>;
  paper: boolean;
  reduced: boolean;
  /** Gapless for webtoons, a gutter between pages otherwise. */
  gapless: boolean;
  endCard: React.ReactNode;
  guided: { on: boolean; itemIndex: number; stop?: GuidedStop };
  onScrollDirection(dir: 'up' | 'down'): void;
  onVisibleItem(itemIndex: number): void;
  onProgress(fraction: number): void;
  onTapCenter(): void;
  onImageError?(): void;
  onExpired?(): void;
}

const WebtoonPage: React.FC<{
  doc: ComicDoc;
  items: ReaderItem[];
  index: number;
  width: number;
  aspect: number;
  near: boolean;
  img: SlotImage;
  paper: boolean;
  onImageError?(): void;
  onExpired?(): void;
  setRef(el: HTMLDivElement | null): void;
}> = ({ doc, items, index, width, aspect, near, img, paper, onImageError, onExpired, setRef }) => {
  const height = width / aspect;
  const box = letterbox(width, height, aspect);
  return (
    <div
      ref={setRef}
      data-item={index}
      data-testid="webtoon-page"
      role="group"
      aria-roledescription="page"
      aria-label={items[index]?.label}
      className="relative mx-auto w-full"
      style={{ width, height, contentVisibility: 'auto', containIntrinsicSize: `${Math.round(width)}px ${Math.round(height)}px` }}
    >
      {near ? (
        <SlotContentView
          doc={doc}
          content={{ kind: 'item', index }}
          items={items}
          width={box.w}
          height={box.h}
          contentAspect={aspect}
          img={img}
          prio="next"
          paper={paper}
          letteringAriaHidden
          onImageError={onImageError}
          onExpired={onExpired}
        />
      ) : (
        <div className="absolute inset-0 bg-white/5" aria-hidden />
      )}
    </div>
  );
};

export const WebtoonStage = forwardRef<WebtoonStageHandle, WebtoonStageProps>(function WebtoonStage(props, ref) {
  const { doc, items, size, aspectOf, img, paper, reduced, gapless, endCard, guided } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set([0, 1, 2]));
  const lastTop = useRef(0);
  const width = Math.min(size.w, 800);
  const imgFull = useMemo<SlotImage>(() => ({ ...img, original: false }), [img]);

  // Lazy decode window: pages within 1.5 viewports. Pages that leave it drop their image (the box keeps
  // its size), so a long webtoon holds only a screenful or two of decoded pages; they reload from the
  // HTTP cache as they come back.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      setNear(new Set(items.map((_, i) => i)));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        setNear((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.item);
            if (!Number.isFinite(i)) continue;
            if (e.isIntersecting && !next.has(i)) {
              next.add(i);
              changed = true;
            } else if (!e.isIntersecting && next.has(i)) {
              next.delete(i);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root, rootMargin: '150% 0px' }
    );
    for (const el of pageEls.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [items]);

  const scrollTo = useCallback(
    (top: number) => {
      const el = scroller.current;
      if (!el) return;
      if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
      else el.scrollTop = top;
    },
    [reduced]
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollByViewport(amount) {
        const el = scroller.current;
        if (el) scrollTo(el.scrollTop + amount * el.clientHeight);
      },
      toTop() {
        scrollTo(0);
      },
      toBottom() {
        const el = scroller.current;
        if (el) scrollTo(el.scrollHeight);
      },
      scrollToItem(itemIndex, box) {
        const el = scroller.current;
        const page = pageEls.current.get(itemIndex);
        if (!el || !page) return;
        const h = page.offsetHeight;
        const top = box ? page.offsetTop + (box.y + box.h / 2) * h - el.clientHeight / 2 : page.offsetTop;
        scrollTo(Math.max(0, top));
      }
    }),
    [scrollTo]
  );

  // Guided View in a column: centre the current panel.
  useEffect(() => {
    if (!guided.on) return;
    const el = scroller.current;
    const page = pageEls.current.get(guided.itemIndex);
    if (!el || !page) return;
    const box = guided.stop && guided.stop.panelIndex >= 0 ? guided.stop.box : undefined;
    const h = page.offsetHeight;
    const top = box ? page.offsetTop + (box.y + box.h / 2) * h - el.clientHeight / 2 : page.offsetTop;
    scrollTo(Math.max(0, top));
  }, [guided.on, guided.itemIndex, guided.stop, scrollTo]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const delta = top - lastTop.current;
    if (Math.abs(delta) > 24) {
      props.onScrollDirection(delta > 0 ? 'down' : 'up');
      lastTop.current = top;
    }
    const max = el.scrollHeight - el.clientHeight;
    props.onProgress(max > 0 ? Math.min(1, Math.max(0, top / max)) : 1);
    // The page under the viewport's upper third is "current" (counter, resume, transcript).
    const probe = top + el.clientHeight / 3;
    let current = 0;
    for (const [i, p] of pageEls.current) if (p.offsetTop <= probe) current = Math.max(current, i);
    props.onVisibleItem(current);
  };

  return (
    <div
      ref={scroller}
      data-testid="webtoon-stage"
      className="absolute inset-0 overflow-y-auto overflow-x-hidden"
      style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
      onScroll={onScroll}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest?.('button, a, input, select, textarea')) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const f = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
        if (f > 0.3 && f < 0.7) props.onTapCenter();
      }}
    >
      <div className={gapless ? 'flex flex-col items-center' : 'flex flex-col items-center gap-6 py-6'} style={{ paddingTop: 'calc(var(--sa-top) + 8px)' }}>
        {items.map((item, i) => (
          <WebtoonPage
            key={item.key}
            doc={doc}
            items={items}
            index={i}
            width={width}
            aspect={aspectOf(i) || props.trim}
            near={near.has(i) || near.has(i - 1) || near.has(i + 1)}
            img={imgFull}
            paper={paper}
            onImageError={props.onImageError}
            onExpired={props.onExpired}
            setRef={(el) => {
              if (el) pageEls.current.set(i, el);
              else pageEls.current.delete(i);
            }}
          />
        ))}
        <div className="relative w-full" style={{ width, minHeight: Math.min(size.h, 640), paddingBottom: 'var(--sa-bottom)' }}>
          <div className="relative h-full min-h-[inherit] bg-[var(--ds-reader-paper-back)]" style={{ minHeight: Math.min(size.h, 640) }}>
            {endCard}
          </div>
        </div>
      </div>
    </div>
  );
});

export default WebtoonStage;
