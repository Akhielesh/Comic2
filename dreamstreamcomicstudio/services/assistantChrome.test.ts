import { describe, expect, it } from 'vitest';
import { assistantChrome } from './assistantChrome';

describe('assistantChrome', () => {
  it('keeps the assistant mounted in the reader with its launcher hidden', () => {
    expect(assistantChrome('reader')).toEqual({ mounted: true, hideLauncher: true });
  });

  it('shows the launcher on every other view where the assistant is mounted', () => {
    for (const view of ['home', 'gallery', 'dashboard', 'editor', 'pagestudio', 'profile', 'auth']) {
      expect(assistantChrome(view)).toEqual({ mounted: true, hideLauncher: false });
    }
  });

  it('is not mounted on the chat product, the v4 studio, the shared viewer, the public share reader or the auth callback', () => {
    for (const view of ['chat', 'comicstudio', 'shared', 'publiccomic', 'auth-callback']) {
      expect(assistantChrome(view).mounted).toBe(false);
    }
  });
});
