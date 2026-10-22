// Page editor — a focused, full-screen workspace for one page.
//
// Left: the page, large, with editable overlay balloons (drag / arrow keys / tail and
// width handles) and a Mark-up mode: drag a box on the art to show the AI exactly what
// to change. Right: "Edit with AI" (instruction + marked area → a scoped image edit of
// this page, with its price), re-render / re-letter, the vision QC report, every saved
// version (restore any), and the script itself — panel actions and lines (text, speaker,
// kind; add/remove) edited in place. ←/→ move between pages; Esc closes.
//
// Lettering (overlay comics) is edited right on the page, for free: a toolbar adds Speech /
// Thought / Caption / SFX balloons, undo/redo, Tidy and Fix edges; selecting balloon(s) opens the
// lettering inspector (Easy or Pro view of the same capability — fonts, sizes, colours, bubble
// shapes, fill opacity / transparent, borders, tails, arrange, apply-to-all) beside the selection;
// double-click edits text in place. The selection is mirrored to the chat as its focus.
// The stage sizes the page from its CONTENT box and can never widen its column (min-w-0), so the
// tools panel is never pushed off-screen (visualqa P0-2).

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  MessageSquare,
  MousePointer2,
  Plus,
  RotateCcw,
  SquareDashed,
  Trash2,
  TriangleAlert,
  Type,
  WandSparkles,
  X
} from 'lucide-react';
import { findPage, newId, type Balloon, type Box, type ComicDoc, type Line, type LineKind, type Page, type Panel } from '../../../shared/comic/doc';
import type { DocOp, StudioAction } from '../../../shared/comic/ops';
import { formatUsd } from '../../../shared/comic/models';
import type { StudioController } from '../types';
import { ModalPortal } from '../../modals/ModalPortal';
import { useDialogA11y } from '../../studio/kit/useDialogA11y';
import { ComicPageView } from './ComicPageView';
import { VersionStrip } from './ImageFrame';
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
import { LetteringInspector, type Rect } from '../lettering/LetteringInspector';
import { LetteringToolbar } from '../lettering/LetteringToolbar';
import { PresetGallery } from '../lettering/PresetGallery';
import { useLetterPlans } from '../lettering/useLetterPlans';
import { useLetteringSelection } from '../lettering/useLetteringSelection';
import { addLineAtOps, fixSafeAreaOps, outlineFractions, presetOps, tidyOps } from '../lettering/styleOps';
import { useFormFactor } from '../mobile/useFormFactor';

type Mode = 'move' | 'markup';

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

const isEditableTarget = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
};

const SELECT_CLS =
  'h-7 min-w-0 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-1.5 text-[12px] text-[var(--ds-ink)] focus:border-[#D97757]/50 focus:outline-none disabled:opacity-50';

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

// ── Mark-up layer ────────────────────────────────────────────────────────────

const MarkupLayer: React.FC<{
  active: boolean;
  region: Box | null;
  panelN?: number;
  onRegion: (region: Box) => void;
}> = ({ active, region, panelN, onRegion }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || !ref.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = ref.current.getBoundingClientRect();
    const start: Point = toPagePoint(e.clientX, e.clientY, rect);
    let end = start;
    const move = (ev: PointerEvent) => {
      end = toPagePoint(ev.clientX, ev.clientY, rect);
      setDraft(regionFromPoints(start, end));
    };
    const up = (ev: PointerEvent) => {
      cleanup.current?.();
      end = toPagePoint(ev.clientX, ev.clientY, rect);
      setDraft(null);
      const box = regionFromPoints(start, end);
      if (box) onRegion(box);
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

  const shown = draft || region;
  return (
    <div
      ref={ref}
      data-testid="markup-layer"
      onPointerDown={onPointerDown}
      className={cx('absolute inset-0 z-[4]', active ? 'cursor-crosshair touch-none' : 'pointer-events-none')}
      aria-hidden={!active}
    >
      {active && !shown && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <span className="rounded-full bg-black/70 px-3 py-1 text-[12px] font-medium text-white shadow">Drag a box around the area to change</span>
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
    </div>
  );
};

// ── Lines ────────────────────────────────────────────────────────────────────

const LineRow: React.FC<{
  doc: ComicDoc;
  page: Page;
  panel: Panel;
  line: Line;
  selected: boolean;
  autoFocus: boolean;
  onSelect: () => void;
  patch: (ops: DocOp[]) => void;
}> = ({ doc, page, panel, line, selected, autoFocus, onSelect, patch }) => {
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
        'space-y-1 rounded-xl border p-1.5 transition-colors duration-200',
        selected ? 'border-[#D97757]/45 bg-[#D97757]/[0.07]' : 'border-transparent bg-[var(--ds-well)]'
      )}
    >
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Line type"
          value={line.kind}
          onChange={(e) => patch(lineKindOps(page, panel, line, e.target.value as LineKind))}
          className={cx(SELECT_CLS, 'w-[7.5rem]')}
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
        <p className="px-1 text-[11px] text-amber-700 dark:text-amber-300">
          {castName(doc, line.speakerId)} isn’t in this panel — the line reads as off-panel.
        </p>
      )}
      <InlineField
        label={`Line text (${LINE_KIND_LABEL[line.kind]})`}
        multiline
        rows={1}
        autoFocus={autoFocus}
        value={line.text}
        placeholder="Type the line…"
        onCommit={(text) => patch([lineOp({ text })])}
        inputClassName="text-[13px]"
      />
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
}> = ({ doc, page, panel, selectedLine, onSelectLine, patch }) => {
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
      <header className="mb-1 flex items-center gap-2">
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
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addLine}
        className="mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
      </button>
    </section>
  );
};

// ── Editor body ──────────────────────────────────────────────────────────────

const EditorBody: React.FC<{ studio: StudioController; doc: ComicDoc; page: Page }> = ({ studio, doc, page }) => {
  const [mode, setMode] = useState<Mode>('move');
  const [region, setRegion] = useState<Box | null>(null);
  const [instruction, setInstruction] = useState('');
  const [panelN, setPanelN] = useState<number | undefined>(undefined);
  const [lettering, setLettering] = useState(true);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const pageBoxRef = useRef<HTMLDivElement>(null);
  const [addKind, setAddKind] = useState<LineKind | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [inspectorClosed, setInspectorClosed] = useState(false);
  const form = useFormFactor();
  const { busyKey, fire } = useClickGuard(2500);
  const byok = byokFromDoc(doc);
  const status = pageVisualStatus(doc, page);
  const busy = isBusy(page.render);
  const drawn = hasImage(page.render);
  const imageUrl = studio.urlFor(page.render.asset);
  const overlayLettering = doc.format.lettering === 'overlay';
  const boxes = useMemo(() => panelBoxesFor(doc, page), [doc, page]);
  const [loadedAspect, setLoadedAspect] = useState(0);
  const aspect = loadedAspect || pageAspectOf(doc, page);
  const editPrice = estimateOne(doc, 'edit', byok).usd;
  const renderPrice = estimateDraw(doc, pagesForIds(doc, [page.id]), byok).estimate.usd;
  const spec = jobModel(doc, 'page');

  // Fit the page inside the stage's CONTENT box (measured directly; no padding arithmetic).
  const pageWidth = fitPageToStage({ w: stage.width, h: stage.height }, aspect, 0);

  const patch = useCallback((ops: DocOp[]) => void studio.patch(ops), [studio]);
  /** Lettering edits: free, undoable, labelled ("Undo move balloon"). */
  const apply = useCallback(
    (ops: DocOp[], opts?: PatchOptions) => {
      if (ops.length) void studio.patch(ops, { undo: true, ...opts });
    },
    [studio]
  );
  const onBalloonChange = useCallback(
    (lineId: string, p: Partial<Balloon>) =>
      void studio.patch([{ op: 'balloon', pageId: page.id, lineId, patch: p }], { undo: true, label: 'Move balloon', coalesce: `balloon:${page.id}:${lineId}` }),
    [studio, page.id]
  );

  // ── Lettering: plans, selection, inspector ──────────────────────────────
  const canPro = studio.caps?.proEditor !== false;
  const viewMode: StudioMode = canPro ? studio.mode ?? 'easy' : 'easy';
  const setViewMode = (m: StudioMode) => studio.setMode?.(m);
  const { plans, placements, measure, H } = useLetterPlans(doc, page, aspect);
  const validIds = useMemo(() => page.panels.flatMap((p) => p.lines.map((l) => l.id)), [page.panels]);
  const panelOf = useCallback((id: string) => page.panels.find((p) => p.lines.some((l) => l.id === id))?.n, [page.panels]);
  const selection = useLetteringSelection({ pageId: page.id, validIds, setStudioSelection: studio.setSelection, panelOf });
  const selectedLine = selection.primary;
  const selectionKey = selection.ids.join('|');
  useEffect(() => setInspectorClosed(false), [selectionKey]);
  const letteringEditable = mode === 'move' && overlayLettering && !busy && drawn;
  const tidy = useMemo(() => (overlayLettering ? tidyOps(doc, page, aspect, measure) : []), [overlayLettering, doc, page, aspect, measure]);
  const outsideCount = plans.filter((p) => p.outOfSafeArea && !p.locked).length;
  const crowdedIds = [...placements.crowded];

  const onAddAt = (kind: LineKind, point: { x: number; y: number }) => {
    const { ops, id } = addLineAtOps(doc, page, kind, point, aspect);
    const withText = ops.map((op) => (op.op === 'line' && op.patch ? { ...op, patch: { ...op.patch, text: NEW_LINE_TEXT[kind] } } : op));
    apply(withText, { label: `Add ${LINE_KIND_LABEL[kind].toLowerCase()}` });
    setAddKind(null);
    selection.select(id);
    setEditingLineId(id);
  };

  // Inspector anchor: the selection's outline bounds on screen (recomputed on resize/scroll).
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
  useLayoutEffect(() => {
    const el = pageBoxRef.current;
    const sel = plans.filter((p) => selection.ids.includes(p.lineId));
    if (!el || !sel.length) {
      setAnchor(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const boxes = sel.map((p) => outlineFractions(p, H));
    const next: Rect = {
      left: r.left + Math.min(...boxes.map((b) => b.x)) * r.width,
      top: r.top + Math.min(...boxes.map((b) => b.y)) * r.height,
      right: r.left + Math.max(...boxes.map((b) => b.x + b.w)) * r.width,
      bottom: r.top + Math.max(...boxes.map((b) => b.y + b.h)) * r.height
    };
    setAnchor((cur) => (cur && Math.abs(cur.left - next.left) < 0.5 && Math.abs(cur.top - next.top) < 0.5 && Math.abs(cur.right - next.right) < 0.5 && Math.abs(cur.bottom - next.bottom) < 0.5 ? cur : next));
  }, [plans, selectionKey, H, viewportTick, pageWidth, stage.width, stage.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc steps back: cancel "add", then deselect, before the dialog's Esc closes the editor.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editingLineId) return;
      if (addKind) {
        e.preventDefault();
        e.stopPropagation();
        setAddKind(null);
      } else if (selection.ids.length && !isEditableTarget(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        selection.clear();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [addKind, editingLineId, selection]);

  const markRegion = (box: Box) => {
    setRegion(box);
    setPanelN(panelForRegion(box, boxes));
  };
  const clearRegion = () => {
    setRegion(null);
    setPanelN(undefined);
  };

  const canEdit = drawn && !busy && instruction.trim().length > 0;
  const submitEdit = () => {
    if (!canEdit) return;
    const action = editActionFor(page.id, instruction, region, panelN);
    fire('edit', () => studio.act(action));
    setInstruction('');
    clearRegion();
    setMode('move');
  };

  const qc = page.render.qc;
  const issues = qc?.issues?.filter(Boolean) || [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* Stage */}
      <div className="flex h-[74vh] min-h-[320px] min-w-0 shrink-0 flex-col sm:h-[62vh] lg:h-auto lg:min-h-0 lg:min-w-0 lg:flex-1" data-testid="editor-stage">
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pt-3">
          <Segmented<Mode>
            label="Editing mode"
            size="xs"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setAddKind(null);
            }}
            options={[
              { value: 'move', label: (<><MousePointer2 className="h-3 w-3" aria-hidden /> {overlayLettering ? 'Lettering' : 'View'}</>) },
              { value: 'markup', label: (<><SquareDashed className="h-3 w-3" aria-hidden /> Mark up</>), disabled: !drawn }
            ]}
          />
          {region && (
            <GhostButton size="xs" onClick={clearRegion}>
              <X className="h-3 w-3" aria-hidden /> Clear mark
            </GhostButton>
          )}
          {overlayLettering && drawn && (
            <GhostButton size="xs" onClick={() => setLettering((v) => !v)} aria-pressed={!lettering}>
              {lettering ? <EyeOff className="h-3 w-3" aria-hidden /> : <Eye className="h-3 w-3" aria-hidden />}
              {lettering ? 'Hide lettering' : 'Show lettering'}
            </GhostButton>
          )}
          {letteringEditable && lettering && (
            <LetteringToolbar
              addKind={addKind}
              onAddKind={setAddKind}
              canUndo={!!studio.canUndo}
              canRedo={!!studio.canRedo}
              undoLabel={studio.undoLabel}
              onUndo={() => studio.undo?.()}
              onRedo={() => studio.redo?.()}
              onTidy={tidy.length ? () => apply(tidy, { label: 'Tidy balloons' }) : null}
              outsideCount={outsideCount}
              onFixEdges={() => apply(fixSafeAreaOps(doc, page, plans, H, placements.balloons), { label: 'Move balloons inside the safe area' })}
              mode={viewMode}
              onModeChange={setViewMode}
              canPro={canPro}
            />
          )}
          {letteringEditable && lettering && crowdedIds.length > 0 && (
            <button
              type="button"
              data-testid="crowded-chip"
              onClick={() => selection.select(crowdedIds[0])}
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/[0.1] px-2 py-0.5 text-[11.5px] font-medium text-amber-800 hover:bg-amber-500/[0.16] dark:text-amber-200"
              title="A balloon couldn’t find free space in its panel — free fixes in the lettering panel"
            >
              <TriangleAlert className="h-3 w-3" aria-hidden /> Crowded panel{crowdedIds.length > 1 ? ` (${crowdedIds.length})` : ''}
            </button>
          )}
          <span className="ml-auto hidden text-[11px] text-[var(--ds-muted)] xl:inline">
            {mode === 'markup'
              ? 'Drag on the page to mark what should change.'
              : addKind
                ? `Click on the page to place the ${LINE_KIND_LABEL[addKind].toLowerCase()} · Esc cancels`
                : overlayLettering
                  ? 'Drag balloons · Shift-click to multi-select · double-click edits text · arrows nudge'
                  : 'Lettering is drawn into the art on this comic.'}
          </span>
        </div>
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div ref={stageRef} className="absolute inset-3 flex min-w-0 items-center justify-center sm:inset-6" data-testid="editor-stage-content">
            <div ref={pageBoxRef} style={{ width: pageWidth ? `${pageWidth}px` : '100%', maxWidth: '100%' }} className="shadow-[0_10px_40px_rgba(0,0,0,0.25)]">
              <ComicPageView
                doc={doc}
                page={page}
                imageUrl={imageUrl}
                editable={letteringEditable}
                onBalloonChange={onBalloonChange}
                onLetteringOps={apply}
                selectedLineIds={selection.ids}
                onSelectionChange={selection.set}
                editingLineId={editingLineId}
                onEditingChange={setEditingLineId}
                addKind={letteringEditable ? addKind : null}
                onAddAt={onAddAt}
                hideLettering={!lettering}
                loading="eager"
                develop={false}
                onAspectChange={setLoadedAspect}
                overlay={
                  <RenderOverlay
                    status={status}
                    since={page.render.updatedAt}
                    model={renderModelNickname(doc, busy ? undefined : page.render, 'page')}
                    typicalSec={spec.latencySec}
                    error={page.render.error}
                    overImage={drawn && !!imageUrl}
                    staleLabel="Out of date — re-render to apply"
                  />
                }
              >
                <MarkupLayer active={mode === 'markup' && drawn && !busy} region={region} panelN={panelN} onRegion={markRegion} />
              </ComicPageView>
            </div>
          </div>
        </div>
      </div>
      {letteringEditable && lettering && selection.ids.length > 0 && !inspectorClosed && !editingLineId && (
        <LetteringInspector
          doc={doc}
          page={page}
          lineIds={selection.ids}
          plans={plans}
          placements={placements}
          H={H}
          apply={apply}
          onEditText={(id) => {
            selection.select(id);
            setEditingLineId(id);
          }}
          onAskAI={(text) => void studio.send(`(about the selected balloon${selection.ids.length > 1 ? 's' : ''}) ${text}`, { focus: 'selection' })}
          onDeselect={selection.clear}
          mode={viewMode}
          onModeChange={setViewMode}
          canPro={canPro}
          anchor={anchor}
          compact={form.width < 640}
          onClose={() => setInspectorClosed(true)}
        />
      )}

      {/* Side panel */}
      <aside
        aria-label="Page tools"
        className="flex-1 space-y-5 border-t border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 lg:w-[400px] lg:flex-none lg:overflow-y-auto lg:border-l lg:border-t-0"
      >
        {/* Edit with AI */}
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
            rows={3}
            disabled={!drawn}
            placeholder={drawn ? 'e.g. “Make it night with lanterns lit” or “Give Maya a red scarf”' : 'Render this page first — edits change an existing drawing.'}
            className="w-full resize-none rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/50 focus:outline-none disabled:opacity-60"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {region ? (
              <span
                data-testid="region-chip"
                className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/[0.08] py-0.5 pl-2.5 pr-1 text-[12px] text-[var(--ds-ink)]"
              >
                <SquareDashed className="h-3 w-3 text-red-500" aria-hidden />
                {panelN ? `Marked area in panel ${panelN}` : 'Marked area'}
                <button type="button" aria-label="Clear the marked area" onClick={clearRegion} className="grid h-5 w-5 place-items-center rounded-full hover:bg-[var(--ds-hover)]">
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ) : (
              <GhostButton size="xs" disabled={!drawn || busy} onClick={() => setMode('markup')}>
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
                disabled={!drawn}
              >
                <option value="">Whole page</option>
                {page.panels.map((p) => (
                  <option key={p.id} value={p.n}>
                    Panel {p.n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <PrimaryButton className="mt-3 w-full" busy={busyKey === 'edit'} disabled={!canEdit} onClick={submitEdit}>
            <WandSparkles className="h-3.5 w-3.5" aria-hidden /> Apply edit{' '}
            <span className="font-normal opacity-85">· ≈ {formatUsd(editPrice)}</span>
          </PrimaryButton>
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--ds-muted)]">
            Only what you describe changes; the layout, other panels and characters stay. The previous version is kept below.
          </p>
        </section>

        {/* Page actions */}
        <section aria-label="Page actions" className="flex flex-wrap gap-2">
          <GhostButton
            size="sm"
            busy={busyKey === 'render'}
            disabled={busy || !page.panels.length}
            onClick={() => fire('render', () => studio.act({ type: 'render_pages', pageIds: [page.id], force: true }))}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {drawn ? 'Re-render page' : 'Render page'}{' '}
            <span className="text-[var(--ds-muted)]">≈ {formatUsd(renderPrice)}</span>
          </GhostButton>
          {overlayLettering && drawn && (
            <GhostButton
              size="sm"
              busy={busyKey === 'reletter'}
              disabled={busy}
              title="Place the balloons again automatically (balloons you moved stay put)"
              onClick={() => fire('reletter', () => studio.act({ type: 'relayout_balloons', pageId: page.id }))}
            >
              <Type className="h-3.5 w-3.5" aria-hidden /> Re-letter
            </GhostButton>
          )}
        </section>

        {/* QC */}
        {qc && (
          <section aria-labelledby="pe-qc">
            <SectionTitle id="pe-qc" icon={<TriangleAlert className="h-3.5 w-3.5" />} right={<span className="text-[11px] tabular-nums text-[var(--ds-muted)]">match {Math.round((qc.score || 0) * 100)}%</span>}>
              Quality check
            </SectionTitle>
            {issues.length ? (
              <ul className="space-y-1">
                {issues.map((issue, i) => (
                  <li key={i} className="flex gap-2 rounded-lg bg-amber-500/[0.08] px-2.5 py-1.5 text-[12px] leading-snug text-[var(--ds-ink)]">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                    <span>{issue}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-[var(--ds-muted)]">No issues found.</p>
            )}
            {issues.length > 0 && <p className="mt-1.5 text-[11px] text-[var(--ds-muted)]">Tip: describe a fix above, or mark the area and let the AI correct just that.</p>}
            {doc.format.lettering === 'in_art' && qc.textFound && qc.textFound.length > 0 && (
              <p className="mt-2 text-[11.5px] text-[var(--ds-muted)]">
                <span className="font-semibold">Text read on the page:</span> {qc.textFound.join(' · ')}
              </p>
            )}
          </section>
        )}

        <VersionStrip
          render={page.render}
          aspect={aspect}
          label="Versions"
          disabled={busy}
          urlFor={(p) => studio.urlFor(p)}
          onRestore={(path) => fire('restore', () => studio.act({ type: 'restore_render', target: { kind: 'page', id: page.id }, path }))}
        />

        {/* Lettering style (whole comic) */}
        {overlayLettering && (
          <section aria-labelledby="pe-lettering" className="space-y-2">
            <SectionTitle id="pe-lettering" icon={<Type className="h-3.5 w-3.5" />} right={<span className="text-[11px] text-[var(--ds-muted)]">Free</span>}>
              Lettering
            </SectionTitle>
            <PresetGallery value={doc.letterStyle?.presetId ?? 'classic'} onChange={(id) => apply(presetOps(id), { label: 'Change lettering style' })} lang={doc.format.language} />
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

        {/* Script */}
        <section aria-labelledby="pe-script" className="space-y-2">
          <SectionTitle id="pe-script" icon={<MessageSquare className="h-3.5 w-3.5" />}>
            Script
          </SectionTitle>
          <InlineField
            label="Page summary"
            showLabel
            multiline
            value={page.summary}
            onCommit={(summary) => patch([{ op: 'page', id: page.id, patch: { summary } }])}
          />
          <InlineField
            label="Layout (rows of panels)"
            showLabel
            multiline
            value={page.layout}
            placeholder="Row 1: one wide panel. Row 2: two equal panels."
            onCommit={(layout) => patch([{ op: 'page', id: page.id, patch: { layout } }])}
          />
          <p className="px-2 text-[11px] leading-snug text-[var(--ds-muted)]">
            {overlayLettering
              ? 'Dialogue edits update the balloons instantly — no redraw needed. Layout and action edits mark the page out of date.'
              : 'Lettering is drawn into the art on this comic: any script change marks the page out of date until you re-render.'}
          </p>
          <div className="space-y-2">
            {page.panels.map((panel) => (
              <PanelEditor key={panel.id} doc={doc} page={page} panel={panel} selectedLine={selectedLine} onSelectLine={(id) => selection.select(id)} patch={patch} />
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
};

// ── Shell ────────────────────────────────────────────────────────────────────

export const PageEditor: React.FC<{ studio: StudioController; doc: ComicDoc; pageId: string }> = ({ studio, doc, pageId }) => {
  const page = findPage(doc, pageId);
  const pages = useMemo(() => [...doc.pages].sort((a, b) => a.n - b.n), [doc.pages]);
  const index = page ? pages.findIndex((p) => p.id === page.id) : -1;
  const prev = index > 0 ? pages[index - 1] : undefined;
  const next = index >= 0 && index < pages.length - 1 ? pages[index + 1] : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => studio.openPage(null), [studio]);
  useDialogA11y(true, close);
  useFocusTrap(rootRef, true);

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
      if (e.altKey || mod) return;
      // Never turn the page while balloons are selected (arrows nudge them instead).
      if (studio.selection && studio.selection.lineIds.length > 0) return;
      if (e.key === 'ArrowLeft' && prev) {
        e.preventDefault();
        studio.openPage(prev.id);
      } else if (e.key === 'ArrowRight' && next) {
        e.preventDefault();
        studio.openPage(next.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prev, next, studio]);

  if (!page) return null;
  const status = pageVisualStatus(doc, page);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70] bg-black/45 backdrop-blur-sm lg:p-4" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div
          ref={rootRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Page ${page.n} editor`}
          tabIndex={-1}
          className="flex h-full w-full flex-col overflow-hidden bg-[var(--ds-canvas)] shadow-2xl focus:outline-none lg:rounded-2xl lg:border lg:border-[var(--ds-hairline)]"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-2">
            <IconButton label="Previous page" disabled={!prev} onClick={() => prev && studio.openPage(prev.id)}>
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold text-[var(--ds-ink)]">
                  Page {page.n} <span className="font-normal text-[var(--ds-muted)]">of {pages.length}</span>
                </h2>
                <StatusChip status={status} label={status === 'stale' ? 'Out of date' : undefined} />
              </div>
              {page.summary && <p className="truncate text-[12px] text-[var(--ds-muted)]">{page.summary}</p>}
            </div>
            <IconButton label="Next page" disabled={!next} onClick={() => next && studio.openPage(next.id)}>
              <ChevronRight className="h-4 w-4" />
            </IconButton>
            <IconButton label="Close editor" onClick={close}>
              <X className="h-4 w-4" />
            </IconButton>
          </header>
          <EditorBody key={page.id} studio={studio} doc={doc} page={page} />
        </div>
      </div>
    </ModalPortal>
  );
};
