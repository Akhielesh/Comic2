// ShareButton loads ReaderShare on demand (the studio never downloads it). A load that fails (offline, or a deploy
// that replaced the chunk) must not throw into the page: the same Share button stays, and the next tap loads again
// and opens the menu.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareButton } from './ShareButton';

const load = vi.hoisted(() => ({ fail: true, attempts: 0 }));
vi.mock('./ReaderShare', async (importOriginal) => {
  load.attempts += 1;
  if (load.fail) throw new Error('Failed to fetch dynamically imported module');
  return importOriginal();
});

class Boundary extends React.Component<{ children: React.ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    return this.state.error ? <p role="alert">The page broke</p> : this.props.children;
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('navigator', { ...navigator, userAgent: 'test', share: undefined, clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe('ShareButton when ReaderShare fails to load', () => {
  it('keeps the Share button on the page, and a tap loads it again and opens the menu', async () => {
    render(
      <Boundary>
        <ShareButton compact target={{ url: 'https://comics.example/c/Ab3dEf6hIj9kLm2nP', title: 'Brick Bridge' }} />
      </Boundary>
    );
    await settle();
    expect(load.attempts).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('alert')).toBeNull();
    const button = screen.getByRole('button', { name: 'Share' });
    expect(button).toHaveAttribute('data-loading');

    load.fail = false;
    fireEvent.click(button);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).not.toHaveAttribute('data-loading');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
