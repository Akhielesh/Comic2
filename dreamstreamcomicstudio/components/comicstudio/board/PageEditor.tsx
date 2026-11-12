// Page editor — a focused, full-screen workspace for one page, on every form factor (mobile.md §5.6).
//
// The stage: the page, large, inside a TouchCanvas (pinch / double-tap / ctrl+wheel zoom, one-finger pan
// when zoomed; a second finger cancels a balloon drag or a Mark-up box with nothing committed), with
// editable overlay balloons (drag / arrow keys / tail and width handles / long-press menu) and a Mark-up
// mode: drag a box on the art to show the AI exactly what to change.
//
// The tools: "Edit with AI" (instruction + marked area → a scoped image edit, with its price), "Try
// another take ≈ cost" beside "Pick from n versions (free)", re-letter, the aspect fix (free), the
// vision QC report, every saved version (VersionStack), the mini filmstrip, the comic's lettering style
// and the script itself. Prices follow the usage rule: governed users see a share of their usage,
// never dollars.
//
// Layouts (editorLayoutFor): phones get a thumb-zone bottom toolbar ([Move | Mark up] · Undo · Redo ·
// Lettering · Tools) and the tools in a non-modal bottom sheet (peek / half / full); landscape phones a
// left rail and a collapsible side sheet; tablets in portrait the mode row on top and the bottom sheet;
// tablets in landscape and desktops today's aside; foldables put the page on one screen and the tools on
// the other. The stage always shrinks to what is left, so no sheet ever rests over the page — and on
// phones the lettering inspector (a bottom sheet) shrinks it too, so the selected balloon stays in view.
//
// Lettering edits are free, undoable and labelled. Editing a translated edition (LanguageSwitch): the art
// is shared; typing writes `translation`, dragging writes `edition_balloon`; the original is never
// overwritten from another language. Safety: the art sits in a SafetyVeil at the comic's rating.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Languages,
  Layers,
  Lock,
  MessageSquare,
  MousePointer2,
  Palette,
  PencilLine,
  Plus,
  Redo2,
  RotateCcw,
  Scaling,
  SquareDashed,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Unlock,
  WandSparkles,
  X
} from 'lucide-react';
import { findPage, newId, type Balloon, type Box, type ComicDoc, type Line, type LineKind, type Page, type Panel, type RenderTarget } from '../../../shared/comic/doc';
import type { DocOp, StudioAction } from '../../../shared/comic/ops';
import { aspectMismatch } from '../../../shared/comic/book';
import { canServeToOwner, effectiveRating } from '../../../shared/comic/safety';
import { i18nOf } from '../../../shared/comic/i18n';
import { DOC_LIMITS } from '../../../shared/comic/limits';
import { ACCENT_SOFT_BG, OVERLAY, RADIUS_CONTROL, RADIUS_PANEL, RADIUS_PILL, SCRIM, STATUS_SURFACE, TONE_CHIP, TONE_TEXT, TRANSITION, Z } from '../../chat/studioDesign';
import { IN_ART_LETTERING_NOTE, MADE_IN_PRO_CHIP, PRO_FREE_FOOTER } from '../../../shared/comic/pro/types';
import { PRO_BUBBLE_SHAPES, PRO_SFX_EFFECTS, PRO_STYLE_KEYS } from '../../../shared/comic/lettering/style';
import { NUDGE as ENGINE_NUDGE, moveEdit } from '../../../shared/comic/editor/transform';
import { resolveDrop } from '../../../shared/comic/editor/drop';
import { BalloonEditorExtrasContext, NO_BALLOON_EXTRAS, type BalloonEditorExtras } from './BalloonLayer';
import { useProEditor, type ProEditorState, type ProPanelProps } from '../editor/useProEditor';
import { ProTopBar } from '../editor/ProTopBar';
import { ToolRail } from '../editor/ToolRail';
import { ProCoach, ProDock, ProLayersSheet, ProPanelFrame, ProWorkspace, ShortcutSheet, type DockTab, type DockTabId } from '../editor/ProWorkspace';
import { TOOL_LINE_KIND, isEditableTarget, isLetteringTool, selectionHoldsArrows, shellShortcut, toolSpec, type ProTool } from '../editor/shortcuts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs';
import { dirOf, languageSpec } from '../../../shared/comic/languages';
import type { StudioController } from '../types';
import { ModalPortal } from '../../modals/ModalPortal';
import { useDialogA11y } from '../../studio/kit/useDialogA11y';
import { ComicPageView } from './ComicPageView';
import type { BalloonChangeOptions } from './BalloonLayer';
import { isSpokenKind, pageAspectOf } from './balloonGeometry';
import {
  CLEAR,
  LINE_KINDS,
  LINE_KIND_LABEL,
  SHOT_LABEL,
  SIZE_LABEL,
  byokFromDoc,
  castName,
  estimateDraw,
  estimateOne,
  hasImage,
  isBusy,
  jobModel,
  pageVisualStatus,
  pagesForIds,
  renderModelNickname
} from './boardModel';
import { panelBoxesFor, panelForRegion, regionFromPoints, toPagePoint, type Point } from './pageLayout';
import { GhostButton, IconButton, InlineField, PrimaryButton, RenderOverlay, SectionTitle, Segmented, StatusChip, cx, useClickGuard, useElementSize, useFocusTrap } from './ui';
import type { PatchOptions } from '../types';
import type { StudioMode } from '../../../shared/comic/capabilities';
import { LetteringInspector, PlacementFixChip, TooMuchTextChip, densePanels, recheckQuoteUsd, type Rect } from '../lettering/LetteringInspector';
import { BUSY_GRID_SIDE, hasFaceData, loadBusyGrid, reletterAroundArtOps } from '../lettering/busyGrid';
import { LetteringToolbar } from '../lettering/LetteringToolbar';
import { LINE_TEXT_MAX } from '../lettering/BalloonTextEditor';
import { PresetGallery } from '../lettering/PresetGallery';
import { useLetterPlans } from '../lettering/useLetterPlans';
import { useLetteringSelection } from '../lettering/useLetteringSelection';
import { addLineAtOps, deleteLinesOps, duplicateLineOps, fixSafeAreaOps, lockOps, outlineFractions, pinKeepingSizeOps, presetOps, resetPositionOps, tidyOps, zOrderOps } from '../lettering/styleOps';
import { useFormFactor } from '../mobile/useFormFactor';
import { TouchCanvas, useZoom } from '../mobile/touch/TouchCanvas';
import { useGestureArbiter } from '../mobile/touch/GestureArbiter';
import { ContextMenuSheet, type ContextMenuItem } from '../mobile/touch/ContextMenuSheet';
import { LanguageSwitch, languageSwitchOptions } from '../i18n/LanguageSwitch';
import { cssFontFamily } from '../i18n/scriptFonts';
import { VersionStack } from '../timeline/VersionStack';
import { BookTimeline } from '../timeline/BookTimeline';
import { versionCount } from '../timeline/bookModel';
import { EditorToolbar, type EditorMode } from '../mobile/editor/EditorToolbar';
import { EditorToolsSheet } from '../mobile/editor/EditorToolsSheet';
import { useEditorCost } from '../mobile/editor/useEditorCost';
import { keepRefusedInComposer } from '../conversation/composerBus';
import {
  COACH_KEY,
  TOOLS_SHEET_KEY,
  coveredByBottomSheet,
  editionOps,
  editionViewDoc,
  editorImageWidth,
  editorLayoutFor,
  isEditionLang,
  proWorkspaceFor,
  readFlag,
  selectionOutOfView,
  swipeTurn,
  toolsSheetHeights,
  translationEditOp,
  turnTarget,
  writeFlag,
  type EditorLayout,
  type ToolsDetent
} from '../mobile/editor/editorModel';

type Mode = EditorMode;

/**
 * The page's on-screen width inside a stage (both dimensions fit; never wider than the stage).
 * `pad` is the stage padding per side (0 when measuring the content box directly).
 */
export const fitPageToStage = (stage: { w: number; h: number }, aspect: number, pad = 24): number | undefined => {
  const w = Math.max(0, stage.w - pad * 2);
  const h = Math.max(0, stage.h - pad * 2);
  if (!w || !h || !(aspect > 0)) return undefined;
  return Math.floor(Math.min(w, h * aspect));
};

/** Phones shorter than this open the editor with the page tools sheet closed (the Tools button opens it). */
export const PHONE_SHEET_OPEN_MIN_H = 780;

/**
 * Is the page tools sheet open when the editor opens? The user's last choice on this device wins. With
 * none, a phone shorter than PHONE_SHEET_OPEN_MIN_H starts with it closed: under the sheet's peek detent a
 * 660 px phone kept an ~85 px page whose balloons were too small to read or tap. Tablets and taller phones
 * start with it open, as before.
 */
export const toolsSheetOpenAtStart = (flag: string | null, kind: EditorLayout['kind'], viewportHeight: number): boolean => {
  if (flag === 'open') return true;
  if (flag === 'closed') return false;
  return kind !== 'phone' || !(viewportHeight > 0) || viewportHeight >= PHONE_SHEET_OPEN_MIN_H;
};

/**
 * Phones: how far (px) the page slides up so a selection (viewport px, measured without any slide) ends
 * 12 px above the lettering sheet's top — 0 when it already does (the page holds still), and never so far
 * that the selection's own top would leave the stage (8 px margin). Pure; tested.
 */
export const selectionSlide = (sel: { top: number; bottom: number }, stageTop: number, sheetTop: number): number => {
  if (![sel.top, sel.bottom, stageTop, sheetTop].every(Number.isFinite)) return 0;
  const need = sel.bottom + 12 - sheetTop;
  if (need <= 0) return 0;
  const room = Math.max(0, sel.top - stageTop - 8);
  return Math.round(Math.min(need, room));
};

/** The least stage height (px) the phone lettering sheet leaves above itself (a 2:3 page ≈ 145 px wide). */
export const MIN_STAGE_PX = 240;
/** …and at least this share of the viewport's height: the page and its balloons stay big enough to tap. */
export const MIN_STAGE_SHARE = 0.45;
/** The sheet never gets shorter than its header plus a row of controls (its content scrolls). */
export const MIN_SHEET_PX = 168;

/**
 * Height cap (px) for the phone lettering sheet: everything below the stage's top minus the page's
 * minimum height (MIN_STAGE_PX, or MIN_STAGE_SHARE of the viewport when that is more), never under
 * MIN_SHEET_PX (the sheet scrolls its own content).
 */
export const inspectorSheetMaxHeight = (stageTop: number, viewportHeight: number, minStage = MIN_STAGE_PX): number => {
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  const keep = Math.max(minStage, Math.round(vh * MIN_STAGE_SHARE));
  return Math.max(MIN_SHEET_PX, Math.round(vh - (Number.isFinite(stageTop) ? stageTop : 0) - keep));
};

/** Default text for a balloon added from the toolbar (selected in the inline editor, so typing replaces it). */
const NEW_LINE_TEXT: Record<LineKind, string> = {
  speech: 'Hello!',
  thought: 'Hmm…',
  whisper: 'Psst…',
  shout: 'Hey!',
  caption: 'Meanwhile…',
  sfx: 'POW!'
};

/** The edit_page action for an instruction (+ optional marked region / panel). */
export const editActionFor = (pageId: string, instruction: string, region?: Box | null, panelN?: number): StudioAction => ({
  type: 'edit_page',
  pageId,
  instruction: instruction.trim(),
  ...(region ? { region } : {}),
  ...(panelN ? { panelN } : {})
});

/** Line kind change: drop the speaker for captions/SFX, give spoken lines one. */
export const lineKindOps = (page: Page, panel: Panel, line: Line, kind: LineKind): DocOp[] => {
  const patch: Partial<Line> = { kind };
  if (!isSpokenKind(kind) && line.speakerId) patch.speakerId = CLEAR;
  if (isSpokenKind(kind) && !line.speakerId && panel.castIds[0]) patch.speakerId = panel.castIds[0];
  return [{ op: 'line', pageId: page.id, panelId: panel.id, id: line.id, patch }];
};

/**
 * A line or balloon carries something only the Pro view edits (rotation, a set height, a named style, a Pro text
 * effect or a Pro shape): Easy shows it as one "Made in Pro · Open in Pro" chip (zero-confusion rule 2). Pure.
 */
export const madeInPro = (page: Page, lineIds: readonly string[]): boolean =>
  lineIds.some((id) => {
    const b = page.balloons.find((x) => x.lineId === id);
    if (b && ((typeof b.rot === 'number' && b.rot !== 0) || (typeof b.minH === 'number' && b.minH > 0))) return true;
    const line = page.panels.flatMap((p) => p.lines).find((l) => l.id === id);
    if (!line) return false;
    if (line.styleId) return true;
    const st = (line.style || {}) as Record<string, unknown>;
    return (
      PRO_STYLE_KEYS.some((k) => st[k] !== undefined) ||
      (typeof st.shape === 'string' && (PRO_BUBBLE_SHAPES as readonly string[]).includes(st.shape)) ||
      (typeof st.sfxEffect === 'string' && (PRO_SFX_EFFECTS as readonly string[]).includes(st.sfxEffect))
    );
  });

const SELECT_CLS =
  'h-7 min-w-0 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-1.5 text-[12px] text-[var(--ds-ink)] focus:border-[var(--ds-accent)] focus:outline-none disabled:opacity-50 coarse:h-11';

/** Any per-line, per-kind, per-speaker or base lettering overrides in the comic? */
const hasLetteringOverrides = (doc: ComicDoc): boolean =>
  !!(doc.letterStyle?.base || doc.letterStyle?.kinds || doc.letterStyle?.speakers) || doc.pages.some((p) => p.panels.some((pn) => pn.lines.some((l) => l.style)));

/** "Reset all balloon styles": back to the chosen preset everywhere (one undoable batch). */
const resetAllLetteringOps = (doc: ComicDoc): DocOp[] => {
  const ops: DocOp[] = [];
  const ls = doc.letterStyle;
  if (ls?.base || ls?.kinds || ls?.speakers) {
    const kinds = ls.kinds ? Object.fromEntries(Object.keys(ls.kinds).map((k) => [k, null])) : undefined;
    const speakers = ls.speakers ? Object.fromEntries(Object.keys(ls.speakers).map((k) => [k, null])) : undefined;
    ops.push({ op: 'letter_style', patch: { ...(ls.base ? { base: null } : {}), ...(kinds ? { kinds } : {}), ...(speakers ? { speakers } : {}) } });
  }
  for (const page of doc.pages) {
    const ids = page.panels.flatMap((p) => p.lines.filter((l) => l.style).map((l) => l.id));
    for (let i = 0; i < ids.length; i += 80) ops.push({ op: 'line_style', pageId: page.id, lineIds: ids.slice(i, i + 80), patch: null });
  }
  return ops;
};

const languageLabel = (code: string): string => languageSpec(code)?.english || code;
const devicePixelRatioNow = (): number => (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio || 1 : 1);

// ── Mark-up layer ────────────────────────────────────────────────────────────

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: { id: Corner; label: string; x: 0 | 1; y: 0 | 1 }[] = [
  { id: 'nw', label: 'top-left', x: 0, y: 0 },
  { id: 'ne', label: 'top-right', x: 1, y: 0 },
  { id: 'sw', label: 'bottom-left', x: 0, y: 1 },
  { id: 'se', label: 'bottom-right', x: 1, y: 1 }
];
const MARK_NUDGE = 0.01;

/**
 * Mark-up: drag a box on the art (one finger on touch; a second finger cancels it and pinches instead).
 * Once drawn, four corner handles (44 px hit areas; arrow keys too) adjust the box — no redrawing.
 */
const MarkupLayer: React.FC<{
  active: boolean;
  region: Box | null;
  panelN?: number;
  onRegion: (region: Box) => void;
}> = ({ active, region, panelN, onRegion }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const arbiter = useGestureArbiter();
  const zoom = useZoom();
  const touches = useRef(new Set<number>());
  useEffect(() => () => cleanup.current?.(), []);

  /** Track one pointer from `fixed` (a new box's start, or the corner opposite the one being dragged). */
  const track = (e: React.PointerEvent, fixed: Point, keepIfTiny: boolean) => {
    if (!ref.current) return;
    if (e.pointerType === 'touch') {
      if (e.isPrimary) touches.current.clear();
      touches.current.add(e.pointerId);
      // A second finger is a pinch: the box in progress is cancelled (TouchCanvas preempts it too).
      if (touches.current.size > 1) {
        cleanup.current?.();
        setDraft(null);
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
    cleanup.current?.();
    const rect = ref.current.getBoundingClientRect();
    let end: Point = toPagePoint(e.clientX, e.clientY, rect);
    let claimed = true;
    const token = arbiter.claim('markup', () => {
      claimed = false;
      cleanup.current?.();
      setDraft(null);
    });
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      end = toPagePoint(ev.clientX, ev.clientY, rect);
      const box = regionFromPoints(fixed, end);
      if (box || !keepIfTiny) setDraft(box);
    };
    const up = (ev: PointerEvent) => {
      touches.current.delete(ev.pointerId);
      if (ev.pointerId !== e.pointerId) return;
      cleanup.current?.();
      end = toPagePoint(ev.clientX, ev.clientY, rect);
      setDraft(null);
      const box = regionFromPoints(fixed, end);
      if (box) onRegion(box); // a click (or a corner squeezed to nothing) changes nothing
    };
    const cancel = (ev: PointerEvent) => {
      touches.current.delete(ev.pointerId);
      if (ev.pointerId !== e.pointerId) return;
      cleanup.current?.();
      setDraft(null); // pointercancel never commits a box
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (claimed) arbiter.release(token);
      claimed = false;
      cleanup.current = null;
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || !ref.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    track(e, toPagePoint(e.clientX, e.clientY, ref.current.getBoundingClientRect()), false);
  };
  const opposite = (box: Box, c: (typeof CORNERS)[number]): Point => ({ x: c.x ? box.x : box.x + box.w, y: c.y ? box.y : box.y + box.h });
  const onCornerDown = (e: React.PointerEvent, c: (typeof CORNERS)[number]) => {
    if (!active || !region || (e.pointerType === 'mouse' && e.button !== 0)) return;
    track(e, opposite(region, c), true);
  };
  const onCornerKey = (e: React.KeyboardEvent, c: (typeof CORNERS)[number]) => {
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = d[e.key];
    if (!step || !region) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.shiftKey ? MARK_NUDGE * 5 : MARK_NUDGE;
    const moving = { x: (c.x ? region.x + region.w : region.x) + step[0] * k, y: (c.y ? region.y + region.h : region.y) + step[1] * k };
    const box = regionFromPoints(opposite(region, c), moving);
    if (box) onRegion(box);
  };

  const shown = draft || region;
  const scale = zoom.scale > 0 ? zoom.scale : 1;
  return (
    <div
      ref={ref}
      data-testid="markup-layer"
      data-no-canvas-gesture={active || undefined}
      onPointerDown={onPointerDown}
      className={cx('absolute inset-0 z-[4]', active ? 'cursor-crosshair touch-none' : 'pointer-events-none')}
      aria-hidden={!active}
    >
      {active && !shown && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-2">
          <span className="max-w-full truncate rounded-full bg-black/70 px-3 py-1 text-[12px] font-medium text-white shadow">Drag a box around the area to change</span>
        </div>
      )}
      {shown && (
        <div
          data-testid="markup-region"
          className="pointer-events-none absolute border-2 border-red-500 bg-red-500/10 shadow-[0_0_0_1px_rgba(255,255,255,0.7)]"
          style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.w * 100}%`, height: `${shown.h * 100}%` }}
        >
          {!draft && (
            // Keep the label on the page: flip it to the right edge / inside the box near the borders.
            <span
              className={cx(
                'absolute whitespace-nowrap rounded-md bg-red-600 px-1.5 py-0.5 text-[10.5px] font-semibold text-white shadow',
                shown.y < 0.06 ? 'top-1' : '-top-6',
                shown.x + shown.w > 0.62 ? (shown.y < 0.06 ? 'right-1' : 'right-0') : shown.y < 0.06 ? 'left-1' : 'left-0'
              )}
            >
              Area to change{panelN ? ` · panel ${panelN}` : ''}
            </span>
          )}
        </div>
      )}
      {active &&
        region &&
        !draft &&
        CORNERS.map((c) => (
          <span
            key={c.id}
            role="button"
            tabIndex={0}
            aria-label={`Resize the marked area from its ${c.label} corner (arrow keys move it)`}
            data-testid={`markup-corner-${c.id}`}
            onPointerDown={(e) => onCornerDown(e, c)}
            onKeyDown={(e) => onCornerKey(e, c)}
            className="absolute z-[5] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-red-500 shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
            style={{ left: `${(region.x + c.x * region.w) * 100}%`, top: `${(region.y + c.y * region.h) * 100}%`, width: 14 / scale, height: 14 / scale, cursor: c.id === 'nw' || c.id === 'se' ? 'nwse-resize' : 'nesw-resize' }}
          >
            <span aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: 44 / scale, height: 44 / scale }} />
          </span>
        ))}
    </div>
  );
};

// ── Lines ────────────────────────────────────────────────────────────────────

interface EditionLineProps {
  lang: string;
  text?: string;
  onCommit(text: string): void;
}

/** Show the count when this close to the cap (and always once at it). */
const COUNT_FROM = 40;

/**
 * A text field with a live "n / max" count once the text is within COUNT_FROM characters of `max` (the
 * field itself carries maxLength). Reads the length from the field's own input events, so it counts the
 * draft as it is typed, not just the committed value.
 */
export const CountedField: React.FC<{ max: number; value: string; testId?: string; children: React.ReactNode }> = ({ max, value, testId, children }) => {
  const [len, setLen] = useState(value.length);
  useEffect(() => setLen(value.length), [value]);
  const near = len >= max - COUNT_FROM;
  return (
    <div
      onInput={(e) => {
        const t = e.target as HTMLInputElement | HTMLTextAreaElement;
        if (typeof t.value === 'string') setLen(t.value.length);
      }}
      onBlur={(e) => {
        const t = e.target as HTMLInputElement | HTMLTextAreaElement;
        if (typeof t.value === 'string') setLen(t.value.length);
      }}
    >
      {children}
      {near && (
        <p data-testid={testId} className={cx('px-2 text-right text-[11px] tabular-nums', len >= max ? 'font-medium text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]')}>
          {len >= max ? `${max} / ${max} — the limit` : `${len} / ${max}`}
        </p>
      )}
    </div>
  );
};

const LineRow: React.FC<{
  doc: ComicDoc;
  page: Page;
  panel: Panel;
  line: Line;
  selected: boolean;
  autoFocus: boolean;
  onSelect: () => void;
  patch: (ops: DocOp[]) => void;
  edition?: EditionLineProps;
}> = ({ doc, page, panel, line, selected, autoFocus, onSelect, patch, edition }) => {
  const spoken = isSpokenKind(line.kind);
  const inPanel = doc.cast.filter((c) => panel.castIds.includes(c.id));
  const others = doc.cast.filter((c) => !panel.castIds.includes(c.id));
  const lineOp = (p: Partial<Line> | null): DocOp => ({ op: 'line', pageId: page.id, panelId: panel.id, id: line.id, patch: p });
  return (
    <div
      data-testid="line-row"
      data-line-id={line.id}
      onClick={onSelect}
      className={cx(
        'space-y-1 rounded-xl border p-1.5 transition-colors duration-200 motion-reduce:transition-none',
        selected ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]' : 'border-transparent bg-[var(--ds-well)]'
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <select
          aria-label="Line type"
          value={line.kind}
          onChange={(e) => patch(lineKindOps(page, panel, line, e.target.value as LineKind))}
          className={cx(SELECT_CLS, 'w-[7.5rem] shrink-0')}
        >
          {LINE_KINDS.map((k) => (
            <option key={k} value={k}>
              {LINE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select
          aria-label="Speaker"
          value={spoken ? line.speakerId || '' : ''}
          disabled={!spoken}
          onChange={(e) => patch([lineOp({ speakerId: e.target.value || CLEAR })])}
          className={cx(SELECT_CLS, 'flex-1')}
        >
          <option value="">{spoken ? 'Choose speaker…' : line.kind === 'caption' ? 'Narration' : 'No speaker'}</option>
          {inPanel.length > 0 && (
            <optgroup label="In this panel">
              {inPanel.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="Others (adds nobody to the panel)">
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <IconButton size="sm" label="Remove line" onClick={() => patch([lineOp(null)])}>
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {spoken && line.speakerId && !panel.castIds.includes(line.speakerId) && (
        <p className={cx('px-1 text-[11px]', TONE_TEXT.warning)}>
          {castName(doc, line.speakerId)} isn’t in this panel — the line reads as off-panel.
        </p>
      )}
      {/* The server stores at most LINE_TEXT_MAX characters (LE-6): the field stops there and counts down
          near the cap, so what the editor shows is what is saved. */}
      <CountedField max={LINE_TEXT_MAX} value={line.text} testId="line-text-count">
        <InlineField
          label={`Line text (${LINE_KIND_LABEL[line.kind]})`}
          multiline
          rows={1}
          autoFocus={autoFocus}
          value={line.text}
          maxLength={LINE_TEXT_MAX}
          placeholder="Type the line…"
          onCommit={(text) => patch([lineOp({ text: text.slice(0, LINE_TEXT_MAX) })])}
          inputClassName="text-[13px]"
        />
      </CountedField>
      {edition && (
        <div lang={edition.lang} dir={dirOf(edition.lang)} style={{ fontFamily: cssFontFamily(edition.lang, line.kind === 'sfx' ? 'sfx' : 'dialogue') }}>
          <CountedField max={DOC_LIMITS.translationChars} value={edition.text ?? ''} testId="translation-text-count">
            <InlineField
              label={`${languageLabel(edition.lang)} translation`}
              multiline
              rows={1}
              value={edition.text ?? ''}
              maxLength={DOC_LIMITS.translationChars}
              placeholder={`Not translated yet — type the ${languageLabel(edition.lang)} line`}
              onCommit={(text) => text.trim() && text !== edition.text && edition.onCommit(text.slice(0, DOC_LIMITS.translationChars))}
              inputClassName="text-[13px]"
            />
          </CountedField>
        </div>
      )}
    </div>
  );
};

const PanelEditor: React.FC<{
  doc: ComicDoc;
  page: Page;
  panel: Panel;
  selectedLine: string | null;
  onSelectLine: (id: string | null) => void;
  patch: (ops: DocOp[]) => void;
  edition?: { lang: string; texts: Record<string, string | undefined>; onCommit(lineId: string, text: string): void };
}> = ({ doc, page, panel, selectedLine, onSelectLine, patch, edition }) => {
  const [added, setAdded] = useState<string | null>(null);
  const addLine = () => {
    const id = newId('ln');
    const speaker = panel.castIds[0];
    patch([
      {
        op: 'line',
        pageId: page.id,
        panelId: panel.id,
        id,
        patch: speaker ? { kind: 'speech', speakerId: speaker, text: '' } : { kind: 'caption', text: '' }
      }
    ]);
    setAdded(id);
    onSelectLine(id);
  };
  return (
    <section aria-label={`Panel ${panel.n}`} className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-2.5">
      <header className="mb-1 flex min-w-0 items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--ds-well-strong)] text-[10.5px] font-semibold tabular-nums text-[var(--ds-muted)]">
          {panel.n}
        </span>
        <p className="min-w-0 truncate text-[11.5px] text-[var(--ds-muted)]">
          {SIZE_LABEL[panel.size] || panel.size} · {SHOT_LABEL[panel.shot] || panel.shot}
          {panel.castIds.length ? ` · ${panel.castIds.map((id) => castName(doc, id)).join(', ')}` : ' · no one'}
        </p>
      </header>
      <InlineField
        label={`Panel ${panel.n} action`}
        multiline
        value={panel.action}
        placeholder="What we see in this panel"
        onCommit={(action) => patch([{ op: 'panel', pageId: page.id, id: panel.id, patch: { action } }])}
        inputClassName="text-[12.5px]"
      />
      <div className="mt-1.5 space-y-1.5">
        {panel.lines.map((line) => (
          <LineRow
            key={line.id}
            doc={doc}
            page={page}
            panel={panel}
            line={line}
            selected={selectedLine === line.id}
            autoFocus={added === line.id}
            onSelect={() => onSelectLine(line.id)}
            patch={patch}
            edition={edition && !line.noTranslate ? { lang: edition.lang, text: edition.texts[line.id], onCommit: (t) => edition.onCommit(line.id, t) } : undefined}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addLine}
        className="tap-target mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
      </button>
    </section>
  );
};

// ── Editor body ──────────────────────────────────────────────────────────────

interface ToolsState {
  open: boolean;
  detent: ToolsDetent;
  side: boolean;
}

interface EditorBodyProps {
  studio: StudioController;
  doc: ComicDoc;
  page: Page;
  layout: EditorLayout;
  /** Edition being edited (a translated language), or null for the original. */
  edition: string | null;
  onEdition(lang: string | null): void;
  tools: ToolsState;
  onTools(patch: Partial<ToolsState>): void;
  /** The Pro shell (useProEditor in the page editor): the view, the tool and the mounted parts. */
  pro: ProEditorState;
  /** The stage's zoom, for the Pro top bar. */
  onZoom?(zoom: number): void;
}

const EditorBody: React.FC<EditorBodyProps> = ({ studio, doc, page: sourcePage, layout, edition, onEdition, tools, onTools, pro, onZoom }) => {
  const [mode, setMode] = useState<Mode>('move');
  const [region, setRegion] = useState<Box | null>(null);
  const [instruction, setInstruction] = useState('');
  const [panelN, setPanelN] = useState<number | undefined>(undefined);
  const [lettering, setLettering] = useState(true);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  /** The stage's fit box with no sheet over it (the image variant is chosen from this, never the shrunk stage). */
  const [restingStageRef, restingStage] = useElementSize<HTMLDivElement>();
  const [bodyRef, body] = useElementSize<HTMLDivElement>();
  const pageBoxRef = useRef<HTMLDivElement>(null);
  const stageBoxRef = useRef<HTMLDivElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const inspectorHostRef = useRef<HTMLDivElement>(null);
  const versionsRef = useRef<HTMLElement>(null);
  const [addKind, setAddKind] = useState<LineKind | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [inspectorClosed, setInspectorClosed] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [menu, setMenu] = useState<{ lineId: string; at: { x: number; y: number } } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [zoomReset, setZoomReset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [coverInset, setCoverInset] = useState(0);
  /** Phones: how far (px) the page slides up so the selection clears the lettering sheet (0 = holds still). */
  const [slide, setSlide] = useState(0);
  const slideRef = useRef(0);
  slideRef.current = slide;
  /** Phones: the lettering sheet's height cap, so the page above it keeps at least MIN_STAGE_PX. */
  const [inspectorMaxH, setInspectorMaxH] = useState<number | undefined>(undefined);
  /** Dual-screen: the floating inspector stays on the tools segment (never across the hinge, never clipped by the grid). */
  const foldGridRef = useRef<HTMLDivElement>(null);
  /** Every other layout: its root (it clips — overflow-hidden — so the floating inspector stays inside it). */
  const layoutRootRef = useRef<HTMLDivElement>(null);
  const [inspectorBounds, setInspectorBounds] = useState<Rect | null>(null);
  const ff = useFormFactor();
  const [coach, setCoach] = useState(() => ff.coarse && readFlag(COACH_KEY) !== '1');
  const { busyKey, fire } = useClickGuard(2500);
  const byok = studio.caps ? !!studio.caps.byok : byokFromDoc(doc);
  const cost = useEditorCost(byok);
  const status = pageVisualStatus(doc, sourcePage);
  const busy = isBusy(sourcePage.render);
  const drawn = hasImage(sourcePage.render);
  // A take that failed the content check is never shown or sent anywhere: it can be redrawn safer,
  // re-checked or swapped for an earlier version — not marked up, AI-edited, fitted or lettered.
  const artBlocked = drawn && !canServeToOwner(sourcePage.render.asset);
  const artOk = drawn && !artBlocked;
  const target: RenderTarget = useMemo(() => ({ kind: 'page', id: sourcePage.id }), [sourcePage.id]);
  const overlayLettering = doc.format.lettering === 'overlay';
  const boxes = useMemo(() => panelBoxesFor(doc, sourcePage), [doc, sourcePage]);
  const [loadedAspect, setLoadedAspect] = useState(0);
  const aspect = loadedAspect || pageAspectOf(doc, sourcePage);
  const editPrice = estimateOne(doc, 'edit', byok).usd;
  const renderPrice = estimateDraw(doc, pagesForIds(doc, [sourcePage.id]), byok).estimate.usd;
  const spec = jobModel(doc, 'page');
  const versions = useMemo(() => versionCount(doc, target), [doc, target]);
  const mismatch = aspectMismatch(doc, sourcePage.render.asset);
  const rating = effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const phone = layout.toolbar !== 'top';

  // ── Edition (translated language) view ──
  const lang = isEditionLang(doc, edition) ? edition : undefined;
  const vDoc = useMemo(() => (lang ? editionViewDoc(doc, lang) : doc), [doc, lang]);
  const page = useMemo(() => vDoc.pages.find((p) => p.id === sourcePage.id) ?? sourcePage, [vDoc, sourcePage]);
  const sourceName = languageLabel(doc.format.language);
  const switchOptions = useMemo(() => languageSwitchOptions(doc), [doc]);
  const editionTexts = useMemo(() => {
    if (!lang) return {};
    const lines = i18nOf(doc).editions[lang]?.lines || {};
    return Object.fromEntries(Object.entries(lines).map(([id, t]) => [id, t.text]));
  }, [doc, lang]);

  // Fit the page inside the stage's CONTENT box (measured directly — outside the zoom transform — so
  // pinch-zooming never feeds back into the fit; no padding arithmetic).
  const pageWidth = fitPageToStage({ w: stage.width, h: stage.height }, aspect, 0);

  const patch = useCallback((ops: DocOp[]) => void studio.patch(ops), [studio]);
  /** Lettering edits: free, undoable, labelled ("Undo move balloon"). In an edition they land in it. */
  const apply = useCallback(
    (ops: DocOp[], opts?: PatchOptions) => {
      if (!ops.length) return;
      if (lang) {
        const r = editionOps(ops, lang, doc);
        if (r.dropped) setNotice(`That change belongs to the original (${sourceName}) — switch to ${sourceName} to make it.`);
        if (r.ops.length) void studio.patch(r.ops, { undo: true, ...opts });
        return;
      }
      void studio.patch(ops, { undo: true, ...opts });
      // A balloon whose text was cleared keeps its (empty) line: say so, and where it went (LE-11).
      if (ops.some((o) => o.op === 'line' && !!o.patch && typeof o.patch.text === 'string' && !o.patch.text.trim()))
        setNotice('The balloon’s text is empty, so it is hidden — its line stays in the script (Page tools). Type it again there, Delete it, or Undo.');
    },
    [studio, lang, doc, sourceName]
  );
  /**
   * One balloon's move / resize / tail aim: the undo entry is named for what it did (LE-8) and a resize
   * then a move within the coalesce window stay two entries (the gesture is part of the coalesce key).
   */
  const onBalloonChange = useCallback(
    (lineId: string, p: Partial<Balloon>, opts?: BalloonChangeOptions) => {
      const label = opts?.label || 'Move balloon';
      const gesture = opts?.gesture || 'move';
      if (opts?.lang) {
        const r = editionOps([{ op: 'balloon', pageId: sourcePage.id, lineId, patch: p }], opts.lang, doc);
        if (r.ops.length) void studio.patch(r.ops, { undo: true, label, coalesce: `edition_balloon:${gesture}:${opts.lang}:${sourcePage.id}:${lineId}` });
        return;
      }
      void studio.patch([{ op: 'balloon', pageId: sourcePage.id, lineId, patch: p }], { undo: true, label, coalesce: `balloon:${gesture}:${sourcePage.id}:${lineId}` });
    },
    [studio, sourcePage.id, doc]
  );
  /** A "don't translate" line reads in the original in every edition: a translation of it would never show. */
  const keepsSource = useCallback(
    (lineId: string) => !!lang && sourcePage.panels.some((p) => p.lines.some((l) => l.id === lineId && l.noTranslate === true)),
    [lang, sourcePage.panels]
  );
  const keepsSourceNotice = useCallback(
    () => setNotice(`This line stays in ${sourceName} in every language (it is marked “don’t translate”). Switch to ${sourceName} to change it.`),
    [sourceName]
  );
  const onEditionText = useCallback(
    (lineId: string, text: string) => {
      if (!lang) return;
      if (keepsSource(lineId)) {
        keepsSourceNotice();
        return;
      }
      const op = translationEditOp(doc, lang, sourcePage.id, lineId, text);
      if (op) void studio.patch([op], { undo: true, label: 'Edit translation' });
    },
    [studio, doc, lang, sourcePage.id, keepsSource, keepsSourceNotice]
  );
  /** Open the inline text editor on a balloon (in an edition, never on a line that stays in the original). */
  const startEditing = useCallback(
    (lineId: string | null) => {
      if (lineId && keepsSource(lineId)) {
        keepsSourceNotice();
        return;
      }
      setEditingLineId(lineId);
    },
    [keepsSource, keepsSourceNotice]
  );

  // ── Lettering: plans, selection, inspector ──────────────────────────────
  const canPro = studio.caps?.proEditor !== false;
  // Flag off: exactly today (studio.mode). Flag on: the shell's view (D7 on phones), switched through the shell.
  const viewMode: StudioMode = pro.on ? pro.view : canPro ? studio.mode ?? 'easy' : 'easy';
  const setViewMode = (m: StudioMode) => (pro.on ? pro.setView(m) : studio.setMode?.(m));
  // ── The Pro workspace (PE-SHELL): docked from 1024 px, a tool row on tablets, today's layout on phones ──
  const ws = proWorkspaceFor(layout, ff.width);
  const docked = pro.pro && ws.kind === 'docked';
  const toolRow = pro.pro && ws.kind === 'tool-row';
  const railed = docked || toolRow;
  const tool: ProTool = pro.pro ? pro.tool : 'select';
  const proRef = useRef(pro);
  proRef.current = pro;
  const dockRef = useRef<HTMLElement>(null);
  const [dockTab, setDockTab] = useState<DockTabId>('properties');
  const [leftTab, setLeftTab] = useState<'layers' | 'assets'>('layers');
  const [layersSheet, setLayersSheet] = useState(false);
  const { plans, placements, measure, H } = useLetterPlans(vDoc, page, aspect);
  const validIds = useMemo(() => page.panels.flatMap((p) => p.lines.map((l) => l.id)), [page.panels]);
  const panelOf = useCallback((id: string) => page.panels.find((p) => p.lines.some((l) => l.id === id))?.n, [page.panels]);
  // "Show me" (the conflict card, agent-editor plan §3 A3) opens this page and sets studio.selection on its balloon. An
  // editor that opens then starts with that balloon selected instead of clearing it; one already open (desktop: the
  // chat beside the board) selects it when the request arrives. Our own mirror of the selection reads back the same ids
  // and changes nothing; ids not on this page are ignored.
  const shown = studio.selection;
  const requestedLineIds = shown && shown.pageId === page.id && shown.surface === 'page_editor' ? shown.lineIds : undefined;
  const selection = useLetteringSelection({ pageId: page.id, validIds, setStudioSelection: studio.setSelection, panelOf, initial: requestedLineIds });
  const requestedKey = requestedLineIds?.join('|') ?? '';
  const lastRequestedRef = useRef(requestedKey);
  useEffect(() => {
    if (requestedKey === lastRequestedRef.current) return;
    lastRequestedRef.current = requestedKey;
    const ids = requestedLineIds?.filter((id) => validIds.includes(id)) ?? [];
    if (ids.length && ids.join('|') !== selection.ids.join('|')) selection.set(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedKey]);
  const selectedLine = selection.primary;
  const selectionKey = selection.ids.join('|');
  useEffect(() => setInspectorClosed(false), [selectionKey]);
  // The Hand tool pans and the Shapes tool places a shape: the balloons stay put under them.
  const letteringEditable = mode === 'move' && overlayLettering && !busy && artOk && !(pro.pro && (tool === 'hand' || tool === 'shapes'));
  const tidy = useMemo(() => (overlayLettering ? tidyOps(vDoc, page, aspect, measure) : []), [overlayLettering, vDoc, page, aspect, measure]);
  const outsideCount = plans.filter((p) => p.outOfSafeArea && !p.locked).length;
  // The drawn plans say which balloons are crowded (the editor's own placement may flag a line the drawn
  // page fits fine); a line with no plan (no text) keeps the placement's flag.
  const crowdedIds = useMemo(() => {
    const planned = new Set(plans.map((p) => p.lineId));
    return [...new Set([...plans.filter((p) => p.crowded).map((p) => p.lineId), ...[...placements.crowded].filter((id) => !planned.has(id))])];
  }, [plans, placements]);
  const overflowIds = plans.filter((p) => p.overflow).map((p) => p.lineId);
  // Dense page: the renderer lettered the software-placed balloons smaller so nothing overlaps.
  const dense = plans.filter((p) => typeof p.densityScale === 'number' && p.densityScale < 1);
  const densityPct = dense.length ? Math.round(Math.min(...dense.map((p) => p.densityScale as number)) * 100) : 100;
  // Letter fit (plan §10 A4): a panel with too much text for its picture, and a page whose check has no face data
  // (balloons may sit on heads): placement around the art (free) or by reading the page again (paid, quoted).
  const tooMuchText = densePanels(plans).length > 0;
  const placementFix = overlayLettering && artOk && !busy && plans.length > 0 && !hasFaceData(sourcePage);
  // The balloon menu is the one surface while it is open: the inspector (a second sheet on phones, which
  // would also re-fit the page under the menu) waits until it closes ("Style…" then shows it).
  const inspectorOpen = letteringEditable && lettering && selection.ids.length > 0 && !inspectorClosed && !editingLineId && !menu;
  const compactInspectorOpen = inspectorOpen && layout.compactInspector;

  const chooseAddKind = (kind: LineKind | null) => {
    if (kind && lang) {
      setNotice(`New lines start in the original (${sourceName}). Switch to ${sourceName} to add one, then translate it.`);
      return;
    }
    setAddKind(kind);
  };
  const onAddAt = (kind: LineKind, point: { x: number; y: number }) => {
    const { ops, id } = addLineAtOps(doc, sourcePage, kind, point, aspect);
    const withText = ops.map((op) => (op.op === 'line' && op.patch ? { ...op, patch: { ...op.patch, text: NEW_LINE_TEXT[kind] } } : op));
    apply(withText, { label: `Add ${LINE_KIND_LABEL[kind].toLowerCase()}` });
    setAddKind(null);
    setTrayOpen(false);
    if (pro.pro && isLetteringTool(pro.tool)) settleTool('select');
    selection.select(id);
    setEditingLineId(id);
  };

  // ── Pro: the tool drives today's mode and "add" state (one engine; the rail is another way in) ──
  /** The tool the editor last applied (a change from elsewhere, a key or the rail, is applied once). */
  const appliedTool = useRef<ProTool | null>(null);
  /** The editor finished with a tool (a balloon placed, Esc, a mark-up sent): back to Select, without re-applying. */
  const settleTool = (t: ProTool) => {
    appliedTool.current = t;
    proRef.current.setTool(t);
  };
  useEffect(() => {
    if (!pro.pro) {
      appliedTool.current = null;
      return;
    }
    if (appliedTool.current === pro.tool) return;
    appliedTool.current = pro.tool;
    const t = pro.tool;
    if (t === 'markup') {
      if (!artOk || busy) return;
      setMode('markup');
      setAddKind(null);
      setTrayOpen(false);
      return;
    }
    setMode('move');
    if (isLetteringTool(t)) {
      if (lang || !overlayLettering) {
        chooseAddKind(TOOL_LINE_KIND[t]);
        settleTool('select');
        return;
      }
      setAddKind(TOOL_LINE_KIND[t]);
      return;
    }
    setAddKind(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pro.pro, pro.tool]);

  // ⌘A (Pro): every balloon on the page, from anywhere in the editor but a field (a focused balloon handles it itself).
  useEffect(() => {
    if (!pro.pro || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target) || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== 'a' && e.key !== 'A')) return;
      if (!letteringEditable) return;
      e.preventDefault();
      selection.set(plans.map((p) => p.lineId).filter((id) => validIds.includes(id)).sort((a, b) => validIds.indexOf(a) - validIds.indexOf(b)));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pro.pro, letteringEditable, plans, validIds, selection]);

  // Presence (A4): the balloons on this page the director is editing right now.
  const presence = studio.presence;
  const presenceKey = presence ? presence.lineIds.join('|') : '';
  const presenceIds = useMemo(() => {
    if (!presence || (presence.pageId && presence.pageId !== sourcePage.id)) return undefined;
    const ids = presence.lineIds.filter((id) => validIds.includes(id));
    return ids.length ? new Set(ids) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceKey, presence?.pageId, sourcePage.id, validIds]);
  const balloonExtras: BalloonEditorExtras = useMemo(
    () => (pro.pro || presenceIds ? { transform: pro.pro, keyboard: pro.pro, presenceLineIds: presenceIds } : NO_BALLOON_EXTRAS),
    [pro.pro, presenceIds]
  );

  // Inspector anchor: the selection's outline bounds on screen (recomputed on resize/scroll/zoom).
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bump = () => setViewportTick((t) => t + 1);
    window.addEventListener('resize', bump);
    window.addEventListener('scroll', bump, true);
    return () => {
      window.removeEventListener('resize', bump);
      window.removeEventListener('scroll', bump, true);
    };
  }, []);
  /** The selection's outline bounds in viewport px (through the zoom transform), or null. */
  const selectionRect = (): Rect | null => {
    const el = pageBoxRef.current;
    const sel = plans.filter((p) => selection.ids.includes(p.lineId));
    if (!el || !sel.length) return null;
    const r = el.getBoundingClientRect();
    const outlines = sel.map((p) => outlineFractions(p, H));
    return {
      left: r.left + Math.min(...outlines.map((b) => b.x)) * r.width,
      top: r.top + Math.min(...outlines.map((b) => b.y)) * r.height,
      right: r.left + Math.max(...outlines.map((b) => b.x + b.w)) * r.width,
      bottom: r.top + Math.max(...outlines.map((b) => b.y + b.h)) * r.height
    };
  };
  useLayoutEffect(() => {
    const next = selectionRect();
    if (!next) {
      setAnchor(null);
      return;
    }
    setAnchor((cur) => (cur && Math.abs(cur.left - next.left) < 0.5 && Math.abs(cur.top - next.top) < 0.5 && Math.abs(cur.right - next.right) < 0.5 && Math.abs(cur.bottom - next.bottom) < 0.5 ? cur : next));
  }, [plans, selectionKey, H, viewportTick, pageWidth, stage.width, stage.height, zoom, coverInset, slide]); // eslint-disable-line react-hooks/exhaustive-deps

  // The floating inspector stays inside the editor's layout (which clips its overflow): on dual-screen
  // layouts on the tools segment (the far side of the hinge from the page) — never across the fold — and
  // in every other layout inside the layout root (phone landscape: below the header, not under it).
  const foldSplit = layout.kind === 'fold-book' || layout.kind === 'fold-tabletop' ? layout.split : undefined;
  useLayoutEffect(() => {
    // Pro, docked: the lettering panel (until the inspector part docks itself) stays in the dock column, never over the page.
    const root = foldSplit ? foldGridRef.current : docked ? dockRef.current : layoutRootRef.current;
    if (!root || !inspectorOpen || layout.compactInspector) {
      setInspectorBounds((cur) => (cur === null ? cur : null));
      return;
    }
    const r = root.getBoundingClientRect();
    const offset = foldSplit ? foldSplit.first + foldSplit.gap : 0;
    const next: Rect = !foldSplit
      ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      : foldSplit.axis === 'rows'
        ? { left: r.left, top: r.top + offset, right: r.right, bottom: r.bottom }
        : { left: r.left + offset, top: r.top, right: r.right, bottom: r.bottom };
    setInspectorBounds((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.right === next.right && cur.bottom === next.bottom ? cur : next));
  }, [layout.kind, foldSplit?.axis, foldSplit?.first, foldSplit?.gap, inspectorOpen, viewportTick, docked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Phones: the lettering inspector is a bottom sheet over the stage's foot. Shrink the stage by what it
  // covers, so the whole page — and the selected balloon — stays above it. The sheet itself is capped so
  // the page keeps MIN_STAGE_PX: a page squeezed to 100 px has no tappable balloons left (its own content
  // scrolls instead).
  useLayoutEffect(() => {
    if (!compactInspectorOpen) {
      setCoverInset(0);
      setSlide(0);
      setInspectorMaxH(undefined);
      return;
    }
    const host = inspectorHostRef.current;
    const stageBox = stageBoxRef.current;
    const sheet = host?.querySelector<HTMLElement>('[data-testid="lettering-inspector"]');
    if (!sheet || !stageBox) return;
    const measureCover = () => {
      const stageRect = stageBox.getBoundingClientRect();
      const sheetTop = sheet.getBoundingClientRect().top;
      setInspectorMaxH(inspectorSheetMaxHeight(stageRect.top, window.innerHeight));
      setCoverInset(coveredByBottomSheet(stageRect.bottom - restingInsetRef.current, sheetTop));
      // Measured where the page would be without the slide (the selection rect includes the current one).
      const sel = selectionRect();
      if (!sel) return;
      const top0 = sel.top + slideRef.current;
      const bottom0 = sel.bottom + slideRef.current;
      setSlide(selectionSlide({ top: top0, bottom: bottom0 }, stageRect.top, sheetTop));
    };
    measureCover();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measureCover);
    ro.observe(sheet);
    ro.observe(stageBox);
    return () => ro.disconnect();
  }, [compactInspectorOpen, selectionKey, viewportTick]);

  // Zoomed in, and a NEW selection (picked from the script, say) or a sheet that just opened leaves the
  // selected balloon off screen: ease back to fit, where the whole page — and the balloon — is visible.
  // Pinching or panning never triggers this (only a selection or sheet change does).
  useLayoutEffect(() => {
    if (zoom <= 1.01) return;
    const sel = selectionRect();
    const area = canvasAreaRef.current?.getBoundingClientRect();
    if (sel && area && area.width > 0 && selectionOutOfView(sel, area)) setZoomReset((n) => n + 1);
  }, [selectionKey, coverInset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc steps back: cancel "add", close the menu or tray, then deselect, before the dialog's Esc closes the editor.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editingLineId || menu) return;
      if (addKind) {
        e.preventDefault();
        e.stopPropagation();
        setAddKind(null);
        if (proRef.current.pro && isLetteringTool(proRef.current.tool)) settleTool('select');
      } else if (trayOpen && !isEditableTarget(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        setTrayOpen(false);
      } else if (selection.ids.length && !isEditableTarget(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        selection.clear();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [addKind, editingLineId, selection, trayOpen, menu]);

  // The top bar shows the stage's zoom (Pro).
  useEffect(() => {
    onZoom?.(zoom);
  }, [zoom, onZoom]);

  // A transient notice clears itself (no network; a local timer only).
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const markRegion = (box: Box) => {
    setRegion(box);
    setPanelN(panelForRegion(box, boxes));
  };
  const clearRegion = () => {
    setRegion(null);
    setPanelN(undefined);
  };
  const changeMode = (m: Mode) => {
    setMode(m);
    setAddKind(null);
    if (m === 'markup') setTrayOpen(false);
    if (pro.pro && railed) settleTool(m === 'markup' ? 'markup' : 'select');
  };

  const canEdit = artOk && !busy && instruction.trim().length > 0;
  const submitEdit = () => {
    if (!canEdit) return;
    const action = editActionFor(sourcePage.id, instruction, region, panelN);
    fire('edit', () => studio.act(action));
    setInstruction('');
    clearRegion();
    setMode('move');
    if (pro.pro && tool === 'markup') settleTool('select');
  };
  /** Pro, the Shapes tool: a rectangle overlay where the page was clicked (B9 resolveDrop; kept in the panel it lands in). */
  const placeShape = (point: { x: number; y: number }) => {
    const r = resolveDrop(doc, sourcePage, { kind: 'shape', shape: 'rect' }, { point });
    if (r.ok === false) {
      setNotice((r as { reason: string }).reason);
      return;
    }
    // Overlays belong to every language (the art is shared), so this is never an edition edit.
    void studio.patch(r.ops, { undo: true, label: r.label });
    settleTool('select');
  };
  const pickVersions = () => {
    if (docked) setDockTab('ai');
    if (layout.tools === 'sheet') onTools({ open: true, detent: 'full' });
    if (layout.tools === 'side') onTools({ side: true });
    requestAnimationFrameSafe(() => {
      versionsRef.current?.scrollIntoView?.({ block: 'start', behavior: ff.reducedMotion ? 'auto' : 'smooth' });
      versionsRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
    });
  };
  const closeEditorTo = (tab: 'story' | 'languages') => {
    studio.setTab(tab);
    studio.openPage(null);
  };

  // ── Balloon menu (long-press / right-click / Menu key) ──
  const menuItems = (lineId: string): ContextMenuItem[] => {
    const locked = !!plans.find((p) => p.lineId === lineId)?.locked;
    const inOriginal = lang ? `In ${sourceName}` : undefined;
    return [
      {
        id: 'edit',
        label: lang ? 'Edit translation' : 'Edit text',
        icon: <PencilLine className="h-4 w-4" />,
        disabled: keepsSource(lineId),
        hint: keepsSource(lineId) ? `Stays in ${sourceName}` : undefined,
        onSelect: () => {
          selection.select(lineId);
          startEditing(lineId);
        }
      },
      {
        id: 'style',
        label: 'Style…',
        icon: <Palette className="h-4 w-4" />,
        hint: 'Free',
        onSelect: () => {
          selection.select(lineId);
          setInspectorClosed(false);
        }
      },
      { id: 'duplicate', label: 'Duplicate', icon: <Copy className="h-4 w-4" />, disabled: !!lang, hint: inOriginal, onSelect: () => apply(duplicateLineOps(sourcePage, lineId, placements.balloons), { label: 'Duplicate balloon' }) },
      { id: 'front', label: 'Bring to front', icon: <Layers className="h-4 w-4" />, onSelect: () => apply(zOrderOps(page, [lineId], 'front', plans, placements.balloons), { label: 'Bring to front' }) },
      { id: 'back', label: 'Send to back', icon: <Layers className="h-4 w-4 rotate-180" />, onSelect: () => apply(zOrderOps(page, [lineId], 'back', plans, placements.balloons), { label: 'Send to back' }) },
      {
        id: 'lock',
        label: locked ? 'Unlock' : 'Lock',
        icon: locked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />,
        // Locking a dense page's balloon keeps the size it is drawn at (one patch with the lock).
        onSelect: () =>
          apply(locked ? lockOps(page, [lineId], false, placements.balloons) : pinKeepingSizeOps(lockOps(page, [lineId], true, placements.balloons), page, plans, [lineId], lang), {
            label: locked ? 'Unlock balloon' : 'Lock balloon'
          })
      },
      {
        id: 'reset',
        label: lang ? `Reset position (follow ${sourceName})` : 'Reset position (auto)',
        icon: <RotateCcw className="h-4 w-4" />,
        hint: 'Free',
        disabled: locked,
        onSelect: () =>
          lang
            ? void studio.patch([{ op: 'edition_balloon', lang, lineId, patch: null }], { undo: true, label: 'Reset balloon position' })
            : apply(resetPositionOps(doc, sourcePage, [lineId], aspect, measure), { label: 'Reset balloon position' })
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        disabled: !!lang,
        hint: inOriginal,
        onSelect: () => {
          apply(deleteLinesOps(sourcePage, [lineId]), { label: 'Delete balloon' });
          selection.clear();
        }
      }
    ];
  };

  const qc = sourcePage.render.qc;
  const issues = qc?.issues?.filter(Boolean) || [];
  const safety = drawn
    ? {
        rating,
        onRedrawSafer: () => fire('safer', () => studio.act({ type: 'render_pages', pageIds: [sourcePage.id], force: true, safe: true })),
        // A safe redraw is this page's forced render: the same quote as Redraw, in this user's terms
        // (governed users read a share of their usage, never dollars).
        redrawPrice: cost(renderPrice),
        onCheckAgain: () => fire('recheck', () => studio.act({ type: 'safety_recheck', target })),
        onChangeRating: () => closeEditorTo('story')
      }
    : undefined;

  // ── Stage geometry ──
  const sheetHeights = toolsSheetHeights(body.height);
  // Phones may close the sheet (the toolbar reopens it); tablets have no toolbar, so theirs always shows.
  const sheetShown = layout.tools === 'sheet' && (tools.open || layout.kind !== 'phone') && !compactInspectorOpen;
  const sheetInset = sheetShown ? sheetHeights[tools.detent] : 0;
  // Phones: the lettering sheet OVERLAYS the stage. The page holds still under the finger that selected a
  // balloon (no re-fit, no re-centre — the finger's next move is a drag of that balloon); it only slides
  // up (`slide`) when the selection would sit under the sheet. The stage keeps the inset it had before.
  const restingInsetRef = useRef(0);
  if (!compactInspectorOpen) restingInsetRef.current = sheetInset;
  const stageInset = compactInspectorOpen ? restingInsetRef.current : sheetInset;
  // The image variant follows the page's size with NO sheet over the stage: opening the lettering
  // inspector or moving the tools sheet between detents never swaps in (and downloads) a smaller file.
  const restingPageWidth = fitPageToStage({ w: restingStage.width, h: restingStage.height }, aspect, 0);
  const imgWidth = editorImageWidth(ff, zoom, restingPageWidth, devicePixelRatioNow());
  const imageUrl = imgWidth ? studio.urlFor(sourcePage.render.asset, { width: imgWidth }) : studio.urlFor(sourcePage.render.asset);
  const trayAvailable = letteringEditable && phone;
  const attention = outsideCount + overflowIds.length + crowdedIds.length;

  // ── Pieces ──
  const undoPill = (
    <span className="inline-flex items-center gap-0.5" role="group" aria-label="Undo and redo">
      <IconButton size="sm" className="tap-target" label={studio.undoLabel ? `Undo ${studio.undoLabel}` : 'Undo'} disabled={!studio.canUndo} onClick={() => studio.undo?.()}>
        <Undo2 className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
      <IconButton size="sm" className="tap-target" label="Redo" disabled={!studio.canRedo} onClick={() => studio.redo?.()}>
        <Redo2 className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
    </span>
  );

  const recheckUsd = recheckQuoteUsd(byok);
  const placeAroundArt = () =>
    fire('placement', async () => {
      const cells = await loadBusyGrid(studio.urlFor(sourcePage.render.asset, { width: BUSY_GRID_SIDE * 2 }));
      const ops = reletterAroundArtOps(doc, sourcePage, aspect, measure, cells);
      if (ops.length) apply(ops, { label: 'Place balloons around the art' });
      setNotice(
        !cells.length
          ? 'This drawing couldn’t be read here, so the balloons were placed from the panels alone (free). To keep them off faces, use Fix balloon placement.'
          : ops.length
            ? 'Balloons placed around the busy parts of the art (free). Balloons you moved stay put — Undo puts the others back.'
            : 'The balloons already sit clear of the busy parts of the art.'
      );
    });
  // Easy, flag on: a balloon made in Pro folds its advanced settings into one chip (zero-confusion rule 2).
  const madeChip = pro.on && !pro.pro && letteringEditable && lettering && selection.ids.length > 0 && madeInPro(sourcePage, selection.ids);
  const chips = (
    <>
      {letteringEditable && lettering && crowdedIds.length > 0 && (
        <button
          type="button"
          data-testid="crowded-chip"
          onClick={() => selection.select(crowdedIds[0])}
          className={`tap-target inline-flex min-w-0 items-center gap-1 ${RADIUS_PILL} border ${TONE_CHIP.warning} px-2 py-0.5 text-[11.5px] font-medium hover:bg-[var(--ds-hover)]`}
          title="A balloon couldn’t find free space in its panel — free fixes in the lettering panel"
        >
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">Crowded panel{crowdedIds.length > 1 ? ` (${crowdedIds.length})` : ''}</span>
        </button>
      )}
      {letteringEditable && lettering && dense.length > 0 && (
        <button
          type="button"
          data-testid="density-chip"
          onClick={() => selection.set(dense.map((p) => p.lineId))}
          className={`tap-target inline-flex min-w-0 items-center gap-1 ${RADIUS_PILL} border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`}
          title="This page is dense: its auto-placed balloons are lettered smaller so none overlap — shorten lines or move some to another page to get the full size back (free)"
        >
          <Type className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">Dense page · text at {densityPct}%</span>
        </button>
      )}
      {letteringEditable && lettering && overflowIds.length > 0 && (
        <button
          type="button"
          data-testid="overflow-chip"
          onClick={() => selection.set(overflowIds)}
          className={`tap-target inline-flex min-w-0 items-center gap-1 ${RADIUS_PILL} border ${TONE_CHIP.warning} px-2 py-0.5 text-[11.5px] font-medium hover:bg-[var(--ds-hover)]`}
          title="The text doesn’t fit its balloon even at the smallest size — select to widen it or shorten the line (free)"
        >
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">
            {overflowIds.length === 1 ? 'Text doesn’t fit' : `Text doesn’t fit (${overflowIds.length})`}
            {lang ? ` in ${languageLabel(lang)}` : ''}
          </span>
        </button>
      )}
      {letteringEditable && lettering && tooMuchText && <TooMuchTextChip plans={plans} onSelect={(ids) => selection.set(ids)} />}
      {madeChip && (
        <button
          type="button"
          data-testid="made-in-pro-chip"
          onClick={() => pro.setView('pro')}
          className={`tap-target inline-flex min-w-0 items-center gap-1 ${RADIUS_PILL} border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`}
          title="This balloon uses Pro settings (rotation, height or a named style). Easy keeps them as they are; open Pro to change them."
        >
          <span className="truncate">{MADE_IN_PRO_CHIP}</span>
        </button>
      )}
      {letteringEditable && lettering && placementFix && (
        <PlacementFixChip
          price={cost(recheckUsd)}
          busy={busyKey === 'placement'}
          freeDisabled={lang ? `Switch to ${sourceName} to re-letter` : undefined}
          onFree={placeAroundArt}
          onPaid={() => fire('placement', () => studio.act({ type: 'recheck_page', pageId: sourcePage.id, quotedUsd: recheckUsd }))}
        />
      )}
    </>
  );

  const languageRow =
    switchOptions.length > 1 ? (
      <LanguageSwitch
        options={switchOptions}
        value={lang ?? doc.format.language}
        onChange={(code) => {
          setEditingLineId(null);
          setAddKind(null);
          onEdition(isEditionLang(doc, code) ? code : null);
        }}
        label="Edit which language"
        className="shrink-0"
      />
    ) : null;

  // Landscape phones: the stage is short (the page is height-bound), so the coach moves to the top of the
  // open side sheet instead of costing the page a third of its height.
  const coachInSide = layout.kind === 'phone-landscape' && tools.side;
  // Never toggled by a selection: a banner appearing or vanishing above the stage would move the page
  // under the finger that just selected a balloon (and is about to drag it).
  const coachInBanners = coach && !coachInSide;
  // Shown in the phone row, or (landscape) at the top of the side sheet.
  const coachEl = (
    <div data-testid="editor-coach" className={cx('flex min-w-0 basis-full items-center gap-2 border border-[var(--ds-hairline)] px-2.5 py-1.5', RADIUS_PANEL, ACCENT_SOFT_BG)}>
      <p className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--ds-ink)]">Tap a balloon to select, drag to move, pinch to zoom, long-press for more.</p>
      <button
        type="button"
        onClick={() => {
          setCoach(false);
          writeFlag(COACH_KEY, '1');
        }}
        // A real 44 px box on touch (fold5 measured 47x26): a ::after hit area here sat under the stage.
        className={cx('shrink-0 px-2 py-1 text-[12px] font-semibold text-[var(--ds-ink)] underline decoration-[var(--ds-hairline)] underline-offset-2 hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11 coarse:min-w-11 coarse:px-3', RADIUS_CONTROL, TRANSITION)}
      >
        Got it
      </button>
    </div>
  );

  // Pro tips: in the dock when docked (nothing moves over the page), above the stage elsewhere.
  const proCoachEl = pro.coach.open ? (
    <ProCoach
      cards={pro.coach.cards}
      onDismiss={pro.coach.dismiss}
      samples={pro.parts.samples}
      onSamples={() => (ws.leftRailW > 0 && pro.parts.assets ? setLeftTab('assets') : setDockTab('assets'))}
      className={docked ? 'mx-3 mt-3' : 'basis-full'}
    />
  ) : null;
  const proCoachInBanners = !!proCoachEl && !docked;
  const banners = (
    <>
      {lang && (
        <p data-testid="edition-banner" role="status" className="min-w-0 basis-full text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
          <Languages className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
          Editing the {languageLabel(lang)} edition. The art is shared by every language.
        </p>
      )}
      {notice && (
        <p role="status" className="min-w-0 basis-full rounded-lg bg-[var(--ds-well)] px-2 py-1 text-[12px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">
          {notice}
        </p>
      )}
      {coachInBanners && coachEl}
      {pro.pro && !overlayLettering && (
        <p data-testid="in-art-note" role="note" className="min-w-0 basis-full text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
          {IN_ART_LETTERING_NOTE}
        </p>
      )}
      {proCoachInBanners && proCoachEl}
    </>
  );

  const hint =
    mode === 'markup'
      ? 'Drag on the page to mark what should change.'
      : addKind
        ? `${phone ? 'Tap' : 'Click'} on the page to place the ${LINE_KIND_LABEL[addKind].toLowerCase()}${phone ? '' : ' · Esc cancels'}`
        : null;

  // Desktop / tablet mode row (today's position).
  const modeRow = (
    // gap-y-3: a wrapped line of chips keeps its 44 px ::after areas clear of the toolbar's above it.
    <div className={cx('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-3 px-4 pt-3', layout.kind === 'fold-tabletop' && 'pb-2')} data-testid="editor-mode-row">
      {!railed && (
        <Segmented<Mode>
          label="Editing mode"
          size="xs"
          value={mode}
          onChange={changeMode}
          options={[
            { value: 'move', label: (<><MousePointer2 className="h-3 w-3" aria-hidden /> {overlayLettering ? 'Lettering' : 'View'}</>) },
            { value: 'markup', label: (<><SquareDashed className="h-3 w-3" aria-hidden /> Mark up</>), disabled: !artOk }
          ]}
        />
      )}
      {region && (
        <GhostButton size="xs" onClick={clearRegion}>
          <X className="h-3 w-3" aria-hidden /> Clear mark
        </GhostButton>
      )}
      {overlayLettering && artOk && (
        <GhostButton size="xs" onClick={() => setLettering((v) => !v)} aria-pressed={!lettering}>
          {lettering ? <EyeOff className="h-3 w-3" aria-hidden /> : <Eye className="h-3 w-3" aria-hidden />}
          {lettering ? 'Hide lettering' : 'Show lettering'}
        </GhostButton>
      )}
      {letteringEditable && lettering && (
        <LetteringToolbar
          addKind={addKind}
          onAddKind={chooseAddKind}
          canUndo={!!studio.canUndo}
          canRedo={!!studio.canRedo}
          undoLabel={studio.undoLabel}
          onUndo={() => studio.undo?.()}
          onRedo={() => studio.redo?.()}
          onTidy={tidy.length ? () => apply(tidy, { label: 'Tidy balloons' }) : null}
          outsideCount={outsideCount}
          onFixEdges={() => apply(fixSafeAreaOps(vDoc, page, plans, H, placements.balloons), { label: 'Move balloons inside the safe area' })}
          mode={viewMode}
          onModeChange={setViewMode}
          canPro={canPro}
          // Flag on: the header's Easy | Pro switch is the one switch (the toolbar's duplicate goes). Pro with the rail:
          // adding lives on the rail and undo with its label in the top bar.
          showMode={!pro.on}
          showAdd={!railed}
          showUndo={!railed}
        />
      )}
      {!(letteringEditable && lettering) && !railed && undoPill /* Undo / redo stay one tap away in every mode. */}
      {letteringEditable && lettering && (crowdedIds.length > 0 || dense.length > 0 || overflowIds.length > 0 || tooMuchText || placementFix || madeChip) && (
        // The status chips move as one line (they shrink and truncate, never stack): a chip wrapped under
        // another put each one's 44 px area on its neighbour's (fold5 dense page).
        <span className="inline-flex min-w-0 max-w-full flex-nowrap items-center gap-1.5" data-testid="editor-chip-group">
          {chips}
        </span>
      )}
      {languageRow}
      <span className="ml-auto hidden text-[11px] text-[var(--ds-muted)] xl:inline">
        {hint ??
          (railed
            ? `${toolSpec(tool).label}: ${toolSpec(tool).hint} · Tab walks the balloons · ? lists every shortcut`
            : overlayLettering
              ? 'Drag balloons · Shift-click or drag a box to multi-select · double-click edits text · arrows nudge · right-click for more'
              : 'Lettering is drawn into the art on this comic.')}
      </span>
      {(lang || notice || coachInBanners || proCoachInBanners || (pro.pro && !overlayLettering)) && <div className="flex min-w-0 basis-full flex-wrap gap-1.5">{banners}</div>}
    </div>
  );

  // Phones: a slim row above the stage when there is something to say. While lettering is editable the
  // status chips (crowded / dense / overflow) get a line of their own with a FIXED height, kept even when
  // empty: they come and go with every edit, and a line that appeared (or wrapped) under a just-dropped
  // balloon re-fitted — shrank — the page, so the balloon no longer sat under the finger (iPhone 15: a
  // 60 px drag measured 52 px). The chips never wrap there; they shrink and truncate instead.
  const chipLine = letteringEditable && lettering;
  const phoneRowNeeded = !!(languageRow || region || hint || lang || notice || coachInBanners || chipLine || proCoachInBanners || (pro.pro && !overlayLettering));
  const phoneRow = phoneRowNeeded ? (
    <div className={cx('flex min-w-0 shrink-0 flex-wrap items-center gap-x-1.5 px-3', chipLine ? 'pt-0.5' : 'gap-y-1.5 pt-2')} data-testid="editor-phone-row">
      {languageRow}
      {region && (
        <GhostButton size="xs" onClick={clearRegion} className="tap-target">
          <X className="h-3 w-3" aria-hidden /> Clear mark
        </GhostButton>
      )}
      {chipLine && (
        // 44 px tall: each chip's 44 px ::after area lies inside the line, clear of the header above and
        // of the stage (or a banner) below.
        <div className="flex h-11 min-w-0 flex-1 basis-full flex-nowrap items-center gap-1.5" data-testid="editor-chip-line">
          {chips}
        </div>
      )}
      {hint && <p className="min-w-0 basis-full truncate text-[12px] text-[var(--ds-muted)]">{hint}</p>}
      {banners}
    </div>
  ) : null;

  const stageEl = (
    <div ref={stageBoxRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="editor-canvas-box">
      {/* Touch: 24 px of stage around the page, so a balloon's or a handle's 44 px target at the page edge is never clipped. */}
      <div ref={restingStageRef} aria-hidden className="pointer-events-none absolute inset-3 coarse:inset-6 sm:inset-6" data-testid="editor-resting-stage" />
      <div
        ref={canvasAreaRef}
        className={cx('absolute inset-x-0 top-0', TRANSITION, 'motion-reduce:transition-none')}
        style={{ bottom: stageInset, ...(slide ? { transform: `translateY(${-slide}px)` } : {}) }}
        data-slide={slide || undefined}
        data-testid="editor-canvas-area"
      >
        {/* Measured, never transformed: the fit box for the page. */}
        <div ref={stageRef} aria-hidden className="pointer-events-none absolute inset-3 coarse:inset-6 sm:inset-6" data-testid="editor-stage-content" />
        <TouchCanvas
          maxScale={5}
          resetKey={String(zoomReset)}
          onZoomChange={setZoom}
          suspendOneFinger={mode === 'markup'}
          controls={zoom > 1.01 || (pro.pro && tool === 'zoom')}
          // Pro: the Hand tool pans with one finger or the mouse at any zoom; the Zoom tool zooms on any wheel.
          oneFingerPan={pro.pro && tool === 'hand' ? 'always' : undefined}
          wheel={pro.pro && tool === 'zoom' ? 'always' : undefined}
          label={`Page ${sourcePage.n} — pinch or use + and − to zoom`}
        >
          <div className="absolute inset-3 flex min-w-0 items-center justify-center coarse:inset-6 sm:inset-6">
            <div ref={pageBoxRef} style={{ width: pageWidth ? `${pageWidth}px` : '100%', maxWidth: '100%' }} className={pro.on ? 'shadow-[shadow:var(--ds-shadow-overlay)]' : 'shadow-[0_10px_40px_rgba(0,0,0,0.25)]'}>
              <BalloonEditorExtrasContext.Provider value={balloonExtras}>
              <ComicPageView
                doc={vDoc}
                page={page}
                imageUrl={imageUrl}
                // The editor's hit layer reaches past the art (44 px halos and handles on edge balloons); the
                // stage (TouchCanvas) clips, the page box must not.
                className={letteringEditable ? 'overflow-visible' : undefined}
                editable={letteringEditable}
                onBalloonChange={onBalloonChange}
                onLetteringOps={apply}
                selectedLineIds={selection.ids}
                onSelectionChange={selection.set}
                editingLineId={editingLineId}
                onEditingChange={startEditing}
                addKind={letteringEditable && !lang ? addKind : null}
                onAddAt={onAddAt}
                onBalloonMenu={(lineId, at) => setMenu({ lineId, at })}
                editionLang={lang}
                markUntranslated={!!lang}
                onEditionTextChange={lang ? onEditionText : undefined}
                hideLettering={!lettering}
                loading="eager"
                develop={false}
                onAspectChange={setLoadedAspect}
                safety={safety}
                overlay={
                  <RenderOverlay
                    status={status}
                    since={sourcePage.render.updatedAt}
                    model={renderModelNickname(doc, busy ? undefined : sourcePage.render, 'page')}
                    typicalSec={spec.latencySec}
                    error={sourcePage.render.error}
                    overImage={drawn && !!imageUrl}
                    staleLabel="Out of date — re-render to apply"
                  />
                }
              >
                <MarkupLayer active={mode === 'markup' && artOk && !busy} region={region} panelN={panelN} onRegion={markRegion} />
                {pro.pro && tool === 'shapes' && pro.parts.compose && <ShapePlaceLayer onPlace={placeShape} />}
              </ComicPageView>
              </BalloonEditorExtrasContext.Provider>
            </div>
          </div>
        </TouchCanvas>
      </div>
      {phone && compactInspectorOpen && (
        // The inspector sheet covers the toolbar: keep undo / redo one tap away just above it.
        <div
          className="absolute left-2 z-[5] rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-0.5 shadow-[0_2px_10px_rgba(0,0,0,0.12)]"
          style={{ bottom: stageInset + coverInset + 8 }}
          data-no-canvas-gesture
          data-testid="editor-undo-float"
        >
          {undoPill}
        </div>
      )}
    </div>
  );

  const filmstrip = (
    <div className="min-w-0 shrink-0" data-testid="editor-filmstrip">
      <BookTimeline studio={studio} compact />
    </div>
  );

  // ── Tools ── (one section each, so the Pro dock can place them; today's tools sheet and aside keep this order)
  const aiSection = (
    <>
      {/* Edit with AI (peek) */}
      <section aria-labelledby="pe-ai">
        <SectionTitle id="pe-ai" icon={<WandSparkles className="h-3.5 w-3.5" />}>
          Edit with AI
        </SectionTitle>
        <label htmlFor="pe-instruction" className="sr-only">
          What should change?
        </label>
        <textarea
          id="pe-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submitEdit();
            }
          }}
          rows={phone ? 2 : 3}
          disabled={!artOk}
          placeholder={
            artBlocked
              ? 'This take didn’t fit the content rules, so it can’t be edited — redraw it safer, or use an earlier version below (free).'
              : drawn
                ? 'e.g. “Make it night with lanterns lit” or “Give Maya a red scarf”'
                : 'Render this page first — edits change an existing drawing.'
          }
          className="w-full resize-none rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[var(--ds-accent)] focus:outline-none disabled:opacity-60 coarse:text-[16px]"
        />
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          {region ? (
            <span
              data-testid="region-chip"
              className="inline-flex min-w-0 items-center gap-1 rounded-full border border-red-500/30 bg-red-500/[0.08] py-0.5 pl-2.5 pr-1 text-[12px] text-[var(--ds-ink)]"
            >
              <SquareDashed className="h-3 w-3 shrink-0 text-red-500" aria-hidden />
              <span className="truncate">{panelN ? `Marked area in panel ${panelN}` : 'Marked area'}</span>
              <button type="button" aria-label="Clear the marked area" onClick={clearRegion} className="tap-target grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-[var(--ds-hover)]">
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ) : (
            <GhostButton size="xs" disabled={!artOk || busy} onClick={() => changeMode('markup')}>
              <SquareDashed className="h-3 w-3" aria-hidden /> Mark an area
            </GhostButton>
          )}
          <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--ds-muted)]">
            Where
            <select
              aria-label="Panel to change"
              value={panelN ? String(panelN) : ''}
              onChange={(e) => setPanelN(e.target.value ? Number(e.target.value) : undefined)}
              className={SELECT_CLS}
              disabled={!artOk}
            >
              <option value="">Whole page</option>
              {sourcePage.panels.map((p) => (
                <option key={p.id} value={p.n}>
                  Panel {p.n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <PrimaryButton className="mt-3 w-full min-w-0" busy={busyKey === 'edit'} disabled={!canEdit} onClick={submitEdit}>
          <WandSparkles className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="shrink-0">Apply edit</span>
          <span className="min-w-0 truncate font-normal opacity-85">· {cost(editPrice)}</span>
        </PrimaryButton>
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--ds-muted)]">
          Only what you describe changes; the layout, other panels and characters stay. The previous version is kept below.
        </p>
      </section>

    </>
  );
  const actionsSection = (
    <>
      {/* Page actions (half): another take, or pick a version you already have (free) */}
      <section aria-label="Page actions" className="space-y-2">
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label={drawn ? 'Another take or a saved version' : 'Draw this page'}>
          <GhostButton
            size="sm"
            busy={busyKey === 'render'}
            disabled={busy || !sourcePage.panels.length}
            onClick={() => fire('render', () => studio.act({ type: 'render_pages', pageIds: [sourcePage.id], force: true }))}
            className="min-w-0"
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="shrink-0">{drawn ? 'Try another take' : 'Render page'}</span>
            <span className="min-w-0 truncate text-[var(--ds-muted)]">{cost(renderPrice)}</span>
          </GhostButton>
          {drawn && versions > 1 && (
            <GhostButton size="sm" onClick={pickVersions} className="min-w-0" data-testid="pick-versions">
              <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="truncate">Pick from {versions} versions</span>
              <span className={cx('shrink-0 font-semibold', TONE_TEXT.success)}>Free</span>
            </GhostButton>
          )}
          {overlayLettering && drawn && (
            <GhostButton
              size="sm"
              busy={busyKey === 'reletter'}
              disabled={busy}
              title="Place the balloons again automatically (balloons you moved stay put) — free"
              onClick={() => fire('reletter', () => studio.act({ type: 'relayout_balloons', pageId: sourcePage.id }))}
            >
              <Type className="h-3.5 w-3.5" aria-hidden /> Re-letter
            </GhostButton>
          )}
        </div>
        {artOk && mismatch && (
          <div data-testid="aspect-notice" className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-2.5 text-[12px] leading-snug text-[var(--ds-ink)]">
            <p>
              This page came back {mismatch.got}, but your book is {mismatch.want}. Fit it to {mismatch.want} for free (the art is padded or trimmed, never redrawn),
              or try another take at {mismatch.want}.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <PrimaryButton size="xs" busy={busyKey === 'fit'} disabled={busy} onClick={() => fire('fit', () => studio.act({ type: 'fit_render', target }))}>
                <Scaling className="h-3 w-3" aria-hidden /> Fit to {mismatch.want} · Free
              </PrimaryButton>
            </div>
          </div>
        )}
      </section>

    </>
  );
  const qcSection = (
    <>
      {/* QC */}
      {qc && (
        <section aria-labelledby="pe-qc">
          <SectionTitle id="pe-qc" icon={<TriangleAlert className="h-3.5 w-3.5" />} right={<span className="text-[11px] tabular-nums text-[var(--ds-muted)]">match {Math.round((qc.score || 0) * 100)}%</span>}>
            Quality check
          </SectionTitle>
          {issues.length ? (
            <ul className="space-y-1">
              {issues.map((issue, i) => (
                <li key={i} className={cx('flex gap-2 rounded-lg px-2.5 py-1.5 text-[12px] leading-snug text-[var(--ds-ink)]', STATUS_SURFACE.attention)}>
                  <TriangleAlert className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', TONE_TEXT.warning)} aria-hidden />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{issue}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-[var(--ds-muted)]">No issues found.</p>
          )}
          {issues.length > 0 && <p className="mt-1.5 text-[11px] text-[var(--ds-muted)]">Tip: describe a fix above, or mark the area and let the AI correct just that.</p>}
          {doc.format.lettering === 'in_art' && qc.textFound && qc.textFound.length > 0 && (
            <p className="mt-2 text-[11.5px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
              <span className="font-semibold">Text read on the page:</span> {qc.textFound.join(' · ')}
            </p>
          )}
        </section>
      )}

    </>
  );
  const versionsSection = (
    <>
      {/* Versions (VersionStack: use any saved version for free, star, compare) */}
      {drawn && (
        <section ref={versionsRef} aria-labelledby="pe-versions" className="scroll-mt-2">
          <SectionTitle id="pe-versions" icon={<Layers className="h-3.5 w-3.5" />} right={<span className="text-[11px] text-[var(--ds-muted)]">Switching is free</span>}>
            Versions
          </SectionTitle>
          <VersionStack studio={studio} target={target} compact />
        </section>
      )}

    </>
  );
  const filmstripToolsSection = (
    <>
      {layout.filmstrip === 'tools' && (
        <section aria-label="Pages">
          <SectionTitle>Pages</SectionTitle>
          {filmstrip}
        </section>
      )}

    </>
  );
  const letteringStyleSection = (
    <>
      {/* Lettering style (whole comic) */}
      {overlayLettering && (
        <section aria-labelledby="pe-lettering" className="space-y-2">
          <SectionTitle id="pe-lettering" icon={<Type className="h-3.5 w-3.5" />} right={<span className="text-[11px] text-[var(--ds-muted)]">Free</span>}>
            Lettering
          </SectionTitle>
          <PresetGallery value={doc.letterStyle?.presetId ?? 'classic'} onChange={(id) => apply(presetOps(id), { label: 'Change lettering style' })} lang={lang ?? doc.format.language} />
          <div className="flex flex-wrap items-center gap-2">
            <GhostButton
              size="xs"
              disabled={!hasLetteringOverrides(doc)}
              onClick={() => apply(resetAllLetteringOps(doc), { label: 'Reset balloon styles' })}
              title="Remove every per-balloon and per-speaker style so the whole comic follows the chosen style"
            >
              <RotateCcw className="h-3 w-3" aria-hidden /> Reset all balloon styles
            </GhostButton>
          </div>
          <p className="px-1 text-[11px] leading-snug text-[var(--ds-muted)]">
            Select a balloon on the page for fonts, colours, shapes and tails. Lettering edits are free — done by the editor, no AI cost.
          </p>
        </section>
      )}

    </>
  );
  const scriptSection = (
    <>
      {/* Script (full) */}
      <section aria-labelledby="pe-script" className="space-y-2">
        <SectionTitle id="pe-script" icon={<MessageSquare className="h-3.5 w-3.5" />}>
          Script
        </SectionTitle>
        <InlineField
          label="Page summary"
          showLabel
          multiline
          value={sourcePage.summary}
          onCommit={(summary) => patch([{ op: 'page', id: sourcePage.id, patch: { summary } }])}
        />
        <InlineField
          label="Layout (rows of panels)"
          showLabel
          multiline
          value={sourcePage.layout}
          placeholder="Row 1: one wide panel. Row 2: two equal panels."
          onCommit={(layout) => patch([{ op: 'page', id: sourcePage.id, patch: { layout } }])}
        />
        <p className="px-2 text-[11px] leading-snug text-[var(--ds-muted)]">
          {overlayLettering
            ? 'Dialogue edits update the balloons instantly — no redraw needed. Layout and action edits mark the page out of date.'
            : 'Lettering is drawn into the art on this comic: any script change marks the page out of date until you re-render.'}
          {lang && ` The ${languageLabel(lang)} lines under each line are this edition’s translation (free to edit).`}
        </p>
        {lang && (
          <button
            type="button"
            onClick={() => closeEditorTo('languages')}
            className="tap-target inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-accent)] hover:bg-[var(--ds-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
          >
            <Languages className="h-3.5 w-3.5" aria-hidden /> Review every {languageLabel(lang)} line
          </button>
        )}
        <div className="space-y-2">
          {sourcePage.panels.map((panel) => (
            <PanelEditor
              key={panel.id}
              doc={doc}
              page={sourcePage}
              panel={panel}
              selectedLine={selectedLine}
              onSelectLine={(id) => selection.select(id)}
              patch={patch}
              edition={lang ? { lang, texts: editionTexts, onCommit: onEditionText } : undefined}
            />
          ))}
        </div>
      </section>
    </>
  );
  const toolsContent = (
    <>
      {aiSection}
      {actionsSection}
      {qcSection}
      {versionsSection}
      {filmstripToolsSection}
      {letteringStyleSection}
      {scriptSection}
      {pro.pro && phone && pro.coach.cards.length > 0 && !pro.coach.open && (
        <button type="button" data-testid="pro-tips-again" onClick={pro.coach.reopen} className={cx('tap-target self-start px-2 py-1 text-[12px] font-semibold text-[var(--ds-ink)] underline decoration-[var(--ds-hairline)] underline-offset-2 hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-11', RADIUS_CONTROL)}>
          Show the Pro tips again
        </button>
      )}
    </>
  );

  // Pro, docked, with the inspector part ready: the Properties tab IS the inspector (nothing floats).
  const dockInspector = docked && !!pro.parts.inspector;
  const inspector = inspectorOpen && !dockInspector && (
    <div ref={inspectorHostRef} className="contents">
      <LetteringInspector
        doc={vDoc}
        page={page}
        lineIds={selection.ids}
        plans={plans}
        placements={placements}
        H={H}
        apply={apply}
        onEditText={(id) => {
          selection.select(id);
          startEditing(id);
        }}
        onAskAI={(text) => {
          const message = `(about the selected balloon${selection.ids.length > 1 ? 's' : ''}) ${text}`;
          void keepRefusedInComposer(studio.send(message, { focus: 'selection' }), message);
        }}
        onDeselect={selection.clear}
        editionLang={lang}
        mode={viewMode}
        onModeChange={setViewMode}
        canPro={canPro}
        anchor={anchor}
        compact={layout.compactInspector}
        maxHeight={inspectorMaxH}
        bounds={inspectorBounds}
        onClose={() => setInspectorClosed(true)}
      />
    </div>
  );

  const menuLine = menu ? page.panels.flatMap((p) => p.lines).find((l) => l.id === menu.lineId) : undefined;
  const contextMenu = menu && (
    <ContextMenuSheet open onClose={() => setMenu(null)} label={menuLine ? `${LINE_KIND_LABEL[menuLine.kind]} balloon` : 'Balloon'} items={menuItems(menu.lineId)} at={menu.at} />
  );

  const toolbar = phone ? (
    <EditorToolbar
      orientation={layout.toolbar === 'rail' ? 'vertical' : 'horizontal'}
      mode={mode}
      onModeChange={changeMode}
      markupDisabled={!artOk || busy}
      canUndo={!!studio.canUndo}
      canRedo={!!studio.canRedo}
      undoLabel={studio.undoLabel}
      onUndo={() => studio.undo?.()}
      onRedo={() => studio.redo?.()}
      lettering={
        overlayLettering && artOk
          ? {
              open: trayOpen || inspectorOpen,
              disabled: busy,
              attention,
              onToggle: () => {
                if (mode !== 'move') changeMode('move');
                if (selection.ids.length && inspectorClosed) {
                  setInspectorClosed(false);
                  return;
                }
                if (inspectorOpen) {
                  setInspectorClosed(true);
                  return;
                }
                setTrayOpen((v) => !v);
              }
            }
          : null
      }
      tools={{
        open: layout.tools === 'side' ? tools.side : sheetShown,
        onToggle: () => {
          if (layout.tools === 'side') onTools({ side: !tools.side });
          else if (compactInspectorOpen) {
            // The lettering sheet is up: put it away and bring the tools back.
            setInspectorClosed(true);
            onTools({ open: true });
          } else onTools({ open: !tools.open });
        }
      }}
      layers={pro.pro && pro.parts.layers ? { open: layersSheet, onToggle: () => setLayersSheet((v) => !v) } : undefined}
      tray={
        trayAvailable && trayOpen && !inspectorOpen
          ? {
              addKind,
              onAddKind: chooseAddKind,
              canAdd: !lang,
              onTidy: tidy.length ? () => apply(tidy, { label: 'Tidy balloons' }) : null,
              outsideCount,
              onFixEdges: () => apply(fixSafeAreaOps(vDoc, page, plans, H, placements.balloons), { label: 'Move balloons inside the safe area' }),
              hidden: !lettering,
              onToggleHidden: () => setLettering((v) => !v)
            }
          : null
      }
    />
  ) : null;

  const toolsSheet = (
    <EditorToolsSheet
      presentation={layout.tools}
      open={layout.tools === 'side' ? tools.side : layout.tools === 'sheet' ? sheetShown : true}
      onOpenChange={(open) => (layout.tools === 'side' ? onTools({ side: open }) : onTools({ open }))}
      detent={tools.detent}
      onDetentChange={(detent) => onTools({ detent, open: true })}
      avail={body.height}
      dismissible={layout.kind === 'phone'}
      width={layout.toolsWidth}
      stacked={layout.kind === 'fold-tabletop'}
      padBottom={layout.kind === 'tablet-portrait'}
      header={layout.kind === 'fold-tabletop' ? modeRow : undefined}
    >
      {coach && coachInSide && coachEl}
      {toolsContent}
    </EditorToolsSheet>
  );

  // ── Pro: what the mounted parts get, the rail, the phone Layers sheet and the docked workspace ──
  const panelProps: ProPanelProps = {
    studio,
    doc: vDoc,
    sourceDoc: doc,
    page,
    sourcePage,
    aspect,
    H,
    plans,
    placements,
    selection: { ids: selection.ids, set: selection.set, clear: selection.clear },
    apply,
    onEditText: (id) => {
      selection.select(id);
      startEditing(id);
    },
    editionLang: lang,
    mode: viewMode,
    layout: layout.kind,
    presence: studio.presence ?? null,
    footer: PRO_FREE_FOOTER
  };
  const LayersPart = pro.parts.layers;
  const layersSheetEl =
    pro.pro && LayersPart && layersSheet && (layout.kind === 'phone' || layout.kind === 'phone-landscape') ? (
      <ProLayersSheet onClose={() => setLayersSheet(false)}>
        <LayersPart {...panelProps} />
      </ProLayersSheet>
    ) : null;
  const rail = railed ? (
    <ToolRail tool={tool} onTool={pro.setTool} tools={pro.tools} disabled={pro.disabled} orientation={docked ? 'vertical' : 'horizontal'} />
  ) : null;

  if (docked) {
    const InspectorPart = pro.parts.inspector;
    const AssetsPart = pro.parts.assets;
    const AnimatePart = pro.parts.animate;
    const leftRailOn = ws.leftRailW > 0 && !!(LayersPart || AssetsPart);
    const properties = (
      <div className="flex min-w-0 flex-col gap-4">
        {InspectorPart ? <InspectorPart {...panelProps} /> : letteringStyleSection}
        {scriptSection}
      </div>
    );
    const tabs: DockTab[] = [
      { id: 'properties', label: 'Properties', content: properties, free: true },
      ...(!leftRailOn && LayersPart ? [{ id: 'layers' as const, label: 'Layers', content: <LayersPart {...panelProps} />, free: true }] : []),
      ...(!leftRailOn && AssetsPart ? [{ id: 'assets' as const, label: 'Assets', content: <AssetsPart {...panelProps} />, free: true }] : []),
      {
        id: 'ai',
        label: 'AI',
        content: (
          <div className="flex min-w-0 flex-col gap-4">
            {aiSection}
            {actionsSection}
            {qcSection}
            {versionsSection}
          </div>
        ),
        free: false
      }
    ];
    const leftTabs = [
      ...(LayersPart ? [{ id: 'layers' as const, label: 'Layers', node: <LayersPart {...panelProps} /> }] : []),
      ...(AssetsPart ? [{ id: 'assets' as const, label: 'Assets', node: <AssetsPart {...panelProps} /> }] : [])
    ];
    const leftValue = leftTabs.some((t) => t.id === leftTab) ? leftTab : leftTabs[0]?.id;
    const leftRail =
      leftRailOn && leftValue ? (
        <Tabs value={leftValue} onValueChange={(v) => setLeftTab(v as 'layers' | 'assets')} className="min-h-0 flex-1 gap-0">
          <div className="shrink-0 border-b border-[var(--ds-hairline)] px-3 py-2">
            <TabsList label="Layers and assets" size="sm" fullWidth>
              {leftTabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {leftTabs.map((t) => (
            <TabsContent key={t.id} value={t.id} className="flex min-h-0 flex-1 flex-col focus-visible:outline-none">
              <ProPanelFrame>{t.node}</ProPanelFrame>
            </TabsContent>
          ))}
        </Tabs>
      ) : undefined;
    return (
      <ProWorkspace
        layout={ws}
        rootRef={layoutRootRef}
        bodyRef={bodyRef}
        rail={rail}
        leftRail={leftRail}
        main={
          <>
            {modeRow}
            {stageEl}
            {AnimatePart && (
              <div className="shrink-0 border-t border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)]" data-testid="pro-timeline">
                <AnimatePart {...panelProps} />
              </div>
            )}
            {filmstrip}
          </>
        }
        dock={<ProDock ref={dockRef} tabs={tabs} value={dockTab} onChange={setDockTab} width={ws.dockW} top={proCoachEl} />}
      >
        {inspector}
        {contextMenu}
      </ProWorkspace>
    );
  }

  // ── Layouts ──
  if (layout.kind === 'fold-book' || layout.kind === 'fold-tabletop') {
    const split = layout.split!;
    const rows = split.axis === 'rows';
    return (
      <div
        ref={foldGridRef}
        className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
        style={rows ? { gridTemplateRows: `minmax(0, ${split.first}px) ${split.gap}px minmax(0, 1fr)` } : { gridTemplateColumns: `minmax(0, ${split.first}px) ${split.gap}px minmax(0, 1fr)` }}
        data-layout={layout.kind}
      >
        <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-col" data-testid="editor-stage">
          {!rows && modeRow}
          {stageEl}
          {layout.filmstrip === 'stage' && filmstrip}
        </div>
        <div aria-hidden data-hinge />
        {toolsSheet}
        {inspector}
        {contextMenu}
      </div>
    );
  }

  if (layout.kind === 'phone-landscape') {
    return (
      <div ref={layoutRootRef} className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden" data-layout={layout.kind}>
        {toolbar}
        <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="editor-stage">
          {phoneRow}
          {stageEl}
        </div>
        {toolsSheet}
        {inspector}
        {contextMenu}
        {layersSheetEl}
      </div>
    );
  }

  if (layout.tools === 'sheet') {
    // Phone portrait and tablet portrait: the stage above, the tools sheet resting at its foot.
    return (
      <div ref={layoutRootRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-layout={layout.kind}>
        <div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="editor-stage">
          {toolRow && rail}
          {phone ? phoneRow : modeRow}
          {stageEl}
          {toolsSheet}
        </div>
        {toolbar}
        {inspector}
        {contextMenu}
        {layersSheetEl}
      </div>
    );
  }

  // Desktop / tablet landscape: today's stage + aside.
  return (
    <div ref={layoutRootRef} className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden" data-layout={layout.kind}>
      <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="editor-stage">
        {modeRow}
        {stageEl}
        {filmstrip}
      </div>
      {inspector}
      {toolsSheet}
      {contextMenu}
    </div>
  );
};

/** Pro, the Shapes tool: one press on the page places a rectangle there (the B9 drop of a shape). */
const ShapePlaceLayer: React.FC<{ onPlace(point: { x: number; y: number }): void }> = ({ onPlace }) => (
  <div
    aria-hidden
    data-testid="shape-place-layer"
    className="absolute inset-0 cursor-crosshair"
    style={{ zIndex: 3 }}
    onPointerDown={(e) => {
      const r = e.currentTarget.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return;
      e.preventDefault();
      e.stopPropagation();
      onPlace({ x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
    }}
  />
);

const requestAnimationFrameSafe = (fn: () => void) => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => fn());
  else fn();
};

// ── Shell ────────────────────────────────────────────────────────────────────

export const PageEditor: React.FC<{ studio: StudioController; doc: ComicDoc; pageId: string }> = ({ studio, doc, pageId }) => {
  const page = findPage(doc, pageId);
  const pages = useMemo(() => [...doc.pages].sort((a, b) => a.n - b.n), [doc.pages]);
  const index = page ? pages.findIndex((p) => p.id === page.id) : -1;
  const prev = index > 0 ? pages[index - 1] : undefined;
  const next = index >= 0 && index < pages.length - 1 ? pages[index + 1] : undefined;
  // Manga / right-to-left books turn the other way: ← goes forward, and the header's arrows swap
  // sides with it (the header swipe already mirrors through swipeTurn).
  const rtl = doc.format.readingDirection === 'rtl';
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => studio.openPage(null), [studio]);
  const ff = useFormFactor();
  const layout = useMemo(() => editorLayoutFor(ff), [ff]);
  // Survive page turns: the language being edited and where the tools are.
  const [edition, setEdition] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolsState>(() => ({ open: toolsSheetOpenAtStart(readFlag(TOOLS_SHEET_KEY), layout.kind, ff.height), detent: 'peek', side: true }));
  const onTools = useCallback((patch: Partial<ToolsState>) => {
    setTools((cur) => {
      const nextState = { ...cur, ...patch };
      if (patch.open !== undefined) writeFlag(TOOLS_SHEET_KEY, patch.open ? 'open' : 'closed');
      return nextState;
    });
  }, []);
  useDialogA11y(true, close);
  useFocusTrap(rootRef, true);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  // The Pro shell (PE-SHELL): flag, view (D7), tool, coach, shortcut sheet and the mounted parts.
  const phoneLayout = layout.kind === 'phone' || layout.kind === 'phone-landscape';
  const pageArtOk = !!page && hasImage(page.render) && canServeToOwner(page.render.asset);
  const pro = useProEditor(studio, {
    pageId,
    phone: phoneLayout,
    inArt: doc.format.lettering !== 'overlay',
    markupOff: pageArtOk ? undefined : 'Mark up needs a drawing: render this page first.'
  });
  const [stageZoom, setStageZoom] = useState(1);
  const proWs = proWorkspaceFor(layout, ff.width);
  // Tool keys work where the rail is (docked or the tablet tool row), never on phones.
  const keyTools = useMemo(() => new Set<ProTool>(pro.pro && proWs.kind !== 'phone' ? pro.tools : []), [pro.pro, proWs.kind, pro.tools]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      // Undo / redo (⌘Z, ⇧⌘Z, Ctrl+Y) — lettering, script and balloon edits.
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) studio.redo?.();
        else studio.undo?.();
        return;
      }
      if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        studio.redo?.();
        return;
      }
      // The Pro shell's keys (flag on): Shift+P, ?, and in Pro the tool keys.
      const shortcut = shellShortcut(e, { flag: pro.on, pro: pro.pro, tools: keyTools });
      if (shortcut?.kind === 'toggle-mode') {
        e.preventDefault();
        pro.toggleView();
        return;
      }
      if (shortcut?.kind === 'help') {
        e.preventDefault();
        pro.help.toggle();
        return;
      }
      if (shortcut?.kind === 'tool') {
        if (!pro.disabled[shortcut.tool]) {
          e.preventDefault();
          pro.setTool(shortcut.tool);
        }
        return;
      }
      if (e.altKey || mod) return;
      // Never turn the page while anything on it is selected (graft 4): balloons, overlays or panels. A selected
      // overlay is nudged instead (one engine move per press; a run of presses is one undo entry).
      const sel = studio.selection;
      if (selectionHoldsArrows(sel)) {
        const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const d = dirs[e.key];
        const layerIds = sel?.layerIds ?? [];
        const on = page && sel && sel.pageId === page.id ? page : undefined;
        if (d && on && layerIds.length) {
          e.preventDefault();
          const step = e.shiftKey ? ENGINE_NUDGE.big : ENGINE_NUDGE.step;
          const ops: DocOp[] = [];
          let label = '';
          for (const id of layerIds) {
            const r = moveEdit(doc, on, { kind: 'overlay', id }, d[0] * step, d[1] * step);
            if (r.ok) {
              ops.push(...r.ops);
              label = label ? 'Move overlays' : r.label;
            }
          }
          if (ops.length) void studio.patch(ops, { undo: true, label, coalesce: `layer:move:${on.id}:${layerIds.join(',')}` });
        }
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const forward = (e.key === 'ArrowRight') !== rtl;
      const to = forward ? next : prev;
      if (!to) return;
      e.preventDefault();
      studio.openPage(to.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prev, next, studio, rtl, pro, keyTools, page, doc]);

  if (!page) return null;
  const status = pageVisualStatus(doc, page);

  // Phones: a horizontal swipe on the header turns the page (the stage pans and zooms instead).
  const headerSwipe = layout.fullBleed
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType === 'mouse') return;
          swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        },
        onPointerUp: (e: React.PointerEvent) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || s.id !== e.pointerId) return;
          const to = turnTarget(pages, page.id, swipeTurn(e.clientX - s.x, e.clientY - s.y, rtl));
          if (to) studio.openPage(to.id);
        },
        onPointerCancel: () => {
          swipe.current = null;
        }
      }
    : {};

  // The arrow points the way the page turns: in a right-to-left book "Next" sits on the left.
  const prevButton = (
    <IconButton label="Previous page" disabled={!prev} onClick={() => prev && studio.openPage(prev.id)}>
      {rtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
    </IconButton>
  );
  const nextButton = (
    <IconButton label="Next page" disabled={!next} onClick={() => next && studio.openPage(next.id)}>
      {rtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
    </IconButton>
  );

  return (
    <ModalPortal>
      <div
        className={
          pro.on
            ? // Flag on: the editor's layer and its backdrop come from the ladder and the recipes (§2.7 chrome rules).
              cx('fixed inset-x-0 top-0 h-[var(--app-h,100dvh)]', Z.editor, layout.fullBleed ? 'bg-[var(--ds-canvas)]' : cx(SCRIM, 'p-4'))
            : cx('fixed inset-x-0 top-0 z-[70] h-[var(--app-h,100dvh)]', layout.fullBleed ? 'bg-[var(--ds-canvas)]' : 'bg-black/45 p-4 backdrop-blur-sm')
        }
        onPointerDown={layout.fullBleed ? undefined : (e) => e.target === e.currentTarget && close()}
        data-editor-layout={layout.kind}
      >
        <div
          ref={rootRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Page ${page.n} editor`}
          tabIndex={-1}
          className={
            pro.on
              ? cx('flex h-full w-full flex-col overflow-hidden bg-[var(--ds-canvas)] focus:outline-none', !layout.fullBleed && OVERLAY)
              : cx('flex h-full w-full flex-col overflow-hidden bg-[var(--ds-canvas)] shadow-2xl focus:outline-none', !layout.fullBleed && 'rounded-2xl border border-[var(--ds-hairline)]')
          }
          style={
            layout.fullBleed
              ? {
                  paddingTop: 'var(--sa-top, 0px)',
                  paddingLeft: 'var(--sa-left, 0px)',
                  // The side sheet pads the right inset itself (its tab hugs the edge).
                  paddingRight: layout.tools === 'side' ? undefined : 'var(--sa-right, 0px)',
                  // The bottom toolbar (phones) and the tools sheet (tablet portrait) pad the home indicator themselves.
                  paddingBottom: layout.kind === 'phone' || layout.kind === 'tablet-portrait' ? undefined : 'var(--sa-bottom-eff, 0px)'
                }
              : undefined
          }
        >
          <header
            className={cx('flex shrink-0 select-none items-center gap-2 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 py-1.5 sm:px-3 sm:py-2', layout.fullBleed && 'touch-pan-y')}
            // Landscape phones: the dialog leaves the right inset to the side sheet (its tab hugs the edge),
            // so the header pads the notch itself — "Close editor" never sits under it.
            style={layout.fullBleed && layout.tools === 'side' ? { paddingRight: 'calc(var(--sa-right, 0px) + 0.75rem)' } : undefined}
            {...headerSwipe}
            data-testid="editor-header"
          >
            {rtl ? nextButton : prevButton}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <h2 className={pro.on ? 'min-w-0 truncate whitespace-nowrap text-[14px] font-semibold text-[var(--ds-ink)]' : 'shrink-0 whitespace-nowrap text-[14px] font-semibold text-[var(--ds-ink)]'}>
                  Page {page.n}{' '}
                  {/* Flag on, phones: the header also holds the Easy | Pro switch, so "of n" goes below 360 px. */}
                  <span className={pro.on ? 'hidden font-normal text-[var(--ds-muted)] min-[360px]:inline' : 'font-normal text-[var(--ds-muted)]'}>of {pages.length}</span>
                </h2>
                <StatusChip status={status} label={status === 'stale' ? 'Out of date' : undefined} className="min-w-0" />
              </div>
              {page.summary && <p className="truncate text-[12px] text-[var(--ds-muted)]">{page.summary}</p>}
            </div>
            {rtl ? prevButton : nextButton}
            {pro.on && (
              <ProTopBar
                mode={pro.view}
                onModeChange={pro.setView}
                canPro={pro.canPro}
                variant={proWs.kind === 'docked' ? 'full' : proWs.kind === 'tool-row' ? 'tablet' : 'phone'}
                canUndo={!!studio.canUndo}
                canRedo={!!studio.canRedo}
                undoLabel={studio.undoLabel}
                onUndo={() => studio.undo?.()}
                onRedo={() => studio.redo?.()}
                zoom={stageZoom}
                helpOpen={pro.help.open}
                onHelp={pro.help.toggle}
              />
            )}
            <IconButton label="Close editor" onClick={close}>
              <X className="h-4 w-4" />
            </IconButton>
          </header>
          <EditorBody
            key={page.id}
            studio={studio}
            doc={doc}
            page={page}
            layout={layout}
            edition={edition}
            onEdition={setEdition}
            tools={tools}
            onTools={onTools}
            pro={pro}
            onZoom={pro.on ? setStageZoom : undefined}
          />
          {pro.help.open && <ShortcutSheet onClose={pro.help.close} onTips={pro.coach.cards.length ? () => { pro.coach.reopen(); pro.help.close(); } : undefined} />}
        </div>
      </div>
    </ModalPortal>
  );
};
