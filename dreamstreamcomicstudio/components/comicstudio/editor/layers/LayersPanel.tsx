// The Layers panel (agent-editor plan §3 C1, C9; master plan §2.4, §2.7 chrome rules, §2.9). It is the keyboard and
// screen-reader path to every object on the page: each object is a labelled role=group row, and every move is
// announced in a polite live region.
//
//   click             select (Shift / ⌘ / Ctrl adds or removes); on touch, the row's checkbox multi-selects. Overlay
//                     rows select the same way (Enter / Space too) through the shell's selectLayers, so the arrows
//                     nudge them (graft 4)
//   drag a row        onto another row of its panel: restack in front of / behind it (zOrderEdit, within the
//                     lettering band — lettering always stays above overlays); onto another panel's row, header or
//                     empty group: move the line there (line_move, its translations travel with it)
//   Alt+↑ / Alt+↓     the same restack without a drag (WCAG 2.5.7); Alt+← / Alt+→ move to the previous / next panel
//   eye               hide in this view only (no edit, nothing saved)
//   lock              lock / unlock (balloon {locked}, layer {locked})
//   badge             "Director is editing" while the director works on that balloon (StudioController.presence); on
//                     touch, where the 44 px controls fill the row, it is the director's icon with the words for
//                     screen readers
//
// Every edit is free, undoable and labelled, through the shell's `apply` (studio.patch); never editActionFor, never
// studio.act. Rows: h-8 on the overlay-hover token; the selected row is accent-soft with a 3 px ink edge.

import React, { useMemo, useRef, useState } from 'react';
import { Bot, Eye, EyeOff, GripVertical, Lock, LockOpen } from 'lucide-react';
import type { DocOp } from '../../../../shared/comic/ops';
import type { LetterPlan } from '../../../../shared/comic/lettering/layout';
import { LETTERING_ON_TOP_NOTE } from '../../../../shared/comic/pro/types';
import { BANDS, zOrderEdit, type EditResult } from '../../../../shared/comic/editor/scene';
import { cn } from '../../../../lib/utils';
import { ACCENT_SOFT_BG, FOCUS_RING, INK, MUTED, OVERLINE, RADIUS_CONTROL, RADIUS_PILL } from '../../../chat/studioDesign';
import { LINE_KIND_LABEL } from '../../board/boardModel';
import { lockOps, moveLineToPanelOps, pinKeepingSizeOps } from '../../lettering/styleOps';
import { restackEdit, sceneFor } from '../../lettering/proStyleOps';
import type { PartPanelProps } from '../inspector/types';
import { balloonRows, layersModel, type LayerRow } from './layersModel';
import { setViewHidden, useViewHidden } from './viewHidden';

/** The words the Layers badge shows while the director edits a balloon (A4 fills StudioController.presence). */
export const DIRECTOR_EDITING = 'Director is editing';

const ROW = cn(
  'group/row flex min-h-8 min-w-0 items-center gap-1 pl-1 pr-0.5 text-[12px] hover:bg-[var(--ds-overlay-hover)] coarse:min-h-11',
  RADIUS_CONTROL,
  INK,
  FOCUS_RING
);
/** Selected: accent-soft with a 3 px ink edge (an inset shadow, so nothing shifts). */
const ROW_SELECTED = cn(ACCENT_SOFT_BG, 'shadow-[inset_3px_0_0_0_var(--ds-ink)]');
const ICON_BTN = cn(
  'grid h-7 w-7 shrink-0 place-items-center hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:cursor-not-allowed disabled:opacity-40 coarse:h-11 coarse:min-h-11 coarse:w-11 coarse:min-w-11',
  RADIUS_CONTROL,
  MUTED,
  FOCUS_RING
);
const KIND_SHORT: Record<string, string> = { speech: 'Speech', thought: 'Thought', whisper: 'Whisper', shout: 'Shout', caption: 'Caption', sfx: 'SFX' };

export type LayersPanelProps = PartPanelProps;

/** What an empty panel group says (while a line is dragged, where it can go). */
export const EMPTY_PANEL_HINT = 'No lettering yet';
export const EMPTY_PANEL_DROP_HINT = 'Drop here to move the line to this panel';

export const LayersPanel: React.FC<LayersPanelProps> = ({ studio, doc, page, plans, placements, selection, selectLayers, apply, editionLang, presence }) => {
  const bands = useMemo(() => layersModel(doc, page, { plans, lang: editionLang }), [doc, page, plans, editionLang]);
  const hidden = useViewHidden(page.id);
  const [said, setSaid] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const selected = new Set(selection.ids);
  // The overlays the studio has selected on this page (selectLayers sets them; the balloon selection is then empty).
  const studioSel = studio?.selection;
  const selectedLayers = new Set(studioSel && studioSel.pageId === page.id ? (studioSel.layerIds ?? []) : []);
  const inEdition = !!editionLang;
  const inOriginal = inEdition ? 'Stacking, locks and panels belong to the original language — switch to it to change them.' : undefined;
  const lettering = balloonRows(bands);
  const rowById = new Map(lettering.map((r) => [r.id, r]));
  const directorOn = (id: string) => !!presence && (!presence.pageId || presence.pageId === page.id) && presence.lineIds.includes(id);

  const send = (ops: DocOp[], label: string, announce: string) => {
    if (!ops.length) return;
    apply(ops, { label });
    setSaid(announce);
  };
  const sendEdit = (r: EditResult, announce: string) => {
    if (r.ok === false) {
      setSaid(r.reason);
      return;
    }
    send(r.ops, r.label, announce);
  };

  /** Select an overlay (Shift / ⌘ / Ctrl adds or removes), through the shell's selectLayers. */
  const chooseLayer = (row: LayerRow, add: boolean) => {
    if (!selectLayers) return;
    const now = [...selectedLayers];
    const next = add ? (selectedLayers.has(row.id) ? now.filter((x) => x !== row.id) : [...now, row.id]) : [row.id];
    selectLayers(next);
    const one = next.length === 1 ? bands.flatMap((b) => b.groups.flatMap((g) => g.rows)).find((r) => r.id === next[0]) : undefined;
    setSaid(next.length === 0 ? 'Nothing selected' : one ? `${one.label} selected` : `${next.length} overlays selected`);
  };

  const choose = (id: string, add: boolean) => {
    if (add) {
      const next = selected.has(id) ? selection.ids.filter((x) => x !== id) : [...selection.ids, id];
      // Reading order, as the editor keeps it.
      const order = lettering.map((r) => r.id);
      selection.set(next.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      setSaid(next.length === 1 ? '1 balloon selected' : `${next.length} balloons selected`);
    } else {
      selection.set([id]);
      setSaid(`${rowById.get(id)?.label ?? 'Balloon'} selected`);
    }
  };

  /** Drop `id` on balloon row `targetId` (same panel: restack; other panel: move there, at that place). */
  const dropOnRow = (id: string, targetId: string) => {
    const from = rowById.get(id);
    const to = rowById.get(targetId);
    if (!from || !to || id === targetId || inEdition) return;
    if (from.panelId === to.panelId) {
      sendEdit(restackEdit(doc, page, plans as LetterPlan[], id, targetId, placements.balloons), `${from.label}: restacked`);
      return;
    }
    const panel = page.panels.find((p) => p.id === to.panelId);
    if (!panel) return;
    const index = panel.lines.findIndex((l) => l.id === targetId);
    send(moveLineToPanelOps(page, id, panel.id, index < 0 ? panel.lines.length : index), 'Move line to another panel', `Moved to panel ${panel.n}`);
  };
  /** Drop `id` on a panel group's header: move the line to the end of that panel. */
  const dropOnPanel = (id: string, panelId: string) => {
    const from = rowById.get(id);
    const panel = page.panels.find((p) => p.id === panelId);
    if (!from || !panel || from.panelId === panelId || inEdition) return;
    send(moveLineToPanelOps(page, id, panelId, panel.lines.length), 'Move line to another panel', `Moved to panel ${panel.n}`);
  };

  const restackStep = (row: LayerRow, dir: 'forward' | 'backward') => {
    if (inEdition) return;
    const r = zOrderEdit(doc, page, { kind: 'balloon', id: row.id }, dir, sceneFor(doc, page, plans));
    // A software-placed line has no stored balloon: restack it against its neighbour so its whole balloon is stored.
    if (r.ok && !page.balloons.some((b) => b.lineId === row.id)) {
      const order = sceneFor(doc, page, plans).objects.filter((o) => o.kind === 'balloon').map((o) => o.id);
      const at = order.indexOf(row.id);
      const other = order[dir === 'forward' ? at + 1 : at - 1];
      if (other) return sendEdit(restackEdit(doc, page, plans as LetterPlan[], row.id, other, placements.balloons), dir === 'forward' ? 'Brought forward' : 'Sent backward');
    }
    sendEdit(r, dir === 'forward' ? 'Brought forward' : 'Sent backward');
  };
  const movePanelStep = (row: LayerRow, dir: -1 | 1) => {
    if (inEdition) return;
    const i = page.panels.findIndex((p) => p.id === row.panelId);
    const panel = page.panels[i + dir];
    if (!panel) {
      setSaid(dir < 0 ? 'Already in the first panel' : 'Already in the last panel');
      return;
    }
    send(moveLineToPanelOps(page, row.id, panel.id, dir < 0 ? panel.lines.length : 0), 'Move line to another panel', `Moved to panel ${panel.n}`);
  };
  const toggleLock = (row: LayerRow) => {
    if (inEdition) return;
    if (row.kind === 'overlay') {
      send([{ op: 'layer', pageId: page.id, id: row.id, patch: { locked: row.locked ? null : true } }], row.locked ? 'Unlock overlay' : 'Lock overlay', row.locked ? 'Unlocked' : 'Locked');
      return;
    }
    const ops = row.locked ? lockOps(page, [row.id], false, placements.balloons) : pinKeepingSizeOps(lockOps(page, [row.id], true, placements.balloons), page, plans as LetterPlan[], [row.id], editionLang);
    send(ops, row.locked ? 'Unlock balloon' : 'Lock balloon', row.locked ? 'Unlocked' : 'Locked');
  };
  const toggleHidden = (row: LayerRow) => {
    const now = setViewHidden(page.id, row.id);
    setSaid(now ? `${row.label}: hidden in this view` : `${row.label}: shown`);
  };

  const rowControls = (row: LayerRow) => (
    <>
      <button
        type="button"
        aria-pressed={hidden.has(row.id)}
        aria-label={hidden.has(row.id) ? `Show ${row.label} in this view` : `Hide ${row.label} in this view`}
        title="Hide in this view only — readers and exports are unchanged"
        className={ICON_BTN}
        onClick={(e) => {
          e.stopPropagation();
          toggleHidden(row);
        }}
      >
        {hidden.has(row.id) ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
      </button>
      <button
        type="button"
        aria-pressed={row.locked}
        aria-label={row.locked ? `Unlock ${row.label}` : `Lock ${row.label}`}
        title={inOriginal ?? (row.locked ? 'Unlock: drags and the editor may move it again' : 'Lock: nothing moves it')}
        disabled={inEdition || (row.kind === 'balloon' && row.drawn === false)}
        className={ICON_BTN}
        onClick={(e) => {
          e.stopPropagation();
          toggleLock(row);
        }}
      >
        {row.locked ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <LockOpen className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </>
  );

  const balloonRow = (row: LayerRow) => {
    const on = selected.has(row.id);
    const editing = directorOn(row.id);
    return (
      <div
        key={row.id}
        role="group"
        aria-label={`${row.label}${row.speaker ? `, ${row.speaker}` : ''}${on ? ', selected' : ''}${row.locked ? ', locked' : ''}`}
        data-row-id={row.id}
        data-selected={on || undefined}
        tabIndex={0}
        draggable={!inEdition}
        onClick={(e) => choose(row.id, e.shiftKey || e.metaKey || e.ctrlKey)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose(row.id, e.shiftKey);
          } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            restackStep(row, e.key === 'ArrowUp' ? 'forward' : 'backward');
          } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            movePanelStep(row, e.key === 'ArrowLeft' ? -1 : 1);
          }
        }}
        onDragStart={(e) => {
          dragging.current = row.id;
          setDragActive(true);
          try {
            e.dataTransfer?.setData('text/plain', row.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          } catch {
            /* some browsers refuse custom data: the ref carries it */
          }
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDragActive(false);
          setOver(null);
        }}
        onDragOver={(e) => {
          if (!dragging.current || dragging.current === row.id) return;
          e.preventDefault();
          setOver(row.id);
        }}
        onDragLeave={() => setOver((cur) => (cur === row.id ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          const id = dragging.current;
          dragging.current = null;
          setDragActive(false);
          setOver(null);
          if (id) dropOnRow(id, row.id);
        }}
        className={cn(ROW, on && ROW_SELECTED, over === row.id && 'ring-1 ring-[var(--ds-ink)]', hidden.has(row.id) && 'opacity-60')}
      >
        <span aria-hidden className={cn('grid h-7 w-4 shrink-0 cursor-grab place-items-center coarse:h-11', MUTED)}>
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <input
          type="checkbox"
          aria-label={`Select ${row.label}`}
          checked={on}
          onClick={(e) => e.stopPropagation()}
          onChange={() => choose(row.id, true)}
          className="hidden h-5 w-5 shrink-0 accent-[var(--ds-accent)] coarse:inline-block coarse:min-h-11 coarse:min-w-11"
        />
        <span className={cn('shrink-0 border border-[var(--ds-hairline)] px-1 text-[10px] font-medium leading-4', RADIUS_PILL, MUTED)}>{KIND_SHORT[row.lineKind ?? 'speech'] ?? LINE_KIND_LABEL.speech}</span>
        <span className="min-w-0 flex-1 truncate">
          {row.text ? `“${row.text}”` : <span className={MUTED}>Empty line</span>}
          {row.speaker && <span className={cn('ml-1', MUTED)}>· {row.speaker}</span>}
        </span>
        {editing && (
          <span
            data-testid="director-editing"
            title={DIRECTOR_EDITING}
            className={cn('inline-flex shrink-0 items-center gap-1 border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-1.5 text-[10.5px] font-medium leading-4 coarse:px-1', RADIUS_PILL, INK)}
          >
            <Bot className="h-3 w-3 shrink-0" aria-hidden />
            <span className="coarse:sr-only">{DIRECTOR_EDITING}</span>
          </span>
        )}
        {rowControls(row)}
      </div>
    );
  };

  const objectRow = (row: LayerRow) => {
    // Overlays select (the shell's selectLayers); frame and page rows are read-only in S2 (PE-PROPS adds their rows).
    const pick = row.kind === 'overlay' && !!selectLayers;
    const on = pick && selectedLayers.has(row.id);
    return (
      <div
        key={row.id}
        role="group"
        aria-label={`${row.label}${on ? ', selected' : ''}${row.locked ? ', locked' : ''}${row.guide ? ', guide only' : ''}`}
        data-row-id={row.id}
        data-selected={on || undefined}
        tabIndex={pick ? 0 : undefined}
        onClick={pick ? (e) => chooseLayer(row, e.shiftKey || e.metaKey || e.ctrlKey) : undefined}
        onKeyDown={
          pick
            ? (e) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                chooseLayer(row, e.shiftKey || e.metaKey || e.ctrlKey);
              }
            : undefined
        }
        className={cn(ROW, 'pl-2', on && ROW_SELECTED, hidden.has(row.id) && 'opacity-60')}
      >
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.guide && <span className={cn('shrink-0 text-[10.5px]', MUTED)}>Guide</span>}
        {row.kind === 'overlay' && rowControls(row)}
      </div>
    );
  };

  /** A lettering group's drop target (its header, and an empty group's hint): the line moves to the end of the panel. */
  const dropTarget = (g: { id: string; panelId?: string }) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging.current || !g.panelId || rowById.get(dragging.current)?.panelId === g.panelId) return;
      e.preventDefault();
      setOver(g.id);
    },
    onDragLeave: () => setOver((cur) => (cur === g.id ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const id = dragging.current;
      dragging.current = null;
      setDragActive(false);
      setOver(null);
      if (id && g.panelId) dropOnPanel(id, g.panelId);
    }
  });

  return (
    <div className="min-w-0 space-y-3" data-testid="layers-panel">
      <p role="status" aria-live="polite" className="sr-only" data-testid="layers-live">
        {said}
      </p>
      {inOriginal && <p className={cn('m-0 text-[11px] leading-snug', MUTED)}>{inOriginal}</p>}
      {bands.map((band) => (
        <section key={band.band} aria-label={band.title} className="min-w-0 space-y-1">
          <h4 className={cn('m-0', OVERLINE)}>{band.title}</h4>
          {band.band === BANDS.lettering && <p className={cn('m-0 text-[11px] leading-snug', MUTED)}>{LETTERING_ON_TOP_NOTE}</p>}
          {band.groups.map((g) => (
            <div key={g.id} role="group" aria-label={band.band === BANDS.lettering ? `${g.title} lettering` : band.band === BANDS.art ? `${g.title} art` : g.title} className="min-w-0 space-y-0.5" data-group={g.id}>
              {band.band === BANDS.lettering ? (
                <>
                  <h5 className={cn('m-0 px-1 pt-1 text-[11px] font-semibold', over === g.id ? cn(INK, 'underline') : MUTED)} {...dropTarget(g)} data-drop-panel={g.panelId}>
                    {g.title}
                  </h5>
                  {g.rows.length === 0 && (
                    <p
                      {...dropTarget(g)}
                      data-drop-empty={g.panelId}
                      className={cn('m-0 flex min-h-8 items-center border border-dashed px-2 text-[11px] coarse:min-h-11', RADIUS_CONTROL, over === g.id ? cn('border-[var(--ds-ink)]', INK) : cn('border-[var(--ds-hairline)]', MUTED))}
                    >
                      {dragActive ? EMPTY_PANEL_DROP_HINT : EMPTY_PANEL_HINT}
                    </p>
                  )}
                </>
              ) : g.head ? (
                objectRow(g.head)
              ) : null}
              {g.rows.map((r) => (r.kind === 'balloon' ? balloonRow(r) : objectRow(r)))}
            </div>
          ))}
        </section>
      ))}
      {lettering.length > 0 && (
        <p className={cn('m-0 text-[11px] leading-snug', MUTED)}>
          Drag a row to restack it or move it to another panel — or use Alt with the arrow keys.
        </p>
      )}
    </div>
  );
};

export default LayersPanel;
