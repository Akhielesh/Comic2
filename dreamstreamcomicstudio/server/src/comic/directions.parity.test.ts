// Parity: shared/comic/directions.ts decides who is DRAWN in a panel and who is an off-panel voice exactly as the page
// prompt does (server/src/comic/prompts.ts povViewerOf / drawnCastIds / offPanelSpeakerIds). Directions (normalize,
// lint, the Who phrases B5 adds) build on the shared copy, so a POV viewer the prompt calls "OFF-PANEL VOICE … (do not
// draw)" never gets a Who phrase. (Server-side file so the client typecheck never pulls server code.)
import { describe, expect, it } from 'vitest';
import { being, harbourComic, lakeStory } from '../../../shared/comic/__fixtures__/consistencyBooks.js';
import type { ComicDoc, Line, Panel } from '../../../shared/comic/doc.js';
import * as shared from '../../../shared/comic/directions.js';
import { drawnCastIds, offPanelSpeakerIds, povViewerOf } from './prompts.js';

const line = (kind: Line['kind'], text: string, speakerId?: string): Line => ({ id: `l_${kind}_${text.length}_${speakerId ?? ''}`, kind, text, ...(speakerId ? { speakerId } : {}) });
const panel = (n: number, castIds: string[], over: Partial<Panel> = {}): Panel => ({ id: `pn_${n}`, n, size: 'medium', shot: 'medium', action: `Moment ${n}`, castIds, lines: [], ...over });

const doc = (): ComicDoc =>
  harbourComic((d) => {
    d.cast.push(being('c_dot', 'Mr. Dot (Sr.)', 'support'), being('c_blank', '   ', 'extra'));
  });

const panels: Panel[] = [
  panel(1, ['c_meera'], { lines: [line('speech', 'Who goes there?', 'c_ravi'), line('speech', 'Me.', 'c_meera'), line('shout', 'Halt!'), line('whisper', 'Again?', 'c_ravi')] }),
  panel(2, ['c_meera', 'c_ravi'], { shot: 'pov', action: "From Ravi's view, Meera backs away from the stall.", lines: [line('speech', 'Stop!', 'c_ravi')] }),
  panel(3, ['c_meera', 'c_ravi'], { shot: 'pov', action: 'A blur of tarps and sacks.', lines: [line('speech', 'Left!', 'c_ravi')] }),
  panel(4, ['c_meera', 'c_lantern'], {
    action: 'Through Meera’s eyes the lantern glows.',
    lines: [line('speech', 'Listen…', 'c_lantern'), line('caption', 'Later.', 'c_guard'), line('sfx', 'HUM', 'c_guard'), line('speech', '  ', 'c_ravi'), line('speech', 'Psst.', 'c_ghost')]
  }),
  panel(5, ['c_meera', 'c_ravi'], { shot: 'pov', action: 'Ravi’s POV: Meera waves.', lines: [line('thought', 'Late again.', 'c_ravi')] }),
  panel(6, ['c_meera', 'c_dot'], { shot: 'pov', action: 'Through the Mr. Dot (Sr.)’s eyes: Meera, small and far.', lines: [line('speech', 'Hm.', 'c_dot')] }),
  panel(7, ['c_meera', 'c_ravi'], { shot: 'pov', action: "  from   RAVI's   point of view  ", lines: [line('speech', '\n', 'c_ravi'), line('whisper', 'Go.', 'c_guard')] }),
  panel(8, ['c_blank', 'c_meera'], { shot: 'pov', action: "From 's view.", lines: [line('speech', 'Hey.', 'c_blank')] }),
  panel(9, ['c_meera'], { shot: 'pov', action: "From Guard's view.", lines: [line('speech', 'Halt.', 'c_guard')] }),
  panel(10, [], { shot: 'pov', action: '', lines: [line('speech', 'Hello?', 'c_meera')] })
];

describe('drawn cast and off-panel voices: shared/comic/directions.ts === prompts.ts', () => {
  it('agrees on every panel (POV viewers, blank lines, captions and SFX, unknown speakers, odd names)', () => {
    const d = doc();
    for (const p of panels) {
      expect(shared.povViewerOf(d, p)?.id, `panel ${p.n}`).toBe(povViewerOf(d, p)?.id);
      expect(shared.drawnCastIds(d, p), `panel ${p.n}`).toEqual(drawnCastIds(d, p));
      expect(shared.offPanelSpeakerIds(d, p), `panel ${p.n}`).toEqual(offPanelSpeakerIds(d, p));
      expect(shared.undrawnSpeakers(p, d), `panel ${p.n}`).toEqual(offPanelSpeakerIds(d, p));
    }
    // The cases above really exercise the rule: viewers found, and voices dropped for blank lines.
    expect(panels.filter((p) => povViewerOf(d, p)).map((p) => p.n)).toEqual([2, 5, 6, 7]);
    expect(offPanelSpeakerIds(d, panels[6])).toEqual(['c_guard']);
  });

  it('agrees on every panel of the consistency fixtures', () => {
    for (const d of [harbourComic(), lakeStory()]) {
      for (const page of d.pages) {
        for (const p of page.panels) {
          expect(shared.drawnCastIds(d, p)).toEqual(drawnCastIds(d, p));
          expect(shared.offPanelSpeakerIds(d, p)).toEqual(offPanelSpeakerIds(d, p));
        }
      }
    }
  });

  it('a normalized direction never directs or places someone the prompt says not to draw', () => {
    const d = doc();
    for (const p of panels) {
      const dir = shared.normalizeDirection({ cast: Object.fromEntries(p.castIds.map((id) => [id, { pos: 'left' }])), by: 'writer' }, p, d);
      const drawn = drawnCastIds(d, p);
      expect(Object.keys(dir.cast ?? {}).every((id) => drawn.includes(id)), `panel ${p.n}`).toBe(true);
      expect((dir.offPanel ?? []).some((id) => drawn.includes(id)), `panel ${p.n}`).toBe(false);
      for (const id of offPanelSpeakerIds(d, p)) expect(dir.offPanel, `panel ${p.n}`).toContain(id);
      expect(shared.directionPhrases({ ...p, direction: dir }, d).who.map((w) => w.castId)).toEqual(drawn.filter((id) => dir.cast?.[id]));
    }
  });
});
