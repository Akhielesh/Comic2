// PE-MOTION-ENGINE calm and still readings (master plan §2.5 "Still exports", "Calm motion"; §2.9 Motion): the poster is
// the end of every entrance with loops off; reduced motion gives the final state with nothing in between; Calm motion
// drops CALM_EXCLUDED_PRESETS.

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { emptyRender, type ComicDoc, type Page } from '../doc';
import { lineRevealMs, pageBeats } from './beats';
import { clipCurveAt, playableClip } from './presets';
import {
  calmSampleAt,
  cameraInMode,
  isCalmExcluded,
  motionModeFor,
  motionModeOptions,
  posterPoses,
  reducedSampleAt,
  sampleInMode
} from './reduced';
import { planMotion, sampleAt } from './sample';
import { CALM_EXCLUDED_PRESETS, type MotionClip, type PageMotion } from './types';

const overlayDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.format = { ...d.format, lettering: 'overlay' };
    d.pages = d.pages.map((p) => ({ ...p, render: { ...emptyRender(), status: 'ready', asset: { path: `p${p.n}.webp`, source: 'generated', at: 1 } } }));
  });

const clip = (id: string, patch: Partial<MotionClip>): MotionClip => ({ id, target: { k: 'line', id: 'pg_1_l1' }, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 }, ...patch });

const animated = (clips: MotionClip[], extra: Omit<PageMotion, 'clips'> = {}) => {
  const doc = overlayDoc();
  const page: Page = { ...doc.pages[0], motion: { clips, ...extra } };
  return { doc: { ...doc, pages: [page, ...doc.pages.slice(1)] }, page, beats: pageBeats(doc, page) };
};

const MIXED = [
  clip('mc_pop', { preset: 'pop', target: { k: 'line', id: 'pg_1_l1' } }),
  clip('mc_keyed', { preset: 'fade', target: { k: 'line', id: 'pg_1_l2' }, keys: [{ t: 0, s: 0.5 }, { t: 1, s: 1.2, r: 8 }] }),
  clip('mc_type', { preset: 'typewriter', target: { k: 'line', id: 'pg_1_l3' }, at: { anchor: 'reveal', ms: 300 } }),
  clip('mc_loop', { role: 'loop', preset: 'float', target: { k: 'line', id: 'pg_1_l1' }, at: { anchor: 'page', ms: 0 } }),
  clip('mc_em', { role: 'emphasis', preset: 'shake', target: { k: 'line', id: 'pg_1_l3' } }),
  clip('mc_exit', { role: 'exit', preset: 'fade-out', target: { k: 'line', id: 'pg_1_l4' } }),
  clip('mc_sway', { role: 'loop', preset: 'sway', target: { k: 'panel', id: 'pg_1_p1' }, at: { anchor: 'page', ms: 0 } })
];

describe('the poster (still exports: PNG, PDF, print)', () => {
  it('equals the end of every entrance, keys included; loops, emphases and exits are off', () => {
    const { doc, page, beats } = animated(MIXED);
    const poster = posterPoses(doc, page, beats);
    expect([...poster.keys()]).toEqual(['line:pg_1_l1', 'line:pg_1_l2', 'line:pg_1_l3']);
    // The end of the entrance as the full player draws it, once every entrance has finished (entrances only).
    const entrancesOnly = { include: (_c: MotionClip, def: { role: string }) => def.role === 'enter' };
    const lastEnd = Math.max(...planMotion(doc, page, beats, entrancesOnly).clips.map((c) => c.startMs + c.pc.durMs));
    expect(poster).toEqual(sampleAt(doc, page, beats, lastEnd + 1, entrancesOnly));
    // Per clip: the poster is the clip's own last frame.
    expect(poster.get('line:pg_1_l2')).toMatchObject(clipCurveAt(playableClip(MIXED[1])!, 1, { dir: 'ltr' }));
    expect(poster.get('line:pg_1_l2')).toMatchObject({ s: 1.2, r: 8, o: 1 });
    expect(poster.get('line:pg_1_l1')).toEqual({ dx: 0, dy: 0, s: 1, sy: 1, r: 0, o: 1, reveal: 1 });
    // The page itself (no clip given) gets the same poster from its own beats.
    expect(posterPoses(doc, page)).toEqual(poster);
  });

  it('is the same whatever the clock says, and draws no camera', () => {
    const { doc, page, beats } = animated(MIXED, { camera: [{ panelId: 'pg_1_p1', move: 'push' }] });
    expect(sampleInMode('poster', doc, page, beats, 0)).toEqual(posterPoses(doc, page, beats));
    expect(cameraInMode('poster', doc, page, beats, beats.panels[0].startMs + 100)).toBeUndefined();
    expect(cameraInMode('full', doc, page, beats, beats.panels.find((p) => p.panelId === 'pg_1_p1')!.startMs + 100)).toBeDefined();
  });
});

describe('reduced motion gives the final state', () => {
  it('an entrance or exit is at its last frame the moment it starts; nothing moves in between; loops and emphases never play', () => {
    const { doc, page, beats } = animated(MIXED);
    const reveal = lineRevealMs(beats, 'pg_1_l1')!;
    // Mid-pop: full motion is still scaling up; reduced motion is already done.
    const full = sampleAt(doc, page, beats, reveal + 100).get('line:pg_1_l1')!;
    const reduced = reducedSampleAt(doc, page, beats, reveal + 100).get('line:pg_1_l1')!;
    expect(full.s).not.toBe(1);
    expect(reduced).toEqual({ dx: 0, dy: 0, s: 1, sy: 1, r: 0, o: 1, reveal: 1 });
    // Before it starts it is hidden in both readings (the balloon has not been revealed yet).
    expect(reducedSampleAt(doc, page, beats, reveal - 1).get('line:pg_1_l1')!.o).toBe(0);
    // The typewriter shows the whole line at once.
    const typeStart = lineRevealMs(beats, 'pg_1_l3')! + 300;
    expect(reducedSampleAt(doc, page, beats, typeStart + 1).get('line:pg_1_l3')!.reveal).toBe(1);
    expect(sampleAt(doc, page, beats, typeStart + 1).get('line:pg_1_l3')!.reveal).toBeLessThan(0.1);
    // An exit is gone the moment it starts.
    const exitStart = lineRevealMs(beats, 'pg_1_l4')!;
    expect(reducedSampleAt(doc, page, beats, exitStart).get('line:pg_1_l4')!.o).toBe(0);
    expect(reducedSampleAt(doc, page, beats, exitStart - 1).get('line:pg_1_l4')!.o).toBe(1);
    // The loop on the panel never plays; the shake on l3 is off (l3 shows only its typewriter, done).
    for (let ms = 0; ms < beats.totalMs; ms += 97) {
      const poses = reducedSampleAt(doc, page, beats, ms);
      expect(poses.has('panel:pg_1_p1')).toBe(false);
      const l1 = poses.get('line:pg_1_l1')!;
      expect(l1.dy).toBe(0);
      expect([0, 1]).toContain(l1.o);
      expect(poses.get('line:pg_1_l3')!.dx).toBe(0);
    }
    expect(cameraInMode('reduced', doc, page, beats, 2000)).toBeUndefined();
  });

  it('a viewer who asked for less motion gets it; an explicit Play in the editor still plays', () => {
    expect(motionModeFor({})).toBe('full');
    expect(motionModeFor({ reducedMotion: true })).toBe('reduced');
    expect(motionModeFor({ readerMotion: 'off' })).toBe('reduced');
    expect(motionModeFor({ readerMotion: 'on' })).toBe('full');
    expect(motionModeFor({ reducedMotion: true, explicitPlay: true })).toBe('full');
    expect(motionModeFor({ calm: true })).toBe('calm');
    expect(motionModeFor({ calm: true, reducedMotion: true })).toBe('reduced');
  });
});

describe('Calm motion', () => {
  it('drops CALM_EXCLUDED_PRESETS (clips and the camera shake) and plays everything else', () => {
    expect(CALM_EXCLUDED_PRESETS).toEqual(['shake', 'jitter', 'flicker', 'zoom-punch', 'blink']);
    for (const id of CALM_EXCLUDED_PRESETS) expect(isCalmExcluded(id)).toBe(true);
    for (const id of ['pop', 'fade', 'float', 'push', '', 'constructor', undefined]) expect(isCalmExcluded(id)).toBe(false);
    const harsh = CALM_EXCLUDED_PRESETS.map((preset, i) =>
      clip(`mc_h${i}`, { preset: preset as MotionClip['preset'], role: preset === 'zoom-punch' ? 'enter' : preset === 'blink' ? 'loop' : 'emphasis', target: { k: 'panel', id: 'pg_1_p2' }, at: { anchor: 'page', ms: 0 } })
    );
    const gentle = clip('mc_g', { role: 'loop', preset: 'float', target: { k: 'panel', id: 'pg_1_p3' }, at: { anchor: 'page', ms: 0 } });
    const { doc, page, beats } = animated([...harsh, gentle], { camera: [{ panelId: 'pg_1_p1', move: 'shake' }, { panelId: 'pg_1_p2', move: 'push' }] });
    // Full motion plays all of them.
    expect([...sampleAt(doc, page, beats, 300).keys()]).toEqual(['panel:pg_1_p2', 'panel:pg_1_p3']);
    expect(planMotion(doc, page, beats).clips).toHaveLength(harsh.length + 1);
    // Calm keeps only the float.
    expect([...calmSampleAt(doc, page, beats, 300).keys()]).toEqual(['panel:pg_1_p3']);
    expect(calmSampleAt(doc, page, beats, 600).get('panel:pg_1_p3')).toEqual(sampleAt(doc, page, beats, 600).get('panel:pg_1_p3'));
    const p1 = beats.panels.find((p) => p.panelId === 'pg_1_p1')!;
    const p2 = beats.panels.find((p) => p.panelId === 'pg_1_p2')!;
    expect(cameraInMode('full', doc, page, beats, p1.startMs + 400)?.move).toBe('shake');
    expect(cameraInMode('calm', doc, page, beats, p1.startMs + 400)).toBeUndefined();
    expect(cameraInMode('calm', doc, page, beats, p2.startMs + 400)?.move).toBe('push');
    expect(motionModeOptions('full', { seed: 3 })).toEqual({ seed: 3 });
  });
});
