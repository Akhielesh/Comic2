import type { Box, Page } from './doc.js';

export type PanelEditBounds = { ok: true; box: Box } | { ok: false; reason: string };

const unavailable = (reason: string): PanelEditBounds => ({ ok: false, reason });
const MARK_AREA = 'Mark an area inside the panel to edit it safely.';
const validBox = (box: Box | undefined): box is Box => !!box &&
  [box.x, box.y, box.w, box.h].every(Number.isFinite) &&
  box.x >= 0 && box.y >= 0 && box.w >= 0.02 && box.h >= 0.02 &&
  box.x + box.w <= 1.000001 && box.y + box.h <= 1.000001;
const overlaps = (a: Box, b: Box): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.000001 &&
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.000001;

/**
 * An editable rectangle on the CURRENT raster, never an estimated layout or a transformed frame.
 * A user-confirmed cut is a manual rectangle. Otherwise the existing vision check must have measured
 * both its shape and its script-panel identity. Old checks deliberately remain unknown.
 */
export function panelEditBounds(page: Page, panelN: number): PanelEditBounds {
  const panels = page.panels.filter((panel) => panel.n === panelN);
  if (!Number.isInteger(panelN) || panels.length !== 1) return unavailable('That panel is no longer on this page.');
  const panel = panels[0];
  if (panel.frame?.locked) return unavailable(`Panel ${panelN} is locked. Unlock it before editing its art.`);
  if (page.artMode === 'panels' || panel.frame?.src || panel.frame?.fit) {
    return unavailable(`This panel uses a separate or repositioned picture. ${MARK_AREA}`);
  }
  const qc = page.render.qc;
  const cuts = page.render.cuts;
  if (cuts?.status === 'mismatch' || cuts?.status === 'unsure') return unavailable(`The panel boundaries need review. ${MARK_AREA}`);
  if (qc?.crosses?.length || cuts?.cuts.some((cut) => cut.crosses)) {
    return unavailable(`Art crosses a panel border on this page. ${MARK_AREA}`);
  }

  // Only user-confirmed rectangles can bypass a measured shape. Detection/vision boxes alone do not
  // establish that a diagonal, inset or overlapping panel is safe to replace as a rectangle.
  if (cuts?.status === 'ok' && cuts.by === 'user') {
    const named = cuts.cuts.filter((cut) => cut.panelId === panel.id);
    const index = page.panels.indexOf(panel);
    const cut = named.length === 1 ? named[0]
      : !cuts.cuts.some((item) => item.panelId) && cuts.cuts.length === page.panels.length ? cuts.cuts[index] : undefined;
    if (cut && validBox(cut.box) && cuts.cuts.every((item) => validBox(item.box)) &&
      !cuts.cuts.some((item) => item !== cut && overlaps(cut.box, item.box))) {
      return { ok: true, box: { ...cut.box } };
    }
    return unavailable(`The confirmed panel bounds are missing or overlap. ${MARK_AREA}`);
  }

  const boxes = qc?.panelBoxes;
  const beats = qc?.beats;
  if (qc?.boxesFrom !== 'vision' || boxes?.length !== page.panels.length || !boxes.every(validBox) ||
    beats?.length !== boxes.length || new Set(beats).size !== beats.length ||
    !beats.every((n) => page.panels.some((item) => item.n === n)) || !Array.isArray(qc.crosses)) {
    return unavailable(`This panel has no verified rectangular boundary yet. ${MARK_AREA}`);
  }
  const index = beats.indexOf(panelN);
  if (qc.panelShapes?.[index] !== 'rect') {
    return unavailable(qc.panelShapes?.[index] === 'other'
      ? `This panel is not rectangular. ${MARK_AREA}`
      : `This panel's shape has not been checked. ${MARK_AREA}`);
  }
  const box = boxes[index];
  if (boxes.some((other, i) => i !== index && overlaps(box, other))) {
    return unavailable(`The measured panel bounds overlap. ${MARK_AREA}`);
  }
  return { ok: true, box: { ...box } };
}
