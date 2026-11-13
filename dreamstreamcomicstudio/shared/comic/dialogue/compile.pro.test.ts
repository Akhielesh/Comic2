// PE-LETTER wave note 22 (S2b integration): the dialogue compiler passes `allowPro: PRO_EDIT_OPS_PATCHABLE` to the
// lettering sanitizer, so a typed restyle and "same style as this one for every caption" carry the Pro text keys only
// while the switch is on; off, they compile exactly as before. The switch is a code constant (OFF in ops.ts): this
// file flips it locally (vi.mock, read live through a getter) and pins both states.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({ on: true }));
vi.mock('../ops', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ops')>();
  return {
    ...real,
    get PRO_EDIT_OPS_PATCHABLE() {
      return sw.on;
    }
  };
});

import type { ComicDoc } from '../doc';
import type { DocOp } from '../ops';
import { compileWith, type RestyleExtras } from './compile';
import { hitOf } from './resolve';
import type { DialogueIntent, LineHit } from './types';
import { dialogueDoc } from './__fixtures__/dialogueDoc';

afterEach(() => {
  sw.on = true;
});

const PRO_TEXT = { warp: 'arc', warpAmount: 0.5, fillGradient: { from: '#000000', to: '#ffffff', angle: 0 } };
const hits = (d: ComicDoc, ...ids: string[]): LineHit[] => ids.map((id) => hitOf(d, id)!);
const styled = (): ComicDoc =>
  dialogueDoc((d) => {
    const leo = d.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === 'l_leo1')!;
    leo.style = JSON.parse(JSON.stringify({ italic: true, ...PRO_TEXT }));
  });

describe('the dialogue compiler and the Pro text keys (PE-LETTER wave note 22)', () => {
  it('a typed restyle keeps a Pro key only with the switch on', () => {
    const doc = dialogueDoc();
    const intent = { act: 'restyle', target: { selected: true }, scope: 'line', style: { warp: 'arc', italic: true } } as unknown as DialogueIntent;
    const on = compileWith(doc, intent, hits(doc, 'l_leo1')).ops as Extract<DocOp, { op: 'line_style' }>[];
    expect(on[0]?.patch).toMatchObject({ italic: true, warp: 'arc' });
    sw.on = false;
    const off = compileWith(doc, intent, hits(doc, 'l_leo1')).ops as Extract<DocOp, { op: 'line_style' }>[];
    expect(off[0]?.patch).toEqual({ italic: true });
  });

  it('"same style as this one for every caption" copies a Pro-styled line\'s Pro keys only with the switch on', () => {
    const doc = styled();
    const intent = { act: 'restyle', target: { selected: true }, scope: 'kind', style: {}, asKind: 'caption' } as unknown as DialogueIntent & RestyleExtras;
    const captionPatch = (ops: DocOp[]) => (ops[0] as Extract<DocOp, { op: 'letter_style' }>).patch?.kinds?.caption;
    expect(captionPatch(compileWith(doc, intent, hits(doc, 'l_leo1')).ops)).toMatchObject({ italic: true, ...PRO_TEXT });
    sw.on = false;
    const off = captionPatch(compileWith(doc, intent, hits(doc, 'l_leo1')).ops) as Record<string, unknown>;
    expect(off).toMatchObject({ italic: true });
    for (const key of Object.keys(PRO_TEXT)) expect(off, key).not.toHaveProperty(key);
  });
});
