// Page editor — a focused, full-screen workspace for one page.
//
// Left: the page, large, with editable overlay balloons (drag / arrow keys / tail and
// width handles) and a Mark-up mode: drag a box on the art to show the AI exactly what
// to change. Right: "Edit with AI" (instruction + marked area → a scoped image edit of
// this page, with its price), re-render / re-letter, the vision QC report, every saved
// version (restore any), and the script itself — panel actions and lines (text, speaker,
// kind; add/remove) edited in place. ←/→ move between pages; Esc closes.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type Mode = 'move' | 'markup';

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
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [lettering, setLettering] = useState(true);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
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

  // Fit the page inside the stage (both dimensions). Phones get a tighter frame so the page is as big as it can be.
  const pad = stage.width > 0 && stage.width < 640 ? 12 : 24;
  const availW = Math.max(0, stage.width - pad * 2);
  const availH = Math.max(0, stage.height - pad * 2);
  const pageWidth = availW && availH ? Math.min(availW, availH * aspect) : undefined;

  const patch = useCallback((ops: DocOp[]) => void studio.patch(ops), [studio]);
  const onBalloonChange = useCallback(
    (lineId: string, p: Partial<Balloon>) => void studio.patch([{ op: 'balloon', pageId: page.id, lineId, patch: p }]),
    [studio, page.id]
  );

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
      <div className="flex h-[74vh] min-h-[320px] shrink-0 flex-col sm:h-[62vh] lg:h-auto lg:min-h-0 lg:flex-1">
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <Segmented<Mode>
            label="Editing mode"
            size="xs"
            value={mode}
            onChange={(m) => setMode(m)}
            options={[
              { value: 'move', label: (<><MousePointer2 className="h-3 w-3" aria-hidden /> {overlayLettering ? 'Move balloons' : 'View'}</>) },
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
          <span className="ml-auto hidden text-[11px] text-[var(--ds-muted)] xl:inline">
            {mode === 'markup'
              ? 'Drag on the page to mark what should change.'
              : overlayLettering
                ? 'Drag balloons · arrow keys nudge · Alt+arrows aim the tail'
                : 'Lettering is drawn into the art on this comic.'}
          </span>
        </div>
        <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center p-3 sm:p-6">
          <div style={{ width: pageWidth ? `${pageWidth}px` : '100%', maxWidth: '100%' }} className="shadow-[0_10px_40px_rgba(0,0,0,0.25)]">
            <ComicPageView
              doc={doc}
              page={page}
              imageUrl={imageUrl}
              editable={mode === 'move' && overlayLettering && !busy}
              onBalloonChange={onBalloonChange}
              selectedLineId={selectedLine}
              onSelectLine={setSelectedLine}
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
              <PanelEditor key={panel.id} doc={doc} page={page} panel={panel} selectedLine={selectedLine} onSelectLine={setSelectedLine} patch={patch} />
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
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || isEditableTarget(e.target)) return;
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
