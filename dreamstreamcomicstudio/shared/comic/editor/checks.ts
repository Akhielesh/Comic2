// The per-page quality checklist (Ship 2, B9; pro plan §4.6, design §4.16): one pure function that feeds the canvas
// badges, the "Checks 5/6" chip and the list. Each check is ok, look or unknown — "unknown" is honest (this page was
// checked before that check existed) and offers the paid re-check; free fixes come first, as K2a ops when they are
// cheap to make here, else as a named fix the editor resolves (checkFixEdit). Runs on every edit: no image reads, no
// network, no clock; well under 2 ms on a 9-panel page.

import { isPageStale, type Box, type ComicDoc, type Line, type LineKind, type Page, type Panel, type PanelDirection, type PanelParts } from '../doc.js';
import { fitState, hardFitLimit, needMeter, panelFit, type NeedMeter } from '../density.js';
import { coverCapFor, outlineFill, type LetterPlan } from '../lettering/layout.js';
import { resolveLetterStyle, type LetterStylePatch } from '../lettering/style.js';
import { EDITOR_LIMITS } from '../limits.js';
import type { DocOp } from '../ops.js';
import { OFF_PANEL_SHOTS } from '../panelRules.js';
import { frameAffine, pageSpaceQc, upscaleOf } from '../panelize/space.js';
import { partsOf } from '../parts.js';
import { closeGapEdit, deleteFrameEdit, makeBiggestEdit } from './frames.js';
import { lineOrderIssues, panelOrderIssue } from './readingOrder.js';
import { buildScene, cap1, editOf, framesEditable, framesShown, intersectBox, isUndrawn, planOutlineBox, refuse, type EditResult, type PageScene, type SceneRef } from './scene.js';
import { applyTemplateEdit, bestTemplate, templateFit, templateById } from './templates.js';

export type CheckState = 'ok' | 'look' | 'unknown';
export type CheckId = 'text' | 'faces' | 'characters' | 'speakers' | 'order' | 'plan' | 'sharp' | 'empty' | 'fresh';

export type FixKey =
  // free, resolved here or with ops
  | 'make_bigger'
  | 'move_line'
  | 'template'
  | 'shrink_text'
  | 'renumber'
  | 'swap_lines'
  | 'looks_fine'
  | 'off_panel'
  | 'caption'
  | 'delete_panel'
  | 'close_gap'
  // free, done by the editor or the server (no ops here)
  | 'check_edges'
  | 'move_clear'
  | 'widen'
  | 'drop_image'
  | 'smaller'
  | 'rebind'
  | 'accept_state'
  | 'drop_cast'
  | 'undo_changes'
  // paid, always quoted and approved first
  | 'recheck'
  | 'redraw_panel'
  | 'redraw_page'
  | 'edit_ai';

export interface CheckFix {
  key: FixKey;
  /** Plain words; prices are added by the editor (formatCostForUser), never here. */
  label: string;
  free: boolean;
  /** The edit, when it is cheap to make here. */
  ops?: DocOp[];
  panelId?: string;
  lineIds?: string[];
  templateId?: string;
  findingId?: string;
  /** rebind: the drawn-panel order the check read. */
  order?: number[];
}

export interface PageCheck {
  id: CheckId;
  state: CheckState;
  title: string;
  detail: string;
  /** What the canvas highlights. */
  targets: SceneRef[];
  /** Free fixes first, then paid ones. */
  fixes: CheckFix[];
}

export interface CheckOptions {
  /** The lettering plans the canvas draws: exact coverage, overflow and safe-area flags. Without them: density fit. */
  plans?: readonly LetterPlan[];
  scene?: PageScene;
  meter?: NeedMeter;
}

const TITLES: Record<CheckId, string> = {
  text: 'Text fits',
  faces: 'Faces clear',
  characters: 'Characters',
  speakers: 'Speakers drawn',
  order: 'Reading order',
  plan: 'Panels match the plan',
  sharp: 'Sharp',
  empty: 'Empty panels',
  fresh: 'Up to date'
};
const RECHECK: CheckFix = { key: 'recheck', label: 'Re-check this page', free: false };
const pct = (v: number) => `${Math.round(v * 100)}%`;
const check = (id: CheckId, state: CheckState, detail: string, targets: SceneRef[] = [], fixes: CheckFix[] = []): PageCheck => ({ id, state, title: TITLES[id], detail, targets, fixes });
const frameRef = (id: string): SceneRef => ({ kind: 'frame', id });
const nameOf = (doc: ComicDoc, castId?: string) => (castId && doc.cast.find((c) => c.id === castId)?.name) || 'Someone';
const PART_WORDS: Record<keyof PanelParts, string> = { c: "who's in it", a: 'what happens', p: 'the place', s: 'the shot', m: 'the mood', d: 'the direction' };

/**
 * One need meter per lettering setup. Docs are immutable and an edit keeps every subtree it does not touch, so the
 * meter (and its per-line measurements) carries over from edit to edit while the format, the lettering style and the
 * cast are the same objects; changing any of them starts a fresh meter.
 */
const meters = new WeakMap<object, { letterStyle: unknown; cast: unknown; meter: NeedMeter }>();
const meterFor = (doc: ComicDoc): NeedMeter => {
  const key = doc.format as object;
  const hit = key ? meters.get(key) : undefined;
  if (hit && hit.letterStyle === doc.letterStyle && hit.cast === doc.cast) return hit.meter;
  const meter = needMeter(doc);
  if (key) meters.set(key, { letterStyle: doc.letterStyle, cast: doc.cast, meter });
  return meter;
};

// ── Text fits ────────────────────────────────────────────────────────────────

function textCheck(doc: ComicDoc, page: Page, boxes: Box[], scene: PageScene, opts: CheckOptions, meter: NeedMeter): PageCheck {
  const hard = hardFitLimit(doc);
  const cap = coverCapFor(doc);
  const plans = opts.plans;
  let worst: { panel: Panel; value: number; measured: boolean } | undefined;
  const looks: string[] = [];
  page.panels.forEach((panel, i) => {
    const box = boxes[i];
    if (!box || !panel.lines.length) return;
    const area = box.w * box.h;
    let value: number;
    let measured = false;
    if (plans) {
      let covered = 0;
      for (const plan of plans) {
        const o = planOutlineBox(plan, scene.aspect);
        const hit = intersectBox(o, box);
        if (hit) covered += outlineFill(plan.style.shape) * hit.w * hit.h;
      }
      value = area > 0 ? covered / area : 0;
      measured = true;
    } else value = panelFit(meter.panel(panel.lines, box), area);
    const over = measured ? value > cap + 1e-9 : fitState(value, hard) === 'overfull';
    if (over) {
      looks.push(panel.id);
      if (!worst || value > worst.value) worst = { panel, value, measured };
    }
  });
  const overflow = (plans || []).filter((p) => p.overflow);
  const outside = (plans || []).filter((p) => p.outOfSafeArea);
  if (!worst && !overflow.length && !outside.length) {
    const words = page.panels.some((p) => p.lines.some((l) => l.text && l.text.trim()));
    return check('text', 'ok', words ? 'The words fit their panels.' : 'No words on this page yet.');
  }
  const targets: SceneRef[] = [...looks.map(frameRef), ...overflow.map((p) => ({ kind: 'balloon' as const, id: p.lineId })), ...outside.map((p) => ({ kind: 'balloon' as const, id: p.lineId }))];
  const fixes: CheckFix[] = [];
  let detail: string;
  if (worst) {
    const n = worst.panel.n;
    detail = `Panel ${n}: balloons cover ${worst.measured ? '' : 'about '}${pct(worst.value)} of the panel`;
    if (framesEditable(page)) fixes.push({ key: 'make_bigger', label: `Make panel ${n} bigger`, free: true, panelId: worst.panel.id });
    // Move its last line to the roomiest other panel (by fit after the move).
    const last = [...worst.panel.lines].reverse().find((l) => l.text && l.text.trim());
    if (last) {
      let best: { panel: Panel; fit: number } | undefined;
      page.panels.forEach((p, i) => {
        if (p.id === worst!.panel.id || !boxes[i] || p.lines.length >= 8) return;
        const fit = panelFit(meter.panel([...p.lines, last], boxes[i]), boxes[i].w * boxes[i].h);
        if (fitState(fit, hard) !== 'overfull' && (!best || fit < best.fit)) best = { panel: p, fit };
      });
      if (best) {
        const ops: DocOp[] = [{ op: 'line_move', pageId: page.id, id: last.id, toPanelId: best.panel.id, index: best.panel.n > n ? 0 : best.panel.lines.length }];
        if (page.balloons.some((b) => b.lineId === last.id)) ops.push({ op: 'balloons', pageId: page.id, balloons: page.balloons.filter((b) => b.lineId !== last.id) });
        fixes.push({ key: 'move_line', label: `Move a line to panel ${best.panel.n}`, free: true, ops, lineIds: [last.id], panelId: best.panel.id });
      }
    }
    if (isUndrawn(page) || framesEditable(page)) {
      const t = bestTemplate(doc, page, meter);
      const cur = t ? templateFit(doc, page, t, meter) : null;
      if (t && cur && cur.worst !== 'overfull') fixes.push({ key: 'template', label: `Use the roomier “${t.name}” layout`, free: true, templateId: t.id });
    }
    const lineIds = worst.panel.lines.map((l) => l.id);
    const ops: DocOp[] = worst.panel.lines.map((l) => {
      const scale = Math.max(0.5, Math.round(resolveLetterStyle(doc, l).sizeScale * 0.9 * 100) / 100);
      return { op: 'line_style', pageId: page.id, lineIds: [l.id], patch: { sizeScale: scale } as LetterStylePatch };
    });
    fixes.push({ key: 'shrink_text', label: `Make the text in panel ${n} 10% smaller`, free: true, ops, lineIds, panelId: worst.panel.id });
  } else if (overflow.length) {
    const p = overflow[0];
    detail = `A balloon in panel ${p.panelN} is too narrow for its words`;
    fixes.push({ key: 'widen', label: 'Widen it', free: true, lineIds: overflow.map((x) => x.lineId) });
  } else {
    const p = outside[0];
    detail = `A balloon in panel ${p.panelN} runs past the safe margin, where printing can cut it`;
    fixes.push({ key: 'move_clear', label: 'Move it inside', free: true, lineIds: outside.map((x) => x.lineId) });
  }
  return check('text', 'look', detail, targets, fixes);
}

// ── Faces ────────────────────────────────────────────────────────────────────

function facesCheck(doc: ComicDoc, page: Page, scene: PageScene): PageCheck {
  if (doc.format?.lettering === 'in_art') return check('faces', 'ok', 'The lettering is drawn into the art.');
  const qc = pageSpaceQc(doc, page);
  if (!qc || (!Array.isArray(qc.keepOut) && !Array.isArray(qc.heads))) {
    return check('faces', 'unknown', 'Not checked: this page was drawn before face checks.', [], [RECHECK]);
  }
  const balloons = scene.objects.filter((o) => o.kind === 'balloon');
  const faces = (qc.keepOut || []).filter((k) => k && k.kind === 'face' && k.box);
  for (const b of balloons) {
    for (const f of faces) {
      const hit = intersectBox(b.box, f.box);
      if (hit && hit.w * hit.h > 0.2 * f.box.w * f.box.h) {
        const head = (qc.heads || []).find((h) => h && h.panel === f.panel && h.head && h.head.x >= f.box.x && h.head.x <= f.box.x + f.box.w && h.head.y >= f.box.y && h.head.y <= f.box.y + f.box.h);
        const who = head?.characterId ? `${nameOf(doc, head.characterId)}'s face` : 'a face';
        return check('faces', 'look', `A balloon covers ${who} in panel ${f.panel}`, [{ kind: 'balloon', id: b.id }], [{ key: 'move_clear', label: 'Move it clear', free: true, lineIds: [b.id] }]);
      }
    }
    for (const h of qc.heads || []) {
      if (h?.head && h.head.x >= b.box.x && h.head.x <= b.box.x + b.box.w && h.head.y >= b.box.y && h.head.y <= b.box.y + b.box.h) {
        return check('faces', 'look', `A balloon covers ${h.characterId ? `${nameOf(doc, h.characterId)}'s face` : 'a face'} in panel ${h.panel}`, [{ kind: 'balloon', id: b.id }], [
          { key: 'move_clear', label: 'Move it clear', free: true, lineIds: [b.id] }
        ]);
      }
    }
  }
  return check('faces', 'ok', 'No balloon covers a face.');
}

// ── Characters, speakers, plan (from the page check) ─────────────────────────

function charactersCheck(doc: ComicDoc, page: Page): PageCheck {
  const qc = page.render.qc;
  if (!qc || qc.checkV !== 2) return check('characters', 'unknown', 'Not checked against the character sheets yet.', [], [RECHECK]);
  const open = (qc.findings || []).filter((f) => !f.dismissed && ['identity', 'continuity', 'style', 'extra'].includes(f.kind));
  if (!open.length) return check('characters', 'ok', 'Everyone looks like themselves.');
  const f = open[0];
  const panel = page.panels.find((p) => p.n === f.panel);
  const fixes: CheckFix[] = [{ key: 'looks_fine', label: 'Looks fine', free: true, findingId: f.id, ops: [{ op: 'finding', pageId: page.id, id: f.id, patch: { dismissed: true } }] }];
  const offer = f.fix;
  if (offer?.kind === 'accept_state') fixes.push({ key: 'accept_state', label: 'Keep it from here on', free: true, findingId: f.id });
  if (offer?.kind === 'drop_cast') fixes.push({ key: 'drop_cast', label: 'Take them out of the panel', free: true, findingId: f.id });
  fixes.push({ key: 'edit_ai', label: 'Mark the area for AI', free: false, ...(panel ? { panelId: panel.id } : {}) });
  if (panel) fixes.push({ key: 'redraw_panel', label: `Redraw panel ${panel.n}`, free: false, panelId: panel.id });
  return check('characters', 'look', `${f.panel ? `Panel ${f.panel}: ` : ''}${f.note}`, panel ? [frameRef(panel.id)] : [], fixes);
}

const VOICE_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
/** A speaker's spoken lines in a panel (captions and sound effects have no speaker to draw). */
const voiceLines = (panel: Panel, castId: string): Line[] => panel.lines.filter((l) => l.speakerId === castId && VOICE_KINDS.has(l.kind) && !!l.text?.trim());

/**
 * A speaker the page check found missing still needs drawing (after the server's QC rule, vision.qcOffPanelSpeakerIds):
 * they still speak there, the shot draws its speakers (not a POV, insert or establishing shot), and the panel's plan
 * has them in it (castIds). A voice from off the panel is out of the cast; a plan that lists them AND marks them
 * off-panel is contradictory, and the cast wins (as the consistency rules normalize it: offPanel ∉ castIds), so it
 * still counts as missing — never a false ok.
 */
const stillMissing = (panel: Panel, castId: string): boolean => voiceLines(panel, castId).length > 0 && !OFF_PANEL_SHOTS.has(panel.shot) && panel.castIds.includes(castId);

/** The panel's direction without one cast member's staging (they are heard, not drawn). */
const directionWithout = (direction: PanelDirection | undefined, castId: string): PanelDirection => {
  const out: PanelDirection = { ...(direction ?? {}) };
  if (out.cast && castId in out.cast) {
    const cast = { ...out.cast };
    delete cast[castId];
    if (Object.keys(cast).length) out.cast = cast;
    else delete out.cast;
  }
  return out;
};

function speakersCheck(doc: ComicDoc, page: Page): PageCheck {
  const qc = page.render.qc;
  if (!qc) return check('speakers', 'unknown', 'Not checked yet.', [], [RECHECK]);
  const missing = (qc.missingSpeakers || []).filter((m) => {
    const p = page.panels.find((x) => x.n === m.panel);
    return !!p && stillMissing(p, m.castId);
  });
  if (!missing.length) {
    if (!Array.isArray(qc.missingSpeakers) && !qc.boxesFrom) return check('speakers', 'unknown', 'Not checked: this page was drawn before speaker checks.', [], [RECHECK]);
    return check('speakers', 'ok', 'Everyone who speaks is drawn.');
  }
  const m = missing[0];
  const panel = page.panels.find((p) => p.n === m.panel)!;
  const who = nameOf(doc, m.castId);
  // Off the panel: heard, not drawn — out of the panel's cast and its staging, and marked off-panel by the user
  // (the consistency rule: offPanel ∉ castIds).
  const offPanel = [...new Set([...(panel.direction?.offPanel || []), m.castId])];
  const fixes: CheckFix[] = [
    {
      key: 'off_panel',
      label: `Make ${who} a voice from off the panel`,
      free: true,
      panelId: panel.id,
      ops: [{ op: 'panel', pageId: page.id, id: panel.id, patch: { castIds: panel.castIds.filter((id) => id !== m.castId), direction: { ...directionWithout(panel.direction, m.castId), offPanel, by: 'user' } } }]
    }
  ];
  // A caption needs no speaker drawn (overlay lettering only: lines drawn into the art are part of the picture).
  const lines = voiceLines(panel, m.castId);
  if (doc.format?.lettering !== 'in_art' && lines.length) {
    fixes.push({
      key: 'caption',
      label: `Make ${who}'s ${lines.length === 1 ? 'line' : 'lines'} in panel ${panel.n} a caption`,
      free: true,
      panelId: panel.id,
      lineIds: lines.map((l) => l.id),
      ops: lines.map((l) => ({ op: 'line', pageId: page.id, panelId: panel.id, id: l.id, patch: { kind: 'caption' } }))
    });
  }
  fixes.push({ key: 'redraw_panel', label: `Redraw panel ${panel.n} with ${who}`, free: false, panelId: panel.id });
  return check('speakers', 'look', `${who} speaks in panel ${m.panel} but isn't drawn`, [frameRef(panel.id)], fixes);
}

/** The drawn-panel order the page check read, when it is a reordering of the plan's panels (not the plan's own order). */
const beatPermutation = (beats: unknown, n: number): number[] | undefined => {
  if (!Array.isArray(beats) || beats.length !== n || n < 2) return undefined;
  const sorted = [...beats].sort((a, b) => a - b);
  if (!sorted.every((b, k) => b === k + 1)) return undefined;
  return beats.some((b, k) => b !== k + 1) ? [...beats] : undefined;
};

function planCheck(page: Page): PageCheck {
  const qc = page.render.qc;
  const cuts = page.render.cuts;
  const n = page.panels.length;
  if (cuts) {
    if (cuts.status === 'ok') return check('plan', 'ok', 'Every drawn panel is where the plan has it.');
    const found = cuts.cuts.length;
    const detail = found !== n ? `We found ${found} drawn panel${found === 1 ? '' : 's'}; the plan has ${n}` : cuts.note || 'We are not sure where every drawn panel is';
    // Free first: fix the edges by hand (the editor opens "Check the edges"), or match the script to the drawing.
    const fixes: CheckFix[] = [{ key: 'check_edges', label: 'Check the edges', free: true }];
    const order = beatPermutation(qc?.beats, n);
    if (order) fixes.push({ key: 'rebind', label: 'Match the script to the drawing', free: true, order });
    fixes.push({ key: 'redraw_page', label: 'Redraw the page', free: false });
    return check('plan', 'look', detail, [], fixes);
  }
  if (!qc) return check('plan', 'unknown', 'Not checked yet.', [], [RECHECK]);
  if (Array.isArray(qc.beats) && qc.beats.length) {
    const i = qc.beats.findIndex((b, k) => b !== 0 && b !== k + 1);
    if (i >= 0) {
      return check('plan', 'look', `Drawn panel ${i + 1} shows the moment of panel ${qc.beats[i]}`, [], [
        { key: 'rebind', label: 'Match the script to the drawing', free: true, order: [...qc.beats] },
        { key: 'redraw_page', label: 'Redraw the page', free: false }
      ]);
    }
  }
  if (Array.isArray(qc.drawnBoxes)) {
    if (qc.drawnBoxes.length !== n) return check('plan', 'look', `We found ${qc.drawnBoxes.length} drawn panel${qc.drawnBoxes.length === 1 ? '' : 's'}; the plan has ${n}`, [], [{ key: 'redraw_page', label: 'Redraw the page', free: false }]);
    return check('plan', 'ok', 'The drawing has the panels the plan has.');
  }
  return check('plan', 'unknown', 'Not checked: this page was drawn before panel checks.', [], [RECHECK]);
}

// ── Frames: sharp and empty ──────────────────────────────────────────────────

function sharpCheck(doc: ComicDoc, page: Page, mode: string): PageCheck {
  if (mode !== 'panels') return check('sharp', 'ok', 'Shown as drawn.');
  let worst: { panel: Panel; up: number } | undefined;
  for (const p of page.panels) {
    const up = upscaleOf(doc, page, p.id);
    if (up !== undefined && up > EDITOR_LIMITS.upscaleSoft && (!worst || up > worst.up)) worst = { panel: p, up };
  }
  if (!worst) return check('sharp', 'ok', 'Every panel is shown at its drawn size or smaller.');
  const word = worst.up > EDITOR_LIMITS.upscaleBad ? 'may look blurry' : 'may look soft';
  return check('sharp', 'look', `Panel ${worst.panel.n} is shown ${worst.up}× larger than drawn and ${word}`, [frameRef(worst.panel.id)], [
    { key: 'smaller', label: `Make panel ${worst.panel.n} smaller`, free: true, panelId: worst.panel.id },
    { key: 'redraw_panel', label: `Redraw panel ${worst.panel.n} at this size`, free: false, panelId: worst.panel.id }
  ]);
}

function emptyCheck(doc: ComicDoc, page: Page, mode: string): PageCheck {
  if (isUndrawn(page)) {
    const blank = page.panels.filter((p) => !p.action.trim() && !p.castIds.length && !p.lines.length);
    if (!blank.length) return check('empty', 'ok', 'Every panel has something planned.');
    const p = blank[0];
    return check('empty', 'look', `Panel ${p.n} has nothing planned yet`, blank.map((b) => frameRef(b.id)), [
      { key: 'delete_panel', label: `Delete panel ${p.n}`, free: true, panelId: p.id }
    ]);
  }
  if (mode !== 'panels') return check('empty', 'ok', 'Shown as drawn.');
  const empty = page.panels.filter((p) => !frameAffine(doc, page, p));
  if (!empty.length) return check('empty', 'ok', 'Every panel shows art.');
  const p = empty[0];
  return check('empty', 'look', `Panel ${p.n} is empty`, empty.map((e) => frameRef(e.id)), [
    { key: 'drop_image', label: 'Drop an image here', free: true, panelId: p.id },
    { key: 'delete_panel', label: `Delete panel ${p.n}`, free: true, panelId: p.id },
    { key: 'redraw_panel', label: `Draw panel ${p.n}`, free: false, panelId: p.id }
  ]);
}

// ── Up to date ───────────────────────────────────────────────────────────────

function freshCheck(doc: ComicDoc, page: Page): PageCheck {
  const stale = page.render.status === 'stale' || isPageStale(doc, page);
  const parts = page.render.parts?.panels;
  const changed: { panel: Panel; what: string }[] = [];
  if (parts) {
    const now = partsOf(doc, page).panels || {};
    for (const p of page.panels) {
      const was = parts[p.id];
      const is = now[p.id];
      if (!was || !is) {
        if (was || is) changed.push({ panel: p, what: was ? 'changed' : 'new since the drawing' });
        continue;
      }
      const keys = (Object.keys(PART_WORDS) as (keyof PanelParts)[]).filter((k) => (was[k] ?? '') !== (is[k] ?? ''));
      if (keys.length) changed.push({ panel: p, what: keys.map((k) => PART_WORDS[k]).join(', ') });
    }
  }
  if (!stale && !changed.length) return check('fresh', 'ok', 'The drawing matches the script.');
  const detail = changed.length
    ? `${changed.length} panel${changed.length === 1 ? '' : 's'} changed since the drawing: ${changed.map((c) => `panel ${c.panel.n}: ${c.what}`).join('; ')}`
    : 'The script changed since this drawing';
  const fixes: CheckFix[] = [{ key: 'undo_changes', label: 'Undo these changes', free: true }];
  if (changed.length === 1) fixes.push({ key: 'redraw_panel', label: `Redraw panel ${changed[0].panel.n}`, free: false, panelId: changed[0].panel.id });
  fixes.push({ key: 'redraw_page', label: 'Redraw the page', free: false });
  return check('fresh', 'look', cap1(detail), changed.map((c) => frameRef(c.panel.id)), fixes);
}

// ── Reading order ────────────────────────────────────────────────────────────

function orderCheck(doc: ComicDoc, page: Page, scene: PageScene): PageCheck {
  const panels = panelOrderIssue(doc, page);
  if (panels) return check('order', 'look', panels.text, panels.order.slice(0, 2).map(frameRef), [{ key: 'renumber', label: panels.fix.label, free: true, ops: panels.fix.ops }]);
  const lines = lineOrderIssues(doc, page, scene);
  if (lines.length) {
    const l = lines[0];
    return check('order', 'look', l.text, [{ kind: 'balloon', id: l.early }, { kind: 'balloon', id: l.before }], [
      { key: 'swap_lines', label: l.fix.label, free: true, ops: l.fix.ops, lineIds: [l.early, l.before], panelId: l.panelId }
    ]);
  }
  return check('order', 'ok', 'Panels and balloons read in script order.');
}

/**
 * The page's checklist. Before drawing (a plan only): text fits, reading order and empty panels. After drawing, also
 * faces, characters, speakers, panels-match-the-plan, sharpness and up to date.
 */
export function pageChecks(doc: ComicDoc, page: Page, opts: CheckOptions = {}): PageCheck[] {
  const scene = opts.scene ?? buildScene(doc, page, opts.plans ? { plans: opts.plans } : {});
  const meter = opts.meter ?? meterFor(doc);
  const shown = framesShown(doc, page);
  const out: PageCheck[] = [textCheck(doc, page, shown.boxes, scene, opts, meter), orderCheck(doc, page, scene)];
  if (isUndrawn(page)) {
    out.push(emptyCheck(doc, page, shown.mode));
    return out;
  }
  out.push(
    facesCheck(doc, page, scene),
    charactersCheck(doc, page),
    speakersCheck(doc, page),
    planCheck(page),
    sharpCheck(doc, page, shown.mode),
    emptyCheck(doc, page, shown.mode),
    freshCheck(doc, page)
  );
  return out;
}

/** The "Checks 5/6" chip: ok out of the checks that could be made (unknown ones are counted, never as ok). */
export const checksSummary = (checks: readonly PageCheck[]): { ok: number; look: number; unknown: number; total: number; label: string } => {
  const ok = checks.filter((c) => c.state === 'ok').length;
  const look = checks.filter((c) => c.state === 'look').length;
  const unknown = checks.filter((c) => c.state === 'unknown').length;
  return { ok, look, unknown, total: checks.length, label: `Checks ${ok}/${checks.length}` };
};

/** The edit behind a free fix: its ops when the check carried them, else the frame or layout edit it names. */
export function checkFixEdit(doc: ComicDoc, page: Page, fix: CheckFix): EditResult {
  if (!fix.free) return refuse('That fix is paid: it is quoted and asked first.');
  if (fix.ops?.length) return editOf(doc, fix.ops, fix.label);
  switch (fix.key) {
    case 'make_bigger':
      return fix.panelId ? makeBiggestEdit(doc, page, fix.panelId) : refuse('Pick a panel.');
    case 'template':
      return fix.templateId && templateById(fix.templateId) ? applyTemplateEdit(doc, page, fix.templateId) : refuse('That layout is not available.');
    case 'delete_panel':
      return fix.panelId ? deleteFrameEdit(doc, page, fix.panelId) : refuse('Pick a panel.');
    case 'close_gap':
      return closeGapEdit(doc, page, fix.panelId);
    default:
      return refuse('The editor does this one for you.');
  }
}
