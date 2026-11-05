// The character reducer drops cleared keys (gate L14): the Undo inverse of a FIRST look line / kind / count /
// likeness sends null for each key that was absent before (contract R4). The server's sanitizer turns that
// null into undefined; the client applies the op as it sent it. Both mirrors must end with the key GONE, so
// the client's doc — and every pageSpecHash built from its look — equals the server's after the echo.

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { pageSpecHash, type ComicDoc } from './doc';
import { applyOps, type DocOp } from './ops';
import { inverseOps } from './undo';

const maya = (doc: ComicDoc) => doc.cast.find((c) => c.id === 'ch_maya')!;
const hashes = (doc: ComicDoc) => doc.pages.map((p) => pageSpecHash(doc, p));

describe('character reducer: cleared keys are removed, never stored as null', () => {
  it('Undo of a first species / markings line restores the exact look and page hashes (client mirror)', () => {
    const before = makeSampleDoc();
    expect('species' in maya(before).look).toBe(false);
    const edit: DocOp[] = [{ op: 'character', id: 'ch_maya', patch: { look: { species: 'red fox', markings: 'white tail tip' } as never } }];
    const after = applyOps(before, edit, 1);
    expect(maya(after).look.species).toBe('red fox');
    expect(hashes(after)).not.toEqual(hashes(before));

    const undo = inverseOps(before, edit);
    // The inverse is what the client sends (and applies to its own mirror): null for the keys that were absent.
    expect(undo).toEqual([{ op: 'character', id: 'ch_maya', patch: { look: expect.objectContaining({ species: null, markings: null }) } }]);
    const undone = applyOps(after, undo, 2);
    expect(maya(undone).look).toEqual(maya(before).look);
    expect('species' in maya(undone).look).toBe(false);
    expect('markings' in maya(undone).look).toBe(false);
    expect(hashes(undone)).toEqual(hashes(before));
  });

  it('the server path (null sanitized to undefined) lands on the same doc as the client path', () => {
    const before = makeSampleDoc();
    const after = applyOps(before, [{ op: 'character', id: 'ch_maya', patch: { look: { species: 'red fox' } as never } }], 1);
    const client = applyOps(after, [{ op: 'character', id: 'ch_maya', patch: { look: { species: null } as never } }], 2);
    const server = applyOps(after, [{ op: 'character', id: 'ch_maya', patch: { look: { species: undefined } as never } }], 2);
    expect(maya(client)).toEqual(maya(server));
    expect(JSON.stringify(maya(client))).toBe(JSON.stringify(maya(server)));
    expect(hashes(client)).toEqual(hashes(before));
  });

  it('Undo of a first kind / count / likeness removes the keys (person / single / auto again)', () => {
    const before = makeSampleDoc();
    const edit: DocOp[] = [{ op: 'character', id: 'ch_maya', patch: { kind: 'animal', count: 3, likeness: 'sheet_only' } }];
    const after = applyOps(before, edit, 1);
    expect(maya(after)).toMatchObject({ kind: 'animal', count: 3, likeness: 'sheet_only' });
    const undone = applyOps(after, inverseOps(before, edit), 2);
    for (const key of ['kind', 'count', 'likeness'] as const) expect(key in maya(undone)).toBe(false);
    expect(maya(undone)).toEqual(maya(before));
    expect(hashes(undone)).toEqual(hashes(before));
  });

  it('a cleared summary keeps the current one (summary is required); other look keys merge as before', () => {
    const before = makeSampleDoc();
    const summary = maya(before).look.summary;
    const next = applyOps(before, [{ op: 'character', id: 'ch_maya', patch: { look: { summary: null, hair: 'short bob' } as never } }], 1);
    expect(maya(next).look.summary).toBe(summary);
    expect(maya(next).look.hair).toBe('short bob');
  });

  it('a new character never stores null look details', () => {
    const doc = applyOps(makeSampleDoc(), [{ op: 'character', id: 'ch_new', patch: { name: 'Pip', look: { summary: 'A sparrow', species: null } as never } }], 1);
    const pip = doc.cast.find((c) => c.id === 'ch_new')!;
    expect(pip.look).toEqual({ summary: 'A sparrow' });
  });
});
