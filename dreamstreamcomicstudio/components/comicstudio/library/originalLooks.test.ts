import { beforeEach, describe, expect, it, vi } from 'vitest';
import { originalLook, pendingOriginalLook, rememberOriginalLook } from './originalLooks';

beforeEach(() => sessionStorage.clear());

describe('the library look selected before sign-in', () => {
  it('restores a public format in the same tab and consumes it only once', () => {
    rememberOriginalLook('DSOriginalMarg001');
    expect(pendingOriginalLook()).toBe('DSOriginalMarg001');
    expect(originalLook(pendingOriginalLook()!)?.brief).toContain('30-page manga, portrait, right to left');
    rememberOriginalLook();
    expect(pendingOriginalLook()).toBeUndefined();
  });

  it('opens the allowlisted fresh-device confirmation with empty session storage', () => {
    window.history.replaceState({}, '', '/?view=dashboard&look=DSOriginalWest001');
    try {
      expect(pendingOriginalLook()).toBe('DSOriginalWest001');
      window.history.replaceState({}, '', '/?view=dashboard&look=unrecognized');
      expect(pendingOriginalLook()).toBeUndefined();
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('drops a previously stored or directly requested look when an edition is held', () => {
    const held = 'DSOriginalBubl001';
    sessionStorage.setItem('comicstudio.library-look.v1', JSON.stringify({ slug: held, at: Date.now() }));
    window.history.replaceState({}, '', '/?view=dashboard&look=' + held);
    try {
      expect(pendingOriginalLook()).toBeUndefined();
      expect(sessionStorage.getItem('comicstudio.library-look.v1')).toBeNull();
      expect(originalLook(held)).toBeUndefined();
      expect(originalLook('DSOriginalHats001')?.brief).toContain('15-page comic, portrait, left to right');
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('expires old selections and refuses arbitrary or unavailable editions', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      rememberOriginalLook('DSOriginalBird001');
      clock.mockReturnValue(100_000 + 31 * 60_000);
      expect(pendingOriginalLook()).toBeUndefined();
      for (const invalid of ['DSOriginalTide001', 'https://example.org', 'somebody’s private story']) {
        rememberOriginalLook(invalid);
        expect(pendingOriginalLook()).toBeUndefined();
      }
    } finally {
      clock.mockRestore();
    }
  });
});
