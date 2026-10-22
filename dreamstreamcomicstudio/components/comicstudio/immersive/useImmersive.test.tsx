// Immersive platform glue (reader.md §11.3): fullscreen with an overlay fallback, page scroll lock,
// theme-color, wake lock (re-acquired on return), and the Back gesture closing the reader.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import React, { useRef } from 'react';
import { useImmersive, type ImmersiveApi } from './useImmersive';

let api: ImmersiveApi | null = null;
const Host: React.FC<{ onExit(): void; themeColor?: string }> = ({ onExit, themeColor }) => {
  const ref = useRef<HTMLDivElement>(null);
  api = useImmersive(ref, { active: true, onExit, themeColor });
  return <div ref={ref} data-testid="root" />;
};

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  api = null;
  vi.restoreAllMocks();
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
});

describe('useImmersive', () => {
  it('without the Fullscreen API it falls back to the overlay and locks page scroll', async () => {
    const view = render(<Host onExit={() => undefined} />);
    await act(tick);
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
    expect(api!.fullscreen).toBe(false);
    view.unmount();
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('Back (popstate) exits the reader; an explicit exit pops its own history entry', async () => {
    window.history.replaceState(null, '', '/c/abc');
    const onExit = vi.fn();
    render(<Host onExit={onExit} />);
    await act(tick);
    expect((window.history.state as Record<string, unknown>)?.__dsReader).toBeTruthy();
    // The user presses Back: the entry is gone, the reader closes.
    window.history.replaceState(null, '', '/c/abc');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    expect(onExit).toHaveBeenCalledTimes(1);
    // Closing again does nothing more.
    act(() => api!.exit());
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('explicit exit goes back over its own entry and calls onExit once', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const onExit = vi.fn();
    render(<Host onExit={onExit} />);
    await act(tick);
    act(() => api!.exit());
    expect(back).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('sets theme-color while open and restores it after', async () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#ffffff';
    document.head.appendChild(meta);
    const view = render(<Host onExit={() => undefined} themeColor="#101010" />);
    await act(tick);
    expect(meta.content).toBe('#101010');
    view.unmount();
    expect(meta.content).toBe('#ffffff');
  });

  it('holds a screen wake lock while visible and releases it on close', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ released: false, release, addEventListener: () => undefined }));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    const view = render(<Host onExit={() => undefined} />);
    await act(tick);
    expect(request).toHaveBeenCalledWith('screen');
    expect(api!.wakeLockActive).toBe(true);
    view.unmount();
    expect(release).toHaveBeenCalled();
  });

  it('uses the Fullscreen API when the browser has it', async () => {
    const el = document.documentElement as HTMLElement & { requestFullscreen?: unknown };
    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { get: () => fsEl, configurable: true });
    const req = vi.fn(async function (this: HTMLElement) {
      fsEl = this;
    });
    HTMLElement.prototype.requestFullscreen = req as unknown as HTMLElement['requestFullscreen'];
    const exitFs = vi.fn(async () => {
      fsEl = null;
    });
    (document as Document & { exitFullscreen: unknown }).exitFullscreen = exitFs;
    const view = render(<Host onExit={() => undefined} />);
    await act(tick);
    expect(req).toHaveBeenCalled();
    expect(api!.fullscreen).toBe(true);
    expect(api!.fullscreenSupported).toBe(true);
    view.unmount();
    expect(exitFs).toHaveBeenCalled();
    delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
    delete (document as Partial<Document> & { exitFullscreen?: unknown }).exitFullscreen;
    delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
    void el;
  });
});
