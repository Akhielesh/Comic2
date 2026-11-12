// The Layers panel's rows (agent-editor plan §3 C1; master plan §2.4, §2.9): every object on the page in the scene's
// bands (shared/comic/editor/scene.ts), front band first, so the list reads the way the page stacks:
//   Lettering  balloons, captions and sound effects — always on top (LETTERING_ON_TOP_NOTE) — grouped by panel, each
//              group and its rows in READING order (reading order belongs to panels and lines, never to z)
//   Overlays   page stickers, images, shapes and effects, frontmost first
//   Panels     the frames in reading order, each with the overlays kept inside it
//   Page       the paper
// Pure: no React. The panel renders it; tests read it.

import type { ComicDoc, LineKind, Page } from '../../../../shared/comic/doc';
import type { LetterPlan } from '../../../../shared/comic/lettering/layout';
import { BANDS, buildScene, panelWord, cap1, type Band, type SceneKind, type SceneObject } from '../../../../shared/comic/editor/scene';
import { normalizeLetteringText } from '../../../../shared/comic/textLayout';
import { castName } from '../../board/boardModel';

/** One object's row. */
export interface LayerRow {
  kind: SceneKind;
  id: string;
  /** The scene's plain-words name ("Caption: “Tokyo, 3 a.m.”", "Sticker", "Panel 2"). */
  label: string;
  /** Balloons: the line's words, clipped to 40 characters. */
  text?: string;
  lineKind?: LineKind;
  /** Balloons: the speaker's name. */
  speaker?: string;
  locked: boolean;
  /** Guide-only overlay (shown in the editor, never printed). */
  guide?: boolean;
  /** Balloons: drawn on the page (a stored balloon or a plan). An empty line has no balloon yet. */
  drawn?: boolean;
  /** The panel the object belongs to (balloon: its line's panel; clipped overlay: its frame). */
  panelId?: string;
  z: number;
}

export interface LayerGroup {
  id: string;
  title: string;
  /** Lettering and panel groups: the panel. */
  panelId?: string;
  /** Panel groups: the frame's own row. */
  head?: LayerRow;
  rows: LayerRow[];
}

export interface LayerBand {
  band: Band;
  title: string;
  groups: LayerGroup[];
}

/** A line's words for a row: one line, at most `max` characters. */
export const clipText = (text: string, max = 40): string => {
  const t = normalizeLetteringText(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const rowOf = (o: SceneObject): LayerRow => ({
  kind: o.kind,
  id: o.id,
  label: o.label,
  locked: o.locked,
  z: o.z,
  ...(o.guide ? { guide: true } : {}),
  ...(o.panelId ? { panelId: o.panelId } : {})
});

export interface LayersOptions {
  plans?: readonly LetterPlan[];
  /** A language edition: its text and positions. */
  lang?: string;
}

/** The page's layers, front band first (see the header). Bands with nothing in them are left out (the page stays). */
export function layersModel(doc: ComicDoc, page: Page, opts: LayersOptions = {}): LayerBand[] {
  const scene = buildScene(doc, page, { plans: opts.plans, lang: opts.lang });
  const byKey = new Map(scene.objects.map((o) => [`${o.kind}:${o.id}`, o]));
  const bands: LayerBand[] = [];

  // Lettering: every line, panel by panel, in reading order.
  const lettering: LayerGroup[] = [];
  for (const panel of page.panels) {
    if (!panel.lines.length) continue;
    const rows: LayerRow[] = panel.lines.map((line) => {
      const o = byKey.get(`balloon:${line.id}`);
      const b = page.balloons.find((x) => x.lineId === line.id);
      return {
        kind: 'balloon',
        id: line.id,
        label: o?.label ?? `${line.kind === 'sfx' ? 'Sound effect' : 'Balloon'}: (empty)`,
        text: clipText(line.text),
        lineKind: line.kind,
        ...(line.speakerId ? { speaker: castName(doc, line.speakerId) } : {}),
        locked: o?.locked ?? !!b?.locked,
        drawn: !!o,
        panelId: panel.id,
        z: o?.z ?? (typeof b?.z === 'number' ? b.z : 0)
      };
    });
    lettering.push({ id: `lettering:${panel.id}`, title: cap1(panelWord(page, panel.id)), panelId: panel.id, rows });
  }
  if (lettering.length) bands.push({ band: BANDS.lettering, title: 'Lettering', groups: lettering });

  // Page overlays, frontmost first.
  const overlays = scene.objects.filter((o) => o.kind === 'overlay' && o.band === BANDS.overlays).reverse().map(rowOf);
  if (overlays.length) bands.push({ band: BANDS.overlays, title: 'Overlays', groups: [{ id: 'overlays', title: 'On the page', rows: overlays }] });

  // Panels in reading order, each with its clipped overlays (frontmost first).
  const frames = scene.objects.filter((o) => o.kind === 'frame').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (frames.length) {
    bands.push({
      band: BANDS.art,
      title: 'Panels',
      groups: frames.map((f) => ({
        id: `art:${f.id}`,
        title: f.label,
        panelId: f.id,
        head: rowOf(f),
        rows: scene.objects.filter((o) => o.kind === 'overlay' && o.band === BANDS.art && o.panelId === f.id).reverse().map(rowOf)
      }))
    });
  }

  const paper = scene.objects.find((o) => o.kind === 'page');
  if (paper) bands.push({ band: BANDS.page, title: 'Page', groups: [{ id: 'page', title: paper.label, rows: [rowOf(paper)] }] });
  return bands;
}

/** Every balloon row in the order the list shows them (keyboard and screen-reader order). */
export const balloonRows = (bands: readonly LayerBand[]): LayerRow[] =>
  bands.filter((b) => b.band === BANDS.lettering).flatMap((b) => b.groups.flatMap((g) => g.rows));
