// The tab-title count (notify SPEC §5.7): "(n) " before whatever title the page shows while alerts wait, kept through
// every title change (ComicStudio's own title and its restore at unmount included), one prefix only, "9+" above nine,
// and gone at 0. The space after ")" is a no-break space, so a person's own "(1) Origins" is never taken for it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTabBadge, stripTabBadge, tabBadgeCount, __resetTabBadgeForTests } from './tabBadge';

const NBSP = ' ';
const tick = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};

beforeEach(() => {
  __resetTabBadgeForTests();
  document.title = 'DreamStream';
});
afterEach(() => {
  __resetTabBadgeForTests();
});

describe('tab badge', () => {
  it('puts the count before the title, and clears it at 0', async () => {
    setTabBadge(2);
    expect(document.title).toBe(`(2)${NBSP}DreamStream`);
    expect(tabBadgeCount()).toBe(2);
    setTabBadge(3);
    expect(document.title).toBe(`(3)${NBSP}DreamStream`);
    setTabBadge(0);
    expect(document.title).toBe('DreamStream');
    // Disconnected at 0: a later title stays as the page set it.
    document.title = 'Library';
    await tick();
    expect(document.title).toBe('Library');
  });

  it('shows 9+ above nine', () => {
    setTabBadge(12);
    expect(document.title).toBe(`(9+)${NBSP}DreamStream`);
  });

  it('a page that sets its title keeps exactly one prefix', async () => {
    setTabBadge(1);
    document.title = 'Spice Market';
    await tick();
    expect(document.title).toBe(`(1)${NBSP}Spice Market`);
    document.title = `(1)${NBSP}(1)${NBSP}Spice Market`;
    await tick();
    expect(document.title).toBe(`(1)${NBSP}Spice Market`);
  });

  it('ComicStudio’s sequence (hidden, rename, unmount restores a prefixed title, visible) ends with no prefix', async () => {
    // Hidden: an alert arrives.
    setTabBadge(1);
    // ComicStudio is mounted: it saves the (prefixed) title and sets its own.
    const saved = document.title;
    document.title = 'Spice Market';
    await tick();
    expect(document.title).toBe(`(1)${NBSP}Spice Market`);
    // A rename.
    document.title = 'Spice Market Returns';
    await tick();
    expect(document.title).toBe(`(1)${NBSP}Spice Market Returns`);
    // A second alert, then the unmount restores the title it saved (with the old prefix).
    setTabBadge(2);
    document.title = saved;
    await tick();
    expect(document.title).toBe(`(2)${NBSP}DreamStream`);
    // Visible again: the count clears.
    setTabBadge(0);
    expect(document.title).toBe('DreamStream');
  });

  it('a person’s own "(1) Origins" survives (an ordinary space is never our prefix)', () => {
    document.title = '(1) Origins';
    setTabBadge(1);
    expect(document.title).toBe(`(1)${NBSP}(1) Origins`);
    setTabBadge(0);
    expect(document.title).toBe('(1) Origins');
    expect(stripTabBadge(`(9+)${NBSP}(1) Origins`)).toBe('(1) Origins');
    expect(stripTabBadge('(1) Origins')).toBe('(1) Origins');
  });
});
