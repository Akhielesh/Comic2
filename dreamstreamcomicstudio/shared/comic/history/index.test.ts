// The history barrel (index.ts): every engine module is reachable from one import, with no name shadowed.
import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import * as earlier from './earlier';
import * as describeModule from './describe';
import * as when from './when';
import * as apply from './apply';

describe('shared/comic/history/index.ts', () => {
  it('re-exports earlier.ts (H6a) — every runtime export, the same binding', () => {
    const names = Object.keys(earlier);
    expect(names).toEqual(expect.arrayContaining(['earlierHistory', 'earlierFacts', 'earlierForPage', 'earlierNote', 'EARLIER_TITLE', 'EARLIER_NOTE_NO_START']));
    for (const name of names) expect((barrel as Record<string, unknown>)[name], name).toBe((earlier as Record<string, unknown>)[name]);
  });

  it('no earlier.ts name collides with another history module (an ambiguous export * would drop it)', () => {
    for (const other of [describeModule, when]) {
      for (const name of Object.keys(earlier)) expect(Object.keys(other), name).not.toContain(name);
    }
    expect(barrel.EARLIER_NOTE_NO_START).toBe('Only drawings were recorded before History started.');
  });

  it('re-exports the archive test for displaced frame pictures and overlays (apply.ts), the same binding', () => {
    expect(barrel.isPanelSourceArchive).toBe(apply.isPanelSourceArchive);
    expect(barrel.PANEL_SOURCE_ARCHIVE_WORDS).toBe(apply.PANEL_SOURCE_ARCHIVE_WORDS);
  });
});
