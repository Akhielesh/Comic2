// The history wire contract (types.ts): K2a's panel moments are part of ChangeItem itself, so a recorder, the
// rows a route returns and the UI can carry them as ordinary ChangeItems (no PanelChangeItem cast needed).
// The fold is checked by the typecheck (npm run typecheck covers this file); the runtime checks prove a plain
// ChangeItem that carries a moment is read and worded exactly as a PanelChangeItem is.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { describeChanges, isPanelChangeItem, panelMomentItem, type PanelChangeItem, type PanelMoment } from './describe';
import type { ChangeItem, VersionRow } from './types';

describe('ChangeItem carries K2a panel moments officially', () => {
  it('moment and panelNs are optional ChangeItem fields; PanelChangeItem is that item with the moment present', () => {
    expectTypeOf<ChangeItem['moment']>().toEqualTypeOf<PanelMoment | undefined>();
    expectTypeOf<ChangeItem['panelNs']>().toEqualTypeOf<number[] | undefined>();
    expectTypeOf<PanelChangeItem>().toMatchTypeOf<ChangeItem>();
    expectTypeOf<VersionRow['changes'][number]>().toEqualTypeOf<ChangeItem>();
  });

  it('a plain ChangeItem with a moment is recognised and worded like the recorder\'s moment item', () => {
    const plain: ChangeItem = { what: 'art', by: 'ai', key: 'art:pg_2', pageIds: ['pg_2'], pageNs: [2], moment: 'redraw_panel', panelNs: [3] };
    expect(isPanelChangeItem(plain)).toBe(true);
    const made = panelMomentItem('redraw_panel', 'ai', { id: 'pg_2', n: 2 }, [3]);
    expect(made).toEqual(plain);
    const items: ChangeItem[] = [plain];
    expect(describeChanges(items, 'ai')).toBe(describeChanges([made], 'ai'));
    expect(describeChanges(items, 'ai')).toMatch(/panel 3/);
    // A ChangeItem without a moment stays an ordinary change.
    expect(isPanelChangeItem({ what: 'art', by: 'ai' } satisfies ChangeItem)).toBe(false);
  });
});
