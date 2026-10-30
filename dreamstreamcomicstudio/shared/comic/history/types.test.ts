// The history wire contract (types.ts): K2a's panel moments are part of ChangeItem itself, so a recorder, the
// rows a route returns and the UI can carry them as ordinary ChangeItems (no PanelChangeItem cast needed).
// The fold is checked by the typecheck (npm run typecheck covers this file); the runtime checks prove a plain
// ChangeItem that carries a moment is read and worded exactly as a PanelChangeItem is.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('PanelChangeItem is ChangeItem with the moment present (ig2 FIX wave note 5)', () => {
  it('is exactly that type, declared once as an alias (no field of its own that could drift from ChangeItem)', () => {
    // The type is the fold: every field is ChangeItem's, the moment is required.
    expectTypeOf<PanelChangeItem>().toEqualTypeOf<ChangeItem & { moment: PanelMoment }>();
    expectTypeOf<Exclude<keyof PanelChangeItem, keyof ChangeItem>>().toEqualTypeOf<never>();
    expectTypeOf<PanelChangeItem['moment']>().toEqualTypeOf<PanelMoment>();
    // Structurally the old interface was the same type, so its declaration is pinned too: an alias of ChangeItem,
    // never again an interface that re-declares ChangeItem's fields.
    const src = readFileSync(join(__dirname, 'describe.ts'), 'utf8');
    expect(src).toMatch(/^export type PanelChangeItem = ChangeItem & \{ moment: PanelMoment \};$/m);
    expect(src).not.toMatch(/interface PanelChangeItem\b/);
  });
});
