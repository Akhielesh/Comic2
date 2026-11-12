// layersModel (PE-INSPECT; agent-editor plan §4 Wave 2 C-LAYERS): the rows are in reading order grouped by panel, in the
// scene's bands front first (lettering always on top), with overlays frontmost first and clipped overlays under their
// panel.

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../../shared/comic/lettering/layout';
import { BANDS } from '../../../../shared/comic/editor/scene';
import type { PageLayer } from '../../../../shared/comic/doc';
import { balloonRows, clipText, layersModel } from './layersModel';

const ASPECT = 2 / 3;
const shape = (id: string, z: number, extra: Partial<PageLayer> = {}): PageLayer => ({
  id,
  kind: 'shape',
  box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  z,
  shape: { type: 'rect', fill: '#ffffff', stroke: '#111111', strokeW: 0.003 },
  ...extra
});

const ctx = (mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  return { doc, page, plans: planLettering(doc, page, ASPECT, estimateMeasure) };
};

describe('layersModel', () => {
  it('lettering rows are in reading order, grouped by panel in panel order — never by z', () => {
    const { doc, page, plans } = ctx((d) => {
      // Stacking that disagrees with reading order: l5 at the back, l3 at the front.
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l5' ? { ...b, z: -5 } : b.lineId === 'pg_1_l3' ? { ...b, z: 9 } : b));
    });
    const bands = layersModel(doc, page, { plans });
    const lettering = bands[0];
    expect(lettering.band).toBe(BANDS.lettering);
    expect(lettering.title).toBe('Lettering');
    expect(lettering.groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
      ['Panel 1', ['pg_1_l1']],
      ['Panel 2', ['pg_1_l2']],
      ['Panel 3', ['pg_1_l3', 'pg_1_l4', 'pg_1_l5']]
    ]);
    expect(balloonRows(bands).map((r) => r.id)).toEqual(['pg_1_l1', 'pg_1_l2', 'pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    const l3 = balloonRows(bands)[2];
    expect(l3).toMatchObject({ kind: 'balloon', lineKind: 'shout', speaker: 'Vendor', text: 'Thief!', panelId: 'pg_1_p3', z: 9, drawn: true, locked: false });
  });

  it('bands run front first: lettering, page overlays (frontmost first), panels with their clipped overlays, the page', () => {
    const { doc, page, plans } = ctx((d) => {
      d.pages[0].layers = [shape('ly_back', 0, { name: 'Back plate' }), shape('ly_front', 3, { name: 'Front star' }), shape('ly_in', 0, { name: 'Speed lines', clip: 'pg_1_p2' }), shape('ly_guide', 1, { name: 'Guide', print: false })];
    });
    const bands = layersModel(doc, page, { plans });
    expect(bands.map((b) => b.title)).toEqual(['Lettering', 'Overlays', 'Panels', 'Page']);
    expect(bands[1].groups[0].rows.map((r) => r.label)).toEqual(['Front star', 'Guide', 'Back plate']);
    expect(bands[1].groups[0].rows[1].guide).toBe(true);
    const panels = bands[2].groups;
    expect(panels.map((g) => g.title)).toEqual(['Panel 1', 'Panel 2', 'Panel 3']);
    expect(panels[1].head).toMatchObject({ kind: 'frame', id: 'pg_1_p2' });
    expect(panels[1].rows.map((r) => r.label)).toEqual(['Speed lines']);
    expect(bands[3].groups[0].rows[0]).toMatchObject({ kind: 'page', id: 'pg_1', label: 'Page 1' });
  });

  it('a line with no balloon yet still has a row (not drawn, its lock waits); text is clipped to 40 characters', () => {
    const { doc, page, plans } = ctx((d) => {
      d.pages[0].panels[0].lines.push({ id: 'pg_1_lx', kind: 'speech', text: '' });
      d.pages[0].panels[0].lines[0].text = 'A very long caption that keeps on going well past forty characters';
    });
    const rows = balloonRows(layersModel(doc, page, { plans }));
    expect(rows.find((r) => r.id === 'pg_1_lx')).toMatchObject({ drawn: false, text: '' });
    expect(rows[0].text).toHaveLength(40);
    expect(rows[0].text!.endsWith('…')).toBe(true);
    expect(clipText('  two\n lines  ')).toBe('two lines');
  });
});
