import { describe, expect, it } from 'vitest';
import { being, pageOf, readyRender } from '../../../../shared/comic/__fixtures__/consistencyBooks.js';
import { createEmptyDoc } from '../../../../shared/comic/doc.js';
import { compileEdit, compilePage } from '../prompts.js';

function book() {
  const doc = createEmptyDoc('mira', 'The Last Return');
  doc.cast = [
    being('mira', 'Mira', 'lead', {
      sheetPath: 'sheets/mira.webp',
      look: { summary: 'Her silver jacket catches the light as she moves.', outfit: 'plain silver jacket', hair: 'black bob',
        face: 'square jaw', eyes: 'hazel eyes', palette: 'metallic silver', props: 'brass compass, leather journal', marks: 'crescent cheek scar' }
    }),
    being('ravi', 'Ravi', 'support', { sheetPath: 'sheets/ravi.webp', look: { summary: 'A sailor in a striped shirt.', outfit: 'striped shirt' } })
  ];
  doc.pages = Array.from({ length: 7 }, (_, i) => pageOf(i + 1, [
    { cast: i === 4 ? ['ravi'] : ['mira'] },
    { cast: ['ravi'] }
  ], readyRender(`art/p${i + 1}.webp`)));
  doc.pages[1].continuity = { cast: { mira: { outfit: 'vermilion oilskin' } }, by: 'writer' };
  doc.pages[3].continuity = { cast: { mira: { outfit: 'cobalt linen coat with a brass clasp' } }, by: 'user' };
  doc.pages[5].continuity = { cast: { mira: { outfit: null } }, by: 'user' };
  return doc;
}

describe('provider-facing cast appearance on a drawn page', () => {
  it.each([false, true])('applies the current outfit to CAST, panel anchors and sheet references, then restores the baseline (story fixes %s)', storyFixes => {
    const doc = book();
    const prompt = (n: number) => compilePage(doc, doc.pages[n - 1], { storyFixes }).prompt;
    expect(prompt(1)).toContain('plain silver jacket');
    expect(prompt(1)).toContain('outfit and colors exactly');
    for (const [n, outfit] of [[2, 'vermilion oilskin'], [3, 'vermilion oilskin'], [4, 'cobalt linen coat']] as const) {
      const words = prompt(n);
      expect(words).toContain(outfit);
      expect(words).not.toMatch(/silver jacket|metallic silver/i);
      expect(words.split('\n').find(line => line.startsWith('- MIRA '))).toContain(outfit);
      expect(words.split('\n').find(line => line.startsWith('Who: MIRA'))).toContain(outfit);
      expect(words.split('\n').find(line => line.includes('CHARACTER SHEET: MIRA'))).toMatch(/identity and proportions only/);
      expect(words.split('\n').find(line => line.includes('CHARACTER SHEET: RAVI'))).toContain('outfit and colors exactly');
      for (const trait of ['black bob', 'square jaw', 'hazel eyes', 'brass compass', 'crescent cheek scar']) expect(words).toContain(trait);
    }
    expect(prompt(4)).not.toContain('vermilion oilskin');
    expect(prompt(5)).not.toMatch(/MIRA|oilskin|cobalt linen|silver jacket/);
    for (const n of [6, 7]) {
      expect(prompt(n)).toContain('plain silver jacket');
      expect(prompt(n)).not.toMatch(/cobalt linen|vermilion oilskin/);
    }
    expect(doc.cast[0].look.outfit).toBe('plain silver jacket');
  });

  it('keeps previous-page art and author photos as identity sources without restating stale notes', () => {
    const doc = book();
    doc.cast[0].sheet = undefined;
    doc.cast[0].refs = [{ path:'photos/mira.webp', source:'upload', at:1, label:'outfit', note:'Her plain silver jacket' }];
    const result = compilePage(doc, doc.pages[2], { previousPage: doc.pages[1] });
    expect(result.references.map(ref => ref.path)).toContain('photos/mira.webp');
    expect(result.prompt).toMatch(/IDENTITY REFERENCE: MIRA.*identity and proportions only/);
    expect(result.prompt).toMatch(/PREVIOUS PAGE.*For MIRA, use earlier art for stable identity only/);
    expect(result.prompt).not.toMatch(/silver jacket/i);
    expect(compilePage(doc, doc.pages[0]).prompt).toMatch(/Her plain silver jacket/);
  });

  it('honors a changed mark or carried item independently and excludes a prop recorded as gone', () => {
    const doc = book();
    doc.pages[1].continuity = { cast: { mira: { marks: ['bandage on left cheek'] } }, props: { compass: null } };
    const current = compilePage(doc, doc.pages[2]).prompt;
    expect(current).toContain('bandage on left cheek');
    expect(current).not.toMatch(/crescent cheek scar|brass compass/i);
    expect(current).toContain('leather journal');
    expect(current).toContain('plain silver jacket');
    expect(current).toContain('No longer present: compass');
    doc.pages[1].continuity = { cast: { mira: { holding: ['signal lamp'] } } };
    const holding = compilePage(doc, doc.pages[2]).prompt;
    expect(holding).toContain('signal lamp');
    expect(holding).not.toMatch(/brass compass|leather journal/);
    expect(holding).toContain('crescent cheek scar');
  });

  it('uses the cropped or whole-page edit instruction above carried appearance, without changing another panel', () => {
    const doc = book();
    const page = doc.pages[3];
    const box = { x: 0, y: 0, w: .5, h: .5 };
    for (const bounds of [{}, { panelCrop: box, panelBox: box, panelN: 1 }]) {
      const job = compileEdit(doc, page, { ...bounds, instruction: 'Give the courier a green poncho.', hasRegion: false });
      expect(job.prompt).toContain('Give the courier a green poncho.');
      expect(job.prompt).toContain('except where this specific change overrides it');
      expect(job.prompt).toContain('cobalt linen coat');
      expect(job.prompt).toContain('square jaw');
      expect(job.prompt).not.toMatch(/silver jacket|characters' identities and outfits|vermilion oilskin/);
    }
    const otherPanel = compileEdit(doc, page, { instruction: 'Raise the hand.', hasRegion: false, panelN: 2 });
    expect(otherPanel.prompt).not.toMatch(/cobalt linen|silver jacket|MIRA/);
  });
});
