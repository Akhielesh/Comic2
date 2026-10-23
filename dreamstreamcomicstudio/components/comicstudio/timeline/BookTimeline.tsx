// The book timeline (contract §13.3; timeline.md §4.2): a video-editor style filmstrip of the whole
// book — cover first, the software pages, every page as a clip — that you reorder by dragging
// (long-press on touch so scrolling never turns into a move), open with a tap, and edit through a
// clip menu or the keyboard. Every edit here is FREE and optimistic, answered by an undo toast.
//
// Dock: a 36 px summary bar ("Book · Cover ✓ · 2/3 pages drawn · 7 versions · $0.55 spent") that
// expands to the strip; collapsed by default below `lg` (phones/tablets keep their board space),
// remembered per device; hidden in the Read tab. `compact` is the 64 px strip for the page editor.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronUp, Images } from 'lucide-react';
import { newId, renderTargetKey, type RenderTarget } from '../../../shared/comic/doc';
import { PLAN_USD_PER_PAGE, PLATFORM_MARKUP } from '../../../shared/comic/models';
import { useCostFormat } from '../conversation/cost';
import { isPhoneLayout } from '../mobile/formFactor';
import { DOC_LIMITS } from '../../../shared/comic/limits';
import type { StudioController } from '../types';
import { useFormFactor } from '../mobile/useFormFactor';
import { byokFromDoc } from '../board/boardModel';
import {
  bookClips,
  canAddPage,
  deleteOps,
  dockSummary,
  duplicateOps,
  ghostPlates,
  hasMedia,
  insertOps,
  moveOps,
  plateOffPatch,
  redrawPrice,
  sortedPages,
  type ClipVM,
  type GhostPlate
} from './bookModel';
import { ClipMenu, clipMenuItems, type ClipAction } from './ClipMenu';
import { PlateEditor } from './PlateView';
import { PLATE_LABEL, type PlateKind } from './plates';
import { AddClip, TimelineClip } from './TimelineClip';
import { UndoToast, useTimelineEdit } from './UndoToast';
import { VersionStack } from './VersionStack';
import { cx, FOCUS_RING, TimelineDialog, useReducedMotion, useStoredFlag } from './ui';

export interface BookTimelineProps {
  studio: StudioController;
  compact?: boolean;
  /** 'longpress' on touch (reorder must not fight scrolling). Default: longpress on coarse pointers. */
  reorderActivation?: 'longpress' | 'immediate';
}

/** localStorage: is the dock expanded on this device ('1' / '0'). */
export const DOCK_OPEN_KEY = 'comicstudio.timeline.dock';
/** Below this width the dock starts collapsed (critic G9: phones/tablets keep their board space). */
export const DOCK_OPEN_MIN_WIDTH = 1024;
export const LONG_PRESS_MS = 350;
const CLIP_GAP = 4;

type Item =
  | { kind: 'clip'; key: string; clip: ClipVM }
  | { kind: 'add'; key: 'add' }
  | { kind: 'ghost'; key: string; ghost: GhostPlate };

type Dialog = { kind: 'versions'; target: RenderTarget; title: string; compare?: boolean } | { kind: 'plate'; plate: PlateKind };

interface DragState {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  startScroll: number;
  longPress: boolean;
  active: boolean;
  moved: boolean;
  fromIdx: number;
  overIdx: number;
  slots: { key: string; left: number; width: number }[];
  timer?: ReturnType<typeof setTimeout>;
  el: HTMLElement;
}

interface DragView {
  key: string;
  dx: number;
  fromIdx: number;
  overIdx: number;
  width: number;
}

/** Page-clip translateX while another clip is being dragged over it. */
export const dragShift = (j: number, from: number, over: number, width: number): number => {
  if (j === from) return 0;
  if (from < over && j > from && j <= over) return -(width + CLIP_GAP);
  if (over < from && j >= over && j < from) return width + CLIP_GAP;
  return 0;
};

/** Index the dragged clip lands on: how many other page clips' centres lie left of its centre. */
export const dropIndex = (slots: { left: number; width: number }[], from: number, dx: number): number => {
  const f = slots[from];
  if (!f) return from;
  const centre = f.left + f.width / 2 + dx;
  let over = 0;
  slots.forEach((s, j) => {
    if (j !== from && s.left + s.width / 2 < centre) over += 1;
  });
  return over;
};

export const BookTimeline: React.FC<BookTimelineProps> = ({ studio, compact = false, reorderActivation }) => {
  const ff = useFormFactor();
  const reduceMotion = useReducedMotion() || ff.reducedMotion;
  const activation = reorderActivation ?? (ff.coarse ? 'longpress' : 'immediate');
  const [open, setOpen] = useStoredFlag(DOCK_OPEN_KEY, ff.width >= DOCK_OPEN_MIN_WIDTH);
  const doc = studio.doc;
  const edit = useTimelineEdit(studio);
  // Prices in the viewer's terms: governed users read a share of their usage, never dollars.
  const cost = useCostFormat(studio);
  const phoneLayout = isPhoneLayout(ff.layout);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; rect: DOMRect | null } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState('');
  const [drag, setDrag] = useState<DragView | null>(null);
  const itemEls = useRef(new Map<string, HTMLDivElement>());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const listeners = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel: () => void } | null>(null);
  /** A drag or long-press just ended: swallow the click the browser sends after it. */
  const suppressUntil = useRef(0);
  const stripId = useId();
  const hintId = useId();

  const clips = useMemo(() => (doc ? bookClips(doc) : []), [doc]);
  const pageKeys = useMemo(() => clips.filter((c) => c.kind === 'page').map((c) => c.key), [clips]);
  const items = useMemo<Item[]>(() => {
    if (!doc) return [];
    const out: Item[] = [];
    let lastPage = -1;
    clips.forEach((c, i) => {
      if (c.kind === 'page' || c.kind === 'cover' || c.kind === 'title') lastPage = i;
    });
    clips.forEach((c, i) => {
      out.push({ kind: 'clip', key: c.key, clip: c });
      if (i === lastPage) out.push({ kind: 'add', key: 'add' });
    });
    if (lastPage < 0) out.push({ kind: 'add', key: 'add' });
    if (!compact) for (const g of ghostPlates(doc)) out.push({ kind: 'ghost', key: `ghost:${g.kind}`, ghost: g });
    return out;
  }, [clips, doc, compact]);

  const byok = doc ? ((studio as { byok?: boolean }).byok ?? byokFromDoc(doc)) : false;
  const maxPages = Math.min(DOC_LIMITS.pages, studio.caps?.maxPages ?? DOC_LIMITS.pages);
  /** The strip is in the DOM (re-binds the touch listener when it mounts after loading / leaving Read). */
  const stripShown = !!doc && (compact || (open && studio.tab !== 'read'));
  const activeKey = (focusKey && items.some((it) => it.key === focusKey) ? focusKey : null) ?? (studio.focusedPageId && items.some((it) => it.key === studio.focusedPageId) ? studio.focusedPageId : items[0]?.key);

  // Transient, visible + announced notices (refusals and confirmations).
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  // Keep the page being edited in view.
  useEffect(() => {
    const el = studio.focusedPageId ? itemEls.current.get(studio.focusedPageId) : undefined;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [studio.focusedPageId, reduceMotion, open]);

  // While a clip is lifted, a finger drag must move the clip, not scroll the strip (non-passive).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (dragRef.current?.active) e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [open, compact, stripShown]);

  // Unmounted mid-drag (tab switch, project switch): drop the window listeners and the long-press timer.
  useEffect(
    () => () => {
      const l = listeners.current;
      if (l) {
        window.removeEventListener('pointermove', l.move);
        window.removeEventListener('pointerup', l.up);
        window.removeEventListener('pointercancel', l.cancel);
      }
      if (dragRef.current?.timer) clearTimeout(dragRef.current.timer);
    },
    []
  );

  const focusItem = useCallback((key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    const focus = () => itemEls.current.get(key)?.focus();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else setTimeout(focus, 0);
  }, []);

  if (!doc) return null;
  if (!compact && studio.tab === 'read') return null;

  const pages = sortedPages(doc);
  const pageIndex = (key: string) => pages.findIndex((p) => p.id === key);
  const say = (text: string) => setNotice(text);

  // ── Actions ────────────────────────────────────────────────────────────────

  const movePage = (clip: ClipVM, to: number) => {
    if (!clip.page) return;
    const from = pageIndex(clip.key);
    const target = Math.max(0, Math.min(pages.length - 1, to));
    if (from < 0 || target === from) return;
    const ops = moveOps(doc, clip.key, target);
    if (!ops.length) return;
    edit.commit(ops, `Moved page ${clip.page.n} → ${target + 1}`, { label: 'Move page' });
    say(`Page ${clip.page.n} moved to position ${target + 1}.`);
    focusItem(clip.key);
  };
  const insertAfter = (n: number) => {
    if (!canAddPage(doc, maxPages)) return say(`This comic is at its ${maxPages}-page limit.`);
    const id = newId('pg');
    edit.commit(insertOps(n, id), `Added a blank page ${n + 1}`, { label: 'Add a page' });
    focusItem(id);
  };
  const duplicate = (clip: ClipVM) => {
    if (!clip.page) return;
    if (clip.busy) return say(`Page ${clip.page.n} is still drawing — duplicate it when it's done.`);
    if (!canAddPage(doc, maxPages)) return say(`This comic is at its ${maxPages}-page limit.`);
    const id = newId('pg');
    edit.commit(duplicateOps(clip.key, id), `Copied page ${clip.page.n}`, { label: 'Duplicate page' });
    focusItem(id);
  };
  const remove = (clip: ClipVM) => {
    if (!clip.page) return;
    if (clip.busy) return say(`Page ${clip.page.n} is still drawing — delete it when it's done (its image is paid for).`);
    if (pages.length <= 1) return say('A comic needs at least one page.');
    const idx = items.findIndex((it) => it.key === clip.key);
    const neighbour = items[idx + 1]?.kind === 'clip' ? items[idx + 1].key : items[idx - 1]?.key;
    if (studio.focusedPageId === clip.key) studio.openPage(null);
    edit.commit(deleteOps(clip.key), `Page ${clip.page.n} deleted`, { label: 'Delete page' });
    focusItem(neighbour);
  };
  const openVersions = (clip: ClipVM, compare = false) => {
    if (!clip.target || clip.versions === 0) return say(`${clip.label} isn't drawn yet — nothing to pick from.`);
    setDialog({ kind: 'versions', target: clip.target, title: `${clip.label} · versions`, compare });
  };
  const openClip = (clip: ClipVM) => {
    if (clip.kind === 'page') studio.openPage(clip.key);
    else if (clip.kind === 'cover') {
      if (clip.versions > 0) openVersions(clip);
      else studio.setTab('pages');
    } else if (clip.plate) setDialog({ kind: 'plate', plate: clip.kind as PlateKind });
  };
  const runAction = (clip: ClipVM, action: ClipAction) => {
    switch (action) {
      case 'open':
        return openClip(clip);
      case 'versions':
        return openVersions(clip);
      case 'compare':
        return openVersions(clip, true);
      case 'redraw':
        if (!clip.page) return;
        return void studio.act({ type: 'render_pages', pageIds: [clip.key], ...(clip.drawn ? { force: true } : {}), quotedUsd: redrawPrice(doc, 'page', byok) });
      case 'fit':
        if (!clip.target) return;
        return void studio.act({ type: 'fit_render', target: clip.target });
      case 'duplicate':
        return duplicate(clip);
      case 'insert':
        return insertAfter(clip.kind === 'page' ? clip.page?.n ?? pages.length : 0);
      case 'write':
        if (!clip.page) return;
        return void studio.send(`Write page ${clip.page.n} for me${clip.page.summary ? `: ${clip.page.summary}` : ''}`);
      case 'move_left':
        return movePage(clip, pageIndex(clip.key) - 1);
      case 'move_right':
        return movePage(clip, pageIndex(clip.key) + 1);
      case 'delete':
        return remove(clip);
      case 'cover_redesign':
        return void studio.act({ type: 'render_cover', quotedUsd: redrawPrice(doc, 'cover', byok) });
      case 'cover_text':
        return studio.setTab('pages');
      case 'plate_edit':
        return setDialog({ kind: 'plate', plate: clip.kind as PlateKind });
      case 'plate_hide':
        edit.commit([{ op: 'book', patch: plateOffPatch(clip.kind as PlateKind) }], `${clip.label} hidden`, { label: 'Change book pages' });
        return;
      default:
        return;
    }
  };
  const openMenu = (clip: ClipVM, anchor?: Element | null) => {
    const el = anchor ?? itemEls.current.get(clip.key) ?? null;
    setMenu({ key: clip.key, rect: el ? el.getBoundingClientRect() : null });
  };
  const activateItem = (item: Item) => {
    if (item.kind === 'clip') return openClip(item.clip);
    if (item.kind === 'add') return insertAfter(pages.length);
    edit.commit([{ op: 'book', patch: item.ghost.patch }], `${item.ghost.label} added — free, made by software`, { label: 'Change book pages' });
    focusItem(item.ghost.kind);
  };
  const undo = () => {
    if (studio.canUndo) studio.undo();
    else if (!edit.undoLast()) say('Nothing to undo here.');
  };

  // ── Keyboard (roving focus; every key also exists in the clip menu) ────────

  const onItemKey = (e: React.KeyboardEvent<HTMLDivElement>, item: Item, index: number) => {
    const k = e.key;
    if (k === 'Escape' && dragRef.current) {
      e.preventDefault();
      return cancelDrag();
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const dir = k === 'ArrowRight' ? 1 : -1;
      if (e.altKey && item.kind === 'clip' && item.clip.kind === 'page') return movePage(item.clip, pageIndex(item.key) + dir);
      return focusItem(items[Math.max(0, Math.min(items.length - 1, index + dir))]?.key);
    }
    if (k === 'Home' || k === 'End') {
      e.preventDefault();
      return focusItem(k === 'Home' ? items[0]?.key : items[items.length - 1]?.key);
    }
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      return activateItem(item);
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      return undo();
    }
    if (item.kind !== 'clip') return;
    const clip = item.clip;
    if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      e.preventDefault();
      return openMenu(clip);
    }
    if (k === 'Delete' || k === 'Backspace') {
      if (clip.kind !== 'page') return;
      e.preventDefault();
      return remove(clip);
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (k.toLowerCase()) {
      case 'm':
        e.preventDefault();
        return openMenu(clip);
      case 'v':
        e.preventDefault();
        return openVersions(clip);
      case 'd':
        if (clip.kind !== 'page') return;
        e.preventDefault();
        return duplicate(clip);
      case 'i':
        if (clip.kind !== 'page' && clip.kind !== 'cover') return;
        e.preventDefault();
        return insertAfter(clip.kind === 'page' ? clip.page?.n ?? pages.length : 0);
      default:
        return;
    }
  };

  // ── Drag to reorder (pointer events; long-press on touch) ──────────────────

  const endListeners = () => {
    const l = listeners.current;
    if (!l) return;
    window.removeEventListener('pointermove', l.move);
    window.removeEventListener('pointerup', l.up);
    window.removeEventListener('pointercancel', l.cancel);
    listeners.current = null;
  };
  function cancelDrag() {
    const s = dragRef.current;
    if (s?.timer) clearTimeout(s.timer);
    dragRef.current = null;
    endListeners();
    setDrag(null);
  }
  const lift = () => {
    const s = dragRef.current;
    if (!s) return;
    s.slots = pageKeys.map((key) => {
      const el = itemEls.current.get(key);
      return { key, left: el?.offsetLeft ?? 0, width: el?.offsetWidth ?? 0 };
    });
    s.active = true;
    if (!reduceMotion) {
      try {
        navigator.vibrate?.(8);
      } catch {
        /* no haptics */
      }
    }
    setDrag({ key: s.key, dx: 0, fromIdx: s.fromIdx, overIdx: s.fromIdx, width: s.slots[s.fromIdx]?.width ?? 0 });
  };
  function onMove(ev: PointerEvent) {
    const s = dragRef.current;
    if (!s || ev.pointerId !== s.pointerId) return;
    const dx = ev.clientX - s.startX;
    const dy = ev.clientY - s.startY;
    if (!s.active) {
      if (s.longPress) {
        if (Math.hypot(dx, dy) > 10) cancelDrag(); // a scroll, not a lift
        return;
      }
      if (Math.abs(dx) < 6) return;
      lift();
    }
    const scroller = scrollerRef.current;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (ev.clientX < r.left + 40) scroller.scrollLeft -= 14;
      else if (ev.clientX > r.right - 40) scroller.scrollLeft += 14;
    }
    const content = dx + ((scroller?.scrollLeft ?? 0) - s.startScroll);
    s.moved = s.moved || Math.abs(dx) > 4;
    s.overIdx = dropIndex(s.slots, s.fromIdx, content);
    setDrag({ key: s.key, dx: content, fromIdx: s.fromIdx, overIdx: s.overIdx, width: s.slots[s.fromIdx]?.width ?? 0 });
  }
  function onUp(ev: PointerEvent) {
    const s = dragRef.current;
    if (!s || ev.pointerId !== s.pointerId) return;
    if (s.timer) clearTimeout(s.timer);
    endListeners();
    dragRef.current = null;
    setDrag(null);
    if (!s.active) return;
    suppressUntil.current = Date.now() + 400;
    const clip = clips.find((c) => c.key === s.key);
    if (!clip) return;
    if (s.overIdx !== s.fromIdx) movePage(clip, s.overIdx);
    else if (s.longPress && !s.moved) openMenu(clip, s.el); // long-press and release: the clip menu
  }
  const onClipPointerDown = (e: React.PointerEvent<HTMLDivElement>, clip: ClipVM) => {
    if (e.button !== 0 || dragRef.current) return;
    const touch = e.pointerType !== 'mouse';
    const longPress = touch && (activation === 'longpress' || clip.kind !== 'page');
    if (clip.kind !== 'page' && !touch) return;
    const fromIdx = pageKeys.indexOf(clip.key);
    const s: DragState = {
      key: clip.key,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScroll: scrollerRef.current?.scrollLeft ?? 0,
      longPress,
      active: false,
      moved: false,
      fromIdx,
      overIdx: fromIdx,
      slots: [],
      el: e.currentTarget
    };
    dragRef.current = s;
    if (longPress) {
      s.timer = setTimeout(() => {
        if (dragRef.current !== s) return;
        if (clip.kind === 'page') lift();
        else {
          // Cover and software pages don't move: a long-press opens their menu.
          cancelDrag();
          suppressUntil.current = Date.now() + 400;
          openMenu(clip, s.el);
        }
      }, LONG_PRESS_MS);
    }
    endListeners();
    listeners.current = { move: onMove, up: onUp, cancel: cancelDrag };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancelDrag);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const summary = dockSummary(doc, cost.exact).replace(/^Book · /, '');
  const menuClip = menu ? clips.find((c) => c.key === menu.key) ?? null : null;
  const pageIdx = menuClip ? pageIndex(menuClip.key) : -1;
  const menuItems = menuClip
    ? clipMenuItems(menuClip, {
        redrawUsd: redrawPrice(doc, 'page', byok),
        coverUsd: redrawPrice(doc, 'cover', byok),
        canMoveLeft: pageIdx > 0,
        canMoveRight: pageIdx >= 0 && pageIdx < pages.length - 1,
        canAddPage: canAddPage(doc, maxPages),
        pageCount: pages.length,
        price: cost.approx,
        writeUsd: PLAN_USD_PER_PAGE * (byok ? 1 : PLATFORM_MARKUP)
      })
    : [];
  const pagePrice = cost.approx(redrawPrice(doc, 'page', byok));

  const strip = (
    <div
      ref={scrollerRef}
      id={stripId}
      className={cx('min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:thin]', compact ? 'px-1.5 py-1' : 'px-2 pb-2 pt-0.5')}
      style={{ touchAction: drag ? 'none' : 'pan-x' }}
    >
      <div role="listbox" aria-orientation="horizontal" aria-roledescription="page timeline" aria-label="Book timeline" className="relative flex w-max items-start gap-1">
        {items.map((item, index) => {
          const tabIndex = item.key === activeKey ? 0 : -1;
          const ref = (el: HTMLDivElement | null) => {
            if (el) itemEls.current.set(item.key, el);
            else itemEls.current.delete(item.key);
          };
          if (item.kind === 'add') {
            const full = !canAddPage(doc, maxPages);
            return (
              <AddClip
                key={item.key}
                label="Add page"
                hint={full ? `this comic is at its ${maxPages}-page limit` : 'a blank page, free'}
                disabled={full}
                compact={compact}
                tabIndex={tabIndex}
                itemRef={ref}
                onActivate={() => activateItem(item)}
                onKeyDown={(e) => onItemKey(e, item, index)}
                onFocus={() => setFocusKey(item.key)}
              />
            );
          }
          if (item.kind === 'ghost') {
            return (
              <AddClip
                key={item.key}
                ghost
                label={item.ghost.label}
                hint="made by software, free"
                compact={compact}
                tabIndex={tabIndex}
                itemRef={ref}
                onActivate={() => activateItem(item)}
                onKeyDown={(e) => onItemKey(e, item, index)}
                onFocus={() => setFocusKey(item.key)}
              />
            );
          }
          const clip = item.clip;
          const j = pageKeys.indexOf(clip.key);
          const lifted = drag?.key === clip.key;
          const shift = drag ? (lifted ? drag.dx : j >= 0 ? dragShift(j, drag.fromIdx, drag.overIdx, drag.width) : 0) : 0;
          return (
            <TimelineClip
              key={clip.key}
              clip={clip}
              doc={doc}
              urlFor={studio.urlFor}
              compact={compact}
              selected={studio.focusedPageId === clip.key}
              tabIndex={tabIndex}
              nextPrice={clip.kind === 'page' && clip.page?.panels.length ? `${clip.drawn ? 'Redraw' : 'Draw'} ${pagePrice}` : undefined}
              cost={cost}
              shift={shift}
              lifted={lifted}
              animate={!reduceMotion}
              describedBy={hintId}
              itemRef={ref}
              onActivate={() => {
                if (Date.now() < suppressUntil.current) return;
                setFocusKey(clip.key);
                openClip(clip);
              }}
              onMenu={(anchor) => openMenu(clip, anchor)}
              onKeyDown={(e) => onItemKey(e, item, index)}
              onFocus={() => setFocusKey(clip.key)}
              onPointerDown={(e) => onClipPointerDown(e, clip)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!dragRef.current?.active) openMenu(clip, e.currentTarget);
              }}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <section
      aria-label="Book timeline"
      className={cx('relative w-full min-w-0 max-w-full shrink-0 overflow-hidden', !compact && 'border-t border-[var(--ds-hairline)] bg-[var(--ds-surface)]')}
      // The dock sits on the screen's bottom edge on tablets and desktops: keep its controls out of the
      // home-indicator inset (P1-QA timeline-dock-safe-area). Phones put the tab bar there, which pads itself.
      style={!compact && !phoneLayout ? { paddingBottom: 'var(--sa-bottom, 0px)' } : undefined}
    >
      <p id={hintId} className="sr-only">
        Enter opens. M opens actions. V shows versions. Alt plus arrow keys move a page. Delete removes it; undo brings it back.
      </p>
      {!compact && (
        <div className="flex h-9 min-w-0 items-center gap-1.5 px-2 coarse:h-11 sm:px-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={stripId}
            onClick={() => setOpen(!open)}
            className={cx('inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] coarse:h-11 coarse:px-3', FOCUS_RING)}
          >
            <ChevronUp className={cx('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', !open && 'rotate-180')} aria-hidden />
            Book
          </button>
          <p className="min-w-0 flex-1 truncate text-[11.5px] tabular-nums text-[var(--ds-muted)]" title={notice || summary} role={notice ? 'status' : undefined}>
            {notice || summary}
          </p>
          {/* The Media tab exists once the comic has an image (feature tab `visible`); no dead button before that. */}
          {hasMedia(doc) && (
            <button
              type="button"
              onClick={() => studio.setTab('media')}
              className={cx('inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] coarse:h-11 coarse:min-w-11 coarse:justify-center coarse:px-3', FOCUS_RING)}
              aria-label="Open Media: every image in this comic"
            >
              <Images className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Media</span>
            </button>
          )}
        </div>
      )}
      {compact && notice && (
        <p role="status" className="truncate px-2 text-[11.5px] text-[var(--ds-muted)]">
          {notice}
        </p>
      )}
      {(compact || open) && strip}
      <ClipMenu
        open={!!menuClip}
        onClose={() => setMenu(null)}
        clip={menuClip}
        anchor={menu?.rect ?? null}
        items={menuItems}
        onAction={(a) => menuClip && runAction(menuClip, a)}
      />
      <TimelineDialog
        open={dialog?.kind === 'versions'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'versions' ? dialog.title : ''}
        wide
      >
        {dialog?.kind === 'versions' && <VersionStack key={renderTargetKey(dialog.target)} studio={studio} target={dialog.target} initialCompare={dialog.compare} />}
      </TimelineDialog>
      <TimelineDialog open={dialog?.kind === 'plate'} onClose={() => setDialog(null)} title={dialog?.kind === 'plate' ? `${PLATE_LABEL[dialog.plate]} · free` : ''}>
        {dialog?.kind === 'plate' && (
          <PlateEditor
            doc={doc}
            kind={dialog.plate}
            urlFor={(p) => studio.urlFor(p, { width: 360 })}
            onSave={(patch) => edit.commit([{ op: 'book', patch }], `${PLATE_LABEL[dialog.plate]} updated`, { label: 'Change book pages' })}
            onEditCover={() => {
              setDialog(null);
              studio.setTab('pages');
            }}
            onClose={() => setDialog(null)}
          />
        )}
      </TimelineDialog>
      <UndoToast entry={edit.toast} onUndo={edit.undo} onDismiss={edit.dismiss} />
    </section>
  );
};

export default BookTimeline;
